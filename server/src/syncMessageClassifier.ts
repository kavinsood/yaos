import * as decoding from "lib0/decoding";

// y-partyserver outer message types.
const MESSAGE_SYNC = 0;

// y-protocols/sync inner message types. Keep in sync with:
// messageYjsSyncStep1 = 0, messageYjsSyncStep2 = 1, messageYjsUpdate = 2.
// Covered by tests/server-sync-message-classifier.ts, which builds real
// y-protocol frames so these local constants do not silently drift.
const MESSAGE_YJS_SYNC_STEP_1 = 0;
const MESSAGE_YJS_SYNC_STEP_2 = 1;
const MESSAGE_YJS_UPDATE = 2;

function asUint8Array(message: unknown): Uint8Array | null {
	if (message instanceof Uint8Array) return message;
	if (message instanceof ArrayBuffer) return new Uint8Array(message);
	if (ArrayBuffer.isView(message)) {
		return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
	}
	return null;
}

/**
 * Returns true only for y-partyserver sync frames whose inner y-protocols
 * message may carry document update state. The later server echo path uses
 * this as a conservative trigger; the client state-vector dominance check is
 * still the truth gate.
 */
export function isUpdateBearingSyncMessage(message: unknown): boolean {
	const bytes = asUint8Array(message);
	if (!bytes) return false;

	try {
		const decoder = decoding.createDecoder(bytes);
		const outerType = decoding.readVarUint(decoder);
		if (outerType !== MESSAGE_SYNC) return false;

		const innerType = decoding.readVarUint(decoder);
		return innerType === MESSAGE_YJS_SYNC_STEP_2 || innerType === MESSAGE_YJS_UPDATE;
	} catch {
		return false;
	}
}
