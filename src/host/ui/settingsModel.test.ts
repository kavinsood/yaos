import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyControl, ATTACHMENT_SIZE_DESC, attachmentLimitMb, attachmentSizeDesc, CONTROL_KEYS, connectionRows, enableSettingsSync, engineAcceptsCommands,
	engineRows, isControlKey, isPaused, parseExcludePatterns, phaseLabel, readControl, runStateLabel, serverConsoleUrl, TRASH_MODE_OPTIONS, validateControl,
} from "./settingsModel";
import { defaultPluginData, MAX_ATTACHMENT_BYTES_LIMIT, MIB, sanitizePluginData, TRASH_MODES, type PairedIdentity } from "./api";
import type { EnginePhase, StatusSnapshot } from "../../protocol/status";
import { testVaultId } from "../keys/testkit/vaultIds";

const TOKEN = "tok_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const IDENTITY: PairedIdentity = {
	host: "https://sync.example.com", vaultId: testVaultId("vaultOne"), deviceId: "dev_AAAAAAAAAAAAAAAA", deviceToken: TOKEN, deviceName: "Mac", vaultGeneration: null,
};

test("every control key reads back what it writes, through the sanitizer", () => {
	const base = defaultPluginData("Mac");
	const values: Record<(typeof CONTROL_KEYS)[number], unknown> = {
		deviceLabel: "Work laptop",
		excludePatterns: "private/**\n\n  *.tmp  \nprivate/**",
		syncAttachments: false,
		maxAttachmentMb: 200,
		syncSettings: true,
		trashMode: "system-trash",
		provisionalBroadcast: false,
		snapshotsEnabled: false,
		snapshotsKeepDaily: 30,
		snapshotsUpload: true,
		showStatusBar: false,
	};
	let data = base;
	for (const key of CONTROL_KEYS) data = applyControl(data, key, values[key]);
	const round = sanitizePluginData(JSON.parse(JSON.stringify(data)), "Mac");
	assert.deepEqual(round, data);
	assert.equal(readControl(round, "excludePatterns"), "private/**\n*.tmp");
	assert.equal(round.engine.maxAttachmentBytes, 200 * MIB);
	for (const key of CONTROL_KEYS) if (key !== "excludePatterns") assert.equal(readControl(round, key), values[key], key);
	// The default data object is never mutated.
	assert.deepEqual(base, defaultPluginData("Mac"));
});

test("applyControl returns the same object when nothing changes", () => {
	const d = defaultPluginData("Mac");
	assert.equal(applyControl(d, "syncAttachments", true), d);
	assert.equal(applyControl(d, "deviceLabel", "  Mac "), d);
	assert.equal(applyControl(d, "excludePatterns", "\n\n"), d);
	assert.equal(applyControl(d, "maxAttachmentMb", 1024), d);
	assert.equal(applyControl(d, "maxAttachmentMb", 95, 95), d, "the default shows as the server's limit");
});

test("attachment size: the default follows the server's limit; the control only lowers it and never shows more", () => {
	const d = defaultPluginData("Mac");
	assert.equal(d.engine.maxAttachmentBytes, MAX_ATTACHMENT_BYTES_LIMIT, "default: min(setting, server) = the server's");
	// Until a vault reports its limit: the least any relay takes (100 MB PUT cap, sealed under suite 1: 98,566,143 bytes).
	assert.equal(attachmentLimitMb(null), 93);
	assert.equal(attachmentLimitMb(snap("starting")), 93);
	assert.equal(attachmentLimitMb(snap("live", { maxBlobBytes: 0 })), 93, "no blob store: no limit to name");
	assert.equal(attachmentLimitMb(snap("live", { maxBlobBytes: 100_000_000 })), 95, "suite 0: the relay's cap, rounded down");
	assert.equal(attachmentLimitMb(snap("live", { maxBlobBytes: 98_566_143 })), 93);
	assert.equal(attachmentLimitMb(snap("live", { maxBlobBytes: 5 * 1024 * MIB })), 1024, "the setting's own ceiling");
	assert.equal(attachmentLimitMb(snap("live", { maxBlobBytes: 1000 })), 1, "whole MB, at least 1");
	assert.equal(readControl(d, "maxAttachmentMb", 95), 95);
	assert.match(validateControl("maxAttachmentMb", 96, 95) ?? "", /from 1 to 95/);
	assert.throws(() => applyControl(d, "maxAttachmentMb", 96, 95), RangeError);
	const lowered = applyControl(d, "maxAttachmentMb", 40, 95);
	assert.equal(lowered.engine.maxAttachmentBytes, 40 * MIB);
	assert.equal(readControl(lowered, "maxAttachmentMb", 30), 30, "a lower server limit is what shows");
	assert.equal(applyControl(lowered, "maxAttachmentMb", 95, 95).engine.maxAttachmentBytes, MAX_ATTACHMENT_BYTES_LIMIT, "the maximum follows the server again");
});

