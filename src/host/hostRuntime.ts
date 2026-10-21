/**
 * HostRuntime: the main-thread side of one paired vault (DESIGN §g, §d, §i.4).
 *
 * Wires EngineHost (carrier), BindingManager (open-note replicas),
 * DiskExecutor (engine disk requests), the vault scan/event feed, lifecycle
 * and side files. No network logic and no UI state here: status/brake/notice
 * events go out through `ui` callbacks.
 */

import { BUDGETS, FULL_RECONCILE_IDLE_MAX_MS, type DeviceClass } from "../core/limits";
import type { BrakeReport } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { LifecycleEvent, PlatformPort } from "../ports/platform";
import type { ConfigDirPort, HostSideFilePort, SideFilePath, VaultPort } from "../ports/vault";
import { sideFileDir } from "../ports/vault";
import type { WorkspacePort } from "../ports/workspace";
import type { ProtocolError } from "../protocol/errors";
import type { EngineResultValue, EngineSettings, HostIoOp, HostIoResult, MainResultValue, UserCommand } from "../protocol/messages";
import type { StatusSnapshot } from "../protocol/status";
import { BindingManager } from "./binding";
import { DiskExecutor } from "./diskExecutor";
import { EngineHost, HostRequestError, type CarrierKind, type EngineCarrier, type EngineEventMessage, type EngineRequestMessage } from "./engineHost";
import { engineHashOracle } from "./hashOracle";
import { KeyRefused, type HostKeys } from "./keys/hostKeys";
import { KeyStoreError } from "./keys/secretStore";
import { VaultEventBatcher, buildInitConfig, deviceClassFor, observationChunks, type HostIdentity } from "./runtimeSupport";

export interface HostUiSink {
	onStatus(status: StatusSnapshot): void;
	onBrake(report: BrakeReport): void;
	onNotice(level: "info" | "warn" | "error", code: string, message: string): void;
	onCarrier(info: { readonly carrier: CarrierKind | null; readonly ready: boolean }): void;
	onFatal(error: ProtocolError): void;
	/**
	 * identity-per-store §2.4 point 4: a runtime started on this store (every start; the same one again after a
	 * restart). Main records it as the install's lineage `current` (installRecord.ts). SECRET: retireKey.
	 */
	onStoreIdentity?(deviceId: string, retireKey: string): void;
	/**
	 * identity-per-store §3.4: the pairing secret was rotated on the server and the engine fetched the new one with its
	 * store's token. Main rewrites data.json's grant (no restart: the engine uses it already). SECRET.
	 */
	onGrantSecret?(grantSecret: string): void;
}

export interface HostRuntimeDeps {
	readonly clock: ClockPort;
	readonly vault: VaultPort;
	readonly configDir: ConfigDirPort;
	/** `<configDir>/plugins/yaos/state/`, addressed `<deviceId>/<name>` (identity-per-store §5.2). */
	readonly sideFiles: HostSideFilePort;
	readonly workspace: WorkspacePort;
	readonly platform: PlatformPort;
	readonly identity: HostIdentity;
	readonly settings: () => EngineSettings;
	/** The engine's keys and the keyringChanged store (e2ee-design §6.3, §18.4). */
	readonly keys: HostKeys;
	/** The engine's one carrier (plugin: the worker; tests and harnesses: an in-process pair). */
	readonly createCarrier: () => EngineCarrier;
	readonly ui: HostUiSink;
	readonly pingEnabled?: boolean;
	readonly log?: (line: string) => void;
}

export class HostRuntime {
	readonly engine: EngineHost;
	readonly bindings: BindingManager;
	readonly disk: DiskExecutor;
	private readonly batcher: VaultEventBatcher;
	private readonly offs: (() => void)[] = [];
	private readonly deviceClass: DeviceClass;
	private scanning: Promise<void> | null = null;
	private rescanWanted = false;
	private reconcileTimer: TimerHandle | null = null;
	/** Periodic scans in a row that found the listing unchanged (the idle backoff). */
	private reconcileIdle = 0;
	/** The last scan's listing (path, size, mtime), to tell an unchanged vault. */
	private lastListing: string | null = null;
	private listingChanged = true;
	private stopped = false;
	/** Counters for tests/diagnostics. */
	readonly stats = { scans: 0, observationsSent: 0, vaultEventBatches: 0, lifecycleFlushes: 0 };

