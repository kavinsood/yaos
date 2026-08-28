import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import {
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
	type ConformanceTarget,
	type DeviceIdentity,
} from "./target.ts";

const WAIT_MS = 20_000;
// @ts-expect-error -- DOM and Workers ambient WebSocket declarations disagree on Cloudflare-only attachment methods; ws supplies the provider's runtime constructor.
const WS_POLYFILL: typeof globalThis.WebSocket = WebSocket;

export interface JsonResult {
	readonly response: Response;
	readonly body: Record<string, unknown> | null;
}

export interface LifecycleRequest {
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

export interface LifecycleReceipt {
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

export interface ConnectedDocument {
	readonly doc: Y.Doc;
	readonly provider: YSyncProvider;
	readonly controlFrames: readonly Record<string, unknown>[];
	destroy(): void;
}
export interface RecoveryCrashBarrierEvidence {
	readonly captureId: string;
	readonly observedState: "planning" | "materializing" | "building" | "publishing";
	readonly dispatchId: string;
	readonly crashPid: number;
	readonly crashSignal: "SIGKILL";
}

export function pass(message: string): void {
	console.log(`  PASS  ${message}`);
}

export function expect(condition: unknown, message: string): asserts condition {
	assert.ok(condition, message);
	pass(message);
}

export function bearer(identity: DeviceIdentity, extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${identity.deviceToken}`, ...extra };
}

export function vaultUrl(identity: DeviceIdentity, suffix: string): string {
	return `${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/${suffix.replace(/^\//, "")}`;
}

export async function jsonRequest(url: string, init: RequestInit = {}): Promise<JsonResult> {
	const response = await fetch(url, init);
	const parsed: unknown = await response.clone().json().catch(() => null);
	return {
		response,
		body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null,
	};
}

export function vaultJson(identity: DeviceIdentity, suffix: string, init: RequestInit = {}): Promise<JsonResult> {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${identity.deviceToken}`);
	return jsonRequest(vaultUrl(identity, suffix), { ...init, headers });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = WAIT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error(`timed out waiting for ${label}`);
}

export async function socketTicket(identity: DeviceIdentity): Promise<{ ticket: string; expiresAt: number; ttlMs: number }> {
	const { response, body } = await vaultJson(identity, "auth/ticket", { method: "POST" });
	if (response.status !== 200 || typeof body?.ticket !== "string"
		|| typeof body.expiresAt !== "number" || typeof body.ttlMs !== "number") {
		throw new Error("device bearer did not mint a bounded socket ticket");
	}
	pass("device bearer mints a bounded socket ticket");
	return { ticket: body.ticket, expiresAt: body.expiresAt, ttlMs: body.ttlMs };
}

function socketPrefix(identity: DeviceIdentity, kind: "root" | "body", documentId: string): string {
	return kind === "root"
		? `/vault/${encodeURIComponent(identity.vaultId)}/ws/root`
		: `/vault/${encodeURIComponent(identity.vaultId)}/ws/body/${encodeURIComponent(documentId)}`;
}

export async function connectDocument(
	identity: DeviceIdentity,
	kind: "root" | "body",
	documentId: string,
	doc = new Y.Doc({ guid: documentId }),
): Promise<ConnectedDocument> {
	const provider = new YSyncProvider(identity.host, documentId, doc, {
		prefix: socketPrefix(identity, kind, documentId),
		params: async () => ({
			ticket: (await socketTicket(identity)).ticket,
			schemaVersion: String(SCHEMA_VERSION),
			protocolVersion: String(PROTOCOL_VERSION),
		}),
		WebSocketPolyfill: WS_POLYFILL,
		disableBc: true,
		connect: false,
		maxBackoffTime: 500,
	});
	const frames: Record<string, unknown>[] = [];
	provider.on("custom-message", (raw: string) => {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frames.push(parsed as Record<string, unknown>);
		} catch { /* non-JSON control frames are irrelevant to schema-4 */ }
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${kind}/${documentId} did not sync`)), WAIT_MS);
		provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			clearTimeout(timer);
			resolve();
		});
		provider.on("connection-error", (error: unknown) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
		void provider.connect().catch(reject);
	});
	let destroyed = false;
	return {
		doc,
		provider,
		controlFrames: frames,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			const socket = provider.ws;
			if (socket instanceof WebSocket) socket.terminate();
			provider.disconnect();
			provider.destroy();
			doc.destroy();
		},
	};
}

