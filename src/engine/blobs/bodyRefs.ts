/**
 * Body refs a reader may still resolve (e2ee-design §10.4 live set): the hash of every bodyUpdateRef row the
 * relay still serves on a b: / c: stream. A reader reads rows above its cursor, and one whose cursor is below
 * gcSeq gets the stream's checkpoint plus the rows above it (server/src/streams/store.ts:476-523): every row
 * above gcSeq can still be read, rows at or below it never again. Checkpoints hold Yjs state, never refs.
 *
 * Per stream: a probe read after Number.MAX_SAFE_INTEGER returns no rows and no checkpoint, only lastSeq and
 * gcSeq (the relay accepts any safe integer, server/src/streams/relay.ts:269-274); then the rows are read from
 * gcSeq. A page whose gcSeq moved past the cursor (compaction meanwhile) restarts the stream from the new gcSeq.
 * Each row is opened as a reader would (ingest/envelope.ts): a reader-dependent failure (unknown key, version
 * or suite, unverified key) refuses the scan, since the row may hold a ref this reader cannot see; a
 * deterministic one is skipped, since every reader quarantines it.
 *
 * `from` (the `through` of an earlier scan) rescans only the rows committed since (gc.ts R4).
 */

import { decodeBodyUpdateRef } from "../../core/codec/contents";
import { untilAborted } from "../../core/deadline";
import type { ContentHash, Seq, StreamName, VaultId } from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import type { ReadPage, ReadRequest, RelaySession } from "../../ports/relay";
import { isReaderDependent, openEnvelope } from "../ingest/envelope";

export interface BodyRefScanDeps {
	readonly session: Pick<RelaySession, "readBatch" | "limits">;
	readonly crypto: CryptoPort;
	readonly vaultId: VaultId;
	readonly signal: AbortSignal;
	readonly yieldNow: () => Promise<void>;
}

export type BodyRefScan =
	| { readonly ok: true; readonly hashes: Set<ContentHash>; readonly through: Map<StreamName, Seq> }
	| { readonly ok: false; readonly stream: StreamName; readonly seq: Seq; readonly reason: string };

const PROBE_AFTER = Number.MAX_SAFE_INTEGER;

interface Step {
	readonly stream: StreamName;
	readonly after: Seq;
	readonly probe: boolean;
}

export async function scanBodyRefs(deps: BodyRefScanDeps, streams: Iterable<StreamName>, from?: ReadonlyMap<StreamName, Seq>): Promise<BodyRefScan> {
	const hashes = new Set<ContentHash>();
	const through = new Map<StreamName, Seq>();
	const queue: Step[] = [];
	for (const stream of new Set(streams)) {
		const f = from?.get(stream);
		queue.push(f === undefined ? { stream, after: PROBE_AFTER, probe: true } : { stream, after: f, probe: false });
	}
	const width = Math.max(1, deps.session.limits.readBatchStreams);
	while (queue.length > 0) {
		if (deps.signal.aborted) throw new Error("aborted");
		const batch = queue.slice(0, width);
		// Bounded by the relay's own deadline and the session's close (adapters/relayHttp.ts); `signal` (the sweep's
		// stop) ends the wait sooner: engine stop awaits the sweep before it closes the session.
		const pages = await untilAborted(deps.session.readBatch(batch.map((s): ReadRequest => ({ stream: s.stream, afterSeq: s.after, preferCheckpoint: false }))), deps.signal);
		if (pages.length === 0) throw new Error("readBatch returned no page");
		queue.splice(0, pages.length);
		for (let i = 0; i < pages.length; i++) {
			const step = batch[i]!;
			const page = pages[i]!;
			const next = await visit(deps, step, page, hashes);
			if (next === null) through.set(step.stream, page.lastSeq);
			else if ("reason" in next) return { ok: false, ...next };
			else queue.push(next);
		}
		await deps.yieldNow();
	}
	return { ok: true, hashes, through };
}

interface Refusal {
	readonly stream: StreamName;
	readonly seq: Seq;
	readonly reason: string;
}

/** The next step of `step`'s stream after `page` (null = done through page.lastSeq). */
async function visit(deps: BodyRefScanDeps, step: Step, page: ReadPage, hashes: Set<ContentHash>): Promise<Step | Refusal | null> {
	const { stream } = step;
	if (step.probe) return page.lastSeq > page.gcSeq ? { stream, after: page.gcSeq, probe: false } : null;
	if (page.gcSeq > step.after) return { stream, after: page.gcSeq, probe: false };
	for (const row of page.rows) {
		if (row.seq <= step.after) continue;
		const opened = await openEnvelope(deps.crypto, deps.vaultId, { t: "frame", stream, deviceId: row.deviceId, clientFrameId: row.clientFrameId }, row.payload);
		if (!opened.ok) {
			const keyVerified = opened.header ? deps.crypto.keyState(opened.header.keyEpoch).verified : false;
			if (isReaderDependent(opened.reason, keyVerified)) return { stream, seq: row.seq, reason: opened.reason };
			continue;
		}
		if (opened.inner.kind !== "bodyUpdateRef") continue;
		const ref = decodeBodyUpdateRef(opened.inner.content);
		if (ref) hashes.add(ref.hash);
	}
	return page.more ? { stream, after: page.nextAfterSeq, probe: false } : null;
}
