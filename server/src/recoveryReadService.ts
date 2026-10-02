import { MAX_BLOB_UPLOAD_BYTES } from "./contracts";
import { parseCanonicalJson } from "./recoveryCanonicalJson";
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
	RECOVERY_SNAPSHOT_FORMAT_VERSION,
} from "./recoveryManifestTree";
import { sha256Hex } from "./hex";
import { safeBlobPath, safeCanvasPath, safeMarkdownPath } from "./shared/vaultPath";
import { blobObjectKey, recoveryPrefix } from "./recoveryProtocol";
import type { ObjectStorePort } from "./platformPorts";
import { MAX_CLIENT_MARKDOWN_BYTES } from "./shared/durableLimits.js";
import { CANVAS_LIMITS } from "./shared/canvasLimits";
import { MAX_RECOVERY_STATE_OBJECT_BYTES, RECOVERY_STATE_CONTENT_TYPE } from "./shared/recoveryStateObject";

const MAX_ROOT_BYTES = 1024 * 1024;
const MAX_MARKDOWN_BYTES = MAX_CLIENT_MARKDOWN_BYTES;
// Gzip can be slightly larger than incompressible input. Keep recovery reads
// above the 5 MiB logical Markdown ceiling without making this unbounded.
const encoder = new TextEncoder();

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

/** Authenticated, state-free graph reader. Every object key is derived from a retained root or verified entry. */
export class RecoveryReadService {
	private readonly prefix: string;

	constructor(
		private readonly bucket: ObjectStorePort,
		private readonly vaultId: string,
		private readonly vaultGeneration: string,
	) {
		this.prefix = recoveryPrefix(vaultId, vaultGeneration);
	}

