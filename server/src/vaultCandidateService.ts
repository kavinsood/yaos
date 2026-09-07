import * as Y from "yjs";
import { MAX_CANDIDATE_BYTES, type DurableReceipt } from "./contracts";
import { sha256Hex } from "./hex";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import type { CatalogMutation, ReconstructedDocument, VaultStore } from "./vaultStore";
import type { VaultDocumentCache } from "./vaultDocumentCache";
import type { VaultLifecycleService } from "./vaultLifecycleService";
import type { VaultSocketService } from "./vaultSocketService";
import { canonicalMarkdownBytes, canonicalizeMarkdown } from "./shared/markdownCodec";
import { MAX_CLIENT_MARKDOWN_BYTES } from "./shared/durableLimits";
import { validateFrontmatterSemanticRoots } from "./shared/frontmatterSemanticValidation";
import type { VaultActorContext } from "./collaboration";

const MAX_IDENTITY_LENGTH = 256;

class NonCanonicalMarkdownCandidateError extends Error {}
class OversizedMarkdownCandidateError extends Error {}
class InvalidFrontmatterSemanticCandidateError extends Error {
	constructor(readonly reason: string) { super(reason); }
}

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
}

/** Owns device-scoped candidate admission, idempotency, and durable receipts. */
export class VaultCandidateService {
	constructor(private readonly options: CandidateServiceOptions) {}

