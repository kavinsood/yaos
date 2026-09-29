/**
 * Relay v2 spike (§5.5): client-side "fresh doc builder" for lease-based
 * semantic reset.
 *
 * It reproduces, on the client's JS `yjs` document, exactly what the server's
 * semantic reset does today in `server/src/semanticCompaction.ts`
 * `prepareSemanticReset(current, "body")`:
 *
 *   1. reject bodies whose `frontmatter:*` roots violate the semantic contract
 *      (`validateFrontmatterSemanticRoots`, shared code, Y.Doc flavour);
 *   2. snapshot every root (deep, type-preserving, sorted by name) with the
 *      server's own JS CRDT engine (`server/src/crdt/yjsCrdtEngine.ts`
 *      `snapshotRoots`, the conformance twin of the ywasm engine);
 *   3. turn each root into one root operation:
 *        text  → `text-replace` (the `body` root is `canonicalizeMarkdown`ed),
 *        array → `array-replace`,
 *        map   → one `map-set` per entry (values must be plain, not nested types);
 *   4. apply them to a brand-new document with the same guid in ONE
 *      transaction (origin "semantic-reset") via the same engine's
 *      `applyRootOperations`;
 *   5. encode the fresh state (the upload payload).
 *
 * Steps 3–4 are a line-for-line mirror of `prepareSemanticReset`; that function
 * is hard-wired to the ywasm engine (`@yaos/crdt-engine`), so it cannot run on
 * a client Y.Doc. `tests/client/relay2-reset-builder.ts` proves equivalence by
 * running both on the same state (same text, same content hash, same root
 * snapshot, same struct census, same encoded size).
 *
 * Undefined roots (a root that arrived over the wire but was never accessed
 * with getText/getMap/getArray) are resolved with the same name table the
 * server uses (`ywasmCrdtEngine.ts` `resolveUndefinedRoot`); unknown roots of
 * unknown kind are dropped, which is what the server's reset does to them
 * (they snapshot as an empty map → no operations).
 */
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { CrdtRootOperation, CrdtValueSnapshot } from "../../../server/src/crdt/crdtEngine";
import { yjsCrdtEngine, type YjsCrdtDocument } from "../../../server/src/crdt/yjsCrdtEngine";
import { canonicalizeMarkdown, canonicalMarkdownBytes, canonicalMarkdownBytesHash } from "../../../server/src/shared/markdownCodec";
import { validateFrontmatterSemanticRoots } from "../../../server/src/shared/frontmatterSemanticValidation";

export const BODY_TEXT_ROOT = "body";

/** Mirror of `YAOS_MAP_ROOTS` in server/src/crdt/ywasmCrdtEngine.ts (body-relevant subset + rest). */
const YAOS_MAP_ROOTS = new Set([
	"canvasMeta", "rootFields", "nodes", "nodeOrder", "nodeTombstones", "edges", "edgeOrder",
	"edgeTombstones", "resolvedConflicts", "sys", "pathToId", "pathToSemantic", "pathToBlob",
	"blobMeta", "blobTombstones", "catalog", "__yaosLifecycle", "__yaosLifecyclePublicationProof", "frontmatter:meta",
	"frontmatter:registers", "frontmatter:presence", "frontmatter:set-adds", "frontmatter:set-removes",
]);

export interface DocumentCensus {
	encodedStateBytes: number;
	totalStructs: number;
	deletedStructs: number;
}

export interface FreshSnapshotTimings {
	/** Encode old state + struct census (the "before" numbers; also needed by the policy). */
	censusMs: number;
	validateMs: number;
	snapshotMs: number;
	buildMs: number;
	encodeMs: number;
	hashMs: number;
	freshCensusMs: number;
	totalMs: number;
}

export interface FreshSnapshot {
	guid: string;
	/** Upload payload for POST …/semantic-reset (a complete Yjs v1 update). */
	snapshot: Uint8Array;
	/** SHA-256 of canonical Markdown UTF-8 (`canonicalMarkdownHash`), as catalog/candidates use. */
	contentHash: string;
	/** Canonical body text that the fresh epoch contains. */
	content: string;
	contentBytes: number;
	roots: string[];
	before: DocumentCensus;
	after: DocumentCensus;
	timings: FreshSnapshotTimings;
	/** Present only when `keepDocument` was requested; caller owns and must destroy it. */
	document?: Y.Doc;
}

