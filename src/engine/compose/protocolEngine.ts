/**
 * The engine behind the protocol (DESIGN §g): one instance per carrier (the
 * worker; an in-process pair in tests, the sim and harnesses). Answers ping in every phase, init -> ready, and routes
 * every other message to the per-epoch VaultRuntime.
 *
 * Protocol-ready is not vault-ready: init answers `ready` as soon as the ports
 * exist, even offline on a fresh device (the runtime keeps retrying in the
 * background). Only an unusable store fails init (`storage-lost`), which
 * stops the host (OR-1, DESIGN §g.4).
 *
 * The runtime is restarted in-process on an epoch change (§c.12), storage
 * loss (§i.5), rebuildLocalCache and settings changes that need it. Bound
 * docs are retargeted to their path so the host re-opens them on the new
 * runtime; the last complete listing (+ later vault events) is replayed.
 *
 * The write gate (pinGate.ts, e2ee-design §12.4): a VaultRuntime gets its ports only from the gate, which opens
 * for suite 0, and for suite 1 once the newest stored winner's key is held and verified. A closed device runs the
 * KeyReader instead: it reads `k` and writes nothing (no frame, checkpoint, blob, ns entry, reconcile or outbox),
 * except the genesis of enableE2ee on the creation path. Key commands (§18.4) go to the KeyReader while the gate is
 * shut, and to the runtime's keyring once it runs. When a key-missing suite-1 device installs the key, the gate
 * re-checks and the runtime starts in this process; an unpinned device waits for main to pin and restart it.
 */

