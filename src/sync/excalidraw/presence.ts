import type { ExcalidrawHostPresence, ExcalidrawHostRemotePresence } from "./host";
import type { ExcalidrawPresenceState, PresenceServerFrame } from "@shared/presenceProtocol";
import { PresenceClient, type PresencePublisher } from "../presence/client";

export interface ExcalidrawPresenceHost {
	applyPresence(peers: readonly ExcalidrawHostRemotePresence[]): boolean;
}

export interface ExcalidrawPresenceControllerOptions {
	drawingId: string;
	drawingEpoch: number;
	host: ExcalidrawPresenceHost;
	now?: () => number;
	idleAfterMs?: number;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	onDegraded?(reason: string): void;
}

/** Excalidraw mapping around the generic transient presence kernel. */
export class ExcalidrawPresenceController {
	private readonly client: PresenceClient;
	private latest: ExcalidrawHostPresence | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = true;

	constructor(private readonly options: ExcalidrawPresenceControllerOptions) {
		this.client = new PresenceClient({
			now: options.now,
			setTimer: options.setTimer,
			clearTimer: options.clearTimer,
			onDegraded: (reason) => options.onDegraded?.(reason),
			onRemoteStates: (states) => {
				options.host.applyPresence(states.map((state) => ({
					sessionId: state.sessionId,
					displayName: state.identity.displayName,
					principalId: state.identity.principalId,
					color: state.identity.color,
					colorLight: state.identity.colorLight,
					presence: fromWireState(state.state),
				})));
			},
		});
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.client.start();
	}

	bindPublisher(publisher: PresencePublisher | null): void { this.client.bindPublisher(publisher); }
	acceptFrame(frame: PresenceServerFrame): void { this.client.acceptFrame(frame); }

	capture(presence: ExcalidrawHostPresence, source: "pointer" | "scene"): void {
		if (this.stopped) return;
		this.latest = presence;
		this.client.updateLocal(toWireState(presence), source === "pointer" ? "interactive" : "ambient");
		this.scheduleIdle();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.idleTimer !== null) this.clearTimer(this.idleTimer);
		this.idleTimer = null;
		this.latest = null;
		this.client.stop();
		this.options.host.applyPresence([]);
	}

	private scheduleIdle(): void {
		if (this.idleTimer !== null) this.clearTimer(this.idleTimer);
		this.idleTimer = this.setTimer(() => {
			this.idleTimer = null;
			if (this.stopped || !this.latest) return;
			this.latest = { ...this.latest, pointer: null, activeElementId: null,
				interaction: "idle", idle: true };
			this.client.updateLocal(toWireState(this.latest), "ambient");
		}, this.options.idleAfterMs ?? 30_000);
	}

	private setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		return (this.options.setTimer ?? setTimeout)(callback, delayMs);
	}
	private clearTimer(timer: ReturnType<typeof setTimeout>): void {
		(this.options.clearTimer ?? clearTimeout)(timer);
	}
}

function toWireState(presence: ExcalidrawHostPresence): ExcalidrawPresenceState {
	const pointer = presence.pointer?.tool === "pointer" ? { x: presence.pointer.x, y: presence.pointer.y,
		tool: "pointer", button: presence.pointer.button } : undefined;
	const laser = presence.pointer?.tool === "laser" ? { x: presence.pointer.x, y: presence.pointer.y } : undefined;
	return {
		...(pointer ? { pointer } : {}),
		...(laser ? { laser } : {}),
		selectedElementIds: presence.selectedElementIds,
		activeElementId: presence.activeElementId,
		editingElementId: presence.interaction === "editing" ? presence.activeElementId : null,
		interaction: presence.interaction,
		...(presence.viewport ? { viewport: presence.viewport } : {}),
		followSessionId: presence.followSessionId,
		idle: presence.idle ? "idle" : "active",
	};
}

function fromWireState(presence: ExcalidrawPresenceState): ExcalidrawHostPresence {
	const pointer = presence.laser ? { ...presence.laser, tool: "laser" as const, button: "down" as const }
		: presence.pointer ? { ...presence.pointer, tool: presence.pointer.tool === "laser" ? "laser" as const : "pointer" as const } : null;
	return {
		pointer,
		selectedElementIds: presence.selectedElementIds ?? [],
		activeElementId: presence.activeElementId ?? presence.editingElementId ?? null,
		interaction: presence.interaction === "editing" || presence.interaction === "dragging"
			? presence.interaction : presence.interaction === "idle" ? "idle" : "pointing",
		viewport: presence.viewport ?? null,
		followSessionId: presence.followSessionId ?? null,
		idle: presence.idle !== "active",
	};
}
