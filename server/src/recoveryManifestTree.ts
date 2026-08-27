import type { ImmutableArtifactStore } from "./bootstrap.js";
import { MAX_BLOB_UPLOAD_BYTES } from "./contracts.js";
import { sha256Hex } from "./hex.js";
import {
	MAX_RECOVERY_NODE_BYTES,
	canonicalJsonBytes,
	canonicalJsonHash,
	decodeHashedRecoveryObject,
	encodeHashedRecoveryObject,
	parseCanonicalJson,
	type EncodedRecoveryObject,
} from "./recoveryCanonicalJson.js";
import { safeBlobPath, safeMarkdownPath } from "./shared/vaultPath.js";
import { MAX_CLIENT_MARKDOWN_BYTES } from "./shared/durableLimits.js";

export const RECOVERY_SNAPSHOT_FORMAT = "yaos-recovery-v2" as const;
export const RECOVERY_SNAPSHOT_FORMAT_VERSION = 2 as const;
export const MANIFEST_BRANCH_FORMAT = "yaos-manifest-branch-v1" as const;
export const MANIFEST_LEAF_FORMAT = "yaos-manifest-leaf-v1" as const;
export const MANIFEST_MAX_ENTRIES = 512;
export const MANIFEST_MAX_CANONICAL_BYTES = 1024 * 1024;
export const MANIFEST_MAX_COMPRESSED_BYTES = 512 * 1024;
export const MANIFEST_MAX_ENTRY_BYTES = 64 * 1024;
export const MANIFEST_MAX_DEPTH = 32;
export const MANIFEST_LOOKUP_MAX_BYTES = 4 * 1024 * 1024;
export const MANIFEST_LOOKUP_MAX_READS = MANIFEST_MAX_DEPTH + 1;
export const MANIFEST_MUTATION_CHUNK_ENTRIES = 100;

const encoder = new TextEncoder();
const MAX_MARKDOWN_BYTES = MAX_CLIENT_MARKDOWN_BYTES;
const MAX_ID_BYTES = 1024;
const MAX_REFERENCE_BYTES = 4096;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CHILD_PREFIX_PATTERN = /^[a-f0-9]{2}$/;

export type RecoverySnapshotReason = "initial" | "daily" | "manual" | "pre-bulk-operation";
export type RecoverySnapshotHealth = "complete" | "complete_with_gaps";
export type ManifestTreeKind = "active" | "deleted" | "attachments";
export type ManifestNodeFormat = typeof MANIFEST_BRANCH_FORMAT | typeof MANIFEST_LEAF_FORMAT;

export type ActiveFileManifestEntry =
	| {
		availability: "available";
		path: string;
		fileId: string;
		bodyId: string;
		bodyGeneration: number;
		contentHash: string;
		size: number;
	}
	| {
		availability: "unavailable";
		path: string;
		fileId: string;
		bodyId: string;
		bodyGeneration: number;
		errorCode: "corrupt_history" | "hash_mismatch" | "missing_history";
		errorReference: string;
	};

export type DeletedFileManifestEntry =
	| {
		availability: "available";
		bodyId: string;
		fileId: string;
		lastPath: string;
		deletedAtSequence: number;
		baselineContentHash: string;
		baselineSize: number;
		bodyReaped: boolean;
	}
	| {
		availability: "unavailable";
		bodyId: string;
		fileId: string;
		lastPath: string;
		deletedAtSequence: number;
		errorCode: "corrupt_history" | "missing_history" | "missing_content";
		errorReference: string;
		bodyReaped: boolean;
	};

export type AttachmentManifestEntry =
	| {
		availability: "available";
		path: string;
		hash: string;
		size: number;
		mime: string | null;
	}
	| {
		availability: "unavailable";
		path: string;
		expectedHash: string;
		expectedSize: number;
		mime: string | null;
		errorCode: "missing_blob" | "corrupt_blob";
		errorReference: string;
	};

export interface ManifestEntryByTree {
	active: ActiveFileManifestEntry;
	deleted: DeletedFileManifestEntry;
	attachments: AttachmentManifestEntry;
}

export type RecoveryManifestEntry = ManifestEntryByTree[ManifestTreeKind];

export interface SnapshotRootV2 {
	format: typeof RECOVERY_SNAPSHOT_FORMAT;
	snapshotFormatVersion: typeof RECOVERY_SNAPSHOT_FORMAT_VERSION;
	snapshotId: string;
	vaultIdHash: string;
	vaultGenerationHash: string;
	runtimeEpoch: string;
	boundarySequence: number;
	rootGeneration: number;
	sourcePlanDigest: string;
	manifestGraphDigest: string;
	manifestNodeCount: number;
	createdAt: string;
	completedAt: string;
	health: RecoverySnapshotHealth;
	reason: RecoverySnapshotReason;
	activeFilesTreeHash: string;
	deletedFilesTreeHash: string;
	attachmentsTreeHash: string;
	totals: {
		activeFiles: number;
		deletedFiles: number;
		unavailableFiles: number;
		attachments: number;
		markdownBytes: number;
		attachmentBytes: number;
	};
	previousSnapshotId: string | null;
}

export interface ManifestChildReference {
	nodes: number;
	hash: string;
	entries: number;
}

export interface ManifestBranchNode {
	format: typeof MANIFEST_BRANCH_FORMAT;
	depth: number;
	children: Record<string, ManifestChildReference>;
}

export interface ManifestLeafNode<T extends RecoveryManifestEntry = RecoveryManifestEntry> {
	format: typeof MANIFEST_LEAF_FORMAT;
	depth: number;
	entries: T[];
}

export type ManifestNode<T extends RecoveryManifestEntry = RecoveryManifestEntry> =
	| ManifestBranchNode
	| ManifestLeafNode<T>;

export interface EncodedManifestNode<T extends RecoveryManifestEntry = RecoveryManifestEntry>
	extends EncodedRecoveryObject<ManifestNode<T>> {
	readonly objectKey: string;
	readonly format: ManifestNodeFormat;
	readonly subtreeEntries: number;
	readonly subtreeNodes: number;
}

export interface ManifestNodeSource {
	readNode(hash: string): Promise<Uint8Array | null>;
}

export interface ManifestNodeStore extends ManifestNodeSource {
	writeNode(node: EncodedManifestNode): Promise<"written" | "reused">;
}

