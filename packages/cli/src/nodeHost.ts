/**
 * The Node host the daemon hands to the plugin engine.
 *
 * The daemon does not reimplement sync policy. It constructs the real
 * `VaultSync`, `DiskMirror` and `ReconciliationController` and gives them a
 * host that is not Obsidian: an `App` stand-in, an
 * inert editor-bindings object, and a filesystem watcher. Everything below is
 * host mechanism. If a line of it looks like a decision about *what should
 * happen* to a file, it is in the wrong file.
 *
 * TWO CASTS, BOTH DELIBERATE. `NodeApp` is exposed as `App` and the inert
 * bindings object as `EditorBindingManager`. Obsidian's `App` and the real
 * binding manager are classes with a hundred members apiece — a private CM6
 * compartment, a `Workspace`, a `MetadataCache` — that a headless process has
 * no answer for. Widening them structurally is impossible; casting once, here,
 * with the exhaustive list of what production actually calls written down
 * beside it, is honest about where the boundary is.
 */

import type { App } from "obsidian";
import type { EditorBindingManager } from "../../../src/sync/editorBinding";
import { NodeApp, type MarkdownWalk, type PathProbe } from "./nodeApp";
import { startWatcher, type FsHint, type FsWatcher } from "./watcher";

export type { FsHint, FsWatcher } from "./watcher";
export type { MarkdownWalk, PathProbe } from "./nodeApp";
export { shadowedBy } from "./nodeApp";

/** One scan: the Markdown it found, and the paths it could not read. */
export interface MarkdownScan {
	/** Every Markdown file the scan saw: vault-relative, POSIX, NFC. */
	readonly paths: readonly string[];
	/** Paths whose contents the scan failed to establish — see `MarkdownWalk`. */
	readonly unreadable: readonly string[];
}

export interface NodeHost {
	/**
	 * The `App` stand-in.
	 *
	 * The complete list of members production reaches for on the daemon's
	 * paths, verified by grepping `this.app.`/`deps.app.` across
	 * `src/sync/diskMirror.ts`, `src/runtime/reconciliationController.ts` and
	 * `src/sync/diskIndex.ts`:
	 *
	 *   vault.getAbstractFileByPath, vault.read, vault.modify, vault.create,
	 *   vault.createFolder, vault.getMarkdownFiles, vault.adapter.stat,
	 *   vault.configDir, fileManager.trashFile, fileManager.renameFile,
	 *   workspace.getActiveViewOfType, workspace.iterateAllLeaves.
	 */
	readonly app: App;
	readonly editorBindings: EditorBindingManager;
	/**
	 * Every Markdown file in the vault, plus what the walk could not read.
	 *
	 * The second half is not diagnostics. A caller that reads absence as
	 * deletion must subtract the unreadable subtrees first, and only a shape
	 * that carries them can make that possible.
	 */
	scanMarkdown(): Promise<MarkdownScan>;
	/**
	 * Is this one path definitely gone? See `NodeApp.probePath`: only a
	 * kernel-confirmed absence answers `"absent"`.
	 */
	probePath(vaultPath: string): PathProbe;
	watch(onHint: (hint: FsHint) => void): FsWatcher;
	dispose(): Promise<void>;
}

/**
 * Editor bindings for a process with no editors.
 *
 * These are not stubs standing in for something missing — they are the correct
 * answers. Nothing is bound, because nothing can be; no path has editor
 * activity, because there is no editor; a repair of a view that does not exist
 * did not happen, so `repair` reports `false`. Returning anything else would
 * make the external-edit and open-bound-deferral policies defer forever waiting
 * on an editor that will never close.
 */
function createInertEditorBindings(): EditorBindingManager {
	const inert = {
		isBound(_path: string): boolean {
			return false;
		},
		unbindByPath(_path: string): void {
			// Nothing was bound.
		},
		updatePathsAfterRename(_renames: Map<string, string>): void {
			// No bindings hold a path to rewrite.
		},
		getLastEditorActivityForPath(_path: string): number | null {
			return null;
		},
		repair(_view: unknown, _deviceName: string, _reason: string): boolean {
			return false;
		},
		rebind(_view: unknown, _deviceName: string, _reason: string): void {
			// No view to rebind.
		},
		getBindingDebugInfoForView(_view: unknown): null {
			return null;
		},
		getCollabDebugInfoForView(_view: unknown): null {
			return null;
		},
	};
	// See the file header: `EditorBindingManager` is a class with private CM6
	// state, so this cannot be satisfied structurally.
	return inert as unknown as EditorBindingManager;
}

/**
 * Build the Node host for `vaultRoot`.
 *
 * Performs one eager walk so the index — and therefore `cachedStat` — is warm
 * before the engine starts asking questions, and so a vault that does not exist
 * yet is created rather than discovered halfway through the first reconcile.
 */
export async function createNodeHost(vaultRoot: string): Promise<NodeHost> {
	const app = await NodeApp.create(vaultRoot);
	const editorBindings = createInertEditorBindings();
	const watchers = new Set<FsWatcher>();

	app.walkMarkdown();

	return {
		// See the file header for why this cast exists and what it covers.
		app: app as unknown as App,
		editorBindings,

		/**
		 * The same walk `getMarkdownFiles` uses, so the two can never report
		 * different sets. Skips dot-entries, symlinks, and anything past
		 * `MAX_MARKDOWN_FILE_BYTES` — see that constant for why the cap is a
		 * mechanism guard and not the user's size limit.
		 *
		 * `unreadable` is passed through untouched: this layer is not entitled
		 * to decide that a directory it could not read was empty.
		 */
		async scanMarkdown(): Promise<MarkdownScan> {
			const walk: MarkdownWalk = app.walkMarkdown();
			return { paths: walk.files.map((entry) => entry.vaultPath), unreadable: walk.unreadable };
		},

		probePath(vaultPath: string): PathProbe {
			return app.probePath(vaultPath);
		},

		watch(onHint: (hint: FsHint) => void): FsWatcher {
			const watcher = startWatcher(app, onHint);
			const tracked: FsWatcher = {
				async close(): Promise<void> {
					watchers.delete(tracked);
					await watcher.close();
				},
			};
			watchers.add(tracked);
			return tracked;
		},

		async dispose(): Promise<void> {
			await Promise.all([...watchers].map(async (watcher) => watcher.close()));
			watchers.clear();
			app.index.clear();
		},
	};
}
