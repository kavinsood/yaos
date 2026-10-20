// Storms (bulk user / external-tool changes past the safety brake, actors.ts STORM_OPS), the simulated brake user
// (brakeUser.ts) and randomized tuning (run.ts tuningWorld). Their seed sweeps are sim matrices (testkit/sweep.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlan, tuningWorld, type SimConfig } from "./run";
import { DEFAULT_FAULTS } from "./faults";
import { SimDevice } from "./device";
import { SimNet } from "./net";
import { VirtualClock } from "./clock";

test("storms and randomized tuning draw from their own streams: the main plan of a seed is unchanged", () => {
	const base: SimConfig = { seed: 31, devices: 3, faults: DEFAULT_FAULTS };
	const main = (p: ReturnType<typeof generatePlan>) => p.filter((s) => s.i < 120);
	assert.deepEqual(main(generatePlan({ ...base, storms: 0.05, randomTuning: true })), main(generatePlan(base)));
	assert.ok(generatePlan({ ...base, storms: 0.05 }).some((s) => "user" in s && ["importStorm", "massDelete", "folderMove", "massRename", "massOverwrite"].includes(s.user.t)));
	assert.equal(tuningWorld(base, 3), null);
	const t = tuningWorld({ ...base, randomTuning: true }, 3)!;
	assert.deepEqual(t, tuningWorld({ ...base, randomTuning: true }, 3));
	assert.notDeepEqual(t[0], t[1]);
});

test("brake: a docs-scoped pass does not clear a held mass-overwrite brake before the user answers it (sim storms seed 6)", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock, { linkMs: 10 });
	const a = new SimDevice({ name: "A", clock, net });
	const b = new SimDevice({ name: "B", clock, net });
	const N = 70;
	const big = (k: number) => `note ${k}\n${"lorem ipsum dolor sit amet\n".repeat(260)}`;
	for (let k = 0; k < N; k++) a.vault.userWrite(`bulk/f${k}.md`, big(k));
	void a.start();
	void b.start();
	assert.ok(await clock.runUntil(() => b.vault.snapshot().size === N && b.vrt?.log.isIdle() === true && a.vrt?.log.isIdle() === true, 300_000), "B has the vault");
	await clock.advance(5_000);
	// An external tool on B shrinks every note: A may overwrite 50 in 10 minutes (BRAKE_MIN_COUNT), the rest are held.
	for (let k = 0; k < N; k++) b.vault.externalWrite(`bulk/f${k}.md`, `note ${k}\n`);
	assert.ok(await clock.runUntil(() => a.vrt?.brake?.reason === "mass-overwrite", 120_000), "A trips mass-overwrite");
	const id = a.vrt!.brake!.id;
	// The user is still reading the report; meanwhile A edits another note (a docs-scoped pass that plans none of the held writes).
	a.vault.userWrite("other.md", "hello\n");
	await clock.advance(10_000);
	assert.equal(a.vrt?.brake?.id, id, "the brake is still the one the user is looking at");
	let answered = false;
	void a.runtime.command({ t: "approveBrake", brakeId: id }).then(() => (answered = true));
	assert.ok(await clock.runUntil(() => answered, 30_000), "approve answered");
	assert.ok(await clock.runUntil(() => [...b.vault.snapshot()].every(([p, t]) => a.vault.textOf(p) === t), 120_000), "approved: A writes the held overwrites");
	assert.equal(a.vrt?.brake ?? null, null);
	for (const d of [a, b]) void d.runtime.stop();
	await clock.advance(1_000);
});
