/**
 * Steps shared by the markdown (mergeJob.ts) and canvas (canvasJob.ts)
 * reconcileContent jobs: the job-level overwrite brake, step 4 of the I1
 * order (conflict-copy intent + copy of the exact disk bytes), and the §c.12
 * old-epoch base.
 */

import type { ContentHash, DocId, LocalEntry, PlannerOp, SyncedEntry, VaultPath } from "../../core/types";
import { brakeKey, isShrinkingOverwrite } from "../../core/plan/brake";
import { conflictName } from "../../core/plan/conflictName";
import type { IntentRecord } from "../store/schema";
import { intentId } from "./blobJobs";
import { writeOk, type Env } from "./diskJobs";
import { textContentHash } from "./localState";

export const MAX_CAS_ATTEMPTS = 3;

export type ReconcileOp = Extract<PlannerOp, { op: "reconcileContent" }>;

/**
 * §c.12: after an epoch migration a doc with no synced record (or a differing re-create loser merged into its
 * winner, op.pathBase) merges against the old epoch's base at its path: the base text of the old DB, markdown text
 * or canvas merge text. null = none.
 */
export function epochBaseOf(env: Env, op: ReconcileOp, s: SyncedEntry | undefined): string | null {
	return op.pathBase || !s ? env.ctx.deps.pathBase?.(env.ctx.pk(op.path)) ?? null : null;
}

/**
 * §c.12 path base, trusted only when the new epoch's text still holds all of it: the base is a subsequence of the
 * crdt text, by character for markdown, by whole record line of the canvas merge text (`unit` "line"). The old base
 * can be ahead of the new epoch: it includes own edits the old relay never received (offline imports, pending
 * creates) and acked edits the migrating peer never saw before the reset. A 3-way merge against such a base reads
 * the peer's staleness as deletions and drops local text or records. With base ⊑ crdt the crdt side only
 * inserted, so nothing on disk can be lost; otherwise null: the no-base merge keeps the disk side as a conflict
 * copy.
 */
export function trustedEpochBase(base: string | null, crdt: string, unit: "char" | "line" = "char"): string | null {
	if (base === null) return null;
	const b: ArrayLike<string> = unit === "line" ? base.split("\n") : base;
	const c: ArrayLike<string> = unit === "line" ? crdt.split("\n") : crdt;
	if (b.length > c.length) return null;
	let i = 0;
	for (let j = 0; i < b.length && j < c.length; j++) if (b[i] === c[j]) i++;
	return i === b.length ? base : null;
}

/**
 * Job-level mass-overwrite brake for md / canvas writes (the planner cannot know M's size). `transition`
 * ("<old hash>><new hash>") is taken only for a shrinking write: it may have to hash M.
 */
export async function overwriteAllowed(
	env: Env, docId: DocId, path: VaultPath, oldBytes: number, newBytes: number, transition: () => Promise<string>,
): Promise<boolean> {
	const { ctx } = env;
	if (!isShrinkingOverwrite(ctx.brake, oldBytes, newBytes)) return true;
	const key = brakeKey("overwrite", docId, path, await transition());
	if (env.approvedOverwrites.has(key)) return true;
	const threshold = Math.max(ctx.brake.minCount, ctx.brake.ratio * ctx.store.synced.size);
	if (ctx.window().overwrite + 1 <= threshold) return true;
	env.heldOverwrites.push({ key, path });
	return false;
}

/**
 * Step 4: T_intent_begin(conflict-copy, subjectHash = logical hash of the disk
 * side, `bytes`), write the exact disk bytes to a fresh conflict name
 * (precondition absent). null = the copy failed (intent dropped, path marked
 * dirty).
 */
export async function writeConflictCopy(
	env: Env, op: ReconcileOp, bytes: Uint8Array, subjectHash: ContentHash, kind: "markdown" | "canvas",
): Promise<{ intent: IntentRecord; local: LocalEntry } | null> {
	const { ctx } = env;
	const docId = op.docId;
	const copyHash = await textContentHash(ctx.deps.hash, kind, bytes);
	const view = ctx.log.view();
	const copyPath = conflictName({
		path: op.path, docId, deviceLabel: ctx.deps.deviceLabel, nowMs: ctx.now(), tzOffsetMinutes: ctx.deps.tzOffsetMinutes?.() ?? 0,
		pathKey: ctx.pk, isTaken: (k) => ctx.local.has(k) || view.remoteByPathKey.has(k),
	});
	const intent: IntentRecord = {
		id: intentId("conflict-copy", docId, op.path), docId, kind: "conflict-copy", subjectHash,
		fromPath: op.path, toPath: copyPath, step: 1, createdAtMs: ctx.now(),
	};
	await ctx.commit({ intentPut: [intent] });
	// exec transfers (detaches) write bytes; the caller still needs its read buffer.
	const res = await ctx.exec({ t: "write", area: "vault", path: copyPath, data: { t: "bytes", bytes: bytes.slice() }, precondition: { t: "absent" }, docId, purpose: "conflict-copy" });
	const out = writeOk(res);
	if (!out) {
		await ctx.commit({ intentDrop: [intent.id] });
		env.scan.markDirty(copyPath, null);
		return null;
	}
	ctx.echo.expectWrite(ctx.pk(copyPath), out.stat.size, out.stat.mtimeMs);
	ctx.noteConflictCopy(op.path, copyPath);
	return { intent, local: ctx.localEntry(copyPath, out.stat, kind, copyHash, out.fingerprint) };
}
