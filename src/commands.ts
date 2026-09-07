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
	applySettingsSync(): Promise<void>;
	replaceSettingsSyncEnvironment(): Promise<void>;
	seedSettingsSyncFromThisDevice(): Promise<void>;
	takeSettingsSyncSeed(): Promise<void>;
	deferSettingsSyncSeed(): Promise<void>;
	isSettingsSyncDebugEnabled(): boolean;
	runSettingsSyncInstallSmoke(): Promise<void>;
	runSettingsSyncCommand(action: "apply" | "replace" | "seed" | "take" | "defer"): Promise<void>;
	canManageRecovery?(): boolean;
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
		checkCallback: (checking) => {
			if (host.canManageRecovery?.() === false) return false;
			if (!checking) void host.getSnapshotService()?.takeSnapshotNow();
			return true;
		},
	});

	registrar.addCommand({
		id: "recovery-status",
		name: "Show recovery readiness and job status",
		checkCallback: (checking) => {
			if (host.canManageRecovery?.() === false) return false;
			if (!checking) void host.getSnapshotService()?.showRecoveryStatus();
			return true;
		},
	});

	registrar.addCommand({
		id: "snapshot-list",
		name: "Browse and restore snapshots",
		checkCallback: (checking) => {
			if (host.canManageRecovery?.() === false) return false;
			if (!checking) void host.getSnapshotService()?.showSnapshotList();
			return true;
		},
	});

	registrar.addCommand({
		id: "snapshot-prune",
		name: "Cleanup old snapshots (apply retention policy)",
		checkCallback: (checking) => {
			if (host.canManageRecovery?.() === false) return false;
			if (!checking) void host.getSnapshotService()?.pruneSnapshots();
			return true;
		},
	});
	registrar.addCommand({
		id: "restart-interrupted-restore",
		name: "Resume interrupted restore",
		checkCallback: (checking) => {
			if (host.canManageRecovery?.() === false) return false;
			if (!checking) void host.restartPendingRestore();
			return true;
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
		id: "settings-sync-apply",
		name: "Settings sync: apply remote environment",
		callback: async () => {
			await host.runSettingsSyncCommand("apply");
		},
	});

	registrar.addCommand({
		id: "settings-sync-replace",
		name: "Settings sync: replace remote environment with this device",
		callback: async () => {
			await host.runSettingsSyncCommand("replace");
		},
	});

	registrar.addCommand({
		id: "settings-sync-seed-this-device",
		name: "Settings sync: seed from this device",
		callback: async () => {
			await host.runSettingsSyncCommand("seed");
		},
	});

	registrar.addCommand({
		id: "settings-sync-take-seed",
		name: "Settings sync: take the remote seed",
		callback: async () => {
			await host.runSettingsSyncCommand("take");
		},
	});

	registrar.addCommand({
		id: "settings-sync-decide-later",
		name: "Settings sync: decide initial seed later",
		callback: async () => {
			await host.runSettingsSyncCommand("defer");
		},
	});

	registrar.addCommand({
		id: "settings-sync-debug-install-calendar",
		name: "Settings sync debug: install calendar via Obsidian",
		checkCallback: (checking) => {
			if (!host.isSettingsSyncDebugEnabled()) return false;
			if (!checking) void host.runSettingsSyncInstallSmoke();
			return true;
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
