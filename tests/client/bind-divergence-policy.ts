/**
 * Bind-time divergence decisions (src/sync/bindDivergencePolicy.ts), the
 * logic behind main.ts `resolveEditorBindDivergence`.
 *
 * Contract (docs/sync-contract.md): the baseline decides which side holds
 * local input; with both moved or nothing known, the editor text is
 * preserved before the body converges; artifacts are never repeated for
 * identical content; repeated identical attempts are quarantined.
 */
import { strict as assert } from "node:assert";
import {
	BindDivergencePolicy,
	BindDivergenceQuarantinedError,
	type BindDivergenceBaseline,
} from "../../legacy-src/sync/bindDivergencePolicy";
import { contentBaselineHash } from "../../legacy-src/sync/diskIndex";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { suite } from "../harness.ts";

installDomCrypto();
const s = suite("bind-divergence-policy");

const BASE = "# Note\n\nseed\n";
const REMOTE = `${BASE}remote edit\n`;
const LOCAL = `${BASE}local edit\n`;
const PROPS = "---\ntags: [a]\n---\n";

function policyFixture(baseline: BindDivergenceBaseline, options: { failArtifacts?: boolean } = {}) {
	const artifacts: Array<{ path: string; content: string; reason: string }> = [];
	const notices: string[] = [];
	let now = 1_000;
	const policy = new BindDivergencePolicy({
		getBaseline: async () => baseline,
		hash: (content) => contentBaselineHash(content),
		createArtifact: async (path, content, reason) => {
			if (options.failArtifacts) throw new Error("disk full");
			artifacts.push({ path, content, reason });
			return `${path} (conflict ${artifacts.length})`;
		},
		notify: (message) => { notices.push(message); },
		now: () => now,
	});
	return { policy, artifacts, notices, advance: (ms: number) => { now += ms; } };
}

const whole = async (content: string, known = false): Promise<BindDivergenceBaseline> =>
	({ kind: "whole", hash: await contentBaselineHash(content), content: known ? content : null });

s.test("an editor still at the baseline adopts the body without preserving anything", async () => {
	const f = policyFixture(await whole(BASE));
	assert.equal(await f.policy.resolve({ path: "N.md", editorContent: BASE, bodyContent: REMOTE }), "adopt-body");
	assert.equal(f.artifacts.length, 0);
});

s.test("a body still at the baseline adopts the editor's local edit", async () => {
	const f = policyFixture(await whole(BASE));
	assert.equal(await f.policy.resolve({ path: "N.md", editorContent: LOCAL, bodyContent: BASE }), "adopt-editor");
	assert.equal(f.artifacts.length, 0);
});

s.test("both changed: the editor is preserved once, then the body wins", async () => {
	const f = policyFixture(await whole(BASE));
	const input = { path: "N.md", editorContent: LOCAL, bodyContent: REMOTE };
	assert.equal(await f.policy.resolve(input), "adopt-body");
	assert.deepEqual(f.artifacts, [{ path: "N.md", content: LOCAL, reason: "bind-divergence-both-changed" }]);
	assert.equal(f.notices.length, 1);
	assert.equal(await f.policy.resolve({ ...input, bodyContent: `${REMOTE}more\n` }), "adopt-body");
	assert.equal(f.artifacts.length, 1, "identical editor text is never preserved twice");
});

s.test("an editor whose edits the body already contains adopts the body without an artifact", async () => {
	const f = policyFixture(await whole(BASE, true));
	const editor = `top\n${BASE}`;
	assert.equal(
		await f.policy.resolve({ path: "N.md", editorContent: editor, bodyContent: `top\n${REMOTE}` }),
		"adopt-body",
	);
	assert.equal(f.artifacts.length, 0);
});