export interface ManifestTreeMutation<T extends RecoveryManifestEntry> {
	readonly type: "upsert" | "delete";
	readonly entry?: T;
	readonly key?: string;
}

export interface ManifestTreeCheckpoint {
	readonly rootHash: string;
	readonly entries: number;
	readonly nodes: number;
	readonly writtenHashes: readonly string[];
	readonly reusedHashes: readonly string[];
}

export interface ManifestTreeResult extends ManifestTreeCheckpoint {
	readonly reachable: readonly ReachableManifestNode[];
}

export interface ManifestLookupResult<T extends RecoveryManifestEntry> {
	readonly entry: T | null;
	readonly nodeReads: number;
	readonly compressedBytes: number;
}

export interface ReachableManifestNode {
	readonly tree: ManifestTreeKind;
	readonly logicalPrefix: string;
	readonly nodeHash: string;
	readonly nodeFormat: ManifestNodeFormat;
	readonly subtreeEntries: number;
	readonly subtreeNodes: number;
}

export interface EncodedSnapshotRoot {
	readonly value: SnapshotRootV2;
	readonly canonicalBytes: Uint8Array;
	readonly hash: string;
	readonly objectKey: string;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return Object.fromEntries(Object.entries(value));
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(record).sort();
	const sortedExpected = [...expected].sort();
	if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
		throw new Error(`${label} contains unexpected fields`);
	}
}

function assertSafeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
		throw new Error(`invalid ${label}`);
	}
}

function isWellFormedUnicode(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code >= 0xd800 && code <= 0xdfff) return false;
	}
	return true;
}

function assertString(value: unknown, label: string, maxBytes = MAX_ID_BYTES): asserts value is string {
	if (
		typeof value !== "string"
		|| value.length === 0
		|| !isWellFormedUnicode(value)
		|| encoder.encode(value).byteLength > maxBytes
	) {
		throw new Error(`invalid ${label}`);
	}
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) throw new Error(`invalid ${label}`);
	}
}

function assertHash(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`invalid ${label}`);
}

function assertMarkdownPath(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !isWellFormedUnicode(value) || safeMarkdownPath(value) !== value) throw new Error(`invalid ${label}`);
}

function assertAttachmentPath(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !isWellFormedUnicode(value) || safeBlobPath(value) !== value) throw new Error(`invalid ${label}`);
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function assertMime(value: unknown): asserts value is string | null {
	if (value !== null && (typeof value !== "string" || !isWellFormedUnicode(value) || encoder.encode(value).byteLength > 1024 || hasControlCharacter(value))) {
		throw new Error("invalid attachment MIME type");
	}
}

function validateActiveEntry(value: unknown): ActiveFileManifestEntry {
	const entry = asRecord(value, "active manifest entry");
	assertMarkdownPath(entry.path, "active path");
	assertString(entry.fileId, "active file ID");
	assertString(entry.bodyId, "active body ID");
	assertSafeInteger(entry.bodyGeneration, "active body generation");
	if (entry.availability === "available") {
		assertExactKeys(entry, ["availability", "path", "fileId", "bodyId", "bodyGeneration", "contentHash", "size"], "active manifest entry");
		assertHash(entry.contentHash, "active content hash");
		assertSafeInteger(entry.size, "active content size", MAX_MARKDOWN_BYTES);
		return {
			availability: "available",
			path: entry.path,
			fileId: entry.fileId,
			bodyId: entry.bodyId,
			bodyGeneration: entry.bodyGeneration,
			contentHash: entry.contentHash,
			size: entry.size,
		};
	}
	if (entry.availability === "unavailable") {
		assertExactKeys(entry, ["availability", "path", "fileId", "bodyId", "bodyGeneration", "errorCode", "errorReference"], "active manifest entry");
		if (entry.errorCode !== "corrupt_history" && entry.errorCode !== "hash_mismatch" && entry.errorCode !== "missing_history") {
			throw new Error("invalid active unavailability code");
		}
		assertString(entry.errorReference, "active error reference", MAX_REFERENCE_BYTES);
		return {
			availability: "unavailable",
			path: entry.path,
			fileId: entry.fileId,
			bodyId: entry.bodyId,
			bodyGeneration: entry.bodyGeneration,
			errorCode: entry.errorCode,
			errorReference: entry.errorReference,
		};
	}
	throw new Error("invalid active availability");
}

function validateDeletedEntry(value: unknown): DeletedFileManifestEntry {
	const entry = asRecord(value, "deleted manifest entry");
	assertString(entry.bodyId, "deleted body ID");
	assertString(entry.fileId, "deleted file ID");
	assertMarkdownPath(entry.lastPath, "deleted last path");
	assertSafeInteger(entry.deletedAtSequence, "deleted sequence");
	if (typeof entry.bodyReaped !== "boolean") throw new Error("invalid deleted reap state");
	if (entry.availability === "available") {
		assertExactKeys(entry, ["availability", "bodyId", "fileId", "lastPath", "deletedAtSequence", "baselineContentHash", "baselineSize", "bodyReaped"], "deleted manifest entry");
		assertHash(entry.baselineContentHash, "deleted baseline hash");
		assertSafeInteger(entry.baselineSize, "deleted baseline size", MAX_MARKDOWN_BYTES);
		return {
			availability: "available",
			bodyId: entry.bodyId,
			fileId: entry.fileId,
			lastPath: entry.lastPath,
			deletedAtSequence: entry.deletedAtSequence,
			baselineContentHash: entry.baselineContentHash,
			baselineSize: entry.baselineSize,
			bodyReaped: entry.bodyReaped,
		};
	}
	if (entry.availability === "unavailable") {
		assertExactKeys(entry, ["availability", "bodyId", "fileId", "lastPath", "deletedAtSequence", "errorCode", "errorReference", "bodyReaped"], "deleted manifest entry");
		if (entry.errorCode !== "corrupt_history" && entry.errorCode !== "missing_history" && entry.errorCode !== "missing_content") {
			throw new Error("invalid deleted unavailability code");
		}
		assertString(entry.errorReference, "deleted error reference", MAX_REFERENCE_BYTES);
		return {
			availability: "unavailable",
			bodyId: entry.bodyId,
			fileId: entry.fileId,
			lastPath: entry.lastPath,
			deletedAtSequence: entry.deletedAtSequence,
			errorCode: entry.errorCode,
			errorReference: entry.errorReference,
			bodyReaped: entry.bodyReaped,
		};
	}
	throw new Error("invalid deleted availability");
}

