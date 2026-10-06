/** RandomPort over crypto.getRandomValues. */

import type { RandomPort } from "../../ports/random";

/** getRandomValues fills at most 65536 bytes per call. */
const MAX_FILL = 65536;

export function createWebRandom(source: Pick<Crypto, "getRandomValues"> = crypto): RandomPort {
	return {
		bytes(length) {
			const out = new Uint8Array(length);
			for (let i = 0; i < length; i += MAX_FILL) source.getRandomValues(out.subarray(i, Math.min(length, i + MAX_FILL)));
			return out;
		},
		float() {
			const words = new Uint32Array(2);
			source.getRandomValues(words);
			// 53 random bits -> [0, 1).
			const hi = (words[0] ?? 0) >>> 5;
			const lo = (words[1] ?? 0) >>> 6;
			return (hi * 67108864 + lo) / 9007199254740992;
		},
	};
}
