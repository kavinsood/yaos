import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket, { type RawData } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../src/sync/schema";
import {
	connectDocument as connectLiveDocument,
	createBody,
	type ConnectedDocument,
	vaultRoute,
	waitFor,
} from "../tests/live/schema4Live";
import type YSyncProvider from "y-partyserver/provider";
import {
	deviceBearerHeaders,
	fetchSocketTicket,
	type LiveIdentity,
} from "../tests/live/liveIdentity";

const host = requiredEnv("YAOS_MULTIPLEX_BENCH_HOST").replace(/\/+$/, "");
const outputPath = process.env.YAOS_MULTIPLEX_BENCH_OUTPUT?.trim() || null;
const accessTokenFile = process.env.YAOS_MULTIPLEX_ACCESS_TOKEN_FILE?.trim() || null;
const accessToken = accessTokenFile ? readFileSync(accessTokenFile, "utf8").trim() : null;
const accessClientId = process.env.YAOS_CF_ACCESS_CLIENT_ID?.trim()
	|| process.env.CF_ACCESS_CLIENT_ID?.trim() || null;
const accessClientSecret = process.env.YAOS_CF_ACCESS_CLIENT_SECRET?.trim()
	|| process.env.CF_ACCESS_CLIENT_SECRET?.trim() || null;
const deploymentVersion = process.env.YAOS_MULTIPLEX_BENCH_DEPLOYMENT_VERSION?.trim() || null;
const bodyCount = Number(process.env.YAOS_CURRENTNESS_BENCH_BODY_COUNT ?? "100");
const smallBodyBytes = 4 * 1024;
const timeoutMs = 30_000;
const currentnessWidths = [1, 2, 4, 7, 24, 100] as const;
const catchUpWidths = [1, 7, 24, 100] as const;

if (!Number.isSafeInteger(bodyCount) || bodyCount < 100) {
	throw new Error("YAOS_CURRENTNESS_BENCH_BODY_COUNT must be an integer >= 100");
}
if ((accessClientId === null) !== (accessClientSecret === null)) {
	throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be supplied together");
}

interface BenchmarkContext {
	readonly deviceA: LiveIdentity;
	readonly deviceB: LiveIdentity;
	readonly operatorCookie: string;
}

interface RawSocketMeasurement {
	readonly bodyId: string;
	readonly openMs: number;
	readonly readyMs: number;
	readonly syncMs: number;
	readonly pongMs: number;
	readonly receivedFrames: number;
	readonly sentFrames: number;
	readonly receivedPayloadBytes: number;
	readonly sentPayloadBytes: number;
	readonly transportBytesRead: number | null;
	readonly transportBytesWritten: number | null;
	readonly pingPayloadBytes: number;
	readonly pongPayloadBytes: number;
	closeMs: number | null;
}

interface OpenRawSocket {
	readonly socket: WebSocket;
	readonly doc: Y.Doc;
	readonly measurement: RawSocketMeasurement;
}

interface Distribution {
	readonly count: number;
	readonly min: number;
	readonly p50: number;
	readonly p95: number;
	readonly max: number;
	readonly mean: number;
}

interface UnexpectedResponse extends Error {
	readonly status: number;
}

interface CapabilityProbe {
	readonly status: number;
	readonly claimed: boolean | null;
	readonly error: string | null;
	readonly cfRay: string | null;
	readonly redirected: boolean;
	readonly responseOrigin: string;
	readonly location: string | null;
}

class BenchmarkWebSocket extends WebSocket {
	constructor(address: string | URL, protocols?: string | string[]) {
		const headers: Record<string, string> = {};
		if (accessToken) headers.Cookie = `CF_Authorization=${accessToken}`;
		if (accessClientId && accessClientSecret) {
			headers["CF-Access-Client-Id"] = accessClientId;
			headers["CF-Access-Client-Secret"] = accessClientSecret;
		}
		super(address, protocols, { headers });
	}
}

function connectDocument(
	identity: LiveIdentity,
	kind: "root" | "body",
	documentId: string,
): Promise<ConnectedDocument> {
	return connectLiveDocument(
		identity,
		kind,
		documentId,
		new Y.Doc({ guid: documentId }),
		BenchmarkWebSocket as unknown as typeof globalThis.WebSocket,
	);
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

if (accessToken || (accessClientId && accessClientSecret)) {
	const nativeFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		if (accessToken) {
			const cookie = headers.get("Cookie");
			headers.set("Cookie", `${cookie ? `${cookie}; ` : ""}CF_Authorization=${accessToken}`);
		}
		if (accessClientId && accessClientSecret) {
			headers.set("CF-Access-Client-Id", accessClientId);
			headers.set("CF-Access-Client-Secret", accessClientSecret);
		}
		return nativeFetch(input, { ...init, headers });
	}) as typeof globalThis.fetch;
	globalThis.WebSocket = BenchmarkWebSocket as unknown as typeof globalThis.WebSocket;
}

function elapsed(startedAt: number): number {
	return performance.now() - startedAt;
}

