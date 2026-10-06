/**
 * Steps shared by the markdown (mergeJob.ts) and canvas (canvasJob.ts)
 * reconcileContent jobs: the job-level overwrite brake and step 4 of the I1
 * order (conflict-copy intent + copy of the exact disk bytes).
 */

import type { ContentHash, DocId, LocalEntry, PlannerOp, VaultPath } from "../../core/types";
import { brakeKey, isShrinkingOverwrite } from "../../core/plan/brake";
import { conflictName } from "../../core/plan/conflictName";
import type { IntentRecord } from "../store/schema";
import { intentId } from "./blobJobs";
import { writeOk, type Env } from "./diskJobs";
import { hashBytes } from "./localState";

export const MAX_CAS_ATTEMPTS = 3;

export type ReconcileOp = Extract<PlannerOp, { op: "reconcileContent" }>;

/** Job-level mass-overwrite brake for md / canvas writes (the planner cannot know M's size). */
export function overwriteAllowed(env: Env, docId: DocId, path: VaultPath, oldBytes: number, newBytes: number, transition: string): boolean {
	const { ctx } = env;
	if (!isShrinkingOverwrite(ctx.brake, oldBytes, newBytes)) return true;
	const key = brakeKey("overwrite", docId, path, transition);
	if (env.approvedOverwrites.has(key)) return true;
	const threshold = Math.max(ctx.brake.minCount, ctx.brake.ratio * ctx.store.synced.size);
	if (ctx.window().overwrite + 1 <= threshold) return true;
	env.heldOverwrites.push({ key, path });
	return false;
}

/**
 * Step 4: T_intent_begin(conflict-copy, subjectHash = logical hash of the disk
 * side), write the exact disk bytes to a fresh conflict name (precondition
 * absent). null = the copy failed (intent dropped, path marked dirty).
 */
export async function writeConflictCopy(
	env: Env, op: ReconcileOp, bytes: Uint8Array, subjectHash: ContentHash, kind: "markdown" | "canvas",
): Promise<{ intent: IntentRecord; local: LocalEntry } | null> {
	const { ctx } = env;
	const docId = op.docId;
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
	const hb = hashBytes(kind, bytes);
	const res = await ctx.exec({ t: "write", area: "vault", path: copyPath, data: { t: "bytes", bytes: bytes.slice() }, precondition: { t: "absent" }, docId, purpose: "conflict-copy" });
	const out = writeOk(res);
	if (!out) {
		await ctx.commit({ intentDrop: [intent.id] });
		env.scan.markDirty(copyPath, null);
		return null;
	}
	ctx.echo.expectWrite(ctx.pk(copyPath), out.stat.size, out.stat.mtimeMs);
	ctx.noteDestructive("conflict");
	return { intent, local: ctx.localEntry(copyPath, out.stat, kind, hb.hash, out.fingerprint) };
}
