import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { VaultCandidateService } from "../../server/src/vaultCandidateService";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import { suite } from "../harness.ts";

const s = suite("vault-candidate-runtime");
const BODY_ID = "body-candidate-0001";
const DEVICE_ID = "device-candidate-0001";
const CANDIDATE_ID = "candidate-runtime-0001";

async function digest(bytes: Uint8Array): Promise<string> {
	const value = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Receipt {
	bodyId: string;
	bodyEpoch: number;
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	vaultSequence: number;
	vaultGeneration: string;
	runtimeEpoch: string;
}

class CandidateStore {
	readonly receipts = new Map<string, Receipt>();
	commits = 0;
	reconstructions = 0;
	appliedUpdates = 0;
	lastCommit: { expectedHead: { generation: number; semanticEpoch: number; latestSequence: number } | null; changesState: boolean } | null = null;
	throwAfterCommit = false;
	private durableUpdate: Uint8Array | null = null;
	creation: {
		bodyId: string; fileId: string; path: string; operationId: string;
		candidateId: string; candidateDigest: string; bodyEpoch: number;
		durableGeneration: number; vaultSequence: number; vaultGeneration: string; runtimeEpoch: string;
	} | null = null;
	private head = { generation: 1, semanticEpoch: 1, latestSequence: 1 };
	currentSequence(): number { return 1; }
	creationCandidate() { return this.creation; }
	getCatalogHeadAt() {
		if (this.creation) return null;
		return { bodyId: BODY_ID, fileId: BODY_ID, path: "candidate.md", previousPath: null, lifecycle: "active", generation: 1, sequence: 1, contentHash: null, size: 0 } as const;
	}
	candidateReceipt(bodyId: string, clientId: string, candidateId: string): Receipt | null {
		return this.receipts.get(`${bodyId}\u0000${clientId}\u0000${candidateId}`) ?? null;
	}
	reconstructDocument() {
		this.reconstructions++;
		const doc = new Y.Doc({ guid: BODY_ID });
		doc.on("update", () => { this.appliedUpdates++; });
		if (this.durableUpdate) Y.applyUpdate(doc, this.durableUpdate);
		return { doc, generation: this.head.generation, semanticEpoch: 1 };
	}
	documentHead() { return { ...this.head }; }
	advanceSemanticEpoch(): void { this.head = { ...this.head, semanticEpoch: this.head.semanticEpoch + 1 }; }
	documentEncodedHistoryBytes(): number { return 1; }
	commitCandidate(input: { bodyId: string; clientId: string; candidateId: string; candidateDigest: string;
		update: Uint8Array;
		bodyEpoch: number; expectedHead: { generation: number; semanticEpoch: number; latestSequence: number } | null; changesState: boolean;
		vaultGeneration: string; runtimeEpoch: string }): Receipt {
		const key = `${input.bodyId}\u0000${input.clientId}\u0000${input.candidateId}`;
		const replay = this.receipts.get(key);
		if (replay) return replay;
		this.commits++;
		this.lastCommit = { expectedHead: input.expectedHead, changesState: input.changesState };
		if (input.changesState) {
			this.head = { ...this.head, generation: this.head.generation + 1, latestSequence: this.head.latestSequence + 1 };
			this.durableUpdate = input.update.slice();
		}
		const receipt = { ...input, durableGeneration: this.head.generation, vaultSequence: this.head.latestSequence };
		this.receipts.set(key, receipt);
		if (this.throwAfterCommit) {
			this.throwAfterCommit = false;
			throw new Error("reply was lost after durable commit");
		}
		return receipt;
	}
}

function makeService(
	store: CandidateStore,
	shouldPauseAdmission: () => boolean = () => false,
	finalizeCreation: () => "committed" | "busy" | "superseded" = () => "committed",
) {
	let flushes = 0;
	let notifications = 0;
	const cache = new VaultDocumentCache(store as never, () => new Set(), () => new Set());
	const service = new VaultCandidateService({
		store,
		cache,
		lifecycle: () => ({ finalizeCreation }),
		sockets: () => ({
			broadcastDocumentUpdate: () => {},
			notifyBodyCommitted: () => { notifications++; },
		}),
		vaultId: () => "vault-candidate-0001",
		vaultGeneration: () => "generation-candidate-0001",
		runtimeEpoch: "epoch-candidate-0001",
		flush: async () => { flushes++; return true; },
		shouldPauseAdmission,
	} as never);
	return { service, flushes: () => flushes, notifications: () => notifications };
}

s.test("durable creation replay re-enters exact lifecycle finalization after restart", async () => {
	const document = new Y.Doc({ guid: BODY_ID });
	document.getText("body").insert(0, "restart-safe creation");
	const update = Y.encodeStateAsUpdate(document);
	document.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	store.creation = {
		bodyId: BODY_ID,
		fileId: BODY_ID,
		path: "restart-safe.md",
		operationId: "create-restart-safe",
		candidateId: CANDIDATE_ID,
		candidateDigest,
		bodyEpoch: 1,
		durableGeneration: 1,
		vaultSequence: 1,
		vaultGeneration: "generation-candidate-0001",
		runtimeEpoch: "epoch-candidate-0001",
	};
	let firstFinalizations = 0;
	const beforeRestart = makeService(store, () => false, () => {
		firstFinalizations++;
		return "busy";
	});
	const interrupted = await beforeRestart.service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(interrupted.status, 409);
	assert.deepEqual(await interrupted.json(), { error: "recovery_boundary_in_progress" });
	assert.equal(store.commits, 1);
	assert.equal(firstFinalizations, 1);

	let replayFinalizations = 0;
	const afterRestart = makeService(store, () => false, () => {
		replayFinalizations++;
		return "committed";
	});
	const replayed = await afterRestart.service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(replayed.status, 200);
	assert.equal(store.commits, 1, "restart replay does not create another durable commit");
	assert.equal(store.receipts.size, 1, "creation replay remains exactly idempotent");
	assert.equal(replayFinalizations, 1, "restart replay retries the missing root lifecycle transaction");
});

s.test("compaction pressure rejects new candidates before body work but preserves receipt replay", async () => {
	const document = new Y.Doc({ guid: BODY_ID });
	document.getText("body").insert(0, "pressure candidate");
	const update = Y.encodeStateAsUpdate(document);
	document.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	let paused = false;
	const harness = makeService(store, () => paused);
	const committed = await harness.service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(committed.status, 200);
	paused = true;
	const replay = await harness.service.handle(BODY_ID, candidateRequest(candidateDigest));
	assert.equal(replay.status, 200, "durable idempotency replay remains available during pressure");

	const freshId = "candidate-pressure-fresh";
	const fresh = candidateRequest(candidateDigest, update);
	fresh.headers.set("x-yaos-candidate-id", freshId);
	const rejected = await harness.service.handle(BODY_ID, fresh);
	assert.equal(rejected.status, 429);
	assert.equal(rejected.headers.get("retry-after"), "1");
	assert.deepEqual(await rejected.json(), { error: "semantic_compaction_backpressure" });
	assert.equal(harness.flushes(), 1, "paused candidate is rejected before flushing or Yjs validation");
	assert.equal(store.commits, 1);
});

function candidateRequest(candidateDigest: string, body?: Uint8Array, bodyEpoch = 1): Request {
	return new Request(`https://internal/body/${BODY_ID}/candidate`, {
		method: "POST",
		headers: {
			"x-yaos-device-id": DEVICE_ID,
			"x-yaos-candidate-id": CANDIDATE_ID,
			"x-yaos-candidate-digest": candidateDigest,
			"x-yaos-body-epoch": String(bodyEpoch),
		},
		body: body?.slice().buffer,
	});
}

async function submitSemanticCandidate(doc: Y.Doc): Promise<{
	response: Response;
	store: CandidateStore;
}> {
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	const { service } = makeService(store);
	return { response: await service.handle(BODY_ID, candidateRequest(candidateDigest, update)), store };
}

s.test("durable candidate receipt is device-scoped and exact", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getText("body").insert(0, "durable candidate");
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	const { service, flushes, notifications } = makeService(store);
	const response = await service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		vaultId: "vault-candidate-0001",
		vaultGeneration: "generation-candidate-0001",
		bodyId: BODY_ID,
		bodyEpoch: 1,
		clientId: DEVICE_ID,
		candidateId: CANDIDATE_ID,
		candidateDigest,
		durableGeneration: 2,
		runtimeEpoch: "epoch-candidate-0001",
	});
	assert.equal(flushes(), 1);
	assert.equal(notifications(), 1);
	assert.equal(store.reconstructions, 1, "candidate metadata validation reconstructs exactly once");
	assert.equal(store.appliedUpdates, 1, "the changed update is applied exactly once during validation");
	assert.deepEqual(store.lastCommit, {
		expectedHead: { generation: 1, semanticEpoch: 1, latestSequence: 1 },
		changesState: true,
	}, "the validated state decision and exact head are reused by commit");
});

