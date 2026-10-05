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
 */

import * as Y from "yjs";
import type { DocId, VaultPath } from "../core/types";
import { kindOfPath } from "../core/types";
import { FORBIDDEN_PATH_CHARS, MAIN_UPDATE_COALESCE_MS } from "../core/limits";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { Unsubscribe } from "../ports/common";
import type { VaultEvent, VaultPort } from "../ports/vault";
import type { EditorViewRef, ViewEvent, WorkspacePort } from "../ports/workspace";
import type { BindInfo, EngineResultValue, MainToEngine } from "../protocol/messages";
import type { Hasher } from "./hashing";
import { utf8 } from "./hashing";
import { DEFAULT_MERGE_LIMITS, merge, minimalDiff } from "./__standins__/merge";

export const REMOTE_IN: unique symbol = Symbol("yaos.remote-in");
export const BIND_LOCAL: unique symbol = Symbol("yaos.bind-local");
export const MAIN_MERGE: unique symbol = Symbol("yaos.main-merge");
export const MAIN_EDITOR: unique symbol = Symbol("yaos.main-editor");

const BOUND_SAVED_DEBOUNCE_MS = 50;
/** Backoff for conflict-copy writes that hit an I/O error (the last value repeats). */
export const CONFLICT_COPY_RETRY_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

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

function sanitizeLabel(label: string): string {
	let out = "";
	for (const ch of label) {
		const c = ch.codePointAt(0) ?? 0;
		if (c < 0x20 || c === 0x7f || ch === "/" || FORBIDDEN_PATH_CHARS.includes(ch)) continue;
		out += ch;
	}
	out = out.trim().replace(/\s+/g, " ").replace(/^\.+/, "");
	return (out.length > 32 ? out.slice(0, 32).trim() : out) || "device";
}

function pad(n: number, w = 2): string {
	return String(n).padStart(w, "0");
}

/** "<stem> (conflict <device> <YYYY-MM-DD HHmm>[ n])<ext>" in the same folder. */
export function conflictCopyPath(path: string, deviceLabel: string, nowMs: number, n: number, timeZone: "local" | "utc" = "local"): string {
	const slash = path.lastIndexOf("/");
	const dir = slash < 0 ? "" : path.slice(0, slash + 1);
	const leaf = path.slice(slash + 1);
	const dot = leaf.lastIndexOf(".");
	const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
	const ext = dot > 0 ? leaf.slice(dot) : "";
	const d = new Date(nowMs);
	const utc = timeZone === "utc";
	const ymd = `${utc ? d.getUTCFullYear() : d.getFullYear()}-${pad((utc ? d.getUTCMonth() : d.getMonth()) + 1)}-${pad(utc ? d.getUTCDate() : d.getDate())}`;
	const hm = `${pad(utc ? d.getUTCHours() : d.getHours())}${pad(utc ? d.getUTCMinutes() : d.getMinutes())}`;
	const suffix = n > 1 ? ` ${n}` : "";
	return `${dir}${stem} (conflict ${sanitizeLabel(deviceLabel)} ${ymd} ${hm}${suffix})${ext}`;
}

function applyTextDiff(ytext: Y.Text, from: string, to: string, origin: unknown): void {
	if (from === to) return;
	const edits = minimalDiff(from, to);
	const doc = ytext.doc;
	if (!doc) throw new Error("Y.Text without doc");
	doc.transact(() => {
		for (let i = edits.length - 1; i >= 0; i--) {
			const e = edits[i];
			if (!e) continue;
			if (e.end > e.start) ytext.delete(e.start, e.end - e.start);
			if (e.text.length > 0) ytext.insert(e.start, e.text);
		}
	}, origin);
}

