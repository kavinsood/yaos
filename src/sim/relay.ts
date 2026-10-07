/**
 * SimRelay: in-memory RelayPort (src/ports/relay.ts R1-R7) conforming to
 * docs/client-remake/relay-wire.md and server/src/streams/{relay,store}.ts,
 * driven by a ClockPort (VirtualClock in simulation) and a seeded RandomPort.
 *
 * The session also plays the wsRelay adapter (wire -> RelayEvent). Real
 * group commit (300 ms idle / 1500 ms max / 64 KiB), contiguous vault seqs,
 * vault-wide pending dedupe, segment dedupe window (open + newest sealed
 * while open < 64 rows), provisional / notice / dropped, per-socket token
 * bucket (1009 / 1013), daily-limit latch, STREAM_RESEND on restart, feed and
 * read paging, checkpoint CAS + segment GC, per-socket link delays and fault
 * hooks. See docs/client-remake/wp-a-notes.md for the decisions.
 */

import type { DeviceId, Seq, StreamName, VaultEpoch } from "../core/types";
import type { ClockPort } from "../ports/clock";
import type { Unsubscribe } from "../ports/common";
import type { RandomPort } from "../ports/random";
import type { FeedPage, PutCheckpointResult, ReadPage, ReadRequest, RelayConnectParams, RelayConnectResult, RelayEvent, RelayLimits, RelayPort } from "../ports/relay";
import { RelayEngine, type CommitFault, type CommitHook, type SimCommitInfo, type SimRelayCounters } from "./a-relay-engine";
import { SimRelaySession, type SessionHost } from "./a-relay-session";
import { RelayStore, type SegmentInfo, type StoreFrame, type StoreSnapshot } from "./a-relay-store";
import {
	DEFAULT_SIM_DEDUPE_WINDOW,
	DEFAULT_SIM_GROUP_COMMIT,
	DEFAULT_SIM_RELAY_LIMITS,
	SIM_FEED_MAX_LIMIT,
	SIM_MAX_SOCKETS,
	SIM_READ_BATCH_MAX_STREAMS,
	SIM_READ_MAX_BYTES,
	SIM_SEGMENT_MAX_BYTES,
	SIM_SEGMENT_SEAL_BYTES,
	SimRelayError,
	realClock,
	validSeq,
	validStreamName,
	type LinkSpec,
	type SimConnectFailureReason,
	type SimRelayOptions,
	type SimRow,
	type SimSessionInfo,
} from "./a-relay-util";
import { SeededRandom } from "./random";

export {
	DEFAULT_SIM_DEDUPE_WINDOW,
	DEFAULT_SIM_GROUP_COMMIT,
	DEFAULT_SIM_RELAY_LIMITS,
	SIM_SEGMENT_MAX_BYTES,
	SIM_SEGMENT_SEAL_BYTES,
	SimRelayError,
	SimRelaySession,
};
export type { CommitFault, CommitHook, LinkSpec, SegmentInfo, SimCommitInfo, SimConnectFailureReason, SimRelayCounters, SimRelayOptions, SimRow, SimSessionInfo, StoreFrame, StoreSnapshot };

/** A device's sessions, or one session by id. */
export type SimTarget = DeviceId | number;

type Failure = { readonly reason: SimConnectFailureReason; readonly retryAfterMs: number | null };

export class SimRelay implements RelayPort {
	readonly limits: RelayLimits;
	readonly clock: ClockPort;
	readonly store: RelayStore;
	readonly engine: RelayEngine;
	private readonly random: RandomPort;
	private epoch: VaultEpoch;
	private readonly host: SessionHost;
	private readonly readOnly: Set<DeviceId>;
	private readonly revoked = new Set<DeviceId>();
	/** Hostile relay: streams hidden from a device (hideFrom). */
	private readonly hidden = new Map<DeviceId, Set<StreamName>>();
	/** Rows forge() appended so far (hostile relay). */
	forgedRows = 0;
	private defaultLink: LinkSpec;
	private readonly links = new Map<DeviceId, LinkSpec>();
	private connectFailure: Failure | null = null;
	private readonly connectFailures: Failure[] = [];
	private httpFailure = false;
	private httpInFlight = 0;
	private connectsInFlight = 0;
	private tracked: SimRelaySession[] = [];
	private readonly all = new Map<number, SimRelaySession>();
	private nextSessionId = 1;
	private readonly readPageRows: number;
	private readonly maxSockets: number;
	/** Catch-up read requests (single and batched): total, on the wire now, most on the wire at once. */
	readRequests = 0;
	readsOnWire = 0;
	maxReadsOnWire = 0;
	/** Listener exceptions: rethrown asynchronously by default (like wsRelay). */
	onListenerError: (error: unknown) => void = (error) => queueMicrotask(() => {
		throw error;
	});

