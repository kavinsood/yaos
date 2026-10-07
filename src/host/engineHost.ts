/**
 * EngineHost: owns the engine carrier (DESIGN §g.1, §g.4, §g.5).
 *
 * - One carrier per host, from `createCarrier`: the Blob-URL worker in the
 *   plugin (plugin.ts), an in-process pair in tests and harnesses. Startup:
 *   ping (pong within STARTUP_PING_TIMEOUT_MS), then init.
 * - Liveness: ping every PING_INTERVAL_MS; no pong within PING_TIMEOUT_MS =>
 *   the engine is dead.
 * - Every carrier failure is terminal (§g.4): the carrier cannot be built,
 *   misses the startup pong, errors or its transport fails, misses a liveness
 *   pong, or init fails (storage-lost included); so are `fatal` from the
 *   engine and a protocol-version mismatch. The host stops: pending requests
 *   are rejected with "aborted", onFatal reports why, once, and no second
 *   carrier is ever built (nothing restarts it, nothing runs the engine on the
 *   UI thread). A new engine is a new host: the user's restart or a reload.
 * - Once the carrier is torn down, its late messages and request answers are
 *   ignored.
 */

import type { ClockPort, TimerHandle } from "../ports/clock";
import type { ProtocolError } from "../protocol/errors";
import type { EngineInitConfig, EngineResultValue, EngineToMain, MainResultValue, MainToEngine } from "../protocol/messages";
import { PROTOCOL_VERSION } from "../protocol/messages";
import type { HostTransport } from "../protocol/transport";
import { PING_INTERVAL_MS, PING_TIMEOUT_MS } from "../protocol/transport";
import { transferablesOf, TransferOwnershipError, wipeSecrets } from "../protocol/workerTransport";

export const STARTUP_PING_TIMEOUT_MS = 5_000;
export const INIT_TIMEOUT_MS = 120_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** "inline": the in-process pair of tests and harnesses (protocol/inlineTransport.ts); the plugin runs "worker" only. */
export type CarrierKind = "worker" | "inline";

export interface EngineCarrier {
	readonly kind: CarrierKind;
	readonly transport: HostTransport;
	/** Terminate the worker / dispose the in-process engine. Idempotent. */
	dispose(): void;
}

export type EngineRequestMessage = Extract<EngineToMain, { t: "readRequest" | "diskOps" | "saveViews" | "sideFileWrite" | "sideFileRead" | "hostIo" | "keyringChanged" }>;
export type EngineEventMessage = Extract<EngineToMain, { t: "body" | "docRetarget" | "bindable" | "status" | "brake" | "notice" }>;
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
	/** Engine answered init. */
	onReady(info: { readonly carrier: CarrierKind; readonly ready: Extract<EngineResultValue, { t: "ready" }> }): void;
	/** The host stopped for good (every carrier failure, `fatal` from the engine); called at most once. */
	onFatal(error: ProtocolError): void;
}

export interface EngineHostDeps {
	readonly clock: ClockPort;
	/** The one carrier of this host. Throws (with the reason) when it cannot be built: terminal. */
	readonly createCarrier: () => EngineCarrier;
	/** Built per start (side files re-read, keys loaded fresh). */
	readonly initConfig: () => Promise<EngineInitConfig>;
	readonly handlers: EngineHostHandlers;
	readonly pingEnabled?: boolean;
	readonly log?: (line: string) => void;
}

interface Pending {
	resolve(value: EngineResultValue): void;
	reject(error: HostRequestError): void;
	timer: TimerHandle | null;
}

