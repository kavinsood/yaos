// Production bundle smoke checks (run by `node esbuild.config.mjs production`).
//   1. zip layout: yaos/main.js + yaos/manifest.json, byte-identical to the build output;
//   2. forbidden content: no WebAssembly;
//   3. the engine is in main.js once (integration-notes D2): one bundle wrapper
//      function, and engine markers (yjs's import guard, two engine-only strings)
//      each occur exactly once;
//   4. main.js loads as an Obsidian CJS plugin (Obsidian's own loader shape:
//      window.eval of `(function anonymous(require,module,exports){...})`)
//      against a stub "obsidian" (real @codemirror/* from node_modules: they are
//      external), the default export extends Plugin, and onload() against an
//      in-memory vault (src/sim/fakeObsidian.ts) with a paired identity reaches
//      phase "running", registers the editor extension / settings tab / status
//      bar, never logs the device token, and onunload() stops it. Twice:
//      a. inline carrier: no `Worker` (node), so the host runs the engine on main;
//      b. worker carrier: a `Worker` (SmokeWorker, a real thread) is available;
//         the host builds the worker from main.js's own source, the worker
//         answers the startup ping and init, and its script is exactly
//         main.js's bundle wrapper (no second engine copy anywhere).
import esbuild from "esbuild";
import { strFromU8, unzipSync } from "fflate";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { SmokeWorker, eventTarget, obsidianStub, workerScripts } from "./plugin-smoke-env.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const nodeRequire = createRequire(new URL("../package.json", import.meta.url));
const PLUGIN_ID = "yaos";
const TOKEN = "smoke_token_0123456789abcdefghijklmnopqrstuvwxyz";
/** Strings that exist once per copy of the engine: yjs's import guard, the IDB adapter, the protocol engine. */
const ENGINE_MARKERS = ["__ $YJS$ __", "createIdbStoragePort: IndexedDB is not available", "already initialized"];

function fail(msg) {
	throw new Error(`plugin smoke: ${msg}`);
}

function occurrences(text, needle) {
	let n = 0;
	for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
	return n;
}

async function loadFakeVault() {
	const r = await esbuild.build({ absWorkingDir: ROOT, entryPoints: ["src/sim/fakeObsidian.ts"], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "warning" });
	const out = r.outputFiles[0];
	if (!out) fail("fakeObsidian bundle empty");
	return import(`data:text/javascript;base64,${Buffer.from(out.text).toString("base64")}`);
}

