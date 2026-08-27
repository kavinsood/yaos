import * as Y from "yjs";
import { MAX_CANDIDATE_BYTES, type DurableReceipt } from "./contracts";
import { sha256Hex } from "./hex";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import type { CatalogMutation, VaultStore } from "./vaultStore";
import type { VaultDocumentCache } from "./vaultDocumentCache";
import type { VaultLifecycleService } from "./vaultLifecycleService";
import type { VaultSocketService } from "./vaultSocketService";

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

interface CandidateServiceOptions {
	store: VaultStore;
	cache: VaultDocumentCache;
	lifecycle: () => VaultLifecycleService;
	sockets: () => VaultSocketService;
	vaultId: () => string;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	flush: (documentId: string) => Promise<boolean>;
}

/** Owns device-scoped candidate admission, idempotency, and durable receipts. */
export class VaultCandidateService {
	constructor(private readonly options: CandidateServiceOptions) {}

	async handle(bodyId: string, request: Request): Promise<Response> {
		if (!bodyId || bodyId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(bodyId)) return json({ error: "invalid_body_id" }, 400);
		const creation = this.options.store.creationCandidate(bodyId);
		const catalog = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), bodyId);
		if (!creation && (!catalog || catalog.lifecycle !== "active" || catalog.fileId !== bodyId)) return json({ error: "body_not_active" }, 409);
		const deviceId = request.headers.get("x-yaos-device-id");
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
		const state = await this.candidateCatalog(bodyId, update);
		let durable;
		try {
			durable = this.options.store.commitCandidate({
				bodyId,
				clientId: deviceId,
				candidateId,
				candidateDigest,
				update,
				catalog: state.catalog,
				vaultGeneration: this.options.vaultGeneration(),
				runtimeEpoch: this.options.runtimeEpoch,
			});
		} catch (error) {
			const current = this.options.store.candidateReceipt(bodyId, deviceId, candidateId);
			if (!current || current.candidateDigest !== candidateDigest) throw error;
			durable = current;
		}
		if (creation && !this.options.lifecycle().finalizeCreation(creation, durable, state.metadata)) {
			return json({ error: "recovery_boundary_in_progress" }, 409);
		}
		if (this.options.cache.applyDurableUpdate(bodyId, update, durable.durableGeneration, request)) {
			this.options.sockets().broadcastDocumentUpdate(bodyId, update, request);
		}
		this.options.cache.removePendingDigest(bodyId, candidateDigest);
		this.options.sockets().notifyBodyCommitted(bodyId, durable.durableGeneration);
		return json(this.receipt(durable));
	}

	private async candidateCatalog(bodyId: string, update: Uint8Array): Promise<{
		metadata: { contentHash: string; size: number };
		catalog?: CatalogMutation;
	}> {
		const reconstructed = this.options.store.reconstructDocument(bodyId);
		const release = this.options.cache.recordTransient(bodyId, update.byteLength);
		try {
			Y.applyUpdate(reconstructed.doc, update, "candidate-metadata");
			const bytes = new TextEncoder().encode(Y.Text.prototype.toString.call(reconstructed.doc.getText("body")));
			const metadata = { contentHash: await sha256Hex(bytes), size: bytes.byteLength };
			const current = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), bodyId);
			const generation = (this.options.store.documentHead(bodyId)?.generation ?? 0) + 1;
			return {
				metadata,
				catalog: current?.lifecycle === "active" ? { bodyId, fileId: current.fileId, path: current.path, previousPath: null,
					lifecycle: "active", bodyGeneration: generation, contentHash: metadata.contentHash, size: metadata.size } : undefined,
			};
		} finally {
			release();
			reconstructed.doc.destroy();
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
