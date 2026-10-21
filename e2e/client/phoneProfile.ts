/**
 * Device profile for phoneBench.ts --profile. Attaches to Obsidian's WebView over the DevTools protocol (adb forward
 * to webview_devtools_remote_<pid>) and auto-attaches every worker. A new worker is held at start until its hooks are
 * in, so the engine's first message, transaction and socket are seen (the host's startup ping pings again for 75 s,
 * engineHost.ts STARTUP_PING_ATTEMPTS, so the hold cannot stop the plugin). Each thread's events are drained every
 * second and its CPU profile is cut every 5 s, so a worker that is terminated mid-run (an engine restart) keeps what
 * it recorded. Recorded per call, on the phone's clock (performance.timeOrigin + now(), shared by every thread):
 *  - every worker: IndexedDB transactions, creation -> complete / abort (`idb`); fetch and XMLHttpRequest, call ->
 *    body read, or -> headers when the body is streamed (`net`); WebSocket open, close, and each frame sent or
 *    received with its size (`wsopen`, `wsclose`, `wsout`, `wsin`); the host <-> engine protocol, each message posted
 *    to main (`out`) or received from it (`in`), named by its type and request id (`init#2`, `result@2:ready`);
 *  - main: Obsidian's vault calls (`vault`) and its DataAdapter calls (`bridge`: on mobile each one crosses the
 *    WebView-to-native file bridge), and long tasks (`longtask`).
 * Plus the CPU profile chunks of every thread, each anchored to the phone's clock (cpuInWindow slices them).
 *
 * attribute() splits a window of wall time by what was in flight: idb, bridge and net, alone or together, or none
 * of them (main or worker CPU, postMessage hops, timers). A transaction's span includes the work queued inside it,
 * and a bridge call's includes the native side, so "idb only" is time the bootstrap could only have spent waiting
 * on IndexedDB. timeline() lists a window's events in order, for the startup stall.
 */
import WebSocket from "ws";

interface Msg {
	readonly id?: number;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly message: string };
	readonly sessionId?: string;
}

class Cdp {
	private n = 0;
	private readonly wait = new Map<number, [(v: Record<string, unknown>) => void, (e: Error) => void]>();
	readonly listeners: ((m: Msg) => void)[] = [];

	private constructor(private readonly ws: WebSocket) {
		ws.on("message", (data) => {
			const m = JSON.parse(String(data)) as Msg;
			if (m.id === undefined) {
				for (const l of this.listeners) l(m);
				return;
			}
			const w = this.wait.get(m.id);
			if (!w) return;
			this.wait.delete(m.id);
			if (m.error) w[1](new Error(m.error.message));
			else w[0](m.result ?? {});
		});
	}

