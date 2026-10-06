/**
 * Main-thread editor binding (DESIGN §d.2, §d.3).
 *
 * One main replica (Y.Doc with one Y.Text "text") per bound doc, shared by
 * every view of that doc (split panes) and ref-counted by view slots.
 *
 * Origins on the main replica:
 *  - REMOTE_IN   docUpdate from the engine and bind/rebind state: never forwarded;
 *  - BIND_LOCAL  bind-time merge edits: carried by bindDelta, never forwarded;
 *  - MAIN_MERGE  external-reload merge edits: forwarded at once as localUpdate "merge";
 *  - anything else (the y-codemirror sync config, its undo manager, the per-view origin):
 *    editor edits, coalesced MAIN_UPDATE_COALESCE_MS and forwarded as "editor".
 * The y-codemirror binding skips transactions tagged with its own origin and
 * annotates remote-applied CM transactions, so nothing is echoed.
 *
 * Engine restart: replicas are suspended (edits keep landing in the replica
 * but are not posted) and every view re-opens its doc; for the same docId the
 * new state is applied in place and bindDelta = encodeStateAsUpdate(replica,
 * new stateVector) carries every edit the new engine lacks, so a worker
 * killed mid-typing loses nothing and the editor is never detached.
 *
 * External reloads (OR-2): Obsidian's setData assigns view.data = incoming
 * BEFORE it calls setViewData, and save() writes the editor whatever
 * view.data holds (Android spike A/C). So inside the interceptor view.data is
 * not a merge base, and "handled" must always leave the merge in the editor.
 * The base is tracked per replica instead (Replica.diskText: the last disk
 * text the replica has absorbed), updated only from disk-verified reads and
 * from reloads it merged; see reloadBase() and checkSaved().
 */

import * as Y from "yjs";
import type { DocId, PathKey, VaultPath } from "../core/types";
import { kindOfPath } from "../core/types";
import { MAIN_UPDATE_COALESCE_MS } from "../core/limits";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { Unsubscribe } from "../ports/common";
import type { VaultEvent, VaultPort, VaultStat } from "../ports/vault";
import type { EditorViewRef, ViewEvent, WorkspacePort } from "../ports/workspace";
import type { BindInfo, EngineResultValue, MainToEngine } from "../protocol/messages";
import type { Hasher } from "./hashing";
import { utf8 } from "./hashing";
import { DEFAULT_MERGE_LIMITS, merge } from "../core/merge/merge";
import { applyEditsTo, minimalDiff } from "../core/merge/minimalDiff";
import { conflictCopyNotice, conflictName } from "../core/plan/conflictName";
import { pathKey } from "../core/paths/pathKey";

export const REMOTE_IN: unique symbol = Symbol("yaos.remote-in");
export const BIND_LOCAL: unique symbol = Symbol("yaos.bind-local");
export const MAIN_MERGE: unique symbol = Symbol("yaos.main-merge");
export const MAIN_EDITOR: unique symbol = Symbol("yaos.main-editor");

const BOUND_SAVED_DEBOUNCE_MS = 50;
/** checkSaved retry after a disk read error. */
const CHECK_SAVED_RETRY_MS = 1_000;
/** Backoff for conflict-copy writes that hit an I/O error (the last value repeats). */
export const CONFLICT_COPY_RETRY_MS: readonly number[] = [250, 1_000, 2_000, 5_000, 10_000, 30_000];
/** Conflict-copy names tried per attempt while each one turns out taken on disk. */
const CONFLICT_COPY_NAME_TRIES = 12;

export interface BindingLink {
	/** Post to the engine (the host handles [T] ownership). */
	post(message: MainToEngine): void;
	/** openDoc request; rejects when the engine errors or restarts. */
	openDoc(path: VaultPath, viewId: number): Promise<EngineResultValue>;
}

export interface BindingDeps {
	readonly workspace: WorkspacePort;
	readonly vault: VaultPort;
	readonly clock: ClockPort;
	readonly hasher: Hasher;
	readonly link: BindingLink;
	readonly deviceLabel: () => string;
	readonly notice: (level: "info" | "warn" | "error", code: string, message: string) => void;
	/** Conflict-copy timestamps: local time in production, UTC in the simulation (reproducible). */
	readonly timeZone?: "local" | "utc";
}

