import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { semanticDocumentCensus } from "../../server/src/semanticCompaction";
import { SemanticCompactionRuntime } from "../../server/src/semanticCompactionRuntime";
import type { SemanticCompactionThresholds } from "../../server/src/semanticCompactionPolicy";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { canonicalCanvasBytes } from "../../server/src/shared/canvasCodec";
import {
	initializeCanvasDocument,
	materializeCanvasDocument,
	validateCanvasDocument,
} from "../../server/src/shared/canvasSemanticDocument";
import { SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE } from "../../server/src/shared/semanticEpoch";
import { encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../server/src/shared/binaryEnvelope";
import { VaultLifecycleService } from "../../server/src/vaultLifecycleService";
import {
	VaultSocketService,
	type VaultSocketAttachment,
	type VaultSocketPort,
} from "../../server/src/vaultSocketService";
import { suite } from "../harness.ts";

const s = suite("semantic-compaction-runtime");

const TEST_THRESHOLDS: Readonly<SemanticCompactionThresholds> = Object.freeze({
	softEncodedStateBytes: 1,
	hardEncodedStateBytes: Number.MAX_SAFE_INTEGER,
	softStructs: 2,
	hardStructs: Number.MAX_SAFE_INTEGER,
	softDeletedStructs: 1,
	minimumRatioStructs: 1,
	softDeletedRatio: 0.01,
	hardDeletedRatio: 1,
	softAmplification: 1.01,
	hardAmplification: Number.MAX_SAFE_INTEGER,
	minimumAmplificationBytes: 1,
	minimumProjectedReduction: 0.10,
	softCooldownMs: 0,
	rearmGrowthFactor: 1,
	hardLatencyViolationStreak: Number.MAX_SAFE_INTEGER,
});

const OPERATIONAL_ONLY_THRESHOLDS: Readonly<SemanticCompactionThresholds> = Object.freeze({
	softEncodedStateBytes: Number.MAX_SAFE_INTEGER,
	hardEncodedStateBytes: Number.MAX_SAFE_INTEGER,
	softStructs: Number.MAX_SAFE_INTEGER,
	hardStructs: Number.MAX_SAFE_INTEGER,
	softDeletedStructs: Number.MAX_SAFE_INTEGER,
	minimumRatioStructs: Number.MAX_SAFE_INTEGER,
	softDeletedRatio: 1,
	hardDeletedRatio: 1,
	softAmplification: Number.MAX_SAFE_INTEGER,
	hardAmplification: Number.MAX_SAFE_INTEGER,
	minimumAmplificationBytes: Number.MAX_SAFE_INTEGER,
	minimumProjectedReduction: 0.10,
	softCooldownMs: 0,
	rearmGrowthFactor: 1,
	hardLatencyViolationStreak: 3,
});

function delta(doc: Y.Doc, mutate: () => void): Uint8Array {
	const before = Y.encodeStateVector(doc);
	mutate();
	return Y.encodeStateAsUpdate(doc, before);
}

async function withRuntime(check: (value: {
	store: VaultStore;
	sqlite: NodeSqliteStorage;
	cache: VaultDocumentCache;
	compaction: SemanticCompactionRuntime;
	fences: Array<{ documentId: string; previousEpoch: number; currentEpoch: number }>;
	}) => void | Promise<void>, options: {
		commitLatencyObjectiveMs?: number;
		cadence?: { commits: number; ingressBytes: number; maxIntervalMs: number };
		thresholds?: Readonly<SemanticCompactionThresholds>;
	} = {}): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-semantic-runtime-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const store = new VaultStore(sqlite as unknown as VaultStoragePort);
	const cache = new VaultDocumentCache(store, () => new Set(), () => new Set());
	const fences: Array<{ documentId: string; previousEpoch: number; currentEpoch: number }> = [];
	let now = 1_000;
	const compaction = new SemanticCompactionRuntime({
		store,
		cache,
		fenceSockets: (documentId, previousEpoch, currentEpoch) => {
			fences.push({ documentId, previousEpoch, currentEpoch });
			return 1;
		},
		commitLatencyObjectiveMs: options.commitLatencyObjectiveMs,
		now: () => now++,
		cadence: options.cadence
			?? { commits: 1, ingressBytes: Number.MAX_SAFE_INTEGER, maxIntervalMs: Number.MAX_SAFE_INTEGER },
		thresholds: () => options.thresholds ?? TEST_THRESHOLDS,
	});
	try {
		await check({ store, sqlite, cache, compaction, fences });
	} finally {
		cache.clear();
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function commitPathologicalDocument(store: VaultStore, documentId: string, scope: "body" | "root"): string {
	const doc = new Y.Doc({ guid: documentId });
	const text = doc.getText("body");
	const preserved = scope === "body" ? "---\ntitle: compact me\n---\nkept\n" : "catalog preserved";
	store.commitUpdate({ documentId, update: delta(doc, () => {
		if (scope === "body") text.insert(0, preserved);
		else doc.getMap("meta").set("catalog-note", preserved);
	}), kind: scope });
	for (let index = 0; index < 300; index++) {
		doc.clientID = 10_000 + index;
		store.commitUpdate({
			documentId,
			update: delta(doc, () => {
				if (scope === "body") {
					text.insert(text.length, "x");
					text.delete(text.length - 1, 1);
				} else {
					doc.getMap("meta").set("churn", index);
					doc.getMap("meta").delete("churn");
				}
			}),
			kind: scope,
		});
	}
	doc.destroy();
	return preserved;
}

async function commitPathologicalCanvas(store: VaultStore, documentId: string): Promise<Uint8Array> {
	const doc = new Y.Doc({ guid: documentId });
	initializeCanvasDocument(doc);
	doc.getMap("rootFields").set("theme", "dark");
	doc.getMap("nodeTombstones").set("retired-node", {
		operationId: "delete-retired-node",
		baseSemanticHash: "a".repeat(64),
		deletedAt: 1,
		lastOrderRank: null,
	});
	for (let index = 0; index < 300; index++) {
		doc.clientID = 30_000 + index;
		doc.getMap("rootFields").set("discarded-history", index);
		doc.getMap("rootFields").delete("discarded-history");
	}
	assert.equal(await validateCanvasDocument(doc), null);
	const canonical = canonicalCanvasBytes(await materializeCanvasDocument(doc, false));
	store.commitUpdate({ documentId, update: Y.encodeStateAsUpdate(doc), kind: "semantic" });
	doc.destroy();
	return canonical;
}

s.test("body reset preserves content, advances epoch, shrinks structs and fences old sockets", async () => {
		await withRuntime(async ({ store, cache, compaction, fences }) => {
			const documentId = "pathological-body";
			const preserved = commitPathologicalDocument(store, documentId, "body");
			const loaded = cache.load(documentId, true, () => true);
			const before = semanticDocumentCensus(loaded.doc);
			const headBefore = store.documentHead(documentId)!;
			const outcome = await compaction.recordCommit(documentId, 1);
			assert.equal(outcome.status, "compacted");
			if (outcome.status !== "compacted") return;
			const headAfter = store.documentHead(documentId)!;
			assert.equal(headAfter.generation, headBefore.generation, "semantic reset is not a content commit");
			assert.equal(headAfter.semanticEpoch, headBefore.semanticEpoch + 1);
			assert.ok(outcome.freshStructs < before.totalStructs / 10);
			assert.equal(outcome.fencedSockets, 1);
			assert.deepEqual(fences, [{
				documentId,
				previousEpoch: headBefore.semanticEpoch,
				currentEpoch: headAfter.semanticEpoch,
			}]);
			const resident = cache.get(documentId)!;
			assert.equal(resident.semanticEpoch, headAfter.semanticEpoch);
			assert.equal(resident.doc.getText("body").toString(), preserved);
			const recovered = store.reconstructDocument(documentId);
			try {
				assert.equal(recovered.semanticEpoch, headAfter.semanticEpoch);
				assert.equal(recovered.doc.getText("body").toString(), preserved);
			} finally {
				recovered.doc.destroy();
			}
		});
});

s.test("body reset waits for a durable Markdown lifecycle receipt to reach the root", async () => {
	await withRuntime(({ store }) => {
		const vaultGeneration = "semantic-lifecycle-generation";
		const root = new Y.Doc({ guid: "root" });
		store.provisionVault("semantic-lifecycle-vault", vaultGeneration,
			delta(root, () => root.getMap("sys").set("schemaVersion", 8)), 1);
		const bodyId = "lifecycle-barrier-body";
		const body = new Y.Doc({ guid: bodyId });
		const bodyCommit = store.commitUpdate({
			documentId: bodyId,
			update: delta(body, () => body.getText("body").insert(0, "preserve me\n")),
			kind: "body",
		});
		const operationId = "lifecycle-before-compaction";
		const lifecycleCommit = store.commitRootLifecycle({
			rootUpdate: delta(root, () => root.getMap("__yaosLifecycle").set(operationId, true)),
			kind: "rename",
			catalog: {
				bodyId, fileId: bodyId, path: "renamed.md", previousPath: "old.md",
				lifecycle: "active", bodyGeneration: bodyCommit.generation,
			},
			lifecycleReceipt: {
				operationId, kind: "rename", bodyId, bodyEpoch: bodyCommit.semanticEpoch,
				fileId: bodyId, candidateId: null, candidateDigest: null,
				sourcePath: "old.md", resultPath: "renamed.md", resultLifecycle: "active",
				durableGeneration: bodyCommit.generation, vaultGeneration, runtimeEpoch: "runtime-1",
			},
		});
		const expectedHead = store.documentHead(bodyId)!;
		const expectedCheckpointHead = { throughSequence: expectedHead.latestSequence,
			generation: expectedHead.generation, semanticEpoch: expectedHead.semanticEpoch };
		const fresh = new Y.Doc({ guid: bodyId });
		fresh.getText("body").insert(0, "preserve me\n");
		const freshState = Y.encodeStateAsUpdate(fresh);
		fresh.destroy();

		assert.throws(
			() => store.semanticResetFromEncodedState(bodyId, freshState, expectedCheckpointHead, 2),
			/semantic_reset_blocked_by_unpublished_lifecycle/,
		);
		assert.deepEqual(store.documentHead(bodyId), expectedHead,
			"the failed barrier check must not advance either the body epoch or durable clock");

		store.commitUpdate({
			documentId: "root",
			update: delta(root, () => root.getMap("__yaosLifecyclePublicationProof").set(operationId, true)),
			kind: "root",
			rootPublications: [{ operationId, lifecycleSequence: lifecycleCommit.vaultSequence,
				rootEpoch: 1, vaultGeneration, runtimeEpoch: "runtime-1" }],
		});
		const reset = store.semanticResetFromEncodedState(bodyId, freshState, expectedCheckpointHead, 3);
		assert.equal(reset.semanticEpoch, expectedHead.semanticEpoch + 1);
		root.destroy();
		body.destroy();
	});
});

s.test("body reset cannot strand an admitted creation fence in the retired epoch", async () => {
	await withRuntime(({ store }) => {
		const vaultGeneration = "semantic-creation-generation";
		const root = new Y.Doc({ guid: "root" });
		store.provisionVault("semantic-creation-vault", vaultGeneration,
			delta(root, () => root.getMap("sys").set("schemaVersion", 8)), 1);
		const bodyId = "creation-before-compaction";
		const body = new Y.Doc({ guid: bodyId });
		const commit = store.commitUpdate({ documentId: bodyId,
			update: delta(body, () => body.getText("body").insert(0, "pending creation\n")), kind: "body" });
		store.expectCreationCandidate({ bodyId, bodyEpoch: commit.semanticEpoch, fileId: bodyId,
			path: "pending.md", operationId: "pending-creation-operation",
			candidateId: "pending-creation-candidate", candidateDigest: "a".repeat(64),
			durableGeneration: commit.generation, vaultSequence: commit.vaultSequence,
			vaultGeneration, runtimeEpoch: "runtime-1" });
		const expectedHead = store.documentHead(bodyId)!;
		assert.throws(() => store.semanticResetFromEncodedState(bodyId, Y.encodeStateAsUpdate(body), {
			throughSequence: expectedHead.latestSequence,
			generation: expectedHead.generation,
			semanticEpoch: expectedHead.semanticEpoch,
		}, 2), /semantic_reset_blocked_by_unpublished_lifecycle/);
		assert.equal(store.creationCandidate(bodyId)?.bodyEpoch, expectedHead.semanticEpoch);
		assert.deepEqual(store.documentHead(bodyId), expectedHead);
		body.destroy();
		root.destroy();
	});
});

s.test("root reset migrates unpublished lifecycle authority and exact replay survives a later body reset", async () => {
	await withRuntime(async ({ store, cache, compaction }) => {
		const vaultId = "semantic-migration-vault";
		const vaultGeneration = "semantic-migration-generation";
		const runtimeEpoch = "semantic-migration-runtime";
		const root = new Y.Doc({ guid: "root" });
		store.provisionVault(vaultId, vaultGeneration, delta(root, () => {
			root.getMap("sys").set("schemaVersion", 8);
			root.getMap("sys").set("protocolVersion", 5);
		}), 1);
		for (let index = 0; index < 100; index++) {
			root.clientID = 70_000 + index;
			store.commitUpdate({ documentId: "root", kind: "root", update: delta(root, () => {
				root.getMap("retired-root-history").set("value", index);
				root.getMap("retired-root-history").delete("value");
			}) });
		}

		const bodyId = "migration-gap-body";
		const body = new Y.Doc({ guid: bodyId });
		const bodyCommit = store.commitUpdate({ documentId: bodyId, kind: "body",
			update: delta(body, () => body.getText("body").insert(0, "migrated lifecycle\n")) });
		const operationId = "migration-gap-rename";
		const rootUpdate = delta(root, () => root.getMap("__yaosLifecycle").set(operationId, true));
		const lifecycleCommit = store.commitRootLifecycle({
			rootUpdate,
			kind: "rename",
			catalog: { bodyId, fileId: bodyId, path: "after.md", previousPath: "before.md",
				lifecycle: "active", bodyGeneration: bodyCommit.generation },
			lifecycleReceipt: {
				operationId, kind: "rename", bodyId, bodyEpoch: bodyCommit.semanticEpoch,
				fileId: bodyId, candidateId: null, candidateDigest: null,
				sourcePath: "before.md", resultPath: "after.md", resultLifecycle: "active",
				durableGeneration: bodyCommit.generation, vaultGeneration, runtimeEpoch,
			},
		});
		assert.equal(store.lifecyclePublication(operationId), null,
			"the test must begin inside the durable-receipt/root-publication gap");

		const publishedBodyId = "migration-published-body";
		const publishedBody = new Y.Doc({ guid: publishedBodyId });
		const publishedBodyCommit = store.commitUpdate({ documentId: publishedBodyId, kind: "body",
			update: delta(publishedBody, () => publishedBody.getText("body").insert(0, "published lifecycle\n")) });
		const publishedOperationId = "migration-published-rename";
		const publishedLifecycleCommit = store.commitRootLifecycle({
			rootUpdate: delta(root, () => root.getMap("__yaosLifecycle").set(publishedOperationId, true)),
			kind: "rename",
			catalog: { bodyId: publishedBodyId, fileId: publishedBodyId, path: "published-after.md",
				previousPath: "published-before.md", lifecycle: "active",
				bodyGeneration: publishedBodyCommit.generation },
			lifecycleReceipt: {
				operationId: publishedOperationId, kind: "rename", bodyId: publishedBodyId,
				bodyEpoch: publishedBodyCommit.semanticEpoch, fileId: publishedBodyId,
				candidateId: null, candidateDigest: null, sourcePath: "published-before.md",
				resultPath: "published-after.md", resultLifecycle: "active",
				durableGeneration: publishedBodyCommit.generation, vaultGeneration, runtimeEpoch,
			},
		});
		const oldPublicationCommit = store.commitUpdate({
			documentId: "root",
			kind: "root",
			update: delta(root, () => root.getMap("__yaosLifecyclePublicationProof").set(publishedOperationId, true)),
			rootPublications: [{ operationId: publishedOperationId,
				lifecycleSequence: publishedLifecycleCommit.vaultSequence, rootEpoch: 1,
				vaultGeneration, runtimeEpoch }],
		});
		assert.equal(store.lifecyclePublication(publishedOperationId)?.rootSequence,
			oldPublicationCommit.vaultSequence);

		cache.load("root", false, () => true);
		const rootReset = await compaction.recordCommit("root", 1);
		assert.equal(rootReset.status, "compacted");
		if (rootReset.status !== "compacted") return;
		const migrated = store.lifecyclePublication(operationId);
		assert.ok(migrated, "root reset must publish every lifecycle receipt represented by its SQL snapshot");
		assert.equal(migrated.rootSequence, rootReset.result.vaultSequence);
		assert.equal(migrated.rootEpoch, rootReset.result.semanticEpoch);
		assert.equal(migrated.lifecycleSequence, lifecycleCommit.vaultSequence);
		const rebasedPublished = store.lifecyclePublication(publishedOperationId)!;
		assert.equal(rebasedPublished.rootSequence, rootReset.result.vaultSequence,
			"an already-published but locally queued operation must receive a replay proof in the fresh root epoch");
		assert.equal(rebasedPublished.rootEpoch, rootReset.result.semanticEpoch);
		assert.equal(rebasedPublished.lifecycleSequence, publishedLifecycleCommit.vaultSequence);

		const bodyHead = store.documentHead(bodyId)!;
		const bodyReset = store.semanticResetFromEncodedState(bodyId, Y.encodeStateAsUpdate(body), {
			throughSequence: bodyHead.latestSequence,
			generation: bodyHead.generation,
			semanticEpoch: bodyHead.semanticEpoch,
		}, 5_000);
		assert.equal(bodyReset.semanticEpoch, bodyCommit.semanticEpoch + 1,
			"the migrated publication must stop fencing body semantic compaction");
		const publishedBodyHead = store.documentHead(publishedBodyId)!;
		store.semanticResetFromEncodedState(publishedBodyId, Y.encodeStateAsUpdate(publishedBody), {
			throughSequence: publishedBodyHead.latestSequence,
			generation: publishedBodyHead.generation,
			semanticEpoch: publishedBodyHead.semanticEpoch,
		}, 5_001);

		const service = new VaultLifecycleService({
			store,
			cache,
			sockets: () => ({}) as never,
			vaultId: () => vaultId,
			vaultGeneration: () => vaultGeneration,
			runtimeEpoch,
			hasBlob: async () => true,
			flush: async () => { throw new Error("exact publication replay must not flush root state"); },
			validateActor: () => true,
		});
		const staleExactOperation = {
			operationId,
			kind: "rename" as const,
			fileId: bodyId,
			bodyId,
			bodyEpoch: bodyCommit.semanticEpoch,
			fromPath: "before.md",
			toPath: "after.md",
			vaultSequence: lifecycleCommit.vaultSequence,
		};
		const stalePublishedOperation = {
			operationId: publishedOperationId,
			kind: "rename" as const,
			fileId: publishedBodyId,
			bodyId: publishedBodyId,
			bodyEpoch: publishedBodyCommit.semanticEpoch,
			fromPath: "published-before.md",
			toPath: "published-after.md",
			vaultSequence: publishedLifecycleCommit.vaultSequence,
		};
		const actor = {
			vaultId, vaultGeneration, principalId: "migration-principal", membershipRevision: 1,
			deviceId: "migration-device", deviceCredentialRevision: 1, role: "member" as const,
			policyVersion: 1, capabilityDigest: "migration-capability",
		};
		const exactReplay = await service.handle(new Request("https://internal/lifecycle", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(staleExactOperation),
		}), actor);
		assert.equal(exactReplay.status, 200,
			"an already-published lifecycle receipt remains replayable after body and root compaction");
		assert.equal((await exactReplay.json() as { operationId?: string }).operationId, operationId);
		const batchReplay = await service.handleBatch(new Request("https://internal/lifecycle/batch", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ operations: [staleExactOperation, stalePublishedOperation] }),
		}), actor);
		assert.equal(batchReplay.status, 200,
			"batch recovery also retires exact already-published old-epoch rows");
		assert.deepEqual((await batchReplay.json() as { receipts: Array<{ operationId: string }> }).receipts
			.map((receipt) => receipt.operationId), [operationId, publishedOperationId]);
		const requestBytes = encodeBinaryEnvelope({ operations: [staleExactOperation, stalePublishedOperation],
			rootUpdate: Uint8Array.of(1), rootEpoch: 1 });
		const response = await service.publish(new Request("https://internal/lifecycle/publish", {
			method: "POST",
			headers: { "content-type": YAOS_BINARY_CONTENT_TYPE },
			body: requestBytes.slice().buffer,
		}), actor);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			operationIds: [operationId, publishedOperationId],
			vaultSequence: migrated.rootSequence,
			rootGeneration: migrated.rootGeneration,
			rootEpoch: migrated.rootEpoch,
			vaultGeneration,
			runtimeEpoch: migrated.runtimeEpoch,
		});
		body.destroy();
		publishedBody.destroy();
		root.destroy();
	});
});