	constructor(options: SimRelayOptions = {}) {
		this.clock = options.clock ?? realClock();
		this.random = options.random ?? new SeededRandom(options.seed ?? 1);
		this.epoch = options.vaultEpoch ?? "sim-epoch-1";
		this.limits = Object.freeze({ ...DEFAULT_SIM_RELAY_LIMITS, ...options.limits });
		this.readPageRows = options.readPageRows ?? Number.POSITIVE_INFINITY;
		this.maxSockets = options.maxSockets ?? SIM_MAX_SOCKETS;
		this.readOnly = new Set(options.readOnlyDevices ?? []);
		this.defaultLink = { ...options.link };
		this.store = new RelayStore({
			sealBytes: options.sealBytes ?? SIM_SEGMENT_SEAL_BYTES,
			maxSegmentBytes: options.maxSegmentBytes ?? SIM_SEGMENT_MAX_BYTES,
			tailRows: options.dedupeWindow ?? DEFAULT_SIM_DEDUPE_WINDOW,
			gcOnCheckpoint: options.gcOnCheckpoint ?? true,
		});
		this.engine = new RelayEngine(this.clock, this.store, {
			limits: this.limits,
			groupCommit: { ...DEFAULT_SIM_GROUP_COMMIT, ...options.groupCommit },
			autoCommit: options.autoCommit ?? true,
		});
		this.engine.hiddenFor = (deviceId, stream) => this.isHidden(deviceId, stream);
		this.host = {
			clock: this.clock,
			arrive: (session, msg) => this.engine.arrive(session, msg),
			feed: (session, afterSeq) => this.http(session, () => this.feedPage(afterSeq, session.deviceId)),
			read: (session, stream, afterSeq, prefer) => this.readRequest(session, () => this.readPage(stream, afterSeq, prefer, undefined, session.deviceId)),
			readBatch: (session, reqs) => this.readRequest(session, () => this.readBatchPages(reqs, session.deviceId)),
			putCheckpoint: (session, stream, coversSeq, expected, bytes) => this.http(session, () => this.checkpointPut(session, stream, coversSeq, expected, bytes)),
			jitter: (session) => this.jitter(session.link),
			listenerError: (error) => this.onListenerError(error),
		};
	}

	// ---- RelayPort ----------------------------------------------------------------

	connect(params: RelayConnectParams): Promise<RelayConnectResult> {
		const link = this.linkFor(params.deviceId);
		this.connectsInFlight++;
		return new Promise((resolve) => {
			this.clock.setTimer(Math.max(0, link.connectMs ?? 0) + this.jitter(link), () => {
				this.connectsInFlight--;
				const failure = this.connectFailures.shift() ?? this.connectFailure;
				if (failure !== null) return resolve({ ok: false, reason: failure.reason, retryAfterMs: failure.retryAfterMs });
				if (this.revoked.has(params.deviceId)) return resolve({ ok: false, reason: "unauthorized", retryAfterMs: null });
				if (this.engine.streamSockets().length >= this.maxSockets) return resolve({ ok: false, reason: "unavailable", retryAfterMs: 1000 });
				const session = new SimRelaySession(
					this.host, this.nextSessionId++, this.engine.nextOrdinal(), params.deviceId, this.epoch,
					this.store.head(), !this.readOnly.has(params.deviceId), this.limits, link,
				);
				this.engine.accept(session);
				this.tracked.push(session);
				this.all.set(session.id, session);
				resolve({ ok: true, session });
			});
		});
	}

	// ---- HTTP ---------------------------------------------------------------------

