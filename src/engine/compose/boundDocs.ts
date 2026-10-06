/**
 * Bound docs and the docUpdate flow control (DESIGN §d.2, §g.3, §g.4).
 *
 * A bound doc has a main replica in an editor view. Updates the host did not
 * author (remote, provisional, merge) go out as `docUpdate` events, FIFO per
 * doc, within the docCredit window: the host returns credit after applying.
 * A doc whose queue grows past 4x the window drops its queue and gets one
 * full-state `resync` instead (applying a full state on main is idempotent).
 *
 * Paths whose openDoc answered `untracked` are remembered; when they become
 * tracked (a create was planned or folded) the host gets `bindable`.
 */

import type { DocId, PathKey, VaultPath } from "../../core/types";
import type { DocUpdateOrigin, EngineToMain } from "../../protocol/messages";
import { owned } from "../../protocol/workerTransport";

export interface BoundDoc {
	readonly docId: DocId;
	/**
	 * Path of the file the views show: set at bind, moved by every vault rename of that file (Obsidian moves
	 * view.file in place, for a user rename and for the projection's vault.rename alike; followRename).
	 */
	path: VaultPath;
	readonly views: Set<number>;
}

interface Queue {
	parts: { readonly update: Uint8Array; readonly origin: DocUpdateOrigin }[];
	bytes: number;
	resync: boolean;
}

export interface BoundDocsDeps {
	post(message: EngineToMain): void;
	/** docUpdate credit window in bytes (BUDGETS[deviceClass].docUpdateWindowBytes). */
	window(): number;
	/** Full state of the worker replica for a resync; null if the doc is gone. */
	fullState(docId: DocId): Uint8Array | null;
}

export class BoundDocs {
	readonly byId = new Map<DocId, BoundDoc>();
	/** Paths answered `untracked` by openDoc, keyed by the requested path. */
	readonly waiting = new Set<VaultPath>();
	private creditUsed = 0;
	private readonly queues = new Map<DocId, Queue>();
	readonly stats = { docUpdatesSent: 0, resyncs: 0, bytesSent: 0 };

	constructor(private readonly deps: BoundDocsDeps) {}

	get size(): number {
		return this.byId.size;
	}

	isBound(docId: DocId): boolean {
		return this.byId.has(docId);
	}

	/** Adds a view; returns true when this is the doc's first view. The bind state covers anything queued. */
	add(docId: DocId, path: VaultPath, viewId: number): boolean {
		this.waiting.delete(path);
		let b = this.byId.get(docId);
		const first = !b;
		if (!b) {
			b = { docId, path, views: new Set() };
			this.byId.set(docId, b);
		}
		b.path = path;
		b.views.add(viewId);
		this.queues.delete(docId);
		return first;
	}

	/** Removes a view; returns true when the doc has no views left (caller unbinds the replica). */
	remove(docId: DocId, viewId: number): boolean {
		const b = this.byId.get(docId);
		if (!b) return false;
		b.views.delete(viewId);
		if (b.views.size > 0) return false;
		this.byId.delete(docId);
		this.queues.delete(docId);
		return true;
	}

	/** A vault rename `from` -> `to`: views on the file follow it (see BoundDoc.path). */
	followRename(fromKey: PathKey, to: VaultPath, key: (p: VaultPath) => PathKey): void {
		for (const b of this.byId.values()) if (key(b.path) === fromKey) b.path = to;
	}

	/** Forget a doc entirely (retargeted / engine restart). */
	drop(docId: DocId): void {
		this.byId.delete(docId);
		this.queues.delete(docId);
	}

	clear(): void {
		this.byId.clear();
		this.queues.clear();
		this.creditUsed = 0;
	}

	push(docId: DocId, update: Uint8Array, origin: DocUpdateOrigin): void {
		if (!this.byId.has(docId)) return;
		let q = this.queues.get(docId);
		if (!q) {
			q = { parts: [], bytes: 0, resync: false };
			this.queues.set(docId, q);
		}
		if (!q.resync) {
			q.parts.push({ update: update.slice(), origin });
			q.bytes += update.byteLength;
			if (q.bytes > 4 * this.deps.window()) {
				q.resync = true;
				q.parts = [];
				q.bytes = 0;
			}
		}
		this.pump();
	}

	credit(bytes: number): void {
		this.creditUsed = Math.max(0, this.creditUsed - bytes);
		this.pump();
	}

	/** Bytes posted and not yet credited back (tests). */
	get inFlightBytes(): number {
		return this.creditUsed;
	}

	private pump(): void {
		const window = this.deps.window();
		for (const [docId, q] of [...this.queues]) {
			if (!this.byId.has(docId)) {
				this.queues.delete(docId);
				continue;
			}
			if (q.resync) {
				const state = this.deps.fullState(docId);
				if (!state) {
					this.queues.delete(docId);
					continue;
				}
				// A resync is sent even past the window when nothing is in flight (it cannot be split).
				if (this.creditUsed > 0 && this.creditUsed + state.byteLength > window) return;
				this.queues.delete(docId);
				this.send(docId, state, "resync");
				this.stats.resyncs++;
				continue;
			}
			while (q.parts.length > 0) {
				const p = q.parts[0]!;
				if (this.creditUsed > 0 && this.creditUsed + p.update.byteLength > window) return;
				q.parts.shift();
				q.bytes -= p.update.byteLength;
				this.send(docId, p.update, p.origin);
			}
			this.queues.delete(docId);
		}
	}

	private send(docId: DocId, update: Uint8Array, origin: DocUpdateOrigin): void {
		this.creditUsed += update.byteLength;
		this.stats.docUpdatesSent++;
		this.stats.bytesSent += update.byteLength;
		this.deps.post({ t: "docUpdate", docId, update: owned(update), origin });
	}
}
