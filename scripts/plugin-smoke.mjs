// Production bundle smoke checks (run by `node esbuild.config.mjs production`).
//   1. zip layout: yaos/main.js + yaos/manifest.json, byte-identical to the build output;
//   2. forbidden content: no WebAssembly in either bundle;
//   3. main.js loads as an Obsidian CJS plugin against a stub "obsidian" (real
//      @codemirror/* from node_modules: they are external), the default export
//      extends Plugin, and onload() against an in-memory vault (src/sim/fakeObsidian.ts)
//      with a paired identity reaches phase "running" on the inline carrier
//      (node has no Worker), registers the editor extension / settings tab /
//      status bar, never logs the device token, and onunload() stops it;
//   4. the worker IIFE runs in a node:vm context (importScripts defined, like a
//      DedicatedWorkerGlobalScope) and answers ping with pong.
import esbuild from "esbuild";
import { strFromU8, unzipSync } from "fflate";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const ROOT = new URL("..", import.meta.url).pathname;
const nodeRequire = createRequire(new URL("../package.json", import.meta.url));
const PLUGIN_ID = "yaos";
const TOKEN = "smoke_token_0123456789abcdefghijklmnopqrstuvwxyz";

function fail(msg) {
	throw new Error(`plugin smoke: ${msg}`);
}

function el() {
	const classes = new Set();
	return {
		style: {},
		textContent: "",
		attrs: {},
		classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) },
		setAttribute(k, v) {
			this.attrs[k] = v;
		},
		addEventListener() {},
		removeEventListener() {},
		empty() {},
		createEl: () => el(),
		createDiv: () => el(),
		createSpan: () => el(),
	};
}

function eventTarget(extra) {
	const ls = new Map();
	return {
		...extra,
		addEventListener: (t, l) => ls.set(t, [...(ls.get(t) ?? []), l]),
		removeEventListener: (t, l) => ls.set(t, (ls.get(t) ?? []).filter((x) => x !== l)),
		listeners: (t) => (ls.get(t) ?? []).length,
	};
}

