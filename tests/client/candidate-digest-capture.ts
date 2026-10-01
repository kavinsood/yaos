import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { candidateDigestMaterial } from "../../server/src/shared/candidateDigest";
import type { VaultAuthorityIdentity } from "../../src/collaboration/authority";
import {
	VaultSync,
	type CandidateRecord,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument, StoredSemanticEpochReplacement } from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const tests = suite("candidate-digest-capture");

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

function pauseDigest() {
	const originalDigest = crypto.subtle.digest;
	const started = gate();
	const continuation = gate();
	const digest: SubtleCrypto["digest"] = async (algorithm, data) => {
		started.release();
		await continuation.promise;
		return originalDigest.call(crypto.subtle, algorithm, data);
	};
	Object.defineProperty(crypto.subtle, "digest", { configurable: true, writable: true, value: digest });
	return {
		started: started.promise,
		release: continuation.release,
		restore: () => {
			continuation.release();
			Object.defineProperty(crypto.subtle, "digest", { configurable: true, writable: true, value: originalDigest });
		},
	};
}

async function digestHex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodedBody(content: string): Uint8Array {
	const document = new Y.Doc({ guid: "body-1" });
	document.getText("body").insert(0, content);
	const encoded = Y.encodeStateAsUpdate(document);
	document.destroy();
	return encoded;
}

