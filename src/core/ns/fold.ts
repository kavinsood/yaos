/**
 * Namespace fold (DESIGN §c.3–§c.10). Pure and total: mutates the given
 * state/index in place (the maps are owned by the fold; entry objects are
 * immutable and replaced), never throws on a decoded NsFrame, never reads
 * clocks, randomness or Map insertion order.
 *
 * Decisions (wp-a-notes.md):
 * - A frame with seq <= coversSeq is a caller error: returns [] and changes nothing.
 * - The upgradeRules pre-scan runs before dedupe. A halt returns exactly one
 *   ignored/rules-version event (index = offending op, docId null) and leaves
 *   the state (including coversSeq) unchanged. nsFoldHalted(events) detects it.
 * - A duplicate frame emits one frame-level event and still sets coversSeq = seq
 *   (the row is folded; it just has no effect).
 * - restore also checks invalid-path / kind-mismatch on op.path (after
 *   restore-not-current), like rename.
 * - Events for unknown-docid / duplicate-docid carry op.docId; other per-op
 *   events carry the target after alias redirect.
 * - Pruning removes all aliases of a deleted entry before it, even if that
 *   overshoots below CAP − HYSTERESIS.
 */

import type {
	ClientFrameId,
	DocId,
	NsEntry,
	NsFoldEvent,
	NsFoldIndex,
	NsFoldState,
	NsFrame,
	NsIgnoreReason,
	NsOp,
	NsOpOutcome,
	FoldNsFrame,
	VaultPath,
} from "../types";
import { kindOfPath } from "../types";
import { FOLD_RULES_VERSION, NS_DEDUPE_RING, TOMBSTONE_CAP, TOMBSTONE_PRUNE_HYSTERESIS } from "../limits";
import { pathKey } from "../paths/pathKey";
import { isValidPath } from "../paths/validate";
import { indexAddLive, indexRemoveLive } from "./index";
import { applyRecases, place, type PlaceMode } from "./place";

export { newNsFoldState, newNsFoldIndex, buildIndex, cloneNsFold } from "./index";

/** Tunables. Production uses DEFAULT_NS_FOLD_RULES; tests shrink the tombstone cap. */
export interface NsFoldRules {
	readonly tombstoneCap: number;
	readonly pruneHysteresis: number;
	readonly dedupeRing: number;
	/** Highest fold rules version this reader implements (upgradeRules above it halts). */
	readonly knownRulesVersion: number;
}

export const DEFAULT_NS_FOLD_RULES: NsFoldRules = {
	tombstoneCap: TOMBSTONE_CAP,
	pruneHysteresis: TOMBSTONE_PRUNE_HYSTERESIS,
	dedupeRing: NS_DEDUPE_RING,
	knownRulesVersion: FOLD_RULES_VERSION,
};

/** True iff the events are a halt (frame not folded; phase upgrade-required). */
export function nsFoldHalted(events: readonly NsFoldEvent[]): boolean {
	return events.some((e) => e.outcome.kind === "ignored" && e.outcome.reason === "rules-version");
}

const ign = (reason: NsIgnoreReason): NsOpOutcome => ({ kind: "ignored", reason });
const APPLIED: NsOpOutcome = { kind: "applied" };

interface Ctx {
	readonly state: NsFoldState;
	readonly index: NsFoldIndex;
	readonly frame: NsFrame;
}

/** Alias redirect (§c.6.1). null = unknown. */
function target(state: NsFoldState, docId: DocId): NsEntry | null {
	const e = state.entries.get(docId);
	if (!e) return null;
	if (e.state === "merged") return e.aliasOf === null ? null : (state.entries.get(e.aliasOf) ?? null);
	return e;
}

function placedOutcome(requested: VaultPath, final: VaultPath, mode: PlaceMode): NsOpOutcome {
	if (mode === "revive") return { kind: "revived", finalPath: final };
	return final === requested ? APPLIED : { kind: "suffixed", requestedPath: requested, finalPath: final };
}

/** Revive a deleted entry at `requested` (rename-revive, restore, setBlob-revive). */
function revive(ctx: Ctx, e: NsEntry, requested: VaultPath, patch: Partial<NsEntry>): NsOpOutcome {
	const { state, index, frame } = ctx;
	const r = place(state, index, requested, "revive", { docId: e.docId, kind: e.kind, contentHash: null });
	if (r.t !== "path") return ign("invalid-path");
	applyRecases(state, index, r.recases);
	const next: NsEntry = {
		...e,
		...patch,
		state: "live",
		path: r.path,
		pathKey: r.key,
		deletedSeq: 0,
		deleteBaseBodySeq: 0,
		lastTouchSeq: frame.seq,
	};
	state.entries.set(e.docId, next);
	index.tombstones--;
	indexAddLive(index, next);
	return placedOutcome(requested, r.path, "revive");
}