function rounded(value: number): number {
	return Math.round(value * 100) / 100;
}

function distribution(values: readonly number[]): Distribution {
	if (values.length === 0) throw new Error("distribution requires at least one value");
	const sorted = [...values].sort((left, right) => left - right);
	const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
	return {
		count: sorted.length,
		min: rounded(sorted[0]!),
		p50: rounded(percentile(0.5)),
		p95: rounded(percentile(0.95)),
		max: rounded(sorted[sorted.length - 1]!),
		mean: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
	};
}

function rawBytes(data: RawData): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function payloadBytes(data: string | Uint8Array): number {
	return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

function bodyId(index: number): string {
	return `mux-body-${String(index).padStart(2, "0")}`;
}

function bodyContent(index: number): string {
	const prefix = `body-${index}\n`;
	return prefix + String.fromCharCode(97 + (index % 26)).repeat(smallBodyBytes - prefix.length);
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
	const value: unknown = await response.clone().json().catch(() => null);
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

async function capabilityProbe(label: string): Promise<CapabilityProbe> {
	const url = new URL(`${host}/api/capabilities`);
	url.searchParams.set("profileProbe", `${label}-${randomBytes(6).toString("hex")}`);
	const response = await fetch(url, {
		redirect: "manual",
		headers: { "Cache-Control": "no-cache" },
	});
	const value = await json(response);
	return {
		status: response.status,
		claimed: typeof value?.claimed === "boolean" ? value.claimed : null,
		error: typeof value?.error === "string" ? value.error : null,
		cfRay: response.headers.get("cf-ray"),
		redirected: response.redirected,
		responseOrigin: new URL(response.url).origin,
		location: response.headers.get("location"),
	};
}

function probeSummary(probes: readonly CapabilityProbe[]): string {
	return JSON.stringify(probes.map(({ status, claimed, error, cfRay, redirected, responseOrigin, location }) => ({
		status, claimed, error, cfRay, redirected, responseOrigin, location,
	})));
}

async function enroll(pairingCode: string, deviceName: string, vaultId: string): Promise<LiveIdentity> {
	const deviceId = randomBytes(16).toString("base64url");
	const deviceToken = randomBytes(32).toString("base64url");
	const response = await fetch(`${host}/enroll`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			pairingCode,
			enrollmentRequestId: randomBytes(16).toString("base64url"),
			deviceId,
			deviceToken,
			deviceName,
		}),
	});
	const value = await json(response);
	if (!response.ok || value?.vaultId !== vaultId || value.deviceId !== deviceId || value.deviceToken !== deviceToken) {
		throw new Error(`enrollment failed (${response.status}): ${JSON.stringify(value)}`);
	}
	return { host, vaultId, deviceId, deviceToken };
}

async function provision(): Promise<BenchmarkContext> {
	const beforeClaim = await capabilityProbe("before-claim");
	if (beforeClaim.status !== 200 || beforeClaim.claimed !== false) {
		throw new Error(`benchmark Worker must be fresh and unclaimed: ${probeSummary([beforeClaim])}`);
	}
	const operatorRecoveryKey = randomBytes(32).toString("base64url");
	const claimResponse = await fetch(`${host}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	const claim = await json(claimResponse);
	if (!claimResponse.ok || typeof claim?.vaultId !== "string" || typeof claim.pairingCode !== "string") {
		throw new Error(`claim failed (${claimResponse.status}): ${JSON.stringify(claim)}`);
	}
	// A deployed Worker can have several warm isolates. Probe concurrently so
	// a stale pre-claim auth cache is diagnosed before it appears midway through
	// publication as an intermittent application-level 503.
	const claimVisibility = await Promise.all(Array.from({ length: 8 }, (_value, index) =>
		capabilityProbe(`after-claim-${index}`)));
	if (claimVisibility.some((probe) => probe.status !== 200 || probe.claimed !== true)) {
		throw new Error(`claim is not visible across edge requests: ${probeSummary(claimVisibility)}`);
	}
	const deviceA = await enroll(claim.pairingCode, "mux-bench-a", claim.vaultId);
	const pairingResponse = await fetch(vaultRoute(deviceA, "auth/pairing-code"), {
		method: "POST",
		headers: deviceBearerHeaders(deviceA, { "Content-Type": "application/json" }),
		body: JSON.stringify({ purpose: "device" }),
	});
	const pairing = await json(pairingResponse);
	if (!pairingResponse.ok || typeof pairing?.pairingCode !== "string") {
		throw new Error(`pairing failed (${pairingResponse.status}): ${JSON.stringify(pairing)}`);
	}
	const deviceB = await enroll(pairing.pairingCode, "mux-bench-b", claim.vaultId);
	const login = await fetch(`${host}/operator/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
	if (!login.ok || !cookie) throw new Error(`operator login failed (${login.status})`);
	return { deviceA, deviceB, operatorCookie: cookie };
}

async function seed(identity: LiveIdentity): Promise<void> {
	for (let index = 0; index < bodyCount; index++) {
		try {
			await createBody(identity, bodyId(index), `Multiplex/${String(index).padStart(2, "0")}.md`, bodyContent(index));
		} catch (error) {
			const probes = await Promise.all(Array.from({ length: 4 }, (_value, probeIndex) =>
				capabilityProbe(`seed-${index}-failure-${probeIndex}`)));
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`seed ${index + 1}/${bodyCount} failed: ${detail}; edge auth probes=${probeSummary(probes)}`);
		}
		if ((index + 1) % 5 === 0) console.log(`Seeded ${index + 1}/${bodyCount} bodies`);
	}
}

