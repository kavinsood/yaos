import { strict as assert } from "node:assert";
import { planMarkdownAgreement } from "../../src/sync/markdownAgreement";
import { suite } from "../harness.ts";

const tests = suite("markdown-agreement");

tests.test("equality and established unchanged inputs use one agreement policy", () => {
	assert.equal(planMarkdownAgreement({ local: "same\r\n", body: "same\n", base: null }).kind, "agree");
	assert.equal(planMarkdownAgreement({ local: "base", body: "remote", base: "base" }).kind, "project-body");
	assert.equal(planMarkdownAgreement({ local: "local", body: "base", base: "base" }).kind, "import-local");
	assert.equal(planMarkdownAgreement({ local: "base", body: "remote", base: null, localMatchesAgreement: true }).kind, "project-body");
	assert.equal(planMarkdownAgreement({ local: "local", body: "base", base: null, bodyMatchesAgreement: true }).kind, "import-local");
});

tests.test("unknown provenance and overlapping edits preserve both inputs", () => {
	assert.deepEqual(planMarkdownAgreement({ local: "local", body: "remote", base: null }), { kind: "preserve", merge: null });
	assert.equal(planMarkdownAgreement({ local: "local\n", body: "remote\n", base: "base\n" }).kind, "preserve");
});

tests.test("established disjoint edits merge without losing either side", () => {
	const plan = planMarkdownAgreement({ local: "local\nsecond\n", body: "first\nremote\n", base: "first\nsecond\n" });
	assert.equal(plan.kind, "merge");
	if (plan.kind === "merge") assert.equal(plan.merge.content, "local\nremote\n");
});

tests.test("a raw disk replacement cannot erase text just because the remote matches the materialized base", () => {
	const body = "original\nremote paragraph\n";
	assert.deepEqual(planMarkdownAgreement({ local: "replacement\n", body, base: body, localInput: "unbound-disk" }), { kind: "preserve", merge: null });
	assert.equal(planMarkdownAgreement({ local: "inserted\n" + body, body, base: body, localInput: "unbound-disk" }).kind, "import-local");
	assert.equal(planMarkdownAgreement({ local: "replacement\n", body, base: body, localInput: "known-base" }).kind, "import-local");
});

await tests.done();