	static open(url: string): Promise<Cdp> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
			ws.once("open", () => resolve(new Cdp(ws)));
			ws.once("error", reject);
		});
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		const id = ++this.n;
		return new Promise((resolve, reject) => {
			this.wait.set(id, [resolve, reject]);
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	async evaluate(expression: string, sessionId?: string): Promise<unknown> {
		const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
		const ex = r.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
		if (ex) throw new Error(`evaluate: ${ex.exception?.description ?? ex.text ?? "exception"}`);
		return (r.result as { value?: unknown } | undefined)?.value;
	}

	close(): void {
		this.ws.close();
	}
}

const MAIN_HOOK = `(() => {
	if (globalThis.__yb) return "again";
	const T = { ev: [] }; globalThis.__yb = T;
	const now = () => performance.timeOrigin + performance.now();
	const wrap = (obj, name, kind) => {
		const f = obj && obj[name];
		if (typeof f !== "function") return 0;
		obj[name] = function (...a) {
			const s = now();
			let r;
			try { r = f.apply(this, a); } catch (e) { T.ev.push([kind, name, s, now(), 1]); throw e; }
			if (r && typeof r.then === "function") r.then(() => T.ev.push([kind, name, s, now(), 0]), () => T.ev.push([kind, name, s, now(), 1]));
			else T.ev.push([kind, name, s, now(), 0]);
			return r;
		};
		return 1;
	};
	const ad = app.vault.adapter;
	let n = 0;
	for (const k of ["write", "writeBinary", "append", "process", "mkdir", "rename", "remove", "rmdir", "stat", "exists", "read",
		"readBinary", "list", "copy", "trashLocal", "trashSystem"]) n += wrap(ad, k, "bridge");
	for (const k of ["create", "createBinary", "createFolder", "modify", "modifyBinary", "process", "append", "delete", "rename",
		"trash"]) n += wrap(app.vault, k, "vault");
	try {
		new PerformanceObserver((l) => { for (const e of l.getEntries()) T.ev.push(["longtask", "main", performance.timeOrigin + e.startTime,
			performance.timeOrigin + e.startTime + e.duration, 0]); }).observe({ entryTypes: ["longtask"] });
	} catch (e) { /* no long task API */ }
	return "main: " + n + " hooks on " + (ad && ad.constructor ? ad.constructor.name : "?");
})()`;

const WORKER_HOOK = `(() => {
	if (globalThis.__yb) return "again";
	const T = { ev: [] }; globalThis.__yb = T;
	const now = () => performance.timeOrigin + performance.now();
	const size = (d) => typeof d === "string" ? d.length : d ? (d.byteLength || d.size || 0) : 0;
	const route = (u) => String(u).replace(/^[a-z]+:\\/\\/[^/]+/, "").replace(/\\?.*$/, "").replace(/\\/vault\\/[^/]+/, "/vault/:id");
	let n = 0;
	if (typeof IDBDatabase !== "undefined") {
		const P = IDBDatabase.prototype, tx = P.transaction;
		P.transaction = function (stores, mode, ...rest) {
			const s = now();
			const t = tx.call(this, stores, mode, ...rest);
			const name = (mode || "readonly") + " " + (typeof stores === "string" ? stores : Array.from(stores).join(","));
			let done = false;
			const end = (bad) => { if (!done) { done = true; T.ev.push(["idb", name, s, now(), bad]); } };
			t.addEventListener("complete", () => end(0));
			t.addEventListener("abort", () => end(1));
			return t;
		};
		const F = IDBFactory.prototype, op = F.open;
		F.open = function (name, ...rest) {
			const s = now(), r = op.call(this, name, ...rest);
			r.addEventListener("success", () => T.ev.push(["idb", "open", s, now(), 0]));
			r.addEventListener("error", () => T.ev.push(["idb", "open", s, now(), 1]));
			return r;
		};
		n++;
	}
	if (typeof fetch === "function") {
		const f = globalThis.fetch;
		let ids = 0;
		globalThis.fetch = function (input, init) {
			const s = now(), id = ++ids;
			const u = route((input && input.url) || input);
			return f.call(this, input, init).then((r) => {
				T.ev.push(["nethead", u, s, now(), r.ok ? 0 : 1, id]);
				for (const k of ["arrayBuffer", "json", "text", "blob"]) {
					const g = r[k];
					if (typeof g === "function") r[k] = function () { return g.call(r).finally(() => T.ev.push(["net", u, s, now(), r.ok ? 0 : 1, id])); };
				}
				return r;
			}, (e) => { T.ev.push(["net", u, s, now(), 1, id]); throw e; });
		};
		n++;
	}
	if (typeof XMLHttpRequest === "function") {
		const P = XMLHttpRequest.prototype, open = P.open, send = P.send;
		let ids = 1e6;
		P.open = function (m, u, ...rest) { this.__yu = route(u); return open.call(this, m, u, ...rest); };
		P.send = function (b) {
			const s = now(), id = ++ids, u = this.__yu;
			this.addEventListener("loadend", () => T.ev.push(["net", u, s, now(), this.status >= 200 && this.status < 300 ? 0 : 1, id]));
			return send.call(this, b);
		};
		n++;
	}
	if (typeof WebSocket === "function") {
		const W = WebSocket;
		let ids = 0;
		globalThis.WebSocket = class extends W {
			constructor(...a) {
				super(...a);
				const id = "ws" + (++ids), s = now();
				this.addEventListener("open", () => T.ev.push(["wsopen", id, s, now(), 0]));
				this.addEventListener("close", (e) => T.ev.push(["wsclose", id + " " + e.code, now(), now(), 0]));
				this.addEventListener("message", (e) => T.ev.push(["wsin", id, now(), now(), 0, size(e.data)]));
				const send = this.send;
				this.send = function (d) { T.ev.push(["wsout", id, now(), now(), 0, size(d)]); return send.call(this, d); };
			}
		};
		n++;
	}
	if (typeof WorkerGlobalScope !== "undefined" && typeof globalThis.postMessage === "function") {
		const tag = (m) => {
			if (!m || typeof m !== "object") return typeof m;
			const v = m.value && typeof m.value === "object" && m.value.t ? ":" + m.value.t : "";
			return String(m.t) + (m.rid !== undefined ? "#" + m.rid : m.re !== undefined ? "@" + m.re : "") + v;
		};
		const pm = globalThis.postMessage;
		globalThis.postMessage = function (m, ...rest) { const t = now(); T.ev.push(["out", tag(m), t, t, 0]); return pm.call(this, m, ...rest); };
		globalThis.addEventListener("message", (e) => { const t = now(); T.ev.push(["in", tag(e.data), t, t, 0]); }, true);
		n++;
	}
	return "worker: " + n + " hooks";
})()`;

const DRAIN = "(() => { const T = globalThis.__yb; return T ? JSON.stringify(T.ev.splice(0)) : \"[]\"; })()";
const NOW = "performance.timeOrigin + performance.now()";
const DRAIN_MS = 1000;
const CHUNK_MS = 5000;

/** [kind, name, startMs, endMs, failed, requestId?] on the phone's clock. */
type Ev = [string, string, number, number, number, number?];

interface CpuNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
export interface CpuProfile { nodes: CpuNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }

/** A CPU profile cut, with the phone's clock read right after its Profiler.start. */
export interface CpuChunk { readonly profile: CpuProfile; readonly startWallMs: number }

export interface ThreadCapture {
	readonly thread: string;
	readonly url: string;
	readonly hook: string;
	readonly events: Ev[];
	readonly chunks: CpuChunk[];
	/** Phone clock when DevTools saw the thread go (terminated), else null. */
	readonly goneAtMs: number | null;
}

interface Thread {
	readonly name: string;
	readonly url: string;
	readonly sid: string | undefined;
	hook: string;
	readonly events: Ev[];
	readonly chunks: CpuChunk[];
	startWallMs: number;
	gone: number | null;
}

/** A live DevTools attachment to the phone's Obsidian page and its workers. */
export class PhoneProfile {
	private readonly threads = new Map<string, Thread>();
	private nextWorker = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticks = 0;
	private busy = false;

	private constructor(private readonly cdp: Cdp, private readonly log: (s: string) => void) {}

	/** Hooks main and starts its CPU profile; auto-attaches every worker, holding new ones until hooked. */
	static async attach(wsUrl: string, log: (s: string) => void): Promise<PhoneProfile> {
		const cdp = await Cdp.open(wsUrl);
		const p = new PhoneProfile(cdp, log);
		const main: Thread = { name: "main", url: "page", sid: undefined, hook: String(await cdp.evaluate(MAIN_HOOK)), events: [], chunks: [], startWallMs: 0, gone: null };
		log(main.hook);
		p.threads.set("main", main);
		cdp.listeners.push((m) => {
			if (m.method === "Target.detachedFromTarget" && m.params) {
				const t = p.threads.get(m.params.sessionId as string);
				if (t && t.gone === null) {
					t.gone = Date.now();
					log(`${t.name} gone (${t.url.slice(0, 60)})`);
				}
				return;
			}
			if (m.method !== "Target.attachedToTarget" || !m.params) return;
			const sid = m.params.sessionId as string;
			const info = m.params.targetInfo as { type: string; url: string };
			const paused = m.params.waitingForDebugger === true;
			if (info.type !== "worker") {
				if (paused) void cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => undefined);
				return;
			}
			const t: Thread = { name: `worker${p.nextWorker++}`, url: info.url, sid, hook: "", events: [], chunks: [], startWallMs: 0, gone: null };
			p.threads.set(sid, t);
			// Every round trip crosses adb: send the hook, the profiler, the clock read and the resume back to back
			// (the target runs them in order), then await.
			const held = Date.now();
			const steps = [
				cdp.evaluate(WORKER_HOOK, sid),
				cdp.send("Profiler.enable", {}, sid),
				cdp.send("Profiler.setSamplingInterval", { interval: 1000 }, sid),
				cdp.send("Profiler.start", {}, sid),
				cdp.evaluate(NOW, sid),
				...(paused ? [cdp.send("Runtime.runIfWaitingForDebugger", {}, sid)] : []),
			];
			void Promise.all(steps).then(([hook, , , , wall]) => {
				t.hook = String(hook);
				t.startWallMs = Number(wall);
				log(`${t.name}: ${t.hook} (${paused ? `new, held ${Date.now() - held} ms` : "running"}) ${info.url.slice(0, 60)}`);
			}, (e: unknown) => log(`${t.name} hook failed: ${String(e)}`));
		});
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
		await cdp.send("Profiler.start");
		main.startWallMs = Number(await cdp.evaluate(NOW));
		await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
		p.timer = setInterval(() => void p.tick(), DRAIN_MS);
		return p;
	}

	private async drain(t: Thread): Promise<void> {
		if (t.gone !== null) return;
		try {
			t.events.push(...(JSON.parse(String(await this.cdp.evaluate(DRAIN, t.sid))) as Ev[]));
		} catch (e) {
			if (t.gone === null) this.log(`${t.name} drain failed: ${String(e)}`);
		}
	}

	/** Ends the thread's current CPU chunk and, unless `last`, starts the next. */
	private async cut(t: Thread, last: boolean): Promise<void> {
		if (t.gone !== null || !t.startWallMs) return;
		try {
			const steps: Promise<unknown>[] = [this.cdp.send("Profiler.stop", {}, t.sid)];
			if (!last) steps.push(this.cdp.send("Profiler.start", {}, t.sid), this.cdp.evaluate(NOW, t.sid));
			const [stopped, , wall] = await Promise.all(steps);
			t.chunks.push({ profile: (stopped as { profile: CpuProfile }).profile, startWallMs: t.startWallMs });
			if (!last) t.startWallMs = Number(wall);
		} catch (e) {
			if (t.gone === null) this.log(`${t.name} profile cut failed: ${String(e)}`);
		}
	}

	private async tick(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const cut = ++this.ticks % (CHUNK_MS / DRAIN_MS) === 0;
			await Promise.all([...this.threads.values()].map(async (t) => {
				await this.drain(t);
				if (cut) await this.cut(t, false);
			}));
		} finally {
			this.busy = false;
		}
	}

	/** Phone clock minus laptop clock (Date.now), from the round trip with the least delay. */
	async clockOffsetMs(): Promise<number> {
		let best = { rtt: Infinity, offset: 0 };
		for (let i = 0; i < 9; i++) {
			const a = Date.now();
			const phone = Number(await this.cdp.evaluate(NOW));
			const b = Date.now();
			if (b - a < best.rtt) best = { rtt: b - a, offset: phone - (a + b) / 2 };
		}
		return best.offset;
	}

	/** Stops the drains, takes every thread's last events and CPU chunk. `offset`: phone minus laptop clock. */
	async finish(offset: number): Promise<ThreadCapture[]> {
		if (this.timer) clearInterval(this.timer);
		while (this.busy) await new Promise((r) => setTimeout(r, 50));
		const out: ThreadCapture[] = [];
		for (const t of this.threads.values()) {
			await this.drain(t);
			await this.cut(t, true);
			out.push({ thread: t.name, url: t.url, hook: t.hook, events: t.events, chunks: t.chunks, goneAtMs: t.gone === null ? null : t.gone + offset });
		}
		this.cdp.close();
		return out;
	}
}

