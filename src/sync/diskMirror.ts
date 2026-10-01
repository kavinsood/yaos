import { type App, MarkdownView, TFile, normalizePath } from "obsidian";
import {
	canonicalizeMarkdown,
	exactMarkdownDiskFingerprint,
} from "@shared/markdownCodec";
import type { VaultSync } from "./vaultSync";
import type { EditorBindingManager } from "./editorBinding";
import type { TraceRecord } from "../observability/traceContext";
import { formatUnknown, yTextToString } from "../utils/format";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	type FrontmatterValidationResult,
} from "./frontmatterGuard";
import { isLocalOrigin } from "./origins";
import {
	composeBodyOnlyProgress,
	composeMarkdownComponents,
	splitMarkdownComponents,
} from "./frontmatterBoundary";
import { contentBaselineHash } from "./diskIndex";
import { decideClosedFileConflict } from "./closedFileConflict";
import {
	createMarkdownConflictArtifact,
} from "../runtime/reconcile/markdownConflictArtifact";
import { PreservedUnresolvedRegistry, type PreservedUnresolvedEntry, type PreservedUnresolvedReason } from "./preservedUnresolved";
import { safeMarkdownPath } from "./pathPolicy";
import { mergeThreeWayText, type ThreeWayMergeResult } from "./threeWayMerge";
import type { BodySettlementRead, DiskSettlementFingerprint } from "./bodySettlement";
import type { ConflictEpisodes } from "./conflictEpisodes";
import { ReconciliationBackpressureError, ReconciliationWorker, reconciliationRetainedBytes } from "../runtime/reconciliationWorker";
import type { BootstrapDiskPort } from "./bootstrapClient";
import { planMarkdownAgreement } from "../sync/markdownAgreement";
import {
	StructuralIntentRecovery,
	type StructuralIntentScope,
	type StructuralIntentStore,
	type StructuralRecoveryResult,
	type StoredStructuralIntent,
} from "./structuralIntent";
export { isLocalOrigin };

export interface DiskSettlementOptions {
	conflictEpisodes?: ConflictEpisodes;
	getBaseline(path: string): {
		contentHash: string | null;
		trustedWhole?: boolean;
		lastDiskIndexPersistedAt?: number;
	} | null;
	/**
	 * Import disk content into the body. With `expectedBodyContent` the
	 * import is conditional: it applies only while the body still holds
	 * exactly the content the decision was planned against (checked in the
	 * same synchronous section as the Y transaction), else "superseded".
	 */
	commitLocalBody(input: {
		bodyId: string;
		path: string;
		content: string;
		reason: "external-edit" | "delete-revive";
		expectedBodyContent?: string;
	}): Promise<void | "completed" | "superseded">;
	getCommonBase?(bodyId: string): Promise<BodySettlementRead>;
	commitMergedBody?(input: {
		bodyId: string;
		path: string;
		expectedBodyContent: string;
		mergedContent: string;
	}): Promise<"completed" | "superseded">;
	markDivergence?(bodyId: string, state: "none" | "preserved" | "decision-required"): void;
	reviewConflict?(input: {
		path: string;
		conflict: Extract<ThreeWayMergeResult, { kind: "conflict" }>;
		stillCurrent: () => boolean;
	}): Promise<string | null>;
	settleClosedBody?(path: string): Promise<void>;
	/**
	 * The frontmatter ingest guard for disk-derived content about to be
	 * committed into the body (`next`, from the body's `current`). True:
	 * blocked (the guard records/quarantines it); nothing is committed.
	 */
	shouldBlockDiskIngest?(path: string, current: string, next: string): boolean;
	isPathAllowed?(path: string): boolean;
	isBodyLive?(bodyId: string): boolean;
}

export type DiskBodySettlement = "settled" | "replan" | "preserved-unresolved";

export interface DiskStructuralRenamePlan {
	readonly id: string;
	readonly moves: readonly {
		readonly bodyId: string;
		readonly from: string;
		readonly to: string;
		readonly temporaryPath: string;
		readonly expectedContent: string;
	}[];
}

export interface DiskStructuralRenamePlanPort {
	prepare(plan: DiskStructuralRenamePlan): Promise<void>;
	staged(plan: DiskStructuralRenamePlan): Promise<void>;
	complete(plan: DiskStructuralRenamePlan): Promise<void>;
}

export interface DiskStructuralRecoveryOptions {
	scope: StructuralIntentScope;
	store: StructuralIntentStore;
	isSourceCurrent?(): boolean;
	isPathAllowed?(path: string): boolean;
	persistMaterializedPaths(moves: readonly { bodyId: string; path: string }[]): Promise<void>;
}

export type DeleteSettlement = "deleted" | "revived" | "preserved-unresolved";

interface DiskDeleteRevival {
	kind: "revive";
	file: TFile;
	content: string;
	settlement: DiskSettlementOptions;
}


/**
 * Handles writeback from Y.Text -> disk with:
 *   - Remote-only writes (skip local yCollab/seed/disk-sync origins)
 *   - Lazy per-file Y.Text observers
 *   - Concurrency-limited write queue (prevents burst I/O on git pull)
 *   - Loop suppression via timed path suppression
 */

const DEBOUNCE_MS = 300;
const DEBOUNCE_BURST_MS = 1000;
const OPEN_FILE_IDLE_MS = 1500;
const BODY_OBSERVER_RETRY_MS = 100;
const BODY_OBSERVER_RETRY_LIMIT = 100;
const OPEN_FILE_ACTIVE_GRACE_MS = 1200;
const SUPPRESS_MS = 10_000;
const BURST_THRESHOLD = 20;
const MAX_PENDING_WRITES = 64;
const MAX_STRUCTURAL_MOVES = 64;
const MAX_STRUCTURAL_SOURCE_BYTES = 16 * 1024 * 1024;

function describeOrigin(origin: unknown, provider: unknown): string {
	if (origin === provider) return "provider-remote";
	if (typeof origin === "string") return origin;
	if (origin == null) return "null";
	if (typeof origin === "object") {
		const constructorName =
			(origin as { constructor?: { name?: string } }).constructor?.name;
		return constructorName || "object";
	}
	return formatUnknown(origin);
}

class DiskProjectionChangedError extends Error {}

class DiskMovedBeforeWriteError extends Error {
	constructor() {
		super("disk content changed before the write");
	}
}

interface SuppressionEntry {
	kind: "write" | "delete";
	expiresAt: number;
	expectedBytes?: number;
	expectedHash?: string;
	remainingAcks?: number;
}

function hashPrefix(hash: string | null | undefined): string | null {
	return typeof hash === "string" ? hash.slice(0, 12) : null;
}


export class DiskMirror {
	private suppressedPaths = new Map<string, SuppressionEntry>();
	private openPaths = new Set<string>();

	/**
	 * Tracks new paths being renamed by DiskMirror in response to remote
	 * metadata changes (handleRemoteRename). Consumed by the vault rename
	 * event handler in main.ts via consumeRemoteRename(), which both reads
	 * and removes the marker in a single call (consume-on-use, matching the
	 * suppressedPaths / consumeDeleteSuppression pattern).
	 */
	private _pendingRemoteRenameNewPaths = new Set<string>();

	/**
	 * Consume the remote-rename marker for `newPath` if present.
	 * Returns true if the rename was DiskMirror-originated (passive receiver).
	 * Removes the marker atomically — safe to call from the vault rename handler.
	 *
	 * @internal Used by main.ts vault rename handler.
	 */
	consumeRemoteRename(newPath: string): boolean {
		const normalized = normalizePath(newPath);
		if (this._pendingRemoteRenameNewPaths.has(normalized)) {
			this._pendingRemoteRenameNewPaths.delete(normalized);
			return true;
		}
		return false;
	}

	/** Deduped write queue. Order doesn't matter — deduplication does. */
	private writeQueue = new Set<string>();
	private forcedWritePaths = new Set<string>();

	/**
	 * Paths where a remote-delete was received but no baseline was available
	 * to verify local state. These files were preserved on disk to avoid data
	 * loss, but must NOT be auto-revived by later import/scan passes.
	 *
	 * A path is removed from this set when:
	 * - The user explicitly edits/creates the file (vault modify/create event)
	 * - The file is deleted locally by the user
	 * - A future remote-delete arrives with a real baseline
	 *
	 * This prevents `importUntrackedFiles()` or reconcile scans from
	 * accidentally resurrecting a legitimately deleted file.
	 */
	private preservedUnresolved: PreservedUnresolvedRegistry;
	readonly preservedUnresolvedPaths: ReadonlySet<string>;
	/** Debounce timers per path. */
	private debounceTimers = new Map<string, number>();
	private openWriteTimers = new Map<string, number>();
	private pendingOpenWrites = new Set<string>();
	private bodyObserverRetryTimers = new Map<string, number>();
	private bodyObserverRetryAttempts = new Map<string, number>();
	/** True while the drain loop is running. */
	private draining = false;
	private drainPromise: Promise<void> | null = null;
	private reconciliationWorker = new ReconciliationWorker();
	private diskScopeGeneration = 0;
	private structuralRenamePlans: DiskStructuralRenamePlanPort | null = null;
	private structuralRecoveryOptions: DiskStructuralRecoveryOptions | null = null;
	private structuralRecoveryReady = false;
	private structuralAdmissionBlocked = false;
	private pendingStructuralPaths = new Map<string, ReadonlySet<string>>();
	private structuralBookkeepingApplied = new Set<string>();

