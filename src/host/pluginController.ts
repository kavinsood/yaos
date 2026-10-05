/**
 * Plugin controller: owns the persisted plugin data and the HostRuntime
 * lifecycle, and implements the dynamic half of YaosUiHost (status, run state,
 * commands, restart, settings application). No Obsidian runtime imports, so
 * it runs in node tests; plugin.ts supplies the environment.
 */

import type { BrakeReport, DeviceId, VaultId } from "../core/types";
import type { EngineResultValue, EngineSettings, UserCommand } from "../protocol/messages";
import type { StatusSnapshot } from "../protocol/status";
import type { HostRuntime, HostUiSink } from "./hostRuntime";
import type { HostIdentity } from "./runtimeSupport";
import { sameEngineSettings, sameIdentity, type EngineRunState, type PairedIdentity, type YaosPluginData } from "./ui/api";

export interface ControllerEnv {
	makeRuntime(identity: HostIdentity, settings: () => EngineSettings, ui: HostUiSink): HostRuntime;
	saveData(data: YaosPluginData): Promise<void>;
	notice(level: "info" | "warn" | "error", message: string): void;
	log?(line: string): void;
}

export function hostIdentityOf(id: PairedIdentity, deviceLabel: string): HostIdentity {
	// SECRET: relay.credential is the device token. Never log the result.
	return { vaultId: id.vaultId as VaultId, deviceId: id.deviceId as DeviceId, deviceLabel, relay: { url: id.host, credential: id.deviceToken } };
}

function safeMessage(e: unknown): string {
	return e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
}

export class YaosController {
	private runtime: HostRuntime | null = null;
	private snapshot: StatusSnapshot | null = null;
	private pendingBrake: BrakeReport | null = null;
	private run: EngineRunState;
	private readonly listeners = new Set<() => void>();
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private current: YaosPluginData,
		private readonly env: ControllerEnv,
	) {
		this.run = { phase: current.identity ? "stopped" : "unpaired", transport: null, lastError: null };
	}

	data(): YaosPluginData {
		return this.current;
	}
	status(): StatusSnapshot | null {
		return this.snapshot;
	}
	runState(): EngineRunState {
		return this.run;
	}
	brake(): BrakeReport | null {
		return this.pendingBrake;
	}
	get activeRuntime(): HostRuntime | null {
		return this.runtime;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const l of [...this.listeners]) {
			try {
				l();
			} catch (e) {
				this.env.log?.(`onChange listener threw: ${safeMessage(e)}`);
			}
		}
	}

	private setRun(next: Partial<EngineRunState>): void {
		this.run = { ...this.run, ...next };
		this.changed();
	}

	/** Serialize start/stop/restart so overlapping UI actions cannot interleave. */
	private serial(fn: () => Promise<void>): Promise<void> {
		const p = this.queue.then(fn, fn);
		this.queue = p.catch(() => undefined);
		return p;
	}

	start(): Promise<void> {
		return this.serial(() => this.startNow());
	}

	stop(): Promise<void> {
		return this.serial(() => this.stopNow());
	}

	restartEngine(): Promise<void> {
		return this.serial(async () => {
			await this.stopNow();
			await this.startNow();
		});
	}

	private async startNow(): Promise<void> {
		const identity = this.current.identity;
		if (!identity) {
			this.setRun({ phase: "unpaired", transport: null });
			return;
		}
		if (this.runtime) return;
		const ui: HostUiSink = {
			onStatus: (s) => {
				if (this.runtime !== rt) return;
				this.snapshot = s;
				if (s.brake) this.pendingBrake = s.brake;
				this.changed();
			},
			onBrake: (b) => {
				if (this.runtime !== rt) return;
				this.pendingBrake = b;
				this.changed();
			},
			onNotice: (level, _code, message) => {
				if (this.runtime === rt && level !== "info") this.env.notice(level, message);
			},
			onCarrier: (c) => {
				if (this.runtime !== rt || this.run.phase === "failed") return;
				this.setRun({ phase: c.ready ? "running" : "starting", transport: c.carrier });
			},
			onFatal: (e) => {
				if (this.runtime !== rt) return;
				this.setRun({ phase: "failed", lastError: `${e.code}: ${e.message}` });
				this.env.notice("error", `YAOS stopped: ${e.message}`);
			},
		};
		const rt = this.env.makeRuntime(hostIdentityOf(identity, this.current.deviceLabel), () => this.current.engine, ui);
		this.runtime = rt;
		this.pendingBrake = null;
		this.setRun({ phase: "starting", transport: null, lastError: null });
		try {
			await rt.start();
		} catch (e) {
			if (this.runtime === rt) this.setRun({ phase: "failed", lastError: safeMessage(e) });
		}
	}

	private async stopNow(): Promise<void> {
		const rt = this.runtime;
		this.runtime = null;
		this.snapshot = null;
		this.pendingBrake = null;
		if (rt) {
			try {
				await rt.stop();
			} catch (e) {
				this.env.log?.(`stop failed: ${safeMessage(e)}`);
			}
		}
		this.setRun({ phase: this.current.identity ? "stopped" : "unpaired", transport: null });
	}

	async command(command: UserCommand): Promise<EngineResultValue> {
		const rt = this.runtime;
		if (!rt || this.run.phase !== "running") throw new Error("YAOS is not running.");
		try {
			const value = await rt.command(command);
			if ((command.t === "approveBrake" || command.t === "rejectBrake") && this.pendingBrake?.id === command.brakeId) {
				this.pendingBrake = null;
				this.changed();
			}
			return value;
		} catch (e) {
			throw new Error(safeMessage(e));
		}
	}

	/** Persist, then apply: identity/label change restarts (or stops); engine settings go live. */
	async updateData(mutate: (d: YaosPluginData) => YaosPluginData): Promise<void> {
		const prev = this.current;
		const next = mutate(prev);
		if (next === prev) return;
		this.current = next;
		await this.env.saveData(next);
		if (!sameIdentity(prev.identity, next.identity) || prev.deviceLabel !== next.deviceLabel) {
			await this.restartEngine();
		} else if (!sameEngineSettings(prev.engine, next.engine) && this.runtime && this.run.phase === "running") {
			try {
				await this.runtime.command({ t: "updateSettings", settings: next.engine });
			} catch (e) {
				this.env.notice("warn", `Settings saved; the engine will apply them on restart (${safeMessage(e)}).`);
			}
		}
		this.changed();
	}
}