s.test("stale semantic-epoch candidates are fenced before validation or persistence", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getText("body").insert(0, "stale identity");
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	store.advanceSemanticEpoch();
	const { service, flushes } = makeService(store);
	const response = await service.handle(BODY_ID, candidateRequest(candidateDigest, update, 1));
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "semantic_epoch_mismatch", purpose: "body", documentId: BODY_ID,
		expectedEpoch: 2, receivedEpoch: 1, reset: "fetch_fresh_baseline",
	});
	assert.equal(flushes(), 0);
	assert.equal(store.reconstructions, 0);
	assert.equal(store.commits, 0);
});

s.test("semantic no-op preserves the current generation while writing an exact receipt", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	const { service, notifications } = makeService(store);
	const response = await service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(response.status, 200);
	const receipt = await response.json() as { durableGeneration: number; candidateDigest: string };
	assert.equal(receipt.durableGeneration, 1);
	assert.equal(receipt.candidateDigest, candidateDigest);
	assert.deepEqual(store.lastCommit, {
		expectedHead: { generation: 1, semanticEpoch: 1, latestSequence: 1 },
		changesState: false,
	});
	assert.equal(store.reconstructions, 1);
	assert.equal(store.appliedUpdates, 0, "applying a redundant update emits no Yjs state change");
	assert.equal(notifications(), 1, "the durable no-op receipt still settles waiting clients");
});

