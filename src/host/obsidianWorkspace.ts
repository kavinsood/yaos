/**
 * WorkspacePort over Obsidian's workspace (DESIGN §d.2).
 *
 * Views: every leaf of type "markdown". The adapter diffs the leaf set on
 * layout-change / active-leaf-change / file-open (and on demand) and emits
 * opened / file-changed / closed. A source<->reading mode switch is reported
 * as file-changed with the same path so the binding (un)binds.
 *
 * Interception (OR-2): an instance-level wrapper of view.setViewData, never a
 * prototype patch. clear=false (external reload of the same file) goes to the
 * handler; "handled" swallows it. clear=true (Obsidian loading another file
 * into this view) detaches the y-codemirror binding BEFORE Obsidian replaces
 * the editor content, so the next file's text can never be written into the
 * previous file's doc.
 */

import type { VaultPath } from "../core/types";
import type { Unsubscribe } from "../ports/common";
import type { EditorBindingSpec, EditorViewRef, ExternalReloadHandler, ViewEvent, WorkspacePort } from "../ports/workspace";
import type { EventRefLike } from "./obsidianApi";

export interface EditorLike {
	getValue(): string;
	offsetToPos(offset: number): { line: number; ch: number };
	replaceRange(text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void;
}

export interface MarkdownViewLike {
	file: { path: string } | null;
	editor: EditorLike;
	data?: string;
	getViewType(): string;
	getMode(): string;
	setViewData(data: string, clear: boolean): void;
	save(): Promise<void>;
}

export interface WorkspaceLike {
	getLeavesOfType(type: string): { view: unknown }[];
	on(name: "layout-change", cb: () => unknown): EventRefLike;
	on(name: "active-leaf-change", cb: (leaf: unknown) => unknown): EventRefLike;
	on(name: "file-open", cb: (file: unknown) => unknown): EventRefLike;
	offref(ref: EventRefLike): void;
}

/** Attaches the editor binding (collab.ts in production); returns detach. */
export type AttachFn = (editor: EditorLike, spec: EditorBindingSpec) => (() => void) | null;

class ObsidianViewRef implements EditorViewRef {
	private detachBinding: (() => void) | null = null;
	private handler: ExternalReloadHandler | null = null;
	private wrapped = false;
	private ownBefore = false;
	private orig: MarkdownViewLike["setViewData"] | null = null;

	constructor(
		readonly viewId: number,
		readonly view: MarkdownViewLike,
		private readonly attach: AttachFn,
	) {}

	get path(): VaultPath | null {
		return (this.view.file?.path ?? null) as VaultPath | null;
	}

	hasEditor(): boolean {
		return this.view.getMode() === "source";
	}

	getText(): string {
		return this.view.editor.getValue();
	}

	getLastSavedText(): string {
		return typeof this.view.data === "string" ? this.view.data : this.getText();
	}

	applyMinimalReplace(text: string): void {
		const cur = this.getText();
		if (cur === text) return;
		let start = 0;
		while (start < cur.length && start < text.length && cur.charCodeAt(start) === text.charCodeAt(start)) start++;
		let ec = cur.length;
		let et = text.length;
		while (ec > start && et > start && cur.charCodeAt(ec - 1) === text.charCodeAt(et - 1)) {
			ec--;
			et--;
		}
		const ed = this.view.editor;
		ed.replaceRange(text.slice(start, et), ed.offsetToPos(start), ed.offsetToPos(ec));
	}

	bind(spec: EditorBindingSpec): Unsubscribe {
		this.unbindNow();
		const detach = this.attach(this.view.editor, spec);
		if (!detach) throw new Error("editor has no CodeMirror 6 view");
		this.detachBinding = detach;
		this.ensureWrapper();
		return () => {
			if (this.detachBinding === detach) this.unbindNow();
		};
	}

	interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe {
		this.handler = handler;
		this.ensureWrapper();
		return () => {
			if (this.handler !== handler) return;
			this.handler = null;
			if (!this.detachBinding) this.removeWrapper();
		};
	}

	save(): Promise<void> {
		return this.view.save();
	}

	get isBound(): boolean {
		return this.detachBinding !== null;
	}

	private unbindNow(): void {
		const d = this.detachBinding;
		this.detachBinding = null;
		d?.();
	}

	private ensureWrapper(): void {
		if (this.wrapped) return;
		const v = this.view;
		this.ownBefore = Object.prototype.hasOwnProperty.call(v, "setViewData");
		const orig = v.setViewData;
		this.orig = orig;
		const self = this;
		v.setViewData = function (this: MarkdownViewLike, data: string, clear: boolean): void {
			if (clear) {
				// Another file is being loaded into this view: unbind first.
				self.unbindNow();
				self.handler = null;
			} else if (self.handler && self.handler(data) === "handled") {
				return;
			}
			orig.call(this, data, clear);
		};
		this.wrapped = true;
	}

	removeWrapper(): void {
		if (!this.wrapped || !this.orig) return;
		if (this.ownBefore) this.view.setViewData = this.orig;
		else delete (this.view as Partial<MarkdownViewLike>).setViewData;
		this.wrapped = false;
		this.orig = null;
	}

	dispose(): void {
		this.unbindNow();
		this.handler = null;
		this.removeWrapper();
	}
}

interface Known {
	ref: ObsidianViewRef;
	path: string | null;
	mode: string;
}

function isMarkdownView(v: unknown): v is MarkdownViewLike {
	const x = v as Partial<MarkdownViewLike> | null;
	return !!x && typeof x.getViewType === "function" && x.getViewType() === "markdown" && typeof x.setViewData === "function" && !!x.editor;
}

export class ObsidianWorkspace implements WorkspacePort {
	private readonly ids = new WeakMap<object, number>();
	private nextId = 1;
	private known = new Map<number, Known>();
	private readonly listeners = new Set<(e: ViewEvent) => void>();
	private refs: EventRefLike[] = [];

	constructor(
		private readonly ws: WorkspaceLike,
		private readonly attach: AttachFn,
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
				const ref = new ObsidianViewRef(id, v, this.attach);
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