function validateAttachmentEntry(value: unknown): AttachmentManifestEntry {
	const entry = asRecord(value, "attachment manifest entry");
	assertAttachmentPath(entry.path, "attachment path");
	assertMime(entry.mime);
	if (entry.availability === "available") {
		assertExactKeys(entry, ["availability", "path", "hash", "size", "mime"], "attachment manifest entry");
		assertHash(entry.hash, "attachment hash");
		assertSafeInteger(entry.size, "attachment size", MAX_BLOB_UPLOAD_BYTES);
		return { availability: "available", path: entry.path, hash: entry.hash, size: entry.size, mime: entry.mime };
	}
	if (entry.availability === "unavailable") {
		assertExactKeys(entry, ["availability", "path", "expectedHash", "expectedSize", "mime", "errorCode", "errorReference"], "attachment manifest entry");
		assertHash(entry.expectedHash, "expected attachment hash");
		assertSafeInteger(entry.expectedSize, "expected attachment size", MAX_BLOB_UPLOAD_BYTES);
		if (entry.errorCode !== "missing_blob" && entry.errorCode !== "corrupt_blob") throw new Error("invalid attachment unavailability code");
		assertString(entry.errorReference, "attachment error reference", MAX_REFERENCE_BYTES);
		return {
			availability: "unavailable",
			path: entry.path,
			expectedHash: entry.expectedHash,
			expectedSize: entry.expectedSize,
			mime: entry.mime,
			errorCode: entry.errorCode,
			errorReference: entry.errorReference,
		};
	}
	throw new Error("invalid attachment availability");
}

export function validateManifestEntry<K extends ManifestTreeKind>(tree: K, value: unknown): ManifestEntryByTree[K] {
	if (tree === "active") return validateActiveEntry(value) as ManifestEntryByTree[K];
	if (tree === "deleted") return validateDeletedEntry(value) as ManifestEntryByTree[K];
	return validateAttachmentEntry(value) as ManifestEntryByTree[K];
}

function manifestEntryKeyUnchecked(tree: ManifestTreeKind, entry: RecoveryManifestEntry): string {
	if (tree === "deleted") return (entry as DeletedFileManifestEntry).bodyId;
	return (entry as ActiveFileManifestEntry | AttachmentManifestEntry).path;
}

export function manifestEntryKey<K extends ManifestTreeKind>(tree: K, entry: ManifestEntryByTree[K]): string {
	return manifestEntryKeyUnchecked(tree, entry);
}

function manifestEntryIdentity(tree: ManifestTreeKind, entry: RecoveryManifestEntry): string {
	if (tree === "active") {
		const active = entry as ActiveFileManifestEntry;
		return `${active.fileId}\u0000${active.bodyId}`;
	}
	if (tree === "deleted") {
		const deleted = entry as DeletedFileManifestEntry;
		return `${deleted.fileId}\u0000${deleted.lastPath}`;
	}
	return (entry as AttachmentManifestEntry).path;
}
function compareCanonicalStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
function compareEntries(tree: ManifestTreeKind, left: RecoveryManifestEntry, right: RecoveryManifestEntry): number {


	const keyComparison = compareCanonicalStrings(manifestEntryKeyUnchecked(tree, left), manifestEntryKeyUnchecked(tree, right));
	if (keyComparison !== 0) return keyComparison;
	return compareCanonicalStrings(manifestEntryIdentity(tree, left), manifestEntryIdentity(tree, right));
}

function assertEntryCanonicalBound(entry: RecoveryManifestEntry): void {
	if (canonicalJsonBytes(entry).byteLength >= MANIFEST_MAX_ENTRY_BYTES) throw new Error("manifest entry exceeds hard canonical byte bound");
}

function validateLeafEntries(tree: ManifestTreeKind, entries: unknown[]): RecoveryManifestEntry[] {
	const validated = entries.map((entry) => {
		const result = validateManifestEntry(tree, entry);
		assertEntryCanonicalBound(result);
		return result;
	});
	for (let index = 1; index < validated.length; index++) {
		const previous = validated[index - 1]!;
		const current = validated[index]!;
		if (compareEntries(tree, previous, current) >= 0 || manifestEntryKeyUnchecked(tree, previous) === manifestEntryKeyUnchecked(tree, current)) {
			throw new Error("manifest leaf entries are not in canonical unique order");
		}
	}
	return validated;
}

function validateChildReference(value: unknown): ManifestChildReference {
	const child = asRecord(value, "manifest child reference");
	assertExactKeys(child, ["nodes", "hash", "entries"], "manifest child reference");
	assertSafeInteger(child.nodes, "manifest child node count");
	assertSafeInteger(child.entries, "manifest child entry count");
	if (child.nodes < 1 || child.entries < 1) throw new Error("manifest child reference cannot be empty");
	assertHash(child.hash, "manifest child hash");
	return { nodes: child.nodes, hash: child.hash, entries: child.entries };
}

export function validateManifestNode<K extends ManifestTreeKind>(tree: K, value: unknown): ManifestNode<ManifestEntryByTree[K]> {
	const node = asRecord(value, "manifest node");
	if (node.format === MANIFEST_LEAF_FORMAT) {
		assertExactKeys(node, ["format", "depth", "entries"], "manifest leaf");
		assertSafeInteger(node.depth, "manifest leaf depth", MANIFEST_MAX_DEPTH);
		if (!Array.isArray(node.entries)) throw new Error("manifest leaf entries must be an array");
		const entries = validateLeafEntries(tree, node.entries) as ManifestEntryByTree[K][];
		return { format: MANIFEST_LEAF_FORMAT, depth: node.depth, entries };
	}
	if (node.format === MANIFEST_BRANCH_FORMAT) {
		assertExactKeys(node, ["format", "depth", "children"], "manifest branch");
		assertSafeInteger(node.depth, "manifest branch depth", MANIFEST_MAX_DEPTH - 1);
		const childrenRecord = asRecord(node.children, "manifest branch children");
		const prefixes = Object.keys(childrenRecord);
		if (prefixes.length === 0 || prefixes.length > 256 || prefixes.some((prefix) => !CHILD_PREFIX_PATTERN.test(prefix))) {
			throw new Error("invalid manifest branch prefixes");
		}
		const children: Record<string, ManifestChildReference> = {};
		for (const prefix of prefixes.sort()) children[prefix] = validateChildReference(childrenRecord[prefix]);
		return { format: MANIFEST_BRANCH_FORMAT, depth: node.depth, children };
	}
	throw new Error("unsupported manifest node format");
}

