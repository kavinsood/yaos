import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	VaultSync,
	type ProviderFactory,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("residency-admission-vault-sync");

function storedBody(bodyId: string, content: string): StoredDocument {
	const doc = new Y.Doc({ guid: bodyId });
	doc.getText("body").insert(0, content);
	const encodedState = Y.encodeStateAsUpdate(doc).slice().buffer;
	doc.destroy();
	return { kind: "body", documentId: bodyId, bodyEpoch: 1, durableBaseline: content,
		generation: 1, encodedState, dirty: false, updatedAt: 1 };
}

function providerFactory(
	firstBodyGate: Promise<void>,
	stats?: { created: number; destroyed: number },
): ProviderFactory {
	let bodyProviders = 0;
	return ({ kind }) => {
		if (stats) stats.created++;
		const callbacks = {
			status: [] as Array<(event: { status: string }) => void>,
			sync: [] as Array<(synced: boolean) => void>,
		};
		const bodyIndex = kind === "body" ? ++bodyProviders : 0;
		let connected = false;
		let connecting = false;
		let synced = false;
		const awareness = partialOf<SyncAwarenessPort>({
			setLocalStateField: () => {},
			destroy: () => {},
			getStates: () => new Map(),
		});
		return partialOf<SyncProviderPort>({
			awareness,
			documentOrigin: {},
			get ws() { return connected ? { readyState: 1 } : null; },
			get wsconnected() { return connected; },
			get wsconnecting() { return connecting; },
			get synced() { return synced; },
			url: "ws://test/body",
			connect: async () => {
				connecting = true;
				callbacks.status.forEach((callback) => callback({ status: "connecting" }));
				if (bodyIndex === 1) await firstBodyGate;
				connecting = false;
				connected = true;
				synced = true;
				callbacks.status.forEach((callback) => callback({ status: "connected" }));
				callbacks.sync.forEach((callback) => callback(true));
			},
			disconnect: () => { connected = false; connecting = false; },
			destroy: () => {
				connected = false;
				connecting = false;
				if (stats) stats.destroyed++;
			},
			on: ((event: string, callback: unknown) => {
				if (event === "status") callbacks.status.push(callback as (value: { status: string }) => void);
				if (event === "sync") callbacks.sync.push(callback as (value: boolean) => void);
			}) as SyncProviderPort["on"],
		});
	};
}

type CurrentnessFailure = "session-replaced" | "invalid-ready" | "malformed-result" | "identity-set-mismatch";

