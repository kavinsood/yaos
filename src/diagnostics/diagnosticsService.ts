import { App, Notice, normalizePath } from "obsidian";
import { deriveSyncFacts } from "../runtime/connectionFacts";
import { formatUnknown } from "../utils/format";
import { BlobSyncManager } from "../sync/blobSync";
import { DiskMirror } from "../sync/diskMirror";
import { VaultSync, type ReconcileMode } from "../sync/vaultSync";
import type { TraceHttpContext } from "../debug/trace";
import type { VaultSyncSettings } from "../settings";
import {
	buildFrontmatterQuarantineDebugLines,
	type FrontmatterQuarantineEntry,
} from "../sync/frontmatterQuarantine";
import { ConfirmModal } from "../ui/ConfirmModal";
import { buildDiagnosticsBundle } from "./diagnosticsBundle";
import type { DiagnosticsBundleInput } from "./diagnosticsBundle";

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

function describeServerReceiptStartupValidation(state: string | null): string {
	switch (state) {
		case "validated":
			return "validated";
		case "skipped_local_yjs_timeout":
			return "skipped: local Yjs cache did not finish loading; persisted receipt candidate was not trusted this session";
		case "unavailable":
			return "unavailable";
		case "not_started":
			return "not started";
		default:
			return state ?? "unknown";
	}
}

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

		const facts = deriveSyncFacts(
			{
				connected: vaultSync.connected,
				fatalAuthError: vaultSync.fatalAuthError,
				fatalAuthCode: vaultSync.fatalAuthCode,
				lastLocalUpdateAt: vaultSync.lastLocalUpdateAt,
				lastLocalUpdateWhileConnectedAt: vaultSync.lastLocalUpdateWhileConnectedAt,
				lastRemoteUpdateAt: vaultSync.lastRemoteUpdateAt,
				pendingBlobUploads: blobSync?.pendingUploads ?? 0,
				serverAppliedLocalState: vaultSync.serverAppliedLocalState,
				lastServerReceiptEchoAt: vaultSync.lastServerReceiptEchoAt,
				lastKnownServerReceiptEchoAt: vaultSync.lastKnownServerReceiptEchoAt,
				candidatePersistenceHealthy: vaultSync.candidatePersistenceHealthy,
				candidatePersistenceFailureCount: vaultSync.candidatePersistenceFailureCount,
				hasUnconfirmedServerReceiptCandidate: vaultSync.hasUnconfirmedServerReceiptCandidate,
				serverReceiptCandidateCapturedAt: vaultSync.serverReceiptCandidateCapturedAt,
			},
			vaultSync.connected
				? (state.reconciled ? "online" : "connecting")
				: (vaultSync.fatalAuthError ? "auth_failed" : "offline"),
		);

		function fmtTs(ms: number | null): string {
			if (ms === null) return "(none)";
			return new Date(ms).toISOString();
		}

		// NOTE: buildDebugInfo() is local/sensitive — it includes the server URL,
		// vault ID, and device name. It is NOT safe for sharing. Use
		// exportDiagnostics() (safe mode) for shareable output.
		return [
			`[local debug — includes server URL and vault ID]`,
			`Host: ${settings.host || "(not set)"}`,
			`Vault ID: ${settings.vaultId || "(not set)"}`,
			`Device: ${settings.deviceName || "(unnamed)"}`,
			`Trace ID: ${trace?.traceId ?? "(disabled)"}`,
			`Boot ID: ${trace?.bootId ?? "(disabled)"}`,
			// Connection facts (INV-AUTH-01, INV-ACK-01)
			`Headline: ${facts.headlineState}`,
			`Server reachable: ${facts.serverReachable ?? "unknown"}`,
			`Auth accepted: ${facts.authAccepted ?? "unknown"}`,
			`WebSocket open: ${facts.websocketOpen}`,
			`Auth reject code: ${facts.lastAuthRejectCode ?? "(none)"}`,
			`Last local CRDT update: ${fmtTs(facts.lastLocalUpdateAt)}`,
			`Last local update while connected: ${fmtTs(facts.lastLocalUpdateWhileConnectedAt)}`,
			`Last remote update observed: ${fmtTs(facts.lastRemoteUpdateAt)}`,
			`Server receipt wire: active (Level 3 server Y.Doc receipt; not durable)`,
			`Server receipt active state: ${facts.serverAppliedLocalState ?? "unknown"}`,
			`Last server receipt echo observed: ${fmtTs(facts.lastServerReceiptEchoAt)}`,
			`Last known server receipt: ${fmtTs(facts.lastKnownServerReceiptEchoAt)}`,
			`Server receipt candidate captured: ${fmtTs(facts.serverReceiptCandidateCapturedAt)}`,
			`Server receipt candidate present: ${facts.hasUnconfirmedServerReceiptCandidate}`,
			`Server receipt persistence healthy: ${facts.candidatePersistenceHealthy ?? "unknown"}`,
			`Server receipt persistence failures: ${facts.candidatePersistenceFailureCount ?? "unknown"}`,
			`Server receipt startup validation: ${describeServerReceiptStartupValidation(vaultSync.serverReceiptStartupValidation)}`,
			`Custom messages seen: ${vaultSync.svEchoCounters.customMessageSeenCount}`,
			`Server receipt echo seen: ${vaultSync.svEchoCounters.svEchoSeenCount}`,
			`Server receipt echo accepted: ${vaultSync.svEchoCounters.acceptedCount}`,
			`Server receipt echo rejected: ${vaultSync.svEchoCounters.rejectedCount}`,
			`Server receipt echo rejected oversize: ${vaultSync.svEchoCounters.rejectedOversizeCount}`,
			`Server receipt echo rejected invalid: ${vaultSync.svEchoCounters.rejectedInvalidCount}`,
			`Server receipt echo max bytes: ${vaultSync.svEchoCounters.bytesMax}`,
			`Pending local updates: unknown (latest-state receipt, no queue count)`,
			`Pending blob uploads: ${facts.pendingBlobUploads}`,
			// Detailed internal state
			`Local ready: ${vaultSync.localReady}`,
			`Provider synced: ${vaultSync.providerSynced}`,
			`Initialized (sentinel): ${vaultSync.isInitialized}`,
			`Reconcile mode: ${vaultSync.getSafeReconcileMode()}`,
			`Reconciled: ${state.reconciled}`,
			`Connection generation: ${vaultSync.connectionGeneration}`,
			`Last reconciled gen: ${state.lastReconciledGeneration}`,
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

	/**
	 * Default diagnostics export. Vault paths are redacted to stable
	 * per-bundle salted hashes; no filenames or vault content appear in
	 * the output (INV-SEC-02).
	 */
	async exportDiagnostics(): Promise<void> {
		await this.runExport({ includeFilenames: false });
	}

	/**
	 * Filename-inclusive diagnostics export. Requires explicit confirmation
	 * before writing. Output contains raw vault paths and is intended for
	 * direct sharing with the maintainer when path structure is needed to
	 * reproduce a bug.
	 */
	async exportDiagnosticsWithFilenames(): Promise<void> {
		await new Promise<void>((resolve) => {
			new ConfirmModal(
				this.deps.app,
				"Export diagnostics with filenames?",
				"This export includes raw vault file names and your server URL. Do not share publicly without reviewing the file first.",
				async () => {
					try {
						await this.runExport({ includeFilenames: true });
					} catch (err) {
						this.deps.log(`diagnostics export failed: ${formatUnknown(err)}`);
						new Notice("Diagnostics export failed. Check console.", 10000);
					} finally {
						resolve();
					}
				},
				"Export with filenames",
				"Cancel",
				() => resolve(),
			).open();
		});
	}

	private async runExport(options: { includeFilenames: boolean }): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		new Notice(
			options.includeFilenames
				? "Exporting full sync diagnostics (with filenames)..."
				: "Exporting safe sync diagnostics...",
		);
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

		const blobSync = this.deps.getBlobSync();
		const syncFacts = deriveSyncFacts(
			{
				connected: vaultSync.connected,
				fatalAuthError: vaultSync.fatalAuthError,
				fatalAuthCode: vaultSync.fatalAuthCode,
				lastLocalUpdateAt: vaultSync.lastLocalUpdateAt,
				lastLocalUpdateWhileConnectedAt: vaultSync.lastLocalUpdateWhileConnectedAt,
				lastRemoteUpdateAt: vaultSync.lastRemoteUpdateAt,
				pendingBlobUploads: blobSync?.pendingUploads ?? 0,
				serverAppliedLocalState: vaultSync.serverAppliedLocalState,
				lastServerReceiptEchoAt: vaultSync.lastServerReceiptEchoAt,
				lastKnownServerReceiptEchoAt: vaultSync.lastKnownServerReceiptEchoAt,
				candidatePersistenceHealthy: vaultSync.candidatePersistenceHealthy,
				candidatePersistenceFailureCount: vaultSync.candidatePersistenceFailureCount,
				hasUnconfirmedServerReceiptCandidate: vaultSync.hasUnconfirmedServerReceiptCandidate,
				serverReceiptCandidateCapturedAt: vaultSync.serverReceiptCandidateCapturedAt,
			},
			vaultSync.connected
				? (state.reconciled ? "online" : "connecting")
				: (vaultSync.fatalAuthError ? "auth_failed" : "offline"),
		);

		const input: DiagnosticsBundleInput = {
			generatedAt: new Date().toISOString(),
			generationMs: Date.now() - startedAt,
			settings: {
				host: settings.host,
				token: settings.token,
				vaultId: settings.vaultId,
				deviceName: settings.deviceName,
				debug: settings.debug,
				enableAttachmentSync: settings.enableAttachmentSync,
				externalEditPolicy: settings.externalEditPolicy,
			},
			stateSnapshot: {
				reconciled: state.reconciled,
				reconcileInFlight: state.reconcileInFlight,
				reconcilePending: state.reconcilePending,
				lastReconcileStats: state.lastReconcileStats,
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
				serverReceiptStartupValidation: vaultSync.serverReceiptStartupValidation,
				svEcho: vaultSync.svEchoCounters,
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
			syncFacts,
			trace: this.deps.getTraceHttpContext(),
			diskHashes,
			crdtHashes,
			eventRing: this.deps.getEventRing(),
			syncEvents: vaultSync.getRecentEvents(240),
			serverTrace: this.deps.getRecentServerTrace(),
			openFiles: await this.deps.collectOpenFileTraceState(),
			diskMirrorSnapshot: this.deps.getDiskMirror()?.getDebugSnapshot() ?? null,
			blobSyncSnapshot: blobSync?.getDebugSnapshot() ?? null,
			frontmatterQuarantine: this.deps.getFrontmatterQuarantineEntries(),
			sha256Hex: this.deps.sha256Hex.bind(this.deps),
		};

		const { bundle: diagnostics, leakDetected, missingOnDiskCount, missingInCrdtCount, hashMismatchCount } = await buildDiagnosticsBundle(input, options);

		if (leakDetected) {
			this.deps.log(`diagnostics: redaction leak detected, aborting safe export`);
			new Notice(
				"Safe diagnostics export failed: a vault path survived redaction. Check the console.",
				10000,
			);
			return;
		}

		const diagDir = await this.ensureDiagnosticsDir();

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const variant = options.includeFilenames ? "with-filenames" : "safe";
		// Device name is excluded from the safe filename to avoid leaking it
		// in filesystem metadata. Full mode retains it for easier file sorting.
		const fileName = options.includeFilenames
			? `sync-diagnostics-with-filenames-${stamp}-${settings.deviceName || "device"}.json`
			: `sync-diagnostics-safe-${stamp}.json`;
		const outPath = normalizePath(`${diagDir}/${fileName}`);
		await this.deps.app.vault.adapter.write(outPath, JSON.stringify(diagnostics, null, 2));

		// Do not log outPath in safe mode: the path is a vault path and would
		// itself constitute a leak if plugin logs are later included in a
		// diagnostics bundle.
		this.deps.log(
			options.includeFilenames
				? `Diagnostics exported (${variant}): ${outPath} (missingOnDisk=${missingOnDiskCount}, missingInCrdt=${missingInCrdtCount}, mismatches=${hashMismatchCount})`
				: `Diagnostics exported (${variant}): missingOnDisk=${missingOnDiskCount}, missingInCrdt=${missingInCrdtCount}, mismatches=${hashMismatchCount}`,
		);
		new Notice(
			options.includeFilenames
				? `Full sync diagnostics (with filenames) exported to ${outPath}`
				: `Safe sync diagnostics exported. File saved in plugin diagnostics folder.`,
			10000,
		);
	}

	async ensureDiagnosticsDir(): Promise<string> {
		const diagDir = normalizePath(`${this.deps.app.vault.configDir}/plugins/yaos/diagnostics`);
		if (!(await this.deps.app.vault.adapter.exists(diagDir))) {
			await this.deps.app.vault.adapter.mkdir(diagDir);
		}
		return diagDir;
	}
}
