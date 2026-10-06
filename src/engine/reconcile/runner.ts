/**
 * Plan runner (DESIGN §f.2 "Plan order"). Executes Plan.ops in order:
 *   - docs with an open intent are skipped entirely (intents.ts resolves them first);
 *   - rebinds run first, then every ns op goes to the log in ONE submitNs,
 *     except blob nsCreate / nsSetBlob, which wait for their pushBlob upload;
 *   - a markdown / canvas nsCreate with content first gets a "born empty" synced
 *     record (contentHash = hash of empty content, bodyVersion of the empty body, no base), committed
 *     BEFORE the submit: the initial content is then an ordinary disk-only merge
 *     from base "", and a crash between the create and the initial frames leaves
 *     S ≠ L, so the next pass re-runs the merge instead of waiting forever on
 *     "body-empty" (the planner cannot tell an own unwritten body from another
 *     device's in-flight one);
 *   - disk / content / bookkeeping ops run one by one (per-op gateway exec); the
 *     downloads of upcoming blob jobs start ahead (BlobTransfer.prefetch, bounded
 *     by the carrier), so N attachments cost about N / window round trips, not N;
 *   - when an op of a doc fails (or is held) the doc's later ops are skipped;
 *   - a "deferred" job (bound doc awaiting the editor's save) counts as a wait;
 *   - after the run, folders emptied by renames / trashes are removed, deepest first.
 * Unknown exceptions propagate (a crash is a crash; intents + T_synced make it safe).
 */

import type { DocId, NsOp, PlannerOp, VaultPath } from "../../core/types";
import { ancestorsOf } from "../../core/plan/pathRules";
import { EMPTY_CONTENT_HASH } from "../../core/plan/planner";
import type { SyncedRecord } from "../store/schema";
import { conflictCopy, fetchBlob, pushBlob } from "./blobJobs";
import { diskMaterializeCanvas } from "./canvasJob";
import { diskMaterialize, diskRename, diskTrash, rebind, syncedDrop, syncedPut, type Env, type JobOutcome } from "./diskJobs";
import { reconcileContent } from "./mergeJob";

export interface RunReport {
	readonly ok: number;
	readonly failed: number;
	readonly held: number;
	/** Jobs that ran but leave their doc waiting (not actionable until something outside changes). */
	readonly deferred: number;
	readonly skipped: number;
	readonly waits: number;
	readonly needHash: number;
	readonly nsSubmitted: number;
	readonly failedDocs: ReadonlySet<DocId>;
}

export function docsOf(op: PlannerOp): DocId[] {
	switch (op.op) {
		case "rebind": return [op.fromDocId, op.toDocId];
		case "syncedPut": return [op.entry.docId];
		case "needHash": return [];
		default: return op.docId === null ? [] : [op.docId];
	}
}

export function toNsOp(op: PlannerOp): NsOp | null {
	switch (op.op) {
		case "nsCreate": return { t: "create", docId: op.docId, kind: op.kind, path: op.path, contentHash: op.contentHash, size: op.size };
		case "nsRename": return { t: "rename", docId: op.docId, path: op.path };
		case "nsDelete": return { t: "delete", docId: op.docId, baseBodySeq: op.baseBodySeq };
		case "nsRestore": return { t: "restore", docId: op.docId, path: op.path, againstDeleteSeq: op.againstDeleteSeq };
		case "nsSetBlob": return { t: "setBlob", docId: op.docId, hash: op.hash, size: op.size, baseRev: op.baseRev };
		default: return null;
	}
}

async function runOne(env: Env, op: PlannerOp): Promise<JobOutcome> {
	switch (op.op) {
		case "rebind": return rebind(env, op);
		case "diskRename": return diskRename(env, op);
		case "diskMaterialize":
			return env.ctx.log.view().remote.get(op.docId)?.kind === "canvas" ? diskMaterializeCanvas(env, op) : diskMaterialize(env, op);
		case "diskTrash": return diskTrash(env, op);
		case "conflictCopy": return conflictCopy(env, op);
		case "reconcileContent": return reconcileContent(env, op);
		case "pushBlob": return pushBlob(env, op);
		case "fetchBlob": return fetchBlob(env, op);
		case "syncedPut": return syncedPut(env, op);
		case "syncedDrop": return syncedDrop(env, op);
		default: return "ok";
	}
}

