/**
 * Semantic coverage counters of a run (SimReport.stats.coverage), from what the engine itself did:
 *
 *   ns.<op>.<outcome>      committed ns frames as folded on the devices (the NsFoldEvent outcome of each op;
 *                          `applied` / `suffixed` / `merged` / `revived` / `deleted`; `revived-suffixed`: a revive
 *                          placed at another path than the op asked for), ns.ignored.<reason>, ns.pruned
 *                          (RuntimeObserver.nsFold; a reload refolds the tail, so a row can count more than once)
 *   plan.<op>              executable planner ops of every reconcile pass (RuntimeObserver.pass), with
 *                          plan.conflictCopy.<reason> (the planner's own copies: no-base, blob-concurrent),
 *                          plan.reconcileContent.{base,noBase,pathBase}, plan.rebind.adopt, plan.wait.<reason>
 *   conflict.<reason>      conflict copy events (RuntimeObserver.conflict): a merge's copy in a reconcile job or a
 *                          bound reload (both-edited / too-large / no-base), a name taken between pick and write
 *                          (path-taken), a copy an intent resume finished (recovered: a crash left it open, or a
 *                          blob keep-both's download had not finished)
 *   brake.<reason>         distinct brake reports (by id) per device
 *   diag.<code>            LogEngine diagnostics of every device engine (SimDevice.diagCounts, class suffix folded)
 *   host.<counter>         engine stats over every runtime of a device (bound conflict copies, provisionals
 *                          adopted, adopt-to-pending)
 *
 * Every key of COVERAGE_KEYS is present (0 when it never fired), so a soak's aggregate shows the gaps.
 *
 * Not keys, because no code path can produce them (DEAD_COVERAGE below, kept as a record): a create never revives
 * (ns/fold.ts places it in "create" mode: applied / suffixed / merged), a restore always revives (never applied or
 * suffixed: the revive outcome carries the final path, counted as `revived-suffixed` when it moved); the planner
 * never emits wait/blob-unavailable nor conflictCopy ops for both-edited / too-large (those are merge outcomes,
 * conflict.*), and no code emits the ConflictReason members path-taken / recovered on a planner op (the events are
 * conflict.path-taken / conflict.recovered); diagnostics `recovered-from-mirror` is the no-identity engine-test path
 * (production's mirror recovery is the identity-per-store inherit, diag `inherited`). An ns frame with upgradeRules
 * above the known version halts the fold before it folds (ns/fold.ts pre-scan), so its ignored/rules-version event
 * never reaches RuntimeObserver.nsFold: the halt is diag `upgrade-required` (upgradeHalt.test.ts).
 */

import type { FoldedNsFrame } from "../engine/sync/nsRuntime";
import type { PassReport } from "../engine/reconcile/reconciler";
import type { PlannerOp } from "../core/types";

const NS_OUTCOMES: readonly string[] = [
	"create.applied", "create.suffixed", "create.merged",
	"rename.applied", "rename.suffixed", "rename.revived",
	"delete.deleted",
	"restore.revived",
	"setBlob.applied", "setBlob.revived",
	"rename.revived-suffixed", "restore.revived-suffixed",
];
const NS_IGNORED: readonly string[] = [
	"duplicate-frame", "replay-stale", "replay-duplicate", "stale-epoch", "duplicate-docid", "unknown-docid", "invalid-path",
	"kind-mismatch", "stale-delete", "already-deleted", "not-deleted", "restore-not-current", "stale-revive", "rev-mismatch",
	"not-blob", "noop",
];
const PLAN_OPS: readonly string[] = [
	"nsCreate", "nsRename", "nsDelete", "nsRestore", "nsSetBlob", "diskMaterialize", "diskRename", "diskTrash", "conflictCopy",
	"reconcileContent", "pushBlob", "fetchBlob", "rebind", "syncedPut", "syncedDrop", "needHash", "wait",
];
/** conflictCopy reasons the planner emits (planner.ts). */
const CONFLICT_REASONS: readonly string[] = ["no-base", "blob-concurrent"];
/** RuntimeObserver.conflict reasons. */
const CONFLICT_EVENTS: readonly string[] = ["both-edited", "too-large", "no-base", "path-taken", "recovered"];
const WAIT_REASONS: readonly string[] = ["body-not-caught-up", "body-empty", "frozen", "pending-ns", "pending-body", "text-hash"];
const BRAKES: readonly string[] = ["mass-delete-local", "mass-delete-remote", "mass-overwrite", "listing-shrank", "conflict-flood"];
/** Diagnostics codes that mark a semantic path (not every code the engine has). */
const DIAGS: readonly string[] = [
	"checkpoint-written", "checkpoint-conflict", "checkpoint-adopted", "checkpoint-adopted-behind", "checkpoint-retired", "checkpoint-held",
	"checkpoint-refused", "checkpoint-failed", "doc-frozen", "frame-poisoned", "adopt-pending", "stream-resend", "causal-hole", "doc-thawed",
	"live-overflow", "inherited", "epoch-mismatch", "gap-feed", "quarantine-retried", "blob-gc-swept", "frame-resealed",
	"snap-fold", "upgrade-required",
];

