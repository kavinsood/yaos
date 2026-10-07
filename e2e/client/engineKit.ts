/**
 * Helpers for the engine e2e (engines.ts): checks + JSON report (no secrets), and headless LogEngines on
 * the production adapters: wsRelay + relayHttp (RelayPort), idbStorage on fake-indexeddb (one IDBFactory
 * per device, reused across restarts), suite-0 crypto, web clock/hash/random, in-memory side files.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { DeviceId, DocId, VaultId } from "../../src/core/types";
import { applyChanges, type ChangeSink } from "../../src/engine/body/textChanges";
import { createIdbStoragePort } from "../../src/engine/adapters/idbStorage";
import { createNoopCrypto } from "../../src/engine/adapters/noopCrypto";
import { createWebClock } from "../../src/engine/adapters/webClock";
import { createWebHash } from "../../src/engine/adapters/webHash";
import { createWebRandom } from "../../src/engine/adapters/webRandom";
import { createWsRelayPort } from "../../src/engine/adapters/wsRelay";
import { LogEngine } from "../../src/engine/runtime/engine";
import type { EngineTuning } from "../../src/engine/runtime/options";
import { MemSideFiles } from "../../src/engine/runtime/testHarness";
import { redact, type OnboardDevice, type OnboardedVault } from "./onboard";

// ---- checks + report ---------------------------------------------------------

interface Check { scenario: string; name: string; ok: boolean; detail: unknown }

export class Report {
	readonly checks: Check[] = [];
	readonly latencies: Record<string, number[]> = {};
	readonly timings: Record<string, number> = {};
	readonly extra: Record<string, unknown> = {};
	readonly started = new Date();
	private readonly t0 = performance.now();
	private scenario = "setup";
	private scenarioAt = 0;

	now(): number {
		return performance.now() - this.t0;
	}
	step(name: string): void {
		this.endStep();
		this.scenario = name;
		this.scenarioAt = this.now();
		console.log(`\n== ${name}`);
	}
	endStep(): void {
		if (this.scenario !== "setup") this.timings[this.scenario] = Math.round(this.now() - this.scenarioAt);
	}
	check(name: string, ok: boolean, detail: unknown = null): boolean {
		this.checks.push({ scenario: this.scenario, name, ok, detail: redact(detail) });
		console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(redact(detail))}`}`);
		return ok;
	}
	record(name: string, ms: number): void {
		(this.latencies[name] ??= []).push(Math.round(ms * 10) / 10);
	}

	/** Writes LOG_DIR/<prefix>-<label>-<stamp>.json; returns [path, failedCount]. */
	write(logDir: string, prefix: string, label: string, host: string, vault: OnboardedVault | null, fatal: string | null): [string, number] {
		this.endStep();
		let sha: string | null = null;
		try { sha = execFileSync("git", ["-C", new URL("../..", import.meta.url).pathname, "rev-parse", "--short", "HEAD"]).toString().trim(); }
		catch { /* not a checkout */ }
		const failed = this.checks.filter((c) => !c.ok);
		const scenarios: Record<string, { passed: number; failed: number; ms: number | null }> = {};
		for (const c of this.checks) {
			const e = (scenarios[c.scenario] ??= { passed: 0, failed: 0, ms: this.timings[c.scenario] ?? null });
			if (c.ok) e.passed++;
			else e.failed++;
		}
		const result = {
			label, host, startedAt: this.started.toISOString(), durationMs: Math.round(this.now()), sha,
			vault: vault ? { vaultIdPrefix: vault.vaultId.slice(0, 8), via: vault.via, devices: vault.devices.length } : null,
			passed: this.checks.length - failed.length, failed: failed.length, fatal, scenarios,
			latencyMs: Object.fromEntries(Object.entries(this.latencies).map(([k, v]) => [k, { ...summary(v), samples: v.length <= 60 ? v : undefined }])),
			extra: redact(this.extra), checks: this.checks,
		};
		let text = JSON.stringify(result, null, 2);
		const secrets = vault ? vault.devices.map((d) => d.deviceToken) : [];
		if (secrets.some((s) => text.includes(s))) {
			for (const s of secrets) text = text.split(s).join("<redacted>");
			console.log("FAIL results contained a device token (redacted before writing)");
			failed.push({ scenario: "report", name: "results contain no secrets", ok: false, detail: null });
		}
		mkdirSync(logDir, { recursive: true });
		const stamp = this.started.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
		const out = join(logDir, `${prefix}-${label.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}.json`);
		writeFileSync(out, text);
		console.log(`\n${Object.entries(scenarios).map(([n, s]) => `${s.failed ? "FAIL" : "ok  "} ${n} (${s.passed}/${s.passed + s.failed}, ${s.ms ?? "?"} ms)`).join("\n")}`);
		console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"}: ${this.checks.length - failed.length}/${this.checks.length} checks${fatal ? ` (fatal: ${fatal})` : ""}`);
		console.log(`results: ${out}`);
		return [out, failed.length];
	}
}

