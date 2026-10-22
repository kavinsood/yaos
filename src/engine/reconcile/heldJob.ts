/**
 * Held edits (DESIGN §f.6 "Held edits", SyncedEntry.held): an edit the write gate refused (key missing).
 *
 * Kept: a markdown / canvas content job whose merge the gate refuses records the disk content on S before the
 * KeyMissingError goes on (`keepHeld`): its hash always, its text with the base it was merged against while
 * HELD_TEXT_MAX_CHARS allows (`heldEditOf`). The store and the synced mirror carry both, so an IndexedDB loss with
 * the mirrors kept recovers them.
 *
 * Published (`publishHeld`, a reconcileContent op with `held`): planned for a live doc whose file is gone and pairs
 * with nothing (planner liveMissing). The held text merges against its base into the doc as the user's edit, the disk
 * untouched. S then records the held content as its sync point (base = the held text). With the replica at the held
 * text afterwards S takes the version; otherwise (a peer's edit) bodyVersion null, so the remote side reads as changed.
 * The next pass decides the file's absence against that doc: a delete, or edit beats delete with the held edit in.
 *
 * Past the bound, or with no base (mirror recovery before a merge stored one), the hash alone: rename inference still
 * pairs the unchanged file by it, and nothing is lost, the file holds the text; only a file renamed and edited again
 * unobserved then reads as a delete + a create (the user's removals in the doc may come back, never a lost text).
 */

import type { ContentHash, DocId, HeldEdit, LocalEntry, SyncedEntry } from "../../core/types";
import { HELD_TEXT_MAX_CHARS, MAX_BASE_TEXT_CHARS } from "../../core/limits";
import { utf8Encode } from "../../core/codec/lib0";
import { canvasToMergeText } from "../../core/hash/canvasCanonical";
import { merge } from "../../core/merge/merge";
import { applyEditsTo, minimalDiff } from "../../core/merge/minimalDiff";
import type { IntentRecord } from "../store/schema";
import { applyCanvas, baseSeenBy, projectCanvasBytes, projectionHash, readCanvas, visibleCanvas } from "./canvasDoc";
import { mergeCanvasSides, parseDiskCanvas, parseMergeText, type CanvasMergeOutput } from "./canvasMerge";
import { MAX_CAS_ATTEMPTS, writeConflictCopy, type ReconcileOp } from "./contentSteps";
import type { BodyHandle } from "./deps";
import type { Env, JobOutcome } from "./diskJobs";
import { hashBase, makeBase } from "./store";

/** Chars a held edit's texts take against HELD_TEXT_MAX_CHARS. */
function heldChars(h: HeldEdit | undefined): number {
	return h?.text === undefined ? 0 : h.text.length + (h.base?.length ?? 0);
}

/** The held edit to keep for `docId`: with its texts while the bound allows (theirs plus every other record's). */
export function heldEditOf(env: Env, docId: DocId, hash: ContentHash, text: string, base: string | null): HeldEdit {
	if (base === null || text.length > MAX_BASE_TEXT_CHARS || base.length > MAX_BASE_TEXT_CHARS) return { hash };
	let used = 0;
	for (const s of env.ctx.store.synced.values()) if (s.docId !== docId) used += heldChars(s.held);
	return used + text.length + base.length <= HELD_TEXT_MAX_CHARS ? { hash, text, base } : { hash };
}

/** Record `held` on the doc's synced record (no-op when S already is that content, or already holds it as well). */
export async function keepHeld(env: Env, docId: DocId, held: HeldEdit): Promise<void> {
	const { ctx } = env;
	const s = ctx.store.synced.get(docId);
	if (!s || held.hash === s.contentHash) return;
	if (s.held?.hash === held.hash && (s.held.text !== undefined || held.text === undefined)) return;
	await ctx.commit({ syncedPut: [{ ...s, held }] });
}

/** S without its held edit (kept on: the marks, the path). */
function released(s: SyncedEntry): Omit<SyncedEntry, "held"> {
	const { held: _held, ...rest } = s;
	return rest;
}

export async function publishHeld(env: Env, op: ReconcileOp, h: BodyHandle): Promise<JobOutcome> {
	const { ctx } = env;
	const s = ctx.synced(op.docId);
	const held = s?.held;
	if (!s || held?.text === undefined || held.base === undefined) return "ok"; // published (or dropped) since the plan
	return op.kind === "canvas" ? publishCanvas(env, op, h, s, held.hash, held.text, held.base) : publishMarkdown(env, op, h, s, held.hash, held.text, held.base);
}

