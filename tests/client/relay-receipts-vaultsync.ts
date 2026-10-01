import { strict as assert } from "node:assert";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { OverdueWorkClock } from "../../src/runtime/overdueWorkKernel";
import { fencedWebSocketConstructor } from "../../src/sync/fencedWebSocket";
import { OwnAwarenessProvider } from "../../src/sync/ownAwarenessProvider";
import { parseSyncFrame } from "../../src/sync/relayReceipts";
import {
	VaultSync,
	type BodyReceipt,
	type CandidateRecord,
	type ProviderFactoryInput,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

/**
 * VaultSync-level relay receipt behaviour (commit 7d70ea9): a body socket that
 * advertises `relayBodies: 2` settles local candidates from socket receipts,
 * with the HTTP candidate POST only as a fallback (15 s without a receipt, the
 * socket closing, or a note closing without a receipt within 3 s).
 *
 * The body provider is the production OwnAwarenessProvider over a
 * fencedWebSocketConstructor(FakeSocket, onClose, input.socketTap), so every
 * frame goes through VaultSync's real RelayReceiptChannel.
 */

installDomCrypto();
const s = suite("relay-receipts-vaultsync");

// y-partyserver registers window unload/online listeners; the Node host window
// has no event target. Each suite runs in its own process.
{
	const hostWindow = window as unknown as Record<string, unknown>;
	if (typeof hostWindow.addEventListener !== "function") hostWindow.addEventListener = () => {};
	if (typeof hostWindow.removeEventListener !== "function") hostWindow.removeEventListener = () => {};
}

const VAULT_ID = "vault-relay";
const GENERATION = "generation-relay";
const DEVICE_ID = "device-relay";
const BODY_ID = "body-relay";
const PATH = "Relay.md";
const INITIAL = "hello";
/** Mirrors vaultSync.ts RELAY_HTTP_FALLBACK_MS / RELAY_SETTLE_WAIT_MS (not exported). */
const RELAY_HTTP_FALLBACK_MS = 15_000;
const RELAY_SETTLE_WAIT_MS = 3_000;
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

function receipt(socket: FakeSocket, envelope: Record<string, unknown>, durableGeneration: number): void {
	socket.receive(`__YPS:${JSON.stringify({
		type: "BODY_COMMITTED", bodyId: BODY_ID, bodyEpoch: 1, vaultGeneration: GENERATION, durableGeneration,
		vaultSequence: durableGeneration, lifecycle: "active", contentHash: null, size: null,
		runtimeEpoch: "runtime-1", relay: true, clientFrameId: envelope.clientFrameId,
		payloadDigest: envelope.payloadDigest, commitRuntimeEpoch: "runtime-2", contentHashAccepted: false,
		deduped: false, noop: false,
	})}`);
}

function storedBody(content: string): { document: StoredDocument; update: Uint8Array } {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getText("body").insert(0, content);
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return {
		update,
		document: {
			kind: "body", documentId: BODY_ID, bodyEpoch: 1, durableBaseline: content,
			generation: 1, encodedState: update.slice().buffer, dirty: false, updatedAt: 0,
		},
	};
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

interface Harness {
	clock: FakeClock;
	runtime: VaultSync;
	socket: FakeSocket;
	submissions: CandidateRecord[];
	candidates: Map<string, CandidateRecord>;
	logs: string[];
	sentAfterOpen: number;
	edit(text: string): void;
	settle(): Promise<void>;
	pendingCount(): number;
	destroy(): Promise<void>;
}

async function harness(): Promise<Harness> {
	FakeSocket.instances = [];
	const clock = new FakeClock();
	const { document, update } = storedBody(INITIAL);
	const documents = new Map<string, StoredDocument>([[BODY_ID, document]]);
	const candidates = new Map<string, CandidateRecord>();
	const database: VaultDatabasePort = {
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (stored) => { documents.set(stored.documentId, stored); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => ({ ...operation, localSequence: operation.localSequence || 1 }),
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	};
	const submissions: CandidateRecord[] = [];
	let durable = 1;
	const server = partialOf<VaultServerPort>({
		currentHead: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation: 1 }),
		currentBody: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation: 1, encodedState: update }),
		submitCandidate: async (record): Promise<BodyReceipt> => {
			submissions.push(record);
			return {
				vaultId: VAULT_ID, vaultGeneration: GENERATION, bodyId: record.bodyId, bodyEpoch: record.bodyEpoch,
				clientId: DEVICE_ID, candidateId: record.candidateId, candidateDigest: record.candidateDigest,
				durableGeneration: ++durable, runtimeEpoch: "runtime-1",
			};
		},
	});
	const providers: OwnAwarenessProvider[] = [];
	const logs: string[] = [];
	const runtime = new VaultSync({
		vaultId: VAULT_ID,
		vaultGeneration: GENERATION,
		deviceId: DEVICE_ID,
		host: "https://sync.test",
		token: "token",
		database,
		server,
		candidateDebounceMs: CANDIDATE_DEBOUNCE_MS,
		bodySyncTimeoutMs: 10_000,
		workClock: clock,
		workRandom: { next: () => 0.5 },
		log: (message) => logs.push(message),
		providerFactory: (input: ProviderFactoryInput) => {
			if (input.kind !== "body") return idleRootProvider();
			assert.ok(input.socketTap, "body sessions pass the relay socket tap");
			const provider = new OwnAwarenessProvider("relay.test", input.documentId, input.doc, {
				connect: false,
				disableBc: true,
				maxBackoffTime: 60_000,
				WebSocketPolyfill: fencedWebSocketConstructor(FakeSocket as unknown as typeof WebSocket,
					input.onClose, input.socketTap),
			});
			providers.push(provider);
			return adapt(provider);
		},
	});
	runtime.ydoc.transact(() => runtime.pathToId.set(PATH, BODY_ID), "test");

	// Server side of the body socket: same content as the stored body.
	const serverDoc = new Y.Doc({ guid: BODY_ID });
	Y.applyUpdate(serverDoc, update);

	const acquire = runtime.acquireEditorBody(PATH, "editor-1");
	await until(() => FakeSocket.instances.length > 0, { timeoutMs: 2_000, intervalMs: 0, message: "body socket" });
	const socket = FakeSocket.instances[0]!;
	socket.open();
	// Server step1 first (as the relay accept path does), then step2, then VAULT_READY.
	socket.receive(syncFrame(0, Y.encodeStateVector(serverDoc)));
	await until(() => clientStep1(socket) !== null, { timeoutMs: 2_000, intervalMs: 0, message: "client step1" });
	socket.receive(syncFrame(1, Y.encodeStateAsUpdate(serverDoc, clientStep1(socket)!)));
	socket.receive(`__YPS:${JSON.stringify({
		type: "VAULT_READY", documentId: BODY_ID, documentEpoch: 1, socketSessionId: "socket-1",
		vaultGeneration: GENERATION, durableGeneration: 1, runtimeEpoch: "runtime-1",
		liveness: { version: 1, idleMs: 60_000, timeoutMs: 15_000 },
		capabilities: { relayBodies: 2 },
	})}`);
	serverDoc.destroy();
	await acquire;
	assert.equal(runtime.getRelayReceiptDiagnostics(BODY_ID)?.relayActive, true, "relay receipts active after VAULT_READY");
	const sentAfterOpen = socket.sent.length;

	const flush = async () => {
		for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return {
		clock, runtime, socket, submissions, candidates, logs, sentAfterOpen,
		edit(text: string) {
			const ytext = runtime.getTextForPath(PATH);
			if (!ytext) throw new Error("body text unavailable");
			ytext.insert(ytext.length, text);
		},
		settle: flush,
		pendingCount: () => (runtime.hasUnconfirmedServerReceiptCandidate ? Math.max(1, candidates.size) : 0),
		async destroy() {
			await runtime.destroy();
			for (const provider of providers) provider.destroy();
		},
	};
}

