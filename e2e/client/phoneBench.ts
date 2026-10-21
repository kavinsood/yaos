/**
 * Phone bootstrap bench: one Android phone over adb, against the vault a bootBench run seeded (same relay, same
 * shape), so the phone's numbers sit next to bootBench's fresh Node devices. Per run, on the phone's bench vault
 * folder: stop Obsidian, revoke the previous run's pairing, wipe the folder (everything but .obsidian, plus the
 * plugin's data.json), push the current build, reopen Obsidian on the vault, mint a pairing code and open the setup
 * link, then press its Pair button over DevTools (a tap on the phone if that fails). The only manual step is
 * unlocking the phone if it is locked: the bench wakes the screen and keeps it on while on USB until it exits. Timed
 * on the laptop, by polling the folder over adb: Pair (data.json holds an identity) -> first file -> every seeded
 * file. A new pairing is a new grant and a new store (identity-per-store; a device id per store before it), so every
 * run bootstraps from an empty IndexedDB.
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
import { attribute, cpuInWindow, pageEvaluate, PhoneProfile, timeline } from "./phoneProfile";
import { LOCAL_SETTINGS_KEY } from "../../src/host/localSettings";

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
/** How long a run waits for the phone to be unlocked before it opens Obsidian. */
const UNLOCK_TIMEOUT_MS = 30 * 60_000;
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
/**
 * The identity the pair flow stored in data.json: a pairing grant (identity-per-store, current client) or an enrolled
 * device (builds before it, so an older build can still be benched). SECRET: grantSecret; never logged.
 */
type PhoneIdentity = { readonly t: "grant"; readonly host: string; readonly vaultId: string; readonly grantSecret: string } | { readonly t: "device"; readonly deviceId: string };

function phoneIdentity(): PhoneIdentity | null {
	const text = sh(`cat ${q(`${PLUGIN_DIR}/data.json`)} 2>/dev/null`);
	if (!text) return null;
	try {
		const id = (JSON.parse(text) as { identity?: Record<string, unknown> | null }).identity;
		if (!id) return null;
		if (typeof id.grantSecret === "string" && typeof id.host === "string" && typeof id.vaultId === "string") return { t: "grant", host: id.host, vaultId: id.vaultId, grantSecret: id.grantSecret };
		return typeof id.deviceId === "string" ? { t: "device", deviceId: id.deviceId } : null;
	} catch {
		return null; // mid-write
	}
}

