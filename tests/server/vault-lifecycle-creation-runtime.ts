import { strict as assert } from "node:assert";
import { VaultLifecycleService } from "../../server/src/vaultLifecycleService.ts";
import { suite } from "../harness.ts";

const s = suite("vault-lifecycle-creation-runtime");
const BODY_ID = "body-create-loser-0001";
const OWNER_ID = "body-create-winner-0001";
const CANDIDATE_ID = "candidate-create-loser-0001";
const CANDIDATE_DIGEST = "a".repeat(64);

const actor = {
	vaultId: "vault-lifecycle-create-0001",
	vaultGeneration: "generation-lifecycle-create-0001",
	principalId: "principal-lifecycle-create-0001",
	membershipRevision: 1,
	deviceId: "device-lifecycle-create-0001",
	deviceCredentialRevision: 1,
	role: "member" as const,
	policyVersion: 1,
	capabilityDigest: "capability-lifecycle-create-0001",
};

function creation() {
	return {
		bodyId: BODY_ID,
		bodyEpoch: 1 as const,
		fileId: BODY_ID,
		path: "contended.md",
		operationId: "operation-create-loser-0001",
		candidateId: CANDIDATE_ID,
		candidateDigest: CANDIDATE_DIGEST,
		durableGeneration: 1,
		vaultSequence: 1,
		vaultGeneration: actor.vaultGeneration,
		runtimeEpoch: "runtime-lifecycle-create-0001",
	};
}

function lifecycleRequest(candidateId = CANDIDATE_ID): Request {
	return new Request("https://internal/lifecycle", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			operationId: "operation-create-loser-0001",
			kind: "create",
			fileId: BODY_ID,
			bodyId: BODY_ID,
			bodyEpoch: 1,
			path: "contended.md",
			candidateId,
			candidateDigest: CANDIDATE_DIGEST,
		}),
	});
}

function harness() {
	let pending = creation();
	let completions = 0;
	const store = {
		lifecycleRecord: () => null,
		documentHead: () => ({ generation: 1, semanticEpoch: 1, latestSequence: 1 }),
		creationCandidate: () => pending,
		currentSequence: () => 7,
		activeCatalogHeadAtPath: () => ({
			sequence: 6, bodyId: OWNER_ID, bodyEpoch: 1, fileId: OWNER_ID,
			path: "contended.md", previousPath: null, lifecycle: "active",
			generation: 2, contentHash: null, size: 4,
		}),
		completeCreationCandidate: () => {
			completions++;
			pending = null as never;
			return true;
		},
		acquireRecoveryMutex: () => true,
		releaseRecoveryMutex: () => {},
	} as never;
	const service = new VaultLifecycleService({
		store,
		cache: {},
		sockets: () => ({}),
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-lifecycle-create-0001",
		hasBlob: async () => true,
		flush: async () => true,
		validateActor: () => true,
	} as never);
	return { service, completions: () => completions };
}

s.test("an exact losing creation is retired with a typed path supersession", async () => {
	const { service, completions } = harness();
	const response = await service.handle(lifecycleRequest(), actor);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "creation_path_superseded",
		path: "contended.md",
		ownerBodyId: OWNER_ID,
	});
	assert.equal(completions(), 1, "the losing durable fence cannot become an immortal retry");
});

s.test("a mismatched request cannot retire somebody else's pending fence", async () => {
	const { service, completions } = harness();
	const response = await service.handle(lifecycleRequest("candidate-attacker-0001"), actor);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "creation_candidate_fence_mismatch" });
	assert.equal(completions(), 0);
});

s.test("finalization retires a creation whose path gained an authoritative owner", () => {
	const { service, completions } = harness();
	const result = service.finalizeCreation(creation(), {
		bodyId: BODY_ID,
		bodyEpoch: 1,
		clientId: actor.deviceId,
		candidateId: CANDIDATE_ID,
		candidateDigest: CANDIDATE_DIGEST,
		durableGeneration: 2,
		vaultSequence: 8,
		vaultGeneration: actor.vaultGeneration,
		runtimeEpoch: "runtime-lifecycle-create-0001",
	}, { contentHash: "b".repeat(64), size: 4 }, actor);
	assert.equal(result, "superseded");
	assert.equal(completions(), 1);
});

s.test("create admission batch returns multiple exact pending fences in one service call", async () => {
	const pending = ["a", "b"].map((suffix, index) => ({
		...creation(),
		bodyId: `body-batch-${suffix}`,
		fileId: `body-batch-${suffix}`,
		path: `${suffix}.md`,
		operationId: `operation-batch-${suffix}`,
		candidateId: `candidate-batch-${suffix}`,
		candidateDigest: suffix.repeat(64),
		vaultSequence: index + 1,
	}));
	const byBody = new Map([[pending[0]!.bodyId, pending[0]!]]);
	const validBodies = new Set(pending.map((item) => item.bodyId));
	let allowNewAdmissions = false;
	const service = new VaultLifecycleService({
		store: {
			lifecycleRecord: () => null,
			documentHead: (bodyId: string) => validBodies.has(bodyId)
				? { generation: 1, semanticEpoch: 1, latestSequence: 1 }
				: null,
			creationCandidate: (bodyId: string) => byBody.get(bodyId) ?? null,
			currentSequence: () => 2,
			activeCatalogHeadAtPath: () => null,
			getCatalogHeadAt: () => null,
			expectCreationCandidate: (candidate: ReturnType<typeof creation>) => {
				byBody.set(candidate.bodyId, candidate);
				return candidate;
			},
		} as never,
		cache: {}, sockets: () => ({}), vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration, runtimeEpoch: "runtime-lifecycle-create-0001",
		hasBlob: async () => true, flush: async () => true, validateActor: () => allowNewAdmissions,
	} as never);
	const operations = pending.map((item) => ({
		operationId: item.operationId, kind: "create", fileId: item.fileId, bodyId: item.bodyId,
		bodyEpoch: item.bodyEpoch, path: item.path, candidateId: item.candidateId,
		candidateDigest: item.candidateDigest,
	}));
	const batchRequest = () => new Request("https://internal/lifecycle/admissions", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ operations }),
	});
	const interrupted = await service.handleCreateAdmissionsBatch(batchRequest(), actor);
	assert.equal(interrupted.status, 409);
	assert.deepEqual(await interrupted.json(), { error: "authority_superseded" });
	assert.equal(byBody.size, 1, "an interrupted batch retains the exact admitted prefix");
	allowNewAdmissions = true;
	const response = await service.handleCreateAdmissionsBatch(batchRequest(), actor);
	assert.equal(response.status, 200);
	const result = await response.json() as { receipts: Array<{ operationId: string }>; vaultSequence: number };
	assert.deepEqual(result.receipts.map((receipt) => receipt.operationId), ["operation-batch-a", "operation-batch-b"]);
	assert.equal(result.vaultSequence, 1);
	assert.equal(byBody.size, 2, "retry replays the prefix and admits only the missing item");
});

await s.done();
