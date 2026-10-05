/**
 * WorkspacePort: open editor views (main thread). DESIGN §d.2.
 *
 * A markdown view is "bound" while a main-thread Y.Doc replica is attached to
 * its editor through y-codemirror. While bound, the editor buffer is the
 * Local-tree content of that file and Obsidian's own save writes it; the
 * projection never writes a bound file.
 */

import type * as Y from "yjs";
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
	readonly ytext: Y.Text;
	/** Origin tag the binding uses for editor-originated transactions. */
	readonly localOrigin: unknown;
	/** Optional awareness (cursor presence); null in v1. */
	readonly awareness: unknown;
}

export interface EditorViewRef {
	readonly viewId: number;
	readonly path: VaultPath | null;
	/** Source/live-preview editor present (reading mode has no editable buffer). */
	hasEditor(): boolean;
	getText(): string;
	/** The text Obsidian last loaded or saved for this view (view.data). */
	getLastSavedText(): string;
	/** Replace editor content with a minimal change set (cursor-preserving). Only before binding. */
	applyMinimalReplace(text: string): void;
	/** Attach y-codemirror to this view; returns the detach function. */
	bind(spec: EditorBindingSpec): Unsubscribe;
	interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe;
	/** Force Obsidian's save now (instead of its 2 s debounce). */
	save(): Promise<void>;
}

export interface WorkspacePort {
	listMarkdownViews(): readonly EditorViewRef[];
	onViewEvent(listener: (event: ViewEvent) => void): Unsubscribe;
}
