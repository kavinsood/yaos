import type { YwasmCrdtDocument } from "./crdt/ywasmCrdtEngine";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "./shared/binaryEnvelope";
import { BootstrapService } from "./bootstrap";
import { MAX_BODY_ID_LENGTH, MAX_CATCH_UP_BODIES, MAX_CATCH_UP_BYTES, MAX_DURABLE_UPDATE_BYTES, MAX_JSON_BYTES } from "./contracts";
import { sha256Hex } from "./hex";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import { handleVaultRecoveryRpc } from "./recoveryRpcRouter";
import { RECOVERY_PUBLIC_RPC_PATH } from "./recoveryProtocol";
import type { ActorCallPort, AlarmPort, DrainPort, ExecutionPort, ObjectStorePort, VaultRuntimeStoragePort } from "./platformPorts";
import { CloudflareActorCalls, CloudflareAlarmPort, CloudflareExecutionPort, CloudflareObjectStore, CloudflareSocketRegistry } from "./cloudflarePorts";
import { handleSettingsSyncRequest, SettingsSyncStore } from "./settingsSyncStore";
import {
	SERVER_PROTOCOL_VERSION,
	SERVER_SCHEMA_VERSION,
	SERVER_SETTINGS_FORMAT_VERSION,
	SERVER_SNAPSHOT_FORMAT_VERSION,
	SERVER_STORAGE_FORMAT_VERSION,
} from "./version";
import { VaultCandidateService } from "./vaultCandidateService";
import { VaultSemanticService } from "./vaultSemanticService";
import { canonicalMarkdownBytes } from "./shared/markdownCodec";
import { validateCanvasDocument } from "./crdt/canvasSemanticDocument";
import { blobKey } from "./vaultObjectStore";
import { VaultDocumentCache, type PendingVaultUpdate } from "./vaultDocumentCache";
import { VaultLifecycleService } from "./vaultLifecycleService";
import { VaultSocketService, type VaultSocketPort, type VaultSocketRegistryPort, hasSafeRootAttachmentSemantics, rootUpdateChangesProtectedAttachmentMaps, rootUpdateHasSafeAttachmentSemantics } from "./vaultSocketService";
import { VaultStore, type CatalogMutation, type SemanticCatalogHead, type SemanticCatalogMutation } from "./vaultStore";
import { isCanonicalVaultId } from "./vaultId";
import { VaultRecoveryService } from "./vaultRecoveryService";
import { authorizeRuntimeActor, OUTCOME_CLAIM_HEADER, parseVaultActor } from "./vaultAuthority";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext, type VaultCapability } from "./collaboration";
import { canonicalJsonHash } from "./recoveryCanonicalJson";
import type { VaultAuthoritySubjectChange } from "./vaultDocumentStore";
import { SemanticCompactionRuntime } from "./semanticCompactionRuntime";
import { BODY_EPOCH_HEADER, ROOT_EPOCH_HEADER, parseSemanticEpoch, parseSemanticEpochHeader } from "./shared/semanticEpoch";

const PERSIST_DEBOUNCE_MS = 250;
const PERSIST_RETRY_MS = 1_000;
const JOURNAL_COMPACT_ENTRIES = 50;
const JOURNAL_COMPACT_BYTES = 1024 * 1024;
const FEED_RETAIN_SEQUENCES = 1000;
const CATCH_UP_YIELD_INTERVAL = 4;
const INTERNAL_DEVICE_HEADER = "x-yaos-device-id";
const INTERNAL_GENERATION_HEADER = "x-yaos-vault-generation";

