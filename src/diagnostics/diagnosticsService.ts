import { App, Notice, normalizePath } from "obsidian";
import { BlobSyncManager } from "../sync/blobSync";
import { DiskMirror } from "../sync/diskMirror";
import { VaultSync, type ReconcileMode } from "../sync/vaultSync";
import type { TraceHttpContext } from "../debug/trace";
import type { VaultSyncSettings } from "../settings";
import {
	buildFrontmatterQuarantineDebugLines,
	type FrontmatterQuarantineEntry,
} from "../sync/frontmatterQuarantine";

type EventEntry = { ts: string; msg: string };

type LastReconcileStats = {
	at: string;
	mode: ReconcileMode;
	plannedCreates: number;
	plannedUpdates: number;
	flushedCreates: number;
	flushedUpdates: number;
	safetyBrakeTriggered: boolean;
	safetyBrakeReason: string | null;
};

interface DiagnosticsServiceDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getVaultSync(): VaultSync | null;
	getDiskMirror(): DiskMirror | null;
	getBlobSync(): BlobSyncManager | null;
	getEventRing(): EventEntry[];
	getRecentServerTrace(): unknown[];
	getFrontmatterQuarantineEntries(): FrontmatterQuarantineEntry[];
	getState(): {
		reconciled: boolean;
		reconcileInFlight: boolean;
		reconcilePending: boolean;
		lastReconcileStats: LastReconcileStats | null;
		awaitingFirstProviderSyncAfterStartup: boolean;
		lastReconciledGeneration: number;
		untrackedFileCount: number;
		openFileCount: number;
	};
	isMarkdownPathSyncable(path: string): boolean;
	collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>>;
	sha256Hex(text: string): Promise<string>;
	log(message: string): void;
}

export class DiagnosticsService {
	constructor(private readonly deps: DiagnosticsServiceDeps) {}

	buildDebugInfo(): string {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return "Sync not initialized";
		const settings = this.deps.getSettings();
		const state = this.deps.getState();
		const blobSync = this.deps.getBlobSync();
		const trace = this.deps.getTraceHttpContext();

		return [
			`Host: ${settings.host || "(not set)"}`,
			`Vault ID: ${settings.vaultId || "(not set)"}`,
			`Device: ${settings.deviceName || "(unnamed)"}`,
			`Trace ID: ${trace?.traceId ?? "(disabled)"}`,
			`Boot ID: ${trace?.bootId ?? "(disabled)"}`,
			`Connected: ${vaultSync.connected}`,
			`Local ready: ${vaultSync.localReady}`,
			`Provider synced: ${vaultSync.providerSynced}`,
			`Initialized (sentinel): ${vaultSync.isInitialized}`,
			`Reconcile mode: ${vaultSync.getSafeReconcileMode()}`,
			`Reconciled: ${state.reconciled}`,
			`Connection generation: ${vaultSync.connectionGeneration}`,
			`Last reconciled gen: ${state.lastReconciledGeneration}`,
			`Fatal auth error: ${vaultSync.fatalAuthError}`,
			`Fatal auth code: ${vaultSync.fatalAuthCode ?? "(none)"}`,
			`IndexedDB error: ${vaultSync.idbError}`,
			`IndexedDB error kind: ${vaultSync.idbErrorDetails?.kind ?? "(none)"}`,
			`IndexedDB error phase: ${vaultSync.idbErrorDetails?.phase ?? "(none)"}`,
			`IndexedDB error name: ${vaultSync.idbErrorDetails?.name ?? "(none)"}`,
			`IndexedDB error message: ${vaultSync.idbErrorDetails?.message ?? "(none)"}`,
			`Schema supported/local: ${vaultSync.supportedSchemaVersion}/${vaultSync.storedSchemaVersion ?? "(unset)"}`,
			`CRDT paths: ${vaultSync.getActiveMarkdownPaths().length}`,
			`Blob paths: ${vaultSync.pathToBlob.size}`,
			`Untracked files: ${state.untrackedFileCount}`,
			`Active disk observers: ${this.deps.getDiskMirror()?.activeObserverCount ?? 0}`,
			`External edit policy: ${settings.externalEditPolicy}`,
			`Attachment sync: ${settings.enableAttachmentSync ? "enabled" : "disabled"}`,
			...(blobSync ? [
				`Pending uploads: ${blobSync.pendingUploads}`,
				`Pending downloads: ${blobSync.pendingDownloads}`,
			] : []),
			`Open files: ${state.openFileCount}`,
			`Server trace events: ${this.deps.getRecentServerTrace().length}`,
			`Remote cursors: ${settings.showRemoteCursors ? "shown" : "hidden"}`,
			...buildFrontmatterQuarantineDebugLines(this.deps.getFrontmatterQuarantineEntries()),
		].join("\n");
	}

	buildRecentEventsText(limit = 80): string {
		const mainEvents = this.deps.getEventRing().slice(-limit).map((e) => `[plugin] ${e.ts} ${e.msg}`);
		const syncEvents = this.deps.getVaultSync()?.getRecentEvents(limit).map((e) => `[sync]   ${e.ts} ${e.msg}`) ?? [];
		const serverEvents = this.deps.getRecentServerTrace()
			.slice(-limit)
			.map((e) => {
				const entry = e as { ts?: string; event?: string; deviceName?: string; traceId?: string };
				return `[server] ${entry.ts ?? ""} ${entry.event ?? "event"}${entry.deviceName ? ` device=${entry.deviceName}` : ""}${entry.traceId ? ` trace=${entry.traceId}` : ""}`;
			});
		const merged = [...mainEvents, ...syncEvents, ...serverEvents].sort();
		if (merged.length === 0) return "No events recorded yet.";
		return merged.slice(-limit).join("\n");
	}