/** Advances the fake clock and lets the async work it starts run. */
async function advance(h: Harness, ms: number, step = 250): Promise<void> {
	for (let elapsed = 0; elapsed < ms; elapsed += step) {
		h.clock.advance(Math.min(step, ms - elapsed));
		await h.settle();
	}
}

s.test("a local edit settles from the relay receipt without an HTTP candidate POST", async () => {
	const h = await harness();
	try {
		h.edit(" world");
		const sent = envelopes(h.socket, h.sentAfterOpen);
		// The edit, plus the frontmatter semantic mirror's follow-up write in
		// the same body doc: each local transaction is its own enveloped frame.
		assert.ok(sent.length >= 1, "the edit was sent enveloped");
		for (const envelope of sent) {
			assert.equal(envelope.bodyId, BODY_ID);
			assert.equal(envelope.frameKind, "update");
		}
		// Let the candidate debounce capture it while the receipt is outstanding.
		await advance(h, CANDIDATE_DEBOUNCE_MS + 50);
		assert.equal(h.pendingCount(), 1, "a candidate was captured");
		assert.equal(h.candidates.size, 1, "and persisted");
		assert.equal(h.submissions.length, 0, "deferred: no HTTP while relay receipts are active");
		receipt(h.socket, sent.at(-1)!, 2);
		await until(() => h.pendingCount() === 0, { timeoutMs: 2_000, intervalMs: 0, message: "relay settlement" });
		assert.equal(h.candidates.size, 0, "persisted candidate removed");
		assert.equal(h.runtime.getRelayReceiptDiagnostics(BODY_ID)?.confirmedSeq,
			h.runtime.getRelayReceiptDiagnostics(BODY_ID)?.localSeq);
		// Nothing fires later: no fallback POST once settled.
		await advance(h, RELAY_HTTP_FALLBACK_MS + 1_000, 1_000);
		assert.equal(h.submissions.length, 0, "no HTTP candidate submission");
		assert.equal(h.runtime.bodies.get(BODY_ID)?.unsettled, 0, "body settled");
	} finally { await h.destroy(); }
});

