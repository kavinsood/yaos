import {
	encodeManifestNode,
	encodeSnapshotRoot,
	recoveryContentObjectKey,
	type ActiveFileManifestEntry,
	type AttachmentManifestEntry,
	type DeletedFileManifestEntry,
	type SnapshotRootV2,
} from "../../server/src/recoveryManifestTree";
import { gzipRecoveryBytes } from "../../server/src/recoveryCanonicalJson";
import { sha256Hex } from "../../server/src/hex";
import { blobObjectKey, recoveryPrefix } from "../../server/src/recoveryProtocol";
import { RecoveryReadError, RecoveryReadService } from "../../server/src/recoveryReadService";
import { FakeObjectStore } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("snapshot-v2-lookup");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const vaultId = "vault-lookup-aa";
const vaultGeneration = "generation-lookup-aa";
const prefix = recoveryPrefix(vaultId, vaultGeneration);

async function seededSnapshot() {
	const bucket = new FakeObjectStore();
	const markdown = encoder.encode("verified snapshot body");
	const deletedMarkdown = encoder.encode("deleted historical body");
	const attachment = new Uint8Array([0, 1, 127, 255]);
	const [contentHash, deletedHash, attachmentHash, vaultIdHash, vaultGenerationHash] = await Promise.all([
		sha256Hex(markdown),
		sha256Hex(deletedMarkdown),
		sha256Hex(attachment),
		sha256Hex(encoder.encode(vaultId)),
		sha256Hex(encoder.encode(vaultGeneration)),
	]);
	const activeEntry: ActiveFileManifestEntry = {
		availability: "available",
		path: "notes/reachable.md",
		fileId: "file-1",
		bodyId: "body-1",
		bodyGeneration: 7,
		contentHash,
		size: markdown.byteLength,
	};
	const deletedEntry: DeletedFileManifestEntry = {
		availability: "available",
		bodyId: "deleted-body-1",
		fileId: "deleted-file-1",
		lastPath: "notes/deleted.md",
		deletedAtSequence: 8,
		baselineContentHash: deletedHash,
		baselineSize: deletedMarkdown.byteLength,
		bodyReaped: true,
	};
	const attachmentEntry: AttachmentManifestEntry = {
		availability: "available",
		path: "assets/reachable.bin",
		hash: attachmentHash,
		size: attachment.byteLength,
		mime: "application/octet-stream",
	};
	const [active, deleted, attachments] = await Promise.all([
		encodeManifestNode(prefix, { format: "yaos-manifest-leaf-v1", depth: 0, entries: [activeEntry] }),
		encodeManifestNode(prefix, { format: "yaos-manifest-leaf-v1", depth: 0, entries: [deletedEntry] }),
		encodeManifestNode(prefix, { format: "yaos-manifest-leaf-v1", depth: 0, entries: [attachmentEntry] }),
	]);
	for (const node of [active, deleted, attachments]) bucket.objects.set(node.objectKey, node.compressedBytes);
	bucket.objects.set(recoveryContentObjectKey(prefix, contentHash), gzipRecoveryBytes(markdown));
	bucket.objects.set(recoveryContentObjectKey(prefix, deletedHash), gzipRecoveryBytes(deletedMarkdown));
	bucket.objects.set(blobObjectKey(vaultId, vaultGeneration, attachmentHash), attachment);
	bucket.objects.set(`${prefix}/content/sha256/ff/${"f".repeat(64)}.md.gz`, gzipRecoveryBytes(encoder.encode("unreachable")));
	const rootValue: SnapshotRootV2 = {
		format: "yaos-recovery-v2",
		snapshotFormatVersion: 2,
		snapshotId: "snapshot-lookup-1",
		vaultIdHash,
		vaultGenerationHash,
		runtimeEpoch: "runtime-lookup-1",
		boundarySequence: 9,
		rootGeneration: 3,
		sourcePlanDigest: "a".repeat(64),
		manifestGraphDigest: "b".repeat(64),
		manifestNodeCount: 3,
		createdAt: "2026-08-24T00:00:00.000Z",
		completedAt: "2026-08-24T00:00:01.000Z",
		health: "complete",
		reason: "manual",
		activeFilesTreeHash: active.hash,
		deletedFilesTreeHash: deleted.hash,
		attachmentsTreeHash: attachments.hash,
		totals: {
			activeFiles: 1,
			deletedFiles: 1,
			unavailableFiles: 0,
			attachments: 1,
			markdownBytes: markdown.byteLength + deletedMarkdown.byteLength,
			attachmentBytes: attachment.byteLength,
		},
		previousSnapshotId: null,
	};
	const root = await encodeSnapshotRoot(prefix, rootValue);
	bucket.objects.set(root.objectKey, root.canonicalBytes);
	return {
		bucket,
		retained: {
			snapshotId: rootValue.snapshotId,
			vaultGeneration,
			rootKey: root.objectKey,
			rootHash: root.hash,
		},
		markdown,
		deletedMarkdown,
		attachment,
	};
}

