// Replays every committed minimized plan in this directory (see README.md) and asserts no violations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSim, type SimConfig, type Step } from "../run";

interface Artifact {
	readonly config: SimConfig;
	readonly minimizedPlan: readonly Step[];
	readonly violations?: readonly { inv: string; detail: string }[];
}

const DIR = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

for (const f of files) {
	test(`sim regression: ${f}`, async () => {
		const a = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Artifact;
		assert.ok(a.config && Array.isArray(a.minimizedPlan), `${f}: needs config and minimizedPlan`);
		const r = await runSim(a.config, a.minimizedPlan);
		assert.deepEqual(r.violations.map((v) => `${v.inv}: ${v.detail}`), [], `${f}: was ${JSON.stringify(a.violations?.map((v) => v.inv) ?? [])}`);
	});
}
