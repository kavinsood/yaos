// Simulation suite (DESIGN §l) over the composed engine and SimRelay. Seeds: YAOS_SIM_SEEDS (default 200, the CI count).
// A failure prints the seed, its violations and a ddmin-minimized plan to replay with runSim(cfg, plan).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlan, minimizePlan, runSim, type SimConfig, type SimReport, type Step } from "./run";
import { BLOB_FAULTS, CANVAS_FAULTS, DEFAULT_FAULTS } from "./faults";
import type { SimBlobLiveness } from "./blobStore";
import { checkCanvas, checkConvergence, checkNothingDestroyed, checkTokens } from "./invariants";
import { ABSENT, CANVAS_HOT_OPS, CanvasOracle, type FieldWrite } from "./canvas";
import { runUserAction, TokenLedger } from "./actors";
import { SimDevice } from "./device";
import { SimNet } from "./net";
import { VirtualClock } from "./clock";
import type { DocId, VaultPath } from "../core/types";

const SEEDS = Math.max(1, Number(process.env.YAOS_SIM_SEEDS ?? 200) || 200);

/** Asserts the matrix's faults hit what they target, over its clean runs' stats. */
type Hits = (name: string, stats: readonly SimReport["stats"][]) => void;

async function sweep(name: string, base: Omit<SimConfig, "seed">, seeds: number, first = 1, hits?: Hits): Promise<void> {
	const failed: SimReport[] = [];
	const stats: SimReport["stats"][] = [];
	let tokens = 0;
	for (let seed = first; seed < first + seeds; seed++) {
		const r = await runSim({ ...base, seed });
		tokens += r.stats.tokens.live;
		stats.push(r.stats);
		if (r.violations.length > 0) failed.push(r);
	}
	if (failed.length === 0) {
		assert.ok(tokens > seeds * 10, `${name}: the actors did real work (${tokens} live tokens)`);
		hits?.(name, stats);
		return;
	}
	const r0 = failed[0] as SimReport;
	const cfg = { ...base, seed: r0.seed };
	const needle = r0.violations[0]?.detail ?? "";
	const m = await minimizePlan(cfg, r0.plan, (r) => r.violations.some((v) => v.detail === needle), 150);
	assert.fail(
		`${name}: ${failed.length}/${seeds} seeds failed: ${failed.map((r) => r.seed).join(",")}\n` +
			`seed ${r0.seed}:\n  ${r0.violations.slice(0, 6).map((v) => `${v.inv}: ${v.detail}`).join("\n  ")}\n` +
			`minimized (${m.plan.length} steps, cfg ${JSON.stringify({ ...cfg, faults: cfg.faults === BLOB_FAULTS ? "BLOB_FAULTS" : cfg.faults === CANVAS_FAULTS ? "CANVAS_FAULTS" : cfg.faults ? "DEFAULT_FAULTS" : null })}):\n${JSON.stringify(m.plan)}`,
	);
}

const CHUNK = 50;
function chunked(name: string, base: Omit<SimConfig, "seed">, seeds: number, hits?: Hits): void {
	for (let first = 1; first <= seeds; first += CHUNK) {
		const n = Math.min(CHUNK, seeds - first + 1);
		test(`sim: ${name}, seeds ${first}..${first + n - 1}`, async () => sweep(name, base, n, first, hits));
	}
}

/** The blob store faults reached real transfers: stalls caught calls, both ends fired, slow calls completed. */
const blobHits: Hits = (name, stats) => {
	const sum = (f: (b: SimBlobLiveness) => number) => stats.reduce((n, s) => n + f(s.blobs), 0);
	const got = {
		stalled: sum((b) => b.stalled.has + b.stalled.put + b.stalled.get), stalledPut: sum((b) => b.stalled.put),
		watchdog: sum((b) => b.watchdog), aborted: sum((b) => b.aborted), slowDone: sum((b) => b.slowDone), slowCut: sum((b) => b.slowCut),
	};
	const ok = got.stalled > 0 && got.stalledPut > 0 && got.watchdog > 0 && got.aborted > 0 && got.slowDone > 0 && got.slowCut === 0;
	assert.ok(ok, `${name}: the blob faults hit transfers ${JSON.stringify(got)}`);
};