async function readError(work: () => Promise<unknown>): Promise<RecoveryReadError> {
	try {
		await work();
	} catch (error) {
		if (error instanceof RecoveryReadError) return error;
		throw error;
	}
	throw new Error("expected recovery read to fail");
}

s.test("canonical root-tree-content reads fetch only reachable verified Markdown", async () => {
	const { bucket, retained, markdown } = await seededSnapshot();
	const reader = new RecoveryReadService(bucket, vaultId, vaultGeneration);
	const result = await reader.activeFile(retained, "notes/reachable.md");
	if (decoder.decode(result.bytes) !== decoder.decode(markdown)) throw new Error("reachable Markdown changed");
	if (bucket.gets.length !== 3) throw new Error(`reader used ${bucket.gets.length} reads instead of root, node, content`);
	if (bucket.gets.some((key) => key.includes("f".repeat(64)))) throw new Error("reader fetched unreachable content");
	if (await reader.activeEntry(retained, "notes/missing.md") !== null) throw new Error("missing path resolved to another entry");
});

s.test("deleted and attachment paths use their own verified trees and storage domains", async () => {
	const { bucket, retained, deletedMarkdown, attachment } = await seededSnapshot();
	const reader = new RecoveryReadService(bucket, vaultId, vaultGeneration);
	const deleted = await reader.deletedFile(retained, "deleted-body-1");
	const binary = await reader.file(retained, "assets/reachable.bin");
	if (decoder.decode(deleted.bytes) !== decoder.decode(deletedMarkdown)) throw new Error("deleted content changed");
	if (binary.contentType !== "application/octet-stream" || binary.bytes.join(",") !== attachment.join(",")) {
		throw new Error("attachment read changed bytes or MIME");
	}
	if (!bucket.gets.some((key) => key.includes(`/${vaultGeneration}/blobs/`))) throw new Error("attachment bypassed generation-scoped blob storage");
});

s.test("generation mismatch is rejected before every root, entry, and content read", async () => {
	const { bucket, retained } = await seededSnapshot();
	const reader = new RecoveryReadService(bucket, vaultId, vaultGeneration);
	const stale = { ...retained, vaultGeneration: "stale-generation" };
	for (const work of [
		() => reader.root(stale),
		() => reader.entry(stale, "notes/reachable.md"),
		() => reader.file(stale, "notes/reachable.md"),
		() => reader.deletedEntry(stale, "deleted-body-1"),
		() => reader.deletedFile(stale, "deleted-body-1"),
	]) {
		const before = bucket.gets.length;
		const error = await readError(work);
		if (error.code !== "invalid_snapshot_authority" || bucket.gets.length !== before) {
			throw new Error("stale generation reached object storage");
		}
	}
});

s.test("root authority and canonical content corruption fail closed", async () => {
	const { bucket, retained } = await seededSnapshot();
	const reader = new RecoveryReadService(bucket, vaultId, vaultGeneration);
	const badKey = await readError(() => reader.root({ ...retained, rootKey: `${prefix}/roots/arbitrary.json` }));
	if (badKey.code !== "invalid_snapshot_authority") throw new Error("arbitrary root key was accepted");
	const rootBytes = bucket.objects.get(retained.rootKey)!;
	const corrupt = rootBytes.slice();
	const corruptIndex = corrupt.byteLength - 2;
	corrupt[corruptIndex] = (corrupt[corruptIndex] ?? 0) ^ 1;
	bucket.objects.set(retained.rootKey, corrupt);
	const badRoot = await readError(() => reader.root(retained));
	if (badRoot.code !== "corrupt_snapshot_root") throw new Error("corrupt root was not explicit");
});

s.test("missing, oversized, unavailable, and hash-mismatched content are explicit", async () => {
	const { bucket, retained } = await seededSnapshot();
	const reader = new RecoveryReadService(bucket, vaultId, vaultGeneration);
	const active = await reader.activeEntry(retained, "notes/reachable.md");
	if (!active || active.availability !== "available") throw new Error("fixture entry missing");
	const contentKey = recoveryContentObjectKey(prefix, active.contentHash);
	bucket.objects.delete(contentKey);
	if ((await readError(() => reader.activeFile(retained, active.path))).code !== "recovery_object_missing") {
		throw new Error("missing content was not explicit");
	}
	bucket.objects.set(contentKey, gzipRecoveryBytes(encoder.encode("same-size-wrong-content")));
	const mismatch = await readError(() => reader.activeFile(retained, active.path));
	if (mismatch.code !== "snapshot_content_corrupt" && mismatch.code !== "snapshot_content_hash_mismatch") {
		throw new Error("content corruption was not explicit");
	}
});

await s.done();
