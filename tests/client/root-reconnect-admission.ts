import { strict as assert } from "node:assert";
import * as Y from "yjs";
import type { OverdueWorkClock } from "../../legacy-src/runtime/overdueWorkKernel";
import {
	VaultSync,
	type ProviderFactory,
	type SocketTicketResult,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../legacy-src/sync/vaultSync";
import type { StoredDocument } from "../../legacy-src/sync/vaultIndexedDb";
import { SOCKET_CONTROL_CAPABILITIES, SOCKET_LIVENESS_DESCRIPTOR } from "../../legacy-src/shared/socketLiveness";
import { ConnectionController } from "../../legacy-src/runtime/connectionController";
import { VaultWorkScheduler } from "../../legacy-src/sync/vaultWorkScheduler";
import { sleep, suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("root-reconnect-admission");

/**
 * Provider double with y-partyserver's transport semantics: `connect()` is a
 * silent no-op while the previous socket has not finished closing, and the
 * `disconnected` status is only published for a socket that was connected.
 */
class ModelProvider implements SyncProviderPort {
	readonly awareness = partialOf<SyncAwarenessPort>({
		setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map(),
	});
	readonly documentOrigin = {};
	url = "ws://test/model?ticket=initial";
	wsconnected = false;
	wsconnecting = false;
	synced = false;
	opens = 0;
	connectCalls = 0;
	asyncClose = false;
	connectGate: Promise<void> | null = null;
	/** When set, an open publishes VAULT_READY like the server (liveness becomes healthy). */
	readyDocumentId: string | null = null;
	/** Keep the socket CLOSING after disconnect() until release() (a close that never lands). */
	holdClose = false;
	/** connect() leaves the socket CONNECTING (readyState 0) and never opens it. */
	stayConnecting = false;
	private socket: { readyState: number } | null = null;
	private readonly statusHandlers: Array<(event: { status: string }) => void> = [];
	readonly syncHandlers: Array<(synced: boolean) => void> = [];
	private readonly customHandlers: Array<(payload: string) => void> = [];

	get ws(): { readyState: number } | null { return this.socket; }

	async connect(): Promise<void> {
		this.connectCalls++;
		if (this.connectGate) await this.connectGate;
		if (this.socket) return;
		this.opens++;
		if (this.stayConnecting) {
			this.socket = { readyState: 0 };
			this.wsconnecting = true;
			return;
		}
		this.socket = { readyState: 1 };
		this.wsconnected = true;
		this.synced = true;
		for (const handler of this.statusHandlers) handler({ status: "connected" });
		if (this.readyDocumentId) this.custom(JSON.stringify({
			type: "VAULT_READY", documentId: this.readyDocumentId, documentEpoch: 1,
			socketSessionId: `session-${this.opens}`, vaultGeneration: "generation-reconnect",
			durableGeneration: 0, runtimeEpoch: "runtime-1", liveness: SOCKET_LIVENESS_DESCRIPTOR,
			capabilities: SOCKET_CONTROL_CAPABILITIES,
		}));
		for (const handler of [...this.syncHandlers]) handler(true);
	}

	disconnect(): void {
		const socket = this.socket;
		if (!socket || socket.readyState >= 2) return;
		socket.readyState = 2;
		if (this.holdClose) return;
		if (this.asyncClose) setTimeout(() => this.closed(), 10);
		else this.closed();
	}

	/** Completes a held close. */
	release(): void { this.closed(); }

	/** A server `__YPS:` control frame (prefix already stripped, as y-partyserver does). */
	custom(payload: string): void {
		for (const handler of this.customHandlers) handler(payload);
	}

	destroy(): void { this.disconnect(); }

	/** The server closed the socket (e.g. `1008 socket authority mismatch`). */
	serverClose(): void { this.closed(); }

	/** The socket vanished without ever reporting `connected` (failed upgrade loop). */
	detachSilently(): void {
		this.socket = null;
		this.wsconnected = false;
		this.synced = false;
	}

	on(event: string, callback: unknown): void {
		if (event === "status") this.statusHandlers.push(callback as (event: { status: string }) => void);
		if (event === "sync") this.syncHandlers.push(callback as (synced: boolean) => void);
		if (event === "custom-message") this.customHandlers.push(callback as (payload: string) => void);
	}

	off(event: string, callback: unknown): void {
		if (event !== "sync") return;
		const index = this.syncHandlers.indexOf(callback as (synced: boolean) => void);
		if (index >= 0) this.syncHandlers.splice(index, 1);
	}

	private closed(): void {
		const wasConnected = this.wsconnected;
		this.socket = null;
		this.wsconnected = false;
		this.wsconnecting = false;
		this.synced = false;
		if (wasConnected) for (const handler of this.statusHandlers) handler({ status: "disconnected" });
	}
}

function storedBody(bodyId: string, content: string): StoredDocument {
	const doc = new Y.Doc({ guid: bodyId });
	doc.getText("body").insert(0, content);
	const encodedState = Y.encodeStateAsUpdate(doc).slice().buffer;
	doc.destroy();
	return { kind: "body", documentId: bodyId, bodyEpoch: 1, durableBaseline: content,
		generation: 1, encodedState, dirty: false, updatedAt: 1 };
}

function harness(options: {
	root?: ModelProvider;
	body?: ModelProvider;
	workClock?: OverdueWorkClock;
	providerFactory?: ProviderFactory | null;
	webSocket?: unknown;
	ticketTtlMs?: number;
	offline?: () => boolean;
	onBodyChangedHint?: (bodyId: string) => void;
	onRemoteRootStructuralUpdate?: () => void;
	random?: () => number;
} = {}): { runtime: VaultSync; tickets: () => number; logs: string[] } {
	const documents = new Map<string, StoredDocument>([["body-note", storedBody("body-note", "note")]]);
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	});
	const server = partialOf<VaultServerPort>({
		currentHead: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation: 1 }),
	});
	let tickets = 0;
	const logs: string[] = [];
	const now = () => options.workClock?.now() ?? Date.now();
	const factory: ProviderFactory = ({ kind }) => {
		if (kind === "root" && options.root) return options.root;
		if (kind === "body" && options.body) return options.body;
		return new ModelProvider();
	};
	const runtime = new VaultSync({
		vaultId: "vault-reconnect",
		vaultGeneration: "generation-reconnect",
		deviceId: "device-reconnect",
		host: "https://sync.test",
		token: "token",
		database,
		server,
		...(options.providerFactory === null ? {} : { providerFactory: options.providerFactory ?? factory }),
		...(options.webSocket ? { webSocket: options.webSocket as never } : {}),
		...(options.workClock ? { workClock: options.workClock } : {}),
		getSocketTicket: async (): Promise<SocketTicketResult> => {
			if (options.offline?.()) throw new TypeError("fetch failed");
			tickets++;
			const ttlMs = options.ticketTtlMs ?? 1_000;
			return { value: `ticket-${tickets}`, expiresAt: now() + ttlMs, localExpiresAt: now() + ttlMs, ttlMs };
		},
		log: (message) => logs.push(message),
		...(options.onBodyChangedHint
			? { onBodyChangedHint: (hint: { bodyId: string }) => options.onBodyChangedHint!(hint.bodyId) } : {}),
		...(options.onRemoteRootStructuralUpdate ? { onRemoteRootStructuralUpdate: options.onRemoteRootStructuralUpdate } : {}),
		...(options.random ? { workRandom: { next: options.random } } : {}),
	});
	return { runtime, tickets: () => tickets, logs };
}

