import * as Y from "yjs";
import { canonicalCanvasBytes } from "./shared/canvasCodec";
import {
	importCanvasData,
	initializeCanvasDocument,
	materializeCanvasDocument,
	validateCanvasDocument,
} from "./shared/canvasSemanticDocument";
import { canonicalizeMarkdown } from "./shared/markdownCodec";
import { validateFrontmatterSemanticRoots } from "./shared/frontmatterSemanticValidation";
import { safeBlobPath, safeCanvasPath, safeMarkdownPath } from "./shared/vaultPath";
import type { SemanticPathRef } from "./shared/canvasTypes";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "./shared/productVersions";
import type { RootAuthoritySnapshot } from "./vaultCatalogStore";

export interface SemanticDocumentCensus {
	totalStructs: number;
	deletedStructs: number;
}

export interface PreparedSemanticReset {
	document: Y.Doc;
	encodedState: Uint8Array;
	previous: SemanticDocumentCensus & { encodedStateBytes: number };
	fresh: SemanticDocumentCensus & { encodedStateBytes: number };
}

export interface PreparedCanvasSemanticReset extends PreparedSemanticReset {
	liveStateBytes: number;
}

type InternalStruct = { deleted?: boolean };
type InternalDoc = Y.Doc & { store: { clients: Map<number, InternalStruct[]> } };

export function semanticDocumentCensus(doc: Y.Doc): SemanticDocumentCensus {
	let totalStructs = 0;
	let deletedStructs = 0;
	for (const structs of (doc as InternalDoc).store.clients.values()) {
		totalStructs += structs.length;
		for (const struct of structs) if (struct.deleted === true) deletedStructs++;
	}
	return { totalStructs, deletedStructs };
}

/**
 * Builds a genuinely fresh CRDT from current semantic values. No encoded Yjs
 * state from the old document is applied to the result.
 */
export function prepareSemanticReset(current: Y.Doc, scope: "body"): PreparedSemanticReset {
	materializeSemanticRoots(current, scope);
	const semanticError = validateFrontmatterSemanticRoots(current);
	if (semanticError) throw new Error(`semantic reset rejected invalid body: ${semanticError}`);
	const previousEncoded = Y.encodeStateAsUpdate(current);
	const fresh = new Y.Doc({ guid: current.guid });
	try {
		for (const [name, shared] of current.share) {
			const kind = shared.constructor.name;
			if (kind === "YText") {
				const source = shared as unknown as Y.Text;
				const sourceText = source.toJSON();
				const text = name === "body"
					? canonicalizeMarkdown(sourceText)
					: sourceText;
				if (text.length > 0) fresh.getText(name).insert(0, text);
				continue;
			}
			if (kind === "YMap") {
				const target = fresh.getMap<unknown>(name);
				for (const [key, value] of (shared as unknown as Y.Map<unknown>).entries()) target.set(key, cloneSemanticValue(value));
				continue;
			}
			if (kind === "YArray") {
				const values = (shared as unknown as Y.Array<unknown>).toArray().map(cloneSemanticValue);
				if (values.length > 0) fresh.getArray(name).insert(0, values);
				continue;
			}
			throw new Error(`semantic reset does not support shared root ${name} (${kind})`);
		}
		const encodedState = Y.encodeStateAsUpdate(fresh);
		return {
			document: fresh,
			encodedState,
			previous: { ...semanticDocumentCensus(current), encodedStateBytes: previousEncoded.byteLength },
			fresh: { ...semanticDocumentCensus(fresh), encodedStateBytes: encodedState.byteLength },
		};
	} catch (error) {
		fresh.destroy();
		throw error;
	}
}

/** The only shared roots that may exist after a root semantic reset. */
export const ROOT_SEMANTIC_ROOTS = Object.freeze([
	"sys", "pathToId", "pathToSemantic", "pathToBlob", "blobMeta", "blobTombstones",
] as const);

/**
 * Builds root state exclusively from immutable SQL catalog authority at the
 * exact root-head boundary. Resident Yjs values are used only for the before
 * census: they are deliberately never copied into the fresh lineage.
 */
