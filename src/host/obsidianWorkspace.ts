/**
 * WorkspacePort over Obsidian's workspace (DESIGN §d.2).
 *
 * Views: every leaf of type "markdown". The adapter diffs the leaf set on
 * layout-change / active-leaf-change / file-open (and on demand) and emits
 * opened / file-changed / closed. A source<->reading mode switch is reported
 * as file-changed with the same path so the binding (un)binds. Nothing here
 * reads, copies or compares a document: a refresh is O(leaves).
 *
 * Interception (OR-2): instance-level wrappers, never prototype patches.
 * - setViewData: clear=false (external reload of the same file) goes to the
 *   handler; "handled" swallows it. clear=true (Obsidian loading another file
 *   into this view) detaches the binding BEFORE Obsidian replaces the editor
 *   content, so the next file's text can never reach the previous file's doc.
 * - getViewData (what TextFileView.save writes): with dirty cleared (save()
 *   clears it before reading; loadFileInternal reads only while dirty) it
 *   reports onSaveRead, and while saves are held answers view.lastSavedData,
 *   which save() compares and skips (Obsidian 1.14.4 TextFileView.save:
 *   `if (this.lastSavedData === o || null === this.lastSavedData) return`). The
 *   2 s debounced save calls the prototype save bound at construction, which
 *   still reads this.getViewData, so the instance wrapper sees every save.
 * - onInternalDataChange: MarkdownView fires workspace "quick-preview" from it,
 *   synchronously, and every other view of the file takes the text through
 *   onExternalDataChange -> setData(text, false). The wrapper names the source
 *   view, so a bound sibling's copy is told apart without reading the text.
 */

import type { Text } from "@codemirror/state";
import type { VaultPath } from "../core/types";
import type { Unsubscribe } from "../ports/common";
import type { EditorBinding, EditorBindingSpec, EditorViewRef, ExternalReloadHandler, ViewEvent, WorkspacePort } from "../ports/workspace";
import type { EventRefLike } from "./obsidianApi";

export interface MarkdownViewLike {
	file: { path: string } | null;
	editor: unknown;
	dirty?: boolean;
	lastSavedData?: string | null;
	getViewType(): string;
	getMode(): string;
	getViewData(): string;
	setViewData(data: string, clear: boolean): void;
	onInternalDataChange?(): void;
	save(): Promise<void>;
}

export interface WorkspaceLike {
	getLeavesOfType(type: string): { view: unknown }[];
	on(name: "layout-change", cb: () => unknown): EventRefLike;
	on(name: "active-leaf-change", cb: (leaf: unknown) => unknown): EventRefLike;
	on(name: "file-open", cb: (file: unknown) => unknown): EventRefLike;
	offref(ref: EventRefLike): void;
}

/** The CodeMirror side (collab.ts in production): the editor's document, and attaching the binding. */
export interface EditorAdapter {
	doc(editor: unknown): Text | null;
	attach(editor: unknown, spec: EditorBindingSpec): EditorBinding | null;
}

type Wrapped = "setViewData" | "getViewData" | "onInternalDataChange";

/** The view whose MarkdownView.onInternalDataChange is running (it fires quick-preview into its siblings synchronously). */
let previewFrom: number | null = null;

class ObsidianViewRef implements EditorViewRef {
	private binding: EditorBinding | null = null;
	private spec: EditorBindingSpec | null = null;
	private handler: ExternalReloadHandler | null = null;
	private held = false;
	private skipped = false;
	private readonly orig = new Map<Wrapped, { fn: (...a: never[]) => unknown; own: boolean }>();

	constructor(
		readonly viewId: number,
		readonly view: MarkdownViewLike,
		private readonly editors: EditorAdapter,
	) {}

	get path(): VaultPath | null {
		return (this.view.file?.path ?? null) as VaultPath | null;
	}

	hasEditor(): boolean {
		return this.view.getMode() === "source";
	}

	editorDoc(): Text | null {
		return this.editors.doc(this.view.editor);
	}

	isDirty(): boolean {
		return this.view.dirty === true;
	}

	lastSavedText(): string | null {
		return typeof this.view.lastSavedData === "string" ? this.view.lastSavedData : null;
	}

	bind(spec: EditorBindingSpec): EditorBinding {
		this.unbindNow();
		const b = this.editors.attach(this.view.editor, spec);
		if (!b) throw new Error("editor has no CodeMirror 6 view");
		this.binding = b;
		this.spec = spec;
		this.wrap();
		const unbind = () => {
			if (this.binding === b) this.unbindNow();
		};
		return { doc: () => b.doc(), applyRemote: (c) => b.applyRemote(c), detach: unbind };
	}

	interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe {
		this.handler = handler;
		this.wrap();
		return () => {
			if (this.handler !== handler) return;
			this.handler = null;
			if (!this.binding) this.unwrap();
		};
	}

	holdSaves(hold: boolean): boolean {
		const skipped = this.skipped;
		this.held = hold;
		this.skipped = false;
		if (hold) this.wrap();
		else if (!this.binding && !this.handler) this.unwrap();
		return !hold && skipped;
	}

	save(): Promise<void> {
		return this.view.save();
	}

	get isBound(): boolean {
		return this.binding !== null;
	}