function subtreeCounts(node: ManifestNode): { entries: number; nodes: number } {
	if (node.format === MANIFEST_LEAF_FORMAT) return { entries: node.entries.length, nodes: 1 };
	let entries = 0;
	let nodes = 1;
	for (const child of Object.values(node.children)) {
		entries += child.entries;
		nodes += child.nodes;
		if (!Number.isSafeInteger(entries) || !Number.isSafeInteger(nodes)) throw new Error("manifest subtree count overflow");
	}
	return { entries, nodes };
}

export function recoveryV2Prefix(vaultPrefix: string): string {
	return `${vaultPrefix.replace(/\/+$/, "")}/recovery-v2`;
}

export function manifestNodeObjectKey(prefix: string, hash: string): string {
	assertHash(hash, "manifest object hash");
	return `${prefix.replace(/\/+$/, "")}/manifest/sha256/${hash.slice(0, 2)}/${hash}.json.gz`;
}

export function recoveryContentObjectKey(prefix: string, hash: string): string {
	assertHash(hash, "content object hash");
	return `${prefix.replace(/\/+$/, "")}/content/sha256/${hash.slice(0, 2)}/${hash}.md.gz`;
}

export function snapshotRootObjectKey(prefix: string, hash: string): string {
	assertHash(hash, "snapshot root hash");
	return `${prefix.replace(/\/+$/, "")}/roots/sha256/${hash.slice(0, 2)}/${hash}.json`;
}

export function recoveryStagingPrefix(prefix: string, jobId: string): string {
	assertString(jobId, "recovery job ID", 256);
	return `${prefix.replace(/\/+$/, "")}/staging/${encodeURIComponent(jobId)}`;
}

export async function encodeManifestNode<T extends RecoveryManifestEntry>(
	prefix: string,
	node: ManifestNode<T>,
): Promise<EncodedManifestNode<T>> {
	const encoded = await encodeHashedRecoveryObject(node);
	const counts = subtreeCounts(node);
	return {
		...encoded,
		objectKey: manifestNodeObjectKey(prefix, encoded.hash),
		format: node.format,
		subtreeEntries: counts.entries,
		subtreeNodes: counts.nodes,
	};
}

export async function decodeAndVerifyManifestNode<K extends ManifestTreeKind>(
	tree: K,
	compressed: Uint8Array,
	expectedHash: string,
): Promise<ManifestNode<ManifestEntryByTree[K]>> {
	const value = await decodeHashedRecoveryObject(compressed, expectedHash);
	const node = validateManifestNode(tree, value);
	if (node.format === MANIFEST_LEAF_FORMAT && node.entries.length > 1) {
		const canonicalBytes = canonicalJsonBytes(node).byteLength;
		if (
			node.entries.length > MANIFEST_MAX_ENTRIES
			|| canonicalBytes > MANIFEST_MAX_CANONICAL_BYTES
			|| compressed.byteLength > MANIFEST_MAX_COMPRESSED_BYTES
		) {
			throw new Error("manifest leaf exceeds deterministic split bounds");
		}
	}
	return node;
}
export async function readAndVerifyManifestNode<K extends ManifestTreeKind>(
	source: ManifestNodeSource,
	tree: K,
	hash: string,
): Promise<{
	readonly node: ManifestNode<ManifestEntryByTree[K]>;
	readonly compressedBytes: number;
	readonly subtreeEntries: number;
	readonly subtreeNodes: number;
}> {
	const compressed = await source.readNode(hash);
	if (!compressed) throw new Error(`manifest node missing: ${hash}`);
	const node = await decodeAndVerifyManifestNode(tree, compressed, hash);
	const counts = subtreeCounts(node);
	return {
		node,
		compressedBytes: compressed.byteLength,
		subtreeEntries: counts.entries,
		subtreeNodes: counts.nodes,
	};
}


export class R2ManifestNodeStore implements ManifestNodeStore {
	constructor(
		private readonly artifacts: ImmutableArtifactStore,
		private readonly prefix: string,
	) {}

	async readNode(hash: string): Promise<Uint8Array | null> {
		return this.artifacts.get(manifestNodeObjectKey(this.prefix, hash));
	}

	async writeNode(node: EncodedManifestNode): Promise<"written" | "reused"> {
		const objectKey = manifestNodeObjectKey(this.prefix, node.hash);
		if (node.objectKey !== objectKey) throw new Error("manifest node object key is not deterministic");
		await decodeHashedRecoveryObject(node.compressedBytes, node.hash);
		const existing = await this.artifacts.get(objectKey);
		if (existing) {
			await decodeHashedRecoveryObject(existing, node.hash);
			return "reused";
		}
		await this.artifacts.put(objectKey, node.compressedBytes, "application/gzip");
		return "written";
	}
}

interface StoredNode<T extends RecoveryManifestEntry> {
	readonly node: ManifestNode<T>;
	readonly hash: string;
	readonly entries: number;
	readonly nodes: number;
}

class ManifestTreeSession<K extends ManifestTreeKind> {
	private readonly cache = new Map<string, ManifestNode<ManifestEntryByTree[K]>>();
	readonly written = new Set<string>();
	readonly reused = new Set<string>();

	constructor(
		private readonly store: ManifestNodeStore,
		readonly tree: K,
		private readonly prefix: string,
	) {}

	async read(hash: string, expectedDepth?: number): Promise<StoredNode<ManifestEntryByTree[K]>> {
		let node = this.cache.get(hash);
		if (!node) {
			const compressed = await this.store.readNode(hash);
			if (!compressed) throw new Error(`manifest node missing: ${hash}`);
			node = await decodeAndVerifyManifestNode(this.tree, compressed, hash);
			this.cache.set(hash, node);
		}
		if (expectedDepth !== undefined && node.depth !== expectedDepth) throw new Error("manifest node depth mismatch");
		const counts = subtreeCounts(node);
		return { node, hash, ...counts };
	}

