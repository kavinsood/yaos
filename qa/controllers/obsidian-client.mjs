import WebSocket from "ws";

export function selectObsidianTarget(targets) {
	if (!Array.isArray(targets)) return null;
	return targets.find((candidate) =>
		candidate?.type === "page" && candidate.url?.includes("obsidian.md/index.html"))
		?? targets.find((candidate) =>
			candidate?.type === "page"
			&& candidate.title?.includes("Obsidian")
			&& !candidate.title.includes("DevTools")
			&& candidate.url !== "about:blank")
		?? targets.find((candidate) =>
			candidate?.type === "page"
			&& !candidate.url?.startsWith("blob:")
			&& candidate.url !== "about:blank"
			&& !candidate.title?.includes("Worker"))
		?? null;
}

/** Raw Chrome DevTools Protocol client for live Obsidian renderer automation. */
export class ObsidianClient {
	#ws = null;
	#messageId = 0;
	#pending = new Map();
	#port;
	#host;
	#connectTimeoutMs;

	constructor({ port = 9222, host = "localhost", connectTimeoutMs = 15_000 } = {}) {
		this.#port = port;
		this.#host = host;
		this.#connectTimeoutMs = connectTimeoutMs;
	}

	async connect() {
		const listUrl = `http://${this.#host}:${this.#port}/json/list`;
		let response;
		try {
			response = await fetch(listUrl);
		} catch (error) {
			throw new Error(
				`QA Obsidian runtime not available at ${listUrl}. ` +
				`Start Obsidian with --remote-debugging-port=${this.#port}. ${String(error)}`,
			);
		}
		if (!response.ok) {
			throw new Error(`GET ${listUrl} returned ${response.status} ${response.statusText}`);
		}

		const targets = await response.json();
		const target = selectObsidianTarget(targets);
		if (!target?.webSocketDebuggerUrl) {
			throw new Error(
				`No suitable Obsidian renderer found on port ${this.#port}. Targets: ` +
				(targets.map((candidate) => `${candidate.type}:"${candidate.title}"`).join(", ") || "(none)"),
			);
		}
		await this.#connectWebSocket(target.webSocketDebuggerUrl);
	}

	#connectWebSocket(url) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`WebSocket connection timeout (${this.#connectTimeoutMs}ms) to ${url}`)),
				this.#connectTimeoutMs,
			);
			const ws = new WebSocket(url);
			this.#ws = ws;
			ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});
			ws.on("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			ws.on("message", (data) => {
				const message = JSON.parse(data.toString());
				const complete = message.id === undefined ? undefined : this.#pending.get(message.id);
				if (complete) {
					this.#pending.delete(message.id);
					complete(message);
				}
			});
		});
	}

	async evalRaw(expression, timeoutMs = 60_000) {
		if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected — call connect() first");
		}
		const id = ++this.#messageId;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`CDP eval timeout (${timeoutMs}ms) on port ${this.#port}`));
			}, timeoutMs);
			this.#pending.set(id, (message) => {
				clearTimeout(timeout);
				const details = message.result?.exceptionDetails;
				if (details) {
					reject(new Error(details.exception?.description || details.text || JSON.stringify(details)));
					return;
				}
				resolve(message.result?.result?.value);
			});
			this.#ws.send(JSON.stringify({
				id,
				method: "Runtime.evaluate",
				params: { expression, awaitPromise: true, returnByValue: true },
			}));
		});
	}

	async evalInObsidian(fn) {
		return this.evalRaw(`(${fn.toString()})()`);
	}

	async isQaReady() {
		try {
			return await this.evalRaw(`!!(window.__YAOS_DEBUG__ && window.__YAOS_QA__)`);
		} catch {
			return false;
		}
	}

	async waitForQaReady(timeoutMs = 30_000) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (await this.isQaReady()) return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error(`waitForQaReady timed out after ${timeoutMs}ms`);
	}

	async runScenario(id) {
		return this.evalRaw(`
			(async () => {
				const qa = window.__YAOS_QA__;
				if (!qa) throw new Error('__YAOS_QA__ not found');
				return qa.run(${JSON.stringify(id)});
			})()
		`, 10 * 60_000);
	}

	async manifest() {
		return this.evalRaw(`window.__YAOS_QA__?.manifest()`);
	}

	async debugState() {
		return this.evalRaw(`
			(function() {
				const d = window.__YAOS_DEBUG__;
				if (!d) return null;
				return {
					localReady: d.isLocalReady(),
					providerSynced: d.isProviderSynced(),
					reconciled: d.isReconciled(),
					serverReceiptState: d.getServerReceiptState(),
					connectionState: d.getConnectionState(),
					activeMarkdownPaths: d.getActiveMarkdownPaths(),
				};
			})()
		`);
	}

	async exportTrace(privacy = "safe") {
		return this.evalRaw(`
			(async () => {
				const qa = window.__YAOS_QA__;
				if (!qa) throw new Error('__YAOS_QA__ not found');
				return qa.exportTrace(${JSON.stringify(privacy)});
			})()
		`);
	}

	async getBuildIdentity() {
		return this.evalRaw(`
			(async function() {
				const manifest = app.plugins?.plugins?.yaos?.manifest;
				let bundleHash = "unknown";
				try {
					const basePath = app.vault.adapter.basePath;
					const fs = require("fs");
					const crypto = require("crypto");
					const bytes = fs.readFileSync(basePath + "/.obsidian/plugins/yaos/main.js");
					bundleHash = crypto.createHash("sha256").update(bytes).digest("hex");
				} catch {}
				return {
					pluginVersion: manifest?.version ?? "unknown",
					bundleHash,
					obsidianVersion: navigator.userAgent.match(/Obsidian\\/([\\d.]+)/)?.[1] ?? "unknown",
					electronVersion: typeof process !== "undefined" ? process?.versions?.electron ?? "unknown" : "unknown",
					chromeVersion: typeof process !== "undefined" ? process?.versions?.chrome ?? "unknown" : "unknown",
					platform: typeof process !== "undefined" ? process?.platform ?? "unknown" : navigator.platform ?? "unknown",
					vaultName: app.vault?.getName?.() ?? "unknown",
				};
			})()
		`);
	}

	async close() {
		this.#ws?.close();
		this.#ws = null;
		this.#pending.clear();
	}
}