async function fixture() {
	const bodyId = "body-1";
	const path = "Note.md";
	const documents = new Map<string, StoredDocument>([[bodyId, {
		kind: "body", documentId: bodyId, bodyEpoch: 1, durableBaseline: "base",
		generation: 1, encodedState: new Uint8Array(encodedBody("base")).buffer, dirty: false, updatedAt: 1,
	}]]);
	const candidates = new Map<string, CandidateRecord>();
	const replacements: StoredSemanticEpochReplacement[] = [];
	const submissions: CandidateRecord[] = [];
	let authority = {
		vaultId: "vault-1", vaultGeneration: "generation-1", principalId: "principal-1",
		membershipRevision: 1, deviceId: "device-1", deviceCredentialRevision: 1,
	};
	let timestamp = 100;
	const database: VaultDatabasePort = {
		getDocument: async (identity) => documents.get(identity) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_identity, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		replaceBodySemanticEpoch: async (replacement) => {
			replacements.push(replacement);
			documents.set(replacement.document.documentId, replacement.document);
			if (replacement.candidate) candidates.set(replacement.candidate.candidateId, replacement.candidate);
		},
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	};
	const server = partialOf<VaultServerPort>({
		currentHead: async (identity) => ({ bodyId: identity, bodyEpoch: 1, generation: 1 }),
		submitCandidate: async (candidate) => {
			submissions.push(candidate);
			throw new Error("offline test server");
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
		getAuthority: () => authority, now: () => timestamp,
		candidateDebounceMs: 60_000, candidateMaxWaitMs: 60_000,
	});
	runtime.ydoc.transact(() => runtime.pathToId.set(path, bodyId), "indexeddb-bootstrap");
	const body = await runtime.bodies.load(bodyId);
	return {
		runtime, body, bodyId, path, candidates, replacements, submissions, authority,
		setAuthority: (next: VaultAuthorityIdentity) => { authority = { ...next }; },
		setTime: (next: number) => { timestamp = next; },
		close: () => runtime.destroy(),
	};
}

tests.test("single-frame capture hashes and persists private bytes with pre-await metadata", async () => {
	const subject = await fixture();
	const backing = Uint8Array.of(99, 1, 2, 3, 99);
	const update = backing.subarray(1, 4);
	const original = new Uint8Array(update);
	const expectedAuthority = { ...subject.authority };
	const paused = pauseDigest();
	try {
		subject.body.pendingLocalUpdates = 3;
		const capture = subject.runtime["captureCandidate"](subject.bodyId, update, "single", 3);
		await paused.started;
		assert.equal(subject.candidates.size, 0);
		backing.fill(8);
		subject.body.doc.getText("body").insert(4, " later");
		subject.body.durableBaseline = "later baseline";
		subject.body.bodyEpoch = 2;
		subject.body.pendingLocalUpdates = 9;
		subject.authority.membershipRevision = 2;
		subject.authority.deviceCredentialRevision = 2;
		subject.runtime.ydoc.transact(() => {
			subject.runtime.pathToId.delete(subject.path);
			subject.runtime.pathToId.set("Renamed.md", subject.bodyId);
		}, "indexeddb-bootstrap");
		subject.setTime(200);
		paused.release();
		const pending = await capture;
		paused.restore();
		const record = subject.candidates.get("single")!;
		assert.equal(pending.record, record);
		assert.deepEqual(new Uint8Array(record.encodedUpdate), original);
		assert.equal(record.encodedUpdates, undefined);
		assert.equal(record.candidateDigest, await digestHex(original));
		assert.equal(record.bodyEpoch, 1);
		assert.equal(record.previousBaseline, "base");
		assert.equal(record.pendingMarkdown, "base");
		assert.equal(record.capturedLocalUpdates, 3);
		assert.equal(record.capturedAt, 100);
		assert.equal(pending.path, subject.path);
		assert.deepEqual(record.authority, expectedAuthority);
		assert.notEqual(record.authority, subject.authority);
		assert.equal(Object.isFrozen(record.authority), true);
	} finally { paused.restore(); await subject.close(); }
});

tests.test("multiframe capture freezes the frame list and each byte view before hashing", async () => {
	const subject = await fixture();
	const merged = Uint8Array.of(10, 20, 30);
	const backing = Uint8Array.of(99, 1, 2, 3, 4, 99);
	const frames = [backing.subarray(1, 3), backing.subarray(3, 5)];
	const originals = frames.map((frame) => new Uint8Array(frame));
	const paused = pauseDigest();
	try {
		const capture = subject.runtime["captureCandidate"](subject.bodyId, merged, "multi", 0, undefined, frames);
		await paused.started;
		merged.fill(8);
		backing.fill(9);
		frames[0] = Uint8Array.of(7);
		frames.push(Uint8Array.of(6));
		paused.release();
		const pending = await capture;
		paused.restore();
		assert.deepEqual(new Uint8Array(pending.record.encodedUpdate), Uint8Array.of(10, 20, 30));
		assert.deepEqual(pending.record.encodedUpdates?.map((frame) => new Uint8Array(frame)), originals);
		assert.equal(pending.record.candidateDigest, await digestHex(candidateDigestMaterial(originals)));
		assert.equal(pending.record, subject.candidates.get("multi"));
	} finally { paused.restore(); await subject.close(); }
});

tests.test("candidate ID retry compares captured bytes rather than mutated caller bytes", async () => {
	const subject = await fixture();
	try {
		const original = await subject.runtime["captureCandidate"](subject.bodyId, Uint8Array.of(1, 2, 3), "retry");
		const update = Uint8Array.of(1, 2, 3);
		const paused = pauseDigest();
		try {
			const retry = subject.runtime["captureCandidate"](subject.bodyId, update, "retry");
			await paused.started;
			update.fill(9);
			paused.release();
			assert.equal(await retry, original);
			assert.equal(subject.candidates.size, 1);
		} finally { paused.restore(); }
	} finally { await subject.close(); }
});

tests.test("authority replacement during digest cannot relabel or submit an ordinary candidate", async () => {
	const subject = await fixture();
	const expectedAuthority = { ...subject.authority };
	const paused = pauseDigest();
	try {
		const capture = subject.runtime["captureCandidate"](subject.bodyId, Uint8Array.of(1, 2, 3), "authority");
		await paused.started;
		subject.setAuthority({ ...subject.authority, principalId: "principal-2", membershipRevision: 2 });
		paused.release();
		const pending = await capture;
		paused.restore();
		assert.deepEqual(pending.record.authority, expectedAuthority);
		await assert.rejects(subject.runtime["submitCandidate"](pending), /authority_superseded/);
		assert.equal(subject.submissions.length, 0);
		assert.equal(subject.candidates.get("authority"), pending.record);
	} finally { paused.restore(); await subject.close(); }
});

tests.test("semantic rebase persists pre-digest authority, document intent and pending count", async () => {
	const subject = await fixture();
	subject.body.doc.getText("body").insert(4, " local");
	subject.body.pendingLocalUpdates = 3;
	const authoritativeState = encodedBody("base");
	const state = { bodyId: subject.bodyId, bodyEpoch: 2, generation: 7, encodedState: authoritativeState };
	const expectedAuthority = { ...subject.authority };
	const paused = pauseDigest();
	try {
		const rebase = subject.runtime["rebaseBodyAcrossSemanticEpoch"](subject.body, state);
		await paused.started;
		assert.equal(subject.replacements.length, 0);
		state.generation = 99;
		subject.setTime(200);
		paused.release();
		const replacement = await rebase;
		paused.restore();
		const stored = subject.replacements[0]!;
		const candidate = stored.candidate!;
		assert.equal(candidate.candidateDigest, await digestHex(new Uint8Array(candidate.encodedUpdate)));
		assert.equal(candidate.pendingMarkdown, "base local");
		assert.equal(candidate.previousBaseline, "base");
		assert.equal(candidate.bodyEpoch, 2);
		assert.equal(candidate.capturedLocalUpdates, 3);
		assert.equal(candidate.capturedAt, 100);
		assert.deepEqual(candidate.authority, expectedAuthority);
		assert.notEqual(candidate.authority, subject.authority);
		assert.equal(Object.isFrozen(candidate.authority), true);
		assert.equal(stored.document.pendingLocalUpdates, 3);
		assert.equal(stored.document.generation, 7);
		assert.equal(replacement.doc.getText("body").toString(), "base local");
		const reconstructed = new Y.Doc();
		try {
			Y.applyUpdate(reconstructed, authoritativeState);
			Y.applyUpdate(reconstructed, new Uint8Array(candidate.encodedUpdate));
			assert.equal(reconstructed.getText("body").toString(), candidate.pendingMarkdown);
		} finally { reconstructed.destroy(); }
		assert.equal(subject.submissions.length, 1);
	} finally { paused.restore(); await subject.close(); }
});

tests.test("semantic rebase refuses later input during digest without replacing the loaded body", async () => {
	const subject = await fixture();
	let installAttempts = 0;
	const install = subject.runtime.bodies.installSemanticEpochTransition.bind(subject.runtime.bodies);
	subject.runtime.bodies.installSemanticEpochTransition = async (...inputs) => {
		installAttempts++;
		return install(...inputs);
	};
	subject.body.doc.getText("body").insert(4, " local");
	subject.body.pendingLocalUpdates = 3;
	const originalDocument = subject.body.doc;
	const retained = await subject.runtime["captureCandidate"](
		subject.bodyId, Y.encodeStateAsUpdate(originalDocument), "retained", 3,
	);
	const paused = pauseDigest();
	try {
		const rebase = subject.runtime["rebaseBodyAcrossSemanticEpoch"](subject.body, {
			bodyId: subject.bodyId, bodyEpoch: 2, generation: 7, encodedState: encodedBody("base"),
		});
		await paused.started;
		originalDocument.getText("body").insert(10, " later");
		paused.release();
		await assert.rejects(rebase, /semantic epoch rebase snapshot superseded/);
		assert.equal(subject.runtime.bodies.get(subject.bodyId), subject.body);
		assert.equal(subject.body.doc, originalDocument);
		assert.equal(originalDocument.isDestroyed, false);
		assert.equal(originalDocument.getText("body").toString(), "base local later");
		assert.equal(subject.body.bodyEpoch, 1);
		assert.equal(installAttempts, 0);
		assert.equal(subject.replacements.length, 0);
		assert.equal(subject.submissions.length, 0);
		assert.equal(subject.candidates.get("retained"), retained.record);
		assert.equal(subject.runtime["pendingCandidates"].get("retained"), retained);
	} finally { paused.restore(); await subject.close(); }
});

tests.test("semantic rebase detects deletion-only changes during digest", async () => {
	const subject = await fixture();
	subject.body.doc.getText("body").insert(4, " local");
	const originalDocument = subject.body.doc;
	const originalVector = Y.encodeStateVector(originalDocument);
	const paused = pauseDigest();
	try {
		const rebase = subject.runtime["rebaseBodyAcrossSemanticEpoch"](subject.body, {
			bodyId: subject.bodyId, bodyEpoch: 2, generation: 7, encodedState: encodedBody("base"),
		});
		await paused.started;
		originalDocument.getText("body").delete(5, 5);
		assert.deepEqual(Y.encodeStateVector(originalDocument), originalVector);
		paused.release();
		await assert.rejects(rebase, /semantic epoch rebase snapshot superseded/);
		assert.equal(subject.runtime.bodies.get(subject.bodyId), subject.body);
		assert.equal(originalDocument.isDestroyed, false);
		assert.equal(originalDocument.getText("body").toString(), "base ");
		assert.equal(subject.replacements.length, 0);
	} finally { paused.restore(); await subject.close(); }
});

tests.test("semantic rebase refuses changed authority without relabeling existing candidates", async () => {
	const subject = await fixture();
	subject.body.doc.getText("body").insert(4, " local");
	const originalDocument = subject.body.doc;
	const expectedAuthority = { ...subject.authority };
	const retained = await subject.runtime["captureCandidate"](
		subject.bodyId, Y.encodeStateAsUpdate(originalDocument), "authority-retained",
	);
	const paused = pauseDigest();
	try {
		const rebase = subject.runtime["rebaseBodyAcrossSemanticEpoch"](subject.body, {
			bodyId: subject.bodyId, bodyEpoch: 2, generation: 7, encodedState: encodedBody("base"),
		});
		await paused.started;
		subject.authority.membershipRevision = 2;
		subject.authority.deviceCredentialRevision = 2;
		paused.release();
		await assert.rejects(rebase, /semantic epoch rebase snapshot superseded/);
		assert.equal(subject.runtime.bodies.get(subject.bodyId), subject.body);
		assert.equal(subject.body.doc, originalDocument);
		assert.equal(originalDocument.isDestroyed, false);
		assert.equal(originalDocument.getText("body").toString(), "base local");
		assert.equal(subject.body.bodyEpoch, 1);
		assert.equal(subject.replacements.length, 0);
		assert.equal(subject.submissions.length, 0);
		assert.equal(subject.candidates.get("authority-retained"), retained.record);
		assert.deepEqual(retained.record.authority, expectedAuthority);
		assert.equal(Object.isFrozen(retained.record.authority), true);
	} finally { paused.restore(); await subject.close(); }
});

await tests.done();