	async write(node: ManifestNode<ManifestEntryByTree[K]>): Promise<StoredNode<ManifestEntryByTree[K]>> {
		const encoded = await encodeManifestNode(this.prefix, node);
		const disposition = await this.store.writeNode(encoded);
		this.cache.set(encoded.hash, node);
		(disposition === "written" ? this.written : this.reused).add(encoded.hash);
		return { node, hash: encoded.hash, entries: encoded.subtreeEntries, nodes: encoded.subtreeNodes };
	}
}

async function canonicalKeyDigest(key: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(key)));
}

function digestPrefix(digest: Uint8Array, depth: number): string {
	const byte = digest[depth];
	if (byte === undefined) throw new Error("manifest key digest collision exceeds maximum depth");
	return byte.toString(16).padStart(2, "0");
}

async function leafEncoding<K extends ManifestTreeKind>(
	entries: ManifestEntryByTree[K][],
	depth: number,
): Promise<{ node: ManifestLeafNode<ManifestEntryByTree[K]>; encoded: EncodedManifestNode<ManifestEntryByTree[K]>; fits: boolean }> {
	const node: ManifestLeafNode<ManifestEntryByTree[K]> = { format: MANIFEST_LEAF_FORMAT, depth, entries };
	const encoded = await encodeManifestNode("", node);
	return {
		node,
		encoded,
		fits: entries.length <= MANIFEST_MAX_ENTRIES
			&& encoded.canonicalBytes.byteLength <= MANIFEST_MAX_CANONICAL_BYTES
			&& encoded.compressedBytes.byteLength <= MANIFEST_MAX_COMPRESSED_BYTES,
	};
}

async function buildCanonicalSubtree<K extends ManifestTreeKind>(
	session: ManifestTreeSession<K>,
	entries: ManifestEntryByTree[K][],
	depth: number,
): Promise<StoredNode<ManifestEntryByTree[K]>> {
	entries.sort((left, right) => compareEntries(session.tree, left, right));
	const leaf = await leafEncoding(entries, depth);
	if (leaf.fits || entries.length <= 1) return session.write(leaf.node);
	if (depth >= MANIFEST_MAX_DEPTH) throw new Error("multiple manifest keys have an indistinguishable SHA-256 digest");
	const grouped = new Map<string, ManifestEntryByTree[K][]>();
	for (const entry of entries) {
		const key = manifestEntryKey(session.tree, entry);
		const prefix = digestPrefix(await canonicalKeyDigest(key), depth);
		const group = grouped.get(prefix);
		if (group) group.push(entry);
		else grouped.set(prefix, [entry]);
	}
	const children: Record<string, ManifestChildReference> = {};
	for (const prefix of [...grouped.keys()].sort()) {
		const child = await buildCanonicalSubtree(session, grouped.get(prefix)!, depth + 1);
		children[prefix] = { hash: child.hash, entries: child.entries, nodes: child.nodes };
	}
	return session.write({ format: MANIFEST_BRANCH_FORMAT, depth, children });
}

async function collectSubtreeEntries<K extends ManifestTreeKind>(
	session: ManifestTreeSession<K>,
	stored: StoredNode<ManifestEntryByTree[K]>,
	maximum: number,
): Promise<ManifestEntryByTree[K][] | null> {
	if (stored.entries > maximum) return null;
	if (stored.node.format === MANIFEST_LEAF_FORMAT) return [...stored.node.entries];
	const entries: ManifestEntryByTree[K][] = [];
	for (const prefix of Object.keys(stored.node.children).sort()) {
		const reference = stored.node.children[prefix]!;
		const child = await session.read(reference.hash, stored.node.depth + 1);
		if (child.entries !== reference.entries || child.nodes !== reference.nodes) throw new Error("manifest branch child counts do not match child");
		const childEntries = await collectSubtreeEntries(session, child, maximum - entries.length);
		if (!childEntries) return null;
		entries.push(...childEntries);
	}
	return entries;
}

async function maybeCollapseBranch<K extends ManifestTreeKind>(
	session: ManifestTreeSession<K>,
	branch: StoredNode<ManifestEntryByTree[K]>,
): Promise<StoredNode<ManifestEntryByTree[K]>> {
	if (branch.node.format !== MANIFEST_BRANCH_FORMAT) return branch;
	const entries = await collectSubtreeEntries(session, branch, MANIFEST_MAX_ENTRIES);
	if (!entries) return branch;
	entries.sort((left, right) => compareEntries(session.tree, left, right));
	const leaf = await leafEncoding(entries, branch.node.depth);
	return leaf.fits ? session.write(leaf.node) : branch;
}

function findEntryIndex(tree: ManifestTreeKind, entries: readonly RecoveryManifestEntry[], key: string): { index: number; found: boolean } {
	let low = 0;
	let high = entries.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const comparison = compareCanonicalStrings(manifestEntryKeyUnchecked(tree, entries[middle]!), key);
		if (comparison < 0) low = middle + 1;
		else high = middle;
	}
	return { index: low, found: low < entries.length && manifestEntryKeyUnchecked(tree, entries[low]!) === key };
}

async function mutateSubtree<K extends ManifestTreeKind>(
	session: ManifestTreeSession<K>,
	stored: StoredNode<ManifestEntryByTree[K]>,
	key: string,
	entry: ManifestEntryByTree[K] | null,
	digest: Uint8Array,
): Promise<StoredNode<ManifestEntryByTree[K]>> {
	if (stored.node.format === MANIFEST_LEAF_FORMAT) {
		const entries = [...stored.node.entries];
		const position = findEntryIndex(session.tree, entries, key);
		if (entry === null) {
			if (!position.found) return stored;
			entries.splice(position.index, 1);
		} else if (position.found) {
			const [currentHash, replacementHash] = await Promise.all([
				canonicalJsonHash(entries[position.index]),
				canonicalJsonHash(entry),
			]);
			if (currentHash === replacementHash) return stored;
			entries[position.index] = entry;
		} else {
			entries.splice(position.index, 0, entry);
		}
		return buildCanonicalSubtree(session, entries, stored.node.depth);
	}
	const branch = stored.node;
	const prefix = digestPrefix(digest, branch.depth);
	const reference = branch.children[prefix];
	if (!reference && entry === null) return stored;
	let updatedChild: StoredNode<ManifestEntryByTree[K]>;
	if (reference) {
		const child = await session.read(reference.hash, branch.depth + 1);
		if (child.entries !== reference.entries || child.nodes !== reference.nodes) throw new Error("manifest branch child counts do not match child");
		updatedChild = await mutateSubtree(session, child, key, entry, digest);
		if (updatedChild.hash === child.hash) return stored;
	} else {
		updatedChild = await buildCanonicalSubtree(session, [entry!], branch.depth + 1);
	}
	const children = { ...branch.children };
	if (updatedChild.entries === 0) delete children[prefix];
	else children[prefix] = { hash: updatedChild.hash, entries: updatedChild.entries, nodes: updatedChild.nodes };
	if (Object.keys(children).length === 0) {
		return session.write({ format: MANIFEST_LEAF_FORMAT, depth: branch.depth, entries: [] });
	}
	return maybeCollapseBranch(session, await session.write({ format: MANIFEST_BRANCH_FORMAT, depth: branch.depth, children }));
}

