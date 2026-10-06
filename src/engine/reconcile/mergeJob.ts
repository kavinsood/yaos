/**
 * Markdown reconcileContent (DESIGN §f.3, invariant I1 ordering):
 *   1. read disk (text D, fingerprint F)
 *   2. MergeFn(B, D, C) -> M
 *   3. CAS on the Y.Text, apply minimalDiff(C -> M) in one MERGE transaction,
 *      T_edit (commitEdits)
 *   4. conflict: T_intent_begin(conflict-copy), write the copy (absent)
 *   5. write M over the path (precondition fingerprint F)
 *   6. T_synced (S, base, L) + T_intent_end, one tx
 * A failed step-5 precondition (the user typed again) rebases S on the disk
 * side D (hash, stat, base D) but keeps S.bodyVersion: the CRDT already holds
 * D's edits, so the next pass merges (D, D', M) and Rc stays true even if the
 * disk returns to D. Keeping B as the base would turn the user's continued
 * typing into a false conflict against their own first edit.
 *
 * Bound docs (open in an editor, §d.2): the replica is merged, the file is never
 * written; S records the disk side (hash(D), F, base D) and the editor's save
 * brings the file to the CRDT text. Until that save is seen (M ≠ D), S has no
 * CRDT sync point (bodyVersion null): a crash, or a close before the save,
 * then still leaves Rc true and the next unbound pass writes M. Recording the
 * current version instead left the disk at D for good. Such a job is
 * "deferred": the doc waits for the editor, like a planner wait.
 *
 * Canvas docs take the same steps in canvasJob.ts (record-per-line merge text,
 * record-level CRDT apply, logical-hash write skip).
 */

import type * as Y from "yjs";
import type { DiskFingerprint, LocalEntry, MergeResult, SyncedEntry } from "../../core/types";
import { canonicalizeMarkdown, exactFingerprint, markdownContentHash } from "../../core/hash/markdownLf";
import { utf8Decode, utf8Length } from "../../core/hash/utf8";
import { merge } from "../../core/merge/merge";
import { applyEditsTo, minimalDiff } from "../../core/merge/minimalDiff";
import { isShrinkingOverwrite } from "../../core/plan/brake";
import type { IntentRecord } from "../store/schema";
import { mergeCanvas } from "./canvasJob";
import { MAX_CAS_ATTEMPTS, overwriteAllowed, writeConflictCopy, type ReconcileOp } from "./contentSteps";
import type { BodyHandle } from "./deps";
import { writeOk, type Env, type JobOutcome } from "./diskJobs";
import { MAX_TEXT_FILE_BYTES } from "./localState";
import { makeBase } from "./store";

export { MAX_CAS_ATTEMPTS } from "./contentSteps";

/** Apply minimalDiff(from -> to) to the Y.Text in one transaction (core applyEditsTo). */
export function applyMinimalDiff(h: BodyHandle, ytext: Y.Text, from: string, to: string): number {
	const edits = minimalDiff(from, to);
	if (edits.length === 0) return 0;
	h.doc.transact(() => applyEditsTo(ytext, from, edits), h.mergeOrigin);
	return edits.length;
}

export async function reconcileContent(env: Env, op: ReconcileOp): Promise<JobOutcome> {
	const { ctx } = env;
	const h = await ctx.log.acquireBody(op.docId, op.kind);
	if (!h) return "fail";
	try {
		return op.kind === "canvas" ? await mergeCanvas(env, op, h) : await mergeMarkdown(env, op, h);
	} finally {
		h.release();
	}
}

