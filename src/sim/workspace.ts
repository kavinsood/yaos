/**
 * SimWorkspace: Obsidian markdown views for the simulation (DESIGN §l.1). Models what matters for sync in
 * Obsidian 1.14.4 (app.js, read-only: TextFileView.save / loadFileInternal / setData, MarkdownView
 * onInternalDataChange / saveFrontmatter), and the adapter host/obsidianWorkspace.ts + host/collab.ts:
 *  - the editor document is an immutable CodeMirror Text; every edit is a ChangeSet. A bound editor reports each
 *    local change (onLocal) and takes the replica's changes (applyRemote) outside its undo history, as collab.ts;
 *  - TextFileView fields: `data` (view.data), `lastSavedData`, `dirty`. Any editor change sets dirty and restarts
 *    the 2 s save debounce (requestSave) and, in source mode, the 10 ms onInternalDataChange debounce;
 *  - save(): dirty = false; o = getViewData(); skipped when lastSavedData === o (or null); else
 *    data = lastSavedData = o, then the write (writer "save");
 *  - loadFileInternal (after every modify/create of an open file, SimVault.onReload): n = disk text;
 *    i = lastSavedData; lastSavedData = n; if i: return when i === n; while dirty, return when getViewData() === n
 *    (Obsidian then merges e2(i, editor, n) into n for a dirty editor: not modelled, n goes as is); setData(n, false);
 *  - setData(text, clear): when data !== text or clear: data = text, then setViewData(text, clear);
 *  - setViewData(text, clear): clear (another file in this leaf) unbinds first, as the adapter's instance wrapper
 *    does; otherwise the interceptor (WorkspacePort.interceptExternalReload) sees it first, with `from` = the view
 *    whose quick preview this is. The default replaces the editor with a minimal change, which a bound editor
 *    reports as local (the clobber the interceptor exists to prevent: counters.defaultReloadWhileBound);
 *  - onInternalDataChange: e = editor text; if data !== e: data = e and every other view of the file gets
 *    setData(e, false) (the "quick-preview" workspace event);
 *  - getViewData is the adapter's wrapper: with dirty cleared (a save) it reports onSaveRead and, while saves are
 *    held (holdSaves), answers lastSavedData so the save skips;
 *  - undo(): CodeMirror history: undoes this editor's own changes, mapped over the remote ones;
 *  - rename of an open file updates view.path; delete closes its views.
 * The O(N) string work here (toString, minimal replace) is Obsidian's own or the sim's, never the binding's.
 */

import { ChangeSet, Text } from "@codemirror/state";
import type { Unsubscribe } from "../ports/common";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { EditorBinding, EditorBindingSpec, EditorViewRef, ExternalReloadHandler, ViewEvent, WorkspacePort } from "../ports/workspace";
import type { VaultEvent } from "../ports/vault";
import type { SimVault } from "./vault";

export const OBSIDIAN_SAVE_DEBOUNCE_MS = 2_000;
/** MarkdownEditView.requestOnInternalDataChange debounce (Obsidian 1.14.4). */
export const OBSIDIAN_INTERNAL_CHANGE_MS = 10;
const UNDO_DEPTH = 200;

/** The sim keeps every character (\r included) as Obsidian's buffer would hold it: lines split on \n only. */
export function simText(s: string): Text {
	return Text.of(s.split("\n"));
}

export interface ViewCounters {
	/** Local editor changes reported to the binding. */
	localTx: number;
	/** Replica changes applied to the editor. */
	remoteApplied: number;
	saves: number;
	setViewDataCalls: number;
	intercepted: number;
	/** setViewData applied by default while bound (the editor-clobber path). */
	defaultReloadWhileBound: number;
	undos: number;
}

interface SimBinding {
	readonly spec: EditorBindingSpec;
	live: boolean;
}

export class SimEditorView implements EditorViewRef {
	path: string | null;
	doc: Text = Text.empty;
	/** view.data */
	data: string | null = null;
	lastSavedData: string | null = null;
	mode: "source" | "reading" = "source";
	closed = false;
	readonly counters: ViewCounters = { localTx: 0, remoteApplied: 0, saves: 0, setViewDataCalls: 0, intercepted: 0, defaultReloadWhileBound: 0, undos: 0 };
	private binding: SimBinding | null = null;
	private interceptor: ExternalReloadHandler | null = null;
	private held = false;
	private skipped = false;
	private dirty = false;
	private saveTimer: TimerHandle | null = null;
	private changeTimer: TimerHandle | null = null;
	/** Inverses of this editor's own changes (newest last), each relative to the document after the ones above it. */
	private undoStack: ChangeSet[] = [];

