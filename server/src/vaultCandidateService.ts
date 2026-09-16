import { MAX_CANDIDATE_BYTES, MAX_CATCH_UP_BODIES, MAX_CATCH_UP_BYTES, type DurableReceipt } from "./contracts";
import { sha256Hex } from "./hex";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import type { CatalogMutation, VaultStore } from "./vaultStore";
import {
	VaultDocumentCachePressureError,
	VaultDocumentValidationError,
	type ValidatedBodyUpdate,
	type VaultDocumentCache,
} from "./vaultDocumentCache";
import type { VaultLifecycleService } from "./vaultLifecycleService";
import type { VaultSocketService } from "./vaultSocketService";
import type { VaultActorContext } from "./collaboration";
import { decodeBinaryEnvelope } from "./shared/binaryEnvelope";
import { candidateDigestMaterial } from "./shared/candidateDigest";
import {
	MAX_CANDIDATE_UPDATE_BYTES,
	MAX_CANDIDATE_UPDATE_FRAMES,
	MAX_DURABLE_UPDATE_BYTES,
} from "./shared/durableLimits";
import {
	BODY_EPOCH_HEADER,
	SemanticEpochMismatchError,
	parseSemanticEpoch,
	type SemanticEpoch,
} from "./shared/semanticEpoch";

const MAX_IDENTITY_LENGTH = 256;

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function validIdentity(value: string | null): value is string {
	return value !== null && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH
		&& ![...value].some((character) => {
			const code = character.codePointAt(0)!;
			return code < 0x20 || code === 0x7f;
		});
}

function boundedFrames(value: unknown): readonly Uint8Array[] | null {
	const frames = value instanceof Uint8Array
		? [value]
		: Array.isArray(value) ? value : null;
	if (!frames || frames.length === 0 || frames.length > MAX_CANDIDATE_UPDATE_FRAMES) return null;
	let total = 0;
	for (const frame of frames) {
		if (!(frame instanceof Uint8Array) || frame.byteLength === 0
			|| frame.byteLength > MAX_DURABLE_UPDATE_BYTES) return null;
		total += frame.byteLength;
		if (!Number.isSafeInteger(total) || total > MAX_CANDIDATE_UPDATE_BYTES) return null;
	}
	return frames;
}

interface CandidateServiceOptions {
	store: VaultStore;
	cache: VaultDocumentCache;
	lifecycle: () => VaultLifecycleService;
	sockets: () => VaultSocketService;
	vaultId: () => string;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	flush: (documentId: string) => Promise<boolean>;
	validateActor: (actor: VaultActorContext) => boolean;
	shouldPauseAdmission?: (documentId: string) => boolean;
}

/** Owns device-scoped candidate admission, idempotency, and durable receipts. */
export class VaultCandidateService {
	constructor(private readonly options: CandidateServiceOptions) {}