async function createFailFastCurrentnessRuntime(failure: CurrentnessFailure): Promise<{
	runtime: VaultSync;
	bodyId: string;
	headReads: () => number;
	queryCount: () => number;
}> {
	const bodyId = `body-${failure}`;
	const content = "current body";
	const bytes = new TextEncoder().encode(content);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const contentHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const documents = new Map<string, StoredDocument>([[bodyId, storedBody(bodyId, content)]]);
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	});
	let headReads = 0;
	let queryCount = 0;
	const server = partialOf<VaultServerPort>({
		currentHead: async (requestedBodyId) => {
			headReads++;
			return { bodyId: requestedBodyId, bodyEpoch: 1, generation: 1, contentHash, size: bytes.byteLength };
		},
	});
	const factory: ProviderFactory = ({ kind, documentId }) => {
		const statusHandlers: Array<(event: { status: string }) => void> = [];
		const syncHandlers: Array<(synced: boolean) => void> = [];
		const customHandlers: Array<(payload: string) => void> = [];
		let connected = false;
		let socketSessionId = `socket-${documentId}-1`;
		const emitCustom = (value: unknown) => {
			const payload = JSON.stringify(value);
			for (const handler of customHandlers) handler(payload);
		};
		const readyFrame = (overrides: Record<string, unknown> = {}) => ({
			type: "VAULT_READY",
			documentId,
			socketSessionId,
			vaultGeneration: "generation-fail-fast",
			durableGeneration: 1,
			documentEpoch: 1,
			runtimeEpoch: "runtime-fail-fast",
			liveness: { version: 1, idleMs: 60_000, timeoutMs: 15_000 },
			capabilities: kind === "body" ? { currentnessQuery: 2, committedHead: 2 } : null,
			...overrides,
		});
		return partialOf<SyncProviderPort>({
			awareness: partialOf<SyncAwarenessPort>({
				setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map(),
			}),
			documentOrigin: {},
			get ws() { return connected ? { readyState: 1 } : null; },
			get wsconnected() { return connected; },
			get wsconnecting() { return false; },
			get synced() { return connected; },
			url: "ws://test/currentness-fail-fast",
			connect: () => {
				connected = true;
				for (const handler of statusHandlers) handler({ status: "connected" });
				emitCustom(readyFrame());
				for (const handler of syncHandlers) handler(true);
			},
			disconnect: () => { connected = false; },
			destroy: () => { connected = false; },
			sendMessage: (message) => {
				const query = JSON.parse(message) as { type: string; queryId: string; bodyIds: string[] };
				if (kind !== "body" || query.type !== "BODY_CURRENTNESS_QUERY") return;
				queryCount++;
				queueMicrotask(() => {
					const queriedSessionId = socketSessionId;
					if (failure === "session-replaced") {
						socketSessionId = `socket-${documentId}-2`;
						emitCustom(readyFrame());
						emitCustom({
							type: "BODY_CURRENTNESS_RESULT",
							queryId: query.queryId,
							socketSessionId: queriedSessionId,
							vaultSequence: 2,
							heads: [],
							missingBodyIds: query.bodyIds,
						});
						return;
					}
					if (failure === "invalid-ready") {
						emitCustom(readyFrame({ vaultGeneration: "wrong-generation" }));
						return;
					}
					if (failure === "malformed-result") {
						emitCustom({
							type: "BODY_CURRENTNESS_RESULT",
							queryId: query.queryId,
							vaultSequence: 2,
							heads: [],
							missingBodyIds: query.bodyIds,
						});
						return;
					}
					emitCustom({
						type: "BODY_CURRENTNESS_RESULT",
						queryId: query.queryId,
						socketSessionId,
						vaultSequence: 2,
						heads: [],
						missingBodyIds: ["different-body"],
					});
				});
			},
			on: ((event: string, callback: unknown) => {
				if (event === "status") statusHandlers.push(callback as (event: { status: string }) => void);
				if (event === "sync") syncHandlers.push(callback as (synced: boolean) => void);
				if (event === "custom-message") customHandlers.push(callback as (payload: string) => void);
			}) as SyncProviderPort["on"],
		});
	};
	const runtime = new VaultSync({
		vaultId: "vault-fail-fast",
		vaultGeneration: "generation-fail-fast",
		deviceId: "device-fail-fast",
		host: "https://sync.test",
		token: "token",
		database,
		server,
		providerFactory: factory,
	});
	runtime.ydoc.transact(() => runtime.pathToId.set("Current.md", bodyId), "test");
	return { runtime, bodyId, headReads: () => headReads, queryCount: () => queryCount };
}

s.test("editor admission reserves decode and socket, then socket pressure closes only warm transport", async () => {
	const documents = new Map<string, StoredDocument>([
		["one", storedBody("one", "first")],
		["two", storedBody("two", "second")],
	]);
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	});
	let headReads = 0;
	const server = partialOf<VaultServerPort>({
		currentHead: async (bodyId) => {
			headReads++;
			return { bodyId, bodyEpoch: 1, generation: 1 };
		},
	});
	let releaseFirstBody!: () => void;
	const firstBodyGate = new Promise<void>((resolve) => { releaseFirstBody = resolve; });
	const runtime = new VaultSync({
		vaultId: "vault",
		vaultGeneration: "generation",
		deviceId: "device",
		host: "https://sync.test",
		token: "token",
		database,
		server,
		providerFactory: providerFactory(firstBodyGate),
		residencyAdmissionLimits: { sockets: 2, reservedSockets: 1 },
	});
	runtime.ydoc.transact(() => {
		runtime.pathToId.set("One.md", "one");
		runtime.pathToId.set("Two.md", "two");
	}, "test");

	const firstAcquire = runtime.acquireEditorBody("One.md", "editor-one");
	await until(() => runtime.getResidencyAdmissionSnapshot().reservations === 1, {
		timeoutMs: 1_000,
		intervalMs: 0,
		message: "cold editor admission reservation",
	});
	const duringAdmission = runtime.getResidencyAdmissionSnapshot();
	assert.equal(duringAdmission.loads.reserved, 1);
	assert.equal(duringAdmission.sockets.reserved, 1);
	releaseFirstBody();
	await firstAcquire;
	assert.equal(runtime.getResidencyAdmissionSnapshot().populations.active, 1);
	const readsAfterFirstAcquire = headReads;
	await runtime.acquireEditorBody("One.md", "editor-split");
	assert.equal(headReads, readsAfterFirstAcquire, "a second active consumer performs no currentness request");
	const sharedAdmission = runtime.getEditorAdmissionDiagnostics().at(-1);
	assert.equal(sharedAdmission?.tier, "shared-active");
	assert.equal(sharedAdmission?.currentnessSource, "none");
	assert.equal(sharedAdmission?.httpFallback, false);
	assert.equal(sharedAdmission?.failureClass, null);
	assert.ok((sharedAdmission?.projectionMs ?? -1) >= 0);
	runtime.completeEditorBodyBinding("editor-split");
	const boundAdmission = runtime.getEditorAdmissionDiagnostics().at(-1);
	assert.equal(boundAdmission?.outcome, "bound");
	assert.ok((boundAdmission?.visibleToBoundMs ?? -1) >= (boundAdmission?.acquisitionMs ?? 0));
	assert.ok((boundAdmission?.cmBindMs ?? -1) >= 0);
	runtime.releaseEditorBody("One.md", "editor-split");

	runtime.releaseEditorBody("One.md", "editor-one");
	assert.equal(runtime.getResidencyAdmissionSnapshot().populations.warm, 1);
	assert.equal(runtime.getBodyResidencySnapshot().bodies[0]?.providerCount, 1);

	await runtime.acquireEditorBody("Two.md", "editor-two");
	assert.equal(runtime.isBodyLoaded("one"), true);
	const firstBody = runtime.getBodyResidencySnapshot().bodies.find((body) => body.bodyId === "one");
	assert.equal(firstBody?.providerCount, 0);
	assert.equal(runtime.getResidencyAdmissionSnapshot().sockets.used, 1);

	runtime.releaseEditorBody("Two.md", "editor-two");
	await runtime.destroy();
});

