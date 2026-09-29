/**
 * Stale-editor regression (B3 amplification path).
 *
 * yCollab assumes editor and Y.Text agree when it attaches, and maps every
 * later delta by offset. Deployed, device B opened a note whose disk copy
 * remote edits had overtaken: Obsidian loaded the stale disk into the editor,
 * yCollab attached over the divergence, B never showed the remote edit, and
 * later deltas/autosave wrote stale or garbled text back into the body.
 * A fresh bind now reconciles the two before attaching.
 */
import { strict as assert } from "node:assert";
import * as Y from "yjs";
import type { MarkdownView, TFile, Workspace } from "obsidian";
import {
	EditorBindingManager,
	type BindDivergenceDecision,
	type BindDivergenceResolver,
} from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { ORIGIN_EDITOR_HEALTH_HEAL } from "../../src/sync/origins";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

const s = suite("bind-divergence-resolution");

const STALE = "# Note\n\nseed\n";
const CURRENT = "# Note\n\nseed\nremote edit from A\n";

/** A CodeMirror stand-in: a document string and change dispatch. */
function fakeCm(initial: string) {
	let doc = initial;
	const cm = {
		state: { doc: { toString: () => doc } },
		dispatch: (spec: { changes?: { from: number; to: number; insert: string } }) => {
			if (!spec.changes) return;
			const { from, to, insert } = spec.changes;
			doc = doc.slice(0, from) + insert + doc.slice(to);
		},
	};
	return { cm, read: () => doc };
}

function fixture(
	editor: string,
	body: string,
	decide: (input: Parameters<BindDivergenceResolver>[0]) => BindDivergenceDecision | Promise<BindDivergenceDecision>,
) {
	const doc = new Y.Doc();
	const ytext = doc.getText("body");
	ytext.insert(0, body);
	const origins: unknown[] = [];
	doc.on("afterTransaction", (transaction) => { origins.push(transaction.origin); });
	const requests: Array<Parameters<BindDivergenceResolver>[0]> = [];
	const manager = new EditorBindingManager(
		partialOf<VaultSync>({}),
		partialOf<Workspace>({}),
		false,
		undefined,
		undefined,
		undefined,
		undefined,
		async (input) => { requests.push(input); return decide(input); },
	);
	const { cm, read } = fakeCm(editor);
	const view = partialOf<MarkdownView>({ file: partialOf<TFile>({ path: "Note.md" }) });
	let rebinds = 0;
	(manager as unknown as { bind: () => void }).bind = () => { rebinds++; };
	const reconcile = (): boolean => manager["reconcileBindDivergence"](view, cm as never, "leaf-1", "Note.md", ytext);
	const type = (text: string, at = read().length) => cm.dispatch({ changes: { from: at, to: at, insert: text } });
	return {
		ytext, origins, requests, read, reconcile, type, rebinds: () => rebinds,
		blocked: (path: string) => manager.isBindResolutionBlocked(path),
		unbindAll: () => manager.unbindAll(),
		unbindByPath: (path: string) => manager.unbindByPath(path),
	};
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

s.test("agreeing editor and body bind immediately without consulting the resolver", async () => {
	const f = fixture(CURRENT, CURRENT, () => { throw new Error("must not be asked"); });
	assert.equal(f.reconcile(), true);
	assert.equal(f.requests.length, 0);
});

s.test("a stale editor adopts the body before yCollab attaches", async () => {
	const f = fixture(STALE, CURRENT, () => "adopt-body");
	assert.equal(f.reconcile(), false, "bind waits for the decision");
	assert.equal(f.reconcile(), false, "a repeated bind does not start a second resolution");
	await settle();
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.requests[0], { path: "Note.md", editorContent: STALE, bodyContent: CURRENT });
	assert.equal(f.rebinds(), 1, "bind is re-entered once decided");
	assert.equal(f.reconcile(), true);
	assert.equal(f.read(), CURRENT, "the editor now shows the body");
	assert.equal(f.ytext.toString(), CURRENT);
	assert.deepEqual(f.origins, [], "the body was not touched");
});

s.test("a local editor edit is pushed into an unchanged body", async () => {
	const f = fixture(CURRENT, STALE, () => "adopt-editor");
	assert.equal(f.reconcile(), false);
	await settle();
	assert.equal(f.reconcile(), true);
	assert.equal(f.ytext.toString(), CURRENT);
	assert.deepEqual(f.origins, [ORIGIN_EDITOR_HEALTH_HEAL]);
});

s.test("a decision for content that changed meanwhile is not applied", async () => {
	const f = fixture(STALE, CURRENT, () => "adopt-body");
	assert.equal(f.reconcile(), false);
	await settle();
	f.ytext.insert(f.ytext.length, "more remote\n");
	assert.equal(f.reconcile(), false, "the body moved: resolve again");
	await settle();
	assert.equal(f.requests.length, 2);
	assert.equal(f.reconcile(), true);
	assert.equal(f.read(), `${CURRENT}more remote\n`);
});

s.test("typing during a pending resolution starts no second resolution and survives adopt-body", async () => {
	let answer!: (decision: BindDivergenceDecision) => void;
	const f = fixture(STALE, CURRENT, () => new Promise<BindDivergenceDecision>((resolve) => { answer = resolve; }));
	assert.equal(f.reconcile(), false);
	// The user types into the (unbound) editor away from the remote change.
	f.type("typed while waiting\n", 0);
	assert.equal(f.reconcile(), false, "still waiting on the first resolution");
	f.type("more typing\n", 0);
	assert.equal(f.reconcile(), false);
	assert.equal(f.requests.length, 1, "one resolution (hence at most one preserved copy) per divergence");
	answer("adopt-body");
	await settle();
	assert.equal(f.reconcile(), true);
	const expected = `more typing\ntyped while waiting\n${CURRENT}`;
	assert.equal(f.read(), expected, "the editor shows the body plus the typing made meanwhile");
	assert.equal(f.ytext.toString(), expected, "the typing reached the body before attach");
	assert.equal(f.requests.length, 1);
});

