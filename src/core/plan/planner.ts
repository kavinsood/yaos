/**
 * The planner (DESIGN §f.2). Pure: same input, same Plan, independent of Map
 * insertion order (everything is iterated in sorted order).
 *
 * `PlannerInput` (frozen) lacks a few facts the table needs. They come from an
 * optional `PlannerContext` with safe defaults, so `plan(input)` satisfies the
 * frozen `PlanFn` signature and the engine can pass the extra facts through
 * `planWith(input, ctx)`:
 *   - nsReady: ns caught up once this session and not halted (§f.2 gates, §c.10)
 *   - divergence: V3 mismatch (§b.5) for the ns-divergence brake
 *   - brakeWindow: destructive ops executed in the rolling 10-minute window
 *   - tzOffsetMinutes: local time for conflict names (core may not read Date)
 *   - remoteTextHash: streams.textHash of caught-up md/canvas docs
 *   - bodyAppliedSeq: streams.appliedSeq (nsDelete.baseBodySeq)
 *   - restoreDuty: docs whose restore condition + own duty hold (§c.7)
 *
 * Decisions (also in docs/client-remake/wp-b-notes.md):
 *   - createSize is not in RemoteEntry: "createSize = 0" is tested as
 *     createHash === hash of empty content (identical for all three kinds).
 *   - md/canvas adoption and convergence always go through reconcileContent
 *     (the job's `identical` path stores the base text); only blobs adopt by
 *     syncedPut. A syncedPut cannot store a base, and a base-less synced md
 *     record would turn the next edit into a no-base conflict.
 *   - Synced-record updates after content ops are written by the content job
 *     itself (bookkeeping runs last and would clobber it); syncedPut is only
 *     emitted when no content op runs for the doc.
 *   - nsDelete is bundled with syncedDrop: if the delete folds as stale (E6) the
 *     doc re-materializes as "live, absent, absent" instead of being deleted again.
 *   - An inferred/observed local rename emits nsRename + a syncedPut of the new
 *     path, so the next pass (overlay R at the new path) is consistent.
 *   - An observed rename wins even when a new file already re-occupies the
 *     source path (§f.6 asks "missing" only of hash inference): the doc moves,
 *     and the file at the old path is planned as new once S has left it. Until
 *     ns is ready (no inference) that file is not merged into the doc.
 *   - Remote-move target already on disk (crash between rename and synced
 *     update): adopt the path, no disk op.
 *   - Folder-casing-only remote moves (same pathKey, same leaf) are tolerated:
 *     synced takes R.path, the disk is left alone.
 *   - A missing synced file is only judged "not renamed" (edit-beats-delete
 *     diskMaterialize, or nsDelete) once inference can run: listing complete,
 *     every fresh local file hashed, ns ready. Likewise "pruned" (no remote entry) needs ns ready.
 *   - Blob materialization uses diskMaterialize (as in E4); fetchBlob is the
 *     overwrite of an existing file.
 *   - conflict-flood counts certain conflict copies: blob keep-both and no-base
 *     md/canvas reconciles whose remote hash is known and differs. 3-way merges
 *     are not counted (they are usually clean).
 *   - Identical-loser collapse nsDeletes are not counted as destructive.
 */

import type {
	ContentHash, DiskFingerprint, DocId, DocKind, LocalEntry, PathKey, PathKeyFn, Plan, PlanFn, PlannerInput, PlannerOp, RemoteEntry, Seq,
	SyncedEntry, VaultPath, BodyVersion,
} from "../types";
import { sha256Hex } from "../hash/sha256";
import { applyBrake, brakeKey, EMPTY_WINDOW, isShrinkingOverwrite, type BrakeWindow, type DestructiveKind, type PlanUnit } from "./brake";
import { conflictName } from "./conflictName";
import { orderOps } from "./order";
import { isValidVaultPath, leafOf, standInPathKey } from "./pathRules";
import { inferRenames, type InferredRename } from "./renames";

/** Logical hash of empty content: markdown "" , empty canvas bytes and an empty blob all hash the empty byte string. */
export const EMPTY_CONTENT_HASH = sha256Hex(new Uint8Array(0)) as ContentHash;

