/**
 * SimRelay engine: per-socket raw admission (token bucket), APPEND parsing
 * and admission, the vault-wide pending buffer, group commit (idle / max /
 * bytes timers on the ClockPort), fan-out and failures, subscriptions
 * (relay-wire §5.6: STREAM_SUBSCRIBE, filtered fan-out with inline
 * STREAM_SKIPPED runs, the set persisted in the "attachment" when it fits).
 * Mirrors server/src/streams/relay.ts (StreamRelayService) message for message.
 */

import { bytesEqual, utf8ByteLength } from "../core/codec/lib0";
import type { ClientFrameId, DeviceId, Seq, StreamName } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { RelayLimits } from "../ports/relay";
import { decodeAppend } from "../engine/adapters/relayFrames";
import type { SimRelaySession } from "./a-relay-session";
import type { RelayStore, StoreOutcome } from "./a-relay-store";
import {
	SIM_MAX_SUBSCRIPTIONS,
	SIM_MAX_TEXT_MESSAGE_BYTES,
	SIM_MESSAGE_SLACK_BYTES,
	SIM_SUBSCRIPTION_ATTACHMENT_BYTES,
	frameKey,
	isProvisionalStream,
	nextUtcMidnight,
	validClientFrameId,
	validStreamName,
	type GroupCommitSpec,
	type SimRow,
	type UpMsg,
} from "./a-relay-util";

export interface PendingFrame {
	readonly key: string;
	readonly stream: StreamName;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly payload: Uint8Array;
	readonly origin: SimRelaySession;
	/** Resends of the same frame while pending: each gets a deduped:true receipt. */
	readonly duplicates: SimRelaySession[];
	readonly provisional: boolean;
	/** Sockets that were sent the PROVISIONAL (they get a COMMIT_NOTICE or STREAM_PROVISIONAL_DROPPED). */
	readonly provisionalTo: Set<SimRelaySession>;
}

export type FlushReason = "lead" | "idle" | "max" | "bytes" | "forced";

/**
 * Outcome of one group commit. durability / daily-limit: nothing written,
 * every frame refused. restart-before: runtime lost before the write (buffer
 * gone unacked). restart-after: rows written, runtime lost before fan-out
 * (no broadcasts or receipts; sockets get STREAM_RESEND).
 */
export type CommitFault = "commit" | "durability" | "daily-limit" | "restart-before" | "restart-after";

export interface SimCommitInfo {
	readonly index: number;
	readonly reason: FlushReason;
	readonly fault: CommitFault;
	readonly frames: readonly { readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId }[];
	/** Empty unless the store was written. */
	readonly outcomes: readonly StoreOutcome[];
	readonly rows: readonly SimRow[];
	readonly head: Seq;
}

export type CommitHook = (info: { readonly index: number; readonly reason: FlushReason; readonly frames: number }) => CommitFault;

export interface SimRelayCounters {
	appendFrames: number;
	pendingDedupes: number;
	storeDedupes: number;
	conflicts: number;
	commits: number;
	committedRows: number;
	commitFailures: number;
	flushLead: number;
	flushIdle: number;
	flushMax: number;
	flushBytes: number;
	flushForced: number;
	provisionalBroadcasts: number;
	notices: number;
	committedBroadcasts: number;
	provisionalDrops: number;
	rateCloses: number;
	oversizeCloses: number;
	policyCloses: number;
	rawDrops: number;
	writeForbidden: number;
	dailyLimitRejects: number;
	wakeNotices: number;
	authorityCloses: number;
	droppedPending: number;
	/** Subscriptions: appended rows sent as a STREAM_SKIPPED seq instead of a payload, and the frames carrying them. */
	skippedRows: number;
	skipFrames: number;
	subscribes: number;
	subscribeRejects: number;
}

/** Per device, over all its sockets: b:/c: rows pushed (COMMITTED / COMMIT_NOTICE) and skipped. */
export interface SimDeviceFanout {
	pushedRows: number;
	skippedRows: number;
}