async function publishMarkdown(env: Env, op: ReconcileOp, h: BodyHandle, s: SyncedEntry, hash: ContentHash, text: string, base: string): Promise<JobOutcome> {
	const { ctx } = env;
	const ytext = h.doc.getText("text");
	let result: ReturnType<typeof merge> | null = null;
	let crdt1 = "";
	let v0 = h.version();
	for (let attempt = 0; ; attempt++) {
		if (attempt >= MAX_CAS_ATTEMPTS) return "fail";
		const crdt0 = ytext.toString();
		await ctx.deps.clock.yieldNow();
		const res = merge({ base, disk: text, crdt: crdt0, limits: ctx.mergeLimits });
		if (ytext.toString() !== crdt0) continue;
		const apply = res.kind === "disk-only" || res.kind === "clean" || res.kind === "conflict";
		const edits = apply ? minimalDiff(crdt0, res.text) : [];
		if (edits.length > 0) {
			h.assertWritable();
			h.doc.transact(() => applyEditsTo(ytext, crdt0, edits), h.mergeOrigin);
		}
		crdt1 = apply ? res.text : crdt0;
		v0 = h.version();
		result = res;
		break;
	}
	const v1 = await h.commitEdits();
	const M = result.kind === "identical" ? text : result.text;
	let intent: IntentRecord | null = null;
	const local: LocalEntry[] = [];
	if (result.kind === "conflict") {
		const cc = await writeConflictCopy(env, op, utf8Encode(text), hash, "markdown");
		if (!cc) return "fail";
		ctx.deps.observeConflict?.(result.reason, "merge");
		intent = cc.intent;
		local.push(cc.local);
	}
	const synced = M === text && ytext.toString() === crdt1;
	const baseRec = makeBase(op.docId, text, hash);
	const entry = ctx.record({
		...released(s), contentHash: hash, bodyVersion: synced ? { remoteSeq: v0.remoteSeq, localOrder: v1.localOrder } : null, hasBase: baseRec !== null,
	});
	await ctx.commit({ syncedPut: [entry], basePut: baseRec ? [baseRec] : [], baseDrop: baseRec ? [] : [op.docId], intentDrop: intent ? [intent.id] : [] }, local);
	return "ok";
}

async function publishCanvas(env: Env, op: ReconcileOp, h: BodyHandle, s: SyncedEntry, hash: ContentHash, text: string, baseText: string): Promise<JobOutcome> {
	const { ctx } = env;
	const port = ctx.deps.hash;
	const bytes = utf8Encode(text);
	const disk = parseDiskCanvas(bytes);
	const base0 = parseMergeText(baseText);
	if (!disk.ok || !base0) {
		// Valid when kept; unreadable now (a codec change): the hash alone, as past the bound.
		await ctx.commit({ syncedPut: [ctx.record({ ...released(s), held: { hash } })] });
		return "ok";
	}
	let out: CanvasMergeOutput | null = null;
	let v0 = h.version();
	for (let attempt = 0; ; attempt++) {
		if (attempt >= MAX_CAS_ATTEMPTS) return "fail";
		const crdt = projectCanvasBytes(h.doc);
		if (!crdt.ok) return "fail";
		const token = canvasToMergeText(crdt.ranked);
		await ctx.deps.clock.yieldNow();
		const m = mergeCanvasSides({ base: baseSeenBy(base0, h.doc), disk: disk.data, crdt, limits: ctx.mergeLimits });
		const now = readCanvas(h.doc); // CAS on the visible CRDT merge text, as canvasJob
		if (!now.ok || canvasToMergeText(visibleCanvas(now.ranked)) !== token) continue;
		h.assertWritable();
		applyCanvas(h.doc, h.mergeOrigin, m.target);
		v0 = h.version();
		out = m;
		break;
	}
	const v1 = await h.commitEdits();
	let intent: IntentRecord | null = null;
	const local: LocalEntry[] = [];
	if (out.kind === "conflict") {
		const cc = await writeConflictCopy(env, op, bytes, hash, "canvas");
		if (!cc) return "fail";
		ctx.deps.observeConflict?.(out.reason ?? "both-edited", "canvas");
		intent = cc.intent;
		local.push(cc.local);
	}
	const synced = (await projectionHash(port, out.projection)) === hash;
	const baseRec = await hashBase(port, op.docId, canvasToMergeText(out.diskRanked));
	const entry = ctx.record({
		...released(s), contentHash: hash, bodyVersion: synced ? { remoteSeq: v0.remoteSeq, localOrder: v1.localOrder } : null, hasBase: baseRec !== null,
	});
	await ctx.commit({ syncedPut: [entry], basePut: baseRec ? [baseRec] : [], baseDrop: baseRec ? [] : [op.docId], intentDrop: intent ? [intent.id] : [] }, local);
	return "ok";
}