interface PersistenceStatus {
	status: "healthy" | "degraded";
	lastError: string | null;
	lastSuccessAt: number | null;
	failures: number;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function pathParts(pathname: string): string[] | null {
	const result: string[] = [];
	try {
		for (const part of pathname.split("/").filter(Boolean)) result.push(decodeURIComponent(part));
		return result;
	} catch {
		return null;
	}
}

function boundedLimit(url: URL, fallback = 1000): number {
	const value = Number(url.searchParams.get("limit") ?? fallback);
	return Number.isInteger(value) ? Math.min(1000, Math.max(1, value)) : fallback;
}

export function shouldCompactJournal(stats: { entries: number; bytes: number }): boolean {
	return stats.entries >= JOURNAL_COMPACT_ENTRIES || stats.bytes >= JOURNAL_COMPACT_BYTES;
}

/** Split one debounced queue into batches that can each occupy one durable BLOB row. */
export function partitionDurableUpdateBatches<T extends { bytes: Uint8Array }>(entries: readonly T[]): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let bytes = 0;
	for (const entry of entries) {
		if (entry.bytes.byteLength === 0 || entry.bytes.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new Error("pending update exceeds durable value limit");
		}
		if (batch.length > 0 && bytes + entry.bytes.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			batches.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(entry);
		bytes += entry.bytes.byteLength;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

function sameSemanticCatalogHead(left: SemanticCatalogHead | null, right: SemanticCatalogHead): boolean {
	return left !== null
		&& left.documentId === right.documentId
		&& left.sequence === right.sequence
		&& left.path === right.path
		&& left.lifecycle === right.lifecycle
		&& left.generation === right.generation
		&& left.bodyEpoch === right.bodyEpoch;
}

export function createVaultDocument(guid?: string): YwasmCrdtDocument {
	return crdtEngine.createDocument(guid ?? crypto.randomUUID());
}

export function applyVaultUpdate(doc: YwasmCrdtDocument, update: Uint8Array): void {
	crdtEngine.applyUpdate(doc, update);
}

export function encodeVaultState(doc: YwasmCrdtDocument): Uint8Array {
	return crdtEngine.encodeStateAsUpdate(doc);
}

export interface RootPathPublication {
	sourcePath: string | null;
	resultPath: string;
	fileId: string;
	lifecycle: "active" | "tombstoned";
}

export function encodeRootPathPublicationUpdate(rootState: Uint8Array, operations: RootPathPublication[]): Uint8Array {
	const doc = crdtEngine.createDocument("root-publication");
	try {
		crdtEngine.applyUpdate(doc, rootState);
		crdtEngine.applyRootOperations(doc, [
			...operations.filter((operation) => operation.sourcePath).map((operation) => ({
				kind: "map-delete" as const, root: "pathToId", key: operation.sourcePath!,
			})),
			...operations.filter((operation) => operation.lifecycle === "active").map((operation) => ({
				kind: "map-set" as const, root: "pathToId", key: operation.resultPath,
				value: { shared: "value" as const, value: operation.fileId },
			})),
		], "root-path-publication");
		return crdtEngine.encodeStateAsUpdate(doc);
	} finally {
		crdtEngine.destroyDocument(doc);
	}
}

export { hasSafeRootAttachmentSemantics, rootUpdateChangesProtectedAttachmentMaps, rootUpdateHasSafeAttachmentSemantics };

export interface VaultRuntimeOptions {
	storage: VaultRuntimeStoragePort;
	sockets: VaultSocketRegistryPort;
	alarms: AlarmPort;
	execution: ExecutionPort;
	objectStore?: ObjectStorePort;
	recoveryJobs?: ActorCallPort;
}

/** Schema-8 root/Markdown/Canvas composition, independent of a worker or process host. */
export class VaultRuntime implements DrainPort {
	private store: VaultStore;
	private settings: SettingsSyncStore;
	private readonly runtimeEpoch = crypto.randomUUID();
	private readonly cache: VaultDocumentCache;
	private readonly sockets: VaultSocketService;
	private readonly lifecycle: VaultLifecycleService;
	private readonly candidates: VaultCandidateService;
	private readonly semantic: VaultSemanticService;
	private readonly bootstrap: BootstrapService;
	private readonly recovery: VaultRecoveryService;
	private readonly semanticCompaction: SemanticCompactionRuntime;
	private lastObservedCommitSequence = 0;
	private readonly persistence = new Map<string, PersistenceStatus>();
	private readonly scheduledFlushes = new Map<string, Promise<void>>();
	/** Persistence work is serialized per document; unrelated notes must not block one another. */
	private readonly flushLanes = new Map<string, Promise<void>>();
	private deleted = false;
	private drainPromise: Promise<void> | null = null;
	private authorityBoundary: Promise<void> = Promise.resolve();

	constructor(private readonly options: VaultRuntimeOptions) {
		this.store = new VaultStore(options.storage);
		this.settings = new SettingsSyncStore(options.storage);
		let socketOwner: VaultSocketService;
		this.cache = new VaultDocumentCache(
			this.store,
			() => socketOwner?.openBodyIds() ?? new Set<string>(),
			// History pins retain durable SQLite lineage. They do not require every
			// body at the pinned boundary to remain materialized in RAM. Runtime
			// owners that genuinely need residency must be represented explicitly;
			// today open sockets are the only such owners.
			() => new Set<string>(),
		);
		const vaultId = () => this.requireMetadata().vaultId;
		const vaultGeneration = () => this.requireMetadata().vaultGeneration;
		socketOwner = new VaultSocketService({
			crdtEngine,
			sockets: options.sockets,
			cache: this.cache,
			vaultId,
			vaultGeneration,
			runtimeEpoch: this.runtimeEpoch,
			isActiveBody: (bodyId) => this.lifecycle?.activeBodyHead(bodyId) !== null,
			isActiveSemantic: (documentId) => this.store.semanticHeadAt(this.store.currentSequence(), documentId)?.lifecycle === "active",
			currentSemanticHead: (documentId) => this.store.semanticHeadAt(this.store.currentSequence(), documentId),
			currentRootEpoch: () => this.store.documentHead("root")?.semanticEpoch ?? 1,
			currentSemanticEpoch: (documentId) => this.store.documentHead(documentId)?.semanticEpoch ?? null,
			currentBodyHead: (bodyId) => {
				const head = this.store.getCatalogHeadAt(this.store.currentSequence(), bodyId);
				const documentHead = this.store.documentHead(bodyId);
				return head && documentHead ? {
					bodyId: head.bodyId,
					bodyEpoch: documentHead.semanticEpoch,
					lifecycle: head.lifecycle,
					generation: head.generation,
					contentHash: head.contentHash,
					size: head.size,
					sequence: head.sequence,
				} : null;
			},
			currentSequence: () => this.store.currentSequence(),
			validateActor: (actor) => this.store.validateActor(actor) === "allowed",
			principalPresence: (principalId) => {
				const principal = this.store.principalAuthority(principalId);
				return principal?.state === "active" ? { displayName: principal.displayName, colorSeed: principal.colorSeed } : null;
			},
			scheduleFlush: (documentId) => this.scheduleFlush(documentId),
			shouldPauseAdmission: (documentId) => this.semanticCompaction?.shouldPauseAdmission(documentId) ?? false,
		});
		this.sockets = socketOwner;
		this.semanticCompaction = new SemanticCompactionRuntime({
			store: this.store,
			cache: this.cache,
			fenceSockets: (documentId, previousEpoch, currentEpoch) =>
				this.sockets.fenceSemanticEpoch(documentId, previousEpoch, currentEpoch),
		});
		this.store.setCommitObserver((observation) => this.afterDurableCommit(observation));
		this.cache.setLoadObserver((loaded) => this.afterDocumentLoaded(
			loaded.documentId, loaded.encodedStateBytes,
		));
		this.lifecycle = new VaultLifecycleService({
			store: this.store,
			cache: this.cache,
			sockets: () => this.sockets,
			vaultId,
			hasBlob: async (hash) => options.objectStore
				? await options.objectStore.head(blobKey(vaultId(), vaultGeneration(), hash)) !== null
				: false,
			vaultGeneration,
			runtimeEpoch: this.runtimeEpoch,
			flush: (documentId) => this.flushDocument(documentId),
			validateActor: (actor) => this.store.validateActor(actor) === "allowed",
		});
		this.candidates = new VaultCandidateService({
			store: this.store,
			cache: this.cache,
			lifecycle: () => this.lifecycle,
			sockets: () => this.sockets,
			vaultId,
			vaultGeneration,
			runtimeEpoch: this.runtimeEpoch,
			flush: (documentId) => this.flushDocument(documentId),
			validateActor: (actor) => this.store.validateActor(actor) === "allowed",
			shouldPauseAdmission: (documentId) => this.semanticCompaction.shouldPauseAdmission(documentId),
		});
		this.semantic = new VaultSemanticService({
			store: this.store,
			cache: this.cache,
			sockets: this.sockets,
			vaultId,
			vaultGeneration,
			runtimeEpoch: this.runtimeEpoch,
			validateActor: (actor) => this.store.validateActor(actor) === "allowed",
			flush: (documentId) => this.flushDocument(documentId),
			shouldPauseAdmission: (documentId) => this.semanticCompaction.shouldPauseAdmission(documentId),
			objectStore: options.objectStore,
		});
		this.bootstrap = new BootstrapService(
			this.store,
			Date.now,
			(documentId, overlappingCopies) => this.cache.reserveFullStateOperation(documentId, overlappingCopies),
		);
		this.recovery = new VaultRecoveryService({
			alarms: {
				setAlarm: (scheduledTime) => this.armAlarmEarliest(scheduledTime),
				deleteAlarm: () => options.alarms.deleteAlarm(),
				getAlarm: () => options.alarms.getAlarm?.() ?? Promise.resolve(null),
			},
			objectStore: options.objectStore,
			recoveryJobs: options.recoveryJobs,
			store: () => this.store,
			runtimeEpoch: this.runtimeEpoch,
			flushLoadedDocuments: () => this.flushLoadedDocuments(),
			hasPendingPersistence: () => Object.keys(this.cache.diagnostics().pending).length > 0
				|| [...this.persistence.values()].some((entry) => entry.status === "degraded"),
			fenceRuntime: () => {
				this.deleted = true;
			},
			closeSockets: (reason) => this.sockets.closeAll(reason),
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (this.drainPromise) return json({ error: "vault_draining" }, 503);
		const vaultId = request.headers.get("x-yaos-vault-id");
		if (!isCanonicalVaultId(vaultId)) return json({ error: "invalid_vault_identity" }, 400);
		const url = new URL(request.url);
		const parts = pathParts(url.pathname);
		if (!parts) return json({ error: "not_found" }, 404);
		try {
			if (request.method === "POST" && url.pathname === "/__yaos/provision") return await this.provision(vaultId, request);
			const metadata = this.store.vaultMetadata();
			if (!metadata) return json({ error: "vault_not_provisioned" }, 409);
			if (metadata.vaultId !== vaultId) return json({ error: "vault_identity_mismatch" }, 409);
			const forwardedGeneration = request.headers.get(INTERNAL_GENERATION_HEADER);
			if (forwardedGeneration !== metadata.vaultGeneration) {
				return json({ error: "vault_generation_mismatch" }, 409);
			}
				if (request.method === "POST" && url.pathname === "/__yaos/authority-fence") {
					return this.runAuthorityBoundary(() => this.installAuthorityFence(request));
				}
				if (url.pathname === RECOVERY_PUBLIC_RPC_PATH) {
					return this.runAuthorityBoundary(async () => {
						const recoveryActor = parseVaultActor(request, metadata.vaultId, metadata.vaultGeneration);
						const authorized = this.authorize(recoveryActor, "vault.recovery.manage");
						if (authorized instanceof Response) return authorized;
						return await handleVaultRecoveryRpc(request, vaultId, this.store, this.recovery)
							?? json({ error: "not_found" }, 404);
					});
				}
				const recoveryResponse = await handleVaultRecoveryRpc(request, vaultId, this.store, this.recovery);
			if (recoveryResponse) return recoveryResponse;
			if (request.method === "POST" && url.pathname === "/__yaos/revoke-device-sockets") {
				let body: { deviceId?: unknown };
				try {
					body = await request.json();
				} catch {
					return json({ error: "invalid_json" }, 400);
				}
				if (typeof body.deviceId !== "string" || !body.deviceId || body.deviceId.length > 128) {
					return json({ error: "invalid_device_identity" }, 400);
				}
				this.store.revokeDevice(body.deviceId);
				return json({ closed: this.sockets.closeDevice(body.deviceId) });
			}
			if (request.method === "POST" && url.pathname === "/__yaos/begin-vault-deletion") return this.beginDeletion(request);
			if (request.method === "POST" && url.pathname === "/__yaos/delete-all") return this.deleteAll();
			if (this.store.vaultDeletionBegun(metadata.vaultGeneration)) return json({ error: "vault_deleting" }, 410);
			const actor = parseVaultActor(request, metadata.vaultId, metadata.vaultGeneration);
			if (parts[0] === "settings-sync") {
				if (parts.length < 2 || parts.length > 3) return json({ error: "not_found" }, 404);
				const authorized = this.authorize(actor, "vault.settings.personal.sync", actor?.principalId);
				if (authorized instanceof Response) return authorized;
				return handleSettingsSyncRequest(this.settings, request, parts[1]!, parts[2], authorized.principalId,
					() => this.store.validateActor(authorized) === "allowed", authorized);
			}
			if (request.method === "POST" && url.pathname === "/compact") return this.compact();

			if (request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const authorized = this.authorize(actor, "vault.content.read");
				if (authorized instanceof Response) return authorized;
				if (url.pathname === "/ws/root") {
					let rootEpoch;
					try { rootEpoch = parseSemanticEpochHeader(request.headers, "root"); }
					catch { return json({ error: "root_epoch_required" }, 400); }
					return this.sockets.accept("root", "root", rootEpoch, authorized);
				}
				if (parts.length === 3 && parts[0] === "ws" && parts[1] === "body") {
					const bodyId = parts[2]!;
					let bodyEpoch;
					try { bodyEpoch = parseSemanticEpochHeader(request.headers, "body"); }
					catch { return json({ error: "body_epoch_required" }, 400); }
					if (!this.lifecycle.activeBodyHead(bodyId)) return json({ error: "body_not_active" }, 409);
					return this.sockets.accept(bodyId, "body", bodyEpoch, authorized);
				}
				if (parts.length === 3 && parts[0] === "ws" && parts[1] === "semantic") {
					const documentId = parts[2]!;
					let documentEpoch;
					try { documentEpoch = parseSemanticEpochHeader(request.headers, "body"); }
					catch { return json({ error: "body_epoch_required" }, 400); }
					if (!this.semantic.activeHead(documentId)) return json({ error: "semantic_document_not_active" }, 409);
					return this.sockets.accept(documentId, "semantic", documentEpoch, authorized);
				}
			}
			if (request.method === "POST" && parts.length === 3 && parts[0] === "body" && parts[2] === "candidate") {
				const authorized = this.authorize(actor, "vault.content.write");
				return authorized instanceof Response ? authorized : this.candidates.handle(parts[1]!, request, authorized);
			}
			if (request.method === "POST" && url.pathname === "/body/candidates") {
				const authorized = this.authorize(actor, "vault.content.write");
				return authorized instanceof Response ? authorized : this.candidates.handleBatch(request, authorized);
			}
			if (request.method === "POST" && parts.length === 3 && parts[0] === "semantic" && parts[2] === "candidate") {
				const authorized = this.authorize(actor, "vault.content.write");
				return authorized instanceof Response ? authorized : this.semantic.candidate(parts[1]!, request, authorized);
			}
			if (request.method === "POST" && url.pathname === "/semantic/lifecycle") {
				const authorized = this.authorize(actor, "vault.lifecycle.write");
				return authorized instanceof Response ? authorized : this.semantic.lifecycle(request, authorized);
			}
			if (request.method === "POST" && url.pathname === "/semantic/authority/promote") {
				const authorized = this.authorize(actor, "vault.attachments.write");
				return authorized instanceof Response ? authorized : this.semantic.promote(request, authorized);
			}
			if (request.method === "POST" && url.pathname === "/semantic/authority/demote") {
				const authorized = this.authorize(actor, "vault.attachments.write");
				return authorized instanceof Response ? authorized : this.semantic.demote(request, authorized);
			}
			if (request.method === "POST" && url.pathname === "/attachments/publish") {
				const authorized = this.authorize(actor, "vault.attachments.write");
				return authorized instanceof Response ? authorized : this.lifecycle.publishAttachment(request, authorized);
			}
			if (request.method === "POST" && url.pathname.startsWith("/lifecycle")) {
				const authorized = this.authorize(actor, "vault.lifecycle.write");
				if (authorized instanceof Response) return authorized;
				if (url.pathname === "/lifecycle") return this.lifecycle.handle(request, authorized);
				if (url.pathname === "/lifecycle/admissions") return this.lifecycle.handleCreateAdmissionsBatch(request, authorized);
				if (url.pathname === "/lifecycle/batch") return this.lifecycle.handleBatch(request, authorized);
				if (url.pathname === "/lifecycle/publish") return this.lifecycle.publish(request, authorized);
			}
			if (request.method === "POST" && url.pathname === "/catch-up") {
				const denied = this.authorize(actor, "vault.content.read");
				return denied instanceof Response ? denied : this.catchUp(request);
			}
			if (request.method === "GET" && parts.length === 3 && parts[0] === "operations" && parts[2] === "outcome") {
				const staleClaim = request.headers.get(OUTCOME_CLAIM_HEADER) === "1";
				const authorized = staleClaim ? actor : this.authorize(actor, "vault.operations.read_own_outcome");
				if (!authorized) return json({ error: "missing_trusted_actor" }, 401);
				if (authorized instanceof Response) return authorized;
				const digest = url.searchParams.get("requestDigest");
				if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return json({ error: "invalid_request_digest" }, 400);
				const membershipRevision = Number(url.searchParams.get("membershipRevision") ?? authorized.membershipRevision);
				const deviceCredentialRevision = Number(url.searchParams.get("deviceCredentialRevision") ?? authorized.deviceCredentialRevision);
				const operationDeviceId = url.searchParams.get("deviceId") ?? authorized.deviceId;
				if (!Number.isSafeInteger(membershipRevision) || membershipRevision < 1
					|| !Number.isSafeInteger(deviceCredentialRevision) || deviceCredentialRevision < 1) {
					return json({ error: "invalid_operation_authority" }, 400);
				}
				if ((staleClaim && operationDeviceId !== authorized.deviceId)
					|| this.store.deviceAuthority(operationDeviceId)?.principalId !== authorized.principalId) {
					return json({ error: "principal_target_mismatch" }, 403);
				}
				const outcome = this.store.committedOperationOutcome({ principalId: authorized.principalId,
					deviceId: operationDeviceId, membershipRevision, deviceCredentialRevision }, parts[1]!, digest);
				return outcome ? json(outcome) : json({ error: "operation_outcome_not_found" }, 404);
			}
			const contentRead = this.authorize(actor, url.pathname === "/diagnostics" ? "vault.diagnostics.read" : "vault.content.read");
			if (contentRead instanceof Response) return contentRead;
			const bootstrap = await this.bootstrapRoute(request, url, parts);
			if (bootstrap) return bootstrap;
			if (request.method === "GET" && url.pathname === "/changes") {
				const after = Number(url.searchParams.get("after") ?? "0");
				if (!Number.isInteger(after) || after < 0) return json({ error: "invalid_cursor" }, 400);
				return json(this.store.changesPageAfter(after, boundedLimit(url)));
			}
			if (request.method === "GET" && url.pathname === "/heads") {
				const highWater = this.store.currentSequence();
				const limit = boundedLimit(url);
				const entries = this.store.listActiveCatalogAt(highWater, url.searchParams.get("cursor") ?? "", limit);
				return json({ entries, nextCursor: entries.length === limit ? entries.at(-1)!.bodyId : null, highWater });
			}
			if (request.method === "GET" && parts.length === 2 && parts[0] === "head") return json(this.lifecycle.activeBodyHead(parts[1]!));
			if (request.method === "GET" && parts.length === 2 && parts[0] === "body") return this.bodyState(parts[1]!);
			if (request.method === "GET" && parts.length === 3 && parts[0] === "semantic" && parts[2] === "head") {
				return json(this.semantic.activeHead(parts[1]!) ?? { error: "semantic_document_not_active" },
					this.semantic.activeHead(parts[1]!) ? 200 : 404);
			}
			if (request.method === "GET" && parts.length === 3 && parts[0] === "semantic" && parts[2] === "state") {
				return this.semantic.state(parts[1]!);
			}
			if (request.method === "GET" && url.pathname === "/root") return this.rootState(url);
			if (request.method === "GET" && url.pathname === "/status") return this.status();
			if (request.method === "GET" && url.pathname === "/health") return this.health();
			if (request.method === "GET" && url.pathname === "/diagnostics") return this.diagnostics();
			return json({ error: "not_found" }, 404);
		} catch (error) {
			console.error("[yaos-vault] request failed", error);
			return json({ error: error instanceof Error ? error.message : "vault_runtime_failed" }, 500);
		}
	}

	private authorize(actor: VaultActorContext | null, capability: VaultCapability, targetPrincipalId?: string): VaultActorContext | Response {
		const result = authorizeRuntimeActor(this.store, actor, capability, targetPrincipalId);
		return result.allowed ? result.actor : result.response;
	}

	private runAuthorityBoundary<T>(work: () => Promise<T>): Promise<T> {
		const result = this.authorityBoundary.then(work, work);
		this.authorityBoundary = result.then(() => undefined, () => undefined);
		return result;
	}

	private async installAuthorityFence(request: Request): Promise<Response> {
		let input: { changeId?: unknown; vaultId?: unknown; vaultGeneration?: unknown; subjectDigest?: unknown; subjects?: unknown };
		try { input = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		if (typeof input.changeId !== "string" || !input.changeId || input.changeId.length > 256
			|| typeof input.vaultId !== "string" || typeof input.vaultGeneration !== "string"
			|| !Array.isArray(input.subjects) || input.subjects.length === 0 || input.subjects.length > 512) {
			return json({ error: "invalid_authorization_change" }, 400);
		}
		const subjects: VaultAuthoritySubjectChange[] = [];
		for (const value of input.subjects) {
			if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "invalid_authorization_subject" }, 400);
			const subject = value as Record<string, unknown>;
			if (typeof subject.deviceId === "string") {
				const credentialRevision = Number.isSafeInteger(subject.credentialRevision)
					? subject.credentialRevision as number
					: subject.targetRevision;
				if (typeof subject.principalId !== "string" || (subject.state !== "active" && subject.state !== "revoked")
					&& (subject.targetState !== "active" && subject.targetState !== "revoked")
					|| !Number.isSafeInteger(credentialRevision) || (credentialRevision as number) < 1) {
					return json({ error: "invalid_device_authority" }, 400);
				}
				subjects.push({ deviceId: subject.deviceId, principalId: subject.principalId,
					state: (subject.state ?? subject.targetState) as "active" | "revoked", credentialRevision: credentialRevision as number });
			} else {
				const current = typeof subject.principalId === "string" ? this.store.principalAuthority(subject.principalId) : null;
				const role = subject.role ?? subject.targetRole;
				const state = subject.state ?? subject.targetState;
				const membershipRevision = Number.isSafeInteger(subject.membershipRevision)
					? subject.membershipRevision as number
					: subject.targetRevision;
				if (typeof subject.principalId !== "string" || (role !== "owner" && role !== "member")
					|| (state !== "active" && state !== "revoked")
					|| !Number.isSafeInteger(membershipRevision) || (membershipRevision as number) < 1) {
					return json({ error: "invalid_principal_authority" }, 400);
				}
				const policyVersion = Number.isSafeInteger(subject.policyVersion) ? subject.policyVersion as number : COLLABORATION_POLICY_VERSION;
				const capabilityDigest = await capabilityDigestForRole(role);
				if (subject.capabilityDigest !== undefined && subject.capabilityDigest !== capabilityDigest) {
					return json({ error: "capability_digest_mismatch" }, 409);
				}
				subjects.push({ principalId: subject.principalId, role, state,
					membershipRevision: membershipRevision as number, policyVersion,
					capabilityDigest,
					displayName: typeof subject.displayName === "string" ? subject.displayName : current?.displayName ?? subject.principalId,
					colorSeed: typeof subject.colorSeed === "string" ? subject.colorSeed : current?.colorSeed ?? subject.principalId });
			}
		}
		const suppliedSubjectDigest = typeof input.subjectDigest === "string" ? input.subjectDigest : null;
		if (suppliedSubjectDigest) {
			const sourceDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(input.subjects)));
			if (sourceDigest !== suppliedSubjectDigest) return json({ error: "authorization_subject_digest_mismatch" }, 409);
		}
		const subjectDigest = suppliedSubjectDigest ?? await canonicalJsonHash(subjects);
		try {
			await this.flushLoadedDocuments();
			const receipt = this.store.installAuthorityFence({ changeId: input.changeId, vaultId: input.vaultId,
				vaultGeneration: input.vaultGeneration, subjectDigest, subjects });
			const principalIds = new Set(subjects.filter((subject) => !("deviceId" in subject))
				.map((subject) => subject.principalId));
			for (const subject of subjects) {
				if ("deviceId" in subject) this.sockets.closeDevice(subject.deviceId);
			}
			for (const principalId of principalIds) this.sockets.closePrincipal(principalId);
			return json({ ...receipt, runtimeEpoch: this.runtimeEpoch });
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "authorization_fence_failed" }, 409);
		}
	}

