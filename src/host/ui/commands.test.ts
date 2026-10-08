import { test } from "node:test";
import assert from "node:assert/strict";
import { canCreateVault, UI_COMMANDS } from "./commands";
import { defaultPluginData, type EngineRunState, type PairedIdentity, type YaosPluginData } from "./api";
import type { StatusSnapshot } from "../../protocol/status";
import type { BrakeReport } from "../../core/types";
import { testVaultId } from "../keys/testkit/vaultIds";

const IDENTITY: PairedIdentity = { host: "https://h.example", vaultId: testVaultId("v"), deviceId: "dev_AAAAAAAAAAAAAAAA", deviceToken: "t".repeat(43), deviceName: "Mac", vaultGeneration: null };

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
		"yaos-browse-snapshots", "yaos-clean-up-attachments", "yaos-create-snapshot", "yaos-export-diagnostics", "yaos-export-diagnostics-with-paths", "yaos-pair-another-device", "yaos-pair-device", "yaos-pause",
		"yaos-rebuild-local-cache", "yaos-reconcile-now", "yaos-restart-engine", "yaos-resume", "yaos-show-brake",
		"yaos-create-vault", "yaos-finish-creating-vault", "yaos-rekey-after-revoke", "yaos-show-rekey-qr", "yaos-unlock",
		"yaos-device-check", "yaos-device-check-large",
	].sort());
	for (const c of UI_COMMANDS) assert.ok(c.name.length > 0 && c.name[0] === c.name[0]?.toUpperCase());
});

test("command availability follows engine, pause, brake and pairing state; restart stays available when the engine is down", () => {
	assert.deepEqual(available(host({ run: "unpaired" })), ["yaos-create-vault", "yaos-pair-device"]);
	// These paired devices hold no pin and their engine reports no e2ee state: "Create a new vault" is not offered.
	const running = ["yaos-browse-snapshots", "yaos-clean-up-attachments", "yaos-create-snapshot", "yaos-device-check", "yaos-device-check-large", "yaos-export-diagnostics", "yaos-export-diagnostics-with-paths", "yaos-pair-another-device", "yaos-pair-device", "yaos-rebuild-local-cache", "yaos-reconcile-now", "yaos-restart-engine"];
	assert.deepEqual(available(host({ paired: true, phase: "live" })), [...running, "yaos-pause"].sort());
	assert.deepEqual(available(host({ paired: true, phase: "paused" })), [...running, "yaos-resume"].sort());
	const brake: BrakeReport = { id: "b", reason: "listing-shrank", heldCount: 1, syncedCount: 1, samplePaths: [] };
	assert.ok(available(host({ paired: true, phase: "braked", brake })).includes("yaos-show-brake"));
	assert.deepEqual(available(host({ paired: true, run: "failed" })), ["yaos-pair-another-device", "yaos-pair-device", "yaos-restart-engine"]);
	assert.deepEqual(available(host({ paired: true, run: "stopped" })), ["yaos-pair-another-device", "yaos-pair-device", "yaos-restart-engine"]);
});