	constructor(
		readonly viewId: number,
		path: string,
		private readonly ws: SimWorkspace,
	) {
		this.path = path;
	}

	/** The editor text (sim/test convenience: O(N)). */
	get buffer(): string {
		return this.doc.toString();
	}

	getText(): string {
		return this.buffer;
	}

	// --- EditorViewRef --------------------------------------------------------

	hasEditor(): boolean {
		return this.mode === "source" && !this.closed;
	}

	editorDoc(): Text | null {
		return this.closed ? null : this.doc;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	lastSavedText(): string | null {
		return this.lastSavedData;
	}

	bind(spec: EditorBindingSpec): EditorBinding {
		if (this.closed) throw new Error("bind on a closed view");
		this.unbindNow();
		const b: SimBinding = { spec, live: true };
		this.binding = b;
		return {
			doc: () => this.doc,
			applyRemote: (changes) => {
				if (b.live) this.change(changes, "remote");
			},
			detach: () => {
				if (this.binding === b) this.unbindNow();
			},
		};
	}

	interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe {
		this.interceptor = handler;
		return () => {
			if (this.interceptor === handler) this.interceptor = null;
		};
	}

	holdSaves(hold: boolean): boolean {
		const skipped = this.skipped;
		this.held = hold;
		this.skipped = false;
		return !hold && skipped;
	}

	async save(): Promise<void> {
		this.clearTimer("save");
		this.dirty = false;
		if (this.closed || this.path === null) return;
		const o = this.getViewData();
		if (this.lastSavedData === o || this.lastSavedData === null) return;
		this.data = o;
		this.lastSavedData = o;
		this.counters.saves++;
		this.ws.vault.editorSave(this.path, o);
	}

	isBound(): boolean {
		return this.binding !== null;
	}

	// --- user actions ---------------------------------------------------------

	/** User edit in the editor (positions in UTF-16 units of the document). */
	edit(pos: number, deleteCount: number, insert: string): void {
		if (!this.hasEditor()) return;
		const len = this.doc.length;
		const from = Math.max(0, Math.min(pos, len));
		const to = from + Math.max(0, Math.min(deleteCount, len - from));
		if (from === to && insert.length === 0) return;
		this.change(ChangeSet.of({ from, to, insert: simText(insert) }, len), "local");
	}

	/** Mod-z: undo this editor's newest own change (CodeMirror history; remote changes are never undone). */
	undo(): boolean {
		if (!this.hasEditor()) return false;
		const inv = this.undoStack.pop();
		if (!inv) return false;
		this.counters.undos++;
		this.change(inv, "undo");
		return true;
	}

	/** Properties edit (MarkdownView.saveFrontmatter): getViewData, setViewData(t, false), onInternalDataChange, save. */
	saveFrontmatter(mutate: (text: string) => string): Promise<void> {
		const t = mutate(this.getViewData());
		this.setViewData(t, false);
		this.onInternalDataChange();
		return this.save();
	}

	// --- Obsidian internals ---------------------------------------------------

	/** TextFileView.getViewData as the adapter's instance wrapper answers it. */
	getViewData(): string {
		if (!this.dirty) {
			this.binding?.spec.onSaveRead();
			if (this.held && this.lastSavedData !== null) {
				this.skipped = true;
				return this.lastSavedData;
			}
		}
		return this.doc.toString();
	}

	/** TextFileView.setData(data, clear). */
	setData(text: string, clear: boolean): void {
		if (this.data === text && !clear) return;
		this.data = text;
		this.setViewData(text, clear);
	}

	/** TextFileView.loadFileInternal(file, clear=false): Obsidian reloading this view after a modify/create of its file. */
	loadFileInternal(): void {
		if (this.closed || this.path === null) return;
		const n = this.ws.vault.textOf(this.path);
		if (n === null) return;
		const i = this.lastSavedData;
		this.lastSavedData = n;
		if (i) {
			if (i === n) return;
			if (this.dirty && this.getViewData() === n) return;
		}
		this.setData(n, false);
	}

	/** File open / leaf switch: loadFileInternal(file, clear=true). */
	loadFile(text: string): void {
		this.lastSavedData = text;
		this.setData(text, true);
	}

	/** MarkdownView.setViewData(data, clear). */
	setViewData(incoming: string, clear: boolean): void {
		this.counters.setViewDataCalls++;
		if (clear) {
			this.unbindNow();
			this.interceptor = null;
			this.doc = simText(incoming);
			this.undoStack = [];
			this.dirty = false;
			return;
		}
		if (this.interceptor) {
			const p = this.ws.previewFrom;
			if (this.interceptor(incoming, p !== null && p !== this.viewId ? p : null) === "handled") {
				this.counters.intercepted++;
				return;
			}
		}
		if (this.binding) this.counters.defaultReloadWhileBound++;
		const old = this.doc.toString();
		let start = 0;
		while (start < old.length && start < incoming.length && old.charCodeAt(start) === incoming.charCodeAt(start)) start++;
		let eo = old.length;
		let ei = incoming.length;
		while (eo > start && ei > start && old.charCodeAt(eo - 1) === incoming.charCodeAt(ei - 1)) {
			eo--;
			ei--;
		}
		if (eo > start || ei > start) this.change(ChangeSet.of({ from: start, to: eo, insert: simText(incoming.slice(start, ei)) }, old.length), "set");
		this.dirty = false;
	}

	/** MarkdownView.onInternalDataChange: view.data follows the editor; the other views of the file get a quick preview. */
	onInternalDataChange(): void {
		this.clearTimer("change");
		if (this.closed) return;
		const e = this.doc.toString();
		if (this.data === e) return;
		this.data = e;
		const prev = this.ws.previewFrom;
		this.ws.previewFrom = this.viewId;
		try {
			for (const v of this.ws.views_()) if (v !== this && v.path !== null && this.path !== null && this.ws.samePath(v.path, this.path)) v.setData(e, false);
		} finally {
			this.ws.previewFrom = prev;
		}
	}

	/** One editor transaction. local/undo: reported to the binding; remote: mapped into the undo history instead. */
	private change(c: ChangeSet, kind: "local" | "undo" | "remote" | "set"): void {
		const before = this.doc;
		this.doc = c.apply(before);
		if (kind === "remote") {
			this.counters.remoteApplied++;
			let m = c;
			for (let k = this.undoStack.length - 1; k >= 0; k--) {
				const inv = this.undoStack[k] as ChangeSet;
				this.undoStack[k] = inv.map(m);
				m = m.map(inv, true);
			}
		} else {
			// Obsidian's own replace (setViewData, clear=false) is an ordinary transaction: CodeMirror history records
			// it (app.js sets addToHistory=false only in its collab sync), so it is undoable like typing.
			if (kind === "local" || kind === "set") {
				this.undoStack.push(c.invert(before));
				if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
			}
			const b = this.binding;
			if (b?.live) {
				this.counters.localTx++;
				b.spec.onLocal(c);
			}
		}
		if (kind === "set") return;
		this.markDirty();
		if (this.mode === "source") {
			this.clearTimer("change");
			this.changeTimer = this.ws.clock.setTimer(OBSIDIAN_INTERNAL_CHANGE_MS, () => {
				this.changeTimer = null;
				this.onInternalDataChange();
			});
		}
	}

	private markDirty(): void {
		this.dirty = true;
		this.clearTimer("save");
		this.saveTimer = this.ws.clock.setTimer(this.ws.saveDebounceMs, () => {
			this.saveTimer = null;
			void this.save();
		});
	}

	private unbindNow(): void {
		const b = this.binding;
		this.binding = null;
		this.held = false;
		this.skipped = false;
		if (b) b.live = false;
	}

	private clearTimer(which: "save" | "change"): void {
		const t = which === "save" ? this.saveTimer : this.changeTimer;
		if (t !== null) this.ws.clock.clearTimer(t);
		if (which === "save") this.saveTimer = null;
		else this.changeTimer = null;
	}

	/** Close: Obsidian saves a dirty view before closing it. */
	async close(): Promise<void> {
		if (this.dirty) await this.save();
		this.crash();
	}

	/** Device crash: unsaved editor content is lost, no save. */
	crash(): void {
		this.clearTimer("save");
		this.clearTimer("change");
		this.unbindNow();
		this.closed = true;
	}
}

export interface SimWorkspaceOptions {
	readonly clock: ClockPort;
	readonly vault: SimVault;
	readonly saveDebounceMs?: number;
}

export class SimWorkspace implements WorkspacePort {
	readonly clock: ClockPort;
	readonly vault: SimVault;
	readonly saveDebounceMs: number;
	/** The view whose onInternalDataChange is running (its quick preview reaches the others synchronously). */
	previewFrom: number | null = null;
	private readonly views = new Map<number, SimEditorView>();
	private readonly listeners = new Set<(event: ViewEvent) => void>();
	private nextViewId = 1;
	private readonly offVault: Unsubscribe;
	/** Every view ever opened here (closed ones included), for invariant counters. */
	readonly history: SimEditorView[] = [];

