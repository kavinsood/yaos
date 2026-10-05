import { test } from "node:test";
import assert from "node:assert/strict";
import { UI_COMMANDS } from "./commands";
import { defaultPluginData, type EngineRunState, type PairedIdentity, type YaosPluginData } from "./api";
import type { StatusSnapshot } from "../../protocol/status";
import type { BrakeReport } from "../../core/types";

const IDENTITY: PairedIdentity = { host: "https://h.example", vaultId: "v", deviceId: "dev_AAAAAAAAAAAAAAAA", deviceToken: "t".repeat(43), deviceName: "Mac", vaultGeneration: null };

function host(opts: { run?: EngineRunState["phase"]; phase?: StatusSnapshot["phase"]; brake?: BrakeReport | null; paired?: boolean }) {
	const data: YaosPluginData = { ...defaultPluginData("Mac"), identity: opts.paired ? IDENTITY : null };
	return {
		data: () => data,
		runState: (): EngineRunState => ({ phase: opts.run ?? "running", transport: "worker", lastError: null }),
		status: () => (opts.phase ? ({ phase: opts.phase, brake: null } as unknown as StatusSnapshot) : null),
		brake: () => opts.brake ?? null,
	};
}

const available = (h: ReturnType<typeof host>) => UI_COMMANDS.filter((c) => c.available(h)).map((c) => c.id).sort();

test("command ids match the contract", () => {
	assert.deepEqual(UI_COMMANDS.map((c) => c.id).sort(), [
		"yaos-export-diagnostics", "yaos-pair-another-device", "yaos-pair-device", "yaos-pause", "yaos-reconcile-now", "yaos-resume", "yaos-show-brake",
	]);
	for (const c of UI_COMMANDS) assert.ok(c.name.length > 0 && c.name[0] === c.name[0]?.toUpperCase());
});

test("command availability follows engine, pause, brake and pairing state", () => {
	assert.deepEqual(available(host({ run: "unpaired" })), ["yaos-pair-device"]);
	assert.deepEqual(available(host({ paired: true, phase: "live" })), ["yaos-export-diagnostics", "yaos-pair-another-device", "yaos-pair-device", "yaos-pause", "yaos-reconcile-now"]);
	assert.deepEqual(available(host({ paired: true, phase: "paused" })), ["yaos-export-diagnostics", "yaos-pair-another-device", "yaos-pair-device", "yaos-reconcile-now", "yaos-resume"]);
	const brake: BrakeReport = { id: "b", reason: "listing-shrank", heldCount: 1, syncedCount: 1, samplePaths: [] };
	assert.ok(available(host({ paired: true, phase: "braked", brake })).includes("yaos-show-brake"));
	assert.deepEqual(available(host({ paired: true, run: "failed" })), ["yaos-pair-another-device", "yaos-pair-device"]);
});
