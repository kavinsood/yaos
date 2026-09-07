import {
	SOCKET_LIVENESS_TIMEOUT_MS,
	type SocketLivenessDescriptor,
} from "@shared/socketLiveness";

export type SocketLivenessPhase =
	| "disconnected"
	| "awaiting_ready"
	| "healthy"
	| "probing"
	| "suspended"
	| "failed";

export type SocketLivenessFailure =
	| "ready_timeout"
	| "probe_send_failed"
	| "probe_timeout";

export interface SocketLivenessClock {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface SocketLivenessTarget {
	id: string;
	documentId: string;
	isOpen(): boolean;
	sendProbe(probeId: string): void;
	onFailure(reason: SocketLivenessFailure): void;
}

export interface SocketLivenessSnapshot {
	id: string;
	documentId: string;
	phase: SocketLivenessPhase;
	lastAcknowledgedAt: number | null;
	probeStartedAt: number | null;
	timeoutCount: number;
}

interface TargetState {
	target: SocketLivenessTarget;
	connectionEpoch: number;
	phase: SocketLivenessPhase;
	descriptor: SocketLivenessDescriptor | null;
	runtimeEpoch: string | null;
	lastAcknowledgedAt: number | null;
	probeId: string | null;
	probeStartedAt: number | null;
	timeoutCount: number;
	timer: unknown;
}

export class SocketLivenessCoordinator {
	private readonly states = new Map<string, TargetState>();
	private foreground = true;
	private stopped = false;

	constructor(
		private readonly clock: SocketLivenessClock,
		private readonly createProbeId: () => string = () => crypto.randomUUID(),
	) {}

	register(target: SocketLivenessTarget): void {
		this.unregister(target.id);
		this.states.set(target.id, {
			target,
			connectionEpoch: 0,
			phase: "disconnected",
			descriptor: null,
			runtimeEpoch: null,
			lastAcknowledgedAt: null,
			probeId: null,
			probeStartedAt: null,
			timeoutCount: 0,
			timer: null,
		});
	}

	unregister(id: string): void {
		const state = this.states.get(id);
		if (!state) return;
		this.clearTimer(state);
		this.states.delete(id);
	}

	connected(id: string): void {
		const state = this.states.get(id);
		if (!state || this.stopped) return;
		this.clearTimer(state);
		state.connectionEpoch++;
		state.phase = this.foreground ? "awaiting_ready" : "suspended";
		state.descriptor = null;
		state.runtimeEpoch = null;
		state.lastAcknowledgedAt = null;
		state.probeId = null;
		state.probeStartedAt = null;
		this.armReadyTimeout(state);
	}

	disconnected(id: string): void {
		const state = this.states.get(id);
		if (!state) return;
		this.clearTimer(state);
		state.connectionEpoch++;
		state.phase = "disconnected";
		state.descriptor = null;
		state.runtimeEpoch = null;
		state.probeId = null;
		state.probeStartedAt = null;
	}

	ready(id: string, descriptor: SocketLivenessDescriptor, runtimeEpoch: string): void {
		const state = this.states.get(id);
		if (!state || this.stopped || !state.target.isOpen()) return;
		state.descriptor = descriptor;
		state.runtimeEpoch = runtimeEpoch;
		state.lastAcknowledgedAt = this.clock.now();
		state.probeId = null;
		state.probeStartedAt = null;
		state.phase = this.foreground ? "healthy" : "suspended";
		this.armIdleProbe(state);
	}

	acknowledge(id: string, probeId: string, runtimeEpoch: string): boolean {
		const state = this.states.get(id);
		if (!state || state.phase !== "probing" || state.probeId !== probeId
			|| state.runtimeEpoch !== runtimeEpoch || !state.target.isOpen()) return false;
		this.clearTimer(state);
		state.probeId = null;
		state.probeStartedAt = null;
		state.lastAcknowledgedAt = this.clock.now();
		state.phase = this.foreground ? "healthy" : "suspended";
		this.armIdleProbe(state);
		return true;
	}

	probeNow(reason: string): void {
		if (this.stopped || !this.foreground) return;
		for (const state of this.states.values()) {
			if (!state.descriptor || !state.target.isOpen()) continue;
			this.startProbe(state, reason);
		}
	}

	setForeground(foreground: boolean): void {
		if (this.stopped || this.foreground === foreground) return;
		this.foreground = foreground;
		for (const state of this.states.values()) {
			this.clearTimer(state);
			state.probeId = null;
			state.probeStartedAt = null;
			if (!state.target.isOpen()) {
				state.phase = "disconnected";
			} else if (!foreground) {
				state.phase = "suspended";
			} else if (state.descriptor) {
				state.phase = "healthy";
				this.startProbe(state, "foreground");
			} else {
				state.phase = "awaiting_ready";
				this.armReadyTimeout(state);
			}
		}
	}

	snapshot(): readonly SocketLivenessSnapshot[] {
		return [...this.states.values()].map((state) => ({
			id: state.target.id,
			documentId: state.target.documentId,
			phase: state.phase,
			lastAcknowledgedAt: state.lastAcknowledgedAt,
			probeStartedAt: state.probeStartedAt,
			timeoutCount: state.timeoutCount,
		}));
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const state of this.states.values()) this.clearTimer(state);
		this.states.clear();
	}

	private armIdleProbe(state: TargetState): void {
		this.clearTimer(state);
		if (!this.foreground || !state.descriptor || state.phase !== "healthy") return;
		const epoch = state.connectionEpoch;
		state.timer = this.clock.setTimer(() => {
			state.timer = null;
			if (state.connectionEpoch !== epoch) return;
			this.startProbe(state, "idle");
		}, state.descriptor.idleMs);
	}

	private armReadyTimeout(state: TargetState): void {
		this.clearTimer(state);
		if (!this.foreground || state.phase !== "awaiting_ready") return;
		const epoch = state.connectionEpoch;
		state.timer = this.clock.setTimer(() => {
			state.timer = null;
			if (state.connectionEpoch !== epoch || state.phase !== "awaiting_ready") return;
			this.fail(state, "ready_timeout");
		}, SOCKET_LIVENESS_TIMEOUT_MS);
	}

	private startProbe(state: TargetState, _reason: string): void {
		if (!this.foreground || !state.descriptor || !state.target.isOpen()
			|| state.phase === "probing" || state.phase === "failed") return;
		this.clearTimer(state);
		const probeId = this.createProbeId();
		state.probeId = probeId;
		state.probeStartedAt = this.clock.now();
		state.phase = "probing";
		try {
			state.target.sendProbe(probeId);
		} catch {
			this.fail(state, "probe_send_failed");
			return;
		}
		const epoch = state.connectionEpoch;
		state.timer = this.clock.setTimer(() => {
			state.timer = null;
			if (state.connectionEpoch !== epoch || state.probeId !== probeId) return;
			this.fail(state, "probe_timeout");
		}, state.descriptor.timeoutMs);
	}

	private fail(state: TargetState, reason: SocketLivenessFailure): void {
		this.clearTimer(state);
		state.phase = "failed";
		state.probeId = null;
		state.probeStartedAt = null;
		if (reason === "ready_timeout" || reason === "probe_timeout") state.timeoutCount++;
		state.target.onFailure(reason);
	}

	private clearTimer(state: TargetState): void {
		if (state.timer === null) return;
		this.clock.clearTimer(state.timer);
		state.timer = null;
	}
}
