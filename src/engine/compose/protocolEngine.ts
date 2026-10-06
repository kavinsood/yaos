/**
 * The engine behind the protocol (DESIGN §g): one instance per carrier
 * (worker or inline). Answers ping in every phase, init -> ready, and routes
 * every other message to the per-epoch VaultRuntime.
 *
 * Protocol-ready is not vault-ready: init answers `ready` as soon as the ports
 * exist, even offline on a fresh device (the runtime keeps retrying in the
 * background). Only an unusable store fails init (`storage-lost`), so the
 * host falls back from the worker to inline (OR-1).
 *
 * The runtime is restarted in-process on an epoch change (§c.12), storage
 * loss (§i.5), rebuildLocalCache and settings changes that need it. Bound
 * docs are retargeted to their path so the host re-opens them on the new
 * runtime; the last complete listing (+ later vault events) is replayed.
 */

import type { DocId, PathKey, VaultEpoch, VaultPath } from "../../core/types";
import { BUDGETS } from "../../core/limits";
import { pathKey } from "../../core/paths/pathKey";
import type { EnginePorts } from "../../ports";
import { findKnownEpoch } from "./knownEpoch";
import { isStorageError } from "../../ports/storage";
import type { VaultEvent } from "../../ports/vault";
import { ProtocolFailure, type ProtocolError } from "../../protocol/errors";
import { PROTOCOL_VERSION, type EngineInitConfig, type EngineResultValue, type EngineSettings, type LocalObservation, type MainToEngine, type UserCommand } from "../../protocol/messages";
import type { StatusSnapshot } from "../../protocol/status";
import type { EngineTransport } from "../../protocol/transport";
import type { Budgets } from "../../core/limits";
import type { EngineTuning } from "../runtime/options";
import { BoundDocs } from "./boundDocs";
import { HostLink } from "./hostLink";
import { idleStatus } from "./statusMerge";
import { prepareEpochMigration } from "./runtimeOps";
import { VaultRuntime, type RestartReason } from "./vaultRuntime";

export interface CreateEngineOptions {
	readonly carrier: "worker" | "inline";
	/** Engine ports for one init. Throwing (store cannot open) answers init with `storage-lost`. */
	makePorts(config: EngineInitConfig): EnginePorts | Promise<EnginePorts>;
	readonly clientVersion?: string;
	readonly tuning?: Partial<EngineTuning>;
	readonly budgets?: Partial<Budgets>;
	/** Retry delay after a failed runtime start (offline fresh device, relay down). */
	readonly startRetryMs?: number;
	/** Test hook: called with each new runtime (null when it stops). */
	readonly onRuntime?: (rt: VaultRuntime | null) => void;
	/** Test hook: diagnostics lines (never secrets). */
	readonly log?: (line: string) => void;
	/** Local time zone offset in minutes (conflict-copy names); the engine core never reads Date. */
	readonly tzOffsetMinutes?: () => number;
	/** Epoch of an existing local DB for this vault/device (offline start); undefined = connect first. */
	findKnownEpoch?(config: EngineInitConfig, ports: EnginePorts): Promise<VaultEpoch | undefined>;
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

export class ComposedEngine {
	readonly link: HostLink;
	readonly bound: BoundDocs;
	config: EngineInitConfig | null = null;
	settings: EngineSettings | null = null;
	ports: EnginePorts | null = null;
	rt: VaultRuntime | null = null;
	private starting: Promise<void> | null = null;
	private disposed = false;
	paused = false;
	/** Last complete listing and the vault events after it (replayed into a new runtime). */
	private listing: LocalObservation[] | null = null;
	private partialListing: LocalObservation[] = [];
	private eventsSince: VaultEvent[] = [];
	private retryTimer: number | null = null;
	private lastStartError: string | null = null;
	private knownEpoch: VaultEpoch | undefined;
	/** Carried into the next runtime after an epoch migration (§c.12). */
	private migration: { bases: Map<PathKey, string>; oldEpoch: VaultEpoch } | null = null;
	private readonly offs: (() => void)[] = [];

	constructor(readonly transport: EngineTransport, readonly options: CreateEngineOptions) {
		this.link = new HostLink(transport);
		this.bound = new BoundDocs({
			post: (m) => this.link.post(m),
			window: () => BUDGETS[this.config?.deviceClass ?? "desktop"].docUpdateWindowBytes,
			fullState: (docId) => this.rt?.fullState(docId) ?? null,
		});
		this.offs.push(transport.onMessage((m) => this.onMessage(m)));
	}

	get vaultEpoch(): VaultEpoch | null {
		return this.rt?.vaultEpoch ?? this.knownEpoch ?? null;
	}

