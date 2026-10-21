// Coverage counters (SimReport.stats.coverage): the core fold / planner / checkpoint paths fire over a seed sweep
// (`npm run test:sim`). The invariant-4/5/6 self-checks are in coverage.test.ts.
import { simTest } from "./testkit/simTest";
import assert from "node:assert/strict";
import { runSim } from "./run";
import { DEFAULT_FAULTS } from "./faults";
import { FULL_OPS } from "./actors";
import { COVERAGE_KEYS } from "./coverage";
import type { SimConfig } from "./run";

async function sweepCoverage(base: Omit<SimConfig, "seed">, first: number, n: number): Promise<{ agg: Record<string, number>; bad: string[]; brakes: { approved: number; rejected: number } }> {
	const agg: Record<string, number> = {};
	const bad: string[] = [];
	const brakes = { approved: 0, rejected: 0 };
	for (let seed = first; seed < first + n; seed++) {
		const r = await runSim({ ...base, seed });
		for (const [k, v] of Object.entries(r.stats.coverage)) agg[k] = (agg[k] ?? 0) + v;
		brakes.approved += r.stats.brakes.approved;
		brakes.rejected += r.stats.brakes.rejected;
		if (r.violations.length > 0) bad.push(`${seed}: ${r.violations[0]!.inv}: ${r.violations[0]!.detail}`);
	}
	return { agg, bad, brakes };
}

const SEEDS = 16;

/**
 * Keys that must fire over a modest DEFAULT_FAULTS / FULL_OPS sweep: the fold and planner paths the main matrix
 * exists to exercise. Keys that never fire in the main matrix (quarantine, pruning, most ns.ignored.*, ...) are
 * listed as coverage gaps in docs/client-remake/wp-d-notes.md, not asserted here. The brakes are the storm matrix's
 * and the eviction / overflow paths the randomized-tuning matrix's (units below).
 */
const CORE = [
	"ns.create.applied", "ns.create.suffixed", "ns.create.merged", "ns.rename.applied", "ns.delete.deleted", "ns.restore.revived",
	"ns.setBlob.applied", "ns.ignored.not-deleted",
	"plan.nsCreate", "plan.nsRename", "plan.nsDelete", "plan.nsRestore", "plan.nsSetBlob", "plan.diskMaterialize", "plan.diskRename",
	"plan.diskTrash", "plan.conflictCopy", "plan.reconcileContent.base", "plan.reconcileContent.noBase", "plan.rebind",
	"plan.pushBlob", "plan.fetchBlob", "plan.wait.body-not-caught-up",
	"diag.checkpoint-written", "diag.checkpoint-conflict", "diag.checkpoint-adopted", "diag.checkpoint-adopted-behind", "diag.stream-resend",
	"host.boundConflictCopies",
	// provisionalBroadcast on, as in production (device.ts SIM_SETTINGS): peers apply and adopt PROVISIONALs.
	"host.provisionalAdopted",
];

simTest(`coverage: core fold / planner / checkpoint paths fire over ${SEEDS} seeds (3 devices, DEFAULT_FAULTS, FULL_OPS)`, SEEDS * 2, async () => {
	const agg: Record<string, number> = {};
	const bad: string[] = [];
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = await runSim({ seed, devices: 3, faults: DEFAULT_FAULTS, ops: FULL_OPS });
		for (const k of COVERAGE_KEYS) assert.equal(typeof r.stats.coverage[k], "number", `seed ${seed}: coverage key ${k} present`);
		for (const [k, n] of Object.entries(r.stats.coverage)) agg[k] = (agg[k] ?? 0) + n;
		if (r.violations.length > 0) bad.push(`${seed}: ${r.violations[0]!.inv}: ${r.violations[0]!.detail}`);
	}
	assert.deepEqual(bad, []);
	const zero = CORE.filter((k) => !(agg[k]! > 0));
	assert.deepEqual(zero, [], `never fired: ${zero.join(", ")}\n${JSON.stringify(agg)}`);
});

simTest("coverage: storms trip every mass brake and the simulated user answers both ways (3 devices, storms)", 16 * 3.5, async () => {
	const { agg, bad, brakes } = await sweepCoverage({ devices: 3, faults: DEFAULT_FAULTS, steps: 80, storms: 0.07 }, 1, 16);
	assert.deepEqual(bad, []);
	const want = ["brake.mass-delete-local", "brake.mass-delete-remote", "brake.mass-overwrite", "brake.listing-shrank", "ns.delete.deleted", "plan.diskTrash", "plan.diskRename"];
	const zero = want.filter((k) => !(agg[k]! > 0));
	assert.deepEqual(zero, [], `never fired: ${zero.join(", ")}`);
	assert.ok(brakes.approved > 0 && brakes.rejected > 0, JSON.stringify(brakes));
});

simTest("coverage: randomized tuning reaches the live-queue overflow path (3 devices, DEFAULT_FAULTS)", 24 * 2, async () => {
	const { agg, bad } = await sweepCoverage({ devices: 3, faults: DEFAULT_FAULTS, randomTuning: true }, 1, 24);
	assert.deepEqual(bad, []);
	const zero = ["diag.live-overflow", "host.provisionalAdopted"].filter((k) => !(agg[k]! > 0));
	assert.deepEqual(zero, [], `never fired: ${zero.join(", ")}`);
});

simTest("coverage: a small tombstone cap prunes, and dead streams are retired, read retired and dropped (3 devices, smallPrune)", 20 * 2.5, async () => {
	// Seeds 21..40: seed 35 retires a pruned canvas that a device then reads retired (checkpoint-retired). Most dead
	// streams need no put: a settle checkpoint at lastSeq already covered them, or they never had a row.
	const { agg, bad } = await sweepCoverage({ devices: 3, faults: DEFAULT_FAULTS, smallPrune: true }, 21, 20);
	assert.deepEqual(bad, []);
	const zero = ["ns.pruned", "diag.retire-written", "diag.checkpoint-retired", "diag.retire-dropped"].filter((k) => !(agg[k]! > 0));
	assert.deepEqual(zero, [], `never fired: ${zero.join(", ")}\n${JSON.stringify(agg)}`);
});
