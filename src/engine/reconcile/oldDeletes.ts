/**
 * What an old epoch's doc deleted, made again in the new epoch (DESIGN §c.12 "Deletes"; MetaDocDeletes,
 * compose/epochBases.ts). The content jobs call applyOldDeletes right after they acquire a doc's body.
 */

import * as Y from "yjs";
import type { DocId } from "../../core/types";
import type { BodyHandle } from "./deps";
import type { Env } from "./diskJobs";

/** A Yjs delete set (yjs does not export the class's type). */
export type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

/** §c.12: what an old epoch's doc deleted, by its docId (ReconcilerDeps.docDeletes, MetaDocDeletes). */
export type OldDocDeletes =
	| { readonly kind: "canvas"; readonly keys: ReadonlySet<string> }
	| { readonly kind: "markdown"; readonly ds: DeleteSet };

/**
 * §c.12 "Deletes": before this device first merges or writes a doc in the new epoch, the deletes its old doc of the
 * same id made are made again, as own edits (a restore keeps doc and item ids, so the ids name the same records and
 * characters; the restored state may predate the deletes, and the old outbox that carried them was dropped). A
 * canvas loses the records under the deleted keys, a note the characters whose items are in the delete set. Applied
 * wherever the doc is now: a rename may have been dropped with the old outbox, or another device's rename restored.
 * Then the edits are committed and the deletes retired.
 */
export async function applyOldDeletes(env: Env, docId: DocId, h: BodyHandle): Promise<void> {
	const deps = env.ctx.deps;
	const od = deps.docDeletes?.(docId) ?? null;
	if (!od) return;
	let n = 0;
	if (od.kind === "canvas") {
		h.doc.transact(() => {
			for (const [map, prefix] of [["nodes", "n:"], ["edges", "e:"]] as const) {
				const m = h.doc.getMap<unknown>(map);
				for (const id of [...m.keys()]) {
					if (!od.keys.has(prefix + id)) continue;
					m.delete(id);
					n++;
				}
			}
		}, h.mergeOrigin);
	} else {
		const text = h.doc.getText("text");
		const ranges: [number, number][] = []; // [index, length], ascending
		let pos = 0;
		for (let item = text._start; item !== null; item = item.right) {
			if (item.deleted || !item.countable) continue;
			if (item.content instanceof Y.ContentString) {
				for (let k = 0; k < item.length; k++) {
					if (!Y.isDeleted(od.ds, Y.createID(item.id.client, item.id.clock + k))) continue;
					const last = ranges[ranges.length - 1];
					if (last && last[0] + last[1] === pos + k) last[1]++;
					else ranges.push([pos + k, 1]);
				}
			}
			pos += item.length;
		}
		if (ranges.length > 0) {
			h.doc.transact(() => {
				for (let r = ranges.length - 1; r >= 0; r--) text.delete(ranges[r]![0], ranges[r]![1]);
			}, h.mergeOrigin);
			n = ranges.length;
		}
	}
	if (n > 0) await h.commitEdits();
	await deps.docDeletesApplied?.(docId);
}