s.test("root proof migration rolls back with the reset transaction after its UPSERT", async () => {
	await withRuntime(async ({ store, sqlite, cache, compaction, fences }) => {
		const vaultGeneration = "semantic-proof-rollback-generation";
		const runtimeEpoch = "semantic-proof-rollback-runtime";
		const root = new Y.Doc({ guid: "root" });
		store.provisionVault("semantic-proof-rollback-vault", vaultGeneration, delta(root, () => {
			root.getMap("sys").set("schemaVersion", 8);
			root.getMap("sys").set("protocolVersion", 5);
		}), 1);
		for (let index = 0; index < 20; index++) {
			root.clientID = 80_000 + index;
			store.commitUpdate({ documentId: "root", kind: "root", update: delta(root, () => {
				root.getMap("rollback-history").set("value", index);
				root.getMap("rollback-history").delete("value");
			}) });
		}

		const bodyId = "proof-rollback-body";
		const body = new Y.Doc({ guid: bodyId });
		const bodyCommit = store.commitUpdate({ documentId: bodyId, kind: "body",
			update: delta(body, () => body.getText("body").insert(0, "proof rollback\n")) });
		const operationId = "proof-rollback-operation";
		const lifecycle = store.commitRootLifecycle({
			rootUpdate: delta(root, () => {
				root.getMap("pathToId").set("proof-rollback.md", bodyId);
				root.getMap("__yaosLifecycle").set(operationId, true);
			}),
			kind: "rename",
			catalog: { bodyId, fileId: bodyId, path: "proof-rollback.md", previousPath: "before.md",
				lifecycle: "active", bodyGeneration: bodyCommit.generation },
			lifecycleReceipt: { operationId, kind: "rename", bodyId, bodyEpoch: bodyCommit.semanticEpoch,
				fileId: bodyId, candidateId: null, candidateDigest: null, sourcePath: "before.md",
				resultPath: "proof-rollback.md", resultLifecycle: "active",
				durableGeneration: bodyCommit.generation, vaultGeneration, runtimeEpoch },
		});
		assert.equal(store.lifecyclePublication(operationId), null);
		const headBefore = store.documentHead("root")!;
		const clockBefore = store.currentSequence();
		cache.load("root", false, () => true);

		sqlite.sql.exec(`CREATE TRIGGER reject_root_compaction_state_after_proof_migration
		 BEFORE INSERT ON vault_semantic_compaction_state
		 WHEN NEW.document_id = 'root'
		 BEGIN SELECT RAISE(ABORT, 'injected failure after proof migration'); END`).toArray();
		await assert.rejects(compaction.recordCommit("root", 1), /injected failure after proof migration/);
		assert.equal(store.lifecyclePublication(operationId), null,
			"the migrated SQL proof must roll back when a later reset write fails");
		assert.deepEqual(store.documentHead("root"), headBefore);
		assert.equal(store.currentSequence(), clockBefore);
		assert.equal(sqlite.sql.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM vault_journal WHERE document_id = 'root' AND kind = 'semantic-reset'",
		).one().count, 0);
		assert.deepEqual(fences, [], "a rolled-back reset cannot fence a lineage which remains current");

		sqlite.sql.exec("DROP TRIGGER reject_root_compaction_state_after_proof_migration").toArray();
		const retried = await compaction.measureAndMaybeCompact("root");
		assert.equal(retried.status, "compacted");
		if (retried.status === "compacted") {
			const publication = store.lifecyclePublication(operationId)!;
			assert.equal(publication.lifecycleSequence, lifecycle.vaultSequence);
			assert.equal(publication.rootSequence, retried.result.vaultSequence);
			assert.equal(publication.rootEpoch, retried.result.semanticEpoch);
		}
		body.destroy();
		root.destroy();
	});
});

