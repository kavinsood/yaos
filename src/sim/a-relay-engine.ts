/**
 * SimRelay engine: per-socket raw admission (token bucket), APPEND parsing
 * and admission, the vault-wide pending buffer, group commit (idle / max /
 * bytes timers on the ClockPort), fan-out and failures. Mirrors
 * server/src/streams/relay.ts (StreamRelayService) message for message.
 */

import type { ClientFrameId, DeviceId, Seq, StreamName } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { AppendFrame, RelayLimits } from "../ports/relay";
import type { SimRelaySession } from "./a-relay-session";
import type { RelayStore, StoreOutcome } from "./a-relay-store";
import {
	SIM_MESSAGE_SLACK_BYTES,
	bytesEqual,
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
	/** Highest socket ordinal at admission: sockets with ordinal <= this got the PROVISIONAL. */
	readonly ordinal: number;
}

export type FlushReason = "idle" | "max" | "bytes" | "forced";

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
}

export function newCounters(): SimRelayCounters {
	return {
		appendFrames: 0, pendingDedupes: 0, storeDedupes: 0, conflicts: 0, commits: 0, committedRows: 0, commitFailures: 0,
		flushIdle: 0, flushMax: 0, flushBytes: 0, flushForced: 0, provisionalBroadcasts: 0, notices: 0, committedBroadcasts: 0,
		provisionalDrops: 0, rateCloses: 0, oversizeCloses: 0, policyCloses: 0, rawDrops: 0, writeForbidden: 0,
		dailyLimitRejects: 0, wakeNotices: 0, authorityCloses: 0, droppedPending: 0,
	};
}

export interface EngineConfig {
	readonly limits: RelayLimits;
	readonly groupCommit: GroupCommitSpec;
	readonly autoCommit: boolean;
}

