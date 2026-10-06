/**
 * EngineHost: owns the engine carrier (DESIGN §g.1, §g.4, §g.5).
 *
 * - Startup probe: construct the Blob-URL worker, ping (pong within 5 s), then
 *   init. No pong, a worker error, or a storage failure in init (IDB not
 *   usable inside the worker, risk OR-1) => fall back to the inline engine.
 * - Liveness: ping every PING_INTERVAL_MS; no pong within PING_TIMEOUT_MS =>
 *   restart. Transport failure => restart. More than MAX_WORKER_RESTARTS
 *   restarts within 10 minutes => inline from then on.
 * - Every carrier instance has a generation; messages and request answers of
 *   an old generation are ignored. Pending requests are rejected with
 *   "aborted" when the carrier goes away.
 * - `fatal` from the engine and TERMINAL_ERROR_CODES stop the host (no retry).
 */

import type { ClockPort, TimerHandle } from "../ports/clock";
import type { ProtocolError } from "../protocol/errors";
import { TERMINAL_ERROR_CODES } from "../protocol/errors";
import type { EngineInitConfig, EngineResultValue, EngineToMain, MainResultValue, MainToEngine } from "../protocol/messages";
import { PROTOCOL_VERSION } from "../protocol/messages";
import type { HostTransport } from "../protocol/transport";
import { MAX_WORKER_RESTARTS, PING_INTERVAL_MS, PING_TIMEOUT_MS } from "../protocol/transport";
import { transferablesOf, TransferOwnershipError } from "../protocol/workerTransport";

export const STARTUP_PING_TIMEOUT_MS = 5_000;
export const INIT_TIMEOUT_MS = 120_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const RESTART_WINDOW_MS = 10 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

export type CarrierKind = "worker" | "inline";

export interface EngineCarrier {
	readonly kind: CarrierKind;
	readonly transport: HostTransport;
	/** Terminate the worker / dispose the inline engine. Idempotent. */
	dispose(): void;
}

export type EngineRequestMessage = Extract<EngineToMain, { t: "readRequest" | "diskOps" | "saveViews" | "sideFileWrite" | "sideFileRead" | "hostIo" | "keyringChanged" }>;
export type EngineEventMessage = Extract<EngineToMain, { t: "docUpdate" | "docRetarget" | "bindable" | "status" | "brake" | "notice" }>;
type HostRequest = Extract<MainToEngine, { rid: number }>;
type HostRequestBody = HostRequest extends infer M ? (M extends { rid: number } ? Omit<M, "rid"> : never) : never;
type HostEvent = Exclude<MainToEngine, { rid: number }>;

export class HostRequestError extends Error {
	constructor(readonly error: ProtocolError) {
		super(`${error.code}: ${error.message}`);
		this.name = "HostRequestError";
	}
}

export interface EngineHostHandlers {
	onEvent(message: EngineEventMessage): void;
	onRequest(message: EngineRequestMessage): Promise<MainResultValue>;
	/** Engine answered init. `restart` = not the first start. */
	onReady(info: { readonly carrier: CarrierKind; readonly ready: Extract<EngineResultValue, { t: "ready" }>; readonly restart: boolean }): void;
	/** Carrier lost (before a restart). */
	onDown(reason: string): void;
	onFatal(error: ProtocolError): void;
}

export interface EngineHostDeps {
	readonly clock: ClockPort;
	/** null when Worker / Blob URLs are unavailable. */
	readonly createWorker: () => EngineCarrier | null;
	readonly createInline: () => EngineCarrier;
	/** Built per start (side files re-read, device class depends on the carrier). */
	readonly initConfig: (carrier: CarrierKind, workerSupported: boolean) => Promise<EngineInitConfig>;
	readonly handlers: EngineHostHandlers;
	readonly pingEnabled?: boolean;
	readonly forceInline?: boolean;
	readonly log?: (line: string) => void;
}

interface Pending {
	resolve(value: EngineResultValue): void;
	reject(error: HostRequestError): void;
	timer: TimerHandle | null;
}

interface Live {
	readonly gen: number;
	readonly carrier: EngineCarrier;
	readonly pending: Map<number, Pending>;
	nextRid: number;
	ready: boolean;
	offs: (() => void)[];
	pingTimer: TimerHandle | null;
}

function protocolError(code: ProtocolError["code"], message: string, retryable = true): ProtocolError {
	return { code, message, retryable };
}

export class EngineHost {
	private live: Live | null = null;
	private gen = 0;
	private restartTimes: number[] = [];
	private inlineOnly: boolean;
	private stopped = false;
	/** Set the moment stop() begins: no restart/bring-up may start a new carrier after this. */
	private halting = false;
	private started = false;
	private workerSupported = false;
	private restarting = false;
	private inlineBackoffMs = 1_000;
	/** For status/UI and tests. */
	restarts = 0;
	lastFallbackReason: string | null = null;

	constructor(private readonly deps: EngineHostDeps) {
		this.inlineOnly = deps.forceInline ?? false;
	}

	get carrierKind(): CarrierKind | null {
		return this.live?.carrier.kind ?? null;
	}