	async exportDiagnostics(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		new Notice("Exporting sync diagnostics...");
		const startedAt = Date.now();
		const settings = this.deps.getSettings();
		const state = this.deps.getState();

		const diskFiles = this.deps.app.vault.getMarkdownFiles()
			.filter((f) => this.deps.isMarkdownPathSyncable(f.path));

		const crdtPaths = new Set<string>(
			vaultSync.getActiveMarkdownPaths().filter((path) =>
				this.deps.isMarkdownPathSyncable(path),
			),
		);

		const diskHashes = new Map<string, { hash: string; length: number }>();
		for (const file of diskFiles) {
			try {
				const content = await this.deps.app.vault.read(file);
				diskHashes.set(file.path, {
					hash: await this.deps.sha256Hex(content),
					length: content.length,
				});
			} catch (err) {
				this.deps.log(`diagnostics: failed to read disk file "${file.path}": ${String(err)}`);
			}
		}

		const crdtHashes = new Map<string, { hash: string; length: number }>();
		for (const path of crdtPaths) {
			const ytext = vaultSync.getTextForPath(path);
			if (!ytext) continue;
			const content = ytext.toJSON();
			crdtHashes.set(path, {
				hash: await this.deps.sha256Hex(content),
				length: content.length,
			});
		}

		const allPaths = new Set<string>([
			...Array.from(diskHashes.keys()),
			...Array.from(crdtHashes.keys()),
		]);

		const missingOnDisk: string[] = [];
		const missingInCrdt: string[] = [];
		const hashMismatches: Array<{ path: string; diskHash: string; crdtHash: string; diskLength: number; crdtLength: number }> = [];

		for (const path of allPaths) {
			const disk = diskHashes.get(path);
			const crdt = crdtHashes.get(path);
			if (!disk && crdt) {
				missingOnDisk.push(path);
				continue;
			}
			if (disk && !crdt) {
				missingInCrdt.push(path);
				continue;
			}
			if (disk && crdt && disk.hash !== crdt.hash) {
				hashMismatches.push({
					path,
					diskHash: disk.hash,
					crdtHash: crdt.hash,
					diskLength: disk.length,
					crdtLength: crdt.length,
				});
			}
		}

		const diagnostics = {
			generatedAt: new Date().toISOString(),
			generationMs: Date.now() - startedAt,
			trace: this.deps.getTraceHttpContext() ?? null,
			settings: {
				host: settings.host,
				tokenPrefix: settings.token ? `${settings.token.slice(0, 8)}...` : "",
				vaultId: settings.vaultId,
				deviceName: settings.deviceName,
				debug: settings.debug,
				enableAttachmentSync: settings.enableAttachmentSync,
				externalEditPolicy: settings.externalEditPolicy,
			},
			state: {
				reconciled: state.reconciled,
				reconcileInFlight: state.reconcileInFlight,
				reconcilePending: state.reconcilePending,
				lastReconcile: state.lastReconcileStats,
				awaitingFirstProviderSyncAfterStartup: state.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: state.lastReconciledGeneration,
				connected: vaultSync.connected,
				providerSynced: vaultSync.providerSynced,
				localReady: vaultSync.localReady,
				connectionGeneration: vaultSync.connectionGeneration,
				fatalAuthError: vaultSync.fatalAuthError,
				fatalAuthCode: vaultSync.fatalAuthCode,
				fatalAuthDetails: vaultSync.fatalAuthDetails,
				idbError: vaultSync.idbError,
				idbErrorDetails: vaultSync.idbErrorDetails,
				pathToIdCount: vaultSync.pathToId.size,
				activePathCount: vaultSync.getActiveMarkdownPaths().length,
				blobPathCount: vaultSync.pathToBlob.size,
				diskFileCount: diskFiles.length,
				openFileCount: state.openFileCount,
				schema: {
					supportedByClient: vaultSync.supportedSchemaVersion,
					storedInDoc: vaultSync.storedSchemaVersion,
				},
			},
			hashDiff: {
				missingOnDisk,
				missingInCrdt,
				hashMismatches,
				matchingCount: allPaths.size - missingOnDisk.length - missingInCrdt.length - hashMismatches.length,
				totalCompared: allPaths.size,
			},
			recentEvents: {
				plugin: this.deps.getEventRing().slice(-240),
				sync: vaultSync.getRecentEvents(240),
			},
			openFiles: await this.deps.collectOpenFileTraceState(),
			diskMirror: this.deps.getDiskMirror()?.getDebugSnapshot() ?? null,
			blobSync: this.deps.getBlobSync()?.getDebugSnapshot() ?? null,
			serverTrace: this.deps.getRecentServerTrace(),
		};

		const diagDir = await this.ensureDiagnosticsDir();

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const fileName = `sync-diagnostics-${stamp}-${settings.deviceName || "device"}.json`;
		const outPath = normalizePath(`${diagDir}/${fileName}`);
		await this.deps.app.vault.adapter.write(outPath, JSON.stringify(diagnostics, null, 2));

		this.deps.log(
			`Diagnostics exported: ${outPath} ` +
			`(missingOnDisk=${missingOnDisk.length}, missingInCrdt=${missingInCrdt.length}, mismatches=${hashMismatches.length})`,
		);
		new Notice(`Sync diagnostics exported to ${outPath}`, 10000);
	}

	async ensureDiagnosticsDir(): Promise<string> {
		const diagDir = normalizePath(`${this.deps.app.vault.configDir}/plugins/yaos/diagnostics`);
		if (!(await this.deps.app.vault.adapter.exists(diagDir))) {
			await this.deps.app.vault.adapter.mkdir(diagDir);
		}
		return diagDir;
	}
}
