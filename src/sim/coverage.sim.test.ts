// Coverage counters (SimReport.stats.coverage): the core fold / planner / checkpoint paths fire over a seed sweep
// (`npm run test:sim`). The invariant-4/5/6 self-checks are in coverage.test.ts.
import { simTest } from "./testkit/simTest";
import assert from "node:assert/strict";
import { runSim } from "./run";
import { DEFAULT_FAULTS } from "./faults";
import { FULL_OPS } from "./actors";
import { COVERAGE_KEYS } from "./coverage";

const SEEDS = 16;

/**
 * Keys that must fire over a modest DEFAULT_FAULTS / FULL_OPS sweep: the fold and planner paths the main matrix
 * exists to exercise. Keys that never fire in the main matrix (brakes, provisional adoption, quarantine, ...) are
 * listed as coverage gaps in docs/client-remake/wp-d-notes.md, not asserted here.
 */
const CORE = [
	"ns.create.applied", "ns.create.suffixed", "ns.create.merged", "ns.rename.applied", "ns.delete.deleted", "ns.restore.revived",
	"ns.setBlob.applied", "ns.ignored.not-deleted",
	"plan.nsCreate", "plan.nsRename", "plan.nsDelete", "plan.nsRestore", "plan.nsSetBlob", "plan.diskMaterialize", "plan.diskRename",
	"plan.diskTrash", "plan.conflictCopy", "plan.reconcileContent.base", "plan.reconcileContent.noBase", "plan.rebind",
	"plan.pushBlob", "plan.fetchBlob", "plan.wait.body-not-caught-up",
	"diag.checkpoint-written", "diag.checkpoint-conflict", "diag.checkpoint-adopted", "diag.checkpoint-adopted-behind", "diag.stream-resend",
	"host.boundConflictCopies",
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
