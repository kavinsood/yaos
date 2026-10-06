/**
 * HostRuntime: the main-thread side of one paired vault (DESIGN §g, §d, §i.4).
 *
 * Wires EngineHost (carrier), BindingManager (open-note replicas),
 * DiskExecutor (engine disk requests), the vault scan/event feed, lifecycle
 * and side files. No network logic and no UI state here: status/brake/notice
 * events go out through `ui` callbacks.
 */

import { BUDGETS, type DeviceClass } from "../core/limits";
import type { BrakeReport } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { LifecycleEvent, PlatformPort } from "../ports/platform";
import type { ConfigDirPort, SideFilePort, VaultPort } from "../ports/vault";
import type { WorkspacePort } from "../ports/workspace";
import type { ProtocolError } from "../protocol/errors";
import type { EngineResultValue, EngineSettings, HostIoOp, HostIoResult, MainResultValue, UserCommand } from "../protocol/messages";
import type { StatusSnapshot } from "../protocol/status";
import { BindingManager } from "./binding";
import { DiskExecutor } from "./diskExecutor";
import { EngineHost, HostRequestError, type CarrierKind, type EngineCarrier, type EngineEventMessage, type EngineRequestMessage } from "./engineHost";
import type { Hasher } from "./hashing";
import { VaultEventBatcher, buildInitConfig, deviceClassFor, observationChunks, type HostIdentity } from "./runtimeSupport";

export interface HostUiSink {
	onStatus(status: StatusSnapshot): void;
	onBrake(report: BrakeReport): void;
	onNotice(level: "info" | "warn" | "error", code: string, message: string): void;
	onCarrier(info: { readonly carrier: CarrierKind | null; readonly ready: boolean; readonly fallbackReason: string | null }): void;
	onFatal(error: ProtocolError): void;
}

export interface HostRuntimeDeps {
	readonly clock: ClockPort;
	readonly vault: VaultPort;
	readonly configDir: ConfigDirPort;
	readonly sideFiles: SideFilePort;
	readonly workspace: WorkspacePort;
	readonly platform: PlatformPort;
	readonly hasher: Hasher;
	readonly identity: HostIdentity;
	readonly settings: () => EngineSettings;
	readonly createWorker: () => EngineCarrier | null;
	readonly createInline: () => EngineCarrier;
	readonly ui: HostUiSink;
	readonly forceInline?: boolean;
	readonly pingEnabled?: boolean;
	readonly timeZone?: "local" | "utc";
	readonly log?: (line: string) => void;
}

export class HostRuntime {
	readonly engine: EngineHost;
	readonly bindings: BindingManager;
	readonly disk: DiskExecutor;
	private readonly batcher: VaultEventBatcher;
	private readonly offs: (() => void)[] = [];
	private deviceClass: DeviceClass;
	private scanId = 0;
	private scanning: Promise<void> | null = null;
	private rescanWanted = false;
	private reconcileTimer: TimerHandle | null = null;
	private stopped = false;
	/** Counters for tests/diagnostics. */
	readonly stats = { scans: 0, observationsSent: 0, vaultEventBatches: 0, lifecycleFlushes: 0 };

	constructor(private readonly deps: HostRuntimeDeps) {
		this.deviceClass = deviceClassFor(deps.platform.info, deps.forceInline ? "inline" : "worker");
		this.bindings = new BindingManager({
			workspace: deps.workspace,
			vault: deps.vault,
			clock: deps.clock,
			hasher: deps.hasher,
			deviceLabel: () => deps.identity.deviceLabel,
			notice: (level, code, message) => deps.ui.onNotice(level, code, message),
			timeZone: deps.timeZone,
			link: {
				post: (m) => void this.engine.post(m as Parameters<EngineHost["post"]>[0]), // binding posts events only
				openDoc: (path, viewId) => this.engine.request({ t: "openDoc", path, viewId }),
			},
		});
		this.disk = new DiskExecutor({
			vault: deps.vault,
			configDir: deps.configDir,
			clock: deps.clock,
			hasher: deps.hasher,
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
			createWorker: deps.createWorker,
			createInline: deps.createInline,
			forceInline: deps.forceInline,
			pingEnabled: deps.pingEnabled ?? true,
			log: deps.log,
			initConfig: (carrier, workerSupported) => {
				this.deviceClass = deviceClassFor(deps.platform.info, carrier);
				return buildInitConfig({
					identity: deps.identity, platform: deps.platform.info, carrier, workerSupported,
					configDir: deps.vault.configDir, caseInsensitiveFs: deps.vault.caseInsensitive,
					settings: deps.settings(), side: deps.sideFiles,
				});
			},
			handlers: {
				onEvent: (m) => this.onEngineEvent(m),
				onRequest: (m) => this.onEngineRequest(m),
				onReady: () => this.onReady(),
				onDown: () => {
					this.bindings.suspend();
					this.reportCarrier();
				},
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
		const scanId = ++this.scanId;
		this.stats.scans++;
		const stats = await this.deps.vault.list();
		const chunks = observationChunks(stats);
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i] ?? [];
			try {
				await this.engine.request({ t: "observations", scanId, chunk, complete: i === chunks.length - 1 });
			} catch {
				return; // engine went away; the next onReady rescans
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

	private scheduleReconcile(): void {
		if (this.reconcileTimer !== null) this.deps.clock.clearTimer(this.reconcileTimer);
		this.reconcileTimer = this.deps.clock.setTimer(BUDGETS[this.deviceClass].fullReconcileIntervalMs, () => {
			this.reconcileTimer = null;
			if (this.stopped) return;
			void this.scan();
			this.scheduleReconcile();
		});
	}

	private reportCarrier(): void {
		this.deps.ui.onCarrier({ carrier: this.engine.carrierKind, ready: this.engine.isReady, fallbackReason: this.engine.lastFallbackReason });
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
			case "docUpdate":
				this.bindings.onDocUpdate(m.docId, m.update);
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
			case "readRequest":
				return { t: "reads", results: await this.disk.read(m.reads) };
			case "diskOps":
				return { t: "diskOps", results: await this.disk.run(m.lane, m.ops) };
			case "saveViews":
				return { t: "viewSaved", saved: await this.bindings.saveViews(m.docIds) };
			case "sideFileWrite":
				await this.deps.sideFiles.write(m.name, m.bytes);
				return { t: "sideFileWritten" };
			case "sideFileRead":
				return { t: "sideFile", bytes: await this.deps.sideFiles.read(m.name) };
			case "hostIo":
				return { t: "hostIo", result: await this.hostIo(m.op) };
			case "keyringChanged":
				// Nothing stores keys yet (WP-E4: src/host/keys): failing keeps the engine from using them (§18.4 persist-before-use).
				for (const x of m.keys) x.k.fill(0);
				throw new HostRequestError({ code: "refused", message: "this build cannot store encryption keys", retryable: false });
		}
	}

	private async hostIo(op: HostIoOp): Promise<HostIoResult> {
		switch (op.t) {
			case "configList":
				return { t: "configListing", entries: await this.deps.configDir.list(op.dir) };
			case "configRemove":
				await this.deps.configDir.remove(op.path);
				return { t: "done" };
			case "sideFileList":
				return { t: "sideFiles", names: await this.deps.sideFiles.list(op.prefix) };
			case "sideFileRemove":
				await this.deps.sideFiles.remove(op.name);
				return { t: "done" };
		}
	}
}
