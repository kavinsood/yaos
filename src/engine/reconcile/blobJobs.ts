/**
 * Blob plan ops (DESIGN §c.8, §j.1): conflictCopy (blob keep-both), fetchBlob
 * (overwrite an existing file with the remote blob), pushBlob (upload, then
 * submit the deferred nsCreate/nsSetBlob).
 *
 * keep-both (E8) runs under a `keep-both-blob` intent: conflictCopy begins it
 * before the copy is written, fetchBlob ends it in its T_synced. A crash in
 * between is resolved by intents.ts.
 */

import type { ContentHash, DocId, PlannerOp, VaultPath } from "../../core/types";
import { isShrinkingOverwrite } from "../../core/plan/brake";
import type { WritePrecondition } from "../../ports/vault";
import type { IntentRecord } from "../store/schema";
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
	const h = hashBytes("blob", r.bytes);
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
 * Download `hash` and write it over `path` (CAS on `precondition`), then
 * T_synced for the doc + end of any keep-both intent. Used by fetchBlob and by
 * intent resume. "fail" = unavailable now or the file changed; "held" = no blob store.
 */
export async function fetchAndWrite(env: Env, docId: DocId, path: VaultPath, hash: ContentHash, size: number, precondition: WritePrecondition): Promise<JobOutcome> {
	const { ctx } = env;
	const blobs = blobStore(env);
	if (!blobs) return "held";
	const bytes = await blobs.download({ hash, docId, path, size });
	if (!bytes) return "fail";
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
 * Upload the local file's bytes. Only after the store confirms are the
 * doc's deferred ns ops submitted, so no ns entry ever points at a blob that
 * readers cannot fetch. A brand-new doc gets a synced record (blobRev 0,
 * nsTouchSeq 0) unless the S1 fold already wrote one.
 */
export async function pushBlob(env: Env, op: Op<"pushBlob">): Promise<JobOutcome> {
	const { ctx } = env;
	const blobs = blobStore(env);
	if (!blobs) return "held";
	const path = ctx.diskPathOf(op.path);
	const r = await ctx.read(path, blobs.maxBlobBytes);
	if (!r.ok) {
		if (r.reason === "too-large") ctx.notice("warn", "blob-too-large", `attachment too large to sync: ${op.path}`, `big:${op.path}`);
		env.scan.markDirty(path, r.reason === "missing" ? null : r.stat);
		return "fail";
	}
	const h = hashBytes("blob", r.bytes);
	if (h.hash !== op.hash) {
		env.scan.markDirty(path, r.stat);
		return "fail";
	}
	if (!(await blobs.upload({ hash: h.hash, docId: op.docId, path: op.path, bytes: r.bytes }))) return "fail";
	const deferred = env.deferred.get(op.docId);
	if (deferred) {
		env.deferred.delete(op.docId);
		await ctx.log.submitNs([deferred]);
	}
	if (!ctx.synced(op.docId) && deferred?.t === "create") {
		const entry = ctx.record({
			docId: op.docId, path: op.path, pathKey: ctx.pk(op.path), kind: "blob", contentHash: h.hash, fingerprint: h.fingerprint, size: r.stat.size,
			mtimeMs: r.stat.mtimeMs, bodyVersion: null, blobRev: 0, nsTouchSeq: 0, hasBase: false,
		});
		await ctx.commit({ syncedPut: [entry] });
	}
	return "ok";
}
