import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isCreating, keyringSeenOf, markedCreating, pinAcross, pinnedSuite, pinnedSuite0, pinnedSuite1, pinsFromKeyring, refuseEnableE2ee,
	refuseKeyCommand, refusePinSuite0, sanitizeCreating, sanitizePin, sawKeyring, withoutPin, PIN_REFUSAL_TEXT, type PinFields,
} from "./pin";
import { sanitizePluginData } from "../ui/api";

const ABSENT: PinFields = {};
const SEEN: PinFields = { e2ee: { suite: null, keyringSeen: true } };
const S0: PinFields = { e2ee: { suite: 0 } };
const S1: PinFields = { e2ee: { suite: 1 } };

test("sanitizePin: exactly four states; anything else is absent (unpinned), never suite 0", () => {
	assert.equal(sanitizePin(undefined), undefined);
	assert.deepEqual(sanitizePin({ suite: 0 }), { suite: 0 });
	assert.deepEqual(sanitizePin({ suite: 1, extra: 1 }), { suite: 1 });
	assert.deepEqual(sanitizePin({ suite: null, keyringSeen: true }), { suite: null, keyringSeen: true });
	for (const bad of [null, {}, { suite: null }, { suite: null, keyringSeen: false }, { suite: 2 }, { suite: "0" }, "0", 0, true, []]) {
		assert.equal(sanitizePin(bad), undefined, JSON.stringify(bad));
	}
	assert.deepEqual(sanitizeCreating({ vaultId: "v" }), { vaultId: "v" });
	assert.equal(sanitizeCreating({ vaultId: "" }), undefined);
	assert.equal(sanitizeCreating("v"), undefined);
});

test("no implicit migration: a stored pairing without e2ee is unpinned", () => {
	const legacy = { identity: { host: "h", vaultId: "v" } } as PinFields;
	assert.equal(pinnedSuite(legacy.e2ee), null);
	assert.equal(keyringSeenOf(legacy.e2ee), false);
	assert.equal(isCreating(legacy, "v"), false);
	assert.equal(refusePinSuite0(legacy, "v", "create"), "not-creating");
	assert.equal(refuseEnableE2ee(legacy, "v"), "not-creating");
});

test("data.json load: a pre-E2EE pairing loads unpinned; a pin needs the identity it belongs to", () => {
	const identity = { host: "https://sync.example.com", vaultId: "vault-1", deviceId: "dev_AAAAAAAAAAAAAAAA", deviceToken: "tok_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", deviceName: "Mac", vaultGeneration: null };
	const legacy = sanitizePluginData({ version: 1, identity, deviceLabel: "Mac" }, "Mac");
	assert.ok(legacy.identity);
	assert.equal(legacy.e2ee, undefined, "no e2ee field: unpinned, nothing inferred from the pairing");
	assert.deepEqual(sanitizePluginData({ identity, e2ee: { suite: 0 } }, "Mac").e2ee, { suite: 0 });
	assert.deepEqual(sanitizePluginData({ identity, e2ee: { suite: null, keyringSeen: true } }, "Mac").e2ee, { suite: null, keyringSeen: true });
	assert.equal(sanitizePluginData({ identity, e2ee: { suite: "0" } }, "Mac").e2ee, undefined, "garbage is unpinned");
	assert.equal(sanitizePluginData({ e2ee: { suite: 1 } }, "Mac").e2ee, undefined, "no identity, no pin");
	assert.deepEqual(sanitizePluginData({ creating: { vaultId: "vault-2" } }, "Mac").creating, { vaultId: "vault-2" }, "the marker precedes the enroll");
});

test("pinSuite0 link: allowed only unpinned and before a k genesis was seen", () => {
	assert.equal(refusePinSuite0(ABSENT, "v", "link"), null);
	assert.equal(refusePinSuite0(SEEN, "v", "link"), "keyring-seen");
	assert.equal(refusePinSuite0(S0, "v", "link"), "already-pinned");
	assert.equal(refusePinSuite0(S1, "v", "link"), "already-pinned");
});

