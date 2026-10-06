/**
 * x:<address> chunk access for the blob layer (blobs/chunks.ts BlobChunkLog).
 * Callers pass the plaintext sha256; the stream is named by
 * CryptoPort.blobAddress(sha256) (e2ee-design §10.1), so no stream name the
 * relay sees carries a plaintext hash. The blobChunk content (sealed) keeps
 * the sha256.
 *
 * appendBlobChunks authors blobChunk frames through the outbox (one T_edit on
 * the edit chain) and waits for their receipts. Idempotent by hash + index: an
 * index with an own record in the outbox is waited on, an index the relay
 * already has is skipped. false = a record was poisoned (refused), the session
 * changed (offline / reconnect: the records stay in the outbox and go out on
 * the next session; a retry waits on them), or the timeout passed.
 *
 * readBlobChunks returns the rows already in the local tail (catch-up and live
 * ingest store x: rows) when they assemble into the blob (the hash is the
 * content address, so they are it); otherwise it reads the committed rows of
 * x:<address> from the relay and opens them through the gate; nothing is
 * persisted. Offline: the local rows, or null if there are none. Reading the
 * committed rows first is the log path's dedupe (the `has` of the store path).
 */

import { decodeBlobChunk } from "../../core/codec/contents";
import type { BlobChunkContent } from "../../core/envelope";
import { blobChunkStream, type ClientFrameId, type ContentHash, type StreamName } from "../../core/types";
import type { RelaySession } from "../../ports/relay";
import { assembleChunks } from "../blobs/chunks";
import { buildBlobChunkFrame } from "../body/frames";
import { gateRow } from "../sync/ingestRow";
import type { EngineCtx } from "./context";

const POLL_MS = 50;

function chunkOf(content: Uint8Array, hash: ContentHash): BlobChunkContent | null {
	const ch = content.length > 0 ? decodeBlobChunk(content) : null;
	return ch && ch.hash === hash ? ch : null;
}

async function chunkStream(c: EngineCtx, hash: ContentHash): Promise<StreamName> {
	return blobChunkStream(await c.deps.crypto.blobAddress(hash));
}

async function localChunks(c: EngineCtx, stream: StreamName, hash: ContentHash): Promise<BlobChunkContent[]> {
	const out: BlobChunkContent[] = [];
	for (const row of await c.repo.getTail(stream, 0)) {
		const ch = chunkOf(row.content, hash);
		if (ch) out.push(ch);
	}
	return out;
}

/** Committed chunks of x:<address> for `hash` (any order, duplicates possible); null = not readable now. */
export async function readBlobChunks(c: EngineCtx, hash: ContentHash): Promise<BlobChunkContent[] | null> {
	if (c.stopped) return null;
	const stream = await chunkStream(c, hash);
	const local = await localChunks(c, stream, hash);
	const s = c.session;
	if (!s || c.stopped) return c.stopped || local.length === 0 ? null : local;
	if (local.length > 0 && assembleChunks(hash, local).ok) return local;
	const out: BlobChunkContent[] = [];
	try {
		let after = 0;
		for (;;) {
			const page = await s.read(stream, after, false);
			for (const row of page.rows) {
				const g = await gateRow(c.gateCtx, c.ports.hash, { stream, seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, payload: row.payload }, c.now());
				if (g.t !== "row") continue; // undecryptable / malformed: not a chunk we can use
				const ch = chunkOf(g.row.content, hash);
				if (ch) out.push(ch);
			}
			if (!page.more || page.nextAfterSeq <= after) break;
			after = page.nextAfterSeq;
		}
	} catch (e) {
		c.diag("blob-chunk-read-failed", { error: String(e) });
		return null;
	}
	return out;
}

/** Append chunks of one blob as x:<address> frames; true once every chunk is committed. */
export async function appendBlobChunks(c: EngineCtx, hash: ContentHash, chunks: readonly BlobChunkContent[]): Promise<boolean> {
	const session = c.session;
	if (!session || c.stopped || !session.canWrite) return false;
	if (chunks.some((ch) => ch.hash !== hash)) return false;
	const address = await c.deps.crypto.blobAddress(hash);
	if (c.session !== session) return false;
	const stream = blobChunkStream(address);
	const want = new Map<number, BlobChunkContent>();
	for (const ch of chunks) if (!want.has(ch.index)) want.set(ch.index, ch);
	const wait = new Set<ClientFrameId>();
	for (const r of c.outbox.ofStream(stream)) {
		const ch = chunkOf(r.content, hash);
		if (!ch || !want.has(ch.index)) continue;
		if (r.state === "poisoned") return false;
		wait.add(r.clientFrameId);
		want.delete(ch.index);
	}
	if (want.size > 0) {
		const committed = await readBlobChunks(c, hash);
		for (const ch of committed ?? []) want.delete(ch.index);
		if (c.session !== session) return false;
	}
	if (want.size > 0) {
		const parts = [...want.values()];
		const ids = await c.docs.chain(async () => {
			const frames = [];
			for (const ch of parts) frames.push(await buildBlobChunkFrame(c.deps, address, ch, c.ns.coversSeq, c.now()));
			c.addOutbox(await c.repo.tEdit(frames, c.now()));
			return frames.map((f) => f.clientFrameId);
		});
		for (const id of ids) wait.add(id);
	}
	return waitCommitted(c, session, wait, c.tuning.blobAppendTimeoutMs);
}

/** Every record gone from the outbox (receipted) -> true; poisoned, session change, stop or timeout -> false. */
function waitCommitted(c: EngineCtx, session: RelaySession, ids: ReadonlySet<ClientFrameId>, timeoutMs: number): Promise<boolean> {
	const deadline = c.mono() + timeoutMs;
	return new Promise((resolve) => {
		const check = (): void => {
			let all = true;
			for (const id of ids) {
				const r = c.outbox.get(id);
				if (!r) continue;
				if (r.state === "poisoned") return resolve(false);
				all = false;
			}
			if (all) return resolve(true);
			if (c.stopped || c.session !== session || c.mono() >= deadline) return resolve(false);
			c.ports.clock.setTimer(POLL_MS, check);
		};
		check();
	});
}
