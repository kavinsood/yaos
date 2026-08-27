import {
	canonicalJsonBytes,
	canonicalJsonHash,
	gzipRecoveryBytes,
} from "../../server/src/recoveryCanonicalJson";
import {
	MANIFEST_BRANCH_FORMAT,
	collectReachableManifestNodes,
	computeManifestGraphDigest,
	createEmptyManifestTree,
	decodeAndVerifyManifestNode,
	encodeSnapshotRoot,
	lookupManifestEntry,
	mutateManifestTree,
	mutateManifestTreeChunk,
	parseAndVerifySnapshotRoot,
	rebuildManifestTree,
	type ActiveFileManifestEntry,
	type DeletedFileManifestEntry,
	type EncodedManifestNode,
	type ManifestNodeStore,
	type ManifestTreeMutation,
	type SnapshotRootV2,
} from "../../server/src/recoveryManifestTree";
import { sha256Hex } from "../../server/src/hex";
import { decodeRecoveryRpcPayload, encodeRecoveryRpcPayload } from "../../server/src/recoveryProtocol";
import { suite } from "../harness.ts";

const s = suite("recovery-v2-format-tree");
const encoder = new TextEncoder();

class MemoryNodeStore implements ManifestNodeStore {
	readonly objects = new Map<string, Uint8Array>();
	reads = 0;

	async readNode(hash: string): Promise<Uint8Array | null> {
		this.reads++;
		return this.objects.get(hash)?.slice() ?? null;
	}

	async writeNode(node: EncodedManifestNode): Promise<"written" | "reused"> {
		if (this.objects.has(node.hash)) return "reused";
		this.objects.set(node.hash, node.compressedBytes.slice());
		return "written";
	}
}

function hashFor(index: number): string {
	return index.toString(16).padStart(64, "0");
}

function activeEntry(index: number, path = `notes/${String(index).padStart(5, "0")}.md`): ActiveFileManifestEntry {
	return {
		availability: "available",
		path,
		fileId: `file-${index}`,
		bodyId: `body-${index}`,
		bodyGeneration: index,
		contentHash: hashFor(index + 1),
		size: index + 10,
	};
}

async function rejects(work: () => unknown | Promise<unknown>, label: string): Promise<void> {
	try {
		await work();
	} catch {
		return;
	}
	throw new Error(`${label} was accepted`);
}

function rootFixture(): SnapshotRootV2 {
	return {
		format: "yaos-recovery-v2",
		snapshotFormatVersion: 2,
		snapshotId: "snapshot-1",
		vaultIdHash: "a".repeat(64),
		vaultGenerationHash: "b".repeat(64),
		runtimeEpoch: "epoch-1",
		boundarySequence: 8,
		rootGeneration: 3,
		sourcePlanDigest: "c".repeat(64),
		manifestGraphDigest: "d".repeat(64),
		manifestNodeCount: 3,
		createdAt: "2026-08-24T00:00:00.000Z",
		completedAt: "2026-08-24T00:01:00.000Z",
		health: "complete",
		reason: "manual",
		activeFilesTreeHash: "e".repeat(64),
		deletedFilesTreeHash: "f".repeat(64),
		attachmentsTreeHash: "1".repeat(64),
		totals: {
			activeFiles: 1,
			deletedFiles: 0,
			unavailableFiles: 0,
			attachments: 0,
			markdownBytes: 12,
			attachmentBytes: 0,
		},
		previousSnapshotId: null,
	};
}

s.test("canonical JSON and gzip are deterministic and hash logical bytes", async () => {
	const left = canonicalJsonBytes({ z: [3, 2, 1], a: { y: 2, x: 1 } });
	const right = canonicalJsonBytes({ a: { x: 1, y: 2 }, z: [3, 2, 1] });
	if (new TextDecoder().decode(left) !== "{\"a\":{\"x\":1,\"y\":2},\"z\":[3,2,1]}") {
		throw new Error("canonical record order changed");
	}
	if (await sha256Hex(left) !== await sha256Hex(right)) throw new Error("equivalent canonical JSON hashed differently");
	const first = gzipRecoveryBytes(left);
	const second = gzipRecoveryBytes(right);
	if (first.byteLength !== second.byteLength || first.some((byte, index) => byte !== second[index])) {
		throw new Error("canonical gzip is nondeterministic");
	}
	await rejects(() => canonicalJsonHash({ fractional: 1.5 }), "fractional number");
	await rejects(() => canonicalJsonHash({ unsafe: Number.MAX_SAFE_INTEGER + 1 }), "unsafe number");
	await rejects(() => canonicalJsonHash({ malformed: "\ud800" }), "malformed Unicode");
});

