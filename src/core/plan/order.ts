/**
 * Plan op ordering (DESIGN §f.2 "Plan order"):
 *   0. rebind (deviation: first, so later ops of the same plan already see the
 *      winner's synced record — "rebind, then plan as W")
 *   1. ns ops: nsDelete, nsRename, nsRestore, nsCreate, nsSetBlob
 *   2. diskRename, topologically sorted; cycles broken through temp names
 *   3. removeEmptyFolder — not a PlannerOp; the plan runner inserts it
 *   4. diskMaterialize
 *   5. conflictCopy (before the overwrite it protects, which is a content op)
 *   6. diskTrash
 *   7. content ops: reconcileContent, pushBlob, fetchBlob
 *   8. bookkeeping: syncedPut, syncedDrop, needHash, wait
 * Stable within a category (input order = planner's deterministic order).
 */

import type { DocId, PathKeyFn, PlannerOp, VaultPath } from "../types";
import { SUFFIX_DOCID_CHARS } from "../limits";
import { joinPath, leafOf, parentOf, splitExt } from "./pathRules";

function rank(op: PlannerOp): number {
	switch (op.op) {
		case "rebind": return 0;
		case "nsDelete": return 10;
		case "nsRename": return 11;
		case "nsRestore": return 12;
		case "nsCreate": return 13;
		case "nsSetBlob": return 14;
		case "diskRename": return 20;
		case "diskMaterialize": return 40;
		case "conflictCopy": return 50;
		case "diskTrash": return 60;
		case "reconcileContent": case "pushBlob": case "fetchBlob": return 70;
		case "syncedPut": case "syncedDrop": case "needHash": case "wait": return 80;
	}
}

const TEMP_RE = / \(yaos-tmp ([A-Za-z0-9_-]{1,8})\)(\.[^/]*)?$/;

/** Temp name used to break rename cycles: `${stem} (yaos-tmp ${docId8})${ext}`, same folder, same kind. */
export function tempPathFor(path: VaultPath, docId: DocId | null): VaultPath {
	const { stem, ext } = splitExt(leafOf(path));
	return joinPath(parentOf(path), `${stem} (yaos-tmp ${(docId ?? "nodocid0").slice(0, SUFFIX_DOCID_CHARS)})${ext}`);
}

/** docId8 of a temp path left behind by a crash mid-cycle, else null. */
export function parseTempPath(path: VaultPath): string | null {
	const m = TEMP_RE.exec(leafOf(path));
	return m ? m[1]! : null;
}

type DiskRename = Extract<PlannerOp, { op: "diskRename" }>;

/**
 * Order renames so a rename runs after the rename that vacates its target.
 * Each source is moved at most once, so the dependency graph is chains plus
 * simple cycles; a cycle is broken by moving its first member to a temp name.
 */
export function sortRenames(renames: readonly DiskRename[], pathKey: PathKeyFn): DiskRename[] {
	const byFrom = new Map<string, DiskRename>();
	for (const r of renames) byFrom.set(pathKey(r.from), r);
	const out: DiskRename[] = [];
	const state = new Map<DiskRename, 1 | 2>(); // 1 = visiting, 2 = done
	const tails: DiskRename[] = [];

	const visit = (r: DiskRename, chain: DiskRename[]): void => {
		const s = state.get(r);
		if (s === 2) return;
		if (s === 1) {
			// Cycle: chain from r back to r. Move r out of the way first.
			const tmp = tempPathFor(r.from, r.docId);
			out.push({ ...r, to: tmp });
			byFrom.delete(pathKey(r.from));
			tails.push({ ...r, from: tmp });
			state.set(r, 2);
			return;
		}
		state.set(r, 1);
		const toKey = pathKey(r.to);
		const blocker = toKey === pathKey(r.from) ? undefined : byFrom.get(toKey);
		if (blocker && blocker !== r) visit(blocker, [...chain, r]);
		if (state.get(r) === 2) {
			// r was the cycle head and got moved to temp while visiting its blockers.
			const tail = tails.find((t) => t.docId === r.docId && t.to === r.to);
			if (tail) {
				out.push(tail);
				tails.splice(tails.indexOf(tail), 1);
			}
			return;
		}
		out.push(r);
		state.set(r, 2);
	};

	const sorted = [...renames].sort((a, b) => {
		const ka = pathKey(a.from);
		const kb = pathKey(b.from);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	for (const r of sorted) visit(r, []);
	for (const t of tails) out.push(t);
	return out;
}

export function orderOps(ops: readonly PlannerOp[], pathKey: PathKeyFn): PlannerOp[] {
	const indexed = ops.map((op, i) => ({ op, i, r: rank(op) }));
	indexed.sort((a, b) => a.r - b.r || a.i - b.i);
	const renames = indexed.filter((x) => x.op.op === "diskRename").map((x) => x.op as DiskRename);
	const sortedRenames = sortRenames(renames, pathKey);
	const out: PlannerOp[] = [];
	let placed = false;
	for (const x of indexed) {
		if (x.op.op === "diskRename") {
			if (!placed) {
				out.push(...sortedRenames);
				placed = true;
			}
			continue;
		}
		out.push(x.op);
	}
	return out;
}
