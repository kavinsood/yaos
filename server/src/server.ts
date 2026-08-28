import * as Y from "yjs";
import { bytesToBase64Url } from "./base64url";
import { BootstrapService } from "./bootstrap";
import { MAX_BODY_ID_LENGTH, MAX_CATCH_UP_BODIES, MAX_CATCH_UP_BYTES, MAX_JSON_BYTES } from "./contracts";
import { sha256Hex } from "./hex";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import { handleVaultRecoveryRpc } from "./recoveryRpcRouter";
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
import { blobKey } from "./vaultObjectStore";
import { VaultDocumentCache } from "./vaultDocumentCache";
import { VaultLifecycleService } from "./vaultLifecycleService";
import { VaultSocketService, type VaultSocketPort, type VaultSocketRegistryPort, hasSafeRootAttachmentSemantics, rootUpdateChangesProtectedAttachmentMaps, rootUpdateHasSafeAttachmentSemantics } from "./vaultSocketService";
import { VaultStore, type CatalogMutation } from "./vaultStore";
import { isCanonicalVaultId } from "./vaultId";
import { VaultRecoveryService } from "./vaultRecoveryService";

const PERSIST_DEBOUNCE_MS = 250;
const PERSIST_RETRY_MS = 1_000;
const JOURNAL_COMPACT_ENTRIES = 50;
const JOURNAL_COMPACT_BYTES = 1024 * 1024;
const FEED_RETAIN_SEQUENCES = 1000;
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

