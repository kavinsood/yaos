import {
	assertTextRange,
	type CrdtDocument,
	type CrdtDocumentStats,
	type CrdtEngine,
	type CrdtMemoryDiagnostics,
	type CrdtRootOperation,
	type CrdtRootSnapshot,
	type CrdtValueSnapshot,
} from "./crdtEngine";

interface Disposable {
	free(): void;
}

type YwasmTransaction = Disposable;

interface YwasmText extends Disposable {
	toString(txn: YwasmTransaction | undefined): string;
	insert(index: number, value: string, attributes: undefined, txn: YwasmTransaction | undefined): void;
	delete(index: number, length: number, txn: YwasmTransaction | undefined): void;
}

interface YwasmArray extends Disposable {
	get(index: number, txn: YwasmTransaction | undefined): unknown;
	length(txn: YwasmTransaction | undefined): number;
	delete(index: number, length: number, txn: YwasmTransaction | undefined): void;
	insert(index: number, values: unknown[], txn: YwasmTransaction | undefined): void;
}

interface YwasmMap extends Disposable {
	/** ywasm 0.27.4 currently returns a plain object despite documenting an iterator. */
	entries(txn: YwasmTransaction | undefined): Iterable<[string, unknown]> | Record<string, unknown>;
	get(key: string, txn: YwasmTransaction | undefined): unknown;
	set(key: string, value: unknown, txn: YwasmTransaction | undefined): void;
	delete(key: string, txn: YwasmTransaction | undefined): void;
}

interface YwasmDocument extends Disposable {
	readonly guid: string;
	destroy(parentTransaction: undefined): void;
	getText(name: string): YwasmText;
	getArray(name: string): YwasmArray;
	getMap(name: string): YwasmMap;
	roots(txn: YwasmTransaction | undefined): Array<[string, unknown]>;
	beginTransaction(origin: unknown): YwasmTransaction;
	documentStats?(): { readonly totalStructs: number; readonly deletedStructs: number };
}

export interface YwasmBindings {
	readonly YDoc: new (options: { readonly guid: string }) => YwasmDocument;
	readonly YText: new (initial?: string | null) => YwasmText;
	readonly YArray: new (initial?: unknown[] | null) => YwasmArray;
	readonly YMap: new (initial?: object | null) => YwasmMap;
	applyUpdate(doc: YwasmDocument, update: Uint8Array, origin: unknown): void;
	encodeStateVector(doc: YwasmDocument): Uint8Array;
	encodeStateAsUpdate(doc: YwasmDocument, vector?: Uint8Array | null): Uint8Array;
	mergeUpdatesV1(updates: Array<Uint8Array>): Uint8Array;
}

export interface YwasmArtifactMetadata {
	readonly maximumLinearMemoryBytes: number;
	readonly artifactSha256: string;
	readonly memoryByteLength: () => number;
}

export interface YwasmCrdtDocument extends CrdtDocument {
	readonly engine: "ywasm";
}

class YwasmDocumentHandle implements YwasmCrdtDocument {
	readonly engine = "ywasm" as const;
	private disposed = false;

	constructor(readonly guid: string, readonly value: YwasmDocument) {}

	assertLive(): YwasmDocument {
		if (this.disposed) throw new Error("CRDT document has been destroyed");
		return this.value;
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.value.destroy(undefined);
		this.value.free();
	}
}

function handle(doc: YwasmCrdtDocument): YwasmDocumentHandle {
	if (!(doc instanceof YwasmDocumentHandle)) throw new TypeError("document belongs to another CRDT engine");
	return doc;
}

function withText<T>(doc: YwasmDocument, name: string, body: (text: YwasmText) => T): T {
	const text = doc.getText(name);
	try {
		return body(text);
	} finally {
		text.free();
	}
}

function withTextTransaction(
	doc: YwasmDocument,
	name: string,
	origin: string | undefined,
	body: (text: YwasmText, txn: YwasmTransaction) => void,
): void {
	// Resolve the shared type before opening the transaction. Yrs rejects
	// getText while the document is mutably borrowed by beginTransaction.
	const text = doc.getText(name);
	try {
		const txn = doc.beginTransaction(origin);
		try {
			body(text, txn);
		} finally {
			txn.free();
		}
	} finally {
		text.free();
	}
}

function isDisposable(value: unknown): value is Disposable {
	return typeof value === "object" && value !== null && "free" in value && typeof value.free === "function";
}

