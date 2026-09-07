import * as Y from "yjs";
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
import { canonicalMarkdownBytes } from "./shared/markdownCodec";
import { blobKey } from "./vaultObjectStore";
import { VaultDocumentCache } from "./vaultDocumentCache";
import { VaultLifecycleService } from "./vaultLifecycleService";
import { VaultSocketService, type VaultSocketPort, type VaultSocketRegistryPort, hasSafeRootAttachmentSemantics, rootUpdateChangesProtectedAttachmentMaps, rootUpdateHasSafeAttachmentSemantics } from "./vaultSocketService";
import { VaultStore, type CatalogMutation } from "./vaultStore";
import { isCanonicalVaultId } from "./vaultId";
import { VaultRecoveryService } from "./vaultRecoveryService";
import { authorizeRuntimeActor, OUTCOME_CLAIM_HEADER, parseVaultActor } from "./vaultAuthority";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext, type VaultCapability } from "./collaboration";
import { canonicalJsonHash } from "./recoveryCanonicalJson";
import type { VaultAuthoritySubjectChange } from "./vaultDocumentStore";

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

export function createVaultDocument(guid?: string): Y.Doc {
	return new Y.Doc(guid ? { guid } : undefined);
}

export function applyVaultUpdate(doc: Y.Doc, update: Uint8Array): void {
	Y.applyUpdate(doc, update);
}

export function encodeVaultState(doc: Y.Doc): Uint8Array {
	return Y.encodeStateAsUpdate(doc);
}

export interface RootPathPublication {
	sourcePath: string | null;
	resultPath: string;
	fileId: string;
	lifecycle: "active" | "tombstoned";
}

