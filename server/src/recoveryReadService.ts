import { MAX_BLOB_UPLOAD_BYTES } from "./contracts";
import { gunzipRecoveryBytes, parseCanonicalJson } from "./recoveryCanonicalJson";
import {
	MANIFEST_LOOKUP_MAX_BYTES,
	MANIFEST_LOOKUP_MAX_READS,
	MANIFEST_MAX_COMPRESSED_BYTES,
	MANIFEST_MAX_DEPTH,
	lookupManifestEntry,
	manifestNodeObjectKey,
	parseAndVerifySnapshotRoot,
	recoveryContentObjectKey,
	snapshotRootObjectKey,
	type ActiveFileManifestEntry,
	type AttachmentManifestEntry,
	type DeletedFileManifestEntry,
	type ManifestEntryByTree,
	type ManifestTreeKind,
	type ManifestNodeSource,
	type SnapshotRootV2,
} from "./recoveryManifestTree";
import { sha256Hex } from "./hex";
import { safeBlobPath, safeMarkdownPath } from "./shared/vaultPath";
import { blobObjectKey, recoveryPrefix } from "./recoveryProtocol";

const MAX_ROOT_BYTES = 1024 * 1024;
const MAX_MARKDOWN_BYTES = 1_500_000;
const MAX_CONTENT_COMPRESSED_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export interface RetainedSnapshotRoot {
	snapshotId: string;
	vaultGeneration: string;
	rootKey: string;
	rootHash: string;
}

export type { ActiveFileManifestEntry, AttachmentManifestEntry, DeletedFileManifestEntry, SnapshotRootV2 };

export class RecoveryReadError extends Error {
	constructor(readonly code: string, readonly status: number) {
		super(code);
	}
}

function safeIdentity(value: string): boolean {
	if (value.length === 0 || encoder.encode(value).byteLength > 1024) return false;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return false;
	}
	return true;
}

/** Authenticated, state-free graph reader. Every R2 key is derived from a retained root or verified entry. */
export class RecoveryReadService {
	private readonly prefix: string;

	constructor(
		private readonly bucket: R2Bucket,
		private readonly vaultId: string,
		private readonly vaultGeneration: string,
	) {
		this.prefix = recoveryPrefix(vaultId, vaultGeneration);
	}