	/** Request travels httpMs (+jitter), is answered from the state at arrival, the response travels back. */
	private readRequest<T>(session: SimRelaySession, compute: () => T): Promise<T> {
		this.readRequests++;
		this.maxReadsOnWire = Math.max(this.maxReadsOnWire, ++this.readsOnWire);
		return this.http(session, compute).finally(() => this.readsOnWire--);
	}

	private http<T>(session: SimRelaySession, compute: () => T): Promise<T> {
		this.httpInFlight++;
		return new Promise<T>((resolve, reject) => {
			this.clock.setTimer(session.delay(session.link.httpMs), () => {
				let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
				try {
					if (this.httpFailure) throw new SimRelayError("network_error");
					outcome = { ok: true, value: compute() };
				} catch (error) {
					outcome = { ok: false, error };
				}
				this.clock.setTimer(session.delay(session.link.httpMs), () => {
					this.httpInFlight--;
					if (outcome.ok) resolve(outcome.value);
					else reject(outcome.error);
				});
			});
		});
	}

	private feedPage(afterSeq: Seq, deviceId: DeviceId | null = null): FeedPage {
		if (!validSeq(afterSeq)) throw new SimRelayError("invalid_cursor");
		const limit = Math.max(1, Math.min(SIM_FEED_MAX_LIMIT, Math.floor(this.limits.feedPageRows)));
		const page = this.store.feed(afterSeq, limit);
		const entries = deviceId === null ? page.changes : page.changes.filter((c) => !this.isHidden(deviceId, c.stream));
		return { entries, throughSeq: page.nextAfter ?? page.head, headSeq: page.head, more: page.nextAfter !== null };
	}

	private readPage(stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean, budget?: number, deviceId: DeviceId | null = null): ReadPage {
		if (!validStreamName(stream)) throw new SimRelayError("invalid_stream");
		if (!validSeq(afterSeq)) throw new SimRelayError("invalid_cursor");
		const maxBytes = budget ?? Math.max(1, Math.min(SIM_READ_MAX_BYTES, this.limits.readPageBytes));
		// A hidden stream reads as one the relay never had (hostile relay, hideFrom).
		if (deviceId !== null && this.isHidden(deviceId, stream)) return { checkpoint: null, rows: [], lastSeq: 0, checkpointSeq: 0, gcSeq: 0, nextAfterSeq: afterSeq, more: false };
		const page = this.store.read(stream, afterSeq, maxBytes, preferCheckpoint, this.readPageRows);
		const last = page.rows.length > 0 ? page.rows[page.rows.length - 1]!.seq : page.checkpoint?.coversSeq ?? afterSeq;
		return {
			checkpoint: page.checkpoint, rows: page.rows, lastSeq: page.lastSeq, checkpointSeq: page.checkpointSeq, gcSeq: page.gcSeq,
			nextAfterSeq: page.nextAfter ?? last, more: page.nextAfter !== null,
		};
	}

	/** Server readBatch: request order, one budget; the first entry always served, a later overrun ends the batch. */
	private readBatchPages(reqs: readonly ReadRequest[], deviceId: DeviceId | null = null): ReadPage[] {
		if (reqs.length === 0 || reqs.length > SIM_READ_BATCH_MAX_STREAMS) throw new SimRelayError("batch_too_large");
		const maxBytes = Math.max(1, Math.min(SIM_READ_MAX_BYTES, this.limits.readPageBytes));
		const pages: ReadPage[] = [];
		let left = maxBytes;
		for (const r of reqs) {
			if (pages.length > 0 && left <= 0) break;
			const page = this.readPage(r.stream, r.afterSeq, r.preferCheckpoint, pages.length > 0 ? left : maxBytes, deviceId);
			const size = (page.checkpoint?.bytes.byteLength ?? 0) + page.rows.reduce((n, row) => n + row.payload.byteLength, 0);
			if (pages.length > 0 && size > left) break;
			pages.push(page);
			left -= size;
		}
		return pages;
	}

