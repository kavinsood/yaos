import { strict as assert } from "node:assert";
import { FrontmatterGuardCoordinator } from "../../src/sync/frontmatterGuardCoordinator";
import { AttentionNoticeQueue } from "../../src/ui/attentionNoticeQueue";
import { suite } from "../harness.ts";

const tests = suite("guard-notice-coalescing");

tests.test("G5: changes to fingerprints and directions cannot spam the same path", async () => {
	const coordinator = new FrontmatterGuardCoordinator({
		isFrontmatterGuardEnabled: () => true, trace: () => {}, persistPluginState: async () => {},
		getFrontmatterQuarantineEntries: () => [], setFrontmatterQuarantineEntries: () => {},
	});
	assert.equal(coordinator.shouldNotifyFrontmatterQuarantine("Note.md", "disk-to-crdt", "one"), true);
	assert.equal(coordinator.shouldNotifyFrontmatterQuarantine("Note.md", "crdt-to-disk", "two"), false);
	coordinator.clearFrontmatterNoticeFingerprint("Note.md", "disk-to-crdt");
	assert.equal(coordinator.shouldNotifyFrontmatterQuarantine("Note.md", "disk-to-crdt", "three"), false);
	assert.equal(coordinator.shouldNotifyFrontmatterQuarantine("Other.md", "disk-to-crdt", "one"), true);
});

tests.test("G1/G5: a burst becomes one delivery with distinct keys", async () => {
	const delivered: string[][] = [];
	const queue = new AttentionNoticeQueue((keys) => { delivered.push(keys); });
	for (const key of ["a", "b", "a", "c"]) queue.add(key);
	await queue.flush();
	assert.deepEqual(delivered, [["a", "b", "c"]]);
	queue.dispose();
});

await tests.done();
