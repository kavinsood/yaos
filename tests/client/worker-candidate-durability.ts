import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { ReconciliationWorker } from "../../src/runtime/reconciliationWorker";
import { VaultSync, type CandidateRecord, type SyncProviderPort, type VaultDatabasePort, type VaultServerPort } from "../../src/sync/vaultSync";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("worker-candidate-durability");

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

async function fixture() {
	const bodyId = "body-1";
	const path = "Note.md";
	const seed = new Y.Doc({ guid: bodyId });
	seed.getText("body").insert(0, "base");
	const documents = new Map<string, StoredDocument>([[bodyId, {
		kind: "body", documentId: bodyId, bodyEpoch: 1, durableBaseline: "base",
		generation: 1, encodedState: Y.encodeStateAsUpdate(seed).slice().buffer, dirty: false, updatedAt: 1,
	}]]);
	seed.destroy();
	const candidates = new Map<string, CandidateRecord>();
	const submissions: CandidateRecord[] = [];
	const candidatePersistence = gate();
	const receipt = gate();
	const remotePersistence = gate();
	let holdCandidate = false;
	let holdDocument = false;
	let failedCandidate = false;
	let documentWrites = 0;
	const hints: string[] = [];
	const database: VaultDatabasePort = {
		getDocument: async (identity) => documents.get(identity) ?? null,
		putDocument: async (document) => {
			documentWrites++;
			if (holdDocument) await remotePersistence.promise;
			documents.set(document.documentId, document);
		},
		putCandidate: async (candidate) => {
			if (holdCandidate) await candidatePersistence.promise;
			if (failedCandidate) throw new Error("candidate storage failed");
			candidates.set(candidate.candidateId, candidate);
		},
		deleteCandidate: async (_identity, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => ({ ...operation, localSequence: operation.localSequence || 1 }),
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	};
	const server = partialOf<VaultServerPort>({
		currentHead: async (identity) => ({ bodyId: identity, bodyEpoch: 1, generation: 1 }),
		submitCandidate: async (candidate) => {
			submissions.push(candidate);
			await receipt.promise;
			return {
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: candidate.bodyId,
				bodyEpoch: candidate.bodyEpoch, clientId: "device-1", candidateId: candidate.candidateId,
				candidateDigest: candidate.candidateDigest, durableGeneration: 2, runtimeEpoch: "runtime-1",
			};
		},
	});
	const provider = partialOf<SyncProviderPort>({
		awareness: { setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map() },
		documentOrigin: {}, ws: null, wsconnected: false, wsconnecting: false, synced: false,
		url: "ws://test/body", connect: () => {}, disconnect: () => {}, destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server, providerFactory: () => provider,
		onRemoteUpdateToClosedBody: (event) => { hints.push(event.path); },
		candidateDebounceMs: 60_000,
		candidateMaxWaitMs: 60_000,
	});
	runtime.ydoc.transact(() => runtime.pathToId.set(path, bodyId), "indexeddb-bootstrap");
	await runtime.bodies.load(bodyId);
	return {
		runtime, bodyId, path, candidates, submissions, hints, provider,
		candidatePersistence, receipt, remotePersistence, documentWrites: () => documentWrites,
		holdCandidate: () => { holdCandidate = true; },
		failCandidate: () => { failedCandidate = true; },
		holdDocument: () => { holdDocument = true; },
		close: async () => {
			candidatePersistence.release(); receipt.release(); remotePersistence.release();
			await runtime.destroy();
		},
	};
}

tests.test("durable local acceptance releases the filesystem worker without waiting for the server", async () => {
	const subject = await fixture();
	const worker = new ReconciliationWorker();
	try {
		subject.holdCandidate();
		const accepted = worker.run(() => subject.runtime.commitBodyCandidateIfCurrent({
			bodyId: subject.bodyId, path: subject.path, expectedContent: "base", content: "local",
			candidateId: "candidate-1", reason: "disk-ingest", waitForReceipt: false,
		}));
		let nextEffect = false;
		const following = worker.run(async () => { nextEffect = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(nextEffect, false);
		assert.equal(subject.submissions.length, 0, "no submission before candidate persistence");
		subject.candidatePersistence.release();
		assert.deepEqual(await accepted, { kind: "completed", receipt: null, pending: true });
		await following;
		assert.equal(nextEffect, true);
		assert.equal(subject.candidates.size, 1, "pending candidate retained while receipt is withheld");
		assert.equal(subject.runtime.hasUnconfirmedServerReceiptCandidate, true);
		subject.receipt.release();
		await until(() => subject.candidates.size === 0, { message: "confirmed candidate retired" });
	} finally { await subject.close(); }
});

tests.test("failed local persistence never reports acceptance or sends bytes", async () => {
	const subject = await fixture();
	try {
		subject.failCandidate();
		await assert.rejects(subject.runtime.commitBodyCandidateIfCurrent({
			bodyId: subject.bodyId, path: subject.path, expectedContent: "base", content: "local",
			candidateId: "candidate-1", reason: "disk-ingest", waitForReceipt: false,
		}), /candidate storage failed/);
		assert.equal(subject.submissions.length, 0);
		assert.equal(subject.candidates.size, 0);
	} finally { await subject.close(); }
});

tests.test("durable editor bursts coalesce before submission without a server write per keystroke", async () => {
	const subject = await fixture();
	try {
		const body = subject.runtime.bodies.get(subject.bodyId)!;
		const session = subject.runtime["createBodySession"](body);
		subject.runtime["sessions"].set(subject.bodyId, session);
		for (const suffix of [" one", " two", " three"]) {
			body.doc.transact(() => body.doc.getText("body").insert(body.doc.getText("body").length, suffix), "editor");
			await subject.runtime.flushReceiptPersistence();
		}
		assert.equal(subject.candidates.size, 3);
		assert.equal(subject.submissions.length, 0);
		const flushed = subject.runtime.flushBodyCandidate(subject.bodyId);
		await until(() => subject.submissions.length === 1, { message: "coalesced editor candidate submitted" });
		assert.equal(subject.candidates.size, 1);
		assert.equal(subject.submissions[0]!.pendingMarkdown, "base one two three");
		const reconstructed = new Y.Doc({ guid: subject.bodyId });
		Y.applyUpdate(reconstructed, Y.encodeStateAsUpdate(body.doc));
		Y.applyUpdate(reconstructed, new Uint8Array(subject.submissions[0]!.encodedUpdate));
		assert.equal(reconstructed.getText("body").toString(), "base one two three");
		reconstructed.destroy();
		subject.receipt.release();
		await flushed;
		assert.equal(subject.candidates.size, 0);
		assert.equal(body.dirty, false);
		assert.equal(body.pendingLocalUpdates, 0);
		assert.equal(body.unsettled, 0);
	} finally { await subject.close(); }
});

tests.test("remote closed-body projection is notified only after durable remote persistence", async () => {
	const subject = await fixture();
	try {
		const body = subject.runtime.bodies.get(subject.bodyId)!;
		const session = subject.runtime["createBodySession"](body);
		subject.runtime["sessions"].set(subject.bodyId, session);
		subject.holdDocument();
		const previousWrites = subject.documentWrites();
		body.doc.transact(() => body.doc.getText("body").insert(4, " remote"), subject.provider.documentOrigin);
		await until(() => subject.documentWrites() > previousWrites, { message: "remote persistence started" });
		assert.deepEqual(subject.hints, [], "volatile remote text cannot trigger disk projection");
		subject.remotePersistence.release();
		await until(() => subject.hints.length === 1, { message: "durable remote notification" });
		assert.deepEqual(subject.hints, [subject.path]);
	} finally { await subject.close(); }
});

await tests.done();
