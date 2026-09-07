import * as Y from "yjs";
import {
	applyDiffToYText,
	applyDiffToYTextWithPostcondition,
	forceReplaceYText,
	tryApplyDiffToYText,
} from "../../src/sync/diff";
import { suite } from "../harness.ts";

const s = suite("diff-regressions");

type TextDelta = Y.YTextEvent["delta"];

interface CaptureResult {
	doc: Y.Doc;
	ytext: Y.Text;
	delta: TextDelta | null;
	value: string;
}

function applyAndCapture(oldText: string, newText: string, origin = "test-diff"): CaptureResult {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, oldText);

	let delta: TextDelta | null = null;
	ytext.observe((event) => {
		delta = event.delta;
	});

	applyDiffToYText(ytext, oldText, newText, origin);

	return {
		doc,
		ytext,
		delta,
		value: ytext.toString(),
	};
}

s.section("Test 1: no-op diff is a no-op");
{
	const oldText = "line 1\nline 2\n";
	const { value, delta, doc } = applyAndCapture(oldText, oldText);
	s.check(value === oldText, "content unchanged after no-op");
	s.check(delta === null, "no transaction emitted for no-op");
	doc.destroy();
}

s.section("Test 2: small mid-document edit patches correctly");
{
	const oldText = "alpha\nbeta\ngamma\n";
	const newText = "alpha\nbeta updated\ngamma\n";
	const { value, delta, doc } = applyAndCapture(oldText, newText);

	s.check(value === newText, "small edit produces exact final content");
	s.check(Array.isArray(delta) && delta.length > 0, "small edit emits a delta");
	s.check(
		delta?.some((part) => typeof part.retain === "number") === true,
		"small edit keeps stable surrounding content",
	);
	doc.destroy();
}

s.section("Test 3: far-apart edits stay localized on a large document");
{
	const lines: string[] = [];
	for (let i = 0; i < 5000; i++) {
		lines.push(`line ${String(i).padStart(4, "0")}: original content`);
	}
	const oldText = `${lines.join("\n")}\n`;

	const updated = [...lines];
	updated[49] = "line 0049: corrected intro typo";
	updated[4949] = "line 4949: appended outro paragraph";
	const newText = `${updated.join("\n")}\n`;

	const { value, delta, doc } = applyAndCapture(oldText, newText);

	s.check(value === newText, "large document edit produces exact final content");
	s.check(Array.isArray(delta) && delta.length >= 5, "large document delta stays segmented");
	s.check(
		delta?.some((part) => typeof part.retain === "number" && part.retain > 0) === true,
		"large document preserves unchanged anchors",
	);
	const deleted = (delta ?? []).reduce(
		(sum, part) => sum + (typeof part.delete === "number" ? part.delete : 0),
		0,
	);
	s.check(deleted < oldText.length / 4, "large document does not replace a huge chunk");
	doc.destroy();
}

s.section("Test 4: line endings and trailing newline changes are preserved");
{
	const oldText = "first line\nsecond line";
	const newText = "first line\nsecond line\nthird line\n";
	const { value, doc } = applyAndCapture(oldText, newText);

	s.check(value === newText, "trailing newline changes are preserved exactly");
	doc.destroy();
}

s.section("Test 5: inline task priority icon change keeps adjacent line boundary");
{
	const oldText = "- [ ] 🔺 task item\nnext line\n";
	const newText = "- [ ] 🔹 task item\nnext line\n";
	const { value, doc } = applyAndCapture(oldText, newText, "disk-sync-task-priority");
	s.check(value === newText, "priority icon swap keeps newline boundary intact");
	s.check(
		value.includes("task item\nnext line"),
		"priority icon swap does not merge task line with the next line",
	);
	doc.destroy();
}

s.section("Test 6: stale-base disk patch does not duplicate task icons or merge lines");
{
	const oldText = "- [ ] 🔺 task item\nnext line\n";
	const remoteText = "- [ ] 🔺 task item\nnext line changed remotely\n";
	const diskPluginText = "- [ ] 🔹 task item\nnext line\n";
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, oldText);

	applyDiffToYText(ytext, oldText, remoteText, "remote");
	applyDiffToYText(ytext, oldText, diskPluginText, "disk-sync");

	const merged = ytext.toString();
	s.check(
		merged.includes("- [ ] 🔹 task item\n"),
		"stale-base patch keeps one task line with the updated icon",
	);
	s.check(
		merged.includes("next line changed remotely\n"),
		"stale-base patch preserves remote adjacent-line content",
	);
	s.check(
		!merged.includes("🔹🔹"),
		"stale-base patch does not duplicate inline task icons",
	);
	doc.destroy();
}

s.section("Test 7: recovery postcondition force-replaces stale-base mismatch");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "abcX");

	const result = applyDiffToYTextWithPostcondition(
		ytext,
		"abc",
		"abcY",
		"disk-sync-recover-bound",
	);

	s.check(ytext.toString() === "abcY", "postcondition helper lands exact expected content");
	s.check(result.diffSkippedDueToStaleBase, "stale-base patch is skipped before mutation");
	s.check(!result.matchesAfterDiff, "stale-base patch mismatch is detected");
	s.check(result.forceReplaceApplied, "force replace is applied after mismatch");
	s.check(result.finalMatchesExpected, "force replace satisfies the postcondition");
	doc.destroy();
}

s.section("Test 8: forceReplaceYText replaces the whole Y.Text exactly");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "old content");

	forceReplaceYText(ytext, "new", "disk-sync-open-idle-recover");

	s.check(ytext.toString() === "new", "forceReplaceYText replaces old content exactly");
	doc.destroy();
}

s.section("Test 9: ordinary stale-base application is superseded without mutation");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "newer remote value");
	const outcome = tryApplyDiffToYText(ytext, "stale observed value", "disk value", "disk-sync");
	s.check(outcome === "superseded", "stale base produces a replan outcome");
	s.check(ytext.toString() === "newer remote value", "stale apply preserves newer content");
	doc.destroy();
}

s.section("Test 10: current-base application remains targeted and exact");
{
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, "alpha beta");
	const outcome = tryApplyDiffToYText(ytext, "alpha beta", "alpha BETA", "disk-sync");
	s.check(outcome === "applied", "current base applies normally");
	s.check(ytext.toString() === "alpha BETA", "safe apply reaches requested content");
	doc.destroy();
}
await s.done();
