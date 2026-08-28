import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";

const browserWindow = globalThis.window;
for (const method of ["addEventListener", "removeEventListener"] as const) {
	if (typeof browserWindow[method] !== "function") {
		Object.defineProperty(browserWindow, method, { value: () => undefined, configurable: true });
	}
}

const SCHEMA_VERSION = 4;
const PROTOCOL_VERSION = 1;
const NETWORK_WAIT_MS = 15_000;
function fetchBounded(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
	return globalThis.fetch(input, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(NETWORK_WAIT_MS),
	});
}


export interface Identity {
	readonly host: string;
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly deviceId: string;
	readonly deviceToken: string;
	readonly deviceName: string;
	readonly originImport: boolean;
}

export interface ClaimedServer {
	readonly host: string;
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly pairingCode: string;
	readonly operatorRecoveryKey: string;
	readonly operatorCookie: string;
}

interface LifecycleRequest {
	readonly operationId: string;
	readonly kind: "create" | "delete" | "revive" | "rename";
	readonly fileId: string;
	readonly bodyId: string;
	readonly path?: string;
	readonly fromPath?: string;
	readonly toPath?: string;
	readonly candidateId?: string;
	readonly candidateDigest?: string;
}

interface LifecycleReceipt {
	readonly vaultId: string;
	readonly vaultGeneration: string;
	readonly bodyId: string;
	readonly fileId: string;
	readonly operationId: string;
	readonly kind: LifecycleRequest["kind"];
	readonly lifecycle: "active" | "tombstoned";
	readonly path: string;
	readonly durableGeneration: number;
	readonly vaultSequence: number;
	readonly runtimeEpoch: string;
}

interface CatalogEntry {
	readonly bodyId: string;
	readonly fileId: string;
	readonly path: string;
	readonly lifecycle: "active";
	readonly contentHash: string | null;
	readonly size: number | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
	return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
	return value;
}

function integerField(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
	return value;
}

async function json(response: Response, label: string): Promise<Record<string, unknown>> {
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) throw new Error(`${label} failed (${response.status}): ${JSON.stringify(body)}`);
	return record(body, `${label} response`);
}

function cookieOf(response: Response): string {
	const setCookie = response.headers.get("set-cookie");
	if (!setCookie) throw new Error("server did not establish an operator session");
	return setCookie.split(";", 1)[0] ?? "";
}