	/** crash = the carrier died (worker killed, app crash; sim/tests): disconnect before anything can flush. */
	dispose(crash = false): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const off of this.offs) off();
		if (this.retryTimer !== null && this.ports) this.ports.clock.clearTimer(this.retryTimer);
		const rt = this.rt;
		this.rt = null;
		if (rt) void rt.stop(crash).catch(() => undefined);
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
		this.link.seedSideFiles(config.sideState.outboxMirror, config.sideState.syncedMirror);
		const find = this.options.findKnownEpoch ?? ((c: EngineInitConfig, p: EnginePorts) => findKnownEpoch(p.storage, c.vaultId, c.deviceId));
		this.knownEpoch = await find(config, this.ports).catch(() => undefined);
		const storageError = await this.startRuntime(null);
		if (storageError) {
			this.config = null;
			this.fail(rid, { code: "storage-lost", message: storageError, retryable: true });
			return;
		}
		this.answer(rid, { t: "ready", protocolVersion: PROTOCOL_VERSION, vaultEpoch: this.vaultEpoch, recovered: this.rt?.recovered ?? false });
		this.postStatus();
	}

	/**
	 * Start (or restart) the vault runtime. Returns a storage error message when
	 * the store is unusable (init answers storage-lost); other failures schedule
	 * a retry and leave the engine protocol-ready without a runtime.
	 */
	private startRuntime(reason: RestartReason | null): Promise<string | null> {
		const run = (async (): Promise<string | null> => {
			const config = this.config!;
			const ports = this.ports!;
			try {
				const rt = await VaultRuntime.start({
					engine: this, config, settings: this.settings!, ports, carrier: this.options.carrier,
					clientVersion: this.options.clientVersion ?? "dev", vaultEpoch: this.knownEpoch, reason,
					tuning: this.options.tuning, budgets: this.options.budgets, paused: this.paused,
					tzOffsetMinutes: this.options.tzOffsetMinutes, log: this.options.log,
					pathBases: this.migration?.bases ?? null, retireEpoch: this.migration?.oldEpoch ?? null,
				});
				if (this.disposed) {
					await rt.stop();
					return null;
				}
				this.rt = rt;
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
				this.scheduleRetry();
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

	private scheduleRetry(): void {
		const ports = this.ports;
		if (!ports || this.disposed || this.retryTimer !== null) return;
		this.retryTimer = ports.clock.setTimer(this.options.startRetryMs ?? 5_000, () => {
			this.retryTimer = null;
			if (this.disposed || this.rt || this.starting) return;
			void this.startRuntime("retry");
		});
	}

	private async replayInto(rt: VaultRuntime): Promise<void> {
		if (this.listing) {
			await rt.observations(this.listing, true);
			if (this.eventsSince.length > 0) rt.vaultEvents(this.eventsSince);
		}
	}

	/** Stop the current runtime and start a new one (same ports, same transport). */
	async restart(reason: RestartReason, beforeStart?: () => Promise<void>): Promise<void> {
		if (this.disposed) return;
		if (this.starting) await this.starting;
		const old = this.rt;
		if (reason === "epoch" && old) {
			const bases = await prepareEpochMigration(old).catch((e) => {
				this.log(`epoch prepare failed: ${String(e)}`);
				return new Map<PathKey, string>();
			});
			this.migration = { bases, oldEpoch: old.vaultEpoch };
		}
		this.rt = null;
		this.options.onRuntime?.(null);
		for (const b of [...this.bound.byId.values()]) {
			// The host unbinds and re-opens by path on the new runtime.
			this.link.post({ t: "docRetarget", docId: b.docId, change: { t: "renamed", path: b.path } });
		}
		this.bound.clear();
		if (old) await old.stop().catch((e) => this.log(`runtime stop failed: ${String(e)}`));
		if (beforeStart) await beforeStart();
		if (reason === "epoch") this.knownEpoch = undefined;
		await this.startRuntime(reason);
		this.postStatus();
	}

	setKnownEpoch(epoch: VaultEpoch | undefined): void {
		this.knownEpoch = epoch;
	}

	postStatus(): void {
		const status: StatusSnapshot = this.rt?.status() ?? idleStatus({
			deviceClass: this.config?.deviceClass ?? "desktop", transport: this.options.carrier, vaultEpoch: this.vaultEpoch,
			phase: this.paused ? "paused" : this.lastStartError ? "offline" : "starting", nowMs: this.ports?.clock.now() ?? 0,
		});
		this.link.post({ t: "status", status });
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
				this.options.onRuntime?.(null);
				if (rt) await rt.stop().catch((e) => this.log(`shutdown stop failed: ${String(e)}`));
				this.answer(m.rid, { t: "ok" });
				return;
			}
			case "lifecycle":
				rt?.lifecycle(m.event);
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
			case "localUpdate":
			case "bindDelta":
				rt?.localUpdate(m.docId, m.update);
				return;
			case "boundSaved":
				rt?.boundSaved(m.docId, m.path, m.stat);
				return;
			case "boundExternalMerged":
				return;
			case "docCredit":
				this.bound.credit(m.bytes);
				return;
			case "command":
				this.answer(m.rid, await this.command(m.command));
				return;
		}
	}

	private async command(c: UserCommand): Promise<EngineResultValue> {
		const rt = this.rt;
		switch (c.t) {
			case "pause":
				this.paused = true;
				rt?.setPaused(true);
				this.postStatus();
				return { t: "ok" };
			case "resume":
				this.paused = false;
				rt?.setPaused(false);
				if (!rt && !this.starting) void this.startRuntime("retry");
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
			default:
				return rt ? rt.command(c) : { t: "ok" };
		}
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

	/** Tests / diagnostics. */
	get runtimeStarting(): Promise<void> | null {
		return this.starting;
	}
	boundDocIds(): DocId[] {
		return [...this.bound.byId.keys()];
	}
	waitingPaths(): VaultPath[] {
		return [...this.bound.waiting];
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