interface Live {
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

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class EngineHost {
	private live: Live | null = null;
	private stopped = false;
	/** Set the moment stop() begins: no bring-up may start a carrier after this. */
	private halting = false;
	private started = false;

	constructor(private readonly deps: EngineHostDeps) {}

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

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		if (this.down) return;
		let carrier: EngineCarrier;
		try {
			carrier = this.deps.createCarrier();
		} catch (error) {
			this.fatal(protocolError("internal", `the sync engine could not start: ${messageOf(error)}`, false));
			return;
		}
		await this.bringUp(carrier);
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

	// --- internals ------------------------------------------------------------

	private log(line: string): void {
		this.deps.log?.(line);
	}

	private async bringUp(carrier: EngineCarrier): Promise<void> {
		const live = this.attach(carrier);
		let stage = "startup-ping";
		try {
			await this.requestOn(live, { t: "ping" }, STARTUP_PING_TIMEOUT_MS);
			if (this.abandon(live)) return;
			stage = "init";
			const config = await this.deps.initConfig();
			if (this.abandon(live)) {
				wipeSecrets({ t: "init", rid: 0, config }); // built but never sent: drop the key bytes (§6.3)
				return;
			}
			const ready = await this.requestOn(live, { t: "init", config }, INIT_TIMEOUT_MS);
			if (ready.t !== "ready") throw new HostRequestError(protocolError("bad-request", `unexpected init answer ${ready.t}`, false));
			if (ready.protocolVersion !== PROTOCOL_VERSION) throw new HostRequestError(protocolError("version-mismatch", `engine protocol ${ready.protocolVersion}, host ${PROTOCOL_VERSION}`, false));
			if (this.abandon(live)) return;
			live.ready = true;
			this.schedulePing(live);
			this.deps.handlers.onReady({ carrier: carrier.kind, ready });
		} catch (error) {
			if (this.live !== live || this.down) return; // stopped meanwhile, or the carrier's failure already ended the host
			const perr = error instanceof HostRequestError ? error.error : protocolError("internal", messageOf(error));
			const message = stage === "startup-ping" && perr.code === "timeout"
				? `the sync engine did not answer within ${STARTUP_PING_TIMEOUT_MS / 1000} s of starting`
				: `the sync engine could not start: ${perr.message}`;
			this.fatal({ code: perr.code, message, retryable: false });
		}
	}

	private attach(carrier: EngineCarrier): Live {
		const live: Live = { carrier, pending: new Map(), nextRid: 1, ready: false, offs: [], pingTimer: null };
		this.live = live;
		live.offs.push(carrier.transport.onMessage((m) => this.onMessage(live, m)));
		live.offs.push(carrier.transport.onFailure((reason) => this.onCarrierFailure(live, `the sync engine failed: ${reason}`)));
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
		try {
			let transfer: ArrayBuffer[] | undefined;
			try {
				transfer = transferablesOf(message);
			} catch (error) {
				if (!(error instanceof TransferOwnershipError)) throw error;
				transfer = undefined; // structured clone copies
			}
			live.carrier.transport.post(message, transfer);
		} finally {
			// Both carriers clone at post time: a copied SECRET buffer is zero-filled here, so main keeps no key
			// bytes after handing them to the engine (e2ee-design §6.3).
			wipeSecrets(message);
		}
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
				reject(new HostRequestError(protocolError("internal", messageOf(error))));
			}
		});
	}

	/** After an await in bringUp: stop() began (tear the half-started carrier down) or the host already ended. */
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
					if (this.live !== live || this.down) return;
					const code = error instanceof HostRequestError ? error.error.code : "internal";
					if (code === "timeout") this.onCarrierFailure(live, `the sync engine stopped answering (no pong within ${PING_TIMEOUT_MS / 1000} s)`);
					else this.schedulePing(live);
				},
			);
		});
	}

	/** Worker error, transport failure, missed liveness pong: terminal. */
	private onCarrierFailure(live: Live, message: string): void {
		if (this.live !== live || this.down) return;
		this.log(message);
		this.fatal(protocolError("internal", message, false));
	}

	private fatal(error: ProtocolError): void {
		if (this.stopped) return;
		this.stopped = true;
		const live = this.live;
		if (live) this.teardown(live, "fatal");
		this.deps.handlers.onFatal(error);
	}

	private onMessage(live: Live, m: EngineToMain): void {
		if (this.live !== live) return; // torn down
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
