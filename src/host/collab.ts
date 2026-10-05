/**
 * y-codemirror attachment for bound views (DESIGN §d.2).
 *
 * One Compartment registered on every editor through
 * plugin.registerEditorExtension(collabCompartmentExtension()); binding a view
 * reconfigures that compartment on that view's EditorView only. yCollab gets
 * its own Y.UndoManager (tracks only this editor's origin, so undo never
 * reverts a remote edit) and the y-undo keymap at highest precedence so
 * Mod-z / Mod-y / Mod-Shift-z use it while bound.
 * Gap (recorded): Obsidian's "editor:undo" command (menu, mobile toolbar)
 * calls CM history undo, which can include remote edits.
 */

import { Compartment, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { EditorBindingSpec } from "../ports/workspace";

const compartment = new Compartment();

export function collabCompartmentExtension(): Extension {
	return compartment.of([]);
}

/** EditorView behind an Obsidian Editor (private but stable `editor.cm`). */
export function editorViewOf(editor: unknown): EditorView | null {
	const cm = (editor as { cm?: unknown } | null)?.cm;
	return cm instanceof EditorView ? cm : null;
}

/** Attach yCollab to `cm`; returns an idempotent detach. Editor text must already equal ytext. */
export function attachCollab(cm: EditorView, spec: EditorBindingSpec): () => void {
	const undoManager = new Y.UndoManager(spec.ytext);
	cm.dispatch({ effects: compartment.reconfigure([yCollab(spec.ytext, spec.awareness, { undoManager }), Prec.highest(keymap.of(yUndoManagerKeymap))]) });
	let attached = true;
	return () => {
		if (!attached) return;
		attached = false;
		try {
			cm.dispatch({ effects: compartment.reconfigure([]) });
		} catch {
			// editor already destroyed
		}
		undoManager.destroy();
	};
}
