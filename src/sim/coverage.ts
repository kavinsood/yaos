/**
 * Semantic coverage counters of a run (SimReport.stats.coverage), from what the engine itself did:
 *
 *   ns.<op>.<outcome>      committed ns frames as folded on the devices (the NsFoldEvent outcome of each op;
 *                          `applied` / `suffixed` / `merged` / `revived` / `deleted`), ns.ignored.<reason>, ns.pruned
 *                          (RuntimeObserver.nsFold; a reload refolds the tail, so a row can count more than once)
 *   plan.<op>              executable planner ops of every reconcile pass (RuntimeObserver.pass), with
 *                          plan.conflictCopy.<reason>, plan.reconcileContent.{base,noBase,pathBase},
 *                          plan.rebind.adopt, plan.wait.<reason>
 *   brake.<reason>         distinct brake reports (by id) per device
 *   diag.<code>            LogEngine diagnostics of every device engine (SimDevice.diagCounts, class suffix folded);
 *                          the retired-stream path (DESIGN §b.5): diag.retire-written (a retired checkpoint put),
 *                          diag.checkpoint-retired (one read), diag.retire-dropped (a dead stream's records dropped)
 *   host.<counter>         engine stats over every runtime of a device (bound conflict copies, provisionals
 *                          adopted, adopt-to-pending)
 *
 * Every key of COVERAGE_KEYS is present (0 when it never fired), so a soak's aggregate shows the gaps.
 */

import type { FoldedNsFrame } from "../engine/sync/nsRuntime";
import type { PassReport } from "../engine/reconcile/reconciler";
import type { PlannerOp } from "../core/types";

const NS_OUTCOMES: readonly string[] = [
	"create.applied", "create.suffixed", "create.merged", "create.revived",
	"rename.applied", "rename.suffixed", "rename.revived",
	"delete.deleted",
	"restore.revived", "restore.applied", "restore.suffixed",
	"setBlob.applied", "setBlob.revived",
];
const NS_IGNORED: readonly string[] = [
	"duplicate-frame", "replay-stale", "replay-duplicate", "stale-epoch", "duplicate-docid", "unknown-docid", "invalid-path",
	"kind-mismatch", "stale-delete", "already-deleted", "not-deleted", "restore-not-current", "stale-revive", "rev-mismatch",
	"not-blob", "noop", "rules-version",
];
const PLAN_OPS: readonly string[] = [
	"nsCreate", "nsRename", "nsDelete", "nsRestore", "nsSetBlob", "diskMaterialize", "diskRename", "diskTrash", "conflictCopy",
	"reconcileContent", "pushBlob", "fetchBlob", "rebind", "syncedPut", "syncedDrop", "needHash", "wait",
];
const CONFLICT_REASONS: readonly string[] = ["both-edited", "no-base", "too-large", "blob-concurrent", "path-taken", "recovered"];
const WAIT_REASONS: readonly string[] = ["body-not-caught-up", "body-empty", "blob-unavailable", "frozen", "pending-ns", "pending-body"];
const BRAKES: readonly string[] = ["mass-delete-local", "mass-delete-remote", "mass-overwrite", "listing-shrank", "conflict-flood"];
/** Diagnostics codes that mark a semantic path (not every code the engine has). */
const DIAGS: readonly string[] = [
	"checkpoint-written", "checkpoint-conflict", "checkpoint-adopted", "checkpoint-adopted-behind", "checkpoint-retired", "checkpoint-held",
	"checkpoint-refused", "checkpoint-failed", "doc-frozen", "frame-poisoned", "adopt-pending", "stream-resend", "causal-hole", "doc-thawed",
	"live-overflow", "recovered-from-mirror", "epoch-mismatch", "gap-feed", "quarantine-retried", "blob-gc-swept", "frame-resealed",
	"snap-fold", "retire-written", "retire-dropped",
];

export const COVERAGE_KEYS: readonly string[] = [
	...NS_OUTCOMES.map((k) => `ns.${k}`), ...NS_IGNORED.map((k) => `ns.ignored.${k}`), "ns.pruned",
	...PLAN_OPS.map((k) => `plan.${k}`), ...CONFLICT_REASONS.map((k) => `plan.conflictCopy.${k}`),
	"plan.reconcileContent.base", "plan.reconcileContent.noBase", "plan.reconcileContent.pathBase", "plan.rebind.adopt",
	...WAIT_REASONS.map((k) => `plan.wait.${k}`), ...BRAKES.map((k) => `brake.${k}`), ...DIAGS.map((k) => `diag.${k}`),
	"host.boundConflictCopies", "host.provisionalAdopted", "host.adoptToPending",
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
				else bump(this.counts, `ns.${f.ops[e.index]?.t ?? "?"}.${o.kind === "applied" ? "applied" : o.kind}`);
			}
		}
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