async function enumerateReachable<K extends ManifestTreeKind>(
	session: ManifestTreeSession<K>,
	root: StoredNode<ManifestEntryByTree[K]>,
): Promise<ReachableManifestNode[]> {
	const reachable: ReachableManifestNode[] = [];
	const visit = async (stored: StoredNode<ManifestEntryByTree[K]>, logicalPrefix: string): Promise<void> => {
		reachable.push({
			tree: session.tree,
			logicalPrefix,
			nodeHash: stored.hash,
			nodeFormat: stored.node.format,
			subtreeEntries: stored.entries,
			subtreeNodes: stored.nodes,
		});
		if (stored.node.format === MANIFEST_LEAF_FORMAT) return;
		let entries = 0;
		let nodes = 1;
		for (const prefix of Object.keys(stored.node.children).sort()) {
			const reference = stored.node.children[prefix]!;
			const child = await session.read(reference.hash, stored.node.depth + 1);
			if (child.entries !== reference.entries || child.nodes !== reference.nodes) throw new Error("manifest graph counts are corrupt");
			entries += child.entries;
			nodes += child.nodes;
			await visit(child, `${logicalPrefix}${prefix}`);
		}
		if (entries !== stored.entries || nodes !== stored.nodes) throw new Error("manifest graph aggregate counts are corrupt");
	};
	await visit(root, "");
	if (reachable.length !== root.nodes) throw new Error("manifest graph node count is corrupt");
	return reachable;
}

async function finishTreeResult<K extends ManifestTreeKind>(
	session: ManifestTreeSession<K>,
	root: StoredNode<ManifestEntryByTree[K]>,
): Promise<ManifestTreeResult> {
	return {
		rootHash: root.hash,
		entries: root.entries,
		nodes: root.nodes,
		reachable: await enumerateReachable(session, root),
		writtenHashes: [...session.written].sort(),
		reusedHashes: [...session.reused].sort(),
	};
}
function checkpointTreeResult<K extends ManifestTreeKind>(
	session: ManifestTreeSession<K>,
	root: StoredNode<ManifestEntryByTree[K]>,
): ManifestTreeCheckpoint {
	return {
		rootHash: root.hash,
		entries: root.entries,
		nodes: root.nodes,
		writtenHashes: [...session.written].sort(),
		reusedHashes: [...session.reused].sort(),
	};
}

export async function createEmptyManifestTree<K extends ManifestTreeKind>(
	store: ManifestNodeStore,
	prefix: string,
	tree: K,
): Promise<ManifestTreeCheckpoint> {
	const session = new ManifestTreeSession(store, tree, prefix);
	return checkpointTreeResult(session, await session.write({
		format: MANIFEST_LEAF_FORMAT,
		depth: 0,
		entries: [],
	}));
}

/**
 * Applies one actor-sized unit without enumerating the resulting graph. The
 * caller inventories reachable nodes separately over bounded alarm turns.
 */
export async function mutateManifestTreeChunk<K extends ManifestTreeKind>(
	store: ManifestNodeStore,
	prefix: string,
	tree: K,
	rootHash: string,
	mutations: readonly ManifestTreeMutation<ManifestEntryByTree[K]>[],
): Promise<ManifestTreeCheckpoint> {
	if (mutations.length > MANIFEST_MUTATION_CHUNK_ENTRIES) {
		throw new Error(`manifest mutation chunk exceeds ${MANIFEST_MUTATION_CHUNK_ENTRIES} entries`);
	}
	assertHash(rootHash, "manifest root hash");
	const session = new ManifestTreeSession(store, tree, prefix);
	let root = await session.read(rootHash, 0);
	for (const mutation of mutations) {
		let key: string;
		let entry: ManifestEntryByTree[K] | null;
		if (mutation.type === "upsert") {
			if (!mutation.entry || mutation.key !== undefined) throw new Error("invalid manifest upsert mutation");
			entry = validateManifestEntry(tree, mutation.entry);
			assertEntryCanonicalBound(entry);
			key = manifestEntryKey(tree, entry);
		} else if (mutation.type === "delete") {
			if (mutation.entry !== undefined || typeof mutation.key !== "string") throw new Error("invalid manifest delete mutation");
			entry = null;
			key = canonicalManifestLookupKey(tree, mutation.key);
		} else {
			throw new Error("unsupported manifest mutation");
		}
		root = await mutateSubtree(session, root, key, entry, await canonicalKeyDigest(key));
	}
	return checkpointTreeResult(session, root);
}


export async function rebuildManifestTree<K extends ManifestTreeKind>(
	store: ManifestNodeStore,
	prefix: string,
	tree: K,
	input: Iterable<ManifestEntryByTree[K]>,
): Promise<ManifestTreeResult> {
	const entries = [...input].map((entry) => validateManifestEntry(tree, entry));
	entries.sort((left, right) => compareEntries(tree, left, right));
	for (let index = 0; index < entries.length; index++) {
		assertEntryCanonicalBound(entries[index]!);
		if (index > 0 && manifestEntryKey(tree, entries[index - 1]!) === manifestEntryKey(tree, entries[index]!)) {
			throw new Error("duplicate manifest primary key");
		}
	}
	const session = new ManifestTreeSession(store, tree, prefix);
	return finishTreeResult(session, await buildCanonicalSubtree(session, entries, 0));
}

