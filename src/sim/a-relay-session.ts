/**
 * One simulated streams socket. Server side: open flag, ordinal, rate gate.
 * Client side: the wsRelay adapter role (relay-wire -> RelayEvent mapping,
 * PROVISIONAL join map, pre-listener buffer, exactly one "closed", the last
 * subscribe() set resent on STREAM_RESEND).
 * Uplink and downlink are FIFO timed queues with per-message jitter.
 */

import type { ClientFrameId, DeviceId, Seq, StreamName, VaultEpoch } from "../core/types";
import type { ClockPort } from "../ports/clock";
import type { Unsubscribe } from "../ports/common";
import type { AppendFrame, FeedPage, PutCheckpointResult, ReadPage, ReadRequest, RelayEvent, RelayLimits, RelaySession } from "../ports/relay";
import { decodeServerFrame, encodeAppend, encodePing, encodeServerFrame, encodeSubscribe } from "../engine/adapters/relayFrames";
import { READ_BATCH_MAX_QUERY_CHARS } from "../engine/adapters/relayHttp";
import { TimedQueue } from "./a-relay-link";
import { heldKey, type DownMsg, type LinkSpec, type UpMsg } from "./a-relay-util";

/** A server binary frame on the downlink, encoded with the wire codec (relayFrames) and decoded on receipt, like wsRelay. */
type WireDown = DownMsg | { readonly k: "binary"; readonly wire: Uint8Array };

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

/** Per-socket admission state: refused once the socket was closed for size or rate (tokens live in the device's bucket). */
export interface RateGate {
	refused: boolean;
}

export class SimRelaySession implements RelaySession {
	// ---- server side ----
	/** The server still treats the socket as open (fan-out target, accepts messages). */
	srvOpen = true;
	gate: RateGate | null = null;
	/** The accepted STREAM_SUBSCRIBE set; empty until the socket subscribes (or after a restart that lost it). */
	subs: Set<string> = new Set();
	/** The set as persisted in the socket attachment (survives a restart); null = none, or it overflowed. */
	persistedSubs: readonly string[] | null = null;

