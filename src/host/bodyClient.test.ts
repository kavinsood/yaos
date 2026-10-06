/**
 * Main-thread body client units (DESIGN §d.3): DocMirror versions and durable base, ViewClient pre-bind rebase,
 * chained pushes, foreign-entry rebase, confirm and reject. The seeded end-to-end fuzz is bindingFuzz.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeSet, Text } from "@codemirror/state";
import { DocMirror, MIRROR_HISTORY, ViewClient } from "./bodyClient";

const T = (s: string) => Text.of(s.split("\n"));
const ins = (len: number, at: number, s: string) => ChangeSet.of({ from: at, insert: s }, len);
const del = (len: number, from: number, to: number) => ChangeSet.of({ from, to }, len);

/** An editor (text + what the client applies) and the pushes the client posts. */
function client(initial: string) {
	const ed = { text: T(initial) };
	const pushes: { seq: number; base: number; after: number | null; changes: ChangeSet }[] = [];
	let seq = 0;
	const c = new ViewClient({
		push: (s, base, after, changes) => void pushes.push({ seq: s, base, after, changes }),
		apply: (changes) => void (ed.text = changes.apply(ed.text)),
	}, () => ++seq);
	/** A local edit: the editor applies it, then the client hears it (as the ViewPlugin reports it). */
	const type = (ch: ChangeSet) => {
		ed.text = ch.apply(ed.text);
		c.local(ch);
	};
	return { ed, pushes, c, type };
}

test("DocMirror: entries apply in version order; a gap or a length mismatch is out of sync", () => {
	const m = new DocMirror(3, T("abc"));
	assert.equal(m.apply(3, 4, ins(3, 1, "X"), 4), true);
	assert.equal(m.text.toString(), "aXbc");
	assert.equal(m.version, 4);
	assert.equal(m.apply(3, 5, ins(4, 0, "Y"), 5), false, "from != version");
	assert.equal(m.apply(4, 5, ins(3, 0, "Y"), 4), false, "changes over another length");
	assert.equal(m.apply(4, 5, ins(4, 0, "Y"), 9), false, "result length differs");
	assert.equal(m.text.toString(), "aXbc", "a refused entry changes nothing");
});

test("DocMirror: markDurable keeps the text of the durable version as the restart base; history is bounded", () => {
	const m = new DocMirror(0, T(""));
	for (let v = 0; v < 5; v++) assert.ok(m.apply(v, v + 1, ins(v, v, String(v)), v + 1));
	const durable = () => m.durable?.toString() ?? null; // a call: no narrowing across markDurable
	assert.equal(durable(), null);
	m.markDurable(2);
	assert.equal(durable(), "01");
	m.markDurable(4);
	assert.equal(durable(), "0123");
	m.markDurable(3); // older than the base already kept: no change
	assert.equal(durable(), "0123");
	for (let v = 5; v < 5 + MIRROR_HISTORY + 10; v++) assert.ok(m.apply(v, v + 1, ins(m.text.length, 0, "z"), m.text.length + 1));
	m.markDurable(6); // dropped from the bounded history: the older durable base stays (safe, coarser)
	assert.equal(durable(), "0123");
});

test("ViewClient: edits before `bound` are rebased behind the bind changes, then pushed", () => {
	const { ed, pushes, c, type } = client("hello");
	assert.equal(c.flush(0), false, "nothing is pushed before bound");
	type(ins(5, 5, "!"));
	assert.ok(c.pending);
	// The replica merged the uploaded "hello" into "hello world" (the bind changes, against the uploaded text).
	c.bound(ins(5, 5, " world"));
	assert.equal(ed.text.toString(), "hello world!", "replica change first at equal positions");
	assert.ok(c.isAttached && c.flush(7));
	assert.equal(pushes.length, 1);
	assert.deepEqual({ base: pushes[0]!.base, after: pushes[0]!.after }, { base: 7, after: null });
	assert.equal(pushes[0]!.changes.apply(T("hello world")).toString(), "hello world!");
	assert.equal(c.confirm(pushes[0]!.seq), true);
	assert.equal(c.pending, false);
});

test("ViewClient: a later push chains after the one in flight; confirms go oldest first", () => {
	const { pushes, c, type } = client("ab");
	c.bound(ChangeSet.empty(2));
	type(ins(2, 2, "c"));
	c.flush(1);
	type(ins(3, 3, "d"));
	c.flush(1);
	assert.deepEqual(pushes.map((p) => [p.seq, p.base, p.after]), [[1, 1, null], [2, 1, 1]]);
	assert.equal(c.lastSeq, 2);
	assert.equal(c.confirm(2), false, "not the oldest push: protocol broken");
	assert.equal(c.confirm(1), true);
	assert.equal(c.confirm(2), true);
	assert.equal(c.lastSeq, null);
	c.local(ChangeSet.empty(4));
	assert.equal(c.pending, false, "an empty change is not an edit");
});

test("ViewClient: a foreign entry is rebased over the push in flight and the buffer; replica and editor converge", () => {
	const { ed, pushes, c, type } = client("abc");
	let replica = T("abc");
	c.bound(ChangeSet.empty(3));
	type(ins(3, 1, "X")); // aXbc
	c.flush(0);
	type(ins(4, 4, "Y")); // aXbcY, buffered
	// Another writer's change reached the replica first (v1): "Z" at 1, the same position as X.
	const f = ins(3, 1, "Z");
	replica = f.apply(replica);
	c.foreign(f);
	assert.equal(ed.text.toString(), "aZXbcY", "the replica's change goes first at equal positions");
	// The push was based on v0: rejected. Everything unconfirmed goes again, composed, at v1.
	assert.equal(c.reject(pushes[0]!.seq), true);
	assert.equal(c.flush(1), true);
	const re = pushes[1]!;
	assert.deepEqual([re.base, re.after], [1, null]);
	replica = re.changes.apply(replica);
	assert.equal(replica.toString(), ed.text.toString());
	assert.equal(c.confirm(re.seq), true);
});

test("ViewClient: a reject folds the chained pushes in; their own rejects are stale, unknown rejects are not", () => {
	const { ed, pushes, c, type } = client("");
	let replica = T("");
	c.bound(ChangeSet.empty(0));
	type(ins(0, 0, "a"));
	c.flush(0);
	type(ins(1, 1, "b"));
	c.flush(0); // chained after seq 1
	const f = ins(0, 0, "q"); // a foreign entry overtakes both
	replica = f.apply(replica);
	c.foreign(f);
	assert.equal(c.reject(1), true);
	assert.equal(c.reject(2), true, "seq 2 was chained behind the rejected push: stale");
	assert.equal(c.reject(9), false, "a reject of a push that never existed: resync");
	assert.equal(c.flush(1), true);
	const re = pushes.at(-1)!;
	assert.equal(re.seq, 3);
	replica = re.changes.apply(replica);
	assert.equal(replica.toString(), "qab");
	assert.equal(ed.text.toString(), "qab");
});

test("ViewClient: a delete overlapping a foreign delete converges (no double delete)", () => {
	const { ed, pushes, c, type } = client("0123456789");
	let replica = T("0123456789");
	c.bound(ChangeSet.empty(10));
	type(del(10, 2, 6)); // 016789
	c.flush(0);
	const f = del(10, 4, 8); // 012389
	replica = f.apply(replica);
	c.foreign(f);
	assert.equal(ed.text.toString(), "0189");
	c.reject(pushes[0]!.seq);
	c.flush(1);
	replica = pushes.at(-1)!.changes.apply(replica);
	assert.equal(replica.toString(), "0189");
});
