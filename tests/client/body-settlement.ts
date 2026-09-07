import { strict as assert } from "node:assert";
import {
	BodySettlementRepository,
	validateBodySettlement,
	type StoredBodySettlement,
} from "../../src/sync/bodySettlement";
import { canonicalMarkdownHash } from "../../server/src/shared/markdownCodec";
import { suite } from "../harness.ts";

const s = suite("body-settlement");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function memoryStore(initial: StoredBodySettlement | null = null) {
	let value = initial;
	return {
		getBodySettlement: async () => value,
		compareAndSwapBodySettlement: async (next: StoredBodySettlement, expected: number | null) => {
			if ((value?.localSettlementRevision ?? null) !== expected) return false;
			value = structuredClone(next);
			return true;
		},
		deleteBodySettlement: async () => { value = null; },
		read: () => value,
	};
}

function repository(
	store = memoryStore(),
	hash: (content: string) => Promise<string> = async () => HASH_A,
) {
	return new BodySettlementRepository(
		store,
		BodySettlementRepository.markdownScope("vault-generation"),
		hash,
	);
}

function validStored(overrides: Partial<StoredBodySettlement> = {}): StoredBodySettlement {
	return {
		format: 1,
		bodyId: "body",
		vaultGeneration: "vault-generation",
		canonicalVersion: "markdown-lf-v1",
		content: "base",
		contentHash: HASH_A,
		durableGeneration: 4,
		serverContentHash: HASH_A,
		diskFingerprint: { bytes: 4, hash: HASH_B },
		pathAtSettlement: "note.md",
		localSettlementRevision: 1,
		settledAt: 10,
		...overrides,
	} as StoredBodySettlement;
}

s.test("records reconstructible common content using a durable local CAS revision", async () => {
	const store = memoryStore();
	const result = await repository(store).settle({
		bodyId: "body",
		content: "base",
		contentHash: HASH_A,
		durableGeneration: 4,
		serverContentHash: HASH_A,
		diskFingerprint: { bytes: 4, hash: HASH_B },
		pathAtSettlement: "note.md",
		expectedLocalSettlementRevision: null,
		settledAt: 10,
	});
	assert.equal(result.kind, "stored");
	assert.equal(store.read()?.localSettlementRevision, 1);
	assert.equal((await repository(store).read("body")).kind, "available");
});

s.test("distinguishes missing, wrong scope, and corrupt content", async () => {
	assert.deepEqual(await repository().read("body"), { kind: "missing" });
	const wrongVault = repository(memoryStore(validStored({ vaultGeneration: "old" })));
	assert.deepEqual(await wrongVault.read("body"), { kind: "invalid", reason: "vault-generation" });
	const corrupt = repository(memoryStore(validStored()), async () => HASH_B);
	assert.deepEqual(await corrupt.read("body"), { kind: "invalid", reason: "content-corrupt" });
});

s.test("late writers are superseded and durable generations cannot regress", async () => {
	const store = memoryStore(validStored());
	const repo = repository(store);
	const superseded = await repo.settle({
		bodyId: "body", content: "base", contentHash: HASH_A, durableGeneration: 5,
		serverContentHash: HASH_A, diskFingerprint: { bytes: 4, hash: HASH_B },
		pathAtSettlement: "renamed.md", expectedLocalSettlementRevision: null, settledAt: 11,
	});
	assert.equal(superseded.kind, "superseded");
	await assert.rejects(repo.settle({
		bodyId: "body", content: "base", contentHash: HASH_A, durableGeneration: 3,
		serverContentHash: HASH_A, diskFingerprint: { bytes: 4, hash: HASH_B },
		pathAtSettlement: "note.md", expectedLocalSettlementRevision: 1, settledAt: 12,
	}), /cannot regress/);
});

s.test("refuses ancestry unless body, server, and canonical bytes agree", async () => {
	await assert.rejects(repository().settle({
		bodyId: "body", content: "base", contentHash: HASH_B, durableGeneration: 1,
		serverContentHash: HASH_B, diskFingerprint: { bytes: 4, hash: HASH_B },
		pathAtSettlement: "note.md", expectedLocalSettlementRevision: null, settledAt: 1,
	}), /content hash/);
	await assert.rejects(repository().settle({
		bodyId: "body", content: "base", contentHash: HASH_A, durableGeneration: 1,
		serverContentHash: HASH_B, diskFingerprint: { bytes: 4, hash: HASH_B },
		pathAtSettlement: "note.md", expectedLocalSettlementRevision: null, settledAt: 1,
	}), /server head/);
});