test("\"Create a new vault\" is offered unpaired, or paired with the vault's pin and key; never on a blocked device (§12.4)", () => {
	const e2ee = (over: Partial<NonNullable<StatusSnapshot["e2ee"]>>): StatusSnapshot["e2ee"] =>
		({ suite: null, sealEpoch: 0, keyMissing: "no-pin", keyringSeen: false, creatable: false, ...over });
	const make = (data: Partial<YaosPluginData>, status: StatusSnapshot["e2ee"] | "none") => {
		const d: YaosPluginData = { ...defaultPluginData("Mac"), identity: IDENTITY, ...data };
		return { data: () => d, status: () => (status === "none" ? null : ({ phase: "live", brake: null, e2ee: status } as unknown as StatusSnapshot)) };
	};
	const cases: [string, ReturnType<typeof make>, boolean][] = [
		["unpaired", { data: () => ({ ...defaultPluginData("Mac"), identity: null }), status: () => null }, true],
		["suite 1 with the key", make({ e2ee: { suite: 1 } }, e2ee({ suite: 1, sealEpoch: 1, keyMissing: null })), true],
		["suite 0", make({ e2ee: { suite: 0 } }, e2ee({ suite: 0, keyMissing: null })), true],
		["no pin", make({}, e2ee({})), false],
		["keyring seen", make({ e2ee: { suite: null, keyringSeen: true } }, e2ee({ keyMissing: "encrypted-vault", keyringSeen: true })), false],
		["suite 1, key lost", make({ e2ee: { suite: 1 } }, e2ee({ suite: 1, sealEpoch: 1, keyMissing: "no-key" })), false],
		["suite 1, revoked epoch", make({ e2ee: { suite: 1 } }, e2ee({ suite: 1, sealEpoch: 2, keyMissing: "revoked-epoch" })), false],
		["suite 1, engine not reporting", make({ e2ee: { suite: 1 } }, "none"), false],
		["suite 1, no e2ee in the status", make({ e2ee: { suite: 1 } }, undefined), false],
		["creating marker, unpinned", make({ creating: { vaultId: IDENTITY.vaultId } }, e2ee({ creatable: true })), false],
		["no pin, engine claims nothing missing", make({}, e2ee({ keyMissing: null })), false],
	];
	for (const [name, h, want] of cases) {
		assert.equal(canCreateVault(h), want, name);
		const spec = UI_COMMANDS.find((c) => c.id === "yaos-create-vault");
		assert.equal(spec?.available({ ...h, runState: () => ({ phase: "running", transport: "worker", lastError: null }), brake: () => null }), want, name);
	}
});

test("encryption commands: finish creating only on the creation path, unlock only when blocked, re-key only with the key", () => {
	const e2ee = (over: Partial<NonNullable<StatusSnapshot["e2ee"]>>): StatusSnapshot["e2ee"] =>
		({ suite: null, sealEpoch: 0, keyMissing: "no-pin", keyringSeen: false, creatable: false, ...over });
	const make = (data: Partial<YaosPluginData>, status: StatusSnapshot["e2ee"]) => {
		const d: YaosPluginData = { ...defaultPluginData("Mac"), identity: IDENTITY, ...data };
		return {
			data: () => d,
			runState: (): EngineRunState => ({ phase: "running", transport: "worker", lastError: null }),
			status: () => ({ phase: "live", brake: null, e2ee: status } as unknown as StatusSnapshot),
			brake: () => null,
		};
	};
	const enc = (h: ReturnType<typeof make>) =>
		available(h as unknown as ReturnType<typeof host>).filter((id) => ["yaos-finish-creating-vault", "yaos-unlock", "yaos-show-rekey-qr", "yaos-rekey-after-revoke"].includes(id));
	assert.deepEqual(enc(make({}, e2ee({}))), ["yaos-unlock"]);
	assert.deepEqual(enc(make({ creating: { vaultId: IDENTITY.vaultId } }, e2ee({ creatable: true }))), ["yaos-finish-creating-vault", "yaos-unlock"]);
	// A marker for another vault, or one under a pin, is not resumable.
	assert.deepEqual(enc(make({ creating: { vaultId: testVaultId("other") } }, e2ee({}))), ["yaos-unlock"]);
	assert.deepEqual(enc(make({ creating: { vaultId: IDENTITY.vaultId }, e2ee: { suite: 1 } }, e2ee({ suite: 1, sealEpoch: 1, keyMissing: null }))), ["yaos-rekey-after-revoke", "yaos-show-rekey-qr"]);
	assert.deepEqual(enc(make({ e2ee: { suite: 1 } }, e2ee({ suite: 1, sealEpoch: 2, keyMissing: "revoked-epoch" }))), ["yaos-unlock"]);
	assert.deepEqual(enc(make({ e2ee: { suite: 0 } }, e2ee({ suite: 0, keyMissing: null }))), []);
});