export async function runPlan(env: Env, ops: readonly PlannerOp[]): Promise<RunReport> {
	const { ctx } = env;
	const skip = new Set<DocId>(ctx.intentDocs());
	const failedDocs = new Set<DocId>();
	const vacated: VaultPath[] = [];
	let ok = 0, failed = 0, held = 0, deferred = 0, skipped = 0, waits = 0, needHash = 0, nsSubmitted = 0;
	const blocked = (op: PlannerOp): boolean => docsOf(op).some((d) => skip.has(d));
	const note = (op: PlannerOp, res: JobOutcome): void => {
		if (res === "ok") {
			ok++;
			return;
		}
		if (res === "deferred") {
			deferred++;
			return;
		}
		if (res === "held") held++;
		else failed++;
		for (const d of docsOf(op)) {
			skip.add(d);
			failedDocs.add(d);
		}
	};
	env.deferred.clear();

	let i = 0;
	for (; i < ops.length && ops[i]!.op === "rebind"; i++) {
		const op = ops[i]!;
		if (blocked(op)) skipped++;
		else note(op, await runOne(env, op));
	}

	const ns: NsOp[] = [];
	const born: SyncedRecord[] = [];
	for (; i < ops.length && toNsOp(ops[i]!) !== null; i++) {
		const op = ops[i]!;
		if (blocked(op)) {
			skipped++;
			continue;
		}
		const nsOp = toNsOp(op)!;
		if ((nsOp.t === "create" && nsOp.kind === "blob") || nsOp.t === "setBlob") {
			env.deferred.set(nsOp.docId, nsOp);
			continue;
		}
		if (nsOp.t === "delete") ctx.noteDestructive("nsDelete");
		if (nsOp.t === "create" && nsOp.kind !== "blob" && nsOp.contentHash !== EMPTY_CONTENT_HASH) {
			const b = bornEmpty(env, nsOp.docId, nsOp.kind, nsOp.path);
			if (b) born.push(b);
		}
		ns.push(nsOp);
	}
	if (born.length > 0) await ctx.commit({ syncedPut: born });
	if (ns.length > 0) {
		await ctx.log.submitNs(ns);
		nsSubmitted += ns.length;
		ok += ns.length;
	}

	const ahead = prefetcher(env, ops, blocked);
	for (; i < ops.length; i++) {
		ahead.pump(i);
		const op = ops[i]!;
		if (op.op === "wait") {
			waits++;
			continue;
		}
		if (op.op === "needHash") {
			needHash++;
			continue;
		}
		if (blocked(op)) {
			skipped++;
			continue;
		}
		if (toNsOp(op) !== null) throw new Error(`ns op out of order: ${op.op}`);
		const res = await runOne(env, op);
		note(op, res);
		if (res === "ok" && op.op === "diskRename") vacated.push(op.from);
		if (res === "ok" && op.op === "diskTrash") vacated.push(op.path);
	}
	ahead.done();
	env.deferred.clear();
	await removeEmptied(env, vacated);
	return { ok, failed, held, deferred, skipped, waits, needHash, nsSubmitted, failedDocs };
}

/** The download a blob job will make: diskMaterialize of a live blob doc, fetchBlob. */
function blobReqOf(env: Env, op: PlannerOp): { hash: string; docId: DocId; path: VaultPath; size: number } | null {
	if (op.op === "fetchBlob") return { hash: op.hash, docId: op.docId, path: op.path, size: op.size };
	if (op.op !== "diskMaterialize") return null;
	const r = env.ctx.log.view().remote.get(op.docId);
	return r?.state === "live" && r.kind === "blob" && r.blob ? { hash: r.blob.hash, docId: op.docId, path: op.path, size: r.blob.size } : null;
}

/** Keeps the carrier's prefetch window full with the next blob jobs at or after the running op. */
function prefetcher(env: Env, ops: readonly PlannerOp[], blocked: (op: PlannerOp) => boolean) {
	const blobs = env.ctx.deps.blobs;
	let next = 0;
	return {
		pump(at: number): void {
			if (!blobs?.prefetch) return;
			for (next = Math.max(next, at); next < ops.length; next++) {
				const op = ops[next]!;
				const req = blocked(op) ? null : blobReqOf(env, op);
				if (req && !blobs.prefetch(req)) return;
			}
		},
		done(): void {
			blobs?.dropPrefetched?.();
		},
	};
}

/** S for a markdown / canvas doc about to be created: the empty body, stat of the local file. */
function bornEmpty(env: Env, docId: DocId, kind: "markdown" | "canvas", path: VaultPath): SyncedRecord | null {
	const { ctx } = env;
	if (ctx.synced(docId)) return null;
	const l = ctx.localAt(path);
	if (!l || l.fingerprint === null) return null;
	return ctx.record({
		docId, path, pathKey: ctx.pk(path), kind, contentHash: EMPTY_CONTENT_HASH, fingerprint: l.fingerprint, size: l.size,
		mtimeMs: l.mtimeMs, bodyVersion: { remoteSeq: 0, localOrder: 0 }, blobRev: 0, nsTouchSeq: 0, hasBase: false,
	});
}

/** Remove folders left empty by renames / trashes (the host never removes non-empty ones). */
async function removeEmptied(env: Env, vacated: readonly VaultPath[]): Promise<void> {
	const { ctx } = env;
	if (vacated.length === 0) return;
	const folders = new Set<string>();
	for (const p of vacated) for (const a of ancestorsOf(p)) folders.add(a);
	const occupied = new Set<string>();
	for (const l of ctx.local.values()) for (const a of ancestorsOf(l.path)) occupied.add(ctx.pk(a));
	const order = [...folders].filter((f) => !occupied.has(ctx.pk(f))).sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1));
	for (const f of order) await ctx.exec({ t: "removeEmptyFolder", path: f });
}