	/** Route permission, argument validation, body size, daily limit, then the store CAS (server order). */
	private checkpointPut(session: SimRelaySession, stream: StreamName, coversSeq: Seq, expected: Seq, bytes: Uint8Array): PutCheckpointResult {
		if (!session.canWrite) return { t: "refused", reason: "forbidden", retryAfterMs: null };
		if (!validStreamName(stream)) throw new SimRelayError("invalid_stream");
		if (!Number.isSafeInteger(coversSeq) || coversSeq < 1) throw new SimRelayError("invalid_covers_seq");
		if (!validSeq(expected)) throw new SimRelayError("invalid_expected_covers_seq");
		if (bytes.byteLength > this.limits.maxCheckpointBytes) return { t: "refused", reason: "too-large", retryAfterMs: null };
		if (!this.engine.dailyActive() && this.engine.envDailyActive()) this.engine.latchDaily(null);
		if (this.engine.dailyActive()) return { t: "refused", reason: "daily-limit", retryAfterMs: Math.max(0, this.engine.latchUntil - this.clock.now()) };
		const result = this.store.putCheckpoint(stream, coversSeq, expected, bytes);
		if (result.ok) return { t: "ok" };
		switch (result.error) {
			case "stream_not_found": return { t: "refused", reason: "stream-not-found", retryAfterMs: null };
			case "checkpoint_conflict": return { t: "conflict", currentCoversSeq: result.current };
			case "checkpoint_not_advancing": return { t: "refused", reason: "not-advancing", retryAfterMs: null };
			case "checkpoint_ahead_of_stream": return { t: "refused", reason: "ahead-of-stream", retryAfterMs: null };
		}
	}

	// ---- fault / test controls ------------------------------------------------------

	/** Every later connect() fails with `reason` until called with null. */
	setConnectFailure(reason: SimConnectFailureReason | null, retryAfterMs: number | null = null): void {
		this.connectFailure = reason === null ? null : { reason, retryAfterMs };
	}

	/** The next connect() fails once (queued; consumed before setConnectFailure applies). */
	failNextConnect(reason: SimConnectFailureReason, retryAfterMs: number | null = null): void {
		this.connectFailures.push({ reason, retryAfterMs });
	}

	/** Group-commit timers do not commit while paused (flush()/commitNow() still do). */
	pauseCommits(): void {
		this.engine.paused = true;
	}

	resumeCommits(): void {
		this.engine.paused = false;
		this.engine.schedule();
	}

	/** Commits the pending buffer now, synchronously (forced flush). */
	commitNow(): void {
		this.engine.flush("forced");
	}

	/** commitNow(), then resolves once delivery settled (pump the clock). */
	flush(): Promise<void> {
		this.commitNow();
		return this.settled();
	}

	/**
	 * Resolves once no commit timer, connect, HTTP exchange or link delivery is
	 * outstanding. Frames held by pauseCommits()/autoCommit:false do not count.
	 * Polls every 1 ms of clock time, so a VirtualClock must be pumped.
	 */
	settled(maxTurns = 1_000_000): Promise<void> {
		return new Promise((resolve, reject) => {
			let turns = 0;
			const check = (): void => {
				if (this.quiescent()) return resolve();
				if (++turns > maxTurns) return reject(new Error(`sim relay: not settled after ${maxTurns} turns`));
				this.clock.setTimer(1, check);
			};
			this.clock.setTimer(0, check);
		});
	}

	quiescent(): boolean {
		if (this.engine.timersArmed || this.httpInFlight > 0 || this.connectsInFlight > 0) return false;
		this.tracked = this.tracked.filter((s) => !(s.closed && !s.srvOpen && s.idle));
		return this.tracked.every((s) => s.idle);
	}

	/** Runtime restart: buffer lost unacked, gates/latch reset, every open socket gets STREAM_RESEND. */
	restart(): void {
		this.engine.restart();
	}

	/** Graceful drain (deploy/eviction): commit the buffer, then every socket closes 1001. */
	drain(): void {
		this.commitNow();
		for (const session of this.engine.streamSockets().slice()) this.engine.serverClose(session, 1001, null, true);
	}

	/** Abrupt network loss: closed{code, wasClean:false}; in-flight messages both ways are lost. Buffered frames still commit. */
	dropSession(target: SimTarget, code = 1006): void {
		for (const session of this.targets(target)) this.engine.serverClose(session, code, null, false);
	}

	/** The next non-empty group commit gets `fault`. daily-limit latches until now + retryAfterMs, else the next 00:00 UTC. */
	failNextCommit(fault: Exclude<CommitFault, "commit">, retryAfterMs: number | null = null): void {
		this.engine.faults.push({ fault, retryAfterMs });
	}

