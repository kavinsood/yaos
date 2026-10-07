/**
 * Handle lifecycle and residency (DESIGN §d.1, §i.3).
 *
 *   cold --load--> resident --bind--> bound ; evict(clean) drops the Y.Doc.
 *
 * load = one Y.transact(LOAD): snapshot, every tail row (refs resolved), then
 * every own non-poisoned outbox record of the stream in order. O(doc), once per
 * residency. Clean-only LRU eviction within maxResidentDocs / maxResidentBytes.
 */

import * as Y from "yjs";
import { CheckpointEncoding } from "../../core/envelope";
import type { Budgets } from "../../core/limits";
import { streamClass, streamDocId, type DocId, type StreamName } from "../../core/types";
import type { Repo } from "../store/repo";
import type { TailRecord } from "../store/schema";
import { FrameBuilder } from "./frameBuilder";
import { ORIGIN } from "./yjsCounters";

export interface Handle {
	readonly stream: StreamName;
	readonly docId: DocId;
	readonly cls: "body" | "canvas";
	readonly doc: Y.Doc;
	readonly builder: FrameBuilder;
	/** 3 x (snapshot + tail + applied update bytes). */
	bytesEstimate: number;
	/** Bound views (pinned while > 0). */
	bound: number;
	/** Jobs holding the handle (merge, union, compaction, causal check). */
	pins: number;
	lastAccessMono: number;
	/** Tail ref rows whose update is not available yet (doc shows wait/blob-unavailable). */
	unresolvedRefs: number;
	/** Those rows, retried on a per-stream backoff timer (DocRuntime; none without a blob store). */
	unresolvedRows: TailRecord[];
	/** Builder close timer. */
	timer: number | null;
}

export interface HandleHooks {
	/** Resolve a bodyUpdateRef tail row to the update bytes (gated), or null if unavailable yet. */
	resolveRef(row: TailRecord): Promise<Uint8Array | null>;
	/** Called once per new handle before load (attach doc listeners). */
	onCreate(h: Handle): void;
	/** Called once a load completed (unresolvedRows set: arm their retry). */
	onLoaded(h: Handle): void;
	/** Called after eviction. */
	onEvict(h: Handle): void;
	monotonic(): number;
}

export class HandleManager {
	private readonly handles = new Map<StreamName, Handle>();
	private readonly loading = new Map<StreamName, Promise<Handle>>();
	loads = 0;

	constructor(private readonly repo: Repo, public budgets: Budgets, private readonly hooks: HandleHooks) {}

	get(stream: StreamName): Handle | undefined {
		const h = this.handles.get(stream);
		if (h) h.lastAccessMono = this.hooks.monotonic();
		return h;
	}
	/** Like get() without touching the LRU clock. */
	peek(stream: StreamName): Handle | undefined {
		return this.handles.get(stream);
	}
	isResident(stream: StreamName): boolean {
		return this.handles.has(stream);
	}
	/**
	 * In-flight load of the stream. Rows committed while a load is between its
	 * read tx and registration must be applied after it (idempotent either way).
	 */
	loadingOf(stream: StreamName): Promise<Handle> | undefined {
		return this.loading.get(stream);
	}
	all(): IterableIterator<Handle> {
		return this.handles.values();
	}
	get count(): number {
		return this.handles.size;
	}
	get bytes(): number {
		let n = 0;
		for (const h of this.handles.values()) n += h.bytesEstimate;
		return n;
	}

	isClean(h: Handle): boolean {
		return h.bound === 0 && h.pins === 0 && h.builder.empty;
	}

	/** Load (or return) the handle and pin it; callers must unpin(). */
	async acquire(stream: StreamName): Promise<Handle> {
		const h = await this.load(stream);
		h.pins++;
		return h;
	}
	unpin(h: Handle): void {
		h.pins = Math.max(0, h.pins - 1);
		this.enforceBudget();
	}

	async load(stream: StreamName): Promise<Handle> {
		const existing = this.get(stream);
		if (existing) return existing;
		const inflight = this.loading.get(stream);
		if (inflight) return inflight;
		const p = this.doLoad(stream).finally(() => this.loading.delete(stream));
		this.loading.set(stream, p);
		return p;
	}