export interface PlannerContext {
	readonly pathKey: PathKeyFn;
	readonly nsReady: boolean;
	readonly divergence: boolean;
	readonly brakeWindow: BrakeWindow;
	readonly tzOffsetMinutes: number;
	readonly remoteTextHash: ReadonlyMap<DocId, ContentHash>;
	readonly bodyAppliedSeq: ReadonlyMap<DocId, Seq>;
	readonly restoreDuty: ReadonlySet<DocId>;
	/** Paths with a path-keyed base carried over an epoch migration (§c.12). */
	readonly pathBaseKeys: ReadonlySet<PathKey>;
}

export const DEFAULT_PLANNER_CONTEXT: PlannerContext = {
	pathKey: standInPathKey,
	nsReady: true,
	divergence: false,
	brakeWindow: EMPTY_WINDOW,
	tzOffsetMinutes: 0,
	remoteTextHash: new Map(),
	bodyAppliedSeq: new Map(),
	restoreDuty: new Set(),
	pathBaseKeys: new Set(),
};

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function versionEq(a: BodyVersion, b: BodyVersion | null): boolean {
	return b !== null && a.remoteSeq === b.remoteSeq && a.localOrder === b.localOrder;
}

type ContentKind = "markdown" | "canvas";

/**
 * §c.13 merged rebind of a markdown/canvas doc. The loser's held body frames
 * were dropped, so the winner never saw the loser's edits after its create: its
 * sync point is the winner's create, not the loser's last merge. Keeping the
 * loser's base would read those edits as already synced and the winner's text
 * as their deletion. The base survives only when it is the create text; with no
 * base the next merge keeps the disk side as a conflict copy.
 */
export function restartAtCreate(s: SyncedEntry, createHash: ContentHash): SyncedEntry {
	if (s.kind === "blob") return s;
	return { ...s, contentHash: createHash, bodyVersion: null, hasBase: s.hasBase && s.contentHash === createHash };
}

export const plan: PlanFn = (input) => planWith(input);