function socketUrl(identity: LiveIdentity, body: string, ticket: string): string {
	const url = new URL(vaultRoute(identity, `ws/body/${encodeURIComponent(body)}`));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	url.searchParams.set("schemaVersion", String(SCHEMA_VERSION));
	url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
	return url.toString();
}

async function openRawBody(
	identity: LiveIdentity,
	body: string,
	expectedContent: string,
): Promise<OpenRawSocket> {
	const ticket = (await fetchSocketTicket(identity, identity.vaultId, "body", body, 1)).ticket;
	const startedAt = performance.now();
	const doc = new Y.Doc({ guid: body });
	const socket = new BenchmarkWebSocket(socketUrl(identity, body, ticket));
	let openMs: number | null = null;
	let readyMs: number | null = null;
	let syncMs: number | null = null;
	let pongMs: number | null = null;
	let receivedFrames = 0;
	let sentFrames = 0;
	let receivedPayloadBytes = 0;
	let sentPayloadBytes = 0;
	let pingPayloadBytes = 0;
	let pongPayloadBytes = 0;
	const probeId = randomBytes(12).toString("base64url");
	let finished = false;

	const send = (data: string | Uint8Array): void => {
		sentFrames++;
		sentPayloadBytes += payloadBytes(data);
		socket.send(data);
	};

	return new Promise<OpenRawSocket>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => finish(new Error(`${body}: timed out`)), timeoutMs);
		const finish = (error?: Error): void => {
			if (finished) return;
			if (!error && (openMs === null || readyMs === null || syncMs === null || pongMs === null)) return;
			finished = true;
			clearTimeout(timer);
			if (error) {
				socket.terminate();
				doc.destroy();
				rejectPromise(error);
				return;
			}
			const transport = socket as unknown as { _socket?: { bytesRead: number; bytesWritten: number } };
			resolvePromise({
				socket,
				doc,
				measurement: {
					bodyId: body,
					openMs: rounded(openMs!),
					readyMs: rounded(readyMs!),
					syncMs: rounded(syncMs!),
					pongMs: rounded(pongMs!),
					receivedFrames,
					sentFrames,
					receivedPayloadBytes,
					sentPayloadBytes,
					transportBytesRead: transport._socket?.bytesRead ?? null,
					transportBytesWritten: transport._socket?.bytesWritten ?? null,
					pingPayloadBytes,
					pongPayloadBytes,
					closeMs: null,
				},
			});
		};

		socket.on("open", () => {
			openMs = elapsed(startedAt);
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, 0);
			syncProtocol.writeSyncStep1(encoder, doc);
			send(encoding.toUint8Array(encoder));
		});
		socket.on("message", (data, isBinary) => {
			receivedFrames++;
			const bytes = rawBytes(data);
			receivedPayloadBytes += bytes.byteLength;
			if (!isBinary) {
				const text = Buffer.from(bytes).toString("utf8");
				if (!text.startsWith("__YPS:")) return;
				let control: Record<string, unknown> | null = null;
				try {
					const parsed: unknown = JSON.parse(text.slice(6));
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						control = parsed as Record<string, unknown>;
					}
				} catch {
					return;
				}
				if (control?.type === "VAULT_READY" && readyMs === null) {
					readyMs = elapsed(startedAt);
					const ping = `__YPS:${JSON.stringify({ type: "VAULT_PING", probeId })}`;
					pingPayloadBytes = Buffer.byteLength(ping);
					send(ping);
				}
				if (control?.type === "VAULT_PONG" && control.probeId === probeId) {
					pongPayloadBytes = bytes.byteLength;
					pongMs = elapsed(startedAt);
				}
				finish();
				return;
			}
			try {
				const decoder = decoding.createDecoder(bytes);
				if (decoding.readVarUint(decoder) !== 0) return;
				const reply = encoding.createEncoder();
				encoding.writeVarUint(reply, 0);
				syncProtocol.readSyncMessage(decoder, reply, doc, socket);
				if (encoding.length(reply) > 1) send(encoding.toUint8Array(reply));
				if (doc.getText("body").toString() === expectedContent && syncMs === null) {
					syncMs = elapsed(startedAt);
				}
				finish();
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.on("unexpected-response", (_request, response) => {
			const error = new Error(`${body}: unexpected HTTP ${response.statusCode}`) as UnexpectedResponse;
			Object.defineProperty(error, "status", { value: response.statusCode, enumerable: true });
			finish(error);
		});
		socket.on("error", (error) => finish(error));
		socket.on("close", () => {
			if (!finished) finish(new Error(`${body}: socket closed before measurement completed`));
		});
	});
}

