/**
 * Full-client e2e: 3-4 complete clients (HostRuntime + simulated Obsidian vault/workspace/config dir/side
 * files + the real composed engine on the production ports, inline carrier, real timers) syncing through a
 * REAL streams relay. See README.md. First the lone-edit latency runs (fullLatency.ts, each on its own vault:
 * E2EE on -> lone_*, off -> lone_plain_*), then the scenarios on one suite-0 vault (each ends with byte-identical
 * convergence of every file and synced .obsidian file on every client, plus clean engine/host state; their
 * back-to-back edits are the sustained_* series):
 *   1 fresh vault creates   2 disk/API/editor edits + concurrent merges   3 file/folder renames + deletes
 *   4 binary attachments    5 .obsidian settings                            6 offline edits + reconnect
 *   7 relay process restart (local hosts only)                              8 fresh device bootstrap + restart from IndexedDB
 *
 *   node --import jiti/register e2e/client/fullClients.ts [--host URL] [--label local] [--operator-context FILE]
 *        [--relay-scripts DIR] [--watcher-ms 100] [--lone both|e2ee|none]
 *
 * --relay-scripts: directory with start-local.sh/stop-local.sh for scenario 7 (default: env YAOS_RELAY_DEV_DIR,
 * else this checkout's scripts/relay-dev). --lone: which lone runs (default both). Every run needs the relay's
 * attachment storage (R2, which start-local.sh binds by default). Writes LOG_DIR/client-e2e-full-<label>-<stamp>.json
 * (no secrets) and exits 1 on any failed check.
 */
import { execFileSync } from "node:child_process";
import { Report } from "./engineKit";
import { converge } from "./fullCheck";
import { FullClient, type FullCtx } from "./fullKit";
import { lone } from "./fullLatency";
import { sAttachments, sCreate, sEdits, sRenames } from "./fullScenarios1";
import { installPlugin, sBootstrapRestart, sOffline, sRelayRestart, sSettings } from "./fullScenarios2";
import { DEFAULT_LOG_DIR, onboardVault, redact, type OnboardDevice, type OnboardedVault } from "./onboard";
import { WireTap } from "./wireTap";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", process.env.YAOS_E2E_HOST ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const LABEL = arg("label", "local");
const OPERATOR_CONTEXT = arg("operator-context", "");
const WT = new URL("../..", import.meta.url).pathname;
const RELAY_SCRIPTS = arg("relay-scripts", process.env.YAOS_RELAY_DEV_DIR ?? `${WT}scripts/relay-dev`).replace(/\/+$/, "");
const WATCHER_MS = Number(arg("watcher-ms", "100"));
const LONE = arg("lone", "both");
const R = new Report();

const url = new URL(HOST);
const LOCAL = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
const relay = LOCAL ? {
	stop: () => void execFileSync("zsh", [`${RELAY_SCRIPTS}/stop-local.sh`, "--port", url.port || "80"], { stdio: ["ignore", "ignore", "inherit"] }),
	start: () => void execFileSync("zsh", [`${RELAY_SCRIPTS}/start-local.sh`, "--port", url.port || "80"], { stdio: ["ignore", "ignore", "inherit"] }),
} : null;

const clients: FullClient[] = [];
const everyClient: FullClient[] = [];
let vault: OnboardedVault | null = null;
const tap = new WireTap();

function newClient(name: string, device: OnboardDevice): FullClient {
	const c = new FullClient({ name, host: HOST, vaultId: vault!.vaultId, device, watcherDelayMs: WATCHER_MS, tap });
	installPlugin(c);
	everyClient.push(c);
	return c;
}

function clientStats(c: FullClient) {
	const s = c.vrt?.status() ?? null;
	return {
		calls: c.vault.calls, bindings: c.runtime.bindings.stats, host: c.runtime.stats, engineStarts: c.engineStarts,
		cursorAtStart: c.cursorAtStart, blob: c.blobKind, carrier: c.ui.carriers.at(-1) ?? null, deviceClass: c.runtime.currentDeviceClass,
		notices: c.ui.notices.map((n) => `${n.level}:${n.code}`), fatals: c.ui.fatals.map((f) => f.code), brakes: c.ui.brakes.length,
		phase: s?.phase ?? null, vaultSeq: s?.vaultSeq ?? null, counts: s?.counts ?? null, cfgPasses: c.vrt?.stats.cfgPasses ?? null,
		trashed: c.vault.trashed.length, conflictCopiesWritten: c.conflictCopiesWritten,
	};
}

