import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema.ts";
import type {
	LifecycleReceipt as ServerLifecycleReceipt,
	LifecycleRequest,
} from "../../server/src/contracts.ts";
import { describeFatalFrame, onFatalFrame } from "./fatalFrame.ts";
import {
	deviceBearerHeaders,
	fetchSocketTicket,
	type LiveIdentity,
} from "./liveIdentity.ts";

const WAIT_MS = 10_000;

export interface ConnectedDocument {
	readonly doc: Y.Doc;
	readonly provider: YSyncProvider;
	destroy(): void;
}

export type LifecycleReceipt = ServerLifecycleReceipt;

export interface CatalogEntry {
	readonly bodyId: string;
	readonly fileId: string;
	readonly path: string;
	readonly lifecycle: "active";
	readonly contentHash: string | null;
	readonly size: number | null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is invalid`);
	return value;
}

function requiredInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} is invalid`);
	}
	return value;
}

function parseLifecycleReceipt(value: unknown): LifecycleReceipt {
	if (!isUnknownRecord(value)) throw new Error("lifecycle receipt is invalid");
	if (
		value.kind !== "create"
		&& value.kind !== "delete"
		&& value.kind !== "revive"
		&& value.kind !== "rename"
	) {
		throw new Error("lifecycle receipt kind is invalid");
	}
	if (value.lifecycle !== "active" && value.lifecycle !== "tombstoned") {
		throw new Error("lifecycle receipt lifecycle is invalid");
	}
	return {
		vaultId: requiredString(value.vaultId, "lifecycle receipt vaultId"),
		vaultGeneration: requiredString(value.vaultGeneration, "lifecycle receipt vaultGeneration"),
		bodyId: requiredString(value.bodyId, "lifecycle receipt bodyId"),
		fileId: requiredString(value.fileId, "lifecycle receipt fileId"),
		operationId: requiredString(value.operationId, "lifecycle receipt operationId"),
		kind: value.kind,
		lifecycle: value.lifecycle,
		path: requiredString(value.path, "lifecycle receipt path"),
		durableGeneration: requiredInteger(value.durableGeneration, "lifecycle receipt durableGeneration"),
		vaultSequence: requiredInteger(value.vaultSequence, "lifecycle receipt vaultSequence"),
		runtimeEpoch: requiredString(value.runtimeEpoch, "lifecycle receipt runtimeEpoch"),
	};
}

function parseCatalogEntries(value: unknown): CatalogEntry[] {
	if (!isUnknownRecord(value) || !Array.isArray(value.entries) || value.nextCursor !== null) {
		throw new Error("bounded bootstrap catalog response is invalid");
	}
	return value.entries.map((entry, index) => {
		if (!isUnknownRecord(entry) || entry.lifecycle !== "active") {
			throw new Error(`bootstrap catalog entry ${index} is invalid`);
		}
		const contentHash = entry.contentHash === null
			? null
			: requiredString(entry.contentHash, `bootstrap catalog entry ${index} contentHash`);
		if (contentHash !== null && !/^[a-f0-9]{64}$/.test(contentHash)) {
			throw new Error(`bootstrap catalog entry ${index} contentHash is invalid`);
		}
		const size = entry.size === null
			? null
			: requiredInteger(entry.size, `bootstrap catalog entry ${index} size`);
		return {
			bodyId: requiredString(entry.bodyId, `bootstrap catalog entry ${index} bodyId`),
			fileId: requiredString(entry.fileId, `bootstrap catalog entry ${index} fileId`),
			path: requiredString(entry.path, `bootstrap catalog entry ${index} path`),
			lifecycle: entry.lifecycle,
			contentHash,
			size,
		};
	});
}

export function vaultRoute(identity: LiveIdentity, suffix: string): string {
	return `${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/${suffix.replace(/^\//, "")}`;
}

