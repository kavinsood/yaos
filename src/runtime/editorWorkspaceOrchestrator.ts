import { type App, MarkdownView, type WorkspaceLeaf } from "obsidian";
import type { EditorBindingManager } from "../sync/editorBinding";
import type { DiskMirror } from "../sync/diskMirror";
import type { VaultSyncSettings } from "../settings";

interface EditorWorkspaceOrchestratorDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getEditorBindings(): EditorBindingManager | null;
	getDiskMirror(): DiskMirror | null;
	maybeImportDeferredClosedOnlyPath(path: string, reason: string): void;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
}

export class EditorWorkspaceOrchestrator {
	private openFilePaths = new Set<string>();
	private activeMarkdownPath: string | null = null;

	constructor(private readonly deps: EditorWorkspaceOrchestratorDeps) {}

	get openFileCount(): number {
		return this.openFilePaths.size;
	}

	reset(): void {
		this.openFilePaths.clear();
		this.activeMarkdownPath = null;
	}

	onReconciled(reason: string): void {
		this.reconcileOpenEditors();
		this.validateOpenBindings(reason);
	}

	onLayoutChange(): void {
		this.deps.getEditorBindings()?.clearLocalCursor("layout-change");
		this.reconcileTrackedOpenFiles("layout-change");
		this.updateActiveMarkdownPath(
			this.getActiveMarkdownPath(),
			"layout-change-active-blur",
		);
		const touched = this.auditBindings("layout-change");
		if (touched > 0) {
			this.deps.log(`Binding health audit (layout-change) — touched ${touched}`);
			this.deps.scheduleTraceStateSnapshot("binding-audit:layout-change");
		}
	}

	onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
		const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
		const nextPath = view?.file?.path ?? null;
		this.updateActiveMarkdownPath(nextPath, "active-leaf-change");
		this.reconcileTrackedOpenFiles("active-leaf-change");
		if (view) {
			this.bindView(view);
		}
	}

	onFileOpen(filePath: string | null): void {
		this.updateActiveMarkdownPath(filePath, "file-open-active-change");
		if (!filePath) return;
		const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file?.path === filePath) {
			this.bindView(view);
		}
	}

	onMarkdownDeleted(path: string): void {
		this.deps.getEditorBindings()?.unbindByPath(path);
		this.deps.getDiskMirror()?.notifyFileClosed(path);
		this.openFilePaths.delete(path);
	}

	onRenameBatchFlushed(renames: Map<string, string>): void {
		this.deps.getEditorBindings()?.updatePathsAfterRename(renames);
		for (const [oldPath, newPath] of renames) {
			if (this.activeMarkdownPath === oldPath) {
				this.activeMarkdownPath = newPath;
			}
			if (this.openFilePaths.has(oldPath)) {
				this.deps.getDiskMirror()?.notifyFileClosed(oldPath);
				this.openFilePaths.delete(oldPath);
				this.deps.getDiskMirror()?.notifyFileOpened(newPath);
				this.openFilePaths.add(newPath);
				this.deps.log(`Rename batch: moved observer "${oldPath}" -> "${newPath}"`);
			}
		}
	}

	validateOpenBindings(reason: string): void {
		let touched = 0;
		const editorBindings = this.deps.getEditorBindings();
		if (!editorBindings) return;

		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) {
				return;
			}

			const binding = editorBindings.getBindingDebugInfoForView(leaf.view) ?? null;
			const health = editorBindings.getBindingHealthForView(leaf.view) ?? null;

			if (health?.bound && (health.healthy || health.settling)) {
				return;
			}

			touched += 1;
			if (!binding || !health?.bound) {
				editorBindings.bind(leaf.view, this.deps.getSettings().deviceName);
				return;
			}

			const repaired = editorBindings.repair(
				leaf.view,
				this.deps.getSettings().deviceName,
				`validate:${reason}`,
			);
			if (!repaired) {
				editorBindings.rebind(
					leaf.view,
					this.deps.getSettings().deviceName,
					`validate:${reason}`,
				);
			}
		});

		if (touched > 0) {
			this.deps.log(`Validated open bindings (${reason}) — touched ${touched}`);
			this.deps.scheduleTraceStateSnapshot(`validate-open-bindings:${reason}`);
		}
	}

	auditBindings(reason: string): number {
		const touched = this.deps.getEditorBindings()?.auditBindings(reason) ?? 0;
		if (touched > 0) {
			this.deps.scheduleTraceStateSnapshot(`binding-audit:${reason}`);
		}
		return touched;
	}

	private reconcileOpenEditors(): void {
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.bindView(leaf.view);
			}
		});
		this.activeMarkdownPath = this.getActiveMarkdownPath();
	}

	private bindView(view: MarkdownView): void {
		this.deps.getEditorBindings()?.bind(view, this.deps.getSettings().deviceName);
		if (view.file) {
			this.trackOpenFile(view.file.path);
		}
	}

	private trackOpenFile(path: string): void {
		if (!this.openFilePaths.has(path)) {
			this.deps.getDiskMirror()?.notifyFileOpened(path);
			this.openFilePaths.add(path);
		}

		this.reconcileTrackedOpenFiles("track-open-file");
		this.deps.scheduleTraceStateSnapshot("track-open-file");
	}

	private reconcileTrackedOpenFiles(reason: string): void {
		const currentlyOpen = new Set<string>();
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				currentlyOpen.add(leaf.view.file.path);
			}
		});

		for (const tracked of this.openFilePaths) {
			if (!currentlyOpen.has(tracked)) {
				this.deps.getDiskMirror()?.notifyFileClosed(tracked);
				this.openFilePaths.delete(tracked);
				this.deps.log(`${reason}: closed observer for "${tracked}"`);
				this.deps.maybeImportDeferredClosedOnlyPath(tracked, reason);
			}
		}
	}

	private getActiveMarkdownPath(): string | null {
		const activeView = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path ?? null;
	}

	private updateActiveMarkdownPath(nextPath: string | null, reason: string): void {
		const previousPath = this.activeMarkdownPath;
		this.activeMarkdownPath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		this.deps.getEditorBindings()?.clearLocalCursor(reason);
		void this.deps.getDiskMirror()?.flushOpenPath(previousPath, reason);
	}
}