s.test("root reset rebuilds only fixed maps from SQL authority and ignores divergent resident state", async () => {
	await withRuntime(async ({ store, cache, compaction, fences }) => {
		const residentRoot = new Y.Doc({ guid: "root" });
		residentRoot.getMap("sys").set("schemaVersion", 8);
		residentRoot.getMap("sys").set("protocolVersion", 5);
		residentRoot.getMap("pathToId").set("resident-lie.md", "wrong-body");
		residentRoot.getMap("pathToBlob").set("ghost.bin", { hash: "f".repeat(64), size: 1, revision: "ghost" });
		residentRoot.getMap("meta").set("unknown", "must disappear");
		residentRoot.getMap("__yaosLifecycle").set("retired-lifecycle", true);
		residentRoot.getMap("__yaosLifecyclePublicationProof").set("retired-proof", true);
		for (let index = 0; index < 300; index++) {
			residentRoot.clientID = 40_000 + index;
			residentRoot.getMap("meta").set("churn", index);
			residentRoot.getMap("meta").delete("churn");
		}
		store.commitUpdate({ documentId: "root", update: Y.encodeStateAsUpdate(residentRoot), kind: "root" });
		residentRoot.destroy();

		const body = new Y.Doc({ guid: "catalog-body" });
		body.getText("body").insert(0, "authoritative Markdown\n");
		const bodyCommit = store.commitUpdate({ documentId: "catalog-body", update: Y.encodeStateAsUpdate(body), kind: "body" });
		body.destroy();
		const lifecycleMarker = new Y.Doc();
		lifecycleMarker.getMap("__yaosLifecycle").set("rename-operation", true);
		store.commitRootLifecycle({
			rootUpdate: Y.encodeStateAsUpdate(lifecycleMarker),
			kind: "rename",
			catalog: { bodyId: "catalog-body", fileId: "catalog-body", path: "renamed.md",
				previousPath: "old.md", lifecycle: "active", bodyGeneration: bodyCommit.generation },
		});
		lifecycleMarker.destroy();

		const canvas = new Y.Doc({ guid: "catalog-canvas" });
		initializeCanvasDocument(canvas);
		const canvasCommit = store.commitUpdate({ documentId: "catalog-canvas",
			update: Y.encodeStateAsUpdate(canvas), kind: "semantic" });
		canvas.destroy();
		const semanticMarker = new Y.Doc();
		semanticMarker.getMap("__yaosLifecycle").set("semantic-rename-operation", true);
		store.commitUpdate({ documentId: "root", update: Y.encodeStateAsUpdate(semanticMarker), kind: "semantic-rename",
			semanticCatalog: { documentId: "catalog-canvas", fileId: "catalog-canvas", kind: "canvas",
				format: "json-canvas", formatVersion: 1, path: "Renamed.canvas", previousPath: "Old.canvas",
				lifecycle: "active", documentGeneration: canvasCommit.generation } });
		semanticMarker.destroy();

		const hash = "a".repeat(64);
		const attachmentMarker = new Y.Doc();
		attachmentMarker.getMap("__yaosLifecycle").set("attachment-upsert", true);
		store.commitRootAttachments(Y.encodeStateAsUpdate(attachmentMarker), [
			{ operationId: "attachment-operation", path: "active.bin", contentHash: hash, size: 4,
				mime: "application/octet-stream", lifecycle: "active" },
			{ operationId: "attachment-operation", path: "deleted.bin", contentHash: "b".repeat(64), size: 8,
				mime: null, lifecycle: "deleted" },
		], { operationId: "attachment-operation", requestDigest: "c".repeat(64), rootEpoch: 1 },
		store.documentHead("root")!, 700);
		attachmentMarker.destroy();

		const loaded = cache.load("root", false, () => true);
		const before = semanticDocumentCensus(loaded.doc);
		const headBefore = store.documentHead("root")!;
		const outcome = await compaction.recordCommit("root", 1);
		assert.equal(outcome.status, "compacted");
		if (outcome.status !== "compacted") return;
		assert.ok(outcome.freshStructs < before.totalStructs / 10);
		assert.deepEqual(fences, [{ documentId: "root", previousEpoch: 1, currentEpoch: 2 }]);
		assert.equal(outcome.result.generation, headBefore.generation);
		assert.equal(outcome.result.semanticEpoch, 2);

		for (const document of [cache.get("root")!.doc, store.reconstructDocument("root").doc]) {
			try {
				assert.equal(document.getMap("pathToId").get("renamed.md"), "catalog-body");
				assert.equal((document.getMap<{ documentId: string }>("pathToSemantic")
					.get("Renamed.canvas"))?.documentId, "catalog-canvas");
				assert.deepEqual(document.getMap("pathToBlob").get("active.bin"),
					{ hash, size: 4, revision: "attachment-operation" });
				assert.deepEqual(document.getMap("blobTombstones").get("deleted.bin"),
					{ deletedAt: 700, previousHash: "b".repeat(64), revision: "attachment-operation" });
				assert.equal(document.getMap("pathToId").has("resident-lie.md"), false);
				assert.equal(document.share.has("meta"), false);
				assert.equal(document.share.has("__yaosLifecycle"), false);
				assert.equal(document.share.has("__yaosLifecyclePublicationProof"), false);
			} finally {
				if (document !== cache.get("root")!.doc) document.destroy();
			}
		}
	});
});

