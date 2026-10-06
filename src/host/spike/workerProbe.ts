// YAOS spike: main-thread side of the OR-1 Blob-URL worker probe. All browser
// constructors are injected (deps) so node:test can drive this against an
// in-process worker over a MessageChannel.
import type { CryptoProbeOptions } from "./cryptoProbe";
import { defaultNow, errInfo, r1, settle, skipped, toStep, type WorkerProbeReport } from "./report";
import { fillPattern, checkPattern, type MainToSpike, type SpikeToMain } from "./spikeWorkerHandler";

export interface WorkerLike {
	postMessage(message: unknown, transfer: Transferable[]): void;
	addEventListener(type: string, listener: (ev: Event) => void): void;
	terminate(): void;
}

export interface WorkerProbeTimeouts {
	firstPongMs: number;
	pingMs: number;
	pings: number;
	probeMs: number;
	idbStepMs: number;
	echoMs: number;
	transferBytes: number;
	graceMs: number;
	cryptoMs: number;
}

/** Which worker steps to run after the first pong. OR-1 runs idb + transfer; the E2EE part runs crypto only. */
export interface WorkerProbeSteps {
	idb: boolean;
	transfer: boolean;
	crypto: boolean;
}

export const DEFAULT_WORKER_TIMEOUTS: WorkerProbeTimeouts = {
	firstPongMs: 5000,
	pingMs: 2000,
	pings: 5,
	probeMs: 25000,
	idbStepMs: 4000,
	echoMs: 5000,
	transferBytes: 64 * 1024,
	graceMs: 750,
	cryptoMs: 60000,
};

export interface WorkerProbeDeps {
	source: string;
	makeUrl(source: string): string;
	makeWorker(url: string): WorkerLike;
	revokeUrl(url: string): void;
	now?: () => number;
	timeouts?: Partial<WorkerProbeTimeouts>;
	steps?: Partial<WorkerProbeSteps>;
	cryptoOpts?: Omit<CryptoProbeOptions, "where">;
	onProgress?: (msg: string) => void;
}

