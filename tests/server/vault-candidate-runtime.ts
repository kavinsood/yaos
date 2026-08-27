import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { VaultCandidateService } from "../../server/src/vaultCandidateService";
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
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	vaultGeneration: string;
	runtimeEpoch: string;
}

class CandidateStore {
	readonly receipts = new Map<string, Receipt>();
	commits = 0;
	throwAfterCommit = false;
	currentSequence(): number { return 1; }
	creationCandidate(): null { return null; }
	getCatalogHeadAt() {
		return { bodyId: BODY_ID, fileId: BODY_ID, path: "candidate.md", previousPath: null, lifecycle: "active", generation: 1, sequence: 1, contentHash: null, size: 0 } as const;
	}
	candidateReceipt(bodyId: string, clientId: string, candidateId: string): Receipt | null {
		return this.receipts.get(`${bodyId}\u0000${clientId}\u0000${candidateId}`) ?? null;
	}
	reconstructDocument() {
		return { doc: new Y.Doc({ guid: BODY_ID }), generation: 1 };
	}
	documentHead() { return { generation: 1, latestSequence: 1 }; }
	documentEncodedHistoryBytes(): number { return 1; }
	commitCandidate(input: { bodyId: string; clientId: string; candidateId: string; candidateDigest: string; vaultGeneration: string; runtimeEpoch: string }): Receipt {
		this.commits++;
		const receipt = { ...input, durableGeneration: 2 };
		this.receipts.set(`${input.bodyId}\u0000${input.clientId}\u0000${input.candidateId}`, receipt);
		if (this.throwAfterCommit) {
			this.throwAfterCommit = false;
			throw new Error("reply was lost after durable commit");
		}
		return receipt;
	}
}

function makeService(store: CandidateStore) {
	let flushes = 0;
	let notifications = 0;
	const service = new VaultCandidateService({
		store,
		cache: {
			recordTransient: () => () => {},
			applyDurableUpdate: () => false,
			removePendingDigest: () => {},
		},
		lifecycle: () => ({ finalizeCreation: () => true }),
		sockets: () => ({
			broadcastDocumentUpdate: () => {},
			notifyBodyCommitted: () => { notifications++; },
		}),
		vaultId: () => "vault-candidate-0001",
		vaultGeneration: () => "generation-candidate-0001",
		runtimeEpoch: "epoch-candidate-0001",
		flush: async () => { flushes++; return true; },
	} as never);
	return { service, flushes: () => flushes, notifications: () => notifications };
}

function candidateRequest(candidateDigest: string, body?: Uint8Array): Request {
	return new Request(`https://internal/body/${BODY_ID}/candidate`, {
		method: "POST",
		headers: {
			"x-yaos-device-id": DEVICE_ID,
			"x-yaos-candidate-id": CANDIDATE_ID,
			"x-yaos-candidate-digest": candidateDigest,
		},
		body: body?.slice().buffer,
	});
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
		clientId: DEVICE_ID,
		candidateId: CANDIDATE_ID,
		candidateDigest,
		durableGeneration: 2,
		runtimeEpoch: "epoch-candidate-0001",
	});
	assert.equal(flushes(), 1);
	assert.equal(notifications(), 1);
});

s.test("replay returns the original receipt and digest collision fails before another write", async () => {
	const doc = new Y.Doc({ guid: BODY_ID });
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	const candidateDigest = await digest(update);
	const store = new CandidateStore();
	const { service, flushes } = makeService(store);
	assert.equal((await service.handle(BODY_ID, candidateRequest(candidateDigest, update))).status, 200);
	const replay = await service.handle(BODY_ID, candidateRequest(candidateDigest));
	assert.equal(replay.status, 200);
	assert.equal((await replay.json() as { durableGeneration: number }).durableGeneration, 2);
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

await s.done();
