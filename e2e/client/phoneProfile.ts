/**
 * Device profile for phoneBench.ts --profile. Attaches to Obsidian's WebView over the DevTools protocol (adb forward
 * to webview_devtools_remote_<pid>) and auto-attaches every worker, existing or new, hooking each as soon as it is
 * seen running. Not paused: a worker held at start for the hooks stalls the engine past the host's startup ping
 * (STARTUP_PING_TIMEOUT_MS, 5 s), which stops the plugin. Recorded per call, on the phone's clock
 * (performance.timeOrigin + now(), shared by every thread):
 *  - every worker: IndexedDB transactions, creation -> complete / abort (`idb`); fetch, call -> body read, or
 *    -> headers when the body is streamed (`net`);
 *  - main: Obsidian's vault calls (`vault`) and its DataAdapter calls (`bridge`: on mobile each one crosses the
 *    WebView-to-native file bridge), and long tasks (`longtask`).
 * Plus a CPU profile of every thread (written as .cpuprofile files, which DevTools opens).
 *
 * attribute() splits a window of wall time by what was in flight: idb, bridge and net, alone or together, or none
 * of them (main or worker CPU, postMessage hops, timers). A transaction's span includes the work queued inside it,
 * and a bridge call's includes the native side, so "idb only" is time the bootstrap could only have spent waiting
 * on IndexedDB.
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
		n++;
	}
	if (typeof fetch === "function") {
		const f = globalThis.fetch;
		let ids = 0;
		globalThis.fetch = function (input, init) {
			const s = now(), id = ++ids;
			const u = String((input && input.url) || input).replace(/^[a-z]+:\\/\\/[^/]+/, "").replace(/\\?.*$/, "").replace(/\\/vault\\/[^/]+/, "/vault/:id");
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
	return "worker: " + n + " hooks";
})()`;

/** [kind, name, startMs, endMs, failed, requestId?] on the phone's clock. */
type Ev = [string, string, number, number, number, number?];

interface CpuNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
export interface CpuProfile { nodes: CpuNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }

export interface ThreadCapture {
	readonly thread: string;
	readonly url: string;
	readonly hook: string;
	readonly events: Ev[];
	readonly profile: CpuProfile | null;
}

/** A live DevTools attachment to the phone's Obsidian page and its workers. */
export class PhoneProfile {
	private readonly workers = new Map<string, { url: string; hook: string }>();
	private constructor(private readonly cdp: Cdp, private readonly mainHook: string) {}

	/** Hooks main, starts its CPU profile, and auto-attaches (paused) every worker, existing or new. */
	static async attach(wsUrl: string, log: (s: string) => void): Promise<PhoneProfile> {
		const cdp = await Cdp.open(wsUrl);
		const mainHook = String(await cdp.evaluate(MAIN_HOOK));
		log(mainHook);
		const p = new PhoneProfile(cdp, mainHook);
		cdp.listeners.push((m) => {
			if (m.method !== "Target.attachedToTarget" || !m.params) return;
			const sid = m.params.sessionId as string;
			const info = m.params.targetInfo as { type: string; url: string };
			const paused = m.params.waitingForDebugger === true;
			if (info.type !== "worker") {
				if (paused) void cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => undefined);
				return;
			}
			// The engine must answer its host within a few seconds of starting, and every round trip here crosses adb:
			// send the hook, the profiler and the resume back to back (the target runs them in order), then await.
			const t = Date.now();
			const steps = [
				cdp.evaluate(WORKER_HOOK, sid),
				cdp.send("Profiler.enable", {}, sid),
				cdp.send("Profiler.setSamplingInterval", { interval: 1000 }, sid),
				cdp.send("Profiler.start", {}, sid),
				...(paused ? [cdp.send("Runtime.runIfWaitingForDebugger", {}, sid)] : []),
			];
			void Promise.all(steps).then(([hook]) => {
				p.workers.set(sid, { url: info.url, hook: String(hook) });
				log(`${String(hook)} (${paused ? `new, held ${Date.now() - t} ms` : "running"}) ${info.url.slice(0, 60)}`);
			}, (e: unknown) => log(`worker hook failed: ${String(e)}`));
		});
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
		await cdp.send("Profiler.start");
		await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
		return p;
	}

	/** Phone clock minus laptop clock (Date.now), from the round trip with the least delay. */
	async clockOffsetMs(): Promise<number> {
		let best = { rtt: Infinity, offset: 0 };
		for (let i = 0; i < 9; i++) {
			const a = Date.now();
			const phone = Number(await this.cdp.evaluate("performance.timeOrigin + performance.now()"));
			const b = Date.now();
			if (b - a < best.rtt) best = { rtt: b - a, offset: phone - (a + b) / 2 };
		}
		return best.offset;
	}

	/** Stops every profile and collects every thread's events. */
	async finish(): Promise<ThreadCapture[]> {
		const out: ThreadCapture[] = [];
		const take = async (thread: string, url: string, hook: string, sid?: string) => {
			let profile: CpuProfile | null = null;
			try { profile = (await this.cdp.send("Profiler.stop", {}, sid)).profile as CpuProfile; } catch { /* thread gone */ }
			let events: Ev[] = [];
			try { events = JSON.parse(String(await this.cdp.evaluate("JSON.stringify(globalThis.__yb ? globalThis.__yb.ev : [])", sid))) as Ev[]; } catch { /* thread gone */ }
			out.push({ thread, url, hook, events, profile });
		};
		await take("main", "page", this.mainHook);
		let k = 0;
		for (const [sid, w] of this.workers) await take(`worker${k++}`, w.url, w.hook, sid);
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

/** CPU busy time (non-idle samples) and the top self-time functions of a thread's profile. */
export function cpuSummary(p: CpuProfile, topN = 15): { totalMs: number; busyMs: number; top: [string, number][] } {
	const byId = new Map(p.nodes.map((n) => [n.id, n]));
	const self = new Map<string, number>();
	let busy = 0;
	const samples = p.samples ?? [];
	const deltas = p.timeDeltas ?? [];
	for (let i = 0; i < samples.length; i++) {
		const ms = (deltas[i + 1] ?? 0) / 1000;
		const f = byId.get(samples[i]!)?.callFrame;
		if (!f) continue;
		const name = f.functionName || "(anonymous)";
		if (name !== "(idle)") busy += ms;
		const tail = f.url ? f.url.replace(/^.*\//, "").slice(0, 30) : "";
		const key = name.startsWith("(") ? name : `${name} ${tail}:${f.lineNumber + 1}`;
		self.set(key, (self.get(key) ?? 0) + ms);
	}
	const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k, v]): [string, number] => [k, r1(v)]);
	return { totalMs: r1((p.endTime - p.startTime) / 1000), busyMs: r1(busy), top };
}