export async function claimServer(host: string): Promise<ClaimedServer> {
	const operatorRecoveryKey = randomBytes(32).toString("base64url");
	const response = await fetchBounded(`${host}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	const body = await json(response, "claim");
	if (body.host !== host) throw new Error(`claim returned wrong host ${JSON.stringify(body.host)}`);
	const operatorCookie = cookieOf(response);
	const vaultId = stringField(body.vaultId, "claim vaultId");
	const state = await json(await fetchBounded(`${host}/operator/state`, {
		headers: { Cookie: operatorCookie },
	}), "operator state after claim");
	const vault = Array.isArray(state.vaults)
		? state.vaults.map((value) => record(value, "operator vault")).find((value) => value.vaultId === vaultId)
		: undefined;
	if (!vault) throw new Error("claimed vault is absent from operator state");
	const claimed = {
		host,
		vaultId,
		vaultGeneration: stringField(vault.vaultGeneration, "claim vaultGeneration"),
		pairingCode: stringField(body.pairingCode, "claim pairingCode"),
		operatorRecoveryKey,
		operatorCookie,
	};
	const capabilities = await fetchBounded(`${host}/api/capabilities`).then((result) => json(result, "capabilities"));
	if (capabilities.claimed !== true || capabilities.schemaVersion !== 4 || capabilities.protocolVersion !== 1) {
		throw new Error(`claimed Worker has the wrong public contract: ${JSON.stringify(capabilities)}`);
	}
	return claimed;
}


export async function operatorState(server: ClaimedServer): Promise<Record<string, unknown>> {
	return json(await fetchBounded(`${server.host}/operator/state`, { headers: { Cookie: server.operatorCookie } }), "operator state");
}

export async function mintPairingCode(server: ClaimedServer): Promise<string> {
	const body = await json(await fetchBounded(`${server.host}/operator/pairing-codes`, {
		method: "POST",
		headers: { Cookie: server.operatorCookie, "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId: server.vaultId, purpose: "device" }),
	}), "pairing code");
	return stringField(body.pairingCode, "pairingCode");
}

export async function enrollPublic(host: string, pairingCode: string, deviceName: string): Promise<Identity> {
	const deviceId = randomBytes(18).toString("base64url");
	const deviceToken = randomBytes(36).toString("base64url");
	const enrollmentRequestId = randomBytes(18).toString("base64url");
	const response = await fetchBounded(`${host}/enroll`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingCode, enrollmentRequestId, deviceId, deviceToken, deviceName }),
	});
	const body = await json(response, `enroll ${deviceName}`);
	if (body.host !== host || body.deviceId !== deviceId || body.deviceToken !== deviceToken || body.deviceName !== deviceName) {
		throw new Error(`enrollment did not preserve the public identity: ${JSON.stringify(body)}`);
	}
	return {
		host,
		vaultId: stringField(body.vaultId, "enrollment vaultId"),
		vaultGeneration: stringField(body.vaultGeneration, "enrollment vaultGeneration"),
		deviceId,
		deviceToken,
		deviceName,
		originImport: body.originImport === true,
	};
}

export async function revokeDevice(server: ClaimedServer, deviceId: string): Promise<void> {
	await json(await fetchBounded(`${server.host}/operator/devices/${encodeURIComponent(deviceId)}`, {
		method: "DELETE",
		headers: { Cookie: server.operatorCookie },
	}), "device revocation");
}

function headers(identity: Identity, extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${identity.deviceToken}`, ...extra };
}

function route(identity: Identity, suffix: string): string {
	return `${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/${suffix.replace(/^\//, "")}`;
}

async function socketTicket(identity: Identity): Promise<string> {
	const body = await json(await fetchBounded(route(identity, "auth/ticket"), { method: "POST", headers: headers(identity) }), "socket ticket");
	const ticket = stringField(body.ticket, "socket ticket");
	const expiresAt = integerField(body.expiresAt, "socket ticket expiresAt");
	const ttlMs = integerField(body.ttlMs, "socket ticket ttlMs");
	if (ttlMs <= 0 || expiresAt <= Date.now()) throw new Error("socket ticket is already expired");
	return ticket;
}

async function connectDocument(identity: Identity, kind: "root" | "body", documentId: string): Promise<{ doc: Y.Doc; provider: YSyncProvider }> {
	const doc = new Y.Doc({ guid: documentId });
	const prefix = kind === "root"
		? `/vault/${encodeURIComponent(identity.vaultId)}/ws/root`
		: `/vault/${encodeURIComponent(identity.vaultId)}/ws/body/${encodeURIComponent(documentId)}`;
	const provider = new YSyncProvider(identity.host, documentId, doc, {
		prefix,
		params: async () => ({
			ticket: await socketTicket(identity),
			schemaVersion: String(SCHEMA_VERSION),
			protocolVersion: String(PROTOCOL_VERSION),
		}),
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			error ? reject(error) : resolve();
		};
		const timer = setTimeout(() => finish(new Error(`${kind}/${documentId} WebSocket sync timed out`)), NETWORK_WAIT_MS);
		provider.on("sync", (synced: boolean) => { if (synced) finish(); });
		provider.on("connection-error", (event: unknown) => finish(new Error(`${kind}/${documentId} connection failed: ${String(event)}`)));
		void provider.connect().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
	});
	return { doc, provider };
}
function destroyDocument(connection: { doc: Y.Doc; provider: YSyncProvider }): void {
	const socket = connection.provider.ws;
	if (socket instanceof WebSocket) socket.terminate();
	connection.provider.destroy();
	connection.doc.destroy();
}