s.test("rapid editor switching leaves bounded warm bodies, sockets, and providers", async () => {
	const documents = new Map<string, StoredDocument>();
	for (let index = 0; index < 6; index++) {
		documents.set(`body-${index}`, storedBody(`body-${index}`, `content-${index}`));
	}
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
	const providerStats = { created: 0, destroyed: 0 };
	const runtime = new VaultSync({
		vaultId: "vault-switching",
		vaultGeneration: "generation-switching",
		deviceId: "device-switching",
		host: "https://sync.test",
		token: "token",
		database,
		server,
		providerFactory: providerFactory(Promise.resolve(), providerStats),
		maxLoadedBodies: 2,
		residencyAdmissionLimits: {
			warmBodies: 2,
			sockets: 3,
			reservedSockets: 1,
			warmRetentionMs: Number.MAX_SAFE_INTEGER,
		},
	});
	runtime.ydoc.transact(() => {
		for (let index = 0; index < 6; index++) {
			runtime.pathToId.set(`Note-${index}.md`, `body-${index}`);
		}
	}, "test");

	for (let index = 0; index < 100; index++) {
		const bodyIndex = index % 6;
		const path = `Note-${bodyIndex}.md`;
		const consumerId = `editor-${index}`;
		await runtime.acquireEditorBody(path, consumerId);
		runtime.releaseEditorBody(path, consumerId);
	}
	await runtime.runResidencyMaintenance();
	const admission = runtime.getResidencyAdmissionSnapshot();
	const residency = runtime.getBodyResidencySnapshot();
	assert.equal(admission.populations.active, 0);
	assert.ok(admission.populations.warm <= 2);
	assert.ok(admission.sockets.used + admission.sockets.fixed <= admission.sockets.limit);
	assert.equal(admission.reservations, 0);
	assert.equal(Object.values(admission.queue).reduce((total, count) => total + count, 0), 0);
	assert.equal(
		providerStats.created - providerStats.destroyed,
		residency.bodies.reduce((total, body) => total + body.providerCount, 0) + 1,
		"only reported warm providers plus the root provider remain",
	);

	await runtime.destroy();
	assert.equal(providerStats.destroyed, providerStats.created, "teardown destroys every created provider exactly once");
});