test("validation rejects bad values with readable messages and applyControl throws", () => {
	const bad: [(typeof CONTROL_KEYS)[number], unknown][] = [
		["deviceLabel", "   "], ["deviceLabel", "x".repeat(65)], ["deviceLabel", 5],
		["excludePatterns", Array.from({ length: 501 }, (_, i) => `p${i}`).join("\n")], ["excludePatterns", "y".repeat(513)],
		["maxAttachmentMb", 0], ["maxAttachmentMb", 1025], ["maxAttachmentMb", 2.5], ["maxAttachmentMb", Number.NaN], ["maxAttachmentMb", "5"],
		["snapshotsKeepDaily", 0], ["snapshotsKeepDaily", 91],
		["trashMode", "rm"], ["syncAttachments", "yes"], ["snapshotsUpload", 1],
	];
	const d = defaultPluginData("Mac");
	for (const [key, value] of bad) {
		const msg = validateControl(key, value);
		assert.ok(msg && msg.length > 5, `${key}=${String(value)}`);
		assert.throws(() => applyControl(d, key, value), RangeError);
	}
	assert.equal(validateControl("maxAttachmentMb", 1024), null);
	assert.equal(validateControl("snapshotsKeepDaily", 90), null);
});

test("trashMode: follow-obsidian is the default and listed first; every mode validates, applies and survives the sanitizer", () => {
	assert.deepEqual(Object.keys(TRASH_MODE_OPTIONS), [...TRASH_MODES]);
	assert.equal(TRASH_MODES[0], "follow-obsidian");
	assert.match(TRASH_MODE_OPTIONS["follow-obsidian"], /Files and links → Deleted files/);
	assert.equal(defaultPluginData("Mac").engine.trashMode, "follow-obsidian");
	for (const mode of TRASH_MODES) {
		assert.equal(validateControl("trashMode", mode), null, mode);
		const d = applyControl(defaultPluginData("Mac"), "trashMode", mode);
		assert.equal(readControl(d, "trashMode"), mode);
		assert.equal(sanitizePluginData(JSON.parse(JSON.stringify(d)), "Mac").engine.trashMode, mode);
	}
});

test("enableSettingsSync turns settings sync on with the seed answer, which survives the sanitizer; turning it off keeps the rest", () => {
	const base = defaultPluginData("Mac");
	assert.equal(base.engine.syncSettingsSeed, undefined);
	for (const seed of ["device", "vault"] as const) {
		const on = enableSettingsSync(base, seed);
		assert.equal(on.engine.syncSettings, true);
		assert.equal(on.engine.syncSettingsSeed, seed);
		assert.deepEqual(sanitizePluginData(JSON.parse(JSON.stringify(on)), "Mac"), on);
		assert.equal(applyControl(on, "syncSettings", false).engine.syncSettings, false);
	}
	const junk = sanitizePluginData({ ...base, engine: { ...base.engine, syncSettingsSeed: "mine" } }, "Mac");
	assert.equal(junk.engine.syncSettingsSeed, undefined);
	assert.deepEqual(base, defaultPluginData("Mac"));
});

test("isControlKey and parseExcludePatterns", () => {
	assert.equal(isControlKey("trashMode"), true);
	assert.equal(isControlKey("deviceToken"), false);
	assert.deepEqual(parseExcludePatterns("a\r\nb\n a \n\n"), ["a", "b"]);
});

test("connectionRows mask the device token and never show it", () => {
	const rows = connectionRows(IDENTITY);
	const text = JSON.stringify(rows);
	assert.ok(!text.includes(TOKEN));
	assert.ok(!text.includes(TOKEN.slice(-4)));
	assert.deepEqual(rows.map((r) => r.name), ["Server", "Vault ID", "Device name", "Device token"]);
	assert.equal(rows[3]?.value, "••••••••••••");
	assert.equal(connectionRows(null).length, 1);
});