/** Schema-4 root/body composition, independent of a worker or process host. */
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
			isDeviceRevoked: (deviceId) => this.store.isDeviceRevoked(deviceId),
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
			const metadata = this.store.vaultMetadata();
			if (!metadata) return json({ error: "vault_not_provisioned" }, 409);
			if (metadata.vaultId !== vaultId) return json({ error: "vault_identity_mismatch" }, 409);
			const forwardedGeneration = request.headers.get(INTERNAL_GENERATION_HEADER);
			if (forwardedGeneration !== metadata.vaultGeneration) {
				return json({ error: "vault_generation_mismatch" }, 409);
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
			if (parts[0] === "settings-sync") {
				if (parts.length < 2 || parts.length > 3) return json({ error: "not_found" }, 404);
				const deviceId = request.headers.get(INTERNAL_DEVICE_HEADER);
				if (!deviceId || deviceId.length > 128) return json({ error: "missing_trusted_device_identity" }, 401);
				if (this.store.isDeviceRevoked(deviceId)) return json({ error: "unauthorized" }, 401);
				return handleSettingsSyncRequest(this.settings, request, parts[1]!, parts[2]);
			}
			if (request.method === "POST" && url.pathname === "/compact") return this.compact();

			if (request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const deviceId = request.headers.get(INTERNAL_DEVICE_HEADER);
				if (!deviceId) return json({ error: "missing_trusted_device_identity" }, 401);
				if (url.pathname === "/ws/root") return this.sockets.accept("root", "root", deviceId);
				if (parts.length === 3 && parts[0] === "ws" && parts[1] === "body") {
					const bodyId = parts[2]!;
					if (!this.lifecycle.activeBodyHead(bodyId)) return json({ error: "body_not_active" }, 409);
					return this.sockets.accept(bodyId, "body", deviceId);
				}
			}
			if (request.method === "POST" && parts.length === 3 && parts[0] === "body" && parts[2] === "candidate") {
				return this.candidates.handle(parts[1]!, request);
			}
			if (request.method === "POST" && url.pathname === "/attachments/publish") {
				return this.lifecycle.publishAttachment(request);
			}
			if (request.method === "POST" && url.pathname === "/lifecycle") return this.lifecycle.handle(request);
			if (request.method === "POST" && url.pathname === "/lifecycle/batch") return this.lifecycle.handleBatch(request);
			if (request.method === "POST" && url.pathname === "/lifecycle/publish") return this.lifecycle.publish(request);
			if (request.method === "POST" && url.pathname === "/catch-up") return this.catchUp(request);
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
		for (const item of requestedBodies) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				return json({ error: "invalid_catch_up_batch" }, 400);
			}
			const bodyId = "bodyId" in item && typeof item.bodyId === "string" ? item.bodyId : "";
			const head = this.lifecycle.activeBodyHead(bodyId);
			if (!head) { bodies.push({ bodyId, status: 409, error: "body_not_active" }); continue; }
			try {
				const reconstructed = this.store.reconstructDocument(bodyId);
				const update = Y.encodeStateAsUpdate(reconstructed.doc);
				reconstructed.doc.destroy();
				bodies.push({ bodyId, status: 200, generation: reconstructed.generation, contentHash: head.contentHash,
					size: head.size, update: bytesToBase64Url(update) });
			} catch { bodies.push({ bodyId, status: 500, error: "body_state_corrupt" }); }
		}
		const response = JSON.stringify({ bodies, highWater: this.store.currentSequence() });
		if (new TextEncoder().encode(response).byteLength > MAX_CATCH_UP_BYTES) return json({ error: "catch_up_response_too_large" }, 413);
		return new Response(response, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
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
					encodedState: bytesToBase64Url(state.encodedState),
				};
			});
			const response = JSON.stringify({ bodies });
			if (new TextEncoder().encode(response).byteLength > MAX_CATCH_UP_BYTES) {
				return json({ error: "bootstrap_response_too_large" }, 413);
			}
			return new Response(response, {
				headers: { "content-type": "application/json", "cache-control": "no-store" },
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
		const content = new TextEncoder().encode(Y.Text.prototype.toString.call(reconstructed.doc.getText("body")));
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
		let blockedByPin = 0;
		for (const documentId of documentIds) {
			const result = this.store.writeCheckpoint(documentId);
			if (result.status === "written") written++;
			else blockedByPin++;
		}
		if (blockedByPin === 0 && this.store.activePins().length === 0) {
			const floor = Math.max(0, this.store.currentSequence() - FEED_RETAIN_SEQUENCES);
			if (floor > this.store.journalFloor()) this.store.advanceFeedFloor(floor);
		}
		return json({
			ok: true,
			documents: documentIds.size,
			checkpointsWritten: written,
			blockedByPin,
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
			.finally(() => this.scheduledFlushes.delete(documentId));
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
				for (const entry of entries) {
					const catalog = documentId === "root" ? undefined : await this.catalogForLoadedBody(documentId);
					const commit = this.store.commitUpdate({ documentId, update: entry.bytes, kind: documentId === "root" ? "root" : "body", catalog });
					processed++;
					const loaded = this.cache.get(documentId);
					if (loaded) loaded.generation = commit.generation;
					if (documentId !== "root") this.sockets.notifyBodyCommitted(documentId, commit.generation);
				}
				this.persistence.set(documentId, { status: "healthy", lastError: null, lastSuccessAt: Date.now(), failures: this.persistence.get(documentId)?.failures ?? 0 });
			} catch (error) {
				success = false;
				this.cache.restorePending(documentId, entries.slice(processed));
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

	private async catalogForLoadedBody(bodyId: string): Promise<CatalogMutation | undefined> {
		const loaded = this.cache.get(bodyId);
		const current = this.lifecycle.activeBodyHead(bodyId);
		if (!loaded || !current) return undefined;
		const content = new TextEncoder().encode(Y.Text.prototype.toString.call(loaded.doc.getText("body")));
		return { bodyId, fileId: current.fileId, path: current.path, previousPath: null, lifecycle: "active",
			bodyGeneration: (this.store.documentHead(bodyId)?.generation ?? 0) + 1, contentHash: await sha256Hex(content), size: content.byteLength };
	}

	private maintain(documentId: string): void {
		try {
			if (!shouldCompactJournal(this.store.documentJournalStats(documentId))) return;
			const checkpoint = this.store.writeCheckpoint(documentId);
			if (checkpoint.status !== "written" || this.store.activePins().length > 0) return;
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

/** Cloudflare Durable Object wrapper for the portable schema-4 vault runtime. */
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
