/**
 * Phone bootstrap bench: one Android phone over adb, against the vault a bootBench run seeded (same relay, same
 * shape), so the phone's numbers sit next to bootBench's fresh Node devices. Per run, on the phone's bench vault
 * folder: stop Obsidian, revoke the previous run's device, wipe the folder (everything but .obsidian, plus the
 * plugin's data.json), push the current build, reopen Obsidian on the vault, mint a pairing code and open the setup
 * link. The only manual step is the Pair tap. Timed on the laptop, by polling the folder over adb: Pair (data.json
 * holds an identity) -> first file -> every seeded file. A new pairing is a new device id and the store is per device
 * (store/schema.ts: yaos2:<vault>:<epoch>:<device>), so every run bootstraps from an empty IndexedDB.
 *
 * One-time on the phone: USB debugging on, an empty Obsidian vault named --vault, community plugins on. The first
 * run refuses a folder holding anything outside .obsidian, then marks it (.obsidian/plugins/yaos/.bench) as wipeable.
 *
 *   node --import jiti/register e2e/client/phoneBench.ts --host URL --label L [--runs 3] [--vault yaos-bench]
 *        [--dir /sdcard/Documents/yaos-bench] [--plugin dist/yaos-client/yaos] [--open-wait-s 10]
 *
 * --label is bootBench's: the vault recorded as boot-<label> in the context file. Writes
 * LOG_DIR/client-e2e-phone-<label>-<stamp>.json (no secrets) and exits 1 on a failed check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Report, sleep } from "./engineKit";
import { contextPath, DEFAULT_LOG_DIR, devicePairingCode, revokeDevice, type OnboardDevice, type OnboardedVault } from "./onboard";
import { attribute, cpuSummary, PhoneProfile } from "./phoneProfile";

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const HOST = arg("host", "").replace(/\/+$/, "");
const LABEL = arg("label", "phone-base");
/** --profile: DevTools hooks and CPU profiles on the phone during the run (phoneProfile.ts); default 1 run. */
const PROFILE = process.argv.includes("--profile");
const RUNS = Number(arg("runs", PROFILE ? "1" : "3"));
const DEVTOOLS_PORT = 9333;
const VAULT_NAME = arg("vault", "yaos-bench");
const DIR = arg("dir", `/sdcard/Documents/${VAULT_NAME}`);
const PLUGIN = arg("plugin", new URL("../../dist/yaos-client/yaos", import.meta.url).pathname);
const OPEN_WAIT_MS = Number(arg("open-wait-s", "10")) * 1000;
const PAIR_TIMEOUT_MS = 5 * 60_000;
const FILES_TIMEOUT_MS = 20 * 60_000;
const PKG = "md.obsidian";
const PLUGIN_DIR = `${DIR}/.obsidian/plugins/yaos`;
const MARKER = `${PLUGIN_DIR}/.bench`;
const R = new Report();
const r1 = (v: number) => Math.round(v * 10) / 10;
const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)]! : 0);

// ---- adb -------------------------------------------------------------------------------------------------------

