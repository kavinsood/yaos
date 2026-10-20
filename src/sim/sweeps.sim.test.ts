// Every seed of the sim matrices (testkit/sweep.ts), in chunks `npm run test:sim` runs in parallel processes.
// A matrix with a fault-hit check is one unit: the check holds over its whole sweep.
import { simTest } from "./testkit/simTest";
import { MATRICES, sweep } from "./testkit/sweep";

const CHUNK = 20;

for (const m of MATRICES) {
	const chunk = m.hits ? m.seeds : CHUNK;
	for (let first = 1; first <= m.seeds; first += chunk) {
		const n = Math.min(chunk, m.seeds - first + 1);
		simTest(`sim: ${m.name}, seeds ${first}..${first + n - 1}`, n * m.cost, () => sweep(m.name, m.base, n, first, m.hits));
	}
}