	/** Per-file Y.Text observers. Only attached for open/active files. */
	private textObservers = new Map<
		string,
		{ ytext: import("yjs").Text; handler: (event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => void }
	>();


	private _flightEventHandler: ((event: Record<string, unknown>) => void) | null = null;

	/**
	 * Called after every successful `flushWrite` with the normalized path and
	 * the SHA-256 content hash of what was written.
	 *
	 * The hash is pre-computed here (where the content is in scope) to keep
	 * the caller free of crypto concerns. Use to update disk index baselines.
	 */
	private _onDiskWriteCallback: ((path: string, contentHash: string, content: string) => void) | null = null;
	/**
	 * Expected canonical disk hash per path for writes planned on the
	 * evidence that disk still held a known state (e.g. its settled baseline).
	 * The write happens only if disk still hashes to it; otherwise disk moved
	 * after the plan (new local input) and the write is handed back.
	 */
	private expectedDiskHashes = new Map<string, string>();
	/**
	 * Per path, the body hash of the last three-way overlap that was
	 * preserved (the conflict note holds the body, C) and offered for review.
	 * While it is unresolved, further disk saves (an external tool's
	 * autosave) add nothing to preserve: no new note, no new review. A new
	 * body state is preserved again.
	 */
	private preservedOverlaps = new Map<string, string>();
	/** Paths with a three-way review modal currently open. */
	private openReviews = new Set<string>();
	private _onDiskMovedBeforeWrite: ((path: string) => void) | null = null;
	private _onPartialDiskWriteCallback: ((path: string, bodyHash: string, propertiesHash: string) => void) | null = null;

	/**
	 * Per-path timestamp of the most recent successful `flushWrite`. Updated
	 * on every `vault.modify` and `vault.create` we issue. Read by the main
	 * vault.on("modify") handler so `disk.modify.observed` events can carry
	 * a writerGuess (yaos-write vs external) for RCA.
	 */
	private lastDiskWriteOkAt = new Map<string, number>();

	private readonly debug: boolean;
	private settlement: DiskSettlementOptions | null = null;


	constructor(
		private app: App,
		private vaultSync: VaultSync,
		private editorBindings: EditorBindingManager,
		debug: boolean,
		private trace?: TraceRecord,
		private frontmatterGuardEnabled: () => boolean = () => true,
		private onFrontmatterValidated?: (
			path: string,
			direction: "crdt-to-disk",
			reason: "flush-write",
			validation: FrontmatterValidationResult,
			previousContent: string | null,
			nextContent: string,
		) => void,
		private getDeviceName: () => string = () => "unknown-device",
		initialPreservedUnresolved: PreservedUnresolvedEntry[] = [],
		private onPreservedUnresolvedChanged?: () => void,
	) {
		this.debug = debug;
		this.preservedUnresolved = new PreservedUnresolvedRegistry(
			initialPreservedUnresolved.filter((entry) => entry.kind === "markdown"),
		);
		this.preservedUnresolvedPaths = this.preservedUnresolved.paths;
	}

	setFlightEventHandler(handler: (event: Record<string, unknown>) => void): void {
		this._flightEventHandler = handler;
	}

	/**
	 * Register a callback that fires after every successful `flushWrite`.
	 * The callback receives the normalized path and the SHA-256 hash of the
	 * content written (pre-computed in diskMirror to avoid redundant re-reads).
	 * Use this to update content-hash baselines in the disk index.
	 */
	setDiskWriteCallback(callback: (path: string, contentHash: string, content: string) => void): void {
		this._onDiskWriteCallback = callback;
	}
	/**
	 * Register the re-plan hook for a planned write that found disk changed
	 * underneath it (see `scheduleWrite`'s `expectedDiskHash`, and the
	 * compare-and-swap immediately before every modify). Nothing was written.
	 */
	setDiskMovedBeforeWriteHandler(handler: ((path: string) => void) | null): void {
		this._onDiskMovedBeforeWrite = handler;
	}
	setPartialDiskWriteCallback(callback: (path: string, bodyHash: string, propertiesHash: string) => void): void {
		this._onPartialDiskWriteCallback = callback;
	}
	configureSettlement(options: DiskSettlementOptions | null): void {
		this.settlement = options;
	}
	markPendingPath(path: string, bodyId: string): void {
		this.vaultSync.markPendingRenameTarget(normalizePath(path), bodyId);
	}

	clearPendingPath(path: string, bodyId: string): void {
		this.vaultSync.clearPendingRenameTarget(normalizePath(path), bodyId);
	}


	setReconciliationWorker(worker: ReconciliationWorker): void {
		const diagnostics = this.reconciliationWorker.diagnostics();
		if (diagnostics.active > 0 || diagnostics.queued > 0) throw new Error("cannot replace an active reconciliation worker");
		this.resetReconciliationScope();
		this.reconciliationWorker = worker;
	}

	getReconciliationWorker(): ReconciliationWorker {
		return this.reconciliationWorker;
	}

	getBootstrapDiskPort(): BootstrapDiskPort {
		return {
			settleBody: (input) => this.settleBody(input),
			moveBodies: (moves) => this.moveBodies(moves),
			settleRename: (input) => this.settleRename(input),
			deleteBody: (input) => this.deleteBody(input),
			discardStaleBody: (input) => this.discardStaleBody(input),
			markPendingPath: (path, bodyId) => this.markPendingPath(path, bodyId),
			clearPendingPath: (path, bodyId) => this.clearPendingPath(path, bodyId),
			readCanonicalDiskEvidence: (path) => this.readCanonicalDiskEvidenceQueued(path),
		};
	}

	resetReconciliationScope(): void {
		this.invalidateDiskScope();
	}

	invalidateDiskScope(): void {
		this.diskScopeGeneration++;
	}

	setStructuralRenamePlanPort(port: DiskStructuralRenamePlanPort | null): void {
		this.structuralRenamePlans = port;
	}

	configureStructuralRecovery(options: DiskStructuralRecoveryOptions | null): void {
		const diagnostics = this.reconciliationWorker.diagnostics();
		if (diagnostics.active > 0 || diagnostics.queued > 0) throw new Error("cannot replace active structural recovery storage");
		this.structuralRecoveryOptions = options === null ? null : { ...options, scope: { ...options.scope } };
		this.structuralRecoveryReady = false;
	}

	isStructuralPathPending(path: string): boolean {
		if (this.structuralAdmissionBlocked) return true;
		if (this.isStructuralStagingPath(path)) return true;
		if (this.structuralRecoveryOptions !== null && !this.structuralRecoveryReady) return true;
		const normalized = normalizePath(path);
		return [...this.pendingStructuralPaths.values()].some((paths) => paths.has(normalized));
	}

	private isStructuralStagingPath(path: string): boolean {
		const parts = normalizePath(path).split("/");
		const basename = parts[parts.length - 1] ?? path;
		return /^(?:YAOS)?\.yaos-moving-[a-f0-9-]+\.md$/.test(basename);
	}

	async recoverStructuralIntents(): Promise<StructuralRecoveryResult[]> {
		const options = this.structuralRecoveryOptions;
		if (!options) return [];
		const isScopeCurrent = this.captureDiskScope([]);
		return this.reconciliationWorker.run(async () => {
			const recovery = this.createStructuralRecovery(options, isScopeCurrent);
			const intents = await options.store.list();
			if (!isScopeCurrent() || this.structuralRecoveryOptions !== options) throw new DiskProjectionChangedError();
			this.pendingStructuralPaths.clear();
			for (const intent of intents) this.trackStructuralIntent(intent);
			const results: StructuralRecoveryResult[] = [];
			for (const intent of intents) {
				const result = await recovery.recover(intent.operationId);
				if (!isScopeCurrent()) throw new DiskProjectionChangedError();
				this.finishStructuralRecovery(intent, result);
				results.push(result);
			}
			this.structuralRecoveryReady = true;
			return results;
		});
	}

	private trackStructuralIntent(intent: StoredStructuralIntent): void {
		this.pendingStructuralPaths.set(intent.operationId, new Set(intent.moves.flatMap((move) => [move.from, move.staging, move.to])));
	}

	private finishStructuralRecovery(intent: StoredStructuralIntent, result: StructuralRecoveryResult): void {
		if (result.status === "blocked") {
			for (const path of this.pendingStructuralPaths.get(intent.operationId) ?? []) this.recordPreservedUnresolved(path, "structural-batch-failed");
			this._flightEventHandler?.({
				priority: "critical", kind: "disk.structural.recovery.blocked", severity: "error", scope: "file",
				source: "diskMirror", layer: "disk", path: result.path,
				data: { operationId: result.operationId, reason: result.reason },
			});
			return;
		}
		this.pendingStructuralPaths.delete(intent.operationId);
		this.structuralBookkeepingApplied.delete(intent.operationId);
		for (const path of intent.moves.flatMap((move) => [move.from, move.staging, move.to])) {
			if (this.preservedUnresolved.get(path)?.reason === "structural-batch-failed") this.clearPreservedUnresolved(path);
		}
	}

	private createStructuralRecovery(options: DiskStructuralRecoveryOptions, isScopeCurrent: () => boolean): StructuralIntentRecovery {
		const verifyScope = () => {
			if (!isScopeCurrent() || this.structuralRecoveryOptions !== options) throw new DiskProjectionChangedError();
		};
		const isPathAllowed = (path: string) => safeMarkdownPath(path) === path
			&& normalizePath(path) === path && (this.isStructuralStagingPath(path) || options.isPathAllowed?.(path) !== false);
		const store: StructuralIntentStore = {
			get: async (operationId) => {
				verifyScope();
				const intent = await options.store.get(operationId);
				verifyScope();
				return intent;
			},
			list: async () => {
				verifyScope();
				const intents = await options.store.list();
				verifyScope();
				return intents;
			},
			put: async (intent) => {
				verifyScope();
				await options.store.put(intent);
				verifyScope();
			},
			delete: async (operationId) => {
				verifyScope();
				await options.store.delete(operationId);
				verifyScope();
			},
		};
		return new StructuralIntentRecovery(options.scope, store, {
			inspect: async (path) => {
				verifyScope();
				if (!isPathAllowed(path)) return { kind: "other" };
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!file) return { kind: "missing" };
				if (!(file instanceof TFile)) return { kind: "other" };
				const content = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
				verifyScope();
				if (!this.isFileCurrent(file, path)) throw new DiskProjectionChangedError();
				return { kind: "file", content };
			},
			moveIfMatches: async (input) => {
				verifyScope();
				if (!isPathAllowed(input.from) || !isPathAllowed(input.to)) return false;
				const file = this.app.vault.getAbstractFileByPath(input.from);
				if (!(file instanceof TFile) || this.app.vault.getAbstractFileByPath(input.to)) return false;
				const content = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
				const fingerprint = await exactMarkdownDiskFingerprint(content);
				verifyScope();
				if (!this.isFileCurrent(file, input.from) || content !== input.expectedContent
					|| fingerprint.bytes !== input.fingerprint.bytes || fingerprint.hash !== input.fingerprint.hash
					|| this.app.vault.getAbstractFileByPath(input.to)) return false;
				this.markPendingPath(input.to, input.bodyId);
				try {
					await this.renameFileUnqueued(file, input.from, input.to, input.expectedContent, isScopeCurrent);
					verifyScope();
					return true;
				} catch (error) {
					if (error instanceof DiskMovedBeforeWriteError) return false;
					throw error;
				} finally {
					this.clearPendingPath(input.to, input.bodyId);
					this.expireRemoteRenameMarkers([input.to]);
				}
			},
			completeBookkeeping: async (intent) => {
				verifyScope();
				await options.persistMaterializedPaths(intent.moves.map((move) => ({ bodyId: move.bodyId, path: move.to })));
				verifyScope();
				for (const move of intent.moves) {
					const file = this.app.vault.getAbstractFileByPath(move.to);
					if (!(file instanceof TFile)) throw new DiskProjectionChangedError();
					const content = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
					verifyScope();
					if (!this.isFileCurrent(file, move.to) || content !== move.expectedContent) throw new DiskMovedBeforeWriteError();
				}
				if (!this.structuralBookkeepingApplied.has(intent.operationId)) {
					this.editorBindings.updatePathsAfterRename(new Map(intent.moves.map((move) => [move.from, move.to])));
					this.structuralBookkeepingApplied.add(intent.operationId);
				}
				this.forgetPathPlans(intent.moves.flatMap((move) => [move.from, move.staging, move.to]));
			},
		});
	}

	private captureDiskScope(paths: readonly string[]): () => boolean {
		const generation = this.diskScopeGeneration;
		const runtime = this.vaultSync;
		const bindings = paths.map((path) => [path, runtime.getFileId(path)] as const);
		const recoveryOptions = this.structuralRecoveryOptions;
		const isSourceCurrent = () => recoveryOptions?.isSourceCurrent?.() ?? true;
		return () => this.reconciliationWorker.isOperational && generation === this.diskScopeGeneration && runtime === this.vaultSync && isSourceCurrent()
			&& bindings.every(([path, bodyId]) => runtime.getFileId(path) === bodyId);
	}

	private hasPendingBodyWork(bodyId: string): boolean {
		const body = this.vaultSync.bodies.get?.(bodyId);
		return body !== null && body !== undefined
			&& (body.dirty || body.unsettled > 0 || body.pendingLocalUpdates > 0);
	}