	async webSocketMessage(socket: VaultSocketPort, message: string | ArrayBuffer): Promise<void> {
		if (this.deleted || this.drainPromise) socket.close(1001, "vault maintenance");
		else await this.sockets.message(socket, message);
	}

	webSocketClose(): void {}

	webSocketError(socket: VaultSocketPort): void {
		try { socket.close(1011, "socket error"); } catch { /* already closed */ }
	}

	drain(): Promise<void> {
		if (!this.drainPromise) {
			this.drainPromise = (async () => {
				this.sockets.closeAll("server draining");
				await Promise.all([...this.scheduledFlushes.values()]);
				await this.flushLoadedDocuments();
				await this.waitForFlushLanes();
			})();
		}
		return this.drainPromise;
	}

	async alarm(): Promise<void> {
		for (const documentId of Object.keys(this.cache.diagnostics().pending)) await this.flushDocument(documentId);
		for (const documentId of this.store.listJournalCheckpointCandidates(
			JOURNAL_COMPACT_ENTRIES, JOURNAL_COMPACT_BYTES, 25,
		)) this.maintain(documentId);
		for (const documentId of this.semanticCompaction.dueRetries(Date.now(), 25)) {
			let enteredAttempt = false;
			try {
				if (!this.cache.get(documentId)) {
					const kind = this.cache.documentKind(documentId);
					this.cache.load(documentId, documentId !== "root", () => true, kind);
				}
				enteredAttempt = true;
				await this.semanticCompaction.measureAndMaybeCompact(documentId);
			} catch (error) {
				if (!enteredAttempt) {
					try { this.semanticCompaction.recordLoadFailure(documentId, error); }
					catch (retryError) { console.warn("[yaos-vault] compaction load retry persistence failed", retryError); }
				}
				console.warn("[yaos-vault] semantic compaction alarm attempt failed", error);
			}
		}
		this.store.reapExpiredRecoveryCaptures(Date.now(), 25);
		this.store.reapExpiredRestoreAuthorities(Date.now(), 25);
		const gc = this.store.latestGcEpoch();
		if (gc && (gc.state === "marking" || gc.state === "sweeping") && gc.deadlineAt <= Date.now()) {
			this.store.advanceGcEpoch(gc.epoch, "aborted");
		}
		const compactionRetryAt = this.semanticCompaction.nextRetryAt();
		const checkpointRetry = this.store.listJournalCheckpointCandidates(
			JOURNAL_COMPACT_ENTRIES, JOURNAL_COMPACT_BYTES, 1,
		).length > 0;
		if (checkpointRetry) await this.armAlarmEarliest(Date.now() + PERSIST_RETRY_MS);
		if (compactionRetryAt !== null) {
			await this.armAlarmEarliest(Math.max(Date.now(), compactionRetryAt));
		} else if (this.store.activeRecoveryCapture() || this.store.activeRestoreAuthority()
			|| gc?.state === "marking" || gc?.state === "sweeping") {
			await this.armAlarmEarliest(Date.now() + 60_000);
		}
	}

