import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_ENGINE_SETTINGS, defaultDeviceName, defaultPluginData, MIB, pendingBrake, sameEngineSettings, sameIdentity,
	sanitizePluginData, type PairedIdentity,
} from "./api";
import type { BrakeReport } from "../../core/types";
import type { StatusSnapshot } from "../../protocol/status";
import { BAD_VAULT_IDS, testVaultId } from "../keys/testkit/vaultIds";

const IDENTITY: PairedIdentity = {
	host: "https://sync.example.com",
	vaultId: testVaultId("vaultOne"),
	deviceId: "dev_AAAAAAAAAAAAAAAA",
	deviceToken: "tok_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	deviceName: "Mac",
	vaultGeneration: "gen-7",
};

test("DEFAULT_ENGINE_SETTINGS matches the contract and is frozen", () => {
	assert.deepEqual(DEFAULT_ENGINE_SETTINGS, {
		excludePatterns: [], syncAttachments: true, maxAttachmentBytes: 1024 * MIB, syncSettings: false,
		trashMode: "follow-obsidian", provisionalBroadcast: true,
		snapshots: { enabled: true, keepDaily: 7, uploadToBlobStore: false },
	});
	assert.ok(Object.isFrozen(DEFAULT_ENGINE_SETTINGS));
	assert.ok(Object.isFrozen(DEFAULT_ENGINE_SETTINGS.snapshots));
	assert.ok(Object.isFrozen(DEFAULT_ENGINE_SETTINGS.excludePatterns));
});

test("defaultPluginData", () => {
	assert.deepEqual(defaultPluginData("Mac"), { version: 1, identity: null, deviceLabel: "Mac", engine: DEFAULT_ENGINE_SETTINGS, showStatusBar: true });
	assert.equal(defaultPluginData("   ").deviceLabel, "Device");
});

test("sanitizePluginData: garbage in, defaults out, never throws", () => {
	const hostile = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
	for (const raw of [null, undefined, 0, "x", [], [1, 2], true, hostile, { version: 99 }]) {
		assert.deepEqual(sanitizePluginData(raw, "Mac"), defaultPluginData("Mac"));
	}
});

test("sanitizePluginData: round-trips valid data", () => {
	const data = {
		version: 1 as const,
		identity: IDENTITY,
		deviceLabel: "Work laptop",
		engine: {
			excludePatterns: ["private/**", "*.tmp"], syncAttachments: false, maxAttachmentBytes: 5 * MIB, syncSettings: true,
			trashMode: "system-trash" as const, provisionalBroadcast: false,
			snapshots: { enabled: false, keepDaily: 30, uploadToBlobStore: true },
		},
		showStatusBar: false,
	};
	assert.deepEqual(sanitizePluginData(JSON.parse(JSON.stringify(data)), "Mac"), data);
});

test("sanitizePluginData: partial and invalid fields fall back per field", () => {
	const out = sanitizePluginData({
		identity: { ...IDENTITY, host: "sync.example.com/", vaultGeneration: "" },
		deviceLabel: "  \u0000  ",
		engine: {
			excludePatterns: [" a ", "a", "", 3, "b", "x".repeat(600)],
			syncAttachments: "yes",
			maxAttachmentBytes: -5,
			trashMode: "rm -rf",
			snapshots: { keepDaily: 1000, enabled: false },
		},
		showStatusBar: "no",
	}, "Phone");
	assert.equal(out.identity?.host, "https://sync.example.com");
	assert.equal(out.identity?.vaultGeneration, null);
	assert.equal(out.deviceLabel, "Phone");
	assert.deepEqual(out.engine.excludePatterns, ["a", "b"]);
	assert.equal(out.engine.syncAttachments, true);
	assert.equal(out.engine.maxAttachmentBytes, 1024 * MIB);
	assert.equal(out.engine.trashMode, "follow-obsidian");
	assert.equal(out.engine.snapshots.keepDaily, 7);
	assert.equal(out.engine.snapshots.enabled, false);
	assert.equal(out.showStatusBar, true);
});

test("sanitizePluginData: an identity with any invalid credential field is dropped", () => {
	const broken: Record<string, unknown>[] = [
		{ ...IDENTITY, deviceToken: "short" },
		{ ...IDENTITY, deviceToken: "has spaces in it which are not allowed at all!!" },
		{ ...IDENTITY, deviceId: "x" },
		{ ...IDENTITY, vaultId: "" },
		{ ...IDENTITY, host: "http://sync.example.com" },
		{ ...IDENTITY, host: 5 },
	];
	for (const identity of broken) assert.equal(sanitizePluginData({ identity }, "Mac").identity, null);
});

test("sanitizePluginData: the vaultId is exactly 22-char canonical base64url (server DECISIONS §2.1), never trimmed or repaired", () => {
	assert.equal(sanitizePluginData({ identity: IDENTITY }, "Mac").identity?.vaultId, IDENTITY.vaultId);
	for (const vaultId of BAD_VAULT_IDS) assert.equal(sanitizePluginData({ identity: { ...IDENTITY, vaultId } }, "Mac").identity, null, JSON.stringify(vaultId));
	assert.equal(sanitizePluginData({ identity: { ...IDENTITY, vaultId: 7 } }, "Mac").identity, null);
});

test("sameIdentity / sameEngineSettings", () => {
	assert.equal(sameIdentity(null, null), true);
	assert.equal(sameIdentity(IDENTITY, null), false);
	assert.equal(sameIdentity(IDENTITY, { ...IDENTITY, deviceName: "Renamed" }), true);
	assert.equal(sameIdentity(IDENTITY, { ...IDENTITY, deviceToken: `${IDENTITY.deviceToken}x` }), false);
	assert.equal(sameEngineSettings(DEFAULT_ENGINE_SETTINGS, { ...DEFAULT_ENGINE_SETTINGS, excludePatterns: [] }), true);
	assert.equal(sameEngineSettings(DEFAULT_ENGINE_SETTINGS, { ...DEFAULT_ENGINE_SETTINGS, excludePatterns: ["a"] }), false);
	assert.equal(sameEngineSettings(DEFAULT_ENGINE_SETTINGS, { ...DEFAULT_ENGINE_SETTINGS, snapshots: { ...DEFAULT_ENGINE_SETTINGS.snapshots, keepDaily: 8 } }), false);
});

test("pendingBrake prefers host.brake() then status().brake", () => {
	const a: BrakeReport = { id: "a", reason: "mass-delete-local", heldCount: 1, syncedCount: 2, samplePaths: [] };
	const b: BrakeReport = { ...a, id: "b" };
	const status = { brake: b } as unknown as StatusSnapshot;
	assert.equal(pendingBrake({ brake: () => a, status: () => status }), a);
	assert.equal(pendingBrake({ brake: () => null, status: () => status }), b);
	assert.equal(pendingBrake({ brake: () => null, status: () => null }), null);
});

test("defaultDeviceName (ported)", () => {
	assert.equal(defaultDeviceName({ isIosApp: true, isTablet: true }), "iPad");
	assert.equal(defaultDeviceName({ isIosApp: true }), "iPhone");
	assert.equal(defaultDeviceName({ isAndroidApp: true }), "Android");
	assert.equal(defaultDeviceName({ isMacOS: true }), "Mac");
	assert.equal(defaultDeviceName({}), "Desktop");
});
