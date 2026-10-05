/**
 * STAND-IN engine disk side: scan reads, ingest, unbound projection, conflict
 * copies. Path-keyed, markdown only, no deletes/renames (recorded limitation).
 */

import { kindOfPath, type DiskFingerprint, type MergeFn } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import type { VaultStat } from "../../ports/vault";
import type { DiskOp, DiskOpResult, DiskReadResult, EngineToMain, MainResultValue } from "../../protocol/messages";
import { LANE } from "../../protocol/messages";
import { STANDIN_MERGE_LIMITS, applyTextDiff, engineConflictPath, type DocState } from "./docs";
import type { HubMemberHandle } from "./hub";

export const LOCAL_DISK = Symbol("standin-local-disk");
export const READ_BATCH = 32;
/** Retry delay after an I/O failure (read, projection, conflict copy). */
export const IO_RETRY_MS = 1_000;
const MAX_READ_BYTES = 8 * 1024 * 1024;

type HostRequest = Extract<EngineToMain, { rid: number }>;
export type HostRequestBody = HostRequest extends infer M ? (M extends { rid: number } ? Omit<M, "rid"> : never) : never;

export interface SyncCtx {
	readonly hash: HashPort;
	readonly merge: MergeFn;
	readonly deviceLabel: string;
	readonly member: HubMemberHandle | null;
	readonly waiting: Set<string>;
	keyOf(path: string): string;
	doc(key: string): DocState | undefined;
	/** Create + register a doc state (attaches update listeners). */
	addDoc(key: string, path: string): DocState;
	persist(st: DocState): void;
	post(message: EngineToMain): void;
	hostRequest(body: HostRequestBody): Promise<MainResultValue>;
	/** Run `fn` after `ms` unless the engine is disposed by then (I/O retry). */
	later(ms: number, fn: () => void): void;
	readonly stats: { reads: number; projections: number; conflictCopies: number; ingests: number };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function fingerprintOf(hash: HashPort, text: string): Promise<DiskFingerprint> {
	const d = await hash.sha256(encoder.encode(text));
	let out = "";
	for (let i = 0; i < d.length; i++) out += (d[i] as number).toString(16).padStart(2, "0");
	return out as DiskFingerprint;
}

export function isSyncedPath(path: string): boolean {
	return kindOfPath(path) === "markdown" && !path.split("/").some((s) => s.startsWith("."));
}

function enqueue(st: DocState, job: () => Promise<void>): Promise<void> {
	const next = st.chain.then(job, job).catch(() => undefined);
	st.chain = next;
	return next;
}

/** Read paths (batched) and ingest each. */
export async function readPaths(ctx: SyncCtx, paths: readonly string[]): Promise<void> {
	for (let i = 0; i < paths.length; i += READ_BATCH) {
		const slice = paths.slice(i, i + READ_BATCH);
		let res: MainResultValue;
		try {
			res = await ctx.hostRequest({ t: "readRequest", reads: slice.map((path) => ({ area: "vault" as const, path, maxBytes: MAX_READ_BYTES })) });
		} catch {
			ctx.later(IO_RETRY_MS, () => void readPaths(ctx, slice));
			continue;
		}
		if (res.t !== "reads") continue;
		const retry: string[] = [];
		for (const r of res.results) {
			if (!r.ok && r.reason === "io") retry.push(r.path);
			else await ingestRead(ctx, r);
		}
		if (retry.length > 0) ctx.later(IO_RETRY_MS, () => void readPaths(ctx, retry));
	}
}

async function ingestRead(ctx: SyncCtx, r: DiskReadResult): Promise<void> {
	if (!r.ok) return;
	ctx.stats.reads++;
	await ingest(ctx, r.stat.path, decoder.decode(r.bytes), r.stat);
}

/** A file's current disk text: create, adopt, or merge into the doc. */
export async function ingest(ctx: SyncCtx, path: string, text: string, _stat: VaultStat | null): Promise<void> {
	if (!isSyncedPath(path)) return;
	ctx.stats.ingests++;
	const key = ctx.keyOf(path);
	let st = ctx.doc(key);
	if (!st) {
		st = ctx.addDoc(key, path);
		const fp = await fingerprintOf(ctx.hash, text);
		const created = ctx.member ? ctx.member.create(key, path) : true;
		if (created) {
			// Our file is the doc's genesis.
			st.base = text;
			st.diskText = text;
			st.diskFp = fp;
			applyTextDiff(st.ytext, text, LOCAL_DISK);
			ctx.persist(st);
		} else {
			// Someone else created this path first: adopt their doc, merge without a base.
			st.diskText = text;
			st.diskFp = fp;
			await mergeDisk(ctx, st, text);
		}
		if (ctx.waiting.delete(key)) ctx.post({ t: "bindable", path: st.path });
		return;
	}
	const target = st;
	await enqueue(target, async () => {
		if (target.bound.size > 0) return; // the editor owns it: boundSaved / interceptor
		if (text === target.diskText) {
			// Our own projection, or unchanged. The doc may still be ahead of the disk
			// (edited while bound, then the app died before the editor saved): project.
			if (target.ytext.toString() !== text) await projectLocked(ctx, target);
			return;
		}
		target.diskText = text;
		target.diskFp = await fingerprintOf(ctx.hash, text);
		await mergeDiskLocked(ctx, target, text);
	});
}

function mergeDisk(ctx: SyncCtx, st: DocState, disk: string): Promise<void> {
	return enqueue(st, () => mergeDiskLocked(ctx, st, disk));
}

async function mergeDiskLocked(ctx: SyncCtx, st: DocState, disk: string): Promise<void> {
	const crdt = st.ytext.toString();
	if (st.base === null && disk === "" && crdt !== "") {
		// An empty local file never conflicts: take the doc.
		await projectLocked(ctx, st);
		return;
	}
	const r = ctx.merge({ base: st.base, disk, crdt, limits: STANDIN_MERGE_LIMITS });
	switch (r.kind) {
		case "identical":
			st.base = disk;
			ctx.persist(st);
			return;
		case "disk-only":
			applyTextDiff(st.ytext, r.text, LOCAL_DISK);
			st.base = r.text;
			ctx.persist(st);
			return;
		case "crdt-only":
			await projectLocked(ctx, st);
			return;
		case "clean":
			applyTextDiff(st.ytext, r.text, LOCAL_DISK);
			await projectLocked(ctx, st);
			return;
		case "conflict":
			if (await writeConflictCopy(ctx, st.path, r.conflictCopy)) await projectLocked(ctx, st);
			else {
				// The disk text is not preserved anywhere yet: forget we saw it and re-read.
				st.diskText = null;
				ctx.later(IO_RETRY_MS, () => void readPaths(ctx, [st.path]));
			}
			return;
	}
}

/** Write the CRDT text over the disk (unbound docs), CAS on what we last saw. */
export function project(ctx: SyncCtx, st: DocState): void {
	if (st.projectQueued) return;
	st.projectQueued = true;
	void enqueue(st, async () => {
		st.projectQueued = false;
		await projectLocked(ctx, st);
	});
}

async function projectLocked(ctx: SyncCtx, st: DocState): Promise<void> {
	if (st.bound.size > 0) return;
	const text = st.ytext.toString();
	if (text === st.diskText) {
		if (st.base !== text) {
			st.base = text;
			ctx.persist(st);
		}
		return;
	}
	const op: DiskOp = {
		t: "write", opId: 1, area: "vault", path: st.path, data: { t: "text", text },
		precondition: st.diskFp ? { t: "fingerprint", fingerprint: st.diskFp } : { t: "absent" },
		docId: st.docId, purpose: "materialize",
	};
	const result = await runOps(ctx, [op]);
	const r = result[0];
	if (!r || r.t !== "write") {
		ctx.later(IO_RETRY_MS, () => project(ctx, st));
		return;
	}
	if (r.outcome.ok) {
		ctx.stats.projections++;
		st.diskText = text;
		st.diskFp = r.outcome.fingerprint;
		st.base = text;
		ctx.persist(st);
		return;
	}
	if (r.outcome.reason === "precondition" && r.outcome.message !== "bound") {
		// Disk changed under us: re-read and merge (after this job).
		void readPaths(ctx, [st.path]);
	} else if (r.outcome.reason === "io") {
		ctx.later(IO_RETRY_MS, () => project(ctx, st));
	}
}

async function runOps(ctx: SyncCtx, ops: readonly DiskOp[]): Promise<readonly DiskOpResult[]> {
	try {
		const res = await ctx.hostRequest({ t: "diskOps", lane: LANE.background, ops });
		return res.t === "diskOps" ? res.results : [];
	} catch {
		return [];
	}
}

/** Conflict copy next to `path` (precondition absent, n = 1..10). */
export async function writeConflictCopy(ctx: SyncCtx, path: string, text: string): Promise<boolean> {
	for (let n = 1; n <= 10; n++) {
		const copy = engineConflictPath(path, ctx.deviceLabel, n);
		const res = await runOps(ctx, [{ t: "write", opId: 1, area: "vault", path: copy, data: { t: "text", text }, precondition: { t: "absent" }, docId: null, purpose: "conflict-copy" }]);
		const r = res[0];
		if (r && r.t === "write" && r.outcome.ok) {
			ctx.stats.conflictCopies++;
			return true;
		}
		if (!r || r.t !== "write" || r.outcome.ok || r.outcome.reason !== "precondition") return false;
	}
	return false;
}
