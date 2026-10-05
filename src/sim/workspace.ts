/**
 * SimWorkspace: Obsidian markdown views for the simulation (DESIGN §l.1).
 *
 * Models what matters for sync, matching what the Android spike measured on
 * Obsidian 1.13.8 (docs/client-remake/spike-reports/android-2026-10-06.md):
 *  - an editor buffer per view, `data` = view.data, and Obsidian's 2 s trailing
 *    save debounce (any editor change, local or remote, schedules a save);
 *  - save(): `data = getViewData()` FIRST, then the write (writer "save"). So a
 *    save always writes the editor, whatever `data` held (spike C);
 *  - setData(text, clear) (TextFileView.setData): `data = text` is assigned
 *    BEFORE setViewData(text, clear) is called. An interceptor that returns
 *    "handled" therefore sees view.data === incoming already (spike A), and if
 *    it leaves the editor alone the next save overwrites the incoming text
 *    (spike C: the data loss the binding must avoid);
 *  - file open / leaf switch: setData(text, clear=true);
 *  - external reloads: every modify/create event of an open file makes
 *    Obsidian re-read it `reloadDelayMs` (25 ms, spike B) after the event and,
 *    if it differs from view.data, call setData(text, false) on every view of
 *    that file: split views, and reading-mode views too (spike R). The
 *    per-instance interceptor (WorkspacePort.interceptExternalReload) sees it
 *    first; otherwise the default replaces the buffer, which a bound editor
 *    turns into a local CRDT edit (the clobber the interceptor exists to
 *    prevent). Not modelled: Obsidian's own merge of unsaved edits into an
 *    unbound dirty editor (spike E); the default here is a plain replace;
 *  - a y-codemirror.next stand-in with the same origin rules: editor changes
 *    go to the Y.Text in one transaction tagged with the binding's origin;
 *    Y.Text changes from any other origin are applied to the buffer and are
 *    not echoed back. Counters let tests assert "no echo loop";
 *  - rename of an open file updates view.path; delete closes its views.
 */

import * as Y from "yjs";
import type { Unsubscribe } from "../ports/common";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { EditorBindingSpec, EditorViewRef, ExternalReloadHandler, ViewEvent, WorkspacePort } from "../ports/workspace";
import type { VaultEvent } from "../ports/vault";
import { OBSIDIAN_RELOAD_DELAY_MS, type SimVault } from "./vault";

export const OBSIDIAN_SAVE_DEBOUNCE_MS = 2_000;

interface Binding {
	readonly ytext: Y.Text;
	readonly origin: unknown;
	readonly observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;
}

export interface ViewCounters {
	/** Editor-originated Y.Text transactions (one per user edit while bound). */
	localTx: number;
	/** Y.Text changes applied to the buffer (remote/merge). */
	remoteApplied: number;
	saves: number;
	setViewDataCalls: number;
	intercepted: number;
	/** setViewData applied by default while bound (CRDT clobber path). */
	defaultReloadWhileBound: number;
	/** bind() called while buffer != Y.Text (binding contract violation). */
	bindMismatch: number;
}

export class SimEditorView implements EditorViewRef {
	path: string | null;
	buffer = "";
	data = "";
	mode: "source" | "reading" = "source";
	private binding: Binding | null = null;
	private interceptor: ExternalReloadHandler | null = null;
	private saveTimer: TimerHandle | null = null;
	private reloadTimer: TimerHandle | null = null;
	private dirty = false;
	closed = false;
	readonly counters: ViewCounters = { localTx: 0, remoteApplied: 0, saves: 0, setViewDataCalls: 0, intercepted: 0, defaultReloadWhileBound: 0, bindMismatch: 0 };

	constructor(
		readonly viewId: number,
		path: string,
		private readonly ws: SimWorkspace,
	) {
		this.path = path;
	}

	// --- EditorViewRef --------------------------------------------------------

	hasEditor(): boolean {
		return this.mode === "source" && !this.closed;
	}

	getText(): string {
		return this.buffer;
	}

	getLastSavedText(): string {
		return this.data;
	}

	applyMinimalReplace(text: string): void {
		if (this.binding) throw new Error("applyMinimalReplace while bound");
		if (text === this.buffer) return;
		this.buffer = text;
		this.markDirty();
	}

