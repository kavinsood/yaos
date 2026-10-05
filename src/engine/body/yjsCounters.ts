/**
 * Counted wrappers for the O(doc) Yjs calls. All engine code goes through
 * these (a grep test enforces it), so the frame-builder benchmark can assert
 * that typing never encodes full state (DESIGN §d.3, §k.3 WP-C).
 */

import * as Y from "yjs";

export const yjsCounters = {
	encodeStateAsUpdate: 0,
	/** Y.mergeUpdates over small outbox batches only (DESIGN §d.4). */
	mergeUpdates: 0,
	mergeUpdatesInputs: 0,
};

export function resetYjsCounters(): void {
	yjsCounters.encodeStateAsUpdate = 0;
	yjsCounters.mergeUpdates = 0;
	yjsCounters.mergeUpdatesInputs = 0;
}

export function encodeStateAsUpdate(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
	yjsCounters.encodeStateAsUpdate++;
	return Y.encodeStateAsUpdate(doc, stateVector);
}

/** Small batches only: the frame builder's buffered updates of one open frame. */
export function mergeSmallBatch(updates: readonly Uint8Array[]): Uint8Array {
	if (updates.length === 1) return updates[0]!;
	yjsCounters.mergeUpdates++;
	yjsCounters.mergeUpdatesInputs += updates.length;
	return Y.mergeUpdates(updates as Uint8Array[]);
}

/** Origin tags (DESIGN §d intro). */
export const ORIGIN = {
	MAIN: Symbol("yaos.main"),
	REMOTE: Symbol("yaos.remote"),
	MERGE: Symbol("yaos.merge"),
	LOAD: Symbol("yaos.load"),
	/** Initial content of a new doc (frames are built explicitly, not by the builder). */
	INITIAL: Symbol("yaos.initial"),
} as const;