import type { DeviceId, VaultEpoch } from "../../core/types";
import { BUDGETS } from "../../core/limits";
import { pathKey } from "../../core/paths/pathKey";
import type { EnginePorts } from "../../ports";
import type { BlobPort } from "../../ports/blob";
import { findKnownEpoch, storedKeyringRecords } from "./knownEpoch";
import { deleteLegacyDbs, IdentityRefused, needsRepair, resolveStoreIdentity, type ResolvedIdentity } from "./storeIdentity";
import type { RegisterRefusal } from "../../ports/identity";
import { isStorageError } from "../../ports/storage";
import type { VaultEvent } from "../../ports/vault";
import { ProtocolFailure, type ProtocolError } from "../../protocol/errors";
import { PROTOCOL_VERSION, type EngineInitConfig, type EngineResultValue, type EngineSettings, type LocalObservation, type MainToEngine, type UserCommand } from "../../protocol/messages";
import type { DeviceCheckMode, DeviceEnv, DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import type { EngineTransport } from "../../protocol/transport";
import type { Budgets } from "../../core/limits";
import type { EngineTuning } from "../runtime/options";
import { BoundBody } from "./boundBody";
import { BoundDisk } from "./boundDisk";
import { BoundDocs } from "./boundDocs";
import { runDeviceCheck, type DeviceCheckDeps } from "./deviceCheck";
import { answerHashRequest } from "./hashService";
import { HostKeyring } from "./hostKeyring";
import { HostLink } from "./hostLink";
import { KeyReader, type KeyCommand } from "./keyReader";
import { PinGate, type GateKeys } from "./pinGate";
import { idleStatus } from "./statusMerge";
import { ownFrameNoFloor, prepareEpochMigration } from "./runtimeOps";
import { wipeSecrets } from "../../protocol/workerTransport";
import type { FrameNoFloor } from "../store/repo";
import type { MetaDocDeletes, MetaPathBase } from "../store/schema";
import { VaultRuntime, type RestartReason, type RuntimeObserver } from "./vaultRuntime";

/** A device id's shape (relay-wire §2.4): a lineage entry of any other shape is ignored. */
const DEVICE_ID_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export interface CreateEngineOptions {
	readonly carrier: "worker" | "inline";
	/** Engine ports for one init. Throwing (store cannot open) answers init with `storage-lost`. */
	makePorts(config: EngineInitConfig): EnginePorts | Promise<EnginePorts>;
	readonly clientVersion?: string;
	readonly tuning?: Partial<EngineTuning>;
	readonly budgets?: Partial<Budgets>;
	/**
	 * First retry delay after a failed runtime start (offline fresh device, relay down); doubles per failure up to
	 * START_RETRY_MAX_MS, back to it after a start or on `online` / `visible` / `resume`.
	 */
	readonly startRetryMs?: number;
	/** Test hook: called with each new runtime (null when it stops). */
	readonly onRuntime?: (rt: VaultRuntime | null) => void;
	/** Test hook: diagnostics lines (never secrets). */
	readonly log?: (line: string) => void;
	/** Test hook: the LogEngine's structured diagnostics events (EngineOptions.onDiag), every runtime. */
	readonly onDiag?: (event: DiagnosticsEvent) => void;
	/** Test hook (sim coverage): observes every runtime's ns folds and reconcile plans (VaultRuntimeStart.observe). */
	readonly observe?: RuntimeObserver;
	/** Local time zone offset in minutes (conflict-copy names); the engine core never reads Date. */
	readonly tzOffsetMinutes?: () => number;
	/** Test hook (sim): the store identity each start resolved (identity-per-store §4). Never secrets. */
	readonly onIdentity?: (deviceId: string, source: "store" | "pending") => void;
	/** What the engine's own scope exposes, for the device check (webEngine.ts: adapters/webDeviceEnv.ts). Absent = not probed. */
	readonly deviceEnv?: () => DeviceEnv;
}

export interface EngineHandle {
	readonly engine: ComposedEngine;
	dispose(): void;
}

export function createEngine(transport: EngineTransport, options: CreateEngineOptions): EngineHandle {
	const engine = new ComposedEngine(transport, options);
	return { engine, dispose: () => engine.dispose() };
}

const MAX_REPLAY_EVENTS = 20_000;
/** Cap of the runtime start retry backoff (startRetryMs doubling): a vault that cannot start costs ~12 tries an hour. */
export const START_RETRY_MAX_MS = 5 * 60_000;

export class ComposedEngine {
	readonly link: HostLink;
	readonly bound: BoundDocs;
	readonly boundBody: BoundBody;
	readonly boundDisk: BoundDisk;
	config: EngineInitConfig | null = null;
	settings: EngineSettings | null = null;
	ports: EnginePorts | null = null;
	rt: VaultRuntime | null = null;
	/** The write gate of this init (null before init). */
	gate: PinGate | null = null;
	/** The keyring main stored, shared by the gate, the KeyReader and each runtime of this init. */
	keyring: HostKeyring | null = null;
	/** Runs instead of a VaultRuntime while the gate is closed. */
	reader: KeyReader | null = null;
	private starting: Promise<void> | null = null;
	private disposed = false;
	paused = false;
	/** Last complete listing and the vault events after it (replayed into a new runtime). */
	private listing: LocalObservation[] | null = null;
	private partialListing: LocalObservation[] = [];
	private eventsSince: VaultEvent[] = [];
	private retryTimer: number | null = null;
	/** Runtime starts failed in a row (the retry backoff). */
	private startFailures = 0;
	private lastStartError: string | null = null;
	private knownEpoch: VaultEpoch | undefined;
	/** The engine clock when init answered ready, and the last runtime start's duration (the device check reports them). */
	private readyAtMs: number | null = null;
	private runtimeStartMs: number | null = null;
	/** The device check running (one at a time); aborted by dispose. */
	private deviceChecking: AbortController | null = null;
	/** The store identity the running runtime or reader authenticates as (identity-per-store §4); null before one. */
	identity: ResolvedIdentity | null = null;
	/** The last registration refusal (cleared by a start that resolves an identity): status and the retry wait. */
	private refused: IdentityRefused | null = null;
	/** Stores this worker ran on before the current one (a store reset): added to the host's lineage. */
	private readonly lineage = new Set<string>();
	/** The key reader is waiting for its identity (startReader). */
	private readerStarting = false;
	/** Carried into the next runtime after an epoch migration (§c.12). */
	private migration: { bases: MetaPathBase[]; docDeletes: MetaDocDeletes[]; frameNoFloor: FrameNoFloor } | null = null;
	private readonly offs: (() => void)[] = [];

	constructor(readonly transport: EngineTransport, readonly options: CreateEngineOptions) {
		this.link = new HostLink(transport, () => this.ports?.hash ?? null);
		this.bound = new BoundDocs({
			post: (m) => this.link.post(m),
			window: () => BUDGETS[this.config?.deviceClass ?? "desktop"].docUpdateWindowBytes,
			durableNow: (docId) => this.rt?.log.bodyDurable(docId) ?? false,
		});
		this.boundDisk = new BoundDisk({
			bound: this.bound, post: (m) => this.link.post(m), runtime: () => this.rt,
			clock: () => this.ports?.clock ?? null, disposed: () => this.disposed,
		});
		this.boundBody = new BoundBody({ bound: this.bound, disk: this.boundDisk, runtime: () => this.rt, diag: (m) => this.log(m) });
		this.offs.push(transport.onMessage((m) => this.onMessage(m)));
	}

	get vaultEpoch(): VaultEpoch | null {
		return this.rt?.vaultEpoch ?? this.reader?.vaultEpoch ?? this.knownEpoch ?? null;
	}

	/** crash = the carrier died (worker killed, app crash; sim/tests): disconnect before anything can flush. */
	dispose(crash = false): void {
		if (this.disposed) return;
		this.disposed = true;
		this.deviceChecking?.abort();
		for (const off of this.offs) off();
		if (this.retryTimer !== null && this.ports) this.ports.clock.clearTimer(this.retryTimer);
		const rt = this.rt;
		this.rt = null;
		if (rt) void rt.stop(crash).catch(() => undefined);
		this.reader?.stop();
		this.reader = null;
		this.link.close();
	}

	private answer(rid: number, value: EngineResultValue): void {
		this.link.post({ t: "result", re: rid, value });
	}

	private fail(rid: number, error: ProtocolError): void {
		this.link.post({ t: "error", re: rid, error });
	}

	private log(line: string): void {
		this.options.log?.(line);
	}

	private onMessage(m: MainToEngine): void {
		if (this.disposed) return;
		switch (m.t) {
			case "ping":
				this.answer(m.rid, { t: "pong" });
				return;
			case "result":
				this.link.settle(m.re, m.value, null);
				return;
			case "error":
				this.link.settle(m.re, null, m.error);
				return;
			case "init":
				void this.init(m.rid, m.config);
				return;
			default:
				break;
		}
		if (!this.config) {
			if ("rid" in m) this.fail(m.rid, { code: "not-ready", message: "init first", retryable: true });
			return;
		}
		void this.dispatch(m).catch((e) => {
			const message = e instanceof Error ? e.message : String(e);
			this.log(`dispatch ${m.t} failed: ${message}`);
			if ("rid" in m) this.fail(m.rid, e instanceof ProtocolFailure ? e.error : { code: "internal", message, retryable: true });
		});
	}

	private async init(rid: number, config: EngineInitConfig): Promise<void> {
		if (config.protocolVersion !== PROTOCOL_VERSION) {
			this.fail(rid, { code: "version-mismatch", message: `host protocol ${config.protocolVersion}, engine ${PROTOCOL_VERSION}`, retryable: false });
			return;
		}
		if (this.config) {
			this.fail(rid, { code: "bad-request", message: "already initialized", retryable: false });
			return;
		}
		try {
			this.ports = await this.options.makePorts(config);
		} catch (e) {
			this.fail(rid, { code: "storage-lost", message: `engine ports: ${e instanceof Error ? e.message : String(e)}`, retryable: true });
			return;
		}
		this.config = config;
		this.settings = config.settings;
		this.keyring = new HostKeyring(this.link, config.crypto);
		// SecretStorage lost its value: the records this device's DB kept (e2ee-design §6.1) let the RK re-key it
		// even after a reset or restore emptied `k` (§11.5, §13.3).
		if (config.crypto.suite === 1 && config.crypto.records.length === 0) {
			this.keyring.mirror = await storedKeyringRecords(this.ports.storage, config.vaultId, config.installKey).catch(() => null);
			if (this.keyring.mirror) this.log(`keyring records from the DB: ${this.keyring.mirror.winners.length} winner(s), ${this.keyring.mirror.open.length} open`);
		}
		try {
			this.gate = await PinGate.open(config.crypto, this.ports, this.gateKeys());
		} finally {
			// makePorts imported the keys (the suite-1 adapter zero-fills them); no copy stays in the config.
			if (config.crypto.suite === 1) for (const x of config.crypto.keys) x.k.fill(0);
		}
		// identity-per-store §13: the identity-less layout's stores go (their unsent edits are on disk).
		const legacy = await deleteLegacyDbs(this.ports.storage, config.vaultId).catch(() => 0);
		if (legacy > 0) this.log(`deleted ${legacy} legacy store(s)`);
		if (this.gate.open) this.knownEpoch = await findKnownEpoch(this.ports.storage, config.vaultId, config.installKey).catch(() => undefined);
		const storageError = await this.startRuntime(null);
		if (storageError) {
			this.config = null;
			this.fail(rid, { code: "storage-lost", message: storageError, retryable: true });
			return;
		}
		this.readyAtMs = this.ports.clock.monotonic();
		this.answer(rid, { t: "ready", protocolVersion: PROTOCOL_VERSION, vaultEpoch: this.vaultEpoch, recovered: this.rt?.recovered ?? false });
		this.postStatus();
	}

	/**
	 * Start (or restart) the vault runtime. Returns a storage error message when
	 * the store is unusable (init answers storage-lost); other failures schedule
	 * a retry and leave the engine protocol-ready without a runtime.
	 */
	private startRuntime(reason: RestartReason | null): Promise<string | null> {
		if (!this.gate!.open) return Promise.resolve(this.startReader());
		const run = (async (): Promise<string | null> => {
			const config = this.config!;
			const ports = this.gate!.writerPorts(this.ports!);
			const startedAt = ports.clock.monotonic();
			try {
				const identity = await this.resolveIdentity();
				const rt = await VaultRuntime.start({
					engine: this, config, identity, settings: this.settings!, ports, carrier: this.options.carrier,
					clientVersion: this.options.clientVersion ?? "dev", vaultEpoch: this.knownEpoch, reason,
					tuning: this.options.tuning, budgets: this.options.budgets, paused: this.paused,
					tzOffsetMinutes: this.options.tzOffsetMinutes, log: this.options.log, onDiag: this.options.onDiag, observe: this.options.observe,
					pathBases: this.migration?.bases ?? null, docDeletes: this.migration?.docDeletes ?? null, frameNoFloor: this.migration?.frameNoFloor ?? null,
				});
				if (this.disposed) {
					await rt.stop();
					return null;
				}
				this.rt = rt;
				this.startFailures = 0;
				// §2.4 point 4: main records the store as its install's lineage `current`.
				this.link.post({ t: "storeIdentity", deviceId: identity.creds.deviceId, retireKey: identity.creds.retireKey });
				this.runtimeStartMs = ports.clock.monotonic() - startedAt;
				this.knownEpoch = rt.vaultEpoch;
				this.migration = null;
				this.lastStartError = null;
				this.options.onRuntime?.(rt);
				await this.replayInto(rt);
				for (const path of [...this.bound.waiting]) rt.checkBindableNow(path);
				return null;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				this.lastStartError = message;
				this.log(`runtime start failed: ${message}`);
				if (isStorageError(e) && reason === null) return message;
				if (!this.identityFailed(e)) this.scheduleRetry();
				this.postStatus();
				return null;
			}
		})();
		const done = run.then(() => undefined);
		this.starting = done;
		void done.finally(() => {
			if (this.starting === done) this.starting = null;
		});
		return run;
	}

	private gateKeys(): GateKeys {
		return { vaultId: this.config!.vaultId, keyring: this.keyring!, diag: (code, fields) => this.log(`${code} ${JSON.stringify(fields)}`) };
	}

	/**
	 * This install's store identity for the next start (storeIdentity.ts), and the relay, blob and side-file
	 * adapters switched to it. Throws IdentityRefused (registration refused) or a storage error.
	 */
	private async resolveIdentity(): Promise<ResolvedIdentity> {
		const ports = this.ports!;
		const config = this.config!;
		const port = ports.identity;
		if (!port) throw new IdentityRefused("no-grant", null);
		const id = await resolveStoreIdentity({
			storage: ports.storage, random: ports.random, hash: ports.hash, identity: port,
			vaultId: config.vaultId, installKey: config.installKey, log: (l) => this.log(l),
		});
		port.use(id.creds.deviceToken);
		this.link.sideDir = id.creds.deviceId;
		// The install's earlier stores: the host's lineage, plus every store this worker ran on before (a store reset
		// mints without a host round trip). Never the store itself.
		if (this.identity && this.identity.creds.deviceId !== id.creds.deviceId) this.lineage.add(this.identity.creds.deviceId);
		const lineage = new Set([...(config.lineage ?? []), ...this.lineage].filter((d) => d !== id.creds.deviceId && DEVICE_ID_SHAPE.test(d)) as DeviceId[]);
		const resolved: ResolvedIdentity = { ...id, lineage };
		this.identity = resolved;
		this.refused = null;
		this.options.onIdentity?.(id.creds.deviceId, id.source);
		return resolved;
	}

	/**
	 * A start failed on a registration refusal (identity-per-store §3.2): say so once, and either stop (only a re-pair
	 * helps: status `revoked`) or retry no sooner than the server asked. False: not a refusal.
	 */
	private identityFailed(e: unknown): boolean {
		if (!(e instanceof IdentityRefused)) return false;
		const first = this.refused?.reason !== e.reason;
		this.refused = e;
		if (first) {
			const n = REFUSAL_NOTICE[e.reason];
			this.link.post({ t: "notice", level: n.level, code: n.code, message: n.text });
		}
		if (!needsRepair(e.reason)) this.scheduleRetry(e.retryAfterMs ?? 0);
		return true;
	}

	/** Gate closed: read `k` (keyReader.ts), as this install's store identity (or its pending one). Never fails init. */
	private startReader(): null {
		if (this.reader || this.disposed || this.readerStarting) return null;
		this.readerStarting = true;
		void this.resolveIdentity().then((id) => {
			this.readerStarting = false;
			if (this.reader || this.disposed || this.gate!.open) return;
			this.runReader(id);
		}, (e: unknown) => {
			this.readerStarting = false;
			const message = e instanceof Error ? e.message : String(e);
			this.lastStartError = message;
			this.log(`key reader start failed: ${message}`);
			if (!this.identityFailed(e)) this.scheduleRetry();
			this.postStatus();
		});
		return null;
	}

	private runReader(id: ResolvedIdentity): void {
		const config = this.config!;
		const gate = this.gate!;
		const reader: KeyReader = new KeyReader({
			ports: gate.readerPorts(this.ports!), vaultId: config.vaultId, deviceId: id.creds.deviceId,
			suite: gate.suite === 1 ? 1 : null, creating: gate.creating, paused: this.paused, keyring: this.keyring!,
			reconnectBaseMs: this.options.tuning?.reconnectBaseMs,
			onChange: () => this.postStatus(),
			onKeyed: (): Promise<boolean> => this.onKeyed(reader),
			log: this.options.log,
		});
		this.reader = reader;
		this.lastStartError = null;
		void reader.start().catch((e) => this.log(`key reader start failed: ${e instanceof Error ? e.message : String(e)}`));
		this.postStatus();
	}

	/**
	 * A suite-1 device that started without the key now holds it, stored by main: if the gate opens, the reader
	 * stops and the VaultRuntime starts in this process (no restart from main needed).
	 */
	private async onKeyed(reader: KeyReader): Promise<boolean> {
		if (this.reader !== reader || this.disposed) return false;
		const open = await this.gate!.recheck(this.ports!, this.gateKeys());
		if (!open || this.reader !== reader || this.disposed) return false;
		this.log("gate open: starting the vault runtime");
		reader.stop();
		this.reader = null;
		this.knownEpoch = await findKnownEpoch(this.ports!.storage, this.config!.vaultId, this.config!.installKey).catch(() => undefined);
		await this.startRuntime("retry");
		this.postStatus();
		return true;
	}

	/** `atLeastMs`: the server's Retry-After (a registration refused for the day). */
	private scheduleRetry(atLeastMs = 0): void {
		const ports = this.ports;
		if (!ports || this.disposed || this.retryTimer !== null) return;
		const base = this.options.startRetryMs ?? 5_000;
		const delay = Math.max(atLeastMs, Math.min(base * 2 ** Math.min(this.startFailures, 20), Math.max(base, START_RETRY_MAX_MS)));
		this.startFailures++;
		this.retryTimer = ports.clock.setTimer(delay, () => {
			this.retryTimer = null;
			if (this.disposed || this.rt || this.starting) return;
			void this.startRuntime("retry");
		});
	}

	/** The network or the app came back while no runtime runs: drop the backoff and retry at once. */
	private retryStartNow(): void {
		if (this.retryTimer === null || !this.ports) return;
		// The server set the wait (Retry-After to 00:00 UTC): coming back online does not end it.
		if (this.refused?.reason === "registration-limit") return;
		this.ports.clock.clearTimer(this.retryTimer);
		this.retryTimer = null;
		this.startFailures = 0;
		if (!this.disposed && !this.rt && !this.starting) void this.startRuntime("retry");
	}

	private async replayInto(rt: VaultRuntime): Promise<void> {
		if (this.listing) {
			await rt.observations(this.listing, true);
			if (this.eventsSince.length > 0) rt.vaultEvents(this.eventsSince);
		}
	}

	/** Stop the current runtime and start a new one (same ports, same transport). */
	async restart(reason: RestartReason, beforeStart?: () => Promise<void>): Promise<void> {
		if (this.disposed || this.reader) return;
		if (this.starting) await this.starting;
		const old = this.rt;
		if (reason === "epoch" && old) {
			const frameNoFloor = ownFrameNoFloor(old);
			const carry = await prepareEpochMigration(old).catch((e) => {
				this.log(`epoch prepare failed: ${String(e)}`);
				return { bases: [], docDeletes: [] };
			});
			this.migration = { ...carry, frameNoFloor };
		}
		this.rt = null;
		this.options.onRuntime?.(null);
		for (const b of [...this.bound.byId.values()]) {
			// The host unbinds and re-opens by path on the new runtime.
			this.link.post({ t: "docRetarget", docId: b.docId, change: { t: "renamed", path: b.path } });
		}
		this.bound.clear();
		this.boundBody.clear();
		if (old) await old.stop().catch((e) => this.log(`runtime stop failed: ${String(e)}`));
		if (beforeStart) await beforeStart();
		if (reason === "epoch") this.knownEpoch = undefined;
		await this.startRuntime(reason);
		this.postStatus();
	}

	postStatus(): void {
		if (this.disposed) return;
		const deviceClass = this.config?.deviceClass ?? "desktop";
		const status: StatusSnapshot = this.rt?.status() ?? this.reader?.status(deviceClass, this.options.carrier) ?? this.idle();
		this.link.post({ t: "status", status });
	}

	/** No runtime and no reader: starting, offline, or a registration refusal (its notice says which). */
	private idle(): StatusSnapshot {
		const nowMs = this.ports?.clock.now() ?? 0;
		const refused = this.refused;
		const phase = refused ? REFUSAL_NOTICE[refused.reason].phase : this.paused ? "paused" : this.lastStartError ? "offline" : "starting";
		const s = idleStatus({ deviceClass: this.config?.deviceClass ?? "desktop", transport: this.options.carrier, vaultEpoch: this.vaultEpoch, phase, nowMs });
		if (!refused) return s;
		const n = REFUSAL_NOTICE[refused.reason];
		return { ...s, notices: [{ code: n.code, level: n.level, atMs: nowMs }] };
	}

	private recordListing(chunk: readonly LocalObservation[], complete: boolean): void {
		this.partialListing.push(...chunk);
		if (!complete) return;
		this.listing = this.partialListing;
		this.partialListing = [];
		this.eventsSince = [];
	}

	private recordEvents(events: readonly VaultEvent[]): void {
		if (!this.listing) return;
		this.eventsSince.push(...events);
		if (this.eventsSince.length > MAX_REPLAY_EVENTS) {
			// Too much churn to replay: forget the listing; the host's next full scan refreshes it.
			this.listing = null;
			this.eventsSince = [];
		}
	}

	private async dispatch(m: Exclude<MainToEngine, { t: "ping" | "result" | "error" | "init" }>): Promise<void> {
		const rt = this.rt;
		switch (m.t) {
			case "shutdown": {
				this.rt = null;
				this.reader?.stop();
				this.reader = null;
				this.options.onRuntime?.(null);
				if (rt) await rt.stop().catch((e) => this.log(`shutdown stop failed: ${String(e)}`));
				this.answer(m.rid, { t: "ok" });
				return;
			}
			case "lifecycle":
				rt?.lifecycle(m.event);
				this.reader?.lifecycle(m.event);
				if (!rt && (m.event === "online" || m.event === "visible" || m.event === "resume")) this.retryStartNow();
				return;
			case "observations":
				this.recordListing(m.chunk, m.complete);
				if (rt) await rt.observations(m.chunk, m.complete);
				this.answer(m.rid, { t: "ok" });
				return;
			case "vaultEvents":
				this.recordEvents(m.events);
				for (const e of m.events) if (e.t === "rename") this.bound.followRename(pathKey(e.from), e.to, pathKey);
				rt?.vaultEvents(m.events);
				this.boundDisk.onVaultEvents(m.events);
				return;
			case "openDoc": {
				if (!rt) {
					this.bound.waiting.add(m.path);
					this.answer(m.rid, { t: "notBindable", reason: "untracked" });
					return;
				}
				this.answer(m.rid, await rt.openDoc(m.path, m.viewId));
				return;
			}
			case "closeDoc":
				if (rt) rt.closeDoc(m.docId, m.viewId);
				else this.bound.remove(m.docId, m.viewId);
				return;
			// Body messages run synchronously up to their first await: their order is the host's (DESIGN §d.3).
			case "textChunk":
				this.boundBody.textChunk(m);
				return;
			case "bodyAttach":
				await this.boundBody.attach(m);
				return;
			case "bodyPush":
				this.boundBody.push(m);
				return;
			case "bodyReload":
				await this.boundBody.reload(m);
				return;
			case "bodySaveMark":
				this.boundBody.saveMark(m);
				return;
			case "docCredit":
				this.bound.credit(m.bytes);
				return;
			case "command":
				this.answer(m.rid, await this.command(m.command));
				return;
			case "hashRequest":
				this.answer(m.rid, await answerHashRequest(m.items, this.ports));
				return;
			case "deviceCheck":
				this.answer(m.rid, await this.deviceCheck(m.mode));
				return;
		}
	}

	/** The on-device self-test on the live ports (deviceCheck.ts). One at a time. */
	private async deviceCheck(mode: DeviceCheckMode): Promise<EngineResultValue> {
		if (this.deviceChecking) throw new ProtocolFailure({ code: "bad-request", message: "a device check is already running", retryable: true });
		const ctl = new AbortController();
		this.deviceChecking = ctl;
		try {
			return { t: "deviceCheck", report: await runDeviceCheck(mode, this.deviceCheckDeps(ctl.signal)) };
		} finally {
			if (this.deviceChecking === ctl) this.deviceChecking = null;
		}
	}

	private deviceCheckDeps(signal: AbortSignal): DeviceCheckDeps {
		const config = this.config!;
		const ports = this.ports!;
		const rt = this.rt;
		const c = rt?.log.c ?? null;
		const why = this.reader
			? "the vault key is missing or not verified: only the key reader runs, no vault runtime"
			: `the vault runtime is not running${this.lastStartError !== null ? ` (its last start failed: ${this.lastStartError})` : " yet"}`;
		return {
			carrier: this.options.carrier,
			clientVersion: this.options.clientVersion ?? "dev",
			platform: config.platform,
			deviceClass: config.deviceClass,
			suite: config.crypto.suite,
			startup: { readyAtMs: this.readyAtMs, runtimeStartMs: this.runtimeStartMs, repoOpenMs: c?.repoOpenMs ?? null },
			env: this.options.deviceEnv ?? (() => null),
			clock: ports.clock,
			random: ports.random,
			hash: ports.hash,
			signal,
			live: rt && c ? {
				crypto: c.deps.crypto,
				blob: c.deps.blob,
				maxBlobBytes: rt.blobs.maxBlobBytes,
				maxAttachmentBytes: rt.settings.maxAttachmentBytes,
				blobBytesInFlight: c.budgets.blobBytesInFlight,
				blobGcGraceMs: c.tuning.blobGcGraceMs,
				phase: () => c.phase,
				session: () => c.session,
				vaultSeq: () => c.repo.cursor.vaultSeq,
				linkGen: () => c.gen,
			} : why,
		};
	}

	private async command(c: UserCommand): Promise<EngineResultValue> {
		const rt = this.rt;
		switch (c.t) {
			case "pause":
				this.paused = true;
				rt?.setPaused(true);
				this.reader?.setPaused(true);
				this.postStatus();
				return { t: "ok" };
			case "resume":
				this.paused = false;
				rt?.setPaused(false);
				this.reader?.setPaused(false);
				if (!rt && !this.reader && !this.starting) void this.startRuntime("retry");
				this.postStatus();
				return { t: "ok" };
			case "updateSettings": {
				const prev = this.settings;
				this.settings = c.settings;
				if (rt && prev && needsRestart(prev, c.settings)) await this.restart("settings");
				else rt?.updateSettings(c.settings);
				return { t: "ok" };
			}
			case "rebuildLocalCache": {
				if (!rt) return { t: "ok" };
				await this.restart("rebuild", async () => undefined);
				return { t: "ok" };
			}
			case "createSnapshot":
			case "listSnapshots":
			case "snapshotFiles":
			case "restoreSnapshot":
			case "deleteSnapshot":
			case "exportDiagnostics":
				// An empty list or `ok` here would read as "no snapshots" / "done".
				if (!rt) throw new ProtocolFailure({ code: "not-ready", message: "the sync engine is not running", retryable: true });
				return rt.command(c);
			case "cleanUpAttachments":
				if (this.reader) return this.reader.command(c);
				if (!rt) throw new ProtocolFailure({ code: "not-ready", message: "the sync engine is not running", retryable: true });
				return rt.command(c);
			case "enableE2ee":
			case "installKey":
			case "pinSuite0":
			case "revokeRekey":
				return this.keyCommand(c);
			default:
				return rt ? rt.command(c) : { t: "ok" };
		}
	}

	/** §18.4: the KeyReader while the gate is shut, else the runtime's keyring. The key bytes never outlive it (§6.3). */
	private async keyCommand(c: KeyCommand): Promise<EngineResultValue> {
		if (this.reader) return this.reader.command(c);
		if (this.rt) return this.rt.command(c);
		wipeSecrets({ t: "command", rid: 0, command: c });
		throw new ProtocolFailure({ code: "not-ready", message: "the sync engine is not running", retryable: true });
	}

	// --- runtime callbacks -------------------------------------------------------

	/** The runtime saw a new vault epoch (§c.12): migrate to a fresh runtime on it. */
	onEpochChanged(_epoch: VaultEpoch | null): void {
		this.log(`epoch changed -> migrating`);
		void this.restart("epoch").then(() => undefined, (e) => this.log(`epoch restart failed: ${String(e)}`));
	}

	/** The store connection died (§i.5): restart; the new runtime recovers from the mirrors. */
	onStorageLost(): void {
		void this.restart("storage-lost").then(() => undefined, (e) => this.log(`storage restart failed: ${String(e)}`));
	}

	/** Started without a blob store and a later connect found one (sessionLoop probeBlobStore): restart on it. */
	onBlobStore(store: BlobPort): void {
		if (!this.ports || this.ports.blob || this.disposed) return;
		this.ports = { ...this.ports, blob: store };
		this.log("blob store available -> restarting");
		void this.restart("blob-store").then(() => undefined, (e) => this.log(`blob-store restart failed: ${String(e)}`));
	}
}

/**
 * Settings whose change rebuilds the runtime: the log reads provisionalBroadcast at start, the
 * reconciler compiles excludes / attachment rules at construction, CfgSync exists only when enabled.
 * Snapshot settings apply in place.
 */
export function needsRestart(a: EngineSettings, b: EngineSettings): boolean {
	return a.provisionalBroadcast !== b.provisionalBroadcast || a.syncAttachments !== b.syncAttachments || a.maxAttachmentBytes !== b.maxAttachmentBytes
		|| a.trashMode !== b.trashMode || a.syncSettings !== b.syncSettings || a.snapshots.uploadToBlobStore !== b.snapshots.uploadToBlobStore
		|| a.excludePatterns.length !== b.excludePatterns.length || a.excludePatterns.some((p, i) => p !== b.excludePatterns[i]);
}

/**
 * How a registration refusal reads (identity-per-store §3.2; relay-wire §2.4.1). The codes are the status notices
 * the host's status bar explains (statusBar.ts identityLine); `phase` is the idle status while no runtime runs.
 */
export const REFUSAL_NOTICE: Readonly<Record<RegisterRefusal, { readonly code: string; readonly level: "warn" | "error"; readonly phase: StatusSnapshot["phase"]; readonly text: string }>> = {
	"network": { code: "registration-unreachable", level: "warn", phase: "offline", text: "YAOS could not reach the server to register this device's local store. Retrying." },
	"unauthorized": { code: "pairing-unknown", level: "error", phase: "revoked", text: "The server does not know this device's pairing. Pair this device again in settings." },
	"grant-revoked": { code: "pairing-revoked", level: "error", phase: "revoked", text: "This device's pairing was revoked on the server. Pair this device again in settings." },
	"grant-required": { code: "pairing-required", level: "error", phase: "revoked", text: "This device was paired by an older YAOS. Pair this device again in settings." },
	"no-grant": { code: "pairing-required", level: "error", phase: "revoked", text: "This device has no pairing. Pair this device in settings." },
	"device-exists": { code: "registration-conflict", level: "warn", phase: "offline", text: "The server refused this device's new identity several times. Retrying." },
	"device-retired": { code: "registration-conflict", level: "warn", phase: "offline", text: "The server refused this device's new identity several times. Retrying." },
	"device-limit": { code: "device-limit", level: "error", phase: "error", text: "This pairing has 50 devices on the server. Remove old devices of this pairing in the server console; YAOS keeps retrying." },
	"registration-limit": { code: "registration-limit", level: "warn", phase: "offline", text: "This pairing registered 20 new local stores today, the server's daily limit. Sync starts again after 00:00 UTC." },
	"rate-limited": { code: "registration-busy", level: "warn", phase: "offline", text: "The server asked YAOS to wait before registering this device's local store. Retrying." },
};