/** Single-quotes `s` for the phone's sh. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const adb = (...args: string[]) => execFileSync("adb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
/** Runs `cmd` in the phone's sh; its stdout whatever the exit status (adb shell passes it through; callers check results). */
function sh(cmd: string): string {
	try {
		return adb("shell", cmd).trim();
	} catch (e) {
		const out = (e as { stdout?: unknown }).stdout;
		if (typeof out === "string") return out.trim();
		throw e;
	}
}
const shOk = (cmd: string) => sh(`${cmd} >/dev/null 2>&1 && echo y || echo n`) === "y";
const countFiles = () => Number(sh(`find ${q(DIR)} -type f ! -path ${q(`${DIR}/.obsidian/*`)} | wc -l`)) || 0;

/** The plugin's data.json identity, parsed here; the token never leaves this function's caller. */
function phoneIdentity(): { deviceId: string } | null {
	const text = sh(`cat ${q(`${PLUGIN_DIR}/data.json`)} 2>/dev/null`);
	if (!text) return null;
	try {
		const id = (JSON.parse(text) as { identity?: { deviceId?: unknown; vaultId?: unknown } | null }).identity;
		return id && typeof id.deviceId === "string" ? { deviceId: id.deviceId } : null;
	} catch {
		return null; // mid-write
	}
}

function deviceInfo(): Record<string, string> {
	const prop = (k: string) => sh(`getprop ${k}`);
	// Filtered on the phone: dumpsys output runs to megabytes.
	const line = (cmd: string, re: string) => sh(`${cmd} 2>/dev/null | grep -m1 -E ${q(re)} || true`).trim();
	return {
		model: `${prop("ro.product.manufacturer")} ${prop("ro.product.model")}`,
		android: prop("ro.build.version.release"),
		obsidian: line(`dumpsys package ${PKG}`, "versionName=").replace("versionName=", ""),
		webview: line("dumpsys webviewupdate", "Current WebView package"),
		memTotal: line("cat /proc/meminfo", "^MemTotal"),
		cpus: sh("nproc"),
		battery: ["level", "AC powered", "USB powered"].map((k) => line("dumpsys battery", `^ *${k}:`)).join(", "),
		wifi: line("dumpsys wifi", "^Wi-Fi is"),
		network: line("dumpsys connectivity", "NetworkAgentInfo.*(WIFI|CELLULAR)").slice(0, 160),
	};
}

// ---- laptop side -----------------------------------------------------------------------------------------------

/** The vault bootBench seeded (context file record boot-<label>, the last one). SECRET: device tokens. */
function seededVault(): OnboardedVault {
	const path = contextPath(HOST);
	if (!existsSync(path)) throw new Error(`no context file for ${HOST}: run bootBench.ts --host ${HOST} --label ${LABEL} first`);
	const ctx = JSON.parse(readFileSync(path, "utf8")) as { vaults?: { label: string; vaultId: string; devices: Record<string, OnboardDevice> }[] };
	const rec = (ctx.vaults ?? []).filter((v) => v.label === `boot-${LABEL}`).at(-1);
	if (!rec) throw new Error(`no vault boot-${LABEL} in ${path}: run bootBench.ts --host ${HOST} --label ${LABEL} first`);
	return { baseUrl: HOST, vaultId: rec.vaultId, vaultGeneration: "", via: "operator", devices: Object.values(rec.devices) };
}

/** bootBench's latest report for this label: the seeded file count and its fresh Node devices' times. */
function nodeBaseline(): { files: number; freshFilesMs: unknown; freshCleanMs: unknown; rtt: unknown; file: string } {
	const prefix = `client-e2e-boot-${LABEL.replace(/[^a-z0-9.-]/gi, "_")}-`;
	const file = readdirSync(DEFAULT_LOG_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort().at(-1);
	if (!file) throw new Error(`no ${prefix}*.json in ${DEFAULT_LOG_DIR}`);
	const rep = JSON.parse(readFileSync(join(DEFAULT_LOG_DIR, file), "utf8")) as {
		host: string; latencyMs: Record<string, unknown>; extra: { vaultShape?: { files?: number }; rtt?: unknown };
	};
	if (rep.host !== HOST) throw new Error(`${file} ran against ${rep.host}, not ${HOST}`);
	const files = rep.extra.vaultShape?.files;
	if (typeof files !== "number") throw new Error(`${file} has no extra.vaultShape.files`);
	return { files, freshFilesMs: rep.latencyMs.fresh_files_ms, freshCleanMs: rep.latencyMs.fresh_clean_ms, rtt: rep.extra.rtt, file };
}

async function laptopRtt(): Promise<{ capabilitiesMs: number; cfRay: string | null }> {
	const ms: number[] = [];
	let cfRay: string | null = null;
	for (let i = 0; i < 8; i++) {
		const s = performance.now();
		const res = await fetch(`${HOST}/api/capabilities`);
		await res.arrayBuffer();
		if (i > 0) ms.push(performance.now() - s);
		cfRay = res.headers.get("cf-ray");
	}
	return { capabilitiesMs: r1(median(ms)), cfRay };
}

// ---- one run ---------------------------------------------------------------------------------------------------

/** Stops Obsidian, revokes the device the folder is paired as, and empties the folder for a fresh pairing. */
async function reset(vault: OnboardedVault): Promise<void> {
	sh(`am force-stop ${PKG}`);
	const prev = phoneIdentity();
	if (prev) await revokeDevice(vault, prev.deviceId).catch((e: unknown) => console.log(`revoke of the previous device failed: ${String(e)}`));
	sh(`cd ${q(DIR)} && find . -mindepth 1 -maxdepth 1 ! -name .obsidian -exec rm -rf {} + ; rm -f ${q(`${PLUGIN_DIR}/data.json`)}`);
	if (countFiles() !== 0) throw new Error(`${DIR} still holds files after the wipe`);
}

function installPlugin(): void {
	sh(`mkdir -p ${q(PLUGIN_DIR)}`);
	for (const f of ["main.js", "manifest.json"]) adb("push", join(PLUGIN, f), `${PLUGIN_DIR}/${f}`);
	const listPath = `${DIR}/.obsidian/community-plugins.json`;
	let list: string[] = [];
	try { list = JSON.parse(sh(`cat ${q(listPath)} 2>/dev/null`) || "[]") as string[]; } catch { /* rewritten below */ }
	if (!list.includes("yaos")) sh(`echo ${q(JSON.stringify([...list, "yaos"]))} > ${q(listPath)}`);
}

interface Run { firstFileMs: number | null; filesMs: number | null; files: number; pollMs: number; profile?: unknown }

/** Forwards the running Obsidian's WebView DevTools socket and returns its page's WebSocket URL. */
async function devtoolsPage(): Promise<string> {
	const pid = sh(`pidof ${PKG}`).split(/\s+/)[0];
	if (!pid || !sh("cat /proc/net/unix").includes(`@webview_devtools_remote_${pid}`)) {
		throw new Error(`no WebView DevTools socket for ${PKG} (pid ${pid ?? "none"})`);
	}
	adb("forward", `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
	const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
	const page = list.find((t) => t.type === "page");
	if (!page) throw new Error("Obsidian's WebView has no page target");
	return page.webSocketDebuggerUrl;
}

async function oneRun(vault: OnboardedVault, files: number, k: number): Promise<Run> {
	await reset(vault);
	installPlugin();
	sh(`am start -a android.intent.action.VIEW -d ${q(`obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}`)}`);
	await sleep(OPEN_WAIT_MS);
	const prof = PROFILE ? await PhoneProfile.attach(await devtoolsPage(), (l) => console.log(`  profile: ${l}`)) : null;
	const code = await devicePairingCode(HOST, vault.vaultId, vault.devices[0]!.deviceToken);
	const link = `obsidian://yaos?action=setup&host=${encodeURIComponent(HOST)}&pairingCode=${encodeURIComponent(code)}&suite=0`;
	sh(`am start -a android.intent.action.VIEW -d ${q(link)}`);
	console.log(`run ${k + 1}/${RUNS}: tap Pair on the phone`);

	const tLink = performance.now();
	while (!phoneIdentity()) {
		if (performance.now() - tLink > PAIR_TIMEOUT_MS) {
			throw new Error("no pairing after 5 min: is the pair modal on the phone? (community plugins on, YAOS enabled in this vault?)");
		}
		await sleep(150);
	}
	const t0 = performance.now();
	const wall0 = Date.now();
	console.log(`paired after ${Math.round((t0 - tLink) / 1000)} s; waiting for ${files} files`);

	let firstFileMs: number | null = null;
	let filesMs: number | null = null;
	let n = 0;
	let polls = 0;
	let lastLog = t0;
	while (filesMs === null) {
		n = countFiles();
		polls++;
		const at = performance.now() - t0;
		if (n > 0 && firstFileMs === null) firstFileMs = at;
		if (n >= files) filesMs = at;
		else if (at > FILES_TIMEOUT_MS) break;
		else if (performance.now() - lastLog > 5000) {
			lastLog = performance.now();
			console.log(`  ${Math.round(at / 1000)} s: ${n}/${files}`);
		}
	}
	const pollMs = r1((performance.now() - t0) / Math.max(1, polls));
	const run: Run = { firstFileMs: firstFileMs === null ? null : r1(firstFileMs), filesMs: filesMs === null ? null : r1(filesMs), files: n, pollMs };
	if (prof) run.profile = await profileOf(prof, wall0, run, k);
	return run;
}

/**
 * Collects the profile and attributes three windows on the phone's clock: pair -> first file, first file -> every
 * file, and the whole bootstrap. The CPU profiles and raw events go next to the report.
 */
async function profileOf(prof: PhoneProfile, wall0: number, run: Run, k: number): Promise<unknown> {
	const offset = await prof.clockOffsetMs();
	await sleep(1000);
	const threads = await prof.finish();
	const at = (ms: number) => wall0 + offset + ms;
	const first = run.firstFileMs ?? 0;
	const end = run.filesMs ?? first;
	const windows = {
		toFirstFile: attribute(threads, [at(0), at(first)]),
		firstToAll: attribute(threads, [at(first), at(end)]),
		all: attribute(threads, [at(0), at(end)]),
	};
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const base = join(DEFAULT_LOG_DIR, `client-e2e-phone-profile-${LABEL.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}-run${k + 1}`);
	const cpu: Record<string, unknown> = {};
	for (const t of threads) {
		if (t.profile) {
			writeFileSync(`${base}-${t.thread}.cpuprofile`, JSON.stringify(t.profile));
			cpu[t.thread] = cpuSummary(t.profile);
		}
	}
	writeFileSync(`${base}-events.json`, JSON.stringify({ wall0, offset, run, threads: threads.map((t) => ({ thread: t.thread, url: t.url, hook: t.hook, events: t.events })) }));
	const threadInfo = threads.map((t) => ({ thread: t.thread, url: t.url.slice(0, 80), hook: t.hook, events: t.events.length }));
	console.log(JSON.stringify({ threads: threadInfo, windows: Object.fromEntries(Object.entries(windows).map(([w, a]) => [w, { windowMs: a.windowMs, split: a.split, busyMs: a.busyMs }])) }, null, 1));
	console.log(`profile files: ${base}-*`);
	return { offsetMs: r1(offset), threads: threadInfo, windows, cpu };
}

// ---- main ------------------------------------------------------------------------------------------------------

let vault: OnboardedVault | null = null;
let fatal: string | null = null;
try {
	if (!HOST) throw new Error("--host is required");
	R.step("setup");
	const devices = adb("devices").split("\n").slice(1).filter((l) => /\tdevice$/.test(l));
	if (devices.length !== 1) throw new Error(`need exactly one phone on adb, found ${devices.length} (USB debugging on, prompt accepted?)`);
	if (!shOk(`test -d ${q(DIR)}`)) throw new Error(`${DIR} is not on the phone: create an empty Obsidian vault named ${VAULT_NAME} (or pass --dir)`);
	if (!shOk(`test -f ${q(MARKER)}`)) {
		const n = countFiles();
		if (n !== 0) throw new Error(`${DIR} holds ${n} files outside .obsidian; this bench wipes the folder, so it only takes an empty vault`);
		sh(`mkdir -p ${q(PLUGIN_DIR)} && touch ${q(MARKER)}`);
	}
	if (!existsSync(join(PLUGIN, "main.js"))) throw new Error(`no build at ${PLUGIN}: npm run build`);
	vault = seededVault();
	const node = nodeBaseline();
	R.extra.vault = { vaultIdPrefix: vault.vaultId.slice(0, 8), files: node.files };
	R.extra.node = node;
	R.extra.device = deviceInfo();
	R.extra.laptop = await laptopRtt();
	console.log(JSON.stringify({ device: R.extra.device, laptop: R.extra.laptop, files: node.files }, null, 1));

	const runs: Run[] = [];
	for (let k = 0; k < RUNS; k++) {
		R.step(`phone run ${k + 1}`);
		const run = await oneRun(vault, node.files, k);
		runs.push(run);
		R.extra[`run ${k + 1}`] = run;
		if (run.firstFileMs !== null) R.record("phone_first_file_ms", run.firstFileMs);
		if (run.filesMs !== null) R.record("phone_files_ms", run.filesMs);
		R.check(`run ${k + 1}: every file on the phone`, run.filesMs !== null, { files: run.files, expected: node.files });
		console.log(`  done: every file at ${run.filesMs ?? "-"} ms (first at ${run.firstFileMs ?? "-"} ms, poll every ${run.pollMs} ms)`);
	}
	sh(`am force-stop ${PKG}`);
	const last = phoneIdentity();
	if (last) await revokeDevice(vault, last.deviceId).catch((e: unknown) => console.log(`final revoke failed: ${String(e)}`));

	const ms = runs.map((r) => r.filesMs).filter((v): v is number => v !== null);
	console.log(`\nphone, files on disk (ms): ${ms.join(" / ") || "-"}`);
	console.log(`node (bootBench), files on disk: ${JSON.stringify(node.freshFilesMs)}`);
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
}
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-phone", LABEL, HOST, vault, fatal);
process.exit(failed === 0 ? 0 : 1);