	async root(retained: RetainedSnapshotRoot): Promise<SnapshotRootV2> {
		return this.readRoot(retained);
	}
	async entry(retained: RetainedSnapshotRoot, path: string): Promise<ActiveFileManifestEntry | AttachmentManifestEntry | null> {
		if (safeMarkdownPath(path) === path) return this.activeEntry(retained, path);
		if (safeBlobPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		return this.lookup("attachments", root.attachmentsTreeHash, path);
	}

	async file(retained: RetainedSnapshotRoot, path: string): Promise<{
		entry: ActiveFileManifestEntry | AttachmentManifestEntry;
		bytes: Uint8Array;
		hash: string;
		contentType: string;
	}> {
		if (safeMarkdownPath(path) === path) {
			const result = await this.activeFile(retained, path);
			return {
				...result,
				hash: result.entry.availability === "available" ? result.entry.contentHash : "",
				contentType: "text/markdown; charset=utf-8",
			};
		}
		if (safeBlobPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		const entry = await this.lookup("attachments", root.attachmentsTreeHash, path);
		if (!entry) throw new RecoveryReadError("snapshot_entry_not_found", 404);
		if (entry.availability !== "available") throw new RecoveryReadError("snapshot_content_unavailable", 409);
		const bytes = await this.readAttachment(entry.hash, entry.size);
		return { entry, bytes, hash: entry.hash, contentType: entry.mime ?? "application/octet-stream" };
	}

	async activeEntry(retained: RetainedSnapshotRoot, path: string): Promise<ActiveFileManifestEntry | null> {
		if (safeMarkdownPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		return this.lookup("active", root.activeFilesTreeHash, path);
	}

	async activeFile(retained: RetainedSnapshotRoot, path: string): Promise<{ entry: ActiveFileManifestEntry; bytes: Uint8Array }> {
		if (safeMarkdownPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		const entry = await this.lookup("active", root.activeFilesTreeHash, path);
		if (!entry) throw new RecoveryReadError("snapshot_entry_not_found", 404);
		if (entry.availability !== "available") throw new RecoveryReadError("snapshot_content_unavailable", 409);
		return { entry, bytes: await this.readMarkdown(entry.contentHash, entry.size) };
	}

	async deletedEntry(retained: RetainedSnapshotRoot, bodyId: string): Promise<DeletedFileManifestEntry | null> {
		if (!safeIdentity(bodyId)) throw new RecoveryReadError("invalid_body_id", 400);
		const root = await this.readRoot(retained);
		return this.lookup("deleted", root.deletedFilesTreeHash, bodyId);
	}

	async deletedFile(retained: RetainedSnapshotRoot, bodyId: string): Promise<{ entry: DeletedFileManifestEntry; bytes: Uint8Array }> {
		if (!safeIdentity(bodyId)) throw new RecoveryReadError("invalid_body_id", 400);
		const root = await this.readRoot(retained);
		const entry = await this.lookup("deleted", root.deletedFilesTreeHash, bodyId);
		if (!entry) throw new RecoveryReadError("deleted_entry_not_found", 404);
		if (entry.availability !== "available") throw new RecoveryReadError("snapshot_content_unavailable", 409);
		return { entry, bytes: await this.readMarkdown(entry.baselineContentHash, entry.baselineSize) };
	}

	private async readRoot(retained: RetainedSnapshotRoot): Promise<SnapshotRootV2> {
		if (!safeIdentity(retained.snapshotId) || retained.vaultGeneration !== this.vaultGeneration
			|| !/^[a-f0-9]{64}$/.test(retained.rootHash)
			|| retained.rootKey !== snapshotRootObjectKey(this.prefix, retained.rootHash)) {
			throw new RecoveryReadError("invalid_snapshot_authority", 503);
		}
		const bytes = await this.readR2(retained.rootKey, MAX_ROOT_BYTES);
		if (await sha256Hex(bytes) !== retained.rootHash) throw new RecoveryReadError("corrupt_snapshot_root", 503);
		let unverified: unknown;
		try { unverified = parseCanonicalJson(bytes); }
		catch { throw new RecoveryReadError("corrupt_snapshot_root", 503); }
		if (!unverified || typeof unverified !== "object" || Array.isArray(unverified)
			|| !("format" in unverified) || unverified.format !== "yaos-recovery-v2"
			|| !("snapshotFormatVersion" in unverified) || unverified.snapshotFormatVersion !== 2) {
			throw new RecoveryReadError("unsupported_snapshot_format", 409);
		}
		let root: SnapshotRootV2;
		try { root = await parseAndVerifySnapshotRoot(bytes, retained.rootHash); }
		catch { throw new RecoveryReadError("corrupt_snapshot_root", 503); }
		if (root.snapshotId !== retained.snapshotId
			|| root.vaultIdHash !== await sha256Hex(encoder.encode(this.vaultId))
			|| root.vaultGenerationHash !== await sha256Hex(encoder.encode(this.vaultGeneration))) {
			throw new RecoveryReadError("snapshot_authority_mismatch", 503);
		}
		return root;
	}

	private nodeSource(): ManifestNodeSource {
		return {
			readNode: async (hash) => {
				try { return await this.readR2(manifestNodeObjectKey(this.prefix, hash), MANIFEST_MAX_COMPRESSED_BYTES); }
				catch (error) {
					if (error instanceof RecoveryReadError && error.code === "recovery_object_missing") return null;
					throw error;
				}
			},
		};
	}

	private async lookup<K extends ManifestTreeKind>(
		tree: K,
		rootHash: string,
		key: string,
	): Promise<ManifestEntryByTree[K] | null> {
		try {
			const result = await lookupManifestEntry(this.nodeSource(), tree, rootHash, key);
			return result.entry;
		} catch (error) {
			if (error instanceof RecoveryReadError) throw error;
			throw new RecoveryReadError("recovery_manifest_unavailable", 503);
		}
	}

	private async readMarkdown(hash: string, expectedSize: number): Promise<Uint8Array> {
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_MARKDOWN_BYTES) throw new RecoveryReadError("snapshot_content_too_large", 413);
		const compressed = await this.readR2(recoveryContentObjectKey(this.prefix, hash), MAX_CONTENT_COMPRESSED_BYTES);
		let bytes: Uint8Array;
		try { bytes = gunzipRecoveryBytes(compressed, MAX_CONTENT_COMPRESSED_BYTES, Math.max(1, expectedSize)); }
		catch { throw new RecoveryReadError("snapshot_content_corrupt", 503); }
		if (bytes.byteLength !== expectedSize || await sha256Hex(bytes) !== hash) throw new RecoveryReadError("snapshot_content_hash_mismatch", 503);
		try { decoder.decode(bytes); } catch { throw new RecoveryReadError("snapshot_content_invalid_utf8", 503); }
		return bytes;
	}
	private async readAttachment(hash: string, expectedSize: number): Promise<Uint8Array> {
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_BLOB_UPLOAD_BYTES) {
			throw new RecoveryReadError("snapshot_content_too_large", 413);
		}
		const bytes = await this.readR2(
			blobObjectKey(this.vaultId, this.vaultGeneration, hash),
			MAX_BLOB_UPLOAD_BYTES,
		);
		if (bytes.byteLength !== expectedSize || await sha256Hex(bytes) !== hash) throw new RecoveryReadError("snapshot_content_hash_mismatch", 503);
		return bytes;
	}


	private async readR2(key: string, maximumBytes: number): Promise<Uint8Array> {
		const object = await this.bucket.get(key);
		if (!object) throw new RecoveryReadError("recovery_object_missing", 503);
		if (object.size > maximumBytes) throw new RecoveryReadError("recovery_object_too_large", 503);
		const bytes = new Uint8Array(await object.arrayBuffer());
		if (bytes.byteLength > maximumBytes) throw new RecoveryReadError("recovery_object_too_large", 503);
		return bytes;
	}
}

export const RECOVERY_READ_LIMITS = Object.freeze({
	maximumTreeDepth: MANIFEST_MAX_DEPTH,
	maximumNodeBytesPerRequest: MANIFEST_LOOKUP_MAX_BYTES,
	maximumContentBytesPerRequest: Math.max(MAX_MARKDOWN_BYTES, MAX_BLOB_UPLOAD_BYTES),
	maximumR2ReadsPerRequest: MANIFEST_LOOKUP_MAX_READS + 2,
});