s.test("replay returns the original receipt and digest collision fails before another write", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	const { service, flushes } = makeService(store);
	const initial = await service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(initial.status, 200);
	const initialReceipt = await initial.json();
	const replay = await service.handle(BODY_ID, candidateRequest(candidateDigest));
	assert.equal(replay.status, 200);
	assert.deepEqual(await replay.json(), initialReceipt);
	const collision = await service.handle(BODY_ID, candidateRequest("f".repeat(64)));
	assert.equal(collision.status, 409);
	assert.equal((await collision.json() as { error: string }).error, "candidate_id_reused_with_different_digest");
	assert.equal(store.commits, 1);
	assert.equal(flushes(), 1);
});

s.test("lost response after durable commit is recovered from the receipt ledger", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getText("body").insert(0, "persisted before transport loss");
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	store.throwAfterCommit = true;
	const { service } = makeService(store);
	const recovered = await service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(recovered.status, 200);
	assert.equal((await recovered.json() as { candidateDigest: string }).candidateDigest, candidateDigest);
	assert.equal(store.commits, 1);
});

s.test("server rejects a candidate whose resulting Markdown is not canonical", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getText("body").insert(0, "line one\r\nline two\r\n");
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	const { service, notifications } = makeService(store);
	const response = await service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(response.status, 409);
	assert.equal((await response.json() as { error: string }).error, "candidate_markdown_not_canonical");
	assert.equal(store.commits, 0, "non-canonical text never reaches durable history");
	assert.equal(notifications(), 0, "rejected candidate is not broadcast as committed");
});

