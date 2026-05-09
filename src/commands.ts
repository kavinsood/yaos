import { Notice, type Plugin } from "obsidian";
import type { DiagnosticsService } from "./diagnostics/diagnosticsService";
import type { ConnectionController } from "./runtime/connectionController";
import type { SnapshotService } from "./snapshots/snapshotService";
import type { ReconcileMode, VaultSync } from "./sync/vaultSync";

export interface CommandsRuntimeHost {
	getVaultSync(): VaultSync | null;
	getConnectionController(): ConnectionController | null;
	getDiagnosticsService(): DiagnosticsService | null;
	getSnapshotService(): SnapshotService | null;
	getUntrackedFileCount(): number;
	isDebugEnabled(): boolean;
	runReconciliation(mode: ReconcileMode): Promise<void>;
	runSchemaMigrationToV2(): void;
	runVfsTortureTest(): Promise<void>;
	importUntrackedFiles(): Promise<void>;
	resetLocalCache(): void;
	nuclearReset(): void;
}

export function registerCommands(
	registrar: Pick<Plugin, "addCommand">,
	host: CommandsRuntimeHost,
): void {
	registrar.addCommand({
		id: "reconnect",
		name: "Reconnect to sync server",
		callback: () => {
			if (host.getVaultSync()) {
				host.getConnectionController()?.reconnect("manual-command");
				new Notice("Reconnecting...");
			}
		},
	});

	registrar.addCommand({
		id: "force-reconcile",
		name: "Force reconcile vault with sync state",
		callback: () => {
			const vaultSync = host.getVaultSync();
			if (!vaultSync) return;
			const mode = vaultSync.getSafeReconcileMode();
			void host.runReconciliation(mode);
		},
	});

	registrar.addCommand({
		id: "debug-status",
		name: "Show sync debug info",
		callback: () => {
			const info = host.getDiagnosticsService()?.buildDebugInfo() ?? "Sync not initialized";
			new Notice(info, 10000);
			console.debug("[yaos] Debug status:\n" + info);
		},
	});

	registrar.addCommand({
		id: "copy-debug",
		name: "Copy debug info to clipboard",
		callback: () => {
			const info = host.getDiagnosticsService()?.buildDebugInfo() ?? "Sync not initialized";
			navigator.clipboard.writeText(info).then(
				() => new Notice("Debug info copied to clipboard."),
				() => new Notice("Failed to copy to clipboard. Check console.", 5000),
			);
			console.debug("[yaos] Debug info:\n" + info);
		},
	});

	registrar.addCommand({
		id: "show-recent-events",
		name: "Show recent sync events",
		callback: () => {
			const text = host.getDiagnosticsService()?.buildRecentEventsText(80) ?? "No events recorded yet.";
			new Notice("Recent sync events printed to console.", 5000);
			console.debug("[yaos] Recent sync events:\n" + text);
		},
	});

	registrar.addCommand({
		id: "export-diagnostics",
		name: "Export sync diagnostics",
		callback: () => {
			void host.getDiagnosticsService()?.exportDiagnostics();
		},
	});

	registrar.addCommand({
		id: "migrate-schema-v2",
		name: "Migrate sync schema to v2",
		callback: () => {
			host.runSchemaMigrationToV2();
		},
	});

	registrar.addCommand({
		id: "debug-vfs-torture-test",
		name: "Run filesystem torture test (debug)",
		checkCallback: (checking: boolean) => {
			if (!host.isDebugEnabled()) return false;
			if (!checking) {
				void host.runVfsTortureTest();
			}
			return true;
		},
	});

	registrar.addCommand({
		id: "import-untracked",
		name: "Import untracked files now",
		callback: () => {
			if (!host.getVaultSync()) {
				new Notice("Sync not initialized");
				return;
			}
			const count = host.getUntrackedFileCount();
			if (count === 0) {
				new Notice("No untracked files to import.");
				return;
			}
			void host.importUntrackedFiles().then(() => {
				new Notice(`Imported ${count} untracked file(s).`);
			});
		},
	});

	registrar.addCommand({
		id: "reset-cache",
		name: "Reset local cache (re-sync from server)",
		callback: () => {
			host.resetLocalCache();
		},
	});

	registrar.addCommand({
		id: "snapshot-now",
		name: "Take snapshot now",
		callback: async () => {
			await host.getSnapshotService()?.takeSnapshotNow();
		},
	});

	registrar.addCommand({
		id: "snapshot-list",
		name: "Browse and restore snapshots",
		callback: async () => {
			await host.getSnapshotService()?.showSnapshotList();
		},
	});

	registrar.addCommand({
		id: "nuclear-reset",
		name: "Nuclear reset (wipe sync state and reseed from disk)",
		callback: () => {
			host.nuclearReset();
		},
	});
}
