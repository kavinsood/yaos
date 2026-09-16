import type { CrdtValueSnapshot } from "./crdtEngine";
import type { YwasmCrdtDocument } from "./ywasmCrdtEngine";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";

function plainValue(snapshot: CrdtValueSnapshot): unknown {
	if (snapshot.shared !== "value") throw new Error("expected a plain CRDT map value");
	return snapshot.value;
}

/** Reads a root map into detached JavaScript values; no engine wrapper escapes. */
export function snapshotRootMap(doc: YwasmCrdtDocument, name: string): ReadonlyMap<string, unknown> {
	const root = crdtEngine.snapshotRoots(doc).find((candidate) => candidate.name === name);
	if (!root) return new Map();
	if (root.value.shared !== "map") throw new Error(`CRDT root ${name} is not a map`);
	return new Map(root.value.entries.map(([key, value]) => [key, plainValue(value)]));
}

export function mapValue(value: unknown): CrdtValueSnapshot {
	return { shared: "value", value };
}