test("serverConsoleUrl: the stored host's origin over http(s), else null", () => {
	assert.equal(serverConsoleUrl(IDENTITY), "https://sync.example.com/");
	assert.equal(serverConsoleUrl({ ...IDENTITY, host: "https://sync.example.com/sub/path?q=1#frag" }), "https://sync.example.com/");
	assert.equal(serverConsoleUrl({ ...IDENTITY, host: "http://127.0.0.1:8787" }), "http://127.0.0.1:8787/");
	for (const host of ["javascript:alert(1)", "file:///etc/passwd", "obsidian://yaos", "not a url", "", "https://user:pw@sync.example.com"]) {
		assert.equal(serverConsoleUrl({ ...IDENTITY, host }), null, host);
	}
	assert.equal(serverConsoleUrl(null), null);
});

function snap(phase: EnginePhase, over: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		phase, deviceClass: "desktop", transport: "worker", vaultEpoch: "e", vaultSeq: 1, headSeq: 1,
		relay: { connected: true, lastCloseCode: null, reconnectInMs: null, rttMs: 30 },
		counts: {
			liveDocs: 0, staleStreams: 0, outboxFrames: 2, outboxBytes: 0, unreceiptedFrames: 1, residentDocs: 0, residentBytesEstimate: 0,
			pendingDiskOps: 0, pendingBlobs: 0, quarantinedRows: 1, frozenDocs: 0, conflictCopiesToday: 0,
		},
		bootstrap: null, brake: null, lastFullReconcileAtMs: null, lastSyncedAtMs: null, dailyFramesUsed: 0, maxBlobBytes: null, notices: [],
		...over,
	};
}

test("engine rows and labels", () => {
	const running = { phase: "running", transport: "worker", lastError: null } as const;
	assert.deepEqual(engineRows({ phase: "unpaired", transport: null, lastError: null }, null, 0), [{ name: "Engine", value: "Not paired" }]);
	assert.match(runStateLabel({ phase: "failed", transport: null, lastError: "boom" }), /boom/);
	assert.match(runStateLabel({ ...running, transport: "inline" }), /main thread/);
	const rows = engineRows(running, snap("live", { lastSyncedAtMs: 0 }), 120_000);
	const byName = Object.fromEntries(rows.map((r) => [r.name, r.value]));
	assert.equal(byName["Phase"], "Live");
	assert.equal(byName["Server connection"], "Connected (30 ms round trip)");
	assert.equal(byName["Unsynced changes"], "3 changes");
	assert.equal(byName["Last synced"], "2 min ago");
	assert.match(byName["Needs attention"] ?? "", /1 quarantined change/);
	const off = engineRows(running, snap("offline", { relay: { connected: false, lastCloseCode: 1006, reconnectInMs: 5000, rttMs: null } }), 0);
	assert.ok(off.some((r) => r.value === "Disconnected, retrying in 5 s"));
	const phases: EnginePhase[] = ["starting", "recovering", "bootstrapping", "catching-up", "live", "offline", "paused", "braked", "daily-limit", "superseded", "revoked", "epoch-migrating", "upgrade-required", "error"];
	assert.equal(new Set(phases.map(phaseLabel)).size, phases.length);
	assert.equal(engineAcceptsCommands(running), true);
	assert.equal(engineAcceptsCommands({ phase: "stopped", transport: null, lastError: null }), false);
	assert.equal(isPaused(snap("paused")), true);
	assert.equal(isPaused(null), false);
});

test("attachment size description names the open carrier's limit when the status has it, rounded down", () => {
	assert.equal(attachmentSizeDesc(null), ATTACHMENT_SIZE_DESC);
	assert.equal(attachmentSizeDesc(snap("starting")), ATTACHMENT_SIZE_DESC, "no vault open yet");
	const tail = ".";
	assert.equal(attachmentSizeDesc(snap("live", { maxBlobBytes: 10 * MIB })), `${ATTACHMENT_SIZE_DESC} This server accepts attachments up to 10 MB${tail}`);
	for (const [bytes, size] of [[8 * MIB, "8 MB"], [1.5 * MIB, "1.5 MB"], [10 * MIB + 1, "10 MB"], [1.99 * MIB, "1.9 MB"], [512 * 1024, "512 KB"], [10, "1 KB"]] as const) {
		assert.equal(attachmentSizeDesc(snap("live", { maxBlobBytes: bytes })), `${ATTACHMENT_SIZE_DESC} This server accepts attachments up to ${size}${tail}`);
	}
	for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(attachmentSizeDesc(snap("live", { maxBlobBytes: bad })), ATTACHMENT_SIZE_DESC);
});