	private async provision(vaultId: string, request: Request): Promise<Response> {
		let body: { vaultGeneration?: unknown };
		try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		if (!isCanonicalVaultId(body.vaultGeneration)) return json({ error: "invalid_vault_generation" }, 400);
		const root = crdtEngine.createDocument("root");
		crdtEngine.applyRootOperations(root, [
			{ kind: "map-set", root: "sys", key: "schemaVersion", value: { shared: "value", value: SERVER_SCHEMA_VERSION } },
			{ kind: "map-set", root: "sys", key: "protocolVersion", value: { shared: "value", value: SERVER_PROTOCOL_VERSION } },
		], "vault-provision");
		const result = this.store.provisionVault(vaultId, body.vaultGeneration, crdtEngine.encodeStateAsUpdate(root));
		crdtEngine.destroyDocument(root);
		this.deleted = false;
		try {
			await this.recovery.initializeProjection(vaultId);
		} catch (error) {
			console.warn("[yaos-vault] recovery projection unavailable", error);
		}
		return json(result, result.created ? 201 : 200);
	}

	private async beginDeletion(request: Request): Promise<Response> {
		let body: { deletionId?: unknown; vaultGeneration?: unknown };
		try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		const metadata = this.requireMetadata();
		if (body.vaultGeneration !== metadata.vaultGeneration || typeof body.deletionId !== "string" || !body.deletionId) {
			return json({ error: "invalid_vault_deletion_fence" }, 400);
		}
		await this.flushLoadedDocuments();
		await this.recovery.beginVaultDeletion({ vaultId: metadata.vaultId, deletionId: body.deletionId });
		return json({ deleting: true });
	}

