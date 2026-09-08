import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { SOCKET_LIVENESS_DESCRIPTOR } from "../../server/src/shared/socketLiveness";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "../../server/src/shared/socketCloseCodes";
import type { OverdueWorkClock } from "../../src/runtime/overdueWorkKernel";
import {
	VaultSync,
	type AttachmentPublicationReceipt,
	type BodyReceipt,
	type CandidateRecord,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredAttachmentPublicationOperation, StoredDocument } from "../../src/sync/vaultIndexedDb";
import { readSource, suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema";

installDomCrypto();
const s = suite("vault-work-scheduler-integration");

interface TimerRecord {
	readonly id: number;
	readonly dueAt: number;
	readonly callback: () => void;
}

class FakeClock implements OverdueWorkClock {
	private time = 0;
	private sequence = 0;
	private readonly timers = new Map<number, TimerRecord>();

	now(): number {
		return this.time;
	}

	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { id, dueAt: this.time + delayMs, callback });
		if (delayMs === 0) {
			queueMicrotask(() => {
				const timer = this.timers.get(id);
				if (!timer || timer.dueAt > this.time) return;
				this.timers.delete(id);
				timer.callback();
			});
		}
		return id;
	}

	clearTimer(handle: unknown): void {
		this.timers.delete(handle as number);
	}

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

class TestProvider implements SyncProviderPort {
	readonly awareness: SyncAwarenessPort = {
		setLocalStateField: () => undefined,
		destroy: () => undefined,
		getStates: () => new Map(),
	};
	readonly documentOrigin = {};
	url = "ws://test/root?ticket=initial";
	wsconnected = false;
	wsconnecting = false;
	synced = false;
	readonly sentMessages: string[] = [];
	private readonly statusHandlers: Array<(event: { status: string }) => void> = [];
	private readonly syncHandlers: Array<(synced: boolean) => void> = [];
	private readonly customHandlers: Array<(payload: string) => void> = [];
	private readonly messageHandlers: Array<(event: MessageEvent) => void> = [];
	private readonly socket = { readyState: 0 };
	private nativeClose: (event: { code: number; reason: string }) => void = () => undefined;

	get ws(): SyncProviderPort["ws"] {
		return this.wsconnected ? this.socket : null;
	}

	connect(): void {
		this.wsconnecting = false;
		this.wsconnected = true;
		this.synced = true;
		this.socket.readyState = 1;
		for (const handler of this.statusHandlers) handler({ status: "connected" });
		for (const handler of this.syncHandlers) handler(true);
	}

	disconnect(): void {
		this.wsconnected = false;
		this.synced = false;
		this.socket.readyState = 3;
	}

	destroy(): void {
		this.disconnect();
	}

	sendMessage(message: string): void {
		this.sentMessages.push(message);
	}

	on(event: "status", callback: (event: { status: string }) => void): void;
	on(event: "sync", callback: (synced: boolean) => void): void;
	on(event: "custom-message", callback: (payload: string) => void): void;
	on(event: "message", callback: (event: MessageEvent) => void): void;
	on(event: "status" | "sync" | "custom-message" | "message", callback: ((value: never) => void)): void {
		if (event === "status") this.statusHandlers.push(callback as (value: { status: string }) => void);
		else if (event === "sync") this.syncHandlers.push(callback as (value: boolean) => void);
		else if (event === "custom-message") this.customHandlers.push(callback as (value: string) => void);
		else this.messageHandlers.push(callback as (value: MessageEvent) => void);
	}

	emitCustom(payload: string): void {
		for (const handler of this.customHandlers) handler(payload);
	}
	setNativeClose(handler: (event: { code: number; reason: string }) => void): void { this.nativeClose = handler; }

	emitClose(code: number, reason: string): void {
		this.wsconnected = false;
		this.synced = false;
		this.socket.readyState = 3;
		// The provider's own close handler can publish disconnection before the
		// raw socket listener. The application close code must still win.
		for (const handler of this.statusHandlers) handler({ status: "disconnected" });
		this.nativeClose({ code, reason });
	}
}

function encodedBody(bodyId: string, content: string): Uint8Array {
	const doc = new Y.Doc({ guid: bodyId });
	doc.getText("body").insert(0, content);
	const encoded = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return encoded;
}