	/** Consulted for every non-empty group commit without a queued failNextCommit. */
	setCommitHook(hook: CommitHook | null): void {
		this.engine.commitHook = hook;
	}

	onCommit(listener: (info: SimCommitInfo) => void): Unsubscribe {
		this.engine.commitListeners.add(listener);
		return () => {
			this.engine.commitListeners.delete(listener);
		};
	}

	/**
	 * Cloudflare free-plan daily row limit. on: commits fail with cf_daily_limit
	 * and latch; appends are refused up front; checkpoints 503. Lifts itself at
	 * now + retryAfterMs (default: the next 00:00 UTC). off: lifted and latch cleared.
	 */
	setDailyLimit(on: boolean, retryAfterMs: number | null = null): void {
		if (!on) {
			this.engine.envDailyUntil = 0;
			this.engine.latchUntil = 0;
			return;
		}
		this.engine.envDailyUntil = 0;
		this.engine.latchDaily(retryAfterMs);
		this.engine.envDailyUntil = this.engine.latchUntil;
	}

	/** VAULT_BACKPRESSURE then 1013 (the gate refuses everything after). Buffered frames still commit. */
	backpressure(target: SimTarget): void {
		for (const session of this.targets(target)) {
			this.engine.counters.rateCloses++;
			session.send({ k: "backpressure" });
			this.engine.serverClose(session, 1013, null, true);
			session.gate = { tokens: 0, at: this.clock.monotonic(), refused: true };
		}
	}

	/** Authority change: commit the buffer (unless paused), then error authority_superseded + 4403. */
	supersede(target: SimTarget): void {
		if (!this.engine.paused) this.commitNow();
		for (const session of this.targets(target)) {
			this.engine.counters.authorityCloses++;
			this.engine.serverClose(session, 4403, "authority_superseded", true);
		}
	}

	/** Device revoked: supersede its sockets; later connects are "unauthorized" until unrevoke. */
	revoke(deviceId: DeviceId): void {
		this.revoked.add(deviceId);
		this.supersede(deviceId);
	}

	unrevoke(deviceId: DeviceId): void {
		this.revoked.delete(deviceId);
	}

	/** New sessions of `deviceId` get canWrite = !readOnly (a real role change also supersedes). */
	setReadOnly(deviceId: DeviceId, readOnly: boolean): void {
		if (readOnly) this.readOnly.add(deviceId);
		else this.readOnly.delete(deviceId);
	}

	/** The adapter forgets held PROVISIONALs: their notices become "committed" with payload null. */
	forgetHeldProvisionals(target: SimTarget): void {
		for (const session of this.targets(target, true)) session.held.clear();
	}

	/** Queues an arbitrary port event on the downlink (a "closed" event ends the session client-side only). */
	inject(target: SimTarget, event: RelayEvent): void {
		for (const session of this.targets(target)) session.send({ k: "event", event });
	}

	/** VAULT_PONG with the head (a "head" event). */
	ping(target: SimTarget): void {
		for (const session of this.targets(target)) session.send({ k: "pong", head: this.store.head() });
	}

	/** While on, feed/read/putCheckpoint reject with SimRelayError("network_error"). */
	setHttpFailure(on: boolean): void {
		this.httpFailure = on;
	}

	/** Link of a device (open sockets and later ones), or the default link with null. */
	setLink(deviceId: DeviceId | null, link: LinkSpec): void {
		if (deviceId === null) {
			this.defaultLink = { ...link };
			return;
		}
		this.links.set(deviceId, { ...link });
		for (const session of this.engine.streamSockets()) if (session.deviceId === deviceId) session.link = { ...link };
	}

	/** Vault destroyed and re-created: buffer and rows wiped, head 0, new epoch; open sockets close 1001. */
	resetEpoch(vaultEpoch: VaultEpoch): void {
		this.engine.dropPending();
		this.store.reset();
		this.engine.latchUntil = 0;
		this.engine.envDailyUntil = 0;
		this.epoch = vaultEpoch;
		for (const session of this.engine.streamSockets().slice()) this.engine.serverClose(session, 1001, null, true);
	}