	private async doLoad(stream: StreamName): Promise<Handle> {
		const cls = streamClass(stream);
		const docId = streamDocId(stream);
		if ((cls !== "body" && cls !== "canvas") || !docId) throw new Error(`not a doc stream: ${stream}`);
		this.enforceBudget(1);
		const { snapshot, tail, outbox } = await this.repo.loadStream(stream);
		const resolved = new Map<number, Uint8Array | null>();
		for (const row of tail) if (row.kind === "bodyUpdateRef") resolved.set(row.seq, await this.hooks.resolveRef(row));
		// A concurrent load cannot have won (loads are deduplicated), but an eviction race can re-enter: re-check.
		const raced = this.handles.get(stream);
		if (raced) return raced;
		const doc = new Y.Doc({ gc: true });
		const h: Handle = {
			stream, docId, cls, doc, builder: new FrameBuilder(), bytesEstimate: 0, bound: 0, pins: 0,
			lastAccessMono: this.hooks.monotonic(), unresolvedRefs: 0, unresolvedRows: [], timer: null,
		};
		this.hooks.onCreate(h);
		let bytes = 0;
		doc.transact(() => {
			if (snapshot && snapshot.encoding === CheckpointEncoding.yjsStateV1 && snapshot.bytes.length > 0) {
				Y.applyUpdate(doc, snapshot.bytes, ORIGIN.LOAD);
				bytes += snapshot.bytes.length;
			}
			for (const row of tail) {
				if (row.kind === "bodyUpdate" || row.kind === "canvasUpdate") {
					// Empty content: an own ref frame recovered from the mirror without its update (gap, see notes).
					if (row.content.length === 0) continue;
					Y.applyUpdate(doc, row.content, ORIGIN.LOAD);
					bytes += row.content.length;
				} else if (row.kind === "bodyUpdateRef") {
					const u = resolved.get(row.seq) ?? null;
					if (u) {
						Y.applyUpdate(doc, u, ORIGIN.LOAD);
						bytes += u.length;
					} else {
						h.unresolvedRefs++;
						h.unresolvedRows.push(row);
					}
				}
			}
			for (const r of outbox) {
				if (r.state === "poisoned" || r.content.length === 0) continue;
				if (r.kind !== "bodyUpdate" && r.kind !== "canvasUpdate" && r.kind !== "bodyUpdateRef") continue;
				Y.applyUpdate(doc, r.content, ORIGIN.LOAD);
				bytes += r.content.length;
			}
		}, ORIGIN.LOAD);
		h.bytesEstimate = 3 * bytes;
		this.handles.set(stream, h);
		this.loads++;
		this.hooks.onLoaded(h);
		return h;
	}

	/** Account applied bytes towards the residency estimate. */
	grow(h: Handle, bytes: number): void {
		h.bytesEstimate += 3 * bytes;
	}

	/** Drop the replica (rebuild after poison, or IDB-driven reload). The caller ensures it is safe. */
	drop(stream: StreamName): void {
		const h = this.handles.get(stream);
		if (!h) return;
		this.handles.delete(stream);
		h.doc.destroy();
		this.hooks.onEvict(h);
	}

	/** Evict clean handles, LRU first, until within budget (`extra` = slots to make room for). */
	enforceBudget(extra = 0): void {
		const overDocs = () => this.handles.size + extra > this.budgets.maxResidentDocs;
		const overBytes = () => this.bytes > this.budgets.maxResidentBytes;
		if (!overDocs() && !overBytes()) return;
		const clean = [...this.handles.values()].filter((h) => this.isClean(h)).sort((a, b) => a.lastAccessMono - b.lastAccessMono);
		for (const h of clean) {
			if (!overDocs() && !overBytes()) break;
			this.drop(h.stream);
		}
	}

	/** memory-pressure: evict every clean handle. */
	evictAllClean(): number {
		let n = 0;
		for (const h of [...this.handles.values()]) {
			if (this.isClean(h)) {
				this.drop(h.stream);
				n++;
			}
		}
		return n;
	}
}

/** Stage 3 checks (DESIGN §d.6): missing structs or a delete set waiting for structs. */
export function hasCausalHole(doc: Y.Doc): boolean {
	return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

export function docTextLength(h: Handle): number {
	if (h.cls === "body") return h.doc.getText("text").length;
	let n = 0;
	for (const name of ["nodes", "edges", "doc"]) n += JSON.stringify(h.doc.getMap(name).toJSON()).length;
	return n;
}