// ---- analysis --------------------------------------------------------------------------------------------------

type Iv = [number, number];
const r1 = (v: number) => Math.round(v * 10) / 10;

function clip(ivs: Iv[], [a, b]: Iv): Iv[] {
	return ivs.map(([s, e]): Iv => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e > s);
}

function unionMs(ivs: Iv[]): number {
	const s = [...ivs].sort((x, y) => x[0] - y[0]);
	let total = 0;
	let cur: Iv | null = null;
	for (const iv of s) {
		if (!cur || iv[0] > cur[1]) {
			if (cur) total += cur[1] - cur[0];
			cur = [iv[0], iv[1]];
		} else cur[1] = Math.max(cur[1], iv[1]);
	}
	if (cur) total += cur[1] - cur[0];
	return total;
}

/** Wall time of `win` split by which of the categories had something in flight. */
function exclusive(cats: Record<string, Iv[]>, win: Iv): Record<string, number> {
	const names = Object.keys(cats);
	const edges: [number, number, number][] = []; // [t, catIndex, +1/-1]
	names.forEach((n, i) => { for (const [s, e] of clip(cats[n]!, win)) edges.push([s, i, 1], [e, i, -1]); });
	edges.push([win[0], -1, 0], [win[1], -1, 0]);
	edges.sort((x, y) => x[0] - y[0] || x[2] - y[2]);
	const depth = names.map(() => 0);
	const out: Record<string, number> = {};
	let t = win[0];
	for (const [at, i, d] of edges) {
		if (at > t) {
			const key = names.filter((_, j) => depth[j]! > 0).join("+") || "none";
			out[key] = (out[key] ?? 0) + (at - t);
			t = at;
		}
		if (i >= 0) depth[i]! += d;
	}
	for (const k of Object.keys(out)) out[k] = r1(out[k]!);
	return out;
}

