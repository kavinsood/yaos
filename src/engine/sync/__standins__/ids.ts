/**
 * STAND-IN for WP-A id helpers. Replace at integration.
 * docId / clientFrameId: 16 random bytes, base64url without padding (22 chars).
 */

import type { RandomPort } from "../../../ports/random";
import type { ClientFrameId, DocId } from "../../../core/types";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64url(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 3 <= bytes.length; i += 3) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
		out += (B64URL[(n >> 18) & 63] as string) + (B64URL[(n >> 12) & 63] as string) + (B64URL[(n >> 6) & 63] as string) + (B64URL[n & 63] as string);
	}
	const rem = bytes.length - i;
	if (rem === 1) {
		const n = (bytes[i] as number) << 16;
		out += (B64URL[(n >> 18) & 63] as string) + (B64URL[(n >> 12) & 63] as string);
	} else if (rem === 2) {
		const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
		out += (B64URL[(n >> 18) & 63] as string) + (B64URL[(n >> 12) & 63] as string) + (B64URL[(n >> 6) & 63] as string);
	}
	return out;
}

export const ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function isId(s: string): boolean {
	return ID_RE.test(s);
}

export function newId(random: RandomPort): string {
	return base64url(random.bytes(16));
}
export function newDocId(random: RandomPort): DocId {
	return newId(random) as DocId;
}
export function newFrameId(random: RandomPort): ClientFrameId {
	return newId(random) as ClientFrameId;
}
