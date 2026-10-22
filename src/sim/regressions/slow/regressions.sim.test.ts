// Replays the slow committed minimized plans (see ../README.md "Slow plans") under `npm run test:sim`, one simTest unit
// per plan, and asserts no violations. ../regressions.test.ts reads only its own directory, so these stay out of
// `npm run test:client`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSim, type SimConfig, type Step } from "../../run";
import { simTest } from "../../testkit/simTest";

interface Artifact {
	readonly config: SimConfig;
	readonly minimizedPlan: readonly Step[];
	readonly violations?: readonly { inv: string; detail: string }[];
}

const DIR = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

for (const f of files) {
	// Cost in rough seconds of one core (scripts/sim-test.mjs orders units by it): every plan here is a slow one.
	simTest(`sim regression (slow): ${f}`, 150, async () => {
		const a = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Artifact;
		assert.ok(a.config && Array.isArray(a.minimizedPlan), `${f}: needs config and minimizedPlan`);
		const r = await runSim(a.config, a.minimizedPlan);
		assert.deepEqual(r.violations.map((v) => `${v.inv}: ${v.detail}`), [], `${f}: was ${JSON.stringify(a.violations?.map((v) => v.inv) ?? [])}`);
	});
}
