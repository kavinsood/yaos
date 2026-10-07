/**
 * Gate a relay row into what the transactions store (DESIGN §d.6 failure
 * table). Runs before any transaction.
 *
 *  - pass                                   -> tail row (content = opened inner content)
 *  - ns/cfg/snap deterministic failure          -> tail row with empty content (folds as an empty frame)
 *  - ns/cfg/snap reader-dependent failure   -> tail row flagged LOCAL_FLAG_UNOPENED, content = raw payload (halts the fold)
 *  - body/canvas/x failure                  -> quarantine record: deterministic failures keep the first
 *                                              QUARANTINE_ROW_BYTES; reader-dependent ones keep the whole payload
 *                                              (bounded by the relay's 1 MiB frame), so a re-gate on new keys or
 *                                              an upgrade can still open it (§d.6 "retried on upgrade or new keys")
 *  - ns/cfg stale-epoch (e2ee-design §14.3)  -> tail row flagged LOCAL_FLAG_STALE_EPOCH, empty content (folds as
 *                                              ignored/stale-epoch)
 *  - body/canvas/x stale-epoch              -> accounted only: ignored, no quarantine, no freeze (§9.3)
 *  - k row                                  -> tail row "keyRecord", content = the raw record (no envelope;
 *                                              judged by the keyring, e2ee-design §11.3)
 *  - unknown stream class                   -> accounted only
 *
 * ownCommitCopy: an own frame (outbox record) that committed stale is renamed to an unsealed copy instead.
 */

import { QUARANTINE_ROW_BYTES } from "../../core/limits";
import { streamClass, type ClientFrameId, type ContentHash, type DeviceId, type Seq, type StreamName } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import { newClientFrameId } from "../../core/codec/ids";
import { gate, type GateCtx } from "../ingest/gate";
import type { OwnCommitCopy } from "../store/repo";
import type { OutboxRecord, QuarantineRecord, TailRecord } from "../store/schema";
import { bytesToHex } from "../../core/codec/lib0";
import { KEY_RECORD_MAX_BYTES } from "../keyring/record";
import { LOCAL_FLAG_STALE_EPOCH, LOCAL_FLAG_UNOPENED } from "./foldRuntime";

export interface RowInput {
	readonly stream: StreamName;
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly payload: Uint8Array;
}

export type GatedRow =
	| { readonly t: "row"; readonly row: TailRecord }
	| { readonly t: "quarantine"; readonly rec: QuarantineRecord }
	| { readonly t: "account" };

export async function gateRow(ctx: GateCtx, hash: HashPort, input: RowInput, nowMs: number): Promise<GatedRow> {
	const cls = streamClass(input.stream);
	if (cls === "other") return { t: "account" };
	if (cls === "keyring") return { t: "row", row: keyRecordRow(input) };
	const g = await gate(ctx, { t: "row", ...input });
	const base = { stream: input.stream, seq: input.seq, deviceId: input.deviceId, clientFrameId: input.clientFrameId };
	if (g.ok) {
		switch (g.t) {
			case "ignored":
				return { t: "account" };
			case "stale":
				if (cls !== "ns" && cls !== "cfg") return { t: "account" };
				return { t: "row", row: { ...base, kind: cls === "ns" ? "nsOps" : "cfgOps", authorNsSeq: 0, flags: LOCAL_FLAG_STALE_EPOCH, frameNo: 0, content: new Uint8Array(0) } };
			case "ns":
			case "cfg":
			case "snap":
			case "body":
			case "bodyRef":
			case "blobchunk":
				return { t: "row", row: { ...base, kind: g.inner.kind, authorNsSeq: g.inner.authorNsSeq, flags: g.inner.flags, frameNo: g.inner.frameNo, content: g.inner.content } };
			case "checkpoint":
				return { t: "account" };
		}
	}
	if (cls === "ns" || cls === "cfg" || cls === "snap") {
		const kind = cls === "ns" ? "nsOps" : cls === "cfg" ? "cfgOps" : "snapOps";
		// frameNo 0: a row that did not open (or decode) never touches the replay window (e2ee-design §8.2).
		if (g.readerDependent) return { t: "row", row: { ...base, kind, authorNsSeq: 0, flags: LOCAL_FLAG_UNOPENED, frameNo: 0, content: input.payload } };
		return { t: "row", row: { ...base, kind, authorNsSeq: 0, flags: 0, frameNo: 0, content: new Uint8Array(0) } };
	}
	return { t: "quarantine", rec: await quarantineRecord(hash, input, g.reason, g.detail, nowMs, g.readerDependent) };
}

/**
 * An own frame committed at `seq` under an epoch the §14.3 rule makes stale, or may (k below `seq` not judged
 * yet): readers ignore it, so its author sends a copy sealed under the current epoch (e2ee-design §14.2 step 4).
 * The copy keeps the frameNo: should a hold settle as not stale, the copy is a replay duplicate (§8.2) or a Yjs
 * no-op. ns/cfg commits are stored as readers store them (stale: folds as ignored; hold: unopened, re-gated once
 * `k` is judged); others as the outbox has them (the local doc already holds the update).
 */
export function ownCommitCopy(ctx: GateCtx, random: RandomPort, self: DeviceId, ob: OutboxRecord, seq: Seq): OwnCommitCopy | null {
	const v = ctx.staleCheck(ob.keyEpoch, seq);
	if (v === null) return null;
	const cls = streamClass(ob.stream);
	if (cls !== "ns" && cls !== "cfg") return { clientFrameId: newClientFrameId(random), row: null };
	const base = { stream: ob.stream, seq, deviceId: self, clientFrameId: ob.clientFrameId, kind: ob.kind, authorNsSeq: 0, frameNo: 0 };
	const row: TailRecord = v === "stale" ? { ...base, flags: LOCAL_FLAG_STALE_EPOCH, content: new Uint8Array(0) } : { ...base, flags: LOCAL_FLAG_UNOPENED, content: ob.sealed };
	return { clientFrameId: newClientFrameId(random), row };
}

/** A `k` row as stored: over-long payloads are kept empty (garbage either way, §11.1). */
export function keyRecordRow(input: Omit<RowInput, "stream"> & { readonly stream: StreamName }): TailRecord {
	const content = input.payload.length <= KEY_RECORD_MAX_BYTES ? input.payload : new Uint8Array(0);
	return { stream: input.stream, seq: input.seq, deviceId: input.deviceId, clientFrameId: input.clientFrameId, kind: "keyRecord", authorNsSeq: 0, flags: 0, frameNo: 0, content };
}

/** `whole`: a reader-dependent failure, re-gated later (quarantineRelease.ts): truncated, it could only fail again. */
export async function quarantineRecord(hash: HashPort, input: RowInput, reason: QuarantineRecord["reason"], detail: string, nowMs: number, whole = false): Promise<QuarantineRecord> {
	const bytesHash = bytesToHex(await hash.sha256(input.payload)) as ContentHash;
	return {
		stream: input.stream, seq: input.seq, deviceId: input.deviceId, clientFrameId: input.clientFrameId, reason, detail,
		bytes: !whole && input.payload.length > QUARANTINE_ROW_BYTES ? input.payload.slice(0, QUARANTINE_ROW_BYTES) : input.payload,
		bytesHash, originalSize: input.payload.length, atMs: nowMs,
	};
}
