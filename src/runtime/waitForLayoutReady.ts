/**
 * Waits for Obsidian's workspace layout to finish restoring before letting
 * startup reconciliation run.
 *
 * WHY THIS EXISTS (issue #77)
 *
 * On plugin load, `Workspace.layoutReady` is false until Obsidian has
 * finished restoring the previous session's open panes/tabs. Startup
 * reconciliation used to run immediately after IndexedDB/provider sync,
 * without waiting for this. If the user had a note open and typing in it at
 * the moment Obsidian relaunched, `isOpenOrBound` (main.ts /
 * reconciliationController.ts, via `iterateAllLeaves` and
 * `EditorBindingManager.isBound`) returned false — no MarkdownView leaf for
 * that path existed yet — so the closed-file planner treated a genuinely
 * open, actively-edited note as closed.
 *
 * For a freshly created note there is also no baseline hash yet
 * (`decideClosedFileConflict`'s missing-baseline branch), so without mtime
 * evidence the conservative distributed default (CRDT wins) fired: the
 * disk content the user was actively typing got dumped into a
 * "(YAOS conflict - disk from ...)" artifact instead of being recognized as
 * live, in-progress content on this device.
 *
 * `AttachmentOrchestrator` already solved the identical race for the
 * attachment download gate (see `attachmentOrchestrator.ts`'s
 * `downloadGateLayoutReady` field). This helper generalizes the same
 * `workspace.onLayoutReady` check into a small awaitable so
 * `main.ts` can gate the FIRST startup reconciliation on it too, without
 * delaying reconnect/live reconciliation (which is safe to run at any time
 * because editor bindings are already live by then).
 */

export interface WorkspaceLayoutReadyLike {
	layoutReady: boolean;
	onLayoutReady(callback: () => void): void;
}

export function waitForWorkspaceLayoutReady(workspace: WorkspaceLayoutReadyLike): Promise<void> {
	if (workspace.layoutReady) return Promise.resolve();
	return new Promise<void>((resolve) => {
		workspace.onLayoutReady(() => resolve());
	});
}