class Replica {
	readonly doc = new Y.Doc();
	readonly ytext: Y.Text = this.doc.getText("text");
	readonly slots = new Set<ViewSlot>();
	pending: Uint8Array[] = [];
	timer: TimerHandle | null = null;
	savedTimer: TimerHandle | null = null;
	suspended = false;
	/** Last text reported through boundSaved (starts at the engine's synced base). */
	lastReported: string | null = null;
	/**
	 * Merge base for external reloads: the last disk text this replica has absorbed (its content is
	 * in the replica, or was preserved in a conflict copy). Set at replica creation from view.data
	 * (outside setViewData, where it is what Obsidian loaded/saved), by every reload merged, and by
	 * checkSaved from a disk read that matches something the replica already holds.
	 */
	diskText = "";
	/** checkSaved runs serialized per replica (posts never reorder); at most one queued. */
	checkChain: Promise<void> = Promise.resolve();
	checkQueued = false;
	constructor(readonly docId: DocId) {}
}

type SlotState = "idle" | "opening" | "bound" | "waiting";

interface ViewSlot {
	readonly viewId: number;
	readonly view: EditorViewRef;
	seq: number;
	state: SlotState;
	rep: Replica | null;
	detach: Unsubscribe | null;
	unintercept: Unsubscribe | null;
}

export interface BindingStats {
	localUpdatesPosted: number;
	mergeUpdatesPosted: number;
	bindDeltasPosted: number;
	docUpdatesApplied: number;
	creditsSent: number;
	boundSavedPosted: number;
	externalMerges: number;
	conflictCopies: number;
}

function applyTextDiff(ytext: Y.Text, from: string, to: string, origin: unknown): void {
	if (from === to) return;
	const edits = minimalDiff(from, to);
	const doc = ytext.doc;
	if (!doc) throw new Error("Y.Text without doc");
	doc.transact(() => applyEditsTo(ytext, from, edits), origin);
}

export class BindingManager {
	private readonly slots = new Map<number, ViewSlot>();
	private readonly replicas = new Map<string, Replica>();
	private running = false;
	private offWorkspace: Unsubscribe | null = null;
	private readonly pendingCopies = new Set<{ readonly path: string; readonly text: string }>();
	readonly stats: BindingStats = { localUpdatesPosted: 0, mergeUpdatesPosted: 0, bindDeltasPosted: 0, docUpdatesApplied: 0, creditsSent: 0, boundSavedPosted: 0, externalMerges: 0, conflictCopies: 0 };

	constructor(private readonly deps: BindingDeps) {}

	// --- lifecycle ------------------------------------------------------------

	/** Engine ready: bind every open markdown view. */
	start(): void {
		if (this.running) return;
		this.running = true;
		if (!this.offWorkspace) this.offWorkspace = this.deps.workspace.onViewEvent((e) => this.onViewEvent(e));
		for (const view of this.deps.workspace.listMarkdownViews()) {
			if (!this.slots.has(view.viewId)) this.slots.set(view.viewId, this.newSlot(view));
		}
		for (const slot of this.slots.values()) {
			if (slot.state === "bound" && slot.rep) void this.rebind(slot);
			else void this.open(slot);
		}
	}

	/** Engine is gone (restart): keep editors bound, stop posting until rebind. */
	suspend(): void {
		this.running = false;
		for (const rep of this.replicas.values()) {
			rep.suspended = true;
			if (rep.timer !== null) this.deps.clock.clearTimer(rep.timer);
			rep.timer = null;
			rep.pending = [];
		}
		for (const slot of this.slots.values()) {
			slot.seq++;
			if (slot.state === "opening") slot.state = "idle";
		}
	}

	/** Plugin unload: flush and unbind everything. */
	stop(): void {
		this.flushAll();
		for (const slot of [...this.slots.values()]) this.unbindSlot(slot, true);
		this.slots.clear();
		this.offWorkspace?.();
		this.offWorkspace = null;
		this.running = false;
	}

	/** Synchronous flush of every coalesce buffer (hidden/pagehide/freeze, unload). */
	flushAll(): void {
		for (const rep of this.replicas.values()) this.flush(rep);
	}

	// --- queries --------------------------------------------------------------

