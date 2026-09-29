// Relay v2 spike (D4): byte-level Yjs update ops for the relay hot path,
// without importing JS `yjs` on the server (scripts/guard-server-crdt-imports.mjs).
//
// Two ywasm-backed implementations share one interface:
//   - ywasmStatelessByteOps   (option c): patch 0003 exports from the pinned
//     ywasm artifact (yrs merge_updates_v1 / encode_state_vector_from_update_v1 /
//     diff_updates_v1). No Doc is ever created.
//   - ywasmTransientDocByteOps (option a): merge via mergeUpdatesV1; SV and diff
//     via a transient ywasm doc (apply → encode → destroy/free).
//
// Both run on the same Wasm instance the CRDT engine uses: the Worker build gets
// the vendored `ywasm.mjs` module; the Node host / tests get the pinned CJS
// artifact via the existing `ywasmWorkerCrdtEngine` → `ywasmNodeCrdtEngine` alias.
import * as engineModule from "./ywasmWorkerCrdtEngine";

/** V1-encoded update of an empty document (what JS yjs `mergeUpdates([])` returns). */
export const EMPTY_UPDATE_V1: Uint8Array = Uint8Array.of(0, 0);

export interface ByteOps {
	readonly name: string;
	/** Merge V1 updates into one V1 update. `[]` → `[0,0]`. */
	mergeUpdates(updates: readonly Uint8Array[]): Uint8Array;
	/** V1 state vector covered by a V1 update. */
	stateVectorFromUpdate(update: Uint8Array): Uint8Array;
	/** Part of `update` not covered by `stateVector` (V1 in, V1 out). */
	diffUpdate(update: Uint8Array, stateVector: Uint8Array): Uint8Array;
}

/** Subset of the patched ywasm bindings (patch 0003) used by option (c). */
export interface YwasmStatelessBindings {
	mergeUpdatesV1(updates: Array<Uint8Array>): Uint8Array;
	encodeStateVectorFromUpdateV1(update: Uint8Array): Uint8Array;
	diffUpdateV1(update: Uint8Array, stateVector: Uint8Array): Uint8Array;
}

type EngineModule = {
	ywasmCrdtEngine: typeof engineModule.ywasmCrdtEngine;
	ywasmBindings?: unknown;
};

const engine = (engineModule as EngineModule).ywasmCrdtEngine;

function mergeWith(merge: (updates: Array<Uint8Array>) => Uint8Array, updates: readonly Uint8Array[]): Uint8Array {
	if (updates.length === 0) return EMPTY_UPDATE_V1.slice();
	return merge([...updates]);
}

let transientCounter = 0;

/** Option (a): transient ywasm doc per SV/diff call; merge is already stateless in ywasm. */
export const ywasmTransientDocByteOps: ByteOps = {
	name: "ywasm-transient-doc",
	mergeUpdates(updates) {
		return mergeWith((list) => engine.mergeUpdates(list), updates);
	},
	stateVectorFromUpdate(update) {
		const doc = engine.openDocument(`yaos-byteops-sv-${transientCounter++}`, update);
		try {
			return engine.encodeStateVector(doc);
		} finally {
			engine.destroyDocument(doc);
		}
	},
	diffUpdate(update, stateVector) {
		const doc = engine.openDocument(`yaos-byteops-diff-${transientCounter++}`, update);
		try {
			return engine.encodeStateAsUpdate(doc, stateVector);
		} finally {
			engine.destroyDocument(doc);
		}
	},
};

/** Builds option (c) around any bindings object carrying the patch-0003 exports. */
export function createYwasmStatelessByteOps(bindings: YwasmStatelessBindings): ByteOps {
	return {
		name: "ywasm-stateless",
		mergeUpdates(updates) {
			return mergeWith((list) => bindings.mergeUpdatesV1(list), updates);
		},
		stateVectorFromUpdate(update) {
			return bindings.encodeStateVectorFromUpdateV1(update);
		},
		diffUpdate(update, stateVector) {
			return bindings.diffUpdateV1(update, stateVector);
		},
	};
}

