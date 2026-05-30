#!/usr/bin/env node
/**
 * run-smoke-ready.mjs — P4C QA harness liveness smoke controller
 *
 * Connects to a running Obsidian instance via Chrome DevTools Protocol and:
 *
 *   1. Checks Obsidian is reachable on the CDP port (fail loudly if not)
 *   2. Waits for waitForQaReady() to pass (both globals must exist)
 *   3. Verifies window.__YAOS_DEBUG__ is mounted
 *   4. Verifies window.__YAOS_QA__ is mounted
 *   5. Verifies QA product build is loaded (getEngineControlPort callable)
 *   6. Verifies harness plugin is loaded (yaos-qa-harness plugin found)
 *   7. Runs scenario smoke-trace-export via qa.run("smoke-trace-export")
 *   8. Asserts result.passed === true
 *   9. Asserts result.tracePath is a non-null, non-empty string
 *  10. Optionally verifies the trace file exists on disk (if QA_VAULT_PATH is set)
 *
 * Usage:
 *   node qa/controllers/run-smoke-ready.mjs
 *
 * Environment variables:
 *   QA_CDP_PORT     CDP port Obsidian was launched with (default: 9222)
 *   QA_CDP_HOST     CDP host (default: localhost)
 *   QA_VAULT_PATH   Absolute path to the QA vault root (optional; enables disk check)
 *   QA_TIMEOUT_MS   waitForQaReady timeout in ms (default: 30000)
 *
 * Start Obsidian with remote debugging:
 *   /path/to/Obsidian --remote-debugging-port=9222
 *
 * Exit 0 = PASS. Exit 1 = FAIL.
 */

import WebSocket from "ws";
import { existsSync } from "fs";
import { resolve, join } from "path";

const PORT = parseInt(process.env.QA_CDP_PORT ?? "9222", 10);
const HOST = process.env.QA_CDP_HOST ?? "localhost";
const VAULT_PATH = process.env.QA_VAULT_PATH ? resolve(process.env.QA_VAULT_PATH) : null;
const QA_TIMEOUT_MS = parseInt(process.env.QA_TIMEOUT_MS ?? "30000", 10);
const SCENARIO_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Minimal raw-CDP client (no Playwright dependency)
// ---------------------------------------------------------------------------

class CdpClient {
	ws = null;
	msgId = 0;
	pending = new Map();

	async connect(port, host) {
		const listUrl = `http://${host}:${port}/json/list`;
		let res;
		try {
			res = await fetch(listUrl);
		} catch (e) {
			throw new Error(
				`QA Obsidian runtime not available; start Obsidian with remote debugging.\n` +
				`  Expected CDP at http://${host}:${port}\n` +
				`  Error: ${e.message}`,
			);
		}
		if (!res.ok) {
			throw new Error(
				`QA Obsidian runtime not available; start Obsidian with remote debugging.\n` +
				`  GET ${listUrl} returned ${res.status} ${res.statusText}`,
			);
		}

		const targets = await res.json();

		// Pick main Obsidian renderer page (not DevTools, not blob workers)
		let target =
			targets.find(
				(t) => t.type === "page" && t.title.includes("Obsidian") && !t.title.includes("DevTools"),
			) ??
			targets.find((t) => t.url?.includes("obsidian.md/index.html")) ??
			targets.find(
				(t) =>
					t.type === "page" &&
					!t.url?.startsWith("blob:") &&
					!t.title?.includes("Worker"),
			);

		if (!target) {
			throw new Error(
				`QA Obsidian runtime not available; start Obsidian with remote debugging.\n` +
				`  No suitable Obsidian renderer page found on port ${port}.\n` +
				`  Targets found: ${targets.map((t) => `${t.type}:"${t.title}"`).join(", ") || "(none)"}`,
			);
		}

		await this._connectWs(target.webSocketDebuggerUrl);
	}