	// ---- client (adapter) side ----
	/** PROVISIONAL payloads held until their COMMIT_NOTICE. */
	readonly held = new Map<string, Uint8Array>();
	private ended = false;
	private errorCode: string | null = null;
	private queue: RelayEvent[] = [];
	private readonly listeners = new Set<(event: RelayEvent) => void>();
	/** The last subscribe() set (client side); resent on STREAM_RESEND. */
	private subscription: readonly string[] | null = null;
	private everListened = false;
	private inFlightBytes = 0;
	/** ping() calls waiting for their pong, by probe id. */
	private readonly probes = new Map<string, { resolve(headSeq: Seq): void; reject(error: Error): void }>();
	private probeCounter = 0;
	private readonly up: TimedQueue<UpMsg>;
	private readonly down: TimedQueue<WireDown>;
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
		// wsRelay: an oversize payload is a caller bug, thrown before anything is sent (even on a closed session).
		if (frame.payload.byteLength > this.limits.maxFrameBytes) {
			throw new RangeError(`relay append: payload ${frame.payload.byteLength} B exceeds maxFrameBytes ${this.limits.maxFrameBytes}`);
		}
		if (this.ended) return;
		const wire = encodeAppend(frame);
		const bytes = wire.byteLength;
		this.inFlightBytes += bytes;
		const rate = this.link.uplinkBytesPerSec ?? 0;
		this.up.push(this.delay(this.link.uplinkMs), { k: "append", wire, bytes }, rate > 0 ? (bytes * 1000) / rate : 0);
	}

	/** Test hook (a buggy or hostile client): one raw binary message on the uplink, without append()'s size check. */
	sendRawBinary(wire: Uint8Array): void {
		if (this.ended) return;
		this.inFlightBytes += wire.byteLength;
		this.up.push(this.delay(this.link.uplinkMs), { k: "append", wire: wire.slice(), bytes: wire.byteLength });
	}

	/** STREAM_SUBSCRIBE on the uplink (in order with appends). */
	subscribe(streams: readonly StreamName[]): void {
		if (this.ended) return;
		if (streams.length > this.limits.maxSubscriptions) throw new RangeError(`sim subscribe: ${streams.length} streams exceed maxSubscriptions`);
		this.subscription = [...streams];
		this.sendSubscription();
	}

	private sendSubscription(): void {
		if (this.ended || this.subscription === null) return;
		const streams = this.subscription;
		// Text frames are charged in UTF-16 units (server charge()).
		const bytes = encodeSubscribe(streams).length;
		this.up.push(this.delay(this.link.uplinkMs), { k: "subscribe", streams, bytes });
	}

	/** The client's last subscribe() set (null: never subscribed). */
	get subscribed(): readonly string[] | null {
		return this.subscription;
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
		if (reqs.length === 1) return [await this.read(first.stream, first.afterSeq, first.preferCheckpoint)];
		// relayHttp.readBatch: at most readBatchStreams entries, and only those that fit the URL query budget.
		const capped = reqs.slice(0, this.limits.readBatchStreams);
		let q = `maxBytes=${this.limits.readPageBytes}`.length;
		let sent = 0;
		for (const r of capped) {
			const entry = `r=${r.afterSeq}.${r.preferCheckpoint ? 1 : 0}.${encodeURIComponent(r.stream)}`;
			if (sent > 0 && q + entry.length + 1 > READ_BATCH_MAX_QUERY_CHARS) break;
			q += entry.length + 1;
			sent++;
		}
		return this.host.readBatch(this, capped.slice(0, sent));
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

	/** VAULT_PING on the uplink; resolves with the matching pong's head, rejects when the session closes first. */
	ping(): Promise<{ readonly headSeq: Seq }> {
		if (this.ended) return Promise.reject(new Error("relay session closed before the pong"));
		const probeId = `p${++this.probeCounter}`;
		return new Promise((resolve, reject) => {
			this.probes.set(probeId, { resolve: (headSeq) => resolve({ headSeq }), reject });
			this.up.push(this.delay(this.link.uplinkMs), { k: "ping", probeId, bytes: encodePing(probeId).length });
		});
	}

	private failProbes(): void {
		const probes = [...this.probes.values()];
		this.probes.clear();
		for (const p of probes) p.reject(new Error("relay session closed before the pong"));
	}

	/** Emits "closed" synchronously; frames already on the uplink still reach the relay (then the close). */
	close(code: number, _reason: string): void {
		if (this.ended) return;
		this.ended = true;
		this.failProbes();
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
		this.down.push(this.delay(this.link.downlinkMs), toWire(msg));
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

	private receive(raw: WireDown): void {
		if (this.ended) return;
		const msg = raw.k === "binary" ? fromWire(raw.wire) : raw;
		if (msg === null) return; // wsRelay ignores a frame it cannot decode
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
				// A PROVISIONAL of this device's own frame that this socket resent gets no COMMIT_NOTICE (wsRelay).
				for (const r of msg.receipts) this.held.delete(heldKey(r.stream, this.deviceId, r.clientFrameId));
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
			case "skipped":
				this.emit({ t: "skipped", rows: msg.rows.map((r) => ({ stream: r.stream, seq: r.seq })) });
				return;
			case "subscribeRejected":
				return; // the previous set stays; the engine never sends an invalid one
			case "resend":
				this.held.clear();
				// The restart may have lost the set (an overflowed attachment): resend it, as wsRelay does.
				this.sendSubscription();
				this.emit({ t: "resendUnreceipted", headSeq: msg.head });
				return;
			case "backpressure":
				this.emit({ t: "backpressure" });
				return;
			case "pong": {
				const probe = msg.probeId === null ? undefined : this.probes.get(msg.probeId);
				if (probe && msg.probeId !== null) {
					this.probes.delete(msg.probeId);
					probe.resolve(msg.head);
				}
				this.emit({ t: "head", headSeq: msg.head });
				return;
			}
			case "error":
				this.errorCode = msg.code;
				return;
			case "close":
				this.ended = true;
				this.failProbes();
				this.held.clear();
				this.up.clear();
				this.inFlightBytes = 0;
				this.emit({ t: "closed", code: msg.code, errorCode: this.errorCode, wasClean: msg.wasClean });
				return;
			case "event":
				if (msg.event.t === "closed") {
					this.ended = true;
				this.failProbes();
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

/** Binary server frames (PROVISIONAL / COMMITTED / COMMIT_NOTICE / STREAM_SKIPPED) go through the wire codec. */
function toWire(msg: DownMsg): WireDown {
	switch (msg.k) {
		case "provisional": return { k: "binary", wire: encodeServerFrame({ kind: "provisional", stream: msg.stream, deviceId: msg.deviceId, clientFrameId: msg.clientFrameId, payload: msg.payload }) };
		case "committed": return { k: "binary", wire: encodeServerFrame({ kind: "committed", seq: msg.seq, stream: msg.stream, deviceId: msg.deviceId, clientFrameId: msg.clientFrameId, payload: msg.payload }) };
		case "notice": return { k: "binary", wire: encodeServerFrame({ kind: "notice", seq: msg.seq, stream: msg.stream, deviceId: msg.deviceId, clientFrameId: msg.clientFrameId }) };
		case "skipped": return { k: "binary", wire: encodeServerFrame({ kind: "skipped", rows: msg.rows }) };
		default: return msg;
	}
}

function fromWire(wire: Uint8Array): DownMsg | null {
	const f = decodeServerFrame(wire);
	if (f === null) return null;
	if (f.kind === "skipped") return { k: "skipped", rows: f.rows.map((r) => ({ stream: r.stream as StreamName, seq: r.seq })) };
	const id = { stream: f.stream as StreamName, deviceId: f.deviceId as DeviceId, clientFrameId: f.clientFrameId as ClientFrameId };
	if (f.kind === "provisional") return { k: "provisional", ...id, payload: f.payload };
	if (f.kind === "committed") return { k: "committed", ...id, seq: f.seq, payload: f.payload };
	return { k: "notice", ...id, seq: f.seq };
}
