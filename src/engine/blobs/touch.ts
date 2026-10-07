/**
 * BlobTouch (e2ee-design §10.4 R2, R3): keeps this device's blob references alive across another device's GC
 * sweep. A sweep deletes a blob that no reference it can see names and that was uploaded more than the grace
 * before its cutoff, so "the store has it" is not enough to rely on an old upload.
 *
 *  - R2 (PutPolicy.reuse): an upload that finds its address present skips the PUT only if the committed
 *    ns / cfg / snap folds reference the hash (and are current), or this device PUT it less than grace / 2 ago
 *    (persisted put time, meta `blobPut:<address>`). Otherwise it PUTs again, which refreshes the upload time.
 *  - R3 (ready): before the sender sends an own frame that references blobs (ns create/setBlob of a blob, cfg
 *    filePut of a blob, snap put, bodyUpdateRef through the store), each hash must pass the same test; else it
 *    is PUT again from local bytes (the frame's own content for a bodyUpdateRef, the vault file or own snapshot
 *    part otherwise), or, without local bytes, its stored object is re-PUT verbatim. A store error holds the
 *    frame (and later frames of its stream) and retries with backoff.
 *
 * A put time in the future (the clock moved back) or missing counts as stale. Without a blob store a
 * bodyUpdateRef is held (its bytes may never have reached a store; a store found later restarts the runtime)
 * and every other frame passes: reconcile emits a blob reference only after its upload succeeded.
 */

import { decodeCfgOps } from "../../core/codec/cfgOps";
import { bytesToHex } from "../../core/codec/lib0";
import { decodeNsOps } from "../../core/codec/nsOps";
import { decodeSnapOps } from "../../core/snap/record";
import type { SnapFoldState } from "../../core/snap/fold";
import type { CfgFoldState, ClientFrameId, ContentHash, NsFoldState } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { BlobAddress, CryptoPort, HashPort } from "../../ports/crypto";
import type { OutboxRecord } from "../store/schema";
import { putAt, type PutPolicy } from "./blobStore";

/** Hashes the committed folds reference: every ns entry's blob (tombstones keep theirs), cfg file blobs, snap parts. */
export function committedBlobHashes(ns: NsFoldState, cfg: CfgFoldState, snap: SnapFoldState): Set<ContentHash> {
	const out = new Set<ContentHash>();
	for (const e of ns.entries.values()) if (e.blob) out.add(e.blob.hash);
	for (const r of cfg.files.values()) if (r.value?.content.t === "blob") out.add(r.value.content.hash);
	for (const e of snap.records.values()) for (const p of e.record.parts) out.add(p.sha256);
	return out;
}

/**
 * Blob hashes an own outbox record references through its decoded content; "bodyRef" = a bodyUpdateRef, whose
 * hash is the sha256 of the record's content (the full update, frames.ts). Other kinds reference none.
 */
export function frameBlobHashes(rec: Pick<OutboxRecord, "kind" | "content">): ContentHash[] | "bodyRef" {
	switch (rec.kind) {
		case "nsOps": {
			const out: ContentHash[] = [];
			for (const op of decodeNsOps(rec.content) ?? []) {
				if (op.t === "create" && op.kind === "blob") out.push(op.contentHash);
				else if (op.t === "setBlob") out.push(op.hash);
			}
			return out;
		}
		case "cfgOps": {
			const out: ContentHash[] = [];
			for (const op of decodeCfgOps(rec.content) ?? []) if (op.t === "filePut" && op.content.t === "blob") out.push(op.content.hash);
			return out;
		}
		case "snapOps": {
			const out: ContentHash[] = [];
			for (const op of decodeSnapOps(rec.content) ?? []) if (op.t === "put") for (const p of op.record.parts) out.push(p.sha256);
			return out;
		}
		case "bodyUpdateRef":
			return "bodyRef";
		default:
			return [];
	}
}

export interface PutTimes {
	blobPutAt(address: string): Promise<number | null>;
	noteBlobPut(address: string, atMs: number): Promise<void>;
}

export interface BlobTouchDeps {
	readonly store: BlobPort | null;
	readonly crypto: CryptoPort;
	readonly hash: HashPort;
	readonly clock: ClockPort;
	/** EngineTuning.blobGcGraceMs; fresh = put less than half of it ago. */
	readonly graceMs: number;
	readonly times: () => PutTimes;
	/** Hashes the committed folds reference, or null when the folds may be behind the relay. */
	readonly committed: () => ReadonlySet<ContentHash> | null;
	/** Local plaintext of `hash` (vault file, own snapshot part), or null; checked here. */
	readonly blobBytes: (hash: ContentHash) => Promise<Uint8Array | null>;
	/** A held frame may be sendable now (pump the sender). */
	readonly onReady: () => void;
	readonly diag: (code: string, fields: Record<string, string | number | boolean | null>) => void;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const RECENT_MAX = 4_096;

export class BlobTouch implements PutPolicy {
	/** hash -> wall time of this device's PUT (this process). */
	private readonly recent = new Map<ContentHash, number>();
	/** cfid -> monotonic time until which the frame stays cleared to send. */
	private readonly cleared = new Map<ClientFrameId, number>();
	private readonly refs = new Map<ClientFrameId, ContentHash[] | "bodyRef">();
	private readonly evaluating = new Set<ClientFrameId>();
	private readonly retry = new Map<ClientFrameId, { attempts: number; atMono: number; timer: TimerHandle }>();

	constructor(private readonly deps: BlobTouchDeps) {}

	private get half(): number {
		return this.deps.graceMs / 2;
	}

	private fresh(atMs: number | null | undefined, now: number): boolean {
		return atMs !== null && atMs !== undefined && atMs <= now && now - atMs < this.half;
	}