export function summary(values: number[]) {
	const s = [...values].sort((x, y) => x - y);
	const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
	return { n: s.length, min: s[0], p50: at(0.5), p95: at(0.95), max: s.at(-1) };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(pred: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
	const start = performance.now();
	for (;;) {
		if (await pred()) return;
		if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

// ---- devices -------------------------------------------------------------------

/** One device: its credentials, its IndexedDB (fake-indexeddb factory), side files and bound host docs. */
export class Device {
	factory = new IDBFactory();
	readonly side = new MemSideFiles();
	engine: LogEngine | null = null;
	/** Bound editors' texts: the bind text, then every onBoundText change (what main's editor would show). */
	readonly hosts = new Map<DocId, string>();
	private readonly waiters = new Set<() => void>();
	constructor(readonly name: string, readonly dev: OnboardDevice) {}

	get e(): LogEngine {
		if (!this.engine) throw new Error(`${this.name}: not started`);
		return this.engine;
	}

	async start(host: string, vaultId: string, tuning: Partial<EngineTuning>): Promise<LogEngine> {
		const clock = createWebClock();
		const random = createWebRandom();
		const hash = createWebHash();
		this.engine = await LogEngine.start({
			ports: {
				relay: createWsRelayPort({ baseUrl: host, credential: this.dev.deviceToken, clock, random }),
				storage: createIdbStoragePort(this.factory, IDBKeyRange),
				clock, random, crypto: createNoopCrypto(hash), hash, blob: null,
			},
			vaultId: vaultId as VaultId,
			deviceId: this.dev.deviceId as DeviceId,
			clientVersion: "wpc-e2e",
			sideFiles: this.side,
			tuning,
			e2ee: { suite: 0 },
			onBoundText: (id, changes, _length, origin) => {
				const text = this.hosts.get(id);
				if (text === undefined || origin === "editor") return; // "editor" = this device's own typing, already shown
				const v = { text };
				const sink: ChangeSink = {
					insert: (i, t) => void (v.text = v.text.slice(0, i) + t + v.text.slice(i)),
					delete: (i, n) => void (v.text = v.text.slice(0, i) + v.text.slice(i + n)),
				};
				applyChanges(sink, changes);
				this.hosts.set(id, v.text);
				for (const w of [...this.waiters]) w();
			},
		});
		this.hosts.clear();
		return this.engine;
	}

	async stop(): Promise<void> {
		await this.engine?.stop();
		this.engine = null;
	}

	/** Drop the IndexedDB (a new, empty factory); side files survive. */
	loseDb(): void {
		this.factory = new IDBFactory();
	}

	async bind(id: DocId): Promise<string> {
		await this.e.bind(id);
		const text = this.e.boundText(id);
		this.hosts.set(id, text);
		return text;
	}

	/** Type at the end of a bound doc like an editor: one change set (CodeMirror JSON), applied via applyEditorChanges. */
	type(id: DocId, s: string): void {
		const text = this.hosts.get(id);
		if (text === undefined) throw new Error(`${this.name}: ${id} not bound`);
		const changes = text.length > 0 ? [text.length, [0, ...s.split("\n")] as [number, ...string[]]] : [[0, ...s.split("\n")] as [number, ...string[]]];
		if (!this.e.applyEditorChanges(id, changes)) throw new Error(`${this.name}: ${id} editor out of sync`);
		this.hosts.set(id, text + s);
	}

	/** Resolves when the bound host doc's text satisfies pred (event-driven, no polling). */
	hostText(id: DocId, pred: (s: string) => boolean, timeoutMs: number): Promise<void> {
		if (!this.hosts.has(id)) return Promise.reject(new Error(`${this.name}: ${id} not bound`));
		return new Promise((resolve, reject) => {
			const check = () => {
				if (!pred(this.hosts.get(id) ?? "")) return;
				this.waiters.delete(check);
				clearTimeout(t);
				resolve();
			};
			const t = setTimeout(() => { this.waiters.delete(check); reject(new Error(`${this.name}: host text timeout`)); }, timeoutMs);
			this.waiters.add(check);
			check();
		});
	}
}

/** Every engine idle with equal live doc lists, paths and texts. Returns ms taken. */
export async function converge(ds: readonly Device[], timeoutMs = 30_000): Promise<number> {
	const t = performance.now();
	const sig = async (e: LogEngine) => {
		const docs = e.listDocs().filter((d) => d.state === "live").sort((a, b) => (a.docId < b.docId ? -1 : 1));
		const parts: string[] = [];
		for (const d of docs) parts.push(`${d.docId}|${d.path}|${await e.docText(d.docId)}`);
		return parts.join("\n");
	};
	await until(async () => {
		if (!ds.every((d) => d.e.isIdle())) return false;
		const first = await sig(ds[0]!.e);
		for (const d of ds.slice(1)) if ((await sig(d.e)) !== first) return false;
		return true;
	}, timeoutMs, `convergence of ${ds.map((d) => d.name).join(",")}`);
	return performance.now() - t;
}

/** Diagnostics-safe engine counters. */
export function engineStats(d: Device): Record<string, unknown> {
	const c = d.e.c;
	return {
		cursor: c.repo.cursor.vaultSeq, sess: c.sess.stats, sender: c.sender.stats, live: c.live.stats,
		maint: d.e.maint.stats, counts: d.e.status().counts, phase: d.e.status().phase,
	};
}
