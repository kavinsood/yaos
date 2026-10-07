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
	let r: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
	void p.then((value) => (r = { ok: true, value }), (error: unknown) => (r = { ok: false, error }));
	if (!(await advanceUntil(clock, () => r !== null, horizonMs))) throw new Error("settleWith: not settled within the horizon");
	const out = r as unknown as { ok: true; value: T } | { ok: false; error: unknown };
	if (!out.ok) throw out.error;
	return out.value;
}
