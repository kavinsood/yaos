// Test doubles for the production bundle smoke (scripts/plugin-smoke.mjs):
//   - obsidianStub: the parts of the "obsidian" module main.js touches at load/onload;
//   - el / eventTarget: minimal DOM elements, document and window;
//   - SmokeWorker: a `Worker` for node. `new SmokeWorker(blobUrl)` reads the Blob
//     the host built and runs it in a node:worker_threads thread set up like a
//     classic DedicatedWorkerGlobalScope (self, postMessage, addEventListener,
//     close, importScripts, its own fake-indexeddb). Messages cross a real
//     thread boundary (structured clone, transfer lists). Every script it was
//     given is kept in `workerScripts` so the smoke can check what ran.
import { resolveObjectURL } from "node:buffer";
import { Worker as NodeWorker } from "node:worker_threads";

export function el() {
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

export function eventTarget(extra) {
	const ls = new Map();
	return {
		...extra,
		addEventListener: (t, l) => ls.set(t, [...(ls.get(t) ?? []), l]),
		removeEventListener: (t, l) => ls.set(t, (ls.get(t) ?? []).filter((x) => x !== l)),
		listeners: (t) => (ls.get(t) ?? []).length,
	};
}

export function obsidianStub(saved, fail) {
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
		registerObsidianProtocolHandler(a) {
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

/** Runs inside the worker thread (CommonJS, `eval: true`). */
const WORKER_BOOT = `
const { parentPort, workerData } = require("node:worker_threads");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const { IDBFactory, IDBKeyRange } = createRequire(workerData.base)("fake-indexeddb");
const listeners = [];
Object.assign(globalThis, {
	self: globalThis,
	indexedDB: new IDBFactory(),
	IDBKeyRange,
	importScripts() {},
	postMessage: (m, t) => parentPort.postMessage(m, t),
	addEventListener: (type, l) => { if (type === "message") listeners.push(l); },
	removeEventListener: (type, l) => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
	close: () => process.exit(0),
});
parentPort.on("message", (data) => { for (const l of [...listeners]) l({ data }); });
vm.runInThisContext(workerData.script, { filename: "yaos-engine-worker.js" });
`;

export const workerScripts = [];

export class SmokeWorker {
	/** A path inside the repo; the worker thread resolves fake-indexeddb from it. Set before use. */
	static base = null;

	constructor(url) {
		const blob = resolveObjectURL(String(url));
		if (!blob) throw new Error(`SmokeWorker: not a live blob URL: ${url}`);
		this.ls = { message: [], error: [], messageerror: [] };
		this.queue = [];
		this.thread = null;
		this.dead = false;
		blob.text().then((script) => {
			workerScripts.push(script);
			if (this.dead) return;
			const t = new NodeWorker(WORKER_BOOT, { eval: true, workerData: { script, base: SmokeWorker.base } });
			t.on("message", (data) => this.emit("message", { data }));
			t.on("error", (e) => this.emit("error", { type: "error", message: e instanceof Error ? e.message : String(e) }));
			t.on("messageerror", () => this.emit("messageerror", { type: "messageerror" }));
			this.thread = t;
			for (const m of this.queue.splice(0)) t.postMessage(m);
		});
	}

	emit(type, ev) {
		if (this.dead) return;
		for (const l of [...this.ls[type]]) l(ev);
	}

	postMessage(message, transfer) {
		if (this.dead) return;
		if (this.thread) this.thread.postMessage(message, transfer);
		// Not started yet: detach the transferred buffers now, like a real Worker.
		else this.queue.push(structuredClone(message, { transfer: transfer ?? [] }));
	}

	addEventListener(type, l) {
		this.ls[type]?.push(l);
	}

	removeEventListener(type, l) {
		const a = this.ls[type];
		if (a) this.ls[type] = a.filter((x) => x !== l);
	}

	terminate() {
		this.dead = true;
		void this.thread?.terminate();
	}
}
