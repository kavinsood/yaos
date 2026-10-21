/** localSettings.ts (identity-per-store §8): the per-install plugin fields in App.saveLocalStorage, and their migration. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { InstallStorage } from "./installRecord";
import {
	hasLegacyLocalFields, loadLocalSettings, LOCAL_SETTINGS_KEY, localPart, markCloneNoticeShown, sameLocalFields, sanitizeLocalSettings,
	saveLocalFields, withLocal,
} from "./localSettings";
import { testVaultId } from "./keys/testkit/vaultIds";
import { defaultPluginData, storedPart } from "./ui/api";
import { prepareEnrollment } from "./ui/pairing";

const V = testVaultId("v");
const ATTEMPT = prepareEnrollment({ host: "https://sync.example.com", pairingCode: "pc_ABCDEFGHIJKLMNOPQRSTUVWX", deviceName: "Mac" });

function memStorage(initial?: unknown): InstallStorage & { m: Map<string, unknown>; saves: number } {
	const m = new Map<string, unknown>();
	if (initial !== undefined) m.set(LOCAL_SETTINGS_KEY, initial);
	const s = { m, saves: 0, load: (k: string) => m.get(k), save: (k: string, v: unknown) => void (s.saves++, m.set(k, structuredClone(v))) };
	return s;
}

test("sanitize: garbage in, defaults out; each field checked with the data.json sanitizers", () => {
	for (const raw of [null, undefined, 0, "x", [], true, { v: 9 }]) {
		assert.deepEqual(sanitizeLocalSettings(raw, "Mac"), { v: 1, deviceLabel: "Mac", showStatusBar: true });
	}
	assert.deepEqual(sanitizeLocalSettings({ deviceLabel: "  Work\u0000 laptop ", showStatusBar: false, creating: { vaultId: V }, pendingEnrollment: ATTEMPT, cloneNoticeShown: true }, "Mac"),
		{ v: 1, deviceLabel: "Work laptop", showStatusBar: false, pendingEnrollment: ATTEMPT, creating: { vaultId: V }, cloneNoticeShown: true });
	const bad = sanitizeLocalSettings({ deviceLabel: "   ", showStatusBar: "no", creating: { vaultId: "x" }, pendingEnrollment: { ...ATTEMPT, grantSecret: "short" }, cloneNoticeShown: 1 }, "  ");
	assert.deepEqual(bad, { v: 1, deviceLabel: "Device", showStatusBar: true });
});

test("migration: the label and the status bar flag move once from an older data.json; creating and pendingEnrollment do not", () => {
	const legacy = { version: 1, deviceLabel: "Old Mac", showStatusBar: false, creating: { vaultId: V }, pendingEnrollment: ATTEMPT };
	const s = memStorage();
	const rec = loadLocalSettings(s, legacy, "Mac");
	assert.deepEqual(rec, { v: 1, deviceLabel: "Old Mac", showStatusBar: false }, "a twin's marker or attempt is never taken");
	assert.deepEqual(s.m.get(LOCAL_SETTINGS_KEY), rec, "saved");
	assert.equal(s.saves, 1);
	// Once: the record has them now, and wins over data.json (e.g. a twin's later write).
	saveLocalFields(s, { ...localPart(rec), deviceLabel: "Mine" });
	assert.equal(loadLocalSettings(s, { deviceLabel: "Twin", showStatusBar: true }, "Mac").deviceLabel, "Mine");
	assert.equal(loadLocalSettings(s, { deviceLabel: "Twin", showStatusBar: true }, "Mac").showStatusBar, false);
	const saves = s.saves;
	loadLocalSettings(s, null, "Mac");
	assert.equal(s.saves, saves, "an unchanged record is not rewritten");
	// Nothing anywhere: the platform default.
	assert.deepEqual(loadLocalSettings(memStorage(), null, "iPhone"), { v: 1, deviceLabel: "iPhone", showStatusBar: true });
	// A record that lacks only one field takes just that one.
	assert.deepEqual(loadLocalSettings(memStorage({ v: 1, deviceLabel: "Kept" }), legacy, "Mac"), { v: 1, deviceLabel: "Kept", showStatusBar: false });
});

test("a storage that throws on load is an empty record", () => {
	const s: InstallStorage = { load: () => { throw new Error("denied"); }, save: () => undefined };
	assert.deepEqual(loadLocalSettings(s, { deviceLabel: "Old" }, "Mac"), { v: 1, deviceLabel: "Old", showStatusBar: true });
});

test("saveLocalFields: writes the four fields, keeps the clone flag, drops a removed field, skips no-ops", () => {
	const s = memStorage({ v: 1, deviceLabel: "A", showStatusBar: true, cloneNoticeShown: true });
	saveLocalFields(s, { deviceLabel: "A", showStatusBar: true, pendingEnrollment: ATTEMPT, creating: { vaultId: V } });
	assert.deepEqual(s.m.get(LOCAL_SETTINGS_KEY), { v: 1, deviceLabel: "A", showStatusBar: true, pendingEnrollment: ATTEMPT, creating: { vaultId: V }, cloneNoticeShown: true });
	saveLocalFields(s, { deviceLabel: "A", showStatusBar: true });
	assert.deepEqual(s.m.get(LOCAL_SETTINGS_KEY), { v: 1, deviceLabel: "A", showStatusBar: true, cloneNoticeShown: true });
	const saves = s.saves;
	saveLocalFields(s, { deviceLabel: "A", showStatusBar: true });
	assert.equal(s.saves, saves);
});

test("markCloneNoticeShown: true once, then false; the other fields are kept", () => {
	const s = memStorage({ v: 1, deviceLabel: "A", showStatusBar: false });
	assert.equal(markCloneNoticeShown(s, "Mac"), true);
	assert.equal(markCloneNoticeShown(s, "Mac"), false);
	assert.deepEqual(s.m.get(LOCAL_SETTINGS_KEY), { v: 1, deviceLabel: "A", showStatusBar: false, cloneNoticeShown: true });
});

test("withLocal / localPart / storedPart: the view splits into data.json's part and the record's, and back", () => {
	const view = { ...defaultPluginData("Mac"), showStatusBar: false, creating: { vaultId: V }, pendingEnrollment: ATTEMPT };
	assert.deepEqual(withLocal(storedPart(view), localPart(view)), view);
	assert.deepEqual(Object.keys(localPart(view)).sort(), ["creating", "deviceLabel", "pendingEnrollment", "showStatusBar"]);
	// The view's own per-install fields never leak through the stored half.
	assert.deepEqual(withLocal(view, { deviceLabel: "B", showStatusBar: true }), { ...defaultPluginData("B") });
	assert.ok(sameLocalFields(view, { ...view }));
	assert.ok(!sameLocalFields(view, { ...view, deviceLabel: "B" }));
});

test("hasLegacyLocalFields: an older data.json is rewritten once", () => {
	assert.equal(hasLegacyLocalFields({ version: 1, identity: null, engine: {} }), false);
	assert.equal(hasLegacyLocalFields(null), false);
	for (const k of ["deviceLabel", "showStatusBar", "creating", "pendingEnrollment"]) assert.equal(hasLegacyLocalFields({ [k]: null }), true, k);
});