export function newCounters(): SimRelayCounters {
	return {
		appendFrames: 0, pendingDedupes: 0, storeDedupes: 0, conflicts: 0, commits: 0, committedRows: 0, commitFailures: 0,
		flushLead: 0, flushIdle: 0, flushMax: 0, flushBytes: 0, flushForced: 0, provisionalBroadcasts: 0, notices: 0, committedBroadcasts: 0,
		provisionalDrops: 0, rateCloses: 0, oversizeCloses: 0, policyCloses: 0, rawDrops: 0, writeForbidden: 0,
		dailyLimitRejects: 0, wakeNotices: 0, authorityCloses: 0, droppedPending: 0, skippedRows: 0, skipFrames: 0,
		subscribes: 0, subscribeRejects: 0,
	};
}

export interface EngineConfig {
	readonly limits: RelayLimits;
	readonly groupCommit: GroupCommitSpec;
	readonly autoCommit: boolean;
}

export class RelayEngine {
	readonly counters = newCounters();
	readonly fanout = new Map<DeviceId, SimDeviceFanout>();
	/** Accepted sockets in ordinal order (closed ones are pruned lazily). */
	open: SimRelaySession[] = [];
	socketOrdinal = 0;
	pending: PendingFrame[] = [];
	readonly pendingByKey = new Map<string, PendingFrame>();
	pendingBytes = 0;
	paused = false;
	commitHook: CommitHook | null = null;
	readonly faults: { readonly fault: CommitFault; readonly retryAfterMs: number | null }[] = [];
	readonly commitListeners = new Set<(info: SimCommitInfo) => void>();
	/** Hostile relay (SimRelay.hideFrom): rows of a hidden stream are never pushed to that device. */
	hiddenFor: (deviceId: DeviceId, stream: StreamName) => boolean = () => false;
	/** Cloudflare-side daily row limit exhausted until this wall time (0 = not). */
	envDailyUntil = 0;
	/** Server latch (DailyLimitLatch.until). */
	latchUntil = 0;
	private commitIndex = 0;
	private idleTimer: TimerHandle | null = null;
	private maxTimer: TimerHandle | null = null;
	private lastCommitAt = Number.NEGATIVE_INFINITY;
	/** Leading-edge commit due time (server leadAt): set by the first append after quietMs without a commit. */
	private leadAt: number | null = null;
	/** H6 rate buckets, per device (shared by all its sockets, like the server's); in-memory, reset on restart. */
	readonly buckets = new Map<DeviceId, { tokens: number; at: number }>();

	constructor(private readonly clock: ClockPort, readonly store: RelayStore, private readonly config: EngineConfig) {}

	get timersArmed(): boolean {
		return this.idleTimer !== null || this.maxTimer !== null;
	}

	streamSockets(): SimRelaySession[] {
		if (this.open.some((s) => !s.srvOpen)) this.open = this.open.filter((s) => s.srvOpen);
		return this.open;
	}

	accept(session: SimRelaySession): void {
		this.open.push(session);
	}

	nextOrdinal(): number {
		return ++this.socketOrdinal;
	}

	dailyActive(): boolean {
		return this.clock.now() < this.latchUntil;
	}

	envDailyActive(): boolean {
		return this.clock.now() < this.envDailyUntil;
	}

	/** Records a daily-limit failure: latch until retryAfterMs from now, else until the env limit lifts, else the next 00:00 UTC. */
	latchDaily(retryAfterMs: number | null): void {
		const now = this.clock.now();
		this.latchUntil = retryAfterMs !== null ? now + retryAfterMs : this.envDailyUntil > now ? this.envDailyUntil : nextUtcMidnight(now);
	}

	serverClose(session: SimRelaySession, code: number, errorCode: string | null, wasClean: boolean): void {
		session.serverClose(code, errorCode, wasClean);
		session.gate = null;
	}

	// ---- messages ---------------------------------------------------------------

	arrive(session: SimRelaySession, msg: UpMsg): void {
		if (msg.k === "close") {
			session.markServerClosed();
			session.gate = null;
			return;
		}
		if (!session.srvOpen) {
			if (session.gate?.refused === true) this.counters.rawDrops++;
			return;
		}
		// Every message is charged before parsing, text (subscribe, ping) in UTF-16 units (server message()).
		if (!this.charge(session, msg.bytes, msg.k !== "append")) return;
		if (msg.k === "ping") session.send({ k: "pong", head: this.store.head(), probeId: msg.probeId });
		else if (msg.k === "subscribe") this.subscribe(session, msg.streams);
		else this.append(session, msg.wire);
	}