export async function createManifestTree<K extends ManifestTreeKind>(
	store: ManifestNodeStore,
	prefix: string,
	tree: K,
	input: AsyncIterable<ManifestEntryByTree[K]> | Iterable<ManifestEntryByTree[K]>,
): Promise<ManifestTreeResult> {
	const session = new ManifestTreeSession(store, tree, prefix);
	let root = await session.write({ format: MANIFEST_LEAF_FORMAT, depth: 0, entries: [] });
	for await (const candidate of input) {
		const entry = validateManifestEntry(tree, candidate);
		assertEntryCanonicalBound(entry);
		const key = manifestEntryKey(tree, entry);
		root = await mutateSubtree(session, root, key, entry, await canonicalKeyDigest(key));
	}
	return finishTreeResult(session, root);
}

export async function mutateManifestTree<K extends ManifestTreeKind>(
	store: ManifestNodeStore,
	prefix: string,
	tree: K,
	rootHash: string,
	mutations: AsyncIterable<ManifestTreeMutation<ManifestEntryByTree[K]>> | Iterable<ManifestTreeMutation<ManifestEntryByTree[K]>>,
): Promise<ManifestTreeResult> {
	assertHash(rootHash, "manifest root hash");
	const session = new ManifestTreeSession(store, tree, prefix);
	let root = await session.read(rootHash, 0);
	for await (const mutation of mutations) {
		let key: string;
		let entry: ManifestEntryByTree[K] | null;
		if (mutation.type === "upsert") {
			if (!mutation.entry || mutation.key !== undefined) throw new Error("invalid manifest upsert mutation");
			entry = validateManifestEntry(tree, mutation.entry);
			assertEntryCanonicalBound(entry);
			key = manifestEntryKey(tree, entry);
		} else if (mutation.type === "delete") {
			if (mutation.entry !== undefined || typeof mutation.key !== "string") throw new Error("invalid manifest delete mutation");
			entry = null;
			key = canonicalManifestLookupKey(tree, mutation.key);
		} else {
			throw new Error("unsupported manifest mutation");
		}
		root = await mutateSubtree(session, root, key, entry, await canonicalKeyDigest(key));
	}
	return finishTreeResult(session, root);
}

export function canonicalManifestLookupKey(tree: ManifestTreeKind, key: string): string {
	if (tree === "active") {
		assertMarkdownPath(key, "active lookup path");
		return key;
	}
	if (tree === "attachments") {
		assertAttachmentPath(key, "attachment lookup path");
		return key;
	}
	assertString(key, "deleted lookup body ID");
	return key;
}

export async function lookupManifestEntry<K extends ManifestTreeKind>(
	source: ManifestNodeSource,
	tree: K,
	rootHash: string,
	lookupKey: string,
	bounds: { maxReads?: number; maxCompressedBytes?: number } = {},
): Promise<ManifestLookupResult<ManifestEntryByTree[K]>> {
	assertHash(rootHash, "manifest root hash");
	const key = canonicalManifestLookupKey(tree, lookupKey);
	const digest = await canonicalKeyDigest(key);
	const maxReads = bounds.maxReads ?? MANIFEST_LOOKUP_MAX_READS;
	const maxCompressedBytes = bounds.maxCompressedBytes ?? MANIFEST_LOOKUP_MAX_BYTES;
	let hash = rootHash;
	let expectedDepth = 0;
	let expectedCounts: { entries: number; nodes: number } | null = null;
	let nodeReads = 0;
	let compressedBytes = 0;
	for (;;) {
		if (++nodeReads > maxReads) throw new Error("manifest lookup exceeded node-read bound");
		const compressed = await source.readNode(hash);
		if (!compressed) throw new Error(`manifest node missing: ${hash}`);
		compressedBytes += compressed.byteLength;
		if (compressedBytes > maxCompressedBytes) throw new Error("manifest lookup exceeded node-byte bound");
		const node = await decodeAndVerifyManifestNode(tree, compressed, hash);
		const counts = subtreeCounts(node);
		if (expectedCounts && (counts.entries !== expectedCounts.entries || counts.nodes !== expectedCounts.nodes)) {
			throw new Error("manifest lookup encountered corrupt child counts");
		}
		if (node.depth !== expectedDepth) throw new Error("manifest lookup encountered an invalid node depth");
		if (node.format === MANIFEST_LEAF_FORMAT) {
			const position = findEntryIndex(tree, node.entries, key);
			return { entry: position.found ? node.entries[position.index]! : null, nodeReads, compressedBytes };
		}
		if (node.depth >= MANIFEST_MAX_DEPTH) throw new Error("manifest lookup exceeded maximum tree depth");
		const child = node.children[digestPrefix(digest, node.depth)];
		if (!child) return { entry: null, nodeReads, compressedBytes };
		hash = child.hash;
		expectedCounts = { entries: child.entries, nodes: child.nodes };
		expectedDepth++;
	}
}

export async function collectReachableManifestNodes<K extends ManifestTreeKind>(
	source: ManifestNodeSource,
	tree: K,
	rootHash: string,
): Promise<readonly ReachableManifestNode[]> {
	const readonlyStore: ManifestNodeStore = {
		readNode: (hash) => source.readNode(hash),
		writeNode: async () => { throw new Error("read-only manifest source"); },
	};
	const session = new ManifestTreeSession(readonlyStore, tree, "");
	return enumerateReachable(session, await session.read(rootHash, 0));
}

export async function computeManifestGraphDigest(nodes: Iterable<ReachableManifestNode>): Promise<string> {
	const seen = new Set<string>();
	const tuples = [...nodes]
		.map((node) => {
			if (
				(node.tree !== "active" && node.tree !== "deleted" && node.tree !== "attachments")
				|| !/^(?:[a-f0-9]{2}){0,32}$/.test(node.logicalPrefix)
				|| !HASH_PATTERN.test(node.nodeHash)
				|| (node.nodeFormat !== MANIFEST_BRANCH_FORMAT && node.nodeFormat !== MANIFEST_LEAF_FORMAT)
			) {
				throw new Error("invalid manifest graph tuple");
			}
			assertSafeInteger(node.subtreeEntries, "manifest graph entry count");
			assertSafeInteger(node.subtreeNodes, "manifest graph node count");
			if (node.subtreeNodes < 1) throw new Error("invalid manifest graph node count");
			const identity = `${node.tree}:${node.logicalPrefix}`;
			if (seen.has(identity)) throw new Error("duplicate manifest graph logical prefix");
			seen.add(identity);
			return [node.tree, node.logicalPrefix, node.nodeHash, node.subtreeEntries, node.subtreeNodes] as const;
		})
		.sort((left, right) => {
			for (let index = 0; index < 3; index++) {
				const comparison = compareCanonicalStrings(String(left[index]), String(right[index]));
				if (comparison !== 0) return comparison;
			}
			return Number(left[3]) - Number(right[3]) || Number(left[4]) - Number(right[4]);
		});
	return canonicalJsonHash(tuples);
}

