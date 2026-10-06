/**
 * One simulated streams socket. Server side: open flag, ordinal, rate gate.
 * Client side: the wsRelay adapter role (relay-wire -> RelayEvent mapping,
 * PROVISIONAL join map, pre-listener buffer, exactly one "closed").
 * Uplink and downlink are FIFO timed queues with per-message jitter.
 */

import type { DeviceId, Seq, StreamName, VaultEpoch } from "../core/types";
import type { ClockPort } from "../ports/clock";
import type { Unsubscribe } from "../ports/common";
import type { AppendFrame, FeedPage, PutCheckpointResult, ReadPage, ReadRequest, RelayEvent, RelayLimits, RelaySession } from "../ports/relay";
import { TimedQueue } from "./a-relay-link";
import { appendMessageBytes, heldKey, type DownMsg, type LinkSpec, type UpMsg } from "./a-relay-util";

export interface SessionHost {
	readonly clock: ClockPort;
	/** An uplink message reached the server. */
	arrive(session: SimRelaySession, msg: UpMsg): void;
	feed(session: SimRelaySession, afterSeq: Seq): Promise<FeedPage>;
	read(session: SimRelaySession, stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean): Promise<ReadPage>;
	readBatch(session: SimRelaySession, reqs: readonly ReadRequest[]): Promise<readonly ReadPage[]>;
	putCheckpoint(session: SimRelaySession, stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): Promise<PutCheckpointResult>;
	/** Uniform [0, jitterMs) for this socket's link. */
	jitter(session: SimRelaySession): number;
	listenerError(error: unknown): void;
}

export interface RateGate {
	tokens: number;
	at: number;
	refused: boolean;
}

export class SimRelaySession implements RelaySession {
	// ---- server side ----
	/** The server still treats the socket as open (fan-out target, accepts messages). */
	srvOpen = true;
	gate: RateGate | null = null;

	// ---- client (adapter) side ----
	/** PROVISIONAL payloads held until their COMMIT_NOTICE. */
	readonly held = new Map<string, Uint8Array>();
	private ended = false;
	private errorCode: string | null = null;
	private queue: RelayEvent[] = [];
	private readonly listeners = new Set<(event: RelayEvent) => void>();
	private everListened = false;
	private inFlightBytes = 0;
	private readonly up: TimedQueue<UpMsg>;
	private readonly down: TimedQueue<DownMsg>;
	/** Every RelayEvent produced, in order (introspection; includes buffered ones). */
	readonly log: RelayEvent[] = [];

	constructor(
		private readonly host: SessionHost,
		readonly id: number,
		readonly ordinal: number,
		readonly deviceId: DeviceId,
		readonly vaultEpoch: VaultEpoch,
		readonly headSeq: Seq,
		readonly canWrite: boolean,
		readonly limits: RelayLimits,
		public link: LinkSpec,
	) {
		this.up = new TimedQueue(host.clock, (msg) => {
			if (msg.k === "append") this.inFlightBytes -= msg.bytes;
			host.arrive(this, msg);
		});
		this.down = new TimedQueue(host.clock, (msg) => this.receive(msg));
	}

	/** The client saw "closed" (or closed itself). */
	get closed(): boolean {
		return this.ended;
	}

	/** No link timer armed (undelivered events of a listener-less session do not count). */
	get idle(): boolean {
		return !this.up.busy && !this.down.busy;
	}

	// ---- RelaySession -------------------------------------------------------

	append(frame: AppendFrame): void {
		if (this.ended) return;
		const copy: AppendFrame = { stream: frame.stream, clientFrameId: frame.clientFrameId, payload: frame.payload.slice() };
		const bytes = appendMessageBytes(copy);
		this.inFlightBytes += bytes;
		const rate = this.link.uplinkBytesPerSec ?? 0;
		this.up.push(this.delay(this.link.uplinkMs), { k: "append", frame: copy, bytes }, rate > 0 ? (bytes * 1000) / rate : 0);
	}

	/** Uplink bytes not yet delivered to the relay. */
	bufferedBytes(): number {
		return this.inFlightBytes;
	}

	feed(afterSeq: Seq): Promise<FeedPage> {
		return this.host.feed(this, afterSeq);
	}

	read(stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean): Promise<ReadPage> {
		return this.host.read(this, stream, afterSeq, preferCheckpoint);
	}

	async readBatch(reqs: readonly ReadRequest[]): Promise<readonly ReadPage[]> {
		const first = reqs[0];
		if (first === undefined) throw new RangeError("readBatch: no requests");
		if (this.limits.readBatchStreams <= 1 || reqs.length === 1) return [await this.read(first.stream, first.afterSeq, first.preferCheckpoint)];
		return this.host.readBatch(this, reqs.slice(0, this.limits.readBatchStreams));
	}

	putCheckpoint(stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): Promise<PutCheckpointResult> {
		return this.host.putCheckpoint(this, stream, coversSeq, expectedPrevCoversSeq, bytes.slice());
	}