	/**
	 * STREAM_SUBSCRIBE: replaces the socket's set (read-only sockets too). An invalid name or more than
	 * SIM_MAX_SUBSCRIPTIONS distinct names is rejected and the previous set kept. Persisted in the attachment when its
	 * JSON fits SIM_SUBSCRIPTION_ATTACHMENT_BYTES, else not (empty after a restart).
	 */
	private subscribe(session: SimRelaySession, streams: readonly string[]): void {
		const code = !streams.every(validStreamName) ? "invalid" : new Set(streams).size > SIM_MAX_SUBSCRIPTIONS ? "too_many" : null;
		if (code !== null) {
			this.counters.subscribeRejects++;
			session.send({ k: "subscribeRejected", code });
			return;
		}
		this.counters.subscribes++;
		session.subs = new Set(streams);
		const subs = [...session.subs];
		session.persistedSubs = utf8ByteLength(JSON.stringify(subs)) <= SIM_SUBSCRIPTION_ATTACHMENT_BYTES ? subs : null;
	}

	/**
	 * The socket is pushed `frame`'s payload (else, once appended, it is sent the seq as skipped): vault-global
	 * streams, its own device's rows and the streams of its set (empty until it subscribes).
	 */
	private wants(peer: SimRelaySession, frame: { readonly stream: StreamName; readonly deviceId: DeviceId }): boolean {
		return !isProvisionalStream(frame.stream) || frame.deviceId === peer.deviceId || peer.subs.has(frame.stream);
	}

	private tally(deviceId: DeviceId): SimDeviceFanout {
		let t = this.fanout.get(deviceId);
		if (t === undefined) this.fanout.set(deviceId, (t = { pushedRows: 0, skippedRows: 0 }));
		return t;
	}

	/** Admits one binary APPEND (server append(): decode, then 1008 malformed/invalid, 1009 payload too large). */
	private append(session: SimRelaySession, wire: Uint8Array): void {
		const decoded = decodeAppend(wire);
		const frame = decoded === null ? null : { stream: decoded.stream as StreamName, clientFrameId: decoded.clientFrameId as ClientFrameId, payload: decoded.payload };
		if (frame === null) {
			this.counters.policyCloses++;
			this.serverClose(session, 1008, null, true);
			return;
		}
		if (!validStreamName(frame.stream) || !validClientFrameId(frame.clientFrameId)) {
			this.counters.policyCloses++;
			this.serverClose(session, 1008, null, true);
			return;
		}
		if (frame.payload.byteLength > this.config.limits.maxFrameBytes) {
			this.counters.oversizeCloses++;
			this.serverClose(session, 1009, null, true);
			return;
		}
		this.counters.appendFrames++;
		if (!session.canWrite) {
			this.counters.writeForbidden++;
			session.send({ k: "rejected", stream: frame.stream, clientFrameId: frame.clientFrameId, code: "write_forbidden", seq: null });
			return;
		}
		const key = frameKey(session.deviceId, frame.clientFrameId);
		const pending = this.pendingByKey.get(key);
		if (pending !== undefined) {
			if (pending.stream === frame.stream && bytesEqual(pending.payload, frame.payload)) {
				this.counters.pendingDedupes++;
				pending.duplicates.push(session);
			} else {
				this.counters.conflicts++;
				session.send({ k: "rejected", stream: frame.stream, clientFrameId: frame.clientFrameId, code: "client_frame_id_conflict", seq: null });
			}
			return;
		}
		if (this.dailyActive()) {
			this.counters.dailyLimitRejects++;
			session.send({ k: "vaultError", code: "cf_daily_limit", stream: frame.stream, clientFrameIds: [frame.clientFrameId], resetAt: this.latchUntil });
			return;
		}
		const provisional = isProvisionalStream(frame.stream);
		const entry: PendingFrame = {
			key, stream: frame.stream, deviceId: session.deviceId, clientFrameId: frame.clientFrameId, payload: frame.payload,
			origin: session, duplicates: [], provisional, provisionalTo: new Set(),
		};
		if (provisional) {
			for (const peer of this.streamSockets()) {
				if (peer === session || this.hiddenFor(peer.deviceId, entry.stream) || !this.wants(peer, entry)) continue;
				entry.provisionalTo.add(peer);
				peer.send({ k: "provisional", stream: entry.stream, deviceId: entry.deviceId, clientFrameId: entry.clientFrameId, payload: entry.payload });
				this.counters.provisionalBroadcasts++;
			}
		}
		this.pending.push(entry);
		this.pendingByKey.set(key, entry);
		this.pendingBytes += frame.payload.byteLength;
		this.schedule();
	}