	isBoundPath(path: string): boolean {
		for (const slot of this.slots.values()) {
			if ((slot.state === "bound" || slot.state === "opening") && slot.view.path !== null && this.samePath(slot.view.path, path)) return true;
		}
		return false;
	}

	/**
	 * Post the coalesce buffer of every replica bound at `path` now. True when edits were posted:
	 * the engine had not seen them, so a delete planned without them must be replanned (§c.7).
	 */
	flushPath(path: string): boolean {
		let posted = false;
		for (const slot of this.slots.values()) {
			const rep = slot.rep;
			if (!rep || slot.view.path === null || !this.samePath(slot.view.path, path)) continue;
			if (rep.pending.length > 0 && !rep.suspended) posted = true;
			this.flush(rep);
		}
		return posted;
	}

	boundDocs(): DocId[] {
		return [...this.replicas.keys()] as DocId[];
	}

	replicaText(docId: DocId): string | null {
		return this.replicas.get(docId)?.ytext.toString() ?? null;
	}

	slotState(viewId: number): SlotState | null {
		return this.slots.get(viewId)?.state ?? null;
	}

	docOfView(viewId: number): DocId | null {
		return this.slots.get(viewId)?.rep?.docId ?? null;
	}

	// --- engine -> main -------------------------------------------------------

	onDocUpdate(docId: DocId, update: Uint8Array): void {
		const bytes = update.byteLength;
		const rep = this.replicas.get(docId);
		if (rep) {
			Y.applyUpdate(rep.doc, update, REMOTE_IN);
			this.stats.docUpdatesApplied++;
		}
		this.stats.creditsSent++;
		this.deps.link.post({ t: "docCredit", bytes });
	}

	onDocRetarget(docId: DocId, change: { readonly t: "renamed"; readonly path: VaultPath } | { readonly t: "merged"; readonly into: DocId } | { readonly t: "deleted" } | { readonly t: "frozen"; readonly reason: string }): void {
		const rep = this.replicas.get(docId);
		if (!rep) return;
		for (const slot of [...rep.slots]) {
			this.unbindSlot(slot, true);
			if (change.t === "deleted") slot.state = "waiting";
			else void this.open(slot);
		}
	}

	onBindable(path: VaultPath): void {
		this.retryUnbound(path);
	}

	async saveViews(docIds: readonly DocId[]): Promise<DocId[]> {
		const saved: DocId[] = [];
		for (const docId of docIds) {
			const rep = this.replicas.get(docId);
			if (!rep) continue;
			for (const slot of [...rep.slots]) await slot.view.save();
			saved.push(docId);
			await this.checkSaved(rep);
		}
		return saved;
	}

	/** Raw vault events (the host forwards every event here before batching). */
	onVaultEvent(event: VaultEvent): void {
		if (event.t !== "modify" && event.t !== "create" && event.t !== "rename") return;
		const path = event.t === "rename" ? event.to : event.path;
		// A rename keeps the file's views (Obsidian moves view.file in place, no file-changed). A slot
		// waiting on the old path would wait forever: the engine's `bindable` is keyed by the path openDoc
		// asked for, and the new path may have been live all along (the projection applying a remote
		// rename it had already folded). Ask again at the new path.
		if (event.t === "rename") this.retryUnbound(event.to);
		for (const rep of this.replicas.values()) {
			const first = [...rep.slots][0];
			if (!first || first.view.path === null || !this.samePath(first.view.path, path)) continue;
			this.scheduleCheckSaved(rep, BOUND_SAVED_DEBOUNCE_MS);
		}
	}

	// --- internals: views -----------------------------------------------------

	private newSlot(view: EditorViewRef): ViewSlot {
		return { viewId: view.viewId, view, seq: 0, state: "idle", rep: null, detach: null, unintercept: null };
	}

	/** Re-open every unbound (waiting/idle) slot whose view is at `path`. */
	private retryUnbound(path: string): void {
		if (!this.running) return;
		for (const slot of this.slots.values()) {
			if ((slot.state === "waiting" || slot.state === "idle") && slot.view.path !== null && this.samePath(slot.view.path, path)) void this.open(slot);
		}
	}

	private samePath(a: string, b: string): boolean {
		if (a === b) return true;
		if (!this.deps.vault.caseInsensitive) return a.normalize("NFC") === b.normalize("NFC");
		return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
	}