async function waitUntil(pred, ms, what) {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) fail(`timeout waiting for ${typeof what === "function" ? what() : what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** Bundle wrapper (esbuild.config.mjs) as `Function.prototype.toString` returns it: `function NAME(` ... last `}` before the call. */
function wrapperSource(mainJs, name) {
	const start = mainJs.indexOf(`function ${name}(`);
	const end = mainJs.lastIndexOf("})(require, module, exports);");
	if (start < 0 || end < 0 || occurrences(mainJs, `function ${name}(`) !== 1) fail(`bundle wrapper ${name} not found exactly once`);
	return mainJs.slice(start, end + 1);
}

function checkEngineOnce(mainJs) {
	for (const m of ENGINE_MARKERS) {
		const n = occurrences(mainJs, m);
		if (n !== 1) fail(`engine marker ${JSON.stringify(m)} occurs ${n} times (expected 1: the engine must be in main.js once)`);
	}
}

async function smokePlugin(mainJs, manifest, carrier) {
	const saved = {
		notices: [],
		data: { identity: { host: "https://relay.example", vaultId: "smokeVaultAAAAAAAAAAAA", deviceId: "smoke-device-0001", deviceToken: TOKEN, deviceName: "smoke", vaultGeneration: null } },
	};
	const stub = obsidianStub(saved, fail);
	const requested = [];
	const fakeRequire = (id) => {
		requested.push(id);
		if (id === "obsidian") return stub;
		if (id === "@codemirror/state" || id === "@codemirror/view") return nodeRequire(id);
		throw new Error(`unexpected require(${JSON.stringify(id)})`);
	};
	const mod = { exports: {} };
	// Obsidian's loader (app.js loadPlugin): window.eval("(function anonymous(require,module,exports){" + code + "\n})\n//# sourceURL=plugin:<id>\n").
	const load = (0, eval)(`(function anonymous(require,module,exports){${mainJs}\n})\n//# sourceURL=plugin:${PLUGIN_ID}\n`);
	load(fakeRequire, mod, mod.exports);
	const Ctor = mod.exports.default;
	if (typeof Ctor !== "function") fail(`module.exports.default is ${typeof Ctor}`);
	const extra = requested.filter((id) => !["obsidian", "@codemirror/state", "@codemirror/view"].includes(id));
	if (extra.length) fail(`unexpected requires ${extra.join(",")}`);

	const { FakeObsidianVault } = await loadFakeVault();
	const vault = new FakeObsidianVault(false);
	vault.put("hello.md", "hello from the smoke vault");
	const workspace = { getLeavesOfType: () => [], on: () => ({}), offref() {}, onLayoutReady: (cb) => cb() };
	const app = { vault, workspace };
	const g = globalThis;
	const prev = { document: g.document, window: g.window, indexedDB: g.indexedDB, IDBKeyRange: g.IDBKeyRange, Worker: g.Worker };
	// Obsidian always has IndexedDB; node does not (the engine's store is real IndexedDB code).
	g.indexedDB = new IDBFactory();
	g.IDBKeyRange = IDBKeyRange;
	if (carrier === "worker") {
		SmokeWorker.base = `${ROOT}package.json`;
		g.Worker = SmokeWorker;
	} else if (typeof g.Worker !== "undefined") fail("node has a global Worker; the inline smoke needs none");
	const logged = [];
	const origDebug = console.debug;
	g.document = eventTarget({ visibilityState: "visible", hidden: false });
	g.window = eventTarget({ setTimeout, clearTimeout, setInterval, clearInterval });
	console.debug = (...a) => logged.push(a.join(" "));
	const scriptsBefore = workerScripts.length;
	try {
		const plugin = new Ctor(app, { ...manifest, dir: `.obsidian/plugins/${PLUGIN_ID}` });
		if (!(plugin instanceof stub.Plugin)) fail("default export does not extend Plugin");
		await plugin.onload();
		if (plugin.editorExtensions.length !== 1) fail("collab editor extension not registered");
		if (plugin.settingTabs.length !== 1) fail("settings tab not registered");
		if (plugin.statusBarItems.length !== 1) fail("status bar item not added");
		if (plugin.commands.length === 0) fail("no commands registered");
		const ctl = plugin.controller;
		if (!ctl) fail("controller missing after onload");
		const state = () => `${JSON.stringify(ctl.runState())}; log: ${logged.slice(-8).join(" | ").replaceAll(TOKEN, "<token>")}`;
		await waitUntil(() => ctl.runState().phase === "running" || ctl.runState().phase === "failed", 10_000, () => `engine running on ${carrier} (${state()})`);
		const rs = ctl.runState();
		if (rs.phase !== "running" || rs.transport !== carrier) fail(`${carrier}: run state ${state()}`);
		await waitUntil(() => ctl.status() !== null, 3000, "status snapshot");
		if (g.document.listeners("visibilitychange") === 0 || g.window.listeners("pagehide") === 0) fail("lifecycle listeners not attached");
		const scripts = workerScripts.slice(scriptsBefore);
		await plugin.onunload();
		for (const d of plugin.disposers.reverse()) d();
		if (ctl.runState().phase !== "stopped") fail(`after unload: ${JSON.stringify(ctl.runState())}`);
		if (logged.join("\n").includes(TOKEN) || saved.notices.join("\n").includes(TOKEN)) fail("device token leaked to logs/notices");
		if (vault.trashed.length !== 0 || vault.text("hello.md") !== "hello from the smoke vault") fail("smoke run modified the vault");
		return { commands: plugin.commands.length, scripts };
	} finally {
		console.debug = origDebug;
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete g[k];
			else g[k] = v;
		}
		// yjs flags itself on globalThis; the next smoke run loads main.js again in this process (Obsidian: a new window).
		delete g[ENGINE_MARKERS[0]];
	}
}

export async function smokeCheck({ mainJs, zipPath, manifest, bundleFunctionName }) {
	const entries = unzipSync(readFileSync(zipPath));
	const names = Object.keys(entries).filter((n) => !n.endsWith("/")).sort();
	if (JSON.stringify(names) !== JSON.stringify([`${PLUGIN_ID}/main.js`, `${PLUGIN_ID}/manifest.json`])) fail(`zip entries ${JSON.stringify(names)}`);
	if (strFromU8(entries[`${PLUGIN_ID}/main.js`]) !== mainJs) fail("zip main.js differs");
	if (JSON.parse(strFromU8(entries[`${PLUGIN_ID}/manifest.json`])).id !== PLUGIN_ID) fail("zip manifest id");
	if (mainJs.includes("WebAssembly")) fail("bundle mentions WebAssembly");
	checkEngineOnce(mainJs);
	const wrapper = wrapperSource(mainJs, bundleFunctionName);

	const inline = await smokePlugin(mainJs, manifest, "inline");
	if (inline.scripts.length !== 0) fail("inline smoke started a worker");
	const worker = await smokePlugin(mainJs, manifest, "worker");
	if (worker.scripts.length !== 1) fail(`worker smoke started ${worker.scripts.length} workers (expected 1)`);
	const script = worker.scripts[0];
	if (!script.startsWith(`(${wrapper})(`)) fail("worker script is not main.js's bundle wrapper");
	if (occurrences(script, ENGINE_MARKERS[0]) !== 1) fail("worker script carries more than one engine");
	console.log(
		`plugin smoke: OK  zip layout, no WASM, engine once (${ENGINE_MARKERS.length} markers x1), ` +
			`onload -> running/inline -> unload (${inline.commands} commands), onload -> running/worker (script = main.js wrapper, ${(script.length / 1024).toFixed(1)} KiB) -> unload`,
	);
}