	_connectWs(url) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`WebSocket connection timeout (15s) to ${url}`));
			}, 15_000);

			this.ws = new WebSocket(url);

			this.ws.on("open", () => {
				clearTimeout(timeout);
				resolve();
			});

			this.ws.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});

			this.ws.on("message", (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					this.pending.get(msg.id)(msg);
					this.pending.delete(msg.id);
				}
			});
		});
	}

	async eval(expression, timeoutMs = 60_000) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("CDP not connected");
		}
		const id = ++this.msgId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP eval timeout (${timeoutMs}ms)`));
			}, timeoutMs);

			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				if (msg.result?.exceptionDetails) {
					const d = msg.result.exceptionDetails;
					reject(new Error(d.exception?.description || d.text || JSON.stringify(d)));
				} else {
					resolve(msg.result?.result?.value);
				}
			});

			this.ws.send(
				JSON.stringify({
					id,
					method: "Runtime.evaluate",
					params: { expression, awaitPromise: true, returnByValue: true },
				}),
			);
		});
	}

	async close() {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.pending.clear();
	}
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const INFO = "\x1b[36mINFO\x1b[0m";

function log(level, msg) {
	const ts = new Date().toISOString().slice(11, 23);
	console.log(`[${ts}] ${level} ${msg}`);
}

function check(label, passed, detail = "") {
	log(passed ? PASS : FAIL, `${label}${detail ? `  — ${detail}` : ""}`);
	return passed;
}

// ---------------------------------------------------------------------------
// P4C smoke
// ---------------------------------------------------------------------------

async function main() {
	log(INFO, `P4C QA liveness smoke  port=${PORT} host=${HOST}`);
	if (VAULT_PATH) log(INFO, `Vault path: ${VAULT_PATH}`);
	else log(INFO, "QA_VAULT_PATH not set — disk trace-file check will be skipped");

	const client = new CdpClient();
	const failures = [];

	function require(label, passed, detail = "") {
		if (!check(label, passed, detail)) failures.push(label);
		return passed;
	}

	try {
		// ----------------------------------------------------------------
		// 0. Connect to Obsidian
		// ----------------------------------------------------------------
		log(INFO, `Connecting to CDP at http://${HOST}:${PORT} …`);
		await client.connect(PORT, HOST);
		log(INFO, "CDP connected.");

		// ----------------------------------------------------------------
		// 1. waitForQaReady
		// ----------------------------------------------------------------
		log(INFO, `Waiting for QA APIs (timeout ${QA_TIMEOUT_MS}ms) …`);
		const start = Date.now();
		let qaReady = false;
		while (Date.now() - start < QA_TIMEOUT_MS) {
			try {
				qaReady = await client.eval(`!!(window.__YAOS_DEBUG__ && window.__YAOS_QA__)`, 5_000);
				if (qaReady) break;
			} catch {
				// transient CDP error — keep polling
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		require("waitForQaReady()", qaReady, qaReady ? "" : `timed out after ${QA_TIMEOUT_MS}ms`);

		if (!qaReady) {
			log(
				FAIL,
				"QA APIs never appeared. Likely causes:\n" +
				"  - Product plugin not loaded (yaos)\n" +
				"  - QA product build (product-main.js) not installed — production main.js loaded instead\n" +
				"  - Harness plugin not loaded (yaos-qa-harness)\n" +
				"  - qaDebugMode not enabled in vault settings\n" +
				"  - Harness plugin loaded before product plugin (check community-plugins.json order)",
			);
			process.exit(1);
		}

		// ----------------------------------------------------------------
		// 2–3. Check both globals explicitly
		// ----------------------------------------------------------------
		const debugExists = await client.eval(`typeof window.__YAOS_DEBUG__ !== "undefined" && window.__YAOS_DEBUG__ !== null`);
		require("window.__YAOS_DEBUG__ exists", debugExists);

		const qaExists = await client.eval(`typeof window.__YAOS_QA__ !== "undefined" && window.__YAOS_QA__ !== null`);
		require("window.__YAOS_QA__ exists", qaExists);

		// ----------------------------------------------------------------
		// 4. QA product build loaded (getEngineControlPort callable)
		// ----------------------------------------------------------------
		const hasEngineControlPort = await client.eval(
			`typeof app?.plugins?.plugins?.["yaos"]?.getEngineControlPort === "function"`,
		);
		require(
			"QA product build loaded (getEngineControlPort)",
			hasEngineControlPort,
			hasEngineControlPort ? "" : "production main.js may be loaded instead of product-main.js",
		);

		// ----------------------------------------------------------------
		// 5. Harness plugin loaded
		// ----------------------------------------------------------------
		const harnessLoaded = await client.eval(
			`app?.plugins?.plugins?.["yaos-qa-harness"] != null`,
		);
		require("Harness plugin loaded (yaos-qa-harness)", harnessLoaded);

		// Bail out of scenario run if the basic checks failed
		if (failures.length > 0) {
			log(FAIL, `${failures.length} pre-conditions failed — skipping scenario run`);
			process.exit(1);
		}

		// ----------------------------------------------------------------
		// 6. Run scenario smoke-trace-export
		// ----------------------------------------------------------------
		log(INFO, `Running scenario: smoke-trace-export (timeout ${SCENARIO_TIMEOUT_MS}ms) …`);
		const result = await client.eval(
			`(async () => {
				const qa = window.__YAOS_QA__;
				if (!qa) throw new Error('__YAOS_QA__ not found');
				return qa.run("smoke-trace-export", { timeoutMs: ${SCENARIO_TIMEOUT_MS} });
			})()`,
			SCENARIO_TIMEOUT_MS + 10_000,
		);

		if (!result) {
			require("scenario smoke-trace-export: returned result", false, "qa.run() returned null/undefined");
			process.exit(1);
		}

		const scenarioPassed = result.passed === true;
		require(
			"scenario smoke-trace-export: passed",
			scenarioPassed,
			scenarioPassed
				? `${result.durationMs}ms`
				: `errors: ${(result.errors ?? []).join("; ") || "(none logged)"}`,
		);

		if (!scenarioPassed && result.errors?.length) {
			for (const e of result.errors) log(FAIL, `  scenario error: ${e}`);
		}
		if (result.warnings?.length) {
			for (const w of result.warnings) log(INFO, `  warning: ${w}`);
		}

		// ----------------------------------------------------------------
		// 7. tracePath is non-null and non-empty
		// ----------------------------------------------------------------
		const tracePath = result.tracePath;
		const tracePathValid =
			typeof tracePath === "string" && tracePath.trim().length > 0;
		require(
			"result.tracePath non-null",
			tracePathValid,
			tracePathValid ? tracePath : `got: ${JSON.stringify(tracePath)}`,
		);

		// ----------------------------------------------------------------
		// 8. Trace file exists on disk (optional — requires QA_VAULT_PATH)
		// ----------------------------------------------------------------
		if (tracePathValid && VAULT_PATH) {
			// tracePath may be absolute or vault-relative
			// tracePath is vault-relative (e.g. ".obsidian/plugins/yaos/diagnostics/...")
			// or absolute. Join with vault root directly — do not prepend .obsidian again.
			const absTracePath = tracePath.startsWith("/")
				? tracePath
				: join(VAULT_PATH, tracePath);
			const fileExists = existsSync(absTracePath);
			require(
				"trace file exists on disk",
				fileExists,
				fileExists ? absTracePath : `not found at: ${absTracePath}`,
			);
		} else if (tracePathValid && !VAULT_PATH) {
			log(INFO, `trace file disk check skipped (set QA_VAULT_PATH to enable)`);
		}

		// ----------------------------------------------------------------
		// 9. stopTrace (clean up — stop the harness-managed trace)
		// ----------------------------------------------------------------
		try {
			await client.eval(`(async () => { await window.__YAOS_QA__?.stopTrace(); })()`, 10_000);
			check("stopTrace()", true);
		} catch (e) {
			// Not fatal — trace may have already been stopped by the scenario runner
			log(INFO, `stopTrace() warning (non-fatal): ${e.message}`);
		}

	} catch (err) {
		log(FAIL, `Unexpected error: ${err.message}`);
		if (err.message.includes("not available")) {
			// Already printed helpful context inside connect()
		}
		failures.push(`unexpected: ${err.message}`);
	} finally {
		await client.close();
	}

	// ----------------------------------------------------------------
	// Summary
	// ----------------------------------------------------------------
	console.log("");
	if (failures.length === 0) {
		console.log(`\x1b[32m✓ P4C smoke PASSED\x1b[0m`);
		process.exit(0);
	} else {
		console.log(`\x1b[31m✗ P4C smoke FAILED  (${failures.length} check(s) failed)\x1b[0m`);
		for (const f of failures) console.log(`  - ${f}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`\x1b[31mFATAL:\x1b[0m ${err.message}`);
	process.exit(1);
});