s.test("server rejects Markdown beyond the shared recovery-safe byte ceiling", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getText("body").insert(0, "x".repeat(1_500_001));
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	assert.ok(update.byteLength < 1_750_000, "fixture must pass the durable update-size gate");
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	const { service, notifications } = makeService(store);
	const response = await service.handle(BODY_ID, candidateRequest(candidateDigest, update));
	assert.equal(response.status, 413);
	assert.equal((await response.json() as { error: string }).error, "candidate_markdown_too_large");
	assert.equal(store.commits, 0);
	assert.equal(notifications(), 0);
});

s.test("server admits bounded semantic frontmatter roots", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getMap<number>("frontmatter:meta").set("format", 1);
	doc.getMap("frontmatter:registers").set("title", { kind: "value", key: "title", value: "" });
	doc.getMap("frontmatter:presence").set("aliases", { present: true, key: "aliases" });
	doc.getArray("frontmatter:ordered:aliases").push(["", "two"]);
	const { response, store } = await submitSemanticCandidate(doc);
	assert.equal(response.status, 200);
	assert.equal(store.commits, 1);
});

s.test("server rejects unexpected or incorrectly typed semantic roots without throwing", async () => {
	for (const configure of [
		(doc: Y.Doc) => doc.getArray("frontmatter:meta").push([1]),
		(doc: Y.Doc) => {
			doc.getMap<number>("frontmatter:meta").set("format", 1);
			doc.getMap("frontmatter:ordered:aliases").set("not", "an-array");
		},
		(doc: Y.Doc) => {
			doc.getMap<number>("frontmatter:meta").set("format", 1);
			doc.getMap("frontmatter:future-root").set("value", true);
		},
	]) {
		const doc = new Y.Doc({ guid: BODY_ID });
		configure(doc);
		const { response, store } = await submitSemanticCandidate(doc);
		assert.equal(response.status, 409);
		assert.equal((await response.json() as { error: string }).error, "frontmatter_semantic_root_invalid");
		assert.equal(store.commits, 0);
	}
});

s.test("server bounds semantic scalar and aggregate ordered bytes before admission", async () => {
	const oversizedScalar = new Y.Doc({ guid: BODY_ID });
	oversizedScalar.getMap<number>("frontmatter:meta").set("format", 1);
	oversizedScalar.getMap("frontmatter:registers").set("title", {
		kind: "value",
		key: "title",
		value: "x".repeat(16 * 1024 + 1),
	});
	const scalarResult = await submitSemanticCandidate(oversizedScalar);
	assert.equal(scalarResult.response.status, 409);
	assert.equal((await scalarResult.response.json() as { error: string }).error, "frontmatter_semantic_register_invalid");
	assert.equal(scalarResult.store.commits, 0);

	const oversizedAggregate = new Y.Doc({ guid: BODY_ID });
	oversizedAggregate.getMap<number>("frontmatter:meta").set("format", 1);
	oversizedAggregate.getArray("frontmatter:ordered:aliases").push(
		Array.from({ length: 17 }, (_, index) => `${index}:${"x".repeat(16 * 1024 - 4)}`),
	);
	const aggregateResult = await submitSemanticCandidate(oversizedAggregate);
	assert.equal(aggregateResult.response.status, 409);
	assert.equal((await aggregateResult.response.json() as { error: string }).error, "frontmatter_semantic_limit_exceeded");
	assert.equal(aggregateResult.store.commits, 0);
});

s.test("server binds semantic display keys to their normalized field", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	doc.getMap<number>("frontmatter:meta").set("format", 1);
	doc.getMap("frontmatter:registers").set("title", {
		kind: "value",
		key: "unrelated",
		value: "unsafe projection target",
	});
	const { response, store } = await submitSemanticCandidate(doc);
	assert.equal(response.status, 409);
	assert.equal((await response.json() as { error: string }).error, "frontmatter_semantic_register_invalid");
	assert.equal(store.commits, 0);
});

await s.done();
