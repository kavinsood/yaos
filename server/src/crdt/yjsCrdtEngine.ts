import * as Y from "yjs";
import {
	assertTextRange,
	type CrdtDocument,
	type CrdtDocumentStats,
	type CrdtEngine,
	type CrdtRootOperation,
	type CrdtRootSnapshot,
	type CrdtValueSnapshot,
} from "./crdtEngine";

export interface YjsCrdtDocument extends CrdtDocument {
	readonly engine: "yjs";
}

class YjsDocumentHandle implements YjsCrdtDocument {
	readonly engine = "yjs" as const;
	private disposed = false;

	constructor(readonly guid: string, readonly value: Y.Doc) {}

	assertLive(): Y.Doc {
		if (this.disposed) throw new Error("CRDT document has been destroyed");
		return this.value;
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.value.destroy();
	}
}

function handle(doc: YjsCrdtDocument): YjsDocumentHandle {
	if (!(doc instanceof YjsDocumentHandle)) throw new TypeError("document belongs to another CRDT engine");
	return doc;
}

function census(doc: Y.Doc): Pick<CrdtDocumentStats, "totalStructs" | "deletedStructs"> {
	let totalStructs = 0;
	let deletedStructs = 0;
	type InternalStruct = { readonly deleted?: boolean };
	type InternalDoc = Y.Doc & { readonly store: { readonly clients: Map<number, readonly InternalStruct[]> } };
	for (const structs of (doc as InternalDoc).store.clients.values()) {
		totalStructs += structs.length;
		for (const struct of structs) if (struct.deleted === true) deletedStructs++;
	}
	return { totalStructs, deletedStructs };
}

function snapshotValue(value: unknown): CrdtValueSnapshot {
	if (value instanceof Y.Text) return { shared: "text", value: Y.Text.prototype.toString.call(value) };
	if (value instanceof Y.Array) return { shared: "array", values: value.toArray().map(snapshotValue) };
	if (value instanceof Y.Map) {
		return { shared: "map", entries: [...value.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, snapshotValue(nested)]) };
	}
	return { shared: "value", value };
}

function materializeValue(value: CrdtValueSnapshot): unknown {
	if (value.shared === "value") return value.value;
	if (value.shared === "text") return new Y.Text(value.value);
	if (value.shared === "array") return Y.Array.from(value.values.map(materializeValue) as never[]);
	const result = new Y.Map<unknown>();
	for (const [key, nested] of value.entries) result.set(key, materializeValue(nested));
	return result;
}

function yjsRootSnapshots(doc: Y.Doc): CrdtRootSnapshot[] {
	const result: CrdtRootSnapshot[] = [];
	for (const [name, value] of doc.share) {
		const snapshot = snapshotValue(value);
		if (snapshot.shared === "value") throw new Error(`unsupported scalar root: ${name}`);
		result.push({ name, value: snapshot });
	}
	return result.sort((left, right) => left.name.localeCompare(right.name));
}

function yjsRoot(doc: Y.Doc, operation: CrdtRootOperation): Y.Map<unknown> | Y.Array<unknown> | Y.Text {
	if ((operation.path?.length ?? 0) > 0 || operation.kind.startsWith("map-")) return doc.getMap(operation.root);
	if (operation.kind === "array-replace") return doc.getArray(operation.root);
	return doc.getText(operation.root);
}

function yjsTarget(root: Y.Map<unknown> | Y.Array<unknown> | Y.Text, path: readonly string[] | undefined): unknown {
	let target: unknown = root;
	for (const key of path ?? []) {
		if (!(target instanceof Y.Map)) throw new Error(`CRDT schema path is not a map at ${key}`);
		target = target.get(key);
	}
	return target;
}

function applyYjsOperation(doc: Y.Doc, operation: CrdtRootOperation): void {
	const target = yjsTarget(yjsRoot(doc, operation), operation.path);
	if (operation.kind === "map-set") {
		if (!(target instanceof Y.Map)) throw new Error("CRDT schema target is not a map");
		target.set(operation.key, materializeValue(operation.value));
	} else if (operation.kind === "map-delete") {
		if (!(target instanceof Y.Map)) throw new Error("CRDT schema target is not a map");
		target.delete(operation.key);
	} else if (operation.kind === "array-replace") {
		if (!(target instanceof Y.Array)) throw new Error("CRDT schema target is not an array");
		if (target.length > 0) target.delete(0, target.length);
		if (operation.values.length > 0) target.insert(0, operation.values.map(materializeValue));
	} else {
		if (!(target instanceof Y.Text)) throw new Error("CRDT schema target is not text");
		if (target.length > 0) target.delete(0, target.length);
		if (operation.value.length > 0) target.insert(0, operation.value);
	}
}

export const yjsCrdtEngine: CrdtEngine<YjsCrdtDocument> = {
	name: "yjs",
	createDocument(guid) {
		return new YjsDocumentHandle(guid, new Y.Doc({ guid }));
	},
	openDocument(guid, encodedState) {
		const result = new YjsDocumentHandle(guid, new Y.Doc({ guid }));
		try {
			Y.applyUpdate(result.value, encodedState, "open");
			return result;
		} catch (error) {
			result.destroy();
			throw error;
		}
	},
	applyUpdate(doc, update, origin) {
		Y.applyUpdate(handle(doc).assertLive(), update, origin);
	},
	encodeStateVector(doc) {
		return Y.encodeStateVector(handle(doc).assertLive());
	},
	encodeStateAsUpdate(doc, vector) {
		return Y.encodeStateAsUpdate(handle(doc).assertLive(), vector);
	},
	mergeUpdates(updates) {
		return Y.mergeUpdates([...updates]);
	},
	documentStats(doc) {
		const value = handle(doc).assertLive();
		const encodedStateBytes = Y.encodeStateAsUpdate(value).byteLength;
		return { encodedStateBytes, ...census(value) };
	},
	readText(doc, name) {
		return Y.Text.prototype.toString.call(handle(doc).assertLive().getText(name));
	},
	insertText(doc, name, index, value, origin) {
		assertTextRange(index);
		handle(doc).assertLive().transact(() => handle(doc).assertLive().getText(name).insert(index, value), origin);
	},
	deleteText(doc, name, index, length, origin) {
		assertTextRange(index, length);
		handle(doc).assertLive().transact(() => handle(doc).assertLive().getText(name).delete(index, length), origin);
	},
	snapshotRoots(doc) {
		return yjsRootSnapshots(handle(doc).assertLive());
	},
	applyRootOperations(doc, operations, origin) {
		const value = handle(doc).assertLive();
		value.transact(() => {
			for (const operation of operations) applyYjsOperation(value, operation);
		}, origin);
	},
	destroyDocument(doc) {
		handle(doc).destroy();
	},
	memoryDiagnostics() {
		return null;
	},
};
