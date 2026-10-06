import { strict as assert } from "node:assert";
import {
	VaultSync,
	parseVaultControlFrame,
	type ProviderFactory,
	type SocketTicketResult,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../legacy-src/sync/vaultSync";
import { SOCKET_CONTROL_CAPABILITIES, SOCKET_LIVENESS_DESCRIPTOR } from "../../legacy-src/shared/socketLiveness";
import {
	DAILY_LIMIT_MAX_BACKOFF_MS,
	DAILY_LIMIT_NOTICE,
	DailyLimitNoticeGate,
	dailyLimitBackoffUntil,
	detectDailyLimitResponses,
	nextUtcMidnight,
	parseDailyLimitSignal,
	type DailyLimitInfo,
} from "../../legacy-src/sync/dailyLimit";
import { getLabelFromConnectionState } from "../../legacy-src/status/statusBarController";
import { DailyLimitLatch, dailyLimitResponse } from "../../server/src/dailyLimit";
import type { HttpRequest, HttpResponse } from "../../legacy-src/utils/http";
import { sleep, suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("daily-limit-client");

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


function harness(options: { root: ModelProvider; request?: (request: HttpRequest) => Promise<HttpResponse>;
	withServer?: boolean }): { runtime: VaultSync; trips: DailyLimitInfo[]; logs: string[] } {
	const database = partialOf<VaultDatabasePort>({
		getDocument: async () => null,
		putDocument: async () => {},
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	});
	const trips: DailyLimitInfo[] = [];
	const logs: string[] = [];
	const factory: ProviderFactory = ({ kind }) => kind === "root" ? options.root : new ModelProvider();
	const runtime = new VaultSync({
		vaultId: "vault-limit",
		vaultGeneration: "generation-reconnect",
		deviceId: "device-limit",
		host: "https://sync.test",
		token: "token",
		database,
		...(options.withServer === false ? {} : { server: partialOf<VaultServerPort>({
			currentHead: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation: 1 }),
		}) }),
		...(options.request ? { request: options.request } : {}),
		providerFactory: factory,
		getSocketTicket: async (): Promise<SocketTicketResult> => ({
			value: "ticket", expiresAt: Date.now() + 300_000, localExpiresAt: Date.now() + 300_000, ttlMs: 300_000,
		}),
		log: (message) => logs.push(message),
		onDailyLimit: (info) => trips.push(info),
	});
	return { runtime, trips, logs };
}

async function toHttpResponse(response: Response): Promise<HttpResponse> {
	const text = await response.text();
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => { headers[name] = value; });
	return { status: response.status, headers, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
		text, get json() { return JSON.parse(text); } };
}

const NOW = Date.UTC(2026, 9, 2, 15, 30);

s.test("notice text is the D8 wording", () => {
	assert.equal(DAILY_LIMIT_NOTICE,
		"Cloudflare's daily free limit was reached. Sync resumes at 00:00 UTC. The $5/month Workers Paid plan removes this limit.");
});

s.test("parses typed HTTP bodies and VAULT_ERROR frames; ignores everything else", () => {
	const reset = nextUtcMidnight(NOW);
	assert.deepEqual(parseDailyLimitSignal({ error: "cf_daily_limit", kind: "rows-written", resetAt: reset }, NOW),
		{ resetAt: reset, kind: "rows-written" });
	assert.deepEqual(parseDailyLimitSignal({ type: "VAULT_ERROR", code: "cf_daily_limit", message: "x", resetAt: reset }, NOW),
		{ resetAt: reset, kind: "rows-written" });
	assert.equal(parseDailyLimitSignal({ type: "VAULT_ERROR", message: "boom" }, NOW), null);
	assert.equal(parseDailyLimitSignal({ error: "server_misconfigured" }, NOW), null);
	assert.equal(parseDailyLimitSignal("cf_daily_limit", NOW), null);
	assert.equal(parseDailyLimitSignal(null, NOW), null);
	// Missing, past or far-future resetAt falls back to the local UTC midnight.
	for (const resetAt of [undefined, NOW - 1, NOW + 3 * 86_400_000, Number.NaN, "soon"]) {
		assert.equal(parseDailyLimitSignal({ error: "cf_daily_limit", resetAt }, NOW)?.resetAt, reset);
	}
});