function durStats(ds: number[]): { n: number; sumMs: number; p50: number; p95: number; max: number } {
	const s = [...ds].sort((a, b) => a - b);
	const at = (q: number) => r1(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0);
	return { n: s.length, sumMs: r1(s.reduce((a, b) => a + b, 0)), p50: at(0.5), p95: at(0.95), max: r1(s.at(-1) ?? 0) };
}

/** Requests as one interval each: to the body read when there was one, else to the headers. */
function requests(evs: Ev[]): Ev[] {
	const byId = new Map<number, Ev>();
	for (const e of evs) {
		if (e[0] !== "net" && e[0] !== "nethead") continue;
		const id = e[5] ?? -1;
		const prev = byId.get(id);
		if (!prev || (e[0] === "net" && (prev[0] === "nethead" || e[3] > prev[3]))) byId.set(id, e);
	}
	return [...byId.values()];
}

export interface Attribution {
	readonly windowMs: number;
	readonly split: Record<string, number>;
	readonly busyMs: Record<string, number>;
	readonly calls: Record<string, ReturnType<typeof durStats> & { top: [string, ReturnType<typeof durStats>][] }>;
}

/** Attributes the wall time of `win` (phone clock) across idb / bridge / net, plus vault ops and main long tasks. */
export function attribute(threads: ThreadCapture[], win: Iv): Attribution {
	const evs = threads.flatMap((t) => t.events.filter((e) => e[0] !== "net" && e[0] !== "nethead"))
		.concat(threads.flatMap((t) => requests(t.events).map((e): Ev => ["net", e[1], e[2], e[3], e[4]])));
	const inWin = evs.filter((e) => e[3] > win[0] && e[2] < win[1]);
	const ivsOf = (kind: string): Iv[] => inWin.filter((e) => e[0] === kind).map((e): Iv => [e[2], e[3]]);
	const cats = { idb: ivsOf("idb"), bridge: ivsOf("bridge"), net: ivsOf("net") };
	const busyMs: Record<string, number> = {};
	for (const kind of ["idb", "bridge", "net", "vault", "longtask"]) busyMs[kind] = r1(unionMs(clip(ivsOf(kind), win)));
	const calls: Attribution["calls"] = {};
	for (const kind of ["idb", "bridge", "vault", "net"]) {
		const es = inWin.filter((e) => e[0] === kind);
		const byName = new Map<string, number[]>();
		for (const e of es) {
			const l = byName.get(e[1]) ?? [];
			l.push(e[3] - e[2]);
			byName.set(e[1], l);
		}
		const top = [...byName.entries()].map(([n, ds]): [string, ReturnType<typeof durStats>] => [n, durStats(ds)])
			.sort((a, b) => b[1].sumMs - a[1].sumMs).slice(0, 8);
		calls[kind] = { ...durStats(es.map((e) => e[3] - e[2])), top };
	}
	return { windowMs: r1(win[1] - win[0]), split: exclusive(cats, win), busyMs, calls };
}

