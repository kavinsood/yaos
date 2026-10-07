import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	COPY_LINK_WARNING, DEVICE_NAME_HINT, keyCommandMessage, keyMissingText, NO_PIN_TEXT, NOT_EMPTY_MESSAGE, PENDING_QR_TEXT,
	REKEY_EVERY_DEVICE_TEXT, SCAN_QR_TEXT, STORE_RK_ADVICE,
} from "./e2eeText";
import type { KeyMissingReason } from "../../protocol/status";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the §12.1, §12.4, §13.2 and §15.1 texts are verbatim", () => {
	assert.equal(NOT_EMPTY_MESSAGE, "The server returned a vault that is not empty");
	assert.equal(NO_PIN_TEXT, "YAOS can't tell whether this vault is end-to-end encrypted. The server says it holds no encryption key record, but a server can hide one, so this device will not sync until one of your own devices or your recovery key settles it.");
	assert.equal(COPY_LINK_WARNING, "This link contains your vault key. Send it only over a channel you trust (AirDrop, a cable), never a chat app.");
	assert.equal(STORE_RK_ADVICE, "Store it outside this vault: a password manager or paper");
	assert.equal(DEVICE_NAME_HINT, "Visible to the server operator");
	assert.match(REKEY_EVERY_DEVICE_TEXT, /EVERY/);
	assert.match(SCAN_QR_TEXT, /"Pair another device"/);
	assert.match(PENDING_QR_TEXT, /memory only/);
});

test("the blocked screen explains each reason; encrypted-vault starts with the §12.4 sentence", () => {
	const reasons: KeyMissingReason[] = ["no-pin", "no-key", "revoked-epoch", "encrypted-vault"];
	const texts = reasons.map(keyMissingText);
	assert.equal(new Set(texts).size, reasons.length);
	assert.equal(keyMissingText("no-pin"), NO_PIN_TEXT);
	assert.ok(keyMissingText("encrypted-vault").startsWith("This vault is end-to-end encrypted. "));
	assert.match(keyMissingText("revoked-epoch"), /re-key/);
	for (const t of texts) assert.match(t, /recovery key/);
});

test("keyCommandMessage maps the engine's refusals, main's refusals and a stopped engine to plain sentences", () => {
	assert.equal(keyCommandMessage(new Error("refused: another genesis won; this device stays unpinned")), `${NOT_EMPTY_MESSAGE}.`);
	assert.match(keyCommandMessage(new Error("refused: the key does not match the vault's key record for its epoch; a verified key is never replaced")), /does not match/);
	assert.match(keyCommandMessage(new Error("refused: revoke needs a suite-1 pin")), /^Re-keying needs/);
	assert.equal(keyCommandMessage(new Error("refused: something new")), "The vault refused this: something new.");
	assert.equal(keyCommandMessage(new Error("YAOS: this device's encryption setting for the vault is already decided.")), "This device's encryption setting for the vault is already decided.");
	assert.equal(keyCommandMessage(new Error("YAOS is not running.")), "YAOS is not running. Wait until it has started, then try again.");
	assert.equal(keyCommandMessage(new Error("timeout: no answer")), "timeout: no answer");
	for (const m of ["refused: x", "YAOS: y", "z"]) assert.ok(!keyCommandMessage(new Error(m)).startsWith("YAOS:"));
});

test("every refusal the table maps is a literal the engine throws (src/engine/compose, src/engine/keyring)", () => {
	const engine = ["engine/compose/keyReader.ts", "engine/compose/runtimeOps.ts", "engine/keyring/keyringRuntime.ts"]
		.map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
	const table = readFileSync(join(SRC, "host/ui/e2eeText.ts"), "utf8");
	const needles = [...table.matchAll(/^\t\["([^"]+)",/gm)].map((m) => m[1]!);
	assert.ok(needles.length >= 12);
	for (const n of needles) assert.ok(engine.includes(`"${n}`) || engine.includes(`\`${n}`), `the engine no longer throws "${n}"`);
	// And the ones the flows branch on.
	for (const n of ["k is not read to head yet", "another genesis won", "not on the creation path"]) assert.ok(needles.includes(n));
});