async function mergeMarkdown(env: Env, op: ReconcileOp, h: BodyHandle): Promise<JobOutcome> {
	const { ctx } = env;
	const docId = op.docId;
	const diskPath = ctx.diskPathOf(op.path);
	const rd = await ctx.read(diskPath, MAX_TEXT_FILE_BYTES);
	if (!rd.ok) {
		if (rd.reason === "too-large") ctx.notice("warn", "text-too-large", `note too large to sync: ${op.path}`, `big:${op.path}`);
		env.scan.markDirty(diskPath, rd.reason === "missing" ? null : rd.stat);
		return "fail";
	}
	const decoded = utf8Decode(rd.bytes, true);
	if (decoded === null) {
		ctx.notice("warn", "not-utf8", `not valid UTF-8, left alone: ${op.path}`, `utf8:${docId}`);
		return "fail";
	}
	const D = canonicalizeMarkdown(decoded);
	const F = exactFingerprint(rd.bytes);
	const s = ctx.synced(docId);
	// §c.12: after an epoch migration a doc with no synced record (or a differing re-create loser merged into its
	// winner, op.pathBase) merges against the old epoch's base at its path, but only while the new epoch's text
	// still contains that base (trustedEpochBase): a base ahead of the new epoch would read as deletions.
	const epochBase = op.pathBase || !s ? ctx.deps.pathBase?.(ctx.pk(op.path)) ?? null : null;
	const storedBase = !op.pathBase && op.hasBase && s?.hasBase ? await ctx.store.loadBase(docId) : null;
	// The synced-side fallback below needs a record describing this doc's last sync (not a rebound loser's).
	const fallback = op.pathBase ? undefined : s;
	const ytext = h.doc.getText("text");
	const diskHash = markdownContentHash(D);
	// Bound: the disk holds a save of its editors (or the last disk text) that the replica already has: not an edit.
	// Without this a save followed by more typing on the same line merges as a conflict against the old base.
	const savedByEditor = h.bound && ctx.deps.boundSavedText?.(docId, D) === true;

	let result: MergeResult | null = null;
	let crdt0 = "";
	let crdt1 = ""; // the CRDT text right after the merge transaction
	let v0 = h.version();
	for (let attempt = 0; ; attempt++) {
		if (attempt >= MAX_CAS_ATTEMPTS) return "fail"; // remote kept moving: re-plan
		crdt0 = ytext.toString();
		// No stored base (mirror recovery, too large to keep, a merged alias restarted at the winner's create): a side
		// still at the synced content is the base, so a one-sided change applies as one instead of a no-base conflict copy.
		const base = savedByEditor ? D : storedBase ?? trustedEpochBase(epochBase, crdt0)
			?? (crdt0 === "" ? "" : !fallback ? null : diskHash === fallback.contentHash ? D : markdownContentHash(crdt0) === fallback.contentHash ? crdt0 : null);
		await ctx.deps.clock.yieldNow();
		const res = merge({ base, disk: D, crdt: crdt0, limits: ctx.mergeLimits });
		const M = res.kind === "identical" ? D : res.text;
		if (!h.bound && M !== D && !overwriteAllowed(env, docId, op.path, rd.bytes.length, utf8Length(M), `${markdownContentHash(D)}>${markdownContentHash(M)}`)) {
			return "held";
		}
		// Synchronous section: CAS, apply, capture the version.
		if (ytext.toString() !== crdt0) continue;
		const apply = res.kind === "disk-only" || res.kind === "clean" || res.kind === "conflict";
		if (apply) applyMinimalDiff(h, ytext, crdt0, res.text);
		crdt1 = apply ? res.text : crdt0;
		v0 = h.version();
		result = res;
		break;
	}
	const v1 = await h.commitEdits();
	// Editor keystrokes applied between the CAS and the frame close are covered by v1.localOrder but are not in M:
	// recording v1 would claim the disk holds them, and a crash before the editor's save lost them on this disk
	// for good (sim heavy seed 119). No sync point then (header): the next pass merges again.
	const bodyVersion = ytext.toString() === crdt1 ? { remoteSeq: v0.remoteSeq, localOrder: v1.localOrder } : null;
	const M = result.kind === "identical" ? D : result.text;

	// Conflict copy of the disk side (exact original bytes).
	let intent: IntentRecord | null = null;
	const local: LocalEntry[] = [];
	if (result.kind === "conflict") {
		const cc = await writeConflictCopy(env, op, rd.bytes, markdownContentHash(D), "markdown");
		if (!cc) return "fail";
		intent = cc.intent;
		local.push(cc.local);
	}

	// Write M over the path, CAS on the fingerprint we read.
	const prevL = ctx.localAt(op.path);
	let stat = rd.stat;
	let fingerprint = F;
	let diskText = D;
	if (!h.bound && M !== D) {
		const res = await ctx.exec({ t: "write", area: "vault", path: diskPath, data: { t: "text", text: M }, precondition: { t: "fingerprint", fingerprint: F }, docId, purpose: "merge" });
		const out = writeOk(res);
		if (!out) {
			// The user edited again: rebase S on D (see header), keep bodyVersion so Rc stays true.
			const rebased = s ? rebaseOnDisk(ctx, s, D, F, rd.stat) : null;
			await ctx.commit({
				intentDrop: intent ? [intent.id] : [],
				syncedPut: rebased ? [rebased.entry] : [],
				basePut: rebased?.base ? [rebased.base] : [],
				baseDrop: rebased && !rebased.base ? [docId] : [],
			}, local);
			env.scan.markDirty(diskPath, null);
			return "fail";
		}
		ctx.echo.expectWrite(ctx.pk(op.path), out.stat.size, out.stat.mtimeMs);
		if (isShrinkingOverwrite(ctx.brake, rd.bytes.length, out.stat.size)) ctx.noteDestructive("overwrite");
		stat = out.stat;
		fingerprint = out.fingerprint;
		diskText = M;
	}

	// T_synced + T_intent_end. Bound with M ≠ D: no sync point until the editor's save (header).
	const awaitingSave = h.bound && M !== D;
	const hash = markdownContentHash(diskText);
	const base = makeBase(docId, diskText, hash);
	const entry = ctx.record({
		docId, path: op.path, pathKey: ctx.pk(op.path), kind: "markdown", contentHash: hash, fingerprint, size: stat.size, mtimeMs: stat.mtimeMs,
		bodyVersion: awaitingSave ? null : bodyVersion, blobRev: 0, nsTouchSeq: ctx.touchSeq(docId), hasBase: base !== null,
	});
	const le = { ...ctx.localEntry(op.path, stat, "markdown", hash, fingerprint), bound: prevL?.bound ?? false };
	local.push(le);
	await ctx.commit(
		{ syncedPut: [entry], basePut: base ? [base] : [], baseDrop: base ? [] : [docId], intentDrop: intent ? [intent.id] : [] },
		local,
	);
	return awaitingSave ? "deferred" : "ok";
}