export function prepareRootSemanticReset(
	current: Y.Doc,
	authority: RootAuthoritySnapshot,
): PreparedSemanticReset {
	if (authority.boundarySequence < 0 || !Number.isSafeInteger(authority.boundarySequence)) {
		throw new Error("semantic reset rejected invalid root authority boundary");
	}
	const previousEncoded = Y.encodeStateAsUpdate(current);
	const fresh = new Y.Doc({ guid: current.guid });
	try {
		fresh.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
		fresh.getMap("sys").set("protocolVersion", PROTOCOL_VERSION);
		const markdown = fresh.getMap<string>("pathToId");
		const semantic = fresh.getMap<SemanticPathRef>("pathToSemantic");
		const refs = fresh.getMap<{ hash: string; size: number; revision: string }>("pathToBlob");
		const metadata = fresh.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta");
		const tombstones = fresh.getMap<{ deletedAt: number; previousHash: string | null; revision: string }>("blobTombstones");
		const occupiedPaths = new Set<string>();
		const identities = new Set<string>();
		const attachmentPaths = new Set<string>();

		for (const entry of authority.markdown) {
			assertCatalogInteger(entry.sequence, "Markdown sequence");
			assertCatalogInteger(entry.generation, "Markdown generation", 1);
			assertCatalogInteger(entry.bodyEpoch, "Markdown epoch", 1);
			if (!validIdentity(entry.bodyId) || entry.fileId !== entry.bodyId) {
				throw new Error("semantic reset rejected invalid Markdown identity");
			}
			if (identities.has(entry.bodyId)) throw new Error("semantic reset rejected duplicate Markdown identity");
			identities.add(entry.bodyId);
			if (entry.lifecycle !== "active" && entry.lifecycle !== "tombstoned" && entry.lifecycle !== "reaped") {
				throw new Error("semantic reset rejected invalid Markdown lifecycle");
			}
			if (entry.lifecycle !== "active") continue;
			if (safeMarkdownPath(entry.path) !== entry.path) throw new Error("semantic reset rejected unsafe Markdown path");
			claimRootPath(occupiedPaths, entry.path);
			markdown.set(entry.path, entry.fileId);
		}

		for (const entry of authority.semantic) {
			assertCatalogInteger(entry.sequence, "semantic sequence");
			assertCatalogInteger(entry.generation, "semantic generation", 1);
			assertCatalogInteger(entry.bodyEpoch, "semantic epoch", 1);
			if (!validIdentity(entry.documentId) || entry.fileId !== entry.documentId
				|| entry.kind !== "canvas" || entry.format !== "json-canvas" || entry.formatVersion !== 1) {
				throw new Error("semantic reset rejected invalid Canvas authority");
			}
			if (identities.has(entry.documentId)) {
				throw new Error("semantic reset rejected duplicate cross-kind document identity");
			}
			identities.add(entry.documentId);
			if (entry.lifecycle !== "active" && entry.lifecycle !== "tombstoned" && entry.lifecycle !== "reaped") {
				throw new Error("semantic reset rejected invalid Canvas lifecycle");
			}
			if (entry.lifecycle !== "active") continue;
			if (safeCanvasPath(entry.path) !== entry.path) throw new Error("semantic reset rejected unsafe Canvas path");
			claimRootPath(occupiedPaths, entry.path);
			semantic.set(entry.path, { documentId: entry.documentId, kind: "canvas", format: "json-canvas", formatVersion: 1 });
		}

		for (const entry of authority.attachments) {
			assertCatalogInteger(entry.sequence, "attachment sequence");
			assertCatalogInteger(entry.createdAt, "attachment operation time");
			if (!validIdentity(entry.operationId) || safeBlobPath(entry.path) !== entry.path
				|| (entry.lifecycle !== "active" && entry.lifecycle !== "deleted")) {
				throw new Error("semantic reset rejected invalid attachment authority");
			}
			if (attachmentPaths.has(entry.path)) throw new Error("semantic reset rejected duplicate attachment path");
			attachmentPaths.add(entry.path);
			if (entry.lifecycle === "active") {
				const hash = entry.contentHash;
				const size = entry.size;
				if (!validBlob(hash, size) || typeof entry.mime !== "string"
					|| entry.mime.length < 1 || entry.mime.length > 256
					|| safeBlobPath(entry.path, "", { hash, size: size! }) !== entry.path) {
					throw new Error("semantic reset rejected invalid active attachment");
				}
				claimRootPath(occupiedPaths, entry.path);
				refs.set(entry.path, { hash, size: size!, revision: entry.operationId });
			} else {
				if (entry.contentHash !== null && !validHash(entry.contentHash)) {
					throw new Error("semantic reset rejected invalid attachment tombstone hash");
				}
				tombstones.set(entry.path, {
					deletedAt: entry.createdAt,
					previousHash: entry.contentHash,
					revision: entry.operationId,
				});
			}
		}

		for (const blob of authority.blobs) {
			const size = blob.size;
			if (!validBlob(blob.contentHash, size) || typeof blob.mime !== "string"
				|| blob.mime.length < 1 || blob.mime.length > 256) {
				throw new Error("semantic reset rejected invalid blob metadata");
			}
			assertCatalogInteger(blob.createdAt, "blob creation time");
			if (metadata.has(blob.contentHash)) throw new Error("semantic reset rejected duplicate blob metadata");
			metadata.set(blob.contentHash, { size: size!, mime: blob.mime, createdAt: blob.createdAt });
		}
		for (const [, ref] of refs) {
			const meta = metadata.get(ref.hash);
			if (!meta || meta.size !== ref.size) throw new Error("semantic reset rejected incomplete blob metadata");
		}

		const encodedState = Y.encodeStateAsUpdate(fresh);
		return {
			document: fresh,
			encodedState,
			previous: { ...semanticDocumentCensus(current), encodedStateBytes: previousEncoded.byteLength },
			fresh: { ...semanticDocumentCensus(fresh), encodedStateBytes: encodedState.byteLength },
		};
	} catch (error) {
		fresh.destroy();
		throw error;
	}
}