s.test("a receipt that arrives before the candidate is captured still settles it without HTTP", async () => {
	const h = await harness();
	try {
		h.edit("!");
		const sent = envelopes(h.socket, h.sentAfterOpen);
		receipt(h.socket, sent.at(-1)!, 2);
		await advance(h, CANDIDATE_DEBOUNCE_MS + 50);
		await until(() => h.pendingCount() === 0, { timeoutMs: 2_000, intervalMs: 0, message: "relay settlement" });
		await advance(h, RELAY_HTTP_FALLBACK_MS + 1_000, 1_000);
		assert.equal(h.submissions.length, 0);
	} finally { await h.destroy(); }
});

s.test("without a receipt the HTTP fallback posts after RELAY_HTTP_FALLBACK_MS", async () => {
	const h = await harness();
	try {
		h.edit(" lost");
		await advance(h, CANDIDATE_DEBOUNCE_MS + 50);
		assert.equal(h.pendingCount(), 1);
		const capturedAt = h.clock.now();
		// Just before the fallback deadline: still deferred (the channel re-sends meanwhile).
		await advance(h, RELAY_HTTP_FALLBACK_MS - 1_000, 500);
		assert.equal(h.submissions.length, 0, "no HTTP before the fallback deadline");
		assert.ok((h.runtime.getRelayReceiptDiagnostics(BODY_ID)?.resends.timeout ?? 0) >= 1,
			"the channel re-sent the unconfirmed update meanwhile");
		await advance(h, 2_000, 250);
		await until(() => h.submissions.length === 1, { timeoutMs: 2_000, intervalMs: 0, message: "fallback POST" });
		assert.ok(h.clock.now() - capturedAt >= RELAY_HTTP_FALLBACK_MS - CANDIDATE_DEBOUNCE_MS);
		await until(() => h.pendingCount() === 0, { timeoutMs: 2_000, intervalMs: 0, message: "HTTP settlement" });
		assert.equal(h.candidates.size, 0);
		assert.ok(h.logs.some((line) => line.includes("relay receipt fallback")), "fallback logged");
	} finally { await h.destroy(); }
});

s.test("without a receipt the HTTP fallback posts promptly when the relay socket closes", async () => {
	const h = await harness();
	try {
		h.edit(" closed");
		await advance(h, CANDIDATE_DEBOUNCE_MS + 50);
		assert.equal(h.pendingCount(), 1);
		assert.equal(h.submissions.length, 0);
		const closedAt = h.clock.now();
		h.socket.close(1006, "abnormal");
		assert.equal(h.runtime.getRelayReceiptDiagnostics(BODY_ID)?.relayActive, false);
		await advance(h, 1_000, 100);
		await until(() => h.submissions.length >= 1, { timeoutMs: 2_000, intervalMs: 0, message: "close fallback POST" });
		assert.ok(h.clock.now() - closedAt <= 1_000, "posted well before the 15 s fallback");
		await until(() => h.pendingCount() === 0, { timeoutMs: 2_000, intervalMs: 0, message: "HTTP settlement" });
		assert.equal(h.submissions.length, 1, "exactly one HTTP POST");
	} finally { await h.destroy(); }
});

