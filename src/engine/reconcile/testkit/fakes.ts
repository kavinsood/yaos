/** Virtual clock, seeded random and an in-memory blob store (BlobTransfer) for reconcile tests. */

import type { ContentHash, DocId, VaultPath } from "../../../core/types";
import { prng } from "../../../core/merge/prng";
import { sha256Hex } from "../../../core/hash/sha256";
import type { ClockPort, TimerHandle } from "../../../ports/clock";
import type { RandomPort } from "../../../ports/random";
import type { BlobTransfer } from "../context";

export class FakeClock implements ClockPort {
	wall = 1_700_000_000_000;
	mono = 0;
	/** Runs inside every yieldNow (inject "a remote update arrived during the async gap"). */
	onYield: (() => void | Promise<void>) | null = null;
	private timers = new Map<number, { at: number; fn: () => void }>();
	private nextTimer = 1;

	now(): number { return this.wall; }
	monotonic(): number { return this.mono; }

	advance(ms: number): void {
		this.wall += ms;
		this.mono += ms;
		for (const [h, t] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
			if (t.at <= this.mono) {
				this.timers.delete(h);
				t.fn();
			}
		}
	}

	setTimer(delayMs: number, fn: () => void): TimerHandle {
		const h = this.nextTimer++;
		this.timers.set(h, { at: this.mono + delayMs, fn });
		return h;
	}

	clearTimer(handle: TimerHandle): void {
		this.timers.delete(handle);
	}

	async yieldNow(): Promise<void> {
		if (this.onYield) await this.onYield();
	}
}

export class FakeRandom implements RandomPort {
	private readonly next: () => number;
	constructor(seed = 1) { this.next = prng(seed); }
	bytes(length: number): Uint8Array {
		const out = new Uint8Array(length);
		for (let i = 0; i < length; i++) out[i] = Math.floor(this.next() * 256);
		return out;
	}
	float(): number { return this.next(); }
}

/** Shared "server" of blobs by hash. Toggle `available` / `uploadOk` to simulate outages. */
export class FakeBlobs implements BlobTransfer {
	readonly server = new Map<string, Uint8Array>();
	available = true;
	uploadOk = true;
	/** upload() refuses every hash it sees from now on, for good (the store's 413: BlobTransfer.refused). */
	refuseUploads = false;
	readonly refusedHashes = new Set<string>();
	uploads: { hash: string; docId: DocId; path: VaultPath }[] = [];
	downloads: { hash: string; docId: DocId; path: VaultPath }[] = [];
	/** prefetch(): results held at once (0 = refuse every prefetch); log of prefetched hashes, takes, drops. */
	window = 0;
	readonly ahead = new Set<string>();
	prefetches: string[] = [];
	taken: string[] = [];
	maxAhead = 0;
	drops = 0;
	constructor(readonly maxBlobBytes = 8 * 1024 * 1024) {}

	prefetch(req: { hash: string; docId: DocId; path: VaultPath; size: number }): boolean {
		if (this.ahead.has(req.hash)) return true;
		if (this.ahead.size >= this.window) return false;
		this.ahead.add(req.hash);
		this.prefetches.push(req.hash);
		this.maxAhead = Math.max(this.maxAhead, this.ahead.size);
		return true;
	}

	dropPrefetched(): void {
		this.drops++;
		this.ahead.clear();
	}

	put(bytes: Uint8Array): ContentHash {
		const hash = sha256Hex(bytes) as ContentHash;
		this.server.set(hash, bytes.slice());
		return hash;
	}

	refused(hash: string): boolean {
		return this.refusedHashes.has(hash);
	}

	async upload(req: { hash: string; docId: DocId; path: VaultPath; bytes: Uint8Array }): Promise<boolean> {
		if (this.refusedHashes.has(req.hash)) return false;
		this.uploads.push({ hash: req.hash, docId: req.docId, path: req.path });
		if (this.refuseUploads) {
			this.refusedHashes.add(req.hash);
			return false;
		}
		if (!this.uploadOk) return false;
		this.server.set(req.hash, req.bytes.slice());
		return true;
	}

	async download(req: { hash: string; docId: DocId; path: VaultPath; size: number }): Promise<Uint8Array | null> {
		this.downloads.push({ hash: req.hash, docId: req.docId, path: req.path });
		if (this.ahead.delete(req.hash)) this.taken.push(req.hash);
		if (!this.available) return null;
		const b = this.server.get(req.hash);
		return b ? b.slice() : null;
	}
}
