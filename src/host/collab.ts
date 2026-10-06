/**
 * CodeMirror attachment for bound views (DESIGN §d.2, §d.3). No CRDT on main: the editor is a client of the worker
 * replica in the @codemirror/collab model. A local transaction's ChangeSet goes to the binding (onLocal, O(change));
 * a change of the replica comes back as a ChangeSet dispatched with addToHistory=false and transaction filters
 * off, so CodeMirror's own history (Mod-z, Obsidian's "editor:undo") maps local events over it and undo never
 * reverts a remote edit.
 *
 * One static ViewPlugin registered on every editor through plugin.registerEditorExtension(collabExtension());
 * binding a view registers its listener for that EditorView only (no reconfigure, no Compartment). EditorView.setState
 * (Obsidian replacing the document wholesale) destroys and recreates view plugins (@codemirror/view 6.38.6
 * dist/index.js:7754-7757): the binding is then void (onReset).
 */

import { Annotation, Transaction, type ChangeSet, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorBinding, EditorBindingSpec } from "../ports/workspace";

/** Marks the binding's own remote dispatches (never reported back as local). */
const remoteChange = Annotation.define<true>();

interface Listener {
	readonly spec: EditorBindingSpec;
	live: boolean;
}

const listeners = new WeakMap<EditorView, Listener>();

const collabPlugin = ViewPlugin.fromClass(class {
	constructor(readonly view: EditorView) {}

	update(u: ViewUpdate): void {
		if (!u.docChanged) return;
		const l = listeners.get(u.view);
		if (!l?.live) return;
		for (const tr of u.transactions) {
			if (tr.docChanged && tr.annotation(remoteChange) !== true) l.spec.onLocal(tr.changes);
		}
	}

	destroy(): void {
		const l = listeners.get(this.view);
		if (!l?.live) return;
		l.live = false;
		listeners.delete(this.view);
		l.spec.onReset();
	}
});

export function collabExtension(): Extension {
	return collabPlugin;
}

/** EditorView behind an Obsidian Editor (private but stable `editor.cm`). */
export function editorViewOf(editor: unknown): EditorView | null {
	const cm = (editor as { cm?: unknown } | null)?.cm;
	return cm instanceof EditorView ? cm : null;
}

/** Attach the binding to `cm` (replacing any earlier one; that one is void). */
export function attachCollab(cm: EditorView, spec: EditorBindingSpec): EditorBinding {
	const prev = listeners.get(cm);
	if (prev) prev.live = false;
	const l: Listener = { spec, live: true };
	listeners.set(cm, l);
	return {
		doc: () => cm.state.doc,
		applyRemote(changes: ChangeSet): void {
			if (!l.live) return;
			cm.dispatch({ changes, annotations: [remoteChange.of(true), Transaction.addToHistory.of(false), Transaction.remote.of(true)], filter: false });
		},
		detach(): void {
			if (!l.live) return;
			l.live = false;
			if (listeners.get(cm) === l) listeners.delete(cm);
		},
	};
}

/** EditorAdapter for ObsidianWorkspace: Obsidian's Editor -> its EditorView. */
export const codeMirrorEditors = {
	doc: (editor: unknown) => editorViewOf(editor)?.state.doc ?? null,
	attach(editor: unknown, spec: EditorBindingSpec): EditorBinding | null {
		const cm = editorViewOf(editor);
		return cm ? attachCollab(cm, spec) : null;
	},
};
