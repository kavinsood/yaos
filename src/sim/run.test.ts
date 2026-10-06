// Simulation suite (DESIGN §l) over the composed engine and SimRelay. Seeds: YAOS_SIM_SEEDS (default 200, the CI count).
// A failure prints the seed, its violations and a ddmin-minimized plan to replay with runSim(cfg, plan).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlan, minimizePlan, runSim, type SimConfig, type SimReport, type Step } from "./run";
import { DEFAULT_FAULTS } from "./faults";
import { checkConvergence, checkNothingDestroyed, checkTokens } from "./invariants";
import { TokenLedger } from "./actors";
import { SimDevice } from "./device";
import { SimNet } from "./net";
import { VirtualClock } from "./clock";
import type { DocId, VaultPath } from "../core/types";

const SEEDS = Math.max(1, Number(process.env.YAOS_SIM_SEEDS ?? 200) || 200);

async function sweep(name: string, base: Omit<SimConfig, "seed">, seeds: number, first = 1): Promise<void> {
	const failed: SimReport[] = [];
	let tokens = 0;
	for (let seed = first; seed < first + seeds; seed++) {
		const r = await runSim({ ...base, seed });
		tokens += r.stats.tokens.live;
		if (r.violations.length > 0) failed.push(r);
	}
	if (failed.length === 0) {
		assert.ok(tokens > seeds * 10, `${name}: the actors did real work (${tokens} live tokens)`);
		return;
	}
	const r0 = failed[0] as SimReport;
	const cfg = { ...base, seed: r0.seed };
	const needle = r0.violations[0]?.detail ?? "";
	const m = await minimizePlan(cfg, r0.plan, (r) => r.violations.some((v) => v.detail === needle), 150);
	assert.fail(
		`${name}: ${failed.length}/${seeds} seeds failed: ${failed.map((r) => r.seed).join(",")}\n` +
			`seed ${r0.seed}:\n  ${r0.violations.slice(0, 6).map((v) => `${v.inv}: ${v.detail}`).join("\n  ")}\n` +
			`minimized (${m.plan.length} steps, cfg ${JSON.stringify({ ...cfg, faults: cfg.faults ? "DEFAULT_FAULTS" : null })}):\n${JSON.stringify(m.plan)}`,
	);
}

const CHUNK = 50;
function chunked(name: string, base: Omit<SimConfig, "seed">, seeds: number): void {
	for (let first = 1; first <= seeds; first += CHUNK) {
		const n = Math.min(CHUNK, seeds - first + 1);
		test(`sim: ${name}, seeds ${first}..${first + n - 1}`, async () => sweep(name, base, n, first));
	}
}

chunked("2 devices, no faults", { devices: 2, faults: null }, SEEDS);
chunked("3 devices, seeded faults", { devices: 3, faults: DEFAULT_FAULTS }, SEEDS);
chunked("5 devices, seeded faults", { devices: 5, faults: DEFAULT_FAULTS }, Math.max(1, Math.ceil(SEEDS / 4)));
chunked("2 devices, fault-heavy", { devices: 2, faults: DEFAULT_FAULTS, faultRate: 0.35 }, Math.max(1, Math.ceil(SEEDS / 4)));

test("sim: same seed, same plan, same trace and same converged bytes (seeded Yjs clientIDs)", async () => {
	const cfg: SimConfig = { seed: 4242, devices: 3, faults: DEFAULT_FAULTS };
	assert.deepEqual(generatePlan(cfg), generatePlan(cfg));
	const a = await runSim(cfg);
	const b = await runSim(cfg);
	assert.equal(a.seededEntropy, true, "Y.Doc clientIDs come from the seed");
	assert.deepEqual(a.trace, b.trace);
	assert.equal(a.digest, b.digest);
	assert.deepEqual(a.violations, []);
	const c = await runSim({ ...cfg, seed: 4243 });
	assert.notEqual(c.digest, a.digest);
});

test("sim: an explicit plan replays the generated run exactly", async () => {
	const cfg: SimConfig = { seed: 77, devices: 2, faults: DEFAULT_FAULTS };
	const a = await runSim(cfg);
	const b = await runSim(cfg, a.plan);
	assert.equal(b.digest, a.digest);
});

test("sim: ddmin reduces a plan to the steps a failure needs", async () => {
	const cfg: SimConfig = { seed: 5, devices: 2, faults: null, steps: 60 };
	const plan = generatePlan(cfg);
	const wanted = [plan[11]?.i, plan[40]?.i];
	const has = (p: readonly Step[]) => wanted.every((i) => p.some((s) => s.i === i));
	const m = await minimizePlan(cfg, plan, (r) => has(r.plan), 200);
	assert.deepEqual(m.plan.map((s) => s.i), wanted);
	assert.ok(m.runs < 200, `${m.runs} runs`);
});

