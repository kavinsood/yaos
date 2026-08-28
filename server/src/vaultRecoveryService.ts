import { bytesToBase64Url } from "./base64url";
import { sha256Hex } from "./hex";
import type { VaultStore } from "./vaultStore";
import {
	CAPTURE_HARD_TTL_MS,
	CAPTURE_PLAN_STREAMS,
	CAPTURE_SOFT_TTL_MS,
	KEY_LEASE_TTL_MS,
	MAX_CAPTURE_PLAN_BYTES,
	MAX_CAPTURE_PLAN_ENTRIES,
	MAX_DEFECTS_PER_CALL,
	MAX_LEASE_KEYS,
	MAX_RECIPE_BODIES,
	MAX_RECIPE_BYTES,
	RECOVERY_RPC_HEADER,
	RECOVERY_DELTA_DIGEST_SEED,
	RECOVERY_PLAN_DIGEST_SEED,
	SWEEP_LEASE_TTL_MS,
	contentObjectKey,
	manifestObjectKey,
	snapshotRootObjectKey,
	type BodyRecipeDescriptor,
	type CaptureDescriptor,
	type CapturePlanEntry,
	type CapturePlanRequest,
	type CatalogDeltaEntry,
	type CapturePlanResponse,
	type CaptureStarted,
	type CaptureStatus,
	type CatalogDeltaPageRequest,
	type CatalogDeltaPageResponse,
	type ContentMaterialized,
	type CoverageCheckRequest,
	type CoverageCheckResponse,
	type FinalizeCaptureRequest,
	type FinalizedCapture,
	type GcDescriptor,
	type GcRootPage,
	type GcRootPageRequest,
	type IncrementalBase,
	type ManifestNodeMaterialized,
	type MaterializationLease,
	type MaterializationLeaseRequest,
	type RecipeChunk,
	type ProjectionLease,
	type ProjectionRecipeRequest,
	type ProjectionWorkPage,
	type ProjectionWorkPageRequest,
	type RecipeChunkRequest,
	type RecipeDescriptorRequest,
	type RecordRecoveryDefectsRequest,
	type RecoveryJobLeaseRequest,
	type RecoveryJobLeaseStatus,
	type RecoverySnapshotCatalogEntry,
	type RestoreDescriptor,
	type RestoreSelection,
	type StartCaptureRequest,
	type SweepLease,
	type SweepLeaseRequest,
} from "./recoveryProtocol";
import { canonicalJsonBytes as recoveryCanonicalJsonBytes, canonicalJsonText as recoveryCanonicalJsonText } from "./recoveryCanonicalJson";
import { parseAndVerifySnapshotRoot, readAndVerifyManifestNode } from "./recoveryManifestTree";
import type { ActorCallPort, AlarmPort, ObjectStorePort } from "./platformPorts";
import { recoveryJobId } from "./recoveryExecutor";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function digestChain(previousHex: string, label: string, pageHash: string): Promise<string> {
	const previous = new Uint8Array(previousHex.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
	const page = new Uint8Array(pageHash.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
	const labelBytes = new TextEncoder().encode(label);
	const bytes = new Uint8Array(previous.byteLength + labelBytes.byteLength + page.byteLength);
	bytes.set(previous);
	bytes.set(labelBytes, previous.byteLength);
	bytes.set(page, previous.byteLength + labelBytes.byteLength);
	return sha256Hex(bytes);
}

export interface VaultRecoveryServiceOptions {
	alarms: AlarmPort;
	objectStore?: ObjectStorePort;
	recoveryJobs?: ActorCallPort;
	store(): VaultStore;
	runtimeEpoch: string;
	flushLoadedDocuments(): Promise<void>;
	hasPendingPersistence(): boolean;
	fenceRuntime(): void;
	closeSockets(reason: string): void;
}

export class VaultRecoveryService {
	constructor(private readonly options: VaultRecoveryServiceOptions) {}
	private get objectStore(): ObjectStorePort | undefined { return this.options.objectStore; }
	private get store(): VaultStore { return this.options.store(); }
	private get runtimeEpoch(): string { return this.options.runtimeEpoch; }
	private flushLoadedDocuments(): Promise<void> { return this.options.flushLoadedDocuments(); }
	async initializeProjection(vaultId: string): Promise<void> {
		await this.ensureRecoveryProjection(vaultId);
	}

	async startRecoveryCapture(input: StartCaptureRequest): Promise<CaptureStarted> {

		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		try {
			await this.ensureRecoveryProjection(input.vaultId);
		} catch (error) {
			console.warn("[yaos-vault] recovery projection refresh failed", errorMessage(error));
		}
		if (!this.objectStore) throw new Error("recovery storage unavailable");
		this.store.reapExpiredRecoveryCaptures();
		const gc = this.store.latestGcEpoch();
		if (gc?.state === "marking") throw new Error("capture admission paused for GC mark");
		const existing = this.store.recoveryCaptureByRequest(input.requestId);
		if (existing?.state === "queued") return this.captureStarted(existing);
		if (existing && existing.state !== "initializing") {
			if (existing.state === "complete") return this.captureStarted({ ...existing, state: "queued" });
			throw new Error(`capture request is ${existing.state}`);
		}
		if (!existing && this.store.activeRecoveryCapture()) throw new Error("exact capture already active");
		if (!existing) {
			await this.flushLoadedDocuments();
			if (this.options.hasPendingPersistence()) throw new Error("capture flush incomplete");
		}
		const vaultGeneration = this.requireVaultGeneration(input.vaultId);
		const boundarySequence = existing?.boundarySequence ?? this.store.currentSequence();
		const rootGeneration = existing?.rootGeneration ?? (this.store.documentHead("root")?.generation ?? 0);
		const captureId = existing?.captureId ?? crypto.randomUUID();
		const jobId = recoveryJobId("capture", input.vaultId, vaultGeneration, captureId);
		let descriptor = existing;
		let capability: string | null = null;
		const initialized = await this.recoveryJobJson<
			{ initialized: false } | {
				initialized: true; jobId: string; vaultId: string; kind: string; boundarySequence: number | null;
				capabilityHash: string; capabilityExpiresAt: number | null;
			}
		>(input.vaultId, jobId, "/__yaos/recovery-job/initialization", "GET");
		if (!descriptor) {
			capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			const capabilityHash = await sha256Hex(new TextEncoder().encode(capability));
			const now = Date.now();
			const base = this.store.latestSnapshotBefore(boundarySequence);
			descriptor = this.store.createRecoveryCapture({
				captureId,
				requestId: input.requestId,
				vaultId: input.vaultId,
				vaultGeneration,
				boundarySequence,
				rootGeneration,
				runtimeEpoch: this.runtimeEpoch,
				reason: input.reason,
				jobId,
				capabilityHash,
				capabilityExpiresAt: now + CAPTURE_HARD_TTL_MS,
				softExpiresAt: now + CAPTURE_SOFT_TTL_MS,
				hardExpiresAt: now + CAPTURE_HARD_TTL_MS,
				baseSnapshotId: base?.snapshotId ?? null,
				gcEpoch: gc?.state === "sweeping" ? gc.epoch : null,
				now,
			});
		}
		if (initialized.initialized) {
			if (initialized.jobId !== descriptor.jobId || initialized.kind !== "capture"
				|| initialized.boundarySequence !== descriptor.boundarySequence
				|| initialized.capabilityHash !== descriptor.capabilityHash) {
				this.store.setRecoveryCaptureState(descriptor.captureId, "failed", "job_initialization_mismatch");
				this.store.releasePin(descriptor.captureId);
				throw new Error("capture job initialization mismatch");
			}
		} else {
			if (capability === null) {
				capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
				descriptor = this.store.replaceInitializingCapability(
					descriptor.captureId,
					await sha256Hex(new TextEncoder().encode(capability)),
					descriptor.capabilityExpiresAt,
				);
			}
			await this.recoveryJobJson(input.vaultId, jobId, "/__yaos/recovery-job/initialize", "POST", {
				jobId,
				vaultId: descriptor.vaultId,
				vaultGeneration: descriptor.vaultGeneration,
				createdAt: descriptor.createdAt,
				capability,
				capabilityExpiresAt: descriptor.capabilityExpiresAt,
				captureId: descriptor.captureId,
				snapshotId: descriptor.captureId,
				boundarySequence: descriptor.boundarySequence,
				rootGeneration: descriptor.rootGeneration,
				runtimeEpoch: descriptor.runtimeEpoch,
				reason: descriptor.reason,
				pinSoftExpiresAt: descriptor.pinSoftExpiresAt,
				pinHardExpiresAt: descriptor.pinHardExpiresAt,
			});
			const accepted = await this.recoveryJobJson<
				{ initialized: false } | { initialized: true; jobId: string; capabilityHash: string; boundarySequence: number | null }
			>(input.vaultId, jobId, "/__yaos/recovery-job/initialization", "GET");
			if (!accepted.initialized || accepted.capabilityHash !== descriptor.capabilityHash
				|| accepted.jobId !== descriptor.jobId || accepted.boundarySequence !== descriptor.boundarySequence) {
				throw new Error("capture job did not durably accept initialization");
			}
		}
		descriptor = this.store.setRecoveryCaptureState(descriptor.captureId, "queued");
		await this.options.alarms.setAlarm(Date.now() + 60_000);
		return this.captureStarted(descriptor);
	}
	async beginVaultDeletion(input: { vaultId: string; deletionId: string }): Promise<void> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const jobsToCancel = this.store.beginVaultDeletion(input.deletionId, this.requireVaultGeneration(input.vaultId));
		this.options.fenceRuntime();
		this.options.closeSockets("vault deleting");
		for (const jobId of jobsToCancel.captureJobIds) {
			await this.recoveryJobJson(input.vaultId, jobId, "/__yaos/recovery-job/cancel", "POST");
		}
		for (const restoreId of jobsToCancel.restoreIds) {
			await this.recoveryJobJson(
				input.vaultId,
				recoveryJobId("restore", input.vaultId, this.requireVaultGeneration(input.vaultId), restoreId),
				"/__yaos/recovery-job/cancel",
				"POST",
			);
		}
	}

	async getRecoveryCaptureStatus(input: { vaultId: string; captureId: string }): Promise<CaptureStatus | null> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		let capture = this.store.recoveryCapture(input.captureId);
		if (!capture) return null;
		const status = await this.recoveryJobJson<CaptureStatus>(
			input.vaultId,
			capture.jobId,
			"/__yaos/recovery-job/status",
			"GET",
		);
		if ((status.state === "failed" || status.state === "cancelled") && capture.state !== status.state) {
			capture = this.store.setRecoveryCaptureState(
				capture.captureId,
				status.state,
				status.error?.code ?? status.state,
			);
			this.store.releasePin(capture.captureId);
		}
		return {
			captureId: input.captureId,
			state: status.state,
			boundarySequence: capture.boundarySequence,
			processedEntries: status?.processedEntries ?? 0,
			totalEntries: status?.totalEntries ?? null,
			contentObjectsWritten: status?.contentObjectsWritten ?? 0,
			contentObjectsReused: status?.contentObjectsReused ?? 0,
			manifestNodesWritten: status?.manifestNodesWritten ?? 0,
			bytesRead: status?.bytesRead ?? 0,
			bytesWritten: status?.bytesWritten ?? 0,
			retryCount: status?.retryCount ?? 0,
			nextAttemptAt: status?.nextAttemptAt ?? null,
			pinSoftExpiresAt: capture.pinSoftExpiresAt || null,
			pinHardExpiresAt: capture.pinHardExpiresAt || null,
			snapshotId: status.state === "complete" || status.state === "complete_with_gaps" ? capture.captureId : null,
			error: status.error ?? (capture.error ? { code: capture.error, reference: null } : null),
		};
	}

	async cancelRecoveryCapture(input: { vaultId: string; captureId: string }): Promise<CaptureStatus> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const capture = this.store.recoveryCapture(input.captureId);
		if (!capture) throw new Error("capture not found");
		if (capture.state === "complete") throw new Error("complete capture cannot be cancelled");
		if (capture.state !== "cancelled") {
			this.store.setRecoveryCaptureState(input.captureId, "cancelled", null);
			await this.recoveryJobJson(input.vaultId, capture.jobId, "/__yaos/recovery-job/cancel", "POST");
		}
		return (await this.getRecoveryCaptureStatus(input))!;
	}

	async acknowledgeJobCancelled(request: RecoveryJobLeaseRequest): Promise<void> {
		const capture = this.store.recoveryCapture(request.captureId);
		if (!capture || capture.state !== "cancelled" || capture.boundarySequence !== request.boundarySequence) {
			throw new Error("capture cancellation not requested");
		}
		if (await sha256Hex(new TextEncoder().encode(request.capability)) !== capture.capabilityHash) {
			throw new Error("capture capability mismatch");
		}
		this.store.releasePin(request.captureId);
		this.store.releaseSnapshotDependencies("capture", request.captureId);
	}

	async checkRecoveryJobLease(request: RecoveryJobLeaseRequest): Promise<RecoveryJobLeaseStatus> {
		const capture = await this.assertCaptureAuthority(request);
		if (request.progress !== undefined) this.store.renewRecoveryCapture(request.captureId, request.progress);
		const current = this.store.recoveryCapture(request.captureId)!;
		return {
			valid: true,
			captureId: current.captureId,
			boundarySequence: current.boundarySequence,
			state: current.state,
			softExpiresAt: current.pinSoftExpiresAt,
			hardExpiresAt: current.pinHardExpiresAt,
			baseSnapshotId: capture.baseSnapshotId,
		};
	}

	async getCapturePlanPage(request: CapturePlanRequest): Promise<CapturePlanResponse> {
		const capture = await this.assertCaptureAuthority(request);
		if (!CAPTURE_PLAN_STREAMS.includes(request.stream)
			|| !Number.isSafeInteger(request.maxEntries) || request.maxEntries <= 0
			|| request.maxEntries > MAX_CAPTURE_PLAN_ENTRIES
			|| !Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes <= 0
			|| request.maxResponseBytes > MAX_CAPTURE_PLAN_BYTES) throw new Error("invalid capture plan bounds");
		const candidates = this.store.listCapturePlanAt(capture.captureId, request.stream, request.cursor, request.maxEntries + 1);
		const entries: CapturePlanEntry[] = [];
		for (const entry of candidates.slice(0, request.maxEntries)) {
			const candidate = [...entries, entry];
			if (recoveryCanonicalJsonBytes(candidate).byteLength > request.maxResponseBytes) {
				if (entries.length === 0) throw new Error("capture plan entry exceeds response bound");
				break;
			}
			entries.push(entry);
		}
		const key = (entry: CapturePlanEntry): string => entry.kind === "active" ? entry.canonicalPath
			: entry.kind === "deleted" ? entry.bodyId : entry.canonicalPath;
		const hasMore = entries.length < candidates.length;
		const nextCursor = hasMore ? key(entries.at(-1)!) : null;
		const terminal = !hasMore;
		const canonical = { entries, nextCursor, terminal };
		const pageHash = await sha256Hex(recoveryCanonicalJsonBytes(canonical));
		const committed = this.store.planPageCommitment(capture.captureId, request.stream, request.cursor);
		let planDigest: string;
		if (committed) {
			if (committed.pageHash !== pageHash || committed.endCursor !== nextCursor || committed.terminal !== terminal) {
				throw new Error("capture plan retry changed at fixed boundary");
			}
			planDigest = committed.rollingDigest;
		} else {
			const previous = capture.planDigest ?? await sha256Hex(new TextEncoder().encode(RECOVERY_PLAN_DIGEST_SEED));
			planDigest = await digestChain(previous, request.stream, pageHash);
			this.store.recordPlanPage({
				captureId: capture.captureId,
				stream: request.stream,
				startCursor: request.cursor,
				endCursor: nextCursor,
				pageHash,
				entries: entries.length,
				terminal,
				rollingDigest: planDigest,
			});
		}
		const hashes = entries.flatMap((entry) => entry.kind === "active" ? [entry.contentHash]
			: entry.kind === "deleted" ? [entry.baselineContentHash] : []);
		const missing = new Set(this.store.missingCoverage(capture.captureId, hashes, [], capture.gcEpoch).contentHashes);
		const casHints = Object.fromEntries(hashes.map((hash) => [hash, !missing.has(hash)]));
		return { ...canonical, casHints, pageHash, planDigest };
	}

	async getRecipeDescriptors(request: RecipeDescriptorRequest): Promise<BodyRecipeDescriptor[]> {
		const capture = await this.assertCaptureAuthority(request);
		if (request.entries.length > MAX_RECIPE_BODIES) throw new Error("recipe descriptor batch too large");
		return request.entries.map((entry) => this.store.bindRecipe(
			capture.captureId,
			entry.bodyId,
			entry.generation,
			`${capture.captureId}:${entry.bodyId}:${entry.generation}`,
		));
	}

	async getRecipeChunk(request: RecipeChunkRequest): Promise<RecipeChunk> {
		await this.assertCaptureAuthority(request);
		if (!Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes <= 0 || request.maxResponseBytes > MAX_RECIPE_BYTES) {
			throw new Error("invalid recipe byte bound");
		}
		const chunk = this.store.rawRecipeChunk(request.recipeId, request.cursor, request.maxResponseBytes);
		if (chunk.encodedBytes > MAX_RECIPE_BYTES) throw new Error("durable update exceeds recipe hard bound");
		return { recipeId: request.recipeId, cursor: request.cursor, ...chunk };
	}

	async acquireMaterializationLease(request: MaterializationLeaseRequest): Promise<MaterializationLease> {
		if (request.objectKeys.length === 0 || request.objectKeys.length > MAX_LEASE_KEYS || new Set(request.objectKeys).size !== request.objectKeys.length) {
			throw new Error("invalid materialization lease keys");
		}
		if (request.ownerKind === "capture") {
			await this.assertCaptureAuthority({ captureId: request.ownerId, capability: request.capability });
		} else {
			await this.assertProjectionAuthority(request.ownerId, request.capability);
		}
		const ttl = Math.min(KEY_LEASE_TTL_MS, Math.max(1_000, request.ttlMs ?? KEY_LEASE_TTL_MS));
		return this.store.acquireMaterializationLease({
			leaseId: crypto.randomUUID(),
			ownerKind: request.ownerKind,
			ownerId: request.ownerId,
			objectKeys: request.objectKeys,
			expiresAt: Date.now() + ttl,
		});
	}

	async releaseMaterializationLease(leaseId: string): Promise<void> {
		if (!leaseId) throw new Error("invalid lease ID");
		this.store.releaseKeyLease(leaseId);
	}

	async acknowledgeContentMaterialized(request: ContentMaterialized): Promise<void> {
		const capture = await this.assertCaptureAuthority(request);
		if (request.objectKey !== contentObjectKey(capture.vaultId, capture.vaultGeneration, request.contentHash)) throw new Error("invalid content object key");
		if (!this.store.hasMaterializationLease(capture.captureId, request.objectKey)) throw new Error("content materialization lease missing");
		this.store.recordContentMaterialized({ ...request });
	}

	async acknowledgeManifestNodeMaterialized(request: ManifestNodeMaterialized): Promise<void> {
		const capture = await this.assertCaptureAuthority(request);
		if (request.objectKey !== manifestObjectKey(capture.vaultId, capture.vaultGeneration, request.nodeHash)) throw new Error("invalid manifest object key");
		if (!this.store.hasMaterializationLease(capture.captureId, request.objectKey)) throw new Error("manifest materialization lease missing");
		this.store.recordManifestNode({ ...request });
	}
	async acknowledgeManifestNodesMaterialized(request: {
		captureId: string;
		boundarySequence: number;
		capability: string;
		nodes: ManifestNodeMaterialized[];
	}): Promise<void> {
		if (!Array.isArray(request.nodes) || request.nodes.length === 0 || request.nodes.length > 128) throw new Error("invalid manifest acknowledgement batch");
		const capture = await this.assertCaptureAuthority(request);
		for (const node of request.nodes) {
			if (node.captureId !== request.captureId || node.boundarySequence !== request.boundarySequence || node.capability !== request.capability) {
				throw new Error("manifest acknowledgement authority mismatch");
			}
			if (node.objectKey !== manifestObjectKey(capture.vaultId, capture.vaultGeneration, node.nodeHash)) throw new Error("invalid manifest object key");
			if (!this.store.hasMaterializationLease(capture.captureId, node.objectKey)) throw new Error("manifest materialization lease missing");
		}
		for (const node of request.nodes) this.store.recordManifestNode(node);
	}

	async checkRecoveryCoverage(request: CoverageCheckRequest): Promise<CoverageCheckResponse> {
		const capture = await this.assertCaptureAuthority(request);
		if (request.contentHashes.length > MAX_CAPTURE_PLAN_ENTRIES || (request.nodeHashes?.length ?? 0) > MAX_CAPTURE_PLAN_ENTRIES) {
			throw new Error("coverage request too large");
		}
		const missing = this.store.missingCoverage(capture.captureId, request.contentHashes, request.nodeHashes ?? [], capture.gcEpoch);
		return { missingContentHashes: missing.contentHashes, missingNodeHashes: missing.nodeHashes };
	}


	async rotateRecoveryProjectionLease(input: { vaultId: string; enabled: boolean; ttlMs?: number }): Promise<{
		lease: ProjectionLease; capability: string;
	}> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
		const capabilityHash = await sha256Hex(new TextEncoder().encode(capability));
		const leaseId = crypto.randomUUID();
		const now = Date.now();
		const expiresAt = now + Math.min(CAPTURE_HARD_TTL_MS, Math.max(60_000, input.ttlMs ?? CAPTURE_HARD_TTL_MS));
		this.store.rotateProjectionLease({

			vaultId: input.vaultId,
			vaultGeneration: this.requireVaultGeneration(input.vaultId),
			leaseId,
			capabilityHash,
			expiresAt,
			runtimeEpoch: this.runtimeEpoch,
			enabled: input.enabled,
			now,
		});
		return {
			lease: {
				vaultId: input.vaultId,
				vaultGeneration: this.requireVaultGeneration(input.vaultId),
				leaseId,
				capabilityHash,
				expiresAt,
				enabled: input.enabled,
				runtimeEpoch: this.runtimeEpoch,
			},
			capability,
		};
	}
	private async ensureRecoveryProjection(vaultId: string): Promise<void> {
		if (!this.objectStore) return;
		const jobId = recoveryJobId("projection", vaultId, this.requireVaultGeneration(vaultId));
		const initialized = await this.recoveryJobJson<
			{ initialized: false } | {
				initialized: true;
				jobId: string;
				kind: string;
				capabilityHash: string;
				capabilityExpiresAt: number | null;
			}
		>(vaultId, jobId, "/__yaos/recovery-job/initialization", "GET");
		const current = this.store.projectionLease();
		const now = Date.now();
		if (
			initialized.initialized
			&& initialized.jobId === jobId
			&& initialized.kind === "projection"
			&& current?.enabled
			&& current.expiresAt > now + 60_000
			&& initialized.capabilityHash === current.capabilityHash
		) {
			const status = await this.recoveryJobJson<{ state: string }>(
				vaultId,
				jobId,
				"/__yaos/recovery-job/status",
				"GET",
			);
			if (status.state !== "failed" && status.state !== "cancelled") {
				await this.recoveryJobJson(
					vaultId,
					jobId,
					"/__yaos/recovery-job/projection/wake",
					"POST",
				);
				return;
			}
		}
		const rotated = await this.rotateRecoveryProjectionLease({
			vaultId,
			enabled: true,
			ttlMs: CAPTURE_HARD_TTL_MS,
		});
		const descriptor = {
			jobId,
			vaultId,
			vaultGeneration: this.requireVaultGeneration(vaultId),
			createdAt: now,
			capability: rotated.capability,
			capabilityExpiresAt: rotated.lease.expiresAt,
			leaseId: rotated.lease.leaseId,
		};
		await this.recoveryJobJson(
			vaultId,
			jobId,
			initialized.initialized
				? "/__yaos/recovery-job/projection/refresh"
				: "/__yaos/recovery-job/initialize",
			"POST",
			descriptor,
		);
	}

	async getProjectionWorkPage(request: ProjectionWorkPageRequest): Promise<ProjectionWorkPage> {
		await this.assertProjectionAuthority(request.leaseId, request.capability);
		if (this.store.vaultMetadata()?.vaultId !== request.vaultId) throw new Error("vault identity mismatch");
		if (request.maxEntries <= 0 || request.maxEntries > MAX_CAPTURE_PLAN_ENTRIES
			|| request.maxResponseBytes <= 0 || request.maxResponseBytes > MAX_CAPTURE_PLAN_BYTES) {
			throw new Error("invalid projection work bounds");
		}
		const boundary = this.store.currentSequence();
		const scanned = this.store.listActiveCatalogAt(boundary, request.cursor ?? "", request.maxEntries + 1);
		const page = scanned.slice(0, request.maxEntries);
		const hashes = page.flatMap((entry) => entry.contentHash ? [entry.contentHash] : []);
		const missing = new Set(this.store.missingIndexedContent(hashes));
		const entries = page.flatMap((entry) => {
			if (entry.contentHash === null || entry.size === null) throw new Error("projection catalog identity missing");
			return missing.has(entry.contentHash) ? [{
				bodyId: entry.bodyId, generation: entry.generation, contentHash: entry.contentHash, size: entry.size,
			}] : [];
		});
		if (recoveryCanonicalJsonBytes(entries).byteLength > request.maxResponseBytes) throw new Error("projection work page exceeds byte bound");
		const terminal = scanned.length <= request.maxEntries;
		return { entries, nextCursor: terminal ? null : page.at(-1)!.bodyId, terminal };
	}

	async checkProjectionLease(
		request: { vaultId: string; vaultGeneration: string; leaseId: string; capability: string },
	): Promise<ProjectionLease> {
		if (this.store.vaultMetadata()?.vaultId !== request.vaultId) throw new Error("vault identity mismatch");
		await this.assertProjectionAuthority(request.leaseId, request.capability);
		const lease = this.store.projectionLease()!;
		return { vaultId: request.vaultId, ...lease };
	}

	async getProjectionRecipeDescriptor(request: ProjectionRecipeRequest): Promise<BodyRecipeDescriptor> {
		await this.assertProjectionAuthority(request.leaseId, request.capability);
		if (this.store.vaultMetadata()?.vaultId !== request.vaultId) throw new Error("vault identity mismatch");
		const boundary = this.store.currentSequence();
		const head = this.store.getCatalogHeadAt(boundary, request.bodyId);
		const durableHead = this.store.documentHead(request.bodyId);
		if (!head || head.lifecycle !== "active" || !durableHead || durableHead.generation !== request.expectedHeadGeneration
			|| head.generation !== request.expectedHeadGeneration || head.contentHash === null || head.size === null) {
			throw new Error("projection head superseded");
		}
		return {
			recipeId: `projection:${request.leaseId}:${request.bodyId}:${request.expectedHeadGeneration}:${boundary}`,
			bodyId: request.bodyId,
			generation: request.expectedHeadGeneration,
			expectedContentHash: head.contentHash,
			expectedSize: head.size,
			encodedHistoryBytes: this.store.documentEncodedHistoryBytes(request.bodyId, boundary),
			firstCursor: "0",
		};
	}

	async getProjectionRecipeChunk(request: ProjectionRecipeRequest & {
		recipeId: string; cursor: string; maxResponseBytes: number;
	}): Promise<RecipeChunk> {
		await this.assertProjectionAuthority(request.leaseId, request.capability);
		if (request.maxResponseBytes <= 0 || request.maxResponseBytes > MAX_RECIPE_BYTES) throw new Error("invalid recipe byte bound");
		const parts = request.recipeId.split(":");
		const boundary = Number(parts.at(-1));
		const generation = Number(parts.at(-2));
		if (!Number.isSafeInteger(boundary) || !Number.isSafeInteger(generation)
			|| generation !== request.expectedHeadGeneration
			|| request.recipeId !== `projection:${request.leaseId}:${request.bodyId}:${generation}:${boundary}`) {
			throw new Error("invalid projection recipe");
		}
		const head = this.store.getCatalogHeadAt(this.store.currentSequence(), request.bodyId);
		if (!head || head.lifecycle !== "active" || head.generation !== generation) throw new Error("projection head superseded");
		const chunk = this.store.rawDocumentRecipeChunk(request.bodyId, boundary, request.cursor, request.maxResponseBytes);
		return { recipeId: request.recipeId, cursor: request.cursor, ...chunk };
	}

	async acknowledgeProjectionContentMaterialized(request: ProjectionRecipeRequest & {
		contentHash: string; plainBytes: number; objectKey: string;
	}): Promise<void> {
		await this.assertProjectionAuthority(request.leaseId, request.capability);
		const head = this.store.getCatalogHeadAt(this.store.currentSequence(), request.bodyId);
		if (!head || head.lifecycle !== "active" || head.generation !== request.expectedHeadGeneration
			|| head.contentHash !== request.contentHash || head.size !== request.plainBytes
			|| request.objectKey !== contentObjectKey(request.vaultId, request.vaultGeneration, request.contentHash)) {
			throw new Error("projection materialization superseded or mismatched");
		}
		if (!this.store.hasMaterializationLease(request.leaseId, request.objectKey)) throw new Error("projection materialization lease missing");
		const gc = this.store.latestGcEpoch();
		this.store.recordProjectedContent(
			request.contentHash,
			request.objectKey,
			request.plainBytes,
			gc?.state === "sweeping" ? gc.epoch : null,
		);
	}
	async getIncrementalBase(request: RecoveryJobLeaseRequest): Promise<IncrementalBase | null> {
		const capture = await this.assertCaptureAuthority(request);
		if (!capture.baseSnapshotId) return null;
		const base = this.store.snapshot(capture.baseSnapshotId);
		return base ? { snapshotId: base.snapshotId, boundarySequence: base.boundarySequence, rootKey: base.rootKey, rootHash: base.rootHash } : null;
	}

	async getCatalogDeltaPage(request: CatalogDeltaPageRequest): Promise<CatalogDeltaPageResponse> {
		const capture = await this.assertCaptureAuthority(request);
		if (request.afterSequence < this.store.journalFloor() || request.afterSequence >= capture.boundarySequence
			|| request.maxEntries <= 0 || request.maxEntries > MAX_CAPTURE_PLAN_ENTRIES
			|| request.maxResponseBytes <= 0 || request.maxResponseBytes > MAX_CAPTURE_PLAN_BYTES) {
			throw new Error("delta source unavailable or bounds invalid");
		}
		const candidates = this.store.catalogDeltaAt(request.afterSequence, capture.boundarySequence, request.cursor, request.maxEntries + 1);
		const entries: CatalogDeltaEntry[] = [];
		for (const entry of candidates.slice(0, request.maxEntries)) {
			if (recoveryCanonicalJsonBytes([...entries, entry]).byteLength > request.maxResponseBytes) {
				if (entries.length === 0) throw new Error("delta entry exceeds response bound");
				break;
			}
			entries.push(entry);
		}
		const terminal = entries.length === candidates.length;
		const last = entries.at(-1);
		const nextCursor = terminal || !last ? null : `${last.sequence}:${last.order}`;
		const pageHash = await sha256Hex(recoveryCanonicalJsonBytes({ entries, nextCursor, terminal }));
		const committed = this.store.deltaPageCommitment(capture.captureId, request.cursor);
		let deltaDigest: string;
		if (committed) {
			if (committed.pageHash !== pageHash || committed.endCursor !== nextCursor || committed.terminal !== terminal) {
				throw new Error("capture delta retry changed at fixed boundary");
			}
			deltaDigest = committed.rollingDigest;
		} else {
			const previous = capture.deltaDigest ?? await sha256Hex(new TextEncoder().encode(RECOVERY_DELTA_DIGEST_SEED));
			deltaDigest = await digestChain(previous, "delta", pageHash);
			this.store.recordDeltaPage({
				captureId: capture.captureId,
				startCursor: request.cursor,
				endCursor: nextCursor,
				pageHash,
				entries: entries.length,
				terminal,
				rollingDigest: deltaDigest,
			});
		}
		return { entries, nextCursor, terminal, pageHash, deltaDigest };
	}

	async resetCaptureDelta(request: RecoveryJobLeaseRequest): Promise<void> {
		await this.assertCaptureAuthority(request);
		this.store.resetCaptureDelta(request.captureId);
	}

	async recordRecoveryDefects(request: RecordRecoveryDefectsRequest): Promise<void> {
		await this.assertCaptureAuthority(request);
		if (request.defects.length === 0 || request.defects.length > MAX_DEFECTS_PER_CALL
			|| request.defects.some((defect) => defect.captureId !== request.captureId)) throw new Error("invalid recovery defects");
		this.store.recordRecoveryDefects(request.defects);
	}

	async finalizeCapture(request: FinalizeCaptureRequest): Promise<FinalizedCapture> {
		const capture = await this.assertCaptureAuthority(request);
		if (!this.objectStore) throw new Error("recovery storage unavailable");
		if (request.snapshotRootKey !== snapshotRootObjectKey(capture.vaultId, capture.vaultGeneration, request.snapshotRootHash)) throw new Error("invalid snapshot root key");
		const rootObject = await this.objectStore.get(request.snapshotRootKey);
		if (!rootObject || rootObject.size > MAX_CAPTURE_PLAN_BYTES) throw new Error("snapshot root missing or oversized");
		const rootBytes = rootObject.bytes;
		const root = await parseAndVerifySnapshotRoot(rootBytes, request.snapshotRootHash);
		const vaultIdHash = await sha256Hex(new TextEncoder().encode(capture.vaultId));
		const vaultGenerationHash = await sha256Hex(new TextEncoder().encode(capture.vaultGeneration));
		if (root.snapshotId !== capture.captureId || root.vaultIdHash !== vaultIdHash
			|| root.vaultGenerationHash !== vaultGenerationHash || root.runtimeEpoch !== capture.runtimeEpoch
			|| root.boundarySequence !== capture.boundarySequence || root.rootGeneration !== capture.rootGeneration
			|| root.sourcePlanDigest !== request.sourcePlanDigest || root.manifestGraphDigest !== request.manifestGraphDigest
			|| root.manifestNodeCount !== request.manifestNodeCount || recoveryCanonicalJsonText(root.totals) !== recoveryCanonicalJsonText(request.totals)
			|| root.createdAt !== new Date(capture.createdAt).toISOString()
			|| root.completedAt !== new Date(request.completedAt).toISOString()
			|| root.reason !== capture.reason || root.previousSnapshotId !== capture.baseSnapshotId) {
			throw new Error("snapshot root authority mismatch");
		}
		const nodeSource = {
			readNode: async (hash: string): Promise<Uint8Array | null> => {
				const object = await this.objectStore!.get(manifestObjectKey(capture.vaultId, capture.vaultGeneration, hash));
				return object?.bytes ?? null;
			},
		};
		const activeRoot = await readAndVerifyManifestNode(nodeSource, "active", root.activeFilesTreeHash);
		const deletedRoot = await readAndVerifyManifestNode(nodeSource, "deleted", root.deletedFilesTreeHash);
		const attachmentRoot = await readAndVerifyManifestNode(nodeSource, "attachments", root.attachmentsTreeHash);
		if (activeRoot.subtreeEntries !== capture.plannedActiveFiles || deletedRoot.subtreeEntries !== capture.plannedDeletedFiles
			|| attachmentRoot.subtreeEntries !== capture.plannedAttachments
			|| activeRoot.subtreeNodes + deletedRoot.subtreeNodes + attachmentRoot.subtreeNodes !== request.manifestNodeCount) {
			throw new Error("snapshot tree root counts mismatch");
		}
		if (request.totals.activeFiles !== capture.plannedActiveFiles
			|| request.totals.deletedFiles !== capture.plannedDeletedFiles
			|| request.totals.attachments !== capture.plannedAttachments) throw new Error("snapshot totals mismatch");
		const coverage = this.store.finalizationCoverage(capture.captureId);
		if (coverage.missingMarkdown !== 0 || coverage.manifestNodes !== request.manifestNodeCount
			|| request.totals.unavailableFiles !== coverage.defects) {
			throw new Error(
				`snapshot coverage incomplete: missingMarkdown=${coverage.missingMarkdown}, ` +
				`manifestNodes=${coverage.manifestNodes}/${request.manifestNodeCount}, ` +
				`defects=${coverage.defects}/${request.totals.unavailableFiles}`,
			);
		}
		const snapshot = this.store.finalizeRecoveryCapture({
			captureId: capture.captureId,
			rootKey: request.snapshotRootKey,
			rootHash: request.snapshotRootHash,
			sourcePlanDigest: request.sourcePlanDigest,
			sourceDeltaDigest: request.sourceDeltaDigest,
			manifestNodeCount: request.manifestNodeCount,
			reason: capture.reason,
			completedAt: request.completedAt,
		});
		return { snapshotId: snapshot.snapshotId, rootKey: snapshot.rootKey, rootHash: snapshot.rootHash, completedAt: snapshot.completedAt, state: "complete" };
	}

	async listRecoverySnapshots(input: { vaultId: string; cursor: string | null; limit: number }): Promise<{
		snapshots: RecoverySnapshotCatalogEntry[]; nextCursor: string | null;
	}> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const snapshots = this.store.listSnapshots(input.cursor, input.limit);
		return { snapshots, nextCursor: snapshots.length === input.limit ? snapshots.at(-1)!.snapshotId : null };
	}

	async getRecoverySnapshot(input: { vaultId: string; snapshotId: string }): Promise<RecoverySnapshotCatalogEntry | null> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		return this.store.snapshot(input.snapshotId);
	}

	async authorizeRecoverySnapshotRead(
		input: { vaultId: string; snapshotId: string },
	): Promise<{ snapshotId: string; vaultGeneration: string; rootKey: string; rootHash: string } | null> {
		const snapshot = await this.getRecoverySnapshot(input);
		return snapshot ? { snapshotId: input.snapshotId, vaultGeneration: this.requireVaultGeneration(input.vaultId), rootKey: snapshot.rootKey, rootHash: snapshot.rootHash } : null;
	}

	async deleteRecoverySnapshot(input: { vaultId: string; snapshotId: string }): Promise<{ deleted: boolean }> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		return { deleted: this.store.deleteSnapshot(input.snapshotId) };
	}

	async startRecoveryRestore(input: {
		vaultId: string; requestId: string; snapshotId: string; selection: RestoreSelection;
	}): Promise<unknown> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		this.store.reapExpiredRestoreAuthorities();
		if (!this.store.snapshot(input.snapshotId)) throw new Error("snapshot not found");
		let authority = this.store.restoreAuthorityByRequest(input.requestId);
		const active = this.store.activeRestoreAuthority();
		if (active && active.restoreId !== authority?.restoreId) throw new Error("another restore is active");
		let capability: string | null = null;
		if (!authority) {
			const now = Date.now();
			const restoreId = crypto.randomUUID();
			const jobId = recoveryJobId("restore", input.vaultId, this.requireVaultGeneration(input.vaultId), restoreId);
			capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			authority = this.store.createRestoreAuthority({
				restoreId, requestId: input.requestId, vaultId: input.vaultId, vaultGeneration: this.requireVaultGeneration(input.vaultId), snapshotId: input.snapshotId,
				selection: input.selection, jobId,
				capabilityHash: await sha256Hex(new TextEncoder().encode(capability)),
				capabilityExpiresAt: now + CAPTURE_HARD_TTL_MS, now,
			});
		} else if (authority.snapshotId !== input.snapshotId
			|| recoveryCanonicalJsonText(authority.selection) !== recoveryCanonicalJsonText(input.selection)) {
			throw new Error("restore request ID collision");
		}
		try {
			const initialized = await this.recoveryJobJson<
				{ initialized: false } | { initialized: true; jobId: string; kind: string; capabilityHash: string }
			>(input.vaultId, authority.jobId, "/__yaos/recovery-job/initialization", "GET");
			if (initialized.initialized) {
				if (initialized.jobId !== authority.jobId || initialized.kind !== "restore"
					|| initialized.capabilityHash !== authority.capabilityHash) throw new Error("restore initialization mismatch");
			} else {
				if (capability === null) {
					capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
					authority = this.store.replaceInitializingRestoreCapability(
						authority.restoreId,
						await sha256Hex(new TextEncoder().encode(capability)),
					);
				}
				await this.recoveryJobJson(input.vaultId, authority.jobId, "/__yaos/recovery-job/initialize", "POST", {
					jobId: authority.jobId,
					vaultId: authority.vaultId,
					vaultGeneration: authority.vaultGeneration,
					createdAt: authority.createdAt,
					capability,
					capabilityExpiresAt: authority.capabilityExpiresAt, restoreId: authority.restoreId,
					snapshotId: authority.snapshotId, selection: authority.selection,
				} satisfies RestoreDescriptor);
			}
			this.store.setRestoreAuthorityState(authority.restoreId, "active");
		} catch (error) {
			this.store.setRestoreAuthorityState(authority.restoreId, "failed");
			throw error;
		}
		await this.options.alarms.setAlarm(Date.now() + 60_000);
		return this.recoveryJobJson(input.vaultId, authority.jobId, "/__yaos/recovery-job/status", "GET");
	}

	async validateRestoreAuthority(input: {
		vaultId: string; vaultGeneration: string; restoreId: string; snapshotId: string; capability: string;
	}): Promise<{ rootKey: string; rootHash: string; selection: RestoreSelection; capabilityExpiresAt: number }> {
		const snapshot = await this.assertRestoreCapability(input);
		const authority = this.store.restoreAuthority(input.restoreId)!;
		return {
			rootKey: snapshot.rootKey,
			rootHash: snapshot.rootHash,
			selection: authority.selection,
			capabilityExpiresAt: authority.capabilityExpiresAt,
		};
	}

	async completeRestore(input: { vaultId: string; vaultGeneration: string; restoreId: string; snapshotId: string; capability: string }): Promise<void> {
		await this.assertRestoreCapability(input);
		this.store.setRestoreAuthorityState(input.restoreId, "complete");
	}

	async getRecoveryRestoreStatus(input: { vaultId: string; restoreId: string }): Promise<unknown> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const authority = this.store.restoreAuthority(input.restoreId);
		if (!authority || authority.vaultId !== input.vaultId) throw new Error("restore authority not found");
		return this.recoveryJobJson(
			input.vaultId,
			authority.jobId,
			"/__yaos/recovery-job/status",
			"GET",
		);
	}

	async listRecoveryRestoreItems(input: { vaultId: string; restoreId: string; cursor: string | null; limit: number }): Promise<unknown> {
		this.assertRestoreAuthority(input.vaultId, input.restoreId);
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		return this.recoveryJobJson(
			input.vaultId,
			recoveryJobId("restore", input.vaultId, this.requireVaultGeneration(input.vaultId), input.restoreId),
			"/__yaos/recovery-job/restore/items",
			"POST",
			{ cursor: input.cursor, limit: input.limit },
		);
	}

	async getRecoveryRestoreItemContent(input: { vaultId: string; restoreId: string; itemId: string }): Promise<Response> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		this.assertRestoreAuthority(input.vaultId, input.restoreId);
		return this.recoveryJobContent(
			input.vaultId,
			recoveryJobId("restore", input.vaultId, this.requireVaultGeneration(input.vaultId), input.restoreId),
			"/__yaos/recovery-job/restore/content",
			{ itemId: input.itemId },
		);
	}

	async recordRecoveryRestoreResults(input: {
		vaultId: string; restoreId: string; results: Array<{ itemId: string; outcome: string; errorCode?: string }>;
	}): Promise<unknown> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		this.assertRestoreAuthority(input.vaultId, input.restoreId);
		return this.recoveryJobJson(
			input.vaultId,
			recoveryJobId("restore", input.vaultId, this.requireVaultGeneration(input.vaultId), input.restoreId),
			"/__yaos/recovery-job/restore/results",
			"POST",
			{ results: input.results },
		);
	}

	async cancelRecoveryRestore(input: { vaultId: string; restoreId: string }): Promise<unknown> {
		this.assertRestoreAuthority(input.vaultId, input.restoreId);
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const result = await this.recoveryJobJson(
			input.vaultId,
			recoveryJobId("restore", input.vaultId, this.requireVaultGeneration(input.vaultId), input.restoreId),
			"/__yaos/recovery-job/cancel",
			"POST",
		);
		this.store.setRestoreAuthorityState(input.restoreId, "cancelled");
		return result;
	}

	async applyRecoveryRetention(input: { vaultId: string; policy: Record<string, unknown> }): Promise<{
		retained: string[]; removed: string[]; deferred: string[];
	}> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const keepLastRaw = input.policy.keepLast;
		const keepLast = typeof keepLastRaw === "number" && Number.isSafeInteger(keepLastRaw)
			? Math.min(1000, Math.max(1, keepLastRaw)) : 30;
		const requestedPins = input.policy.pinnedSnapshotIds;
		const pinnedIds = Array.isArray(requestedPins)
			? requestedPins.filter((value): value is string => typeof value === "string").slice(0, 100)
			: [];
		const pinned = new Set(pinnedIds);
		const snapshots = this.store.listSnapshots(null, 1000).sort((left, right) => right.completedAt - left.completedAt);
		for (const snapshot of snapshots) this.store.setSnapshotPinned(snapshot.snapshotId, pinned.has(snapshot.snapshotId));
		const retained = snapshots.filter((snapshot, index) => index < keepLast || pinned.has(snapshot.snapshotId));
		const retainedIds = new Set(retained.map((snapshot) => snapshot.snapshotId));
		const removed: string[] = [];
		const deferred: string[] = [];
		for (const snapshot of snapshots) {
			if (retainedIds.has(snapshot.snapshotId)) continue;
			try {
				if (this.store.deleteSnapshot(snapshot.snapshotId)) removed.push(snapshot.snapshotId);
			} catch (error) {
				if (this.store.snapshot(snapshot.snapshotId)) deferred.push(snapshot.snapshotId);
				else throw error;
			}
		}
		return {
			retained: [...retained.map((snapshot) => snapshot.snapshotId), ...deferred],
			removed,
			deferred,
		};
	}

	async startRecoveryGc(input: { vaultId: string; requestId: string }): Promise<unknown> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		if (!this.objectStore) throw new Error("recovery storage unavailable");
		const current = this.store.latestGcEpoch();
		const jobId = recoveryJobId("gc", input.vaultId, this.requireVaultGeneration(input.vaultId));
		let activeEpoch = current && (current.state === "marking" || current.state === "sweeping") ? current : null;
		let jobStatus: { state: string } | null = null;
		try {
			jobStatus = await this.recoveryJobJson<{ state: string }>(
				input.vaultId, jobId, "/__yaos/recovery-job/status", "GET",
			);
		} catch {
			jobStatus = null;
		}
		const jobTerminal = jobStatus !== null
			&& ["complete", "complete_with_gaps", "failed", "cancelled"].includes(jobStatus.state);
		if (activeEpoch && (activeEpoch.deadlineAt <= Date.now() || jobTerminal)) {
			this.store.advanceGcEpoch(activeEpoch.epoch, jobStatus?.state === "complete" ? "complete" : "aborted");
			activeEpoch = null;
		}
		if (activeEpoch && activeEpoch.requestId !== input.requestId) throw new Error("another recovery GC is active");
		if (!activeEpoch && current?.requestId === input.requestId) return jobStatus ?? current;
		if (!activeEpoch && jobStatus) {
			if (!jobTerminal) {
				await this.recoveryJobJson(input.vaultId, jobId, "/__yaos/recovery-job/cancel", "POST");
				throw new Error("previous recovery GC cleanup is pending");
			}
			await this.recoveryJobJson(input.vaultId, jobId, "/__yaos/recovery-job/delete-state", "POST");
		}
		let capability: string | null = null;
		let epoch = activeEpoch;
		if (!epoch) {
			const now = Date.now();
			capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
			epoch = this.store.createGcEpoch({
				requestId: input.requestId, vaultId: input.vaultId, vaultGeneration: this.requireVaultGeneration(input.vaultId), jobId,
				capabilityHash: await sha256Hex(new TextEncoder().encode(capability)),
				capabilityExpiresAt: now + CAPTURE_HARD_TTL_MS,
			}, now);
		}
		let authority = this.store.gcAuthority(epoch.epoch)!;
		const initialized = await this.recoveryJobJson<
			{ initialized: false } | { initialized: true; jobId: string; kind: string; capabilityHash: string }
		>(input.vaultId, jobId, "/__yaos/recovery-job/initialization", "GET");
		if (initialized.initialized) {
			if (initialized.jobId !== jobId || initialized.kind !== "gc"
				|| initialized.capabilityHash !== authority.capabilityHash) throw new Error("GC initialization mismatch");
		} else {
			if (capability === null) {
				capability = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
				authority = this.store.replaceMarkingGcCapability(
					epoch.epoch,
					await sha256Hex(new TextEncoder().encode(capability)),
				);
			}
			await this.recoveryJobJson(input.vaultId, jobId, "/__yaos/recovery-job/initialize", "POST", {
				jobId, vaultId: input.vaultId, vaultGeneration: this.requireVaultGeneration(input.vaultId), createdAt: authority.markStartedAt, capability,
				capabilityExpiresAt: authority.capabilityExpiresAt, epoch: epoch.epoch,
				markStartedAt: epoch.markStartedAt, deadlineAt: epoch.deadlineAt,
				gracePeriodMs: 48 * 60 * 60_000, domains: ["recovery", "blob"],
			} satisfies GcDescriptor);
		}
		return this.recoveryJobJson(input.vaultId, jobId, "/__yaos/recovery-job/status", "GET");
	}

	async getRecoveryStatus(input: { vaultId: string }): Promise<unknown> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		try {
			await this.ensureRecoveryProjection(input.vaultId);
		} catch (error) {
			console.warn("[yaos-vault] recovery projection status refresh failed", errorMessage(error));
		}
		const active = this.store.activeRecoveryCapture();
		const snapshots = this.store.listSnapshots(null, 1000);
		const latest = [...snapshots].sort((left, right) => right.completedAt - left.completedAt)[0] ?? null;
		const oldestPin = this.store.activePins().sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;
		const projectionLease = this.store.projectionLease();
		type ProjectionStatusView = {
			state: string;
			processedEntries: number;
			totalEntries: number;
			remainingEntries: number;
			lagSequences: number;
			lastProgressAt: number | null;
		};
		let projectionStatus: ProjectionStatusView | null = null;
		if (projectionLease) {
			let rawStatus: { state: string; updatedAt: number } | null = null;
			try {
				rawStatus = await this.recoveryJobJson<{ state: string; updatedAt: number }>(
					input.vaultId,
					recoveryJobId("projection", input.vaultId, this.requireVaultGeneration(input.vaultId)),
					"/__yaos/recovery-job/status",
					"GET",
				);
			} catch {
				rawStatus = null;
			}
			const summary = this.store.recoveryProjectionSummary();
			projectionStatus = {
				state: !projectionLease.enabled
					? "paused"
					: summary.remainingEntries === 0
						? "ready"
						: rawStatus?.state ?? "queued",
				processedEntries: summary.totalEntries - summary.remainingEntries,
				totalEntries: summary.totalEntries,
				remainingEntries: summary.remainingEntries,
				lagSequences: summary.lagSequences,
				lastProgressAt: rawStatus?.updatedAt ?? null,
			};
		}
		const storageAvailable = this.objectStore !== undefined;
		const activeRestoreDependency = this.store.activeRestoreDependency();
		type ActiveRestoreStatus = {
			restoreId: string; snapshotId: string; state: string; processedEntries: number; totalEntries: number | null;
			retryCount: number; nextAttemptAt: number | null; error: { code: string; reference: string | null } | null;
		};
		let activeRestore: ActiveRestoreStatus | null = null;
		if (activeRestoreDependency) {
			const status = await this.recoveryJobJson<ActiveRestoreStatus>(
				input.vaultId,
				recoveryJobId("restore", input.vaultId, this.requireVaultGeneration(input.vaultId), activeRestoreDependency.operationId),
				"/__yaos/recovery-job/status",
				"GET",
			);
			if (status) activeRestore = {
				restoreId: activeRestoreDependency.operationId,
				snapshotId: activeRestoreDependency.snapshotId,
				state: status.state,
				processedEntries: status.processedEntries,
				totalEntries: status.totalEntries,
				retryCount: status.retryCount,
				nextAttemptAt: status.nextAttemptAt,
				error: status.error,
			};
		}
		const currentSequence = this.store.currentSequence();
		const emptyVault = this.store.countActiveCatalogAt(currentSequence) === 0
			&& this.store.activeAttachmentCatalogAt(currentSequence, "", 1).length === 0;
		return {
			syncReady: !this.options.hasPendingPersistence(),
			recoveryReady: storageAvailable && (
				(projectionStatus !== null && projectionStatus.remainingEntries === 0 && projectionStatus.lagSequences === 0)
				|| (projectionStatus === null && emptyVault)
			),
			storageAvailable,
			projection: projectionStatus,
			oldestPin: oldestPin ? {
				sequence: oldestPin.boundarySequence,
				ageMs: Date.now() - oldestPin.createdAt,
				softExpiresAt: oldestPin.softExpiresAt,
				hardExpiresAt: oldestPin.hardExpiresAt,
			} : null,
			lastSuccessfulSnapshot: latest ? {
				snapshotId: latest.snapshotId,
				completedAt: latest.completedAt,
				boundarySequence: latest.boundarySequence,
			} : null,
			activeCapture: active ? await this.getRecoveryCaptureStatus({ vaultId: input.vaultId, captureId: active.captureId }) : null,
			activeRestore,
			gc: this.store.latestGcEpoch(),
			snapshotCount: snapshots.length,
		};
	}

	async getGcRootPage(request: GcRootPageRequest): Promise<GcRootPage> {
		await this.assertGcCapability(request);
		if (request.maxEntries <= 0 || request.maxEntries > MAX_CAPTURE_PLAN_ENTRIES) throw new Error("invalid GC root page bound");
		const epoch = this.store.gcEpoch(request.epoch)!;
		const cursor = request.cursor;
		const separator = cursor?.indexOf(":") ?? -1;
		const stream = cursor === null ? "snapshots" : separator >= 0 ? cursor.slice(0, separator) : "";
		const after = cursor === null ? "" : separator >= 0 ? cursor.slice(separator + 1) : "";
		let objects: Array<{ objectKey: string; domain: "recovery" | "blob" }> = [];
		let nextCursor: string | null;
		if (stream === "snapshots") {
			const snapshots = this.store.listSnapshots(after, request.maxEntries);
			objects = snapshots.map((snapshot): { objectKey: string; domain: "recovery" } => ({ objectKey: snapshot.rootKey, domain: "recovery" }));
			nextCursor = snapshots.length === request.maxEntries ? `snapshots:${snapshots.at(-1)!.snapshotId}` : "markdown:";
		} else if (stream === "markdown") {
			const entries = this.store.listCatalogAt(epoch.markBoundarySequence, after, request.maxEntries);
			objects = entries.map((entry): { objectKey: string; domain: "recovery" } => {
				if (entry.contentHash === null) throw new Error("GC catalog content identity missing");
				return { objectKey: contentObjectKey(request.vaultId, request.vaultGeneration, entry.contentHash), domain: "recovery" };
			});
			nextCursor = entries.length === request.maxEntries ? `markdown:${entries.at(-1)!.bodyId}` : "attachments:";
		} else if (stream === "attachments") {
			const entries = this.store.activeAttachmentCatalogAt(epoch.markBoundarySequence, after, request.maxEntries);
			objects = entries.map((entry): { objectKey: string; domain: "blob" } => {
				if (entry.contentHash === null) throw new Error("GC attachment identity missing");
				return { objectKey: `vault/${encodeURIComponent(request.vaultId)}/${encodeURIComponent(request.vaultGeneration)}/blobs/${entry.contentHash}`, domain: "blob" };
			});
			nextCursor = entries.length === request.maxEntries ? `attachments:${entries.at(-1)!.path}` : null;
		} else {
			throw new Error("invalid GC root cursor");
		}
		const marks = await Promise.all(objects.map(async (object) => ({
			objectKeyHash: await sha256Hex(new TextEncoder().encode(object.objectKey)),
			domain: object.domain,
		})));
		return { roots: objects, marks, nextCursor, terminal: nextCursor === null };
	}

	async acquireSweepLease(request: SweepLeaseRequest & { vaultId: string; vaultGeneration: string; capability: string }): Promise<SweepLease> {
		await this.assertGcCapability(request);
		if (request.objectKeys.length === 0 || request.objectKeys.length > MAX_LEASE_KEYS) throw new Error("invalid sweep lease keys");
		const ttl = Math.min(SWEEP_LEASE_TTL_MS, Math.max(1_000, request.ttlMs ?? SWEEP_LEASE_TTL_MS));
		return this.store.acquireSweepLease({
			leaseId: crypto.randomUUID(), epoch: request.epoch, ownerId: request.ownerId, domain: request.domain,
			objectKeys: request.objectKeys, expiresAt: Date.now() + ttl,
		});
	}

	async releaseSweepLease(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string; leaseId: string }): Promise<void> {
		await this.assertGcCapability(input);
		this.store.releaseKeyLease(input.leaseId);
	}

	async invalidateSweptObjects(input: {
		vaultId: string; vaultGeneration: string; epoch: number; capability: string; leaseId: string;
		domain: "recovery" | "blob"; objectKeys: string[];
	}): Promise<void> {
		await this.assertGcCapability(input);
		if (input.objectKeys.length > MAX_LEASE_KEYS) throw new Error("sweep invalidation batch too large");
		this.store.invalidateDeletedObjects(input.leaseId, input.objectKeys);
	}

	async completeGcMark(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string }): Promise<unknown> {
		await this.assertGcCapability(input);
		return this.store.advanceGcEpoch(input.epoch, "sweeping");
	}

	async completeGcSweep(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string }): Promise<unknown> {
		await this.assertGcCapability(input);
		return this.store.advanceGcEpoch(input.epoch, "complete");
	}

	async abortRecoveryGc(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string; reason: string }): Promise<unknown> {
		await this.assertGcCapability(input);
		return this.store.advanceGcEpoch(input.epoch, "aborted");
	}

	private async assertGcCapability(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string }): Promise<void> {
		if (this.store.vaultMetadata()?.vaultId !== input.vaultId) throw new Error("vault identity mismatch");
		const authority = this.store.gcAuthority(input.epoch);
		if (!authority || authority.vaultId !== input.vaultId
			|| input.vaultGeneration !== authority.vaultGeneration
			|| authority.vaultGeneration !== this.requireVaultGeneration(input.vaultId)
			|| (authority.state !== "marking" && authority.state !== "sweeping")
			|| authority.capabilityExpiresAt <= Date.now()) throw new Error("GC authority expired");
		if (await sha256Hex(new TextEncoder().encode(input.capability)) !== authority.capabilityHash) {
			throw new Error("GC capability mismatch");
		}
	}
	private recoveryJobs(): ActorCallPort {
		const jobs = this.options.recoveryJobs;
		if (!jobs) throw new Error("recovery job binding unavailable");
		return jobs;
	}

	private async recoveryJobJson<T>(
		vaultId: string,
		jobId: string,
		path: string,
		method: "GET" | "POST",
		payload?: unknown,
	): Promise<T> {
		const response = await this.recoveryJobs().call(jobId, new Request(`https://internal${path}`, {
			method,
			headers: {
				[RECOVERY_RPC_HEADER]: "1",
				"x-yaos-vault-id": vaultId,
				"x-yaos-vault-generation": this.requireVaultGeneration(vaultId),
				...(payload === undefined ? {} : { "content-type": "application/json" }),
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		}));
		const value: unknown = await response.json();
		if (!response.ok) {
			const message = value && typeof value === "object" && "error" in value && typeof value.error === "string"
				? value.error : `recovery job request failed (${response.status})`;
			throw new Error(message);
		}
		return value as T;
	}

	private async recoveryJobContent(
		vaultId: string,
		jobId: string,
		path: string,
		payload: unknown,
	): Promise<Response> {
		const response = await this.recoveryJobs().call(jobId, new Request(`https://internal${path}`, {
			method: "POST",
			headers: {
				[RECOVERY_RPC_HEADER]: "1",
				"x-yaos-vault-id": vaultId,
				"x-yaos-vault-generation": this.requireVaultGeneration(vaultId),
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
		}));
		if (!response.ok) throw new Error(`recovery job content request failed (${response.status})`);
		return response;
	}

	private captureStarted(capture: CaptureDescriptor): CaptureStarted {
		return {
			captureId: capture.captureId,
			boundarySequence: capture.boundarySequence,
			state: "queued",
			statusUrl: `/vault/${encodeURIComponent(capture.vaultId)}/recovery/captures/${encodeURIComponent(capture.captureId)}`,
		};
	}

	private assertRestoreAuthority(vaultId: string, restoreId: string): RecoverySnapshotCatalogEntry {
		if (this.store.vaultMetadata()?.vaultId !== vaultId) throw new Error("vault identity mismatch");
		const authority = this.store.restoreAuthority(restoreId);
		if (!authority || authority.vaultId !== vaultId
			|| authority.vaultGeneration !== this.requireVaultGeneration(vaultId)
			|| authority.state !== "active"
			|| authority.capabilityExpiresAt <= Date.now()) throw new Error("restore authority not found or expired");
		const dependency = this.store.snapshotDependency("restore", restoreId);
		if (!dependency || dependency.snapshotId !== authority.snapshotId) throw new Error("restore dependency missing");
		const snapshot = this.store.snapshot(authority.snapshotId);
		if (!snapshot) throw new Error("restore snapshot is no longer retained");
		return snapshot;
	}

	private async assertRestoreCapability(input: {
		vaultId: string; vaultGeneration: string; restoreId: string; snapshotId?: string; capability: string;
	}): Promise<RecoverySnapshotCatalogEntry> {
		const snapshot = this.assertRestoreAuthority(input.vaultId, input.restoreId);
		const authority = this.store.restoreAuthority(input.restoreId)!;
		if (input.vaultGeneration !== authority.vaultGeneration) throw new Error("restore generation mismatch");
		if (input.snapshotId !== undefined && input.snapshotId !== authority.snapshotId) throw new Error("restore snapshot mismatch");
		if (await sha256Hex(new TextEncoder().encode(input.capability)) !== authority.capabilityHash) {
			throw new Error("restore capability mismatch");
		}
		return snapshot;
	}

	private async assertCaptureAuthority(request: {
		captureId: string; capability: string; boundarySequence?: number; vaultId?: string; vaultGeneration?: string;
	}): Promise<CaptureDescriptor> {
		this.store.reapExpiredRecoveryCaptures();
		const capture = this.store.recoveryCapture(request.captureId);
		if (!capture || capture.vaultGeneration !== this.requireVaultGeneration(capture.vaultId)
			|| capture.state === "complete" || capture.state === "failed" || capture.state === "cancelled") {
			throw new Error("capture authority is not active");
		}
		const now = Date.now();
		const pin = this.store.getPin(request.captureId);
		if (!pin || now >= pin.softExpiresAt || now >= pin.hardExpiresAt || now >= capture.capabilityExpiresAt) {
			this.store.reapExpiredRecoveryCaptures(now);
			throw new Error("capture authority expired");
		}
		if (request.boundarySequence !== undefined && request.boundarySequence !== capture.boundarySequence) {
			throw new Error("capture boundary mismatch");
		}
		if (request.vaultId !== undefined && request.vaultId !== capture.vaultId) throw new Error("capture vault mismatch");
		if (request.vaultGeneration !== undefined && request.vaultGeneration !== capture.vaultGeneration) {
			throw new Error("capture generation mismatch");
		}
		const capabilityHash = await sha256Hex(new TextEncoder().encode(request.capability));
		if (capabilityHash !== capture.capabilityHash) throw new Error("capture capability mismatch");
		return capture;
	}

	private async assertProjectionAuthority(leaseId: string, capability: string): Promise<void> {
		const lease = this.store.projectionLease();
		if (!lease || !lease.enabled || lease.leaseId !== leaseId || lease.expiresAt <= Date.now()) {
			throw new Error("projection authority expired");
		}
		if (await sha256Hex(new TextEncoder().encode(capability)) !== lease.capabilityHash) {
			throw new Error("projection capability mismatch");
		}
	}

	private requireVaultGeneration(vaultId: string): string {
		const metadata = this.store.vaultMetadata();
		if (!metadata || metadata.vaultId !== vaultId) throw new Error("vault identity mismatch");
		return metadata.vaultGeneration;
	}
}