	async handle(bodyId: string, request: Request, suppliedActor?: VaultActorContext): Promise<Response> {
		const actor = suppliedActor ?? this.legacyActor(request);
		if (!bodyId || bodyId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(bodyId)) return json({ error: "invalid_body_id" }, 400);
		const creation = this.options.store.creationCandidate(bodyId);
		const catalog = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), bodyId);
		if (!creation && (!catalog || catalog.lifecycle !== "active" || catalog.fileId !== bodyId)) return json({ error: "body_not_active" }, 409);
		const deviceId = actor.deviceId;
		const candidateId = request.headers.get("x-yaos-candidate-id");
		const candidateDigest = request.headers.get("x-yaos-candidate-digest")?.toLowerCase() ?? null;
		if (!validIdentity(deviceId) || !validIdentity(candidateId) || !candidateDigest || !/^[a-f0-9]{64}$/.test(candidateDigest)) {
			return json({ error: "invalid_candidate_identity" }, 400);
		}
		if (creation && (creation.candidateId !== candidateId || creation.candidateDigest !== candidateDigest)) {
			return json({ error: "candidate_does_not_match_creation_fence" }, 409);
		}
		const replay = this.options.store.candidateReceipt(bodyId, deviceId, candidateId);
		if (replay) {
			return replay.candidateDigest === candidateDigest
				? json(this.receipt(replay))
				: json({ error: "candidate_id_reused_with_different_digest" }, 409);
		}
		let update: Uint8Array;
		try { update = await readBoundedBytes(request, MAX_CANDIDATE_BYTES); }
		catch (error) {
			const tooLarge = error instanceof BoundedBodyError && error.kind === "body_too_large";
			return json({ error: error instanceof BoundedBodyError ? error.kind : "candidate_read_failed" }, tooLarge ? 413 : 400);
		}
		const actualDigest = await sha256Hex(update);
		if (actualDigest !== candidateDigest) return json({ error: "candidate_digest_mismatch" }, 400);
		if (!await this.options.flush(bodyId)) return json({ error: "body_persistence_unavailable" }, 503);
		let state: Awaited<ReturnType<VaultCandidateService["candidateCatalog"]>>;
		try {
			state = await this.candidateCatalog(bodyId, update);
		} catch (error) {
			if (error instanceof NonCanonicalMarkdownCandidateError) {
				return json({ error: "candidate_markdown_not_canonical" }, 409);
			}
			if (error instanceof OversizedMarkdownCandidateError) {
				return json({ error: "candidate_markdown_too_large" }, 413);
			}
			if (error instanceof InvalidFrontmatterSemanticCandidateError) {
				return json({ error: error.reason }, 409);
			}
			throw error;
		}
		let durable;
		try {
			if (!(this.options.validateActor?.(actor) ?? true)) return json({ error: "authority_superseded" }, 409);
				durable = this.options.store.commitCandidate({
				bodyId,
				clientId: deviceId,
				candidateId,
				candidateDigest,
				update,
				catalog: state.catalog,
				expectedHead: state.expectedHead,
				changesState: state.changesState,
				vaultGeneration: this.options.vaultGeneration(),
				runtimeEpoch: this.options.runtimeEpoch,
				actor,
			});
		} catch (error) {
			const current = this.options.store.candidateReceipt(bodyId, deviceId, candidateId);
			if (!current || current.candidateDigest !== candidateDigest) throw error;
			durable = current;
		}
		if (creation && !this.options.lifecycle().finalizeCreation(creation, durable, state.metadata, actor)) {
			return json({ error: "recovery_boundary_in_progress" }, 409);
		}
		if (this.options.cache.applyDurableUpdate(bodyId, update, durable.durableGeneration, request)) {
			this.options.sockets().broadcastDocumentUpdate(bodyId, update, request);
		}
		this.options.cache.removePendingDigest(bodyId, candidateDigest);
		this.options.sockets().notifyBodyCommitted(bodyId, durable.durableGeneration, durable.vaultSequence);
		return json(this.receipt(durable));
	}

	private legacyActor(request: Request): VaultActorContext {
		return { vaultId: this.options.vaultId(), vaultGeneration: this.options.vaultGeneration(),
			principalId: request.headers.get("x-yaos-device-id") ?? "legacy", membershipRevision: 1,
			deviceId: request.headers.get("x-yaos-device-id") ?? "legacy", deviceCredentialRevision: 1,
			role: "member", policyVersion: 1, capabilityDigest: "legacy" };
	}

	private async candidateCatalog(bodyId: string, update: Uint8Array): Promise<{
		metadata: { contentHash: string; size: number };
		catalog?: CatalogMutation;
		expectedHead: { generation: number; latestSequence: number } | null;
		changesState: boolean;
	}> {
		const head = this.options.store.documentHead(bodyId);
		const historyBytes = head
			? this.options.store.documentEncodedHistoryBytes(bodyId, head.latestSequence)
			: 0;
		const release = this.options.cache.recordTransient(bodyId, historyBytes + update.byteLength);
		let reconstructed: ReconstructedDocument | null = null;
		try {
			reconstructed = this.options.store.reconstructDocument(bodyId);
			let changesState = false;
			const observe = (): void => { changesState = true; };
			reconstructed.doc.on("update", observe);
			try { Y.applyUpdate(reconstructed.doc, update, "candidate-metadata"); }
			finally { reconstructed.doc.off("update", observe); }
			const content = Y.Text.prototype.toString.call(reconstructed.doc.getText("body"));
			if (content !== canonicalizeMarkdown(content)) {
				throw new NonCanonicalMarkdownCandidateError();
			}
			const semanticError = validateFrontmatterSemanticRoots(reconstructed.doc);
			if (semanticError) throw new InvalidFrontmatterSemanticCandidateError(semanticError);
			const bytes = canonicalMarkdownBytes(content);
			if (bytes.byteLength > MAX_CLIENT_MARKDOWN_BYTES) {
				throw new OversizedMarkdownCandidateError();
			}
			const metadata = { contentHash: await sha256Hex(bytes), size: bytes.byteLength };
			const current = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), bodyId);
			const generation = (this.options.store.documentHead(bodyId)?.generation ?? 0) + 1;
			return {
				metadata,
				expectedHead: head,
				changesState,
				catalog: current?.lifecycle === "active" ? { bodyId, fileId: current.fileId, path: current.path, previousPath: null,
					lifecycle: "active", bodyGeneration: generation, contentHash: metadata.contentHash, size: metadata.size } : undefined,
			};
		} finally {
			release();
			reconstructed?.doc.destroy();
		}
	}

	private receipt(value: {
		bodyId: string;
		clientId: string;
		candidateId: string;
		candidateDigest: string;
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
			durableGeneration: value.durableGeneration,
			runtimeEpoch: value.runtimeEpoch,
		};
	}
}