function snapshotWasmValue(value: unknown, bindings: YwasmBindings, owned: Disposable[]): CrdtValueSnapshot {
	if (value instanceof bindings.YText) return { shared: "text", value: value.toString(undefined) };
	if (value instanceof bindings.YArray) {
		const values: CrdtValueSnapshot[] = [];
		for (let index = 0; index < value.length(undefined); index++) {
			const nested = value.get(index, undefined);
			if (isDisposable(nested)) owned.push(nested);
			values.push(snapshotWasmValue(nested, bindings, owned));
		}
		return { shared: "array", values };
	}
	if (value instanceof bindings.YMap) {
		const entries: Array<readonly [string, CrdtValueSnapshot]> = [];
		const returned = value.entries(undefined);
		const iterable = Symbol.iterator in Object(returned)
			? returned as Iterable<[string, unknown]>
			: Object.entries(returned);
		for (const [key, nested] of iterable) {
			if (isDisposable(nested)) owned.push(nested);
			entries.push([key, snapshotWasmValue(nested, bindings, owned)]);
		}
		return { shared: "map", entries: entries.sort(([left], [right]) => left.localeCompare(right)) };
	}
	return { shared: "value", value };
}

const YAOS_MAP_ROOTS = new Set([
	"canvasMeta", "rootFields", "nodes", "nodeOrder", "nodeTombstones", "edges", "edgeOrder",
	"edgeTombstones", "resolvedConflicts", "sys", "pathToId", "pathToSemantic", "pathToBlob",
	"blobMeta", "blobTombstones", "catalog", "__yaosLifecycle", "__yaosLifecyclePublicationProof", "frontmatter:meta",
	"frontmatter:registers", "frontmatter:presence", "frontmatter:set-adds", "frontmatter:set-removes",
]);

function resolveUndefinedRoot(doc: YwasmDocument, name: string): YwasmMap | YwasmArray | YwasmText | null {
	if (name === "body") return doc.getText(name);
	if (name === "frontmatter:ordered:aliases") return doc.getArray(name);
	if (YAOS_MAP_ROOTS.has(name)) return doc.getMap(name);
	// Root collection kinds are not carried on the Y update wire. ywasm can
	// therefore report an imported, previously unseen root without a wrapper.
	// Preserve its name so schema validators can reject it deterministically;
	// its contents are intentionally immaterial for an unsupported root.
	return null;
}

function wasmRootSnapshots(doc: YwasmDocument, bindings: YwasmBindings): CrdtRootSnapshot[] {
	const owned: Disposable[] = [];
	try {
		const result: CrdtRootSnapshot[] = [];
		for (const [name, returnedRoot] of doc.roots(undefined)) {
			const root = returnedRoot === undefined ? resolveUndefinedRoot(doc, name) : returnedRoot;
			if (root === null) {
				result.push({ name, value: { shared: "map", entries: [] } });
				continue;
			}
			if (isDisposable(root)) owned.push(root);
			const value = snapshotWasmValue(root, bindings, owned);
			if (value.shared === "value") throw new Error(`unsupported scalar root: ${name}`);
			result.push({ name, value });
		}
		return result.sort((left, right) => left.name.localeCompare(right.name));
	} finally {
		for (let index = owned.length - 1; index >= 0; index--) owned[index]?.free();
	}
}

function materializeWasmValue(
	value: CrdtValueSnapshot,
	bindings: YwasmBindings,
	owned: Disposable[],
): unknown {
	if (value.shared === "value") return value.value;
	if (value.shared === "text") {
		const result = new bindings.YText(value.value);
		owned.push(result);
		return result;
	}
	if (value.shared === "array") {
		const result = new bindings.YArray(value.values.map((nested) => materializeWasmValue(nested, bindings, owned)));
		owned.push(result);
		return result;
	}
	const result = new bindings.YMap();
	owned.push(result);
	for (const [key, nested] of value.entries) {
		result.set(key, materializeWasmValue(nested, bindings, owned), undefined);
	}
	return result;
}

function wasmRoot(doc: YwasmDocument, operation: CrdtRootOperation): YwasmMap | YwasmArray | YwasmText {
	if ((operation.path?.length ?? 0) > 0 || operation.kind.startsWith("map-")) return doc.getMap(operation.root);
	if (operation.kind === "array-replace") return doc.getArray(operation.root);
	return doc.getText(operation.root);
}

function wasmTarget(
	root: YwasmMap | YwasmArray | YwasmText,
	path: readonly string[] | undefined,
	txn: YwasmTransaction,
	bindings: YwasmBindings,
	owned: Disposable[],
): unknown {
	let target: unknown = root;
	for (const key of path ?? []) {
		if (!(target instanceof bindings.YMap)) throw new Error(`CRDT schema path is not a map at ${key}`);
		target = target.get(key, txn);
		if (isDisposable(target)) owned.push(target);
	}
	return target;
}

