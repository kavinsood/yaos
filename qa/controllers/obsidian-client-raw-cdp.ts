/**
 * RawCdpObsidianClient — Drop-in replacement for ObsidianClient using raw WebSocket CDP.
 *
 * Bypasses Playwright entirely to avoid Playwright/Electron version incompatibility.
 * Auto-discovers page WebSocket URLs from /json/list and selects the main Obsidian
 * renderer page (not blob workers, DevTools, or metadata cache workers).
 *
 * Implements the same public interface as ObsidianClient so it can be used
 * interchangeably in two-device.ts and other controllers.
 */

import WebSocket from "ws";

export interface RawCdpClientOptions {
	/** Chrome DevTools Protocol port Obsidian was launched with. Default: 9222 */
	port?: number;
	/** Hostname for CDP. Default: localhost */
	host?: string;
	/** Connection timeout in ms. Default: 15_000 */
	connectTimeoutMs?: number;
}

interface CdpTarget {
	id: string;
	title: string;
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}

export class RawCdpObsidianClient {
	private ws: WebSocket | null = null;
	private msgId = 0;
	private pending = new Map<number, (msg: unknown) => void>();
	private readonly port: number;
	private readonly host: string;
	private readonly connectTimeoutMs: number;

	constructor(opts: RawCdpClientOptions = {}) {
		this.port = opts.port ?? 9222;
		this.host = opts.host ?? "localhost";
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
	}

	/**
	 * Discover and connect to the main Obsidian renderer page.
	 * Selects the page whose title matches "* - Obsidian *" (the vault tab).
	 * Falls back to any "page" type target if no title match.
	 */
	async connect(): Promise<void> {
		const listUrl = `http://${this.host}:${this.port}/json/list`;
		const res = await fetch(listUrl);
		if (!res.ok) {
			throw new Error(`Failed to fetch ${listUrl}: ${res.status} ${res.statusText}`);
		}
		const targets: CdpTarget[] = await res.json();

		// Pick the main Obsidian page:
		// Priority 1: title contains "Obsidian" and type === "page"
		// Priority 2: url contains "obsidian.md/index.html"
		// Priority 3: first page-type target
		let target: CdpTarget | undefined;

		target = targets.find(
			(t) => t.type === "page" && t.title.includes("Obsidian") && !t.title.includes("DevTools"),
		);
		if (!target) {
			target = targets.find((t) => t.url.includes("obsidian.md/index.html"));
		}
		if (!target) {
			target = targets.find(
				(t) => t.type === "page" && !t.url.startsWith("blob:") && !t.title.includes("Worker"),
			);
		}

		if (!target) {
			throw new Error(
				`No suitable Obsidian page found on port ${this.port}. ` +
				`Targets: ${targets.map((t) => `${t.type}:"${t.title}"`).join(", ")}`,
			);
		}

		const wsUrl = target.webSocketDebuggerUrl;
		await this.connectWebSocket(wsUrl);
	}

