import { access } from "node:fs/promises";
import WebSocket from "ws";
import { TFile } from "obsidian";

import { BootstrapClient, BootstrapHttpPort, prepareBootstrapRoot } from "../../../src/sync/bootstrapClient";
import { DiskMirror } from "../../../src/sync/diskMirror";
import { createSocketTicketCache } from "../../../src/sync/socketTicket";
import { VaultSync, type ReconcileMode } from "../../../src/sync/vaultSync";
import { ReconciliationController } from "../../../src/runtime/reconciliationController";
import { buildRuntimeConfig, type RuntimeConfig } from "../../../src/runtime/runtimeConfig";
import { DEFAULT_SETTINGS, type VaultSyncSettings } from "../../../src/settings/settingsStore";
import { FrontmatterGuardCoordinator } from "../../../src/sync/frontmatterGuardCoordinator";
import type { FrontmatterQuarantineEntry } from "../../../src/sync/frontmatterQuarantine";
import { contentBaselineHash, type DiskIndex } from "../../../src/sync/diskIndex";
import type { DiskIngestPort } from "../../../src/runtime/engineControlPort";
import { isMarkdownSyncable } from "../../../src/types";
import { createFetchRequester } from "../../../src/utils/http";
import { fetchVaultProvisioningProof } from "../../../src/onboarding/provisioningClient";
import { LocalVaultImporter } from "../../../src/onboarding/localVaultImport";
import {
	FreshBodyAdmissionLocalVaultImportSink,
	ObsidianLocalVaultImportSource,
} from "../../../src/onboarding/obsidianLocalVaultImport";
import type {
	LocalFileRevision,
	LocalInventoryEntry,
	LocalVaultImportSource,
} from "../../../src/onboarding/localVaultImport";

import type { CleanupStack } from "./cleanup";
import type { DaemonConfig } from "./config";
import { NodeVaultDatabase } from "./nodeVaultDatabase";
import {
	createNodeHost,
	shadowedBy,
	type FsHint,
	type FsWatcher,
	type MarkdownScan,
	type NodeHost,
} from "./nodeHost";
import {
	readEnrollmentState,
	updateEnrollmentState,
	validateStateIdentity,
	writeEnrollmentState,
	type EnrollmentMembership,
	type StatePaths,
} from "./state";

/**
 * A refusal the daemon cannot retry its way out of: the server rejected the
 * client's credentials or its schema version. Carries the code so the process
 * can exit 2 and let a supervisor stop restarting it.
 */
export class FatalAuthError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "FatalAuthError";
	}
}

/**
 * The daemon could not reach a usable server at startup. Distinct from
 * `FatalAuthError`: retrying later is exactly the right response.
 */
export class StartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StartupError";
	}
}


/** The headless product boundary: Markdown files only, never `.obsidian` or attachments. */
const VAULT_CONFIG_DIR = ".obsidian";

/** Test-only causal barrier used by the black-box shutdown race scenario. */
const PERIODIC_RECONCILE_BARRIER: string | null =
	process.env["YAOS_TEST_ONLY_PERIODIC_RECONCILE_BARRIER"]?.trim() || null;