s.test("a receipt 1.5 s late is not a failure: no HTTP and no re-sent frame", async () => {
	const h = await harness();
	try {
		h.edit(" late");
		const sent = envelopes(h.socket, h.sentAfterOpen);
		assert.ok(sent.length >= 1);
		await advance(h, 1_500, 250);
		assert.equal(h.pendingCount(), 1, "candidate captured and still deferred");
		assert.equal(h.submissions.length, 0);
		assert.equal(envelopes(h.socket, h.sentAfterOpen).length, sent.length, "no re-send before the receipt");
		receipt(h.socket, sent.at(-1)!, 2);
		await until(() => h.pendingCount() === 0, { timeoutMs: 2_000, intervalMs: 0, message: "relay settlement" });
		await advance(h, RELAY_HTTP_FALLBACK_MS * 2, 1_000);
		assert.equal(h.submissions.length, 0, "no HTTP candidate submission");
		assert.equal(envelopes(h.socket, h.sentAfterOpen).length, sent.length, "no re-sent frame after the receipt");
		const diagnostics = h.runtime.getRelayReceiptDiagnostics(BODY_ID)!;
		assert.equal(diagnostics.resends.timeout, 0);
		assert.equal(diagnostics.receipts, 1);
	} finally { await h.destroy(); }
});

s.test("settleBodyOnClose waits for a receipt within 3 s and then does not POST", async () => {
	const h = await harness();
	try {
		h.edit(" close");
		const sent = envelopes(h.socket, h.sentAfterOpen);
		h.runtime.releaseEditorBody(PATH, "editor-1");
		assert.equal(h.runtime.isBodyOpen(BODY_ID), false);
		let settled = false;
		let failure: unknown = null;
		const settling = h.runtime.settleBodyOnClose(BODY_ID).then(() => { settled = true; }, (error) => { failure = error; });
		await h.settle();
		assert.equal(h.pendingCount(), 1, "close captured the candidate");
		await advance(h, 1_000, 250);
		assert.equal(settled, false, "close is waiting for the relay receipt");
		assert.equal(h.submissions.length, 0);
		receipt(h.socket, sent.at(-1)!, 2);
		await until(() => settled || failure !== null, { timeoutMs: 2_000, intervalMs: 0, message: "close settles" });
		await settling;
		assert.equal(failure, null, `settleBodyOnClose failed: ${String(failure)}`);
		assert.equal(h.pendingCount(), 0);
		assert.ok(h.clock.now() < RELAY_SETTLE_WAIT_MS + CANDIDATE_DEBOUNCE_MS + 1_000);
		await advance(h, RELAY_HTTP_FALLBACK_MS + 1_000, 1_000);
		assert.equal(h.submissions.length, 0, "no HTTP candidate submission");
	} finally { await h.destroy(); }
});

s.test("settleBodyOnClose without a receipt falls back to HTTP after 3 s", async () => {
	const h = await harness();
	try {
		h.edit(" unconfirmed");
		h.runtime.releaseEditorBody(PATH, "editor-1");
		let settled = false;
		let failure: unknown = null;
		const startedAt = h.clock.now();
		const settling = h.runtime.settleBodyOnClose(BODY_ID).then(() => { settled = true; }, (error) => { failure = error; });
		await h.settle();
		await advance(h, RELAY_SETTLE_WAIT_MS - 500, 250);
		assert.equal(h.submissions.length, 0, "no HTTP while the 3 s wait runs");
		assert.equal(settled, false);
		await advance(h, 1_000, 250);
		await until(() => settled || failure !== null, { timeoutMs: 2_000, intervalMs: 0, message: "close settles" });
		await settling;
		assert.equal(failure, null, `settleBodyOnClose failed: ${String(failure)}`);
		assert.equal(h.submissions.length, 1, "one HTTP POST after the wait");
		assert.ok(h.clock.now() - startedAt >= RELAY_SETTLE_WAIT_MS);
		assert.equal(h.pendingCount(), 0);
	} finally { await h.destroy(); }
});

await s.done();
