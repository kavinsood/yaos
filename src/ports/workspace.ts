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
 * External content arriving for a bound view, intercepted at the view instance
 * (wrapping view.setViewData(data, clear=false) on that instance only, removed
 * on unbind). The handler must route it through the merge engine and return
 * "handled"; "default" lets Obsidian apply it (used when not bound).
 */
export type ExternalReloadHandler = (incoming: string) => "handled" | "default";

export interface EditorBindingSpec {
	/** A change made in this editor (typing, undo, paste, commands), once per transaction, in order. */
	onLocal(changes: ChangeSet): void;
	/** The editor state was replaced without a transaction (EditorView.setState): the binding is void. */
	onReset(): void;
	/** Obsidian is reading the editor for a save (view.getViewData), synchronously before it writes. */
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
	/** Unsaved editor edits (TextFileView.dirty): the editor may differ from getLastSavedText(). */
	isDirty(): boolean;
	/** The text Obsidian last loaded or saved for this view (view.data). Read, never compared, on main. */
	getLastSavedText(): string;
	/** Attach the editor binding. Throws when the view has no CodeMirror 6 editor. */
	bind(spec: EditorBindingSpec): EditorBinding;
	interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe;
	/** Force Obsidian's save now (instead of its 2 s debounce). */
	save(): Promise<void>;
}

export interface WorkspacePort {
	listMarkdownViews(): readonly EditorViewRef[];
	onViewEvent(listener: (event: ViewEvent) => void): Unsubscribe;
}