s.test("root authority snapshot is fenced by an exact durable-head CAS", async () => {
	await withRuntime(async ({ store, cache, compaction, fences }) => {
		commitPathologicalDocument(store, "root", "root");
		cache.load("root", false, () => true);
		const previousEpoch = store.documentHead("root")!.semanticEpoch;
		const snapshot = store.rootAuthoritySnapshotAt.bind(store);
		store.rootAuthoritySnapshotAt = (boundarySequence) => {
			const authority = snapshot(boundarySequence);
			const concurrent = new Y.Doc();
			concurrent.getMap("concurrent-root-change").set("won", true);
			store.commitUpdate({ documentId: "root", update: Y.encodeStateAsUpdate(concurrent), kind: "root" });
			concurrent.destroy();
			return authority;
		};
		const outcome = await compaction.recordCommit("root", 1);
		assert.equal(outcome.status, "head-changed");
		assert.equal(store.documentHead("root")!.semanticEpoch, previousEpoch);
		assert.deepEqual(fences, []);
	});
});

s.test("Canvas reset preserves canonical JSON, drops tombstones, advances epoch, and fences stale lineage", async () => {
	await withRuntime(async ({ store, cache, compaction, fences }) => {
		const documentId = "pathological-canvas";
		const canonicalBefore = await commitPathologicalCanvas(store, documentId);
		const loaded = cache.load(documentId, true, () => true, "canvas");
		const censusBefore = semanticDocumentCensus(loaded.doc);
		const headBefore = store.documentHead(documentId)!;
		assert.equal(loaded.doc.getMap("nodeTombstones").size, 1);

		const outcome = await compaction.recordCommit(documentId, 1);
		assert.equal(outcome.status, "compacted");
		if (outcome.status !== "compacted") return;
		assert.equal(outcome.result.previousSemanticEpoch, headBefore.semanticEpoch);
		assert.equal(outcome.result.semanticEpoch, headBefore.semanticEpoch + 1);
		assert.equal(outcome.result.generation, headBefore.generation);
		assert.ok(outcome.freshStructs < censusBefore.totalStructs / 10);
		assert.equal(outcome.fencedSockets, 1);
		assert.deepEqual(fences, [{ documentId, previousEpoch: 1, currentEpoch: 2 }]);

		const resident = cache.get(documentId)!;
		assert.equal(resident.kind, "canvas");
		assert.equal(resident.semanticEpoch, 2);
		assert.equal(resident.doc.getMap("nodeTombstones").size, 0,
			"fresh semantic state does not carry retired Canvas tombstones");
		assert.deepEqual(canonicalCanvasBytes(await materializeCanvasDocument(resident.doc, false)), canonicalBefore);

		const recovered = store.reconstructDocument(documentId);
		try {
			assert.equal(recovered.semanticEpoch, 2);
			assert.equal(recovered.doc.getMap("nodeTombstones").size, 0);
			assert.deepEqual(canonicalCanvasBytes(await materializeCanvasDocument(recovered.doc, false)), canonicalBefore);
		} finally {
			recovered.doc.destroy();
		}

		assert.throws(() => store.semanticResetFromEncodedState(
			documentId,
			Y.encodeStateAsUpdate(resident.doc),
			{
				throughSequence: headBefore.latestSequence,
				generation: headBefore.generation,
				semanticEpoch: headBefore.semanticEpoch,
			},
		), /checkpoint head mismatch/, "retired Canvas expected-head cannot reset the new lineage");
	});
});

