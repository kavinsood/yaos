import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { updateCoveredBy } from "./compaction";

/** The update `edit` makes on a doc holding `base`, and the state after it. */
function step(base: Uint8Array, edit: (t: Y.Text) => void): { update: Uint8Array; after: Uint8Array } {
	const d = new Y.Doc();
	if (base.length > 0) Y.applyUpdate(d, base);
	const updates: Uint8Array[] = [];
	d.on("update", (u: Uint8Array) => void updates.push(u));
	edit(d.getText("t"));
	return { update: Y.mergeUpdates(updates), after: Y.encodeStateAsUpdate(d) };
}

test("updateCoveredBy: inserts and deletes held by the state are covered; anything missing or pending is not", () => {
	const base = step(new Uint8Array(), (t) => t.insert(0, "hello")).after;
	const ins = step(base, (t) => t.insert(5, " world"));
	assert.equal(updateCoveredBy(ins.after, ins.update), true, "insert held");
	assert.equal(updateCoveredBy(base, ins.update), false, "insert missing");
	const del = step(ins.after, (t) => t.delete(0, 1));
	assert.equal(updateCoveredBy(del.after, del.update), true, "delete held");
	assert.equal(updateCoveredBy(ins.after, del.update), false, "delete-only update: the state vector alone would call it covered");
	assert.equal(updateCoveredBy(new Uint8Array(), ins.update), false, "missing dependency: pending, not covered");
	assert.equal(updateCoveredBy(base, new Uint8Array([1, 2, 3])), false, "undecodable");
});
