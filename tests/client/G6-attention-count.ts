import { strict as assert } from "node:assert";
import { getAttentionCount, getLabelFromConnectionState } from "../../src/status/statusBarController";
import { suite } from "../harness.ts";

const checks = suite("G6-attention-count");

checks.test("an expected open-body deferral alone requires no attention", () => {
	const count = getAttentionCount([{ path: "Open.md", reason: "body-open-deferred" }], [], []);
	assert.equal(count, 0);
	assert.equal(getLabelFromConnectionState({ kind: "online", generation: 1 }, null, null, count), "YAOS: Connected");
});

checks.test("disjoint attention sources are counted by path union, not maximum", () => {
	assert.equal(getAttentionCount(
		[{ path: "Disk.md", reason: "remote-delete-read-failed" }],
		[{ path: "Conflict.md" }],
		[{ path: "Image.png" }],
	), 3);
});

checks.test("overlapping sources count once and real conflicts survive deferred flushes", () => {
	assert.equal(getAttentionCount(
		[
			{ path: "Conflict.md", reason: "body-open-deferred" },
			{ path: "Other.md", reason: "remote-delete-missing-baseline" },
		],
		[{ path: "Conflict.md" }, { path: "Other.md" }],
		[{ path: "Other.md" }],
	), 2);
});

checks.test("empty sources do not display attention", () => {
	assert.equal(getAttentionCount([], [], []), 0);
});

await checks.done();