function parseReceipt(value: unknown): LifecycleReceipt {
	const body = record(value, "lifecycle receipt");
	if (body.kind !== "create" && body.kind !== "delete" && body.kind !== "revive" && body.kind !== "rename") throw new Error("invalid lifecycle kind");
	if (body.lifecycle !== "active" && body.lifecycle !== "tombstoned") throw new Error("invalid lifecycle state");
	return {
		vaultId: stringField(body.vaultId, "receipt vaultId"),
		vaultGeneration: stringField(body.vaultGeneration, "receipt vaultGeneration"),
		bodyId: stringField(body.bodyId, "receipt bodyId"),
		fileId: stringField(body.fileId, "receipt fileId"),
		operationId: stringField(body.operationId, "receipt operationId"),
		kind: body.kind,
		lifecycle: body.lifecycle,
		path: stringField(body.path, "receipt path"),
		durableGeneration: integerField(body.durableGeneration, "receipt durableGeneration"),
		vaultSequence: integerField(body.vaultSequence, "receipt vaultSequence"),
		runtimeEpoch: stringField(body.runtimeEpoch, "receipt runtimeEpoch"),
	};
}

async function postLifecycle(identity: Identity, request: LifecycleRequest): Promise<LifecycleReceipt> {
	const response = await fetchBounded(route(identity, "lifecycle"), {
		method: "POST",
		headers: headers(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify(request),
	});
	const receipt = parseReceipt(await json(response, `lifecycle ${request.kind}`));
	if (receipt.vaultId !== identity.vaultId || receipt.vaultGeneration !== identity.vaultGeneration
		|| receipt.bodyId !== request.bodyId || receipt.fileId !== request.fileId
		|| receipt.operationId !== request.operationId || receipt.kind !== request.kind) {
		throw new Error(`lifecycle receipt crossed an identity boundary: ${JSON.stringify(receipt)}`);
	}
	return receipt;
}

async function publishRoot(identity: Identity, request: LifecycleRequest, receipt: LifecycleReceipt): Promise<void> {
	const current = await fetchBounded(route(identity, "root"), { headers: headers(identity) });
	if (!current.ok) throw new Error(`root read failed (${current.status})`);
	const root = new Y.Doc({ guid: "headless-root-publication" });
	Y.applyUpdate(root, new Uint8Array(await current.arrayBuffer()));
	const before = Y.encodeStateVector(root);
	const paths = root.getMap<string>("pathToId");
	if (request.kind === "delete") paths.delete(receipt.path);
	else {
		if (request.kind === "rename" && request.fromPath) paths.delete(request.fromPath);
		paths.set(receipt.path, request.fileId);
	}
	const update = Y.encodeStateAsUpdate(root, before);
	root.destroy();
	const publication = await json(await fetchBounded(route(identity, "lifecycle/publish"), {
		method: "POST",
		headers: headers(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify({
			operations: [{ ...request, vaultSequence: receipt.vaultSequence }],
			rootUpdateBase64: Buffer.from(update).toString("base64"),
		}),
	}), "root publication");
	if (publication.vaultGeneration !== identity.vaultGeneration
		|| !Array.isArray(publication.operationIds)
		|| !publication.operationIds.includes(request.operationId)
		|| !Number.isSafeInteger(publication.vaultSequence)
		|| !Number.isSafeInteger(publication.rootGeneration)) {
		throw new Error(`root publication returned an invalid receipt: ${JSON.stringify(publication)}`);
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Buffer.from(digest).toString("hex");
}

async function bodyUpdate(identity: Identity, bodyId: string): Promise<Uint8Array> {
	const response = await fetchBounded(route(identity, `body/${encodeURIComponent(bodyId)}`), { headers: headers(identity) });
	if (!response.ok) throw new Error(`body ${bodyId} read failed (${response.status})`);
	return new Uint8Array(await response.arrayBuffer());
}

async function submitCandidate(identity: Identity, bodyId: string, update: Uint8Array, prefix: string): Promise<void> {
	const candidateId = `${prefix}-${crypto.randomUUID()}`;
	const candidateDigest = await sha256Hex(update);
	const response = await fetchBounded(route(identity, `body/${encodeURIComponent(bodyId)}/candidate`), {
		method: "POST",
		headers: headers(identity, {
			"Content-Type": "application/octet-stream",
			"x-yaos-candidate-id": candidateId,
			"x-yaos-candidate-digest": candidateDigest,
		}),
		body: update,
	});
	const receipt = await json(response, `body candidate ${bodyId}`);
	if (receipt.vaultId !== identity.vaultId || receipt.vaultGeneration !== identity.vaultGeneration
		|| receipt.bodyId !== bodyId || receipt.candidateId !== candidateId
		|| receipt.candidateDigest !== candidateDigest) {
		throw new Error(`candidate receipt crossed an identity boundary: ${JSON.stringify(receipt)}`);
	}
}

export async function bootstrapCatalog(identity: Identity): Promise<Map<string, { bodyId: string; fileId: string; content: string }>> {
	const started = await json(await fetchBounded(route(identity, "bootstrap/start"), {
		method: "POST",
		headers: headers(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify({ attemptId: `headless-bootstrap-${crypto.randomUUID()}` }),
	}), "bootstrap start");
	if (started.format !== "yaos-bootstrap-v1" || started.schemaVersion !== 4) throw new Error(`wrong bootstrap format: ${JSON.stringify(started)}`);
	const bootstrapId = stringField(started.bootstrapId, "bootstrapId");
	const catalogBody = await json(await fetchBounded(route(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/catalog?limit=100`), {
		headers: headers(identity),
	}), "bootstrap catalog");
	if (!Array.isArray(catalogBody.entries) || catalogBody.nextCursor !== null) throw new Error("bootstrap catalog was not a complete bounded page");
	const entries: CatalogEntry[] = catalogBody.entries.map((item, index) => {
		const entry = record(item, `catalog entry ${index}`);
		if (entry.lifecycle !== "active") throw new Error(`catalog entry ${index} is not active`);
		return {
			bodyId: stringField(entry.bodyId, `catalog ${index} bodyId`),
			fileId: stringField(entry.fileId, `catalog ${index} fileId`),
			path: stringField(entry.path, `catalog ${index} path`),
			lifecycle: "active",
			contentHash: entry.contentHash === null ? null : stringField(entry.contentHash, `catalog ${index} hash`),
			size: entry.size === null ? null : integerField(entry.size, `catalog ${index} size`),
		};
	});
	const result = new Map<string, { bodyId: string; fileId: string; content: string }>();
	for (const entry of entries) {
		const response = await fetchBounded(route(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/body/${encodeURIComponent(entry.bodyId)}`), { headers: headers(identity) });
		if (!response.ok) throw new Error(`bootstrap body ${entry.bodyId} failed (${response.status})`);
		const doc = new Y.Doc({ guid: entry.bodyId });
		Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
		result.set(entry.path, { bodyId: entry.bodyId, fileId: entry.fileId, content: doc.getText("body").toString() });
		doc.destroy();
	}
	const renewed = await json(await fetchBounded(route(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/renew`), {
		method: "POST",
		headers: headers(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify({ settledBodies: entries.length }),
	}), "bootstrap renew");
	if (renewed.ok !== true) throw new Error(`bootstrap renew was not acknowledged: ${JSON.stringify(renewed)}`);
	await json(await fetchBounded(route(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/complete`), {
		method: "POST",
		headers: headers(identity),
	}), "bootstrap complete");
	return result;
}

export class PublicPeer {
	private readonly root: Y.Doc;
	private readonly rootProvider: YSyncProvider;
	private readonly bodies = new Map<string, { doc: Y.Doc; provider: YSyncProvider }>();
	private static readonly MAX_OPEN_BODIES = 8;
	private constructor(readonly identity: Identity, root: Y.Doc, rootProvider: YSyncProvider) {
		this.root = root;
		this.rootProvider = rootProvider;
	}

	static async connect(identity: Identity): Promise<PublicPeer> {
		const root = await connectDocument(identity, "root", "root");
		return new PublicPeer(identity, root.doc, root.provider);
	}

	activePaths(): Map<string, string> {
		return new Map(this.root.getMap<string>("pathToId").entries());
	}

	async read(path: string): Promise<string | null> {
		const bodyId = this.activePaths().get(path);
		if (!bodyId) return null;
		let connected = this.bodies.get(bodyId);
		if (connected) {
			this.bodies.delete(bodyId);
			this.bodies.set(bodyId, connected);
		} else {
			if (this.bodies.size >= PublicPeer.MAX_OPEN_BODIES) {
				const oldestId = this.bodies.keys().next().value as string | undefined;
				const oldest = oldestId === undefined ? undefined : this.bodies.get(oldestId);
				if (oldestId !== undefined) this.bodies.delete(oldestId);
				if (oldest) destroyDocument(oldest);
			}
			connected = await connectDocument(this.identity, "body", bodyId);
			this.bodies.set(bodyId, connected);
		}
		return connected.doc.getText("body").toString();
	}

	async create(path: string, content: string): Promise<string> {
		const bodyId = randomBytes(18).toString("base64url");
		const doc = new Y.Doc({ guid: bodyId });
		doc.getText("body").insert(0, content);
		const update = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		const candidateId = `create-${crypto.randomUUID()}`;
		const candidateDigest = await sha256Hex(update);
		const request: LifecycleRequest = {
			operationId: `create-${crypto.randomUUID()}`,
			kind: "create",
			fileId: bodyId,
			bodyId,
			path,
			candidateId,
			candidateDigest,
		};
		await postLifecycle(this.identity, request);
		const candidate = await fetchBounded(route(this.identity, `body/${encodeURIComponent(bodyId)}/candidate`), {
			method: "POST",
			headers: headers(this.identity, {
				"Content-Type": "application/octet-stream",
				"x-yaos-candidate-id": candidateId,
				"x-yaos-candidate-digest": candidateDigest,
			}),
			body: update,
		});
		const candidateReceipt = await json(candidate, "creation candidate");
		if (candidateReceipt.vaultId !== this.identity.vaultId
			|| candidateReceipt.vaultGeneration !== this.identity.vaultGeneration
			|| candidateReceipt.bodyId !== bodyId || candidateReceipt.candidateId !== candidateId
			|| candidateReceipt.candidateDigest !== candidateDigest) {
			throw new Error(`creation candidate receipt crossed an identity boundary: ${JSON.stringify(candidateReceipt)}`);
		}
		const receipt = await postLifecycle(this.identity, request);
		await publishRoot(this.identity, request, receipt);
		return bodyId;
	}

	async edit(path: string, content: string): Promise<void> {
		const bodyId = this.activePaths().get(path);
		if (!bodyId) throw new Error(`cannot edit missing remote path ${path}`);
		const doc = new Y.Doc({ guid: bodyId });
		Y.applyUpdate(doc, await bodyUpdate(this.identity, bodyId));
		const before = Y.encodeStateVector(doc);
		const text = doc.getText("body");
		text.delete(0, text.length);
		text.insert(0, content);
		const update = Y.encodeStateAsUpdate(doc, before);
		doc.destroy();
		await submitCandidate(this.identity, bodyId, update, "edit");
	}

	async delete(path: string): Promise<void> {
		const bodyId = this.activePaths().get(path);
		if (!bodyId) throw new Error(`cannot delete missing remote path ${path}`);
		const request: LifecycleRequest = {
			operationId: `delete-${crypto.randomUUID()}`,
			kind: "delete",
			fileId: bodyId,
			bodyId,
			path,
		};
		const receipt = await postLifecycle(this.identity, request);
		await publishRoot(this.identity, request, receipt);
	}

	close(): void {
		for (const connected of this.bodies.values()) destroyDocument(connected);
		this.bodies.clear();
		const rootSocket = this.rootProvider.ws;
		if (rootSocket instanceof WebSocket) rootSocket.terminate();
		this.rootProvider.destroy();
		this.root.destroy();
	}
}
