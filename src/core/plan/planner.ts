/**
 * The planner (DESIGN §f.2). Pure: same input, same Plan, independent of Map
 * insertion order (everything is iterated in sorted order).
 *
 * `PlannerInput` (frozen) lacks a few facts the table needs. They come from an
 * optional `PlannerContext` with safe defaults, so `plan(input)` satisfies the
 * frozen `PlanFn` signature and the engine can pass the extra facts through
 * `planWith(input, ctx)`:
 *   - nsReady: ns caught up once this session and not halted (§f.2 gates, §c.10)
 *   - brakeWindow: destructive ops executed in the rolling 10-minute window
 *   - tzOffsetMinutes: local time for conflict names (core may not read Date)
 *   - remoteTextHash: streams.textHash of caught-up md/canvas docs
 *   - bodyAppliedSeq: streams.appliedSeq (nsDelete.baseBodySeq)
 *   - restoreDuty: docs whose restore condition + own duty hold (§c.7), pruned docs with rows past the pruned
 *     delete's base included (§c.9 "Pruned docs")
 *   - lostCreateBody: live docs whose initial body never reached the relay and never will: created by
 *     this install's lineage and no longer pending here (store lost), or by a retired store (abandoned)
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
 *   - A lost create body (own create, no rows, nothing pending, e.g. the store was wiped with its
 *     mirrors; or a retired creator's: DESIGN §i.5 "Abandoned creates") is not waited on as
 *     "body-empty": its creator never supplies it. The empty doc is deleted (baseBodySeq 0). A file at
 *     the path is kept and claimed; once the delete folds it is a new local file, created as a new doc
 *     with its text (planNewLocal). Never a push into the empty doc: several devices may hold the file,
 *     and their pushes would each insert the text. Two holders' re-creates race as concurrent creates
 *     (identical texts merge, others take a suffix). With no file there the delete is braked like a
 *     local delete; with one it deletes nothing of the user's.
 */

import type {
	ContentHash, DiskFingerprint, DocId, LocalEntry, ObservedRename, PathKey, PathKeyFn, Plan, PlanFn, PlannerInput, PlannerOp, RemoteEntry, Seq,
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
	readonly brakeWindow: BrakeWindow;
	readonly tzOffsetMinutes: number;
	readonly remoteTextHash: ReadonlyMap<DocId, ContentHash>;
	readonly bodyAppliedSeq: ReadonlyMap<DocId, Seq>;
	readonly restoreDuty: ReadonlySet<DocId>;
	/** Replica body version of each pruned doc with a restore duty (§c.9 "Pruned docs"). */
	readonly prunedBody: ReadonlyMap<DocId, BodyVersion>;
	readonly lostCreateBody: ReadonlySet<DocId>;
	/** Paths with a path-keyed base carried over an epoch migration (§c.12). */
	readonly pathBaseKeys: ReadonlySet<PathKey>;
}

