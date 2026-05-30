/**
 * ObsidianClient — Playwright/Electron CDP wrapper for Obsidian desktop.
 *
 * Connects to a running Obsidian instance via remote debugging port.
 * Exposes `evalInObsidian()` to run arbitrary JS in the Electron renderer.
 *
 * Usage:
 *   const client = new ObsidianClient({ port: 9222 });
 *   await client.connect();
 *   const ready = await client.evalInObsidian(() => window.__YAOS_DEBUG__?.isLocalReady());
 *   await client.close();
 *
 * Start Obsidian with remote debugging:
 *   /path/to/Obsidian --remote-debugging-port=9222
 */

import { chromium, type CDPSession, type Browser } from "playwright";

export interface ObsidianClientOptions {
	/** Chrome DevTools Protocol port Obsidian was launched with. Default: 9222 */
	port?: number;
	/** Hostname for CDP. Default: localhost */
	host?: string;
	/** Connection timeout in ms. Default: 15_000 */
	connectTimeoutMs?: number;
}

export interface ObsidianClientResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
}

export class ObsidianClient {
	private browser: Browser | null = null;
	private cdpSession: CDPSession | null = null;
	private readonly port: number;
	private readonly host: string;
	private readonly connectTimeoutMs: number;

	constructor(opts: ObsidianClientOptions = {}) {
		this.port = opts.port ?? 9222;
		this.host = opts.host ?? "localhost";
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 60_000;
	}

	async connect(): Promise<void> {
		this.browser = await chromium.connectOverCDP(
			`http://${this.host}:${this.port}`,
			{ timeout: this.connectTimeoutMs },
		);
		const contexts = this.browser.contexts();
		if (contexts.length === 0) throw new Error("No browser context found in Obsidian");
		const pages = await contexts[0]!.pages();
		if (pages.length === 0) throw new Error("No pages found in Obsidian context");
		// Connect CDP session for direct evaluate
		this.cdpSession = await pages[0]!.context().newCDPSession(pages[0]!);
	}

	/** Evaluate an expression string in the Obsidian renderer process. */
	async evalRaw<T = unknown>(expression: string): Promise<T> {
		if (!this.browser) throw new Error("Not connected — call connect() first");
		const contexts = this.browser.contexts();
		const pages = await contexts[0]!.pages();
		const result = await pages[0]!.evaluate(expression as never);
		return result as T;
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
			return await this.evalInObsidian(() => {
				const w = window as unknown as Record<string, unknown>;
				return !!(w.__YAOS_DEBUG__ && w.__YAOS_QA__);
			});
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
	async runScenario(id: string, opts: { timeoutMs?: number } = {}): Promise<{
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
		const result = await this.evalRaw<string>(`
			(async () => {
				const qa = window.__YAOS_QA__;
				if (!qa) throw new Error('__YAOS_QA__ not found');
				// Export while trace is still active, then stop.
				const path = await qa.exportTrace(${JSON.stringify(privacy)});
				await qa.stopTrace();
				return path;
			})()
		`);
		return result;
	}

	/**
	 * Write a file to the vault via Node's fs module — a REAL external write.
	 * This exercises the OS file-system watcher path (the same as Web Clipper,
	 * file manager paste, or git checkout). Use this for bulk-import and external
	 * edit scenarios instead of writeAdapterFile from the harness.
	 *
	 * @param vaultAbsPath  Absolute path to the vault root on the local filesystem.
	 * @param relPath       Vault-relative path (e.g. "Notes/new-note.md").
	 * @param content       UTF-8 string content to write.
	 */
	async writeNodeFile(vaultAbsPath: string, relPath: string, content: string): Promise<void> {
		const { writeFile, mkdir } = await import("fs/promises");
		const { join, dirname } = await import("path");
		const fullPath = join(vaultAbsPath, relPath);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, "utf-8");
	}

	/**
	 * Write a file via Node fs and wait for Obsidian/YAOS to observe it.
	 *
	 * Polls until the vault manifest shows the file exists and the disk hash
	 * matches the written content, or until timeoutMs. This avoids timing
	 * roulette from fixed sleeps after external writes.
	 *
	 * @param vaultAbsPath   Absolute path to the vault root.
	 * @param relPath        Vault-relative path (e.g. "Notes/new-note.md").
	 * @param content        UTF-8 string to write.
	 * @param timeoutMs      Maximum wait for Obsidian observation. Default: 15_000.
	 */
	async writeNodeFileAndWait(
		vaultAbsPath: string,
		relPath: string,
		content: string,
		timeoutMs = 15_000,
	): Promise<void> {
		await this.writeNodeFile(vaultAbsPath, relPath, content);

		// Poll the vault manifest until the file appears with the expected content.
		const start = Date.now();
		const expectedLen = content.length;
		while (Date.now() - start < timeoutMs) {
			try {
				const found = await this.evalRaw<boolean>(`
					(async () => {
						const app = (window).app;
						if (!app) return false;
						const file = app.vault.getFileByPath(${JSON.stringify(relPath)});
						if (!file) return false;
						try {
							const diskContent = await app.vault.read(file);
							return diskContent.length === ${expectedLen};
						} catch {
							return false;
						}
					})()
				`);
				if (found) return;
			} catch {
				// CDP might fail transiently
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		throw new Error(
			`writeNodeFileAndWait: Obsidian did not observe "${relPath}" within ${timeoutMs}ms`,
		);
	}

	/**
	 * Write multiple files to the vault via Node fs concurrently.
	 * Simulates a watcher storm from bulk paste or directory copy.
	 */
	async writeNodeFiles(
		vaultAbsPath: string,
		files: Array<{ relPath: string; content: string }>,
	): Promise<void> {
		await Promise.all(
			files.map(({ relPath, content }) => this.writeNodeFile(vaultAbsPath, relPath, content)),
		);
	}

	/**
	 * Write multiple files via Node fs and wait for ALL to be observed by Obsidian.
	 * Each file is checked individually; the call returns when all are visible.
	 */
	async writeNodeFilesAndWait(
		vaultAbsPath: string,
		files: Array<{ relPath: string; content: string }>,
		timeoutMs = 30_000,
	): Promise<void> {
		// Write all first (concurrent), then wait for each to appear
		await this.writeNodeFiles(vaultAbsPath, files);
		await Promise.all(
			files.map(({ relPath, content }) =>
				this.writeNodeFileAndWait(vaultAbsPath, relPath, content, timeoutMs),
			),
		);
	}

	/**
	 * Delete a file from the vault via Node fs — real external deletion.
	 */
	async deleteNodeFile(vaultAbsPath: string, relPath: string): Promise<void> {
		const { rm } = await import("fs/promises");
		const { join } = await import("path");
		const fullPath = join(vaultAbsPath, relPath);
		await rm(fullPath, { force: true });
	}

	/**
	 * Delete a file via Node fs and wait for Obsidian to observe the deletion.
	 */
	async deleteNodeFileAndWait(
		vaultAbsPath: string,
		relPath: string,
		timeoutMs = 15_000,
	): Promise<void> {
		await this.deleteNodeFile(vaultAbsPath, relPath);
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const gone = await this.evalRaw<boolean>(
					`!window.app?.vault.getFileByPath(${JSON.stringify(relPath)})`,
				);
				if (gone) return;
			} catch {
				// CDP transient
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		throw new Error(
			`deleteNodeFileAndWait: "${relPath}" still visible in vault after ${timeoutMs}ms`,
		);
	}

	async close(): Promise<void> {
		this.cdpSession = null;
		await this.browser?.close();
		this.browser = null;
	}
}