async function closeRaw(opened: OpenRawSocket): Promise<void> {
	const startedAt = performance.now();
	if (opened.socket.readyState === WebSocket.CLOSED) {
		opened.measurement.closeMs = 0;
		opened.doc.destroy();
		return;
	}
	await new Promise<void>((resolvePromise) => {
		const timer = setTimeout(() => {
			opened.socket.terminate();
			resolvePromise();
		}, 2_000);
		opened.socket.once("close", () => {
			clearTimeout(timer);
			resolvePromise();
		});
		opened.socket.close();
	});
	opened.measurement.closeMs = rounded(elapsed(startedAt));
	opened.doc.destroy();
}

async function serverDiagnostics(identity: LiveIdentity): Promise<Record<string, unknown> | null> {
	const response = await fetch(vaultRoute(identity, "debug/recent"), { headers: deviceBearerHeaders(identity) });
	return response.ok ? json(response) : null;
}

async function measureHttpReads(
	identity: LiveIdentity,
	route: "head" | "body",
	indices: readonly number[],
): Promise<{ latencyMs: Distribution; responseBytes: Distribution }> {
	const latencies: number[] = [];
	const sizes: number[] = [];
	for (const index of indices) {
		const startedAt = performance.now();
		const response = await fetch(vaultRoute(identity, `${route}/${encodeURIComponent(bodyId(index))}`), {
			headers: deviceBearerHeaders(identity),
		});
		const bytes = await response.arrayBuffer();
		if (!response.ok) throw new Error(`${route} read failed (${response.status})`);
		latencies.push(elapsed(startedAt));
		sizes.push(bytes.byteLength);
	}
	return { latencyMs: distribution(latencies), responseBytes: distribution(sizes) };
}

async function measureParallelHeads(
	identity: LiveIdentity,
	bodyIds: readonly string[],
	count: number,
): Promise<{ wallMs: Distribution; responseBytes: Distribution; requestsPerTrial: number }> {
	const latencies: number[] = [];
	const sizes: number[] = [];
	for (let trial = 0; trial < count; trial++) {
		const startedAt = performance.now();
		const responses = await Promise.all(bodyIds.map(async (bodyId) => {
			const response = await fetch(vaultRoute(identity, `head/${encodeURIComponent(bodyId)}`), {
				headers: deviceBearerHeaders(identity),
			});
			const bytes = await response.arrayBuffer();
			if (!response.ok) throw new Error(`head read failed (${response.status})`);
			return bytes.byteLength;
		}));
		latencies.push(elapsed(startedAt));
		sizes.push(responses.reduce((sum, size) => sum + size, 0));
	}
	return {
		wallMs: distribution(latencies),
		responseBytes: distribution(sizes),
		requestsPerTrial: bodyIds.length,
	};
}

async function measureProviderCurrentness(
	provider: YSyncProvider,
	bodyIds: readonly string[],
	count: number,
): Promise<{ latencyMs: Distribution; responseBytes: Distribution }> {
	const pending = new Map<string, {
		startedAt: number;
		resolve: (value: { latency: number; bytes: number }) => void;
	}>();
	provider.on("custom-message", (payload: string) => {
		let value: Record<string, unknown> | null = null;
		try {
			const parsed: unknown = JSON.parse(payload);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
		} catch { return; }
		if (value?.type !== "BODY_CURRENTNESS_RESULT" || typeof value.queryId !== "string") return;
		const waiter = pending.get(value.queryId);
		if (!waiter) return;
		pending.delete(value.queryId);
		waiter.resolve({ latency: elapsed(waiter.startedAt), bytes: Buffer.byteLength(payload) + 6 });
	});
	const latencies: number[] = [];
	const sizes: number[] = [];
	for (let index = 0; index < count; index++) {
		const queryId = randomBytes(12).toString("base64url");
		const result = await new Promise<{ latency: number; bytes: number }>((resolvePromise, rejectPromise) => {
			const timeout = setTimeout(() => {
				pending.delete(queryId);
				rejectPromise(new Error(`currentness query timed out (${bodyIds.length} bodies)`));
			}, timeoutMs);
			pending.set(queryId, {
				startedAt: performance.now(),
				resolve: (value) => {
					clearTimeout(timeout);
					resolvePromise(value);
				},
			});
			provider.sendMessage(JSON.stringify({ type: "BODY_CURRENTNESS_QUERY", queryId, bodyIds }));
		});
		latencies.push(result.latency);
		sizes.push(result.bytes);
	}
	return { latencyMs: distribution(latencies), responseBytes: distribution(sizes) };
}