/** CPU busy time (non-idle samples) and the top self-time functions of a thread's chunks, inside `win` if given. */
export function cpuInWindow(chunks: CpuChunk[], win: Iv | null = null, topN = 15): { totalMs: number; busyMs: number; top: [string, number][] } {
	const self = new Map<string, number>();
	let busy = 0;
	let total = 0;
	for (const { profile: p, startWallMs } of chunks) {
		const byId = new Map(p.nodes.map((n) => [n.id, n]));
		const samples = p.samples ?? [];
		const deltas = p.timeDeltas ?? [];
		let ts = p.startTime;
		for (let i = 0; i < samples.length; i++) {
			ts += deltas[i] ?? 0;
			const at = startWallMs + (ts - p.startTime) / 1000;
			if (win && (at < win[0] || at >= win[1])) continue;
			const ms = (deltas[i + 1] ?? 0) / 1000;
			total += ms;
			const f = byId.get(samples[i]!)?.callFrame;
			if (!f) continue;
			const name = f.functionName || "(anonymous)";
			if (name !== "(idle)") busy += ms;
			const tail = f.url ? f.url.replace(/^.*\//, "").slice(0, 30) : "";
			const key = name.startsWith("(") ? name : `${name} ${tail}:${f.lineNumber + 1}`;
			self.set(key, (self.get(key) ?? 0) + ms);
		}
	}
	const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k, v]): [string, number] => [k, r1(v)]);
	return { totalMs: r1(total), busyMs: r1(busy), top };
}