function foldOp(ctx: Ctx, op: NsOp): { docId: DocId | null; outcome: NsOpOutcome } {
	const { state, index, frame } = ctx;
	switch (op.t) {
		case "create": {
			if (state.entries.has(op.docId)) return { docId: op.docId, outcome: ign("duplicate-docid") };
			if (!isValidPath(op.path)) return { docId: op.docId, outcome: ign("invalid-path") };
			if (op.kind !== kindOfPath(op.path)) return { docId: op.docId, outcome: ign("kind-mismatch") };
			const r = place(state, index, op.path, "create", { docId: op.docId, kind: op.kind, contentHash: op.contentHash });
			if (r.t === "fail") return { docId: op.docId, outcome: ign("invalid-path") };
			const base = {
				docId: op.docId,
				kind: op.kind,
				createdSeq: frame.seq,
				createdBy: frame.deviceId,
				lastTouchSeq: frame.seq,
				deletedSeq: 0,
				deleteBaseBodySeq: 0,
				createHash: op.contentHash,
				createSize: op.size,
			};
			if (r.t === "merged") {
				const w = state.entries.get(r.into)!;
				state.entries.set(op.docId, { ...base, state: "merged", path: w.path, pathKey: w.pathKey, blob: null, aliasOf: w.docId });
				index.tombstones++;
				return { docId: op.docId, outcome: { kind: "merged", into: w.docId } };
			}
			applyRecases(state, index, r.recases);
			const e: NsEntry = {
				...base,
				state: "live",
				path: r.path,
				pathKey: r.key,
				blob: op.kind === "blob" ? { hash: op.contentHash, size: op.size, rev: frame.seq } : null,
				aliasOf: null,
			};
			state.entries.set(op.docId, e);
			indexAddLive(index, e);
			return { docId: op.docId, outcome: placedOutcome(op.path, r.path, "create") };
		}
		case "rename": {
			const e = target(state, op.docId);
			if (!e) return { docId: op.docId, outcome: ign("unknown-docid") };
			const docId = e.docId;
			if (!isValidPath(op.path)) return { docId, outcome: ign("invalid-path") };
			if (e.kind !== kindOfPath(op.path)) return { docId, outcome: ign("kind-mismatch") };
			if (e.state === "deleted") {
				if (frame.authorNsSeq < e.deletedSeq) return { docId, outcome: revive(ctx, e, op.path, {}) };
				return { docId, outcome: ign("stale-revive") };
			}
			if (op.path === e.path) return { docId, outcome: ign("noop") };
			indexRemoveLive(index, e);
			const mode: PlaceMode = pathKey(op.path) === e.pathKey ? "caseOnlyRename" : "rename";
			const r = place(state, index, op.path, mode, { docId, kind: e.kind, contentHash: null });
			if (r.t !== "path") {
				indexAddLive(index, e);
				return { docId, outcome: ign("invalid-path") };
			}
			applyRecases(state, index, r.recases);
			const next: NsEntry = { ...e, path: r.path, pathKey: r.key, lastTouchSeq: frame.seq };
			state.entries.set(docId, next);
			indexAddLive(index, next);
			return { docId, outcome: placedOutcome(op.path, r.path, mode) };
		}
		case "delete": {
			const e = target(state, op.docId);
			if (!e) return { docId: op.docId, outcome: ign("unknown-docid") };
			const docId = e.docId;
			if (e.state === "deleted") return { docId, outcome: ign("already-deleted") };
			if (frame.authorNsSeq < e.lastTouchSeq) return { docId, outcome: ign("stale-delete") };
			indexRemoveLive(index, e);
			state.entries.set(docId, { ...e, state: "deleted", deletedSeq: frame.seq, deleteBaseBodySeq: op.baseBodySeq, lastTouchSeq: frame.seq });
			index.tombstones++;
			return { docId, outcome: { kind: "deleted" } };
		}
		case "restore": {
			const e = target(state, op.docId);
			if (!e) return { docId: op.docId, outcome: ign("unknown-docid") };
			const docId = e.docId;
			if (e.state !== "deleted") return { docId, outcome: ign("not-deleted") };
			if (e.deletedSeq !== op.againstDeleteSeq) return { docId, outcome: ign("restore-not-current") };
			if (!isValidPath(op.path)) return { docId, outcome: ign("invalid-path") };
			if (e.kind !== kindOfPath(op.path)) return { docId, outcome: ign("kind-mismatch") };
			return { docId, outcome: revive(ctx, e, op.path, {}) };
		}
		case "setBlob": {
			const e = target(state, op.docId);
			if (!e) return { docId: op.docId, outcome: ign("unknown-docid") };
			const docId = e.docId;
			if (e.kind !== "blob") return { docId, outcome: ign("not-blob") };
			const blob = { hash: op.hash, size: op.size, rev: frame.seq };
			if (e.state === "deleted") {
				if (frame.authorNsSeq < e.deletedSeq) return { docId, outcome: revive(ctx, e, e.path, { blob }) };
				return { docId, outcome: ign("stale-revive") };
			}
			if (e.blob !== null && op.hash === e.blob.hash) return { docId, outcome: ign("noop") };
			if (op.baseRev !== (e.blob?.rev ?? 0)) return { docId, outcome: ign("rev-mismatch") };
			state.entries.set(docId, { ...e, blob, lastTouchSeq: frame.seq });
			return { docId, outcome: APPLIED };
		}
		case "upgradeRules": {
			if (op.version <= state.foldRulesVersion) return { docId: null, outcome: ign("noop") };
			state.foldRulesVersion = op.version;
			return { docId: null, outcome: APPLIED };
		}
	}
}

