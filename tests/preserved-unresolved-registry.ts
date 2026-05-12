import assert from "node:assert/strict";
import { PreservedUnresolvedRegistry, type PreservedUnresolvedEntry } from "../src/sync/preservedUnresolved";

const firstSeenAt = Date.parse("2026-05-11T08:00:00Z");
const lastSeenAt = Date.parse("2026-05-11T08:05:00Z");

const persisted: PreservedUnresolvedEntry[] = [
	{
		path: "Notes/Needs Attention.md",
		kind: "markdown",
		reason: "remote-delete-missing-baseline",
		firstSeenAt,
		lastSeenAt,
		localHash: "local-note",
		knownRemoteHash: null,
	},
	{
		path: "Attachments/photo.png",
		kind: "blob",
		reason: "remote-delete-hash-read-failed",
		firstSeenAt: firstSeenAt + 1,
		lastSeenAt: lastSeenAt + 1,
		localHash: null,
		knownRemoteHash: "remote-blob",
	},
];

const registry = new PreservedUnresolvedRegistry(persisted);

assert.equal(registry.has("Notes/Needs Attention.md"), true);
assert.equal(registry.paths.has("Notes/Needs Attention.md"), true);
assert.equal(registry.has("Attachments/photo.png"), true);
assert.equal(registry.paths.has("Attachments/photo.png"), true);

const summary = registry.getSummary();
assert.equal(summary.markdownCount, 1);
assert.equal(summary.blobCount, 1);
assert.equal(summary.totalCount, 2);
assert.equal(summary.lastAt, lastSeenAt + 1);
assert.equal(summary.reasons["remote-delete-missing-baseline"], 1);
assert.equal(summary.reasons["remote-delete-hash-read-failed"], 1);

registry.record({
	path: "Notes/Needs Attention.md",
	kind: "markdown",
	reason: "multiple-editor-authorities",
	at: lastSeenAt + 10,
	localHash: "local-note-new",
});

const updated = registry.get("Notes/Needs Attention.md");
assert.ok(updated);
assert.equal(updated.firstSeenAt, firstSeenAt);
assert.equal(updated.lastSeenAt, lastSeenAt + 10);
assert.equal(updated.reason, "multiple-editor-authorities");
assert.equal(updated.localHash, "local-note-new");
assert.equal(updated.knownRemoteHash, null);

assert.equal(registry.resolve("Notes/Needs Attention.md"), true);
assert.equal(registry.has("Notes/Needs Attention.md"), false);
assert.equal(registry.paths.has("Notes/Needs Attention.md"), false);
assert.equal(registry.getSummary().totalCount, 1);

registry.clear();
assert.equal(registry.getSummary().totalCount, 0);
assert.equal(registry.paths.size, 0);

console.log("preserved-unresolved registry tests passed");