export function socketPrefix(identity: LiveIdentity, kind: "root" | "body", documentId: string): string {
	return kind === "root"
		? `/vault/${encodeURIComponent(identity.vaultId)}/ws/root`
		: `/vault/${encodeURIComponent(identity.vaultId)}/ws/body/${encodeURIComponent(documentId)}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function requestJson(
	identity: LiveIdentity,
	suffix: string,
	init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> | null }> {
	const forwardedHeaders: Record<string, string> = {};
	new Headers(init.headers).forEach((value, key) => {
		forwardedHeaders[key] = value;
	});
	const headers = deviceBearerHeaders(identity, forwardedHeaders);
	const response = await fetch(vaultRoute(identity, suffix), { ...init, headers });
	const parsed: unknown = await response.clone().json().catch(() => null);
	return { response, body: isUnknownRecord(parsed) ? parsed : null };
}

export async function connectDocument(
	identity: LiveIdentity,
	kind: "root" | "body",
	documentId: string,
	doc = new Y.Doc({ guid: documentId }),
): Promise<ConnectedDocument> {
	const provider = new YSyncProvider(identity.host, documentId, doc, {
		prefix: socketPrefix(identity, kind, documentId),
		params: async () => {
			const { ticket } = await fetchSocketTicket(identity);
			return {
				ticket,
				schemaVersion: String(SCHEMA_VERSION),
				protocolVersion: String(PROTOCOL_VERSION),
			};
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => finish(new Error(`${kind}/${documentId}: timed out waiting for schema-4 sync`)), WAIT_MS);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			error ? reject(error) : resolve();
		};
		onFatalFrame(provider, (frame) => finish(new Error(`${kind}/${documentId}: ${describeFatalFrame(frame)}`)));
		provider.on("sync", (synced: boolean) => { if (synced) finish(); });
		void provider.connect().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
	});
	return {
		doc,
		provider,
		destroy(): void {
			const socket = provider.ws;
			if (socket instanceof WebSocket) socket.terminate();
			provider.destroy();
			doc.destroy();
		},
	};
}

async function postLifecycle(identity: LiveIdentity, request: LifecycleRequest): Promise<LifecycleReceipt> {
	const { response, body } = await requestJson(identity, "lifecycle", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	if (response.status !== 200 || !body) {
		throw new Error(`lifecycle ${request.kind} failed (${response.status}): ${JSON.stringify(body)}`);
	}
	try {
		return parseLifecycleReceipt(body);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`lifecycle ${request.kind} returned an invalid receipt: ${detail}`);
	}
}

async function publishRoot(
	identity: LiveIdentity,
	request: LifecycleRequest,
	receipt: LifecycleReceipt,
): Promise<void> {
	const current = await fetch(vaultRoute(identity, "root"), { headers: deviceBearerHeaders(identity) });
	if (!current.ok) throw new Error(`root read failed (${current.status})`);
	const root = new Y.Doc({ guid: "root-publication" });
	Y.applyUpdate(root, new Uint8Array(await current.arrayBuffer()));
	const before = Y.encodeStateVector(root);
	const paths = root.getMap<string>("pathToId");
	if (request.kind === "rename") paths.delete(request.fromPath!);
	if (request.kind === "delete") paths.delete(receipt.path);
	else paths.set(receipt.path, request.fileId);
	const update = Y.encodeStateAsUpdate(root, before);
	root.destroy();
	const { response, body } = await requestJson(identity, "lifecycle/publish", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			operations: [{ ...request, vaultSequence: receipt.vaultSequence }],
			rootUpdateBase64: Buffer.from(update).toString("base64"),
		}),
	});
	if (response.status !== 200) throw new Error(`root publication failed (${response.status}): ${JSON.stringify(body)}`);
}

export async function createBody(
	identity: LiveIdentity,
	bodyId: string,
	path: string,
	content: string,
): Promise<LifecycleReceipt> {
	const body = new Y.Doc({ guid: bodyId });
	body.getText("body").insert(0, content);
	const update = Y.encodeStateAsUpdate(body);
	body.destroy();
	const candidateId = `candidate-create-${crypto.randomUUID()}`;
	const candidateDigest = await sha256Hex(update);
	const lifecycle: LifecycleRequest = {
		operationId: `create-${crypto.randomUUID()}`,
		kind: "create",
		fileId: bodyId,
		bodyId,
		path,
		candidateId,
		candidateDigest,
	};
	await postLifecycle(identity, lifecycle);
	const candidate = await fetch(vaultRoute(identity, `body/${encodeURIComponent(bodyId)}/candidate`), {
		method: "POST",
		headers: deviceBearerHeaders(identity, {
			"Content-Type": "application/octet-stream",
			"x-yaos-candidate-id": candidateId,
			"x-yaos-candidate-digest": candidateDigest,
		}),
		body: update,
	});
	if (candidate.status !== 200) throw new Error(`creation candidate failed (${candidate.status}): ${await candidate.text()}`);
	const receipt = await postLifecycle(identity, lifecycle);
	await publishRoot(identity, lifecycle, receipt);
	return receipt;
}

export async function submitBodyUpdate(
	identity: LiveIdentity,
	bodyId: string,
	update: Uint8Array,
	candidateId = `candidate-edit-${crypto.randomUUID()}`,
): Promise<Response> {
	return fetch(vaultRoute(identity, `body/${encodeURIComponent(bodyId)}/candidate`), {
		method: "POST",
		headers: deviceBearerHeaders(identity, {
			"Content-Type": "application/octet-stream",
			"x-yaos-candidate-id": candidateId,
			"x-yaos-candidate-digest": await sha256Hex(update),
		}),
		body: update,
	});
}

export async function mutateLifecycle(
	identity: LiveIdentity,
	request: LifecycleRequest,
): Promise<LifecycleReceipt> {
	const receipt = await postLifecycle(identity, request);
	await publishRoot(identity, request, receipt);
	return receipt;
}

export async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = WAIT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}

export async function bootstrapFromSql(identity: LiveIdentity): Promise<{
	root: Y.Doc;
	bodies: Map<string, Y.Doc>;
	entries: CatalogEntry[];
}> {
	const started = await requestJson(identity, "bootstrap/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ attemptId: `live-bootstrap-${crypto.randomUUID()}` }),
	});
	if (started.response.status !== 200 || !started.body || typeof started.body.bootstrapId !== "string") {
		throw new Error(`bootstrap start failed (${started.response.status}): ${JSON.stringify(started.body)}`);
	}
	if (started.body.format !== "yaos-bootstrap-v1" || started.body.schemaVersion !== SCHEMA_VERSION) {
		throw new Error(`bootstrap descriptor has wrong format: ${JSON.stringify(started.body)}`);
	}
	const bootstrapId = started.body.bootstrapId;
	const rootResponse = await fetch(vaultRoute(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/root`), {
		headers: deviceBearerHeaders(identity),
	});
	if (!rootResponse.ok) throw new Error(`bootstrap root failed (${rootResponse.status})`);
	const root = new Y.Doc({ guid: "root" });
	Y.applyUpdate(root, new Uint8Array(await rootResponse.arrayBuffer()));
	const catalog = await requestJson(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/catalog?limit=100`);
	if (!catalog.response.ok) {
		throw new Error(`bounded bootstrap catalog failed (${catalog.response.status}): ${JSON.stringify(catalog.body)}`);
	}
	let entries: CatalogEntry[];
	try {
		entries = parseCatalogEntries(catalog.body);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`bounded bootstrap catalog failed: ${detail}; body=${JSON.stringify(catalog.body)}`);
	}
	const bodies = new Map<string, Y.Doc>();
	for (const entry of entries) {
		const response = await fetch(vaultRoute(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/body/${encodeURIComponent(entry.bodyId)}`), {
			headers: deviceBearerHeaders(identity),
		});
		if (!response.ok) throw new Error(`bootstrap body ${entry.bodyId} failed (${response.status})`);
		const doc = new Y.Doc({ guid: entry.bodyId });
		Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
		bodies.set(entry.bodyId, doc);
	}
	const complete = await requestJson(identity, `bootstrap/${encodeURIComponent(bootstrapId)}/complete`, { method: "POST" });
	if (!complete.response.ok) throw new Error(`bootstrap completion failed (${complete.response.status})`);
	return { root, bodies, entries };
}