export async function rejectedSocket(
	identity: DeviceIdentity,
	options: { ticket?: string | null; schemaVersion?: number | null; protocolVersion?: number | null },
): Promise<Record<string, unknown>> {
	const doc = new Y.Doc({ guid: "root" });
	const params: Record<string, string> = {};
	if (options.ticket !== null) params.ticket = options.ticket ?? (await socketTicket(identity)).ticket;
	if (options.schemaVersion !== null) params.schemaVersion = String(options.schemaVersion ?? SCHEMA_VERSION);
	if (options.protocolVersion !== null) params.protocolVersion = String(options.protocolVersion ?? PROTOCOL_VERSION);
	const provider = new YSyncProvider(identity.host, "root", doc, {
		prefix: socketPrefix(identity, "root", "root"), params, WebSocketPolyfill: WS_POLYFILL,
		disableBc: true, connect: false, maxBackoffTime: 500,
	});
	try {
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("socket was not rejected with a fatal control frame")), WAIT_MS);
			provider.on("custom-message", (raw: string) => {
				let parsed: unknown;
				try { parsed = JSON.parse(raw); } catch { return; }
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).type !== "error") return;
				clearTimeout(timer);
				resolve(parsed as Record<string, unknown>);
			});
			void provider.connect().catch(reject);
		});
	} finally {
		provider.disconnect();
		provider.destroy();
		doc.destroy();
	}
}

