/**
 * WorkspacePort: open editor views (main thread). DESIGN §d.2, §d.3.
 *
 * A markdown view is "bound" while its CodeMirror editor is a client of the
 * worker replica: local changes leave as ChangeSets, the replica's other
 * changes come back as ChangeSets. Main keeps no CRDT. While bound, the editor
 * buffer is the Local-tree content of that file and Obsidian's own save
 * writes it; the projection never writes a bound file.
 *
 * Only @codemirror/state types cross this port (type-only; Obsidian provides
 * the package at runtime). Every call here is O(1) or O(change): nothing reads
 * or compares whole texts.
 */

import type { ChangeSet, Text } from "@codemirror/state";
import type { Unsubscribe } from "./common";
import type { VaultPath } from "../core/types";

export type ViewEvent =
	| { readonly t: "opened"; readonly view: EditorViewRef }
	/** The view switched to another file (Obsidian reuses leaves). */
	| { readonly t: "file-changed"; readonly view: EditorViewRef; readonly previousPath: VaultPath | null }
	| { readonly t: "closed"; readonly viewId: number };

/**
 * Content Obsidian puts into a bound view without an editor transaction, intercepted at the view instance
 * (wrapping view.setViewData(data, clear=false) on that instance only, removed on unbind): an external reload
 * of the file (TextFileView.loadFileInternal), a properties edit (MarkdownView.saveFrontmatter), or the
 * quick-preview copy of another view of the same file. `from` is that other view's id for a quick preview
 * (MarkdownView.onInternalDataChange -> workspace "quick-preview" -> onExternalDataChange -> setData), else
 * null. The handler routes it through the engine and returns "handled"; "default" lets Obsidian apply it.
 */
export type ExternalReloadHandler = (incoming: string, from: number | null) => "handled" | "default";

export interface EditorBindingSpec {
	/** A change made in this editor (typing, undo, paste, commands), once per transaction, in order. */
	onLocal(changes: ChangeSet): void;
	/** The editor state was replaced without a transaction (EditorView.setState): the binding is void. */
	onReset(): void;
	/** Obsidian is reading the editor for a save (view.getViewData with dirty cleared), synchronously before it writes. */
	onSaveRead(): void;
}

export interface EditorBinding {
	/** The editor document now (immutable CodeMirror Text: O(1), shares structure). */
	doc(): Text;
	/** Apply a change that is not this editor's own: kept out of undo history, never reported to onLocal. */
	applyRemote(changes: ChangeSet): void;
	detach(): void;
}

export interface EditorViewRef {
	readonly viewId: number;
	readonly path: VaultPath | null;
	/** Source/live-preview editor present (reading mode has no editable buffer). */
	hasEditor(): boolean;
	/** The editor document now (O(1)). Null without an editor. */
	editorDoc(): Text | null;
	/** Unsaved editor edits (TextFileView.dirty): the editor may differ from lastSavedText(). */
	isDirty(): boolean;
	/** The text Obsidian last loaded or saved for this view (TextFileView.lastSavedData). Read, never compared, on main. */
	lastSavedText(): string | null;
	/** Attach the editor binding. Throws when the view has no CodeMirror 6 editor. */
	bind(spec: EditorBindingSpec): EditorBinding;
	interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe;
	/**
	 * While held, Obsidian's saves of this view write nothing (getViewData answers the text Obsidian last loaded or
	 * saved, TextFileView.lastSavedData, which its save compares and skips). Releasing returns whether a save was
	 * skipped meanwhile. Used while the engine merges an external reload the editor does not show yet.
	 */
	holdSaves(hold: boolean): boolean;
	/** Force Obsidian's save now (instead of its 2 s debounce). */
	save(): Promise<void>;
}

export interface WorkspacePort {
	listMarkdownViews(): readonly EditorViewRef[];
	onViewEvent(listener: (event: ViewEvent) => void): Unsubscribe;
}