export class BindingManager {
	private readonly slots = new Map<number, ViewSlot>();
	private readonly replicas = new Map<string, Replica>();
	private running = false;
	private offWorkspace: Unsubscribe | null = null;
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
		if (!this.running) return;
		for (const slot of this.slots.values()) {
			if ((slot.state === "waiting" || slot.state === "idle") && slot.view.path !== null && this.samePath(slot.view.path, path)) void this.open(slot);
		}
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
		for (const rep of this.replicas.values()) {
			const first = [...rep.slots][0];
			if (!first || first.view.path === null || !this.samePath(first.view.path, path)) continue;
			if (rep.savedTimer !== null) this.deps.clock.clearTimer(rep.savedTimer);
			rep.savedTimer = this.deps.clock.setTimer(BOUND_SAVED_DEBOUNCE_MS, () => {
				rep.savedTimer = null;
				void this.checkSaved(rep);
			});
		}
	}

	// --- internals: views -----------------------------------------------------

	private newSlot(view: EditorViewRef): ViewSlot {
		return { viewId: view.viewId, view, seq: 0, state: "idle", rep: null, detach: null, unintercept: null };
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
				if (copyText !== null) await this.writeConflictCopy(path, copyText);
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

	private onExternalReload(slot: ViewSlot, incoming: string): "handled" | "default" {
		const rep = slot.rep;
		if (!rep || slot.state !== "bound") return "default";
		const base = slot.view.getLastSavedText();
		const crdt = rep.ytext.toString();
		if (incoming === base && incoming !== crdt) return "handled"; // nothing external; editor keeps its unsaved edits
		const r = merge({ base, disk: incoming, crdt, limits: DEFAULT_MERGE_LIMITS });
		if (r.kind === "disk-only" || r.kind === "clean" || r.kind === "conflict") applyTextDiff(rep.ytext, crdt, r.text, MAIN_MERGE);
		const copy = r.kind === "conflict" ? r.conflictCopy : null;
		const path = slot.view.path ?? "";
		void (async () => {
			if (copy !== null) await this.writeConflictCopy(path, copy);
			if (r.kind !== "crdt-only" && !(r.kind === "identical" && incoming === base)) {
				this.stats.externalMerges++;
				this.deps.link.post({ t: "boundExternalMerged", docId: rep.docId, result: r.kind, conflictReason: r.kind === "conflict" ? r.reason : null });
			}
			// Make disk and view.data match the merged buffer (next merge uses it as base).
			for (const s of [...rep.slots]) await s.view.save();
			await this.checkSaved(rep);
		})();
		return "handled";
	}

	/**
	 * The copy text exists only in memory once the merge has replaced it in the editor/CRDT, so an I/O
	 * failure is retried (backoff, capped) for as long as the binding runs; callers that save over the
	 * disk side await this first. Gives up on unload, a non-transient refusal, or when every candidate name is taken.
	 */
	private async writeConflictCopy(path: string, text: string): Promise<boolean> {
		let attempt = 0;
		for (;;) {
			const r = await this.tryConflictCopy(path, text);
			if (r === "ok") return true;
			if (r === "give-up") break;
			if (attempt === 0) this.deps.notice("warn", "conflict-copy-retrying", `Could not write a conflict copy for ${path} (disk error); retrying.`);
			const delay = CONFLICT_COPY_RETRY_MS[Math.min(attempt, CONFLICT_COPY_RETRY_MS.length - 1)] ?? 30_000;
			attempt++;
			await new Promise<void>((resolve) => this.deps.clock.setTimer(delay, resolve));
			if (!this.running) break;
		}
		this.deps.notice("error", "conflict-copy-failed", `Could not write a conflict copy for ${path}; the other version is kept in the editor history only.`);
		return false;
	}

	private async tryConflictCopy(path: string, text: string): Promise<"ok" | "io" | "give-up"> {
		const now = this.deps.clock.now();
		const tz = this.deps.timeZone ?? "local";
		for (let n = 1; n <= 12; n++) {
			const target = n <= 10 ? conflictCopyPath(path, this.deps.deviceLabel(), now, n, tz) : conflictCopyPath(path, `${this.deps.deviceLabel()} ${now}`, now, n - 10, tz);
			try {
				const out = await this.deps.vault.write(target, text, { t: "absent" });
				if (out.ok) {
					this.stats.conflictCopies++;
					return "ok";
				}
				if (out.reason === "io") return "io";
				if (out.reason !== "precondition") return "give-up"; // invalid path / parent is a file: not transient
			} catch {
				return "io";
			}
		}
		return "give-up"; // every candidate name is taken
	}

	private async checkSaved(rep: Replica): Promise<void> {
		const slot = [...rep.slots][0];
		if (!slot || slot.view.path === null) return;
		const text = slot.view.getLastSavedText();
		if (text === rep.lastReported) return;
		rep.lastReported = text;
		const path = slot.view.path;
		const stat = await this.deps.vault.stat(path);
		if (!stat) return;
		const fingerprint = await this.deps.hasher.fingerprint(utf8(text));
		this.stats.boundSavedPosted++;
		this.deps.link.post({ t: "boundSaved", docId: rep.docId, path, text, fingerprint, stat });
	}
}