	private unbindNow(): void {
		const b = this.binding;
		this.binding = null;
		this.spec = null;
		this.held = false;
		this.skipped = false;
		b?.detach();
	}

	private wrap(): void {
		if (this.orig.size > 0) return;
		const v = this.view;
		const keep = (k: Wrapped) => {
			const fn = v[k];
			if (typeof fn === "function") this.orig.set(k, { fn, own: Object.prototype.hasOwnProperty.call(v, k) });
			return fn;
		};
		const setViewData = keep("setViewData") as MarkdownViewLike["setViewData"];
		const getViewData = keep("getViewData") as MarkdownViewLike["getViewData"];
		const onInternalDataChange = keep("onInternalDataChange") as MarkdownViewLike["onInternalDataChange"];
		const self = this;
		v.setViewData = function (this: MarkdownViewLike, data: string, clear: boolean): void {
			if (clear) {
				// Another file is being loaded into this view: unbind first.
				self.unbindNow();
				self.handler = null;
			} else if (self.handler && self.handler(data, previewFrom !== self.viewId ? previewFrom : null) === "handled") {
				return;
			}
			setViewData.call(this, data, clear);
		};
		v.getViewData = function (this: MarkdownViewLike): string {
			// save() clears dirty before it reads; loadFileInternal reads only while dirty (to merge) and must see the editor.
			if (this.dirty !== true) {
				self.spec?.onSaveRead();
				if (self.held && typeof this.lastSavedData === "string") {
					self.skipped = true;
					return this.lastSavedData;
				}
			}
			return getViewData.call(this);
		};
		if (onInternalDataChange) {
			v.onInternalDataChange = function (this: MarkdownViewLike): void {
				const prev = previewFrom;
				previewFrom = self.viewId;
				try {
					onInternalDataChange.call(this);
				} finally {
					previewFrom = prev;
				}
			};
		}
	}

	private unwrap(): void {
		const v = this.view as unknown as Record<Wrapped, unknown>;
		for (const [k, o] of this.orig) {
			if (o.own) v[k] = o.fn;
			else delete v[k];
		}
		this.orig.clear();
	}

	removeWrapper(): void {
		this.unwrap();
	}

	dispose(): void {
		this.unbindNow();
		this.handler = null;
		this.unwrap();
	}
}

interface Known {
	ref: ObsidianViewRef;
	path: string | null;
	mode: string;
}

function isMarkdownView(v: unknown): v is MarkdownViewLike {
	const x = v as Partial<MarkdownViewLike> | null;
	return !!x && typeof x.getViewType === "function" && x.getViewType() === "markdown" && typeof x.setViewData === "function" && typeof x.getViewData === "function" && !!x.editor;
}

export class ObsidianWorkspace implements WorkspacePort {
	private readonly ids = new WeakMap<object, number>();
	private nextId = 1;
	private known = new Map<number, Known>();
	private readonly listeners = new Set<(e: ViewEvent) => void>();
	private refs: EventRefLike[] = [];

	constructor(
		private readonly ws: WorkspaceLike,
		private readonly editors: EditorAdapter,
	) {}

	listMarkdownViews(): readonly EditorViewRef[] {
		// With subscribers, pending changes are emitted (never silently absorbed).
		this.refresh(this.listeners.size > 0);
		return [...this.known.values()].map((k) => k.ref);
	}

	onViewEvent(listener: (event: ViewEvent) => void): Unsubscribe {
		if (this.listeners.size === 0) {
			this.refresh(false);
			const r = () => this.refresh(true);
			this.refs = [this.ws.on("layout-change", r), this.ws.on("active-leaf-change", r), this.ws.on("file-open", r)];
		}
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				for (const ref of this.refs) this.ws.offref(ref);
				this.refs = [];
			}
		};
	}

	/** Diff the markdown leaves against what we know; emit=false only syncs state. */
	refresh(emit = true): void {
		const seen = new Set<number>();
		const events: ViewEvent[] = [];
		for (const leaf of this.ws.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (!isMarkdownView(v)) continue;
			let id = this.ids.get(v);
			if (id === undefined) {
				id = this.nextId++;
				this.ids.set(v, id);
			}
			seen.add(id);
			const path = v.file?.path ?? null;
			const mode = v.getMode();
			const k = this.known.get(id);
			if (!k) {
				const ref = new ObsidianViewRef(id, v, this.editors);
				this.known.set(id, { ref, path, mode });
				events.push({ t: "opened", view: ref });
			} else if (k.path !== path || k.mode !== mode) {
				const previousPath = k.path as VaultPath | null;
				k.path = path;
				k.mode = mode;
				events.push({ t: "file-changed", view: k.ref, previousPath });
			}
		}
		for (const [id, k] of [...this.known]) {
			if (seen.has(id)) continue;
			this.known.delete(id);
			k.ref.dispose();
			events.push({ t: "closed", viewId: id });
		}
		if (!emit) return;
		for (const e of events) for (const l of [...this.listeners]) l(e);
	}

	dispose(): void {
		for (const ref of this.refs) this.ws.offref(ref);
		this.refs = [];
		for (const k of this.known.values()) k.ref.dispose();
		this.known.clear();
		this.listeners.clear();
	}
}