export const COVERAGE_KEYS: readonly string[] = [
	...NS_OUTCOMES.map((k) => `ns.${k}`), ...NS_IGNORED.map((k) => `ns.ignored.${k}`), "ns.pruned",
	...PLAN_OPS.map((k) => `plan.${k}`), ...CONFLICT_REASONS.map((k) => `plan.conflictCopy.${k}`),
	"plan.reconcileContent.base", "plan.reconcileContent.noBase", "plan.reconcileContent.pathBase", "plan.rebind.adopt",
	...WAIT_REASONS.map((k) => `plan.wait.${k}`), ...CONFLICT_EVENTS.map((k) => `conflict.${k}`), ...BRAKES.map((k) => `brake.${k}`), ...DIAGS.map((k) => `diag.${k}`),
	"host.boundConflictCopies", "host.provisionalAdopted", "host.adoptToPending",
];

/** Keys a reader might expect that no code path produces (module doc): never in COVERAGE_KEYS, never asserted. */
export const DEAD_COVERAGE: readonly string[] = [
	"ns.create.revived", "ns.restore.applied", "ns.restore.suffixed", "plan.wait.blob-unavailable", "plan.conflictCopy.both-edited",
	"plan.conflictCopy.too-large", "plan.conflictCopy.path-taken", "plan.conflictCopy.recovered", "diag.recovered-from-mirror",
	"ns.ignored.rules-version",
];

export function emptyCoverage(): Record<string, number> {
	const out: Record<string, number> = {};
	for (const k of COVERAGE_KEYS) out[k] = 0;
	return out;
}

const bump = (c: Record<string, number>, k: string, n = 1) => (c[k] = (c[k] ?? 0) + n);

/** One device's engine-side counters, over all of its engines (SimDevice.coverage). */
export class CoverageSink {
	readonly counts: Record<string, number> = {};
	private readonly brakes = new Set<string>();

	nsFold(frames: readonly FoldedNsFrame[]): void {
		for (const f of frames) {
			for (const e of f.events) {
				const o = e.outcome;
				if (o.kind === "pruned") bump(this.counts, "ns.pruned", o.docIds.length);
				else if (o.kind === "ignored") bump(this.counts, `ns.ignored.${o.reason}`);
				else {
					const op = f.ops[e.index];
					bump(this.counts, `ns.${op?.t ?? "?"}.${o.kind === "applied" ? "applied" : o.kind}`);
					// A revive placed elsewhere than asked (another doc took the path meanwhile). Only rename / restore
					// carry the asked path (setBlob revives at the entry's old path, which the event does not carry).
					if (o.kind === "revived" && op && "path" in op && o.finalPath !== op.path) bump(this.counts, `ns.${op.t}.revived-suffixed`);
				}
			}
		}
	}

	conflict(reason: string): void {
		bump(this.counts, `conflict.${reason}`);
	}

	pass(ops: readonly PlannerOp[], report: PassReport): void {
		for (const op of ops) {
			bump(this.counts, `plan.${op.op}`);
			if (op.op === "conflictCopy") bump(this.counts, `plan.conflictCopy.${op.reason}`);
			else if (op.op === "reconcileContent") bump(this.counts, `plan.reconcileContent.${op.pathBase ? "pathBase" : op.hasBase ? "base" : "noBase"}`);
			else if (op.op === "rebind" && op.adopt) bump(this.counts, "plan.rebind.adopt");
			else if (op.op === "wait") bump(this.counts, `plan.wait.${op.reason}`);
		}
		if (report.brake && !this.brakes.has(report.brake.id)) {
			this.brakes.add(report.brake.id);
			bump(this.counts, `brake.${report.brake.reason}`);
		}
	}
}

/** The run's coverage: every device's sink, diagnostics and host stats, over COVERAGE_KEYS. */
export function collectCoverage(devs: readonly { readonly coverage: CoverageSink; readonly diagCounts: Readonly<Record<string, number>>; readonly hostStats: () => Readonly<Record<string, number>> }[]): Record<string, number> {
	const out = emptyCoverage();
	for (const d of devs) {
		for (const [k, n] of Object.entries(d.coverage.counts)) bump(out, k, n);
		for (const [k, n] of Object.entries(d.diagCounts)) {
			// One key per event: "code" or "code:cls" (derived codes such as checkpoint-adopted-behind are their own).
			const code = k.split(":")[0]!;
			if (DIAGS.includes(code)) bump(out, `diag.${code}`, n);
		}
		for (const [k, n] of Object.entries(d.hostStats())) bump(out, `host.${k}`, n);
	}
	return out;
}
