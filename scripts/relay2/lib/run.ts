/**
 * Scenario runtime: context, device clients, fresh fixtures, frame-coverage tracking, tail capture.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { readFrozenFrames, readTraceManifest } from "../../pathology-lab/trace";
import type { LiveIdentity } from "../../../tests/live/liveIdentity";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { EXP_ROOT, LOG_DIR, type Args, flagNum, flagStr, log, now, r2, sleep, workerName } from "./common";
import { type Context, createBodyFromUpdate, device, refreshOperatorCookie, seedNotes, smallContent } from "./context";
import { RawClient, type ProtocolAdapter } from "./rawClient";

export const QUICK_TRACE_DIR = join(EXP_ROOT, "logs/A5-trace-quick");

export interface RunCtx {
	host: string;
	context: Context;
	args: Args;
	adapter: ProtocolAdapter;
	scenario: string;
	/** Run tag used for fresh body ids. */
	tag: string;
	n(fallback: number): number;
	num(name: string, fallback: number): number;
	str(name: string, fallback?: string): string | undefined;
	dev(name: string): Promise<LiveIdentity>;
	client(deviceName: string, bodyId: string, doc?: Y.Doc): Promise<RawClient>;
	/** Record a note for the output JSON. */
	notes: string[];
}

export function makeCtx(host: string, context: Context, args: Args, adapter: ProtocolAdapter, scenario: string): RunCtx {
	const tag = `${scenario.toLowerCase()}-${Date.now().toString(36)}`;
	const ctx: RunCtx = {
		host, context, args, adapter, scenario, tag, notes: [],
		n: (fallback) => flagNum(args, "n", fallback),
		num: (name, fallback) => flagNum(args, name, fallback),
		str: (name, fallback) => flagStr(args, name, fallback),
		dev: (name) => device(context, name),
		client: async (deviceName, bodyId, doc) => new RawClient(await device(context, deviceName), bodyId, doc, adapter),
	};
	return ctx;
}

export async function openOrThrow(client: RawClient, timeoutMs = 30_000) {
	const outcome = await client.open(timeoutMs);
	if (outcome.status !== "ok") throw new Error(`open ${client.body} failed: ${JSON.stringify(outcome)}`);
	return client;
}

/** Reopen a client (same doc) if its socket closed, e.g. before a convergence check. */
export async function ensureOpen(client: RawClient) {
	if (!client.isOpen) await client.open(30_000);
	return client;
}

/** Create fresh notes via the production import path; returns body ids. */
export async function freshNotes(ctx: RunCtx, prefix: string, count: number, content: (i: number) => string): Promise<string[]> {
	const ids = Array.from({ length: count }, (_v, i) => `${ctx.tag}-${prefix}-${i}`.replace(/[^A-Za-z0-9_-]/g, "-"));
	await seedNotes(ctx.context, ids.map((bodyId, i) => ({ bodyId, path: `R2/${ctx.tag}/${prefix}-${i}.md`, content: content(i) })));
	return ids;
}

export async function freshSmallNote(ctx: RunCtx, bytes = 4096) {
	return (await freshNotes(ctx, "note", 1, () => smallContent(7, bytes)))[0]!;
}

export interface Trace { dir: string; base: Uint8Array; frames: Uint8Array[]; finalSha: string; baseChars: number }
export function loadTrace(dir = QUICK_TRACE_DIR): Trace {
	const manifest = readTraceManifest(dir);
	return { dir, base: new Uint8Array(readFileSync(join(dir, "base.update"))), frames: [...readFrozenFrames(join(dir, "updates.bin"))],
		finalSha: manifest.final.textSha256, baseChars: manifest.base.textCodeUnits };
}

/** Fresh body whose server state is exactly the trace base (64k chars for quick). */
export async function freshTraceBody(ctx: RunCtx, trace: Trace, suffix = "trace") {
	const id = `${ctx.tag}-${suffix}`;
	await createBodyFromUpdate(ctx.context.devices.A!, id, `R2/${ctx.tag}/${suffix}.md`, trace.base);
	return id;
}

/**
 * Tracks when a receiving doc first contains each sent frame (struct clocks and delete set), which
 * is exact even when the server coalesces or splits broadcasts.
 */
export class CoverageTracker {
	private pending: Array<{ index: number; update: Uint8Array; sentAt: number; resolve?: (ms: number | null) => void }> = [];
	readonly coveredMs: Array<number | null> = [];
	private readonly handler = () => this.check();
	constructor(readonly receiver: Y.Doc) { receiver.on("update", this.handler); }
	sent(index: number, update: Uint8Array, sentAt: number) {
		this.coveredMs[index] = null;
		this.pending.push({ index, update, sentAt });
	}
	/** Track one frame and resolve with its propagation ms (null on timeout). */
	sentAndWait(index: number, update: Uint8Array, sentAt: number, timeoutMs: number): Promise<number | null> {
		return new Promise((resolve) => {
			const entry = { index, update, sentAt, resolve: (ms: number | null) => { clearTimeout(timer); resolve(ms); } };
			const timer = setTimeout(() => { this.pending = this.pending.filter((p) => p !== entry); resolve(null); }, timeoutMs);
			this.coveredMs[index] = null;
			this.pending.push(entry);
			this.check();
		});
	}
	check() {
		if (this.pending.length === 0) return;
		const at = now();
		const snap = Y.snapshot(this.receiver);
		this.pending = this.pending.filter((p) => {
			if (!Y.snapshotContainsUpdate(snap, p.update)) return true;
			const ms = r2(at - p.sentAt);
			this.coveredMs[p.index] = ms;
			p.resolve?.(ms);
			return false;
		});
	}
	get outstanding() { return this.pending.length; }
	stop() { this.receiver.off("update", this.handler); }
}