	async root(retained: RetainedSnapshotRoot): Promise<SnapshotRootV2> {
		return this.readRoot(retained);
	}
	async entry(retained: RetainedSnapshotRoot, path: string): Promise<ActiveFileManifestEntry | AttachmentManifestEntry | null> {
		if (safeMarkdownPath(path) === path || safeCanvasPath(path) === path) return this.activeEntry(retained, path);
		if (safeBlobPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		return this.lookup("attachments", root.attachmentsTreeHash, path);
	}

	async file(retained: RetainedSnapshotRoot, path: string): Promise<{
		entry: ActiveFileManifestEntry | AttachmentManifestEntry;
		bytes: Uint8Array;
		hash: string;
		contentType: string;
		/** Plaintext size the client must verify (differs from `bytes` for state objects). */
		size: number;
	}> {
		if (safeMarkdownPath(path) === path || safeCanvasPath(path) === path) {
			const result = await this.activeFile(retained, path);
			return {
				...result,
				hash: result.entry.availability === "available" ? result.entry.contentHash : "",
				contentType: RECOVERY_STATE_CONTENT_TYPE,
				size: result.entry.availability === "available" ? result.entry.size : 0,
			};
		}
		if (safeBlobPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		const entry = await this.lookup("attachments", root.attachmentsTreeHash, path);
		if (!entry) throw new RecoveryReadError("snapshot_entry_not_found", 404);
		if (entry.availability !== "available") throw new RecoveryReadError("snapshot_content_unavailable", 409);
		const bytes = await this.readAttachment(entry.hash, entry.size);
		return { entry, bytes, hash: entry.hash, contentType: entry.mime ?? "application/octet-stream", size: bytes.byteLength };
	}

	async activeEntry(retained: RetainedSnapshotRoot, path: string): Promise<ActiveFileManifestEntry | null> {
		if (safeMarkdownPath(path) !== path && safeCanvasPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		return this.lookup("active", root.activeFilesTreeHash, path);
	}

	async activeFile(retained: RetainedSnapshotRoot, path: string): Promise<{ entry: ActiveFileManifestEntry; bytes: Uint8Array }> {
		if (safeMarkdownPath(path) !== path && safeCanvasPath(path) !== path) throw new RecoveryReadError("invalid_path", 400);
		const root = await this.readRoot(retained);
		const entry = await this.lookup("active", root.activeFilesTreeHash, path);
		if (!entry) throw new RecoveryReadError("snapshot_entry_not_found", 404);
		if (entry.availability !== "available") throw new RecoveryReadError("snapshot_content_unavailable", 409);
		return { entry, bytes: await this.readState(entry.contentHash, entry.size,
			"kind" in entry && entry.kind === "canvas" ? CANVAS_LIMITS.canonicalBytes : MAX_MARKDOWN_BYTES) };
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
		return { entry, bytes: await this.readState(entry.baselineContentHash, entry.baselineSize, MAX_MARKDOWN_BYTES) };
	}

	private async readRoot(retained: RetainedSnapshotRoot): Promise<SnapshotRootV2> {
		if (!safeIdentity(retained.snapshotId) || retained.vaultGeneration !== this.vaultGeneration
			|| !/^[a-f0-9]{64}$/.test(retained.rootHash)
			|| retained.rootKey !== snapshotRootObjectKey(this.prefix, retained.rootHash)) {
			throw new RecoveryReadError("invalid_snapshot_authority", 503);
		}
		const bytes = await this.readObject(retained.rootKey, MAX_ROOT_BYTES);
		if (await sha256Hex(bytes) !== retained.rootHash) throw new RecoveryReadError("corrupt_snapshot_root", 503);
		let unverified: unknown;
		try { unverified = parseCanonicalJson(bytes); }
		catch { throw new RecoveryReadError("corrupt_snapshot_root", 503); }
		if (!unverified || typeof unverified !== "object" || Array.isArray(unverified)
			|| !("format" in unverified) || unverified.format !== "yaos-recovery-v2"
			|| !("snapshotFormatVersion" in unverified) || unverified.snapshotFormatVersion !== RECOVERY_SNAPSHOT_FORMAT_VERSION) {
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
				try { return await this.readObject(manifestNodeObjectKey(this.prefix, hash), MANIFEST_MAX_COMPRESSED_BYTES); }
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

	/**
	 * Format 4: Markdown and Canvas content is an opaque state object (stored CRDT
	 * bytes). The server bounds the declared size and the object size only; the
	 * client decodes it and verifies the size and sha256 headers.
	 */
	private async readState(hash: string, expectedSize: number, maximumPlainBytes: number): Promise<Uint8Array> {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new RecoveryReadError("snapshot_content_corrupt", 503);
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maximumPlainBytes) throw new RecoveryReadError("snapshot_content_too_large", 413);
		return this.readObject(recoveryContentObjectKey(this.prefix, hash), MAX_RECOVERY_STATE_OBJECT_BYTES);
	}
	private async readAttachment(hash: string, expectedSize: number): Promise<Uint8Array> {
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_BLOB_UPLOAD_BYTES) {
			throw new RecoveryReadError("snapshot_content_too_large", 413);
		}
		const bytes = await this.readObject(
			blobObjectKey(this.vaultId, this.vaultGeneration, hash),
			MAX_BLOB_UPLOAD_BYTES,
		);
		if (bytes.byteLength !== expectedSize || await sha256Hex(bytes) !== hash) throw new RecoveryReadError("snapshot_content_hash_mismatch", 503);
		return bytes;
	}


	private async readObject(key: string, maximumBytes: number): Promise<Uint8Array> {
		const object = await this.bucket.get(key);
		if (!object) throw new RecoveryReadError("recovery_object_missing", 503);
		if (object.size > maximumBytes) throw new RecoveryReadError("recovery_object_too_large", 503);
		const bytes = object.bytes;
		if (bytes.byteLength > maximumBytes) throw new RecoveryReadError("recovery_object_too_large", 503);
		return bytes;
	}
}

export const RECOVERY_READ_LIMITS = Object.freeze({
	maximumTreeDepth: MANIFEST_MAX_DEPTH,
	maximumNodeBytesPerRequest: MANIFEST_LOOKUP_MAX_BYTES,
	maximumContentBytesPerRequest: Math.max(MAX_MARKDOWN_BYTES, CANVAS_LIMITS.canonicalBytes, MAX_BLOB_UPLOAD_BYTES),
	maximumR2ReadsPerRequest: MANIFEST_LOOKUP_MAX_READS + 2,
});
