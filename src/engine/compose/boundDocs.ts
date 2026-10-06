/**
 * Bound docs: versions, the per-doc body event queue and its credit window (DESIGN §d.3, §g.3, §g.4).
 *
 * A bound doc's only replica is the worker's; each view on main is a client of it (CodeMirror ChangeSets,
 * the @codemirror/collab model). Every change of the replica while bound bumps the doc's version and becomes
 * one `entry` event (onBoundText), FIFO per doc together with the `bound` / `reject` / `durable` / `reloaded`
 * events, sent within the docCredit window (main returns each event's weight once applied). A doc whose
 * queue grows past 4x the window drops it and gets docRetarget{resync}: its views re-bind.
 *
 * Paths whose openDoc answered `untracked` are remembered; when they become tracked (a create was planned or
 * folded) the host gets `bindable`.
 */

import type { DocId, PathKey, VaultPath } from "../../core/types";
import type { BodyChanges, BodyEvent, DocUpdateOrigin, EngineToMain } from "../../protocol/messages";
import { changesInsertedLength } from "../body/textChanges";

/** Save candidates kept per doc (texts a save of some view wrote or may still write). */
export const SAVE_CANDIDATES = 4;

export interface BoundDoc {
	readonly docId: DocId;
	/**
	 * Path of the file the views show: set at bind, moved by every vault rename of that file (Obsidian moves
	 * view.file in place, for a user rename and for the projection's vault.rename alike; followRename).
	 */
	path: VaultPath;
	/** Views that opened the doc (binding or bound). */
	readonly views: Set<number>;
	/** Views whose bodyAttach was merged: they get every event. */
	readonly attached: Set<number>;
	version: number;
	/** The bodyPush being applied (tags its entry). */
	author: { readonly viewId: number; readonly seq: number } | null;
	/** Author of the newest entry (null = not a push). */
	lastAuthor: { readonly viewId: number; readonly seq: number } | null;
	/** Every change up to this version is committed (null = none known since bind). */
	durable: number | null;
	/** A frame of this doc failed: durability is not claimed again while bound. */
	frameFailed: boolean;
	/** Reload merge base: the last disk text the replica absorbed (null before the first attach). */
	diskText: string | null;
	/** Last disk text reported as boundSaved. */
	lastReported: string | null;
	/** Texts a save read from a view while it equalled the replica (newest last). */
	readonly candidates: string[];
	/** checkSaved state (boundBody.ts). */
	check: { timer: number | null; queued: boolean; chain: Promise<void> };
}

interface Queued {
	readonly event: BodyEvent;
	readonly weight: number;
}

interface Queue {
	events: Queued[];
	weight: number;
}

export interface BoundDocsDeps {
	post(message: EngineToMain): void;
	/** Body event credit window (BUDGETS[deviceClass].docUpdateWindowBytes). */
	window(): number;
	/** Every change applied to the doc's replica is committed (no open frame, no T_edit pending). */
	durableNow(docId: DocId): boolean;
}

export function eventWeight(e: BodyEvent): number {
	if (e.t === "entry" || e.t === "bound") return 48 + 2 * changesInsertedLength(e.changes);
	return 24;
}

export class BoundDocs {
	readonly byId = new Map<DocId, BoundDoc>();
	/** Paths answered `untracked` by openDoc, keyed by the requested path. */
	readonly waiting = new Set<VaultPath>();
	private creditUsed = 0;
	private readonly queues = new Map<DocId, Queue>();
	/** Version of docs no longer bound: a re-bind continues it (views of other docs never mix versions). */
	private readonly lastVersion = new Map<DocId, number>();
	readonly stats = { eventsSent: 0, entries: 0, rejects: 0, resyncs: 0, weightSent: 0 };

	constructor(private readonly deps: BoundDocsDeps) {}

	get size(): number {
		return this.byId.size;
	}

	isBound(docId: DocId): boolean {
		return this.byId.has(docId);
	}

	get(docId: DocId): BoundDoc | undefined {
		return this.byId.get(docId);
	}

	/** Adds a view; returns true when this is the doc's first view. */
	add(docId: DocId, path: VaultPath, viewId: number): boolean {
		this.waiting.delete(path);
		let b = this.byId.get(docId);
		const first = !b;
		if (!b) {
			b = {
				docId, path, views: new Set(), attached: new Set(), version: this.lastVersion.get(docId) ?? 0,
				author: null, lastAuthor: null, durable: null, frameFailed: false, diskText: null, lastReported: null,
				candidates: [], check: { timer: null, queued: false, chain: Promise.resolve() },
			};
			this.byId.set(docId, b);
		}
		b.path = path;
		b.views.add(viewId);
		b.attached.delete(viewId);
		return first;
	}