function statelessBindings(): YwasmStatelessBindings | null {
	const candidate = (engineModule as EngineModule).ywasmBindings as Partial<YwasmStatelessBindings> | undefined;
	if (!candidate || typeof candidate.encodeStateVectorFromUpdateV1 !== "function"
		|| typeof candidate.diffUpdateV1 !== "function" || typeof candidate.mergeUpdatesV1 !== "function") {
		return null;
	}
	return candidate as YwasmStatelessBindings;
}

const resolvedStateless = statelessBindings();

/** True when the loaded ywasm artifact carries patch 0003 (option c available). */
export const ywasmStatelessByteOpsAvailable = resolvedStateless !== null;

/**
 * Option (c). Throws on use if the loaded artifact predates patch 0003; callers that
 * want graceful degradation should use `defaultYwasmByteOps`.
 */
export const ywasmStatelessByteOps: ByteOps = resolvedStateless
	? createYwasmStatelessByteOps(resolvedStateless)
	: {
		name: "ywasm-stateless(unavailable)",
		mergeUpdates() { throw new Error("ywasm artifact lacks patch 0003-byte-level-update-ops"); },
		stateVectorFromUpdate() { throw new Error("ywasm artifact lacks patch 0003-byte-level-update-ops"); },
		diffUpdate() { throw new Error("ywasm artifact lacks patch 0003-byte-level-update-ops"); },
	};

/** Preferred backend: (c) when available, else (a). */
export const defaultYwasmByteOps: ByteOps = resolvedStateless ? ywasmStatelessByteOps : ywasmTransientDocByteOps;

export function mergeUpdates(updates: readonly Uint8Array[], ops: ByteOps = defaultYwasmByteOps): Uint8Array {
	return ops.mergeUpdates(updates);
}

export function stateVectorFromUpdate(update: Uint8Array, ops: ByteOps = defaultYwasmByteOps): Uint8Array {
	return ops.stateVectorFromUpdate(update);
}

export function diffUpdate(update: Uint8Array, stateVector: Uint8Array, ops: ByteOps = defaultYwasmByteOps): Uint8Array {
	return ops.diffUpdate(update, stateVector);
}

/** Current ywasm linear memory high-water mark in bytes (Wasm memory never shrinks). */
export function ywasmLinearMemoryBytes(): number {
	return engine.memoryDiagnostics()?.linearMemoryBytes ?? 0;
}

// --- state vector helpers (lib0 V1: varuint count, then (client varuint, clock varuint)*) ---

function readVarUint(bytes: Uint8Array, cursor: { pos: number }): number {
	let result = 0;
	let multiplier = 1;
	for (;;) {
		if (cursor.pos >= bytes.length) throw new RangeError("truncated varuint in state vector");
		const byte = bytes[cursor.pos++]!;
		result += (byte & 0x7f) * multiplier;
		if (byte < 0x80) return result;
		multiplier *= 128;
		if (multiplier > 2 ** 53) throw new RangeError("varuint overflow in state vector");
	}
}

/** Decodes a V1 state vector into client → clock. Zero clocks are dropped (semantically absent). */
export function decodeStateVector(stateVector: Uint8Array): Map<number, number> {
	const cursor = { pos: 0 };
	const result = new Map<number, number>();
	if (stateVector.length === 0) return result;
	const count = readVarUint(stateVector, cursor);
	for (let index = 0; index < count; index++) {
		const client = readVarUint(stateVector, cursor);
		const clock = readVarUint(stateVector, cursor);
		if (clock > 0) result.set(client, clock);
	}
	return result;
}

/** Semantic SV equality (map equality); encoders may order clients differently. */
export function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
	const left = decodeStateVector(a);
	const right = decodeStateVector(b);
	if (left.size !== right.size) return false;
	for (const [client, clock] of left) if (right.get(client) !== clock) return false;
	return true;
}

/** True when every clock in `a` is <= the matching clock in `b`. */
export function stateVectorCoveredBy(a: Uint8Array, b: Uint8Array): boolean {
	const right = decodeStateVector(b);
	for (const [client, clock] of decodeStateVector(a)) if ((right.get(client) ?? 0) < clock) return false;
	return true;
}
