import { EXCALIDRAW_PRESENCE_SURFACE, PRESENCE_MIN_BROADCAST_INTERVAL_MS, PRESENCE_PROTOCOL_VERSION, PRESENCE_TTL_MS,
	type ExcalidrawPresenceState, type PresenceClientUpdate, type PresenceEntry,
	type PresenceServerFrame } from "@shared/presenceProtocol";

export interface PresencePublisher {
	publishPresence(update: PresenceClientUpdate): void | Promise<void>;
}

export interface PresenceClientOptions {
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	minimumPublishIntervalMs?: number;
	ambientPublishIntervalMs?: number;
	remoteSweepIntervalMs?: number;
	refreshIntervalMs?: number;
	onRemoteStates(states: readonly PresenceEntry[]): void;
	onDegraded?(reason: string): void;
}

type LocalPresenceEntry = PresenceEntry & { localExpiresAt: number };

/** Full-state transient state; socket ownership remains with the surface room. */
export class PresenceClient {
	private publisher: PresencePublisher | null = null;
	private readonly remote = new Map<string, LocalPresenceEntry>();
	private localState: ExcalidrawPresenceState | null | undefined;
	private publishPending = false;
	private lastPublishedAt = Number.NEGATIVE_INFINITY;
	private clientSequence = 0;
	private publishTimer: ReturnType<typeof setTimeout> | null = null;
	private sweepTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = true;

	constructor(private readonly options: PresenceClientOptions) {}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.scheduleSweep();
		this.scheduleRefresh();
	}

	bindPublisher(publisher: PresencePublisher | null): void {
		if (this.stopped) return;
		this.publisher = publisher;
		if (!publisher) {
			if (this.remote.size > 0) { this.remote.clear(); this.emitRemote(); }
			return;
		}
		if (this.localState !== undefined) { this.publishPending = true; void this.flush(); }
	}

	updateLocal(state: ExcalidrawPresenceState | null,
		priority: "interactive" | "ambient" = "interactive"): void {
		if (this.stopped) return;
		this.localState = state;
		this.publishPending = true;
		const interval = priority === "interactive"
			? this.options.minimumPublishIntervalMs ?? PRESENCE_MIN_BROADCAST_INTERVAL_MS
			: this.options.ambientPublishIntervalMs ?? 200;
		const remaining = Math.max(0, this.lastPublishedAt + interval - this.now());
		if (remaining === 0) { void this.flush(); return; }
		if (this.publishTimer !== null) return;
		this.publishTimer = this.setTimer(() => {
			this.publishTimer = null;
			void this.flush();
		}, remaining);
	}

	acceptFrame(frame: PresenceServerFrame): void {
		if (this.stopped || frame.surface.kind !== EXCALIDRAW_PRESENCE_SURFACE.kind
			|| frame.surface.version !== EXCALIDRAW_PRESENCE_SURFACE.version) return;
		if (frame.type === "presence.snapshot") {
			this.remote.clear();
			for (const presence of frame.presences) this.install(presence);
			this.emitRemote();
			return;
		}
		if (frame.type === "presence.state") {
			this.install(frame.presence);
			this.emitRemote();
			return;
		}
		if (this.remote.delete(frame.sessionId)) this.emitRemote();
	}

	stop(): void {
		if (this.stopped) return;
		if (this.publisher) {
			const update: PresenceClientUpdate = { type: "presence.update", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
				surface: EXCALIDRAW_PRESENCE_SURFACE, clientSequence: ++this.clientSequence, state: null };
			try { void this.publisher.publishPresence(update); } catch { /* Socket close also removes presence. */ }
		}
		this.stopped = true;
		this.publisher = null;
		this.localState = undefined;
		this.publishPending = false;
		this.cancelTimers();
		if (this.remote.size > 0) { this.remote.clear(); this.emitRemote(); }
	}

	states(): readonly PresenceEntry[] { return [...this.remote.values()]; }

	private async flush(): Promise<void> {
		if (this.stopped || !this.publisher || this.localState === undefined || !this.publishPending) return;
		const state = this.localState;
		this.publishPending = false;
		this.lastPublishedAt = this.now();
		const update: PresenceClientUpdate = { type: "presence.update", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
			surface: EXCALIDRAW_PRESENCE_SURFACE, clientSequence: ++this.clientSequence, state };
		try { await this.publisher.publishPresence(update); }
		catch (error) {
			this.publishPending = true;
			this.options.onDegraded?.(error instanceof Error ? error.message : "Presence publish failed");
		}
	}

	private install(presence: PresenceEntry): void {
		const expiresInMs = presence.expiresInMs;
		if (expiresInMs <= 0) { this.remote.delete(presence.sessionId); return; }
		this.remote.set(presence.sessionId, { ...presence, localExpiresAt: this.now() + expiresInMs });
	}

	private scheduleSweep(): void {
		if (this.stopped || this.sweepTimer !== null) return;
		this.sweepTimer = this.setTimer(() => {
			this.sweepTimer = null;
			const now = this.now();
			let changed = false;
			for (const [sessionId, presence] of this.remote) if (presence.localExpiresAt <= now) {
				this.remote.delete(sessionId); changed = true;
			}
			if (changed) this.emitRemote();
			this.scheduleSweep();
		}, this.options.remoteSweepIntervalMs ?? 1_000);
	}

	private scheduleRefresh(): void {
		if (this.stopped || this.refreshTimer !== null) return;
		this.refreshTimer = this.setTimer(() => {
			this.refreshTimer = null;
			if (this.publisher && this.localState !== undefined) {
				this.publishPending = true;
				void this.flush();
			}
			this.scheduleRefresh();
		}, this.options.refreshIntervalMs ?? Math.floor(PRESENCE_TTL_MS / 3));
	}

	private emitRemote(): void { this.options.onRemoteStates([...this.remote.values()]); }
	private now(): number {
		if (this.options.now) return this.options.now();
		return typeof performance === "undefined" ? Date.now() : performance.now();
	}
	private setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		return (this.options.setTimer ?? setTimeout)(callback, delayMs);
	}
	private clearTimer(timer: ReturnType<typeof setTimeout>): void { (this.options.clearTimer ?? clearTimeout)(timer); }
	private cancelTimers(): void {
		if (this.publishTimer !== null) this.clearTimer(this.publishTimer);
		if (this.sweepTimer !== null) this.clearTimer(this.sweepTimer);
		if (this.refreshTimer !== null) this.clearTimer(this.refreshTimer);
		this.publishTimer = this.sweepTimer = this.refreshTimer = null;
	}
}