	/** Removes a view; returns true when the doc has no views left (caller unbinds the replica). */
	remove(docId: DocId, viewId: number): boolean {
		const b = this.byId.get(docId);
		if (!b) return false;
		b.views.delete(viewId);
		b.attached.delete(viewId);
		if (b.views.size > 0) return false;
		this.drop(docId);
		return true;
	}

	/** A vault rename `from` -> `to`: views on the file follow it (see BoundDoc.path). */
	followRename(fromKey: PathKey, to: VaultPath, key: (p: VaultPath) => PathKey): void {
		for (const b of this.byId.values()) if (key(b.path) === fromKey) b.path = to;
	}

	/** Forget a doc entirely (last view closed, retargeted). */
	drop(docId: DocId): void {
		const b = this.byId.get(docId);
		if (b) this.lastVersion.set(docId, b.version);
		this.byId.delete(docId);
		this.queues.delete(docId);
	}

	/** Engine runtime switch: the host re-opens every view. */
	clear(): void {
		for (const docId of [...this.byId.keys()]) this.drop(docId);
		this.queues.clear();
		this.creditUsed = 0;
	}

	/** onBoundText: the replica of a bound doc changed. Runs inside the Yjs transaction (observer phase). */
	onText(docId: DocId, changes: BodyChanges, length: number, origin: DocUpdateOrigin): void {
		const b = this.byId.get(docId);
		if (!b) return;
		const from = b.version++;
		const author = origin === "editor" ? b.author : null;
		b.lastAuthor = author;
		this.stats.entries++;
		this.queue(b, { t: "entry", from, to: b.version, changes, length, origin, author });
		// Remote rows are stored before they are applied: with no own change pending, this version is committed.
		if ((origin === "remote" || origin === "provisional") && this.deps.durableNow(docId)) this.markDurable(b, b.version);
	}

	/** A frame of the doc was taken for T_edit: the returned callback marks the version durable on commit. */
	frameTaken(docId: DocId): ((ok: boolean) => void) | undefined {
		const b = this.byId.get(docId);
		if (!b) return undefined;
		const v = b.version;
		return (ok) => {
			if (this.byId.get(docId) !== b) return;
			if (!ok) b.frameFailed = true;
			else this.markDurable(b, v);
		};
	}

	markDurable(b: BoundDoc, version: number): void {
		if (b.frameFailed || (b.durable !== null && version <= b.durable)) return;
		b.durable = version;
		this.queue(b, { t: "durable", version });
	}

	/** Queue an event for the doc's attached views (entries and durable marks only once a view is attached). */
	queue(b: BoundDoc, event: BodyEvent): void {
		if (b.attached.size === 0 && (event.t === "entry" || event.t === "durable")) return;
		let q = this.queues.get(b.docId);
		if (!q) this.queues.set(b.docId, (q = { events: [], weight: 0 }));
		const last = q.events[q.events.length - 1];
		if (event.t === "durable" && last?.event.t === "durable") {
			q.events[q.events.length - 1] = { event, weight: last.weight };
		} else {
			const weight = eventWeight(event);
			q.events.push({ event, weight });
			q.weight += weight;
		}
		if (event.t === "reject") this.stats.rejects++;
		if (q.weight > 4 * this.deps.window()) {
			this.resync(b);
			return;
		}
		this.pump();
	}

	/** Drop the doc's queue: its views re-bind (protocol docRetarget{resync}). */
	resync(b: BoundDoc): void {
		this.queues.delete(b.docId);
		b.attached.clear();
		this.stats.resyncs++;
		this.deps.post({ t: "docRetarget", docId: b.docId, change: { t: "resync" } });
	}

	credit(weight: number): void {
		this.creditUsed = Math.max(0, this.creditUsed - weight);
		this.pump();
	}

	/** Weight posted and not yet credited back (tests). */
	get inFlightWeight(): number {
		return this.creditUsed;
	}

	private pump(): void {
		const window = this.deps.window();
		for (const [docId, q] of [...this.queues]) {
			if (!this.byId.has(docId)) {
				this.queues.delete(docId);
				continue;
			}
			while (q.events.length > 0) {
				const p = q.events[0]!;
				// One event is sent even past the window when nothing is in flight (it cannot be split).
				if (this.creditUsed > 0 && this.creditUsed + p.weight > window) return;
				q.events.shift();
				q.weight -= p.weight;
				this.creditUsed += p.weight;
				this.stats.eventsSent++;
				this.stats.weightSent += p.weight;
				this.deps.post({ t: "body", docId, event: p.event, weight: p.weight });
			}
			this.queues.delete(docId);
		}
	}
}