	/** Arms the group-commit timers (or commits now on the bytes threshold). */
	schedule(): void {
		if (!this.config.autoCommit || this.paused || this.pending.length === 0) return;
		const gc = this.config.groupCommit;
		if (this.pendingBytes >= gc.maxBytes) {
			this.flush("bytes");
			return;
		}
		if (this.maxTimer === null) {
			this.maxTimer = this.clock.setTimer(gc.maxMs, () => {
				this.maxTimer = null;
				this.flush("max");
			});
		}
		// Server schedule(): leading edge (leadMs after an append into an empty buffer with no commit for quietMs),
		// else the idle window; minIntervalMs holds both.
		const now = this.clock.monotonic();
		const quiet = gc.quietMs > 0 && now - this.lastCommitAt >= gc.quietMs;
		if (this.pending.length === 1 && quiet) this.leadAt = now + gc.leadMs;
		if (this.idleTimer !== null) this.clock.clearTimer(this.idleTimer);
		const floor = this.lastCommitAt + gc.minIntervalMs - now;
		const lead = this.leadAt !== null;
		const wait = lead ? Math.max(0, this.leadAt! - now, floor) : Math.max(gc.idleMs, floor);
		this.idleTimer = this.clock.setTimer(wait, () => {
			this.idleTimer = null;
			this.flush(lead ? "lead" : "idle");
		});
	}

	clearTimers(): void {
		if (this.idleTimer !== null) this.clock.clearTimer(this.idleTimer);
		if (this.maxTimer !== null) this.clock.clearTimer(this.maxTimer);
		this.idleTimer = null;
		this.maxTimer = null;
		this.leadAt = null;
	}

	/** Commits every buffered frame in one transaction, then broadcasts (frame order) and receipts per origin socket. */
	flush(reason: FlushReason): void {
		this.clearTimers();
		if (this.pending.length === 0) return;
		if (this.paused && reason !== "forced") return;
		const frames = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		this.pendingByKey.clear();
		const key = reason === "lead" ? "flushLead" : reason === "idle" ? "flushIdle" : reason === "max" ? "flushMax" : reason === "bytes" ? "flushBytes" : "flushForced";
		this.counters[key]++;
		const index = this.commitIndex++;
		const queued = this.faults.shift();
		let fault: CommitFault = queued?.fault ?? this.commitHook?.({ index, reason, frames: frames.length }) ?? "commit";
		if (fault === "commit" && this.envDailyActive()) fault = "daily-limit";
		const ids = frames.map((f) => ({ stream: f.stream, deviceId: f.deviceId, clientFrameId: f.clientFrameId }));
		const report = (outcomes: readonly StoreOutcome[], rows: readonly SimRow[]): void => {
			const info: SimCommitInfo = { index, reason, fault, frames: ids, outcomes, rows, head: this.store.head() };
			for (const listener of Array.from(this.commitListeners)) listener(info);
		};
		if (fault === "durability" || fault === "daily-limit") {
			this.counters.commitFailures++;
			if (fault === "daily-limit") this.latchDaily(queued?.retryAfterMs ?? null);
			this.failed(frames, fault === "daily-limit" ? "cf_daily_limit" : "durability_failed");
			report([], []);
			return;
		}
		if (fault === "restart-before") {
			this.counters.droppedPending += frames.length;
			report([], []);
			this.restart();
			return;
		}
		const { outcomes, rows } = this.store.commit(frames);
		this.lastCommitAt = this.clock.monotonic();
		this.counters.commits++;
		if (rows.length > 0) this.latchUntil = 0; // noteWriteSucceeded
		report(outcomes, rows);
		if (fault === "restart-after") {
			this.restart();
			return;
		}
		this.fanOut(frames, outcomes);
	}

