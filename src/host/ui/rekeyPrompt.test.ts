import { test } from "node:test";
import assert from "node:assert/strict";
import { REKEY_PROMPT_CONFIRM, REKEY_PROMPT_TEXT, REKEY_PROMPT_TITLE, RekeyPromptTracker, rekeyDue } from "./rekeyPrompt";
import { FakeUiHost, identityFor, snapshot } from "./testkit/fakeUiHost";

const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBBB";

function host(over: { suite?: 0 | 1 | null; keyMissing?: "no-key" | "revoked-epoch" | null; rekey?: { removals: number; rekeyed: number } | null } = {}): FakeUiHost {
	const suite = over.suite === undefined ? 1 : over.suite;
	const h = new FakeUiHost({ identity: identityFor(VAULT), ...(suite === null ? {} : { e2ee: { suite } }) });
	const keyMissing = over.keyMissing === undefined ? null : over.keyMissing;
	h.snap = snapshot("live", { suite, sealEpoch: suite === 1 && keyMissing === null ? 1 : 0, keyMissing }, over.rekey === undefined ? {} : { rekey: over.rekey });
	return h;
}

test("rekeyDue: a removal no new key covers, on an encrypted device that holds the current key", () => {
	assert.equal(rekeyDue(host({ rekey: { removals: 1, rekeyed: 0 } })), 1);
	assert.equal(rekeyDue(host({ rekey: { removals: 3, rekeyed: 1 } })), 3, "the count to cover is the newest");
	assert.equal(rekeyDue(host({ rekey: { removals: 2, rekeyed: 2 } })), null, "covered: no nagging after the roll");
	assert.equal(rekeyDue(host({ rekey: { removals: 0, rekeyed: 0 } })), null, "no removal");
	assert.equal(rekeyDue(host()), null, "no signal reported (key reader, idle engine)");
	assert.equal(rekeyDue(host({ rekey: null })), null, "no session yet");
});

test("rekeyDue: never on a suite-0 or unpinned device, nor on one without the current key (it could not roll)", () => {
	const due = { removals: 1, rekeyed: 0 };
	assert.equal(rekeyDue(host({ suite: 0, rekey: due })), null, "suite 0: no key to roll; the relay's gate already shut the device out");
	assert.equal(rekeyDue(host({ suite: null, keyMissing: "no-key", rekey: due })), null);
	assert.equal(rekeyDue(host({ keyMissing: "revoked-epoch", rekey: due })), null, "another device already rolled");
	assert.equal(rekeyDue(host({ keyMissing: "no-key", rekey: due })), null);
});

test("RekeyPromptTracker: asks once per vault and removal count per plugin start; a new removal asks again", () => {
	const t = new RekeyPromptTracker();
	const h = host({ rekey: { removals: 1, rekeyed: 0 } });
	assert.equal(t.shouldOpen(h), true);
	assert.equal(t.shouldOpen(h), false, "\"Not now\" holds until the next start");
	h.snap = snapshot("live", { suite: 1, sealEpoch: 1, keyMissing: null }, { rekey: { removals: 2, rekeyed: 0 } });
	assert.equal(t.shouldOpen(h), true, "a second removal");
	h.snap = snapshot("live", { suite: 1, sealEpoch: 2, keyMissing: null }, { rekey: { removals: 2, rekeyed: 2 } });
	assert.equal(t.shouldOpen(h), false, "covered");
	const other = host({ rekey: { removals: 2, rekeyed: 0 } });
	other.current = { ...other.current, identity: identityFor(OTHER) };
	assert.equal(t.shouldOpen(other), true, "per vault");
	assert.equal(new RekeyPromptTracker().shouldOpen(host({ rekey: { removals: 1, rekeyed: 0 } })), true, "a restart asks again until it is covered");
});

test("the prompt says what happened, what is at stake and the one action", () => {
	assert.equal(REKEY_PROMPT_TITLE, "A device was removed from this vault");
	assert.match(REKEY_PROMPT_TEXT, /still has the vault key/);
	assert.match(REKEY_PROMPT_TEXT, /recovery key/);
	assert.match(REKEY_PROMPT_TEXT, /re-key QR code on each of your other devices/);
	assert.equal(REKEY_PROMPT_CONFIRM, "Make a new vault key");
});