function isReply(v: unknown): v is SpikeToMain {
	return Boolean(v) && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

export async function runWorkerProbe(deps: WorkerProbeDeps): Promise<WorkerProbeReport> {
	const now = deps.now ?? defaultNow;
	const T: WorkerProbeTimeouts = { ...DEFAULT_WORKER_TIMEOUTS, ...deps.timeouts };
	const steps: WorkerProbeSteps = { idb: true, transfer: true, crypto: false, ...deps.steps };
	const progress = (m: string): void => {
		try {
			deps.onProgress?.(m);
		} catch {
			/* ignore */
		}
	};
	const t0 = now();
	const report: WorkerProbeReport = {
		sourceBytes: deps.source.length,
		blobUrl: skipped(),
		construct: skipped(),
		boot: { received: false },
		firstPong: { received: false },
		pingRttsMs: [],
		probe: { received: false },
		transfer: { attempted: false, sentBytes: 0, echoed: false },
		events: [],
		terminate: skipped(),
		revoke: skipped(),
		ok: false,
		totalMs: 0,
	};
	const finish = (): WorkerProbeReport => {
		report.ok = report.construct.ok && report.firstPong.received;
		report.totalMs = r1(now() - t0);
		return report;
	};

	progress("creating Blob URL");
	const urlRes = await settle(() => deps.makeUrl(deps.source), 3000, now);
	report.blobUrl = toStep(urlRes, (u) => u.slice(0, 80));
	if (urlRes.kind !== "ok") return finish();
	const url = urlRes.value;

	progress("constructing worker");
	const constructT = now();
	const at = (): number => r1(now() - constructT);
	const cons = await settle(() => deps.makeWorker(url), 3000, now);
	report.construct = toStep(cons, () => "constructed");
	if (cons.kind !== "ok") {
		report.revoke = toStep(await settle(() => deps.revokeUrl(url), 2000, now));
		return finish();
	}
	const worker = cons.value;

	const waiters = new Map<string, (msg: SpikeToMain) => void>();
	try {
		worker.addEventListener("message", (ev) => {
			const data: unknown = (ev as MessageEvent).data;
			if (!isReply(data)) {
				report.events.push({ type: "unexpected", atMs: at(), detail: typeof data });
				return;
			}
			if (data.type === "boot") {
				report.boot = { received: true, ms: at() };
				return;
			}
			if (data.type === "workerError") {
				report.events.push({ type: "workerError", atMs: at(), message: `${data.source}: ${data.error.name}: ${data.error.message}`, detail: data.detail });
				return;
			}
			if (data.type === "error") {
				report.events.push({ type: "workerReplyError", atMs: at(), message: `${data.error.name}: ${data.error.message}`, detail: data.id });
				if (typeof data.id === "number") {
					for (const [key, resolve] of [...waiters]) {
						if (key.endsWith(`:${data.id}`)) {
							waiters.delete(key);
							resolve(data);
						}
					}
				}
				return;
			}
			const key = `${data.type}:${data.id}`;
			const resolve = waiters.get(key);
			if (resolve) {
				waiters.delete(key);
				resolve(data);
			} else report.events.push({ type: "unmatchedReply", atMs: at(), message: key });
		});
		worker.addEventListener("error", (ev) => {
			const e = ev as ErrorEvent;
			report.events.push({ type: "error", atMs: at(), message: typeof e.message === "string" ? e.message : undefined, filename: e.filename, lineno: e.lineno, colno: e.colno });
		});
		worker.addEventListener("messageerror", () => {
			report.events.push({ type: "messageerror", atMs: at() });
		});
	} catch (e) {
		report.events.push({ type: "listenerSetupFailed", atMs: at(), message: errInfo(e).message });
	}

	let nextId = 1;
	const expect = (type: SpikeToMain["type"], id: number): Promise<SpikeToMain> =>
		new Promise<SpikeToMain>((resolve) => {
			waiters.set(`${type}:${id}`, resolve);
		});
	const request = async (msg: MainToSpike, replyType: SpikeToMain["type"], timeoutMs: number, transfer: Transferable[] = []) => {
		const reply = expect(replyType, msg.id);
		const res = await settle(() => {
			worker.postMessage(msg, transfer);
			return reply;
		}, timeoutMs, now);
		if (res.kind !== "ok") waiters.delete(`${replyType}:${msg.id}`);
		return res;
	};

	try {
		progress("waiting for first pong");
		const sent = now();
		const first = await request({ type: "ping", id: nextId++, t: r1(sent) }, "pong", T.firstPongMs);
		if (first.kind === "ok" && first.value.type === "pong") {
			report.firstPong = { received: true, ms: at(), rttMs: r1(now() - sent) };
		} else {
			if (first.kind === "error") report.events.push({ type: "pingPostFailed", atMs: at(), message: `${first.error.name}: ${first.error.message}` });
			if (first.kind === "ok") report.events.push({ type: "pingBadReply", atMs: at(), detail: first.value });
			// Give late error events a moment to arrive before tearing down.
			await new Promise((r) => setTimeout(r, T.graceMs));
		}

		if (report.firstPong.received) {
			for (let i = 0; i < T.pings; i++) {
				const s = now();
				const p = await request({ type: "ping", id: nextId++, t: r1(s) }, "pong", T.pingMs);
				if (p.kind === "ok" && p.value.type === "pong") report.pingRttsMs.push(r1(now() - s));
			}
		}

		if (report.firstPong.received && steps.idb) {
			progress("worker IndexedDB probe");
			const probe = await request({ type: "probe", id: nextId++, idbTimeoutMs: T.idbStepMs }, "probeResult", T.probeMs);
			if (probe.kind === "ok") {
				if (probe.value.type === "probeResult") report.probe = { received: true, ms: probe.ms, report: probe.value.report };
				else if (probe.value.type === "error") report.probe = { received: false, ms: probe.ms, error: probe.value.error };
			} else if (probe.kind === "hang") report.probe = { received: false, ms: probe.ms, hang: true };
			else report.probe = { received: false, ms: probe.ms, error: probe.error };
		}

		if (report.firstPong.received && steps.transfer) {
			progress("transfer echo");
			const id = nextId++;
			const buf = new ArrayBuffer(T.transferBytes);
			fillPattern(new Uint8Array(buf));
			const t = report.transfer;
			t.attempted = true;
			t.sentBytes = buf.byteLength;
			const after = expect("echoAfter", id);
			const echo = await request({ type: "echo", id, buf }, "echo", T.echoMs, [buf]);
			t.senderByteLengthAfterPost = buf.byteLength;
			t.detachedOnSend = buf.byteLength === 0;
			if (echo.kind === "ok" && echo.value.type === "echo") {
				const v = echo.value;
				t.echoed = true;
				t.echoMs = echo.ms;
				t.workerReceivedBytes = v.receivedBytes;
				t.workerPatternOk = v.patternOk;
				t.echoBytes = v.buf ? v.buf.byteLength : -1;
				t.intact = Boolean(v.buf && v.buf.byteLength === T.transferBytes && checkPattern(new Uint8Array(v.buf)));
				const a = await settle(() => after, 1000, now);
				if (a.kind === "ok" && a.value.type === "echoAfter") t.workerByteLengthAfterPost = a.value.byteLengthAfterPost;
			} else if (echo.kind === "hang") t.hang = true;
			else if (echo.kind === "error") t.error = echo.error;
			else if (echo.value.type === "error") t.error = echo.value.error;
			waiters.delete(`echoAfter:${id}`);
		}

		if (report.firstPong.received && steps.crypto) {
			progress("worker E2EE crypto probe");
			const msg: MainToSpike = deps.cryptoOpts ? { type: "crypto", id: nextId++, opts: deps.cryptoOpts } : { type: "crypto", id: nextId++ };
			const c = await request(msg, "cryptoResult", T.cryptoMs);
			if (c.kind === "ok") {
				if (c.value.type === "cryptoResult") report.crypto = { received: true, ms: c.ms, report: c.value.report };
				else if (c.value.type === "error") report.crypto = { received: false, ms: c.ms, error: c.value.error };
			} else if (c.kind === "hang") report.crypto = { received: false, ms: c.ms, hang: true };
			else report.crypto = { received: false, ms: c.ms, error: c.error };
		} else if (steps.crypto) report.crypto = { received: false };
	} catch (e) {
		report.events.push({ type: "probeException", atMs: at(), message: errInfo(e).message });
	} finally {
		waiters.clear();
		report.terminate = toStep(await settle(() => worker.terminate(), 2000, now));
		report.revoke = toStep(await settle(() => deps.revokeUrl(url), 2000, now));
	}
	return finish();
}
