/**
 * The device check's engine side (src/engine/compose/deviceCheck.ts) through the worker carrier, against a live relay.
 * Per vault, one full client whose engine runs on a worker thread as in the plugin (FullClient carrier "worker":
 * fullWorker.ts runs createEngine over createWorkerEngineTransport with the production ports), driven by the plugin
 * controller (YaosController): the vault is created as "Create a new vault" does (pinSuite0 "create" for plain,
 * enableE2ee for E2EE), then each check goes through YaosController.deviceCheck, the `deviceCheck` request with its
 * size-scaled deadline, exactly as the two commands send it.
 *
 * Checks per vault and mode: every step passes (the seal step is skipped on the plain vault); the carrier is the
 * worker; every test upload had progress events and every download chunks; the large check ran at the engine's
 * status maxBlobBytes; the redacted report (src/host/ui/deviceCheck.ts formatDeviceCheck, what Copy / Save write)
 * holds neither the device token nor the vault key.
 *
 *   node --import jiti/register e2e/client/deviceCheck.ts --host URL --label L [--vault plain|e2ee|both] [--mode quick|both]
 *
 * Writes LOG_DIR/client-e2e-device-check-<label>-<stamp>.json (no secrets: the steps' measurements only).
 */
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { bytesToHex } from "../../src/core/codec/lib0";
import { makeRecoveryKey } from "../../src/core/codec/recoveryKey";
import { VaultKeyStore } from "../../src/host/keys/secretStore";
import { YaosController } from "../../src/host/pluginController";
import { DEFAULT_ENGINE_SETTINGS, defaultPluginData, type PairedIdentity, type YaosPluginData } from "../../src/host/ui/api";
import { formatDeviceCheck, stepLine, summaryLine } from "../../src/host/ui/deviceCheck";
import { diagnosticsSettings } from "../../src/host/ui/diagnostics";
import type { DeviceCheckMode, DeviceCheckReport, StatusSnapshot } from "../../src/protocol/status";
import { Report } from "./engineKit";
import { waitFor } from "./fullCheck";
import { FullClient } from "./fullKit";
import { DEFAULT_LOG_DIR, onboardVault, type OnboardedVault } from "./onboard";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", "http://127.0.0.1:8809").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const VAULT_ARG = arg("vault", "both");
const MODE_ARG = arg("mode", "both");

type VaultKind = "plain" | "e2ee";

const lastStatus = (c: FullClient): StatusSnapshot | undefined => c.ui.statuses.at(-1);

/** The plugin controller over a client (e2ee.ts): main's real pin, key and request flow; this device creates the vault. */
function controllerFor(client: FullClient, identity: PairedIdentity): YaosController {
	const data: YaosPluginData = { ...defaultPluginData(client.name), identity, engine: DEFAULT_ENGINE_SETTINGS, creating: { vaultId: identity.vaultId } };
	return new YaosController(data, {
		makeRuntime: (id, settings, ui, keys) => client.runtimeFor(id, settings, ui, keys),
		saveData: async () => {},
		notice: () => {},
		log: (l) => client.log(`main: ${l}`),
		clock: client.clock,
		secrets: client.secrets,
	});
}

/** Hex and base64url of the vault's stored keys (a fresh copy each, zeroed after): strings the report must not contain. */
function keyStrings(client: FullClient, vaultId: string): string[] {
	const out: string[] = [];
	for (const key of new VaultKeyStore(client.secrets, vaultId, client.clock).load()?.keys ?? []) {
		out.push(bytesToHex(key.k), Buffer.from(key.k).toString("base64url"));
		key.k.fill(0);
	}
	return out;
}

function stepsOf(r: DeviceCheckReport) {
	return r.steps.map((s) => ({ id: s.id, status: s.status, ms: s.ms, detail: s.detail, error: s.error, data: s.data }));
}

