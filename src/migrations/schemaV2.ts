import { Notice, type App, TFile } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import type { VaultSync } from "../sync/vaultSync";
import type { DiagnosticsService } from "../diagnostics/diagnosticsService";
import { ConfirmModal } from "../ui/ConfirmModal";

export interface SchemaV2MigrationContext {
	app: App;
	vaultSync: VaultSync;
	settings: VaultSyncSettings;
	diagnosticsService: DiagnosticsService | null;
	log: (msg: string) => void;
	runReconciliation: () => Promise<void>;
}

const cleanupMigrationLoserPaths = async (
	app: App,
	log: (msg: string) => void,
	paths: string[],
): Promise<number> => {
	if (paths.length === 0) return 0;
	let removed = 0;
	for (const path of paths) {
		const node = app.vault.getAbstractFileByPath(path);
		if (!(node instanceof TFile)) continue;
		try {
			await app.fileManager.trashFile(node);
			removed++;
		} catch (err) {
			log(`schema migration: failed to remove loser path "${path}": ${String(err)}`);
		}
	}
	return removed;
};

export const runSchemaMigrationToV2 = (context: SchemaV2MigrationContext): void => {
	const vaultSync = context.vaultSync as VaultSync | null;
	if (!vaultSync) {
		new Notice("Sync not initialized.");
		return;
	}

	const fromVersion = vaultSync.storedSchemaVersion;
	if (fromVersion !== null && fromVersion >= 2) {
		new Notice("This vault is already on schema v2.");
		return;
	}

	new ConfirmModal(
		context.app,
		"Migrate sync schema to v2",
		"This will switch this vault to schema v2 and block older YAOS clients from syncing " +
			"until they are upgraded. YAOS will export diagnostics before and after migration. Continue?",
		async () => {
			const activeVaultSync = context.vaultSync as VaultSync | null;
			if (!activeVaultSync) return;

			try {
				new Notice("Exporting pre-migration diagnostics...", 7000);
				await context.diagnosticsService?.exportDiagnostics();
			} catch (err) {
				context.log(`schema migration: preflight diagnostics export failed: ${String(err)}`);
			}

			const result = activeVaultSync.migrateSchemaToV2(context.settings.deviceName);
			context.log(
				`schema migration result: ${JSON.stringify(result)}`,
			);
			const loserCleanupCount = await cleanupMigrationLoserPaths(
				context.app,
				context.log,
				result.loserPaths,
			);
			if (loserCleanupCount > 0) {
				context.log(`schema migration: removed ${loserCleanupCount} loser-path file(s) from disk`);
			}

			await context.runReconciliation();

			try {
				new Notice("Exporting post-migration diagnostics...", 7000);
				await context.diagnosticsService?.exportDiagnostics();
			} catch (err) {
				context.log(`schema migration: postflight diagnostics export failed: ${String(err)}`);
			}

			new Notice(
				`YAOS: schema v2 migration complete` +
					(loserCleanupCount > 0 ? ` (${loserCleanupCount} local alias file(s) cleaned).` : ".") +
					" Update YAOS on your other devices before reconnecting them.",
				12000,
			);
		},
	).open();
};