s.test("post-durable reset install failure drops stale RAM and still fences the retired epoch", async () => {
	await withRuntime(async ({ store, cache, compaction, fences }) => {
		const documentId = "install-failure-body";
		const preserved = commitPathologicalDocument(store, documentId, "body");
		cache.load(documentId, true, () => true);
		const previousEpoch = store.documentHead(documentId)!.semanticEpoch;
		cache.installSemanticReset = () => { throw new Error("injected resident install failure"); };

		const outcome = await compaction.recordCommit(documentId, 1);
		assert.equal(outcome.status, "compacted");
		if (outcome.status !== "compacted") return;
		assert.equal(store.documentHead(documentId)!.semanticEpoch, previousEpoch + 1,
			"the exact durable reset remains authoritative");
		assert.equal(cache.get(documentId), undefined,
			"the retired resident epoch is discarded after install failure");
		assert.deepEqual(fences, [{ documentId, previousEpoch, currentEpoch: previousEpoch + 1 }],
			"old sockets are fenced even when the resident install fails");

		const recovered = store.reconstructDocument(documentId);
		try {
			assert.equal(recovered.semanticEpoch, previousEpoch + 1);
			assert.equal(recovered.doc.getText("body").toString(), preserved);
		} finally { recovered.doc.destroy(); }
	});
});