async function currentHeads(identity: LiveIdentity): Promise<Map<string, number>> {
	const response = await fetch(vaultRoute(identity, "heads?limit=1000"), { headers: deviceBearerHeaders(identity) });
	const value = await json(response);
	if (!response.ok || !Array.isArray(value?.entries)) throw new Error(`heads read failed (${response.status})`);
	return new Map(value.entries.map((entry) => {
		if (!entry || typeof entry !== "object" || !("bodyId" in entry) || !("generation" in entry)
			|| typeof entry.bodyId !== "string" || !Number.isSafeInteger(entry.generation)) {
			throw new Error("invalid heads response");
		}
		return [entry.bodyId, entry.generation as number];
	}));
}

async function measureCatchUp(
	identity: LiveIdentity,
	bodyIds: readonly string[],
	generations: ReadonlyMap<string, number>,
	current: boolean,
	count: number,
): Promise<{ latencyMs: Distribution; responseBytes: Distribution }> {
	const latencies: number[] = [];
	const sizes: number[] = [];
	for (let trial = 0; trial < count; trial++) {
		const startedAt = performance.now();
		const response = await fetch(vaultRoute(identity, "catch-up"), {
			method: "POST",
			headers: deviceBearerHeaders(identity, { "Content-Type": "application/json" }),
			body: JSON.stringify({ bodies: bodyIds.map((bodyId) => ({
				bodyId,
				bodyEpoch: 1,
				generation: current ? generations.get(bodyId) ?? 0 : 0,
			})) }),
		});
		const bytes = await response.arrayBuffer();
		if (!response.ok) {
			throw new Error(`catch-up read failed (${response.status}): ${new TextDecoder().decode(bytes)}`);
		}
		latencies.push(elapsed(startedAt));
		sizes.push(bytes.byteLength);
	}
	return { latencyMs: distribution(latencies), responseBytes: distribution(sizes) };
}

async function catchUpRequest(
	identity: LiveIdentity,
	bodyIds: readonly string[],
	generation = 0,
): Promise<{ latency: number; bytes: number }> {
	const startedAt = performance.now();
	const response = await fetch(vaultRoute(identity, "catch-up"), {
		method: "POST",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify({ bodies: bodyIds.map((bodyId) => ({ bodyId, bodyEpoch: 1, generation })) }),
	});
	const bytes = await response.arrayBuffer();
	if (!response.ok) {
		throw new Error(`catch-up read failed (${response.status}): ${new TextDecoder().decode(bytes)}`);
	}
	return { latency: elapsed(startedAt), bytes: bytes.byteLength };
}

async function runSequential(
	identity: LiveIdentity,
	indices: readonly number[],
): Promise<RawSocketMeasurement[]> {
	const values: RawSocketMeasurement[] = [];
	for (const index of indices) {
		const opened = await openRawBody(identity, bodyId(index), bodyContent(index));
		values.push(opened.measurement);
		await closeRaw(opened);
	}
	return values;
}

async function runParallel(
	identity: LiveIdentity,
	indices: readonly number[],
): Promise<{ wallMs: number; measurements: RawSocketMeasurement[] }> {
	const startedAt = performance.now();
	const opened = await Promise.all(indices.map((index) => openRawBody(identity, bodyId(index), bodyContent(index))));
	const wallMs = elapsed(startedAt);
	await Promise.all(opened.map(closeRaw));
	return { wallMs: rounded(wallMs), measurements: opened.map((value) => value.measurement) };
}

function summarizeRaw(values: readonly RawSocketMeasurement[]): Record<string, unknown> {
	const closeTimes = values.flatMap((value) => value.closeMs === null ? [] : [value.closeMs]);
	return {
		openMs: distribution(values.map((value) => value.openMs)),
		readyMs: distribution(values.map((value) => value.readyMs)),
		syncMs: distribution(values.map((value) => value.syncMs)),
		pongMs: distribution(values.map((value) => value.pongMs)),
		receivedPayloadBytes: distribution(values.map((value) => value.receivedPayloadBytes)),
		sentPayloadBytes: distribution(values.map((value) => value.sentPayloadBytes)),
		transportBytesRead: distribution(values.flatMap((value) => value.transportBytesRead === null ? [] : [value.transportBytesRead])),
		transportBytesWritten: distribution(values.flatMap((value) => value.transportBytesWritten === null ? [] : [value.transportBytesWritten])),
		pingPayloadBytes: distribution(values.map((value) => value.pingPayloadBytes)),
		pongPayloadBytes: distribution(values.map((value) => value.pongPayloadBytes)),
		...(closeTimes.length > 0 ? { closeMs: distribution(closeTimes) } : {}),
	};
}

