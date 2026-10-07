import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentsCleanedNotice, cleanUpAttachments, CLOSED_DEVICE_DETAIL, SHUT_GATE_DETAIL_PREFIX } from "./attachmentsCleanup";
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

test("attachmentsCleanedNotice: keys-unverified tells a closed device from a shut in-session gate", () => {
	const closed = attachmentsCleanedNotice(cleaned({ refused: "keys-unverified", detail: CLOSED_DEVICE_DETAIL })).message;
	const shut = attachmentsCleanedNotice(cleaned({ refused: "keys-unverified", detail: `${SHUT_GATE_DETAIL_PREFIX}revoked-epoch)` })).message;
	const unconfirmed = attachmentsCleanedNotice(cleaned({ refused: "keys-unverified", detail: "the vault's encryption key is not confirmed on this device" })).message;
	assert.equal(new Set([closed, shut, unconfirmed]).size, 3);
	assert.match(closed, /^Nothing was deleted: this device does not have the vault's encryption key yet; enter your recovery key/);
	assert.match(shut, /^Nothing was deleted: this device may not write to the vault right now/);
	assert.ok(!shut.includes("revoked-epoch"), "the detail stays in diagnostics");
	assert.equal(unconfirmed, "Nothing was deleted: this device has not confirmed the vault's encryption key.");
	// The details are the engine's literals (keyReader.ts closed device, blobGc.ts shut gate).
	const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "engine");
	assert.ok(readFileSync(join(src, "compose", "keyReader.ts"), "utf8").includes(`detail: "${CLOSED_DEVICE_DETAIL}"`));
	assert.ok(readFileSync(join(src, "runtime", "blobGc.ts"), "utf8").includes(`\`${SHUT_GATE_DETAIL_PREFIX}\${shut})\``));
});
