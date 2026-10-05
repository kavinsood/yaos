import { strict as assert } from "node:assert";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { OverdueWorkClock } from "../../legacy-src/runtime/overdueWorkKernel";
import { fencedWebSocketConstructor } from "../../legacy-src/sync/fencedWebSocket";
import { OwnAwarenessProvider } from "../../legacy-src/sync/ownAwarenessProvider";
import { parseSyncFrame } from "../../legacy-src/sync/relayReceipts";
import { VaultSync, type ProviderFactoryInput, type SyncAwarenessPort, type SyncProviderPort } from "../../legacy-src/sync/vaultSync";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { FakeBulkCreateServer, memoryVault } from "./helpers/fakeBulkCreateServer.ts";

/**
 * Batch 3 (b3-bulk): D5 with relay v3 socket receipts. A bulk-created body has
 * no path -> id mapping until the create receipt, so no body session (and no
 * relay socket) can exist before it: edits made while the create is in flight
 * are held on device and go over HTTP only after the receipt. After the
 * receipt the body opens a relay socket and later edits settle from socket
 * receipts, with no HTTP candidate POST.
 */

installDomCrypto();
const s = suite("bulk-create-relay-receipts");

{
	const hostWindow = window as unknown as Record<string, unknown>;
	if (typeof hostWindow.addEventListener !== "function") hostWindow.addEventListener = () => {};
	if (typeof hostWindow.removeEventListener !== "function") hostWindow.removeEventListener = () => {};
}

const GENERATION = "generation-1";
const RELAY_HTTP_FALLBACK_MS = 15_000;
const CANDIDATE_DEBOUNCE_MS = 250;

interface TimerRecord {
	readonly id: number;
	readonly dueAt: number;
	readonly callback: () => void;
}

/** Same shape as vault-work-scheduler-integration: 0 ms timers run as microtasks. */
class FakeClock implements OverdueWorkClock {
	private time = 0;
	private sequence = 0;
	private readonly timers = new Map<number, TimerRecord>();
	now(): number { return this.time; }
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { id, dueAt: this.time + delayMs, callback });
		if (delayMs <= 0) {
			queueMicrotask(() => {
				const timer = this.timers.get(id);
				if (!timer || timer.dueAt > this.time) return;
				this.timers.delete(id);
				timer.callback();
			});
		}
		return id;
	}
	clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
	advance(ms: number): number {
		this.time += ms;
		const due = [...this.timers.values()]
			.filter((timer) => timer.dueAt <= this.time)
			.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
		for (const timer of due) {
			this.timers.delete(timer.id);
			timer.callback();
		}
		return due.length;
	}
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/** Browser-WebSocket double the test drives as the relay server. */
class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeSocket[] = [];
	readyState = 0;
	binaryType = "arraybuffer";
	readonly sent: Array<string | Uint8Array> = [];
	private readonly listeners = new Map<string, Set<Listener>>();
	constructor(readonly url: string) { FakeSocket.instances.push(this); }
	addEventListener(type: string, listener: Listener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
	dispatchEvent(): boolean { return true; }
	send(data: string | ArrayBufferLike | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error("socket not open");
		if (typeof data === "string") this.sent.push(data);
		else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
		else this.sent.push(new Uint8Array(data as ArrayBuffer).slice());
	}
	close(code = 1000, reason = ""): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.emit("close", { code, reason });
	}
	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}
	receive(data: string | Uint8Array): void {
		this.emit("message", { data: typeof data === "string" ? data : data.slice().buffer });
	}
	private emit(type: string, event: { data?: unknown; code?: number; reason?: string }): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
	}
}

function syncFrame(sync: number, payload: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0);
	encoding.writeVarUint(encoder, sync);
	encoding.writeVarUint8Array(encoder, payload);
	return encoding.toUint8Array(encoder);
}

