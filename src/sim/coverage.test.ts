// The invariant-4/5/6 checks catch what they claim to (the coverage counters' sweep: coverage.sim.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSim, type SimReport } from "./run";

test("invariant 4: a device fold that no delivery of the relay's rows gives is reported", async () => {
	let tampered = false;
	const r: SimReport = await runSim({
		seed: 3, devices: 2, faults: null, steps: 40,
		observe: (label, devs) => {
			const st = devs[0]?.vrt?.log.c.ns.state;
			if (label !== "end" || !st) return;
			const e = [...st.entries.values()].find((x) => x.state === "live");
			if (!e) return;
			st.entries.set(e.docId, { ...e, path: `${e.path}x` });
			tampered = true;
		},
	});
	assert.ok(tampered);
	const fold = r.violations.filter((v) => v.inv === "fold").map((v) => v.detail);
	for (const how of ["full refold", "paged refold", "+ tail"]) assert.ok(fold.some((d) => d.startsWith("ns ") && d.includes(how)), `${how}: ${JSON.stringify(fold)}`);
	assert.ok(!fold.some((d) => d.startsWith("cfg ") || d.startsWith("snap ")), JSON.stringify(fold));
});

test("invariant 6: a resident doc over the budget is reported (sampled during the run)", async () => {
	const r = await runSim({
		seed: 4, devices: 2, faults: null, steps: 30,
		observe: (label, devs) => {
			const c = devs[0]?.vrt?.log.c;
			// A budget below zero: any resident doc (or none) breaches budget + 1 from here on.
			if (label === "10" && c) (c.budgets as { maxResidentDocs: number }).maxResidentDocs = -2;
		},
	});
	assert.ok(r.violations.some((v) => v.inv === "bounds" && v.detail.startsWith("A: ") && v.detail.includes("resident docs")), JSON.stringify(r.violations));
});
