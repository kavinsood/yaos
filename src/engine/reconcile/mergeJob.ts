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
 * brings the file to the CRDT text.
 */

import type * as Y from "yjs";
import type { DiskFingerprint, DocId, LocalEntry, MergeResult, PlannerOp, SyncedEntry, VaultPath } from "../../core/types";
import { canonicalizeMarkdown, exactFingerprint, markdownContentHash } from "../../core/hash/markdownLf";
import { utf8Decode, utf8Length } from "../../core/hash/utf8";
import { merge } from "../../core/merge/merge";
import { minimalDiff } from "../../core/merge/minimalDiff";
import { brakeKey, isShrinkingOverwrite } from "../../core/plan/brake";
import { conflictName } from "../../core/plan/conflictName";
import type { IntentRecord } from "../store/schema";
import type { BodyHandle } from "./deps";
import { writeOk, type Env, type JobOutcome } from "./diskJobs";
import { intentId } from "./blobJobs";
import { hashBytes, MAX_TEXT_FILE_BYTES } from "./localState";
import { makeBase } from "./store";

export const MAX_CAS_ATTEMPTS = 3;

type ReconcileOp = Extract<PlannerOp, { op: "reconcileContent" }>;

/** Apply minimalDiff(from -> to) to the Y.Text in one transaction (end to start, offsets stay valid). */
export function applyMinimalDiff(h: BodyHandle, ytext: Y.Text, from: string, to: string): number {
	const edits = minimalDiff(from, to);
	if (edits.length === 0) return 0;
	h.doc.transact(() => {
		for (let i = edits.length - 1; i >= 0; i--) {
			const e = edits[i]!;
			if (e.end > e.start) ytext.delete(e.start, e.end - e.start);
			if (e.text.length > 0) ytext.insert(e.start, e.text);
		}
	}, h.mergeOrigin);
	return edits.length;
}

/** Job-level mass-overwrite brake for md writes (the planner cannot know M's size). */
function overwriteAllowed(env: Env, docId: DocId, path: VaultPath, oldBytes: number, newBytes: number, transition: string): boolean {
	const { ctx } = env;
	if (!isShrinkingOverwrite(ctx.brake, oldBytes, newBytes)) return true;
	const key = brakeKey("overwrite", docId, path, transition);
	if (env.approvedOverwrites.has(key)) return true;
	const threshold = Math.max(ctx.brake.minCount, ctx.brake.ratio * ctx.store.synced.size);
	if (ctx.window().overwrite + 1 <= threshold) return true;
	env.heldOverwrites.push({ key, path });
	return false;
}

export async function reconcileContent(env: Env, op: ReconcileOp): Promise<JobOutcome> {
	const { ctx } = env;
	if (op.kind === "canvas") {
		ctx.notice("warn", "canvas-unsupported", `canvas sync is not implemented yet: ${op.path}`, `canvas:${op.docId}`);
		return "fail";
	}
	const h = await ctx.log.acquireBody(op.docId, "markdown");
	if (!h) return "fail";
	try {
		return await mergeMarkdown(env, op, h);
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
	const storedBase = op.hasBase && s?.hasBase ? await ctx.store.loadBase(docId) : null;
	const ytext = h.doc.getText("text");

	let result: MergeResult | null = null;
	let crdt0 = "";
	let v0 = h.version();
	for (let attempt = 0; ; attempt++) {
		if (attempt >= MAX_CAS_ATTEMPTS) return "fail"; // remote kept moving: re-plan
		crdt0 = ytext.toString();
		const base = storedBase ?? (crdt0 === "" ? "" : null);
		await ctx.deps.clock.yieldNow();
		const res = merge({ base, disk: D, crdt: crdt0, limits: ctx.mergeLimits });
		const M = res.kind === "identical" ? D : res.text;
		if (!h.bound && M !== D && !overwriteAllowed(env, docId, op.path, rd.bytes.length, utf8Length(M), `${markdownContentHash(D)}>${markdownContentHash(M)}`)) {
			return "held";
		}
		// Synchronous section: CAS, apply, capture the version.
		if (ytext.toString() !== crdt0) continue;
		if (res.kind === "disk-only" || res.kind === "clean" || res.kind === "conflict") applyMinimalDiff(h, ytext, crdt0, res.text);
		v0 = h.version();
		result = res;
		break;
	}
	const v1 = await h.commitEdits();
	const bodyVersion = { remoteSeq: v0.remoteSeq, localOrder: v1.localOrder };
	const M = result.kind === "identical" ? D : result.text;

	// Conflict copy of the disk side (exact original bytes).
	let intent: IntentRecord | null = null;
	const local: LocalEntry[] = [];
	if (result.kind === "conflict") {
		const view = ctx.log.view();
		const copyPath = conflictName({
			path: op.path, docId, deviceLabel: ctx.deps.deviceLabel, nowMs: ctx.now(), tzOffsetMinutes: ctx.deps.tzOffsetMinutes?.() ?? 0,
			pathKey: ctx.pk, isTaken: (k) => ctx.local.has(k) || view.remoteByPathKey.has(k),
		});
		intent = {
			id: intentId("conflict-copy", docId, op.path), docId, kind: "conflict-copy", subjectHash: markdownContentHash(D),
			fromPath: op.path, toPath: copyPath, step: 1, createdAtMs: ctx.now(),
		};
		await ctx.commit({ intentPut: [intent] });
		const res = await ctx.exec({ t: "write", area: "vault", path: copyPath, data: { t: "bytes", bytes: rd.bytes }, precondition: { t: "absent" }, docId, purpose: "conflict-copy" });
		const out = writeOk(res);
		if (!out) {
			await ctx.commit({ intentDrop: [intent.id] });
			env.scan.markDirty(copyPath, null);
			return "fail";
		}
		ctx.echo.expectWrite(ctx.pk(copyPath), out.stat.size, out.stat.mtimeMs);
		ctx.noteDestructive("conflict");
		const hb = hashBytes("markdown", rd.bytes);
		local.push(ctx.localEntry(copyPath, out.stat, "markdown", hb.hash, out.fingerprint));
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

	// T_synced + T_intent_end.
	const hash = markdownContentHash(diskText);
	const base = makeBase(docId, diskText, hash);
	const entry = ctx.record({
		docId, path: op.path, pathKey: ctx.pk(op.path), kind: "markdown", contentHash: hash, fingerprint, size: stat.size, mtimeMs: stat.mtimeMs,
		bodyVersion, blobRev: 0, nsTouchSeq: ctx.touchSeq(docId), hasBase: base !== null,
	});
	const le = { ...ctx.localEntry(op.path, stat, "markdown", hash, fingerprint), bound: prevL?.bound ?? false };
	local.push(le);
	await ctx.commit(
		{ syncedPut: [entry], basePut: base ? [base] : [], baseDrop: base ? [] : [docId], intentDrop: intent ? [intent.id] : [] },
		local,
	);
	return "ok";
}

function rebaseOnDisk(ctx: Env["ctx"], s: SyncedEntry, D: string, F: DiskFingerprint, stat: { size: number; mtimeMs: number }) {
	const hash = markdownContentHash(D);
	const base = makeBase(s.docId, D, hash);
	const entry = ctx.record({ ...s, contentHash: hash, fingerprint: F, size: stat.size, mtimeMs: stat.mtimeMs, hasBase: base !== null });
	return { entry, base };
}