	private onViewEvent(e: ViewEvent): void {
		switch (e.t) {
			case "opened": {
				const existing = this.slots.get(e.view.viewId);
				if (existing) this.unbindSlot(existing, true);
				const slot = this.newSlot(e.view);
				this.slots.set(slot.viewId, slot);
				void this.open(slot);
				return;
			}
			case "file-changed": {
				let slot = this.slots.get(e.view.viewId);
				if (!slot) {
					slot = this.newSlot(e.view);
					this.slots.set(slot.viewId, slot);
				} else this.unbindSlot(slot, true);
				void this.open(slot);
				return;
			}
			case "closed": {
				const slot = this.slots.get(e.viewId);
				if (!slot) return;
				this.unbindSlot(slot, true);
				slot.seq++;
				this.slots.delete(e.viewId);
				return;
			}
		}
	}

	private async open(slot: ViewSlot): Promise<void> {
		const view = slot.view;
		const path = view.path;
		const seq = ++slot.seq;
		if (!this.running || path === null || kindOfPath(path) !== "markdown" || !view.hasEditor()) {
			slot.state = "idle";
			return;
		}
		slot.state = "opening";
		let res: EngineResultValue;
		try {
			res = await this.deps.link.openDoc(path, slot.viewId);
		} catch {
			if (seq === slot.seq) slot.state = "idle";
			return;
		}
		const stale = seq !== slot.seq || this.slots.get(slot.viewId) !== slot || view.path === null || !this.samePath(view.path, path);
		if (stale) {
			if (res.t === "bind") this.deps.link.post({ t: "closeDoc", docId: res.bind.docId, viewId: slot.viewId });
			if (seq === slot.seq && this.slots.get(slot.viewId) === slot) void this.open(slot);
			return;
		}
		if (res.t !== "bind") {
			slot.state = "waiting";
			return;
		}
		const info = res.bind;
		if (info.frozen) {
			// Deviation: WorkspacePort has no read-only bind; a frozen doc stays unbound with a notice.
			this.deps.link.post({ t: "closeDoc", docId: info.docId, viewId: slot.viewId });
			slot.state = "waiting";
			this.deps.notice("warn", "doc-frozen", "This note is frozen by sync; edits are kept locally until it is released.");
			return;
		}
		this.attach(slot, info);
	}

	/** Bind-time merge + bind. Synchronous so no editor edit can slip in between. */
	private attach(slot: ViewSlot, info: BindInfo): void {
		const view = slot.view;
		let rep = this.replicas.get(info.docId);
		if (!rep) {
			rep = this.createReplica(info.docId);
			rep.lastReported = info.baseText;
			rep.diskText = view.getLastSavedText();
		}
		Y.applyUpdate(rep.doc, info.state, REMOTE_IN);
		const editorText = view.getText();
		const crdtText = rep.ytext.toString();
		let report: { result: "identical" | "disk-only" | "clean" | "conflict"; reason: ReturnType<typeof merge> } | null = null;
		let copyText: string | null = null;
		if (editorText !== crdtText) {
			const r = merge({ base: info.baseText, disk: editorText, crdt: crdtText, limits: DEFAULT_MERGE_LIMITS });
			const target = r.kind === "identical" ? crdtText : r.text;
			applyTextDiff(rep.ytext, crdtText, target, BIND_LOCAL);
			view.applyMinimalReplace(target);
			if (r.kind === "conflict") copyText = r.conflictCopy;
			if (r.kind !== "crdt-only") report = { result: r.kind, reason: r };
		}
		// Distinct origin per view (y-codemirror uses its own config object per editor), so split views see each other.
		slot.detach = view.bind({ ytext: rep.ytext, localOrigin: { editor: MAIN_EDITOR, viewId: slot.viewId }, awareness: null });
		slot.unintercept = view.interceptExternalReload((incoming) => this.onExternalReload(slot, incoming));
		slot.rep = rep;
		slot.state = "bound";
		rep.slots.add(slot);
		this.postBindDelta(rep, info.stateVector);
		if (report) {
			const result = report.result;
			const reason = report.reason.kind === "conflict" ? report.reason.reason : null;
			const path = view.path ?? "";
			void (async () => {
				if (copyText !== null) await this.writeConflictCopy(path, info.docId, copyText);
				this.stats.externalMerges++;
				this.deps.link.post({ t: "boundExternalMerged", docId: info.docId, result, conflictReason: reason });
			})();
		}
	}

