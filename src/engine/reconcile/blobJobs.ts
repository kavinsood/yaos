/**
 * Blob plan ops (DESIGN §c.8, §j.1): conflictCopy (blob keep-both), fetchBlob
 * (overwrite an existing file with the remote blob), pushBlob (upload, then
 * submit the deferred nsCreate/nsSetBlob).
 *
 * Transfers run in the background (blobs/blobQueue.ts): fetchBlob and pushBlob
 * claim theirs and answer "inflight" until it settled; its docs are then
 * planned again, and the new pass's job takes the outcome. So every write and
 * every ns op is decided from the facts of the pass that makes it.
 *
 * keep-both (E8) runs under a `keep-both-blob` intent: conflictCopy begins it
 * before the copy is written, fetchBlob ends it in its T_synced. A crash in
 * between is resolved by intents.ts.
 */

import type { ContentHash, DocId, PlannerOp, VaultPath } from "../../core/types";
import { isShrinkingOverwrite } from "../../core/plan/brake";
import type { VaultStat, WritePrecondition } from "../../ports/vault";
import type { IntentRecord } from "../store/schema";
import type { UploadSource } from "./context";
import { hashBytes } from "./localState";
import { blobStore, writeOk, type Env, type JobOutcome } from "./diskJobs";

type Op<K extends PlannerOp["op"]> = Extract<PlannerOp, { op: K }>;

export function intentId(kind: IntentRecord["kind"], docId: DocId | null, path: VaultPath): string {
	return `${kind}:${docId ?? path}`;
}

/** Copy the local side of a blob conflict to `to` (precondition absent) under a keep-both intent. */
export async function conflictCopy(env: Env, op: Op<"conflictCopy">): Promise<JobOutcome> {
	const { ctx } = env;
	if (op.expect.t !== "hash") return "fail";
	const src = ctx.diskPathOf(op.from);
	const r = await ctx.read(src, ctx.classifySettings.maxBlobBytes);
	if (!r.ok) {
		env.scan.markDirty(src, null);
		return "fail";
	}
	const h = await hashBytes(ctx.deps.hash, "blob", r.bytes);
	if (h.hash !== op.expect.hash) {
		env.scan.markDirty(src, r.stat);
		return "fail";
	}
	const intent: IntentRecord = {
		id: intentId("keep-both-blob", op.docId, op.from), docId: op.docId, kind: "keep-both-blob", subjectHash: h.hash,
		fromPath: op.from, toPath: op.to, step: 1, createdAtMs: ctx.now(),
	};
	await ctx.commit({ intentPut: [intent] });
	const res = await ctx.exec({ t: "write", area: "vault", path: op.to, data: { t: "bytes", bytes: r.bytes }, precondition: { t: "absent" }, docId: op.docId, purpose: "conflict-copy" });
	const out = writeOk(res);
	if (!out) {
		await ctx.commit({ intentDrop: [intent.id] });
		env.scan.markDirty(op.to, null);
		return "fail";
	}
	ctx.echo.expectWrite(ctx.pk(op.to), out.stat.size, out.stat.mtimeMs);
	ctx.noteConflictCopy(op.from, op.to);
	await ctx.commit({}, [ctx.localEntry(op.to, out.stat, "blob", h.hash, out.fingerprint)]);
	return "ok";
}

/**
 * Write the downloaded `hash` over `path` (CAS on `precondition`), then
 * T_synced for the doc + end of any keep-both intent. Used by fetchBlob and by
 * intent resume. "inflight" = downloading (the doc is planned again when it
 * settles); "fail" = unavailable now or the file changed; "held" = no blob store.
 */