function integer(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid ${field}`);
	return value as number;
}
function text(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
	return value;
}

export function parseLifecycleReceipt(body: Record<string, unknown> | null): LifecycleReceipt {
	if (!body || !["create", "delete", "revive", "rename"].includes(String(body.kind))
		|| (body.lifecycle !== "active" && body.lifecycle !== "tombstoned")) throw new Error("invalid lifecycle receipt");
	return {
		vaultId: text(body.vaultId, "vaultId"), vaultGeneration: text(body.vaultGeneration, "vaultGeneration"),
		bodyId: text(body.bodyId, "bodyId"), fileId: text(body.fileId, "fileId"), operationId: text(body.operationId, "operationId"),
		kind: body.kind as LifecycleReceipt["kind"], lifecycle: body.lifecycle, path: text(body.path, "path"),
		durableGeneration: integer(body.durableGeneration, "durableGeneration"), vaultSequence: integer(body.vaultSequence, "vaultSequence"),
		runtimeEpoch: text(body.runtimeEpoch, "runtimeEpoch"),
	};
}

export async function postLifecycle(identity: DeviceIdentity, request: LifecycleRequest): Promise<{ result: JsonResult; receipt: LifecycleReceipt | null }> {
	const result = await vaultJson(identity, "lifecycle", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
	});
	return { result, receipt: result.response.ok ? parseLifecycleReceipt(result.body) : null };
}

export async function publishLifecycle(identity: DeviceIdentity, request: LifecycleRequest, receipt: LifecycleReceipt): Promise<JsonResult> {
	const current = await fetch(vaultUrl(identity, "root"), { headers: bearer(identity) });
	assert.equal(current.status, 200);
	const root = new Y.Doc({ guid: "root-publication" });
	Y.applyUpdate(root, new Uint8Array(await current.arrayBuffer()));
	const before = Y.encodeStateVector(root);
	const paths = root.getMap<string>("pathToId");
	if (request.kind === "rename") paths.delete(request.fromPath!);
	if (request.kind === "delete") paths.delete(receipt.path);
	else paths.set(receipt.path, request.fileId);
	const update = Y.encodeStateAsUpdate(root, before);
	root.destroy();
	return vaultJson(identity, "lifecycle/publish", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ operations: [{ ...request, vaultSequence: receipt.vaultSequence }], rootUpdateBase64: Buffer.from(update).toString("base64") }),
	});
}

export async function createBody(identity: DeviceIdentity, path: string, content: string, bodyId = `body_${randomBytes(12).toString("hex")}`): Promise<{ bodyId: string; request: LifecycleRequest; receipt: LifecycleReceipt }> {
	const doc = new Y.Doc({ guid: bodyId });
	doc.getText("body").insert(0, content);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateId = `candidate_${randomBytes(12).toString("hex")}`;
	const candidateDigest = await sha256Hex(update);
	const request: LifecycleRequest = { operationId: `create_${randomBytes(12).toString("hex")}`, kind: "create", fileId: bodyId, bodyId, path, candidateId, candidateDigest };
	const admission = await postLifecycle(identity, request);
	assert.equal(admission.result.response.status, 200, "create lifecycle admits its named candidate fence");
	assert.ok(admission.receipt);
	const candidate = await fetch(vaultUrl(identity, `body/${encodeURIComponent(bodyId)}/candidate`), {
		method: "POST", headers: bearer(identity, { "content-type": "application/octet-stream", "x-yaos-candidate-id": candidateId, "x-yaos-candidate-digest": candidateDigest }), body: update,
	});
	assert.equal(candidate.status, 200, `candidate failed: ${await candidate.clone().text()}`);
	const committed = await postLifecycle(identity, request);
	assert.equal(committed.result.response.status, 200);
	assert.ok(committed.receipt);
	const published = await publishLifecycle(identity, request, committed.receipt);
	assert.equal(published.response.status, 200, `root publication failed: ${JSON.stringify(published.body)}`);
	return { bodyId, request, receipt: committed.receipt };
}

export async function bodyText(identity: DeviceIdentity, bodyId: string): Promise<string> {
	const response = await fetch(vaultUrl(identity, `body/${encodeURIComponent(bodyId)}`), { headers: bearer(identity) });
	assert.equal(response.status, 200);
	const doc = new Y.Doc({ guid: bodyId });
	Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
	const value = doc.getText("body").toString();
	doc.destroy();
	return value;
}

export async function crashRecoveryCaptureAtDispatch(
	target: ConformanceTarget,
	identity: DeviceIdentity,
	capture: { readonly reason: "manual"; readonly requestId: string },
): Promise<RecoveryCrashBarrierEvidence> {
	const result = await jsonRequest(`${target.controlUrl}/recovery-capture-crash`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			path: `/vault/${encodeURIComponent(identity.vaultId)}/recovery/captures`,
			authorization: `Bearer ${identity.deviceToken}`,
			capture,
		}),
	});
	if (!result.response.ok || !result.body) {
		throw new Error(`recovery dispatch crash barrier failed (${result.response.status}): ${JSON.stringify(result.body)}`);
	}
	const { captureId, observedState, dispatchId, crashPid, crashSignal } = result.body;
	if (typeof captureId !== "string"
		|| (observedState !== "planning" && observedState !== "materializing"
			&& observedState !== "building" && observedState !== "publishing")
		|| typeof dispatchId !== "string" || dispatchId.length === 0
		|| !Number.isSafeInteger(crashPid) || (crashPid as number) < 1
		|| crashSignal !== "SIGKILL") {
		throw new Error(`recovery dispatch crash barrier returned invalid evidence: ${JSON.stringify(result.body)}`);
	}
	return {
		captureId,
		observedState,
		dispatchId,
		crashPid: crashPid as number,
		crashSignal,
	};
}

export async function hardRestart(target: ConformanceTarget): Promise<void> {
	const response = await fetch(`${target.controlUrl}/hard-restart`, { method: "POST" });
	if (!response.ok) throw new Error(`hard restart failed (${response.status}): ${await response.text()}`);
}

export async function restart(target: ConformanceTarget): Promise<void> {
	const response = await fetch(`${target.controlUrl}/restart`, { method: "POST" });
	if (!response.ok) throw new Error(`restart failed (${response.status}): ${await response.text()}`);
}

export async function enroll(host: string, pairingCode: string, name: string, values?: Partial<{ enrollmentRequestId: string; deviceId: string; deviceToken: string }>): Promise<{ result: JsonResult; identity: DeviceIdentity | null }> {
	const enrollmentRequestId = values?.enrollmentRequestId ?? randomBytes(16).toString("base64url");
	const deviceId = values?.deviceId ?? randomBytes(16).toString("base64url");
	const deviceToken = values?.deviceToken ?? randomBytes(32).toString("base64url");
	const result = await jsonRequest(`${host}/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairingCode, enrollmentRequestId, deviceId, deviceToken, deviceName: name }) });
	const body = result.body;
	const identity = result.response.ok && body && typeof body.vaultId === "string" && typeof body.vaultGeneration === "string"
		? { host, vaultId: body.vaultId, vaultGeneration: body.vaultGeneration, deviceId, deviceToken }
		: null;
	return { result, identity };
}

export async function createVaultAndEnroll(target: ConformanceTarget, name: string): Promise<DeviceIdentity> {
	const created = await jsonRequest(`${target.baseUrl}/operator/vaults`, {
		method: "POST", headers: { cookie: target.operatorCookie, "content-type": "application/json" }, body: JSON.stringify({ name }),
	});
	assert.equal(created.response.status, 200, JSON.stringify(created.body));
	const vault = created.body?.vault as Record<string, unknown> | undefined;
	assert.ok(vault && typeof vault.vaultId === "string");
	const paired = await jsonRequest(`${target.baseUrl}/operator/pairing-codes`, {
		method: "POST", headers: { cookie: target.operatorCookie, "content-type": "application/json" }, body: JSON.stringify({ vaultId: vault.vaultId, purpose: "device" }),
	});
	assert.equal(paired.response.status, 200);
	assert.ok(paired.body && typeof paired.body.pairingCode === "string");
	const enrolled = await enroll(target.baseUrl, paired.body.pairingCode, name);
	assert.equal(enrolled.result.response.status, 200);
	assert.ok(enrolled.identity);
	return enrolled.identity;
}