/**
 * §c.12 path base, trusted only when the new epoch's text still holds all of it
 * (base is a subsequence of crdt). The old base can be ahead of the new epoch:
 * it includes own edits the old relay never received (offline imports, pending
 * creates) and acked edits the migrating peer never saw before the reset. A
 * 3-way merge against such a base reads the peer's staleness as deletions and
 * drops local text. With base ⊑ crdt the crdt side only inserted, so no disk
 * text can be lost; otherwise null: the no-base merge keeps the disk side as a
 * conflict copy.
 */
export function trustedEpochBase(base: string | null, crdt: string): string | null {
	if (base === null || base.length > crdt.length) return null;
	let i = 0;
	for (let j = 0; i < base.length && j < crdt.length; j++) if (base.charCodeAt(i) === crdt.charCodeAt(j)) i++;
	return i === base.length ? base : null;
}

function rebaseOnDisk(ctx: Env["ctx"], s: SyncedEntry, D: string, F: DiskFingerprint, stat: { size: number; mtimeMs: number }) {
	const hash = markdownContentHash(D);
	const base = makeBase(s.docId, D, hash);
	const { fileGone: _gone, ...live } = s; // the disk holds the doc's file
	const entry = ctx.record({ ...live, contentHash: hash, fingerprint: F, size: stat.size, mtimeMs: stat.mtimeMs, hasBase: base !== null });
	return { entry, base };
}