export async function fetchAndWrite(env: Env, docId: DocId, path: VaultPath, hash: ContentHash, size: number, precondition: WritePrecondition): Promise<JobOutcome> {
	const { ctx } = env;
	const blobs = blobStore(env);
	if (!blobs) return "held";
	const got = blobs.claimDownload({ hash, docId, path, size });
	if (got.t === "busy") return "inflight";
	if (got.t === "unavailable") return "fail";
	const bytes = got.bytes;
	const old = ctx.localAt(path);
	const res = await ctx.exec({ t: "write", area: "vault", path: ctx.diskPathOf(path), data: { t: "bytes", bytes }, precondition, docId, purpose: "materialize" });
	const out = writeOk(res);
	if (!out) {
		env.scan.markDirty(ctx.diskPathOf(path), null);
		return "fail";
	}
	ctx.echo.expectWrite(ctx.pk(path), out.stat.size, out.stat.mtimeMs);
	if (old && isShrinkingOverwrite(ctx.brake, old.size, out.stat.size)) ctx.noteDestructive("overwrite");
	const r = ctx.log.view().remote.get(docId);
	const s = ctx.synced(docId);
	const blobRev = r?.blob && r.blob.hash === hash ? r.blob.rev : (s?.blobRev ?? 0);
	const entry = ctx.record({
		docId, path, pathKey: ctx.pk(path), kind: "blob", contentHash: hash, fingerprint: out.fingerprint, size: out.stat.size, mtimeMs: out.stat.mtimeMs,
		bodyVersion: null, blobRev, nsTouchSeq: ctx.touchSeq(docId), hasBase: false,
	});
	const intentDrop = [...ctx.store.intents.values()].filter((i) => i.docId === docId && i.kind === "keep-both-blob").map((i) => i.id);
	await ctx.commit({ syncedPut: [entry], intentDrop }, [ctx.localEntry(path, out.stat, "blob", hash, out.fingerprint)]);
	return "ok";
}

export async function fetchBlob(env: Env, op: Op<"fetchBlob">): Promise<JobOutcome> {
	const l = env.ctx.localAt(op.path);
	const pre: WritePrecondition = l?.hash ? { t: "hash", hash: l.hash } : { t: "absent" };
	return fetchAndWrite(env, op.docId, op.path, op.hash, op.size, pre);
}

/**
 * Upload the local file's bytes: claim the upload (started or joined in the
 * background, "inflight"), and once the store confirmed it, submit the doc's
 * deferred ns op, so no ns entry ever points at a blob that readers cannot
 * fetch. A brand-new doc gets a synced record (blobRev 0, nsTouchSeq 0) unless
 * the S1 fold already wrote one. "held" = no blob store, or the store refused
 * these bytes by size: retrying cannot help, so no retry is armed and the doc
 * stays local.
 *
 * A crash before the ns op leaves S as it was (L ≠ S): the next start plans
 * the same upload again (idempotent; has() skips a stored blob).
 */
export async function pushBlob(env: Env, op: Op<"pushBlob">): Promise<JobOutcome> {
	const { ctx } = env;
	const blobs = blobStore(env);
	if (!blobs) return "held";
	const claim = blobs.claimUpload({ hash: op.hash, docId: op.docId, path: op.path, size: op.size }, uploadSource(env, op.path, blobs.maxBlobBytes));
	if (claim === "busy") return "inflight";
	if (claim === "refused") return "held";
	if (claim === "unavailable") return "fail";
	// Stored. The plan's local entry is the file that was hashed; it moved on since (re-hash pending): re-plan.
	const l = ctx.localAt(op.path);
	if (!l || l.hash !== op.hash || l.fingerprint === null) return "fail";
	const deferred = env.deferred.get(op.docId);
	if (deferred) {
		env.deferred.delete(op.docId);
		await ctx.log.submitNs([deferred]);
	}
	if (!ctx.synced(op.docId) && deferred?.t === "create") {
		const entry = ctx.record({
			docId: op.docId, path: op.path, pathKey: ctx.pk(op.path), kind: "blob", contentHash: op.hash, fingerprint: l.fingerprint, size: l.size,
			mtimeMs: l.mtimeMs, bodyVersion: null, blobRev: 0, nsTouchSeq: 0, hasBase: false,
		});
		await ctx.commit({ syncedPut: [entry] });
	}
	return "ok";
}

/** Where pushBlob's upload reads the file when it starts (in the background, after this pass maybe). */
function uploadSource(env: Env, path: VaultPath, maxBytes: number): UploadSource {
	const { ctx } = env;
	const diskPath = ctx.diskPathOf(path);
	let stat: VaultStat | null = null;
	return {
		read: async () => {
			const r = await ctx.read(diskPath, maxBytes);
			if (r.ok) {
				stat = r.stat;
				return r.bytes;
			}
			if (r.reason === "too-large") ctx.notice("warn", "blob-too-large", `attachment too large to sync: ${path}`, `big:${path}`);
			env.scan.markDirty(diskPath, r.reason === "missing" ? null : r.stat);
			return null;
		},
		changed: () => env.scan.markDirty(diskPath, stat),
	};
}