chunked("2 devices, no faults", { devices: 2, faults: null }, SEEDS);
chunked("3 devices, seeded faults", { devices: 3, faults: DEFAULT_FAULTS }, SEEDS);
chunked("5 devices, seeded faults", { devices: 5, faults: DEFAULT_FAULTS }, Math.max(1, Math.ceil(SEEDS / 4)));
chunked("2 devices, fault-heavy", { devices: 2, faults: DEFAULT_FAULTS, faultRate: 0.35 }, Math.max(1, Math.ceil(SEEDS / 4)));
chunked("3 devices, blob stall/slow faults", { devices: 3, faults: BLOB_FAULTS, faultRate: 0.3 }, Math.max(1, Math.ceil(SEEDS / 10)), blobHits);

/** The hot canvas matrix reached the merge paths it exists for: real 3-way merges, conflicts, broken saves, checkpoints. */
const canvasHits: Hits = (name, stats) => {
	const sum = (f: (s: SimReport["stats"]) => number) => stats.reduce((n, s) => n + f(s), 0);
	const got = {
		actions: sum((s) => s.canvas.actions), divergent: sum((s) => s.canvas.merges.divergent), conflict: sum((s) => s.canvas.merges.conflict),
		invalid: sum((s) => s.canvas.invalidNotices), written: sum((s) => s.checkpoints.put.canvas?.ok ?? 0), adopted: sum((s) => s.checkpoints.adopted.canvas ?? 0),
	};
	const ok = got.actions > stats.length * 50 && got.divergent > 0 && got.conflict > 0 && got.invalid > 0 && got.written > 0 && got.adopted > 0;
	assert.ok(ok, `${name}: the canvas actions hit the merge paths ${JSON.stringify(got)}`);
};
const HOT_CANVAS = { rate: 3, ops: CANVAS_HOT_OPS, pool: 2, hot: true };
chunked("2 devices, concurrent offline canvas edits", { devices: 2, faults: CANVAS_FAULTS, faultRate: 0.2, steps: 80, canvas: HOT_CANVAS }, Math.max(1, Math.ceil(SEEDS / 8)), canvasHits);

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