	/** Restart path: same doc -> apply state in place and send bindDelta; otherwise a fresh bind. */
	private async rebind(slot: ViewSlot): Promise<void> {
		const view = slot.view;
		const path = view.path;
		const rep = slot.rep;
		const seq = ++slot.seq;
		if (!rep || path === null) return this.open(slot);
		let res: EngineResultValue;
		try {
			res = await this.deps.link.openDoc(path, slot.viewId);
		} catch {
			return;
		}
		if (seq !== slot.seq || this.slots.get(slot.viewId) !== slot) {
			if (res.t === "bind") this.deps.link.post({ t: "closeDoc", docId: res.bind.docId, viewId: slot.viewId });
			return;
		}
		if (res.t === "bind" && res.bind.docId === rep.docId && !res.bind.frozen && slot.rep === rep) {
			Y.applyUpdate(rep.doc, res.bind.state, REMOTE_IN);
			rep.suspended = false;
			this.postBindDelta(rep, res.bind.stateVector);
			return;
		}
		if (res.t === "bind") this.deps.link.post({ t: "closeDoc", docId: res.bind.docId, viewId: slot.viewId });
		this.unbindSlot(slot, false);
		void this.open(slot);
	}

	private unbindSlot(slot: ViewSlot, sendClose: boolean): void {
		const rep = slot.rep;
		slot.detach?.();
		slot.unintercept?.();
		slot.detach = null;
		slot.unintercept = null;
		slot.rep = null;
		slot.state = "idle";
		if (!rep) return;
		this.flush(rep);
		rep.slots.delete(slot);
		if (sendClose && !rep.suspended) this.deps.link.post({ t: "closeDoc", docId: rep.docId, viewId: slot.viewId });
		if (rep.slots.size === 0) {
			if (rep.timer !== null) this.deps.clock.clearTimer(rep.timer);
			if (rep.savedTimer !== null) this.deps.clock.clearTimer(rep.savedTimer);
			this.replicas.delete(rep.docId);
			rep.doc.destroy();
		}
	}

	// --- internals: replica updates -------------------------------------------

	private createReplica(docId: DocId): Replica {
		const rep = new Replica(docId);
		rep.doc.on("update", (update: Uint8Array, origin: unknown) => this.onReplicaUpdate(rep, update, origin));
		this.replicas.set(docId, rep);
		return rep;
	}

	private onReplicaUpdate(rep: Replica, update: Uint8Array, origin: unknown): void {
		if (origin === REMOTE_IN || origin === BIND_LOCAL) return;
		if (rep.suspended) return; // bindDelta after rebind carries it
		if (origin === MAIN_MERGE) {
			this.flush(rep);
			this.stats.mergeUpdatesPosted++;
			this.deps.link.post({ t: "localUpdate", docId: rep.docId, update: update.slice(), origin: "merge" });
			return;
		}
		rep.pending.push(update.slice());
		if (rep.timer === null) {
			rep.timer = this.deps.clock.setTimer(MAIN_UPDATE_COALESCE_MS, () => {
				rep.timer = null;
				this.flush(rep);
			});
		}
	}

	private flush(rep: Replica): void {
		if (rep.timer !== null) {
			this.deps.clock.clearTimer(rep.timer);
			rep.timer = null;
		}
		if (rep.pending.length === 0) return;
		const parts = rep.pending;
		rep.pending = [];
		if (rep.suspended) return;
		const update = parts.length === 1 ? (parts[0] as Uint8Array) : Y.mergeUpdates(parts);
		this.stats.localUpdatesPosted++;
		this.deps.link.post({ t: "localUpdate", docId: rep.docId, update, origin: "editor" });
	}

	private postBindDelta(rep: Replica, stateVector: Uint8Array): void {
		// Pending editor updates are inside the delta; drop them so they are not sent twice.
		if (rep.timer !== null) this.deps.clock.clearTimer(rep.timer);
		rep.timer = null;
		rep.pending = [];
		this.stats.bindDeltasPosted++;
		this.deps.link.post({ t: "bindDelta", docId: rep.docId, update: Y.encodeStateAsUpdate(rep.doc, stateVector) });
	}