s.test("typing that overlaps the body's change during resolution is resolved again, not guessed", async () => {
	let answer!: (decision: BindDivergenceDecision) => void;
	const f = fixture(STALE, CURRENT, () => new Promise<BindDivergenceDecision>((resolve) => { answer = resolve; }));
	assert.equal(f.reconcile(), false);
	f.type("typed at the same place\n");
	answer("adopt-body");
	await settle();
	assert.equal(f.reconcile(), false, "ambiguous carry-over: a fresh resolution with the current text");
	assert.equal(f.requests.length, 2);
	assert.equal(f.requests[1]?.editorContent, `${STALE}typed at the same place\n`);
});

s.test("typing during a pending adopt-editor resolution is kept in full", async () => {
	let answer!: (decision: BindDivergenceDecision) => void;
	const f = fixture(CURRENT, STALE, () => new Promise<BindDivergenceDecision>((resolve) => { answer = resolve; }));
	assert.equal(f.reconcile(), false);
	f.type("typed\n");
	answer("adopt-editor");
	await settle();
	assert.equal(f.reconcile(), true);
	assert.equal(f.ytext.toString(), `${CURRENT}typed\n`);
});

s.test("a failed resolution leaves the editor unbound and retries with backoff", async () => {
	let calls = 0;
	const f = fixture(STALE, CURRENT, () => {
		calls++;
		if (calls === 1) throw new Error("artifact write failed");
		return "adopt-body";
	});
	assert.equal(f.reconcile(), false);
	await settle();
	assert.equal(f.rebinds(), 0, "no immediate re-bind after a failure");
	assert.equal(f.reconcile(), false, "a new bind attempt resolves again");
	await settle();
	assert.equal(f.reconcile(), true, "the retry's decision applies");
	assert.equal(f.read(), CURRENT);
	const g = fixture(STALE, CURRENT, () => { throw new Error("transient"); });
	g.reconcile();
	await settle();
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.equal(g.rebinds(), 1, "the backoff timer re-enters bind");
});

s.test("a quarantined (non-retryable) resolution is not retried", async () => {
	const f = fixture(STALE, CURRENT, () => {
		throw Object.assign(new Error("quarantined"), { nonRetryable: true as const });
	});
	f.reconcile();
	await settle();
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.equal(f.rebinds(), 0);
});

s.test("REVIEW N10: an adopt-merged decision gives editor and body the merge before attach", async () => {
	const MERGED = `local heading\n${CURRENT}`;
	const f = fixture(`local heading\n${STALE}`, CURRENT, () => ({ kind: "adopt-merged", content: MERGED }));
	assert.equal(f.reconcile(), false);
	await settle();
	assert.equal(f.reconcile(), true);
	assert.equal(f.read(), MERGED, "the editor shows the merge");
	assert.equal(f.ytext.toString(), MERGED, "the body holds the merge");
	assert.deepEqual(f.origins, [ORIGIN_EDITOR_HEALTH_HEAL]);
});

s.test("REVIEW N10: typing during a pending adopt-merged resolution is carried onto the merge", async () => {
	const MERGED = `local heading\n${CURRENT}`;
	let answer!: (decision: BindDivergenceDecision) => void;
	const f = fixture(`local heading\n${STALE}`, CURRENT, () => new Promise<BindDivergenceDecision>((resolve) => { answer = resolve; }));
	assert.equal(f.reconcile(), false);
	f.type("typed first\n", 0);
	answer({ kind: "adopt-merged", content: MERGED });
	await settle();
	assert.equal(f.reconcile(), true);
	assert.equal(f.read(), `typed first\n${MERGED}`);
	assert.equal(f.ytext.toString(), `typed first\n${MERGED}`);
});

s.test("REVIEW N1: a pending, retrying or abandoned bind resolution blocks disk ingest for the path", async () => {
	let answer!: (decision: BindDivergenceDecision) => void;
	const pending = fixture(STALE, CURRENT, () => new Promise<BindDivergenceDecision>((resolve) => { answer = resolve; }));
	assert.equal(pending.reconcile(), false);
	assert.equal(pending.blocked("Note.md"), true, "resolution in flight");
	assert.equal(pending.blocked("Other.md"), false);
	answer("adopt-body");
	await settle();
	assert.equal(pending.reconcile(), true);
	assert.equal(pending.blocked("Note.md"), false, "resolved");

	const retrying = fixture(STALE, CURRENT, () => { throw new Error("transient"); });
	retrying.reconcile();
	await settle();
	assert.equal(retrying.blocked("Note.md"), true, "a retry is scheduled");
	retrying.unbindAll();

	const abandoned = fixture(STALE, CURRENT, () => {
		throw Object.assign(new Error("quarantined"), { nonRetryable: true as const });
	});
	abandoned.reconcile();
	await settle();
	assert.equal(abandoned.blocked("Note.md"), true, "abandoned: still not safe to ingest for it");
	abandoned.unbindByPath("Note.md");
	assert.equal(abandoned.blocked("Note.md"), false, "cleared with the editor");
});

await s.done();