	/** Own PUT of `hash` less than grace / 2 ago (memory, then the persisted time). */
	private async freshPut(hash: ContentHash, address: BlobAddress, now: number): Promise<boolean> {
		if (this.fresh(this.recent.get(hash), now)) return true;
		const at = await this.deps.times().blobPutAt(address);
		if (!this.fresh(at, now)) return false;
		this.remember(hash, at!);
		return true;
	}

	private remember(hash: ContentHash, atMs: number): void {
		this.recent.set(hash, atMs);
		if (this.recent.size <= RECENT_MAX) return;
		const now = this.deps.clock.now();
		for (const [h, at] of this.recent) if (!this.fresh(at, now)) this.recent.delete(h);
		while (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value!);
	}

	/** R2. */
	async reuse(hash: ContentHash, address: BlobAddress): Promise<boolean> {
		if (this.deps.committed()?.has(hash)) return true;
		return this.freshPut(hash, address, this.deps.clock.now());
	}

	async noted(hash: ContentHash, address: BlobAddress): Promise<void> {
		const now = this.deps.clock.now();
		this.remember(hash, now);
		await this.deps.times().noteBlobPut(address, now);
	}

	/** New session: re-check every frame before it is sent again. */
	reset(): void {
		this.cleared.clear();
	}

	/** The record left the sender. */
	forget(cfid: ClientFrameId): void {
		this.cleared.delete(cfid);
		this.refs.delete(cfid);
		const r = this.retry.get(cfid);
		if (r) this.deps.clock.clearTimer(r.timer);
		this.retry.delete(cfid);
	}

	private refsOf(rec: OutboxRecord): ContentHash[] | "bodyRef" {
		let r = this.refs.get(rec.clientFrameId);
		if (r === undefined) {
			r = frameBlobHashes(rec);
			this.refs.set(rec.clientFrameId, r);
		}
		return r;
	}

	/** R3 sender gate: true = send now; false = held until onReady (re-PUT running, or a store error backing off). */
	ready(rec: OutboxRecord): boolean {
		if (!this.deps.store) return this.refsOf(rec) !== "bodyRef";
		const cfid = rec.clientFrameId;
		const mono = this.deps.clock.monotonic();
		const until = this.cleared.get(cfid);
		if (until !== undefined && until > mono) return true;
		if (this.evaluating.has(cfid)) return false;
		const r = this.retry.get(cfid);
		if (r && r.atMono > mono) return false;
		const refs = this.refsOf(rec);
		if (refs !== "bodyRef") {
			if (refs.length === 0) return true;
			const now = this.deps.clock.now();
			const committed = this.deps.committed();
			if (refs.every((h) => committed?.has(h) || this.fresh(this.recent.get(h), now))) {
				this.cleared.set(cfid, mono + this.deps.graceMs / 4);
				return true;
			}
		}
		this.evaluate(rec, refs);
		return false;
	}

	private evaluate(rec: OutboxRecord, refs: ContentHash[] | "bodyRef"): void {
		const cfid = rec.clientFrameId;
		this.evaluating.add(cfid);
		void this.check(rec, refs).then(
			() => {
				this.evaluating.delete(cfid);
				this.retry.delete(cfid);
				if (this.refs.has(cfid)) this.cleared.set(cfid, this.deps.clock.monotonic() + this.deps.graceMs / 4);
				this.deps.onReady();
			},
			(e: unknown) => {
				this.evaluating.delete(cfid);
				if (!this.refs.has(cfid)) return; // forgotten meanwhile
				const attempts = (this.retry.get(cfid)?.attempts ?? 0) + 1;
				const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
				this.deps.diag("blob-refresh-failed", { kind: rec.kind, attempts, error: String(e) });
				const timer = this.deps.clock.setTimer(wait, () => this.deps.onReady());
				this.retry.set(cfid, { attempts, atMono: this.deps.clock.monotonic() + wait, timer });
			},
		);
	}

	private async check(rec: OutboxRecord, refs: ContentHash[] | "bodyRef"): Promise<void> {
		const { crypto } = this.deps;
		if (refs === "bodyRef") {
			const hash = bytesToHex(await this.deps.hash.sha256(rec.content)) as ContentHash;
			await this.refresh(hash, await crypto.blobAddress(hash), rec.content);
			return;
		}
		for (const hash of new Set(refs)) await this.refresh(hash, await crypto.blobAddress(hash), null);
	}

	/** Makes `hash` safe to reference now: committed, fresh own PUT, or PUT again. Store errors throw. */
	private async refresh(hash: ContentHash, address: BlobAddress, own: Uint8Array | null): Promise<void> {
		if (this.deps.committed()?.has(hash)) return;
		if (await this.freshPut(hash, address, this.deps.clock.now())) return;
		const store = this.deps.store!;
		const bytes = own ?? (await this.localBytes(hash));
		if (bytes) {
			await putAt(store, this.deps.crypto, this, hash, address, bytes);
			this.deps.diag("blob-refreshed", { from: own ? "frame" : "local" });
			return;
		}
		const sealed = await store.get(address);
		if (sealed) {
			await store.put(address, [sealed]);
			await this.noted(hash, address);
			this.deps.diag("blob-refreshed", { from: "store" });
			return;
		}
		// Neither local bytes nor a stored object: the reference is already unresolvable, holding it helps no one.
		this.deps.diag("blob-refresh-missing", {});
	}

	private async localBytes(hash: ContentHash): Promise<Uint8Array | null> {
		const bytes = await this.deps.blobBytes(hash);
		if (!bytes) return null;
		return bytesToHex(await this.deps.hash.sha256(bytes)) === hash ? bytes : null;
	}
}