s.test("REVIEW N10: disjoint edits on both sides of a known baseline adopt their merge, preserving nothing", async () => {
	const f = policyFixture(await whole(BASE, true));
	const editor = `local heading\n${BASE}`;
	const decision = await f.policy.resolve({ path: "N.md", editorContent: editor, bodyContent: REMOTE });
	assert.deepEqual(decision, { kind: "adopt-merged", content: `local heading\n${REMOTE}` });
	assert.equal(f.artifacts.length, 0, "a clean merge keeps both edits; no conflict note");
	assert.equal(f.notices.length, 0);
});

s.test("REVIEW N10: a body whose edits the editor already contains adopts the editor", async () => {
	const f = policyFixture(await whole(BASE, true));
	const editor = `local heading\n${REMOTE}`;
	assert.equal(await f.policy.resolve({ path: "N.md", editorContent: editor, bodyContent: REMOTE }), "adopt-editor");
	assert.equal(f.artifacts.length, 0);
});

s.test("no baseline: preserve, and never repeat an artifact for identical editor text", async () => {
	const f = policyFixture({ kind: "unknown", reason: "missing" });
	for (let i = 0; i < 3; i++) {
		assert.equal(await f.policy.resolve({ path: "N.md", editorContent: LOCAL, bodyContent: REMOTE }), "adopt-body");
	}
	assert.deepEqual(f.artifacts.map((artifact) => artifact.reason), ["bind-divergence-no-baseline"]);
});

s.test("untrusted and dropped-version baselines are unknown, not proof", async () => {
	for (const reason of ["untrusted", "canonical-version"] as const) {
		const f = policyFixture({ kind: "unknown", reason });
		assert.equal(await f.policy.resolve({ path: "N.md", editorContent: BASE, bodyContent: REMOTE }), "adopt-body");
		assert.deepEqual(f.artifacts.map((artifact) => artifact.reason), [`bind-divergence-${reason}-baseline`]);
	}
});

s.test("body-only settlements compare Markdown bodies, not the missing whole hash", async () => {
	const baseline: BindDivergenceBaseline = {
		kind: "body-only",
		bodyHash: await contentBaselineHash(BASE),
		propertiesHash: await contentBaselineHash(PROPS),
	};
	const f = policyFixture(baseline);
	assert.equal(
		await f.policy.resolve({ path: "N.md", editorContent: PROPS + BASE, bodyContent: PROPS + REMOTE }),
		"adopt-body",
		"editor body at the settled body: no local edit",
	);
	assert.equal(
		await f.policy.resolve({ path: "N.md", editorContent: PROPS + LOCAL, bodyContent: PROPS + BASE }),
		"adopt-editor",
		"body at the settled body: the editor's edit is local input",
	);
	assert.equal(f.artifacts.length, 0, "the no-baseline branch never fires for body-only entries");
	assert.equal(
		await f.policy.resolve({ path: "N.md", editorContent: PROPS + LOCAL, bodyContent: PROPS + REMOTE }),
		"adopt-body",
	);
	assert.deepEqual(f.artifacts.map((artifact) => artifact.reason), ["bind-divergence-body-only-both-changed"]);
});

s.test("a failed artifact write rejects: no convergence without preservation", async () => {
	const f = policyFixture({ kind: "unknown", reason: "missing" }, { failArtifacts: true });
	await assert.rejects(f.policy.resolve({ path: "N.md", editorContent: LOCAL, bodyContent: REMOTE }), /disk full/);
	assert.equal(f.notices.length, 0);
});

s.test("identical repeated resolutions are quarantined, and the window expires", async () => {
	const f = policyFixture(await whole(BASE));
	const input = { path: "N.md", editorContent: BASE, bodyContent: REMOTE };
	for (let i = 0; i < 4; i++) assert.equal(await f.policy.resolve(input), "adopt-body");
	await assert.rejects(f.policy.resolve(input), (error: unknown) =>
		error instanceof BindDivergenceQuarantinedError && error.nonRetryable);
	f.advance(61_000);
	assert.equal(await f.policy.resolve(input), "adopt-body");
});

await s.done();