	bind(spec: EditorBindingSpec): Unsubscribe {
		if (this.binding) throw new Error("bind while bound");
		if (spec.ytext.toString() !== this.buffer) this.counters.bindMismatch++;
		const observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
			if (tr.origin === spec.localOrigin) return;
			let pos = 0;
			let out = this.buffer;
			for (const d of event.delta) {
				if (d.insert != null) {
					const ins = typeof d.insert === "string" ? d.insert : "";
					out = out.slice(0, pos) + ins + out.slice(pos);
					pos += ins.length;
				} else if (d.delete != null) {
					out = out.slice(0, pos) + out.slice(pos + d.delete);
				} else if (d.retain != null) {
					pos += d.retain;
				}
			}
			this.buffer = out;
			this.counters.remoteApplied++;
			this.markDirty();
		};
		spec.ytext.observe(observer);
		const binding: Binding = { ytext: spec.ytext, origin: spec.localOrigin, observer };
		this.binding = binding;
		return () => {
			if (this.binding !== binding) return;
			spec.ytext.unobserve(observer);
			this.binding = null;
		};
	}

	interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe {
		this.interceptor = handler;
		return () => {
			if (this.interceptor === handler) this.interceptor = null;
		};
	}

	async save(): Promise<void> {
		if (this.saveTimer !== null) {
			this.ws.clock.clearTimer(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.closed || this.path === null) return;
		const text = this.buffer;
		this.dirty = false;
		// Skipped only when it would rewrite identical bytes (no observable difference).
		if (text === this.data && this.ws.vault.textOf(this.path) === text) return;
		this.data = text; // view.data = getViewData(), then vault.modify

		this.counters.saves++;
		this.ws.vault.editorSave(this.path, text);
	}

	// --- user actions ---------------------------------------------------------

	/** User edit in the editor (positions in UTF-16 units of the buffer). */
	edit(pos: number, deleteCount: number, insert: string): void {
		if (!this.hasEditor()) return;
		const p = Math.max(0, Math.min(pos, this.buffer.length));
		const del = Math.max(0, Math.min(deleteCount, this.buffer.length - p));
		this.buffer = this.buffer.slice(0, p) + insert + this.buffer.slice(p + del);
		const b = this.binding;
		if (b) {
			this.counters.localTx++;
			const doc = b.ytext.doc;
			if (!doc) throw new Error("ytext without doc");
			doc.transact(() => {
				if (del > 0) b.ytext.delete(p, del);
				if (insert.length > 0) b.ytext.insert(p, insert);
			}, b.origin);
		}
		this.markDirty();
	}

	isBound(): boolean {
		return this.binding !== null;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	// --- Obsidian internals ---------------------------------------------------

	/** TextFileView.setData(data, clear): view.data is assigned before setViewData runs. */
	setData(text: string, clear: boolean): void {
		this.data = text;
		this.setViewData(text, clear);
	}

	/** Obsidian's modify/create handler for this view's file: re-read after the reload lag, reload if != data. */
	noteFileModified(): void {
		if (this.reloadTimer !== null || this.closed) return;
		this.reloadTimer = this.ws.clock.setTimer(this.ws.reloadDelayMs, () => {
			this.reloadTimer = null;
			if (this.closed || this.path === null) return;
			const text = this.ws.vault.textOf(this.path);
			if (text !== null && text !== this.data) this.setData(text, false);
		});
	}

	/** MarkdownView.setViewData(data, clear). Called by setData only (data is already assigned). */
	setViewData(incoming: string, clear: boolean): void {
		this.counters.setViewDataCalls++;
		if (clear) {
			// Another file is loaded into this leaf. The Obsidian adapter's instance
			// wrapper (host/obsidianWorkspace.ts) detaches the binding and drops the
			// interceptor BEFORE Obsidian replaces the editor text; mirror that.
			const b = this.binding;
			if (b) b.ytext.unobserve(b.observer);
			this.binding = null;
			this.interceptor = null;
		} else if (this.interceptor) {
			if (this.interceptor(incoming) === "handled") {
				this.counters.intercepted++;
				return;
			}
		}
		if (this.binding) {
			// Obsidian replaces the CM doc; y-codemirror forwards it as an editor change.
			this.counters.defaultReloadWhileBound++;
			const b = this.binding;
			const old = this.buffer;
			let start = 0;
			while (start < old.length && start < incoming.length && old.charCodeAt(start) === incoming.charCodeAt(start)) start++;
			let eo = old.length;
			let ei = incoming.length;
			while (eo > start && ei > start && old.charCodeAt(eo - 1) === incoming.charCodeAt(ei - 1)) {
				eo--;
				ei--;
			}
			this.buffer = incoming;
			b.ytext.doc?.transact(() => {
				if (eo > start) b.ytext.delete(start, eo - start);
				if (ei > start) b.ytext.insert(start, incoming.slice(start, ei));
			}, b.origin);
		} else {
			this.buffer = incoming;
		}
		this.dirty = false;
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.saveTimer !== null) this.ws.clock.clearTimer(this.saveTimer);
		this.saveTimer = this.ws.clock.setTimer(this.ws.saveDebounceMs, () => {
			this.saveTimer = null;
			void this.save();
		});
	}

	/** Close: Obsidian saves a dirty view before closing it. */
	async close(): Promise<void> {
		if (this.dirty) await this.save();
		this.stopTimers();
		this.closed = true;
	}

	/** Device crash: unsaved buffer content is lost, no save. */
	crash(): void {
		this.stopTimers();
		this.closed = true;
	}

	private stopTimers(): void {
		if (this.saveTimer !== null) this.ws.clock.clearTimer(this.saveTimer);
		if (this.reloadTimer !== null) this.ws.clock.clearTimer(this.reloadTimer);
		this.saveTimer = null;
		this.reloadTimer = null;
	}
}

export interface SimWorkspaceOptions {
	readonly clock: ClockPort;
	readonly vault: SimVault;
	readonly saveDebounceMs?: number;
	/** Modify event -> setViewData lag (default OBSIDIAN_RELOAD_DELAY_MS, spike B). */
	readonly reloadDelayMs?: number;
}

export class SimWorkspace implements WorkspacePort {
	readonly clock: ClockPort;
	readonly vault: SimVault;
	readonly saveDebounceMs: number;
	readonly reloadDelayMs: number;
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
		this.reloadDelayMs = opts.reloadDelayMs ?? OBSIDIAN_RELOAD_DELAY_MS;
		this.offVault = this.vault.onEvent((e) => this.onVaultEvent(e));
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
		v.setData(text, true);
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
		v.setData(text, true);
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

	private same(a: string | null, b: string): boolean {
		return a !== null && this.vault.key(a) === this.vault.key(b);
	}

	private onVaultEvent(e: VaultEvent): void {
		switch (e.t) {
			case "modify":
			case "create": {
				// Obsidian re-reads the file ~25 ms later and reloads views (any mode) whose data differs.
				for (const v of this.views.values()) if (this.same(v.path, e.path) && !v.closed) v.noteFileModified();
				return;
			}
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