	constructor(opts: SimWorkspaceOptions) {
		this.clock = opts.clock;
		this.vault = opts.vault;
		this.saveDebounceMs = opts.saveDebounceMs ?? OBSIDIAN_SAVE_DEBOUNCE_MS;
		const offEvents = this.vault.onEvent((e) => this.onVaultEvent(e));
		const offReload = this.vault.onReload((path) => {
			for (const v of [...this.views.values()]) if (v.path !== null && this.samePath(v.path, path)) v.loadFileInternal();
		});
		this.offVault = () => {
			offEvents();
			offReload();
		};
	}

	listMarkdownViews(): readonly EditorViewRef[] {
		return [...this.views.values()];
	}

	onViewEvent(listener: (event: ViewEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	views_(): SimEditorView[] {
		return [...this.views.values()];
	}

	view(viewId: number): SimEditorView | undefined {
		return this.views.get(viewId);
	}

	/** Open a file in a new leaf. Returns null if the file does not exist. */
	openFile(path: string): SimEditorView | null {
		const text = this.vault.textOf(path);
		if (text === null) return null;
		const v = new SimEditorView(this.nextViewId++, this.displayPath(path), this);
		v.loadFile(text);
		this.views.set(v.viewId, v);
		this.history.push(v);
		this.emit({ t: "opened", view: v });
		return v;
	}

	/** Source <-> reading mode switch: Obsidian keeps the leaf and file; the adapter reports file-changed (same path). */
	setMode(viewId: number, mode: "source" | "reading"): boolean {
		const v = this.views.get(viewId);
		if (!v || v.mode === mode) return false;
		v.mode = mode;
		this.emit({ t: "file-changed", view: v, previousPath: v.path });
		return true;
	}

	/** Switch a leaf to another file (Obsidian saves the old one first). */
	async switchFile(viewId: number, path: string): Promise<boolean> {
		const v = this.views.get(viewId);
		const text = this.vault.textOf(path);
		if (!v || text === null) return false;
		if (v.isDirty()) await v.save();
		const previousPath = v.path;
		v.path = this.displayPath(path);
		v.loadFile(text);
		this.emit({ t: "file-changed", view: v, previousPath });
		return true;
	}

	async closeView(viewId: number): Promise<void> {
		const v = this.views.get(viewId);
		if (!v) return;
		await v.close();
		this.views.delete(viewId);
		this.emit({ t: "closed", viewId });
	}

	/** Device crash: views vanish without saving. */
	crashAll(): void {
		for (const v of this.views.values()) v.crash();
		this.views.clear();
		this.offVault();
	}

	dispose(): void {
		for (const v of this.views.values()) v.crash();
		this.views.clear();
		this.offVault();
	}

	private displayPath(path: string): string {
		const snap = this.vault.snapshot();
		for (const p of snap.keys()) if (this.vault.key(p) === this.vault.key(path)) return p;
		return path;
	}

	private emit(event: ViewEvent): void {
		for (const l of [...this.listeners]) l(event);
	}

	samePath(a: string, b: string): boolean {
		return this.vault.key(a) === this.vault.key(b);
	}

	private same(a: string | null, b: string): boolean {
		return a !== null && this.samePath(a, b);
	}

	private onVaultEvent(e: VaultEvent): void {
		switch (e.t) {
			case "modify":
			case "create":
				return; // views reload from SimVault.onReload

			case "rename":
				for (const v of this.views.values()) if (this.same(v.path, e.from)) v.path = e.to;
				return;
			case "delete":
				for (const v of [...this.views.values()]) {
					if (this.same(v.path, e.path) && !this.vault.hasFile(e.path)) {
						v.crash();
						this.views.delete(v.viewId);
						this.emit({ t: "closed", viewId: v.viewId });
					}
				}
				return;
		}
	}
}