export class RelayEngine {
	readonly counters = newCounters();
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
	/** Cloudflare-side daily row limit exhausted until this wall time (0 = not). */
	envDailyUntil = 0;
	/** Server latch (DailyLimitLatch.until). */
	latchUntil = 0;
	private commitIndex = 0;
	private idleTimer: TimerHandle | null = null;
	private maxTimer: TimerHandle | null = null;
	private lastCommitAt = Number.NEGATIVE_INFINITY;

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
		if (!this.charge(session, msg.bytes)) return;
		this.append(session, msg.frame);
	}

	private append(session: SimRelaySession, frame: AppendFrame): void {
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
			origin: session, duplicates: [], provisional, ordinal: this.socketOrdinal,
		};
		if (provisional) {
			for (const peer of this.streamSockets()) {
				if (peer === session) continue;
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
		if (this.idleTimer !== null) this.clock.clearTimer(this.idleTimer);
		const wait = Math.max(gc.idleMs, this.lastCommitAt + gc.minIntervalMs - this.clock.monotonic());
		this.idleTimer = this.clock.setTimer(wait, () => {
			this.idleTimer = null;
			this.flush("idle");
		});
	}

	clearTimers(): void {
		if (this.idleTimer !== null) this.clock.clearTimer(this.idleTimer);
		if (this.maxTimer !== null) this.clock.clearTimer(this.maxTimer);
		this.idleTimer = null;
		this.maxTimer = null;
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
		const key = reason === "idle" ? "flushIdle" : reason === "max" ? "flushMax" : reason === "bytes" ? "flushBytes" : "flushForced";
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
	private charge(session: SimRelaySession, size: number): boolean {
		const { burstBytes, appendBytesPerSec, maxFrameBytes } = this.config.limits;
		const now = this.clock.monotonic();
		let gate = session.gate;
		if (gate === null) {
			gate = { tokens: burstBytes, at: now, refused: false };
			session.gate = gate;
		}
		if (gate.refused) {
			this.counters.rawDrops++;
			return false;
		}
		const max = maxFrameBytes + SIM_MESSAGE_SLACK_BYTES;
		gate.tokens = Math.min(burstBytes, gate.tokens + (Math.max(0, now - gate.at) * appendBytesPerSec) / 1000);
		gate.at = now;
		if (size <= max && gate.tokens >= size) {
			gate.tokens -= size;
			return true;
		}
		gate.refused = true;
		if (size > max) {
			this.counters.oversizeCloses++;
			this.serverClose(session, 1009, null, true);
		} else {
			this.counters.rateCloses++;
			session.send({ k: "backpressure" });
			this.serverClose(session, 1013, null, true);
		}
		session.gate = gate; // keep refusing until the socket record is gone
		return false;
	}

	private fanOut(frames: readonly PendingFrame[], outcomes: readonly StoreOutcome[]): void {
		const sockets = this.streamSockets().slice();
		const receipts = new Map<SimRelaySession, { stream: StreamName; clientFrameId: ClientFrameId; seq: Seq; deduped: boolean }[]>();
		const addReceipt = (session: SimRelaySession, receipt: { stream: StreamName; clientFrameId: ClientFrameId; seq: Seq; deduped: boolean }): void => {
			const list = receipts.get(session);
			if (list === undefined) receipts.set(session, [receipt]);
			else list.push(receipt);
		};
		for (let i = 0; i < frames.length; i++) {
			const frame = frames[i]!;
			const outcome = outcomes[i]!;
			if (outcome.kind === "conflict") {
				this.counters.conflicts++;
				for (const waiter of [frame.origin, ...frame.duplicates]) {
					waiter.send({ k: "rejected", stream: frame.stream, clientFrameId: frame.clientFrameId, code: "client_frame_id_conflict", seq: outcome.seq });
				}
				if (frame.provisional) this.dropProvisional(sockets, frame, "client_frame_id_conflict");
				continue;
			}
			if (outcome.kind === "appended") this.counters.committedRows++;
			else this.counters.storeDedupes++;
			// Rows appended now go to every other socket (a notice for PROVISIONAL holders); a row
			// deduped against an earlier commit was delivered then: only holders get a notice (R7).
			for (const peer of sockets) {
				if (peer === frame.origin) continue;
				if (frame.provisional && peer.ordinal <= frame.ordinal) {
					peer.send({ k: "notice", stream: frame.stream, seq: outcome.seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId });
					this.counters.notices++;
				} else if (outcome.kind === "appended") {
					peer.send({ k: "committed", stream: frame.stream, seq: outcome.seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, payload: frame.payload });
					this.counters.committedBroadcasts++;
				}
			}
			const receipt = { stream: frame.stream, clientFrameId: frame.clientFrameId, seq: outcome.seq, deduped: outcome.kind === "deduped" };
			addReceipt(frame.origin, receipt);
			for (const duplicate of frame.duplicates) addReceipt(duplicate, { ...receipt, deduped: true });
		}
		const head = this.store.head();
		for (const [session, list] of receipts) session.send({ k: "receipts", head, receipts: list });
	}

	private dropProvisional(sockets: readonly SimRelaySession[], frame: PendingFrame, reason: string): void {
		for (const peer of sockets) {
			if (peer === frame.origin || peer.ordinal > frame.ordinal) continue;
			peer.send({ k: "dropped", stream: frame.stream, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, reason });
			this.counters.provisionalDrops++;
		}
	}

	/** A failed commit: nothing written. One VAULT_ERROR per (socket, stream); PROVISIONAL holders drop. */
	private failed(frames: readonly PendingFrame[], code: "durability_failed" | "cf_daily_limit"): void {
		const sockets = this.streamSockets().slice();
		const byOrigin = new Map<SimRelaySession, Map<StreamName, ClientFrameId[]>>();
		for (const frame of frames) {
			for (const waiter of [frame.origin, ...frame.duplicates]) {
				let streams = byOrigin.get(waiter);
				if (streams === undefined) byOrigin.set(waiter, (streams = new Map()));
				const ids = streams.get(frame.stream);
				if (ids === undefined) streams.set(frame.stream, [frame.clientFrameId]);
				else ids.push(frame.clientFrameId);
			}
			if (frame.provisional) this.dropProvisional(sockets, frame, "commit_failed");
		}
		const resetAt = code === "cf_daily_limit" ? this.latchUntil : null;
		for (const [session, streams] of byOrigin) {
			for (const [stream, clientFrameIds] of streams) session.send({ k: "vaultError", code, stream, clientFrameIds, resetAt });
		}
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
	 * gets STREAM_RESEND with the head. Sockets themselves survive (hibernation).
	 */
	restart(): void {
		this.dropPending();
		this.latchUntil = 0;
		const head = this.store.head();
		for (const session of this.streamSockets()) {
			session.gate = null;
			session.send({ k: "resend", head });
			this.counters.wakeNotices++;
		}
	}
}