function applyWasmOperation(
	root: YwasmMap | YwasmArray | YwasmText,
	operation: CrdtRootOperation,
	txn: YwasmTransaction,
	bindings: YwasmBindings,
	owned: Disposable[],
): void {
	const target = wasmTarget(root, operation.path, txn, bindings, owned);
	if (operation.kind === "map-set") {
		if (!(target instanceof bindings.YMap)) throw new Error("CRDT schema target is not a map");
		target.set(operation.key, materializeWasmValue(operation.value, bindings, owned), txn);
	} else if (operation.kind === "map-delete") {
		if (!(target instanceof bindings.YMap)) throw new Error("CRDT schema target is not a map");
		target.delete(operation.key, txn);
	} else if (operation.kind === "array-replace") {
		if (!(target instanceof bindings.YArray)) throw new Error("CRDT schema target is not an array");
		const length = target.length(txn);
		if (length > 0) target.delete(0, length, txn);
		if (operation.values.length > 0) {
			target.insert(0, operation.values.map((nested) => materializeWasmValue(nested, bindings, owned)), txn);
		}
	} else {
		if (!(target instanceof bindings.YText)) throw new Error("CRDT schema target is not text");
		const length = target.toString(txn).length;
		if (length > 0) target.delete(0, length, txn);
		if (operation.value.length > 0) target.insert(0, operation.value, undefined, txn);
	}
}

/** Builds the adapter around either the vendored Worker binding or npm ywasm in Node tests. */
export function createYwasmCrdtEngine(
	bindings: YwasmBindings,
	artifact?: YwasmArtifactMetadata,
): CrdtEngine<YwasmCrdtDocument> {
	return {
		name: "ywasm",
		createDocument(guid) {
			return new YwasmDocumentHandle(guid, new bindings.YDoc({ guid }));
		},
		openDocument(guid, encodedState) {
			const result = new YwasmDocumentHandle(guid, new bindings.YDoc({ guid }));
			try {
				bindings.applyUpdate(result.value, encodedState, "open");
				return result;
			} catch (error) {
				result.destroy();
				throw error;
			}
		},
		applyUpdate(doc, update, origin) {
			bindings.applyUpdate(handle(doc).assertLive(), update, origin);
		},
		encodeStateVector(doc) {
			return bindings.encodeStateVector(handle(doc).assertLive());
		},
		encodeStateAsUpdate(doc, vector) {
			return bindings.encodeStateAsUpdate(handle(doc).assertLive(), vector);
		},
		mergeUpdates(updates) {
			return bindings.mergeUpdatesV1([...updates]);
		},
		documentStats(doc): CrdtDocumentStats {
			const value = handle(doc).assertLive();
			if (typeof value.documentStats !== "function") {
				throw new Error("YAOS ywasm artifact is missing the required documentStats census patch");
			}
			const encodedStateBytes = bindings.encodeStateAsUpdate(value).byteLength;
			return { encodedStateBytes, ...value.documentStats() };
		},
		readText(doc, name) {
			return withText(handle(doc).assertLive(), name, (text) => text.toString(undefined));
		},
		insertText(doc, name, index, value, origin) {
			assertTextRange(index);
			withTextTransaction(handle(doc).assertLive(), name, origin, (text, txn) => {
				text.insert(index, value, undefined, txn);
			});
		},
		deleteText(doc, name, index, length, origin) {
			assertTextRange(index, length);
			withTextTransaction(handle(doc).assertLive(), name, origin, (text, txn) => {
				text.delete(index, length, txn);
			});
		},
		snapshotRoots(doc) {
			return wasmRootSnapshots(handle(doc).assertLive(), bindings);
		},
		applyRootOperations(doc, operations, origin) {
			const value = handle(doc).assertLive();
			const owned: Disposable[] = [];
			// Root wrappers must be obtained before beginTransaction borrows the doc.
			const roots = operations.map((operation) => wasmRoot(value, operation));
			owned.push(...roots);
			const txn = value.beginTransaction(origin);
			try {
				for (let index = 0; index < operations.length; index++) {
					const operation = operations[index];
					const root = roots[index];
					if (operation && root) applyWasmOperation(root, operation, txn, bindings, owned);
				}
			} finally {
				txn.free();
				for (let index = owned.length - 1; index >= 0; index--) owned[index]?.free();
			}
		},
		destroyDocument(doc) {
			handle(doc).destroy();
		},
		memoryDiagnostics(): CrdtMemoryDiagnostics | null {
			if (!artifact) return null;
			return {
				linearMemoryBytes: artifact.memoryByteLength(),
				maximumLinearMemoryBytes: artifact.maximumLinearMemoryBytes,
				artifactSha256: artifact.artifactSha256,
			};
		},
	};
}