export function encodeRootPathPublicationUpdate(rootState: Uint8Array, operations: RootPathPublication[]): Uint8Array {
	const doc = new Y.Doc({ guid: "root-publication" });
	try {
		Y.applyUpdate(doc, rootState);
		const paths = doc.getMap<string>("pathToId");
		for (const operation of operations) if (operation.sourcePath) paths.delete(operation.sourcePath);
		for (const operation of operations) if (operation.lifecycle === "active") paths.set(operation.resultPath, operation.fileId);
		return Y.encodeStateAsUpdate(doc);
	} finally {
		doc.destroy();
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

/** Schema-6 root/body composition, independent of a worker or process host. */
export class VaultRuntime implements DrainPort {
	private store: VaultStore;
	private settings: SettingsSyncStore;
	private readonly runtimeEpoch = crypto.randomUUID();
	private readonly cache: VaultDocumentCache;
	private readonly sockets: VaultSocketService;
	private readonly lifecycle: VaultLifecycleService;
	private readonly candidates: VaultCandidateService;
	private readonly bootstrap: BootstrapService;
	private readonly recovery: VaultRecoveryService;
	private readonly persistence = new Map<string, PersistenceStatus>();
	private readonly scheduledFlushes = new Map<string, Promise<void>>();
	private flushChain: Promise<void> = Promise.resolve();
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
			() => new Set(this.store.activePins().flatMap(() => this.store.listActiveCatalogAt(this.store.currentSequence()).map((entry) => entry.bodyId))),
		);
		const vaultId = () => this.requireMetadata().vaultId;
		const vaultGeneration = () => this.requireMetadata().vaultGeneration;
		socketOwner = new VaultSocketService({
			sockets: options.sockets,
			cache: this.cache,
			vaultId,
			vaultGeneration,
			runtimeEpoch: this.runtimeEpoch,
			isActiveBody: (bodyId) => this.lifecycle?.activeBodyHead(bodyId) !== null,
			currentBodyHead: (bodyId) => {
				const head = this.store.getCatalogHeadAt(this.store.currentSequence(), bodyId);
				return head ? {
					bodyId: head.bodyId,
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
		});
		this.sockets = socketOwner;
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
		});
		this.bootstrap = new BootstrapService(this.store);
		this.recovery = new VaultRecoveryService({
			alarms: options.alarms,
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
			if (request.method === "POST" && url.pathname === "/__yaos/collaboration-migrate") {
				return await this.migrateCollaboration(vaultId, request);
			}
			const metadata = this.store.vaultMetadata();
			if (!metadata) {
				const storedSchemaVersion = this.store.storedVaultSchemaVersion();
				return storedSchemaVersion === 6
					? json({ error: "collaboration_migration_required", storedSchemaVersion, requiredSchemaVersion: SERVER_SCHEMA_VERSION }, 409)
					: json({ error: "vault_not_provisioned" }, 409);
			}
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
				if (url.pathname === "/ws/root") return this.sockets.accept("root", "root", authorized);
				if (parts.length === 3 && parts[0] === "ws" && parts[1] === "body") {
					const bodyId = parts[2]!;
					if (!this.lifecycle.activeBodyHead(bodyId)) return json({ error: "body_not_active" }, 409);
					return this.sockets.accept(bodyId, "body", authorized);
				}
			}
			if (request.method === "POST" && parts.length === 3 && parts[0] === "body" && parts[2] === "candidate") {
				const authorized = this.authorize(actor, "vault.content.write");
				return authorized instanceof Response ? authorized : this.candidates.handle(parts[1]!, request, authorized);
			}
			if (request.method === "POST" && url.pathname === "/attachments/publish") {
				const authorized = this.authorize(actor, "vault.attachments.write");
				return authorized instanceof Response ? authorized : this.lifecycle.publishAttachment(request, authorized);
			}
			if (request.method === "POST" && url.pathname.startsWith("/lifecycle")) {
				const authorized = this.authorize(actor, "vault.lifecycle.write");
				if (authorized instanceof Response) return authorized;
				if (url.pathname === "/lifecycle") return this.lifecycle.handle(request, authorized);
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

	private async migrateCollaboration(vaultId: string, request: Request): Promise<Response> {
		let input: {
			migrationId?: unknown;
			vaultGeneration?: unknown;
			requestDigest?: unknown;
			subjectDigest?: unknown;
			ownerPrincipalId?: unknown;
			subjects?: unknown;
		};
		try { input = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		if (typeof input.migrationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.migrationId)
			|| typeof input.vaultGeneration !== "string"
			|| typeof input.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.requestDigest)
			|| typeof input.subjectDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.subjectDigest)
			|| typeof input.ownerPrincipalId !== "string"
			|| !Array.isArray(input.subjects) || input.subjects.length === 0 || input.subjects.length > 8_192) {
			return json({ error: "invalid_collaboration_migration" }, 400);
		}
		const sourceDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify(input.subjects)));
		if (sourceDigest !== input.subjectDigest) {
			return json({ error: "authorization_subject_digest_mismatch" }, 409);
		}
		const subjects: VaultAuthoritySubjectChange[] = [];
		for (const value of input.subjects) {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				return json({ error: "invalid_authorization_subject" }, 400);
			}
			const subject = value as Record<string, unknown>;
			if (subject.kind === "device") {
				if (typeof subject.deviceId !== "string" || typeof subject.principalId !== "string"
					|| subject.targetState !== "active" || !Number.isSafeInteger(subject.targetRevision)
					|| (subject.targetRevision as number) < 1) {
					return json({ error: "invalid_device_authority" }, 400);
				}
				subjects.push({ deviceId: subject.deviceId, principalId: subject.principalId,
					state: "active", credentialRevision: subject.targetRevision as number });
			} else if (subject.kind === "membership") {
				if (typeof subject.principalId !== "string"
					|| (subject.targetRole !== "owner" && subject.targetRole !== "member")
					|| subject.targetState !== "active" || !Number.isSafeInteger(subject.targetRevision)
					|| (subject.targetRevision as number) < 1
					|| typeof subject.displayName !== "string" || typeof subject.colorSeed !== "string") {
					return json({ error: "invalid_principal_authority" }, 400);
				}
				const capabilityDigest = await capabilityDigestForRole(subject.targetRole);
				subjects.push({ principalId: subject.principalId, role: subject.targetRole,
					state: "active", membershipRevision: subject.targetRevision as number,
					policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest,
					displayName: subject.displayName, colorSeed: subject.colorSeed });
			} else {
				return json({ error: "invalid_authorization_subject" }, 400);
			}
		}
		try {
			this.sockets.closeAll("vault collaboration migration");
			await this.flushLoadedDocuments();
			const receipt = this.store.migrateCollaboration({
				migrationId: input.migrationId,
				vaultId,
				vaultGeneration: input.vaultGeneration,
				requestDigest: input.requestDigest,
				subjectDigest: input.subjectDigest,
				ownerPrincipalId: input.ownerPrincipalId,
				subjects,
			});
			this.cache.clear();
			this.persistence.clear();
			return json({ ...receipt, runtimeEpoch: this.runtimeEpoch });
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "collaboration_migration_failed" }, 409);
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
				await this.flushChain;
			})();
		}
		return this.drainPromise;
	}

	async alarm(): Promise<void> {
		for (const documentId of Object.keys(this.cache.diagnostics().pending)) await this.flushDocument(documentId);
		this.store.reapExpiredRecoveryCaptures(Date.now(), 25);
		this.store.reapExpiredRestoreAuthorities(Date.now(), 25);
		const gc = this.store.latestGcEpoch();
		if (gc && (gc.state === "marking" || gc.state === "sweeping") && gc.deadlineAt <= Date.now()) {
			this.store.advanceGcEpoch(gc.epoch, "aborted");
		}
		if (this.store.activeRecoveryCapture() || this.store.activeRestoreAuthority()
			|| gc?.state === "marking" || gc?.state === "sweeping") {
			await this.options.alarms.setAlarm(Date.now() + 60_000);
		}
	}

	private async provision(vaultId: string, request: Request): Promise<Response> {
		let body: { vaultGeneration?: unknown };
		try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		if (!isCanonicalVaultId(body.vaultGeneration)) return json({ error: "invalid_vault_generation" }, 400);
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", SERVER_SCHEMA_VERSION);
		root.getMap("sys").set("protocolVersion", SERVER_PROTOCOL_VERSION);
		const result = this.store.provisionVault(vaultId, body.vaultGeneration, Y.encodeStateAsUpdate(root));
		root.destroy();
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
		await this.flushChain;
		this.cache.clear();
		this.persistence.clear();
		await this.options.alarms.deleteAlarm();
		await this.options.storage.deleteAll();
		this.store = new VaultStore(this.options.storage);
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
		const requestedBodyIds = new Set<string>();
		let reconstructedBodies = 0;
		for (const item of requestedBodies) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				return json({ error: "invalid_catch_up_batch" }, 400);
			}
			const bodyId = "bodyId" in item && typeof item.bodyId === "string" ? item.bodyId : "";
			if (!bodyId || bodyId.length > MAX_BODY_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(bodyId)
				|| requestedBodyIds.has(bodyId)
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
			const knownContentHash = "contentHash" in item && typeof item.contentHash === "string"
				? item.contentHash
				: null;
			const metadata = {
				bodyId,
				fileId: head.fileId,
				path: head.path,
				previousPath: head.previousPath,
				lifecycle: head.lifecycle,
				generation: head.generation,
				contentHash: head.contentHash,
				size: head.size,
			};
			if (knownGeneration === head.generation
				&& (knownContentHash === null || knownContentHash === head.contentHash)) {
				bodies.push({ ...metadata, status: 304 });
				continue;
			}
			let reconstructedThisBody = false;
			try {
				const reconstructed = this.store.reconstructDocument(bodyId);
				const update = Y.encodeStateAsUpdate(reconstructed.doc);
				reconstructed.doc.destroy();
				bodies.push({ ...metadata, status: 200, generation: reconstructed.generation, update });
				reconstructedBodies++;
				reconstructedThisBody = true;
			} catch { bodies.push({ bodyId, status: 500, error: "body_state_corrupt" }); }
			if (reconstructedThisBody && reconstructedBodies % CATCH_UP_YIELD_INTERVAL === 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		let response: Uint8Array;
		try { response = encodeBinaryEnvelope({ bodies, highWater: this.store.currentSequence() }, MAX_CATCH_UP_BYTES); }
		catch { return json({ error: "catch_up_response_too_large" }, 413); }
		return new Response(response.slice().buffer, { headers: { "content-type": YAOS_BINARY_CONTENT_TYPE, "cache-control": "no-store" } });
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
			return new Response(state.encodedState.slice().buffer, { headers: { "content-type": "application/octet-stream", "x-yaos-sha256": await state.hash } });
		}
		if (request.method === "GET" && parts.length === 3 && parts[2] === "catalog") return json(this.bootstrap.catalogPage(bootstrapId, url.searchParams.get("cursor"), boundedLimit(url)));
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
			const bodies = bodyIds.map((bodyId) => {
				const state = this.bootstrap.bodyState(bootstrapId, bodyId);
				return {
					bodyId,
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
		}
		if (request.method === "GET" && parts.length === 4 && parts[2] === "body") {
			const state = this.bootstrap.bodyState(bootstrapId, parts[3]!);
			const head = this.store.getCatalogHeadAt(state.throughSequence, state.bodyId);
			return new Response(state.encodedState.slice().buffer, { headers: { "content-type": "application/octet-stream", "x-yaos-body-id": state.bodyId,
				"x-yaos-generation": String(state.generation), "x-yaos-through-sequence": String(state.throughSequence),
				"x-yaos-content-hash": head?.contentHash ?? "", "x-yaos-size": String(head?.size ?? 0) } });
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
		const reconstructed = this.store.reconstructDocument(bodyId);
		const bytes = Y.encodeStateAsUpdate(reconstructed.doc);
		const content = canonicalMarkdownBytes(Y.Text.prototype.toString.call(reconstructed.doc.getText("body")));
		reconstructed.doc.destroy();
		return new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store",
			"x-yaos-body-id": bodyId, "x-yaos-generation": String(reconstructed.generation), "x-yaos-content-hash": await sha256Hex(content), "x-yaos-size": String(content.byteLength) } });
	}

	private rootState(url: URL): Response {
		const current = this.store.currentSequence();
		const through = Number(url.searchParams.get("through") ?? current);
		if (!Number.isInteger(through) || through < 0 || through > current) return json({ error: "invalid_root_sequence" }, 400);
		const reconstructed = this.store.reconstructDocument("root", through);
		const bytes = Y.encodeStateAsUpdate(reconstructed.doc);
		reconstructed.doc.destroy();
		return new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store",
			"x-yaos-generation": String(reconstructed.generation), "x-yaos-through-sequence": String(through) } });
	}

	private async compact(): Promise<Response> {
		await this.flushLoadedDocuments();
		const documentIds = new Set<string>(["root"]);
		for (const entry of this.store.listActiveCatalogAt(this.store.currentSequence())) {
			documentIds.add(entry.bodyId);
		}
		let written = 0;
		for (const documentId of documentIds) {
			this.store.writeCheckpoint(documentId);
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
		return json({ vaultId: metadata.vaultId, vaultGeneration: metadata.vaultGeneration, runtimeEpoch: this.runtimeEpoch,
			provisionedAt: metadata.provisionedAt, schemaVersion: SERVER_SCHEMA_VERSION,
			storageFormatVersion: SERVER_STORAGE_FORMAT_VERSION, protocolVersion: SERVER_PROTOCOL_VERSION,
			snapshotFormatVersion: SERVER_SNAPSHOT_FORMAT_VERSION,
			settingsFormatVersion: SERVER_SETTINGS_FORMAT_VERSION,
			sequence: this.store.currentSequence(), feedFloor: this.store.journalFloor(), activePins: this.store.activePins().length });
	}

	private health(): Response {
		const diagnostics = this.cache.diagnostics();
		const degraded = [...this.persistence.values()].filter((value) => value.status === "degraded").length;
		const ok = degraded === 0 && Object.keys(diagnostics.loadFailures).length === 0;
		return json({ ok, persistence: degraded === 0 ? "healthy" : "degraded", degradedDocuments: degraded,
			corruptDocuments: Object.keys(diagnostics.loadFailures).length, pendingUpdates: Object.values(diagnostics.pending).reduce((sum, value) => sum + value, 0) }, ok ? 200 : 503);
	}

	private diagnostics(): Response {
		return json({ ...this.statusObject(), sockets: this.options.sockets.sockets().length, ...this.cache.diagnostics(), persistence: Object.fromEntries(this.persistence) });
	}

	private statusObject() {
		const metadata = this.requireMetadata();
		return { vaultId: metadata.vaultId, vaultGeneration: metadata.vaultGeneration, runtimeEpoch: this.runtimeEpoch,
			provisionedAt: metadata.provisionedAt, schemaVersion: SERVER_SCHEMA_VERSION,
			storageFormatVersion: SERVER_STORAGE_FORMAT_VERSION, protocolVersion: SERVER_PROTOCOL_VERSION,
			snapshotFormatVersion: SERVER_SNAPSHOT_FORMAT_VERSION,
			settingsFormatVersion: SERVER_SETTINGS_FORMAT_VERSION,
			sequence: this.store.currentSequence(), feedFloor: this.store.journalFloor() };
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
		this.flushChain = this.flushChain.then(async () => {
			const entries = this.cache.takePending(documentId);
			if (entries.length === 0) return;
			let processed = 0;
			try {
				if (entries.some((entry) => !entry.actor || this.store.validateActor(entry.actor) !== "allowed")) {
					throw new Error("authority_superseded");
				}
				for (const batch of partitionDurableUpdateBatches(entries)) {
					const update = batch.length === 1
						? batch[0]!.bytes
						: Y.mergeUpdates(batch.map((entry) => entry.bytes));
					if (update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
						throw new Error("merged pending update exceeds durable value limit");
					}
					const catalog = documentId === "root" ? undefined : await this.catalogForUpdate(documentId, update);
					const commit = this.store.commitUpdate({ documentId, update, kind: documentId === "root" ? "root" : "body", catalog,
						actorAttributions: batch.map((entry) => ({ actor: entry.actor!, requestDigest: entry.digest })) });
					processed += batch.length;
					const loaded = this.cache.get(documentId);
					if (loaded) loaded.generation = commit.generation;
					if (documentId !== "root") {
						this.sockets.notifyBodyCommitted(documentId, commit.generation, commit.vaultSequence);
					}
				}
				this.persistence.set(documentId, { status: "healthy", lastError: null, lastSuccessAt: Date.now(), failures: this.persistence.get(documentId)?.failures ?? 0 });
			} catch (error) {
				success = false;
				if (error instanceof Error && error.message === "authority_superseded") {
					processed = entries.length;
					this.sockets.closeAll("queued authority superseded");
					this.cache.clear();
				} else {
					this.cache.restorePending(documentId, entries.slice(processed));
				}
				const prior = this.persistence.get(documentId);
				this.persistence.set(documentId, { status: "degraded", lastError: error instanceof Error ? error.message : String(error),
					lastSuccessAt: prior?.lastSuccessAt ?? null, failures: (prior?.failures ?? 0) + 1 });
				await this.options.alarms.setAlarm(Date.now() + PERSIST_RETRY_MS);
			}
		});
		await this.flushChain;
		if (success) this.maintain(documentId);
		return success;
	}

	private async catalogForUpdate(bodyId: string, update: Uint8Array): Promise<CatalogMutation | undefined> {
		const current = this.lifecycle.activeBodyHead(bodyId);
		if (!current) return undefined;
		const reconstructed = this.store.reconstructDocument(bodyId);
		try {
			Y.applyUpdate(reconstructed.doc, update, "flush-metadata");
			const content = canonicalMarkdownBytes(Y.Text.prototype.toString.call(reconstructed.doc.getText("body")));
			return { bodyId, fileId: current.fileId, path: current.path, previousPath: null, lifecycle: "active",
				bodyGeneration: reconstructed.generation + 1, contentHash: await sha256Hex(content), size: content.byteLength };
		} finally {
			reconstructed.doc.destroy();
		}
	}

	private maintain(documentId: string): void {
		try {
			if (!shouldCompactJournal(this.store.documentJournalStats(documentId))) return;
			this.store.writeCheckpoint(documentId);
			if (this.store.activePins().length > 0) return;
			const floor = Math.max(0, this.store.currentSequence() - FEED_RETAIN_SEQUENCES);
			if (floor > this.store.journalFloor()) this.store.advanceFeedFloor(floor);
		} catch (error) {
			console.warn("[yaos-vault] maintenance failed", error);
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

/** Cloudflare Durable Object wrapper for the portable schema-6 vault runtime. */
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