s.test("repeated body resets keep fresh identities small, recoverable, and CAS fenced", async () => {
	await withRuntime(async ({ store, cache, compaction, fences }) => {
		const documentId = "repeated-reset-body";
		const initial = new Y.Doc({ guid: documentId });
		initial.getText("body").insert(0, "---\ntitle: repeated resets\n---\nstill here\n");
		store.commitUpdate({ documentId, update: Y.encodeStateAsUpdate(initial), kind: "body" });
		initial.destroy();
		cache.load(documentId, true, () => true);

		let expectedEpoch = store.documentHead(documentId)!.semanticEpoch;
		for (let cycle = 0; cycle < 3; cycle++) {
			const resident = cache.get(documentId)!;
			const producer = new Y.Doc({ guid: documentId });
			Y.applyUpdate(producer, Y.encodeStateAsUpdate(resident.doc), "fresh-client-baseline");
			const before = Y.encodeStateVector(producer);
			const text = producer.getText("body");
			const preserved = text.toString();
			for (let churn = 0; churn < 48; churn++) {
				// Deliberately distinct identities model bounded multi-device churn.
				// The reset must retire all of them instead of carrying tombstones on.
				producer.clientID = 20_000 + (cycle * 100) + churn;
				text.insert(text.length, "x");
				text.delete(text.length - 1, 1);
			}
			const update = Y.encodeStateAsUpdate(producer, before);
			producer.destroy();

			const durable = store.commitUpdate({ documentId, update, kind: "body" });
			assert.equal(cache.applyDurableUpdate(documentId, update, durable.generation, "test-churn"), true);
			assert.equal(cache.get(documentId)!.doc.getText("body").toString(), preserved);
			const resetFromHead = store.documentHead(documentId)!;
			assert.equal(resetFromHead.semanticEpoch, expectedEpoch);

			const outcome = await compaction.recordCommit(documentId, update.byteLength);
			assert.equal(outcome.status, "compacted", `cycle ${cycle + 1} should reset its pathological lineage`);
			if (outcome.status !== "compacted") return;
			assert.equal(outcome.result.previousSemanticEpoch, expectedEpoch);
			expectedEpoch++;
			assert.equal(outcome.result.semanticEpoch, expectedEpoch);
			assert.equal(store.documentHead(documentId)!.semanticEpoch, expectedEpoch);
			assert.equal(store.documentHead(documentId)!.generation, resetFromHead.generation,
				"reset advances lineage, not content generation");
			assert.ok(outcome.freshStructs <= 4,
				`cycle ${cycle + 1} fresh lineage should remain tiny, got ${outcome.freshStructs}`);
			assert.equal(cache.get(documentId)!.doc.getText("body").toString(), preserved);

			const recovered = store.reconstructDocument(documentId);
			try {
				assert.equal(recovered.semanticEpoch, expectedEpoch);
				assert.equal(recovered.doc.getText("body").toString(), preserved);
			} finally {
				recovered.doc.destroy();
			}

			assert.throws(() => store.semanticResetFromEncodedState(
				documentId,
				Y.encodeStateAsUpdate(cache.get(documentId)!.doc),
				{
					throughSequence: resetFromHead.latestSequence,
					generation: resetFromHead.generation,
					semanticEpoch: resetFromHead.semanticEpoch,
				},
				Date.now(),
			), /checkpoint head mismatch/,
			`cycle ${cycle + 1} retired epoch must fail exact-head CAS`);
		}

		assert.equal(fences.length, 3);
		assert.deepEqual(fences.map(({ previousEpoch, currentEpoch }) => [previousEpoch, currentEpoch]), [
			[1, 2], [2, 3], [3, 4],
		]);
	});
});