	/** The store as of now, for restoreEpoch (a point-in-time-restore target). */
	snapshot(): StoreSnapshot {
		return this.store.snapshot();
	}

	/**
	 * Point-in-time restore (server D8b: "content == T", a new epoch): buffer dropped, the store becomes `snap`,
	 * open sockets close 1001. Records committed after T are gone from `k` (e2ee-design §11.5).
	 */
	restoreEpoch(snap: StoreSnapshot, vaultEpoch: VaultEpoch): void {
		this.engine.dropPending();
		this.store.restore(snap);
		this.engine.latchUntil = 0;
		this.engine.envDailyUntil = 0;
		this.epoch = vaultEpoch;
		for (const session of this.engine.streamSockets().slice()) this.engine.serverClose(session, 1001, null, true);
	}

	// ---- hostile relay (e2ee-design §20.2; sim only) ----------------------------------

	/**
	 * Commit `frames` as new rows (no dedupe: a replay lands again at a new seq) and push each to every open socket
	 * as committed. Returns the rows.
	 */
	forge(frames: readonly StoreFrame[]): readonly SimRow[] {
		const rows = this.store.forge(frames);
		this.forgedRows += rows.length;
		for (const session of this.engine.streamSockets().slice()) {
			for (const r of rows) {
				if (this.isHidden(session.deviceId, r.stream)) continue;
				session.send({ k: "committed", stream: r.stream, seq: r.seq, deviceId: r.deviceId, clientFrameId: r.clientFrameId, payload: r.payload });
			}
		}
		return rows;
	}

	/** `stream` reads as absent for `deviceId` (feed, read, readBatch) and its rows are not pushed to it; head still counts them. */
	hideFrom(deviceId: DeviceId, stream: StreamName): void {
		let set = this.hidden.get(deviceId);
		if (!set) this.hidden.set(deviceId, (set = new Set()));
		set.add(stream);
	}

	unhideFrom(deviceId: DeviceId, stream: StreamName): void {
		this.hidden.get(deviceId)?.delete(stream);
	}

	private isHidden(deviceId: DeviceId, stream: StreamName): boolean {
		return this.hidden.get(deviceId)?.has(stream) ?? false;
	}

	// ---- introspection -----------------------------------------------------------

	head(): Seq {
		return this.store.head();
	}

	vaultEpoch(): VaultEpoch {
		return this.epoch;
	}

	rows(stream: StreamName, options: { readonly includeGc?: boolean } = {}): readonly SimRow[] {
		return this.store.rows(stream, options.includeGc === true);
	}

	streams(): readonly StreamName[] {
		return this.store.streams();
	}

	checkpoint(stream: StreamName): { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null {
		return this.store.checkpoint(stream);
	}

	gcSeq(stream: StreamName): Seq {
		return this.store.gcSeq(stream);
	}

	/** Server-open sockets in ordinal order. */
	sessions(): readonly SimSessionInfo[] {
		return this.engine.streamSockets().map((s) => ({ id: s.id, deviceId: s.deviceId, headSeq: s.headSeq, canWrite: s.canWrite, ordinal: s.ordinal }));
	}

	/** Any session ever created (its .log has every event it produced). */
	session(id: number): SimRelaySession | null {
		return this.all.get(id) ?? null;
	}

	pendingCount(): number {
		return this.engine.pending.length;
	}

	pendingBytes(): number {
		return this.engine.pendingBytes;
	}

	counters(): SimRelayCounters {
		return { ...this.engine.counters };
	}

	dailyLimitActive(): boolean {
		return this.engine.dailyActive();
	}

	private targets(target: SimTarget, includeClientClosed = false): SimRelaySession[] {
		if (typeof target === "number") {
			const s = this.all.get(target);
			return s !== undefined && (s.srvOpen || (includeClientClosed && !s.closed)) ? [s] : [];
		}
		return this.engine.streamSockets().filter((s) => s.deviceId === target);
	}

	private jitter(link: LinkSpec): number {
		const j = link.jitterMs ?? 0;
		return j > 0 ? this.random.float() * j : 0;
	}

	private linkFor(deviceId: DeviceId): LinkSpec {
		return this.links.get(deviceId) ?? this.defaultLink;
	}
}