async function runVault(R: Report, kind: VaultKind, modes: readonly DeviceCheckMode[], vaults: OnboardedVault[]): Promise<void> {
	R.step(`device check, ${kind === "e2ee" ? "E2EE vault (suite 1)" : "plain vault (suite 0)"}`);
	const vault = await onboardVault(HOST, { devices: 1, label: `device-check-${kind}-${LABEL}` });
	vaults.push(vault);
	const d = vault.devices[0]!;
	const a = new FullClient({ name: "a", host: HOST, vaultId: vault.vaultId, device: d, watcherDelayMs: 100, carrier: "worker" });
	const ctl = controllerFor(a, { host: HOST, vaultId: vault.vaultId, deviceId: d.deviceId, deviceToken: d.deviceToken, deviceName: "a", vaultGeneration: vault.vaultGeneration });
	const x: Record<string, unknown> = {};
	R.extra[kind] = x;
	try {
		await a.thread!.ready;
		await ctl.start();
		await waitFor(() => lastStatus(a)?.e2ee?.creatable === true, "a creatable", 30_000, performance.now(), 50);
		const pinned = kind === "e2ee"
			? await ctl.command({ t: "enableE2ee", rk: makeRecoveryKey(new Uint8Array(nodeRandomBytes(32))) })
			: await ctl.command({ t: "pinSuite0", source: "create" });
		if (pinned.t !== "ok") throw new Error(`pin on a: ${pinned.t}`);
		const suite = kind === "e2ee" ? 1 : 0;
		await waitFor(() => {
			const s = lastStatus(a);
			return s?.phase === "live" && s.e2ee?.suite === suite && s.e2ee.keyMissing === null && s.maxBlobBytes !== null;
		}, `a live on suite ${suite}`, 60_000, performance.now(), 50);
		const secrets = [d.deviceToken, ...keyStrings(a, vault.vaultId)];
		R.check(`${kind}: setup, a runs its engine on the worker carrier`, ctl.runState().transport === "worker", ctl.runState());
		for (const mode of modes) {
			const t0 = performance.now();
			const report = await ctl.deviceCheck(mode);
			const wallMs = Math.round(performance.now() - t0);
			const text = formatDeviceCheck(report, diagnosticsSettings({ data: () => ctl.data(), pluginVersion: "e2e", runState: () => ctl.runState() }, false));
			console.log(`-- ${kind} ${mode}: ${summaryLine(report)} (request ${wallMs} ms)`);
			for (const s of report.steps) console.log(`   ${stepLine(s)}`);
			for (const n of report.notes) console.log(`   note: ${n}`);
			x[mode] = { wallMs, totalMs: report.totalMs, steps: stepsOf(report), notes: report.notes };
			const bad = report.steps.filter((s) => s.status !== (s.id.startsWith("seal-") && kind === "plain" ? "skip" : "pass"));
			R.check(`${kind} ${mode}: every step passes${kind === "plain" ? " (seal skipped: suite 0)" : ""}`, bad.length === 0, bad.map((s) => ({ id: s.id, status: s.status, detail: s.detail })));
			R.check(`${kind} ${mode}: engine step reports the worker carrier`, report.steps[0]?.id === "engine" && report.steps[0].data.carrier === "worker", report.steps[0]?.data ?? null);
			const blobs = report.steps.filter((s) => s.id.startsWith("blob-"));
			R.check(`${kind} ${mode}: every test upload had progress events and every download chunks`,
				blobs.length === (mode === "quick" ? 2 : 1) && blobs.every((s) => (s.data.uploadProgressEvents as number) > 0 && (s.data.downloadChunks as number) > 0),
				blobs.map((s) => ({ id: s.id, uploadProgressEvents: s.data.uploadProgressEvents, downloadChunks: s.data.downloadChunks })));
			if (mode === "large") {
				const max = lastStatus(a)?.maxBlobBytes ?? null;
				R.check(`${kind} large: the round trip ran at the engine's maxBlobBytes (status)`, blobs[0]?.data.bytes === max && (max ?? 0) > 0, { bytes: blobs[0]?.data.bytes ?? null, statusMaxBlobBytes: max });
			}
			const leaked = secrets.filter((s) => s.length > 0 && text.includes(s)).length;
			R.check(`${kind} ${mode}: the saved report holds no device token or vault key`, leaked === 0, { leaked });
		}
	} finally {
		try { await ctl.stop(); } catch { /* best effort */ }
		try { await a.stop(); } catch { /* best effort */ }
		await a.thread?.close();
	}
}

async function main(): Promise<void> {
	const kinds: VaultKind[] = VAULT_ARG === "both" ? ["plain", "e2ee"] : VAULT_ARG === "plain" || VAULT_ARG === "e2ee" ? [VAULT_ARG] : [];
	if (kinds.length === 0) throw new Error(`--vault plain|e2ee|both, not ${VAULT_ARG}`);
	const modes: DeviceCheckMode[] = MODE_ARG === "both" ? ["quick", "large"] : MODE_ARG === "quick" || MODE_ARG === "large" ? [MODE_ARG] : [];
	if (modes.length === 0) throw new Error(`--mode quick|large|both, not ${MODE_ARG}`);
	const R = new Report();
	R.extra.config = { host: HOST, vault: VAULT_ARG, modes, node: process.version };
	const vaults: OnboardedVault[] = [];
	let fatal: string | null = null;
	try {
		for (const k of kinds) await runVault(R, k, modes, vaults);
	} catch (e) {
		fatal = e instanceof Error ? e.message : String(e);
		console.log(`FATAL ${fatal}`);
	}
	const merged = vaults[0] ? { ...vaults[0], devices: vaults.flatMap((v) => v.devices) } : null;
	const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-device-check", LABEL, HOST, merged, fatal);
	process.exit(failed > 0 || fatal ? 1 : 0);
}

await main();