	get isReady(): boolean {
		return this.live?.ready ?? false;
	}

	get isStopped(): boolean {
		return this.stopped;
	}

	private get down(): boolean {
		return this.stopped || this.halting;
	}

	get probedWorkerSupported(): boolean {
		return this.workerSupported;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.bringUp(false);
	}

	/** Fire-and-forget message; dropped while no ready engine (callers resend state on onReady). */
	post(message: HostEvent): boolean {
		const live = this.live;
		if (!live || !live.ready || this.stopped) return false;
		this.send(live, message);
		return true;
	}

	request(body: HostRequestBody, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<EngineResultValue> {
		const live = this.live;
		if (!live || !live.ready || this.stopped) return Promise.reject(new HostRequestError(protocolError("not-ready", "engine not ready")));
		return this.requestOn(live, body, timeoutMs);
	}

	/** Graceful stop (plugin unload). */
	async stop(): Promise<void> {
		if (this.stopped || this.halting) return;
		this.halting = true;
		const live = this.live;
		if (live && live.ready) {
			try {
				await this.requestOn(live, { t: "shutdown", reason: "unload" }, SHUTDOWN_TIMEOUT_MS);
			} catch {
				// best effort
			}
		}
		this.stopped = true;
		const cur = this.live; // may differ from `live` (half-started carrier); teardown is not idempotent
		if (cur) this.teardown(cur, "stopped");
	}

	/** Test/diagnostic hook: treat the current carrier as failed. */
	simulateFailure(reason: string): void {
		const live = this.live;
		if (live) this.onCarrierFailure(live, reason);
	}

	// --- internals ------------------------------------------------------------

	private log(line: string): void {
		this.deps.log?.(line);
	}

	private async bringUp(restart: boolean): Promise<void> {
		if (this.down) return;
		if (!this.inlineOnly) {
			const worker = this.safeCreateWorker();
			if (worker) {
				const outcome = await this.tryStart(worker, restart);
				if (outcome === "ok" || outcome === "fatal" || this.down) return;
				this.lastFallbackReason = outcome;
				this.log(`worker start failed (${outcome}); falling back to inline`);
				this.inlineOnly = true;
			} else {
				this.lastFallbackReason = "worker-unavailable";
				this.inlineOnly = true;
			}
		}
		const inline = this.deps.createInline();
		const outcome = await this.tryStart(inline, restart);
		if (outcome !== "ok" && outcome !== "fatal" && !this.down) {
			this.log(`inline start failed (${outcome}); retrying in ${this.inlineBackoffMs} ms`);
			const delay = this.inlineBackoffMs;
			this.inlineBackoffMs = Math.min(this.inlineBackoffMs * 2, 60_000);
			this.deps.clock.setTimer(delay, () => void this.bringUp(true));
		}
	}

	private safeCreateWorker(): EngineCarrier | null {
		try {
			return this.deps.createWorker();
		} catch (error) {
			this.log(`worker construction threw: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	}

	/** Returns "ok", "fatal", or a fallback reason. */
	private async tryStart(carrier: EngineCarrier, restart: boolean): Promise<string> {
		const live = this.attach(carrier);
		try {
			if (carrier.kind === "worker") {
				await this.requestOn(live, { t: "ping" }, STARTUP_PING_TIMEOUT_MS);
				this.workerSupported = true;
				if (this.abandon(live)) return "superseded";
			}
			const config = await this.deps.initConfig(carrier.kind, this.workerSupported);
			if (this.abandon(live)) return "superseded";
			const ready = await this.requestOn(live, { t: "init", config }, INIT_TIMEOUT_MS);
			if (ready.t !== "ready") throw new HostRequestError(protocolError("bad-request", `unexpected init answer ${ready.t}`));
			if (ready.protocolVersion !== PROTOCOL_VERSION) throw new HostRequestError(protocolError("version-mismatch", `engine protocol ${ready.protocolVersion}, host ${PROTOCOL_VERSION}`, false));
			if (this.abandon(live)) return "superseded";
			live.ready = true;
			this.inlineBackoffMs = 1_000;
			this.schedulePing(live);
			this.deps.handlers.onReady({ carrier: carrier.kind, ready, restart });
			return "ok";
		} catch (error) {
			const perr = error instanceof HostRequestError ? error.error : protocolError("internal", error instanceof Error ? error.message : String(error));
			if (this.live === live) this.teardown(live, perr.code);
			if (TERMINAL_ERROR_CODES.includes(perr.code)) {
				this.fatal(perr);
				return "fatal";
			}
			return `${carrier.kind}:${perr.code}`;
		}
	}

	private attach(carrier: EngineCarrier): Live {
		const live: Live = { gen: ++this.gen, carrier, pending: new Map(), nextRid: 1, ready: false, offs: [], pingTimer: null };
		this.live = live;
		live.offs.push(carrier.transport.onMessage((m) => this.onMessage(live, m)));
		live.offs.push(carrier.transport.onFailure((reason) => this.onCarrierFailure(live, `failure: ${reason}`)));
		return live;
	}

	private teardown(live: Live, reason: string): void {
		if (live.pingTimer !== null) this.deps.clock.clearTimer(live.pingTimer);
		live.pingTimer = null;
		for (const off of live.offs) off();
		live.offs = [];
		const pending = [...live.pending.values()];
		live.pending.clear();
		for (const p of pending) {
			if (p.timer !== null) this.deps.clock.clearTimer(p.timer);
			p.reject(new HostRequestError(protocolError("aborted", `engine ${reason}`)));
		}
		try {
			live.carrier.transport.close();
		} catch {
			// ignore
		}
		live.carrier.dispose();
		if (this.live === live) this.live = null;
	}

	private send(live: Live, message: MainToEngine): void {
		let transfer: ArrayBuffer[] | undefined;
		try {
			transfer = transferablesOf(message);
		} catch (error) {
			if (!(error instanceof TransferOwnershipError)) throw error;
			transfer = undefined; // structured clone copies
		}
		live.carrier.transport.post(message, transfer);
	}

	private requestOn(live: Live, body: HostRequestBody, timeoutMs: number): Promise<EngineResultValue> {
		return new Promise<EngineResultValue>((resolve, reject) => {
			const rid = live.nextRid++;
			const pending: Pending = { resolve, reject, timer: null };
			pending.timer = this.deps.clock.setTimer(timeoutMs, () => {
				if (live.pending.get(rid) !== pending) return;
				live.pending.delete(rid);
				reject(new HostRequestError(protocolError("timeout", `${body.t} timed out after ${timeoutMs} ms`)));
			});
			live.pending.set(rid, pending);
			try {
				this.send(live, { ...body, rid } as MainToEngine);
			} catch (error) {
				live.pending.delete(rid);
				if (pending.timer !== null) this.deps.clock.clearTimer(pending.timer);
				reject(new HostRequestError(protocolError("internal", error instanceof Error ? error.message : String(error))));
			}
		});
	}

	/** After an await in tryStart: superseded, or stop() began (tear the half-started carrier down). */
	private abandon(live: Live): boolean {
		if (this.live !== live) return true;
		if (!this.down) return false;
		this.teardown(live, "stopped");
		return true;
	}

	private schedulePing(live: Live): void {
		if (!this.deps.pingEnabled) return;
		live.pingTimer = this.deps.clock.setTimer(PING_INTERVAL_MS, () => {
			live.pingTimer = null;
			if (this.live !== live || this.down) return;
			this.requestOn(live, { t: "ping" }, PING_TIMEOUT_MS).then(
				() => {
					if (this.live === live) this.schedulePing(live);
				},
				(error: unknown) => {
					if (this.live !== live) return;
					const code = error instanceof HostRequestError ? error.error.code : "internal";
					if (code === "timeout") this.onCarrierFailure(live, "ping-timeout");
					else this.schedulePing(live);
				},
			);
		});
	}

	private onCarrierFailure(live: Live, reason: string): void {
		if (this.live !== live || this.down) return;
		const wasReady = live.ready;
		this.teardown(live, reason);
		if (!wasReady) return; // tryStart handles startup failures
		this.log(`engine down: ${reason}`);
		this.deps.handlers.onDown(reason);
		this.restart();
	}

	private restart(): void {
		if (this.restarting || this.down) return;
		this.restarting = true;
		this.restarts++;
		const now = this.deps.clock.monotonic();
		this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
		this.restartTimes.push(now);
		if (!this.inlineOnly && this.restartTimes.length > MAX_WORKER_RESTARTS) {
			this.inlineOnly = true;
			this.lastFallbackReason = "too-many-restarts";
			this.log("too many worker restarts; switching to inline");
		}
		void this.bringUp(true).finally(() => {
			this.restarting = false;
		});
	}

	private fatal(error: ProtocolError): void {
		this.stopped = true;
		const live = this.live;
		if (live) this.teardown(live, "fatal");
		this.deps.handlers.onFatal(error);
	}

	private onMessage(live: Live, m: EngineToMain): void {
		if (this.live !== live) return; // stale generation
		switch (m.t) {
			case "result":
			case "error": {
				const p = live.pending.get(m.re);
				if (!p) return;
				live.pending.delete(m.re);
				if (p.timer !== null) this.deps.clock.clearTimer(p.timer);
				if (m.t === "result") p.resolve(m.value);
				else p.reject(new HostRequestError(m.error));
				return;
			}
			case "readRequest":
			case "diskOps":
			case "saveViews":
			case "sideFileWrite":
			case "sideFileRead":
			case "hostIo":
			case "keyringChanged": {
				const rid = m.rid;
				this.deps.handlers.onRequest(m).then(
					(value) => {
						if (this.live !== live) return;
						this.send(live, { t: "result", re: rid, value });
					},
					(error: unknown) => {
						if (this.live !== live) return;
						const perr = error instanceof HostRequestError ? error.error : protocolError("vault-io", error instanceof Error ? error.message : "host request failed");
						this.send(live, { t: "error", re: rid, error: perr });
					},
				);
				return;
			}
			case "fatal":
				this.fatal(m.error);
				return;
			default:
				// status/notice may arrive during init; pass everything through.
				this.deps.handlers.onEvent(m);
		}
	}
}