async function scenario(name: string, fn: (x: FullCtx) => Promise<void>, x: FullCtx): Promise<void> {
	R.step(name);
	try {
		await fn(x);
	} catch (e) {
		R.check("scenario completed", false, e instanceof Error ? e.message : String(e));
		const logs: Record<string, string[]> = {};
		for (const c of everyClient) logs[c.name] = c.logLines.slice(-80);
		R.extra[`logs ${name}`] = redact(logs);
	}
}

async function loneRun(e2ee: boolean): Promise<void> {
	try {
		await lone(R, { host: HOST, label: LABEL, watcherMs: WATCHER_MS, e2ee, prefix: e2ee ? "lone" : "lone_plain" });
	} catch (e) {
		R.check("lone run completed", false, e instanceof Error ? e.message : String(e));
	}
}

async function main(): Promise<void> {
	if (LONE === "both" || LONE === "e2ee") await loneRun(true);
	if (LONE === "both") await loneRun(false);

	R.step("onboard + start a, b, c");
	vault = await onboardVault(HOST, { devices: 3, label: `full-${LABEL}`, ...(OPERATOR_CONTEXT ? { operatorContextFile: OPERATOR_CONTEXT } : {}) });
	const x: FullCtx = { R, host: HOST, vault, clients, newClient, relay, tap };
	for (const [i, d] of vault.devices.entries()) clients.push(newClient("abc"[i]!, d));
	const t0 = performance.now();
	await Promise.all(clients.map((c) => c.start()));
	await converge(clients, 60_000);
	R.record("start_to_clean_ms", performance.now() - t0);
	R.check("clients started inline, ready and clean", clients.every((c) => c.runtime.engine.isReady && c.ui.carriers.at(-1)?.carrier === "inline"),
		clients.map((c) => ({ carrier: c.ui.carriers.at(-1), deviceClass: c.runtime.currentDeviceClass })));
	R.check("every client has the relay's blob store (R2): attachments upload over HTTP PUT, never through the relay log",
		clients.every((c) => c.blobKind === "http" && (c.vrt?.status().maxBlobBytes ?? 0) > 0), clients.map((c) => ({ blob: c.blobKind, maxBlobBytes: c.vrt?.status().maxBlobBytes ?? null })));
	R.extra.config = { watcherDelayMs: WATCHER_MS, local: LOCAL, carrier: "inline", settings: "DEFAULT_ENGINE_SETTINGS + syncSettings" };
	// Back-to-back edits cannot commit closer than the relay's minimum interval: the sustained_* floor per commit.
	R.extra.groupCommit = tap.groupCommit;
	R.extra.sustainedFloorMsPerCommit = tap.groupCommit?.minIntervalMs ?? null;

	await scenario("1 fresh vault creates", sCreate, x);
	await scenario("2 edits (disk, api, editor, concurrent)", sEdits, x);
	await scenario("3 renames + deletes", sRenames, x);
	await scenario("4 binary attachments", sAttachments, x);
	await scenario("5 .obsidian settings", sSettings, x);
	await scenario("6 offline + reconnect", sOffline, x);
	await scenario("7 relay restart", sRelayRestart, x);
	await scenario("8 fresh bootstrap + restart from IndexedDB", sBootstrapRestart, x);

	R.step("final");
	await converge(clients, 60_000);
	R.check("final convergence of every client", true, { clients: clients.map((c) => c.name), files: clients[0]!.vault.snapshot().size });
}

let fatal: string | null = null;
try {
	await main();
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
} finally {
	R.extra.sustained_samples = tap.samples;
	for (const c of everyClient) R.extra[`stats ${c.name}`] = clientStats(c);
	for (const c of everyClient) {
		try { await c.stop(); } catch { /* best effort */ }
	}
}
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-full", LABEL, HOST, vault, fatal);
process.exit(failed === 0 ? 0 : 1);