/** §c.9. Returns the pruned docIds in removal order. */
function prune(state: NsFoldState, index: NsFoldIndex, rules: NsFoldRules): DocId[] {
	if (index.tombstones <= rules.tombstoneCap) return [];
	const goal = rules.tombstoneCap - rules.pruneHysteresis;
	const dead: NsEntry[] = [];
	const aliases = new Map<DocId, DocId[]>();
	const ids = [...state.entries.keys()].sort();
	for (const id of ids) {
		const e = state.entries.get(id)!;
		if (e.state === "live") continue;
		dead.push(e);
		if (e.state === "merged" && e.aliasOf !== null) {
			const list = aliases.get(e.aliasOf);
			if (list) list.push(id);
			else aliases.set(e.aliasOf, [id]);
		}
	}
	dead.sort((a, b) => a.lastTouchSeq - b.lastTouchSeq || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
	const removed: DocId[] = [];
	const drop = (id: DocId) => {
		state.entries.delete(id);
		index.tombstones--;
		removed.push(id);
	};
	for (const e of dead) {
		if (index.tombstones <= goal) break;
		if (!state.entries.has(e.docId)) continue;
		if (e.state === "deleted") for (const a of aliases.get(e.docId) ?? []) if (state.entries.has(a)) drop(a);
		drop(e.docId);
	}
	return removed;
}

export function foldNsFrameWith(rules: NsFoldRules, state: NsFoldState, index: NsFoldIndex, frame: NsFrame): NsFoldEvent[] {
	if (frame.seq <= state.coversSeq) return [];
	const ev = (i: number, docId: DocId | null, outcome: NsOpOutcome): NsFoldEvent => ({
		seq: frame.seq,
		index: i,
		deviceId: frame.deviceId,
		clientFrameId: frame.clientFrameId,
		docId,
		outcome,
	});
	// §c.10 pre-scan: the frame folds whole or not at all.
	for (let i = 0; i < frame.ops.length; i++) {
		const op = frame.ops[i]!;
		if (op.t === "upgradeRules" && op.version > rules.knownRulesVersion) return [ev(i, null, ign("rules-version"))];
	}
	// §c.3.2 dedupe ring.
	const ring = state.recentFrames.get(frame.deviceId);
	if (ring && ring.includes(frame.clientFrameId)) {
		state.coversSeq = frame.seq;
		return [ev(-1, null, ign("duplicate-frame"))];
	}
	const nextRing: ClientFrameId[] = ring ? [...ring, frame.clientFrameId] : [frame.clientFrameId];
	state.recentFrames.set(frame.deviceId, nextRing.length > rules.dedupeRing ? nextRing.slice(-rules.dedupeRing) : nextRing);
	// §c.3.3 ops.
	const ctx: Ctx = { state, index, frame };
	const events: NsFoldEvent[] = [];
	for (let i = 0; i < frame.ops.length; i++) {
		const { docId, outcome } = foldOp(ctx, frame.ops[i]!);
		events.push(ev(i, docId, outcome));
	}
	// §c.3.4 prune.
	const pruned = prune(state, index, rules);
	if (pruned.length > 0) events.push(ev(-1, null, { kind: "pruned", docIds: pruned }));
	state.coversSeq = frame.seq;
	return events;
}

export const foldNsFrame: FoldNsFrame = (state, index, frame) => foldNsFrameWith(DEFAULT_NS_FOLD_RULES, state, index, frame);