	private connectWebSocket(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`WebSocket connection timeout (${this.connectTimeoutMs}ms) to ${url}`));
			}, this.connectTimeoutMs);

			this.ws = new WebSocket(url);

			this.ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});

			this.ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});

			this.ws.on("message", (data: Buffer) => {
				const msg = JSON.parse(data.toString()) as { id?: number; [key: string]: unknown };
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					this.pending.get(msg.id)!(msg);
					this.pending.delete(msg.id);
				}
			});
		});
	}

	/** Evaluate an expression string in the Obsidian renderer process. */
	async evalRaw<T = unknown>(expression: string): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("Not connected — call connect() first");
		}

		const id = ++this.msgId;

		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP eval timeout (60s) on port ${this.port}`));
			}, 60_000);

			this.pending.set(id, (msg: unknown) => {
				clearTimeout(timeout);
				const m = msg as {
					result?: {
						result?: { value?: unknown; type?: string };
						exceptionDetails?: { text?: string; exception?: { description?: string } };
					};
				};

				if (m.result?.exceptionDetails) {
					const details = m.result.exceptionDetails;
					const errMsg =
						details.exception?.description ||
						details.text ||
						JSON.stringify(details);
					reject(new Error(errMsg));
				} else {
					resolve(m.result?.result?.value as T);
				}
			});

			this.ws!.send(
				JSON.stringify({
					id,
					method: "Runtime.evaluate",
					params: {
						expression,
						awaitPromise: true,
						returnByValue: true,
					},
				}),
			);
		});
	}

	/**
	 * Evaluate a typed function in the Obsidian renderer.
	 * The function must be serializable (no closures over local variables).
	 */
	async evalInObsidian<T>(fn: () => T | Promise<T>): Promise<T> {
		return this.evalRaw<T>(`(${fn.toString()})()`);
	}

	/** Check that the YAOS debug API and harness API are available. */
	async isQaReady(): Promise<boolean> {
		try {
			return await this.evalRaw<boolean>(
				`!!(window.__YAOS_DEBUG__ && window.__YAOS_QA__)`,
			);
		} catch {
			return false;
		}
	}

	/** Wait until the QA APIs are available. */
	async waitForQaReady(timeoutMs = 30_000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (await this.isQaReady()) return;
			await new Promise((r) => setTimeout(r, 500));
		}
		throw new Error(`waitForQaReady timed out after ${timeoutMs}ms`);
	}

	/** Run a named scenario and return the result. */
	async runScenario(
		id: string,
		opts: { timeoutMs?: number } = {},
	): Promise<{
		passed: boolean;
		durationMs: number;
		errors: string[];
		warnings: string[];
	}> {
		const timeoutMs = opts.timeoutMs ?? 120_000;
		return this.evalRaw(`
			(async () => {
				const qa = window.__YAOS_QA__;
				if (!qa) throw new Error('__YAOS_QA__ not found');
				return qa.run(${JSON.stringify(id)}, ${JSON.stringify({ timeoutMs })});
			})()
		`);
	}

	/** Snapshot the vault manifest. */
	async manifest(): Promise<unknown> {
		return this.evalRaw(`window.__YAOS_QA__?.manifest()`);
	}

	/** Get YAOS debug state. */
	async debugState(): Promise<{
		localReady: boolean;
		providerSynced: boolean;
		reconciled: boolean;
		serverReceiptState: string;
		connectionState: string;
		activeMarkdownPaths: string[];
	}> {
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

	/** Start QA flight trace. */
	async startTrace(mode = "qa-safe"): Promise<void> {
		await this.evalRaw(`window.__YAOS_QA__?.startTrace(${JSON.stringify(mode)})`);
	}

	/** Stop flight trace and return export path. */
	async stopAndExportTrace(privacy: "safe" | "full" = "safe"): Promise<string> {
		return this.evalRaw<string>(`
			(async () => {
				const qa = window.__YAOS_QA__;
				if (!qa) throw new Error('__YAOS_QA__ not found');
				// Export while trace is still active, then stop.
				// Some flight recorder implementations require the trace to be active for export.
				const path = await qa.exportTrace(${JSON.stringify(privacy)});
				await qa.stopTrace();
				return path;
			})()
		`);
	}

	/** Collect build identity from a running instance. */
	async getBuildIdentity(): Promise<{
		pluginVersion: string;
		bundleHash: string;
		obsidianVersion: string;
		electronVersion: string;
		chromeVersion: string;
		platform: string;
		vaultName: string;
	}> {
		return this.evalRaw(`
			(async function() {
				const manifest = app.plugins?.plugins?.yaos?.manifest;
				let bundleHash = "unknown";
				try {
					const basePath = app.vault.adapter.basePath;
					const fs = require("fs");
					const crypto = require("crypto");
					const buf = fs.readFileSync(basePath + "/.obsidian/plugins/yaos/main.js");
					bundleHash = crypto.createHash("sha256").update(buf).digest("hex");
				} catch (e) { /* mobile or missing */ }
				return {
					pluginVersion: manifest?.version ?? "unknown",
					bundleHash: bundleHash,
					obsidianVersion: navigator.userAgent.match(/Obsidian\\/([\\d.]+)/)?.[1] ?? "unknown",
					electronVersion: typeof process !== "undefined" ? process?.versions?.electron ?? "unknown" : "unknown",
					chromeVersion: typeof process !== "undefined" ? process?.versions?.chrome ?? "unknown" : "unknown",
					platform: typeof process !== "undefined" ? process?.platform ?? "unknown" : navigator.platform ?? "unknown",
					vaultName: app.vault?.getName?.() ?? "unknown",
				};
			})()
		`);
	}

	async close(): Promise<void> {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.pending.clear();
	}
}
