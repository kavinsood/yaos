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

import type { BlobChunkContent } from "../../core/envelope";
import { OUTBOX_MIRROR_MAX_BYTES } from "../../core/limits";
import { streamClass } from "../../core/types";
import type { SideFileName, SideFilePort } from "../../ports/vault";
import { resolveRefContent } from "../body/refs";
import { assembleChunks } from "../blobs/chunks";
import { openEnvelope } from "../ingest/envelope";
import type { OutboxMirrorFrame, OutboxRecord } from "../store/schema";
import { decodeBlobChunk, decodeBodyUpdateRef } from "../../core/codec/contents";
import type { EngineCtx } from "./context";
import { decodeOutboxMirror, encodeOutboxMirror, nextMirrorSlot, pickOutboxMirror, selectMirrorFrames, type MirrorIdentity } from "./mirrors";

const FILES: readonly [SideFileName, SideFileName] = ["outbox-a.bin", "outbox-b.bin"];

function identityOf(c: EngineCtx): MirrorIdentity {
	return { vaultId: c.opts.vaultId, vaultEpoch: c.repo.identity.vaultEpoch, deviceId: c.self };
}

export class MirrorWriter {
	private gens: [number | null, number | null] = [null, null];
	/** Frame ids of the newest on-disk mirror for this identity (readGenerations); null: none. */
	private onDisk: ReadonlySet<string> | null = null;
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
		let newest = -1;
		this.onDisk = null;
		for (let i = 0; i < 2; i++) {
			let g: number | null = null;
			try {
				const bytes = await this.files.read(FILES[i]!);
				const m = bytes ? await decodeOutboxMirror(bytes, this.c.ports.hash) : null;
				if (m && m.vaultId === id.vaultId && m.vaultEpoch === id.vaultEpoch && m.deviceId === id.deviceId) {
					g = m.generation;
					if (g > newest) {
						newest = g;
						this.onDisk = new Set(m.frames.map((f) => f.clientFrameId));
					}
				}
			} catch {
				g = null;
			}
			this.gens[i] = g;
		}
	}

	/**
	 * Start over a stored outbox: rewrite the mirror when it does not hold
	 * exactly these frames. The app can die inside the write debounce, after
	 * frames reached the store but not the mirror; nothing else rewrites it
	 * until the outbox next changes, while the synced mirror moves on to sync
	 * points those frames carry (an IDB loss then drops them and the merge
	 * takes the disk as base: their text is overwritten, sim heavy seed 246).
	 */
	scheduleIfBehind(records: readonly OutboxRecord[]): void {
		if (!this.files) return;
		const want = selectMirrorFrames(records, OUTBOX_MIRROR_MAX_BYTES);
		const have = this.onDisk;
		if (have === null ? want.length === 0 : have.size === want.length && want.every((f) => have.has(f.clientFrameId))) return;
		this.schedule();
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

	/** Flush; true when the mirror now holds the outbox (or there is no mirror). */
	async flushed(): Promise<boolean> {
		await this.flush();
		return !this.dirty;
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
				this.dirty = true; // still behind: the next change or flush retries
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
	const opened: { f: OutboxMirrorFrame; kind: OutboxRecord["kind"]; flags: number; frameNo: number; content: Uint8Array }[] = [];
	const chunks = new Map<string, BlobChunkContent[]>();
	for (const f of picked.mirror.frames) {
		const o = await openEnvelope(c.ports.crypto, c.opts.vaultId, { t: "frame", stream: f.stream, deviceId: c.self, clientFrameId: f.clientFrameId }, f.sealed);
		if (!o.ok) {
			c.diag("mirror-frame-unreadable", { reason: o.reason });
			continue;
		}
		opened.push({ f, kind: o.inner.kind, flags: o.inner.flags, frameNo: o.inner.frameNo, content: o.inner.content });
		if (streamClass(f.stream) === "blobchunk") {
			const d = decodeBlobChunk(o.inner.content);
			if (d) {
				const l = chunks.get(d.hash) ?? [];
				l.push(d);
				chunks.set(d.hash, l);
			}
		}
	}
	const records: OutboxRecord[] = [];
	for (const { f, kind, flags, frameNo, content } of opened) {
		let local = content;
		if (kind === "bodyUpdateRef") {
			local = new Uint8Array(0);
			const ref = decodeBodyUpdateRef(content);
			if (ref) {
				const fromChunks = assembleChunks(ref.hash, chunks.get(ref.hash) ?? []);
				local = fromChunks.ok ? fromChunks.bytes : (await resolveRefContent(c.deps, f.stream, content)) ?? new Uint8Array(0);
			}
			if (local.length === 0) c.diag("mirror-ref-content-missing", {});
		}
		records.push({
			clientFrameId: f.clientFrameId, order: f.order, stream: f.stream, kind, state: f.state, sealed: f.sealed, content: local,
			authorNsSeq: f.authorNsSeq, flags, frameNo: frameNo === 0 ? null : frameNo, dependsOn: f.dependsOn,
			adoptOf: f.adoptOf ? { ...f.adoptOf, receivedAtMs: now } : null, attempts: 0, createdAtMs: now, lastSentAtMs: 0,
		});
	}
	if (records.length === 0) return 0;
	await c.repo.tImportOutbox(records, now);
	c.diag("recovered-from-mirror", { frames: records.length, generation: picked.mirror.generation });
	return records.length;
}