	// --- internals: external reload + saves -----------------------------------

	/**
	 * Obsidian is reloading a bound view with `incoming` (the file's current text). view.data of THIS
	 * view already equals `incoming` here, so the base comes from reloadBase(). The merge goes into the
	 * replica (MAIN_MERGE), and so into every bound editor, synchronously: returning "handled" with the
	 * editor unchanged would let the next save write the old editor text over the external edit.
	 * Saves run after setData has returned, so view.data, the editor and the disk end equal.
	 */
	private onExternalReload(slot: ViewSlot, incoming: string): "handled" | "default" {
		const rep = slot.rep;
		if (!rep || slot.state !== "bound") return "default";
		const base = this.reloadBase(rep, slot, incoming);
		const crdt = rep.ytext.toString();
		const r = merge({ base, disk: incoming, crdt, limits: DEFAULT_MERGE_LIMITS });
		if (r.kind === "disk-only" || r.kind === "clean" || r.kind === "conflict") applyTextDiff(rep.ytext, crdt, r.text, MAIN_MERGE);
		rep.diskText = incoming; // absorbed: merged into the replica, or kept by the conflict copy below
		const copy = r.kind === "conflict" ? r.conflictCopy : null;
		const report = r.kind === "disk-only" || r.kind === "clean" || r.kind === "conflict" || (r.kind === "identical" && incoming !== base);
		const path = slot.view.path ?? "";
		void (async () => {
			await Promise.resolve(); // never call save() from inside Obsidian's setData
			if (copy !== null) await this.writeConflictCopy(path, rep.docId, copy);
			if (report) {
				this.stats.externalMerges++;
				this.deps.link.post({ t: "boundExternalMerged", docId: rep.docId, result: r.kind as "identical" | "disk-only" | "clean" | "conflict", conflictReason: r.kind === "conflict" ? r.reason : null });
			}
			if (this.replicas.get(rep.docId) !== rep) return;
			for (const s of [...rep.slots]) {
				if (s.view.getText() !== s.view.getLastSavedText()) await s.view.save();
			}
			await this.checkSaved(rep);
		})();
		return "handled";
	}

	/**
	 * Base for merging a reload of `slot`. If a sibling bound view of the same doc already holds
	 * `incoming` as its view.data, the replica has absorbed it (that sibling saved it from the shared
	 * replica, or already took this same reload), so the reload is not external: base = incoming.
	 * Otherwise the replica's last absorbed disk text. Never this view's own view.data (pre-assigned).
	 * A base that is stale (an ancestor of the true one, e.g. a reload racing checkSaved right after
	 * our own save) can only turn a clean merge into a spurious conflict copy; it never drops text.
	 */
	private reloadBase(rep: Replica, slot: ViewSlot, incoming: string): string {
		for (const s of rep.slots) if (s !== slot && s.view.getLastSavedText() === incoming) return incoming;
		return rep.diskText;
	}

	/**
	 * The copy text exists only in memory once the merge has replaced it in the editor/CRDT, so an I/O
	 * failure is retried (backoff, capped) for as long as the binding runs; callers that save over the
	 * disk side await this first. Gives up on unload, a non-transient refusal, or when every candidate name is taken.
	 */
	private async writeConflictCopy(path: string, docId: DocId, text: string): Promise<boolean> {
		let attempt = 0;
		const pending = { path, text };
		try {
			for (;;) {
				const r = await this.tryConflictCopy(path, docId, text);
				if (r === "ok") return true;
				if (r === "give-up") break;
				if (attempt === 0) {
					this.pendingCopies.add(pending);
					this.deps.notice("warn", "conflict-copy-retrying", `Could not write a conflict copy for ${path} (disk error); retrying.`);
				}
				const delay = CONFLICT_COPY_RETRY_MS[Math.min(attempt, CONFLICT_COPY_RETRY_MS.length - 1)] ?? 30_000;
				attempt++;
				await new Promise<void>((resolve) => this.deps.clock.setTimer(delay, resolve));
				if (!this.running) break;
			}
		} finally {
			this.pendingCopies.delete(pending);
		}
		this.deps.notice("error", "conflict-copy-failed", `Could not write a conflict copy for ${path}; the other version is kept in the editor history only.`);
		return false;
	}

