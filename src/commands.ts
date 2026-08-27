import { Notice, type Plugin } from "obsidian";
import type { ConnectionController } from "./runtime/connectionController";
import type { SnapshotService } from "./snapshots/snapshotService";
import type { ReconcileMode, VaultSync } from "./sync/vaultSync";

export interface CommandsRuntimeHost {
	getVaultSync(): VaultSync | null;
	getConnectionController(): ConnectionController | null;
	getSnapshotService(): SnapshotService | null;
	getUntrackedFileCount(): number;
	runReconciliation(mode: ReconcileMode): Promise<void>;
	importUntrackedFiles(): Promise<void>;
	resetLocalCache(): void;
	nuclearReset(): void;
	exportVault(): Promise<void>;
	restartPendingRestore(): Promise<void>;
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
		id: "recovery-status",
		name: "Show recovery readiness and job status",
		callback: async () => {
			await host.getSnapshotService()?.showRecoveryStatus();
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
		id: "snapshot-prune",
		name: "Cleanup old snapshots (apply retention policy)",
		callback: async () => {
			await host.getSnapshotService()?.pruneSnapshots();
		},
	});
	registrar.addCommand({
		id: "restart-interrupted-restore",
		name: "Resume interrupted restore",
		callback: async () => {
			await host.restartPendingRestore();
		},
	});

	registrar.addCommand({
		id: "export-portable-vault",
		name: "Export portable vault backup",
		callback: async () => {
			await host.exportVault();
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
