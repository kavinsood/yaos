/**
 * Canvas content jobs (DESIGN §j.2): reconcileContent, diskMaterialize and the
 * conflict-copy resume for "c:<docId>" docs. Same I1 order as markdown
 * (mergeJob.ts header):
 *   1. read disk (bytes, fingerprint F); parse + validate. Invalid disk or CRDT
 *      -> notice "canvas-invalid", no write, no frames ("fail"; the planner
 *      retries when something changes).
 *   2. canvas merge (canvasMerge.ts) over the record-per-line merge text
 *   3. CAS on the visible CRDT merge text, applyCanvas in one MERGE tx, T_edit
 *   4. conflict: conflict-copy intent + copy of the exact disk bytes
 *   5. write the projection (precondition F) unless its logical hash equals the
 *      disk's: formatting-only differences are never rewritten
 *   6. T_synced: S.contentHash = canvasContentHash of the bytes now on disk,
 *      base = merge text of the visible target (ranks included)
 * A failed step-5 precondition rebases S on the disk side D (hash, stat, base
 * D ranked) and keeps bodyVersion, as for markdown.
 *
 * Canvas views are never bound (§j.2): h.bound is ignored, the file is written.
 * Content hash (decision): canvasContentHash = logical hash over the canonical
 * bytes, the same function in localState (L), here (S) and for streams.textHash
 * (canvasDocHash of the projection), so adoption without I/O works and a
 * reformatted file is not a change.
 */

import type { DiskFingerprint, DocId, LocalEntry, PlannerOp, SyncedEntry, VaultPath } from "../../core/types";
import { exactFingerprint } from "../../core/hash/markdownLf";
import { canvasLogicalHash, canvasToMergeText, type CanvasRanked } from "../../core/hash/canvasCanonical";
import { isShrinkingOverwrite } from "../../core/plan/brake";
import type { IntentRecord } from "../store/schema";
import { applyCanvas, emptyCanvas, projectCanvasBytes, readCanvas, visibleCanvas } from "./canvasDoc";
import { isEmptyCanvas, mergeCanvasSides, parseDiskCanvas, parseMergeText, rankDisk, type CanvasMergeOutput } from "./canvasMerge";
import { MAX_CAS_ATTEMPTS, overwriteAllowed, writeConflictCopy, type ReconcileOp } from "./contentSteps";
import type { BodyHandle } from "./deps";
import { writeOk, type Env, type JobOutcome } from "./diskJobs";
import { MAX_TEXT_FILE_BYTES } from "./localState";
import { makeBase } from "./store";

function invalid(env: Env, docId: DocId, path: VaultPath, reason: string, onceKey: string): JobOutcome {
	env.ctx.notice("warn", "canvas-invalid", `canvas not synced (${reason}): ${path}`, `canvas-invalid:${docId}:${onceKey}`);
	return "fail";
}

/** Visible CRDT merge text (CAS token), null if the CRDT is invalid. */
function crdtToken(h: BodyHandle): string | null {
	const r = readCanvas(h.doc);
	return r.ok ? canvasToMergeText(visibleCanvas(r.ranked)) : null;
}

