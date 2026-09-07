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
	return { documentId: bodyId, generation: 1, encodedState, dirty: false, updatedAt: 1 };
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
	const server = partialOf<VaultServerPort>({
		currentHead: async (bodyId) => ({ bodyId, generation: 1 }),
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
		currentHead: async (bodyId) => ({ bodyId, generation: 1 }),
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

await s.done();
