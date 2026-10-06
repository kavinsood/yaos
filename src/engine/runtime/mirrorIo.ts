/**
 * Outbox mirror I/O (DESIGN §e.4, §i.5): the A/B side-file copy of the
 * outbox, written debounced after every outbox change, and the recovery path
 * that re-imports it into a fresh DB after IndexedDB loss.
 *
 * The mirror carries sealed bytes + identity only; recovery opens each
 * envelope for kind / flags / content. A bodyUpdateRef's local content (the
 * full update) is rebuilt from the mirrored x: chunk frames, else from the
 * blob store, else left empty (the sealed frame still goes out unchanged).
 */

import { OUTBOX_MIRROR_MAX_BYTES } from "../../core/limits";
import { streamClass, type ContentHash } from "../../core/types";
import type { SideFileName, SideFilePort } from "../../ports/vault";
import { assembleChunks, resolveRefContent } from "../body/refs";
import { openEnvelope } from "../ingest/envelope";
import type { OutboxMirrorFrame, OutboxRecord } from "../store/schema";
import { decodeBlobChunk, decodeBodyUpdateRef } from "../../core/codec/contents";
import { bytesToHex } from "../../core/codec/lib0";
import type { EngineCtx } from "./context";
import { decodeOutboxMirror, encodeOutboxMirror, nextMirrorSlot, pickOutboxMirror, selectMirrorFrames, type MirrorIdentity } from "./mirrors";

const FILES: readonly [SideFileName, SideFileName] = ["outbox-a.bin", "outbox-b.bin"];

function identityOf(c: EngineCtx): MirrorIdentity {
	return { vaultId: c.opts.vaultId, vaultEpoch: c.repo.identity.vaultEpoch, deviceId: c.self };
}

export class MirrorWriter {
	private gens: [number | null, number | null] = [null, null];
	private timer: number | null = null;
	private dirty = false;
	private writing: Promise<void> | null = null;
	stats = { writes: 0, failures: 0, lastFrames: 0, lastBytes: 0 };

	constructor(private readonly c: EngineCtx, private readonly files: SideFilePort | null) {}

	get enabled(): boolean {
		return this.files !== null;
	}

	/** Learn the on-disk generations (identity matches only) so the next write takes the older slot. */
	async readGenerations(): Promise<void> {
		if (!this.files) return;
		const id = identityOf(this.c);
		for (let i = 0; i < 2; i++) {
			let g: number | null = null;
			try {
				const bytes = await this.files.read(FILES[i]!);
				const m = bytes ? await decodeOutboxMirror(bytes, this.c.ports.hash) : null;
				if (m && m.vaultId === id.vaultId && m.vaultEpoch === id.vaultEpoch && m.deviceId === id.deviceId) g = m.generation;
			} catch {
				g = null;
			}
			this.gens[i] = g;
		}
	}

	schedule(): void {
		if (!this.files) return;
		this.dirty = true;
		if (this.timer !== null || this.c.stopped) return;
		this.timer = this.c.ports.clock.setTimer(this.c.tuning.mirrorDebounceMs, () => {
			this.timer = null;
			void this.flush();
		});
	}

	cancel(): void {
		if (this.timer !== null) this.c.ports.clock.clearTimer(this.timer);
		this.timer = null;
	}

	/** Write now if dirty (single writer; loops while new changes arrive). */
	flush(): Promise<void> {
		if (!this.files) return Promise.resolve();
		this.cancel();
		if (this.writing) return this.writing.then(() => (this.dirty ? this.flush() : undefined));
		if (!this.dirty) return Promise.resolve();
		const p = this.writeLoop().finally(() => {
			this.writing = null;
		});
		this.writing = p;
		return p;
	}

	private async writeLoop(): Promise<void> {
		const files = this.files!;
		while (this.dirty) {
			this.dirty = false;
			const frames = selectMirrorFrames(this.c.outbox.all(), OUTBOX_MIRROR_MAX_BYTES);
			const { slot, generation } = nextMirrorSlot(this.gens);
			try {
				const id = identityOf(this.c);
				const bytes = await encodeOutboxMirror({ ...id, generation, writtenAtMs: this.c.now(), frames }, this.c.ports.hash);
				await files.write(FILES[slot], bytes);
				this.gens[slot] = generation;
				this.stats.writes++;
				this.stats.lastFrames = frames.length;
				this.stats.lastBytes = bytes.length;
			} catch (e) {
				this.stats.failures++;
				this.c.diag("mirror-write-failed", { error: String(e) });
				return;
			}
		}
	}
}

/**
 * Fresh DB + mirror present: import the mirrored outbox (DESIGN §i.5).
 * Returns the number of frames imported (0 = nothing usable).
 */
export async function recoverFromMirror(c: EngineCtx, files: SideFilePort): Promise<number> {
	const raw: (Uint8Array | null)[] = [];
	for (const f of FILES) {
		try {
			raw.push(await files.read(f));
		} catch {
			raw.push(null);
		}
	}
	const picked = await pickOutboxMirror(raw, identityOf(c), c.ports.hash);
	if (!picked || picked.mirror.frames.length === 0) return 0;
	const now = c.now();
	const opened: { f: OutboxMirrorFrame; kind: OutboxRecord["kind"]; flags: number; content: Uint8Array }[] = [];
	const chunks = new Map<string, Uint8Array[]>();
	for (const f of picked.mirror.frames) {
		const o = await openEnvelope(c.ports.crypto, c.opts.vaultId, { t: "frame", stream: f.stream, clientFrameId: f.clientFrameId }, f.sealed);
		if (!o.ok) {
			c.diag("mirror-frame-unreadable", { reason: o.reason });
			continue;
		}
		opened.push({ f, kind: o.inner.kind, flags: o.inner.flags, content: o.inner.content });
		if (streamClass(f.stream) === "blobchunk") {
			const d = decodeBlobChunk(o.inner.content);
			if (d) {
				const l = chunks.get(d.hash) ?? [];
				l.push(o.inner.content);
				chunks.set(d.hash, l);
			}
		}
	}
	const records: OutboxRecord[] = [];
	for (const { f, kind, flags, content } of opened) {
		let local = content;
		if (kind === "bodyUpdateRef") {
			local = new Uint8Array(0);
			const ref = decodeBodyUpdateRef(content);
			if (ref) {
				const fromChunks = assembleChunks(chunks.get(ref.hash) ?? [], ref.hash as ContentHash);
				if (fromChunks && bytesToHex(await c.ports.hash.sha256(fromChunks)) === ref.hash) local = fromChunks;
				else local = (await resolveRefContent(c.deps, f.stream, content)) ?? new Uint8Array(0);
			}
			if (local.length === 0) c.diag("mirror-ref-content-missing", {});
		}
		records.push({
			clientFrameId: f.clientFrameId, order: f.order, stream: f.stream, kind, state: f.state, sealed: f.sealed, content: local,
			authorNsSeq: f.authorNsSeq, flags, dependsOn: f.dependsOn,
			adoptOf: f.adoptOf ? { ...f.adoptOf, receivedAtMs: now } : null, attempts: 0, createdAtMs: now, lastSentAtMs: 0,
		});
	}
	if (records.length === 0) return 0;
	await c.repo.tImportOutbox(records, now);
	c.diag("recovered-from-mirror", { frames: records.length, generation: picked.mirror.generation });
	return records.length;
}