	private async deleteAll(): Promise<Response> {
		this.deleted = true;
		this.sockets.closeAll("vault deleted");
		await this.waitForFlushLanes();
		this.cache.clear();
		this.persistence.clear();
		await this.options.alarms.deleteAlarm();
		await this.options.storage.deleteAll();
		this.store = new VaultStore(this.options.storage);
		this.store.setCommitObserver((observation) => this.afterDurableCommit(observation));
		this.settings = new SettingsSyncStore(this.options.storage);
		return json({ deleted: true });
	}

	private async catchUp(request: Request): Promise<Response> {
		const deviceId = request.headers.get(INTERNAL_DEVICE_HEADER);
		if (!deviceId) return json({ error: "missing_trusted_device_identity" }, 401);
		let bytes: Uint8Array;
		try { bytes = await readBoundedBytes(request, MAX_CATCH_UP_BYTES); }
		catch (error) { return json({ error: error instanceof BoundedBodyError ? error.kind : "invalid_body" }, 413); }
		let input: unknown;
		try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: "invalid_json" }, 400); }
		if (typeof input !== "object" || input === null || Array.isArray(input) || !("bodies" in input)
			|| !Array.isArray(input.bodies) || input.bodies.length > MAX_CATCH_UP_BODIES) {
			return json({ error: "invalid_catch_up_batch" }, 400);
		}
		const requestedBodies: unknown[] = input.bodies;
		const bodies: unknown[] = [];
		const responseReservations: Array<() => void> = [];
		const requestedBodyIds = new Set<string>();
		let reconstructedBodies = 0;
		for (const item of requestedBodies) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				return json({ error: "invalid_catch_up_batch" }, 400);
			}
			const bodyId = "bodyId" in item && typeof item.bodyId === "string" ? item.bodyId : "";
			if (!bodyId || bodyId.length > MAX_BODY_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(bodyId)
				|| requestedBodyIds.has(bodyId)
				|| !("bodyEpoch" in item) || !Number.isSafeInteger(item.bodyEpoch) || (item.bodyEpoch as number) < 1
				|| ("generation" in item && item.generation !== undefined
					&& (!Number.isSafeInteger(item.generation) || (item.generation as number) < 0))
				|| ("contentHash" in item && item.contentHash !== undefined && item.contentHash !== null
					&& (typeof item.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(item.contentHash)))) {
				return json({ error: "invalid_catch_up_batch" }, 400);
			}
			requestedBodyIds.add(bodyId);
			const head = this.lifecycle.activeBodyHead(bodyId);
			if (!head) { bodies.push({ bodyId, status: 409, error: "body_not_active" }); continue; }
			const knownGeneration = "generation" in item && Number.isSafeInteger(item.generation)
				? item.generation as number
				: null;
			const knownBodyEpoch = parseSemanticEpoch(item.bodyEpoch, "catch-up body epoch");
			const knownContentHash = "contentHash" in item && typeof item.contentHash === "string"
				? item.contentHash
				: null;
			const metadata = {
				bodyId,
				bodyEpoch: head.bodyEpoch,
				fileId: head.fileId,
				path: head.path,
				previousPath: head.previousPath,
				lifecycle: head.lifecycle,
				generation: head.generation,
				contentHash: head.contentHash,
				size: head.size,
			};
			if (knownBodyEpoch === head.bodyEpoch && knownGeneration === head.generation
				&& (knownContentHash === null || knownContentHash === head.contentHash)) {
				bodies.push({ ...metadata, status: 304 });
				continue;
			}
			let reconstructedThisBody = false;
			let failedRelease: (() => void) | null = null;
			try {
				const release = this.cache.reserveFullStateOperation(bodyId, 2);
				failedRelease = release;
				const reconstructed = this.store.reconstructDocument(bodyId);
				try {
					const update = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
					release();
					const responseRelease = this.cache.reserveFullStateOperation(bodyId, 1, update.byteLength);
					bodies.push({ ...metadata, status: 200, bodyEpoch: reconstructed.semanticEpoch,
						generation: reconstructed.generation, update });
					responseReservations.push(responseRelease);
					failedRelease = null;
					reconstructedBodies++;
					reconstructedThisBody = true;
				} catch (error) {
					release();
					throw error;
				} finally { crdtEngine.destroyDocument(reconstructed.doc); }
			} catch {
				failedRelease?.();
				bodies.push({ bodyId, status: 500, error: "body_state_corrupt" });
			}
			if (reconstructedThisBody && reconstructedBodies % CATCH_UP_YIELD_INTERVAL === 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		try {
			let response: Uint8Array;
			try { response = encodeBinaryEnvelope({ bodies, highWater: this.store.currentSequence() }, MAX_CATCH_UP_BYTES); }
			catch { return json({ error: "catch_up_response_too_large" }, 413); }
			return new Response(response.slice().buffer, { headers: { "content-type": YAOS_BINARY_CONTENT_TYPE, "cache-control": "no-store" } });
		} finally {
			for (const release of responseReservations) release();
		}
	}

	private async bootstrapRoute(request: Request, url: URL, parts: string[]): Promise<Response | null> {
		if (parts[0] !== "bootstrap") return null;
		if (request.method === "POST" && url.pathname === "/bootstrap/start") {
			await this.flushLoadedDocuments();
			let input: unknown = {};
			try { input = await request.json(); } catch { /* optional body */ }
			const attemptId = typeof input === "object" && input !== null && !Array.isArray(input)
				&& "attemptId" in input && typeof input.attemptId === "string" ? input.attemptId : undefined;
			return json(await this.bootstrap.start(attemptId));
		}
		const bootstrapId = parts[1];
		if (!bootstrapId) return json({ error: "not_found" }, 404);
		if (request.method === "GET" && parts.length === 3 && parts[2] === "root") {
			const state = this.bootstrap.rootState(bootstrapId);
			const release = this.cache.reserveFullStateOperation("root", 1, state.encodedState.byteLength);
			try {
				return new Response(state.encodedState.slice().buffer, { headers: { "content-type": "application/octet-stream",
					[ROOT_EPOCH_HEADER]: String(state.rootEpoch), "x-yaos-sha256": await state.hash } });
			} finally { release(); }
		}
		if (request.method === "GET" && parts.length === 3 && parts[2] === "catalog") return json(this.bootstrap.catalogPage(bootstrapId, url.searchParams.get("cursor"), boundedLimit(url)));
		if (request.method === "GET" && parts.length === 3 && parts[2] === "semantic-catalog") {
			return json(this.bootstrap.semanticCatalogPage(bootstrapId, url.searchParams.get("cursor"), boundedLimit(url)));
		}
		if (request.method === "GET" && parts.length === 4 && parts[2] === "semantic") {
			const state = this.bootstrap.semanticState(bootstrapId, parts[3]!);
			const release = this.cache.reserveFullStateOperation(state.documentId, 1, state.encodedState.byteLength);
			try {
				return new Response(state.encodedState.slice().buffer, { headers: { "content-type": "application/octet-stream",
					[BODY_EPOCH_HEADER]: String(state.bodyEpoch),
					"x-yaos-document-id": state.documentId, "x-yaos-generation": String(state.generation),
					"x-yaos-through-sequence": String(state.throughSequence) } });
			} finally { release(); }
		}
		if (request.method === "POST" && parts.length === 3 && parts[2] === "bodies") {
			let bytes: Uint8Array;
			try {
				bytes = await readBoundedBytes(request, MAX_JSON_BYTES);
			} catch (error) {
				return json({
					error: error instanceof BoundedBodyError ? error.kind : "invalid_body_batch",
				}, error instanceof BoundedBodyError && error.kind === "body_too_large" ? 413 : 400);
			}
			let input: unknown;
			try {
				input = JSON.parse(new TextDecoder().decode(bytes));
			} catch {
				return json({ error: "invalid_body_batch" }, 400);
			}
			if (
				typeof input !== "object"
				|| input === null
				|| Array.isArray(input)
				|| Object.keys(input).length !== 1
				|| !("bodyIds" in input)
				|| !Array.isArray(input.bodyIds)
				|| input.bodyIds.length < 1
				|| input.bodyIds.length > MAX_CATCH_UP_BODIES
			) {
				return json({ error: "invalid_body_batch" }, 400);
			}
			const bodyIds: string[] = [];
			for (const value of input.bodyIds) {
				if (typeof value !== "string" || value.length > MAX_BODY_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
					return json({ error: "invalid_body_id" }, 400);
				}
				bodyIds.push(value);
			}
			if (new Set(bodyIds).size !== bodyIds.length) return json({ error: "duplicate_body_id" }, 400);
			const releases: Array<() => void> = [];
			try {
				const bodies = bodyIds.map((bodyId) => {
					const state = this.bootstrap.bodyState(bootstrapId, bodyId);
					const release = this.cache.reserveFullStateOperation(bodyId, 1, state.encodedState.byteLength);
					releases.push(release);
					return {
						bodyId,
						bodyEpoch: state.bodyEpoch,
						generation: state.generation,
						encodedState: state.encodedState,
					};
				});
				let response: Uint8Array;
				try { response = encodeBinaryEnvelope({ bodies }, MAX_CATCH_UP_BYTES); }
				catch { return json({ error: "bootstrap_response_too_large" }, 413); }
				return new Response(response.slice().buffer, {
					headers: { "content-type": YAOS_BINARY_CONTENT_TYPE, "cache-control": "no-store" },
				});
			} finally {
				for (const release of releases) release();
			}
		}
		if (request.method === "GET" && parts.length === 4 && parts[2] === "body") {
			const bodyId = parts[3]!;
			const state = this.bootstrap.bodyState(bootstrapId, bodyId);
			const release = this.cache.reserveFullStateOperation(bodyId, 1, state.encodedState.byteLength);
			try {
				const head = this.store.getCatalogHeadAt(state.throughSequence, state.bodyId);
				return new Response(state.encodedState.slice().buffer, { headers: { "content-type": "application/octet-stream", "x-yaos-body-id": state.bodyId,
					[BODY_EPOCH_HEADER]: String(state.bodyEpoch),
					"x-yaos-generation": String(state.generation), "x-yaos-through-sequence": String(state.throughSequence),
					"x-yaos-content-hash": head?.contentHash ?? "", "x-yaos-size": String(head?.size ?? 0) } });
			} finally { release(); }
		}
		if (request.method === "POST" && parts.length === 3 && parts[2] === "renew") {
			const input: unknown = await request.json();
			if (typeof input !== "object" || input === null || Array.isArray(input)
				|| ("settledBodies" in input && input.settledBodies !== undefined && typeof input.settledBodies !== "number")) {
				return json({ error: "invalid_json" }, 400);
			}
			const settledBodies = "settledBodies" in input && typeof input.settledBodies === "number" ? input.settledBodies : 0;
			this.bootstrap.renew(bootstrapId, settledBodies);
			return json({ ok: true });
		}
		if (request.method === "POST" && parts.length === 3 && parts[2] === "complete") {
			const operation = this.store.getOperation(bootstrapId);
			if (operation?.state === "running") this.bootstrap.complete(bootstrapId);
			return json({ currentHighWater: this.store.currentSequence() });
		}
		return json({ error: "not_found" }, 404);
	}

	private async bodyState(bodyId: string): Promise<Response> {
		const head = this.lifecycle.activeBodyHead(bodyId);
		if (!head) return json({ error: "body_not_active" }, 404);
		const release = this.cache.reserveFullStateOperation(bodyId, 2);
		try {
			const reconstructed = this.store.reconstructDocument(bodyId);
			try {
				const bytes = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
				const content = canonicalMarkdownBytes(crdtEngine.readText(reconstructed.doc, "body"));
				return new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store",
					[BODY_EPOCH_HEADER]: String(reconstructed.semanticEpoch),
					"x-yaos-body-id": bodyId, "x-yaos-generation": String(reconstructed.generation), "x-yaos-content-hash": await sha256Hex(content), "x-yaos-size": String(content.byteLength) } });
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
		} finally { release(); }
	}

	private rootState(url: URL): Response {
		const current = this.store.currentSequence();
		const through = Number(url.searchParams.get("through") ?? current);
		if (!Number.isInteger(through) || through < 0 || through > current) return json({ error: "invalid_root_sequence" }, 400);
		const release = this.cache.reserveFullStateOperation("root", 2);
		try {
			const reconstructed = this.store.reconstructDocument("root", through);
			try {
				const bytes = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
				return new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store",
					[ROOT_EPOCH_HEADER]: String(reconstructed.semanticEpoch),
					"x-yaos-generation": String(reconstructed.generation), "x-yaos-through-sequence": String(through) } });
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
		} finally { release(); }
	}

	private async compact(): Promise<Response> {
		await this.flushLoadedDocuments();
		const documentIds = new Set<string>(["root"]);
		for (const entry of this.store.listActiveCatalogAt(this.store.currentSequence())) {
			documentIds.add(entry.bodyId);
		}
		for (const entry of this.store.listActiveSemanticAt(this.store.currentSequence())) {
			documentIds.add(entry.documentId);
		}
		let written = 0;
		for (const documentId of documentIds) {
			this.writeLiveCheckpoint(documentId);
			written++;
		}
		if (this.store.activePins().length === 0) {
			const floor = Math.max(0, this.store.currentSequence() - FEED_RETAIN_SEQUENCES);
			if (floor > this.store.journalFloor()) this.store.advanceFeedFloor(floor);
		}
		return json({
			ok: true,
			documents: documentIds.size,
			checkpointsWritten: written,
			blockedByPin: 0,
			sequence: this.store.currentSequence(),
			feedFloor: this.store.journalFloor(),
		});
	}

	private status(): Response {
		const metadata = this.requireMetadata();
		const sequence = this.store.currentSequence();
		return json({ vaultId: metadata.vaultId, vaultGeneration: metadata.vaultGeneration, runtimeEpoch: this.runtimeEpoch,
			provisionedAt: metadata.provisionedAt, schemaVersion: SERVER_SCHEMA_VERSION,
			storageFormatVersion: SERVER_STORAGE_FORMAT_VERSION, protocolVersion: SERVER_PROTOCOL_VERSION,
			snapshotFormatVersion: SERVER_SNAPSHOT_FORMAT_VERSION,
			settingsFormatVersion: SERVER_SETTINGS_FORMAT_VERSION,
			sequence, feedFloor: this.store.journalFloor(), activePins: this.store.activePins().length,
			semanticCanvas: this.semanticCanvasStatus(sequence) });
	}

	private health(): Response {
		const diagnostics = this.cache.diagnostics();
		const degraded = [...this.persistence.values()].filter((value) => value.status === "degraded").length;
		const ok = degraded === 0 && Object.keys(diagnostics.loadFailures).length === 0;
		return json({ ok, persistence: degraded === 0 ? "healthy" : "degraded", degradedDocuments: degraded,
			corruptDocuments: Object.keys(diagnostics.loadFailures).length, pendingUpdates: Object.values(diagnostics.pending).reduce((sum, value) => sum + value, 0) }, ok ? 200 : 503);
	}

	private diagnostics(): Response {
		const durableCompaction = this.store.listSemanticCompactionStates(100).map((state) => ({
			...state,
			journal: this.store.documentJournalStats(state.documentId),
			tail: this.store.documentJournalTailStats(state.documentId),
		}));
		return json({ ...this.statusObject(), sockets: this.options.sockets.sockets().length, ...this.cache.diagnostics(),
			semanticCompaction: this.semanticCompaction.diagnostics(),
			semanticCompactionDurable: durableCompaction,
			semanticCompactionNextRetryAt: this.semanticCompaction.nextRetryAt(),
			persistence: Object.fromEntries(this.persistence) });
	}

	private statusObject() {
		const metadata = this.requireMetadata();
		const sequence = this.store.currentSequence();
		return { vaultId: metadata.vaultId, vaultGeneration: metadata.vaultGeneration, runtimeEpoch: this.runtimeEpoch,
			provisionedAt: metadata.provisionedAt, schemaVersion: SERVER_SCHEMA_VERSION,
			storageFormatVersion: SERVER_STORAGE_FORMAT_VERSION, protocolVersion: SERVER_PROTOCOL_VERSION,
			snapshotFormatVersion: SERVER_SNAPSHOT_FORMAT_VERSION,
			settingsFormatVersion: SERVER_SETTINGS_FORMAT_VERSION,
			sequence, feedFloor: this.store.journalFloor(), semanticCanvas: this.semanticCanvasStatus(sequence) };
	}

	private semanticCanvasStatus(sequence: number): { enabled: true; available: true; active: number; retainedRollbackBlobs: number } {
		const store = this.store as VaultStore & {
			countActiveSemanticAt?: (boundary: number) => number;
			countRetainedSemanticRollbackBlobs?: () => number;
		};
		return { enabled: true, available: true,
			active: typeof store.countActiveSemanticAt === "function" ? store.countActiveSemanticAt(sequence) : 0,
			retainedRollbackBlobs: typeof store.countRetainedSemanticRollbackBlobs === "function"
				? store.countRetainedSemanticRollbackBlobs() : 0 };
	}

	private scheduleFlush(documentId: string): void {
		if (this.scheduledFlushes.has(documentId)) return;
		const scheduled = new Promise<void>((resolve) => setTimeout(resolve, PERSIST_DEBOUNCE_MS))
			.then(async () => { await this.flushDocument(documentId); })
			.finally(() => {
				this.scheduledFlushes.delete(documentId);
				if (this.cache.pendingFor(documentId).length > 0) this.scheduleFlush(documentId);
			});
		this.scheduledFlushes.set(documentId, scheduled);
		this.options.execution.waitUntil(scheduled);
	}

	private async flushDocument(documentId: string): Promise<boolean> {
		if (this.deleted) return false;
		let success = true;
		const prior = this.flushLanes.get(documentId) ?? Promise.resolve();
		const flush = prior.catch(() => undefined).then(() => this.cache.serializeDocument(documentId, async () => {
			const entries = this.cache.takePending(documentId);
			if (entries.length === 0) return;
			let published = 0;
			try {
				if (entries.some((entry) => !entry.actor || this.store.validateActor(entry.actor) !== "allowed")) {
					throw new Error("authority_superseded");
				}
				for (const batch of partitionDurableUpdateBatches(entries)) {
					const frozenKind = batch[0]?.kind;
					const frozenEpoch = batch[0]?.documentEpoch;
					if ((frozenKind !== "body" && frozenKind !== "semantic") || frozenEpoch === undefined
						|| batch.some((entry) => entry.kind !== frozenKind || entry.documentEpoch !== frozenEpoch)) {
						throw new Error("pending_admission_scope_invalid");
					}
					const update = batch.length === 1
						? batch[0]!.bytes
						: crdtEngine.mergeUpdates(batch.map((entry) => entry.bytes));
					if (update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
						throw new Error("merged pending update exceeds durable value limit");
					}
					const expectedHead = this.store.documentHead(documentId);
					if (!expectedHead || expectedHead.semanticEpoch !== frozenEpoch) throw new Error("document_head_changed");
					let expectedSemanticHead: SemanticCatalogHead | undefined;
					let catalog: CatalogMutation | undefined;
					let semanticCatalog: SemanticCatalogMutation | undefined;
					if (frozenKind === "semantic") {
						expectedSemanticHead = batch[0]!.semanticHead;
						if (!expectedSemanticHead || expectedSemanticHead.lifecycle !== "active"
							|| expectedSemanticHead.bodyEpoch !== frozenEpoch
							|| batch.some((entry) => !entry.semanticHead
								|| !sameSemanticCatalogHead(entry.semanticHead, expectedSemanticHead!))
							|| !sameSemanticCatalogHead(
								this.store.semanticHeadAt(this.store.currentSequence(), documentId), expectedSemanticHead)) {
							throw new Error("semantic_catalog_head_changed");
						}
						semanticCatalog = await this.semanticCatalogForUpdate(expectedSemanticHead, batch, update);
					} else {
						if (!this.lifecycle.activeBodyHead(documentId)) throw new Error("body_not_active");
						catalog = await this.catalogForBatch(documentId, batch, update);
					}
					const commit = this.store.commitUpdate({ documentId, update,
						kind: frozenKind, expectedHead, catalog, semanticCatalog,
						...(expectedSemanticHead ? { expectedSemanticHead } : {}),
						actorAttributions: batch.map((entry) => ({ actor: entry.actor!, requestDigest: entry.digest })) });
					const changed = this.cache.applyStagedDurableUpdate(
						documentId, update, commit.generation, "durable-socket-flush",
					);
					if (changed) {
						for (const entry of batch) {
							this.sockets.broadcastCommittedSocketUpdate(documentId, entry.bytes, entry.socketId);
						}
					}
					if (semanticCatalog) {
						this.sockets.notifySemanticCommitted(documentId, commit.generation, commit.vaultSequence,
							{ lifecycle: semanticCatalog.lifecycle, contentHash: semanticCatalog.contentHash ?? null, size: semanticCatalog.size ?? null });
					} else if (documentId !== "root") {
						this.sockets.notifyBodyCommitted(documentId, commit.generation, commit.vaultSequence);
					}
					published += batch.length;
				}
				this.cache.completePendingPersistence(documentId);
				this.persistence.set(documentId, { status: "healthy", lastError: null, lastSuccessAt: Date.now(), failures: this.persistence.get(documentId)?.failures ?? 0 });
			} catch (error) {
				success = false;
				const reason = error instanceof Error ? error.message : String(error);
				const terminalFence = reason === "authority_superseded"
					|| reason === "document_head_changed"
					|| reason === "semantic_catalog_head_changed"
					|| reason === "body_not_active";
				if (reason === "authority_superseded") {
					this.sockets.closeAll("queued authority superseded");
					this.cache.clear();
				} else {
					try {
						this.cache.reloadFromDurable(documentId);
					} catch {
						// If even exceptional reconstruction is unavailable, discard every
						// resident view. The next socket admission must reconstruct from SQL.
						this.cache.clear();
					} finally {
						this.sockets.closeUndurableOrigins(documentId, entries.slice(published));
					}
				}
				if (terminalFence) return;
				const prior = this.persistence.get(documentId);
				this.persistence.set(documentId, { status: "degraded", lastError: reason,
					lastSuccessAt: prior?.lastSuccessAt ?? null, failures: (prior?.failures ?? 0) + 1 });
				await this.options.alarms.setAlarm(Date.now() + PERSIST_RETRY_MS);
			}
		}));
		this.flushLanes.set(documentId, flush);
		try {
			await flush;
		} finally {
			if (this.flushLanes.get(documentId) === flush) this.flushLanes.delete(documentId);
		}
		if (success) this.maintain(documentId);
		return success;
	}

	private async waitForFlushLanes(): Promise<void> {
		// A lane can be replaced by a follow-up flush while the current snapshot is
		// settling, so continue until no document owns persistence work.
		while (this.flushLanes.size > 0) await Promise.all([...this.flushLanes.values()]);
	}

	private async catalogForBatch(
		bodyId: string,
		batch: readonly PendingVaultUpdate[],
		update: Uint8Array,
	): Promise<CatalogMutation | undefined> {
		const current = this.lifecycle.activeBodyHead(bodyId);
		if (!current) return undefined;
		const final = batch.at(-1);
		if (final?.contentHash && Number.isSafeInteger(final.contentSize) && final.contentSize! >= 0) {
			return { bodyId, fileId: current.fileId, path: current.path, previousPath: null, lifecycle: "active",
				bodyGeneration: (this.store.documentHead(bodyId)?.generation ?? 0) + 1,
				contentHash: final.contentHash, size: final.contentSize! };
		}
		// Normal socket queues defer whole-document extraction and hashing to this
		// debounced boundary. Reconstructing from the current durable prefix keeps
		// metadata exact even when one queue splits into multiple commits.
		const release = this.cache.reserveFullStateOperation(bodyId, 2);
		try {
			const reconstructed = this.store.reconstructDocument(bodyId);
			try {
				crdtEngine.applyUpdate(reconstructed.doc, update, "flush-metadata");
				const content = canonicalMarkdownBytes(crdtEngine.readText(reconstructed.doc, "body"));
				return { bodyId, fileId: current.fileId, path: current.path, previousPath: null, lifecycle: "active",
					bodyGeneration: reconstructed.generation + 1, contentHash: await sha256Hex(content), size: content.byteLength };
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
		} finally { release(); }
	}

	private async semanticCatalogForUpdate(
		current: NonNullable<ReturnType<VaultStore["semanticHeadAt"]>>,
		batch: readonly PendingVaultUpdate[],
		update: Uint8Array,
	): Promise<SemanticCatalogMutation> {
		const final = batch.at(-1);
		if (final?.contentHash && Number.isSafeInteger(final.contentSize) && final.contentSize! >= 0) {
			return { documentId: current.documentId, fileId: current.fileId, kind: "canvas", format: "json-canvas",
				formatVersion: 1, path: current.path, previousPath: null, lifecycle: "active",
				documentGeneration: (this.store.documentHead(current.documentId)?.generation ?? 0) + 1,
				contentHash: final.contentHash, size: final.contentSize! };
		}
		// Normal socket queues defer Canvas content hashing to this debounced
		// boundary. Each partition reconstructs from its exact durable prefix.
		const durableHead = this.store.documentHead(current.documentId);
		const durableBytes = durableHead
			? this.store.documentEncodedHistoryBytes(current.documentId, durableHead.latestSequence)
			: 0;
		const knownBytes = durableBytes > Number.MAX_SAFE_INTEGER - update.byteLength
			? Number.MAX_SAFE_INTEGER : durableBytes + update.byteLength;
		const release = this.cache.reserveFullStateOperation(current.documentId, 2, knownBytes);
		try {
			const reconstructed = this.store.reconstructDocument(current.documentId);
			try {
				crdtEngine.applyUpdate(reconstructed.doc, update, "semantic-flush-metadata");
				const validation = await validateCanvasDocument(reconstructed.doc);
				if (validation.error !== null) throw new Error(validation.error);
				const content = validation.canonicalBytes;
				return { documentId: current.documentId, fileId: current.fileId, kind: "canvas", format: "json-canvas",
					formatVersion: 1, path: current.path, previousPath: null, lifecycle: "active",
					documentGeneration: reconstructed.generation + 1, contentHash: await sha256Hex(content), size: content.byteLength };
			} finally { crdtEngine.destroyDocument(reconstructed.doc); }
		} finally { release(); }
	}

	private maintain(documentId: string): void {
		try {
			// A few narrow unit fakes predate tail accounting; production VaultStore
			// always supplies the tail query.
			const tailStore = this.store as VaultStore & {
				documentJournalTailStats?: (id: string) => { entries: number; bytes: number };
			};
			const stats = typeof tailStore.documentJournalTailStats === "function"
				? tailStore.documentJournalTailStats(documentId)
				: this.store.documentJournalStats(documentId);
			if (!shouldCompactJournal(stats)) return;
			this.writeLiveCheckpoint(documentId);
			if (this.store.activePins().length > 0) return;
			const floor = Math.max(0, this.store.currentSequence() - FEED_RETAIN_SEQUENCES);
			if (floor > this.store.journalFloor()) this.store.advanceFeedFloor(floor);
		} catch (error) {
			console.warn("[yaos-vault] maintenance failed", error);
			this.options.execution.waitUntil(this.armAlarmEarliest(Date.now() + PERSIST_RETRY_MS)
				.catch((alarmError) => console.warn("[yaos-vault] maintenance retry alarm failed", alarmError)));
		}
	}

	private afterDurableCommit(observation: {
		documentId: string; ingressBytes: number; commitLatencyMs: number; vaultSequence: number; sequenceReset?: boolean;
	}): void {
		if (observation.sequenceReset) this.lastObservedCommitSequence = 0;
		if (observation.vaultSequence <= this.lastObservedCommitSequence) return;
		this.lastObservedCommitSequence = observation.vaultSequence;
		const task = Promise.resolve().then(async () => {
			this.maintain(observation.documentId);
			try {
				await this.semanticCompaction.recordCommit(
					observation.documentId, observation.ingressBytes, observation.commitLatencyMs,
				);
			} finally {
				const retryAt = this.semanticCompaction.nextRetryAt();
				if (retryAt !== null) await this.armAlarmEarliest(Math.max(Date.now(), retryAt));
			}
		}).catch((error: unknown) => console.warn("[yaos-vault] semantic compaction failed", error));
		this.options.execution.waitUntil(task);
	}

	private afterDocumentLoaded(documentId: string, encodedStateBytes: number): void {
		const task = Promise.resolve().then(async () => {
			this.maintain(documentId);
			try { await this.semanticCompaction.documentLoaded(documentId, encodedStateBytes); }
			finally {
				const retryAt = this.semanticCompaction.nextRetryAt();
				if (retryAt !== null) await this.armAlarmEarliest(Math.max(Date.now(), retryAt));
			}
		}).catch((error: unknown) => console.warn("[yaos-vault] post-load maintenance failed", error));
		this.options.execution.waitUntil(task);
	}

	private async armAlarmEarliest(scheduledTime: number): Promise<void> {
		const current = await this.options.alarms.getAlarm?.();
		if (current !== undefined && current !== null && current <= scheduledTime) return;
		await this.options.alarms.setAlarm(scheduledTime);
	}

	private writeLiveCheckpoint(documentId: string): void {
		const loaded = this.cache.get(documentId);
		const head = this.store.documentHead(documentId);
		if (!loaded || loaded.dirty || !head || loaded.generation !== head.generation) {
			const release = this.cache.reserveFullStateOperation(documentId, 3);
			try { this.store.writeCheckpoint(documentId); }
			finally { release(); }
			return;
		}
		const release = this.cache.reserveFullStateOperation(documentId, 2);
		try {
			this.store.writeCheckpointFromDocument(documentId, loaded.doc, {
				throughSequence: head.latestSequence,
				generation: head.generation,
				semanticEpoch: head.semanticEpoch,
			});
		} finally {
			release();
		}
	}

	private async flushLoadedDocuments(): Promise<void> {
		for (const documentId of Object.keys(this.cache.diagnostics().pending)) {
			if (!await this.flushDocument(documentId)) throw new Error(`persistence unavailable for ${documentId}`);
		}
	}

	private requireMetadata() {
		const metadata = this.store.vaultMetadata();
		if (!metadata) throw new Error("vault is not provisioned");
		return metadata;
	}
}