	constructor(private readonly deps: HostRuntimeDeps) {
		this.deviceClass = deviceClassFor(deps.platform.info);
		this.bindings = new BindingManager({
			workspace: deps.workspace,
			vault: deps.vault,
			clock: deps.clock,
			notice: (level, code, message) => deps.ui.onNotice(level, code, message),
			link: {
				post: (m) => void this.engine.post(m as Parameters<EngineHost["post"]>[0]), // binding posts events only
				openDoc: (path, viewId) => this.engine.request({ t: "openDoc", path, viewId }),
			},
		});
		this.disk = new DiskExecutor({
			vault: deps.vault,
			configDir: deps.configDir,
			clock: deps.clock,
			// Config-area preconditions are hashed by this runtime's engine (main never hashes).
			hashes: engineHashOracle((body) => this.engine.request(body)),
			isBoundPath: (p) => this.bindings.isBoundPath(p),
			flushBoundPath: (p) => this.bindings.flushPath(p),
			budgets: () => BUDGETS[this.deviceClass],
		});
		this.batcher = new VaultEventBatcher(deps.clock, (events) => {
			this.stats.vaultEventBatches++;
			this.engine.post({ t: "vaultEvents", events });
		});
		this.engine = new EngineHost({
			clock: deps.clock,
			createCarrier: deps.createCarrier,
			pingEnabled: deps.pingEnabled ?? true,
			log: deps.log,
			initConfig: async () => {
				// Keys are loaded per start, as fresh buffers that move into the engine (§6.3).
				return buildInitConfig({
					identity: deps.identity, platform: deps.platform.info,
					configDir: deps.vault.configDir, caseInsensitiveFs: deps.vault.caseInsensitive,
					settings: deps.settings(), crypto: await deps.keys.crypto(),
				});
			},
			handlers: {
				onEvent: (m) => this.onEngineEvent(m),
				onRequest: (m) => this.onEngineRequest(m),
				onReady: () => this.onReady(),
				onFatal: (e) => {
					this.bindings.stop();
					this.reportCarrier();
					deps.ui.onFatal(e);
				},
			},
		});
	}

	get currentDeviceClass(): DeviceClass {
		return this.deviceClass;
	}