export function planWith(input: PlannerInput, options: Partial<PlannerContext> = {}): Plan {
	const ctx: PlannerContext = { ...DEFAULT_PLANNER_CONTEXT, ...options };
	const pk = ctx.pathKey;
	const units: PlanUnit[] = [];
	const handled = new Set<DocId>();
	const claimed = new Set<PathKey>();
	const reserved = new Set<PathKey>();
	let consumed = 0;

	// ---- indexes -----------------------------------------------------------
	const syncedIds = [...input.synced.keys()].sort(cmp);
	const syncedByKey = new Map<PathKey, DocId>();
	for (const id of syncedIds) {
		const s = input.synced.get(id)!;
		if (!syncedByKey.has(s.pathKey)) syncedByKey.set(s.pathKey, id);
	}

	// ---- scope ---------------------------------------------------------------
	let docIds: DocId[];
	let localKeys: Set<PathKey> | null;
	if (input.scope.t === "full") {
		const all = new Set<DocId>(syncedIds);
		for (const id of input.remote.keys()) all.add(id);
		docIds = [...all].sort(cmp);
		localKeys = null;
	} else {
		const ids = new Set<DocId>(input.scope.docIds);
		const keys = new Set<PathKey>(input.scope.pathKeys);
		for (const r of input.renames) {
			keys.add(pk(r.from));
			keys.add(pk(r.to));
		}
		for (const k of keys) {
			const a = input.remoteByPathKey.get(k);
			if (a !== undefined) ids.add(a);
			const b = syncedByKey.get(k);
			if (b !== undefined) ids.add(b);
		}
		const work = [...ids];
		while (work.length > 0) {
			const id = work.pop()!;
			const s = input.synced.get(id);
			if (s) keys.add(s.pathKey);
			const r = input.remote.get(id);
			if (r) {
				keys.add(r.pathKey);
				if (r.aliasOf !== null && !ids.has(r.aliasOf)) {
					ids.add(r.aliasOf);
					work.push(r.aliasOf);
				}
			}
		}
		docIds = [...ids].sort(cmp);
		localKeys = keys;
	}
	const inScopeLocal: LocalEntry[] = [];
	if (localKeys === null) {
		for (const l of input.local.values()) inScopeLocal.push(l);
	} else {
		for (const k of localKeys) {
			const l = input.local.get(k);
			if (l) inScopeLocal.push(l);
		}
	}
	inScopeLocal.sort((a, b) => cmp(a.pathKey, b.pathKey));

	// ---- helpers -------------------------------------------------------------
	const push = (ops: PlannerOp[], destructive: DestructiveKind | null = null, key = "", path: VaultPath = ""): void => {
		if (ops.length > 0) units.push({ ops, destructive, brakeKey: key, path });
	};
	const takeFresh = (): DocId | null => {
		const id = input.freshDocIds[consumed];
		if (id === undefined) return null;
		consumed++;
		return id;
	};
	const resolve = (id: DocId): RemoteEntry | undefined => {
		const r = input.remote.get(id);
		if (r && r.state === "merged" && r.aliasOf !== null) return input.remote.get(r.aliasOf);
		return r;
	};
	const remoteHash = (r: RemoteEntry): ContentHash | null => {
		if (r.kind === "blob") return r.blob?.hash ?? null;
		if (!r.body || !r.body.caughtUp) return null;
		const known = ctx.remoteTextHash.get(r.docId);
		if (known !== undefined) return known;
		return r.body.hasContent ? null : r.createHash;
	};
	const baseBodySeq = (r: RemoteEntry): Seq => (r.kind === "blob" ? 0 : ctx.bodyAppliedSeq.get(r.docId) ?? r.body?.version.remoteSeq ?? 0);
	const hasRestoreDuty = (id: DocId): boolean => ctx.restoreDuty.has(id) || input.docsWithPendingBody.has(id);
	const waitOp = (docId: DocId, reason: Extract<PlannerOp, { op: "wait" }>["reason"]): PlannerOp => ({ op: "wait", docId, reason });
	const drop = (docId: DocId): PlannerOp => ({ op: "syncedDrop", docId });
	const isTaken = (key: PathKey): boolean => input.local.has(key) || input.remoteByPathKey.has(key) || reserved.has(key);
	const copyNameFor = (path: VaultPath, docId: DocId): VaultPath => {
		const name = conflictName({ path, docId, deviceLabel: input.deviceLabel, nowMs: input.nowMs, tzOffsetMinutes: ctx.tzOffsetMinutes, pathKey: pk, isTaken });
		reserved.add(pk(name));
		return name;
	};
	const initialContent = (docId: DocId, l: LocalEntry): PlannerOp[] =>
		l.kind === "blob"
			? [{ op: "pushBlob", docId, path: l.path, hash: l.hash!, size: l.size }]
			: [{ op: "reconcileContent", docId, path: l.path, kind: l.kind, hasBase: false }];
	const localFor = (s: SyncedEntry, r: RemoteEntry | undefined): { l: LocalEntry | undefined; atRemote: boolean } => {
		const l = input.local.get(s.pathKey);
		if (l) return { l, atRemote: false };
		if (r && r.state === "live" && r.pathKey !== s.pathKey && !syncedByKey.has(r.pathKey)) {
			const atR = input.local.get(r.pathKey);
			if (atR) return { l: atR, atRemote: true };
		}
		return { l: undefined, atRemote: false };
	};

	// ---- remote moves into occupied paths ---------------------------------------
	// A file at a live remote entry's path is that doc's, unless the doc is synced at another path and its file is
	// still there: then the remote moved it onto a file this device has that the mover never saw (a local create or
	// rename). That file is new here. It is created like any other (the fold suffixes it, its loser rename frees the
	// path); the remote move waits for the path (`moveBlocked`).
	const remoteOwns = (key: PathKey): boolean => {
		const id = input.remoteByPathKey.get(key);
		if (id === undefined) return false;
		const s = input.synced.get(id);
		return !(s && s.pathKey !== key && input.local.has(s.pathKey));
	};
	// Keys this plan moves a synced file away from (remote moved it, not pinned by an own pending op).
	const vacating = new Set<PathKey>();
	for (const id of syncedIds) {
		const s = input.synced.get(id)!;
		const r = resolve(id);
		if (r && r.state === "live" && !r.pendingLocal && r.pathKey !== s.pathKey && input.local.has(s.pathKey)) vacating.add(s.pathKey);
	}
	const moveBlocked = (r: RemoteEntry, l: LocalEntry): boolean => r.pathKey !== l.pathKey && input.local.has(r.pathKey) && !vacating.has(r.pathKey);
	/** An own create of `l` would fold as an identical duplicate of the doc moving onto its path (merged, then dropped: a loop). */
	const mergesIntoOwner = (l: LocalEntry): boolean => {
		const id = input.remoteByPathKey.get(l.pathKey);
		const w = id === undefined ? undefined : input.remote.get(id);
		return w !== undefined && w.kind === l.kind && (l.hash === w.createHash || l.hash === (w.blob?.hash ?? null));
	};

	// ---- rename inference ------------------------------------------------------
	const freshLocal = inScopeLocal.filter((l) => !l.excluded && !syncedByKey.has(l.pathKey) && !remoteOwns(l.pathKey));
	const unhashedFresh = freshLocal.some((l) => l.hash === null);
	const missing: SyncedEntry[] = [];
	for (const id of docIds) {
		const s = input.synced.get(id);
		if (!s) continue;
		const r = resolve(id);
		if (!r || r.state !== "live") continue;
		if (localFor(s, r).l === undefined) missing.push(s);
	}
	const inferred = new Map<DocId, InferredRename>();
	if (ctx.nsReady) for (const rn of inferRenames(missing, freshLocal, input.renames, input.localComplete, pk)) inferred.set(rn.docId, rn);
	// Observed renames off a re-occupied source path (header): observed-only inference over the rest.
	const renamedFrom = new Set(input.renames.map((e) => pk(e.from)));
	const movedAway = new Set<DocId>();
	if (ctx.nsReady && renamedFrom.size > 0) {
		const reoccupied: SyncedEntry[] = [];
		for (const id of docIds) {
			const s = input.synced.get(id);
			const r = input.remote.get(id);
			if (s && r && r.state === "live" && r.pathKey === s.pathKey && renamedFrom.has(s.pathKey) && input.local.has(s.pathKey)) reoccupied.push(s);
		}
		const used = new Set([...inferred.values()].map((rn) => rn.to.pathKey));
		for (const rn of inferRenames(reoccupied, freshLocal.filter((l) => !used.has(l.pathKey)), input.renames, false, pk)) {
			inferred.set(rn.docId, rn);
			movedAway.add(rn.docId);
		}
	}

	// ---- content step for a synced live doc with a local file ------------------
	interface Step { ops: PlannerOp[]; destructive: DestructiveKind | null; key: string }
	const contentStep = (s: SyncedEntry, r: RemoteEntry, l: LocalEntry, diskPath: VaultPath, syncedPath: VaultPath, pathChanged: boolean): Step => {
		const docId = s.docId;
		const lHash = l.hash!;
		const Lc = lHash !== s.contentHash;
		const pathFields = pathChanged ? { path: syncedPath, pathKey: pk(syncedPath), nsTouchSeq: r.lastTouchSeq } : {};
		const statMoved = l.size !== s.size || l.mtimeMs !== s.mtimeMs || (l.fingerprint !== null && l.fingerprint !== s.fingerprint);
		const stat = { size: l.size, mtimeMs: l.mtimeMs, fingerprint: l.fingerprint ?? s.fingerprint };
		const putFull = (extra: Partial<SyncedEntry> = {}): PlannerOp => ({ op: "syncedPut", entry: { ...s, ...stat, ...pathFields, ...extra } });
		const putPath = (): PlannerOp[] => (pathChanged ? [{ op: "syncedPut", entry: { ...s, ...pathFields } }] : []);
		const none: Step = { ops: [], destructive: null, key: "" };

		if (s.kind !== "blob") {
			const body = r.body;
			const Rc = body === null || !versionEq(body.version, s.bodyVersion);
			if (!Lc && !Rc) return { ...none, ops: statMoved || pathChanged ? [putFull()] : [] };
			if (body === null || !body.caughtUp) return { ...none, ops: [waitOp(docId, "body-not-caught-up"), ...putPath()] };
			// The create's initial frames are still in flight: merging against the empty text would read it as a
			// deletion. A born-empty S (own create, frames maybe never written) merges, so the runner can re-push.
			if (!body.hasContent && r.createHash !== EMPTY_CONTENT_HASH && s.contentHash !== EMPTY_CONTENT_HASH) {
				return { ...none, ops: [waitOp(docId, "body-empty"), ...putPath()] };
			}
			return { ...none, ops: [{ op: "reconcileContent", docId, path: diskPath, kind: s.kind as ContentKind, hasBase: s.hasBase }] };
		}

		const rb = r.blob;
		if (rb === null) return { ...none, ops: statMoved || pathChanged ? [putFull()] : [] };
		const Rc = rb.rev !== s.blobRev;
		if (!Lc && !Rc) return { ...none, ops: statMoved || pathChanged ? [putFull()] : [] };
		if (lHash === rb.hash) {
			// Converged. While our own setBlob is pending the rev is a pseudo-seq: S1 updates synced on fold.
			if (r.pendingLocal) return { ...none, ops: putPath() };
			return { ...none, ops: [putFull({ contentHash: lHash, blobRev: rb.rev })] };
		}
		if (Rc && !Lc) {
			const shrinking = isShrinkingOverwrite(input.brake, l.size, rb.size);
			return {
				ops: [{ op: "fetchBlob", docId, path: diskPath, hash: rb.hash, size: rb.size }],
				destructive: shrinking ? "overwrite" : null,
				key: shrinking ? brakeKey("overwrite", docId, diskPath, `${lHash}>${rb.hash}`) : "",
			};
		}
		if (r.pendingLocal) return { ...none, ops: [waitOp(docId, "pending-ns"), ...putPath()] };
		if (!Rc) {
			// Lc only. The pushBlob job leaves synced at the base; S1 moves it when setBlob folds.
			return { ...none, ops: [{ op: "nsSetBlob", docId, hash: lHash, size: l.size, baseRev: rb.rev }, { op: "pushBlob", docId, path: diskPath, hash: lHash, size: l.size }, ...putPath()] };
		}
		// Both changed: keep both (§c.8, E8).
		if (!ctx.nsReady) return none;
		const id = takeFresh();
		if (id === null) return none;
		const copy = copyNameFor(diskPath, docId);
		return {
			ops: [
				{ op: "conflictCopy", docId, from: diskPath, to: copy, reason: "blob-concurrent", expect: { t: "hash", hash: lHash } },
				{ op: "fetchBlob", docId, path: diskPath, hash: rb.hash, size: rb.size },
				{ op: "nsCreate", docId: id, kind: "blob", path: copy, contentHash: lHash, size: l.size },
				{ op: "pushBlob", docId: id, path: copy, hash: lHash, size: l.size },
			],
			destructive: "conflict",
			key: brakeKey("conflict", docId, diskPath, `${lHash}|${rb.hash}`),
		};
	};

	// ---- rows --------------------------------------------------------------------
	const pruned = (s: SyncedEntry, l: LocalEntry | undefined, prefix: PlannerOp[]): void => {
		// Before ns is ready a missing entry may just not be read yet (fresh DB after a wipe): keep S, it carries
		// the doc identity an observed rename of this file still needs.
		if (!ctx.nsReady) return push(prefix);
		if (!l) return push([...prefix, drop(s.docId)]);
		if (l.hash === s.contentHash) {
			return push([...prefix, { op: "diskTrash", docId: s.docId, path: l.path, expect: { t: "hash", hash: s.contentHash } }, drop(s.docId)],
				"diskTrash", brakeKey("diskTrash", s.docId, l.path, s.contentHash), l.path);
		}
		const id = takeFresh();
		if (id === null) return push(prefix);
		push([...prefix, { op: "nsCreate", docId: id, kind: l.kind, path: l.path, contentHash: l.hash!, size: l.size }, ...initialContent(id, l), drop(s.docId)]);
	};

	const deleted = (s: SyncedEntry, r: RemoteEntry, l: LocalEntry | undefined, prefix: PlannerOp[]): void => {
		if (!l) return push([...prefix, drop(s.docId)]);
		if (!ctx.nsReady) return push(prefix);
		const Lc = l.hash !== s.contentHash;
		if (!Lc && !hasRestoreDuty(s.docId)) {
			return push([...prefix, { op: "diskTrash", docId: s.docId, path: l.path, expect: { t: "hash", hash: s.contentHash } }, drop(s.docId)],
				"diskTrash", brakeKey("diskTrash", s.docId, l.path, s.contentHash), l.path);
		}
		if (r.pendingLocal) return push([...prefix, waitOp(s.docId, "pending-ns")]);
		const ops: PlannerOp[] = [...prefix, { op: "nsRestore", docId: s.docId, path: l.path, againstDeleteSeq: r.deletedSeq }];
		if (Lc) {
			if (s.kind === "blob") {
				ops.push({ op: "nsSetBlob", docId: s.docId, hash: l.hash!, size: l.size, baseRev: r.blob?.rev ?? 0 });
				ops.push({ op: "pushBlob", docId: s.docId, path: l.path, hash: l.hash!, size: l.size });
			} else if (r.body && r.body.caughtUp) {
				ops.push({ op: "reconcileContent", docId: s.docId, path: l.path, kind: s.kind as ContentKind, hasBase: s.hasBase });
			} else {
				ops.push(waitOp(s.docId, "body-not-caught-up"));
			}
		}
		push(ops);
	};

	const liveMissing = (s: SyncedEntry, origId: DocId, r: RemoteEntry, prefix: PlannerOp[]): void => {
		const docId = s.docId;
		const inf = inferred.get(origId);
		if (inf && !claimed.has(inf.to.pathKey)) {
			const l2 = inf.to;
			claimed.add(l2.pathKey);
			if (l2.hash === null) return push([...prefix, { op: "needHash", path: l2.path }]);
			const step = contentStep(s, r, l2, l2.path, l2.path, true);
			const hasContentOp = step.ops.some((o) => o.op !== "syncedPut" && o.op !== "wait");
			const renameOps: PlannerOp[] = [{ op: "nsRename", docId, path: l2.path }];
			// The content job writes the synced path itself; otherwise record the move now.
			if (hasContentOp) return push([...prefix, ...renameOps, ...step.ops], step.destructive, step.key, l2.path);
			const put: PlannerOp = { op: "syncedPut", entry: { ...s, path: l2.path, pathKey: l2.pathKey } };
			return push([...prefix, ...renameOps, ...step.ops.filter((o) => o.op !== "syncedPut"), put], step.destructive, step.key, l2.path);
		}
		if (s.kind !== "blob" && (!r.body || !r.body.caughtUp)) return push([...prefix, waitOp(docId, "body-not-caught-up")]);
		// "Not a rename" needs the inference inputs, for edit-beats-delete as for nsDelete: while ns
		// is not ready inference is off, and re-materializing would undo the user's rename into a copy.
		if (!input.localComplete || unhashedFresh || !ctx.nsReady) return push(prefix);
		const Rc = s.kind === "blob" ? (r.blob?.rev ?? 0) !== s.blobRev : !versionEq(r.body!.version, s.bodyVersion);
		if (Rc) return push([...prefix, { op: "diskMaterialize", docId, path: r.path, expect: { t: "absent" } }]); // edit beats delete
		if (r.pendingLocal) return push([...prefix, waitOp(docId, "pending-ns")]);
		// Own body frames still unsequenced: a delete now would carry a base below them and hand
		// this device a restore duty for its own edits (§c.7). Delete once they are acked.
		if (input.docsWithPendingBody.has(docId)) return push([...prefix, waitOp(docId, "pending-body")]);
		push([...prefix, { op: "nsDelete", docId, baseBodySeq: baseBodySeq(r) }, drop(docId)], "nsDelete", brakeKey("nsDelete", docId, s.path, s.contentHash), s.path);
	};

	const collapse = (s: SyncedEntry, r: RemoteEntry, l: LocalEntry, prefix: PlannerOp[]): boolean => {
		const winner = input.remoteByPathKey.get(s.pathKey);
		if (winner === undefined || winner === s.docId || input.synced.has(winner) || handled.has(winner)) return false;
		const w = input.remote.get(winner);
		if (!w || w.state !== "live" || w.kind !== s.kind) return false;
		const wh = remoteHash(w);
		const identical = wh !== null && wh === l.hash;
		// §c.12: devices re-creating the vault after an epoch reset race on every path. A differing loser at a
		// path with an old-epoch base merges into the winner (3-way against that base) instead of a loser rename.
		const migrated = !identical && s.kind === "markdown" && ctx.pathBaseKeys.has(s.pathKey);
		if (!identical && !migrated) return false;
		handled.add(winner);
		if (migrated && (!w.body?.caughtUp || (!w.body.hasContent && w.createHash !== EMPTY_CONTENT_HASH))) {
			push([...prefix, waitOp(s.docId, w.body?.caughtUp ? "body-empty" : "body-not-caught-up")]);
			return true;
		}
		const ops: PlannerOp[] = [...prefix, { op: "rebind", fromDocId: s.docId, toDocId: winner, path: w.path }, { op: "nsDelete", docId: s.docId, baseBodySeq: baseBodySeq(r) }];
		if (migrated) ops.push({ op: "reconcileContent", docId: winner, path: l.path, kind: "markdown", hasBase: false, pathBase: true });
		push(ops);
		return true;
	};

	const livePresent = (s: SyncedEntry, r: RemoteEntry, l: LocalEntry, atRemote: boolean, prefix: PlannerOp[]): void => {
		const docId = s.docId;
		const ops: PlannerOp[] = [...prefix];
		let diskPath = l.path;
		let syncedPath = s.path;
		let pathChanged = false;
		const Rm = r.path !== s.path;
		if (atRemote) {
			syncedPath = r.path;
			pathChanged = true;
		} else if (Rm && !r.pendingLocal) {
			if (!ctx.nsReady) return push(prefix);
			if (r.pathKey === l.pathKey && leafOf(r.path) === leafOf(l.path)) {
				syncedPath = r.path; // folder-casing-only difference: tolerated
				pathChanged = true;
			} else if (s.nsTouchSeq === 0 && collapse(s, r, l, prefix)) {
				return;
			} else if (moveBlocked(r, l)) {
				// The target holds a new local file (see remoteOwns): keep the doc at its path until that file moves.
			} else {
				ops.push({ op: "diskRename", docId, from: l.path, to: r.path, expect: { t: "hash", hash: l.hash! } });
				diskPath = r.path;
				syncedPath = r.path;
				pathChanged = true;
			}
		} else if (!Rm && l.path !== s.path && leafOf(l.path) !== leafOf(s.path) && ctx.nsReady) {
			// Local case-only leaf rename (same pathKey): publish it.
			ops.push({ op: "nsRename", docId, path: l.path });
			syncedPath = l.path;
			pathChanged = true;
		}
		const step = contentStep(s, r, l, diskPath, syncedPath, pathChanged);
		push([...ops, ...step.ops], step.destructive, step.key, diskPath);
	};

	const planSynced = (s0: SyncedEntry): void => {
		const r0 = input.remote.get(s0.docId);
		let s = s0;
		let r = r0;
		const prefix: PlannerOp[] = [];
		if (r0 && r0.state === "merged" && r0.aliasOf !== null) {
			if (input.synced.has(r0.aliasOf)) return push([drop(s0.docId)]);
			prefix.push({ op: "rebind", fromDocId: s0.docId, toDocId: r0.aliasOf, path: s0.path });
			r = input.remote.get(r0.aliasOf);
			s = { ...(r ? restartAtCreate(s0, r.createHash) : s0), docId: r0.aliasOf };
			handled.add(r0.aliasOf);
		}
		const found = movedAway.has(s.docId) ? { l: undefined, atRemote: false } : localFor(s, r);
		const l = found.l;
		if (l) claimed.add(l.pathKey);
		if (l?.excluded) return push(prefix);
		// The file at a path an observed rename left may be new: no merge into the doc before inference (ns ready).
		if (l && !found.atRemote && !ctx.nsReady && renamedFrom.has(s.pathKey)) return push(prefix);
		if (r?.body?.frozen) return push([...prefix, waitOp(s.docId, "frozen")]);
		if (l && l.hash === null) return push([...prefix, { op: "needHash", path: l.path }]);
		if (!r) return pruned(s, l, prefix);
		if (r.state === "deleted") return deleted(s, r, l, prefix);
		if (r.state !== "live") return push(prefix);
		if (!l) return liveMissing(s, s0.docId, r, prefix);
		livePresent(s, r, l, found.atRemote, prefix);
	};

	const planRemoteOnly = (r: RemoteEntry): void => {
		const docId = r.docId;
		const key = r.pathKey;
		const blocked = syncedByKey.has(key) || claimed.has(key);
		const l = blocked ? undefined : input.local.get(key);
		if (l?.excluded) return;
		if (r.body?.frozen) return push([waitOp(docId, "frozen")]);
		if (!l) {
			if (r.kind === "blob") return push([{ op: "diskMaterialize", docId, path: r.path, expect: { t: "absent" } }]);
			if (!r.body || !r.body.caughtUp) return push([waitOp(docId, "body-not-caught-up")]);
			if (r.body.hasContent || r.createHash === EMPTY_CONTENT_HASH) return push([{ op: "diskMaterialize", docId, path: r.path, expect: { t: "absent" } }]);
			return push([waitOp(docId, "body-empty")]);
		}
		claimed.add(key);
		if (l.hash === null) return push([{ op: "needHash", path: l.path }]);
		if (r.kind === "blob") {
			const rb = r.blob;
			if (rb === null) return;
			if (l.hash === rb.hash) {
				return push([{ op: "syncedPut", entry: {
					docId, path: r.path, pathKey: r.pathKey, kind: "blob", contentHash: l.hash, fingerprint: l.fingerprint ?? (l.hash as string as DiskFingerprint),
					size: l.size, mtimeMs: l.mtimeMs, bodyVersion: null, blobRev: rb.rev, nsTouchSeq: r.lastTouchSeq, hasBase: false,
				} }]);
			}
			if (!ctx.nsReady) return;
			const id = takeFresh();
			if (id === null) return;
			const copy = copyNameFor(l.path, docId);
			return push([
				{ op: "conflictCopy", docId, from: l.path, to: copy, reason: "no-base", expect: { t: "hash", hash: l.hash } },
				{ op: "fetchBlob", docId, path: l.path, hash: rb.hash, size: rb.size },
				{ op: "nsCreate", docId: id, kind: "blob", path: copy, contentHash: l.hash, size: l.size },
				{ op: "pushBlob", docId: id, path: copy, hash: l.hash, size: l.size },
			], "conflict", brakeKey("conflict", docId, l.path, `${l.hash}|${rb.hash}`), l.path);
		}
		if (!r.body || !r.body.caughtUp) return push([waitOp(docId, "body-not-caught-up")]);
		if (!r.body.hasContent && r.createHash !== EMPTY_CONTENT_HASH) return push([waitOp(docId, "body-empty")]);
		const rh = remoteHash(r);
		const certainConflict = rh !== null && rh !== l.hash && rh !== EMPTY_CONTENT_HASH;
		push([{ op: "reconcileContent", docId, path: l.path, kind: r.kind as ContentKind, hasBase: false }],
			certainConflict ? "conflict" : null, certainConflict ? brakeKey("conflict", docId, l.path, `${l.hash}|${rh}`) : "", l.path);
	};

	const planNewLocal = (l: LocalEntry): void => {
		if (l.excluded || claimed.has(l.pathKey)) return;
		if (l.hash === null) return push([{ op: "needHash", path: l.path }]);
		if (!isValidVaultPath(l.path) || !ctx.nsReady) return;
		if (mergesIntoOwner(l)) return;
		const id = takeFresh();
		if (id === null) return;
		push([{ op: "nsCreate", docId: id, kind: l.kind as DocKind, path: l.path, contentHash: l.hash, size: l.size }, ...initialContent(id, l)]);
	};

	// ---- run ---------------------------------------------------------------------
	for (const id of docIds) {
		const s = input.synced.get(id);
		if (s) planSynced(s);
	}
	for (const id of docIds) {
		if (input.synced.has(id) || handled.has(id)) continue;
		const r = input.remote.get(id);
		if (r && r.state === "live") planRemoteOnly(r);
		// Deleted with no synced record here (e.g. this device is the deleter, or its store was
		// rebuilt) but body rows the delete did not cover: restore (§c.7); the live entry then
		// materializes on the next pass.
		else if (r && r.state === "deleted" && ctx.nsReady && !r.pendingLocal && hasRestoreDuty(id)) {
			claimed.add(r.pathKey); // a local file there is this doc's: merge it after the restore, never nsCreate it
			push([{ op: "nsRestore", docId: id, path: r.path, againstDeleteSeq: r.deletedSeq }]);
		}
	}
	for (const l of freshLocal) planNewLocal(l);

	// ---- brake + order -------------------------------------------------------------
	let liveLocalCount: number | null = null;
	if (input.scope.t === "full" && input.localComplete) {
		liveLocalCount = 0;
		for (const l of input.local.values()) if (!l.excluded) liveLocalCount++;
	}
	const outcome = applyBrake(units, {
		config: input.brake,
		syncedCount: input.synced.size,
		liveLocalCount,
		divergence: ctx.divergence,
		window: ctx.brakeWindow,
		approval: input.brakeApproval,
	});
	return {
		ops: orderOps(outcome.released.flatMap((u) => u.ops), pk),
		held: orderOps(outcome.held.flatMap((u) => u.ops), pk),
		brake: outcome.report,
		consumedDocIds: consumed,
	};
}