async function propagationSamples(
	deviceA: LiveIdentity,
	deviceB: LiveIdentity,
	body: string,
	extraDeviceBBodyIds: readonly string[],
	count: number,
): Promise<number[]> {
	const a = await connectDocument(deviceA, "body", body);
	const b = await connectDocument(deviceB, "body", body);
	const extras = [];
	try {
		for (const extra of extraDeviceBBodyIds) extras.push(await connectDocument(deviceB, "body", extra));
		const latencies: number[] = [];
		for (let index = 0; index < count; index++) {
			const expected = `${b.doc.getText("body").toString()}${index % 10}`;
			const received = new Promise<void>((resolvePromise) => {
				const observer = (): void => {
					if (b.doc.getText("body").toString() !== expected) return;
					b.doc.off("update", observer);
					resolvePromise();
				};
				b.doc.on("update", observer);
			});
			const startedAt = performance.now();
			a.doc.getText("body").insert(a.doc.getText("body").length, String(index % 10));
			await received;
			latencies.push(rounded(elapsed(startedAt)));
		}
		return latencies;
	} finally {
		for (const extra of extras) extra.destroy();
		b.destroy();
		a.destroy();
	}
}

async function propagationDuringCatchUpSamples(
	deviceA: LiveIdentity,
	deviceB: LiveIdentity,
	body: string,
	extraDeviceBBodyIds: readonly string[],
	catchUpBodyIds: readonly string[],
	count: number,
): Promise<{ propagationMs: number[]; catchUpMs: number[]; catchUpBytes: number[] }> {
	const a = await connectDocument(deviceA, "body", body);
	const b = await connectDocument(deviceB, "body", body);
	const extras = [];
	try {
		for (const extra of extraDeviceBBodyIds) extras.push(await connectDocument(deviceB, "body", extra));
		const propagationMs: number[] = [];
		const catchUpMs: number[] = [];
		const catchUpBytes: number[] = [];
		for (let index = 0; index < count; index++) {
			const expected = `${b.doc.getText("body").toString()}${index % 10}`;
			const received = new Promise<void>((resolvePromise) => {
				const observer = (): void => {
					if (b.doc.getText("body").toString() !== expected) return;
					b.doc.off("update", observer);
					resolvePromise();
				};
				b.doc.on("update", observer);
			});
			const catchUp = catchUpRequest(deviceB, catchUpBodyIds);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
			const startedAt = performance.now();
			a.doc.getText("body").insert(a.doc.getText("body").length, String(index % 10));
			await received;
			propagationMs.push(rounded(elapsed(startedAt)));
			const catchUpResult = await catchUp;
			catchUpMs.push(rounded(catchUpResult.latency));
			catchUpBytes.push(catchUpResult.bytes);
		}
		return { propagationMs, catchUpMs, catchUpBytes };
	} finally {
		for (const extra of extras) extra.destroy();
		b.destroy();
		a.destroy();
	}
}

async function waitForGeneration(
	identity: LiveIdentity,
	body: string,
	minimumGeneration: number,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const heads = await currentHeads(identity);
		const generation = heads.get(body) ?? 0;
		if (generation >= minimumGeneration) return generation;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error(`${body}: generation did not reach ${minimumGeneration}`);
}

async function measureFlushCompaction(
	deviceA: LiveIdentity,
	deviceB: LiveIdentity,
	body: string,
): Promise<Record<string, unknown>> {
	const a = await connectDocument(deviceA, "body", body);
	const b = await connectDocument(deviceB, "body", body);
	const root = await connectDocument(deviceB, "root", "root");
	let committedNotifications = 0;
	root.provider.on("custom-message", (payload: string) => {
		try {
			const value: unknown = JSON.parse(payload);
			if (typeof value === "object" && value !== null && "type" in value
				&& value.type === "BODY_COMMITTED" && "bodyId" in value && value.bodyId === body) {
				committedNotifications++;
			}
		} catch { return; }
	});
	try {
		const result: Record<string, unknown> = {};
		for (const width of [1, 10, 100]) {
			const beforeHeads = await currentHeads(deviceB);
			const beforeGeneration = beforeHeads.get(body) ?? 0;
			const beforeStatus = await serverDiagnostics(deviceB);
			const beforeSequence = typeof beforeStatus?.sequence === "number" ? beforeStatus.sequence : null;
			const beforeNotifications = committedNotifications;
			const expected = `${b.doc.getText("body").toString()}${"x".repeat(width)}`;
			const received = new Promise<void>((resolvePromise) => {
				const observer = (): void => {
					if (b.doc.getText("body").toString() !== expected) return;
					b.doc.off("update", observer);
					resolvePromise();
				};
				b.doc.on("update", observer);
			});
			const startedAt = performance.now();
			for (let index = 0; index < width; index++) {
				a.doc.getText("body").insert(a.doc.getText("body").length, "x");
			}
			await received;
			const durableGeneration = await waitForGeneration(deviceB, body, beforeGeneration + 1);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
			const afterStatus = await serverDiagnostics(deviceB);
			const afterSequence = typeof afterStatus?.sequence === "number" ? afterStatus.sequence : null;
			result[String(width)] = {
				wallToDurableMs: rounded(elapsed(startedAt)),
				inputUpdates: width,
				journalGenerationDelta: durableGeneration - beforeGeneration,
				vaultSequenceDelta: beforeSequence === null || afterSequence === null ? null : afterSequence - beforeSequence,
				committedNotifications: committedNotifications - beforeNotifications,
			};
		}
		return result;
	} finally {
		root.destroy();
		b.destroy();
		a.destroy();
	}
}