	/** Raw admission on the received size; oversize closes 1009, overdraft VAULT_BACKPRESSURE + 1013. */
	private charge(session: SimRelaySession, size: number, text: boolean): boolean {
		const { burstBytes, appendBytesPerSec, maxFrameBytes } = this.config.limits;
		const now = this.clock.monotonic();
		let gate = session.gate;
		if (gate === null) {
			gate = { refused: false };
			session.gate = gate;
		}
		if (gate.refused) {
			this.counters.rawDrops++;
			return false;
		}
		const max = text ? SIM_MAX_TEXT_MESSAGE_BYTES : maxFrameBytes + SIM_MESSAGE_SLACK_BYTES;
		if (size > max) {
			// Oversize: closed uncharged (server charge()).
			gate.refused = true;
			this.counters.oversizeCloses++;
			this.serverClose(session, 1009, null, true);
			session.gate = gate;
			return false;
		}
		// The bucket is the device's, shared by every socket of it (server H6 buckets by deviceId).
		let bucket = this.buckets.get(session.deviceId);
		if (bucket === undefined) this.buckets.set(session.deviceId, (bucket = { tokens: burstBytes, at: now }));
		bucket.tokens = Math.min(burstBytes, bucket.tokens + (Math.max(0, now - bucket.at) * appendBytesPerSec) / 1000);
		bucket.at = now;
		if (bucket.tokens >= size) {
			bucket.tokens -= size;
			return true;
		}
		gate.refused = true;
		this.counters.rateCloses++;
		session.send({ k: "backpressure" });
		this.serverClose(session, 1013, null, true);
		session.gate = gate; // keep refusing until the socket record is gone
		return false;
	}

	/**
	 * Per frame and peer socket, in frame order (relay-wire §5.6): the origin and duplicate waiters get receipts only;
	 * a PROVISIONAL recipient gets the COMMIT_NOTICE; an appended row the socket wants goes as COMMITTED, one it does
	 * not want joins the socket's pending skip run; a store-deduped row is neither (R7). A socket's run is flushed as
	 * one STREAM_SKIPPED before its next live frame and after the loop, before the receipts.
	 */
	private fanOut(frames: readonly PendingFrame[], outcomes: readonly StoreOutcome[]): void {
		const sockets = this.streamSockets().slice();
		const receipts = new Map<SimRelaySession, { stream: StreamName; clientFrameId: ClientFrameId; seq: Seq; deduped: boolean }[]>();
		const skips = new Map<SimRelaySession, { stream: StreamName; seq: Seq }[]>();
		const addReceipt = (session: SimRelaySession, receipt: { stream: StreamName; clientFrameId: ClientFrameId; seq: Seq; deduped: boolean }): void => {
			const list = receipts.get(session);
			if (list === undefined) receipts.set(session, [receipt]);
			else list.push(receipt);
		};
		const flushSkips = (peer: SimRelaySession): void => {
			const run = skips.get(peer);
			if (run === undefined || run.length === 0) return;
			skips.delete(peer);
			peer.send({ k: "skipped", rows: run });
			this.counters.skipFrames++;
		};
		for (let i = 0; i < frames.length; i++) {
			const frame = frames[i]!;
			const outcome = outcomes[i]!;
			if (outcome.kind === "conflict") {
				this.counters.conflicts++;
				for (const waiter of [frame.origin, ...frame.duplicates]) {
					waiter.send({ k: "rejected", stream: frame.stream, clientFrameId: frame.clientFrameId, code: "client_frame_id_conflict", seq: outcome.seq });
				}
				if (frame.provisional) this.dropProvisional(frame, "client_frame_id_conflict");
				continue;
			}
			if (outcome.kind === "appended") this.counters.committedRows++;
			else this.counters.storeDedupes++;
			for (const peer of sockets) {
				if (peer === frame.origin || frame.duplicates.includes(peer) || this.hiddenFor(peer.deviceId, frame.stream)) continue;
				const doc = isProvisionalStream(frame.stream);
				if (frame.provisionalTo.has(peer)) {
					flushSkips(peer);
					peer.send({ k: "notice", stream: frame.stream, seq: outcome.seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId });
					this.counters.notices++;
					if (doc) this.tally(peer.deviceId).pushedRows++;
				} else if (outcome.kind === "appended" && this.wants(peer, frame)) {
					flushSkips(peer);
					peer.send({ k: "committed", stream: frame.stream, seq: outcome.seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, payload: frame.payload });
					this.counters.committedBroadcasts++;
					if (doc) this.tally(peer.deviceId).pushedRows++;
				} else if (outcome.kind === "appended") {
					const run = skips.get(peer);
					if (run === undefined) skips.set(peer, [{ stream: frame.stream, seq: outcome.seq }]);
					else run.push({ stream: frame.stream, seq: outcome.seq });
					this.counters.skippedRows++;
					this.tally(peer.deviceId).skippedRows++;
				}
			}
			const receipt = { stream: frame.stream, clientFrameId: frame.clientFrameId, seq: outcome.seq, deduped: outcome.kind === "deduped" };
			addReceipt(frame.origin, receipt);
			for (const duplicate of frame.duplicates) addReceipt(duplicate, { ...receipt, deduped: true });
		}
		for (const peer of [...skips.keys()]) flushSkips(peer);
		const head = this.store.head();
		for (const [session, list] of receipts) session.send({ k: "receipts", head, receipts: list });
	}

