/**
 * Per-(deviceId, stream) anti-replay window over frameNo (e2ee-design §8.2,
 * RFC 4303 §3.4.3). Shared by the ns and cfg folds. Pure and deterministic.
 *
 * State: right edge `r` (highest accepted frameNo) and a REPLAY_WINDOW-bit
 * bitmap where bit i records frameNo r − i (bit 0 is r itself, always set).
 * Bits for frameNos < 1 are always clear, so the canonical form is unique.
 *
 * BigInt is built with BigInt(...) calls, not `1n` literals: the bundle
 * targets ES2018 (esbuild.config.mjs), which rejects bigint literals.
 */

import { REPLAY_WINDOW } from "./limits";
import type { DeviceId, ReplayWindow } from "./types";

export type { ReplayWindow };

export type ReplayState = Map<DeviceId, ReplayWindow>;

export type ReplayVerdict = "accept" | "replay-stale" | "replay-duplicate";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const W = BigInt(REPLAY_WINDOW);
const MASK = (ONE << W) - ONE;
/** Bytes of an encoded bitmap. */
export const REPLAY_BITS_BYTES = REPLAY_WINDOW / 8;

/** Verdict for an authenticated frame with frameNo f ≥ 1. Does not change the window. */
export function replayCheck(w: ReplayWindow | undefined, f: number): ReplayVerdict {
	if (!w) return "accept";
	if (f > w.r) return "accept";
	if (f <= w.r - REPLAY_WINDOW) return "replay-stale";
	return (w.bits >> BigInt(w.r - f)) & ONE ? "replay-duplicate" : "accept";
}

/** Window after accepting f (call only when replayCheck said "accept"). */
export function replayAccept(w: ReplayWindow | undefined, f: number): ReplayWindow {
	if (!w) return { r: f, bits: ONE };
	if (f > w.r) {
		const shift = f - w.r;
		return { r: f, bits: shift >= REPLAY_WINDOW ? ONE : ((w.bits << BigInt(shift)) | ONE) & MASK };
	}
	return { r: w.r, bits: w.bits | (ONE << BigInt(w.r - f)) };
}

/**
 * Byte-level validity of a decoded window: r ≥ 1, bit 0 set, no bit for a
 * frameNo < 1, and nothing above the window.
 */
export function replayWindowValid(w: ReplayWindow): boolean {
	if (!Number.isSafeInteger(w.r) || w.r < 1) return false;
	if (w.bits < ZERO || w.bits > MASK || (w.bits & ONE) !== ONE) return false;
	return w.r >= REPLAY_WINDOW || w.bits >> BigInt(w.r) === ZERO;
}

/** Big-endian REPLAY_BITS_BYTES bytes. */
export function replayBitsToBytes(bits: bigint): Uint8Array {
	const out = new Uint8Array(REPLAY_BITS_BYTES);
	let b = bits;
	for (let i = REPLAY_BITS_BYTES - 1; i >= 0; i--) {
		out[i] = Number(b & BigInt(0xff));
		b >>= BigInt(8);
	}
	return out;
}

export function replayBitsFromBytes(bytes: Uint8Array): bigint {
	let b = ZERO;
	for (const x of bytes) b = (b << BigInt(8)) | BigInt(x);
	return b;
}

export function cloneReplay(m: ReadonlyMap<DeviceId, ReplayWindow>): ReplayState {
	return new Map(m);
}
