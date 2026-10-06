import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLAY_WINDOW } from "./limits";
import {
	REPLAY_BITS_BYTES,
	replayAccept,
	replayBitsFromBytes,
	replayBitsToBytes,
	replayCheck,
	replayWindowValid,
	type ReplayWindow,
} from "./replayWindow";

const B = (n: number | string) => BigInt(n);

/** Reference model: the set of accepted frameNos, judged against the highest. */
class SetModel {
	readonly seen = new Set<number>();
	r = 0;
	check(f: number): string {
		if (this.r === 0 || f > this.r) return "accept";
		if (f <= this.r - REPLAY_WINDOW) return "replay-stale";
		return this.seen.has(f) ? "replay-duplicate" : "accept";
	}
	accept(f: number): void {
		this.seen.add(f);
		this.r = Math.max(this.r, f);
	}
}

test("replayWindow: first frame, advance, in-window out of order, duplicate, stale edge", () => {
	assert.equal(replayCheck(undefined, 1), "accept");
	let w = replayAccept(undefined, 10);
	assert.deepEqual(w, { r: 10, bits: B(1) });
	assert.equal(replayCheck(w, 10), "replay-duplicate");
	assert.equal(replayCheck(w, 9), "accept", "below r, inside the window, unseen");
	w = replayAccept(w, 9);
	assert.deepEqual(w, { r: 10, bits: B(3) });
	w = replayAccept(w, 12);
	assert.deepEqual(w, { r: 12, bits: B(0b1101) });
	w = replayAccept(w, 12 + REPLAY_WINDOW - 1);
	assert.equal(w.r, 75);
	assert.equal(replayCheck(w, 12), "replay-duplicate", "r - 63 is the oldest frameNo in the window");
	assert.equal(replayCheck(w, 11), "replay-stale", "r - 64 is stale even though it was never seen");
	assert.equal(replayCheck(w, 13), "accept");
	// A jump of >= REPLAY_WINDOW clears the bitmap.
	w = replayAccept(w, 75 + REPLAY_WINDOW);
	assert.deepEqual(w, { r: 75 + REPLAY_WINDOW, bits: B(1) });
	for (const x of [w, { r: 1, bits: B(1) }, { r: 64, bits: (B(1) << B(63)) | B(1) }]) assert.ok(replayWindowValid(x));
});

test("replayWindow: validity rejects every non-canonical form", () => {
	const bad: [ReplayWindow, string][] = [
		[{ r: 0, bits: B(1) }, "r 0"],
		[{ r: 1.5, bits: B(1) }, "fractional r"],
		[{ r: 5, bits: B(2) }, "bit 0 clear"],
		[{ r: 5, bits: B(0b100001) }, "bit 5 = frameNo 0"],
		[{ r: 100, bits: B(1) << B(64) | B(1) }, "bit above the window"],
		[{ r: 100, bits: B(-1) }, "negative"],
	];
	for (const [w, why] of bad) assert.equal(replayWindowValid(w), false, why);
});

test("replayWindow: bitmap bytes are big-endian and round trip", () => {
	assert.equal(REPLAY_BITS_BYTES, 8);
	assert.deepEqual([...replayBitsToBytes(B(1))], [0, 0, 0, 0, 0, 0, 0, 1]);
	assert.deepEqual([...replayBitsToBytes((B(1) << B(63)) | B(0x0102))], [0x80, 0, 0, 0, 0, 0, 1, 2]);
	for (const v of [B(0), B(1), B("0xffffffffffffffff"), B("0x8000000000000001"), B("0x0123456789abcdef")]) {
		assert.equal(replayBitsFromBytes(replayBitsToBytes(v)), v);
	}
});

test("replayWindow: agrees with a set model on random streams (duplicates, reorder, jumps)", () => {
	let x = 0x2545f491;
	const rnd = () => {
		x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
		return (x >>> 0) / 4294967296;
	};
	for (let seed = 0; seed < 200; seed++) {
		const m = new SetModel();
		let w: ReplayWindow | undefined;
		let top = 0;
		for (let i = 0; i < 400; i++) {
			const roll = rnd();
			const f = roll < 0.5 ? top + 1 + Math.floor(rnd() * 3)
				: roll < 0.55 ? top + Math.floor(rnd() * 200)
				: Math.max(1, top - Math.floor(rnd() * (REPLAY_WINDOW + 8)));
			const got = replayCheck(w, f);
			assert.equal(got, m.check(f), `seed ${seed} step ${i} f ${f}`);
			if (got === "accept") {
				w = replayAccept(w, f);
				m.accept(f);
				top = Math.max(top, f);
				assert.ok(replayWindowValid(w));
			}
		}
	}
});