function validateTimestamp(value: unknown, label: string): string {
	assertString(value, label, 128);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(`invalid ${label}`);
	return value;
}

export function validateSnapshotRoot(value: unknown): SnapshotRootV2 {
	const root = asRecord(value, "snapshot root");
	assertExactKeys(root, [
		"format", "snapshotFormatVersion", "snapshotId", "vaultIdHash", "vaultGenerationHash", "runtimeEpoch",
		"boundarySequence", "rootGeneration", "sourcePlanDigest", "manifestGraphDigest", "manifestNodeCount",
		"createdAt", "completedAt", "health", "reason", "activeFilesTreeHash", "deletedFilesTreeHash",
		"attachmentsTreeHash", "totals", "previousSnapshotId",
	], "snapshot root");
	if (root.format !== RECOVERY_SNAPSHOT_FORMAT || root.snapshotFormatVersion !== RECOVERY_SNAPSHOT_FORMAT_VERSION) {
		throw new Error("unsupported recovery snapshot format");
	}
	assertString(root.snapshotId, "snapshot ID", 256);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(root.snapshotId)) throw new Error("invalid snapshot ID");
	assertHash(root.vaultIdHash, "vault ID hash");
	assertHash(root.vaultGenerationHash, "vault generation hash");
	assertString(root.runtimeEpoch, "runtime epoch", 256);
	assertSafeInteger(root.boundarySequence, "snapshot boundary sequence");
	assertSafeInteger(root.rootGeneration, "snapshot root generation");
	assertHash(root.sourcePlanDigest, "source plan digest");
	assertHash(root.manifestGraphDigest, "manifest graph digest");
	assertSafeInteger(root.manifestNodeCount, "manifest node count");
	if (root.manifestNodeCount < 3) throw new Error("snapshot manifest graph omits a tree root");
	const createdAt = validateTimestamp(root.createdAt, "snapshot creation timestamp");
	const completedAt = validateTimestamp(root.completedAt, "snapshot completion timestamp");
	if (completedAt < createdAt) throw new Error("snapshot completion precedes creation");
	if (root.health !== "complete" && root.health !== "complete_with_gaps") throw new Error("invalid snapshot health");
	if (root.reason !== "initial" && root.reason !== "daily" && root.reason !== "manual" && root.reason !== "pre-bulk-operation") {
		throw new Error("invalid snapshot reason");
	}
	assertHash(root.activeFilesTreeHash, "active tree hash");
	assertHash(root.deletedFilesTreeHash, "deleted tree hash");
	assertHash(root.attachmentsTreeHash, "attachments tree hash");
	const totals = asRecord(root.totals, "snapshot totals");
	assertExactKeys(totals, ["activeFiles", "deletedFiles", "unavailableFiles", "attachments", "markdownBytes", "attachmentBytes"], "snapshot totals");
	const activeFiles = totals.activeFiles;
	const deletedFiles = totals.deletedFiles;
	const unavailableFiles = totals.unavailableFiles;
	const attachments = totals.attachments;
	const markdownBytes = totals.markdownBytes;
	const attachmentBytes = totals.attachmentBytes;
	assertSafeInteger(activeFiles, "snapshot total activeFiles");
	assertSafeInteger(deletedFiles, "snapshot total deletedFiles");
	assertSafeInteger(unavailableFiles, "snapshot total unavailableFiles");
	assertSafeInteger(attachments, "snapshot total attachments");
	assertSafeInteger(markdownBytes, "snapshot total markdownBytes");
	assertSafeInteger(attachmentBytes, "snapshot total attachmentBytes");
	if (unavailableFiles > activeFiles + deletedFiles) throw new Error("snapshot unavailable file total exceeds file total");
	if (root.previousSnapshotId !== null) {
		assertString(root.previousSnapshotId, "previous snapshot ID", 256);
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(root.previousSnapshotId)) throw new Error("invalid previous snapshot ID");
	}
	return {
		format: root.format,
		snapshotFormatVersion: root.snapshotFormatVersion,
		snapshotId: root.snapshotId,
		vaultIdHash: root.vaultIdHash,
		vaultGenerationHash: root.vaultGenerationHash,
		runtimeEpoch: root.runtimeEpoch,
		boundarySequence: root.boundarySequence,
		rootGeneration: root.rootGeneration,
		sourcePlanDigest: root.sourcePlanDigest,
		manifestGraphDigest: root.manifestGraphDigest,
		manifestNodeCount: root.manifestNodeCount,
		createdAt,
		completedAt,
		health: root.health,
		reason: root.reason,
		activeFilesTreeHash: root.activeFilesTreeHash,
		deletedFilesTreeHash: root.deletedFilesTreeHash,
		attachmentsTreeHash: root.attachmentsTreeHash,
		totals: {
			activeFiles,
			deletedFiles,
			unavailableFiles,
			attachments,
			markdownBytes,
			attachmentBytes,
		},
		previousSnapshotId: root.previousSnapshotId,
	};
}

export async function encodeSnapshotRoot(prefix: string, value: SnapshotRootV2): Promise<EncodedSnapshotRoot> {
	const root = validateSnapshotRoot(value);
	const canonicalBytes = canonicalJsonBytes(root);
	const hash = await sha256Hex(canonicalBytes);
	return { value: root, canonicalBytes, hash, objectKey: snapshotRootObjectKey(prefix, hash) };
}

export async function parseAndVerifySnapshotRoot(bytes: Uint8Array, expectedHash: string): Promise<SnapshotRootV2> {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECOVERY_NODE_BYTES) throw new Error("snapshot root exceeds byte bound");
	assertHash(expectedHash, "expected snapshot root hash");
	if (await sha256Hex(bytes) !== expectedHash) throw new Error("snapshot root hash mismatch");
	return validateSnapshotRoot(parseCanonicalJson(bytes));
}
