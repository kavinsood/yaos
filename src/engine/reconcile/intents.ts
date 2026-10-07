/**
 * Intent resume (DESIGN §e.2 T_intent_*). An intent is begun before a
 * multi-step disk effect and ended in the T_synced that completes it. After a
 * crash every open intent is resolved here, before any plan runs for its doc,
 * so a resumed job never loses text and never writes a second copy.
 *
 * conflict-copy (md, subjectHash = hash of the disk text D that was copied):
 *   - copy absent                       -> drop (the next merge redoes it)
 *   - copy == D and path still == D     -> the copy is safe; finish step 5:
 *                                          write the current CRDT text over D
 *                                          (precondition hash D), T_synced, drop
 *   - otherwise (step 5 done / user edit) -> drop (the next merge converges)
 * conflict-copy of a canvas (subjectHash = logical canvas hash of D): same
 *   rules, step 5 writes the CRDT projection (canvasDoc.projectCanvasBytes).
 * keep-both-blob (subjectHash = local blob hash that was copied):
 *   - copy == subject and original == subject -> fetch + overwrite, T_synced, drop
 *     (download unavailable: keep the intent and retry next pass)
 *   - otherwise -> drop
 * Other kinds are not produced by the disk side: dropped.
 */

import type { ContentHash, DiskFingerprint, DocId, VaultPath } from "../../core/types";
import { kindOfPath } from "../../core/types";
import { canvasToMergeText } from "../../core/hash/canvasCanonical";
import { canonicalizeMarkdown, markdownContentHash } from "../../core/hash/markdownLf";
import { utf8Decode } from "../../core/hash/utf8";
import type { VaultStat } from "../../ports/vault";
import type { IntentRecord } from "../store/schema";
import { fetchAndWrite } from "./blobJobs";
import { projectCanvasBytes, projectionHash } from "./canvasDoc";
import { writeOk, type Env } from "./diskJobs";
import { hashBytes, MAX_TEXT_FILE_BYTES } from "./localState";
import { hashBase, makeBase } from "./store";

interface Seen { readonly hash: ContentHash; readonly fingerprint: DiskFingerprint; readonly bytes: Uint8Array; readonly stat: VaultStat }

async function hashAt(env: Env, path: VaultPath, kind: "markdown" | "canvas" | "blob"): Promise<Seen | null> {
	const max = kind === "blob" ? env.ctx.classifySettings.maxBlobBytes : MAX_TEXT_FILE_BYTES;
	const r = await env.ctx.read(env.ctx.diskPathOf(path), max);
	if (!r.ok) return null;
	const h = await hashBytes(env.ctx.deps.hash, kind, r.bytes);
	return { hash: h.hash, fingerprint: h.fingerprint, bytes: r.bytes, stat: r.stat };
}

async function drop(env: Env, i: IntentRecord): Promise<void> {
	await env.ctx.commit({ intentDrop: [i.id] });
}

async function resumeConflictCopy(env: Env, i: IntentRecord, docId: DocId, from: VaultPath, to: VaultPath, subject: ContentHash): Promise<boolean> {
	const { ctx } = env;
	const copy = await hashAt(env, to, "markdown");
	const orig = await hashAt(env, from, "markdown");
	if (!copy || copy.hash !== subject || !orig || orig.hash !== subject) {
		await drop(env, i);
		return true;
	}
	const h = await ctx.log.acquireBody(docId, "markdown");
	if (!h) {
		await drop(env, i);
		return true;
	}
	try {
		const port = ctx.deps.hash;
		const crdt = h.doc.getText("text").toString();
		const version = h.version();
		const crdtHash = await markdownContentHash(port, crdt);
		// Default: the disk keeps D (bound editor owns the file, or the CRDT already equals D).
		let diskText = canonicalizeMarkdown(utf8Decode(orig.bytes));
		let stat = orig.stat;
		let fingerprint = orig.fingerprint;
		let hash: ContentHash;
		if (!h.bound && crdtHash !== subject) {
			const path = ctx.diskPathOf(from);
			const res = await ctx.exec({ t: "write", area: "vault", path, data: { t: "text", text: crdt }, precondition: { t: "hash", hash: subject }, docId, purpose: "merge" });
			const out = writeOk(res);
			if (!out) {
				env.scan.markDirty(path, null);
				await drop(env, i);
				return true;
			}
			ctx.echo.expectWrite(ctx.pk(from), out.stat.size, out.stat.mtimeMs);
			diskText = crdt;
			stat = out.stat;
			fingerprint = out.fingerprint;
			hash = crdtHash;
		} else {
			hash = await markdownContentHash(port, diskText);
		}
		const base = makeBase(docId, diskText, hash);
		// Bound and the disk lacks the CRDT text: no sync point until the editor's save (mergeJob.ts header).
		const awaitingSave = h.bound && crdtHash !== hash;
		const s = ctx.record({
			docId, path: from, pathKey: ctx.pk(from), kind: "markdown", contentHash: hash, fingerprint, size: stat.size, mtimeMs: stat.mtimeMs,
			bodyVersion: awaitingSave ? null : version, blobRev: 0, nsTouchSeq: ctx.touchSeq(docId), hasBase: base !== null,
		});
		await ctx.commit(
			{ syncedPut: [s], basePut: base ? [base] : [], baseDrop: base ? [] : [docId], intentDrop: [i.id] },
			[ctx.localEntry(from, stat, "markdown", hash, fingerprint), ctx.localEntry(to, copy.stat, "markdown", copy.hash, copy.fingerprint)],
		);
		return true;
	} finally {
		h.release();
	}
}

