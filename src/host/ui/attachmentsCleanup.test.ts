import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentsCleanedNotice, cleanUpAttachments } from "./attachmentsCleanup";
import type { AttachmentCleanupRefusal, EngineResultValue, UserCommand } from "../../protocol/messages";

type Cleaned = Extract<EngineResultValue, { t: "attachmentsCleaned" }>;
const cleaned = (over: Partial<Cleaned> = {}): Cleaned => ({ t: "attachmentsCleaned", deleted: 0, keptNewer: 0, repaired: 0, lost: 0, refused: null, detail: null, ...over });

test("attachmentsCleanedNotice: deleted and kept-newer counts in one message", () => {
	assert.deepEqual(attachmentsCleanedNotice(cleaned({ deleted: 3, keptNewer: 1 })), {
		message: "Deleted 3 unused attachments from the server. Kept 1 unused recent upload; a later clean-up removes it once older.",
		level: "info",
	});
	assert.deepEqual(attachmentsCleanedNotice(cleaned()), { message: "No unused attachments to delete.", level: "info" });
	assert.equal(attachmentsCleanedNotice(cleaned({ deleted: 1, keptNewer: 2 })).message, "Deleted 1 unused attachment from the server. Kept 2 unused recent uploads; a later clean-up removes them once older.");
});

test("attachmentsCleanedNotice: every refusal says nothing was deleted and why", () => {
	const all: AttachmentCleanupRefusal[] = ["no-store", "keys-unverified", "offline", "read-only", "not-caught-up", "fold-incomplete", "body-unreadable", "addressing-mismatch", "busy"];
	const seen = new Set<string>();
	for (const refused of all) {
		const n = attachmentsCleanedNotice(cleaned({ refused, detail: "ns row 4: row does not open" }));
		assert.equal(n.level, "error");
		assert.match(n.message, /^Nothing was deleted: .+\.$/);
		assert.ok(!n.message.includes("row 4"), "the detail stays in diagnostics");
		seen.add(n.message);
	}
	assert.equal(seen.size, all.length);
});

test("attachmentsCleanedNotice: interrupted, repaired and lost", () => {
	const n = attachmentsCleanedNotice(cleaned({ refused: "interrupted", detail: "store 503", deleted: 100, repaired: 1, lost: 2 }));
	assert.equal(n.level, "error");
	assert.equal(n.message, "The clean-up stopped part-way (store 503). Deleted 100 unused attachments from the server. Uploaded 1 attachment again that another device started using meanwhile. 2 attachments another device started using meanwhile were deleted and this device has no copy: add them again from the device that has them.");
	assert.equal(attachmentsCleanedNotice(cleaned({ refused: "interrupted" })).message, "The clean-up stopped part-way.");
	assert.equal(attachmentsCleanedNotice(cleaned({ deleted: 2, repaired: 1 })).level, "info");
});

test("cleanUpAttachments: one command, one notice; a failure is one error notice", async () => {
	const sent: UserCommand[] = [];
	const notes: [string, string][] = [];
	await cleanUpAttachments({ command: (c) => { sent.push(c); return Promise.resolve(cleaned({ deleted: 2 })); } }, (m, l) => notes.push([m, l]));
	assert.deepEqual(sent, [{ t: "cleanUpAttachments" }]);
	assert.deepEqual(notes, [["Deleted 2 unused attachments from the server.", "info"]]);
	notes.length = 0;
	await cleanUpAttachments({ command: () => Promise.reject(new Error("the sync engine is not running")) }, (m, l) => notes.push([m, l]));
	assert.deepEqual(notes, [["Could not clean up attachments: the sync engine is not running", "error"]]);
	notes.length = 0;
	await cleanUpAttachments({ command: () => Promise.resolve({ t: "ok" }) }, (m, l) => notes.push([m, l]));
	assert.deepEqual(notes, [["Could not clean up attachments: the sync engine did not run the clean-up", "error"]]);
});