	async start(): Promise<void> {
		this.offs.push(this.deps.vault.onEvent((e) => {
			this.bindings.onVaultEvent(e);
			if (this.engine.isReady) this.batcher.push(e);
			this.reconcileActive();
		}));
		this.offs.push(this.deps.platform.onLifecycle((e) => this.onLifecycle(e)));
		await this.engine.start();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const off of this.offs) off();
		this.offs.length = 0;
		if (this.reconcileTimer !== null) this.deps.clock.clearTimer(this.reconcileTimer);
		this.bindings.stop();
		this.batcher.flush();
		this.batcher.dispose();
		await this.engine.stop();
	}

	/** User command; reconcileNow rescans first so the engine sees fresh stats. */
	async command(command: UserCommand): Promise<EngineResultValue> {
		if (command.t === "reconcileNow") await this.scan();
		return this.engine.request({ t: "command", command });
	}

	/** Full listing -> observations (sequential chunks, each acked). Coalesces concurrent calls. */
	scan(): Promise<void> {
		if (this.scanning) {
			this.rescanWanted = true;
			return this.scanning;
		}
		const run = (async () => {
			do {
				this.rescanWanted = false;
				await this.scanOnce();
			} while (this.rescanWanted && !this.stopped);
		})().finally(() => {
			this.scanning = null;
		});
		this.scanning = run;
		return run;
	}

	private async scanOnce(): Promise<void> {
		if (!this.engine.isReady) return;
		this.stats.scans++;
		const stats = await this.deps.vault.list();
		const listing = stats.map((s) => `${s.path}\u0000${s.size}\u0000${s.mtimeMs}`).sort().join("\u0001");
		if (listing !== this.lastListing) this.listingChanged = true;
		this.lastListing = listing;
		const chunks = observationChunks(stats);
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i] ?? [];
			try {
				await this.engine.request({ t: "observations", chunk, complete: i === chunks.length - 1 });
			} catch {
				return; // engine stopped (unload or fatal)
			}
			this.stats.observationsSent += chunk.length;
		}
	}

	private onReady(): void {
		this.reportCarrier();
		this.bindings.start();
		void this.scan();
		this.scheduleReconcile();
	}

	/**
	 * The periodic full scan: every fullReconcileIntervalMs, doubling while scans find the listing unchanged, up to
	 * FULL_RECONCILE_IDLE_MAX_MS; a vault event resets it (reconcileActive).
	 */
	private scheduleReconcile(): void {
		if (this.reconcileTimer !== null) this.deps.clock.clearTimer(this.reconcileTimer);
		const base = BUDGETS[this.deviceClass].fullReconcileIntervalMs;
		const delay = Math.min(base * 2 ** Math.min(this.reconcileIdle, 10), Math.max(base, FULL_RECONCILE_IDLE_MAX_MS));
		this.reconcileTimer = this.deps.clock.setTimer(delay, () => {
			this.reconcileTimer = null;
			if (this.stopped) return;
			this.listingChanged = false;
			void this.scan().finally(() => {
				if (this.stopped) return;
				this.reconcileIdle = this.listingChanged ? 0 : this.reconcileIdle + 1;
				if (this.reconcileTimer === null) this.scheduleReconcile();
			});
		});
	}

	/** Vault activity: the periodic scan back to its base interval. */
	private reconcileActive(): void {
		if (this.reconcileIdle === 0) return;
		this.reconcileIdle = 0;
		if (this.reconcileTimer !== null) this.scheduleReconcile(); // else a scan is running: it re-arms
	}

	private reportCarrier(): void {
		this.deps.ui.onCarrier({ carrier: this.engine.carrierKind, ready: this.engine.isReady });
	}

	/** §i.4: hidden/pagehide/freeze flush synchronously before the OS may kill us. */
	private onLifecycle(event: LifecycleEvent): void {
		if (event === "hidden" || event === "pagehide" || event === "freeze") {
			this.stats.lifecycleFlushes++;
			this.bindings.flushAll();
			this.batcher.flush();
			this.engine.post({ t: "lifecycle", event });
			void this.bindings.saveViews(this.bindings.boundDocs());
			return;
		}
		this.engine.post({ t: "lifecycle", event });
		if (event === "visible" || event === "resume") void this.scan();
	}

	private onEngineEvent(m: EngineEventMessage): void {
		switch (m.t) {
			case "body":
				this.bindings.onBody(m.docId, m.event, m.weight);
				return;
			case "docRetarget":
				this.bindings.onDocRetarget(m.docId, m.change);
				return;
			case "bindable":
				this.bindings.onBindable(m.path);
				return;
			case "status":
				this.deps.ui.onStatus(m.status);
				return;
			case "storeIdentity":
				this.deps.ui.onStoreIdentity?.(m.deviceId, m.retireKey);
				return;
			case "grantSecret":
				this.deps.ui.onGrantSecret?.(m.grantSecret);
				return;
			case "brake":
				this.deps.ui.onBrake(m.report);
				return;
			case "notice":
				this.deps.ui.onNotice(m.level, m.code, m.message);
				return;
		}
	}

	private async onEngineRequest(m: EngineRequestMessage): Promise<MainResultValue> {
		switch (m.t) {
			// A result reflects the disk now: the events that changed it go out first (§g.3). Batched, a rename's
			// event reached the engine after a read of its source said "missing", and the engine deleted the doc
			// and created a new one for the target (sim canvas seed 20701862: a concurrent edit then restored the
			// old doc with the records the user had deleted).
			case "readRequest": {
				const results = await this.disk.read(m.reads);
				this.batcher.flush();
				return { t: "reads", results };
			}
			case "diskOps": {
				const results = await this.disk.run(m.lane, m.ops);
				this.batcher.flush();
				return { t: "diskOps", results };
			}
			case "saveViews":
				return { t: "viewSaved", saved: await this.bindings.saveViews(m.docIds) };
			case "sideFileWrite":
				await this.deps.sideFiles.write(sidePath(m.name), m.bytes);
				return { t: "sideFileWritten" };
			case "sideFileRead":
				return { t: "sideFile", bytes: await this.deps.sideFiles.read(sidePath(m.name)) };
			case "hostIo":
				return { t: "hostIo", result: await this.hostIo(m.op) };
			case "keyringChanged":
				return this.keyringChanged(m);
		}
	}

	/**
	 * §18.4 persist-before-use: the answer goes out only after SecretStorage holds the change and main saved its pin
	 * decision. Failures carry fixed, secret-free text (never the SecretStorage error or any value).
	 */
	private async keyringChanged(m: Extract<EngineRequestMessage, { t: "keyringChanged" }>): Promise<MainResultValue> {
		try {
			await this.deps.keys.persist({ keys: m.keys, records: m.records, pending: m.pending });
		} catch (error) {
			if (error instanceof KeyRefused) throw new HostRequestError({ code: "refused", message: error.message, retryable: false });
			if (error instanceof KeyStoreError) throw new HostRequestError({ code: "vault-io", message: error.message, retryable: error.reason === "unavailable" });
			throw new HostRequestError({ code: "internal", message: "could not store the vault key", retryable: true });
		}
		return { t: "keyringStored" };
	}

	private async hostIo(op: HostIoOp): Promise<HostIoResult> {
		switch (op.t) {
			case "configList":
				return { t: "configListing", entries: await this.deps.configDir.list(op.dir) };
			case "configRemove":
				await this.deps.configDir.remove(op.path);
				return { t: "done" };
			case "sideFileList":
				sidePath(op.prefix);
				return { t: "sideFiles", names: await this.deps.sideFiles.list(op.prefix) };
			case "sideFileRemove":
				await this.deps.sideFiles.remove(sidePath(op.name));
				return { t: "done" };
		}
	}
}

/** The engine names side files in a store dir, `<deviceId>/...`; anything else (a path escape) is refused. */
function sidePath<P extends string>(name: P): P & SideFilePath {
	if (sideFileDir(name) === null || name.includes("..") || name.includes("\\")) {
		throw new HostRequestError({ code: "bad-request", message: "side file outside a store dir", retryable: false });
	}
	return name as P & SideFilePath;
}