s.test("cooldown and low-water mark survive runtime restart without hot-path state writes", async () => {
	await withRuntime(async ({ store, cache, compaction }) => {
		const documentId = "restart-stable-compaction";
		commitPathologicalDocument(store, documentId, "body");
		cache.load(documentId, true, () => true);
		const first = await compaction.recordCommit(documentId, 1);
		assert.equal(first.status, "compacted");
		if (first.status !== "compacted") return;
		const durableAfterReset = store.semanticCompactionState(documentId)!;
		assert.equal(durableAfterReset.lastCompactedAt, 1_001);
		assert.equal(durableAfterReset.postCompactionEncodedStateBytes, first.result.totalBytes);

		const producer = new Y.Doc({ guid: documentId });
		Y.applyUpdate(producer, Y.encodeStateAsUpdate(cache.get(documentId)!.doc));
		const before = Y.encodeStateVector(producer);
		const text = producer.getText("body");
		for (let index = 0; index < 30; index++) {
			producer.clientID = 60_000 + index;
			text.insert(text.length, "x");
			text.delete(text.length - 1, 1);
		}
		const update = Y.encodeStateAsUpdate(producer, before);
		producer.destroy();
		const commit = store.commitUpdate({ documentId, update, kind: "body" });
		cache.applyDurableUpdate(documentId, update, commit.generation, "restart-test");

		const options = {
			store,
			cache,
			fenceSockets: () => 0,
			now: () => 2_000,
			cadence: { commits: 1, ingressBytes: Number.MAX_SAFE_INTEGER, maxIntervalMs: Number.MAX_SAFE_INTEGER },
			thresholds: () => ({ ...TEST_THRESHOLDS, softCooldownMs: 100_000 }),
		};
		const restarted = new SemanticCompactionRuntime(options);
		const measured = await restarted.recordCommit(documentId, 1);
		assert.equal(measured.status, "measured");
		if (measured.status !== "measured") return;
		assert.ok(measured.decision.reasons.includes("soft-cooldown"),
			"restart must not bypass the durable post-reset cooldown");
		assert.equal(restarted.diagnostics()[documentId]!.policy.postCompactionEncodedStateBytes,
			first.result.totalBytes, "the durable low-water mark reloads with the new runtime");
	});
});

s.test("a dirty resident document is never reset", async () => {
	await withRuntime(async ({ store, cache, compaction, fences }) => {
		const documentId = "dirty-body";
		commitPathologicalDocument(store, documentId, "body");
		const loaded = cache.load(documentId, true, () => true);
		assert.deepEqual(cache.queue(documentId, {
			bytes: new Uint8Array([1]), digest: "queued", socketId: "socket",
		}), { ok: true });
		const epoch = loaded.semanticEpoch;
		assert.deepEqual(await compaction.recordCommit(documentId, 1), { status: "busy" });
		assert.equal(store.documentHead(documentId)!.semanticEpoch, epoch);
		assert.deepEqual(fences, []);
	});
});

s.test("first-call memory pressure fences admission before a busy document can skip measurement", async () => {
	await withRuntime(async ({ store, cache, compaction }) => {
		const documentId = "busy-memory-pressure-body";
		const document = new Y.Doc({ guid: documentId });
		document.getText("body").insert(0, "busy\n");
		store.commitUpdate({ documentId, update: Y.encodeStateAsUpdate(document), kind: "body" });
		document.destroy();
		const loaded = cache.load(documentId, true, () => true);
		loaded.dirty = true;
		cache.hasResidentMemoryPressure = () => true;

		assert.deepEqual(await compaction.measureAndMaybeCompact(documentId), { status: "busy" });
		assert.equal(compaction.shouldPauseAdmission(documentId), true);
		assert.equal(compaction.diagnostics()[documentId]?.admissionPaused, true);
	}, { thresholds: OPERATIONAL_ONLY_THRESHOLDS });
});

s.test("first hard latency measurement retains its fence when transient reservation fails", async () => {
	await withRuntime(async ({ store, cache, compaction }) => {
		const documentId = "reservation-latency-pressure-body";
		commitPathologicalDocument(store, documentId, "body");
		cache.load(documentId, true, () => true);
		await compaction.recordCommit(documentId, 1, 51);
		await compaction.recordCommit(documentId, 1, 52);
		cache.recordTransient = () => { throw new Error("transient reservation denied"); };

		await assert.rejects(
			() => compaction.recordCommit(documentId, 1, 53),
			/transient reservation denied/,
		);
		assert.equal(compaction.shouldPauseAdmission(documentId), true);
		assert.equal(compaction.diagnostics()[documentId]?.latencyViolationStreak, 3,
			"failed preflight retains the evidence for the next exact attempt");
	}, {
		commitLatencyObjectiveMs: 50,
		cadence: {
			commits: Number.MAX_SAFE_INTEGER,
			ingressBytes: Number.MAX_SAFE_INTEGER,
			maxIntervalMs: Number.MAX_SAFE_INTEGER,
		},
		thresholds: OPERATIONAL_ONLY_THRESHOLDS,
	});
});