export async function mergeCanvas(env: Env, op: ReconcileOp, h: BodyHandle): Promise<JobOutcome> {
	const { ctx } = env;
	const docId = op.docId;
	const diskPath = ctx.diskPathOf(op.path);
	const rd = await ctx.read(diskPath, MAX_TEXT_FILE_BYTES);
	if (!rd.ok) {
		if (rd.reason === "too-large") ctx.notice("warn", "text-too-large", `canvas too large to sync: ${op.path}`, `big:${op.path}`);
		env.scan.markDirty(diskPath, rd.reason === "missing" ? null : rd.stat);
		return "fail";
	}
	const F = exactFingerprint(rd.bytes);
	const disk = parseDiskCanvas(rd.bytes);
	if (!disk.ok) return invalid(env, docId, op.path, `disk: ${disk.reason}`, F);
	const diskHash = canvasLogicalHash(disk.data);
	const s = ctx.synced(docId);
	const baseText = op.hasBase && s?.hasBase ? await ctx.store.loadBase(docId) : null;
	const storedBase = baseText === null ? null : parseMergeText(baseText);

	let out: CanvasMergeOutput | null = null;
	let v0 = h.version();
	for (let attempt = 0; ; attempt++) {
		if (attempt >= MAX_CAS_ATTEMPTS) return "fail"; // remote kept moving: re-plan
		const crdt = projectCanvasBytes(h.doc);
		if (!crdt.ok) return invalid(env, docId, op.path, `crdt: ${crdt.reason}`, `crdt:${h.version().remoteSeq}`);
		const token = canvasToMergeText(crdt.ranked);
		// No stored base: a side still at the synced content is the base (see mergeJob).
		const base = storedBase ?? (isEmptyCanvas(crdt.ranked) ? emptyCanvas() : !s ? null : diskHash === s.contentHash ? rankDisk(disk.data, null, crdt.ranked) : crdt.hash === s.contentHash ? crdt.ranked : null);
		await ctx.deps.clock.yieldNow();
		const m = mergeCanvasSides({ base, disk: disk.data, crdt, limits: ctx.mergeLimits });
		if (m.projection.hash !== diskHash
			&& !overwriteAllowed(env, docId, op.path, rd.bytes.length, m.projection.bytes.length, `${diskHash}>${m.projection.hash}`)) {
			return "held";
		}
		// Synchronous section: CAS, apply, capture the version.
		if (crdtToken(h) !== token) continue;
		applyCanvas(h.doc, h.mergeOrigin, m.target);
		v0 = h.version();
		out = m;
		break;
	}
	const v1 = await h.commitEdits();
	const bodyVersion = { remoteSeq: v0.remoteSeq, localOrder: v1.localOrder };

	let intent: IntentRecord | null = null;
	const local: LocalEntry[] = [];
	if (out.kind === "conflict") {
		const cc = await writeConflictCopy(env, op, rd.bytes, diskHash, "canvas");
		if (!cc) return "fail";
		intent = cc.intent;
		local.push(cc.local);
	}

	let stat = rd.stat;
	let fingerprint = F;
	let hash = diskHash;
	if (out.projection.hash !== diskHash) {
		const res = await ctx.exec({
			t: "write", area: "vault", path: diskPath, data: { t: "text", text: out.projection.text },
			precondition: { t: "fingerprint", fingerprint: F }, docId, purpose: "merge",
		});
		const w = writeOk(res);
		if (!w) {
			const rebased = s ? rebaseOnDisk(env, s, out.diskRanked, F, rd.stat) : null;
			await ctx.commit({
				intentDrop: intent ? [intent.id] : [],
				syncedPut: rebased ? [rebased.entry] : [],
				basePut: rebased?.base ? [rebased.base] : [],
				baseDrop: rebased && !rebased.base ? [docId] : [],
			}, local);
			env.scan.markDirty(diskPath, null);
			return "fail";
		}
		ctx.echo.expectWrite(ctx.pk(op.path), w.stat.size, w.stat.mtimeMs);
		if (isShrinkingOverwrite(ctx.brake, rd.bytes.length, w.stat.size)) ctx.noteDestructive("overwrite");
		stat = w.stat;
		fingerprint = w.fingerprint;
		hash = out.projection.hash;
	}

	const base = makeBase(docId, canvasToMergeText(out.projection.ranked));
	const entry = ctx.record({
		docId, path: op.path, pathKey: ctx.pk(op.path), kind: "canvas", contentHash: hash, fingerprint, size: stat.size, mtimeMs: stat.mtimeMs,
		bodyVersion, blobRev: 0, nsTouchSeq: ctx.touchSeq(docId), hasBase: base !== null,
	});
	local.push(ctx.localEntry(op.path, stat, "canvas", hash, fingerprint));
	await ctx.commit(
		{ syncedPut: [entry], basePut: base ? [base] : [], baseDrop: base ? [] : [docId], intentDrop: intent ? [intent.id] : [] },
		local,
	);
	return "ok";
}

function rebaseOnDisk(env: Env, s: SyncedEntry, disk: CanvasRanked, F: DiskFingerprint, stat: { size: number; mtimeMs: number }) {
	const base = makeBase(s.docId, canvasToMergeText(disk));
	const entry = env.ctx.record({ ...s, contentHash: canvasLogicalHash(disk.data), fingerprint: F, size: stat.size, mtimeMs: stat.mtimeMs, hasBase: base !== null });
	return { entry, base };
}

type MaterializeOp = Extract<PlannerOp, { op: "diskMaterialize" }>;

/** diskMaterialize of a canvas doc (the runner routes canvas docs here): write the projection (precondition absent), S + base. */
export async function diskMaterializeCanvas(env: Env, op: MaterializeOp): Promise<JobOutcome> {
	const r = env.ctx.log.view().remote.get(op.docId);
	if (!r || r.state !== "live" || r.kind !== "canvas") return "fail";
	const h = await env.ctx.log.acquireBody(op.docId, "canvas");
	if (!h) return "fail";
	try {
		return await materializeCanvas(env, op, h);
	} finally {
		h.release();
	}
}

async function materializeCanvas(env: Env, op: MaterializeOp, h: BodyHandle): Promise<JobOutcome> {
	const { ctx } = env;
	const version = h.version();
	const p = projectCanvasBytes(h.doc);
	if (!p.ok) return invalid(env, op.docId, op.path, `crdt: ${p.reason}`, `crdt:${version.remoteSeq}`);
	const res = await ctx.exec({ t: "write", area: "vault", path: op.path, data: { t: "text", text: p.text }, precondition: { t: "absent" }, docId: op.docId, purpose: "materialize" });
	const out = writeOk(res);
	if (!out) {
		env.scan.markDirty(op.path, null);
		return "fail";
	}
	ctx.echo.expectWrite(ctx.pk(op.path), out.stat.size, out.stat.mtimeMs);
	const base = makeBase(op.docId, canvasToMergeText(p.ranked));
	const entry = ctx.record({
		docId: op.docId, path: op.path, pathKey: ctx.pk(op.path), kind: "canvas", contentHash: p.hash, fingerprint: out.fingerprint,
		size: out.stat.size, mtimeMs: out.stat.mtimeMs, bodyVersion: version, blobRev: 0, nsTouchSeq: ctx.touchSeq(op.docId), hasBase: base !== null,
	});
	await ctx.commit(
		{ syncedPut: [entry], basePut: base ? [base] : [], baseDrop: base ? [] : [op.docId] },
		[ctx.localEntry(op.path, out.stat, "canvas", p.hash, out.fingerprint)],
	);
	return "ok";
}