async function resumeCanvasCopy(env: Env, i: IntentRecord, docId: DocId, from: VaultPath, to: VaultPath, subject: ContentHash): Promise<boolean> {
	const { ctx } = env;
	const copy = await hashAt(env, to, "canvas");
	const orig = await hashAt(env, from, "canvas");
	const h = copy?.hash === subject && orig?.hash === subject ? await ctx.log.acquireBody(docId, "canvas") : null;
	if (!h || !copy || !orig) {
		await drop(env, i);
		return true;
	}
	try {
		const p = projectCanvasBytes(h.doc);
		if (!p.ok) {
			await drop(env, i); // the next merge reports canvas-invalid
			return true;
		}
		const version = h.version();
		// Hashed before the write: nothing awaits between the write and the T_synced commit that records it.
		const pHash = await projectionHash(ctx.deps.hash, p);
		const base = await hashBase(ctx.deps.hash, docId, canvasToMergeText(p.ranked));
		let stat = orig.stat;
		let fingerprint = orig.fingerprint;
		let hash = orig.hash;
		if (pHash !== subject) {
			const path = ctx.diskPathOf(from);
			const res = await ctx.exec({ t: "write", area: "vault", path, data: { t: "text", text: p.text }, precondition: { t: "hash", hash: subject }, docId, purpose: "merge" });
			const out = writeOk(res);
			if (!out) {
				env.scan.markDirty(path, null);
				await drop(env, i);
				return true;
			}
			ctx.echo.expectWrite(ctx.pk(from), out.stat.size, out.stat.mtimeMs);
			stat = out.stat;
			fingerprint = out.fingerprint;
			hash = pHash;
		}
		const s = ctx.record({
			docId, path: from, pathKey: ctx.pk(from), kind: "canvas", contentHash: hash, fingerprint, size: stat.size, mtimeMs: stat.mtimeMs,
			bodyVersion: version, blobRev: 0, nsTouchSeq: ctx.touchSeq(docId), hasBase: base !== null,
		});
		await ctx.commit(
			{ syncedPut: [s], basePut: base ? [base] : [], baseDrop: base ? [] : [docId], intentDrop: [i.id] },
			[ctx.localEntry(from, stat, "canvas", hash, fingerprint), ctx.localEntry(to, copy.stat, "canvas", copy.hash, copy.fingerprint)],
		);
		return true;
	} finally {
		h.release();
	}
}

async function resumeKeepBoth(env: Env, i: IntentRecord, docId: DocId, from: VaultPath, to: VaultPath, subject: ContentHash): Promise<boolean> {
	const r = env.ctx.log.view().remote.get(docId);
	const copy = await hashAt(env, to, "blob");
	const orig = await hashAt(env, from, "blob");
	if (!r?.blob || r.state !== "live" || !copy || copy.hash !== subject || !orig || orig.hash !== subject) {
		await drop(env, i);
		return true;
	}
	if (r.blob.hash === subject) {
		await drop(env, i);
		return true;
	}
	const res = await fetchAndWrite(env, docId, from, r.blob.hash, r.blob.size, { t: "hash", hash: subject });
	return res === "ok";
}

/** Resolve every open intent. Returns the number still open (blob downloads pending). */
export async function resumeIntents(env: Env): Promise<number> {
	let open = 0;
	const intents = [...env.ctx.store.intents.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const i of intents) {
		const { docId, fromPath, toPath, subjectHash } = i;
		if (docId === null || fromPath === null || toPath === null || subjectHash === null) {
			await drop(env, i);
			continue;
		}
		let done = true;
		if (i.kind === "conflict-copy" && kindOfPath(fromPath) === "canvas") done = await resumeCanvasCopy(env, i, docId, fromPath, toPath, subjectHash);
		else if (i.kind === "conflict-copy") done = await resumeConflictCopy(env, i, docId, fromPath, toPath, subjectHash);
		else if (i.kind === "keep-both-blob") done = await resumeKeepBoth(env, i, docId, fromPath, toPath, subjectHash);
		else await drop(env, i);
		if (!done) open++;
	}
	return open;
}