async function destroyVault(context: BenchmarkContext): Promise<void> {
	const url = `${host}/operator/vaults/${encodeURIComponent(context.deviceA.vaultId)}`;
	const ownerRequest = await fetch(vaultRoute(context.deviceA, "governance"), {
		method: "DELETE",
		headers: deviceBearerHeaders(context.deviceA, { "Content-Type": "application/json" }),
		body: JSON.stringify({ requestId: randomBytes(16).toString("base64url") }),
	});
	const requested = await json(ownerRequest);
	const governance = requested?.governanceRequest;
	const governanceRequestId = governance && typeof governance === "object" && !Array.isArray(governance)
		&& typeof (governance as Record<string, unknown>).governanceRequestId === "string"
		? String((governance as Record<string, unknown>).governanceRequestId)
		: null;
	if (ownerRequest.status !== 202 || governanceRequestId === null) {
		throw new Error(`owner destroy request failed (${ownerRequest.status}): ${JSON.stringify(requested)}`);
	}
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const response = await fetch(url, {
			method: "DELETE",
			headers: { Cookie: context.operatorCookie, "Content-Type": "application/json" },
			body: JSON.stringify({ governanceRequestId }),
		});
		if (response.status === 200) return;
		if (response.status !== 202) throw new Error(`vault destroy failed (${response.status}): ${await response.text()}`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
	}
	throw new Error("vault destroy did not complete before deadline");
}