s.test("warm synced reacquisition uses the exact body-socket currentness query", async () => {
	const bodyId = "body-currentness";
	const content = "current body";
	const bytes = new TextEncoder().encode(content);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const contentHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	const documents = new Map<string, StoredDocument>([[bodyId, storedBody(bodyId, content)]]);
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	});
	let headReads = 0;
	const server = partialOf<VaultServerPort>({
		currentHead: async (requestedBodyId) => {
			headReads++;
			return { bodyId: requestedBodyId, bodyEpoch: 1, generation: 1, contentHash, size: bytes.byteLength };
		},
	});
	const factory: ProviderFactory = ({ kind, documentId }) => {
		const statusHandlers: Array<(event: { status: string }) => void> = [];
		const syncHandlers: Array<(synced: boolean) => void> = [];
		const customHandlers: Array<(payload: string) => void> = [];
		let connected = false;
		return partialOf<SyncProviderPort>({
			awareness: partialOf<SyncAwarenessPort>({
				setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map(),
			}),
			documentOrigin: {},
			get ws() { return connected ? { readyState: 1 } : null; },
			get wsconnected() { return connected; },
			get wsconnecting() { return false; },
			get synced() { return connected; },
			url: "ws://test/currentness",
			connect: () => {
				connected = true;
				for (const handler of statusHandlers) handler({ status: "connected" });
				for (const handler of customHandlers) handler(JSON.stringify({
					type: "VAULT_READY",
					documentId,
					socketSessionId: `socket-${documentId}`,
					vaultGeneration: "generation-currentness",
					durableGeneration: 1,
					documentEpoch: 1,
					runtimeEpoch: "runtime-currentness",
					liveness: { version: 1, idleMs: 60_000, timeoutMs: 15_000 },
					capabilities: { currentnessQuery: 2, committedHead: 2 },
				}));
				for (const handler of syncHandlers) handler(true);
			},
			disconnect: () => { connected = false; },
			destroy: () => { connected = false; },
			sendMessage: (message) => {
				const query = JSON.parse(message) as { type: string; queryId: string; bodyIds: string[] };
				if (query.type !== "BODY_CURRENTNESS_QUERY") return;
				queueMicrotask(() => {
					for (const handler of customHandlers) handler(JSON.stringify({
						type: "BODY_CURRENTNESS_RESULT",
						queryId: query.queryId,
						socketSessionId: `socket-${documentId}`,
						vaultSequence: 4,
						heads: query.bodyIds.map((requestedBodyId) => ({
							bodyId: requestedBodyId,
							bodyEpoch: 1,
							lifecycle: "active",
							generation: 1,
							contentHash,
							size: bytes.byteLength,
						})),
						missingBodyIds: [],
					}));
				});
			},
			on: ((event: string, callback: unknown) => {
				if (event === "status") statusHandlers.push(callback as (event: { status: string }) => void);
				if (event === "sync") syncHandlers.push(callback as (synced: boolean) => void);
				if (event === "custom-message") customHandlers.push(callback as (payload: string) => void);
			}) as SyncProviderPort["on"],
		});
	};
	const runtime = new VaultSync({
		vaultId: "vault-currentness",
		vaultGeneration: "generation-currentness",
		deviceId: "device-currentness",
		host: "https://sync.test",
		token: "token",
		database,
		server,
		providerFactory: factory,
	});
	runtime.ydoc.transact(() => runtime.pathToId.set("Current.md", bodyId), "test");
	await runtime.acquireEditorBody("Current.md", "editor-first");
	runtime.releaseEditorBody("Current.md", "editor-first");
	assert.equal(headReads, 1);
	await runtime.acquireEditorBody("Current.md", "editor-second");
	assert.equal(headReads, 1, "warm reacquisition replaces HEAD with the socket query");
	const warmAdmission = runtime.getEditorAdmissionDiagnostics().at(-1);
	assert.equal(warmAdmission?.tier, "warm-live");
	assert.equal(warmAdmission?.currentnessSource, "body-query");
	assert.equal(warmAdmission?.httpFallback, false);
	assert.equal(warmAdmission?.bodySizeBucket, "lt-16-kib");
	assert.ok((warmAdmission?.currentnessProofMs ?? -1) >= 0);
	runtime.releaseEditorBody("Current.md", "editor-second");
	await runtime.destroy();
});

for (const failure of [
	"session-replaced",
	"invalid-ready",
	"malformed-result",
	"identity-set-mismatch",
] as const) {
	s.test(`currentness ${failure} settles once and falls back immediately`, async () => {
		const harness = await createFailFastCurrentnessRuntime(failure);
		await harness.runtime.acquireEditorBody("Current.md", "editor-first");
		harness.runtime.releaseEditorBody("Current.md", "editor-first");
		assert.equal(harness.headReads(), 1);
		const startedAt = performance.now();
		await harness.runtime.acquireEditorBody("Current.md", "editor-second");
		const elapsedMs = performance.now() - startedAt;
		assert.ok(elapsedMs < 500, `${failure} waited ${elapsedMs}ms instead of failing fast`);
		assert.equal(harness.queryCount(), 1);
		assert.equal(harness.headReads(), 2, "fallback currentness executes exactly once");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(harness.headReads(), 2, "late frames cannot resettle a completed waiter");
		harness.runtime.releaseEditorBody("Current.md", "editor-second");
		await harness.runtime.destroy();
	});
}

await s.done();