/**
 * The window's events in order, as "+ms thread kind name (duration)", relative to `win[0]`. Runs of one kind and name
 * in a row on one thread fold into one line with a count (a burst of transactions, a stream of frames).
 */
export function timeline(threads: ThreadCapture[], win: Iv, kinds: readonly string[] = ["in", "out", "wsopen", "wsclose", "wsout", "wsin", "net", "idb", "bridge"]): string[] {
	const evs = threads.flatMap((t) => t.events.filter((e) => kinds.includes(e[0]) && e[2] >= win[0] && e[2] < win[1]).map((e) => ({ t: t.thread, e })))
		.sort((a, b) => a.e[2] - b.e[2]);
	const out: string[] = [];
	let run: { key: string; first: Ev; last: Ev; n: number; bytes: number } | null = null;
	const flush = () => {
		if (!run) return;
		const { first, last, n, bytes } = run;
		const span = n > 1 ? ` x${n} over ${r1(last[3] - first[2])} ms` : first[3] > first[2] ? ` ${r1(first[3] - first[2])} ms` : "";
		out.push(`+${r1(first[2] - win[0])} ${run.key}${span}${bytes ? ` ${bytes} B` : ""}${first[4] ? " FAILED" : ""}`);
		run = null;
	};
	for (const { t, e } of evs) {
		const key = `${t} ${e[0]} ${e[1]}`;
		const bytes = e[0] === "wsin" || e[0] === "wsout" ? e[5] ?? 0 : 0;
		if (run && run.key === key && !e[4]) {
			run.last = e;
			run.n++;
			run.bytes += bytes;
			continue;
		}
		flush();
		run = { key, first: e, last: e, n: 1, bytes };
	}
	flush();
	return out;
}