	private dropProvisional(frame: PendingFrame, reason: string): void {
		for (const peer of frame.provisionalTo) {
			peer.send({ k: "dropped", stream: frame.stream, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, reason });
			this.counters.provisionalDrops++;
		}
	}

	/** A failed commit: nothing written. One VAULT_ERROR per (socket, stream); PROVISIONAL holders drop. */
	private failed(frames: readonly PendingFrame[], code: "durability_failed" | "cf_daily_limit"): void {
		const byOrigin = new Map<SimRelaySession, Map<StreamName, ClientFrameId[]>>();
		for (const frame of frames) {
			for (const waiter of [frame.origin, ...frame.duplicates]) {
				let streams = byOrigin.get(waiter);
				if (streams === undefined) byOrigin.set(waiter, (streams = new Map()));
				const ids = streams.get(frame.stream);
				if (ids === undefined) streams.set(frame.stream, [frame.clientFrameId]);
				else ids.push(frame.clientFrameId);
			}
			if (frame.provisional) this.dropProvisional(frame, "commit_failed");
		}
		const resetAt = code === "cf_daily_limit" ? this.latchUntil : null;
		for (const [session, streams] of byOrigin) {
			for (const [stream, clientFrameIds] of streams) session.send({ k: "vaultError", code, stream, clientFrameIds, resetAt });
		}
	}

	/**
	 * D7 revoke (server relay.ts revokeDevice): the device's buffered frames are dropped (no commit, no receipt) and
	 * peers that got their PROVISIONAL get STREAM_PROVISIONAL_DROPPED; other devices' frames stay buffered.
	 */
	dropDevice(deviceId: DeviceId): number {
		const dropped = this.pending.filter((f) => f.deviceId === deviceId);
		if (dropped.length === 0) return 0;
		this.pending = this.pending.filter((f) => f.deviceId !== deviceId);
		this.pendingBytes = this.pending.reduce((n, f) => n + f.payload.byteLength, 0);
		for (const f of dropped) this.pendingByKey.delete(f.key);
		if (this.pending.length === 0) this.clearTimers();
		for (const f of dropped) if (f.provisional) this.dropProvisional(f, "commit_failed");
		return dropped.length;
	}

	/** Drops the buffer unacked. Returns the dropped frame count. */
	dropPending(): number {
		const dropped = this.pending.length;
		this.clearTimers();
		this.pending = [];
		this.pendingBytes = 0;
		this.pendingByKey.clear();
		this.counters.droppedPending += dropped;
		return dropped;
	}

	/**
	 * Runtime restart (eviction / hibernation wake): the buffer is gone unacked,
	 * rate gates and the latch are in-memory and reset, and every open socket
	 * gets STREAM_RESEND with the head. Sockets themselves survive (hibernation),
	 * their subscription restored from the attachment (empty when it overflowed,
	 * or with `loseSubscriptions`: every set as if it had).
	 */
	restart(loseSubscriptions = false): void {
		this.dropPending();
		this.latchUntil = 0;
		this.buckets.clear();
		const head = this.store.head();
		for (const session of this.streamSockets()) {
			session.gate = null;
			if (loseSubscriptions) session.persistedSubs = null;
			session.subs = new Set(session.persistedSubs ?? []);
			session.send({ k: "resend", head });
			this.counters.wakeNotices++;
		}
	}
}