const admissionsStarted = (logs: readonly string[]) =>
	logs.filter((message) => message.startsWith("socket admission started")).length;

s.test("a root close during an in-flight body admission still reconnects root (B1)", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	let releaseBody!: () => void;
	body.connectGate = new Promise<void>((resolve) => { releaseBody = resolve; });
	const { runtime, logs } = harness({ root, body, ticketTtlMs: 300_000 });
	assert.equal((await runtime.reconnect("initial")).kind, "completed");
	assert.equal(root.opens, 1);

	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	const open = runtime.acquireEditorBody("Note.md", "editor");
	await until(() => body.connectCalls === 1, { message: "body admission in flight" });

	// The stale-runtime root socket is closed by the server mid body admission.
	root.serverClose();
	await sleep(30);
	assert.equal(root.opens, 1, "the root admission queues behind the in-flight body admission");
	assert.equal(root.wsconnected, false);

	releaseBody();
	await open;
	await until(() => root.opens === 2, { message: "root reconnect after the body admission settled" });
	await runtime.whenOverdueWorkIdle();
	assert.equal(root.wsconnected, true);
	assert.equal(body.wsconnected, true);
	assert.equal(body.opens, 1, "the body socket is not reopened by the root recovery");
	assert.ok(logs.some((message) => message === "socket admission started (root-disconnected)"));
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("a body close while root is open reconnects only the body", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	const { runtime, tickets } = harness({ root, body, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	assert.equal(body.opens, 1);
	const ticketsBefore = tickets();
	body.serverClose();
	await until(() => body.opens === 2, { message: "body reconnect" });
	await runtime.whenOverdueWorkIdle();
	assert.equal(root.opens, 1, "an open root socket is not replaced because a body socket closed");
	assert.equal(tickets() - ticketsBefore, 1, "one credential check for the body re-admission");
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("reopening a note whose warm body socket closed reconnects it before binding (B2)", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	const { runtime } = harness({ root, body, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	runtime.releaseEditorBody("Note.md", "editor");
	// The note is closed; its warm body socket is closed by a woken runtime.
	body.serverClose();
	await sleep(30);
	await runtime.whenOverdueWorkIdle();
	assert.equal(body.opens, 1, "a closed note's socket is not reopened by the body close itself");

	await runtime.acquireEditorBody("Note.md", "editor");
	assert.equal(body.opens, 2, "the editor waits for a live body socket");
	assert.equal(body.wsconnected, true);
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("a root reconnect also repairs detached warm body sockets (B2)", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	const { runtime } = harness({ root, body, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	runtime.releaseEditorBody("Note.md", "editor");
	// A woken runtime closes every stale socket: root and the warm body.
	body.serverClose();
	root.serverClose();
	await until(() => root.opens === 2, { message: "root reconnect" });
	await until(() => body.opens === 2, { message: "warm body reconnect" });
	await runtime.whenOverdueWorkIdle();
	assert.equal(body.wsconnected, true, "the closed note keeps receiving remote updates");
	await runtime.destroy();
});

s.test("replacing a live root socket whose close lands late costs one admission and one ticket (F1)", async () => {
	const root = new ModelProvider();
	root.asyncClose = true;
	const { runtime, tickets, logs } = harness({ root, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	assert.equal(tickets(), 1);
	assert.equal(root.opens, 1);
	assert.equal((await runtime.reconnect("explicit")).kind, "completed");
	assert.equal(root.opens, 2, "the admission itself reopens the socket once the old one has closed");
	await sleep(40);
	await runtime.whenOverdueWorkIdle();
	assert.equal(root.opens, 2);
	assert.equal(tickets(), 2, "no second ticket for a follow-up admission");
	assert.equal(admissionsStarted(logs), 2, "the late close of the replaced socket is not a new disconnect");
	assert.equal(root.wsconnected, true);
	await runtime.destroy();
});

class FakeClock implements OverdueWorkClock {
	private time = 0;
	private sequence = 0;
	private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();
	now(): number { return this.time; }
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { dueAt: this.time + delayMs, callback });
		if (delayMs === 0) queueMicrotask(() => {
			const timer = this.timers.get(id);
			if (!timer || timer.dueAt > this.time) return;
			this.timers.delete(id);
			timer.callback();
		});
		return id;
	}
	clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
	advance(ms: number): void {
		this.time += ms;
		for (const [id, timer] of [...this.timers].sort((left, right) => left[1].dueAt - right[1].dueAt)) {
			if (timer.dueAt > this.time) continue;
			this.timers.delete(id);
			timer.callback();
		}
	}
}

s.test("the ticket-expiry check re-admits a root stuck retrying with an expiring ticket", async () => {
	const clock = new FakeClock();
	const root = new ModelProvider();
	const { runtime, tickets } = harness({ root, workClock: clock });
	await runtime.reconnect("initial");
	assert.equal(tickets(), 1);
	const check = runtime.getOverdueWorkDiagnostics().queue.find((item) => item.key === "ticket-expiry");
	assert.equal(check?.dueAt, 500);
	assert.equal(runtime.hasPendingLocalWork, false, "the expiry check is connection maintenance, not local work");
	root.detachSilently();
	clock.advance(500);
	await until(() => root.opens === 2, { message: "stuck root re-admitted at ticket expiry" });
	await runtime.whenOverdueWorkIdle();
	assert.equal(tickets(), 2);
	assert.equal(root.wsconnected, true);
	await runtime.destroy();
});

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readyState = 0;
	binaryType = "arraybuffer";
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			this.dispatch("open", {});
		}, 0);
	}
	addEventListener(type: string, listener: (event: unknown) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(listener);
	}
	send(): void {}
	close(code = 1000, reason = ""): void {
		if (this.readyState >= 2) return;
		this.readyState = 2;
		setTimeout(() => {
			this.readyState = 3;
			this.dispatch("close", { code, reason });
		}, 5);
	}
	private dispatch(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

s.test("the default provider opens root with the ticket its admission minted", async () => {
	const host = globalThis as unknown as { addEventListener?: unknown; removeEventListener?: unknown };
	const restore = host.addEventListener === undefined;
	if (restore) {
		host.addEventListener = () => {};
		host.removeEventListener = () => {};
	}
	try {
		FakeWebSocket.instances = [];
		const { runtime, tickets } = harness({ providerFactory: null, webSocket: FakeWebSocket, ticketTtlMs: 300_000 });
		assert.equal((await runtime.reconnect("initial")).kind, "completed");
		assert.equal(tickets(), 1, "one ticket per root open");
		assert.equal(FakeWebSocket.instances.length, 1);
		assert.equal(new URL(FakeWebSocket.instances[0]!.url).searchParams.get("ticket"), "ticket-1");
		await until(() => FakeWebSocket.instances[0]!.readyState === 1, { message: "root socket open" });
		assert.equal((await runtime.reconnect("explicit")).kind, "completed");
		await until(() => FakeWebSocket.instances.length === 2, { message: "replacement socket" });
		await sleep(30);
		await runtime.whenOverdueWorkIdle();
		assert.equal(tickets(), 2, "a replacement costs exactly one more ticket");
		assert.equal(FakeWebSocket.instances.length, 2, "and exactly one more socket");
		assert.equal(new URL(FakeWebSocket.instances[1]!.url).searchParams.get("ticket"), "ticket-2");
		await runtime.destroy();
	} finally {
		if (restore) {
			delete host.addEventListener;
			delete host.removeEventListener;
		}
	}
});

function installDomEvents(): () => void {
	const host = globalThis as unknown as {
		addEventListener?: unknown; removeEventListener?: unknown; document?: unknown;
	};
	const restoreWindow = host.addEventListener === undefined;
	const restoreDocument = host.document === undefined;
	if (restoreWindow) {
		host.addEventListener = () => {};
		host.removeEventListener = () => {};
	}
	if (restoreDocument) {
		host.document = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
	}
	return () => {
		if (restoreWindow) {
			delete host.addEventListener;
			delete host.removeEventListener;
		}
		if (restoreDocument) delete host.document;
	};
}

function controllerFor(runtime: VaultSync): ConnectionController {
	return new ConnectionController({
		getVaultSync: () => runtime,
		isReconciled: () => true,
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		getLastReconciledGeneration: () => Number.MAX_SAFE_INTEGER,
		setReconnectPending: () => {},
		isReconcileInFlight: () => false,
		runReconnectReconciliation: () => {},
		refreshServerCapabilities: () => {},
		flushOpenWrites: () => {},
		updateOfflineStatus: () => {},
		refreshStatusBar: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		trace: partialOf({}),
		registerCleanup: () => {},
	});
}

s.test("through ConnectionController, a body close while root is healthy reconnects the body (S4)", async () => {
	const restore = installDomEvents();
	try {
		const clock = new FakeClock();
		const root = new ModelProvider();
		root.readyDocumentId = "root";
		const body = new ModelProvider();
		body.readyDocumentId = "body-note";
		const { runtime } = harness({ root, body, workClock: clock, ticketTtlMs: 300_000 });
		const controller = controllerFor(runtime);
		controller.start();
		assert.equal((await runtime.reconnect("initial")).kind, "completed");
		runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
		await runtime.acquireEditorBody("Note.md", "editor");
		assert.equal(runtime.connected, true, "root is open and liveness-healthy, as in production");
		assert.equal(body.opens, 1);
		body.serverClose();
		await sleep(10);
		clock.advance(1_000);
		await until(() => body.opens === 2, { message: "body reconnect through the fast-reconnect path" });
		await runtime.whenOverdueWorkIdle();
		assert.equal(root.opens, 1, "the healthy root is not replaced");
		assert.equal(body.wsconnected, true);
		controller.stop();
		runtime.releaseEditorBody("Note.md", "editor");
		await runtime.destroy();
	} finally {
		restore();
	}
});

s.test("a root that keeps closing right after it opens backs off exponentially (S6)", async () => {
	const clock = new FakeClock();
	const root = new ModelProvider();
	const { runtime } = harness({ root, workClock: clock, ticketTtlMs: 300_000, random: () => 0.5 });
	await runtime.reconnect("initial");
	const reconnectDelay = async (): Promise<number | null> => {
		await sleep(10);
		const item = runtime.getOverdueWorkDiagnostics().queue.find((entry) => entry.key === "reconnect");
		return item ? item.dueAt - clock.now() : null;
	};
	root.serverClose();
	await until(() => root.opens === 2, { message: "a single short-lived close reconnects at once" });
	await runtime.whenOverdueWorkIdle();
	root.serverClose();
	assert.equal(await reconnectDelay(), 1_000, "second consecutive flap waits the base delay");
	clock.advance(1_000);
	await until(() => root.opens === 3, { message: "reconnect after the first backoff" });
	await runtime.whenOverdueWorkIdle();
	root.serverClose();
	assert.equal(await reconnectDelay(), 2_000, "and doubles");
	clock.advance(2_000);
	await until(() => root.opens === 4, { message: "reconnect after the second backoff" });
	await runtime.whenOverdueWorkIdle();
	clock.advance(10_000);
	root.serverClose();
	await until(() => root.opens === 5, { message: "a connection that lived past the window resets the backoff" });
	await runtime.whenOverdueWorkIdle();
	await runtime.destroy();
});

s.test("reopening a note while offline binds the local warm body and reconnects in the background", async () => {
	let offline = false;
	const root = new ModelProvider();
	const body = new ModelProvider();
	const { runtime } = harness({ root, body, ticketTtlMs: 300_000, offline: () => offline });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	runtime.releaseEditorBody("Note.md", "editor");
	offline = true;
	body.serverClose();
	root.serverClose();
	await sleep(30);
	assert.equal(root.wsconnected, false, "offline: root cannot reconnect");
	await runtime.acquireEditorBody("Note.md", "editor");
	assert.equal(runtime.isEditorBodyReady("Note.md", "editor"), true, "the warm body is bound from local state");
	assert.equal(body.opens, 1);
	offline = false;
	await until(() => root.opens === 2 && body.opens === 2, {
		timeoutMs: 6_000, message: "root and the bound body reconnect once back online",
	});
	await runtime.whenOverdueWorkIdle();
	assert.equal(body.wsconnected, true);
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("warm reopens do not accumulate provider sync listeners", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	const { runtime } = harness({ root, body, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	const baseline = body.syncHandlers.length;
	for (let cycle = 0; cycle < 3; cycle++) {
		runtime.releaseEditorBody("Note.md", "editor");
		body.serverClose();
		await sleep(5);
		await runtime.acquireEditorBody("Note.md", "editor");
	}
	assert.equal(body.opens, 4);
	assert.equal(body.syncHandlers.length, baseline, "each wait removes its own listener");
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("admission waiting too long for the old socket to close is retryable, not completed", async () => {
	const root = new ModelProvider();
	const { runtime } = harness({ root, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	root.holdClose = true;
	const outcome = await runtime.reconnect("explicit");
	assert.equal(outcome.kind, "retryable_failure", "no socket was opened, so the admission did not complete");
	assert.equal(root.opens, 1);
	root.release();
	await runtime.destroy();
});

s.test("only root-opening admissions stash a root ticket, and a stash dies with its authority", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	const { runtime } = harness({ root, body, ticketTtlMs: 300_000 });
	const internals = runtime as unknown as {
		admissionRootTicket: unknown;
		takeAdmissionRootTicket(epoch: number): SocketTicketResult | null;
		options: { getAuthority?: () => unknown };
	};
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	assert.equal(internals.admissionRootTicket, null, "a body admission's credential check leaves no root ticket");
	let authority = { principalId: "p", membershipRevision: 1, deviceId: "d", deviceCredentialRevision: 1,
		role: "member", policyVersion: 1, capabilityDigest: "c", vaultId: "vault-reconnect", vaultGeneration: "generation-reconnect" };
	internals.options.getAuthority = () => authority;
	internals.admissionRootTicket = { ticket: { value: "t", expiresAt: Date.now() + 300_000,
		localExpiresAt: Date.now() + 300_000, ttlMs: 300_000 }, rootEpoch: 1, authority };
	authority = { ...authority, membershipRevision: 2 };
	assert.equal(internals.takeAdmissionRootTicket(1), null, "a stash from a superseded authority is discarded");
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("a body changed hint schedules catch-up only; it is never a commit receipt (S7)", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	const hinted: string[] = [];
	const { runtime } = harness({ root, body, ticketTtlMs: 300_000, onBodyChangedHint: (bodyId) => hinted.push(bodyId) });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	const hint = (overrides: Record<string, unknown> = {}) => JSON.stringify({
		type: "BODY_CHANGED_HINT", bodyId: "body-note", bodyEpoch: 1, vaultGeneration: "generation-reconnect",
		durableGeneration: 7, vaultSequence: 12, ...overrides,
	});
	root.custom(hint());
	body.custom(hint());
	root.custom(hint({ vaultGeneration: "generation-other" }));
	body.custom(hint({ bodyId: "body-other" }));
	root.custom(hint({ durableGeneration: -1 }));
	await sleep(5);
	assert.deepEqual(hinted, ["body-note", "body-note"], "only well-formed hints for this vault (and this body socket)");
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();

	let catchUps = 0;
	const fallbackRoot = new ModelProvider();
	const fallback = harness({ root: fallbackRoot, ticketTtlMs: 300_000, onRemoteRootStructuralUpdate: () => { catchUps++; } });
	await fallback.runtime.reconnect("initial");
	fallbackRoot.custom(hint());
	await sleep(5);
	assert.equal(catchUps, 1, "without a hint callback the existing catch-up trigger runs");
	await fallback.runtime.destroy();
});

s.test("the default provider advertises the catch-up hint capability in the upgrade URL", async () => {
	const restore = installDomEvents();
	try {
		FakeWebSocket.instances = [];
		const { runtime } = harness({ providerFactory: null, webSocket: FakeWebSocket, ticketTtlMs: 300_000 });
		assert.equal((await runtime.reconnect("initial")).kind, "completed");
		const url = new URL(FakeWebSocket.instances[0]!.url);
		assert.equal(url.searchParams.get("caps"), "catchupHint");
		assert.equal(url.searchParams.get("protocolVersion") !== null, true, "the pinned protocol version is unchanged");
		await runtime.destroy();
	} finally {
		restore();
	}
});

s.test("the ticket-expiry check keeps the earliest due time across tickets (S8)", async () => {
	const clock = new FakeClock();
	const scheduler = new VaultWorkScheduler({
		clock,
		reconnect: async () => ({ kind: "completed", value: undefined }),
		wakeBody: async () => ({ kind: "completed", value: undefined }),
		flushCandidate: async () => ({ kind: "completed", value: undefined }),
		retryLifecycle: async () => ({ kind: "completed", value: undefined }),
		retryAttachmentPublications: async () => ({ kind: "completed", value: undefined }),
		onError: (error) => { throw error; },
	});
	const due = () => scheduler.diagnostics().queue.find((item) => item.key === "ticket-expiry")?.dueAt;
	await scheduler.queueTicketExpiryCheck("ticket-expiry-check", 500);
	await scheduler.queueTicketExpiryCheck("ticket-expiry-check", 900);
	await sleep(1);
	assert.equal(due(), 500, "a later-expiring ticket does not postpone the check");
	await scheduler.queueTicketExpiryCheck("ticket-expiry-check", 300);
	await sleep(1);
	assert.equal(due(), 300, "an earlier one brings it forward");
	clock.advance(300);
	await scheduler.whenIdle();
	assert.equal(due(), undefined);
	await scheduler.queueTicketExpiryCheck("ticket-expiry-check", 900);
	await sleep(1);
	assert.equal(due(), 900, "after the check ran, the next ticket re-arms it");
	scheduler.stop();
});

s.test("a ticket-expiry check that ran does not re-arm itself in the past (N3)", async () => {
	const clock = new FakeClock();
	let releaseCheck!: () => void;
	let checks = 0;
	const scheduler = new VaultWorkScheduler({
		clock,
		reconnect: async () => {
			checks++;
			if (checks === 1) await new Promise<void>((resolve) => { releaseCheck = resolve; });
			return { kind: "completed", value: undefined };
		},
		wakeBody: async () => ({ kind: "completed", value: undefined }),
		flushCandidate: async () => ({ kind: "completed", value: undefined }),
		retryLifecycle: async () => ({ kind: "completed", value: undefined }),
		retryAttachmentPublications: async () => ({ kind: "completed", value: undefined }),
		onError: (error) => { throw error; },
	});
	const due = () => scheduler.diagnostics().queue.find((item) => item.key === "ticket-expiry")?.dueAt;
	await scheduler.queueTicketExpiryCheck("ticket-expiry-check", 100);
	clock.advance(100);
	await until(() => checks === 1, { message: "check running" });
	// The running check (dueAt 100, now past) mints a ticket, which re-arms
	// the check for that ticket's expiry. Minning with the running record's
	// dueAt put it at 100 again: an immediate re-run, forever.
	await scheduler.queueTicketExpiryCheck("ticket-expiry-check", 5_000);
	releaseCheck();
	await sleep(5);
	assert.equal(due(), 5_000, "the new ticket's expiry, not the spent dueAt");
	assert.equal(checks, 1, "no immediate re-run");
	// Concurrent queues (no await in between) still keep the minimum.
	void scheduler.queueTicketExpiryCheck("ticket-expiry-check", 4_000);
	void scheduler.queueTicketExpiryCheck("ticket-expiry-check", 4_500);
	await sleep(5);
	assert.equal(due(), 4_000, "atomic minimum across concurrent queues (N8)");
	scheduler.stop();
});

s.test("a body socket still CONNECTING is not torn down by repair until its connect timeout (N3)", async () => {
	const clock = new FakeClock();
	const root = new ModelProvider();
	const body = new ModelProvider();
	root.readyDocumentId = "root";
	body.readyDocumentId = "body-note";
	const { runtime, tickets, logs } = harness({ root, body, workClock: clock, ticketTtlMs: 300_000, random: () => 0.5 });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	assert.equal(body.opens, 1);
	body.stayConnecting = true;
	body.serverClose();
	await until(() => body.opens === 2, { message: "body re-admitted" });
	await runtime.whenOverdueWorkIdle();
	assert.equal(body.wsconnecting, true);
	const ticketsBefore = tickets();
	for (let index = 0; index < 50; index++) {
		clock.advance(100);
		assert.equal((await runtime.reconnect("ticket-expiry-check")).kind, "completed");
		assert.equal((await runtime.reconnect("body-disconnected:body-note")).kind, "completed");
	}
	assert.equal(body.opens, 2, "a CONNECTING socket is an admission in flight, not detached");
	assert.equal(tickets(), ticketsBefore, "no ticket per repair pass");
	clock.advance(20_000);
	const late = await runtime.reconnect("ticket-expiry-check");
	assert.equal(body.opens, 3, `a socket stuck CONNECTING past the timeout is re-admitted: ${JSON.stringify(late)} ${logs.slice(-6).join(" | ")}`);
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("repair passes while root is CONNECTING do not replace root (N3)", async () => {
	const clock = new FakeClock();
	const root = new ModelProvider();
	root.readyDocumentId = "root";
	const { runtime, tickets } = harness({ root, workClock: clock, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	root.stayConnecting = true;
	root.serverClose();
	await until(() => root.opens === 2, { message: "root re-admitted" });
	await runtime.whenOverdueWorkIdle();
	const ticketsBefore = tickets();
	const outcome = await runtime.reconnect("ticket-expiry-check");
	assert.equal(outcome.kind, "retryable_failure");
	assert.equal(root.opens, 2, "a CONNECTING root is not replaced");
	assert.equal(tickets(), ticketsBefore);
	await runtime.destroy();
});

s.test("sockets that never open cannot storm admissions (N3 P0c)", async () => {
	const clock = new FakeClock();
	const root = new ModelProvider();
	const body = new ModelProvider();
	root.readyDocumentId = "root";
	body.readyDocumentId = "body-note";
	const { runtime, tickets } = harness({ root, body, workClock: clock, ticketTtlMs: 300_000, random: () => 0.5 });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	body.stayConnecting = true;
	const ticketsBefore = tickets();
	// Each pass the body socket vanishes before it opened (no status event)
	// and every repair trigger fires; 10 minutes at 100 ms.
	for (let index = 0; index < 6_000; index++) {
		body.detachSilently();
		body.wsconnecting = false;
		clock.advance(100);
		await runtime.reconnect(index % 2 === 0 ? "ticket-expiry-check" : "body-disconnected:body-note");
	}
	// Includes a root re-admission every ~minute: this model socket cannot
	// answer liveness probes. Unbounded, the loop minted one ticket per pass.
	const minted = tickets() - ticketsBefore;
	assert.ok(minted <= 30, `bounded admissions in a 10-minute never-open storm: ${minted}`);
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("a fast reconnect does not pull a flap-backoff reconnect forward (N7)", async () => {
	const clock = new FakeClock();
	const root = new ModelProvider();
	const { runtime } = harness({ root, workClock: clock, ticketTtlMs: 300_000, random: () => 0.5 });
	await runtime.reconnect("initial");
	root.serverClose();
	await until(() => root.opens === 2, { message: "first flap reconnects at once" });
	await runtime.whenOverdueWorkIdle();
	root.serverClose();
	await sleep(10);
	const due = () => runtime.getOverdueWorkDiagnostics().queue.find((entry) => entry.key === "reconnect")?.dueAt;
	assert.equal(due(), clock.now() + 1_000);
	await runtime.queueReconnect("app-foregrounded", 0);
	await sleep(1);
	assert.equal(due(), clock.now() + 1_000, "the backoff floor holds");
	clock.advance(1_000);
	await until(() => root.opens === 3, { message: "reconnect after the backoff" });
	await runtime.whenOverdueWorkIdle();
	await runtime.destroy();
});

s.test("local edits inside the candidate debounce are not reported as saved by the server", async () => {
	const root = new ModelProvider();
	const body = new ModelProvider();
	const { runtime } = harness({ root, body, ticketTtlMs: 300_000 });
	await runtime.reconnect("initial");
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	await runtime.acquireEditorBody("Note.md", "editor");
	const text = runtime.getTextForPath("Note.md");
	assert.ok(text);
	text.doc!.transact(() => text.insert(0, "typed "), "local-editor");
	assert.equal(runtime.serverAppliedLocalState, false, "an uncaptured local edit is not the server's latest state");
	runtime.releaseEditorBody("Note.md", "editor");
	await runtime.destroy();
});

s.test("loadBodyForPlanning loads the current body without capturing a candidate", async () => {
	const { runtime } = harness({ ticketTtlMs: 300_000 });
	runtime.ydoc.transact(() => runtime.pathToId.set("Note.md", "body-note"), "test");
	assert.equal(runtime.isBodyLoaded("body-note"), false);
	await runtime.loadBodyForPlanning("body-note");
	assert.equal(runtime.isBodyLoaded("body-note"), true);
	assert.equal(runtime.getTextForPath("Note.md")?.toJSON(), "note");
	assert.equal(runtime.hasUnconfirmedServerReceiptCandidate, false, "planning never captures a candidate");
	await runtime.destroy();
});

await s.done();