export interface KeystrokeSample { i: number; sentAtWall: number; propagationMs: number | null; ackMs: number | null; frameId: string }

/**
 * One-char edits on `a`, measuring propagation to `b` (coverage) and origin ack. Spacing is start-to-start.
 */
export async function keystrokes(a: RawClient, b: RawClient | null, n: number, spacingMs: number, options: {
	position?: "end" | "middle"; timeoutMs?: number; onSample?: (s: KeystrokeSample) => void;
} = {}): Promise<KeystrokeSample[]> {
	const tracker = b ? new CoverageTracker(b.doc) : null;
	const samples: KeystrokeSample[] = [];
	const timeoutMs = options.timeoutMs ?? 10_000;
	try {
		for (let i = 0; i < n; i++) {
			const start = now();
			const sentAtWall = Date.now();
			let update: Uint8Array | null = null;
			const capture = (u: Uint8Array, origin: unknown) => { if (origin !== a) update = u; };
			a.doc.on("update", capture);
			let tracked: { frameId: string; sentAt: number };
			try {
				tracked = a.editTracked((t) => t.insert(options.position === "middle" ? Math.floor(t.length / 2) : t.length,
					String.fromCharCode(97 + (i % 26))));
			} finally { a.doc.off("update", capture); }
			const prop = tracker && update ? tracker.sentAndWait(i, update, tracked.sentAt, timeoutMs) : Promise.resolve(null);
			const ack = a.waitAck(tracked.frameId, tracked.sentAt, timeoutMs);
			const [p, k] = await Promise.all([prop, ack]);
			const sample = { i, sentAtWall, propagationMs: p, ackMs: k ? r2(k.at - tracked.sentAt) : null, frameId: tracked.frameId };
			samples.push(sample);
			options.onSample?.(sample);
			const wait = start + spacingMs - now();
			if (wait > 0) await sleep(wait);
		}
	} finally { tracker?.stop(); }
	return samples;
}

/** Replay trace frames from `sender` at `rate` edits/s (0 = as fast as the socket accepts). */
export async function replayTrace(sender: RawClient, frames: readonly Uint8Array[], rate: number, options: {
	tracker?: CoverageTracker; limit?: number; onProgress?: (i: number) => void;
} = {}) {
	const limit = Math.min(options.limit ?? frames.length, frames.length);
	const sendTimes: number[] = [];
	const t0 = now();
	for (let i = 0; i < limit; i++) {
		if (rate > 0) {
			const wait = t0 + (i * 1000) / rate - now();
			if (wait > 1) await sleep(wait);
		} else if (i % 200 === 0) {
			// Yield and respect socket backpressure.
			while ((sender.socket as unknown as { bufferedAmount: number }).bufferedAmount > 1 << 20) await sleep(5);
			await sleep(0);
		}
		if (sender.closed) { log(`sender closed during replay at ${i}: ${JSON.stringify(sender.closed)}`); break; }
		const at = now();
		sender.applyAndSend(frames[i]!);
		sendTimes.push(at);
		options.tracker?.sent(i, frames[i]!, at);
		if (i % 1000 === 0) options.onProgress?.(i);
	}
	return { sent: sendTimes.length, sendTimes, durationMs: r2(now() - t0) };
}

/** Operator-authenticated POST to a vault debug route (simulate-restart, compact). */
export async function operatorVaultPost(ctx: RunCtx, suffix: string) {
	const go = () => fetch(vaultRoute(ctx.context.devices.A!, suffix), { method: "POST", headers: { cookie: ctx.context.operatorCookie } });
	let response = await go();
	if (response.status === 401) { await refreshOperatorCookie(ctx.context); response = await go(); }
	const text = await response.text();
	let value: unknown = text;
	try { value = JSON.parse(text); } catch { /* keep text */ }
	return { status: response.status, value };
}

export async function revokeDevice(ctx: RunCtx, deviceId: string) {
	const go = () => fetch(`${ctx.host}/operator/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", headers: { cookie: ctx.context.operatorCookie } });
	let response = await go();
	if (response.status === 401) { await refreshOperatorCookie(ctx.context); response = await go(); }
	return { status: response.status, body: (await response.text()).slice(0, 300) };
}

/** Optional in-process `wrangler tail --format json` capture for a scenario window. */
export class TailCapture {
	private child: ChildProcess | null = null;
	readonly path: string;
	constructor(host: string, label: string) {
		this.path = join(LOG_DIR, `tail-${workerName(host)}-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
	}
	async start(host: string, warmupMs = 8000) {
		const wrangler = process.env.WRANGLER ?? "/Users/kavin/personal/obsidiansync/node_modules/.bin/wrangler";
		const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: "261336883158b276696d7181091ba1a6" };
		delete env.CLOUDFLARE_API_TOKEN;
		const out = createWriteStream(this.path);
		this.child = spawn(wrangler, ["tail", workerName(host), "--format", "json"], { env, stdio: ["ignore", "pipe", "pipe"] });
		this.child.stdout!.pipe(out);
		this.child.stderr!.on("data", () => { /* banner */ });
		await sleep(warmupMs);
		log(`tail capturing → ${this.path}`);
	}
	async stop(drainMs = 10_000) {
		await sleep(drainMs);
		this.child?.kill("SIGINT");
		await sleep(500);
		this.child?.kill("SIGKILL");
	}
}

export function pctChange(a: number | undefined, b: number | undefined) {
	if (a === undefined || b === undefined || a === 0) return null;
	return r2(((b - a) / a) * 100);
}