s.test("the server's typed frame round-trips through the client parser", () => {
	const latch = new DailyLimitLatch(() => NOW);
	latch.note(new Error("Exceeded allowed rows written in Durable Objects free tier."));
	const decorated = latch.decorateControl({ type: "VAULT_ERROR", code: "relay_persist_failed", message: "persist failed" });
	const frame = parseVaultControlFrame(JSON.stringify(decorated));
	assert.equal(frame?.type, "VAULT_ERROR");
	assert.equal(frame?.type === "VAULT_ERROR" ? frame.code : null, "cf_daily_limit");
	assert.equal(parseDailyLimitSignal(frame, NOW)?.resetAt, nextUtcMidnight(NOW));
	// Plain VAULT_ERROR frames keep parsing as before.
	assert.deepEqual(parseVaultControlFrame(JSON.stringify({ type: "VAULT_ERROR", message: "m" })),
		{ type: "VAULT_ERROR", message: "m" });
});

s.test("back-off is the reset or one hourly probe, whichever is first", () => {
	const late = Date.UTC(2026, 9, 2, 23, 50);
	assert.equal(dailyLimitBackoffUntil({ resetAt: nextUtcMidnight(late), kind: "rows-written" }, late), nextUtcMidnight(late));
	assert.equal(dailyLimitBackoffUntil({ resetAt: nextUtcMidnight(NOW), kind: "rows-written" }, NOW), NOW + DAILY_LIMIT_MAX_BACKOFF_MS);
});

s.test("notice gate fires once per reset window", () => {
	let now = NOW;
	const gate = new DailyLimitNoticeGate(() => now);
	const info = { resetAt: nextUtcMidnight(NOW), kind: "rows-written" };
	assert.equal(gate.trip(info), true);
	for (let i = 0; i < 50; i++) assert.equal(gate.trip(info), false, "repeat trips are silent");
	assert.equal(gate.active(), true);
	assert.equal(gate.resetAt(), info.resetAt);
	now = info.resetAt + 1;
	assert.equal(gate.active(), false);
	assert.equal(gate.resetAt(), null);
	assert.equal(gate.trip({ resetAt: nextUtcMidnight(now), kind: "rows-written" }), true, "next day notifies again");
});

s.test("requester wrapper reports the server's 503 and passes responses through", async () => {
	const trips: DailyLimitInfo[] = [];
	const limited = await toHttpResponse(dailyLimitResponse(NOW));
	const ok = await toHttpResponse(new Response("{}", { status: 200 }));
	const other503 = await toHttpResponse(new Response("not json", { status: 503 }));
	const queue = [limited, ok, other503];
	const request = detectDailyLimitResponses(async () => queue.shift()!, (info) => trips.push(info), () => NOW);
	assert.equal((await request({ url: "u" })).status, 503);
	assert.equal((await request({ url: "u" })).status, 200);
	assert.equal((await request({ url: "u" })).status, 503);
	assert.deepEqual(trips, [{ resetAt: nextUtcMidnight(NOW), kind: "rows-written" }]);
});

s.test("status bar shows the daily-limit state", () => {
	const label = getLabelFromConnectionState({ kind: "online" } as never, null, null, 0, null, null, true);
	assert.match(label, /Daily free limit reached/);
	assert.doesNotMatch(getLabelFromConnectionState({ kind: "online" } as never), /Daily free limit/);
});

s.test("a typed VAULT_ERROR trips the runtime and holds reconnects", async () => {
	const root = new ModelProvider();
	const { runtime, trips, logs } = harness({ root });
	await runtime.reconnect("initial");
	assert.equal(root.opens, 1);
	assert.equal(runtime.getDailyLimitState(), null);

	const resetAt = nextUtcMidnight(Date.now());
	for (let i = 0; i < 3; i++) {
		root.custom(JSON.stringify({ type: "VAULT_ERROR", code: "cf_daily_limit", kind: "rows-written",
			resetAt, message: "Cloudflare's daily free limit was reached. Sync resumes at 00:00 UTC. The $5/month Workers Paid plan removes this limit." }));
	}
	assert.equal(trips.length, 3, "the host gets every trip and decides how often to notify");
	assert.equal(runtime.getDailyLimitState()?.resetAt, resetAt);

	// The server closes the socket: no reconnect inside the back-off window.
	root.serverClose();
	await sleep(150);
	assert.equal(root.opens, 1, "reconnect is held by the daily-limit floor");
	assert.ok(logs.some((message) => message.startsWith("cloudflare daily limit (rows-written)")));
	await runtime.destroy();
});