s.test("advances the body base while retaining the last agreed properties base", async () => {
	const store = memoryStore();
	const repo = repository(store, canonicalMarkdownHash);
	const original = "---\ntitle: agreed\n---\nold body";
	const originalHash = await canonicalMarkdownHash(original);
	const whole = await repo.settle({
		bodyId: "body",
		content: original,
		contentHash: originalHash,
		durableGeneration: 1,
		serverContentHash: originalHash,
		diskFingerprint: { bytes: original.length, hash: HASH_B },
		pathAtSettlement: "note.md",
		expectedLocalSettlementRevision: null,
		settledAt: 1,
	});
	assert.equal(whole.kind, "stored");
	const server = "---\ntitle: server\n---\nnew body";
	const disk = "---\ntitle: disk\n---\nnew body";
	const partial = await repo.settleComponents({
		bodyId: "body",
		serverContent: server,
		diskContent: disk,
		serverContentHash: await canonicalMarkdownHash(server),
		durableGeneration: 2,
		diskFingerprint: { bytes: disk.length, hash: HASH_B },
		pathAtSettlement: "note.md",
		expectedLocalSettlementRevision: 1,
		settledAt: 2,
	});
	assert.equal(partial.kind, "stored");
	if (partial.kind !== "stored") return;
	assert.equal(partial.settlement.agreement, "body-only");
	assert.equal(partial.settlement.bodyBase.content, "new body");
	assert.equal(partial.settlement.propertiesBase.kind, "available");
	if (partial.settlement.propertiesBase.kind === "available") {
		assert.equal(partial.settlement.propertiesBase.content, "---\ntitle: agreed\n---\n");
		assert.equal(partial.settlement.propertiesBase.advancedAtGeneration, 1);
	}
});

s.test("keeps a missing properties base typed and rejects partial body disagreement", async () => {
	const store = memoryStore();
	const repo = repository(store, canonicalMarkdownHash);
	const server = "---\ntitle: server\n---\nsame body";
	const partial = await repo.settleComponents({
		bodyId: "body",
		serverContent: server,
		diskContent: "---\ntitle: disk\n---\nsame body",
		serverContentHash: await canonicalMarkdownHash(server),
		durableGeneration: 1,
		diskFingerprint: { bytes: 10, hash: HASH_B },
		pathAtSettlement: "note.md",
		expectedLocalSettlementRevision: null,
		settledAt: 1,
	});
	assert.equal(partial.kind, "stored");
	if (partial.kind === "stored") assert.deepEqual(partial.settlement.propertiesBase, { kind: "missing" });
	await assert.rejects(repo.settleComponents({
		bodyId: "body",
		serverContent: server,
		diskContent: "---\ntitle: disk\n---\ndifferent body",
		serverContentHash: await canonicalMarkdownHash(server),
		durableGeneration: 2,
		diskFingerprint: { bytes: 10, hash: HASH_B },
		pathAtSettlement: "note.md",
		expectedLocalSettlementRevision: 1,
		settledAt: 2,
	}), /identical body content/);
});

s.test("rejects v2 records whose component ancestry is unrelated to the recorded content", async () => {
	const store = memoryStore();
	const repo = repository(store, canonicalMarkdownHash);
	const content = "---\ntitle: agreed\n---\nbody";
	const result = await repo.settle({
		bodyId: "body",
		content,
		contentHash: await canonicalMarkdownHash(content),
		durableGeneration: 1,
		serverContentHash: await canonicalMarkdownHash(content),
		diskFingerprint: { bytes: content.length, hash: HASH_B },
		pathAtSettlement: "note.md",
		expectedLocalSettlementRevision: null,
		settledAt: 1,
	});
	assert.equal(result.kind, "stored");
	if (result.kind !== "stored") return;
	const scope = BodySettlementRepository.markdownScope("vault-generation");
	const invalidAgreement = structuredClone(result.settlement);
	// @ts-expect-error Deliberately corrupt the persisted discriminant to exercise validation.
	invalidAgreement.agreement = "future";
	assert.equal(validateBodySettlement(invalidAgreement, "body", scope), "component-observation");
	assert.equal(validateBodySettlement({
		...result.settlement,
		bodyBase: { ...result.settlement.bodyBase, content: "unrelated body" },
	}, "body", scope), "component-observation");
	assert.equal(validateBodySettlement({
		...result.settlement,
		propertiesBase: result.settlement.propertiesBase.kind === "available"
			? { ...result.settlement.propertiesBase, content: "---\ntitle: unrelated\n---\n" }
			: result.settlement.propertiesBase,
	}, "body", scope), "component-observation");
});

await s.done();