/** BODY_UPDATE_ENVELOPE frames the client sent, from index `from`. */
function envelopes(socket: FakeSocket, from = 0): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const data of socket.sent.slice(from)) {
		if (typeof data !== "string" || !data.startsWith("__YPS:")) continue;
		const value = JSON.parse(data.slice("__YPS:".length)) as Record<string, unknown>;
		if (value.type === "BODY_UPDATE_ENVELOPE") out.push(value);
	}
	return out;
}

function clientStep1(socket: FakeSocket): Uint8Array | null {
	for (const data of socket.sent) {
		if (typeof data === "string") continue;
		const parsed = parseSyncFrame(data);
		if (parsed.type !== 0 || parsed.sync !== 0) continue;
		const decoder = decoding.createDecoder(data);
		decoding.readVarUint(decoder);
		decoding.readVarUint(decoder);
		return decoding.readVarUint8Array(decoder);
	}
	return null;
}

/** Same adapter as vaultSync.ts adaptProvider (not exported). */
function adapt(provider: OwnAwarenessProvider): SyncProviderPort {
	return {
		get awareness() { return provider.awareness; },
		get documentOrigin() { return provider; },
		get wsconnected() { return provider.wsconnected; },
		get wsconnecting() { return provider.wsconnecting; },
		get synced() { return provider.synced; },
		get ws() { return provider.ws; },
		get url() { return provider.url; },
		set url(value: string) { provider.url = value; },
		connect: () => provider.connect(),
		disconnect: () => provider.disconnect(),
		destroy: () => provider.destroy(),
		sendMessage: (message) => provider.sendMessage(message),
		on: ((event: string, callback: (...values: never[]) => void) =>
			provider.on(event, callback)) as SyncProviderPort["on"],
		off: (event, callback) => provider.off(event, callback),
	};
}