// --- invariant self-tests: the checks must catch what they claim to catch ---------------------

function twoDevices(): { clock: VirtualClock; net: SimNet; a: SimDevice; b: SimDevice } {
	const clock = new VirtualClock();
	const net = new SimNet(clock, { linkMs: 10 });
	return { clock, net, a: new SimDevice({ name: "A", clock, net }), b: new SimDevice({ name: "B", clock, net }) };
}

test("invariants: divergent bytes, a missing file and a doc that never reached the relay are reported", () => {
	const { a, b } = twoDevices();
	a.vault.userWrite("x.md", "one [A.1]\n");
	b.vault.userWrite("x.md", "one [A.1]\nextra\n");
	a.vault.userWrite("only-a.md", "a\n");
	const v = checkConvergence([a, b], { docs: [{ docId: "d1" as DocId, path: "ghost.md" as VaultPath, kind: "markdown", text: "boo" }], error: null }).map((x) => x.detail);
	assert.ok(v.some((d) => d.startsWith("x.md differs")), JSON.stringify(v));
	assert.ok(v.some((d) => d === "only-a.md on A, missing on B"), JSON.stringify(v));
	assert.ok(v.some((d) => d === "x.md never reached the relay"), JSON.stringify(v));
	assert.ok(v.some((d) => d === "relay doc ghost.md has no file"), JSON.stringify(v));
});

test("invariants: a lost live token and a destroyed version are reported; deleted tokens are exempt", () => {
	const { a, b } = twoDevices();
	const ledger = new TokenLedger();
	ledger.add("[A.1]", "A", 1, "type");
	ledger.add("[A.2]", "A", 2, "type");
	ledger.add("[A.3]", "A", 3, "type");
	a.vault.userWrite("x.md", "[A.1] [A.2] [A.3]\n");
	b.vault.userWrite("x.md", "[A.1] [A.2] [A.3]\n");
	a.vault.userWrite("x.md", "[A.1]\n");
	b.vault.userWrite("x.md", "[A.1]\n");
	ledger.deleted("[A.3]");
	assert.deepEqual(checkTokens([a, b], ledger).map((v) => v.detail), ["lost [A.2] (type on A at step 2)"]);
	assert.deepEqual(checkNothingDestroyed([a, b], ledger).map((v) => v.detail), ["[A.2] was on A:x.md (user) and is gone"]);
});

test("invariants: tokens Obsidian clobbered (editor save over an unseen external write) are exempt", () => {
	const { a, b } = twoDevices();
	const ledger = new TokenLedger();
	ledger.add("[B.9]", "B", 9, "disk-external");
	a.vault.userWrite("x.md", "base\n");
	a.vault.externalWrite("x.md", "base [B.9]\n");
	assert.equal(a.vault.editorSave("x.md", "base edited\n"), true);
	b.vault.userWrite("x.md", "base edited\n");
	assert.equal(a.vault.clobbered.length, 1);
	assert.deepEqual(checkTokens([a, b], ledger), []);
	assert.deepEqual(checkNothingDestroyed([a, b], ledger), []);
});

test("invariants: tokens must be contiguous; a crash-lost pending conflict copy is exempt from 'destroyed'", () => {
	const { a, b } = twoDevices();
	const ledger = new TokenLedger();
	ledger.add("[A.15]", "A", 15, "disk-external");
	ledger.add("[A.1]", "A", 1, "type");
	ledger.add("[A.53]", "A", 53, "disk-external");
	ledger.add("[B.23]", "B", 23, "type");
	a.vault.userWrite("x.md", "seed A.15] [A.1]\n[A.[B.23] 53]\n"); // a lost bracket; a concurrent token inside another
	b.vault.userWrite("x.md", "seed A.15] [A.1]\n[A.[B.23] 53]\n");
	assert.deepEqual(checkTokens([a, b], ledger).map((v) => v.detail), [
		"lost [A.15] (disk-external on A at step 15)",
		"lost [A.53] (disk-external on A at step 53)",
	], "[A.1] is not a prefix match of [A.15]; [B.23] is whole");
	a.vault.externalWrite("y.md", "other [A.36]\n");
	a.vault.userWrite("y.md", "other\n");
	b.vault.userWrite("y.md", "other\n");
	assert.deepEqual(checkNothingDestroyed([a, b], ledger).map((v) => v.detail), ["[A.36] was on A:y.md (external) and is gone"]);
	a.crashLost.push("other [A.36]\n");
	assert.deepEqual(checkNothingDestroyed([a, b], ledger), []);
});