/** Revokes a run's pairing on the server: a grant leaves with its own secret (pairing.ts leaveGrant), a device is revoked by the owner. */
async function revokeIdentity(vault: OnboardedVault, id: PhoneIdentity): Promise<void> {
	if (id.t === "device") return revokeDevice(vault, id.deviceId);
	const res = await fetch(`${id.host.replace(/\/+$/, "")}/vault/${encodeURIComponent(id.vaultId)}/auth/grant`, { method: "DELETE", headers: { Authorization: `Grant ${id.grantSecret}` } });
	if (res.status !== 200 && res.status !== 401) throw new Error(`grant leave failed ${res.status}`);
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

/**
 * Stops Obsidian, revokes the device the folder is paired as, and empties the folder for a fresh pairing: the notes,
 * data.json and the plugin's `state/` (the stores' mirror dirs, which a new store would otherwise inherit from).
 */
async function reset(vault: OnboardedVault): Promise<void> {
	sh(`am force-stop ${PKG}`);
	const prev = phoneIdentity();
	if (prev) await revokeIdentity(vault, prev).catch((e: unknown) => console.log(`revoke of the previous pairing failed: ${String(e)}`));
	sh(`cd ${q(DIR)} && find . -mindepth 1 -maxdepth 1 ! -name .obsidian -exec rm -rf {} + ; rm -rf ${q(`${PLUGIN_DIR}/data.json`)} ${q(`${PLUGIN_DIR}/state`)}`);
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

/** The screen stays on while the phone is on USB for the bench (restored at exit): a dozing phone shows no pair modal. */
let stayOn: string | null = null;
function keepAwake(): void {
	if (stayOn === null) stayOn = sh("settings get global stay_on_while_plugged_in") || "0";
	sh("svc power stayon usb");
	sh("input keyevent KEYCODE_WAKEUP");
}
function restoreAwake(): void {
	if (stayOn !== null) sh(`settings put global stay_on_while_plugged_in ${q(stayOn)}`);
}
const locked = () => /isKeyguardShowing=true|mDreamingLockscreen=true/.test(sh("dumpsys window | grep -E 'isKeyguardShowing|mDreamingLockscreen'"));

/** Wakes the screen and waits (asking once) until the keyguard is gone. */
async function unlocked(): Promise<void> {
	keepAwake();
	if (!locked()) return;
	console.log("the phone is locked: unlock it (the screen stays on while the bench runs)");
	const t = performance.now();
	while (locked()) {
		if (performance.now() - t > UNLOCK_TIMEOUT_MS) throw new Error("the phone stayed locked for 30 min");
		await sleep(1000);
		sh("input keyevent KEYCODE_WAKEUP");
	}
	console.log("unlocked");
}

/** Presses the pair modal's "Pair" button over DevTools (pairModal.ts); false when it did not appear within 20 s. */
async function pressPair(): Promise<boolean> {
	const click = `(() => { const b = [...document.querySelectorAll(".modal button")].find((e) => e.textContent.trim() === "Pair"); if (!b) return false; b.click(); return true; })()`;
	const t = performance.now();
	while (performance.now() - t < 20_000) {
		try {
			if (await pageEvaluate(await devtoolsPage(), click)) return true;
		} catch {
			// DevTools socket not up yet
		}
		await sleep(500);
	}
	return false;
}

/**
 * Makes the phone a fresh install of the bench vault, as a new phone would be: deletes this vault's YAOS stores
 * (IndexedDB `yaos3:<vaultId>:…`, `yaos3-pending:<vaultId>:…`) and the per-install record in Obsidian's localStorage
 * (localSettings.ts, its install key), with the plugin unloaded so nothing holds them open. The folder wipe leaves
 * both: the next pairing then reopened the previous run's store, whose device the bench had just revoked (an unpinned
 * engine does not replace a revoked store). Scoped to the bench vault's id: other vaults' stores on the phone (one
 * WebView origin) are not touched.
 */
async function freshInstall(vaultId: string): Promise<void> {
	const expr = `(async () => {
		if (app.vault.getName() !== ${JSON.stringify(VAULT_NAME)}) return "Obsidian has another vault open: " + app.vault.getName();
		await app.plugins.disablePlugin("yaos");
		const ours = (n) => typeof n === "string" && (n.startsWith("yaos3:") || n.startsWith("yaos3-pending:")) && n.split(":")[1] === ${JSON.stringify(vaultId)};
		const names = (await indexedDB.databases()).map((d) => d.name).filter(ours);
		for (const n of names) await new Promise((res, rej) => { const r = indexedDB.deleteDatabase(n); r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked: " + n)); });
		app.saveLocalStorage(${JSON.stringify(LOCAL_SETTINGS_KEY)}, null);
		await app.plugins.enablePlugin("yaos");
		return names.length;
	})()`;
	let last: unknown = null;
	for (let i = 0; i < 20; i++) {
		try {
			last = await pageEvaluate(await devtoolsPage(), expr);
			break;
		} catch (e) {
			last = e; // DevTools or the app not up yet
			await sleep(500);
		}
	}
	if (typeof last !== "number") throw new Error(`fresh install failed: ${String(last)}`);
	console.log(`  fresh install: ${last} store DB(s) of the bench vault deleted, install record cleared`);
}

async function oneRun(vault: OnboardedVault, files: number, k: number): Promise<Run> {
	await unlocked();
	await reset(vault);
	installPlugin();
	sh(`am start -a android.intent.action.VIEW -d ${q(`obsidian://open?vault=${encodeURIComponent(VAULT_NAME)}`)}`);
	await sleep(OPEN_WAIT_MS);
	await freshInstall(vault.vaultId);
	const prof = PROFILE ? await PhoneProfile.attach(await devtoolsPage(), (l) => console.log(`  profile: ${l}`)) : null;
	const code = await devicePairingCode(HOST, vault.vaultId, vault.devices[0]!.deviceToken);
	const link = `obsidian://yaos?action=setup&host=${encodeURIComponent(HOST)}&pairingCode=${encodeURIComponent(code)}&suite=0`;
	sh(`am start -a android.intent.action.VIEW -d ${q(link)}`);
	if (await pressPair()) console.log(`run ${k + 1}/${RUNS}: pressed Pair over DevTools`);
	else console.log(`run ${k + 1}/${RUNS}: tap Pair on the phone`);

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
		// Yield between the (synchronous) adb polls: with --profile, DevTools traffic (attaches, drains) is handled here.
		await sleep(0);
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
	const threads = await prof.finish(offset);
	const at = (ms: number) => wall0 + offset + ms;
	const first = run.firstFileMs ?? 0;
	const end = run.filesMs ?? first;
	const wins = { toFirstFile: [at(0), at(first)], firstToAll: [at(first), at(end)], all: [at(0), at(end)] } as const;
	const windows = Object.fromEntries(Object.entries(wins).map(([w, win]) => [w, attribute(threads, [win[0], win[1]])]));
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const base = join(DEFAULT_LOG_DIR, `client-e2e-phone-profile-${LABEL.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}-run${k + 1}`);
	const cpu: Record<string, Record<string, unknown>> = {};
	for (const t of threads) {
		if (t.chunks.length === 0) continue;
		writeFileSync(`${base}-${t.thread}.cpuchunks.json`, JSON.stringify(t.chunks));
		cpu[t.thread] = Object.fromEntries(Object.entries(wins).map(([w, win]) => [w, cpuInWindow(t.chunks, [win[0], win[1]])]));
	}
	// The startup stall: everything from 1 s before the pair was seen (the poll lags it) to the first file.
	const startup = timeline(threads, [at(-1000), at(first)], at(0));
	writeFileSync(`${base}-events.json`, JSON.stringify({ wall0, offset, run, threads: threads.map((t) => ({ thread: t.thread, url: t.url, hook: t.hook, goneAtMs: t.goneAtMs, events: t.events })) }));
	writeFileSync(`${base}-startup.txt`, startup.join("\n") + "\n");
	const threadInfo = threads.map((t) => ({ thread: t.thread, url: t.url.slice(0, 80), hook: t.hook, events: t.events.length, chunks: t.chunks.length, gone: t.goneAtMs === null ? null : r1(t.goneAtMs - at(0)) }));
	const busy = Object.fromEntries(Object.entries(cpu).map(([t, w]) => [t, Object.fromEntries(Object.entries(w).map(([n, c]) => [n, (c as { busyMs: number }).busyMs]))]));
	console.log(JSON.stringify({ threads: threadInfo, cpuBusyMs: busy, windows: Object.fromEntries(Object.entries(windows).map(([w, a]) => [w, { windowMs: a.windowMs, split: a.split, busyMs: a.busyMs }])) }, null, 1));
	console.log(`startup timeline (ms from pair seen, ${startup.length} lines):`);
	for (const l of startup.slice(0, 120)) console.log(`  ${l}`);
	console.log(`profile files: ${base}-*`);
	return { offsetMs: r1(offset), threads: threadInfo, windows, cpu, startup };
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
	if (last) await revokeIdentity(vault, last).catch((e: unknown) => console.log(`final revoke failed: ${String(e)}`));

	const ms = runs.map((r) => r.filesMs).filter((v): v is number => v !== null);
	console.log(`\nphone, files on disk (ms): ${ms.join(" / ") || "-"}`);
	console.log(`node (bootBench), files on disk: ${JSON.stringify(node.freshFilesMs)}`);
} catch (e) {
	fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
	R.check("run completed", false, fatal);
}
restoreAwake();
const [, failed] = R.write(DEFAULT_LOG_DIR, "client-e2e-phone", LABEL, HOST, vault, fatal);
process.exit(failed === 0 ? 0 : 1);