function obsidianStub(saved) {
	class Component {}
	class Plugin extends Component {
		constructor(app, manifest) {
			super();
			this.app = app;
			this.manifest = manifest;
			this.commands = [];
			this.disposers = [];
			this.editorExtensions = [];
			this.settingTabs = [];
			this.statusBarItems = [];
			this.protocolHandlers = [];
		}
		async loadData() {
			return saved.data;
		}
		async saveData(d) {
			saved.data = d;
		}
		addCommand(c) {
			this.commands.push(c);
			return c;
		}
		addRibbonIcon() {
			return el();
		}
		addStatusBarItem() {
			const e = el();
			this.statusBarItems.push(e);
			return e;
		}
		addSettingTab(t) {
			this.settingTabs.push(t);
		}
		registerEditorExtension(e) {
			this.editorExtensions.push(e);
		}
		registerObsidianProtocolHandler(a, h) {
			this.protocolHandlers.push(a);
		}
		register(fn) {
			this.disposers.push(fn);
		}
		registerEvent() {}
		registerDomEvent() {}
		registerInterval(i) {
			return i;
		}
	}
	class PluginSettingTab {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = el();
		}
	}
	class Modal {
		constructor(app) {
			this.app = app;
			this.contentEl = el();
			this.titleEl = el();
		}
		open() {}
		close() {}
		onClose() {}
	}
	class Notice {
		constructor(m) {
			saved.notices.push(String(m));
		}
		setMessage() {
			return this;
		}
		hide() {}
	}
	class Setting {
		constructor() {
			this.settingEl = el();
		}
	}
	const Platform = { isDesktop: true, isMobile: false, isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false, isPhone: false, isTablet: false, isMacOS: false, isWin: false, isLinux: true, isSafari: false };
	return { Component, Plugin, PluginSettingTab, Modal, Notice, Setting, Platform, requestUrl: async () => fail("requestUrl during smoke"), apiVersion: "1.13.0-stub" };
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
		if (Date.now() > end) fail(`timeout waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function smokePlugin(mainJs, manifest) {
	const saved = {
		notices: [],
		data: { identity: { host: "https://relay.example", vaultId: "smoke-vault", deviceId: "smoke-device-0001", deviceToken: TOKEN, deviceName: "smoke", vaultGeneration: null } },
	};
	const stub = obsidianStub(saved);
	const requested = [];
	const fakeRequire = (id) => {
		requested.push(id);
		if (id === "obsidian") return stub;
		if (id === "@codemirror/state" || id === "@codemirror/view") return nodeRequire(id);
		throw new Error(`unexpected require(${JSON.stringify(id)})`);
	};
	const mod = { exports: {} };
	vm.runInThisContext(`(function (module, exports, require) {${mainJs}\n})`, { filename: `${PLUGIN_ID}/main.js` })(mod, mod.exports, fakeRequire);
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
	const prev = { document: g.document, window: g.window };
	const logged = [];
	const origDebug = console.debug;
	g.document = eventTarget({ visibilityState: "visible", hidden: false });
	g.window = eventTarget({});
	console.debug = (...a) => logged.push(a.join(" "));
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
		await waitUntil(() => ctl.runState().phase === "running" || ctl.runState().phase === "failed", 5000, "engine running");
		const rs = ctl.runState();
		if (rs.phase !== "running" || rs.transport !== "inline") fail(`run state ${JSON.stringify(rs)}`);
		await waitUntil(() => ctl.status() !== null, 3000, "status snapshot");
		if (g.document.listeners("visibilitychange") === 0 || g.window.listeners("pagehide") === 0) fail("lifecycle listeners not attached");
		await plugin.onunload();
		for (const d of plugin.disposers.reverse()) d();
		if (ctl.runState().phase !== "stopped") fail(`after unload: ${JSON.stringify(ctl.runState())}`);
		if (logged.join("\n").includes(TOKEN) || saved.notices.join("\n").includes(TOKEN)) fail("device token leaked to logs/notices");
		if (vault.trashed.length !== 0 || vault.text("hello.md") !== "hello from the smoke vault") fail("smoke run modified the vault");
		return { commands: plugin.commands.length, logLines: logged.length };
	} finally {
		console.debug = origDebug;
		g.document = prev.document;
		g.window = prev.window;
	}
}

async function smokeWorker(workerSrc) {
	const posted = [];
	const listeners = [];
	const ctx = vm.createContext({
		importScripts: () => {},
		postMessage: (m) => posted.push(m),
		addEventListener: (type, l) => {
			if (type === "message") listeners.push(l);
		},
		close() {},
		setTimeout,
		clearTimeout,
		queueMicrotask,
		console,
		performance,
		TextEncoder,
		TextDecoder,
		crypto: webcrypto,
	});
	vm.runInContext(workerSrc, ctx, { filename: "yaos-engine-worker.js" });
	if (listeners.length === 0) fail("worker did not subscribe to messages");
	for (const l of listeners) l({ data: { t: "ping", rid: 1 } });
	await waitUntil(() => posted.some((m) => m && m.t === "result" && m.re === 1), 2000, "worker pong");
	const pong = posted.find((m) => m.t === "result" && m.re === 1);
	if (pong.value?.t !== "pong") fail(`worker answered ${JSON.stringify(pong)}`);
}

export async function smokeCheck({ mainJs, workerSrc, zipPath, manifest }) {
	const entries = unzipSync(readFileSync(zipPath));
	const names = Object.keys(entries).filter((n) => !n.endsWith("/")).sort();
	if (JSON.stringify(names) !== JSON.stringify([`${PLUGIN_ID}/main.js`, `${PLUGIN_ID}/manifest.json`])) fail(`zip entries ${JSON.stringify(names)}`);
	if (strFromU8(entries[`${PLUGIN_ID}/main.js`]) !== mainJs) fail("zip main.js differs");
	if (JSON.parse(strFromU8(entries[`${PLUGIN_ID}/manifest.json`])).id !== PLUGIN_ID) fail("zip manifest id");
	if (mainJs.includes("WebAssembly") || workerSrc.includes("WebAssembly")) fail("bundle mentions WebAssembly");
	const p = await smokePlugin(mainJs, manifest);
	await smokeWorker(workerSrc);
	console.log(`plugin smoke: OK  zip layout, no WASM, onload -> running/inline -> unload (${p.commands} commands), worker ping/pong`);
}