export interface BuildOptions {
	/** Keep and return the fresh Y.Doc (otherwise destroyed). */
	keepDocument?: boolean;
	/** Deterministic client id for the fresh lineage (tests only). Default: yjs random. */
	clientID?: number;
	/** Skip the "before" census (caller already has it from the policy check). */
	before?: DocumentCensus;
	/**
	 * Make the snapshot's state vector cover this (old-lineage) state vector by
	 * prepending one GC struct per old client (`lineageCoverUpdate`). The deployed
	 * relay server rejects a snapshot whose SV does not cover the head SV
	 * (`snapshotCoversHead` → 400 invalid_snapshot), which a lineage-fresh doc never
	 * does. Cost: ~13 B per historical client (measured 52 B for 4); the SV never shrinks. Side effect
	 * (useful): any leaked old-lineage update at clocks ≤ the cover is a no-op.
	 */
	coverStateVector?: Uint8Array;
}

/**
 * A Yjs v1 update containing, for each (client, clock) in `stateVector`, a
 * single GC struct spanning clocks [0, clock). GC = "content known and
 * discarded": it carries no content and belongs to no shared type.
 */
export function lineageCoverUpdate(stateVector: Uint8Array): Uint8Array {
	const clocks = [...Y.decodeStateVector(stateVector).entries()].filter(([, clock]) => clock > 0).sort((a, b) => b[0] - a[0]);
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, clocks.length);
	for (const [client, clock] of clocks) {
		encoding.writeVarUint(encoder, 1); // structs for this client
		encoding.writeVarUint(encoder, client);
		encoding.writeVarUint(encoder, 0); // first clock
		encoding.writeUint8(encoder, 0); // info: GC
		encoding.writeVarUint(encoder, clock); // length
	}
	encoding.writeVarUint(encoder, 0); // empty delete set
	return encoding.toUint8Array(encoder);
}

type InternalDoc = Y.Doc & { readonly store: { readonly clients: Map<number, ReadonlyArray<{ readonly deleted?: boolean }>> } };

/** Struct census identical to yjsCrdtEngine.documentStats (which also encodes the state). */
export function structCensus(doc: Y.Doc): { totalStructs: number; deletedStructs: number } {
	let totalStructs = 0;
	let deletedStructs = 0;
	for (const structs of (doc as InternalDoc).store.clients.values()) {
		totalStructs += structs.length;
		for (const struct of structs) if (struct.deleted === true) deletedStructs++;
	}
	return { totalStructs, deletedStructs };
}

export function documentCensus(doc: Y.Doc): DocumentCensus {
	return { encodedStateBytes: Y.encodeStateAsUpdate(doc).byteLength, ...structCensus(doc) };
}

/**
 * Adopt an existing client Y.Doc into a yjsCrdtEngine handle WITHOUT copying
 * it, so the server's own snapshot code runs on it. The handle must never be
 * passed to destroyDocument (it would destroy the caller's doc).
 */
function adopt(doc: Y.Doc): YjsCrdtDocument {
	const handle = yjsCrdtEngine.createDocument(doc.guid);
	const placeholder = (handle as unknown as { value: Y.Doc }).value;
	Object.defineProperty(handle, "value", { value: doc, writable: false, configurable: false, enumerable: true });
	placeholder.destroy();
	return handle;
}

function engineDoc(handle: YjsCrdtDocument): Y.Doc {
	return (handle as unknown as { value: Y.Doc }).value;
}

/** Give every wire-only (AbstractType placeholder) root its schema kind; return the snapshot-able names. */
function resolveRoots(doc: Y.Doc): string[] {
	const names: string[] = [];
	for (const [name, type] of [...doc.share.entries()]) {
		if (type instanceof Y.Text || type instanceof Y.Map || type instanceof Y.Array) {
			names.push(name);
			continue;
		}
		if (name === BODY_TEXT_ROOT) doc.getText(name);
		else if (name === "frontmatter:ordered:aliases") doc.getArray(name);
		else if (YAOS_MAP_ROOTS.has(name)) doc.getMap(name);
		else continue; // unknown kind: the server snapshots it as an empty map → dropped.
		names.push(name);
	}
	return names.sort((left, right) => left.localeCompare(right));
}

function cloneSemanticValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Uint8Array) return value.slice();
	if (Array.isArray(value)) return value.map(cloneSemanticValue);
	if (typeof value === "object") {
		if (value instanceof Y.AbstractType) throw new Error("nested shared types are not semantic reset values");
		return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneSemanticValue(nested)]));
	}
	throw new Error("unsupported semantic reset value");
}

function cloneSemanticSnapshot(value: CrdtValueSnapshot): CrdtValueSnapshot {
	if (value.shared !== "value") throw new Error("nested shared types are not semantic reset values");
	return { shared: "value", value: cloneSemanticValue(value.value) };
}

/** Same operation list `prepareSemanticReset` builds (server/src/semanticCompaction.ts). */
export function semanticResetOperations(current: Y.Doc): CrdtRootOperation[] {
	const names = resolveRoots(current);
	const operations: CrdtRootOperation[] = [];
	for (const root of yjsCrdtEngine.snapshotRoots(adopt(current), { names })) {
		if (root.value.shared === "text") {
			operations.push({ kind: "text-replace", root: root.name,
				value: root.name === BODY_TEXT_ROOT ? canonicalizeMarkdown(root.value.value) : root.value.value });
		} else if (root.value.shared === "array") {
			operations.push({ kind: "array-replace", root: root.name, values: root.value.values });
		} else {
			for (const [key, value] of root.value.entries) {
				operations.push({ kind: "map-set", root: root.name, key, value: cloneSemanticSnapshot(value) });
			}
		}
	}
	return operations;
}

const now = (): number => performance.now();

export async function buildFreshSnapshot(current: Y.Doc, options: BuildOptions = {}): Promise<FreshSnapshot> {
	const started = now();
	const before = options.before ?? documentCensus(current);
	const censusDone = now();
	const semanticError = validateFrontmatterSemanticRoots(current);
	if (semanticError) throw new Error(`semantic reset rejected invalid body: ${semanticError}`);
	const validated = now();
	const operations = semanticResetOperations(current);
	const snapshotted = now();
	const freshHandle = yjsCrdtEngine.createDocument(current.guid);
	const fresh = engineDoc(freshHandle);
	if (options.clientID !== undefined) fresh.clientID = options.clientID;
	const cover = options.coverStateVector ? Y.decodeStateVector(options.coverStateVector) : null;
	while (cover?.has(fresh.clientID)) fresh.clientID = Math.floor(Math.random() * 0xffff_ffff);
	let kept = false;
	try {
		yjsCrdtEngine.applyRootOperations(freshHandle, operations, "semantic-reset");
		const built = now();
		if (options.coverStateVector) Y.applyUpdate(fresh, lineageCoverUpdate(options.coverStateVector), "semantic-reset-lineage-cover");
		const snapshot = Y.encodeStateAsUpdate(fresh);
		const encoded = now();
		const content = fresh.getText(BODY_TEXT_ROOT).toJSON();
		const bytes = canonicalMarkdownBytes(content);
		const contentHash = await canonicalMarkdownBytesHash(bytes);
		const hashed = now();
		const after: DocumentCensus = { encodedStateBytes: snapshot.byteLength, ...structCensus(fresh) };
		const finished = now();
		const result: FreshSnapshot = {
			guid: current.guid,
			snapshot,
			contentHash,
			content,
			contentBytes: bytes.byteLength,
			roots: [...fresh.share.keys()].sort(),
			before,
			after,
			timings: {
				censusMs: censusDone - started,
				validateMs: validated - censusDone,
				snapshotMs: snapshotted - validated,
				buildMs: built - snapshotted,
				encodeMs: encoded - built,
				hashMs: hashed - encoded,
				freshCensusMs: finished - hashed,
				totalMs: finished - started,
			},
		};
		if (options.keepDocument) {
			kept = true;
			result.document = fresh;
		}
		return result;
	} finally {
		if (!kept) yjsCrdtEngine.destroyDocument(freshHandle);
	}
}

/** Build from plain text + frontmatter root values (no Y.Doc loaded): same shape as a reset of that state. */
export async function buildFreshSnapshotFromContent(
	guid: string,
	content: string,
	seedRoots?: (doc: Y.Doc) => void,
	options: BuildOptions = {},
): Promise<FreshSnapshot> {
	const scratch = new Y.Doc({ guid });
	try {
		scratch.getText(BODY_TEXT_ROOT).insert(0, content);
		seedRoots?.(scratch);
		return await buildFreshSnapshot(scratch, options);
	} finally {
		scratch.destroy();
	}
}