export interface CloudflareVaultEnvironment {
	YAOS_BUCKET?: R2Bucket;
	YAOS_RECOVERY_JOBS?: DurableObjectNamespace;
}

// Workers namespaces require the exported class type to carry the RPC brand.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- Workers RPC requires the exported class type to carry its brand.
export interface VaultSyncServer extends Rpc.DurableObjectBranded {}

/** Cloudflare Durable Object wrapper for the portable schema-8 vault runtime. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- Declaration merging preserves the Workers RPC brand on the Cloudflare wrapper.
export class VaultSyncServer implements DurableObject {
	private readonly runtime: VaultRuntime;

	constructor(state: DurableObjectState, env: CloudflareVaultEnvironment) {
		this.runtime = new VaultRuntime({
			storage: state.storage as VaultRuntimeStoragePort,
			sockets: new CloudflareSocketRegistry(state),
			alarms: new CloudflareAlarmPort(state.storage),
			execution: new CloudflareExecutionPort(state),
			objectStore: env.YAOS_BUCKET ? new CloudflareObjectStore(env.YAOS_BUCKET) : undefined,
			recoveryJobs: env.YAOS_RECOVERY_JOBS
				? new CloudflareActorCalls(env.YAOS_RECOVERY_JOBS)
				: undefined,
		});
	}

	fetch(request: Request): Promise<Response> {
		return this.runtime.fetch(request);
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		return this.runtime.webSocketMessage(socket, message);
	}

	webSocketClose(): void {
		this.runtime.webSocketClose();
	}

	webSocketError(socket: WebSocket): void {
		this.runtime.webSocketError(socket);
	}

	alarm(): Promise<void> {
		return this.runtime.alarm();
	}
}