/** Root provider that never connects: the body socket is what matters here. */
function idleRootProvider(): SyncProviderPort {
	return partialOf<SyncProviderPort>({
		awareness: partialOf<SyncAwarenessPort>({
			setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map(),
		}),
		documentOrigin: {},
		ws: null,
		wsconnected: false,
		wsconnecting: false,
		synced: false,
		url: "ws://test/root",
		connect: () => {},
		disconnect: () => {},
		destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
}


s.test("D5 + relay3: no body socket before the create receipt; held edit goes HTTP after it; later edits settle from socket receipts", async () => {
	FakeSocket.instances = [];
	const clock = new FakeClock();
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	let generation = 2;
	const providers: OwnAwarenessProvider[] = [];
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: GENERATION, deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database,
		server: server.port({
			currentHead: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation }),
			currentBody: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation,
				encodedState: Y.encodeStateAsUpdate(server.bodies.get(bodyId)!) }),
		}),
		createCollectorDelayMs: 0,
		candidateDebounceMs: CANDIDATE_DEBOUNCE_MS,
		bodySyncTimeoutMs: 10_000,
		workClock: clock,
		workRandom: { next: () => 0.5 },
		providerFactory: (input: ProviderFactoryInput) => {
			if (input.kind !== "body") return idleRootProvider();
			const provider = new OwnAwarenessProvider("relay.test", input.documentId, input.doc, {
				connect: false, disableBc: true, maxBackoffTime: 60_000,
				WebSocketPolyfill: fencedWebSocketConstructor(FakeSocket as unknown as typeof WebSocket, input.onClose, input.socketTap),
			});
			providers.push(provider);
			return adapt(provider);
		},
	});
	const settle = async () => { for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0)); };
	const advance = async (ms: number, step = 250) => {
		for (let elapsed = 0; elapsed < ms; elapsed += step) { clock.advance(Math.min(step, ms - elapsed)); await settle(); }
	};
	try {
		server.hold();
		const created = runtime.commitFreshBody({ bodyId: "body-note", path: "note.md", content: "v1",
			candidateId: "candidate-note", reason: "test" });
		await until(() => server.calls.length === 1, { timeoutMs: 2_000, intervalMs: 1, message: "bulk request in flight" });
		// Before the receipt: no catalog entry, so no editor session and no relay socket can open.
		assert.ok(!runtime.getFileId("note.md"), "no path -> id before the create receipt");
		await assert.rejects(runtime.acquireEditorBody("note.md", "editor-early"), /no active body/);
		assert.equal(FakeSocket.instances.length, 0, "no body socket before the create receipt");
		const edited = runtime.commitFreshBody({ bodyId: "ignored", path: "note.md", content: "v1 then v2",
			candidateId: "ignored", reason: "test" });
		await runtime.retryPendingCandidates();
		await settle();
		assert.equal(server.candidateCalls, 0, "D5 hold: no candidate before its file");
		server.release();
		await Promise.all([created, edited]);
		assert.deepEqual(server.events, ["bulk:note.md", "candidate:body-note"], "held edit sent once, after the receipt");
		assert.equal(server.bodyText("body-note"), "v1 then v2");
		assert.equal(runtime.getFileId("note.md"), "body-note");

		// After the receipt: the editor opens a relay socket.
		const serverDoc = server.bodies.get("body-note")!;
		const acquire = runtime.acquireEditorBody("note.md", "editor-1");
		await until(() => FakeSocket.instances.length > 0, { timeoutMs: 2_000, intervalMs: 0, message: "body socket" });
		const socket = FakeSocket.instances[0]!;
		socket.open();
		socket.receive(syncFrame(0, Y.encodeStateVector(serverDoc)));
		await until(() => clientStep1(socket) !== null, { timeoutMs: 2_000, intervalMs: 0, message: "client step1" });
		socket.receive(syncFrame(1, Y.encodeStateAsUpdate(serverDoc, clientStep1(socket)!)));
		socket.receive(`__YPS:${JSON.stringify({
			type: "VAULT_READY", documentId: "body-note", documentEpoch: 1, socketSessionId: "socket-1",
			vaultGeneration: GENERATION, durableGeneration: generation, runtimeEpoch: "runtime-1",
			liveness: { version: 1, idleMs: 60_000, timeoutMs: 15_000 }, capabilities: { relayBodies: 2 },
		})}`);
		await acquire;
		assert.equal(runtime.getRelayReceiptDiagnostics("body-note")?.relayActive, true);
		const sentAfterOpen = socket.sent.length;
		const text = runtime.getTextForPath("note.md")!;
		text.insert(text.length, " v3");
		const sent = envelopes(socket, sentAfterOpen);
		assert.ok(sent.length >= 1, "the first post-create edit is relayed enveloped");
		await advance(CANDIDATE_DEBOUNCE_MS + 50);
		assert.equal(server.candidateCalls, 1, "deferred: no HTTP while relay receipts are active");
		const last = sent.at(-1)!;
		socket.receive(`__YPS:${JSON.stringify({
			type: "BODY_COMMITTED", bodyId: "body-note", bodyEpoch: 1, vaultGeneration: GENERATION,
			durableGeneration: ++generation, vaultSequence: 10, lifecycle: "active", contentHash: null, size: null,
			runtimeEpoch: "runtime-1", relay: true, clientFrameId: last.clientFrameId, payloadDigest: last.payloadDigest,
			commitRuntimeEpoch: "runtime-1", contentHashAccepted: false, deduped: false, noop: false,
		})}`);
		await until(() => !runtime.hasUnconfirmedServerReceiptCandidate, { timeoutMs: 2_000, intervalMs: 0, message: "relay settlement" });
		await advance(RELAY_HTTP_FALLBACK_MS + 1_000, 1_000);
		assert.equal(server.candidateCalls, 1, "settled from the socket receipt: no HTTP fallback");
	} finally {
		await runtime.destroy();
		for (const provider of providers) provider.destroy();
	}
});

await s.done();