test("pinSuite0 create / enableE2ee: only on the creation path for this vault", () => {
	const creating = markedCreating(ABSENT, "v", null);
	assert.ok(isCreating(creating, "v"));
	assert.equal(isCreating(creating, "w"), false);
	assert.equal(refusePinSuite0(creating, "v", "create"), null);
	assert.equal(refusePinSuite0(creating, "w", "create"), "not-creating");
	assert.equal(refusePinSuite0(ABSENT, "v", "create"), "not-creating");
	assert.equal(refuseEnableE2ee(creating, "v"), null);
	assert.equal(refuseEnableE2ee(ABSENT, "v"), "not-creating");
	assert.equal(refuseEnableE2ee({ ...S1, creating: { vaultId: "v" } }, "v"), "already-pinned");
	assert.equal(markedCreating(S0, "v", "v"), S0, "a pinned device never re-enters creation for its vault");
	assert.deepEqual(markedCreating(S1, "new", "old"), { e2ee: { suite: 1 }, creating: { vaultId: "new" } }, "creating another vault while enrolled elsewhere");
});

test("transitions: pins only from unpinned, drop the creation marker, never lowered", () => {
	const creating = markedCreating(ABSENT, "v", null);
	assert.deepEqual(pinnedSuite0(creating), { e2ee: { suite: 0 } });
	assert.deepEqual(pinnedSuite1(creating), { e2ee: { suite: 1 } });
	assert.deepEqual(pinnedSuite1(SEEN), { e2ee: { suite: 1 } });
	assert.deepEqual(pinnedSuite0(SEEN), { e2ee: { suite: 0 } }, "the transition itself; refusePinSuite0 gates it");
	assert.equal(pinnedSuite0(S1), S1);
	assert.equal(pinnedSuite1(S0), S0);
	assert.equal(pinnedSuite0(S0), S0);
});

test("keyringSeen is sticky and only set while absent", () => {
	assert.deepEqual(sawKeyring(ABSENT), SEEN);
	assert.equal(sawKeyring(SEEN), SEEN);
	assert.equal(sawKeyring(S0), S0);
	assert.equal(sawKeyring(S1), S1);
	assert.equal(refusePinSuite0(sawKeyring(ABSENT), "v", "link"), "keyring-seen");
});

test("leaving the vault drops pin and marker", () => {
	assert.deepEqual(withoutPin({ ...S1, creating: { vaultId: "v" } }), {});
	assert.equal(withoutPin(ABSENT), ABSENT);
});

test("pinAcross: the UI cannot write or lower a pin; another vault drops it; the creation marker survives its enroll", () => {
	const prev: PinFields = { e2ee: { suite: 1 } };
	assert.deepEqual(pinAcross(prev, { e2ee: { suite: 0 } } as PinFields, true, "v"), { e2ee: { suite: 1 } });
	assert.deepEqual(pinAcross(prev, {} as PinFields, true, "v"), { e2ee: { suite: 1 } });
	assert.deepEqual(pinAcross(prev, { e2ee: { suite: 1 } } as PinFields, false, "w"), {});
	assert.deepEqual(pinAcross(ABSENT, { e2ee: { suite: 0 }, creating: { vaultId: "x" } } as PinFields, false, "x"), {}, "the UI cannot forge either field");
	const marked: PinFields = { e2ee: { suite: 1 }, creating: { vaultId: "new" } };
	assert.deepEqual(pinAcross(marked, {} as PinFields, false, "new"), { creating: { vaultId: "new" } }, "§15.1 step 2 enroll into the created vault");
	assert.deepEqual(pinAcross(marked, {} as PinFields, true, "old"), marked);
	assert.deepEqual(pinAcross(marked, {} as PinFields, false, null), { creating: { vaultId: "new" } });
	assert.deepEqual(pinAcross(marked, {} as PinFields, false, "other"), {});
});