async function main(): Promise<void> {
	console.log(`Multiplex benchmark target: ${host}`);
	const context = await provision();
	const edgeProbe = await fetch(`${host}/api/capabilities`);
	const report: Record<string, unknown> = {
		format: "yaos-currentness-plane-measurement-v1",
		startedAt: new Date().toISOString(),
		host,
		schemaVersion: SCHEMA_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		bodyCount,
		bodyBytes: smallBodyBytes,
		deploymentVersion,
		accessTransport: accessClientId ? "service-token" : accessToken ? "authorization-cookie" : "none",
		cfRay: edgeProbe.headers.get("cf-ray"),
	};
	try {
		const seedStartedAt = performance.now();
		await seed(context.deviceA);
		report.seedMs = rounded(elapsed(seedStartedAt));
		console.log("Waiting 20 seconds for a deployed-runtime idle boundary...");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20_000));

		const idleResume = await runSequential(context.deviceB, [0]);
		report.idleResume = summarizeRaw(idleResume);
		console.log(`Idle-resume body sync: ${idleResume[0]!.syncMs} ms`);
		report.steadyHttpReads = {
			head: await measureHttpReads(context.deviceB, "head", Array.from({ length: 16 }, (_value, index) => index)),
			body: await measureHttpReads(context.deviceB, "body", Array.from({ length: 8 }, (_value, index) => index)),
		};

		const rootCurrentness = await connectDocument(context.deviceB, "root", "root");
		const bodyCurrentness = await connectDocument(context.deviceB, "body", bodyId(0));
		try {
			const currentnessQueries: Record<string, unknown> = {
				bodySelf: await measureProviderCurrentness(bodyCurrentness.provider, [bodyId(0)], 16),
			};
			const parallelHeads: Record<string, unknown> = {};
			for (const width of currentnessWidths) {
				const bodyIds = Array.from({ length: width }, (_value, index) => bodyId(index));
				currentnessQueries[`rootWidth${width}`] = await measureProviderCurrentness(
					rootCurrentness.provider,
					bodyIds,
					width >= 24 ? 8 : 16,
				);
				parallelHeads[String(width)] = await measureParallelHeads(
					context.deviceB,
					bodyIds,
					width >= 24 ? 4 : 8,
				);
			}
			report.currentnessQueries = currentnessQueries;
			report.parallelHeadReads = parallelHeads;
		} finally {
			bodyCurrentness.destroy();
			rootCurrentness.destroy();
		}
		const generations = await currentHeads(context.deviceB);
		const catchUp: Record<string, unknown> = {};
		for (const width of catchUpWidths) {
			const bodyIds = Array.from({ length: width }, (_value, index) => bodyId(index));
			catchUp[String(width)] = {
				stale: await measureCatchUp(context.deviceB, bodyIds, generations, false, 5),
				unchanged: await measureCatchUp(context.deviceB, bodyIds, generations, true, 5),
			};
		}
		report.conditionalCatchUp = catchUp;
		report.flushCompaction = await measureFlushCompaction(
			context.deviceA,
			context.deviceB,
			bodyId(bodyCount - 1),
		);

		const firstPass = await runSequential(context.deviceB, Array.from({ length: 16 }, (_value, index) => index));
		const repeatPass = await runSequential(context.deviceB, Array.from({ length: 16 }, (_value, index) => index));
		report.sequentialFirstPass = summarizeRaw(firstPass);
		report.sequentialRepeatPass = summarizeRaw(repeatPass);
		console.log(`Sequential first/repeat sync p50: ${distribution(firstPass.map((value) => value.syncMs)).p50}/${distribution(repeatPass.map((value) => value.syncMs)).p50} ms`);

		const parallel: Record<string, unknown> = {};
		for (const width of [1, 2, 4, 7]) {
			const trials = [];
			for (let trial = 0; trial < 4; trial++) {
				const start = (trial * 7) % 28;
				trials.push(await runParallel(context.deviceB, Array.from({ length: width }, (_value, offset) => start + offset)));
			}
			parallel[String(width)] = {
				wallMs: distribution(trials.map((trial) => trial.wallMs)),
				individual: summarizeRaw(trials.flatMap((trial) => trial.measurements)),
			};
			console.log(`Parallel width ${width} wall p50: ${distribution(trials.map((trial) => trial.wallMs)).p50} ms`);
		}
		report.parallel = parallel;

		const churnStartedAt = performance.now();
		const churn = await runSequential(context.deviceB, Array.from({ length: 40 }, (_value, index) => index % 20));
		report.switchChurn = { wallMs: rounded(elapsed(churnStartedAt)), ...summarizeRaw(churn) };
		console.log(`40-note switch churn: ${rounded(elapsed(churnStartedAt))} ms`);

		const saturationStartedAt = performance.now();
		const saturationSockets = await Promise.all(Array.from({ length: 32 }, (_value, index) =>
			openRawBody(context.deviceB, bodyId(index), bodyContent(index))));
		let thirtyThirdStatus: number | null = null;
		try {
			const unexpected = await openRawBody(context.deviceB, bodyId(32), bodyContent(32));
			await closeRaw(unexpected);
		} catch (error) {
			thirtyThirdStatus = typeof error === "object" && error !== null && "status" in error
				? Number((error as { status: unknown }).status)
				: null;
		}
		report.saturation = {
			open32WallMs: rounded(elapsed(saturationStartedAt)),
			open32: summarizeRaw(saturationSockets.map((value) => value.measurement)),
			thirtyThirdStatus,
			diagnostics: await serverDiagnostics(context.deviceA),
		};
		console.log(`Opened 32 deployed body sockets; 33rd status: ${String(thirtyThirdStatus)}`);
		await Promise.all(saturationSockets.map(closeRaw));

		const oneSocketPropagation = await propagationSamples(context.deviceA, context.deviceB, bodyId(39), [], 25);
		const sevenSocketPropagation = await propagationSamples(
			context.deviceA,
			context.deviceB,
			bodyId(39),
			Array.from({ length: 6 }, (_value, index) => bodyId(33 + index)),
			25,
		);
		report.propagation = {
			oneBodySocket: distribution(oneSocketPropagation),
			sevenDeviceBSockets: distribution(sevenSocketPropagation),
		};
		console.log(`Propagation p50 with 1/7 B sockets: ${distribution(oneSocketPropagation).p50}/${distribution(sevenSocketPropagation).p50} ms`);

		const catchUpBodyIds = Array.from({ length: 100 }, (_value, index) => bodyId(index));
		const oneSocketUnderCatchUp = await propagationDuringCatchUpSamples(
			context.deviceA,
			context.deviceB,
			bodyId(39),
			[],
			catchUpBodyIds,
			8,
		);
		const sevenSocketsUnderCatchUp = await propagationDuringCatchUpSamples(
			context.deviceA,
			context.deviceB,
			bodyId(39),
			Array.from({ length: 6 }, (_value, index) => bodyId(33 + index)),
			catchUpBodyIds,
			8,
		);
		report.catchUpContention = {
			oneBodySocket: {
				propagationMs: distribution(oneSocketUnderCatchUp.propagationMs),
				catchUpMs: distribution(oneSocketUnderCatchUp.catchUpMs),
				catchUpBytes: distribution(oneSocketUnderCatchUp.catchUpBytes),
			},
			sevenDeviceBSockets: {
				propagationMs: distribution(sevenSocketsUnderCatchUp.propagationMs),
				catchUpMs: distribution(sevenSocketsUnderCatchUp.catchUpMs),
				catchUpBytes: distribution(sevenSocketsUnderCatchUp.catchUpBytes),
			},
		};

		const sample = firstPass[0]!;
		report.livenessProjection = {
			currentPhysicalSockets: 8,
			idleIntervalMs: 60_000,
			applicationBytesPerSocketProbe: sample.pingPayloadBytes + sample.pongPayloadBytes,
			applicationBytesPerForegroundHourAtEightSockets: (sample.pingPayloadBytes + sample.pongPayloadBytes) * 8 * 60,
			probePairsPerForegroundHourAtEightSockets: 8 * 60,
		};
		report.finishedAt = new Date().toISOString();
		const serialized = `${JSON.stringify(report, null, 2)}\n`;
		console.log(serialized);
		if (outputPath) {
			const absolute = resolve(outputPath);
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, serialized, "utf8");
			console.log(`Wrote ${absolute}`);
		}
	} finally {
		await destroyVault(context);
		console.log("Destroyed benchmark vault and generation-scoped data.");
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