s.test("snapshot roots are raw canonical content-addressed strict v2", async () => {
	const root = rootFixture();
	const encoded = await encodeSnapshotRoot("vault/test/generation/recovery-v2", root);
	if (encoded.canonicalBytes[0] !== 0x7b || !encoded.objectKey.endsWith(`${encoded.hash}.json`)) {
		throw new Error("root is not raw canonical content-addressed JSON");
	}
	const decoded = await parseAndVerifySnapshotRoot(encoded.canonicalBytes, encoded.hash);
	if (decoded.snapshotId !== root.snapshotId || decoded.vaultGenerationHash !== root.vaultGenerationHash) {
		throw new Error("snapshot root round trip changed authority");
	}
	const v1 = canonicalJsonBytes({ ...root, format: "yaos-recovery-v1", snapshotFormatVersion: 1 });
	await rejects(async () => parseAndVerifySnapshotRoot(v1, await sha256Hex(v1)), "v1 root");
	const corrupt = encoded.canonicalBytes.slice();
	corrupt[corrupt.byteLength - 2] = (corrupt[corrupt.byteLength - 2] ?? 0) ^ 1;
	await rejects(() => parseAndVerifySnapshotRoot(corrupt, encoded.hash), "corrupt root");
});

s.test("manifest split and lookup follow one bounded digest branch", async () => {
	const store = new MemoryNodeStore();
	const entries = Array.from({ length: 520 }, (_, index) => activeEntry(index));
	const tree = await rebuildManifestTree(store, "recovery-v2", "active", entries);
	if (tree.nodes <= 1 || tree.reachable[0]?.nodeFormat !== MANIFEST_BRANCH_FORMAT) {
		throw new Error("entry bound did not split the manifest");
	}
	store.reads = 0;
	const found = await lookupManifestEntry(store, "active", tree.rootHash, entries[519]!.path);
	if (found.entry?.bodyId !== entries[519]!.bodyId || found.nodeReads > 2 || found.nodeReads !== store.reads) {
		throw new Error("lookup scanned outside its digest branch");
	}
	await rejects(() => lookupManifestEntry(store, "active", tree.rootHash, entries[0]!.path, { maxReads: 1 }), "read bound");
	await rejects(() => lookupManifestEntry(store, "active", tree.rootHash, entries[0]!.path, { maxCompressedBytes: 1 }), "byte bound");
});

s.test("incremental mutation converges with a canonical rebuild and collapses splits", async () => {
	const store = new MemoryNodeStore();
	const initial = Array.from({ length: 520 }, (_, index) => activeEntry(index));
	const split = await rebuildManifestTree(store, "recovery-v2", "active", [...initial].reverse());
	const remaining = initial.slice(20);
	const mutations: ManifestTreeMutation<ActiveFileManifestEntry>[] = initial.slice(0, 20)
		.map((entry) => ({ type: "delete", key: entry.path }));
	const changed = { ...remaining[0]!, bodyGeneration: 999, contentHash: "9".repeat(64) };
	remaining[0] = changed;
	mutations.push({ type: "upsert", entry: changed });
	const incremental = await mutateManifestTree(store, "recovery-v2", "active", split.rootHash, mutations);
	const rebuilt = await rebuildManifestTree(store, "recovery-v2", "active", remaining);
	if (incremental.rootHash !== rebuilt.rootHash || incremental.entries !== remaining.length || incremental.nodes !== 1) {
		throw new Error("incremental tree diverged from canonical rebuild or failed to collapse");
	}
});

