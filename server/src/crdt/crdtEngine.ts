/**
 * Server-only CRDT boundary. Durable storage and coordination remain byte
 * oriented; engine-owned objects must never escape this module family.
 *
 * Text offsets are JavaScript UTF-16 code units, matching Yjs. No operation
 * retains a transaction or shared-type wrapper across an async boundary.
 */
export interface CrdtDocument {
	readonly engine: "yjs" | "ywasm";
	readonly guid: string;
}

export interface CrdtDocumentStats {
	readonly encodedStateBytes: number;
	readonly totalStructs: number;
	readonly deletedStructs: number;
}

export interface CrdtMemoryDiagnostics {
	readonly linearMemoryBytes: number;
	readonly maximumLinearMemoryBytes: number;
	readonly artifactSha256: string;
}

export type CrdtValueSnapshot =
	| { readonly shared: "value"; readonly value: unknown }
	| { readonly shared: "text"; readonly value: string }
	| { readonly shared: "array"; readonly values: readonly CrdtValueSnapshot[] }
	| { readonly shared: "map"; readonly entries: readonly (readonly [string, CrdtValueSnapshot])[] };

export interface CrdtRootSnapshot {
	readonly name: string;
	readonly value: Exclude<CrdtValueSnapshot, { readonly shared: "value" }>;
}

export type CrdtRootOperation =
	| { readonly kind: "map-set"; readonly root: string; readonly path?: readonly string[];
		readonly key: string; readonly value: CrdtValueSnapshot }
	| { readonly kind: "map-delete"; readonly root: string; readonly path?: readonly string[]; readonly key: string }
	| { readonly kind: "array-replace"; readonly root: string; readonly path?: readonly string[];
		readonly values: readonly CrdtValueSnapshot[] }
	| { readonly kind: "text-replace"; readonly root: string; readonly path?: readonly string[]; readonly value: string };

export interface CrdtEngine<Doc extends CrdtDocument = CrdtDocument> {
	readonly name: Doc["engine"];
	createDocument(guid: string): Doc;
	openDocument(guid: string, encodedState: Uint8Array): Doc;
	applyUpdate(doc: Doc, update: Uint8Array, origin?: string): void;
	encodeStateVector(doc: Doc): Uint8Array;
	encodeStateAsUpdate(doc: Doc, vector?: Uint8Array): Uint8Array;
	mergeUpdates(updates: readonly Uint8Array[]): Uint8Array;
	documentStats(doc: Doc): CrdtDocumentStats;
	readText(doc: Doc, name: string): string;
	insertText(doc: Doc, name: string, index: number, value: string, origin?: string): void;
	deleteText(doc: Doc, name: string, index: number, length: number, origin?: string): void;
	/** Deep, type-preserving snapshot; all engine wrappers are disposed before return. */
	snapshotRoots(doc: Doc): readonly CrdtRootSnapshot[];
	/** Applies a synchronous schema batch in one engine transaction. */
	applyRootOperations(doc: Doc, operations: readonly CrdtRootOperation[], origin?: string): void;
	destroyDocument(doc: Doc): void;
	memoryDiagnostics(): CrdtMemoryDiagnostics | null;
}

export function assertTextRange(index: number, length?: number): void {
	if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("text index must be a non-negative safe integer");
	if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
		throw new RangeError("text length must be a non-negative safe integer");
	}
}
