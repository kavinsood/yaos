import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { describeFatalFrame, onFatalFrame } from "./fatalFrame.ts";
import {
	deviceBearerHeaders,
	fetchSocketTicket,
	requireLiveIdentity,
} from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const HOST = identity.host;
const ROOM_ID = identity.vaultId;

const CONNECTION_WAIT_MS = 5_000;
const TICKET_START_MARGIN_MS = 1_000;

/** sv-echo send counters the Worker publishes on `GET /debug/recent`. */
interface SvEchoCounters {
	readonly baselineSent?: number;
	readonly postApplySent?: number;
}

/** The subset of `GET /debug/recent` this suite asserts on. */
interface DebugPayload {
	readonly svEcho?: SvEchoCounters;
}

/** The sv-echo control frame the Worker pushes over the y-partyserver channel. */
interface SvEchoFrame {
	readonly type?: string;
	readonly schema?: number;
	readonly sv?: unknown;
}

/** What withProvider() hands to a test body. */
interface ProviderContext {
	readonly ydoc: Y.Doc;
	readonly provider: YSyncProvider;
	readonly getStatusEvents: () => number;
	readonly getSvEchoes: () => Uint8Array[];
}

function wait(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function freshSocketParams(label: string): Promise<Record<string, string>> {
	const { ticket, expiresAt } = await fetchSocketTicket(identity);
	const validityMs = expiresAt - Date.now();
	const minimumValidityMs = CONNECTION_WAIT_MS + TICKET_START_MARGIN_MS;
	if (validityMs < minimumValidityMs) {
		throw new Error(
			`${label}: fresh ticket has ${validityMs}ms validity; ${minimumValidityMs}ms required before connect`,
		);
	}
	return { ticket, schemaVersion: String(SCHEMA_VERSION) };
}

async function getDebugPayload(): Promise<DebugPayload | string | null> {
	const res = await fetch(`${HOST}/vault/${encodeURIComponent(ROOM_ID)}/debug/recent`, {
		headers: deviceBearerHeaders(identity),
	});
	const text = await res.text();
	let payload: DebugPayload | string | null = null;
	try {
		payload = text ? (JSON.parse(text) as DebugPayload) : null;
	} catch {
		payload = text;
	}
	if (!res.ok) {
		throw new Error(`debug fetch failed (${res.status}): ${text}`);
	}
	return payload;
}

/** Counters from a debug body, or none when the Worker did not answer with JSON. */
function svEchoCounters(payload: DebugPayload | string | null): SvEchoCounters {
	return payload === null || typeof payload === "string" ? {} : payload.svEcho ?? {};
}

function parseSvEchoMessage(payload: string): Uint8Array | null {
	let parsed: SvEchoFrame | null;
	try {
		parsed = JSON.parse(payload) as SvEchoFrame | null;
	} catch {
		return null;
	}
	if (parsed?.type !== "yaos/sv-echo" || parsed?.schema !== 1 || typeof parsed?.sv !== "string") {
		return null;
	}
	try {
		const binary = atob(parsed.sv);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		Y.decodeStateVector(bytes);
		return bytes;
	} catch {
		return null;
	}
}

function isStateVectorGe(a: Uint8Array, b: Uint8Array): boolean {
	try {
		const svA = Y.decodeStateVector(a);
		const svB = Y.decodeStateVector(b);
		for (const [clientId, clock] of svB) {
			if ((svA.get(clientId) ?? 0) < clock) return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function safeDestroy(provider: YSyncProvider, ydoc: Y.Doc): Promise<void> {
	// Force terminate the WebSocket to skip the 30s close handshake timeout in "ws" library.
	// Only the "ws" implementation can be terminated; when Node supplies a global
	// WebSocket the provider uses that one and there is nothing to force-close.
	const ws = provider.ws;
	if (ws instanceof WebSocket) {
		ws.terminate();
	}

	// Ensure Awareness interval is cleared (using public API).
	if (provider.awareness) {
		provider.awareness.destroy();
	}

	const capturedDuringTeardown = new Set<NodeJS.Timeout>();
	const originalSetTimeout = globalThis.setTimeout;
	const originalGlobalSetTimeout = global.setTimeout;
	// lib.dom and @types/node both declare setTimeout, so the global's type is
	// the union of their overloads: a replacement has to satisfy the
	// number-returning DOM signature as well as the Timeout-returning Node one,
	// and carry Node's util.promisify hook.
	function patchedSetTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): number;
	function patchedSetTimeout<TArgs extends unknown[]>(
		callback: (...cbArgs: TArgs) => void,
		ms?: number,
		...args: TArgs
	): NodeJS.Timeout;
	function patchedSetTimeout(
		callback: (...cbArgs: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	): NodeJS.Timeout | number {
		const handle = originalSetTimeout(callback, ms, ...args);
		if (ms !== undefined && ms > 0) {
			capturedDuringTeardown.add(handle);
		}
		return handle;
	}
	const patched = Object.assign(patchedSetTimeout, {
		__promisify__: originalSetTimeout.__promisify__,
	});
	globalThis.setTimeout = patched;
	global.setTimeout = patched;

	provider.destroy();
	if (ydoc) ydoc.destroy();

	// Give a few ticks for any post-close logic (like reconnect timers)
	await new Promise<void>((r) => originalSetTimeout(r, 100));

	globalThis.setTimeout = originalSetTimeout;
	global.setTimeout = originalGlobalSetTimeout;

	for (const h of capturedDuringTeardown) {
		clearTimeout(h);
	}
}

async function withProvider(
	label: string,
	callback: (context: ProviderContext) => Promise<void>,
): Promise<void> {
	const ydoc = new Y.Doc();
	const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
		prefix: `/vault/sync/${encodeURIComponent(ROOM_ID)}`,
		// YSyncProvider awaits params before every connect and rebuilds its URL,
		// so the explicit reconnect below cannot reuse the previous ticket.
		params: () => freshSocketParams(label),
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 500,
	});

	let statusEvents = 0;
	let customHandlersReady = false;
	const svEchoes: Uint8Array[] = [];
	provider.on("custom-message", (payload: string) => {
		if (!customHandlersReady) throw new Error(`${label}: custom-message before handler readiness marker`);
		const sv = parseSvEchoMessage(payload);
		if (sv) svEchoes.push(sv);
	});
	provider.on("status", () => {
		statusEvents++;
	});
	customHandlersReady = true;

	try {
		await callback({ ydoc, provider, getStatusEvents: () => statusEvents, getSvEchoes: () => svEchoes.slice() });
	} finally {
		await safeDestroy(provider, ydoc);
	}
}

async function waitForSync(provider: YSyncProvider, label: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for sync`));
		}, CONNECTION_WAIT_MS);

		// Fatal rejections arrive as "custom-message", not "message" — the
		// provider has no "message" event at all (see ./fatalFrame.ts).
		onFatalFrame(provider, (frame) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(new Error(`${label}: server rejected the connection: ${describeFatalFrame(frame)}`));
		});

		provider.on("sync", (synced: boolean) => {
			if (!synced || settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
		void provider.connect().catch((error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error instanceof Error ? error : new Error(`${label}: connect failed: ${String(error)}`));
		});
	});
}

async function waitForConnected(provider: YSyncProvider, label: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		if (provider.wsconnected) {
			resolve(undefined);
			return;
		}
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`${label}: timed out waiting for connected status`));
		}, CONNECTION_WAIT_MS);
		provider.on("status", (event: { status: string }) => {
			if (settled || event.status !== "connected") return;
			settled = true;
			clearTimeout(timeout);
			resolve(undefined);
		});
		void provider.connect().catch((error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error instanceof Error ? error : new Error(`${label}: connect failed: ${String(error)}`));
		});
	});
}

async function waitForSvEcho(
	getSvEchoes: () => Uint8Array[],
	label: string,
	minCount = 1,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (getSvEchoes().length >= minCount) return;
		await wait(50);
	}
	throw new Error(`${label}: timed out waiting for sv-echo custom-message`);
}

async function waitForDominatingSvEcho(
	getSvEchoes: () => Uint8Array[],
	candidateSv: Uint8Array,
	label: string,
	minCount = 1,
): Promise<Uint8Array> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const echoes = getSvEchoes();
		if (echoes.length >= minCount) {
			const dominating = echoes.find((sv) => isStateVectorGe(sv, candidateSv));
			if (dominating) return dominating;
		}
		await wait(50);
	}
	throw new Error(`${label}: timed out waiting for dominating sv-echo custom-message`);
}

async function main() {
	console.log(`Provider manual-connect smoke room: ${ROOM_ID}`);
	let writtenCandidateSv: Uint8Array | null = null;

	await withProvider("initial connect", async ({ ydoc, provider, getSvEchoes }) => {
		await waitForSync(provider, "initial connect");
		await waitForSvEcho(getSvEchoes, "initial connect baseline echo");
		const baselineEchoCount = getSvEchoes().length;
		const sys = ydoc.getMap("sys");
		sys.set("initialized", true);
		sys.set("schemaVersion", SCHEMA_VERSION);
		const text = ydoc.getText("manual-connect");
		text.insert(0, "manual connect smoke");
		writtenCandidateSv = Y.encodeStateVector(ydoc);
		await waitForDominatingSvEcho(
			getSvEchoes,
			writtenCandidateSv,
			"initial connect postApply echo",
			baselineEchoCount + 1,
		);
		const debug = svEchoCounters(await getDebugPayload());
		if ((debug.baselineSent ?? 0) < 1) {
			throw new Error("initial connect: server debug did not count baseline sv-echo");
		}
		if ((debug.postApplySent ?? 0) < 1) {
			throw new Error("initial connect: server debug did not count postApply sv-echo");
		}
		console.log("Initial manual connect synced, received baseline sv-echo, wrote state, and received dominating postApply sv-echo");
	});

	await withProvider("reconnect", async ({ ydoc, provider, getSvEchoes }) => {
		await waitForSync(provider, "reconnect first sync");
		await waitForSvEcho(getSvEchoes, "reconnect first baseline echo");
		const candidateSv = writtenCandidateSv;
		if (candidateSv && !getSvEchoes().some((sv) => isStateVectorGe(sv, candidateSv))) {
			throw new Error("reconnect: baseline sv-echo did not dominate initial written candidate");
		}
		const debug = svEchoCounters(await getDebugPayload());
		if ((debug.baselineSent ?? 0) < 2) {
			throw new Error("reconnect: server debug did not count fresh baseline sv-echo");
		}
		provider.disconnect();
		await wait(500);
		await waitForConnected(provider, "reconnect second connect");
		if (ydoc.getText("manual-connect").toString() !== "manual connect smoke") {
			throw new Error("reconnect: seeded text was not observed after reconnect");
		}
		console.log("Manual reconnect synced existing state; fresh provider received baseline sv-echo");
	});
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