async function waitForBarrierRelease(path: string): Promise<void> {
	for (;;) {
		try {
			await access(path);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}

async function waitForPendingPublications(
	runtime: VaultSync,
	database: NodeVaultDatabase,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const pending = await database.getPendingWorkSummary();
		if (
			!runtime.hasPendingLocalWork
			&& pending.pendingCandidates === 0
			&& pending.lifecycleOperations === 0
			&& pending.attachmentOperations === 0
		) {
			return true;
		}
		if (Date.now() >= deadline) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}



/**
 * The floor and the ceiling on how long a path must stay missing before the
 * daemon is willing to call it deleted.
 *
 * The interval itself is derived from `YAOS_RECONCILE_INTERVAL_MS`, because
 * the scan period is already the granularity at which the daemon learns
 * anything about disk: waiting longer than one period adds latency to a real
 * deletion for nothing, and waiting less than one period would let the second
 * confirming scan follow the first so closely that "it is still missing"
 * covers no wall-clock time at all.
 *
 * The floor exists because a configured interval can be arbitrarily small —
 * the headless suite runs at 1.5 s — and the transients this delay is here to
 * outlast (an editor's unlink-then-rename save, a `git checkout` replacing a
 * file, a scan racing a write) are measured in hundreds of milliseconds. Two
 * seconds clears them with room to spare while keeping the suite fast enough
 * to assert the delay rather than skip it.
 *
 * The ceiling exists because the delay is not the mechanism that finds the
 * deletion — the next scan is — so on the 60 s default there is nothing to be
 * bought by waiting more than half a period beyond it.
 */
const MIN_DELETE_STABILITY_MS = 2_000;
const MAX_DELETE_STABILITY_MS = 30_000;

/**
 * A path that has gone missing and might be a deletion. Recording one mutates
 * nothing: it is the daemon writing down what it saw so a later scan can
 * decide whether the absence was real.
 */
interface DeleteCandidate {
	/**
	 * What `diskIndex` held for the path when it went missing. A later scan
	 * that finds any of it changed knows something wrote to that path since,
	 * which explains the absence as materialization rather than deletion.
	 */
	readonly baselineHash: string | undefined;
	readonly baselineMtime: number;
	readonly baselineSize: number;
	readonly firstMissingAt: number;
	readonly firstMissingScan: number;
}

/** Everything one pass needs in order to judge an absence, gathered once. */
interface AbsenceEvidence {
	readonly present: ReadonlySet<string>;
	readonly active: ReadonlySet<string>;
	readonly unreadable: readonly string[];
	readonly pendingWrites: ReadonlySet<string>;
}

/**
 * Why an absence is not a deletion.
 *
 * `settled` separates the two kinds of doubt. A settled explanation is
 * positive knowledge — the file is there, the CRDT dropped it, a hint is
 * owed — and retires any candidate. An unsettled one means the daemon could
 * not tell, which is never grounds for acting and never grounds for
 * forgetting either.
 */
interface AbsenceExplanation {
	readonly reason: string;
	readonly settled: boolean;
}
class CapturedImportSource implements LocalVaultImportSource {
	constructor(
		private readonly inventory: readonly LocalInventoryEntry[],
		private readonly delegate: LocalVaultImportSource,
	) {}

	async captureInventory(): Promise<readonly LocalInventoryEntry[]> {
		return this.inventory;
	}

	async read(path: string): Promise<string> {
		return this.delegate.read(path);
	}

	async stat(path: string): Promise<LocalFileRevision | null> {
		return this.delegate.stat(path);
	}
}


/**
 * Assemble the real plugin engine — `VaultSync`, `DiskMirror` and
 * `ReconciliationController` — on top of a Node host.
 *
 * Nothing about sync policy lives here. This class supplies the host
 * mechanisms the client owners need: a filesystem-backed `App`, inert editor
 * bindings, durable SQLite ports, and lifecycle cleanup. Everything else is a
 * call into the same domain owners `src/main.ts` uses.
 */
export class DaemonEngine {
	private host: NodeHost | null = null;
	private vaultSync: VaultSync | null = null;
	private diskMirror: DiskMirror | null = null;
	private controller: ReconciliationController | null = null;
	private database: NodeVaultDatabase | null = null;
	private bootstrapClient: BootstrapClient | null = null;
	private watcher: FsWatcher | null = null;
	private reconcileTimer: NodeJS.Timeout | undefined;
	private ingestPort: DiskIngestPort | null = null;
	private preservedPersistence: Promise<void> = Promise.resolve();
	private bootstrapCatchUp: Promise<void> | null = null;
	private bootstrapCatchUpPending = false;
	private periodicReconcileInFlight: Promise<void> | null = null;
	private startInFlight: Promise<void> | null = null;
	private stopInFlight: Promise<void> | null = null;
	private periodicBarrierUsed = false;

	private diskIndex: DiskIndex = {};
	private lastDiskIndexPersistedAt = 0;
	private quarantineEntries: FrontmatterQuarantineEntry[] = [];
	private readonly settings: VaultSyncSettings;
	private readonly runtimeConfig: RuntimeConfig;

	/**
	 * Paths the watcher reported since the last authoritative reconcile, with
	 * the reason it reported them.
	 *
	 * The controller owns the real dirty set and its coalescing; this is a
	 * shutdown ledger. It deliberately includes deletes so watcher-close can
	 * flush a coalesced final event into the one serialized shutdown drain.
	 */
	private readonly hintedPaths = new Map<string, FsHint["kind"]>();

	/**
	 * Paths seen missing by an earlier scan and not yet explained. Phase one
	 * of delete inference writes here and nowhere else; nothing in the vault
	 * or the CRDT changes because a candidate exists.
	 */
	private readonly deleteCandidates = new Map<string, DeleteCandidate>();

	/**
	 * Authoritative scans completed by `runPeriodicReconcile`, counted so a
	 * candidate can require a LATER one than the scan that recorded it. Wall
	 * clock alone would let one scan's snapshot confirm itself.
	 */
	private authoritativeScans = 0;

	/** See `MIN_DELETE_STABILITY_MS`. Resolved once, from the configured period. */
	private readonly deleteStabilityMs: number;

	/**
	 * How long a candidate may stay unresolved before it is dropped as a stuck
	 * state rather than kept as evidence. Four confirmation windows: a real
	 * deletion needs one, and anything still undecided after four is a path
	 * the daemon cannot judge — which must not hold reconciliation off forever.
	 */
	private readonly deleteReviewDeadlineMs: number;

	/** True once `start()` completed: connected, reconciled, watching. */
	private started = false;
	/** Set before watcher close; blocks every new producer except final watcher hints. */
	private stopping = false;
	/** Set after watcher close; no more filesystem hints can be admitted. */
	private stopped = false;
	private fatalAuth: FatalAuthError | null = null;
	private onFatalAuthCallback: ((error: FatalAuthError) => void) | null = null;

	constructor(
		private readonly config: DaemonConfig,
		private readonly realVaultPath: string,
		private membership: EnrollmentMembership,
		private readonly statePaths: StatePaths,
		private readonly cleanup: CleanupStack,
		private readonly log: (message: string) => void,
	) {
		this.settings = {
			...DEFAULT_SETTINGS,
			host: membership.host,
			deviceToken: membership.deviceToken,
			vaultId: membership.vaultId,
			deviceId: membership.deviceId,
			vaultGeneration: membership.vaultGeneration,
			originImportPending: membership.originImportPending,
			deviceName: membership.deviceName,
			debug: config.debug,
			settingsSyncEnabled: false,
			enableAttachmentSync: false,
			attachmentSyncExplicitlyConfigured: true,
			maxAttachmentSizeKB: 0,
			attachmentConcurrency: 1,
			showRemoteCursors: false,
		};
		this.runtimeConfig = buildRuntimeConfig(this.settings, VAULT_CONFIG_DIR);
		this.deleteStabilityMs = Math.min(
			Math.max(config.reconcileIntervalMs, MIN_DELETE_STABILITY_MS),
			MAX_DELETE_STABILITY_MS,
		);
		this.deleteReviewDeadlineMs = this.deleteStabilityMs * 4;
	}

	/** Register the post-startup fatal-auth notification. Fires at most once. */
	onFatalAuth(callback: (error: FatalAuthError) => void): void {
		this.onFatalAuthCallback = callback;
		if (this.fatalAuth) callback(this.fatalAuth);
	}

	/**
	 * Bring the daemon up: connect, sync, and complete one authoritative
	 * reconcile. Returns only when the vault and the room agree — the caller
	 * may print readiness the moment this resolves.
	 */
	start(): Promise<void> {
		if (this.startInFlight === null) this.startInFlight = this.startInternal();
		return this.startInFlight;
	}

	private async startInternal(): Promise<void> {
		// Phase 1: prove the enrolled generation and freeze origin inventory.
		const host = await createNodeHost(this.realVaultPath);
		this.host = host;
		this.cleanup.defer(() => host.dispose());
		const requester = createFetchRequester(fetch);
		let provisioning;
		try {
			provisioning = await fetchVaultProvisioningProof({
				host: this.membership.host,
				deviceToken: this.membership.deviceToken,
				vaultId: this.membership.vaultId,
			}, requester);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/\((?:401|403)\)/.test(message)) {
				throw this.raiseFatal(new FatalAuthError("unauthorized", message));
			}
			if (message.includes("incompatible product versions")) {
				throw this.raiseFatal(new FatalAuthError("update_required", message));
			}
			throw new StartupError(`Provisioning proof failed: ${message}`);
		}
		if (provisioning.vaultId !== this.membership.vaultId
			|| provisioning.vaultGeneration !== this.membership.vaultGeneration) {
			throw this.raiseFatal(new FatalAuthError(
				"server_misconfigured",
				"Enrollment vault generation does not match the active server vault",
			));
		}
		const enrollmentState = await readEnrollmentState(this.statePaths);
		if (!enrollmentState) throw new StartupError("Enrollment state disappeared during startup");
		validateStateIdentity(enrollmentState, this.realVaultPath, this.membership.host);
		await writeEnrollmentState(
			this.statePaths,
			updateEnrollmentState(enrollmentState, { provisioningProof: provisioning }),
		);
		const liveImportSource = new ObsidianLocalVaultImportSource(host.app);
		const finiteInventory = this.membership.originImportPending
			? await liveImportSource.captureInventory()
			: [];

		// Phase 2: open generation-scoped persistence and validate bootstrap root.
		const database = new NodeVaultDatabase(this.statePaths.databaseFile, {
			host: this.membership.host,
			realVaultPath: this.realVaultPath,
			vaultId: this.membership.vaultId,
			vaultGeneration: this.membership.vaultGeneration,
			deviceId: this.membership.deviceId,
			folderKey: enrollmentState.folderKey,
		});
		this.database = database;
		this.cleanup.defer(() => database.close());
		const persistedDiskIndex = await database.loadDiskIndex();
		this.diskIndex = persistedDiskIndex.index;
		this.lastDiskIndexPersistedAt = persistedDiskIndex.updatedAt;
		const bootstrapServer = new BootstrapHttpPort(
			this.membership.host,
			this.membership.vaultId,
			this.membership.deviceToken,
			database,
			requester,
		);
		await prepareBootstrapRoot(bootstrapServer, database);

		// Phase 3: construct the canonical runtime and its disk mirror.
		const tickets = createSocketTicketCache(requester);
		const vaultSync = new VaultSync({
			vaultId: this.membership.vaultId,
			deviceId: this.membership.deviceId,
			host: this.membership.host,
			token: this.membership.deviceToken,
			database,
			request: requester,
			webSocket: WebSocket,
			getSocketTicket: async (force = false) => {
				if (force) tickets.invalidate();
				return tickets.get(
					this.membership.host,
					this.membership.deviceToken,
					this.membership.vaultId,
				);
			},
			log: (message) => this.log(`[sync] ${message}`),
			onRemoteRootStructuralUpdate: () => this.scheduleBootstrapCatchUp("remote-root"),
			onDurableBodyCommitted: () => this.scheduleBootstrapCatchUp("body-committed"),
		});
		this.vaultSync = vaultSync;
		this.cleanup.defer(() => vaultSync.destroy());
		await vaultSync.initialize();
		vaultSync.provider.on("custom-message", () => {
			queueMicrotask(() => {
				if (vaultSync.fatalAuthError) this.recordFatalAuth();
			});
		});
		if (vaultSync.fatalAuthError) throw this.recordFatalAuth();

		const initialPreserved = await database.loadPreservedUnresolved();
		const diskMirror = new DiskMirror(
			host.app,
			vaultSync,
			host.editorBindings,
			this.config.debug,
			undefined,
			() => this.settings.frontmatterGuardEnabled,
			undefined,
			() => this.settings.deviceName,
			initialPreserved,
			() => {
				const entries = diskMirror.getPreservedUnresolvedEntries();
				for (const entry of entries) {
					this.log(`preserved-unresolved path="${entry.path}" reason=${entry.reason}`);
				}
				this.preservedPersistence = this.preservedPersistence
					.then(() => database.replacePreservedUnresolved(entries))
					.catch((error: unknown) => {
						this.log(`preserved-unresolved persistence failed: ${String(error)}`);
					});
			},
		);
		this.diskMirror = diskMirror;
		this.cleanup.defer(() => diskMirror.destroy());
		diskMirror.setDiskWriteCallback((path, contentHash) => {
			const existing = this.diskIndex[path];
			if (existing) existing.contentHash = contentHash;
			else this.diskIndex[path] = { mtime: 0, size: 0, contentHash };
			this.withdrawDeleteCandidate(path, "the daemon wrote it");
		});
		diskMirror.configureSettlement({
			getBaseline: (path) => ({
				contentHash: this.diskIndex[path]?.contentHash ?? null,
				lastDiskIndexPersistedAt: this.lastDiskIndexPersistedAt,
			}),
			commitLocalBody: async (input) => {
				await vaultSync.commitDiskBody({
					...input,
					...(input.reason === "delete-revive" ? { lifecycle: "revive" as const } : {}),
				});
			},
			settleClosedBody: async (path) => {
				const bodyId = vaultSync.getFileId(path);
				if (!bodyId || !this.bootstrapClient) return;
				await vaultSync.settleBodyOnClose(bodyId);
				await this.bootstrapClient.settleBodyNow(bodyId);
				diskMirror.notifyBodyAvailable(path);
			},
			isPathAllowed: (path) => this.isMarkdownPathSyncable(path),
			isBodyLive: (bodyId) => vaultSync.isBodyOpen(bodyId),
		});
		const bootstrapClient = new BootstrapClient(
			bootstrapServer,
			database,
			vaultSync.bodies,
			diskMirror,
		);
		this.bootstrapClient = bootstrapClient;
		const controller = new ReconciliationController(this.buildControllerDeps());
		this.controller = controller;

		// Phase 4: durably seed an origin or bootstrap a joining device, then sync.
		if (this.membership.originImportPending) {
			const importer = new LocalVaultImporter(
				new CapturedImportSource(finiteInventory, liveImportSource),
				new FreshBodyAdmissionLocalVaultImportSink(() => this.vaultSync, (_paths, work) => work()),
				database,
				{
					vaultId: this.membership.vaultId,
					maxFileSizeBytes: this.runtimeConfig.maxFileSizeBytes,
					excludePatterns: this.runtimeConfig.excludePatterns,
					configDir: VAULT_CONFIG_DIR,
				},
			);
			await importer.capture();
			const imported = await importer.run();
			if (imported.stage !== "complete") {
				throw new StartupError("Origin import requires attention before the daemon can become ready");
			}
			const state = await readEnrollmentState(this.statePaths);
			if (!state?.membership) throw new StartupError("Enrollment state disappeared after origin import");
			this.membership = { ...state.membership, originImportPending: false };
			this.settings.originImportPending = false;
			await writeEnrollmentState(
				this.statePaths,
				updateEnrollmentState(state, { membership: this.membership }),
			);
		}
		await this.bootstrapCatchUp;
		await bootstrapClient.run();
		const providerSynced = await vaultSync.waitForProviderSync();
		if (vaultSync.fatalAuthError) throw this.recordFatalAuth();
		if (!providerSynced) {
			throw new StartupError(`Timed out waiting for ${this.membership.host} to synchronize the schema-4 root`);
		}
		await this.admitAuthoritativeDiskChanges(await host.scanMarkdown());
		const mode = vaultSync.getSafeReconcileMode();
		if (mode !== "authoritative") throw new StartupError("Root provider did not establish authoritative reconciliation");
		await controller.runReconciliation(mode);
		controller.lastGeneration = vaultSync.connectionGeneration;
		if (!await waitForPendingPublications(vaultSync, database, 15_000)) {
			throw new StartupError(
				"Startup publication did not reach durable candidate and lifecycle settlement",
			);
		}
		await vaultSync.flushReceiptPersistence();
		await this.persistDiskIndex();

		// Phase 5: begin hint intake and periodic authoritative reconciliation.
		this.watcher = host.watch((hint) => this.handleHint(hint));
		this.cleanup.defer(() => this.watcher?.close());
		this.reconcileTimer = setInterval(() => {
			void this.runPeriodicReconcile();
		}, this.config.reconcileIntervalMs);
		this.reconcileTimer.unref?.();
		this.cleanup.defer(() => {
			clearInterval(this.reconcileTimer);
			this.reconcileTimer = undefined;
		});
		vaultSync.onProviderSync((generation) => {
			if (this.stopping || generation <= (this.controller?.lastGeneration ?? 0)) return;
			this.scheduleBootstrapCatchUp("provider-sync");
			void (this.bootstrapCatchUp ?? Promise.resolve())
				.then(() => this.controller?.runReconnectReconciliation(generation))
				.catch((error: unknown) => this.log(`Reconnect settlement failed: ${String(error)}`));
		});
		this.started = true;
	}
	private scheduleBootstrapCatchUp(reason: string): void {
		if (this.stopping || !this.bootstrapClient) return;
		this.bootstrapCatchUpPending = true;
		if (this.bootstrapCatchUp) return;
		const bootstrap = this.bootstrapClient;
		const run = async () => {
			while (this.bootstrapCatchUpPending && !this.stopping) {
				this.bootstrapCatchUpPending = false;
				try {
					await bootstrap.run();
				} catch (error) {
					this.log(`Bootstrap catch-up failed (${reason}): ${String(error)}`);
				}
			}
		};
		this.bootstrapCatchUp = run().finally(() => {
			this.bootstrapCatchUp = null;
		});
	}


	/**
	 * Shut down without losing work, in the only order that is safe:
	 * stop new producers, close and flush the watcher, join periodic work,
	 * perform one final disk drain, then persist for outer cleanup.
	 */
	stop(): Promise<void> {
		if (this.stopInFlight === null) {
			this.stopInFlight = this.stopOnce().catch((error: unknown) => {
				this.log(`Shutdown drain failed: ${String(error)}`);
			});
		}
		return this.stopInFlight;
	}

	private async stopOnce(): Promise<void> {
		this.stopping = true;

		// A direct caller may request stop while start() is still assembling the
		// runtime. Join it before touching resources it still owns. The CLI's
		// SIGINT path normally reaches here with the same promise already settled.
		await this.startInFlight?.catch(() => undefined);

		clearInterval(this.reconcileTimer);
		this.reconcileTimer = undefined;

		// close() synchronously flushes the watcher's coalescing ledger through
		// handleHint. `stopped` must remain false until that callback is done.
		const watcher = this.watcher;
		if (watcher !== null) {
			await watcher.close();
			if (this.watcher === watcher) this.watcher = null;
		}
		this.stopped = true;
		this.log("shutdown-watcher-closed");

		const periodic = this.periodicReconcileInFlight;
		if (periodic !== null) {
			this.log("shutdown-awaiting-periodic-reconcile");
			await periodic;
			this.log("shutdown-periodic-reconcile-joined");
		}

		if (!this.started) {
			await this.preservedPersistence;
			return;
		}

		this.log("shutdown-final-drain-start");
		await this.drainDiskToCrdt();
		await this.diskMirror?.flushAllPendingWrites().catch((error: unknown) => {
			this.log(`Write drain failed: ${String(error)}`);
		});
		await this.bootstrapCatchUp;
		await this.vaultSync?.retryPendingCandidates().catch((error: unknown) => {
			this.log(`Candidate drain retry failed: ${String(error)}`);
		});
		const settled = this.vaultSync && this.database
			? await waitForPendingPublications(this.vaultSync, this.database, 10_000)
			: true;
		if (!settled) this.log("Pending candidate work remains durably queued for restart");
		await this.vaultSync?.flushReceiptPersistence();
		await this.persistDiskIndex();
		if (this.database && this.diskMirror) {
			const entries = this.diskMirror.getPreservedUnresolvedEntries();
			this.preservedPersistence = this.preservedPersistence
				.then(() => this.database!.replacePreservedUnresolved(entries));
		}
		await this.preservedPersistence;
		this.log("shutdown-final-drain-complete");
	}

	// -------------------------------------------------------------------
	// Watcher hints
	// -------------------------------------------------------------------

	/**
	 * Translate one filesystem hint into the same engine calls the plugin
	 * makes from its `vault.on(...)` handlers. Markdown only, and every
	 * decision that is policy — delete suppression, dirty coalescing — is
	 * delegated.
	 */
	private handleHint(hint: FsHint): void {
		if (this.stopped) return;
		const controller = this.controller;
		const vaultSync = this.vaultSync;
		if (!controller || !vaultSync || !controller.isReconciled) return;

		// Any hint at all is fresher evidence than a scan's snapshot, so it
		// retires the candidate before the hint's own policy runs — including
		// a delete hint, which needs no confirmation of its own.
		this.withdrawDeleteCandidate(hint.path, `the watcher reported a ${hint.kind}`);

		switch (hint.kind) {
			case "create":
			case "modify": {
				if (!this.isMarkdownPathSyncable(hint.path)) return;
				const file = this.host?.app.vault.getAbstractFileByPath(hint.path);
				if (!(file instanceof TFile)) return;
				this.hintedPaths.set(hint.path, hint.kind);
				if (this.stopping) {
					this.log(`shutdown-hint kind=${hint.kind} path="${hint.path}"`);
					return;
				}
				controller.markMarkdownDirty(file, hint.kind);
				return;
			}
			case "delete": {
				if (!this.isMarkdownPathSyncable(hint.path)) return;
				if (this.diskMirror?.consumeDeleteSuppression(hint.path)) {
					this.log(`Suppressed delete event for "${hint.path}"`);
					return;
				}
				if (this.diskMirror?.isPreservedUnresolved(hint.path)) {
					this.diskMirror.clearPreservedUnresolved(hint.path);
					this.log(`preserved-retired path="${hint.path}" reason=external-delete-or-rename`);
				}
				this.hintedPaths.set(hint.path, "delete");
				if (this.stopping) {
					this.log(`shutdown-hint kind=delete path="${hint.path}"`);
					return;
				}
				vaultSync.handleDelete(hint.path, this.settings.deviceName);
				this.log(`Delete: "${hint.path}"`);
				return;
			}
		}
	}

	// -------------------------------------------------------------------
	// Reconciliation
	// -------------------------------------------------------------------

	/**
	 * Delete inference, in two phases and on positive evidence only.
	 *
	 * A missing path is ambiguous on its own: it is either a file the user
	 * deleted, or a file the CRDT holds that has not been written out yet. The
	 * authoritative scan cannot tell those apart, so on its own it resolves the
	 * ambiguity the safe way and re-materializes — which silently resurrects a
	 * deletion whose watcher hint was dropped.
	 *
	 * `diskIndex` narrows it. An entry exists only once this process has
	 * actually read or written that path, so an entry plus an absent file is
	 * not a pending write. The baseline is per-process and deliberately not
	 * persisted: after a restart the index is empty, nothing is inferred, and
	 * the daemon falls back to re-materializing rather than deleting on
	 * evidence it does not have.
	 *
	 * BUT ABSENCE FROM A SCAN IS NOT A DELETION. A walk that could not read a
	 * directory reports no files under it; an editor saving atomically, a
	 * `git checkout` and a scan racing the daemon's own write all make a path
	 * momentarily absent. Reading any of those as a delete propagates it to
	 * every other device, and an unreadable directory would propagate the
	 * whole subtree at once. So:
	 *
	 *   PHASE 1 records a candidate and mutates nothing. It needs the scan's
	 *   absence AND a per-path `lstat` that positively says ENOENT/ENOTDIR AND
	 *   the path not to lie under anything the walk failed to read AND no
	 *   pending hint or mirror write. Every "I could not tell" — EACCES, EIO,
	 *   ELOOP, an errno nobody has enumerated — ends in no candidate.
	 *
	 *   PHASE 2 confirms on a LATER scan, once the same evidence still holds,
	 *   the `diskIndex` baseline has not moved, and the stability interval has
	 *   elapsed. Only then does the delete reach the CRDT.
	 *
	 * The evidence is assembled by `explainAbsence`, which returns a reason
	 * for every path it can account for and null only when nothing explains
	 * the absence but a deletion. Doing nothing is therefore the default
	 * outcome of every branch, including ones added later.
	 */
	private reviewDroppedDeletes(scan: MarkdownScan): string[] {
		const vaultSync = this.vaultSync;
		if (!vaultSync) return [];

		const scanSeq = ++this.authoritativeScans;
		const now = Date.now();
		const mirror = this.diskMirror?.getDebugSnapshot();
		const evidence: AbsenceEvidence = {
			present: new Set(scan.paths),
			active: new Set(vaultSync.getActiveMarkdownPaths()),
			unreadable: scan.unreadable,
			pendingWrites: new Set([...mirror?.queuedWrites ?? [], ...mirror?.openPendingPaths ?? []]),
		};

		// Two ways a candidate stops being one before it is ever judged.
		//
		// A baseline that moved means something wrote to that path after the
		// candidate was recorded, which explains the absence better than a
		// deletion does. Checked before anything else so a stale candidate can
		// never be confirmed against a baseline it no longer describes.
		//
		// A candidate neither confirmed nor explained for four windows is not
		// evidence, it is a stuck state — and a stuck candidate holds
		// reconciliation off (see `runPeriodicReconcile`). Dropping it returns
		// the daemon to re-materializing, which is the safe answer, and a later
		// scan is free to open a fresh one.
		for (const [path, candidate] of this.deleteCandidates) {
			if (now - candidate.firstMissingAt > this.deleteReviewDeadlineMs) {
				this.deleteCandidates.delete(path);
				this.log(
					`delete-withdrawn path="${path}" reason=review-deadline `
					+ `deadlineMs=${String(this.deleteReviewDeadlineMs)}`,
				);
				continue;
			}
			const entry = this.diskIndex[path];
			if (
				entry !== undefined
				&& entry.contentHash === candidate.baselineHash
				&& entry.mtime === candidate.baselineMtime
				&& entry.size === candidate.baselineSize
			) {
				continue;
			}
			this.deleteCandidates.delete(path);
			this.log(`delete-withdrawn path="${path}" reason=baseline-changed`);
		}

		const confirmed: string[] = [];
		for (const path of Object.keys(this.diskIndex)) {
			const explanation = this.explainAbsence(path, evidence);
			if (explanation !== null) {
				if (explanation.settled) this.withdrawDeleteCandidate(path, explanation.reason);
				continue;
			}

			const candidate = this.deleteCandidates.get(path);
			if (candidate === undefined) {
				const entry = this.diskIndex[path];
				if (entry === undefined) continue;
				this.deleteCandidates.set(path, {
					baselineHash: entry.contentHash,
					baselineMtime: entry.mtime,
					baselineSize: entry.size,
					firstMissingAt: now,
					firstMissingScan: scanSeq,
				});
				this.log(
					`delete-candidate path="${path}" scan=${String(scanSeq)} `
					+ `stabilityMs=${String(this.deleteStabilityMs)}`,
				);
				continue;
			}

			// Two independent clocks, both required: a scan the candidate did
			// not come from, and real elapsed time. A single scan cannot
			// confirm its own snapshot, and a fast scan period cannot shrink
			// the window a transient has to close in.
			if (scanSeq <= candidate.firstMissingScan) continue;
			if (now - candidate.firstMissingAt < this.deleteStabilityMs) continue;
			confirmed.push(path);
		}
		return confirmed;
	}

	/**
	 * Why `path`'s absence is not a deletion, or null when nothing explains it.
	 *
	 * Every check answers with a reason; only falling off the end means the
	 * daemon has positive evidence that the file is gone. Adding a check can
	 * therefore only ever make the daemon more cautious.
	 */
	private explainAbsence(path: string, evidence: AbsenceEvidence): AbsenceExplanation | null {
		if (evidence.present.has(path)) {
			return { reason: "the scan found it on disk", settled: true };
		}
		if (!evidence.active.has(path)) {
			return { reason: "the CRDT no longer holds it", settled: true };
		}
		if (this.hintedPaths.has(path)) {
			return { reason: "a watcher hint for it is still owed to the CRDT", settled: true };
		}
		const shadow = shadowedBy(path, evidence.unreadable);
		if (shadow !== null) {
			const where = shadow === "" ? "the vault root" : `"${shadow}"`;
			return { reason: `the walk could not read ${where}`, settled: false };
		}
		if (evidence.pendingWrites.has(path)) {
			return { reason: "the mirror has a write pending for it", settled: false };
		}
		if (this.diskMirror?.isSuppressed(path) === true) {
			return { reason: "the daemon wrote it moments ago", settled: false };
		}
		switch (this.host?.probePath(path) ?? "unknown") {
			case "present":
				return { reason: "an lstat still finds something at that path", settled: true };
			case "unknown":
				return { reason: "an lstat could not tell whether it is there", settled: false };
			case "absent":
				return null;
		}
	}

	/** Drop a candidate, saying why. Silent when there was none. */
	private withdrawDeleteCandidate(path: string, reason: string): void {
		if (!this.deleteCandidates.delete(path)) return;
		this.log(`delete-withdrawn path="${path}" reason=${JSON.stringify(reason)}`);
	}

	private runPeriodicReconcile(): Promise<void> {
		const vaultSync = this.vaultSync;
		const controller = this.controller;
		const host = this.host;
		if (
			this.stopping
			|| this.periodicReconcileInFlight !== null
			|| !vaultSync
			|| !controller
			|| !host
		) return Promise.resolve();

		const work = this.performPeriodicReconcile(vaultSync, controller, host);
		this.periodicReconcileInFlight = work;
		const clear = (): void => {
			if (this.periodicReconcileInFlight === work) this.periodicReconcileInFlight = null;
		};
		void work.then(clear, clear);
		return work;
	}

	private async performPeriodicReconcile(
		vaultSync: VaultSync,
		controller: ReconciliationController,
		host: NodeHost,
	): Promise<void> {
		const mode: ReconcileMode = vaultSync.getSafeReconcileMode();
		const hintedAtStart = new Set(this.hintedPaths.keys());
		try {
			let confirmedDelete = false;
			if (mode === "authoritative") {
				const deleteScan = await host.scanMarkdown();
				for (const path of this.reviewDroppedDeletes(deleteScan)) {
					const candidate = this.deleteCandidates.get(path);
					const missingForMs = candidate === undefined ? 0 : Date.now() - candidate.firstMissingAt;
					this.log(
						`delete-confirmed path="${path}" missingForMs=${String(missingForMs)} scans=2`,
					);
					this.deleteCandidates.delete(path);
					vaultSync.handleDelete(path, this.settings.deviceName);
					delete this.diskIndex[path];
					confirmedDelete = true;
				}
			}
			if (confirmedDelete) return;
			if (this.deleteCandidates.size > 0) {
				const firstPath = this.deleteCandidates.keys().next().value as string;
				this.log(
					`reconcile-deferred path="${firstPath}" deleteReview=${String(this.deleteCandidates.size)}`,
				);
				return;
			}
			this.scheduleBootstrapCatchUp("periodic");
			await this.bootstrapCatchUp;
			if (mode === "authoritative") {
				await this.admitAuthoritativeDiskChanges(await host.scanMarkdown());
			}
			await controller.runReconciliation(mode);
			if (mode === "authoritative") {
				if (PERIODIC_RECONCILE_BARRIER !== null && !this.periodicBarrierUsed) {
					this.periodicBarrierUsed = true;
					this.log(`periodic-reconcile-barrier-wait path="${PERIODIC_RECONCILE_BARRIER}"`);
					await waitForBarrierRelease(PERIODIC_RECONCILE_BARRIER);
					this.log(`periodic-reconcile-barrier-released path="${PERIODIC_RECONCILE_BARRIER}"`);
				}
				await this.persistDiskIndex();
				if (!controller.pending) {
					for (const path of hintedAtStart) this.hintedPaths.delete(path);
				}
				this.log(`reconcile-complete scan=${String(this.authoritativeScans)}`);
			}
		} catch (error) {
			this.log(`Periodic reconcile failed: ${String(error)}`);
		}
	}
	private async admitAuthoritativeDiskChanges(scan: MarkdownScan): Promise<void> {
		for (const path of scan.paths) {
			if (!this.isMarkdownPathSyncable(path) || this.hintedPaths.has(path)) continue;
			if (this.diskMirror?.isPreservedUnresolved(path)) continue;
			await this.ingestAuthoritativeDiskPath(path);
		}
	}

	private async ingestAuthoritativeDiskPath(path: string): Promise<void> {
		const host = this.host;
		const runtime = this.vaultSync;
		const ingest = this.ingestPort;
		if (!host || !runtime || !ingest) return;
		const abstractFile = host.app.vault.getAbstractFileByPath(path);
		if (!(abstractFile instanceof TFile)) return;
		let content: string;
		let contentHash: string;
		try {
			content = await host.app.vault.read(abstractFile);
			contentHash = await contentBaselineHash(content);
		} catch (error) {
			this.log(`Authoritative scan could not read "${path}": ${String(error)}`);
			return;
		}
		const activeBodyId = runtime.getFileId(path);
		const baseline = this.diskIndex[path];
		if (activeBodyId && baseline?.contentHash === contentHash) {
			this.diskIndex[path] = {
				mtime: abstractFile.stat.mtime,
				size: abstractFile.stat.size,
				contentHash,
			};
			return;
		}
		await ingest.ingestDiskFileNow(path, activeBodyId ? "modify" : "create");
	}

	private async persistDiskIndex(): Promise<void> {
		const database = this.database;
		if (!database || this.vaultSync?.hasPendingLocalWork) return;
		const pending = await database.getPendingWorkSummary();
		if (
			pending.dirtyDocuments > 0
			|| pending.pendingCandidates > 0
			|| pending.lifecycleOperations > 0
		) {
			return;
		}
		const updatedAt = Date.now();
		await database.saveDiskIndex(this.diskIndex, updatedAt);
		this.lastDiskIndexPersistedAt = updatedAt;
	}


	/**
	 * Reconcile one final authoritative disk snapshot after hint intake and
	 * periodic work have both stopped.
	 *
	 * Present paths are hash-compared through the normal ingest port. Missing
	 * paths are recoverable even when SIGTERM outran OS event delivery, but
	 * only with the same evidence used by periodic delete review: a known disk
	 * baseline, two positive absences spanning the stability window, no
	 * unreadable ancestor, and no mirror write. That second snapshot also lets
	 * an unlink-then-rename atomic save finish without becoming a false delete.
	 */
	private async drainDiskToCrdt(): Promise<void> {
		const vaultSync = this.vaultSync;
		const host = this.host;
		if (!this.ingestPort || !vaultSync || !host) return;

		const pendingHints = new Map(this.hintedPaths);
		this.hintedPaths.clear();
		const firstScan = await host.scanMarkdown();
		const firstMirror = this.diskMirror?.getDebugSnapshot();
		const firstEvidence: AbsenceEvidence = {
			present: new Set(firstScan.paths),
			active: new Set(vaultSync.getActiveMarkdownPaths()),
			unreadable: firstScan.unreadable,
			pendingWrites: new Set([
				...firstMirror?.queuedWrites ?? [],
				...firstMirror?.openPendingPaths ?? [],
			]),
		};

		const reviewPaths = new Set(Object.keys(this.diskIndex));
		for (const [path, kind] of pendingHints) {
			if (kind === "delete") reviewPaths.add(path);
		}
		const shutdownCandidates = new Map<string, DeleteCandidate>();
		const firstMissingAt = Date.now();
		for (const path of reviewPaths) {
			if (!this.isMarkdownPathSyncable(path)) continue;
			if (pendingHints.has(path) && pendingHints.get(path) !== "delete") continue;
			if (this.diskMirror?.isPreservedUnresolved(path)) continue;
			if (this.explainAbsence(path, firstEvidence) !== null) continue;

			const entry = this.diskIndex[path];
			const existing = this.deleteCandidates.get(path);
			const existingMatches = existing !== undefined
				&& entry !== undefined
				&& existing.baselineHash === entry.contentHash
				&& existing.baselineMtime === entry.mtime
				&& existing.baselineSize === entry.size;
			const candidate: DeleteCandidate = existingMatches ? existing : {
				baselineHash: entry?.contentHash,
				baselineMtime: entry?.mtime ?? 0,
				baselineSize: entry?.size ?? 0,
				firstMissingAt,
				firstMissingScan: this.authoritativeScans,
			};
			shutdownCandidates.set(path, candidate);
			this.log(
				`shutdown-delete-review path="${path}" `
				+ `stabilityMs=${String(this.deleteStabilityMs)}`,
			);
		}

		let finalScan = firstScan;
		if (shutdownCandidates.size > 0) {
			let remainingMs = 0;
			const now = Date.now();
			for (const candidate of shutdownCandidates.values()) {
				remainingMs = Math.max(
					remainingMs,
					this.deleteStabilityMs - (now - candidate.firstMissingAt),
				);
			}
			if (remainingMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
			}
			finalScan = await host.scanMarkdown();
		}

		this.log(
			`Draining final disk snapshot paths=${String(finalScan.paths.length)} `
			+ `hints=${String(pendingHints.size)} deleteReview=${String(shutdownCandidates.size)}`,
		);
		for (const path of finalScan.paths) {
			if (!this.isMarkdownPathSyncable(path)) continue;
			if (this.diskMirror?.isPreservedUnresolved(path)) continue;
			try {
				await this.ingestAuthoritativeDiskPath(path);
			} catch (error) {
				this.log(`Shutdown ingest failed for "${path}": ${String(error)}`);
			}
		}

		const finalMirror = this.diskMirror?.getDebugSnapshot();
		const finalEvidence: AbsenceEvidence = {
			present: new Set(finalScan.paths),
			active: new Set(vaultSync.getActiveMarkdownPaths()),
			unreadable: finalScan.unreadable,
			pendingWrites: new Set([
				...finalMirror?.queuedWrites ?? [],
				...finalMirror?.openPendingPaths ?? [],
			]),
		};
		for (const [path, candidate] of shutdownCandidates) {
			const explanation = this.explainAbsence(path, finalEvidence);
			if (explanation !== null) {
				if (explanation.settled) this.withdrawDeleteCandidate(path, explanation.reason);
				this.log(`Shutdown delete skipped for "${path}": ${explanation.reason}`);
				continue;
			}
			const entry = this.diskIndex[path];
			const baselineMatches = entry === undefined
				? candidate.baselineHash === undefined
					&& candidate.baselineMtime === 0
					&& candidate.baselineSize === 0
				: entry.contentHash === candidate.baselineHash
					&& entry.mtime === candidate.baselineMtime
					&& entry.size === candidate.baselineSize;
			if (!baselineMatches) {
				this.withdrawDeleteCandidate(path, "shutdown baseline changed");
				this.log(`Shutdown delete skipped for "${path}": baseline changed`);
				continue;
			}
			this.withdrawDeleteCandidate(path, "shutdown confirmed the missing path");
			vaultSync.handleDelete(path, this.settings.deviceName);
			delete this.diskIndex[path];
			this.log(`shutdown-delete path="${path}"`);
		}
	}
	// -------------------------------------------------------------------

	private buildControllerDeps(): ConstructorParameters<typeof ReconciliationController>[0] {
		// The real frontmatter policy, hosted headlessly: quarantine entries
		// live in memory because a daemon has no settings file to persist them
		// to, and the guard's decisions do not depend on their durability.
		const frontmatterGuard = new FrontmatterGuardCoordinator({
			isFrontmatterGuardEnabled: () => this.settings.frontmatterGuardEnabled,
			trace: (source, event, data) => this.trace(source, event, data),
			persistPluginState: async () => undefined,
			getFrontmatterQuarantineEntries: () => this.quarantineEntries,
			setFrontmatterQuarantineEntries: (entries) => {
				this.quarantineEntries = entries;
			},
		});

		let awaitingFirstProviderSync = false;
		return {
			app: this.host!.app,
			getSettings: () => this.settings,
			getRuntimeConfig: () => this.runtimeConfig,
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			// The headless product does not synchronize attachments, so there is
			// no blob subsystem to hand over.
			getBlobSync: () => null,
			getEditorBindings: () => this.host?.editorBindings ?? null,
			getDiskIndex: () => this.diskIndex,
			setDiskIndex: (index) => {
				this.diskIndex = index;
			},
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			shouldBlockFrontmatterIngest: (path, previousContent, nextContent, reason) =>
				frontmatterGuard.shouldBlockFrontmatterIngest(path, previousContent, nextContent, reason),
			// Capabilities gate attachments and snapshots. Both are out of
			// scope, so there is nothing to refresh.
			refreshServerCapabilities: async () => undefined,
			// Headless: there are no open editors, so there are no bindings to
			// validate and nothing to notify when a reconcile finishes.
			validateOpenEditorBindings: () => undefined,
			onReconciled: () => undefined,
			getAwaitingFirstProviderSyncAfterStartup: () => awaitingFirstProviderSync,
			setAwaitingFirstProviderSyncAfterStartup: (value) => {
				awaitingFirstProviderSync = value;
			},
			saveDiskIndex: async () => {
				await this.persistDiskIndex();
			},
			getLastSaveDiskIndexAt: () => this.lastDiskIndexPersistedAt,
			refreshStatusBar: () => undefined,
			trace: (source, msg, details) => this.trace(source, msg, details),
			scheduleTraceStateSnapshot: () => undefined,
			log: (message) => this.log(message),
			registerDiskIngestPort: (port) => {
				this.ingestPort = port;
			},
		};
	}

	private isMarkdownPathSyncable(path: string): boolean {
		return isMarkdownSyncable(
			path,
			this.runtimeConfig.excludePatterns,
			this.runtimeConfig.vaultConfigDir,
		);
	}

	private trace(source: string, msg: string, details?: Record<string, unknown>): void {
		if (!this.config.debug) return;
		this.log(`[${source}] ${msg}${details ? ` ${JSON.stringify(details)}` : ""}`);
	}

	/**
	 * Turn the provider's fatal-auth state into an error, reporting it exactly
	 * once. Both the startup path and the post-startup callback funnel through
	 * here, so a refusal that happens mid-handshake is not announced twice.
	 */
	private recordFatalAuth(): FatalAuthError {
		if (this.fatalAuth) return this.fatalAuth;
		const code = this.vaultSync?.fatalAuthCode ?? "unauthorized";
		const details = this.vaultSync?.fatalAuthDetails;
		return this.raiseFatal(new FatalAuthError(
			code,
			`Server refused the connection: ${code}` +
			(details?.reason ? ` (${details.reason})` : "") +
			(details?.roomSchemaVersion != null
				? ` [client schema ${details.clientSchemaVersion}, room schema ${details.roomSchemaVersion}]`
				: ""),
		));
	}

	private raiseFatal(error: FatalAuthError): FatalAuthError {
		if (this.fatalAuth) return this.fatalAuth;
		this.fatalAuth = error;
		this.onFatalAuthCallback?.(error);
		return error;
	}
}