	onEvent(listener: (event: RelayEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		if (!this.everListened) {
			this.everListened = true;
			const buffered = this.queue;
			this.queue = [];
			for (const event of buffered) this.call(listener, event);
		} else if (this.queue.length > 0) {
			const buffered = this.queue;
			this.queue = [];
			for (const event of buffered) this.dispatch(event);
		}
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Emits "closed" synchronously; frames already on the uplink still reach the relay (then the close). */
	close(code: number, _reason: string): void {
		if (this.ended) return;
		this.ended = true;
		this.held.clear();
		this.down.clear();
		if (this.everListened) this.queue = [];
		this.emit({ t: "closed", code, errorCode: null, wasClean: true });
		this.up.push(this.delay(this.link.uplinkMs), { k: "close", code });
	}

	// ---- server side ----------------------------------------------------------

	delay(base: number | undefined): number {
		return Math.max(0, base ?? 0) + this.host.jitter(this);
	}

	/** Queues a server message on the downlink (dropped once the server closed the socket). */
	send(msg: DownMsg): void {
		if (!this.srvOpen) return;
		this.down.push(this.delay(this.link.downlinkMs), msg);
	}

	/**
	 * Server-initiated close. Clean: optional control error, then the close
	 * frame, after every queued message. Abnormal (network loss): queued
	 * messages both ways are lost; the client sees the close after the downlink delay.
	 */
	serverClose(code: number, errorCode: string | null, wasClean: boolean): void {
		if (!this.srvOpen) return;
		if (wasClean) {
			if (errorCode !== null) this.send({ k: "error", code: errorCode });
			this.send({ k: "close", code, wasClean: true });
			this.srvOpen = false;
			return;
		}
		this.srvOpen = false;
		this.down.clear();
		this.up.clear();
		this.inFlightBytes = 0;
		this.down.push(this.delay(this.link.downlinkMs), { k: "close", code, wasClean: false });
	}

	/** The server learned that the client is gone (client close arrived / restart forgot it). */
	markServerClosed(): void {
		this.srvOpen = false;
	}

	// ---- adapter: wire -> RelayEvent -------------------------------------------

	private receive(msg: DownMsg): void {
		if (this.ended) return;
		switch (msg.k) {
			case "provisional":
				this.held.set(heldKey(msg.stream, msg.deviceId, msg.clientFrameId), msg.payload);
				this.emit({ t: "provisional", stream: msg.stream, deviceId: msg.deviceId, clientFrameId: msg.clientFrameId, payload: msg.payload.slice() });
				return;
			case "committed":
				this.emit({ t: "committed", frame: { stream: msg.stream, seq: msg.seq, deviceId: msg.deviceId, clientFrameId: msg.clientFrameId, payload: msg.payload.slice() } });
				return;
			case "notice": {
				const key = heldKey(msg.stream, msg.deviceId, msg.clientFrameId);
				const payload = this.held.get(key) ?? null;
				this.held.delete(key);
				this.emit({ t: "committed", frame: { stream: msg.stream, seq: msg.seq, deviceId: msg.deviceId, clientFrameId: msg.clientFrameId, payload } });
				return;
			}
			case "receipts":
				for (const r of msg.receipts) this.emit({ t: "receipt", stream: r.stream, clientFrameId: r.clientFrameId, seq: r.seq, deduped: r.deduped });
				this.emit({ t: "head", headSeq: msg.head });
				return;
			case "rejected":
				this.emit({
					t: "refused", stream: msg.stream, clientFrameId: msg.clientFrameId,
					reason: msg.code === "write_forbidden" ? "forbidden" : "frame-id-conflict", retryAfterMs: null, conflictSeq: msg.seq,
				});
				return;
			case "vaultError": {
				const daily = msg.code === "cf_daily_limit";
				const retryAfterMs = daily && msg.resetAt !== null ? Math.max(0, msg.resetAt - this.host.clock.now()) : null;
				for (const clientFrameId of msg.clientFrameIds) {
					this.emit({ t: "refused", stream: msg.stream, clientFrameId, reason: daily ? "daily-limit" : "durability", retryAfterMs, conflictSeq: null });
				}
				return;
			}
			case "dropped":
				this.held.delete(heldKey(msg.stream, msg.deviceId, msg.clientFrameId));
				this.emit({ t: "provisionalDropped", stream: msg.stream, deviceId: msg.deviceId, clientFrameId: msg.clientFrameId });
				return;
			case "resend":
				this.held.clear();
				this.emit({ t: "resendUnreceipted", headSeq: msg.head });
				return;
			case "backpressure":
				this.emit({ t: "backpressure" });
				return;
			case "pong":
				this.emit({ t: "head", headSeq: msg.head });
				return;
			case "error":
				this.errorCode = msg.code;
				return;
			case "close":
				this.ended = true;
				this.held.clear();
				this.up.clear();
				this.inFlightBytes = 0;
				this.emit({ t: "closed", code: msg.code, errorCode: this.errorCode, wasClean: msg.wasClean });
				return;
			case "event":
				if (msg.event.t === "closed") {
					this.ended = true;
					this.held.clear();
					this.up.clear();
					this.inFlightBytes = 0;
				}
				this.emit(msg.event);
				return;
		}
	}

	private emit(event: RelayEvent): void {
		this.log.push(event);
		if (this.listeners.size === 0) this.queue.push(event);
		else this.dispatch(event);
	}

	private dispatch(event: RelayEvent): void {
		for (const listener of Array.from(this.listeners)) this.call(listener, event);
	}

	private call(listener: (event: RelayEvent) => void, event: RelayEvent): void {
		try {
			listener(event);
		} catch (error) {
			this.host.listenerError(error);
		}
	}
}