	async handleBatch(request: Request, actor: VaultActorContext): Promise<Response> {
		let decoded: unknown;
		try {
			decoded = decodeBinaryEnvelope(
				await readBoundedBytes(request, MAX_CATCH_UP_BYTES),
				MAX_CATCH_UP_BYTES,
			);
		} catch {
			return json({ error: "invalid_candidate_batch" }, 400);
		}
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)
			|| !("candidates" in decoded) || !Array.isArray(decoded.candidates)
			|| decoded.candidates.length === 0 || decoded.candidates.length > MAX_CATCH_UP_BODIES) {
			return json({ error: "invalid_candidate_batch" }, 400);
		}
		const candidates: Array<{
			bodyId: string;
			bodyEpoch: SemanticEpoch;
			candidateId: string;
			candidateDigest: string;
			encodedUpdates: readonly Uint8Array[];
		}> = [];
		const bodyIds = new Set<string>();
		const candidateIds = new Set<string>();
		for (const value of decoded.candidates) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return json({ error: "invalid_candidate_batch_item" }, 400);
			}
			const item = value as Record<string, unknown>;
			const bodyId = typeof item.bodyId === "string" ? item.bodyId : "";
			const candidateId = typeof item.candidateId === "string" ? item.candidateId : null;
			const candidateDigest = typeof item.candidateDigest === "string"
				? item.candidateDigest.toLowerCase()
				: "";
			let bodyEpoch: SemanticEpoch;
			try { bodyEpoch = parseSemanticEpoch(item.bodyEpoch, "candidate batch body epoch"); }
			catch { return json({ error: "invalid_candidate_batch_item" }, 400); }
			const encodedUpdates = boundedFrames(item.encodedUpdates ?? item.encodedUpdate);
			if (!bodyId || bodyId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(bodyId)
				|| !validIdentity(candidateId) || !/^[a-f0-9]{64}$/.test(candidateDigest)
				|| !encodedUpdates
				|| bodyIds.has(bodyId) || candidateIds.has(candidateId)) {
				return json({ error: "invalid_candidate_batch_item" }, 400);
			}
			bodyIds.add(bodyId);
			candidateIds.add(candidateId);
			try {
				if (await sha256Hex(candidateDigestMaterial(encodedUpdates)) !== candidateDigest) {
					return json({ error: "candidate_digest_mismatch" }, 400);
				}
			} catch {
				return json({ error: "invalid_candidate_batch_item" }, 400);
			}
			candidates.push({ bodyId, bodyEpoch, candidateId, candidateDigest, encodedUpdates });
		}
		const receipts: DurableReceipt[] = [];
		for (const candidate of candidates) {
			const response = await this.handlePrepared({ ...candidate, request, actor, digestValidated: true });
			if (response.status !== 200) return response;
			receipts.push(await response.json() as DurableReceipt);
		}
		return json({ receipts, highWater: this.options.store.currentSequence() });
	}

	async handle(bodyId: string, request: Request, suppliedActor?: VaultActorContext): Promise<Response> {
		const actor = suppliedActor ?? this.legacyActor(request);
		if (!bodyId || bodyId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(bodyId)) return json({ error: "invalid_body_id" }, 400);
		const deviceId = actor.deviceId;
		const candidateId = request.headers.get("x-yaos-candidate-id");
		const candidateDigest = request.headers.get("x-yaos-candidate-digest")?.toLowerCase() ?? null;
		let bodyEpoch: SemanticEpoch;
		try { bodyEpoch = parseSemanticEpoch(Number(request.headers.get(BODY_EPOCH_HEADER)), "candidate body epoch"); }
		catch { return json({ error: "invalid_body_epoch" }, 400); }
		if (!validIdentity(deviceId) || !validIdentity(candidateId) || !candidateDigest || !/^[a-f0-9]{64}$/.test(candidateDigest)) {
			return json({ error: "invalid_candidate_identity" }, 400);
		}
		// Enforce the one-row wire bound before any Yjs work or SQLite read. The
		// request stream is the only exact evidence available at this boundary.
		let update: Uint8Array;
		try { update = await readBoundedBytes(request, MAX_CANDIDATE_BYTES, { allowEmpty: true }); }
		catch (error) {
			const tooLarge = error instanceof BoundedBodyError && error.kind === "body_too_large";
			return json({ error: error instanceof BoundedBodyError ? error.kind : "candidate_read_failed" }, tooLarge ? 413 : 400);
		}
		return this.handlePrepared({ bodyId, bodyEpoch, candidateId, candidateDigest,
			encodedUpdates: [update], request, actor, digestValidated: false });
	}

	private async handlePrepared(input: {
		bodyId: string;
		bodyEpoch: SemanticEpoch;
		candidateId: string;
		candidateDigest: string;
		encodedUpdates: readonly Uint8Array[];
		request: Request;
		actor: VaultActorContext;
		digestValidated: boolean;
	}): Promise<Response> {
		const { bodyId, bodyEpoch, candidateId, candidateDigest, encodedUpdates, request, actor } = input;
		const deviceId = actor.deviceId;
		const creation = this.options.store.creationCandidate(bodyId);
		const catalog = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), bodyId);
		if (!creation && (!catalog || catalog.lifecycle !== "active" || catalog.fileId !== bodyId)) return json({ error: "body_not_active" }, 409);
		if (creation && (creation.candidateId !== candidateId || creation.candidateDigest !== candidateDigest)) {
			return json({ error: "candidate_does_not_match_creation_fence" }, 409);
		}
		const currentHead = this.options.store.documentHead(bodyId);
		if (!currentHead) return json({ error: "body_state_missing" }, 409);
		if (currentHead.semanticEpoch !== bodyEpoch) return this.epochMismatch(bodyId, currentHead.semanticEpoch, bodyEpoch);
		const replay = this.options.store.candidateReceipt(bodyId, deviceId, candidateId);
		if (replay) {
			if (replay.bodyEpoch !== bodyEpoch) return this.epochMismatch(bodyId, currentHead.semanticEpoch, bodyEpoch);
			if (replay.candidateDigest !== candidateDigest) {
				return json({ error: "candidate_id_reused_with_different_digest" }, 409);
			}
			// A durable creation candidate may still have an unfinished root
			// lifecycle transaction after a restart. Only ordinary active-body
			// replays can return without re-entering exact-fence finalization.
			if (!creation) return json(this.receipt(replay));
		}
		const updates = boundedFrames(encodedUpdates);
		if (!updates) return json({ error: "invalid_candidate_frames" }, 400);
		if (!input.digestValidated) {
			let actualDigest: string;
			try { actualDigest = await sha256Hex(candidateDigestMaterial(updates)); }
			catch { return json({ error: "invalid_candidate_frames" }, 400); }
			if (actualDigest !== candidateDigest) return json({ error: "candidate_digest_mismatch" }, 400);
		}
		if (this.options.shouldPauseAdmission?.(bodyId)) return this.compactionBackpressure();
		if (!await this.options.flush(bodyId)) return json({ error: "body_persistence_unavailable" }, 503);
		return this.options.cache.serializeDocument(bodyId, async () => this.commitValidatedCandidate({
			bodyId, bodyEpoch, request, actor, deviceId, candidateId, candidateDigest, creation, updates,
		}));
	}

	private async commitValidatedCandidate(input: {
		bodyId: string;
		bodyEpoch: SemanticEpoch;
		request: Request;
		actor: VaultActorContext;
		deviceId: string;
		candidateId: string;
		candidateDigest: string;
		creation: ReturnType<VaultStore["creationCandidate"]>;
		updates: readonly Uint8Array[];
	}): Promise<Response> {
		const { bodyId, bodyEpoch, request, actor, deviceId, candidateId, candidateDigest, creation, updates } = input;
		const currentHead = this.options.store.documentHead(bodyId);
		if (!currentHead) return json({ error: "body_state_missing" }, 409);
		// Compaction may have advanced the lineage while this request was being
		// read or waiting for the per-document serializer. Fence it before Yjs.
		if (currentHead.semanticEpoch !== bodyEpoch) return this.epochMismatch(bodyId, currentHead.semanticEpoch, bodyEpoch);
		if (this.options.shouldPauseAdmission?.(bodyId)) return this.compactionBackpressure();
		const replay = this.options.store.candidateReceipt(bodyId, deviceId, candidateId);
		if (replay) {
			if (replay.bodyEpoch !== bodyEpoch) return this.epochMismatch(bodyId, currentHead.semanticEpoch, bodyEpoch);
			if (replay.candidateDigest !== candidateDigest) {
				return json({ error: "candidate_id_reused_with_different_digest" }, 409);
			}
			if (!creation) return json(this.receipt(replay));
		}
		let state: Awaited<ReturnType<VaultCandidateService["candidateCatalog"]>>;
		try {
			state = await this.candidateCatalog(bodyId, updates);
		} catch (error) {
			if (error instanceof VaultDocumentValidationError && error.reason === "candidate_markdown_not_canonical") {
				return json({ error: "candidate_markdown_not_canonical" }, 409);
			}
			if (error instanceof VaultDocumentValidationError && error.reason === "markdown_size_limit") {
				return json({ error: "candidate_markdown_too_large" }, 413);
			}
			if (error instanceof VaultDocumentValidationError) {
				return json({ error: error.reason }, 409);
			}
			if (error instanceof VaultDocumentCachePressureError) return json({ error: error.reason }, 429);
			throw error;
		}
		let durable;
		try {
			if (!(this.options.validateActor?.(actor) ?? true)) {
				this.options.cache.discardValidatedBodyUpdate(bodyId);
				return json({ error: "authority_superseded" }, 409);
			}
				durable = this.options.store.commitCandidate({
				bodyId,
				bodyEpoch,
				clientId: deviceId,
				candidateId,
				candidateDigest,
				updates,
				catalog: state.catalog,
				expectedHead: state.expectedHead,
				changesState: state.changesState,
				vaultGeneration: this.options.vaultGeneration(),
				runtimeEpoch: this.options.runtimeEpoch,
				actor,
			});
		} catch (error) {
			const current = this.options.store.candidateReceipt(bodyId, deviceId, candidateId);
			if (!current || current.candidateDigest !== candidateDigest) {
				this.options.cache.discardValidatedBodyUpdate(bodyId);
				throw error;
			}
			durable = current;
		}
		const creationResult = creation
			? this.options.lifecycle().finalizeCreation(creation, durable, state.metadata, actor)
			: "committed";
		if (creationResult === "busy") {
			// The body candidate is already durable even though root publication is
			// temporarily fenced. Keep the resident document aligned with storage;
			// lifecycle recovery will publish or retire it.
			this.options.cache.commitValidatedBodyUpdate(bodyId, updates, durable.durableGeneration,
				this.options.cache.get(bodyId)!.semanticEpoch, request, state.validated);
			this.options.cache.removePendingDigest(bodyId, candidateDigest);
			return json({ error: "recovery_boundary_in_progress" }, 409);
		}
		if (this.options.cache.commitValidatedBodyUpdate(bodyId, updates, durable.durableGeneration,
			this.options.cache.get(bodyId)!.semanticEpoch, request, state.validated)
			&& creationResult !== "superseded") {
			for (const update of updates) this.options.sockets().broadcastDocumentUpdate(bodyId, update, request);
		}
		this.options.cache.removePendingDigest(bodyId, candidateDigest);
		if (creationResult !== "superseded") {
			this.options.sockets().notifyBodyCommitted(bodyId, durable.durableGeneration, durable.vaultSequence);
		}
		return json(this.receipt(durable));
	}

	private legacyActor(request: Request): VaultActorContext {
		return { vaultId: this.options.vaultId(), vaultGeneration: this.options.vaultGeneration(),
			principalId: request.headers.get("x-yaos-device-id") ?? "legacy", membershipRevision: 1,
			deviceId: request.headers.get("x-yaos-device-id") ?? "legacy", deviceCredentialRevision: 1,
			role: "member", policyVersion: 1, capabilityDigest: "legacy" };
	}

	private async candidateCatalog(bodyId: string, updates: readonly Uint8Array[]): Promise<{
		metadata: { contentHash: string; size: number };
		catalog?: CatalogMutation;
		expectedHead: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number } | null;
		changesState: boolean;
		validated: ValidatedBodyUpdate;
	}> {
		const head = this.options.store.documentHead(bodyId);
		this.options.cache.load(bodyId, true, () => {
			if (!this.options.cache.admitBody(bodyId)) {
				throw new VaultDocumentCachePressureError("body_cache_count");
			}
			return true;
		});
		const validated = this.options.cache.validateBodyUpdate(bodyId, updates);
		try {
			const metadata = { contentHash: await sha256Hex(validated.contentBytes), size: validated.contentBytes.byteLength };
			const current = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), bodyId);
			const generation = (this.options.store.documentHead(bodyId)?.generation ?? 0) + 1;
			return {
				metadata,
				expectedHead: head,
				changesState: validated.changesState,
				validated,
				catalog: current?.lifecycle === "active" ? { bodyId, fileId: current.fileId, path: current.path, previousPath: null,
					lifecycle: "active", bodyGeneration: generation, contentHash: metadata.contentHash, size: metadata.size } : undefined,
			};
		} catch (error) {
			this.options.cache.discardValidatedBodyUpdate(bodyId);
			throw error;
		}
	}

	private receipt(value: {
		bodyId: string;
		clientId: string;
		candidateId: string;
		candidateDigest: string;
		bodyEpoch: SemanticEpoch;
		durableGeneration: number;
		vaultGeneration: string;
		runtimeEpoch: string;
	}): DurableReceipt {
		return {
			vaultId: this.options.vaultId(),
			vaultGeneration: value.vaultGeneration,
			bodyId: value.bodyId,
			clientId: value.clientId,
			candidateId: value.candidateId,
			candidateDigest: value.candidateDigest,
			bodyEpoch: value.bodyEpoch,
			durableGeneration: value.durableGeneration,
			runtimeEpoch: value.runtimeEpoch,
		};
	}

	private compactionBackpressure(): Response {
		return Response.json({ error: "semantic_compaction_backpressure" }, {
			status: 429, headers: { "cache-control": "no-store", "Retry-After": "1" },
		});
	}

	private epochMismatch(bodyId: string, expected: SemanticEpoch, received: SemanticEpoch): Response {
		const mismatch = new SemanticEpochMismatchError({
			purpose: "body", documentId: bodyId,
			expectedBodyEpoch: expected, receivedBodyEpoch: received,
		});
		return json(mismatch.toPayload(), mismatch.status);
	}
}
