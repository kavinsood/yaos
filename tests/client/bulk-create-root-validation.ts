import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { VaultSync, type BulkCreateRequest, type VaultSyncOptions } from "../../src/sync/vaultSync";
import { validateBulkCreateRootUpdate } from "../../src/sync/bulkCreateRootValidation";
import { suite } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { FakeBulkCreateServer, memoryVault, testProvider, type MemoryVault } from "./helpers/fakeBulkCreateServer.ts";

installDomCrypto();
const s = suite("bulk-create-root-validation");

const input = (name: string, content: string) => ({
	bodyId: `body-${name}`, path: `${name}.md`, content, candidateId: `candidate-${name}`, reason: "import",
});

/**
 * Server whose receipt delta is tampered by `tamper` (applied to a fork of the
 * authoritative root, never to the root itself), plus an honest `currentRoot`.
 */
function tamperingRuntime(
	vault: MemoryVault,
	server: FakeBulkCreateServer,
	tamper: ((fork: Y.Doc) => void) | null,
	extra: Partial<VaultSyncOptions> = {},
): { runtime: VaultSync; rootFetches: () => number; remapsSeen: string[] } {
	let fetches = 0;
	const remapsSeen: string[] = [];
	const port = server.port({
		commitCreateBulk: async (request: BulkCreateRequest) => {
			const response = await server.commitCreateBulk(request);
			if (!tamper) return response;
			const fork = new Y.Doc();
			Y.applyUpdate(fork, Y.encodeStateAsUpdate(server.root));
			tamper(fork);
			return { ...response, rootUpdate: Y.encodeStateAsUpdate(fork, request.rootStateVector) };
		},
		currentRoot: async () => {
			fetches++;
			return { rootEpoch: 1, generation: 99, encodedState: Y.encodeStateAsUpdate(server.root) };
		},
	});
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database, server: port,
		providerFactory: testProvider, createCollectorDelayMs: 0, ...extra,
	});
	runtime.pathToId.observe((event) => {
		for (const key of event.keysChanged) remapsSeen.push(`${key}=${runtime.pathToId.get(key) ?? "<deleted>"}`);
	});
	return { runtime, rootFetches: () => fetches, remapsSeen };
}

async function seedUnrelated(runtime: VaultSync, server: FakeBulkCreateServer): Promise<void> {
	// The client and server share an unrelated note before the batch.
	server.seedExisting("keep.md", "server-keep", "kept");
	Y.applyUpdate(runtime.ydoc, Y.encodeStateAsUpdate(server.root));
	assert.equal(runtime.getFileId("keep.md"), "server-keep");
}

s.test("an honest delta is applied directly with no root fetch", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const { runtime, rootFetches } = tamperingRuntime(vault, server, null);
	await seedUnrelated(runtime, server);
	const result = await runtime.commitFreshBodies([input("a", "A"), input("b", "B")]);
	assert.ok(result.results.every((item) => item.outcome === "created"));
	assert.equal(runtime.getFileId("a.md"), "body-a");
	assert.equal(runtime.getFileId("keep.md"), "server-keep");
	assert.equal(rootFetches(), 0);
	assert.equal(runtime.bulkCreateRootRejections().count, 0);
	await runtime.destroy();
});

s.test("a delta that remaps an unrelated path is never applied; the root resyncs from the server", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const { runtime, rootFetches, remapsSeen } = tamperingRuntime(vault, server,
		(fork) => fork.getMap<string>("pathToId").set("keep.md", "evil-body"));
	await seedUnrelated(runtime, server);
	const result = await runtime.commitFreshBodies([input("a", "A")]);
	assert.equal(result.results[0]!.outcome, "created");
	assert.equal(runtime.getFileId("keep.md"), "server-keep", "the unrelated path keeps its owner");
	assert.ok(!remapsSeen.some((entry) => entry.includes("evil-body")), "the bad mapping never reached the live root");
	assert.equal(rootFetches(), 1, "recovery goes through a root fetch");
	assert.equal(runtime.getFileId("a.md"), "body-a", "the honest server root delivers the created path");
	const diagnostics = runtime.bulkCreateRootRejections();
	assert.equal(diagnostics.count, 1);
	assert.match(diagnostics.last!.reason, /unrelated path keep\.md/);
	await runtime.destroy();
});

s.test("a delta that drops an unrelated path or maps the created path elsewhere is rejected", async () => {
	for (const tamper of [
		(fork: Y.Doc) => fork.getMap<string>("pathToId").delete("keep.md"),
		(fork: Y.Doc) => fork.getMap<string>("pathToId").set("a.md", "someone-else"),
	]) {
		const vault = memoryVault();
		const server = new FakeBulkCreateServer();
		const { runtime, remapsSeen } = tamperingRuntime(vault, server, tamper);
		await seedUnrelated(runtime, server);
		await runtime.commitFreshBodies([input("a", "A")]);
		assert.equal(runtime.bulkCreateRootRejections().count, 1);
		assert.equal(runtime.getFileId("keep.md"), "server-keep");
		assert.equal(runtime.getFileId("a.md"), "body-a");
		assert.ok(!remapsSeen.some((entry) => entry.includes("someone-else") || entry === "keep.md=<deleted>"));
		await runtime.destroy();
	}
});

s.test("pure validator: unrelated blob edits and changed blobMeta are rejected; new keys and existing owners are accepted", () => {
	const live = new Y.Doc();
	live.getMap("pathToBlob").set("img.png", { hash: "h1", size: 1, revision: "r1" });
	live.getMap("blobMeta").set("h1", { size: 1, mime: "image/png", createdAt: 1 });
	const fork = (edit: (doc: Y.Doc) => void): Uint8Array => {
		const doc = new Y.Doc();
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
		edit(doc);
		return Y.encodeStateAsUpdate(doc, Y.encodeStateVector(live));
	};
	const expect = { files: [{ path: "n.md", bodyId: "mine", outcome: "exists-identical" }], attachments: [] };
	assert.deepEqual(validateBulkCreateRootUpdate(live,
		fork((doc) => doc.getMap("pathToId").set("n.md", "theirs")), expect), { ok: true });
	assert.deepEqual(validateBulkCreateRootUpdate(live,
		fork((doc) => doc.getMap("pathToId").set("n.md", "mine")), expect), { ok: true },
		"exists-identical may map this client's own body (replay after a lost response)");
	assert.equal(validateBulkCreateRootUpdate(live,
		fork((doc) => doc.getMap("pathToBlob").set("img.png", { hash: "h2", size: 1, revision: "r2" })), expect).ok, false);
	assert.equal(validateBulkCreateRootUpdate(live,
		fork((doc) => doc.getMap("blobMeta").set("h1", { size: 9, mime: "x", createdAt: 1 })), expect).ok, false);
	assert.deepEqual(validateBulkCreateRootUpdate(live, fork((doc) => {
		doc.getMap("pathToId").set("other-device.md", "theirs");
		doc.getMap("blobMeta").set("h9", { size: 9, mime: "x", createdAt: 1 });
	}), expect), { ok: true }, "unseen concurrent creates of new keys are accepted");
	assert.equal(validateBulkCreateRootUpdate(live, new Uint8Array([1, 2, 3, 4, 5]), expect).ok, false);
});

await s.done();