	async settleBody(input: {
		path: string;
		bodyId: string;
		generation: number;
		content: string;
		/**
		 * Exact content of the last disk/body agreement, when the caller
		 * knows it. Takes precedence over the stored common base.
		 */
		baseContent?: string;
		/**
		 * What to do when disk and body both moved and no common base is
		 * available. "preserve" (default) leaves both untouched and unresolved;
		 * "preserve-disk" saves disk as a conflict artifact, then projects the
		 * body (the durable, converged state) to disk.
		 */
		onMissingBase?: "preserve" | "preserve-disk";
	}): Promise<DiskBodySettlement> {
		const path = this.acceptPath(input.path);
		if (!path) return "preserved-unresolved";
		const isScopeCurrent = this.captureDiskScope([path]);
		return this.reconciliationWorker.run<DiskBodySettlement>(async () => {
			if (!isScopeCurrent() || this.vaultSync.getFileId(path) !== input.bodyId) return "replan";
			if (this.isStructuralPathPending(path)) return "preserved-unresolved";
			if (this.hasPendingBodyWork(input.bodyId)) return "replan";
			const source = this.vaultSync.getTextForPath?.(path);
			const sourceContent = source ? yTextToString(source) : null;
			if (sourceContent !== null && canonicalizeMarkdown(sourceContent) !== canonicalizeMarkdown(input.content)) return "replan";
			let lease;
			try {
				lease = this.vaultSync.bodies.coordinator.acquireProjection(
					path,
					input.bodyId,
					"disk",
					crypto.randomUUID(),
				);
			} catch {
				this.recordPreservedUnresolved(path, "body-open-deferred");
				return "preserved-unresolved";
			}
			try {
				const proof = this.vaultSync.bodies.captureRevision(input.bodyId);
				const isCurrent = () => isScopeCurrent() && !this.hasPendingBodyWork(input.bodyId)
					&& this.vaultSync.bodies.coordinator.isProjectionCurrent(proof, path);
				const outcome = await this.settleBodyUnlocked({
					...input,
					path,
					content: canonicalizeMarkdown(input.content),
				}, isCurrent, isScopeCurrent);
				if (!isScopeCurrent()) return "replan";
				if (outcome === "settled") {
					// Disk and body agree: older closed-write plans are void.
					this.expectedDiskHashes.delete(path);
					this.preservedOverlaps.delete(path);
				}
				return outcome;
			} finally {
				lease.release();
			}
		}, { retainedBytes: reconciliationRetainedBytes(input.content, input.baseContent), label: "settle-body" });
	}
	async discardStaleBody(input: {
		path: string;
		bodyId: string;
		expectedContent: string;
	}): Promise<boolean> {
		const path = this.acceptPath(input.path);
		if (!path) return false;
		const expectedContent = canonicalizeMarkdown(input.expectedContent);
		const isScopeCurrent = this.captureDiskScope([path]);
		return this.reconciliationWorker.run(async () => {
			if (!isScopeCurrent()) return false;
			if (this.isStructuralPathPending(path)) return false;
			const boundBodyId = this.vaultSync.getFileId(path);
			if (boundBodyId !== undefined && boundBodyId !== input.bodyId) return false;
			if (this.openPaths.has(path) || this.editorBindings.isBound(path)) {
				this.recordPreservedUnresolved(path, "body-open-deferred");
				return false;
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return true;
			let content: string;
			try {
				content = canonicalizeMarkdown(await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file)));
			} catch {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return false;
			}
			if (!isScopeCurrent() || !this.isFileCurrent(file, path)) return false;
			if (content !== expectedContent) {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return false;
			}

			this.suppressDelete(path, 2);
			if (!isScopeCurrent()) return false;
			await this.deleteLocalReplica(file, path);
			if (!isScopeCurrent()) return false;
			this.clearPreservedUnresolved(path);
			this.forgetPathPlans([path]);
			this.log(`discarded stale settlement for ${input.bodyId} at "${path}"`);
			return true;
		}, { retainedBytes: reconciliationRetainedBytes(input.expectedContent, expectedContent), label: "discard-stale-body" });
	}
	async settleRename(input: {
		from: string;
		to: string;
		bodyId: string;
		currentContent: string;
	}): Promise<"moved" | "source-absent" | "source-deleted" | "preserved-unresolved"> {
		const from = this.acceptPath(input.from);
		const to = this.acceptPath(input.to);
		if (!from || !to) return "preserved-unresolved";
		if (from === to) return "moved";
		const isScopeCurrent = this.captureDiskScope([from, to]);
		return this.reconciliationWorker.run(() => this.settleRenameUnqueued({ ...input, from, to }, isScopeCurrent), {
			retainedBytes: reconciliationRetainedBytes(input.currentContent), label: "settle-rename",
		});
	}

	private async settleRenameUnqueued(input: {
		from: string;
		to: string;
		bodyId: string;
		currentContent: string;
	}, isScopeCurrent: () => boolean): Promise<"moved" | "source-absent" | "source-deleted" | "preserved-unresolved"> {
		const from = this.acceptPath(input.from);
		const to = this.acceptPath(input.to);
		if (!from || !to) return "preserved-unresolved";
		if (!isScopeCurrent()) return "preserved-unresolved";
		if (this.isStructuralPathPending(from) || this.isStructuralPathPending(to)) return "preserved-unresolved";
		const boundBodyId = this.vaultSync.getFileId(to);
		if (boundBodyId !== undefined && boundBodyId !== input.bodyId) return "preserved-unresolved";
		const currentContent = canonicalizeMarkdown(input.currentContent);
		const source = this.app.vault.getAbstractFileByPath(from);
		if (!(source instanceof TFile)) return "source-absent";
		const target = this.app.vault.getAbstractFileByPath(to);
		if (target instanceof TFile) {
			const sourceContent = canonicalizeMarkdown(await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(source)));
			if (!isScopeCurrent()) return "preserved-unresolved";
			const targetContent = canonicalizeMarkdown(await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(target)));
			if (!isScopeCurrent() || !this.isFileCurrent(source, from) || !this.isFileCurrent(target, to)) return "preserved-unresolved";
			if (
				sourceContent !== currentContent
				|| targetContent !== currentContent
				|| this.openPaths.has(from)
				|| this.editorBindings.isBound(from)
			) {
				this.recordPreservedUnresolved(from, "path-collision");
				return "preserved-unresolved";
			}
			this.suppressDelete(from, 2);
			if (!isScopeCurrent()) return "preserved-unresolved";
			await this.deleteLocalReplica(source, from);
			if (!isScopeCurrent()) return "preserved-unresolved";
			this.clearPreservedUnresolved(from);
			this.forgetPathPlans([from]);
			this.log(`removed exact previous rename source "${from}" for ${input.bodyId}`);
			return "source-deleted";
		}
		if (target) {
			this.recordPreservedUnresolved(from, "path-collision");
			return "preserved-unresolved";
		}
		await this.moveBodiesUnqueued([{ from, to, bodyId: input.bodyId }], isScopeCurrent);
		return "moved";
	}


	async moveBodies(moves: Array<{ from: string; to: string; bodyId: string }>): Promise<void> {
		if (moves.length > MAX_STRUCTURAL_MOVES) {
			this.blockStructuralAdmission();
			throw new ReconciliationBackpressureError("Rename batch exceeds 64 moves. Retry smaller independent batches; oversized cycles must remain unresolved with source files unchanged.");
		}
		const normalized = moves.map((move) => {
			const from = this.acceptPath(move.from);
			const to = this.acceptPath(move.to);
			if (!from || !to) throw new Error("structural batch contains an unsafe path");
			return { ...move, from, to };
		}).filter((move) => move.from !== move.to);
		if (normalized.length === 0) return;
		const sourceBytes = normalized.reduce((total, move) => {
			const source = this.app.vault.getAbstractFileByPath(move.from);
			return total + (source instanceof TFile ? Math.max(0, source.stat.size) * 2 : 0);
		}, 0);
		if (sourceBytes > MAX_STRUCTURAL_SOURCE_BYTES) {
			this.blockStructuralAdmission();
			throw new ReconciliationBackpressureError("Rename batch exceeds the 16 MiB retained source-text limit. Retry smaller independent batches; source files and durable plans remain unchanged.");
		}
		const isScopeCurrent = this.captureDiskScope(normalized.flatMap((move) => [move.from, move.to]));
		return this.reconciliationWorker.run(() => this.moveBodiesUnqueued(normalized, isScopeCurrent, sourceBytes), {
			retainedBytes: sourceBytes * 2 + normalized.reduce((total, move) => total + 128
				+ reconciliationRetainedBytes(move.from, move.to, move.bodyId, move.from, move.to, move.bodyId, move.bodyId), 0),
			label: "structural-move-batch",
		}).catch((error: unknown) => {
			if (error instanceof ReconciliationBackpressureError) this.blockStructuralAdmission();
			throw error;
		});
	}

	private async moveBodiesUnqueued(moves: Array<{ from: string; to: string; bodyId: string }>, isScopeCurrent: () => boolean, reservedSourceBytes = MAX_STRUCTURAL_SOURCE_BYTES): Promise<void> {
		if (!isScopeCurrent()) throw new DiskProjectionChangedError();
		if (moves.some((move) => this.isStructuralPathPending(move.from) || this.isStructuralPathPending(move.to))) {
			throw new Error("Structural recovery must finish before another disk rename");
		}
		if (moves.length === 1) {
			const move = moves[0]!;
			const boundBodyId = this.vaultSync.getFileId(move.to);
			if (boundBodyId !== undefined && boundBodyId !== move.bodyId) throw new DiskProjectionChangedError();
		}
		const fromPaths = new Set<string>();
		const toPaths = new Set<string>();
		for (const move of moves) {
			if (fromPaths.has(move.from)) throw new Error(`Duplicate move source: ${move.from}`);
			if (toPaths.has(move.to)) throw new Error(`Duplicate move destination: ${move.to}`);
			fromPaths.add(move.from);
			toPaths.add(move.to);
		}
		const sources: Array<{ move: typeof moves[number]; file: TFile; content: string }> = [];
		let retainedSourceBytes = 0;
		for (const move of moves) {
			const target = this.app.vault.getAbstractFileByPath(move.to);
			if (target && !fromPaths.has(move.to)) throw new Error(`Move destination already exists: ${move.to}`);
			const source = this.app.vault.getAbstractFileByPath(move.from);
			if (!source) continue;
			if (!(source instanceof TFile)) throw new Error(`Move source is not a file: ${move.from}`);
			const content = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(source));
			if (!this.isFileCurrent(source, move.from)) throw new DiskProjectionChangedError();
			retainedSourceBytes += reconciliationRetainedBytes(content);
			if (retainedSourceBytes > MAX_STRUCTURAL_SOURCE_BYTES || retainedSourceBytes > reservedSourceBytes) {
				this.blockStructuralAdmission();
				throw new ReconciliationBackpressureError("Rename source text exceeds its bounded reservation or changed during planning. Retry smaller independent batches; all source files and durable plans remain unchanged.");
			}
			sources.push({ move, file: source, content });
		}
		if (sources.length === 0) return;
		if (sources.length === 1 && !this.app.vault.getAbstractFileByPath(sources[0]!.move.to)) {
			const source = sources[0]!;
			await this.renameFileUnqueued(source.file, source.move.from, source.move.to, source.content, isScopeCurrent);
			if (!isScopeCurrent()) throw new DiskProjectionChangedError();
			await this.structuralRecoveryOptions?.persistMaterializedPaths([{ bodyId: source.move.bodyId, path: source.move.to }]);
			if (!isScopeCurrent()) throw new DiskProjectionChangedError();
			this.editorBindings.updatePathsAfterRename(new Map([[source.move.from, source.move.to]]));
			this.forgetPathPlans([source.move.from, source.move.to]);
			this.clearPendingPath(source.move.to, source.move.bodyId);
			this.expireRemoteRenameMarkers([source.move.to]);
			return;
		}
		const port = this.structuralRenamePlans;
		const recoveryOptions = this.structuralRecoveryOptions;
		if (!recoveryOptions && (!port || typeof port.staged !== "function")) throw new Error("Multi-step disk rename requires durable structural plan storage");
		const temporaryPaths = new Set<string>();
		const plan: DiskStructuralRenamePlan = Object.freeze({
			id: crypto.randomUUID(),
			moves: Object.freeze(sources.map(({ move, content }) => {
				const slash = move.from.lastIndexOf("/");
				const directory = slash >= 0 ? move.from.slice(0, slash + 1) : "";
				let temporaryPath: string;
				do {
					temporaryPath = `${directory}YAOS.yaos-moving-${crypto.randomUUID()}.md`;
				} while (this.app.vault.getAbstractFileByPath(temporaryPath) || temporaryPaths.has(temporaryPath)
					|| fromPaths.has(temporaryPath) || toPaths.has(temporaryPath));
				temporaryPaths.add(temporaryPath);
				return Object.freeze({ ...move, temporaryPath, expectedContent: content });
			})),
		});
		if (recoveryOptions) {
			const intent: StoredStructuralIntent = {
				format: 1, kind: "rename-batch", phase: "staging", operationId: plan.id,
				scope: { ...recoveryOptions.scope }, createdAt: Date.now(),
				moves: await Promise.all(plan.moves.map(async (move) => ({
					bodyId: move.bodyId, from: move.from, staging: move.temporaryPath, to: move.to,
					expectedContent: move.expectedContent, fingerprint: await exactMarkdownDiskFingerprint(move.expectedContent),
				}))),
			};
			if (!isScopeCurrent()) throw new DiskProjectionChangedError();
			this.trackStructuralIntent(intent);
			try {
				const recovery = this.createStructuralRecovery(recoveryOptions, isScopeCurrent);
				await recovery.prepare(intent);
				const result = await recovery.recover(intent.operationId);
				if (!isScopeCurrent()) throw new DiskProjectionChangedError();
				this.finishStructuralRecovery(intent, result);
				if (result.status === "blocked") throw new Error(`Structural rename blocked at ${result.path}: ${result.reason}`);
			} catch (error) {
				for (const path of this.pendingStructuralPaths.get(intent.operationId) ?? []) this.recordPreservedUnresolved(path, "structural-batch-failed");
				throw error;
			}
			return;
		}
		await port!.prepare(plan);
		try {
			for (const [index, move] of plan.moves.entries()) {
				if (!isScopeCurrent()) throw new DiskProjectionChangedError();
				this.markPendingPath(move.temporaryPath, move.bodyId);
				await this.renameFileUnqueued(sources[index]!.file, move.from, move.temporaryPath, move.expectedContent, isScopeCurrent);
			}
			if (!isScopeCurrent()) throw new DiskProjectionChangedError();
			await port!.staged(plan);
			for (const [index, move] of plan.moves.entries()) {
				if (!isScopeCurrent()) throw new DiskProjectionChangedError();
				this.markPendingPath(move.to, move.bodyId);
				await this.renameFileUnqueued(sources[index]!.file, move.temporaryPath, move.to, move.expectedContent, isScopeCurrent);
				this.clearPendingPath(move.temporaryPath, move.bodyId);
			}
			for (const [index, move] of plan.moves.entries()) {
				const file = sources[index]!.file;
				const content = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
				if (!isScopeCurrent() || !this.isFileCurrent(file, move.to) || content !== move.expectedContent
					|| this.app.vault.getAbstractFileByPath(move.temporaryPath)) throw new DiskProjectionChangedError();
			}
			if (!isScopeCurrent()) throw new DiskProjectionChangedError();
			this.editorBindings.updatePathsAfterRename(new Map(plan.moves.map((move) => [move.from, move.to])));
			this.forgetPathPlans(plan.moves.flatMap((move) => [move.from, move.to]));
			await port!.complete(plan);
		} catch (error) {
			for (const move of plan.moves) {
				this.recordPreservedUnresolved(move.from, "structural-batch-failed");
				this.recordPreservedUnresolved(move.to, "structural-batch-failed");
				if (this.app.vault.getAbstractFileByPath(move.temporaryPath)) this.recordPreservedUnresolved(move.temporaryPath, "structural-batch-failed");
			}
			throw error;
		} finally {
			for (const move of plan.moves) {
				this.clearPendingPath(move.temporaryPath, move.bodyId);
				this.clearPendingPath(move.to, move.bodyId);
			}
			this.expireRemoteRenameMarkers(plan.moves.flatMap((move) => [move.temporaryPath, move.to]));
		}
	}

	private async renameFileUnqueued(file: TFile, from: string, to: string, expectedContent: string, isScopeCurrent: () => boolean): Promise<void> {
		const verifySource = () => {
			if (!isScopeCurrent() || !this.isFileCurrent(file, from)) throw new DiskProjectionChangedError();
			if (this.app.vault.getAbstractFileByPath(to)) throw new Error(`Move destination already exists: ${to}`);
		};
		verifySource();
		await this.ensureParentFolder(to, verifySource);
		await this.suppressWrite(to, expectedContent, 2);
		const content = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
		verifySource();
		if (content !== expectedContent) throw new DiskMovedBeforeWriteError();
		this.suppressDelete(from, 2);
		this._pendingRemoteRenameNewPaths.add(to);
		await this.reconciliationWorker.io("fileManager.renameFile", () => this.app.fileManager.renameFile(file, to));
	}

	private expireRemoteRenameMarkers(paths: readonly string[]): void {
		window.setTimeout(() => {
			for (const path of paths) this._pendingRemoteRenameNewPaths.delete(path);
		}, SUPPRESS_MS);
	}


	async deleteBody(input: {
		path: string;
		bodyId: string;
		generation: number;
		baselineContent?: string | null;
	}): Promise<DeleteSettlement> {
		const path = this.acceptPath(input.path);
		if (!path) return "preserved-unresolved";
		const isScopeCurrent = this.captureDiskScope([path]);
		const outcome = await this.reconciliationWorker.run(() => this.deleteBodyUnqueued({ ...input, path }, isScopeCurrent), {
			retainedBytes: reconciliationRetainedBytes(input.baselineContent), label: "delete-body",
		});
		if (typeof outcome === "string") return outcome;
		if (!isScopeCurrent() || !this.isFileCurrent(outcome.file, path)) return "preserved-unresolved";
		try {
			const committed = await outcome.settlement.commitLocalBody({
				bodyId: input.bodyId, path, content: outcome.content, reason: "delete-revive",
			});
			if (!isScopeCurrent() || committed === "superseded") return "preserved-unresolved";
			return await this.reconciliationWorker.run<DeleteSettlement>(async () => {
				if (!isScopeCurrent() || !this.isFileCurrent(outcome.file, path)) return "preserved-unresolved";
				const content = canonicalizeMarkdown(await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(outcome.file)));
				if (!isScopeCurrent() || !this.isFileCurrent(outcome.file, path) || content !== outcome.content) return "preserved-unresolved";
				this.clearPreservedUnresolved(path);
				return "revived";
			}, { retainedBytes: reconciliationRetainedBytes(outcome.content, input.baselineContent), label: "verify-delete-revival" });
		} catch {
			if (isScopeCurrent()) this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
	}

	private async deleteBodyUnqueued(input: {
		path: string;
		bodyId: string;
		generation: number;
		baselineContent?: string | null;
	}, isScopeCurrent: () => boolean): Promise<DeleteSettlement | DiskDeleteRevival> {
		if (!isScopeCurrent()) return "preserved-unresolved";
		if (this.isStructuralPathPending(input.path)) return "preserved-unresolved";
		const boundBodyId = this.vaultSync.getFileId(input.path);
		if (boundBodyId !== undefined && boundBodyId !== input.bodyId) return "preserved-unresolved";
		const path = this.acceptPath(input.path);
		if (!path) return "preserved-unresolved";
		if (
			this.settlement?.isBodyLive?.(input.bodyId)
			|| this.openPaths.has(path)
			|| this.editorBindings.isBound(path)
		) {
			this.recordPreservedUnresolved(path, "body-open-deferred");
			return "preserved-unresolved";
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			if (file) {
				this.recordPreservedUnresolved(path, "path-collision");
				return "preserved-unresolved";
			}
			await this.settlement?.conflictEpisodes?.close(input.bodyId);
			if (!isScopeCurrent()) return "preserved-unresolved";
			this.clearPreservedUnresolved(path);
			return "deleted";
		}

		let diskContent: string;
		try {
			diskContent = canonicalizeMarkdown(await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file)));
		} catch {
			this.recordPreservedUnresolved(path, "remote-delete-read-failed");
			return "preserved-unresolved";
		}
		if (!isScopeCurrent() || !this.isFileCurrent(file, path)) return "preserved-unresolved";
		if (input.baselineContent == null) {
			this.recordPreservedUnresolved(path, "remote-delete-missing-baseline");
			return "preserved-unresolved";
		}
		if (diskContent !== canonicalizeMarkdown(input.baselineContent)) {
			if (!this.settlement) {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return "preserved-unresolved";
			}
			return { kind: "revive", file, content: diskContent, settlement: this.settlement };
		}

		if (this.settlement?.isBodyLive?.(input.bodyId) || this.openPaths.has(path) || this.editorBindings.isBound(path)) {
			this.recordPreservedUnresolved(path, "body-open-deferred");
			return "preserved-unresolved";
		}
		this.editorBindings.unbindByPath(path);
		this.suppressDelete(path, 2);
		if (!isScopeCurrent()) return "preserved-unresolved";
		await this.deleteLocalReplica(file, path);
		if (!isScopeCurrent()) return "preserved-unresolved";
		if (this.app.vault.getAbstractFileByPath(path)) {
			this.recordPreservedUnresolved(path, "path-collision");
			return "preserved-unresolved";
		}
		await this.settlement?.conflictEpisodes?.close(input.bodyId);
		if (!isScopeCurrent()) return "preserved-unresolved";
		this.clearPreservedUnresolved(path);
		this.forgetPathPlans([path]);
		return "deleted";
	}


	private acceptPath(path: string): string | null {
		const canonical = safeMarkdownPath(path);
		if (!canonical || this.settlement?.isPathAllowed?.(canonical) === false) {
			this.log(`disk mutation rejected unsafe path "${path}"`);
			return null;
		}
		return normalizePath(canonical);
	}

	// -------------------------------------------------------------------
	// Map observers (structural: add/delete)
	// -------------------------------------------------------------------


	/**
	 * Reverse-lookup: given a Y.Text instance, find the fileId.
	 * Uses VaultSync's WeakMap for O(1) lookup, with O(n) fallback.
	 */

	// -------------------------------------------------------------------
	// Per-file observers (lazy)
	// -------------------------------------------------------------------

	notifyFileOpened(path: string): void {
		path = normalizePath(path);
		if (
			"acquireEditorBody" in this.vaultSync
			&& typeof this.vaultSync.acquireEditorBody === "function"
		) {
			this.scheduleBodyObserverRetry(path);
		}
		this.trace?.("disk", "notifyFileOpened", { path });
		this.openPaths.add(path);
		// The editor is the authority for an open note; closed-note write plans
		// (and their disk expectations) no longer apply.
		this.expectedDiskHashes.delete(path);
		if (this.writeQueue.delete(path)) {
			this.forcedWritePaths.delete(path);
			this.scheduleOpenWrite(path);
		}
		const closedTimer = this.debounceTimers.get(path);
		if (closedTimer) {
			window.clearTimeout(closedTimer);
			this.debounceTimers.delete(path);
			this.writeQueue.delete(path);
			this.scheduleOpenWrite(path);
		}
		this.observeText(path);
	}

	notifyFileClosed(path: string): void {
		path = normalizePath(path);
		this.trace?.("disk", "notifyFileClosed", { path });
		this.openPaths.delete(path);
		// Flush any pending debounce for this path
		const bodyRetry = this.bodyObserverRetryTimers.get(path);
		if (bodyRetry !== undefined) window.clearTimeout(bodyRetry);
		this.bodyObserverRetryTimers.delete(path);
		this.bodyObserverRetryAttempts.delete(path);
		const timer = this.debounceTimers.get(path);
		if (timer) {
			window.clearTimeout(timer);
			this.debounceTimers.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		}
		const openTimer = this.openWriteTimers.get(path);
		if (openTimer) {
			window.clearTimeout(openTimer);
			this.openWriteTimers.delete(path);
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		} else if (this.pendingOpenWrites.delete(path)) {
			this.queueImmediateWrite(path, "file-closed");
		}
		this.unobserveText(path);
		if (this.settlement?.settleClosedBody) {
			const isScopeCurrent = this.captureDiskScope([path]);
			void this.settlement.settleClosedBody(path).catch(() => {
				if (isScopeCurrent()) this.recordPreservedUnresolved(path, "body-settlement-failed");
			});
		}
	}

	private observeText(path: string): void {
		const ytext = this.vaultSync.getTextForPath(path);
		const existing = this.textObservers.get(path);
		if (!ytext) {
			if (existing) this.unobserveText(path);
			return;
		}
		if (existing?.ytext === ytext) return;
		if (existing) this.unobserveText(path);

		const handler = (_event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => {
			const bodyOrigin = this.vaultSync.getBodyOrigin(path);
			if (isLocalOrigin(txn.origin, bodyOrigin)) return;
			const originLabel = describeOrigin(txn.origin, bodyOrigin);
			this.log(`text observer: remote change to "${path}" (origin=${originLabel})`);
			this.scheduleWrite(path);
		};

		ytext.observe(handler);
		this.textObservers.set(path, { ytext, handler });
		this.bodyObserverRetryAttempts.delete(path);
		this.log(`observeText: watching "${path}" (remote-only)`);
	}

	private scheduleBodyObserverRetry(path: string): void {
		if (this.textObservers.has(path) || this.bodyObserverRetryTimers.has(path)) return;
		const attempts = this.bodyObserverRetryAttempts.get(path) ?? 0;
		if (attempts >= BODY_OBSERVER_RETRY_LIMIT) return;
		this.bodyObserverRetryAttempts.set(path, attempts + 1);
		const timer = window.setTimeout(() => {
			this.bodyObserverRetryTimers.delete(path);
			if (!this.openPaths.has(path)) return;
			this.observeText(path);
			if (!this.textObservers.has(path)) this.scheduleBodyObserverRetry(path);
		}, BODY_OBSERVER_RETRY_MS);
		this.bodyObserverRetryTimers.set(path, timer);
	}
	/** Reattach after a body load or server replacement changes Y.Text identity. */
	notifyBodyAvailable(path: string): void {
		path = normalizePath(path);
		if (this.openPaths.has(path)) this.observeText(path);
	}


	private unobserveText(path: string): void {
		const obs = this.textObservers.get(path);
		if (obs) {
			obs.ytext.unobserve(obs.handler);
			this.textObservers.delete(path);
			this.log(`unobserveText: stopped watching "${path}"`);
		}
	}

	/** Set of currently observed paths (for external cleanup). */
	getObservedPaths(): Set<string> {
		return new Set(this.textObservers.keys());
	}

	// -------------------------------------------------------------------
	// Write scheduling (debounce + concurrency-limited queue)
	// -------------------------------------------------------------------

	/**
	 * Queue a body -> disk projection. With `expectedDiskHash` the write is
	 * conditional: it happens only while disk still hashes to that value (the
	 * evidence the write was planned on). If disk moved, nothing is written and
	 * the disk-moved handler re-plans.
	 */
	scheduleWrite(path: string, options: { expectedDiskHash?: string } = {}): void {
		path = normalizePath(path);
		if (!this.admitWritePath(path)) return;
		if (options.expectedDiskHash !== undefined) this.expectedDiskHashes.set(path, options.expectedDiskHash);
		if (this.writeQueue.has(path)) return;
		if (this.openPaths.has(path)) {
			const closedTimer = this.debounceTimers.get(path);
			if (closedTimer !== undefined) window.clearTimeout(closedTimer);
			this.debounceTimers.delete(path);
			this.scheduleOpenWrite(path);
			return;
		}
		const openTimer = this.openWriteTimers.get(path);
		if (openTimer !== undefined) window.clearTimeout(openTimer);
		this.openWriteTimers.delete(path);
		this.pendingOpenWrites.delete(path);

		this.scheduleClosedWrite(path);
	}

	/**
	 * The file at these paths was deleted, renamed or otherwise replaced:
	 * plans made on evidence about the old file (disk expectations, the
	 * preserved-overlap dedupe) no longer describe it.
	 */
	forgetPathPlans(paths: Iterable<string>): void {
		for (const raw of paths) {
			const path = normalizePath(raw);
			this.expectedDiskHashes.delete(path);
			this.preservedOverlaps.delete(path);
		}
	}

	private scheduleClosedWrite(path: string): void {
		if (!this.admitWritePath(path)) return;
		// Clear existing debounce for this path
		const existing = this.debounceTimers.get(path);
		if (existing) window.clearTimeout(existing);

		// Use longer debounce when queue is deep (burst scenario)
		const delay = this.writeQueue.size >= BURST_THRESHOLD ? DEBOUNCE_BURST_MS : DEBOUNCE_MS;

		this.debounceTimers.set(
			path,
			window.setTimeout(() => {
				this.debounceTimers.delete(path);
				this.writeQueue.add(path);
					void this.kickDrain();
			}, delay),
		);
	}

	private scheduleOpenWrite(path: string): void {
		if (!this.admitWritePath(path)) return;
		this.pendingOpenWrites.add(path);

		const existing = this.openWriteTimers.get(path);
		if (existing) window.clearTimeout(existing);

		this.openWriteTimers.set(
			path,
				window.setTimeout(() => {
					this.openWriteTimers.delete(path);
					if (!this.pendingOpenWrites.has(path)) return;

					const ytext = this.vaultSync.getTextForPath(path);
					const crdtContent = yTextToString(ytext);
					if (
						this.isActivelyViewedPath(path)
						&& this.hasFocusedEditorUnflushedChanges(path, crdtContent)
					) {
						this.log(`open-write: deferring "${path}" (active editor has unflushed changes)`);
						this.scheduleOpenWrite(path);
						return;
					}

				if (this.hasRecentEditorActivity(path)) {
					this.log(`open-write: deferring "${path}" (recent editor activity)`);
					this.scheduleOpenWrite(path);
					return;
				}

				this.pendingOpenWrites.delete(path);
				this.writeQueue.add(path);
				void this.kickDrain();
			}, OPEN_FILE_IDLE_MS),
		);
	}

	/** Start the drain loop if not already running. */
	private kickDrain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = null;
		});
		return this.drainPromise;
	}

	/**
	 * Drain coalesced projections through the shared worker one at a time.
	 */
	private async drain(): Promise<void> {
		this.draining = true;

		try {
			while (this.writeQueue.size > 0 && this.reconciliationWorker.isOperational) {
				const [path] = this.writeQueue;
				if (path === undefined) break;
				this.writeQueue.delete(path);
				const force = this.forcedWritePaths.delete(path);
				try {
					await this.flushWrite(path, force);
				} catch (error) {
					if (!this.reconciliationWorker.isOperational || error instanceof ReconciliationBackpressureError) {
						if (this.admitWritePath(path)) {
							this.writeQueue.add(path);
							if (force) this.forcedWritePaths.add(path);
						}
						if (!this.reconciliationWorker.isOperational) return;
						await new Promise<void>((resolve) => window.setTimeout(resolve, BODY_OBSERVER_RETRY_MS));
						continue;
					}
					throw error;
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private async settleBodyUnlocked(input: {
		path: string;
		bodyId: string;
		generation: number;
		content: string;
		baseContent?: string;
		onMissingBase?: "preserve" | "preserve-disk";
	}, isCurrent: () => boolean, isIdentityCurrent: () => boolean): Promise<DiskBodySettlement> {
		const { path, bodyId, content } = input;
		if (!isCurrent()) return "replan";
		if (this.openPaths.has(path) || this.editorBindings.isBound(path)) {
			this.recordPreservedUnresolved(path, "body-open-deferred");
			return "preserved-unresolved";
		}

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) {
			this.recordPreservedUnresolved(path, "path-collision");
			return "preserved-unresolved";
		}
		if (!(existing instanceof TFile)) {
			const written = await this.writeSettledBody(path, null, content, isCurrent);
			if (written !== "written") return written === "moved" ? "replan" : "preserved-unresolved";
			this.clearPreservedUnresolved(path);
			this.trace?.("disk", "body-settled", {
				path,
				bodyId,
				generation: input.generation,
				action: "create",
			});
			return "settled";
		}
		const isProjectionCurrent = isCurrent;
		const isBindingCurrent = isIdentityCurrent;
		isCurrent = () => isProjectionCurrent() && this.isFileCurrent(existing, path);
		isIdentityCurrent = () => isBindingCurrent() && this.isFileCurrent(existing, path);

		let diskContent: string;
		let rawDiskContent: string;
		try {
			rawDiskContent = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(existing));
			diskContent = canonicalizeMarkdown(rawDiskContent);
		} catch {
			if (!isCurrent()) return "replan";
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
		if (!isCurrent()) return "replan";
		const settlement = this.settlement;
		const episodes = settlement?.conflictEpisodes;
		if (episodes?.get(bodyId)) {
			try {
				await episodes.preserve({ bodyId, path, epoch: this.vaultSync.bodies.get?.(bodyId)?.bodyEpoch, disk: diskContent, body: content, device: this.getDeviceName() });
				if (!isCurrent()) return "replan";
			} catch {
				if (!isCurrent()) return "replan";
				this.recordPreservedUnresolved(path, "conflict-artifact-write-failed");
				return "preserved-unresolved";
			}
			this.settlement?.markDivergence?.(bodyId, "decision-required");
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			if (diskContent !== content) await this.writeSettledBody(path, diskContent, content, isCurrent, rawDiskContent);
			return "preserved-unresolved";
		}
		const [diskHash, remoteHash] = await Promise.all([
			contentBaselineHash(diskContent),
			contentBaselineHash(content),
		]);
		if (!isCurrent()) return "replan";
		if (diskHash === remoteHash) {
			this._onDiskWriteCallback?.(path, remoteHash, content);
			this.clearPreservedUnresolved(path);
			return "settled";
		}
		if (episodes && settlement && content.length > 0 && diskContent.startsWith(content)) {
			const artifactHash = episodes.snapshot().artifacts[path];
			const verified = await episodes.isArtifact(path, rawDiskContent);
			if (!isCurrent() || this.settlement !== settlement
				|| artifactHash !== episodes.snapshot().artifacts[path]) return "replan";
			if (verified) {
				const currentDisk = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(existing));
				if (!isCurrent() || this.settlement !== settlement || currentDisk !== rawDiskContent
					|| artifactHash !== episodes.snapshot().artifacts[path]) return "replan";
				if (this.diskIngestBlocked(bodyId, path, content, diskContent)) return "preserved-unresolved";
				const committed = await settlement.commitLocalBody({
					bodyId, path, content: diskContent, expectedBodyContent: content, reason: "external-edit",
				});
				if (!isIdentityCurrent()) return "replan";
				if (committed !== "superseded") {
					this.settlement?.markDivergence?.(bodyId, "none");
					this.clearPreservedUnresolved(path);
				}
				return "replan";
			}
		}

		if (this.settlement?.getCommonBase && this.settlement.commitMergedBody) {
			const base = input.baseContent !== undefined
				? null
				: await this.settlement.getCommonBase(bodyId);
			if (!isCurrent()) return "replan";
			const baseline = this.settlement.getBaseline(path);
			const agreement = this.planRawDiskAgreement(diskContent, content,
				input.baseContent ?? (base?.kind === "available" ? base.settlement.content : null),
				baseline?.contentHash ?? null, diskHash, remoteHash);
			if (agreement.kind === "preserve" && agreement.merge === null
				&& (input.baseContent !== undefined || base?.kind === "available" || baseline?.contentHash === remoteHash)) {
				return this.preserveRawDiskReplacement(bodyId, path, diskContent, content, diskHash, remoteHash, isCurrent);
			}
			if (agreement.kind === "import-local"
				&& (baseline?.trustedWhole === true || input.baseContent !== undefined || base?.kind === "available")) {
				return this.commitDiskWinner(bodyId, path, diskContent, "external-edit", diskHash, content, isCurrent, isIdentityCurrent);
			}
			if (base !== null && base.kind !== "invalid"
				&& baseline?.trustedWhole === true && baseline.contentHash === diskHash) {
				const written = await this.writeSettledBody(path, diskContent, content, isCurrent, rawDiskContent);
				if (written !== "written") return written === "moved" ? "replan" : "preserved-unresolved";
				this.settlement.markDivergence?.(bodyId, "none");
				this.clearPreservedUnresolved(path);
				return "settled";
			}
			if (base !== null && base.kind !== "available") {
				if (input.onMissingBase === "preserve-disk") {
					return this.preserveDiskThenProjectBody(bodyId, path, diskContent, content, isCurrent, rawDiskContent);
				}
				this.settlement.markDivergence?.(bodyId, "preserved");
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return "preserved-unresolved";
			}
			let merge: ThreeWayMergeResult;
			let composeMerged = (merged: string): string => merged;
			if (base === null) {
				merge = this.mergeWholeMarkdownAgreement(canonicalizeMarkdown(input.baseContent ?? ""), diskContent, content);
			} else if (base.settlement.format === 2 && base.settlement.agreement === "body-only") {
				const diskComponents = splitMarkdownComponents(diskContent);
				const remoteComponents = splitMarkdownComponents(content);
				if (diskComponents.kind === "ambiguous" || remoteComponents.kind === "ambiguous") {
					this.settlement.markDivergence?.(bodyId, "preserved");
					this.recordPreservedUnresolved(path, "body-settlement-failed");
					return "preserved-unresolved";
				}
				merge = mergeThreeWayText(
					base.settlement.bodyBase.content,
					diskComponents.body,
					remoteComponents.body,
				);
				composeMerged = (merged) => composeMarkdownComponents(remoteComponents.propertiesRegion, merged);
			} else {
				merge = this.mergeWholeMarkdownAgreement(base.settlement.content, diskContent, content);
			}
			if (merge.kind === "too-large") {
				this.settlement.markDivergence?.(bodyId, "preserved");
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return "preserved-unresolved";
			}
			if (merge.kind === "conflict") {
				if (this.settlement.conflictEpisodes) {
					try {
						await this.settlement.conflictEpisodes.preserve({
							bodyId, path, epoch: this.vaultSync.bodies.get?.(bodyId)?.bodyEpoch, disk: diskContent, body: content,
							base: input.baseContent ?? base?.settlement.content ?? merge.base, device: this.getDeviceName(),
						});
						if (!isCurrent()) return "replan";
					} catch {
						if (!isCurrent()) return "replan";
						this.recordPreservedUnresolved(path, "conflict-artifact-write-failed");
						return "preserved-unresolved";
					}
					this.settlement.markDivergence?.(bodyId, "decision-required");
					this.recordPreservedUnresolved(path, "body-settlement-failed");
					await this.writeSettledBody(path, diskContent, content, isCurrent, rawDiskContent);
					return "preserved-unresolved";
				}
				const overlapKey = remoteHash;
				if (this.preservedOverlaps.get(path) === overlapKey || this.openReviews.has(path)) {
					// Already preserved and offered for review: nothing new to decide.
					this.settlement.markDivergence?.(bodyId, "decision-required");
					this.recordPreservedUnresolved(path, "body-settlement-failed");
					return "preserved-unresolved";
				}
				try {
					await createMarkdownConflictArtifact(this.app, path, content, {
						executeHost: (operation, execute) => this.reconciliationWorker.io(operation, execute),
						deviceName: this.getDeviceName(),
						reason: "three-way-overlap",
						source: "crdt",
						trace: (message, details) => this.trace?.("conflict", message, details),
					});
					if (!isCurrent()) return "replan";
				} catch {
					if (!isCurrent()) return "replan";
					this.recordPreservedUnresolved(path, "conflict-artifact-write-failed");
					return "preserved-unresolved";
				}
				this.preservedOverlaps.set(path, overlapKey);
				this.settlement.markDivergence?.(bodyId, "decision-required");
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return "preserved-unresolved";
			}
			const mergedContent = composeMerged(merge.content);
			if (mergedContent === content) {
				const written = await this.writeSettledBody(path, diskContent, content, isCurrent, rawDiskContent);
				if (written !== "written") return written === "moved" ? "replan" : "preserved-unresolved";
				this.settlement.markDivergence?.(bodyId, "none");
				this.clearPreservedUnresolved(path);
				return "settled";
			}
			if (!isCurrent()) return "replan";
			if (this.diskIngestBlocked(bodyId, path, content, mergedContent)) return "preserved-unresolved";
			const committed = await this.settlement.commitMergedBody({
				bodyId,
				path,
				expectedBodyContent: content,
				mergedContent,
			});
			if (!isIdentityCurrent()) return "replan";
			if (committed === "superseded") return "replan";
			this.settlement.markDivergence?.(bodyId, "none");
			return "replan";
		}

		const baseline = this.settlement?.getBaseline(path) ?? null;
		const agreement = this.planRawDiskAgreement(diskContent, content, input.baseContent ?? null,
			baseline?.contentHash ?? null, diskHash, remoteHash);
		if (agreement.kind === "preserve") {
			return this.preserveRawDiskReplacement(bodyId, path, diskContent, content, diskHash, remoteHash, isCurrent);
		}
		const decision = decideClosedFileConflict({
			baselineHash: baseline?.contentHash ?? null,
			diskHash,
			crdtHash: remoteHash,
			diskMtime: existing.stat.mtime,
			lastDiskIndexPersistedAt: baseline?.lastDiskIndexPersistedAt,
		});

		if (decision.kind === "apply-remote-to-disk") {
			const written = await this.writeSettledBody(path, diskContent, content, isCurrent, rawDiskContent);
			if (written !== "written") return written === "moved" ? "replan" : "preserved-unresolved";
			this.clearPreservedUnresolved(path);
			return "settled";
		}
		if (decision.kind === "import-disk-to-crdt") {
			return this.commitDiskWinner(bodyId, path, diskContent, "external-edit", diskHash, content, isCurrent, isIdentityCurrent);
		}
		if (decision.kind === "no-op") {
			this._onDiskWriteCallback?.(path, remoteHash, content);
			this.clearPreservedUnresolved(path);
			return "settled";
		}

		const preservedContent = decision.preserveDisk ? diskContent : content;
		const preservedSource = decision.preserveDisk ? "disk" : "crdt";
		try {
			await createMarkdownConflictArtifact(this.app, path, preservedContent, {
				executeHost: (operation, execute) => this.reconciliationWorker.io(operation, execute),
				deviceName: this.getDeviceName(),
				reason: `closed-file-${decision.reason}`,
				source: preservedSource,
				trace: (message: string, details: Record<string, unknown>) =>
					this.trace?.("conflict", message, details),
			});
			if (!isCurrent()) return "replan";
		} catch {
			if (!isCurrent()) return "replan";
			this.recordPreservedUnresolved(path, "conflict-artifact-write-failed");
			return "preserved-unresolved";
		}

		if (decision.winner === "disk") {
			return this.commitDiskWinner(bodyId, path, diskContent, "external-edit", diskHash, content, isCurrent, isIdentityCurrent);
		}
		const written = await this.writeSettledBody(path, diskContent, content, isCurrent, rawDiskContent);
		if (written !== "written") return written === "moved" ? "replan" : "preserved-unresolved";
		this.clearPreservedUnresolved(path);
		return "settled";
	}

	private mergeWholeMarkdownAgreement(base: string, local: string, body: string): ThreeWayMergeResult {
		const plan = planMarkdownAgreement({ local, body, base });
		if (plan.kind === "merge") return plan.merge;
		if (plan.kind === "preserve" && plan.merge !== null) return plan.merge;
		return mergeThreeWayText(base, local, body);
	}

	private planRawDiskAgreement(local: string, body: string, base: string | null, baselineHash: string | null, diskHash: string, bodyHash: string) {
		const input = {
			local, body, base,
			localMatchesAgreement: baselineHash !== null && diskHash === baselineHash,
			bodyMatchesAgreement: baselineHash !== null && bodyHash === baselineHash,
			localInput: "unbound-disk" as const,
		};
		return planMarkdownAgreement(input);
	}

	private async preserveRawDiskReplacement(bodyId: string, path: string, diskContent: string, content: string, diskHash: string, bodyHash: string, isCurrent: () => boolean): Promise<DiskBodySettlement> {
		const overlapKey = `raw-disk:${diskHash}:${bodyHash}`;
		if (!isCurrent()) return "replan";
		if (this.preservedOverlaps.get(path) !== overlapKey) {
			try {
				const episodes = this.settlement?.conflictEpisodes;
				if (episodes) {
					await episodes.preserve({
						bodyId, path, epoch: this.vaultSync.bodies.get?.(bodyId)?.bodyEpoch,
						disk: diskContent, body: content, device: this.getDeviceName(),
					});
				} else {
					await createMarkdownConflictArtifact(this.app, path, diskContent, {
						executeHost: (operation, execute) => this.reconciliationWorker.io(operation, execute),
						deviceName: this.getDeviceName(), reason: "raw-disk-unknown-ancestry", source: "disk",
						trace: (message, details) => this.trace?.("conflict", message, details),
					});
				}
				if (!isCurrent()) return "replan";
				this.preservedOverlaps.set(path, overlapKey);
			} catch {
				if (!isCurrent()) return "replan";
				this.recordPreservedUnresolved(path, "conflict-artifact-write-failed");
				return "preserved-unresolved";
			}
		}
		this.settlement?.markDivergence?.(bodyId, "decision-required");
		this.recordPreservedUnresolved(path, "body-settlement-failed");
		return "preserved-unresolved";
	}

	/**
	 * Both sides moved and no common base exists: preserve disk (the local
	 * input) as a conflict artifact first, then project the body. The body is
	 * the durable state other devices already hold; importing disk over it
	 * would revert committed remote work. Never runs if preservation fails.
	 */
	private async preserveDiskThenProjectBody(
		bodyId: string,
		path: string,
		diskContent: string,
		content: string,
		isCurrent: () => boolean,
		rawDiskContent: string,
	): Promise<"settled" | "replan" | "preserved-unresolved"> {
		if (!isCurrent()) return "replan";
		try {
			if (this.settlement?.conflictEpisodes) {
				await this.settlement.conflictEpisodes.preserve({ bodyId, path, epoch: this.vaultSync.bodies.get?.(bodyId)?.bodyEpoch, disk: diskContent, body: content, device: this.getDeviceName() });
			} else await createMarkdownConflictArtifact(this.app, path, diskContent, {
				executeHost: (operation, execute) => this.reconciliationWorker.io(operation, execute),
				deviceName: this.getDeviceName(),
				reason: "closed-file-both-changed-no-common-base",
				source: "disk",
				trace: (message, details) => this.trace?.("conflict", message, details),
			});
			if (!isCurrent()) return "replan";
		} catch {
			if (!isCurrent()) return "replan";
			this.settlement?.markDivergence?.(bodyId, "preserved");
			this.recordPreservedUnresolved(path, "conflict-artifact-write-failed");
			return "preserved-unresolved";
		}
		const written = await this.writeSettledBody(path, diskContent, content, isCurrent, rawDiskContent);
		if (written !== "written") return written === "moved" ? "replan" : "preserved-unresolved";
		if (this.settlement?.conflictEpisodes?.get(bodyId)) {
			this.settlement.markDivergence?.(bodyId, "decision-required");
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
		this.settlement?.markDivergence?.(bodyId, "none");
		this.clearPreservedUnresolved(path);
		return "settled";
	}

	/** Frontmatter ingest guard before committing disk-derived content. */
	private diskIngestBlocked(bodyId: string, path: string, current: string, next: string): boolean {
		if (current === next || !this.settlement?.shouldBlockDiskIngest?.(path, current, next)) return false;
		this.log(`settle: frontmatter guard blocked disk-derived content for "${path}"; body and disk left as they are`);
		this.settlement.markDivergence?.(bodyId, "preserved");
		this.recordPreservedUnresolved(path, "body-settlement-failed");
		return true;
	}

	/**
	 * The stored whole-content common base of a body, only when it is exactly
	 * the content named by `expectedHash` (the disk-index baseline).
	 */
	async readCommonBaseContent(bodyId: string, expectedHash: string): Promise<string | null> {
		if (!this.settlement?.getCommonBase) return null;
		const base = await this.settlement.getCommonBase(bodyId);
		if (base.kind !== "available") return null;
		if (base.settlement.format === 2 && base.settlement.agreement !== "whole") return null;
		return base.settlement.contentHash === expectedHash ? base.settlement.content : null;
	}

	/** The stored whole-content common base of a body, whatever its hash. */
	async readWholeCommonBase(bodyId: string): Promise<{ content: string; hash: string } | null> {
		if (!this.settlement?.getCommonBase) return null;
		const base = await this.settlement.getCommonBase(bodyId);
		if (base.kind !== "available") return null;
		if (base.settlement.format === 2 && base.settlement.agreement !== "whole") return null;
		return { content: base.settlement.content, hash: base.settlement.contentHash };
	}

	async readCanonicalDiskEvidenceQueued(path: string): Promise<Awaited<ReturnType<DiskMirror["readCanonicalDiskEvidence"]>>> {
		return this.readCanonicalDiskEvidence(path);
	}

	async readCanonicalDiskEvidence(path: string): Promise<Awaited<ReturnType<DiskMirror["readCanonicalDiskEvidenceUnqueued"]>>> {
		return this.reconciliationWorker.run(() => this.readCanonicalDiskEvidenceUnqueued(path), {
			retainedBytes: reconciliationRetainedBytes(path), label: "read-disk-evidence",
		});
	}

	async readCanonicalDiskEvidenceUnqueued(path: string): Promise<{
		content: string;
		fingerprint: DiskSettlementFingerprint;
		file: TFile;
		rawContent: string;
	} | null> {
		const accepted = this.acceptPath(path);
		if (!accepted) return null;
		const file = this.app.vault.getAbstractFileByPath(accepted);
		if (!(file instanceof TFile)) return null;
		const raw = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
		const fingerprint = await exactMarkdownDiskFingerprint(raw);
		if (!this.isFileCurrent(file, accepted)) return null;
		return {
			content: canonicalizeMarkdown(raw),
			fingerprint,
			file,
			rawContent: raw,
		};
	}

	async projectReviewedContentQueued(input: Parameters<DiskMirror["projectReviewedContentUnqueued"]>[0]): Promise<"written" | "moved" | "failed"> {
		return this.projectReviewedContent(input);
	}

	async projectReviewedContent(input: Parameters<DiskMirror["projectReviewedContentUnqueued"]>[0]): Promise<"written" | "moved" | "failed"> {
		return this.reconciliationWorker.run(() => this.projectReviewedContentUnqueued(input), {
			retainedBytes: reconciliationRetainedBytes(input.content, input.expectedDisk.content, input.expectedDisk.rawContent),
			label: "project-reviewed-content",
		});
	}

	async projectReviewedContentUnqueued(input: {
		path: string;
		bodyId: string;
		content: string;
		expectedDisk: {
			content: string;
			fingerprint: DiskSettlementFingerprint;
			file?: TFile;
			rawContent?: string;
		};
	}): Promise<"written" | "moved" | "failed"> {
		const path = this.acceptPath(input.path);
		if (!path || this.vaultSync.getFileId(path) !== input.bodyId) return "moved";
		if (this.isStructuralPathPending(path)) return "failed";
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || (input.expectedDisk.file && input.expectedDisk.file !== file)) return "moved";
		const content = canonicalizeMarkdown(input.content);
		const isScopeCurrent = this.captureDiskScope([path]);
		const runtime = this.vaultSync;
		const revision = runtime.bodies.captureRevision(input.bodyId);
		const isCurrent = () => {
			if (!isScopeCurrent() || this.isStructuralPathPending(path) || !this.isFileCurrent(file, path)
				|| !runtime.bodies.coordinator.isProjectionCurrent(revision, path)) return false;
			const text = runtime.getTextForPath(path);
			return text !== null && yTextToString(text) === content;
		};
		try {
			if (!isCurrent()) return "moved";
			const raw = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
			const fingerprint = await exactMarkdownDiskFingerprint(raw);
			if (!isCurrent() || canonicalizeMarkdown(raw) !== input.expectedDisk.content
				|| fingerprint.hash !== input.expectedDisk.fingerprint.hash
				|| fingerprint.bytes !== input.expectedDisk.fingerprint.bytes
				|| (input.expectedDisk.rawContent !== undefined && raw !== input.expectedDisk.rawContent)) return "moved";
			if (this.shouldBlockFrontmatterWrite(path, canonicalizeMarkdown(raw), content)) return "failed";
			const contentHash = await contentBaselineHash(content);
			if (!isCurrent()) return "moved";
			await this.suppressWrite(path, content, 1);
			const outcome = await this.compareAndModify(file, path, raw, content, isCurrent);
			if (outcome !== "written") {
				this.suppressedPaths.delete(path);
				return outcome;
			}
			if (!isCurrent()) return "moved";
			const projected = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
			if (!isCurrent() || projected !== content) return "moved";
			this.lastDiskWriteOkAt.set(path, Date.now());
			this.expectedDiskHashes.delete(path);
			if (!this.hasPendingBodyWork(input.bodyId)) this._onDiskWriteCallback?.(path, contentHash, content);
			return isCurrent() ? "written" : "moved";
		} catch {
			this.suppressedPaths.delete(path);
			return isCurrent() ? "failed" : "moved";
		}
	}

	/**
	 * Disk wins over the body the decision was planned against
	 * (`plannedBodyContent`). The import is conditional on the body still
	 * holding exactly that content: a remote update that reached the body
	 * after the plan must not be diffed away (P0c N2). "replan" then.
	 */
	private async commitDiskWinner(
		bodyId: string,
		path: string,
		content: string,
		reason: "external-edit" | "delete-revive",
		contentHash: string,
		plannedBodyContent: string,
		isCurrent: () => boolean,
		isIdentityCurrent: () => boolean,
	): Promise<"settled" | "replan" | "preserved-unresolved"> {
		if (!isCurrent()) return "replan";
		if (!this.settlement) {
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
		if (plannedBodyContent !== undefined && this.diskIngestBlocked(bodyId, path, plannedBodyContent, content)) {
			return "preserved-unresolved";
		}
		try {
			const outcome = await this.settlement.commitLocalBody({
				bodyId,
				path,
				content,
				reason,
				...(plannedBodyContent !== undefined ? { expectedBodyContent: plannedBodyContent } : {}),
			});
			if (!isIdentityCurrent()) return "replan";
			if (outcome === "superseded") {
				this.log(`settle: body of "${path}" moved after the disk-import decision; re-planning`);
				return "replan";
			}
			if (this.hasPendingBodyWork(bodyId)) return "replan";
			this.expectedDiskHashes.delete(path);
			this._onDiskWriteCallback?.(path, contentHash, content);
			this.clearPreservedUnresolved(path);
			return "settled";
		} catch {
			if (!isIdentityCurrent()) return "replan";
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
	}

	private async writeSettledBody(
		path: string,
		previousContent: string | null,
		content: string,
		isCurrent: () => boolean,
		rawDiskContent?: string,
	): Promise<"written" | "moved" | "failed"> {
		content = canonicalizeMarkdown(content);
		previousContent = previousContent === null ? null : canonicalizeMarkdown(previousContent);
		let partial = false;
		if (this.shouldBlockFrontmatterWrite(path, previousContent, content)) {
			const bodyOnly = this.frontmatterBodyOnlyWrite(previousContent ?? "", content);
			if (bodyOnly === null) {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return "failed";
			}
			content = bodyOnly;
			partial = true;
		}
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			const isProjectionCurrent = isCurrent;
			let projectedFile = existing instanceof TFile ? existing : null;
			isCurrent = () => isProjectionCurrent() && (projectedFile === null || this.isFileCurrent(projectedFile, path));
			if (!isCurrent()) return "moved";
			if (existing instanceof TFile && (previousContent === null || rawDiskContent === undefined)) return "moved";
			if (!(existing instanceof TFile) && previousContent !== null) return "moved";
			await this.suppressWrite(path, content, existing instanceof TFile ? 1 : 2);
			if (!isCurrent()) return "moved";
			if (existing instanceof TFile) {
				const outcome = await this.compareAndModify(existing, path, rawDiskContent!, content, isCurrent);
				if (outcome === "moved") {
					this.suppressedPaths.delete(path);
					this.log(`settle: disk at "${path}" changed before the write; not overwriting`);
					return "moved";
				}
			} else {
				await this.ensureParentFolder(path, () => {
					if (!isCurrent()) throw new DiskProjectionChangedError(path);
				});
				if (!isCurrent()) return "moved";
				projectedFile = await this.reconciliationWorker.io("vault.create", () => this.app.vault.create(path, content));
			}
			if (!isCurrent()) return "moved";
			this.lastDiskWriteOkAt.set(path, Date.now());
			this.expectedDiskHashes.delete(path);
			if (partial) await this.recordPartialDiskWrite(path, content, isCurrent);
			else {
				const contentHash = await contentBaselineHash(content);
				if (!isCurrent()) return "moved";
				this._onDiskWriteCallback?.(path, contentHash, content);
			}
			if (!isCurrent()) return "moved";
			return "written";
		} catch {
			if (!isCurrent()) return "moved";
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "failed";
		}
	}

	private isFileCurrent(file: TFile, path: string): boolean {
		return this.reconciliationWorker.isOperational && file.path === path && this.app.vault.getAbstractFileByPath(path) === file;
	}

	private async compareAndModify(file: TFile, path: string, expected: string, next: string, isCurrent: () => boolean): Promise<"written" | "moved"> {
		if (!this.isFileCurrent(file, path) || !isCurrent()) return "moved";
		const vault = this.app.vault;
		if (typeof vault.process !== "function") throw new Error("Safe disk replacement requires Vault.process");
		const processOptions: Parameters<typeof vault.process>[2] & { retainedBytes: number } = {
			retainedBytes: reconciliationRetainedBytes(expected, next),
		};
		try {
			await this.reconciliationWorker.io("vault.process", () => vault.process(file, (data) => {
				if (!this.isFileCurrent(file, path) || !isCurrent() || data !== expected) {
					throw new DiskMovedBeforeWriteError();
				}
				return next;
			}, processOptions));
		} catch (error) {
			if (error instanceof DiskMovedBeforeWriteError) return "moved";
			throw error;
		}
		return "written";
	}

	private handDiskMovedBack(path: string, reason: string): void {
		this.log(`flushWrite: disk at "${path}" moved before the write (${reason}); not overwriting`);
		this.trace?.("disk", "planned-write-disk-moved", { path, reason });
		this._onDiskMovedBeforeWrite?.(path);
	}

	private admitWritePath(path: string): boolean {
		if (this.writeQueue.has(path) || this.debounceTimers.has(path) || this.openWriteTimers.has(path)) return true;
		if (this.writeQueue.size + this.debounceTimers.size + this.openWriteTimers.size < MAX_PENDING_WRITES) return true;
		this.handDiskMovedBack(path, "projection-backpressure");
		return false;
	}

	private blockStructuralAdmission(): void {
		if (this.structuralAdmissionBlocked) return;
		this.structuralAdmissionBlocked = true;
		this.invalidateDiskScope();
		this.log("Structural reconciliation paused: an oversized or backpressured rename batch was refused before acceptance. Source files are unchanged; inspect the remote mapping and replan smaller independent batches before restarting sync.");
		this._flightEventHandler?.({
			priority: "critical", kind: "disk.structural.recovery.blocked", severity: "error", scope: "vault",
			source: "diskMirror", layer: "disk", data: { reason: "structural-admission-refused" },
		});
	}

	get isStructuralAdmissionBlocked(): boolean {
		return this.structuralAdmissionBlocked;
	}

	private async ensureParentFolder(path: string, verifySource: () => void): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash < 0) return;
		const parts = path.slice(0, slash).split("/");
		let current = "";
		for (const part of parts) {
			verifySource();
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.reconciliationWorker.io("vault.createFolder", () => this.app.vault.createFolder(current));
				verifySource();
			} else if (existing instanceof TFile) {
				throw new Error(`Cannot create sync folder over file: ${current}`);
			}
		}
	}

	// -------------------------------------------------------------------
	// Disk write
	// -------------------------------------------------------------------

	async flushWrite(path: string, force = false): Promise<void> {
		const accepted = this.acceptPath(path);
		if (!accepted) return;
		path = accepted;
		const isScopeCurrent = this.captureDiskScope([path]);
		return this.reconciliationWorker.run(() => this.flushWriteUnlocked(path, force, isScopeCurrent));
	}

	private async flushWriteUnlocked(path: string, force: boolean, isScopeCurrent: () => boolean): Promise<void> {
		if (this.isPreservedUnresolved(path)) {
			this.log(`flushWrite: preserving unresolved disk content at "${path}"`);
			return;
		}
		if (!isScopeCurrent()) return;
		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) {
			this.log(`flushWrite: no Y.Text for "${path}", skipping`);
			return;
		}
		const bodyId = this.vaultSync.getFileId(path);
		if (!bodyId) return;
		const proof = this.vaultSync.bodies.captureRevision(bodyId);
		let projectedFile: TFile | null = null;
		const isSourceCurrent = () => projectedFile === null || this.isFileCurrent(projectedFile, path);
		const isCurrent = () => isScopeCurrent() && isSourceCurrent() && this.vaultSync.bodies.coordinator.isProjectionCurrent(proof, path);
		const content = canonicalizeMarkdown(ytext.toJSON());

		if (!force && this.openPaths.has(path)) {
			if (
				this.isActivelyViewedPath(path)
				&& this.hasFocusedEditorUnflushedChanges(path, content)
			) {
				this.log(`flushWrite: deferring open "${path}" (active editor has unflushed changes)`);
				this.scheduleOpenWrite(path);
				return;
			}
			if (this.hasRecentEditorActivity(path)) {
				this.log(`flushWrite: deferring open "${path}" (recent editor activity)`);
				this.scheduleOpenWrite(path);
				return;
			}
		}

		const normalized = normalizePath(path);

		try {
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			const expectedDiskHash = this.expectedDiskHashes.get(normalized);
			if (existing instanceof TFile) {
				projectedFile = existing;
				const rawDiskContent = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(existing));
				const currentContent = canonicalizeMarkdown(rawDiskContent);
				let writeContent = content;
				let partial = false;
				if (!isCurrent()) {
					if (isScopeCurrent() && isSourceCurrent()) this.queueImmediateWrite(path, "superseded-disk-proof", force);
					return;
				}
				const currentHash = expectedDiskHash !== undefined && currentContent !== content
					? await contentBaselineHash(currentContent)
					: null;
				if (!isCurrent()) {
					if (isScopeCurrent() && isSourceCurrent()) this.queueImmediateWrite(path, "superseded-disk-hash", force);
					return;
				}
				if (currentHash !== null && currentHash !== expectedDiskHash) {
					// Kept until a new plan replaces it: any other flush of this
					// path must not overwrite the moved disk either.
					this.handDiskMovedBack(normalized, "expected-disk-hash");
					return;
				}
				if (currentContent === content) {
					this.expectedDiskHashes.delete(normalized);
					this.log(`flushWrite: "${path}" unchanged, skipping`);
					return;
				}
				if (this.shouldBlockFrontmatterWrite(path, currentContent, content)) {
					const bodyOnly = this.frontmatterBodyOnlyWrite(currentContent, content);
					if (bodyOnly === null) return;
					writeContent = bodyOnly;
					partial = true;
				}

				await this.suppressWrite(path, writeContent, 1);
				if (!isCurrent()) {
					if (isScopeCurrent() && isSourceCurrent()) this.queueImmediateWrite(path, "superseded-before-modify", force);
					return;
				}
				if (await this.compareAndModify(existing, normalized, rawDiskContent, writeContent, isCurrent) === "moved") {
					this.suppressedPaths.delete(normalized);
					this.handDiskMovedBack(normalized, "compare-and-swap");
					return;
				}
				if (!isCurrent()) {
					if (isScopeCurrent() && isSourceCurrent()) this.queueImmediateWrite(path, "superseded-after-modify", force);
					return;
				}
				this.expectedDiskHashes.delete(normalized);
				this.log(`flushWrite: updated "${path}" (${writeContent.length} chars)`);
				this.lastDiskWriteOkAt.set(normalized, Date.now());
				if (partial) await this.recordPartialDiskWrite(normalized, writeContent, isCurrent);
				else {
					const contentHash = await contentBaselineHash(writeContent);
					if (!isCurrent()) return;
					this._onDiskWriteCallback?.(normalized, contentHash, writeContent);
				}
				if (!isCurrent()) return;
				this._flightEventHandler?.({
					priority: "important",
					kind: "disk.write.ok",
					severity: "info",
					scope: "file",
					source: "diskMirror",
					layer: "disk",
					path: normalized,
					data: { contentLength: writeContent.length, isCreate: false, partialFrontmatter: partial },
				});
			} else {
				if (expectedDiskHash !== undefined) {
					// Planned against a file that existed; it is gone now (a
					// local delete or rename). Recreating it would undo that.
					this.handDiskMovedBack(normalized, "file-removed");
					return;
				}
				let writeContent = content;
				let partial = false;
				if (this.shouldBlockFrontmatterWrite(path, null, content)) {
					const bodyOnly = this.frontmatterBodyOnlyWrite("", content);
					if (bodyOnly === null) return;
					writeContent = bodyOnly;
					partial = true;
				}
				await this.suppressWrite(path, writeContent, 2);
				if (!isCurrent()) {
					if (isScopeCurrent()) this.queueImmediateWrite(path, "superseded-before-create", force);
					return;
				}
				await this.ensureParentFolder(normalized, () => {
					if (!isCurrent()) throw new DiskProjectionChangedError(path);
				});
				if (!isCurrent()) return;
				projectedFile = await this.reconciliationWorker.io("vault.create", () => this.app.vault.create(normalized, writeContent));
				if (!isCurrent()) {
					if (isScopeCurrent() && isSourceCurrent()) this.queueImmediateWrite(path, "superseded-after-create", force);
					return;
				}
				this.log(
					`flushWrite: created "${path}" on disk (${writeContent.length} chars)`,
				);
				this.lastDiskWriteOkAt.set(normalized, Date.now());
				if (partial) await this.recordPartialDiskWrite(normalized, writeContent, isCurrent);
				else {
					const contentHash = await contentBaselineHash(writeContent);
					if (!isCurrent()) return;
					this._onDiskWriteCallback?.(normalized, contentHash, writeContent);
				}
				if (!isCurrent()) return;
				this._flightEventHandler?.({
					priority: "important",
					kind: "disk.write.ok",
					severity: "info",
					scope: "file",
					source: "diskMirror",
					layer: "disk",
					path: normalized,
					data: { contentLength: content.length, isCreate: true },
				});
			}
		} catch (err) {
			if (!isCurrent()) {
				if (isScopeCurrent() && isSourceCurrent()) this.queueImmediateWrite(path, "superseded-during-write", force);
				return;
			}
			console.error(`[yaos] flushWrite failed for "${path}":`, err);
			this._flightEventHandler?.({
				priority: "critical",
				kind: "disk.write.failed",
				severity: "error",
				scope: "file",
				source: "diskMirror",
				layer: "disk",
				path: normalized,
				data: { error: err instanceof Error ? err.message : String(err) },
			});
		}
	}

	private shouldBlockFrontmatterWrite(
		path: string,
		previousContent: string | null,
		nextContent: string,
	): boolean {
		if (!this.frontmatterGuardEnabled()) return false;

		const validation = validateFrontmatterTransition(previousContent, nextContent);
		this.onFrontmatterValidated?.(
			path,
			"crdt-to-disk",
			"flush-write",
			validation,
			previousContent,
			nextContent,
		);
		if (!isFrontmatterBlocked(validation)) return false;

		this.log(
			`frontmatter write blocked for "${path}" ` +
			`(${validation.reasons.join(", ") || validation.risk})`,
		);
		return true;
	}

	private frontmatterBodyOnlyWrite(currentContent: string, incomingContent: string): string | null {
		const partial = composeBodyOnlyProgress(currentContent, incomingContent);
		if (partial.kind === "ambiguous") return null;
		if (partial.heldPropertiesRegion === "" && partial.incomingPropertiesRegion === "") return null;
		this.log(
			`frontmatter properties held while body advanced ` +
			`(${partial.heldPropertiesRegion.length}->${partial.incomingPropertiesRegion.length} property bytes)`,
		);
		return partial.content;
	}

	private async recordPartialDiskWrite(path: string, content: string, isCurrent: () => boolean): Promise<void> {
		const split = splitMarkdownComponents(content);
		if (split.kind === "ambiguous") return;
		const [bodyHash, propertiesHash] = await Promise.all([
			contentBaselineHash(split.body),
			contentBaselineHash(split.propertiesRegion),
		]);
		if (!isCurrent()) return;
		this._onPartialDiskWriteCallback?.(path, bodyHash, propertiesHash);
	}



	private async deleteLocalReplica(file: TFile, path: string): Promise<"trash"> {
		if (!this.isFileCurrent(file, path)) throw new DiskProjectionChangedError(path);
		await this.reconciliationWorker.io("fileManager.trashFile", () => this.app.fileManager.trashFile(file));
		return "trash";
	}

	// -------------------------------------------------------------------
	// Suppression
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		return this.getActiveSuppression(path) !== null;
	}

	/**
	 * Per-path timestamp of the most recent successful YAOS-issued
	 * `flushWrite`. Returns null if YAOS has never written this path in
	 * this session. Used by main.ts to label `disk.modify.observed` events
	 * with writer attribution.
	 */
	getLastDiskWriteOkAt(path: string): number | null {
		const v = this.lastDiskWriteOkAt.get(normalizePath(path));
		return v === undefined ? null : v;
	}

	async shouldSuppressModify(file: TFile): Promise<boolean> {
		return this.reconciliationWorker.run(() => this.shouldSuppressWriteEvent(file, "modify"), { label: "verify-modify-suppression" });
	}

	async shouldSuppressCreate(file: TFile): Promise<boolean> {
		return this.reconciliationWorker.run(() => this.shouldSuppressWriteEvent(file, "create"), { label: "verify-create-suppression" });
	}

	consumeDeleteSuppression(path: string): boolean {
		path = normalizePath(path);
		const entry = this.getActiveSuppression(path);
		if (!entry || entry.kind !== "delete") return false;
		const remaining = Math.max(0, (entry.remainingAcks ?? 1) - 1);
		if (remaining === 0) this.suppressedPaths.delete(path);
		else entry.remainingAcks = remaining;
		return true;
	}

	/**
	 * Returns true if this path was preserved during a remote-delete because
	 * no baseline was available to verify local state.
	 *
	 * Callers (importUntrackedFiles, reconcile scans) MUST check this before
	 * auto-reviving tombstones for local files.
	 */
	isPreservedUnresolved(path: string): boolean {
		return this.preservedUnresolvedPaths.has(normalizePath(path)) || this.isStructuralPathPending(path);
	}

	/**
	 * Clear the preserved-unresolved marker for a path. Called when evidence
	 * arrives that the user intentionally wants this file to exist:
	 * - User explicitly edits the file (vault modify event, not suppressed)
	 * - User creates a new file at this path
	 * - User deletes the file locally
	 * - A future remote-delete arrives with a real baseline
	 */
	clearPreservedUnresolved(path: string): void {
		const normalized = normalizePath(path);
		if (this.preservedUnresolved.resolve(normalized)) {
			this.onPreservedUnresolvedChanged?.();
			this.trace?.("disk", "preserved-unresolved-cleared", {
				path: normalized,
				reason: "user-action-or-baseline-available",
			});
		}
	}

	recordPreservedUnresolved(
		path: string,
		reason: PreservedUnresolvedReason,
	): void {
		this.preservedUnresolved.record({
			path: normalizePath(path),
			kind: "markdown",
			reason,
		});
		this.onPreservedUnresolvedChanged?.();
	}

	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[] {
		return this.preservedUnresolved.getEntries();
	}

	async flushOpenWrites(reason: string): Promise<void> {
		const targets = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			targets.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			targets.add(path);
		}
		if (targets.size === 0) return;

		for (const path of targets) {
			const timer = this.openWriteTimers.get(path);
			if (timer) {
				window.clearTimeout(timer);
				this.openWriteTimers.delete(path);
			}
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, reason, true);
		}

		await this.kickDrain();
	}

	async flushOpenPath(path: string, reason: string): Promise<void> {
		path = normalizePath(path);
		const timer = this.openWriteTimers.get(path);
		const hadTimer = !!timer;
		if (timer) {
			window.clearTimeout(timer);
			this.openWriteTimers.delete(path);
		}
		const wasPending = this.pendingOpenWrites.delete(path);
		const wasQueued = this.writeQueue.has(path);
		if (!wasPending && !hadTimer && !wasQueued) {
			return;
		}
		this.queueImmediateWrite(path, reason, true);
		await this.kickDrain();
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get activeObserverCount(): number {
		return this.textObservers.size;
	}

	get pendingWriteCount(): number {
		return (
			this.writeQueue.size
			+ this.debounceTimers.size
			+ this.openWriteTimers.size
		);
	}

	getDebugSnapshot(): {
		observedPaths: string[];
		openPaths: string[];
		openPendingPaths: string[];
		queuedWrites: string[];
		debounceCount: number;
		openDebounceCount: number;
		suppressedCount: number;
		preservedUnresolved: ReturnType<PreservedUnresolvedRegistry["getSummary"]>;
	} {
		return {
			observedPaths: Array.from(this.textObservers.keys()),
			openPaths: Array.from(this.openPaths.keys()),
			openPendingPaths: Array.from(this.pendingOpenWrites.keys()),
			queuedWrites: Array.from(this.writeQueue.keys()),
			debounceCount: this.debounceTimers.size,
			openDebounceCount: this.openWriteTimers.size,
			suppressedCount: this.suppressedPaths.size,
			preservedUnresolved: this.preservedUnresolved.getSummary(),
		};
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

	/**
	 * Flush all pending writes and await completion before teardown.
	 *
	 * Safe ordering for plugin unload:
	 *   1. flushAllPendingWrites()  ← all writes complete, callbacks fire, hashes recorded
	 *   2. caller saves disk index  ← persists content hashes to data.json
	 *   3. destroy()                ← nothing pending, safe to clear state
	 *
	 * Covers:
	 *   - writeQueue (debounced bulk writes)
	 *   - pendingOpenWrites / openWriteTimers (deferred editor writes)
	 *   - existing drain promise (if already draining)
	 */
	async flushAllPendingWrites(): Promise<void> {
		// 1. Flush all pending open-file writes immediately (cancel their timers,
		//    flush now with force=true so editor guards don't defer again).
		const openPending = new Set<string>([
			...this.pendingOpenWrites,
			...this.openWriteTimers.keys(),
		]);
		for (const timer of this.openWriteTimers.values()) {
			window.clearTimeout(timer);
		}
		this.openWriteTimers.clear();
		this.pendingOpenWrites.clear();
		if (openPending.size > 0) {
			for (const path of openPending) {
				this.writeQueue.add(path);
				this.forcedWritePaths.add(path);
			}
		}

		// 2. Also flush anything sitting in the debounce timer queue (those
		//    haven't made it into writeQueue yet).
		const debouncePending = new Set<string>(this.debounceTimers.keys());
		for (const timer of this.debounceTimers.values()) {
			window.clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const path of debouncePending) {
			this.writeQueue.add(path);
		}

		// 3. Drain the write queue. If a drain is already running, await it
		//    then do one more pass to catch any items added during this flush.
		if (this.drainPromise) {
			await this.drainPromise;
		}
		if (this.writeQueue.size > 0) {
			await this.kickDrain();
		}

		// 4. Await any outstanding per-path write locks.
		await this.reconciliationWorker.whenIdle();
	}

	destroy(): void {
		this.resetReconciliationScope();
		const pendingFinalWrites = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			pendingFinalWrites.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			pendingFinalWrites.add(path);
		}
		for (const path of pendingFinalWrites) {
			this.forcedWritePaths.add(path);
		}
		void (async () => {
			for (const path of pendingFinalWrites) {
				if (!this.reconciliationWorker.isOperational) return;
				await this.flushWrite(path, true);
			}
		})().catch((error: unknown) => this.log(`final projections remain pending: ${String(error)}`));


		for (const [, obs] of this.textObservers) {
			obs.ytext.unobserve(obs.handler);
		}
		this.textObservers.clear();

		for (const timer of this.debounceTimers.values()) {
			window.clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.openWriteTimers.values()) {
			window.clearTimeout(timer);
		}
		this.openWriteTimers.clear();
		for (const timer of this.bodyObserverRetryTimers.values()) {
			window.clearTimeout(timer);
		}
		this.bodyObserverRetryTimers.clear();
		this.bodyObserverRetryAttempts.clear();

		this.writeQueue.clear();
		this.pendingOpenWrites.clear();
		this.openPaths.clear();
		this.forcedWritePaths.clear();
		this.suppressedPaths.clear();
		this.preservedUnresolved.clear();
		this.lastDiskWriteOkAt.clear();
		this.log("DiskMirror destroyed");
	}

	private log(msg: string): void {
		this.trace?.("disk", msg);
		if (this.debug) {
			console.debug(`[yaos:disk] ${msg}`);
		}
	}

	private hasRecentEditorActivity(path: string): boolean {
		const lastEditorActivity = this.editorBindings.getLastEditorActivityForPath(path);
		if (lastEditorActivity == null) return false;
		return Date.now() - lastEditorActivity < OPEN_FILE_ACTIVE_GRACE_MS;
	}

	private hasFocusedEditorUnflushedChanges(path: string, expectedCrdtContent: string | null): boolean {
		if (expectedCrdtContent == null) return false;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file?.path !== path) return false;
		try {
			return activeView.editor.getValue() !== expectedCrdtContent;
		} catch {
			// If the editor instance is in flux, conservatively defer one cycle.
			return true;
		}
	}

	private isActivelyViewedPath(path: string): boolean {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			return false;
		}
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path === path;
	}

	private queueImmediateWrite(path: string, reason: string, force = false): void {
		path = normalizePath(path);
		if (!this.admitWritePath(path)) return;
		if (force) {
			this.forcedWritePaths.add(path);
		}
		this.writeQueue.add(path);
		this.log(`queueImmediateWrite: "${path}" (${reason}${force ? ", forced" : ""})`);
		void this.kickDrain();
	}

	private getActiveSuppression(path: string): SuppressionEntry | null {
		path = normalizePath(path);
		const entry = this.suppressedPaths.get(path);
		if (!entry) return null;
		if (Date.now() < entry.expiresAt) {
			return entry;
		}
		this.suppressedPaths.delete(path);
		return null;
	}

	private async suppressWrite(path: string, content: string, remainingAcks = 1): Promise<void> {
		// Record the exact content before mutation so create/modify event order is
		// irrelevant and each matching Obsidian event consumes one acknowledgement.
		const fingerprint = await this.fingerprintContent(content);
		this.suppressedPaths.set(normalizePath(path), {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
			remainingAcks,
		});
	}

	private suppressDelete(path: string, remainingAcks = 1): void {
		this.suppressedPaths.set(normalizePath(path), {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
			remainingAcks,
		});
	}

	private async shouldSuppressWriteEvent(
		file: TFile,
		event: "modify" | "create",
	): Promise<boolean> {
		const path = normalizePath(file.path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;

		if (entry.kind !== "write") {
			this.suppressedPaths.delete(path);
			this.log(`suppression: "${path}" ${event} did not match pending delete`);
			this.trace?.("disk", "suppression-mismatch", {
				path,
				event,
				expectedKind: entry.kind,
				observedKind: "write",
				reason: "kind-mismatch",
			});
			this._flightEventHandler?.({
				priority: "critical",
				kind: "disk.event.not_suppressed",
				severity: "warn",
				scope: "file",
				source: "diskMirror",
				layer: "disk",
				path,
				data: { event, reason: "kind-mismatch", expectedKind: entry.kind },
			});
			return false;
		}


		try {
			// Read back the file only when a suppression candidate exists. This
			// keeps the hot path cheap while making self-event detection causal.
			const content = await this.reconciliationWorker.io("vault.read", () => this.app.vault.read(file));
			const fingerprint = await this.fingerprintContent(content);
			if (!this.isFileCurrent(file, path) || this.getActiveSuppression(path) !== entry) return false;
			if (
				fingerprint.bytes === entry.expectedBytes
				&& fingerprint.hash === entry.expectedHash
			) {
				const remaining = Math.max(0, (entry.remainingAcks ?? 1) - 1);
				if (remaining === 0) this.suppressedPaths.delete(path);
				else entry.remainingAcks = remaining;
				this.log(`suppression: acknowledged "${path}" ${event} (${remaining} remaining)`);
				this.trace?.("disk", "suppression-acknowledged", {
					path,
					event,
					kind: entry.kind,
					expectedBytes: entry.expectedBytes,
					expectedHashPrefix: hashPrefix(entry.expectedHash),
					remainingAcks: remaining,
				});
				return true;
			}
		} catch (err) {
			this.trace?.("disk", "suppression-mismatch", {
				path,
				event,
				expectedKind: entry.kind,
				reason: "read-failed",
				error: formatUnknown(err),
			});
			// If the file cannot be read here, fall through and let normal sync handle it.
		}

		this.suppressedPaths.delete(path);
		this.log(`suppression: "${path}" ${event} fingerprint mismatch`);
		this.trace?.("disk", "suppression-mismatch", {
			path,
			event,
			expectedKind: entry.kind,
			expectedBytes: entry.expectedBytes,
			expectedHashPrefix: hashPrefix(entry.expectedHash),
			reason: "fingerprint-mismatch",
		});
		this._flightEventHandler?.({
			priority: "critical",
			kind: "disk.event.not_suppressed",
			severity: "warn",
			scope: "file",
			source: "diskMirror",
			layer: "disk",
			path,
			data: {
				event,
				reason: "fingerprint-mismatch",
				expectedBytes: entry.expectedBytes,
				expectedHashPrefix: hashPrefix(entry.expectedHash),
			},
		});
		return false;
	}

	private async fingerprintContent(content: string): Promise<{ bytes: number; hash: string }> {
		return exactMarkdownDiskFingerprint(content);
	}

}
