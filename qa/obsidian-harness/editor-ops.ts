/**
 * Editor operations for the QA harness.
 *
 * Uses real Obsidian editor APIs — NOT app.vault.modify() for tests that
 * exercise the editor/CRDT binding boundary.
 */

import { MarkdownView, normalizePath, type App } from "obsidian";
import { sleep, waitForCondition } from "./wait";

export async function openFile(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	await app.workspace.openLinkText(normalized, "", true);
	await waitForCondition(
		() => {
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			return view?.file?.path === normalized;
		},
		5000,
		`openFile(${path})`,
	);
}

export async function closeFile(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	const toDetach: ReturnType<typeof app.workspace.getLeaf>[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		// Match by path, also detach leaves whose file was deleted (file=null)
		// but whose last path matched — avoids stale binding-health-failed loops.
		const leafPath = leaf.view instanceof MarkdownView
			? (leaf.view.file?.path ?? (leaf.view as unknown as { _filePath?: string })._filePath)
			: null;
		if (leaf.view instanceof MarkdownView && leafPath === normalized) {
			toDetach.push(leaf);
		}
	});
	for (const leaf of toDetach) {
		leaf.detach();
	}
}

function getViewForPath(app: App, path: string): MarkdownView {
	const normalized = normalizePath(path);
	let found: MarkdownView | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		if (found) return;
		if (leaf.view instanceof MarkdownView && leaf.view.file?.path === normalized) {
			found = leaf.view;
		}
	});
	if (!found) throw new Error(`No open MarkdownView for path: ${normalized}`);
	return found;
}

/**
 * Append text to a file's editor via a single atomic document replacement.
 *
 * This function exercises the editor→CRDT propagation path: a CodeMirror 6
 * document replacement triggers one y-codemirror reconciliation pass that
 * applies the change to the Y.Text.
 *
 * What it tests:
 *   - y-codemirror binding connectivity (editor ↔ Y.Text)
 *   - CRDT update from a single editor transaction
 *   - DiskMirror write from the resulting Y.Text change
 *
 * What it does NOT test:
 *   - Per-keystroke incremental sync
 *   - Debounced write behavior
 *   - Cursor-sensitive or partial-transaction behavior
 *
 * Implementation note: character-by-character replaceRange was replaced with
 * atomic setValue because headless CDP runs have no OS window focus, causing
 * getCursor() to return {line:0,ch:0} on every call and inserting all characters
 * at position 0 (reversing the text). Atomic setValue avoids this and also
 * eliminates intermediate Y.js states from N partial transactions.
 *
 * The intervalMs option is kept for API compatibility but is unused.
 */
export async function typeIntoFile(
	app: App,
	path: string,
	text: string,
	opts: { intervalMs?: number } = {},
): Promise<void> {
	void opts; // intervalMs unused: atomic mode, no per-character delay
	const view = getViewForPath(app, path);
	const current = view.editor.getValue();
	view.editor.setValue(current + text);
	// Allow the y-codemirror binding one microtask to propagate the transaction
	// to Y.Text before the caller proceeds.
	await sleep(50);
}

/**
 * Replace entire editor content (blunt).
 * Only use for setup steps, not for live-sync correctness tests.
 */
export async function replaceFileContent(app: App, path: string, content: string): Promise<void> {
	const view = getViewForPath(app, path);
	view.editor.setValue(content);
}

export async function runCommand(app: App, commandId: string): Promise<void> {
	await (app as unknown as {
		commands: { executeCommandById: (id: string) => boolean | Promise<boolean>;
	};
	}).commands.executeCommandById(commandId);
}

export function listCommands(app: App, filter?: string): string[] {
	const all = Object.keys(
		(app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands,
	);
	return filter ? all.filter((id) => id.includes(filter)) : all;
}
