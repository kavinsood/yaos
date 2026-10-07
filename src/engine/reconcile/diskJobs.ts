/**
 * Disk-only plan ops (DESIGN §f.2): rebind, diskRename, diskMaterialize,
 * diskTrash, syncedPut/syncedDrop. Blob transfers live in blobJobs.ts, the
 * markdown merge in mergeJob.ts, canvas merge / materialize in canvasJob.ts.
 *
 * Every job returns "ok" or "fail". A failed job leaves S untouched (the next
 * plan sees the same or newer facts and decides again) and the runner skips
 * the doc's later ops. Unknown exceptions propagate.
 */

import type { ContentHash, DocId, NsBlobRef, NsOp, PlannerOp, VaultPath } from "../../core/types";
import { markdownContentHash } from "../../core/hash/markdownLf";
import { restartAtCreate } from "../../core/plan/planner";
import type { VaultStat } from "../../ports/vault";
import type { Ctx } from "./context";
import type { ExecResult, WrittenOk } from "./deps";
import type { Scanner } from "./scan";
import { makeBase } from "./store";

/** "deferred": the job ran, the doc now waits outside the engine (a bound editor's save); counted like a wait. */
export type JobOutcome = "ok" | "fail" | "held" | "deferred";

export interface Env {
	readonly ctx: Ctx;
	readonly scan: Scanner;
	/** Blob ns ops (nsCreate kind blob, nsSetBlob) waiting for their upload; pushBlob submits them. */
	readonly deferred: Map<DocId, NsOp>;
	/** brakeKeys of shrinking md overwrites held by the job-level brake in this pass. */
	readonly heldOverwrites: { key: string; path: VaultPath }[];
	/** brakeKeys the user approved (approveBrake of a job-level report). */
	readonly approvedOverwrites: Set<string>;
}

type Op<K extends PlannerOp["op"]> = Extract<PlannerOp, { op: K }>;

export function writeOk(res: ExecResult): WrittenOk | null {
	return res.t === "write" && res.outcome.ok ? res.outcome : null;
}

export function moveOk(res: ExecResult): VaultStat | null {
	return (res.t === "rename" || res.t === "trash") && res.outcome.ok ? res.outcome.stat : null;
}

/**
 * rebind: the doc's synced record (and base) now belong to the winner (§c.5 alias, identical-loser collapse). A §c.12
 * migrated loser's record is dropped instead (op.adopt): moved, its base (this device's own text) would be the
 * winner's sync point for any merge before the planned one against the epoch base, and the winner's text would read
 * as the deletion of this device's edits (E7 suite-1 sim, seed 32: a bound editor's attach, or a retried merge).
 */
export async function rebind(env: Env, op: Op<"rebind">): Promise<JobOutcome> {
	const { ctx } = env;
	const s = ctx.synced(op.fromDocId);
	if (!s) return "ok";
	if (op.adopt || ctx.synced(op.toDocId)) {
		await ctx.commit({ syncedDrop: [op.fromDocId], baseDrop: [op.fromDocId] });
		ctx.deps.onRebind?.(op.fromDocId, op.toDocId);
		return "ok";
	}
	// A merged alias restarts at the winner's create, as the planner planned it; an identical collapse (live loser) keeps S.
	const view = ctx.log.view().remote;
	const winner = view.get(op.toDocId);
	const from = winner && view.get(op.fromDocId)?.state !== "live" ? restartAtCreate(s, winner.createHash) : s;
	const moved = ctx.record({ ...from, docId: op.toDocId, path: op.path, pathKey: ctx.pk(op.path) });
	await ctx.commit({
		syncedDrop: [op.fromDocId], syncedPut: [moved],
		baseMove: from.hasBase ? [{ from: op.fromDocId, to: op.toDocId }] : [], baseDrop: s.hasBase && !from.hasBase ? [op.fromDocId] : [],
	});
	ctx.deps.onRebind?.(op.fromDocId, op.toDocId);
	return "ok";
}

/** Plain vault rename (never fileManager.renameFile): remote moves must not rewrite links. */
export async function diskRename(env: Env, op: Op<"diskRename">): Promise<JobOutcome> {
	const { ctx } = env;
	const from = ctx.diskPathOf(op.from);
	const res = await ctx.exec({ t: "rename", from, to: op.to, precondition: op.expect, docId: op.docId, purpose: op.docId === null ? "loser-rename" : "remote-move" });
	const stat = moveOk(res);
	if (!stat) {
		env.scan.markDirty(from, null);
		env.scan.markDirty(op.to, null);
		return "fail";
	}
	const fromKey = ctx.pk(op.from);
	const toKey = ctx.pk(op.to);
	ctx.echo.expectRename(fromKey, toKey);
	const old = ctx.local.get(fromKey);
	const kind = old?.kind ?? ctx.classify(op.to, stat.size).kind;
	const entry = old
		? { ...old, diskPath: stat.path, path: op.to, pathKey: toKey, size: stat.size, mtimeMs: stat.mtimeMs, hashedAtMs: ctx.now() }
		: ctx.localEntry(op.to, stat, kind, op.expect.t === "hash" ? op.expect.hash : null, null);
	// S follows the file in the same tx as L: a crash between the renames of a
	// cycle (or before the plan's final syncedPut) never leaves two synced
	// records at one path, and a temp name stays tracked as the doc's file.
	const s = op.docId === null ? undefined : ctx.synced(op.docId);
	const moved = s && s.pathKey === fromKey && fromKey !== toKey ? [ctx.record({ ...s, path: op.to, pathKey: toKey })] : [];
	await ctx.commit({ syncedPut: moved }, [entry], fromKey === toKey ? [] : [fromKey]);
	return "ok";
}