test("actors: a backgrounded app takes no user actions; other programs still write its files (sim seed 131)", async () => {
	const { a, b } = twoDevices();
	const ledger = new TokenLedger();
	let background = true;
	const w = { devs: [a, b], ledger, isDown: () => false, isBackground: (i: number) => i === 0 && background };
	a.vault.userWrite("notes/n0.md", "seed\n");
	assert.equal(await runUserAction(w, { t: "create", dev: 0, name: 1 }, 5), "skip A create: app in background");
	assert.equal(await runUserAction(w, { t: "diskInsert", dev: 0, file: 0, pos: 0, by: "user" }, 6), "skip A diskInsert: app in background");
	assert.equal(await runUserAction(w, { t: "diskInsert", dev: 0, file: 0, pos: 0, by: "external" }, 7), "A diskInsert(external) notes/n0.md@0 [A.7]");
	assert.equal(a.vault.textOf("notes/n0.md"), "[A.7] seed\n");
	assert.equal(await runUserAction(w, { t: "create", dev: 1, name: 1 }, 8), "B create notes/n1.md new [B.8]");
	background = false;
	assert.equal(await runUserAction(w, { t: "create", dev: 0, name: 2 }, 9), "A create notes/n2.md new [A.9]");
	assert.deepEqual([...ledger.entries.keys()], ["[A.7]", "[B.8]", "[A.9]"]);
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

const board = (nodes: string, edges = "") => `{"nodes":[${nodes}],"edges":[${edges}]}`;
const textNode = (id: string, x: number, extra = "") => `{"id":"${id}","type":"text","text":"t","x":${x},"y":0,"width":10,"height":10${extra}}`;

test("invariants: canvases converge canonically (formatting may differ), not semantically", () => {
	const { a, b } = twoDevices();
	a.vault.userWrite("c.canvas", board(textNode("n1", 1)));
	b.vault.userWrite("c.canvas", `\uFEFF{\r\n  "edges": [],\r\n  "nodes": [${textNode("n1", 1)}]\r\n}\r\n`);
	a.vault.userWrite("e.canvas", "");
	b.vault.userWrite("e.canvas", board(""));
	const none = { docs: [], error: null };
	const v = checkConvergence([a, b], none).map((x) => x.detail);
	assert.ok(!v.some((d) => / differs/.test(d)), JSON.stringify(v));
	b.vault.userWrite("c.canvas", board(textNode("n1", 2)));
	assert.ok(checkConvergence([a, b], none).some((x) => x.detail.startsWith("c.canvas differs")));
});

test("invariants: canvas validity, lost records, lost field writes and discarded values", async () => {
	let { a, b } = twoDevices();
	const o = new CanvasOracle();
	const w = (rec: string, field: string, value: string, saw: string | null, step: number): FieldWrite =>
		({ rec, field, value, saw, dev: "A", step, path: "c.canvas", atMs: step });
	// a garbage file left on disk, and a broken version the engine wrote once
	a.vault.userWrite("bad.canvas", "{\"nodes\":[{\"id\":");
	b.vault.userWrite("bad.canvas", "{\"nodes\":[{\"id\":");
	await b.vault.write("x.canvas" as VaultPath, "{\"nodes\":[1]}", { t: "absent" });
	b.vault.userDelete("x.canvas");
	let v = checkCanvas([a, b], o).map((x) => x.detail);
	assert.ok(v.some((d) => d.startsWith("A: bad.canvas is not a valid canvas")), JSON.stringify(v));
	assert.ok(v.some((d) => d.startsWith("B: the engine wrote an invalid canvas to x.canvas")), JSON.stringify(v));
	({ a, b } = twoDevices());
	// n1 created and moved 1 -> 5; n2 created, never deleted
	o.created("n:n1", "A", 1, "c.canvas");
	o.created("n:n2", "A", 2, "c.canvas");
	o.write(w("n:n1", "x", "1", null, 1));
	o.write(w("n:n1", "x", "5", "1", 3));
	for (const d of [a, b]) d.vault.userWrite("c.canvas", board(textNode("n1", 1)));
	v = checkCanvas([a, b], o).map((x) => x.detail);
	assert.ok(v.includes("lost n:n2 (created on A at step 2 in c.canvas)"), JSON.stringify(v));
	assert.ok(v.some((d) => d.startsWith("lost write n:n1.x=5 on A at step 3")), JSON.stringify(v));
	// the newer value holds (and n2 deleted): clean
	o.deleted("n:n2", { dev: "A", step: 4, atMs: 4, how: "record", saw: new Map(), doc: null });
	for (const d of [a, b]) d.vault.userWrite("c.canvas", board(textNode("n1", 5)));
	assert.deepEqual(checkCanvas([a, b], o), []);
	// a removal undone
	o.write(w("n:n1", "color", "\"1\"", ABSENT, 5));
	o.write(w("n:n1", "color", ABSENT, "\"1\"", 6));
	for (const d of [a, b]) d.vault.userWrite("c.canvas", board(textNode("n1", 5, `,"color":"1"`)));
	assert.ok(checkCanvas([a, b], o).some((x) => x.detail.startsWith("lost write n:n1.color=(removed)")));
	// a format no projection writes, by the engine
	for (const d of [a, b]) d.vault.userWrite("c.canvas", board(textNode("n1", 5)));
	assert.deepEqual(checkCanvas([a, b], o), []);
	// root fields belong to the canvas's lineage: a conflict copy keeping the replaced value does not undo a removal
	const rooted = (extra: string) => `{"simCanvas":"L1"${extra},"nodes":[${textNode("n1", 5)}],"edges":[]}`;
	o.write({ ...w("root", "viewport", "\"v1\"", ABSENT, 7), lineage: "L1" });
	o.write({ ...w("root", "viewport", ABSENT, "\"v1\"", 8), lineage: "L1" });
	for (const d of [a, b]) {
		d.vault.userWrite("c.canvas", rooted(""));
		d.vault.userWrite("c (conflict A 2026-01-01 0001).canvas", rooted(`,"viewport":"v1"`));
	}
	assert.deepEqual(checkCanvas([a, b], o), []);
	for (const d of [a, b]) d.vault.userWrite("c.canvas", rooted(`,"viewport":"v1"`));
	assert.ok(checkCanvas([a, b], o).some((x) => x.detail.startsWith("lost write root.viewport=(removed)")));
	for (const d of [a, b]) {
		d.vault.userWrite("c.canvas", board(textNode("n1", 5)));
		d.vault.userDelete("c (conflict A 2026-01-01 0001).canvas");
	}
	await a.vault.write("f.canvas" as VaultPath, ` ${board(textNode("n1", 5))}`, { t: "absent" });
	assert.deepEqual(checkCanvas([a, b], o).map((x) => x.detail.slice(0, 81)), ["A: f.canvas holds bytes neither the projection's formatting nor written by a user"]);
});
