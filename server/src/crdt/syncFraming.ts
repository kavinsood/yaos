import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { CrdtDocument, CrdtEngine } from "./crdtEngine";

export const SYNC_STEP_1 = 0;
export const SYNC_STEP_2 = 1;
export const SYNC_UPDATE = 2;

export type DecodedSyncMessage =
	| { readonly kind: "step-1"; readonly stateVector: Uint8Array }
	| { readonly kind: "step-2"; readonly update: Uint8Array }
	| { readonly kind: "update"; readonly update: Uint8Array };

/** Y-protocol sync framing over an engine-produced state vector. */
export function writeSyncStep1<Doc extends CrdtDocument>(
	encoder: encoding.Encoder,
	engine: CrdtEngine<Doc>,
	doc: Doc,
): void {
	encoding.writeVarUint(encoder, SYNC_STEP_1);
	encoding.writeVarUint8Array(encoder, engine.encodeStateVector(doc));
}

/** Y-protocol sync framing over the update missing from a peer state vector. */
export function writeSyncStep2<Doc extends CrdtDocument>(
	encoder: encoding.Encoder,
	engine: CrdtEngine<Doc>,
	doc: Doc,
	peerStateVector: Uint8Array,
): void {
	encoding.writeVarUint(encoder, SYNC_STEP_2);
	encoding.writeVarUint8Array(encoder, engine.encodeStateAsUpdate(doc, peerStateVector));
}

/** Y-protocol notification framing; update bytes remain engine-independent. */
export function writeSyncUpdate(encoder: encoding.Encoder, update: Uint8Array): void {
	encoding.writeVarUint(encoder, SYNC_UPDATE);
	encoding.writeVarUint8Array(encoder, update);
}

/** Decode only the inner sync message. The caller owns the outer message tag. */
export function readSyncMessage(decoder: decoding.Decoder): DecodedSyncMessage {
	const type = decoding.readVarUint(decoder);
	const bytes = decoding.readVarUint8Array(decoder);
	if (type === SYNC_STEP_1) return { kind: "step-1", stateVector: bytes };
	if (type === SYNC_STEP_2) return { kind: "step-2", update: bytes };
	if (type === SYNC_UPDATE) return { kind: "update", update: bytes };
	throw new Error(`unsupported sync message ${type}`);
}
