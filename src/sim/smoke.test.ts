// The first seeds of every sim matrix (testkit/sweep.ts) in `npm run test:client`; every seed runs in
// `npm run test:sim` (sweeps.sim.test.ts).
import { test } from "node:test";
import { MATRICES, sweep } from "./testkit/sweep";

for (const m of MATRICES) {
	const n = Math.min(m.smoke, m.seeds);
	if (n === 0) continue; // test:sim only
	test(`sim smoke: ${m.name}, seeds 1..${n}`, () => sweep(m.name, m.base, n, 1));
}