export const DEFAULT_PLANNER_CONTEXT: PlannerContext = {
	pathKey: standInPathKey,
	nsReady: true,
	brakeWindow: EMPTY_WINDOW,
	tzOffsetMinutes: 0,
	remoteTextHash: new Map(),
	bodyAppliedSeq: new Map(),
	restoreDuty: new Set(),
	prunedBody: new Map(),
	lostCreateBody: new Set(),
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
 * §c.13 merged rebind of a markdown/canvas doc. The loser's body frames were
 * dropped (held or unreceipted) or committed on the loser's stream, which
 * nobody materializes, so the winner never saw the loser's edits after its create: its
 * sync point is the winner's create, not the loser's last merge. Keeping the
 * loser's base would read those edits as already synced and the winner's text
 * as their deletion. The base survives only when it is the create text; with no
 * base the next merge keeps the disk side as a conflict copy.
 */
export function restartAtCreate(s: SyncedEntry, createHash: ContentHash): SyncedEntry {
	if (s.kind === "blob") return s;
	return { ...s, contentHash: createHash, bodyVersion: null, hasBase: s.hasBase && s.contentHash === createHash };
}

/**
 * A file at a synced record's path that no planner row takes a fresh docId for: the record's bytes, not a decided
 * delete (fileGone), and a doc either present in the tree or seen committed (nsTouchSeq > 0). Every row that takes
 * one runs on a file this is false for, or one with no record: the pruned row's re-create (absent, nsTouchSeq 0: an
 * own create the fold ignored, sim seed 222), the both-changed and no-base conflict copies, a new file (also one at a
 * fileGone path). The pruned row decides by it (absent: remotePresent false) and freshIdBudget counts by it, so the
 * planner and the reconciler's budget cannot drift.
 */
export function takesNoFreshId(s: Pick<SyncedEntry, "contentHash" | "nsTouchSeq" | "fileGone">, fileHash: ContentHash | null, remotePresent: boolean): boolean {
	return fileHash === s.contentHash && s.fileGone !== true && (s.nsTouchSeq > 0 || remotePresent);
}

/**
 * Upper bound of the fresh docIds a plan over these trees can consume (PlannerInput.freshDocIds): one per non-excluded
 * local file that not every synced record at its path covers (takesNoFreshId), a file with no record included. A
 * path holding several records (an ignored own create next to its folded twin) counts if any of them does not. A
 * merged doc counts as absent (its winner may be). Kept tight: every id is a random draw, and seeded runs replay them.
 */
export function freshIdBudget(
	synced: ReadonlyMap<DocId, SyncedEntry>, local: ReadonlyMap<PathKey, LocalEntry>, remote: ReadonlyMap<DocId, RemoteEntry>, restoring: (docId: DocId) => boolean = () => false,
): number {
	const covered = new Map<PathKey, boolean>();
	for (const s of synced.values()) {
		const l = local.get(s.pathKey);
		const r = remote.get(s.docId);
		// An absent doc with a restore duty (own body frames still to send, rows its pruned delete did not cover)
		// re-creates (the pruned row), as a changed file does.
		const ok = l !== undefined && takesNoFreshId(s, l.hash, r !== undefined && r.state !== "merged") && (r !== undefined || !restoring(s.docId));
		covered.set(s.pathKey, (covered.get(s.pathKey) ?? true) && ok);
	}
	let n = 0;
	for (const l of local.values()) if (!l.excluded && covered.get(l.pathKey) !== true) n++;
	return n;
}

export const plan: PlanFn = (input) => planWith(input);

/**
 * The observed renames, plus the one each fileGone record kept (`renamedTo`): observed before ns was ready, it is
 * gone from memory after an engine restart, and without it the file is lost track of (sim hot canvas seed 705).
 */
function withKeptRenames(input: PlannerInput, pk: PathKeyFn): PlannerInput {
	const kept: ObservedRename[] = [];
	for (const s of input.synced.values()) {
		if (!s.fileGone || !s.renamedTo) continue;
		const e = { from: s.path, to: s.renamedTo.to, atMs: s.renamedTo.atMs };
		if (!input.renames.some((x) => pk(x.from) === pk(e.from) && pk(x.to) === pk(e.to))) kept.push(e);
	}
	return kept.length === 0 ? input : { ...input, renames: [...input.renames, ...kept] };
}

/**
 * Where the file of synced record `s` is now: the end of the observed rename chain from its synced path (the
 * observed renames and the one the record kept), else its synced path, or null for a file gone with no rename.
 */
export function syncedFileKey(s: SyncedEntry, renames: readonly ObservedRename[], pk: PathKeyFn): PathKey | null {
	const all = s.renamedTo ? [...renames, { from: s.path, to: s.renamedTo.to, atMs: s.renamedTo.atMs }] : renames;
	const away = renamedAway(all, s.pathKey, pk);
	return away ? pk(away.to) : s.fileGone ? null : s.pathKey;
}

/** The observed rename events of the chain starting at `key`, in order. */
function renameChain(renames: readonly ObservedRename[], key: PathKey, pk: PathKeyFn): ObservedRename[] {
	let at = key;
	const out: ObservedRename[] = [];
	for (const e of [...renames].sort((x, y) => x.atMs - y.atMs)) {
		if (pk(e.from) !== at) continue;
		at = pk(e.to);
		out.push(e);
	}
	return out;
}

/** The end of the observed rename chain starting at `key` (its last event), if any. */
export function renamedAway(renames: readonly ObservedRename[], key: PathKey, pk: PathKeyFn): { to: VaultPath; atMs: number } | null {
	let at = key;
	let last: ObservedRename | null = null;
	for (const e of [...renames].sort((x, y) => x.atMs - y.atMs)) {
		if (pk(e.from) !== at) continue;
		at = pk(e.to);
		last = e;
	}
	return last && at !== key ? { to: last.to, atMs: last.atMs } : null;
}

export function planWith(input0: PlannerInput, options: Partial<PlannerContext> = {}): Plan {
	const ctx: PlannerContext = { ...DEFAULT_PLANNER_CONTEXT, ...options };
	const pk = ctx.pathKey;
	const input = withKeptRenames(input0, pk);
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
	// Where each observed rename chain ended: target key -> the key the file started from.
	const arrivedFrom = new Map<PathKey, PathKey>();
	for (const e of [...input.renames].sort((x, y) => x.atMs - y.atMs)) {
		const from = pk(e.from);
		const origin = arrivedFrom.get(from) ?? from;
		arrivedFrom.delete(from);
		arrivedFrom.set(pk(e.to), origin);
	}
	/** The file at `key` was renamed there by the user from a path other than S's: another file, not S's doc's. */
	const arrivedElsewhere = (key: PathKey, s: SyncedEntry): boolean => {
		const o = arrivedFrom.get(key);
		return o !== undefined && o !== s.pathKey;
	};
	/** The user's rename of S's file (observed, or kept on S) took it somewhere other than `key`. */
	const renamedElsewhere = (s: SyncedEntry, key: PathKey): boolean => {
		const away = renamedAway(input.renames, s.pathKey, pk);
		return away !== null && pk(away.to) !== key;
	};
	const localFor = (s: SyncedEntry, r: RemoteEntry | undefined): { l: LocalEntry | undefined; atRemote: boolean } => {
		// A decided delete (fileGone) covers the file at S's path only. A file at the doc's remote path is its
		// own: the doc moved there (an own rename inference could not catch offline, sim heavy seed 22). Unless
		// the user renamed it there from elsewhere: then it is that file, and the doc's own file is wherever its
		// rename took it (sim DEV3 F seed 452: the doc's file renamed n6 -> r4 offline, another note n4 -> r2,
		// the doc moved to r2 by a peer; r2's note merged into the doc as a conflict and r4 became a duplicate).
		// Nor when the user's rename of S's file is known (observed, or kept on S as renamedTo): the file is where the
		// rename took it, and one at the remote path is another, a note created there (soak 1307815726 #30: offline,
		// C renamed the canvas away while a peer moved the doc to c0, then created a new c0; the new canvas was merged
		// into the doc over a peer's edits, and the renamed file became a doc of its own).
		const l = s.fileGone ? undefined : input.local.get(s.pathKey);
		const movable = r !== undefined && r.state === "live" && r.pathKey !== s.pathKey && !syncedByKey.has(r.pathKey) && !arrivedElsewhere(r.pathKey, s)
			&& !renamedElsewhere(s, r.pathKey);
		const atR = movable ? input.local.get(r.pathKey) : undefined;
		if (l && atR && ownBytesAt(s, r!, l, atR)) return { l: atR, atRemote: true };
		if (l) return { l, atRemote: false };
		if (atR) return { l: atR, atRemote: true };
		return { l: undefined, atRemote: false };
	};
	/**
	 * S is behind a move of the doc (an S restored from a mirror older than the move, after an IDB loss): the file at
	 * the doc's remote path holds S's bytes, which are still the doc's current ones, and the file at S's path holds
	 * other bytes. The doc's file is the one at the remote path; the other is a new file (another doc's, which took
	 * S's old path). Taking the file at S's path instead trashed the doc's own file as a copy (`ownCopyAt`) and
	 * pushed the other file's bytes as an edit of the doc (sim seed 630 F DEV3, production checkpoints: B's
	 * attachment got C's bytes at the same path).
	 */
	const ownBytesAt = (s: SyncedEntry, r: RemoteEntry, l: LocalEntry, atR: LocalEntry): boolean =>
		!atR.excluded && atR.kind === s.kind && l.hash !== null && atR.hash !== null &&
		atR.hash === s.contentHash && l.hash !== s.contentHash && remoteHash(r) === s.contentHash;

	// ---- remote moves into occupied paths ---------------------------------------
	// A file at a live remote entry's path is that doc's, unless the doc is synced at another path and its file is
	// still there: then the remote moved it onto a file this device has that the mover never saw (a local create or
	// rename). That file is new here. It is created like any other (the fold suffixes it, its loser rename frees the
	// path); the remote move waits for the path (`moveBlocked`).
	const remoteOwns = (key: PathKey): boolean => {
		const id = input.remoteByPathKey.get(key);
		if (id === undefined) return false;
		const s = input.synced.get(id);
		return !(s && s.pathKey !== key && ((!s.fileGone && input.local.has(s.pathKey)) || arrivedElsewhere(key, s)));
	};
	// Keys this plan moves a synced file away from (remote moved it, not pinned by an own pending op).
	const vacating = new Set<PathKey>();
	for (const id of syncedIds) {
		const s = input.synced.get(id)!;
		const r = resolve(id);
		if (r && r.state === "live" && !r.pendingLocal && !s.fileGone && r.pathKey !== s.pathKey && input.local.has(s.pathKey)) vacating.add(s.pathKey);
	}
	const moveBlocked = (r: RemoteEntry, l: LocalEntry): boolean => r.pathKey !== l.pathKey && input.local.has(r.pathKey) && !vacating.has(r.pathKey);
	/** An own create of `l` would fold as an identical duplicate of the doc moving onto its path (merged, then dropped: a loop). */
	const mergesIntoOwner = (l: LocalEntry): boolean => {
		const id = input.remoteByPathKey.get(l.pathKey);
		const w = id === undefined ? undefined : input.remote.get(id);
		return w !== undefined && w.kind === l.kind && (l.hash === w.createHash || l.hash === (w.blob?.hash ?? null));
	};
	/** The occupant of r's (blocked) target is untracked and holds r's own bytes: the doc's file `l` or its create content. */
	const ownCopyAt = (r: RemoteEntry, l: LocalEntry): boolean => {
		const t = input.local.get(r.pathKey);
		if (!t || t.excluded || syncedByKey.has(r.pathKey) || claimed.has(r.pathKey) || input.remoteByPathKey.get(r.pathKey) !== r.docId) return false;
		return t.hash === null || (t.hash === l.hash && t.kind === l.kind) || mergesIntoOwner(t);
	};

	// ---- rename inference ------------------------------------------------------
	/**
	 * The file at `key` is new although a synced doc sits there: that doc's file is gone (decided delete, fileGone)
	 * and the user renamed another file there (sim seed 703 F DEV3). It takes part in inference as a new file.
	 */
	const goneHere = (key: PathKey): boolean => {
		const id = syncedByKey.get(key);
		const s = id === undefined ? undefined : input.synced.get(id);
		return s?.fileGone === true && arrivedElsewhere(key, s);
	};
	const freshLocal = inScopeLocal.filter((l) => !l.excluded && (goneHere(l.pathKey) || (!syncedByKey.has(l.pathKey) && !remoteOwns(l.pathKey))));
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
	// A doc deleted remotely whose file the user renamed here (observed only: the rename is the user's, not a
	// guess): the file is still the doc's. Unpaired, the doc is dropped and the observed rename later pairs with
	// whatever doc takes the source path next, merging this file into it (sim DEV5 F seed 157: an offline edit and
	// rename of a note a peer deleted and re-created at its path; the edits landed in the new note's body).
	if (ctx.nsReady && input.renames.length > 0) {
		const gone: SyncedEntry[] = [];
		for (const id of docIds) {
			const s = input.synced.get(id);
			const r = s ? resolve(id) : undefined;
			if (s && r && r.state === "deleted" && localFor(s, r).l === undefined) gone.push(s);
		}
		const used = new Set([...inferred.values()].map((rn) => rn.to.pathKey));
		const rest = freshLocal.filter((l) => !used.has(l.pathKey));
		if (gone.length > 0) for (const rn of inferRenames(gone, rest, input.renames, false, pk)) inferred.set(rn.docId, rn);
	}
	// Observed renames off a re-occupied source path (header): observed-only inference over the rest. A rename onto
	// the same path key (case only) leaves nothing behind: the file there is the renamed file (hot canvas seed 208).
	const renamedFrom = new Set(input.renames.filter((e) => pk(e.from) !== pk(e.to)).map((e) => pk(e.from)));
	const movedAway = new Set<DocId>();
	if (ctx.nsReady && renamedFrom.size > 0) {
		const reoccupied: SyncedEntry[] = [];
		for (const id of docIds) {
			const s = input.synced.get(id);
			const r = input.remote.get(id);
			// A remote move of the doc does not change this: the user's rename still took the doc's file along
			// (a missing source is inferred the same way), so the file at the old path is never carried to R.path.
			if (s && r && r.state === "live" && !s.fileGone && renamedFrom.has(s.pathKey) && input.local.has(s.pathKey)) reoccupied.push(s);
		}
		const used = new Set([...inferred.values()].map((rn) => rn.to.pathKey));
		for (const rn of inferRenames(reoccupied, freshLocal.filter((l) => !used.has(l.pathKey)), input.renames, false, pk)) {
			inferred.set(rn.docId, rn);
			movedAway.add(rn.docId);
		}
	}
	// Observed renames onto the path of a remote doc never materialized here (no synced record): the file there
	// came from the rename source, so it is the moved doc's, not the remote doc's (merged into it, the bound
	// editor of the moved doc refuses the write and every pass adds a conflict copy, sim heavy seed 222). The
	// doc moves; its nsRename folds suffixed and the remote doc materializes once the file has left the path.
	// Until ns is ready (no inference) the file is left alone, not merged into the remote doc.
	const observedOnto = new Set<PathKey>();
	if (renamedFrom.size > 0) {
		const usedKeys = new Set([...inferred.values()].map((rn) => rn.to.pathKey));
		const observedTo = new Set(input.renames.map((e) => pk(e.to)));
		const onto = inScopeLocal.filter((l) => {
			if (l.excluded || usedKeys.has(l.pathKey) || syncedByKey.has(l.pathKey) || !observedTo.has(l.pathKey)) return false;
			const holder = input.remoteByPathKey.get(l.pathKey);
			return holder !== undefined && !input.synced.has(holder);
		});
		if (onto.length > 0) {
			const rest = missing.filter((s) => !inferred.has(s.docId));
			for (const rn of inferRenames(rest, onto, input.renames, false, pk)) {
				observedOnto.add(rn.to.pathKey);
				if (ctx.nsReady) inferred.set(rn.docId, rn);
			}
		}
	}
	// Observed renames off the path of a remote doc with no synced record here, whose file sat there untracked (the
	// doc's, as any file at a live remote entry's path is: planRemoteOnly merges it into the doc): the renamed file
	// is still that doc's. The doc moves with it and merges it there, against the old epoch's base at the path it
	// left (§c.12: a migration drops the synced records and keeps bases by path). Unpaired, the file became a new doc
	// and the doc came back at the old path, with what the user had deleted in the file (sim suite-1
	// wipe/revoke/roll seed 40: a canvas edited while key-missing, renamed after an epoch restore).
	const movedUntracked = new Map<DocId, LocalEntry>();
	const movedChain = new Map<DocId, ObservedRename[]>();
	const keepRenames: ObservedRename[] = [];
	if (ctx.nsReady && renamedFrom.size > 0) {
		const used = new Set([...inferred.values()].map((rn) => rn.to.pathKey));
		const fresh = new Set(freshLocal.map((l) => l.pathKey));
		for (const from of renamedFrom) {
			const id = input.remoteByPathKey.get(from);
			if (id === undefined || input.synced.has(id) || input.local.has(from)) continue;
			const r = input.remote.get(id);
			if (!r || r.state !== "live" || r.kind === "blob" || r.pathKey !== from) continue;
			const away = renamedAway(input.renames, from, pk);
			const l = away ? input.local.get(pk(away.to)) : undefined;
			if (!l || l.excluded || l.kind !== r.kind || !fresh.has(l.pathKey) || used.has(l.pathKey) || input.remoteByPathKey.has(l.pathKey)) continue;
			movedUntracked.set(id, l);
			movedChain.set(id, renameChain(input.renames, from, pk));
			used.add(l.pathKey);
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
			// A lost create body (header) that this device holds a synced record for, with the file just what S says:
			// the merge that would have pushed the text has nothing to do (an own create's file was edited back to
			// S, e.g. a born-empty S and a file now empty, or a broken canvas save fixed to the empty canvas; or S
			// came back from the mirror after its store was lost). No frame ever fills the doc, and every other device
			// waits on "body-empty" for good. Drop the empty doc as when no S is here; the file is a new local file
			// once the delete folds, created with what it holds. A path change moves the doc first.
			if (!Lc && !Rc && !pathChanged && body?.caughtUp && !body.hasContent && r.createHash !== EMPTY_CONTENT_HASH && ctx.lostCreateBody.has(docId) && ctx.nsReady && !r.pendingLocal) {
				return { ...none, ops: [{ op: "nsDelete", docId, baseBodySeq: 0 }, drop(docId)] };
			}
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
		// The file is a live doc's: that doc's synced record sits at the path, or the doc there holds these bytes. A
		// trash would delete it (its planner row reads the file as gone: nsDelete), and a re-create would duplicate
		// it. Drop S only; the live doc keeps (or, next pass, adopts) the file (sim seed 222: the own create, folded
		// as replay-duplicate, had a twin create of the same file from before an IDB wipe that did fold).
		const holder = input.remoteByPathKey.get(s.pathKey);
		if (holder !== undefined && holder !== s.docId && (input.synced.get(holder)?.pathKey === s.pathKey || mergesIntoOwner(l))) {
			return push([...prefix, drop(s.docId)]);
		}
		// A prune removes only an entry the fold held (created, then deleted or merged): nsTouchSeq 0 says this
		// device never saw the doc committed (an own create still waits for S1 to stamp the fold's seq). Its absence
		// is then an own create the fold ignored (replay-duplicate, duplicate-docid, ...), not a prune: the file is
		// created anew instead of trashed, as a changed file is below. The worst case of the rule is a resurrection
		// (an own create that did fold, was deleted elsewhere and pruned before S1 ran), never a loss.
		// Restore duty of a pruned doc (§c.9 "Pruned docs"): body rows the pruned delete did not cover (committed past
		// its base, or own frames still in the outbox) beat the delete (§c.7), but the restore can no longer name the
		// pruned id. The file (S tracks the edits this device sent, so it reads unchanged) is created anew with them
		// instead of trashed (sim smallPrune seed 104: offline edits trashed; open-repro prune-storm-mass-delete:
		// sent edits trashed when the delete and its prune folded in one batch).
		if (takesNoFreshId(s, l.hash, false) && !hasRestoreDuty(s.docId)) {
			return push([...prefix, { op: "diskTrash", docId: s.docId, path: l.path, expect: { t: "hash", hash: s.contentHash } }, drop(s.docId)],
				"diskTrash", brakeKey("diskTrash", s.docId, l.path, s.contentHash), l.path);
		}
		// The re-create takes the file's bytes: a replica ahead of what the file was synced at (own edits a bound
		// editor never saved before a crash, rows from elsewhere) is merged into the file first, under the old id,
		// and the next pass creates anew from the merged file (sim smallPrune storm seed 200: an unsaved bound edit
		// lost to a re-create from the file).
		const replica = s.kind === "blob" ? undefined : ctx.prunedBody.get(s.docId);
		if (replica && !versionEq(replica, s.bodyVersion) && (l.kind === "markdown" || l.kind === "canvas") && l.kind === s.kind) {
			return push([...prefix, { op: "reconcileContent", docId: s.docId, path: l.path, kind: l.kind, hasBase: s.hasBase }]);
		}
		const id = takeFresh();
		if (id === null) return push(prefix);
		push([...prefix, { op: "nsCreate", docId: id, kind: l.kind, path: l.path, contentHash: l.hash!, size: l.size }, ...initialContent(id, l), drop(s.docId)]);
	};

	const deleted = (s: SyncedEntry, origId: DocId, r: RemoteEntry, l: LocalEntry | undefined, prefix: PlannerOp[]): void => {
		// Before ns is ready inference is off: S carries the identity an observed rename of the file still needs.
		if (!l && !ctx.nsReady) return push(prefix);
		const inf = l ? undefined : inferred.get(origId);
		if (inf && !claimed.has(inf.to.pathKey)) return deletedRenamed(s, r, inf.to, prefix);
		if (!l) {
			// Own rows the delete did not cover (§c.7 duty) and the file deleted here too: dropped, S would leave the
			// restore to the no-S branch below, which brings the doc back at its path. Kept, the pass after the
			// restore sees live/present/absent: an nsDelete covering the own rows, or edit-beats-delete (sim blob seed 5).
			if (hasRestoreDuty(s.docId)) {
				if (r.pendingLocal) return push([...prefix, waitOp(s.docId, "pending-ns")]);
				return push([...prefix, { op: "nsRestore", docId: s.docId, path: r.path, againstDeleteSeq: r.deletedSeq }]);
			}
			return push([...prefix, drop(s.docId)]);
		}
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

	/**
	 * The user renamed the file of a doc deleted remotely (observed rename, not yet published). The rename is an
	 * edit of the doc the deleter never saw: it wins as an ns rename does (E6), so the doc is restored at the new
	 * path, with the file's content (`reconcileContent` records the synced path; otherwise a `syncedPut` does).
	 */
	const deletedRenamed = (s0: SyncedEntry, r: RemoteEntry, l2: LocalEntry, prefix: PlannerOp[]): void => {
		const { fileGone: _gone, renamedTo: _to, ...s } = s0;
		claimed.add(l2.pathKey);
		if (l2.hash === null) return push([...prefix, { op: "needHash", path: l2.path }]);
		if (r.pendingLocal) return push([...prefix, waitOp(s.docId, "pending-ns")]);
		const ops: PlannerOp[] = [...prefix, { op: "nsRestore", docId: s.docId, path: l2.path, againstDeleteSeq: r.deletedSeq }];
		const moved: PlannerOp = { op: "syncedPut", entry: { ...s, path: l2.path, pathKey: l2.pathKey } };
		if (l2.hash === s.contentHash) ops.push(moved);
		else if (s.kind === "blob") {
			ops.push({ op: "nsSetBlob", docId: s.docId, hash: l2.hash, size: l2.size, baseRev: r.blob?.rev ?? 0 });
			ops.push({ op: "pushBlob", docId: s.docId, path: l2.path, hash: l2.hash, size: l2.size }, moved);
		} else if (r.body && r.body.caughtUp) {
			ops.push({ op: "reconcileContent", docId: s.docId, path: l2.path, kind: s.kind as ContentKind, hasBase: s.hasBase });
		} else {
			ops.push(waitOp(s.docId, "body-not-caught-up"), moved);
		}
		push(ops, null, "", l2.path);
	};

	const liveMissing = (s0: SyncedEntry, origId: DocId, r: RemoteEntry, prefix: PlannerOp[]): void => {
		const { fileGone, renamedTo: _to, ...s } = s0;
		const docId = s.docId;
		const inf = inferred.get(origId);
		if (inf && !claimed.has(inf.to.pathKey)) {
			const l2 = inf.to;
			claimed.add(l2.pathKey);
			if (l2.hash === null) return push([...prefix, { op: "needHash", path: l2.path }]);
			// The source path holds S's own bytes again (the engine re-materialized the doc there before the rename
			// event arrived): S is that file's record, and the moved file's base is unknown (sim hot canvas seed 0).
			const stale = movedAway.has(docId) && input.local.get(s.pathKey)?.hash === s.contentHash;
			const step0 = contentStep(s, r, l2, l2.path, l2.path, true);
			const step = !stale ? step0 : {
				...step0, ops: step0.ops.map((o): PlannerOp => (o.op === "reconcileContent" ? { ...o, hasBase: false, noBase: true } : o)),
			};
			const hasContentOp = step.ops.some((o) => o.op !== "syncedPut" && o.op !== "wait");
			const renameOps: PlannerOp[] = [{ op: "nsRename", docId, path: l2.path }];
			// The content job writes the synced path itself; otherwise record the move now.
			if (hasContentOp) return push([...prefix, ...renameOps, ...step.ops], step.destructive, step.key, l2.path);
			const put: PlannerOp = { op: "syncedPut", entry: { ...s, path: l2.path, pathKey: l2.pathKey } };
			return push([...prefix, ...renameOps, ...step.ops.filter((o) => o.op !== "syncedPut"), put], step.destructive, step.key, l2.path);
		}
		// The file is gone from a complete listing: the doc is deleted here or renamed (inference). Whatever this
		// pass waits for (body catch-up, ns, inference, own ops), a file re-created at the path meanwhile is new, as
		// it is once the delete went out, not a save over this doc (sim heavy seed 92: an offline delete, then a new
		// note at the same path, merged into the doc a peer had emptied). `fileGone` records that; it passes the
		// brake as the delete does, and the delete it leads to is not braked again.
		const hold = (...ops: PlannerOp[]): void => {
			push([...prefix, ...ops]);
			if (!fileGone && input.localComplete) {
				const away = renamedAway(input.renames, s.pathKey, pk);
				const entry: SyncedEntry = { ...s, fileGone: true, ...(away ? { renamedTo: away } : {}) };
				push([{ op: "syncedPut", entry }], "nsDelete", brakeKey("nsDelete", docId, s.path, s.contentHash), s.path);
			}
		};
		if (s.kind !== "blob" && (!r.body || !r.body.caughtUp)) return hold(waitOp(docId, "body-not-caught-up"));
		// "Not a rename" needs the inference inputs, for edit-beats-delete as for nsDelete: while ns
		// is not ready inference is off, and re-materializing would undo the user's rename into a copy.
		if (!input.localComplete || unhashedFresh || !ctx.nsReady) return hold();
		const Rc = s.kind === "blob" ? (r.blob?.rev ?? 0) !== s.blobRev : !versionEq(r.body!.version, s.bodyVersion);
		if (Rc) {
			// Edit beats delete. A decided delete whose path holds a new file by now: the file merges into the doc
			// after all (the next pass sees it as the doc's), there is no free path to restore the doc at.
			// Unless the file there is another doc's: renamed there by the user from elsewhere, or synced as another
			// doc's (sim seed 703 F DEV3). The doc then waits for its path.
			if (fileGone && r.pathKey === s.pathKey && input.local.has(s.pathKey)) {
				const other = arrivedElsewhere(s.pathKey, s) || claimed.has(s.pathKey)
					|| [...input.synced.values()].some((o) => o.docId !== docId && o.pathKey === s.pathKey && !o.fileGone);
				return push(other ? prefix : [...prefix, { op: "syncedPut", entry: s }]);
			}
			return push([...prefix, { op: "diskMaterialize", docId, path: r.path, expect: { t: "absent" } }]);
		}
		if (r.pendingLocal) return hold(waitOp(docId, "pending-ns"));
		// Own body frames still unsequenced: a delete now would carry a base below them and hand
		// this device a restore duty for its own edits (§c.7). Delete once they are acked.
		if (input.docsWithPendingBody.has(docId)) return hold(waitOp(docId, "pending-body"));
		const ops: PlannerOp[] = [...prefix, { op: "nsDelete", docId, baseBodySeq: baseBodySeq(r) }, drop(docId)];
		if (fileGone) return push(ops);
		push(ops, "nsDelete", brakeKey("nsDelete", docId, s.path, s.contentHash), s.path);
	};

	/** A caught-up markdown / canvas body with content whose textHash is not known: not resident here. */
	const unhashed = (r: RemoteEntry): boolean => r.kind !== "blob" && r.body !== null && r.body.caughtUp && r.body.hasContent && !ctx.remoteTextHash.has(r.docId);
	/** Wait for `docId`'s text to be loaded and hashed (runner: wait "text-hash"); the winner is not planned meanwhile. */
	const waitText = (docId: DocId, prefix: PlannerOp[], winner: DocId = docId): boolean => {
		handled.add(winner);
		push([...prefix, waitOp(docId, "text-hash")]);
		return true;
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
		const migrated = !identical && s.kind !== "blob" && ctx.pathBaseKeys.has(s.pathKey);
		// A caught-up text whose hash is unknown here is not resident (a restart since): load it and decide on the
		// next pass, instead of a loser rename for want of it (a duplicate; sim suite-1 seed 65).
		if (!identical && !migrated) return wh === null && unhashed(w) ? waitText(winner, prefix) : false;
		// The loser must still hold just what this device synced: once another device wrote to it (it materialized
		// the loser under its suffixed name and edited it there), its nsDelete would drop that edit with it. It is a
		// doc of its own then, and keeps the loser rename.
		if (r.body && !r.body.caughtUp) {
			handled.add(winner);
			push([...prefix, waitOp(s.docId, "body-not-caught-up")]);
			return true;
		}
		const lh = remoteHash(r);
		if (lh === null && unhashed(r)) return waitText(s.docId, prefix, winner);
		if (lh === null || lh !== s.contentHash) return false;
		handled.add(winner);
		if (migrated && (!w.body?.caughtUp || (!w.body.hasContent && w.createHash !== EMPTY_CONTENT_HASH))) {
			push([...prefix, waitOp(s.docId, w.body?.caughtUp ? "body-empty" : "body-not-caught-up")]);
			return true;
		}
		// The loser's own create frames still unsequenced: its nsDelete would carry a base below them and hand every
		// device a restore duty (§c.7), bringing the loser back under a suffixed name. Collapse once they are acked,
		// as a user delete waits.
		if (input.docsWithPendingBody.has(s.docId)) {
			push([...prefix, waitOp(s.docId, "pending-body")]);
			return true;
		}
		const ops: PlannerOp[] = [
			...prefix, { op: "rebind", fromDocId: s.docId, toDocId: winner, path: w.path, ...(migrated ? { adopt: true as const } : {}) },
			{ op: "nsDelete", docId: s.docId, baseBodySeq: baseBodySeq(r) },
		];
		if (migrated) ops.push({ op: "reconcileContent", docId: winner, path: l.path, kind: s.kind, hasBase: false, pathBase: true });
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
			} else if (moveBlocked(r, l) && !ownCopyAt(r, l)) {
				// The target holds a new local file (see remoteOwns): keep the doc at its path until that file moves.
			} else if (moveBlocked(r, l)) {
				// The target holds an untracked copy of this doc's own bytes (its current file or its create
				// content, e.g. the user's rename of a copy re-materialized after an IDB loss). It is never
				// created (mergesIntoOwner) and the move would wait for it forever: trash it (plan order puts
				// trashes after renames, so the move is the next pass's, once the path is free).
				const t = input.local.get(r.pathKey)!;
				claimed.add(t.pathKey);
				if (t.hash === null) return push([...prefix, { op: "needHash", path: t.path }]);
				push([{ op: "diskTrash", docId: null, path: t.path, expect: { t: "hash", hash: t.hash } }], "diskTrash", brakeKey("diskTrash", docId, t.path, t.hash), t.path);
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
			// The loser's replica moved past its sync point: own edits its file does not hold (typed into an editor
			// bound to the loser, the save lost with the app; sim suite-1 seed 1). Its frames are the only copy (they
			// stay in the outbox until the loser's stream is dropped, after this rebind): write them to the file
			// first, and the rebind of the next pass merges them into the winner off the disk.
			if (s0.kind !== "blob" && r0.body && !r0.body.frozen && r0.body.hasContent && !versionEq(r0.body.version, s0.bodyVersion)) {
				// Its file: at its path, or where the user moved it (rename inference, as for any synced doc).
				const l0 = (s0.fileGone ? undefined : input.local.get(s0.pathKey)) ?? inferred.get(s0.docId)?.to;
				if (l0 && !l0.excluded && !claimed.has(l0.pathKey)) {
					claimed.add(l0.pathKey);
					// Not planned as a remote-only doc meanwhile (a materialize onto the loser's file).
					if (!input.synced.has(r0.aliasOf)) handled.add(r0.aliasOf);
					if (l0.hash === null) return push([{ op: "needHash", path: l0.path }]);
					return push([{ op: "reconcileContent", docId: s0.docId, path: l0.path, kind: s0.kind, hasBase: s0.hasBase }]);
				}
			}
			if (input.synced.has(r0.aliasOf)) return push([drop(s0.docId)]);
			prefix.push({ op: "rebind", fromDocId: s0.docId, toDocId: r0.aliasOf, path: s0.path });
			r = input.remote.get(r0.aliasOf);
			// Seen committed as the winner (the rebind job records its touch seq): never an own unfolded create (collapse).
			s = { ...(r ? restartAtCreate(s0, r.createHash) : s0), docId: r0.aliasOf, ...(r && !r.pendingLocal ? { nsTouchSeq: Math.max(s0.nsTouchSeq, r.lastTouchSeq) } : {}) };
			handled.add(r0.aliasOf);
		}
		const found = movedAway.has(s.docId) ? { l: undefined, atRemote: false } : localFor(s, r);
		if (found.atRemote && s.fileGone) {
			const { fileGone: _gone, renamedTo: _to, ...live } = s; // the doc's file is at its remote path: not gone, and the put records it there
			s = live;
		}
		const l = found.l;
		if (l) claimed.add(l.pathKey);
		if (l?.excluded) return push(prefix);
		// The file at a path an observed rename left may be new: no merge into the doc before inference (ns ready).
		if (l && !found.atRemote && !ctx.nsReady && renamedFrom.has(s.pathKey)) return push(prefix);
		if (r?.body?.frozen) {
			// The doc waits, and so does whatever happened to its file (sim suite-1 wipe/revoke/roll seed 40: a doc frozen
			// key-missing, edited and renamed; the renamed file was created anew and the doc deleted once it thawed). Its
			// renamed file (inference) is still this doc's: never a new create meanwhile. And a file gone from a complete
			// listing is recorded as liveMissing records it (fileGone, the observed rename kept on S): the pass that drops
			// the observed renames from memory must not take the rename with it, or the thawed doc reads as deleted.
			const inf = l ? undefined : inferred.get(s0.docId);
			if (inf) claimed.add(inf.to.pathKey);
			push([...prefix, waitOp(s.docId, "frozen")]);
			if (!l && r.state === "live" && !s.fileGone && input.localComplete) {
				const { renamedTo: _to, ...rest } = s;
				const away = renamedAway(input.renames, s.pathKey, pk);
				push([{ op: "syncedPut", entry: { ...rest, fileGone: true, ...(away ? { renamedTo: away } : {}) } }],
					"nsDelete", brakeKey("nsDelete", s.docId, s.path, s.contentHash), s.path);
			}
			return;
		}
		if (l && l.hash === null) return push([...prefix, { op: "needHash", path: l.path }]);
		if (!r) return pruned(s, l, prefix);
		if (r.state === "deleted") return deleted(s, s0.docId, r, l, prefix);
		if (r.state !== "live") return push(prefix);
		if (!l) return liveMissing(s, s0.docId, r, prefix);
		livePresent(s, r, l, found.atRemote, prefix);
	};

	/** A file is at `key` and no diskRename planned so far (every synced doc is planned before remote-only ones) moves it away. */
	const occupiedThroughPlan = (key: PathKey): boolean =>
		input.local.has(key) && !units.some((u) => u.ops.some((o) => o.op === "diskRename" && pk(o.from) === key));

	const planRemoteOnly = (r: RemoteEntry): void => {
		const docId = r.docId;
		const key = r.pathKey;
		const blocked = syncedByKey.has(key) || claimed.has(key);
		const l = blocked ? undefined : input.local.get(key);
		if (l?.excluded) return;
		const moved = movedUntracked.get(docId);
		if (moved) {
			claimed.add(moved.pathKey);
			// While the doc waits, only memory has the rename (no synced record to keep it on): it stays there.
			const wait = (op: PlannerOp): void => {
				keepRenames.push(...(movedChain.get(docId) ?? []));
				push([op]);
			};
			if (r.body?.frozen) return wait(waitOp(docId, "frozen"));
			if (moved.hash === null) return wait({ op: "needHash", path: moved.path });
			if (r.pendingLocal) return wait(waitOp(docId, "pending-ns"));
			if (!r.body || !r.body.caughtUp) return wait(waitOp(docId, "body-not-caught-up"));
			return push([
				{ op: "nsRename", docId, path: moved.path },
				{ op: "reconcileContent", docId, path: moved.path, kind: r.kind as ContentKind, hasBase: false, basePath: r.path },
			], null, "", moved.path);
		}
		if (r.body?.frozen) return push([waitOp(docId, "frozen")]);
		// The file that sat at the path (the doc's, untracked) just left it by an observed rename: whether it is still
		// the doc's is inference's, off while ns is not ready. A materialize meanwhile turned the rename into a copy.
		if (!l && !blocked && !ctx.nsReady && renamedFrom.has(key)) return;
		// The file at the path is a renamed doc's (observed rename above): materialize once it has moved away.
		if (observedOnto.has(key)) return;
		// Another doc's file holds the path and no rename this plan moves it away (renames run before materializes,
		// trashes after): a materialize could only fail its absent precondition, and the failed write throws its
		// downloaded bytes away. Materialize once the path is free (sim real skip deferral seed 20: the occupant's
		// move was pinned by its own pending ns op, and the materialize re-downloaded both blobs in a hot loop).
		if (!l && blocked && occupiedThroughPlan(key)) return;
		if (!l) {
			// Live only through an own op not yet folded (a restore with no synced record here): its path is the
			// overlay's guess, and S1 puts S on the requested path at fold. Materialize the committed placement.
			if (r.pendingLocal) return push([waitOp(docId, "pending-ns")]);
			if (r.kind === "blob") return push([{ op: "diskMaterialize", docId, path: r.path, expect: { t: "absent" } }]);
			if (!r.body || !r.body.caughtUp) return push([waitOp(docId, "body-not-caught-up")]);
			if (r.body.hasContent || r.createHash === EMPTY_CONTENT_HASH) return push([{ op: "diskMaterialize", docId, path: r.path, expect: { t: "absent" } }]);
			if (!ctx.lostCreateBody.has(docId)) return push([waitOp(docId, "body-empty")]);
			// Own create whose content is gone with the store and its file: drop the empty doc.
			if (!ctx.nsReady || !input.localComplete || unhashedFresh) return;
			if (r.pendingLocal) return push([waitOp(docId, "pending-ns")]);
			return push([{ op: "nsDelete", docId, baseBodySeq: 0 }], "nsDelete", brakeKey("nsDelete", docId, r.path, r.createHash), r.path);
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
		if (!r.body.hasContent && r.createHash !== EMPTY_CONTENT_HASH) {
			if (!ctx.lostCreateBody.has(docId)) return push([waitOp(docId, "body-empty")]);
			// Lost create body with the file here (header): drop the empty doc; the file is a new create once it folds.
			if (!ctx.nsReady) return;
			if (r.pendingLocal) return push([waitOp(docId, "pending-ns")]);
			return push([{ op: "nsDelete", docId, baseBodySeq: 0 }]);
		}
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
		push([{ op: "nsCreate", docId: id, kind: l.kind, path: l.path, contentHash: l.hash, size: l.size }, ...initialContent(id, l)]);
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
		window: ctx.brakeWindow,
		approval: input.brakeApproval,
	});
	return {
		ops: orderOps(outcome.released.flatMap((u) => u.ops), pk),
		held: orderOps(outcome.held.flatMap((u) => u.ops), pk),
		brake: outcome.report,
		consumedDocIds: consumed,
		...(keepRenames.length > 0 ? { keepRenames } : {}),
	};
}