/**
 * Rebuilds a Canvas from its canonical live JSON model. Tombstones, resolved
 * conflict records, ordering churn, and all prior CRDT identities deliberately
 * stay in the retired epoch.
 */
export async function prepareCanvasSemanticReset(current: Y.Doc): Promise<PreparedCanvasSemanticReset> {
	const validation = await validateCanvasDocument(current);
	if (validation) throw new Error(`semantic reset rejected invalid canvas: ${validation}`);
	const data = await materializeCanvasDocument(current, false);
	const canonical = canonicalCanvasBytes(data);
	const previousEncoded = Y.encodeStateAsUpdate(current);
	const fresh = new Y.Doc({ guid: current.guid });
	try {
		initializeCanvasDocument(fresh);
		importCanvasData(fresh, data, "canvas-semantic-reset");
		const freshValidation = await validateCanvasDocument(fresh);
		if (freshValidation) throw new Error(`semantic reset produced invalid canvas: ${freshValidation}`);
		const encodedState = Y.encodeStateAsUpdate(fresh);
		return {
			document: fresh,
			encodedState,
			liveStateBytes: canonical.byteLength,
			previous: { ...semanticDocumentCensus(current), encodedStateBytes: previousEncoded.byteLength },
			fresh: { ...semanticDocumentCensus(fresh), encodedStateBytes: encodedState.byteLength },
		};
	} catch (error) {
		fresh.destroy();
		throw error;
	}
}

/**
 * Updates loaded into an otherwise empty Y.Doc initially expose AbstractType
 * placeholders. Resolve them through YAOS's schema before inspecting their
 * constructors; guessing from the placeholder would conflate Y.Text/Y.Array.
 */
function materializeSemanticRoots(doc: Y.Doc, scope: "body"): void {
	doc.getText("body");
	for (const name of doc.share.keys()) {
		if (!name.startsWith("frontmatter:")) continue;
		if (name.startsWith("frontmatter:ordered:")) doc.getArray(name);
		else doc.getMap(name);
	}
}

function claimRootPath(paths: Set<string>, path: string): void {
	if (paths.has(path)) throw new Error(`semantic reset rejected duplicate root path: ${path}`);
	paths.add(path);
}

function validIdentity(value: string): boolean {
	if (value.length < 1 || value.length > 256) return false;
	return [...value].every((character) => {
		const code = character.codePointAt(0)!;
		return code >= 0x20 && code !== 0x7f;
	});
}

function validHash(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

function validBlob(hash: string | null, size: number | null): hash is string {
	return typeof hash === "string" && validHash(hash)
		&& typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
}

function assertCatalogInteger(value: number, label: string, minimum = 0): void {
	if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`semantic reset rejected invalid ${label}`);
}

function cloneSemanticValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Uint8Array) return value.slice();
	if (Array.isArray(value)) return value.map(cloneSemanticValue);
	if (typeof value === "object") {
		if ("_item" in value && "_map" in value) throw new Error("nested shared types are not semantic reset values");
		return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneSemanticValue(nested)]));
	}
	throw new Error("unsupported semantic reset value");
}