s.test("without a trip the same close reconnects (control)", async () => {
	const root = new ModelProvider();
	const { runtime, trips } = harness({ root });
	await runtime.reconnect("initial");
	root.custom(JSON.stringify({ type: "VAULT_ERROR", message: "some other failure" }));
	root.serverClose();
	await until(() => root.opens === 2, { message: "ordinary reconnect" });
	assert.equal(trips.length, 0);
	await runtime.destroy();
});

s.test("a typed HTTP 503 from the vault server port trips the runtime", async () => {
	const root = new ModelProvider();
	const requests: string[] = [];
	const { runtime, trips } = harness({ root, withServer: false, request: async (request) => {
		requests.push(request.url);
		return toHttpResponse(dailyLimitResponse(Date.now()));
	} });
	const server = (runtime as unknown as { server: VaultServerPort }).server;
	await assert.rejects(server.currentHead("body-x"));
	assert.equal(requests.length, 1);
	assert.equal(trips.length, 1);
	assert.equal(runtime.getDailyLimitState()?.kind, "rows-written");
	await runtime.destroy();
});

// ---------------------------------------------------------------------------
// b3 regressions found while porting D8 onto relay3.
// ---------------------------------------------------------------------------

s.test("b3 regression: destroy() completes while the daily-limit back-off holds a submission", async () => {
	const root = new ModelProvider();
	const { runtime } = harness({ root });
	await runtime.reconnect("initial");
	root.custom(JSON.stringify({ type: "VAULT_ERROR", code: "cf_daily_limit", kind: "rows-written",
		resetAt: nextUtcMidnight(Date.now()), message: "limited" }));
	assert.ok(runtime.getDailyLimitState());
	// A scheduler job that submits (lifecycle replay, candidate, bulk create all
	// pass waitForSubmissionWindow) is parked for up to an hour.
	const internals = runtime as unknown as {
		runLifecycleReplayWork(groupKey: string): Promise<void>;
		waitForSubmissionWindow(): Promise<void>;
		workScheduler: { queueLifecycleReplay(groupKey: string): Promise<void> };
	};
	let parked = false;
	let outcome: string | null = null;
	internals.runLifecycleReplayWork = async () => {
		parked = true;
		try { await internals.waitForSubmissionWindow(); outcome = "resolved"; }
		catch (error) { outcome = String(error); }
	};
	void internals.workScheduler.queueLifecycleReplay("group-limited").catch(() => undefined);
	await until(() => parked, { message: "submission parked in the back-off" });
	const started = Date.now();
	const destroyed = await Promise.race([
		runtime.destroy().then(() => "destroyed"),
		sleep(3_000).then(() => "hung"),
	]);
	assert.equal(destroyed, "destroyed", "destroy() must not wait out the daily-limit back-off");
	assert.ok(Date.now() - started < 3_000);
	assert.match(String(outcome), /destroyed during submission backoff/);
	await assert.rejects(internals.waitForSubmissionWindow(), /destroyed/, "no new wait after destroy");
});

s.test("b3 regression: BODY_COMMITTED arriving after the scheduler stopped is not an unhandled rejection", async () => {
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => { rejections.push(reason); };
	process.on("unhandledRejection", onRejection);
	try {
		const root = new ModelProvider();
		root.readyDocumentId = "root";
		const { runtime } = harness({ root });
		await runtime.reconnect("initial");
		const frame = JSON.stringify({ type: "BODY_COMMITTED", bodyId: "body-closed", vaultGeneration: "generation-reconnect",
			durableGeneration: 3, bodyEpoch: 1, runtimeEpoch: "runtime-1" });
		// destroy() stops the work scheduler synchronously, then awaits teardown;
		// a frame delivered in that window used to reject inside queueBodyWake.
		const destroying = runtime.destroy();
		root.custom(frame);
		await destroying;
		const direct = (runtime as unknown as { handleDurableBodyCommitted(value: unknown): Promise<void> })
			.handleDurableBodyCommitted({ bodyId: "body-closed", durableGeneration: 4, bodyEpoch: 1,
				vaultGeneration: "generation-reconnect", runtimeEpoch: "runtime-1" });
		await direct; // resolves (was: rejects "vault work scheduler is stopped")
		await sleep(20);
		assert.deepEqual(rejections.map(String), []);
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

await s.done();