s.test("VaultSync reconstructs and drains candidate, body-wake, and ticket work", async () => {
	const clock = new FakeClock();
	const documents = new Map<string, StoredDocument>();
	const root = new Y.Doc({ guid: "root" });
	root.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
	root.getMap("sys").set("protocolVersion", PROTOCOL_VERSION);
	documents.set("root", {
		kind: "root",
		documentId: "root",
		rootEpoch: 1,
		generation: 1,
		encodedState: Y.encodeStateAsUpdate(root).slice().buffer,
		dirty: false,
		updatedAt: 0,
	});
	root.destroy();
	documents.set("body-1", {
		kind: "body",
		documentId: "body-1",
		bodyEpoch: 1,
		durableBaseline: "old",
		generation: 1,
		encodedState: encodedBody("body-1", "old").slice().buffer,
		dirty: true,
		updatedAt: 0,
	});

	const candidate: CandidateRecord = {
		vaultId: "vault-1",
		bodyId: "body-1",
		bodyEpoch: 1,
		previousBaseline: "old",
		pendingMarkdown: "old",
		candidateId: "candidate-1",
		candidateDigest: "digest-1",
		encodedUpdate: new Uint8Array([1, 2, 3]).buffer,
		capturedAt: 0,
		capturedLocalUpdates: 1,
	};
	const candidates = new Map([[candidate.candidateId, candidate]]);
	const attachments = new Map<string, StoredAttachmentPublicationOperation>();
	const database: VaultDatabasePort = {
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (record) => { candidates.set(record.candidateId, record); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => {
			const stored = { ...operation, localSequence: operation.localSequence || attachments.size + 1 };
			attachments.set(operation.mutation.operationId, stored);
			return stored;
		},
		listAttachmentOperations: async () => [...attachments.values()],
		deleteAttachmentOperation: async (operationId) => { attachments.delete(operationId); },
		close: async () => undefined,
	};

	let candidateAttempts = 0;
	const remoteBody = encodedBody("body-1", "new");
	const server = partialOf<VaultServerPort>({
		currentHead: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation: 2 }),
		currentBody: async (bodyId) => ({ bodyId, bodyEpoch: 1, generation: 2, encodedState: remoteBody }),
		submitCandidate: async (record): Promise<BodyReceipt> => {
			candidateAttempts++;
			if (candidateAttempts === 1) throw new Error("temporary candidate outage");
			return {
				vaultId: "vault-1",
				vaultGeneration: "generation-1",
				bodyId: record.bodyId,
				bodyEpoch: record.bodyEpoch,
				clientId: "device-1",
				candidateId: record.candidateId,
				candidateDigest: record.candidateDigest,
				durableGeneration: 2,
				runtimeEpoch: "runtime-1",
			};
		},
		publishAttachment: async (): Promise<AttachmentPublicationReceipt> => {
			throw new Error("unexpected attachment publication");
		},
	});
	const provider = new TestProvider();
	let ticketRequests = 0;
	const runtime = await VaultSync.create({
		vaultId: "vault-1",
		vaultGeneration: "generation-1",
		deviceId: "device-1",
		host: "https://sync.test",
		token: "token",
		database,
		server,
		providerFactory: (input) => {
			provider.setNativeClose(input.onClose);
			return provider;
		},
		getSocketTicket: async () => {
			ticketRequests++;
			return {
				value: `ticket-${ticketRequests}`,
				expiresAt: clock.now() + 1_000,
				localExpiresAt: clock.now() + 1_000,
				ttlMs: 1_000,
			};
		},
		workClock: clock,
		workRandom: { next: () => 0.5 },
	});
	provider.emitCustom(JSON.stringify({
		type: "VAULT_READY",
		documentId: "root",
		documentEpoch: 1,
		vaultGeneration: "wrong-generation",
		durableGeneration: 1,
		runtimeEpoch: "runtime-wrong",
		liveness: SOCKET_LIVENESS_DESCRIPTOR,
	}));
	assert.equal(runtime.applicationResponsive, null);
	provider.emitCustom(JSON.stringify({
		type: "VAULT_READY",
		documentId: "root",
		documentEpoch: 1,
		vaultGeneration: "generation-1",
		durableGeneration: 1,
		runtimeEpoch: "runtime-1",
		liveness: SOCKET_LIVENESS_DESCRIPTOR,
	}));
	assert.equal(runtime.applicationResponsive, true);
	runtime.probeSocketLiveness("authority-test");
	const probe = JSON.parse(provider.sentMessages.at(-1) ?? "null") as { probeId?: unknown };
	assert.equal(typeof probe.probeId, "string");
	assert.equal(runtime.getSocketLivenessSnapshot()[0]?.phase, "probing");
	for (const frame of [
		{ documentId: "other", documentEpoch: 1, vaultGeneration: "generation-1", runtimeEpoch: "runtime-1", probeId: probe.probeId },
		{ documentId: "root", documentEpoch: 1, vaultGeneration: "wrong-generation", runtimeEpoch: "runtime-1", probeId: probe.probeId },
		{ documentId: "root", documentEpoch: 1, vaultGeneration: "generation-1", runtimeEpoch: "runtime-wrong", probeId: probe.probeId },
		{ documentId: "root", documentEpoch: 1, vaultGeneration: "generation-1", runtimeEpoch: "runtime-1", probeId: "wrong-probe" },
	]) {
		provider.emitCustom(JSON.stringify({ type: "VAULT_PONG", ...frame }));
		assert.equal(runtime.getSocketLivenessSnapshot()[0]?.phase, "probing");
	}
	provider.emitCustom(JSON.stringify({
		type: "VAULT_PONG",
		documentId: "root",
		documentEpoch: 1,
		vaultGeneration: "generation-1",
		runtimeEpoch: "runtime-1",
		probeId: probe.probeId,
	}));
	assert.equal(runtime.getSocketLivenessSnapshot()[0]?.phase, "healthy");

	assert.equal(candidateAttempts, 1);
	const candidateRetry = runtime.getOverdueWorkDiagnostics().queue.find((item) => item.key === "candidate:body-1");
	const ticketRefresh = runtime.getOverdueWorkDiagnostics().queue.find((item) => item.key === "reconnect");
	assert.equal(candidateRetry?.owner, "kernel");
	assert.equal(candidateRetry?.attempt, 1);
	assert.equal(candidateRetry?.dueAt, 1_000);
	assert.equal(ticketRefresh?.dueAt, 500);

	await runtime.bodies.load("body-1");
	provider.emitCustom(JSON.stringify({
		type: "BODY_COMMITTED",
		bodyId: "body-1",
		bodyEpoch: 1,
		vaultGeneration: "generation-1",
		durableGeneration: 2,
		runtimeEpoch: "runtime-1",
	}));
	await until(() => runtime.bodies.get("body-1")?.generation === 2, {
		timeoutMs: 1_000,
		intervalMs: 0,
		message: "scheduler-owned body wake",
	});
	assert.equal(runtime.getOverdueWorkDiagnostics().queue.some((item) => item.key === "body-wake:body-1"), false);

	assert.equal(clock.advance(500), 1);
	await runtime.whenOverdueWorkIdle();
	assert.equal(ticketRequests, 2);
	assert.equal(runtime.getOverdueWorkDiagnostics().queue.find((item) => item.key === "reconnect")?.dueAt, 1_000);

	assert.equal(clock.advance(500), 1);
	await runtime.whenOverdueWorkIdle();
	assert.equal(candidateAttempts, 2);
	assert.equal(candidates.size, 0);
	assert.equal(runtime.getOverdueWorkDiagnostics().queue.some((item) => item.key === "candidate:body-1"), false);
	let fatalNotifications = 0;
	runtime.onFatalAuth(() => { fatalNotifications++; });
	provider.emitClose(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "device authority changed");
	assert.equal(runtime.fatalAuthCode, "authority_superseded", "application close code is fatal even when the control frame is lost");
	assert.equal(runtime.fatalAuthDetails?.reason, "device authority changed");
	assert.equal(fatalNotifications, 1);
	await runtime.destroy();
});

s.section("Legacy timer ownership");
{
	const vaultSource = readSource("src/sync/vaultSync.ts");
	const connectionSource = readSource("src/runtime/connectionController.ts");
	s.check(!vaultSource.includes("candidateTimers"), "VaultSync has no legacy candidate debounce timers");
	s.check(!vaultSource.includes("ticketRefreshTimer"), "VaultSync has no legacy ticket/retry timer");
	s.check(!connectionSource.includes("fastReconnectDebounceTimer"), "ConnectionController has no reconnect debounce timer");
	s.check(vaultSource.includes("this.renameTimer = window.setTimeout"), "unrelated rename batching remains unchanged");
}

await s.done();