s.test("actor mutation chunks are bounded and expose only a checkpoint", async () => {
	const store = new MemoryNodeStore();
	const empty = await createEmptyManifestTree(store, "recovery-v2", "active");
	const chunk = await mutateManifestTreeChunk(store, "recovery-v2", "active", empty.rootHash, [
		{ type: "upsert", entry: activeEntry(1) },
		{ type: "upsert", entry: activeEntry(2) },
	]);
	if (chunk.entries !== 2 || "reachable" in chunk) throw new Error("bounded mutation returned an invalid checkpoint");
	await rejects(() => mutateManifestTreeChunk(
		store,
		"recovery-v2",
		"active",
		chunk.rootHash,
		Array.from({ length: 101 }, (_, index) => ({ type: "upsert" as const, entry: activeEntry(100 + index) })),
	), "oversized mutation chunk");
});

s.test("manifest decoding rejects corruption, noncanonical JSON, and invented fields", async () => {
	const store = new MemoryNodeStore();
	const tree = await rebuildManifestTree(store, "recovery-v2", "active", [activeEntry(1)]);
	const encoded = store.objects.get(tree.rootHash)!;
	const corrupt = encoded.slice();
	const corruptIndex = Math.floor(corrupt.byteLength / 2);
	corrupt[corruptIndex] = (corrupt[corruptIndex] ?? 0) ^ 0xff;
	await rejects(() => decodeAndVerifyManifestNode("active", corrupt, tree.rootHash), "corrupt compressed node");
	const noncanonical = encoder.encode("{\"format\":\"yaos-manifest-leaf-v1\", \"depth\":0,\"entries\":[]}");
	await rejects(
		async () => decodeAndVerifyManifestNode("active", gzipRecoveryBytes(noncanonical), await sha256Hex(noncanonical)),
		"noncanonical node",
	);
	const extra = canonicalJsonBytes({ format: "yaos-manifest-leaf-v1", depth: 0, entries: [], timestamp: "forbidden" });
	await rejects(
		async () => decodeAndVerifyManifestNode("active", gzipRecoveryBytes(extra), await sha256Hex(extra)),
		"node with invented field",
	);
});

s.test("deleted identities remain independent from canonical active paths", async () => {
	const store = new MemoryNodeStore();
	const active = activeEntry(1, "Café/Note.md");
	const deleted: DeletedFileManifestEntry = {
		availability: "available",
		bodyId: "old-body",
		fileId: "old-file",
		lastPath: active.path,
		deletedAtSequence: 7,
		baselineContentHash: "7".repeat(64),
		baselineSize: 4,
		bodyReaped: true,
	};
	const activeTree = await rebuildManifestTree(store, "recovery-v2", "active", [active]);
	const deletedTree = await rebuildManifestTree(store, "recovery-v2", "deleted", [deleted]);
	if ((await lookupManifestEntry(store, "active", activeTree.rootHash, active.path)).entry?.bodyId !== active.bodyId
		|| (await lookupManifestEntry(store, "deleted", deletedTree.rootHash, deleted.bodyId)).entry?.bodyId !== deleted.bodyId) {
		throw new Error("path and body identity lookup collapsed");
	}
	await rejects(
		() => rebuildManifestTree(store, "recovery-v2", "active", [{ ...active, path: "Cafe\u0301/Note.md" }]),
		"non-NFC path",
	);
});

s.test("reachable node counts and graph digest are traversal-order independent", async () => {
	const store = new MemoryNodeStore();
	const tree = await rebuildManifestTree(store, "recovery-v2", "active", Array.from({ length: 520 }, (_, index) => activeEntry(index)));
	const reachable = await collectReachableManifestNodes(store, "active", tree.rootHash);
	if (reachable[0]?.subtreeEntries !== 520 || reachable.length !== tree.nodes) throw new Error("reachable graph counts changed");
	if (await computeManifestGraphDigest(reachable) !== await computeManifestGraphDigest([...reachable].reverse())) {
		throw new Error("manifest graph digest depends on traversal order");
	}
});

s.test("internal RPC codec preserves nested binary values without aliasing", () => {
	const update = new Uint8Array([0, 1, 127, 128, 255]);
	const encoded = encodeRecoveryRpcPayload({ parts: [{ update }] });
	update.fill(9);
	const decoded = decodeRecoveryRpcPayload(encoded) as { parts: Array<{ update: Uint8Array }> };
	if (!(decoded.parts[0]?.update instanceof Uint8Array) || decoded.parts[0].update.join(",") !== "0,1,127,128,255") {
		throw new Error("RPC codec aliased or corrupted bytes");
	}
});

await s.done();