s.test("commit latency streak forces exact measurement and successful compaction clears admission", async () => {
	await withRuntime(async ({ store, cache, compaction }) => {
		const documentId = "latency-pressure-body";
		commitPathologicalDocument(store, documentId, "body");
		cache.load(documentId, true, () => true);
		assert.equal(compaction.shouldPauseAdmission(documentId), false);

		assert.deepEqual(await compaction.recordCommit(documentId, 1, 51), { status: "not-due" });
		assert.deepEqual(await compaction.recordCommit(documentId, 1, 60), { status: "not-due" });
		assert.equal(compaction.diagnostics()[documentId]?.latencyViolationStreak, 2);
		assert.deepEqual(await compaction.recordCommit(documentId, 1, 50), { status: "not-due" },
			"a commit at the objective clears the consecutive streak");
		assert.equal(compaction.diagnostics()[documentId]?.latencyViolationStreak, 0);

		await compaction.recordCommit(documentId, 1, 51);
		await compaction.recordCommit(documentId, 1, 52);
		const outcome = await compaction.recordCommit(documentId, 1, 53);
		assert.equal(outcome.status, "compacted", "hard latency pressure bypasses the ordinary census cadence");
		if (outcome.status !== "compacted") return;
		assert.ok(outcome.decision.reasons.includes("repeated-latency-pressure"));
		assert.equal(compaction.shouldPauseAdmission(documentId), false,
			"a successful reset clears the temporary admission fence");
		assert.equal(compaction.diagnostics()[documentId]?.latencyViolationStreak, 0);
	}, {
		commitLatencyObjectiveMs: 50,
		cadence: {
			commits: Number.MAX_SAFE_INTEGER,
			ingressBytes: Number.MAX_SAFE_INTEGER,
			maxIntervalMs: Number.MAX_SAFE_INTEGER,
		},
		thresholds: OPERATIONAL_ONLY_THRESHOLDS,
	});
});

s.test("automatic cache pressure pauses admission until a clean exact measurement clears it", async () => {
	await withRuntime(async ({ store, cache, compaction }) => {
		const documentId = "irreducible-memory-pressure-body";
		const document = new Y.Doc({ guid: documentId });
		document.getText("body").insert(0, "already compact\n");
		store.commitUpdate({ documentId, update: Y.encodeStateAsUpdate(document), kind: "body" });
		document.destroy();
		const loaded = cache.load(documentId, true, () => true);
		let memoryPressure = true;
		cache.hasResidentMemoryPressure = () => memoryPressure;

		const hard = await compaction.measureAndMaybeCompact(documentId);
		assert.equal(hard.status, "measured");
		if (hard.status !== "measured") return;
		assert.equal(hard.decision.urgency, "hard");
		assert.ok(hard.decision.reasons.includes("memory-pressure"));
		assert.equal(hard.decision.semanticResetRecommended, false);
		assert.equal(compaction.shouldPauseAdmission(documentId), true);
		assert.equal(compaction.diagnostics()[documentId]?.admissionPaused, true);

		loaded.dirty = true;
		assert.deepEqual(await compaction.measureAndMaybeCompact(documentId), { status: "busy" });
		assert.equal(compaction.shouldPauseAdmission(documentId), true,
			"an inexact busy check cannot clear a hard-pressure fence");
		loaded.dirty = false;
		memoryPressure = false;
		const cleared = await compaction.measureAndMaybeCompact(documentId);
		assert.equal(cleared.status, "measured");
		if (cleared.status === "measured") assert.equal(cleared.decision.urgency, "none");
		assert.equal(compaction.shouldPauseAdmission(documentId), false);
	}, { thresholds: OPERATIONAL_ONLY_THRESHOLDS });
});

s.test("invalid latency observations fail closed", async () => {
	await withRuntime(async ({ compaction }) => {
		await assert.rejects(() => compaction.recordCommit("bad-latency", 1, Number.NaN), /invalid commit latency/);
		await assert.rejects(() => compaction.recordCommit("bad-latency", 1, -1), /invalid commit latency/);
	});
});

s.test("socket fencing targets only the retired Canvas lineage and sends the reset contract", () => {
	const events: Array<{ id: string; kind: "send" | "close"; value: unknown }> = [];
	const base: VaultSocketAttachment = {
		vaultId: "vault-semantic-compaction-test",
		vaultGeneration: "generation-semantic-compaction-test",
		runtimeEpoch: "runtime-semantic-compaction-test",
		documentId: "fenced-body",
		kind: "semantic",
		documentEpoch: 1,
		deviceId: "device-semantic-compaction-test",
		principalId: "principal-semantic-compaction-test",
		membershipRevision: 1,
		deviceCredentialRevision: 1,
		role: "member",
		policyVersion: 1,
		capabilityDigest: "capability-semantic-compaction-test",
		socketId: "socket-semantic-compaction-test",
	};
	const port = (id: string, value: VaultSocketAttachment): VaultSocketPort => ({
		deserializeAttachment: () => value,
		serializeAttachment: () => {},
		send: (message) => events.push({ id, kind: "send", value: message }),
		close: (code, reason) => events.push({ id, kind: "close", value: { code, reason } }),
	});
	const old = port("old", base);
	const current = port("current", { ...base, documentEpoch: 2, socketId: "socket-current" });
	const other = port("other", { ...base, documentId: "other-body", socketId: "socket-other" });
	const service = new VaultSocketService({
		sockets: {
			sockets: () => [old, current, other],
			createPair: () => { throw new Error("not used"); },
			accept: () => {},
			upgradeResponse: () => { throw new Error("not used"); },
		},
		cache: {}, vaultId: () => base.vaultId, vaultGeneration: () => base.vaultGeneration,
		runtimeEpoch: base.runtimeEpoch, isActiveBody: () => true, currentBodyHead: () => null,
		currentRootEpoch: () => 1, currentSequence: () => 1, validateActor: () => true,
		principalPresence: () => null, scheduleFlush: () => {},
	} as never);
	assert.equal(service.fenceSemanticEpoch("fenced-body", 1, 2), 1);
	assert.equal(events.length, 2);
	assert.deepEqual(JSON.parse((events[0]!.value as string).slice(6)), {
		type: "SEMANTIC_EPOCH_RESET_REQUIRED",
		code: "semantic_epoch_mismatch",
		purpose: "body",
		documentId: "fenced-body",
		expectedEpoch: 2,
		receivedEpoch: 1,
	});
	assert.deepEqual(events[1], {
		id: "old", kind: "close",
		value: { code: SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE, reason: "semantic epoch reset" },
	});
});

await s.done();
