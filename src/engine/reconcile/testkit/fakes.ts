/** Virtual clock, seeded random and an in-memory blob store (BlobTransfer) for reconcile tests. */

import type { ContentHash, DocId, VaultPath } from "../../../core/types";
import { prng } from "../../../core/merge/prng";
import { sha256HexRef } from "../../../core/hash/testkit/hashRef";
import type { ClockPort, TimerHandle } from "../../../ports/clock";
import type { RandomPort } from "../../../ports/random";
import type { BlobReq, BlobTransfer, DownloadClaim, UploadClaim, UploadSource } from "../context";

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

/**
 * Shared "server" of blobs by hash, with transfers in the background as the blob queue runs them: a claim starts
 * one (answer "busy"), settle() runs every started one (World.sync does, between its passes), and the docs' next
 * pass takes the outcome. A failed transfer answers "unavailable" (backing off) until retry() (World.sync calls it
 * first: time passed). Downloaded bytes no job of a later pass over their doc took are dropped (endPass), as the
 * blob queue does. Toggle `available` / `uploadOk` to simulate outages. upload() / download() are the awaited
 * calls (settings sync).
 */
export class FakeBlobs implements BlobTransfer {
	readonly server = new Map<string, Uint8Array>();
	available = true;
	uploadOk = true;
	/** The store refuses every hash it sees from now on, for good (its 413). */
	refuseUploads = false;
	readonly refusedHashes = new Set<string>();
	uploads: { hash: string; docId: DocId; path: VaultPath }[] = [];
	downloads: { hash: string; docId: DocId; path: VaultPath }[] = [];
	/** Claimants of the transfers that settled (every settle()), as the blob queue's wake names them. */
	readonly woken: { readonly docId: DocId; readonly path: VaultPath }[] = [];
	/** Downloaded hashes endPass dropped (no job took them). */
	readonly dropped: string[] = [];
	private readonly started = new Map<string, { readonly who: Map<DocId, VaultPath>; readonly run: () => Promise<void> }>();
	private readonly confirmed = new Set<string>();
	private readonly ready = new Map<string, { readonly bytes: Uint8Array; readonly who: ReadonlyMap<DocId, VaultPath>; readonly pass: number }>();
	private readonly backingOff = new Set<string>();
	private passes = 0;
	constructor(readonly maxBlobBytes = 8 * 1024 * 1024) {}

	put(bytes: Uint8Array): ContentHash {
		const hash = sha256HexRef(bytes) as ContentHash;
		this.server.set(hash, bytes.slice());
		return hash;
	}

	/** Transfers claimed and not settled yet. */
	get inFlight(): number {
		return this.started.size;
	}

	/** Downloaded hashes no job took yet. */
	get readyHashes(): readonly string[] {
		return [...this.ready.keys()];
	}

	claimUpload(req: BlobReq, source: UploadSource): UploadClaim {
		if (this.refusedHashes.has(req.hash)) return "refused";
		if (this.confirmed.has(req.hash)) return "stored";
		const key = `up:${req.hash}`;
		return this.start(key, req, async () => {
			const bytes = await source.read();
			if (!bytes) return void this.backingOff.add(key);
			if (sha256HexRef(bytes) !== req.hash) return source.changed();
			if (await this.upload({ hash: req.hash, docId: req.docId, path: req.path, bytes })) this.confirmed.add(req.hash);
			else if (!this.refusedHashes.has(req.hash)) this.backingOff.add(key);
		}) ?? "busy";
	}

	claimDownload(req: BlobReq): DownloadClaim {
		const got = this.ready.get(req.hash);
		if (got) {
			this.ready.delete(req.hash);
			return { t: "bytes", bytes: got.bytes };
		}
		const key = `down:${req.hash}`;
		const res = this.start(key, req, async (who) => {
			const bytes = await this.download(req);
			if (bytes) this.ready.set(req.hash, { bytes, who, pass: this.passes });
			else this.backingOff.add(key);
		});
		return res === "unavailable" ? { t: "unavailable" } : { t: "busy" };
	}

	beginPass(): number {
		return ++this.passes;
	}

	endPass(token: number, covers: (docId: DocId, path: VaultPath) => boolean): void {
		for (const [hash, r] of this.ready) {
			if (r.pass >= token || ![...r.who].some(([d, p]) => covers(d, p))) continue;
			this.ready.delete(hash);
			this.dropped.push(hash);
		}
	}

	private start(key: string, req: BlobReq, run: (who: ReadonlyMap<DocId, VaultPath>) => Promise<void>): "unavailable" | null {
		const cur = this.started.get(key);
		if (cur) {
			cur.who.set(req.docId, req.path);
			return null;
		}
		if (this.backingOff.has(key)) return "unavailable";
		const who = new Map([[req.docId, req.path]]);
		this.started.set(key, { who, run: () => run(who) });
		return null;
	}

	/** Run every started transfer to its end; returns how many ran. */
	async settle(): Promise<number> {
		const runs = [...this.started.values()];
		this.started.clear();
		for (const r of runs) {
			await r.run();
			for (const [docId, path] of r.who) this.woken.push({ docId, path });
		}
		return runs.length;
	}

	/** Backoff over: failed transfers may start again. */
	retry(): void {
		this.backingOff.clear();
	}

	/** Process death: transfers in flight, downloaded bytes and the confirmations (all in memory) are lost. */
	crash(): void {
		this.started.clear();
		this.ready.clear();
		this.confirmed.clear();
		this.backingOff.clear();
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

	async download(req: BlobReq): Promise<Uint8Array | null> {
		this.downloads.push({ hash: req.hash, docId: req.docId, path: req.path });
		if (!this.available) return null;
		const b = this.server.get(req.hash);
		return b ? b.slice() : null;
	}
}
