import { test } from "node:test";
import assert from "node:assert/strict";
import { RELAY_HTTP_BASE_MS } from "../../core/deadline";
import { MAX_BLOB_UPLOAD_BYTES } from "../../core/limits";
import type { DeviceCheckReport } from "../../protocol/status";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../engineHost";
import { testVaultId } from "../keys/testkit/vaultIds";
import { canRunDeviceCheck, UI_COMMANDS } from "./commands";
import {
	DEVICE_CHECK_FORMAT, deviceCheckDeadlineMs, deviceCheckFileName, formatDeviceCheck, largeCheckConfirm, runDeviceCheck, stepLine, summaryLine,
} from "./deviceCheck";
import { diagnosticsSettings } from "./diagnostics";
import { FakeUiHost, identityFor, RUNNING } from "./testkit/fakeUiHost";

const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function report(over: Partial<DeviceCheckReport> = {}): DeviceCheckReport {
	return {
		mode: "quick", clientVersion: "1.0.0", startedAtMs: Date.UTC(2026, 9, 8, 12, 0, 0), totalMs: 14_230,
		steps: [
			{ id: "engine", name: "Engine basics", status: "pass", ms: 0.4, detail: "background worker", error: null, data: { carrier: "worker" } },
			{ id: "blob-10mb", name: "Blob round trip 10 MB", status: "fail", ms: 12_040, detail: "the upload sent no progress event", error: null, data: { uploadProgressEvents: 0 } },
			{ id: "seal-10mb", name: "Seal and open 10 MB (AES-GCM)", status: "skip", ms: 0, detail: "not encrypted", error: null, data: {} },
		],
		notes: ["The test blobs belong to no file."],
		...over,
	};
}

test("the saved report is redacted JSON: no device token from the identity, any secret-looking key redacted at any depth", () => {
	const host = new FakeUiHost({ identity: { ...identityFor(testVaultId("v")), deviceToken: TOKEN } });
	const leaky = report({ steps: [{ id: "x", name: "X", status: "pass", ms: 1, detail: "d", error: null, data: { deviceToken: TOKEN, relayCredential: TOKEN, ticket: "t1", rttMs: 12 } }] });
	const text = formatDeviceCheck(leaky, diagnosticsSettings(host, false));
	assert.ok(!text.includes(TOKEN), "no token");
	assert.ok(!text.includes("t1"), "no ticket");
	const parsed = JSON.parse(text) as { format: string; report: DeviceCheckReport; settings: Record<string, unknown> };
	assert.equal(parsed.format, DEVICE_CHECK_FORMAT);
	assert.deepEqual(parsed.report.steps[0]!.data, { deviceToken: "[redacted]", relayCredential: "[redacted]", rttMs: 12, ticket: "[redacted]" });
	assert.equal(parsed.settings.vaultId, testVaultId("v"));
	assert.equal(parsed.settings.deviceToken, undefined);
});

test("runDeviceCheck asks the host's engine for the mode and names the file by mode and time", async () => {
	const host = new FakeUiHost({ identity: identityFor(testVaultId("v")) });
	host.deviceCheckHandler = async (mode) => report({ mode });
	const quick = await runDeviceCheck(host, "quick");
	assert.equal(quick.fileName, "yaos-device-check-2026-10-08T12-00-00-000Z.json");
	const large = await runDeviceCheck(host, "large");
	assert.equal(large.fileName, "yaos-large-attachment-check-2026-10-08T12-00-00-000Z.json");
	assert.deepEqual(host.calls, ["deviceCheck:quick", "deviceCheck:large"]);
	assert.ok(!large.text.includes(identityFor(testVaultId("v")).deviceToken));
	host.deviceCheckHandler = async () => { throw new Error("YAOS is not running."); };
	await assert.rejects(runDeviceCheck(host, "quick"), /YAOS is not running/);
	assert.equal(deviceCheckFileName(Number.NaN, "quick"), "yaos-device-check-1970-01-01T00-00-00-000Z.json");
});

test("the request deadline scales with the bytes moved, both ways, and is never the 60 s default", () => {
	const quick = deviceCheckDeadlineMs("quick", null);
	assert.ok(quick > DEFAULT_REQUEST_TIMEOUT_MS * 5, `${quick}`);
	assert.equal(deviceCheckDeadlineMs("quick", 5), quick, "the quick sizes are fixed");
	const max = deviceCheckDeadlineMs("large", 99_000_000);
	assert.ok(max > quick * 5, `${max}`);
	assert.equal(deviceCheckDeadlineMs("large", null), deviceCheckDeadlineMs("large", MAX_BLOB_UPLOAD_BYTES));
	assert.ok(deviceCheckDeadlineMs("large", 0) >= RELAY_HTTP_BASE_MS + 60_000);
});

test("one line per step and a summary; the large check's confirm names the size and the risks", () => {
	const r = report();
	assert.deepEqual(r.steps.map(stepLine), [
		"✓ Engine basics · 0 ms · background worker",
		"✗ Blob round trip 10 MB · 12 s · the upload sent no progress event",
		"– Seal and open 10 MB (AES-GCM) · 0 ms · not encrypted",
	]);
	assert.equal(summaryLine(r), "1 of 2 checks failed, 1 skipped (14.2 s).");
	assert.equal(summaryLine(report({ steps: [r.steps[0]!] })), "All 1 checks passed (14.2 s).");
	const c = largeCheckConfirm(99_999_800);
	assert.match(c.message, /a 100 MB test file/);
	assert.match(c.message, /300 MB of memory/);
	assert.match(c.message, /YAOS stopped.*Restart sync engine/);
	assert.match(largeCheckConfirm(null).message, /the largest size this server takes/);
});

test("both device check commands are offered only on a paired device whose engine runs", () => {
	const ids = UI_COMMANDS.filter((c) => c.id.startsWith("yaos-device-check")).map((c) => [c.id, c.name]);
	assert.deepEqual(ids, [["yaos-device-check", "Run device check"], ["yaos-device-check-large", "Run large attachment check (max size)"]]);
	const paired = new FakeUiHost({ identity: identityFor(testVaultId("v")) });
	assert.equal(canRunDeviceCheck(paired), true);
	for (const phase of ["stopped", "starting", "failed"] as const) {
		paired.run = { ...RUNNING, phase };
		assert.equal(canRunDeviceCheck(paired), false, phase);
	}
	const unpaired = new FakeUiHost();
	assert.equal(canRunDeviceCheck(unpaired), false, "running but unpaired");
});
