import { Notice, normalizePath, type App, TFile } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import type { VaultSync } from "../sync/vaultSync";
import type { ReconciliationController } from "../runtime/reconciliationController";
import type { EditorWorkspaceOrchestrator } from "../runtime/editorWorkspaceOrchestrator";
import type { DiagnosticsService } from "../diagnostics/diagnosticsService";
import type { BlobSyncManager } from "../sync/blobSync";
import type { TraceHttpContext } from "../debug/trace";

export interface VfsTortureTestContext {
	app: App;
	vaultSync: VaultSync;
	settings: VaultSyncSettings;
	reconciliationController: ReconciliationController;
	editorWorkspace: EditorWorkspaceOrchestrator | null;
	diagnosticsService: DiagnosticsService | null;
	getBlobSync: () => BlobSyncManager | null;
	getTraceHttpContext: () => TraceHttpContext | undefined;
	eventRing: Array<{ ts: string; msg: string }>;
	log: (msg: string) => void;
}

export const runVfsTortureTest = async (context: VfsTortureTestContext): Promise<void> => {
	const startedAt = Date.now();
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
	const rootDir = normalizePath(`YAOS QA/vfs-torture-${runId}`);
	const steps: Array<{
		name: string;
		status: "ok" | "error" | "skipped";
		timestamp: string;
		durationMs: number;
		detail: string;
	}> = [];

	const ensureFolder = async (folderPath: string): Promise<void> => {
		const normalized = normalizePath(folderPath);
		if (!normalized) return;
		const segments = normalized.split("/").filter(Boolean);
		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!context.app.vault.getAbstractFileByPath(current)) {
				await context.app.vault.createFolder(current);
			}
		}
	};

	const runStep = async (
		name: string,
		fn: () => Promise<string | void>,
	): Promise<void> => {
		const stepStartedAt = Date.now();
		try {
			const detail = (await fn()) ?? "";
			steps.push({
				name,
				status: "ok",
				timestamp: new Date().toISOString(),
				durationMs: Date.now() - stepStartedAt,
				detail,
			});
		} catch (err) {
			const detail = err instanceof Error ? err.stack ?? err.message : String(err);
			steps.push({
				name,
				status: "error",
				timestamp: new Date().toISOString(),
				durationMs: Date.now() - stepStartedAt,
				detail,
			});
			context.log(`VFS torture step failed [${name}]: ${detail}`);
		}
	};

	new Notice("Running filesystem torture test...");
	context.log(`VFS torture: starting run ${runId} in "${rootDir}"`);

	await runStep("Create sandbox folder structure", async () => {
		await ensureFolder(rootDir);
		await ensureFolder(`${rootDir}/rename-source/nested`);
		return `Created sandbox at ${rootDir}`;
	});

	await runStep("Burst edit markdown file", async () => {
		const burstPath = normalizePath(`${rootDir}/burst.md`);
		const burstFile = await context.app.vault.create(
			burstPath,
			"# YAOS burst test\n\nStart of burst edits.",
		);
		for (let i = 1; i <= 10; i++) {
			const current = await context.app.vault.read(burstFile);
			await context.app.vault.modify(
				burstFile,
				`${current}\n- burst edit ${i} @ ${new Date().toISOString()}`,
			);
		}
		return `Applied 10 rapid app-level writes to ${burstPath}`;
	});

	await runStep("Rapid create/rename/edit sequence", async () => {
		const untitledPath = normalizePath(`${rootDir}/Untitled.md`);
		const renamedPath = normalizePath(`${rootDir}/Meeting Notes.md`);
		const untitledFile = await context.app.vault.create(
			untitledPath,
			"# Quick rename flow\n\nseed",
		);
		await context.app.vault.modify(untitledFile, "# Quick rename flow\n\nseed\nline 1");
		await context.app.fileManager.renameFile(untitledFile, renamedPath);
		const renamedFile = context.app.vault.getAbstractFileByPath(renamedPath);
		if (!(renamedFile instanceof TFile)) {
			throw new Error(`Expected renamed file at "${renamedPath}"`);
		}
		const current = await context.app.vault.read(renamedFile);
		await context.app.vault.modify(renamedFile, `${current}\nline 2`);
		return `Renamed ${untitledPath} -> ${renamedPath} and appended a post-rename edit`;
	});

	await runStep("Folder rename cascade with post-rename edit", async () => {
		const sourceFolder = normalizePath(`${rootDir}/rename-source`);
		const destinationFolder = normalizePath(`${rootDir}/rename-destination`);
		const targetPath = normalizePath(`${sourceFolder}/nested/target.md`);
		await context.app.vault.create(targetPath, "# Rename target\n\nbefore rename");

		const sourceNode = context.app.vault.getAbstractFileByPath(sourceFolder);
		if (!sourceNode) {
			throw new Error(`Folder missing: ${sourceFolder}`);
		}
		await context.app.fileManager.renameFile(sourceNode, destinationFolder);

		const movedTargetPath = normalizePath(`${destinationFolder}/nested/target.md`);
		const movedTarget = context.app.vault.getAbstractFileByPath(movedTargetPath);
		if (!(movedTarget instanceof TFile)) {
			throw new Error(`Renamed target missing: ${movedTargetPath}`);
		}
		const current = await context.app.vault.read(movedTarget);
		await context.app.vault.modify(movedTarget, `${current}\npost-rename line`);
		return `Renamed folder ${sourceFolder} -> ${destinationFolder}`;
	});

	await runStep("Delete and recreate same path", async () => {
		const tombstonePath = normalizePath(`${rootDir}/tombstone.md`);
		const file = await context.app.vault.create(
			tombstonePath,
			"# Tombstone test\n\noriginal content",
		);
		await context.app.fileManager.trashFile(file);
		await context.app.vault.create(
			tombstonePath,
			"# Tombstone test\n\nrecreated content",
		);
		return `Deleted and recreated ${tombstonePath}`;
	});

	await runStep("Create 3 MB binary attachment", async () => {
		const blobPath = normalizePath(`${rootDir}/attachment-3mb.bin`);
		const bytes = new Uint8Array(3 * 1024 * 1024);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = i % 251;
		}
		await context.app.vault.createBinary(blobPath, bytes.buffer);
		if (!context.settings.enableAttachmentSync) {
			return `Created ${blobPath} (${bytes.length} bytes). Attachment sync is disabled in settings.`;
		}
		return `Created ${blobPath} (${bytes.length} bytes) for attachment sync path`;
	});

	const failures = steps.filter((step) => step.status === "error");
	const report = {
		generatedAt: new Date().toISOString(),
		durationMs: Date.now() - startedAt,
		runId,
		rootDir,
		trace: context.getTraceHttpContext() ?? null,
		settings: {
			host: context.settings.host,
			vaultId: context.settings.vaultId,
			deviceName: context.settings.deviceName,
			enableAttachmentSync: context.settings.enableAttachmentSync,
			externalEditPolicy: context.settings.externalEditPolicy,
			debug: context.settings.debug,
		},
		syncState: {
			connected: context.vaultSync.connected,
			providerSynced: context.vaultSync.providerSynced,
			localReady: context.vaultSync.localReady,
			connectionGeneration: context.vaultSync.connectionGeneration,
			reconciled: context.reconciliationController.getState().reconciled,
			openFileCount: context.editorWorkspace?.openFileCount ?? 0,
			pathToIdCount: context.vaultSync.pathToId.size,
			activePathCount: context.vaultSync.getActiveMarkdownPaths().length,
			pathToBlobCount: context.vaultSync.pathToBlob.size,
			pendingUploads: context.getBlobSync()?.pendingUploads ?? 0,
			pendingDownloads: context.getBlobSync()?.pendingDownloads ?? 0,
		},
		steps,
		recentEvents: {
			plugin: context.eventRing.slice(-120),
			sync: context.vaultSync.getRecentEvents(120),
		},
	};

	const diagDir = await context.diagnosticsService?.ensureDiagnosticsDir()
		?? normalizePath(`${context.app.vault.configDir}/plugins/yaos/diagnostics`);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outPath = normalizePath(
		`${diagDir}/vfs-torture-${stamp}-${context.settings.deviceName || "device"}.json`,
	);
	await context.app.vault.adapter.write(outPath, JSON.stringify(report, null, 2));

	if (failures.length > 0) {
		new Notice(
			`YAOS VFS torture run finished with ${failures.length} failed step(s). Report: ${outPath}`,
			12000,
		);
		context.log(
			`VFS torture: completed with ${failures.length} failures. Report=${outPath}`,
		);
		return;
	}

	new Notice(`YAOS VFS torture run completed. Report: ${outPath}`, 10000);
	context.log(`VFS torture: completed successfully. Report=${outPath}`);
};