/** Recoverable delete only (obsidian or system trash): invariant 2. */
export async function diskTrash(env: Env, op: Op<"diskTrash">): Promise<JobOutcome> {
	const { ctx } = env;
	const path = ctx.diskPathOf(op.path);
	const res = await ctx.exec({ t: "trash", path, mode: ctx.deps.settings.trashMode, precondition: op.expect, docId: op.docId, purpose: "remote-delete" });
	const key = ctx.pk(op.path);
	if (!moveOk(res)) {
		if ((res.t === "trash" || res.t === "rename") && !res.outcome.ok && res.outcome.reason === "source-missing") {
			await ctx.commit({}, [], [key]);
			return "ok";
		}
		env.scan.markDirty(path, null);
		return "fail";
	}
	ctx.echo.expectTrash(key);
	ctx.noteDestructive("diskTrash");
	await ctx.commit({}, [], [key]);
	return "ok";
}

/** Create a file for a remote doc that is absent locally (precondition absent). */
export async function diskMaterialize(env: Env, op: Op<"diskMaterialize">): Promise<JobOutcome> {
	const { ctx } = env;
	const r = ctx.log.view().remote.get(op.docId);
	if (!r || r.state !== "live") return "fail";
	if (r.kind === "blob") return materializeBlob(env, op, r.blob);
	if (r.kind === "canvas") return "fail"; // the runner routes canvas docs to canvasJob.diskMaterializeCanvas
	const h = await ctx.log.acquireBody(op.docId, "markdown");
	if (!h) return "fail";
	try {
		const text = h.doc.getText("text").toString();
		const version = h.version();
		const res = await ctx.exec({ t: "write", area: "vault", path: op.path, data: { t: "text", text }, precondition: { t: "absent" }, docId: op.docId, purpose: "materialize" });
		const out = writeOk(res);
		if (!out) {
			env.scan.markDirty(op.path, null);
			return "fail";
		}
		const hash = markdownContentHash(text);
		const base = makeBase(op.docId, text, hash);
		ctx.echo.expectWrite(ctx.pk(op.path), out.stat.size, out.stat.mtimeMs);
		const entry = ctx.record({
			docId: op.docId, path: op.path, pathKey: ctx.pk(op.path), kind: "markdown", contentHash: hash, fingerprint: out.fingerprint,
			size: out.stat.size, mtimeMs: out.stat.mtimeMs, bodyVersion: version, blobRev: 0, nsTouchSeq: ctx.touchSeq(op.docId), hasBase: base !== null,
		});
		await ctx.commit(
			{ syncedPut: [entry], basePut: base ? [base] : [], baseDrop: base ? [] : [op.docId] },
			[ctx.localEntry(op.path, out.stat, "markdown", hash, out.fingerprint)],
		);
		return "ok";
	} finally {
		h.release();
	}
}

async function materializeBlob(env: Env, op: Op<"diskMaterialize">, blob: NsBlobRef | null): Promise<JobOutcome> {
	const { ctx } = env;
	const blobs = ctx.deps.blobs;
	if (!blob) return "fail";
	if (!blobs) {
		ctx.notice("warn", "no-blob-carrier", "attachments cannot be transferred: no blob carrier", "no-blob-carrier");
		return "fail";
	}
	const bytes = await blobs.download({ hash: blob.hash, docId: op.docId, path: op.path, size: blob.size });
	if (!bytes) return "fail";
	const res = await ctx.exec({ t: "write", area: "vault", path: op.path, data: { t: "bytes", bytes }, precondition: { t: "absent" }, docId: op.docId, purpose: "materialize" });
	const out = writeOk(res);
	if (!out) {
		env.scan.markDirty(op.path, null);
		return "fail";
	}
	const hash = out.fingerprint as string as ContentHash;
	ctx.echo.expectWrite(ctx.pk(op.path), out.stat.size, out.stat.mtimeMs);
	const entry = ctx.record({
		docId: op.docId, path: op.path, pathKey: ctx.pk(op.path), kind: "blob", contentHash: hash, fingerprint: out.fingerprint,
		size: out.stat.size, mtimeMs: out.stat.mtimeMs, bodyVersion: null, blobRev: hash === blob.hash ? blob.rev : 0, nsTouchSeq: ctx.touchSeq(op.docId), hasBase: false,
	});
	await ctx.commit({ syncedPut: [entry] }, [ctx.localEntry(op.path, out.stat, "blob", hash, out.fingerprint)]);
	return "ok";
}

export async function syncedPut(env: Env, op: Op<"syncedPut">): Promise<JobOutcome> {
	await env.ctx.commit({ syncedPut: [env.ctx.record(op.entry)] });
	return "ok";
}

export async function syncedDrop(env: Env, op: Op<"syncedDrop">): Promise<JobOutcome> {
	await env.ctx.commit({ syncedDrop: [op.docId], baseDrop: [op.docId] });
	return "ok";
}
