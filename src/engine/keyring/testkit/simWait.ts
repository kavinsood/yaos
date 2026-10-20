/**
 * Test-only: a suite-1 sim run does real WebCrypto, which no virtual timer waits for (VirtualClock settles one
 * macrotask per timer). Advance virtual time in small steps with a short real wait between them, until `done`
 * holds or the horizon passes.
 */

import type { VirtualClock } from "../../../sim/clock";

export async function advanceUntil(clock: VirtualClock, done: () => boolean, horizonMs: number, stepMs = 50): Promise<boolean> {
	for (let t = 0; t <= horizonMs; t += stepMs) {
		if (done()) return true;
		await new Promise((r) => setTimeout(r, 1));
		await clock.advance(stepMs);
	}
	return done();
}

/** Settles a promise driven by the virtual clock and real WebCrypto. */
export async function settleWith<T>(clock: VirtualClock, p: Promise<T>, horizonMs = 30_000): Promise<T> {
	// A box, not a `let`: control flow would narrow a local assigned only inside the callbacks to `null` for good.
	const box: { r: { ok: true; value: T } | { ok: false; error: unknown } | null } = { r: null };
	void p.then((value) => (box.r = { ok: true, value }), (error: unknown) => (box.r = { ok: false, error }));
	if (!(await advanceUntil(clock, () => box.r !== null, horizonMs))) throw new Error("settleWith: not settled within the horizon");
	const out = box.r;
	if (out === null) throw new Error("settleWith: not settled within the horizon");
	if (!out.ok) throw out.error;
	return out.value;
}
