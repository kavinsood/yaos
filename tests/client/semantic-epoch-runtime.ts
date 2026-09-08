import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { SCHEMA_VERSION } from "../../src/sync/schema";
import {
	ROOT_DOCUMENT_ID,
	VaultSync,
	VaultMutationRequestError,
	type BodyReceipt,
	type CandidateRecord,
	type ProviderFactory,
	type ProviderFactoryInput,
	type RootState,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type {
	StoredBodyCandidate,
	StoredDocument,
	StoredLifecycleOperation,
	StoredSemanticEpochReplacement,
} from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("semantic-epoch-runtime");

function encodedBody(bodyId: string, content: string): Uint8Array {
	const doc = new Y.Doc({ guid: bodyId });
	doc.getText("body").insert(0, content);
	const encoded = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return encoded;
}

function encodedRoot(entries: Readonly<Record<string, string>>): Uint8Array {
	const doc = new Y.Doc({ guid: ROOT_DOCUMENT_ID });
	doc.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
	for (const [path, bodyId] of Object.entries(entries)) doc.getMap<string>("pathToId").set(path, bodyId);
	const encoded = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return encoded;
}

class RecordingProvider implements SyncProviderPort {
	readonly awareness: SyncAwarenessPort = {
		setLocalStateField: () => {},
		destroy: () => { this.awarenessDestroyed = true; },
		getStates: () => new Map(),
	};
	readonly documentOrigin = {};
	url = "ws://test/semantic-epoch";
	wsconnected = false;
	wsconnecting = false;
	synced = false;
	destroyed = false;
	aborted = false;
	awarenessDestroyed = false;
	private readonly statusHandlers: Array<(event: { status: string }) => void> = [];
	private readonly syncHandlers: Array<(synced: boolean) => void> = [];
	private readonly customHandlers: Array<(payload: string) => void> = [];

	constructor(readonly input: ProviderFactoryInput) {}

	get ws(): { readonly readyState?: number; terminate?: () => void; close?: () => void } | null {
		return this.wsconnected ? { readyState: 1 } : null;
	}

	connect(): void {
		this.wsconnecting = true;
		this.statusHandlers.forEach((handler) => handler({ status: "connecting" }));
		this.wsconnecting = false;
		this.wsconnected = true;
		this.synced = true;
		this.statusHandlers.forEach((handler) => handler({ status: "connected" }));
		this.syncHandlers.forEach((handler) => handler(true));
	}

	disconnect(): void {
		this.wsconnected = false;
		this.wsconnecting = false;
		this.synced = false;
	}

	forceAbort(): void {
		this.aborted = true;
		this.disconnect();
	}

	destroy(): void {
		this.destroyed = true;
		this.disconnect();
	}

	on(event: "status" | "sync" | "custom-message", callback: never): void {
		if (event === "status") this.statusHandlers.push(callback as (event: { status: string }) => void);
		if (event === "sync") this.syncHandlers.push(callback as (synced: boolean) => void);
		if (event === "custom-message") this.customHandlers.push(callback as (payload: string) => void);
	}

	emit(frame: unknown): void {
		const payload = JSON.stringify(frame);
		this.customHandlers.forEach((handler) => handler(payload));
	}

	emitStatus(status: string): void {
		this.statusHandlers.forEach((handler) => handler({ status }));
	}
}

interface MemoryPersistence {
	readonly database: VaultDatabasePort;
	readonly documents: Map<string, StoredDocument>;
	readonly candidates: Map<string, StoredBodyCandidate>;
	readonly replacements: StoredSemanticEpochReplacement[];
}

function memoryPersistence(initialDocuments: readonly StoredDocument[]): MemoryPersistence {
	const documents = new Map(initialDocuments.map((document) => [document.documentId, document]));
	const candidates = new Map<string, StoredBodyCandidate>();
	const replacements: StoredSemanticEpochReplacement[] = [];
	const database: VaultDatabasePort = {
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		replaceBodySemanticEpoch: async (replacement) => {
			replacements.push(replacement);
			documents.set(replacement.document.documentId, replacement.document);
			for (const [candidateId, candidate] of candidates) {
				if (candidate.bodyId === replacement.document.documentId) candidates.delete(candidateId);
			}
			if (replacement.candidate) candidates.set(replacement.candidate.candidateId, replacement.candidate);
		},
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	};
	return { database, documents, candidates, replacements };
}

function storedRoot(rootEpoch: number, generation: number, entries: Readonly<Record<string, string>>): StoredDocument {
	return {
		kind: "root", documentId: ROOT_DOCUMENT_ID, rootEpoch, generation,
		encodedState: encodedRoot(entries).slice().buffer, dirty: false, updatedAt: 1,
	};
}

function storedBody(bodyId: string, bodyEpoch: number, generation: number, content: string): StoredDocument {
	return {
		kind: "body", documentId: bodyId, bodyEpoch, durableBaseline: content, generation,
		encodedState: encodedBody(bodyId, content).slice().buffer, dirty: false,
		pendingLocalUpdates: 0, updatedAt: 1,
	};
}

function providerRecorder(providers: RecordingProvider[]): ProviderFactory {
	return (input) => {
		const provider = new RecordingProvider(input);
		providers.push(provider);
		return provider;
	};
}

s.test("custom root provider is constructed from the persisted epoch and root document", async () => {
	const persistence = memoryPersistence([storedRoot(6, 12, { "Live.md": "body-live" })]);
	const providers: RecordingProvider[] = [];
	const runtime = await VaultSync.create({
		vaultId: "vault-root-preload", vaultGeneration: "generation-root-preload",
		deviceId: "device-root-preload", host: "https://sync.test", token: "token",
		database: persistence.database,
		server: {} as VaultServerPort,
		providerFactory: providerRecorder(providers),
	});
	try {
		assert.equal(providers.length, 1);
		assert.equal(providers[0]?.input.kind, "root");
		assert.equal(providers[0]?.input.documentEpoch, 6);
		assert.equal(providers[0]?.input.doc.getMap<string>("pathToId").get("Live.md"), "body-live");
		assert.equal(runtime.getFileId("Live.md"), "body-live");
	} finally {
		await runtime.destroy();
	}
});

s.test("active editor reset retires old identity and atomically persists a semantic rebase", async () => {
	const bodyId = "body-active";
	const path = "Active.md";
	const baseline = "title\nold line\nshared\n";
	const local = "local title\nold line\nshared\n";
	const authoritative = "title\nserver line\nshared\n";
	const authoritativeState = encodedBody(bodyId, authoritative);
	const persistence = memoryPersistence([
		storedRoot(1, 1, { [path]: bodyId }),
		storedBody(bodyId, 1, 1, baseline),
	]);
	const providers: RecordingProvider[] = [];
	const resetEvents: Array<{ purpose: "root" | "body"; documentId: string; previousEpoch: number; currentEpoch: number }> = [];
	let resetAttempts = 0;
	const submitted: CandidateRecord[] = [];
	let resolveReceipt!: (receipt: BodyReceipt) => void;
	const receipt = new Promise<BodyReceipt>((resolve) => { resolveReceipt = resolve; });
	const server = partialOf<VaultServerPort>({
		currentHead: async () => ({ bodyId, bodyEpoch: 1, generation: 1 }),
		currentBody: async () => ({ bodyId, bodyEpoch: 2, generation: 2, encodedState: authoritativeState }),
		submitCandidate: async (candidate) => { submitted.push(candidate); return receipt; },
	});
	const runtime = await VaultSync.create({
		vaultId: "vault-active", vaultGeneration: "generation-active", deviceId: "device-active",
		host: "https://sync.test", token: "token", database: persistence.database, server,
		providerFactory: providerRecorder(providers), candidateDebounceMs: 60_000,
		onSemanticEpochReset: (event) => {
			resetAttempts++;
			if (resetAttempts === 1) throw new Error("simulated editor reset integration failure");
			resetEvents.push(event);
		},
	});
	try {
		await runtime.acquireEditorBody(path, "editor-active");
		const oldText = runtime.getTextForPath(path);
		assert.ok(oldText);
		runtime.bodies.get(bodyId)!.doc.transact(() => {
			oldText!.delete(0, oldText!.length);
			oldText!.insert(0, local);
		}, "editor-test");
		assert.equal(runtime.getPathContent(path), local);
		assert.equal(runtime.bodies.get(bodyId)?.durableBaseline, baseline);
		persistence.candidates.set("stale-candidate", {
			candidateId: "stale-candidate", vaultId: "vault-active", bodyId, bodyEpoch: 1,
			previousBaseline: baseline, pendingMarkdown: local, candidateDigest: "stale",
			encodedUpdate: new ArrayBuffer(0), capturedAt: 1,
		});
		const oldBodyProvider = providers.find((provider) => provider.input.kind === "body");
		assert.ok(oldBodyProvider);
		oldBodyProvider!.emit({
			type: "SEMANTIC_EPOCH_RESET_REQUIRED", code: "semantic_epoch_mismatch",
			purpose: "body", documentId: bodyId, expectedEpoch: 2, receivedEpoch: 1,
		});
		await until(() => resetEvents.length === 1 && persistence.replacements.length === 1, {
			timeoutMs: 2_000, intervalMs: 0, message: "body semantic epoch recovery",
		});
		assert.equal(oldBodyProvider!.aborted, true);
		assert.equal(oldBodyProvider!.destroyed, true);
		assert.equal(runtime.isEditorBodyReady(path, "editor-active"), false);
		assert.equal(runtime.bodies.get(bodyId)?.bodyEpoch, 2);
		const expectedRebase = "local title\nserver line\nshared\n";
		assert.equal(runtime.getPathContent(path), expectedRebase, "installed body lost local Markdown intent");
		assert.deepEqual(resetEvents, [{
			purpose: "body", documentId: bodyId, previousEpoch: 1, currentEpoch: 2,
		}]);
		assert.equal(resetAttempts, 2,
			"a failed editor reset integration is retried after the authoritative epoch is installed");
		assert.equal(persistence.replacements.length, 1);
		assert.equal(persistence.replacements[0]?.document.bodyEpoch, 2);
		assert.equal(persistence.candidates.has("stale-candidate"), false);
		assert.equal(persistence.candidates.size, 1);
		const rebasedCandidate = persistence.replacements[0]?.candidate;
		assert.ok(rebasedCandidate);
		assert.equal(rebasedCandidate!.bodyEpoch, 2);
		assert.equal(rebasedCandidate!.pendingMarkdown, expectedRebase, "persisted rebase candidate lost local Markdown intent");
		await until(() => submitted.some((candidate) => candidate.candidateId === rebasedCandidate!.candidateId), {
			timeoutMs: 1_000, intervalMs: 0, message: "rebased candidate submission",
		});
		assert.equal(submitted.length, 1, "no old-epoch queued candidate crosses the reset fence");

		const reconstructed = new Y.Doc({ guid: bodyId });
		try {
			Y.applyUpdate(reconstructed, authoritativeState);
			Y.applyUpdate(reconstructed, new Uint8Array(rebasedCandidate!.encodedUpdate));
			assert.equal(reconstructed.getText("body").toJSON(), "local title\nserver line\nshared\n");
		} finally {
			reconstructed.destroy();
		}
		resolveReceipt({
			vaultId: "vault-active", vaultGeneration: "generation-active", bodyId, bodyEpoch: 2,
			clientId: "device-active", candidateId: rebasedCandidate!.candidateId,
			candidateDigest: rebasedCandidate!.candidateDigest, durableGeneration: 3, runtimeEpoch: "runtime-active",
		});
		await until(() => persistence.candidates.size === 0, {
			timeoutMs: 1_000, intervalMs: 0, message: "rebased candidate settlement",
		});
	} finally {
		await runtime.destroy();
	}
});

s.test("a stale Markdown lifecycle intent rebinds durably and succeeds after restart", async () => {
	const bodyId = "body-lifecycle-restart";
	const operationId = "delete-across-body-reset";
	const persistence = memoryPersistence([
		storedRoot(1, 1, { "Retired.md": bodyId }),
		storedBody(bodyId, 1, 1, "same semantic text\n"),
	]);
	const lifecycle = new Map<string, StoredLifecycleOperation>([[operationId, {
		operationId, kind: "delete", bodyId, bodyEpoch: 1, path: "Retired.md",
		previousPath: null, content: null, createdAt: 1, attempts: 0, lastAttemptAt: null,
	}]]);
	Object.assign(persistence.database, {
		putLifecycleOperation: async (operation: StoredLifecycleOperation) => {
			lifecycle.set(operation.operationId, { ...operation });
		},
		listLifecycleOperations: async () => [...lifecycle.values()].map((operation) => ({ ...operation })),
		deleteLifecycleOperation: async (id: string) => { lifecycle.delete(id); },
	});
	const authoritativeState = encodedBody(bodyId, "same semantic text\n");
	let commits = 0;
	const server = partialOf<VaultServerPort>({
		currentBody: async () => ({ bodyId, bodyEpoch: 2, generation: 1, encodedState: authoritativeState }),
		commitLifecycle: async (request) => {
			commits++;
			if (request.bodyEpoch === 1) {
				throw new VaultMutationRequestError(409, "semantic_epoch_mismatch", "lifecycle", {
					error: "semantic_epoch_mismatch", purpose: "body", documentId: bodyId,
					expectedEpoch: 2, receivedEpoch: 1, reset: "fetch_fresh_baseline",
				});
			}
			return { vaultId: "vault-lifecycle", vaultGeneration: "generation-lifecycle",
				bodyId, bodyEpoch: request.bodyEpoch, operationId, kind: "delete",
				durableGeneration: 1, vaultSequence: 8, runtimeEpoch: "runtime-2" };
		},
		publishLifecycleRoot: async (operations, _update, rootEpoch) => ({
			operationIds: operations.map((operation) => operation.operationId),
			vaultGeneration: "generation-lifecycle", vaultSequence: 9,
			rootGeneration: 2, rootEpoch, runtimeEpoch: "runtime-2",
		}),
	});
	const options = {
		vaultId: "vault-lifecycle", vaultGeneration: "generation-lifecycle", deviceId: "device-lifecycle",
		host: "https://sync.test", token: "token", database: persistence.database, server,
		providerFactory: providerRecorder([]),
	};
	const first = await VaultSync.create(options);
	assert.equal(commits, 1);
	assert.equal(lifecycle.get(operationId)?.bodyEpoch, 2,
		"the old durable row is rebound before shutdown instead of retrying epoch one forever");
	const recoveredBody = persistence.documents.get(bodyId);
	assert.equal(recoveredBody?.kind, "body");
	if (recoveredBody?.kind === "body") assert.equal(recoveredBody.bodyEpoch, 2);
	await first.destroy();

	const second = await VaultSync.create(options);
	assert.equal(commits, 2);
	assert.equal(lifecycle.size, 0, "the rebound lifecycle operation settles after restart");
	await second.destroy();
});

s.test("conflicting offline Markdown is preserved before the fresh epoch replaces old CRDT identities", async () => {
	const bodyId = "body-conflicting-offline";
	const path = "Conflicting offline.md";
	const baseline = "shared line\n";
	const local = "local rewrite\n";
	const authoritative = "remote rewrite\n";
	const persistence = memoryPersistence([
		storedRoot(1, 1, { [path]: bodyId }),
		storedBody(bodyId, 1, 1, baseline),
	]);
	const providers: RecordingProvider[] = [];
	const preserved: Array<{ path: string; pendingMarkdown: string; authoritativeContent: string; kind: string }> = [];
	const resets: number[] = [];
	const runtime = await VaultSync.create({
		vaultId: "vault-conflict", vaultGeneration: "generation-conflict", deviceId: "device-conflict",
		host: "https://sync.test", token: "token", database: persistence.database,
		server: partialOf<VaultServerPort>({
			currentHead: async () => ({ bodyId, bodyEpoch: 1, generation: 1 }),
			currentBody: async () => ({ bodyId, bodyEpoch: 2, generation: 2,
				encodedState: encodedBody(bodyId, authoritative) }),
		}),
		providerFactory: providerRecorder(providers),
		onSemanticEpochRebaseConflict: (event) => { preserved.push(event); },
		onSemanticEpochReset: (event) => { if (event.purpose === "body") resets.push(event.currentEpoch); },
	});
	try {
		await runtime.acquireEditorBody(path, "editor-conflict");
		const text = runtime.getTextForPath(path)!;
		text.doc!.transact(() => {
			text.delete(0, text.length);
			text.insert(0, local);
		}, "offline-conflict-test");
		const bodyProvider = providers.find((provider) => provider.input.kind === "body")!;
		bodyProvider.emit({
			type: "SEMANTIC_EPOCH_RESET_REQUIRED", code: "semantic_epoch_mismatch",
			purpose: "body", documentId: bodyId, expectedEpoch: 2, receivedEpoch: 1,
		});
		await until(() => persistence.replacements.length === 1 && resets.length === 1, {
			timeoutMs: 2_000, intervalMs: 0, message: "conflicting semantic epoch recovery",
		});
		assert.equal(preserved.length, 1);
		assert.deepEqual(preserved[0], { bodyId, path, previousEpoch: 1, currentEpoch: 2,
			pendingMarkdown: local, authoritativeContent: authoritative, kind: "conflict" });
		assert.equal(runtime.bodies.get(bodyId)?.bodyEpoch, 2);
		assert.equal(runtime.getPathContent(path), authoritative,
			"the live path must adopt the fresh authoritative epoch after preserving local intent");
		assert.equal(persistence.replacements[0]?.candidate, null,
			"conflicting old identities must not become a new-epoch Yjs candidate");
		assert.equal(persistence.candidates.size, 0);
	} finally {
		await runtime.destroy();
	}
});

s.test("root reset retires the old provider and installs only the fresh catalog epoch", async () => {
	const persistence = memoryPersistence([storedRoot(3, 8, { "Dead.md": "dead-body" })]);
	const providers: RecordingProvider[] = [];
	const resetEvents: Array<{ purpose: "root" | "body"; documentId: string; previousEpoch: number; currentEpoch: number }> = [];
	const rootState: RootState = {
		rootEpoch: 4, generation: 9, encodedState: encodedRoot({ "Live.md": "live-body" }),
	};
	const runtime = await VaultSync.create({
		vaultId: "vault-root-reset", vaultGeneration: "generation-root-reset", deviceId: "device-root-reset",
		host: "https://sync.test", token: "token", database: persistence.database,
		server: { currentRoot: async () => rootState } as VaultServerPort,
		providerFactory: providerRecorder(providers),
		onSemanticEpochReset: (event) => { resetEvents.push(event); },
	});
	try {
		const oldProvider = providers[0];
		const oldDocument = runtime.ydoc;
		oldProvider!.emit({
			type: "SEMANTIC_EPOCH_RESET_REQUIRED", code: "semantic_epoch_mismatch",
			purpose: "root", documentId: ROOT_DOCUMENT_ID, expectedEpoch: 4, receivedEpoch: 3,
		});
		await until(() => resetEvents.length === 1, {
			timeoutMs: 2_000, intervalMs: 0, message: "root semantic epoch recovery",
		});
		assert.equal(providers.length, 2);
		assert.equal(oldProvider!.aborted, true);
		assert.equal(oldProvider!.destroyed, true);
		assert.equal(oldProvider!.awarenessDestroyed, true);
		assert.notEqual(runtime.ydoc, oldDocument);
		assert.equal(providers[1]?.input.doc, runtime.ydoc);
		assert.equal(providers[1]?.input.documentEpoch, 4);
		assert.equal(providers[1]?.wsconnected, true);
		oldProvider!.emitStatus("disconnected");
		assert.equal(providers[1]?.wsconnected, true, "late old-provider events cannot disconnect the new epoch");
		assert.equal(runtime.getFileId("Dead.md"), undefined);
		assert.equal(runtime.getFileId("Live.md"), "live-body");
		assert.equal(persistence.documents.get(ROOT_DOCUMENT_ID)?.kind, "root");
		assert.equal((persistence.documents.get(ROOT_DOCUMENT_ID) as Extract<StoredDocument, { kind: "root" }>).rootEpoch, 4);
		assert.deepEqual(resetEvents, [{
			purpose: "root", documentId: ROOT_DOCUMENT_ID, previousEpoch: 3, currentEpoch: 4,
		}]);
	} finally {
		await runtime.destroy();
	}
});

await s.done();
