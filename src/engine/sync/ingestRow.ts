/**
 * Gate a relay row into what the transactions store (DESIGN §d.6 failure
 * table). Runs before any transaction.
 *
 *  - pass                                   -> tail row (content = opened inner content)
 *  - ns/cfg deterministic failure           -> tail row with empty content (folds as an empty frame)
 *  - ns/cfg reader-dependent failure        -> tail row flagged LOCAL_FLAG_UNOPENED, content = raw payload (halts the fold)
 *  - body/canvas/x failure                  -> quarantine record
 *  - unknown stream class                   -> accounted only
 */

import { QUARANTINE_ROW_BYTES } from "../../core/limits";
import { streamClass, type ClientFrameId, type ContentHash, type DeviceId, type Seq, type StreamName } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import { gate, type GateCtx } from "../ingest/gate";
import type { QuarantineRecord, TailRecord } from "../store/schema";
import { bytesToHex } from "../../core/codec/lib0";
import { LOCAL_FLAG_UNOPENED } from "./nsRuntime";

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
	const g = await gate(ctx, { t: "row", ...input });
	const base = { stream: input.stream, seq: input.seq, deviceId: input.deviceId, clientFrameId: input.clientFrameId };
	if (g.ok) {
		switch (g.t) {
			case "ignored":
				return { t: "account" };
			case "ns":
			case "cfg":
			case "body":
			case "bodyRef":
			case "blobchunk":
				return { t: "row", row: { ...base, kind: g.inner.kind, authorNsSeq: g.inner.authorNsSeq, flags: g.inner.flags, content: g.inner.content } };
			case "checkpoint":
				return { t: "account" };
		}
	}
	if (cls === "ns" || cls === "cfg") {
		const kind = cls === "ns" ? "nsOps" : "cfgOps";
		if (g.readerDependent) return { t: "row", row: { ...base, kind, authorNsSeq: 0, flags: LOCAL_FLAG_UNOPENED, content: input.payload } };
		return { t: "row", row: { ...base, kind, authorNsSeq: 0, flags: 0, content: new Uint8Array(0) } };
	}
	return { t: "quarantine", rec: await quarantineRecord(hash, input, g.reason, g.detail, nowMs) };
}

export async function quarantineRecord(hash: HashPort, input: RowInput, reason: QuarantineRecord["reason"], detail: string, nowMs: number): Promise<QuarantineRecord> {
	const bytesHash = bytesToHex(await hash.sha256(input.payload)) as ContentHash;
	return {
		stream: input.stream, seq: input.seq, deviceId: input.deviceId, clientFrameId: input.clientFrameId, reason, detail,
		bytes: input.payload.length > QUARANTINE_ROW_BYTES ? input.payload.slice(0, QUARANTINE_ROW_BYTES) : input.payload,
		bytesHash, originalSize: input.payload.length, atMs: nowMs,
	};
}