	/**
	 * Conflict copies that hit a disk error and live only in memory until a retry lands. Known gap
	 * (wp-d-notes): if the process dies in that window after Obsidian's own autosave replaced the disk
	 * side, the copy is gone. The sim records these at an app crash (SimDevice.crashLost).
	 */
	pendingConflictCopies(): { readonly path: string; readonly text: string }[] {
		return [...this.pendingCopies];
	}

	/** Names come from core conflictName (DESIGN §f.7); a name another writer took meanwhile is skipped. */
	private async tryConflictCopy(path: string, docId: DocId, text: string): Promise<"ok" | "io" | "give-up"> {
		const nowMs = this.deps.clock.now();
		const tzOffsetMinutes = (this.deps.timeZone ?? "local") === "utc" ? 0 : -new Date(nowMs).getTimezoneOffset();
		const taken = new Set<PathKey>();
		for (let n = 1; n <= CONFLICT_COPY_NAME_TRIES; n++) {
			const target = conflictName({ path, docId, deviceLabel: this.deps.deviceLabel(), nowMs, tzOffsetMinutes, pathKey, isTaken: (k) => taken.has(k) });
			try {
				const out = await this.deps.vault.write(target, text, { t: "absent" });
				if (out.ok) {
					this.stats.conflictCopies++;
					this.deps.notice("warn", "conflict-copy", conflictCopyNotice({ from: path, to: target }, 1));
					return "ok";
				}
				if (out.reason === "io") return "io";
				if (out.reason !== "precondition") return "give-up"; // invalid path / parent is a file: not transient
				taken.add(pathKey(target));
			} catch {
				return "io";
			}
		}
		return "give-up"; // every candidate name is taken
	}

	/** Serialized per replica; a request while one is queued joins it (the queued run reads the disk later). */
	private checkSaved(rep: Replica): Promise<void> {
		if (rep.checkQueued) return rep.checkChain;
		rep.checkQueued = true;
		rep.checkChain = rep.checkChain.then(async () => {
			rep.checkQueued = false;
			await this.checkSavedNow(rep);
		}).catch(() => undefined);
		return rep.checkChain;
	}

	/**
	 * Report a save of a bound file as boundSaved (the engine's new synced base). Disk-verified: stat,
	 * read, stat (unchanged in between), and only a disk text the replica has absorbed (its last disk
	 * text, its current text, or some bound view's view.data, read here outside setViewData) is
	 * reported, with its own stat and fingerprint, and becomes the reload base. Anything else on disk is
	 * an external write whose reload is still pending: the interceptor merges it, and reporting it here
	 * would make unmerged text the engine's base.
	 */
	private async checkSavedNow(rep: Replica): Promise<void> {
		const first = [...rep.slots][0];
		if (!first || first.view.path === null) return;
		const path = first.view.path;
		let text: string;
		let stat: VaultStat | null;
		try {
			const before = await this.deps.vault.stat(path);
			if (!before) return;
			text = await this.deps.vault.readText(path);
			stat = await this.deps.vault.stat(path);
			// Changed while reading: the write's own vault event schedules another check.
			if (!stat || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) return;
		} catch {
			this.scheduleCheckSaved(rep, CHECK_SAVED_RETRY_MS);
			return;
		}
		if (this.replicas.get(rep.docId) !== rep) return;
		const absorbed = text === rep.diskText || text === rep.ytext.toString() || [...rep.slots].some((s) => s.view.getLastSavedText() === text);
		if (!absorbed) return;
		rep.diskText = text;
		if (text === rep.lastReported) return;
		const fingerprint = await this.deps.hasher.fingerprint(utf8(text));
		if (this.replicas.get(rep.docId) !== rep) return;
		rep.lastReported = text;
		this.stats.boundSavedPosted++;
		this.deps.link.post({ t: "boundSaved", docId: rep.docId, path, text, fingerprint, stat });
	}

	private scheduleCheckSaved(rep: Replica, delayMs: number): void {
		if (rep.savedTimer !== null) this.deps.clock.clearTimer(rep.savedTimer);
		rep.savedTimer = this.deps.clock.setTimer(delayMs, () => {
			rep.savedTimer = null;
			if (this.replicas.get(rep.docId) === rep) void this.checkSaved(rep);
		});
	}
}
