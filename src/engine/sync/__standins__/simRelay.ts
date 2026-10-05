/**
 * STAND-IN for WP-A src/sim/relay.ts. Replace at integration.
 *
 * In-memory RelayPort (src/ports/relay.ts R1-R7) following
 * docs/client-remake/relay-wire.md at the port level: the session plays the
 * part of the wsRelay adapter too (PROVISIONAL + COMMIT_NOTICE are joined into
 * "committed" with the payload; STREAM_RECEIPTS become "receipt" events then a
 * "head" hint).
 *
 * Followed from the wire:
 * - Seqs vault-wide, contiguous from 1; one group commit assigns consecutive
 *   seqs in arrival order; broadcasts (seq order) then receipts per origin
 *   session, then a "head" event (§5.1).
 * - b:/c: appends are sent as "provisional" at append time to every other open
 *   session; sessions that saw it get "committed" (joined payload) at commit,
 *   later sessions get "committed" from the row. ns/other streams are
 *   commit-only (§5.2). The origin session never gets its own frame back;
 *   other sessions of the same device do (§5.3).
 * - Several sessions per device may be open at once: a new connect does NOT
 *   supersede the old one (§5.3 "other sockets of the same device"). 4403 +
 *   "authority_superseded" comes from supersede() (an authority change), which
 *   commits the buffer first (§5.1 "committed before authority fences").
 * - Dedupe: the pending buffer is vault-wide by (deviceId, clientFrameId):
 *   same stream + bytes -> joins the pending frame (extra deduped:true
 *   receipt), otherwise frame-id-conflict without conflictSeq. At commit the
 *   stream's dedupe window is checked: same bytes -> deduped:true receipt with
 *   the ORIGINAL seq, holders of the new provisional get "committed" with that
 *   older seq (R7), commit-only peers get nothing (no re-delivery); different
 *   bytes -> frame-id-conflict with conflictSeq, holders get
 *   provisionalDropped. Reusing an id on another stream after commit is not
 *   detected (§5.4).
 * - Frames buffered before a close (client close, 1009, 1013, 1006, 4403)
 *   still commit; only their receipts are lost with the session (§5.4, server
 *   charge()). The oversize/malformed frame itself is never buffered.
 * - restart(): the buffer is lost unreceipted; every open session gets
 *   "resendUnreceipted" and drops its held provisionals. No
 *   provisionalDropped is sent (§5.2, §12 "Restarts").
 * - A failed group commit refuses every frame of it (durability / daily-limit)
 *   and sends provisionalDropped to holders; a daily-limit failure latches the
 *   daily limit (§11.4) until setDailyLimit(false). While latched, appends are
 *   refused up front (no provisional) and checkpoints are refused.
 * - Feed (§6): streams with lastSeq > after, ascending by lastSeq, paged by
 *   feedPageRows; throughSeq = nextAfter (last listed lastSeq) or head on the
 *   last page. Like the wire, a stream with an older commit <= throughSeq whose
 *   lastSeq moved past throughSeq is listed on a later page (feed(throughSeq)),
 *   never lost.
 * - Read (§7): checkpoint included when checkpointSeq > 0 and (after < gcSeq,
 *   or preferCheckpoint and after < checkpointSeq); rows then start after its
 *   coversSeq; page budget counts checkpoint bytes; a page always carries at
 *   least one row or the checkpoint. nextAfterSeq = last row seq ?? checkpoint
 *   coversSeq ?? afterSeq (same as relayHttp).
 * - Checkpoint (§8): forbidden, too-large, daily-limit, then the store CAS in
 *   server order: stream-not-found, conflict (current != expected),
 *   not-advancing (N <= current), ahead-of-stream (N > lastSeq). coversSeq need
 *   not be a row seq. Invalid arguments (N < 1, negative expected/after,
 *   invalid stream name) reject the promise with SimRelayError, like the
 *   adapter does for HTTP 400s.
 * - Malformed APPEND (stream 1-256 UTF-8 bytes, clientFrameId 1-128) closes
 *   1008; payload > maxFrameBytes closes 1009 (errorCode null, clean).
 *
 * Simplified:
 * - Group commit runs on the next schedule() turn instead of 300 ms idle /
 *   1500 ms max / 64 KiB; autoCommit:false or pauseCommits() hold frames until
 *   flush()/resumeCommits().
 * - GC collects every row <= coversSeq (no open-segment retain window);
 *   gcSeq = highest collected row seq. The dedupe window is the last
 *   `dedupeWindow` rows of the stream (GC'd or not), not open + sealed segment.
 * - No token bucket: appendBytesPerSec/burstBytes are only advertised; use
 *   backpressure(deviceId) to inject VAULT_BACKPRESSURE + 1013.
 * - No liveness pings; bufferedBytes() is always 0. HTTP calls are answered
 *   from a snapshot taken at call time, resolved on the next schedule() turn,
 *   and keep working after the socket closed.
 * - Like wsRelay: events buffered before the first listener are flushed to it
 *   synchronously inside onEvent(), and close() emits "closed" synchronously
 *   (events still in flight are discarded). Every other event is delivered
 *   asynchronously via schedule(), FIFO per session, never inside append().
 */

import { RELAY_CLOSE } from "../../../core/limits";
import type { ClientFrameId, DeviceId, Seq, StreamName, VaultEpoch } from "../../../core/types";
import type { Unsubscribe } from "../../../ports/common";
import type {
	AppendFrame,
	FeedPage,
	PutCheckpointResult,
	ReadPage,
	RefusalReason,
	RelayConnectParams,
	RelayConnectResult,
	RelayEvent,
	RelayLimits,
	RelayPort,
	RelayRow,
	RelaySession,
} from "../../../ports/relay";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const DEFAULT_SIM_RELAY_LIMITS: RelayLimits = Object.freeze({
	maxFrameBytes: 1024 * 1024,
	maxCheckpointBytes: 4 * 1024 * 1024,
	appendBytesPerSec: 256 * 1024,
	burstBytes: 2 * 1024 * 1024,
	feedPageRows: 1000,
	readPageBytes: 1024 * 1024,
});

/** relay-wire §5.4: the stream's recent rows checked for (deviceId, clientFrameId) duplicates. */
export const DEFAULT_SIM_DEDUPE_WINDOW = 64;

export interface SimRelayOptions {
	readonly vaultEpoch?: VaultEpoch;
	readonly limits?: Partial<RelayLimits>;
	/** Extra cap on rows per read() page (tests: force paging). Default unlimited. */
	readonly readPageRows?: number;
	/** Per-stream recent rows checked for duplicates. Default 64. */
	readonly dedupeWindow?: number;
	/** true (default): pending frames are group-committed on the next schedule() turn. false: only flush() commits. */
	readonly autoCommit?: boolean;
	/** true (default): a successful putCheckpoint collects the stream's rows <= coversSeq. */
	readonly gcOnCheckpoint?: boolean;
	/** Members without vault.content.write: canWrite=false, appends and checkpoints refused "forbidden". */
	readonly readOnlyDevices?: readonly DeviceId[];
	/** Macrotask scheduler for commits, event delivery and HTTP replies. Default setTimeout(fn, 0). */
	readonly schedule?: (fn: () => void) => void;
}

export interface SimRow extends RelayRow {
	readonly stream: StreamName;
}

export interface SimSessionInfo {
	readonly id: number;
	readonly deviceId: DeviceId;
	readonly headSeq: Seq;
	readonly canWrite: boolean;
}

export type SimConnectFailureReason = Extract<RelayConnectResult, { ok: false }>["reason"];

/** Rejection of feed/read/putCheckpoint: the HTTP 400 codes of relay-wire §6-§8, or "network_error" (setHttpFailure). */
export class SimRelayError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`sim relay: ${code}`);
		this.name = "SimRelayError";
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface StreamState {
	readonly name: StreamName;
	/** Every committed row in seq order; rows with seq <= gcSeq are collected (only introspection sees them). */
	readonly rows: SimRow[];
	lastSeq: Seq;
	checkpoint: { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null;
	gcSeq: Seq;
}

interface PendingFrame {
	readonly key: string;
	readonly stream: StreamName;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly payload: Uint8Array;
	readonly origin: SimSession;
	/** Resends of the same frame while pending: each gets a deduped:true receipt. */
	readonly duplicates: SimSession[];
	/** Sessions that got the PROVISIONAL (b:/c: only). */
	readonly provisionalTo: SimSession[];
}

type Outcome =
	| { readonly kind: "appended"; readonly seq: Seq }
	| { readonly kind: "deduped"; readonly seq: Seq }
	| { readonly kind: "conflict"; readonly seq: Seq };

interface SessionHost {
	readonly schedule: (fn: () => void) => void;
	append(session: SimSession, frame: AppendFrame): void;
	feed(afterSeq: Seq): Promise<FeedPage>;
	read(stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean): Promise<ReadPage>;
	putCheckpoint(session: SimSession, stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): Promise<PutCheckpointResult>;
	clientClosed(session: SimSession): void;
}

function frameKey(deviceId: DeviceId, clientFrameId: ClientFrameId): string {
	return `${deviceId}\u0000${clientFrameId}`;
}

function heldKey(stream: StreamName, deviceId: DeviceId, clientFrameId: ClientFrameId): string {
	return `${stream}\u0000${deviceId}\u0000${clientFrameId}`;
}

function isProvisionalStream(stream: StreamName): boolean {
	return stream.startsWith("b:") || stream.startsWith("c:");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

function utf8Length(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

function validStreamName(stream: string): boolean {
	const n = utf8Length(stream);
	return n >= 1 && n <= 256;
}

function validClientFrameId(id: string): boolean {
	const n = utf8Length(id);
	return n >= 1 && n <= 128;
}

function validSeq(n: number): boolean {
	return Number.isSafeInteger(n) && n >= 0;
}

class SimSession implements RelaySession {
	/** Adapter join map: PROVISIONAL payloads held until their notice. */
	readonly held = new Map<string, Uint8Array>();
	private queue: RelayEvent[] = [];
	private readonly listeners = new Set<(event: RelayEvent) => void>();
	private everListened = false;
	private drainScheduled = false;
	private ended = false;

	constructor(
		private readonly host: SessionHost,
		readonly id: number,
		readonly deviceId: DeviceId,
		readonly vaultEpoch: VaultEpoch,
		readonly headSeq: Seq,
		readonly canWrite: boolean,
		readonly limits: RelayLimits,
	) {}

	/** Nothing left to deliver (a session without listeners holds its buffer: it counts as idle). */
	get idle(): boolean {
		return !this.drainScheduled && (this.queue.length === 0 || this.listeners.size === 0);
	}

	get disposable(): boolean {
		return this.ended && this.queue.length === 0 && !this.drainScheduled;
	}

	// ---- RelaySession -------------------------------------------------------

	append(frame: AppendFrame): void {
		if (this.ended) return;
		this.host.append(this, frame);
	}

	/** Appends reach the relay at once: nothing is ever queued on the "socket". */
	bufferedBytes(): number {
		return 0;
	}

	feed(afterSeq: Seq): Promise<FeedPage> {
		return this.host.feed(afterSeq);
	}

	read(stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean): Promise<ReadPage> {
		return this.host.read(stream, afterSeq, preferCheckpoint);
	}

	putCheckpoint(stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): Promise<PutCheckpointResult> {
		return this.host.putCheckpoint(this, stream, coversSeq, expectedPrevCoversSeq, bytes);
	}

	onEvent(listener: (event: RelayEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		if (!this.everListened) {
			// Like wsRelay: the pre-listener buffer is flushed synchronously, in order.
			this.everListened = true;
			const buffered = this.queue;
			this.queue = [];
			for (const event of buffered) this.deliver(listener, event);
		} else {
			this.kick();
		}
		return () => {
			this.listeners.delete(listener);
		};
	}

	close(code: number, _reason: string): void {
		if (this.ended) return;
		this.ended = true;
		this.held.clear();
		this.host.clientClosed(this);
		// Events still "on the wire" die with the socket; a never-listened buffer is the adapter's and survives.
		if (this.everListened) this.queue = [];
		const event: RelayEvent = { t: "closed", code, errorCode: null, wasClean: true };
		if (this.listeners.size === 0) {
			this.queue.push(event);
			return;
		}
		for (const listener of Array.from(this.listeners)) this.deliver(listener, event);
	}

	// ---- relay side ---------------------------------------------------------

	/** Queues one event for asynchronous FIFO delivery. Ignored once "closed" was produced. */
	push(event: RelayEvent): void {
		if (this.ended) return;
		if (event.t === "closed") {
			this.ended = true;
			this.held.clear();
		}
		this.queue.push(event);
		this.kick();
	}

	/** Takes a held PROVISIONAL payload (null when not held: forgotten or dropped). */
	takeHeld(key: string): Uint8Array | null {
		const payload = this.held.get(key);
		if (payload === undefined) return null;
		this.held.delete(key);
		return payload;
	}

	private kick(): void {
		if (this.drainScheduled || this.listeners.size === 0 || this.queue.length === 0) return;
		this.drainScheduled = true;
		this.host.schedule(() => this.drain());
	}

	private drain(): void {
		this.drainScheduled = false;
		while (this.queue.length > 0 && this.listeners.size > 0) {
			const event = this.queue.shift();
			if (event === undefined) break;
			for (const listener of Array.from(this.listeners)) this.deliver(listener, event);
		}
	}

	private deliver(listener: (event: RelayEvent) => void, event: RelayEvent): void {
		try {
			listener(event);
		} catch (error) {
			// A throwing listener must not stall delivery; surface it asynchronously (like wsRelay).
			queueMicrotask(() => {
				throw error;
			});
		}
	}
}

// ---------------------------------------------------------------------------
// SimRelay
// ---------------------------------------------------------------------------

export class SimRelay implements RelayPort {
	readonly limits: RelayLimits;
	private epoch: VaultEpoch;
	private readonly readPageRows: number;
	private readonly dedupeWindow: number;
	private readonly autoCommit: boolean;
	private readonly gcOnCheckpoint: boolean;
	private readonly readOnly: Set<DeviceId>;
	private readonly schedule: (fn: () => void) => void;
	private readonly host: SessionHost;

	private headSeq: Seq = 0;
	private readonly streamMap = new Map<StreamName, StreamState>();
	private pending: PendingFrame[] = [];
	private readonly pendingByKey = new Map<string, PendingFrame>();
	private readonly open = new Set<SimSession>();
	private tracked: SimSession[] = [];
	private nextSessionId = 1;

	private commitScheduled = false;
	private paused = false;
	private nextCommitFailure: { readonly reason: "durability" | "daily-limit"; readonly retryAfterMs: number } | null = null;
	private dailyLimit: { readonly retryAfterMs: number } | null = null;
	private connectFailure: { readonly reason: SimConnectFailureReason; readonly retryAfterMs: number | null } | null = null;
	private httpFailure = false;
	private httpInFlight = 0;

	constructor(options: SimRelayOptions = {}) {
		this.epoch = options.vaultEpoch ?? "sim-epoch-1";
		this.limits = Object.freeze({ ...DEFAULT_SIM_RELAY_LIMITS, ...options.limits });
		this.readPageRows = options.readPageRows ?? Number.POSITIVE_INFINITY;
		this.dedupeWindow = options.dedupeWindow ?? DEFAULT_SIM_DEDUPE_WINDOW;
		this.autoCommit = options.autoCommit ?? true;
		this.gcOnCheckpoint = options.gcOnCheckpoint ?? true;
		this.readOnly = new Set(options.readOnlyDevices ?? []);
		this.schedule = options.schedule ?? ((fn) => {
			setTimeout(fn, 0);
		});
		this.host = {
			schedule: this.schedule,
			append: (session, frame) => this.onAppend(session, frame),
			feed: (afterSeq) => this.reply(() => this.feedPage(afterSeq)),
			read: (stream, afterSeq, prefer) => this.reply(() => this.readPage(stream, afterSeq, prefer)),
			putCheckpoint: (session, stream, coversSeq, expected, bytes) =>
				this.reply(() => this.checkpointPut(session, stream, coversSeq, expected, bytes)),
			clientClosed: (session) => {
				this.open.delete(session);
			},
		};
	}

	// ---- RelayPort ----------------------------------------------------------

	connect(params: RelayConnectParams): Promise<RelayConnectResult> {
		const failure = this.connectFailure;
		if (failure !== null) return Promise.resolve({ ok: false, reason: failure.reason, retryAfterMs: failure.retryAfterMs });
		// Admission is synchronous: headSeq is the head now; later commits are buffered for the first listener.
		const session = new SimSession(
			this.host,
			this.nextSessionId++,
			params.deviceId,
			this.epoch,
			this.headSeq,
			!this.readOnly.has(params.deviceId),
			this.limits,
		);
		this.open.add(session);
		this.tracked.push(session);
		return Promise.resolve({ ok: true, session });
	}

	// ---- fault / test controls ----------------------------------------------

	/** Every later connect() fails with `reason` until called with null. */
	setConnectFailure(reason: SimConnectFailureReason | null, retryAfterMs: number | null = null): void {
		this.connectFailure = reason === null ? null : { reason, retryAfterMs };
	}

	/** While paused, appended frames stay uncommitted and unreceipted (flush() still commits). */
	pauseCommits(): void {
		this.paused = true;
	}

	resumeCommits(): void {
		this.paused = false;
		this.scheduleCommit();
	}

	/** Commits the pending buffer now (even when paused or autoCommit is off), then resolves once delivery settled. */
	flush(): Promise<void> {
		this.commitNow();
		return this.settled();
	}

	/**
	 * Resolves once no commit is scheduled, no HTTP reply is outstanding and every
	 * session with a listener has an empty queue. Pending frames held by
	 * pauseCommits()/autoCommit:false do not count. Driven by `schedule`, so it
	 * also works with a manual scheduler (as long as it is pumped).
	 */
	settled(maxTurns = 10_000): Promise<void> {
		return new Promise((resolve, reject) => {
			let turns = 0;
			const check = (): void => {
				if (this.quiescent()) {
					resolve();
					return;
				}
				if (++turns > maxTurns) {
					reject(new Error(`sim relay: not settled after ${maxTurns} turns`));
					return;
				}
				this.schedule(check);
			};
			this.schedule(check);
		});
	}

	/**
	 * Relay runtime restart (STREAM_RESEND, §5.5): every uncommitted frame is
	 * lost without a receipt or refusal; every open session drops its held
	 * provisionals and gets "resendUnreceipted" with the current head.
	 */
	restart(): void {
		this.pending = [];
		this.pendingByKey.clear();
		for (const session of this.open) {
			session.held.clear();
			session.push({ t: "resendUnreceipted", headSeq: this.headSeq });
		}
	}

	/** Abrupt socket loss for every open session of `deviceId`: closed{code, wasClean:false}. Buffered frames still commit. */
	dropSession(deviceId: DeviceId, code: number = RELAY_CLOSE.abnormal): void {
		for (const session of this.sessionsOf(deviceId)) this.serverClose(session, code, null, false);
	}

	/** The next non-empty group commit fails as a whole: every frame refused, nothing written. "daily-limit" also latches the daily limit. */
	failNextCommit(reason: "durability" | "daily-limit", retryAfterMs = 60_000): void {
		this.nextCommitFailure = { reason, retryAfterMs };
	}

	/** Free-plan daily limit latch: appends refused up front (no provisional), checkpoints refused. */
	setDailyLimit(on: boolean, retryAfterMs = 60_000): void {
		this.dailyLimit = on ? { retryAfterMs } : null;
	}

	/** VAULT_BACKPRESSURE then a 1013 close for every open session of `deviceId`. Buffered frames still commit. */
	backpressure(deviceId: DeviceId): void {
		for (const session of this.sessionsOf(deviceId)) {
			session.push({ t: "backpressure" });
			this.serverClose(session, RELAY_CLOSE.rate, null, true);
		}
	}

	/**
	 * Authority change (device revoked, credential rotated, role changed): the
	 * buffer is committed first (unless paused), then every open session of
	 * `deviceId` closes 4403 with errorCode "authority_superseded".
	 */
	supersede(deviceId: DeviceId): void {
		if (!this.paused) this.commitNow();
		for (const session of this.sessionsOf(deviceId)) {
			this.serverClose(session, RELAY_CLOSE.superseded, "authority_superseded", true);
		}
	}

	/** New sessions of `deviceId` get canWrite = !readOnly (open sessions keep theirs; a real role change also supersedes). */
	setReadOnly(deviceId: DeviceId, readOnly: boolean): void {
		if (readOnly) this.readOnly.add(deviceId);
		else this.readOnly.delete(deviceId);
	}

	/** Open sessions of `deviceId` forget held PROVISIONAL payloads: their notices become "committed" with payload null. */
	forgetHeldProvisionals(deviceId: DeviceId): void {
		for (const session of this.sessionsOf(deviceId)) session.held.clear();
	}

	/** Queues any event (e.g. provisionalDropped, head) on every open session of `deviceId`. A "closed" event closes them. */
	inject(deviceId: DeviceId, event: RelayEvent): void {
		for (const session of this.sessionsOf(deviceId)) {
			if (event.t === "closed") this.serverClose(session, event.code, event.errorCode, event.wasClean);
			else session.push(event);
		}
	}

	/** While on, feed/read/putCheckpoint reject with SimRelayError("network_error"). */
	setHttpFailure(on: boolean): void {
		this.httpFailure = on;
	}

	/** Vault destroyed and re-created: buffer and rows wiped, head 0, new epoch; open sessions close 1001. */
	resetEpoch(vaultEpoch: VaultEpoch): void {
		this.pending = [];
		this.pendingByKey.clear();
		this.streamMap.clear();
		this.headSeq = 0;
		this.dailyLimit = null;
		this.nextCommitFailure = null;
		this.epoch = vaultEpoch;
		for (const session of Array.from(this.open)) this.serverClose(session, RELAY_CLOSE.goingAway, null, true);
	}

	// ---- introspection --------------------------------------------------------

	head(): Seq {
		return this.headSeq;
	}

	vaultEpoch(): VaultEpoch {
		return this.epoch;
	}

	/** Rows of `stream` still readable (seq > gcSeq), or every committed row with includeGc. */
	rows(stream: StreamName, options: { readonly includeGc?: boolean } = {}): readonly SimRow[] {
		const state = this.streamMap.get(stream);
		if (state === undefined) return [];
		return options.includeGc === true ? state.rows.slice() : state.rows.filter((row) => row.seq > state.gcSeq);
	}

	/** Streams with at least one committed row, in first-commit order. */
	streams(): readonly StreamName[] {
		return Array.from(this.streamMap.keys());
	}

	checkpoint(stream: StreamName): { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null {
		const cp = this.streamMap.get(stream)?.checkpoint ?? null;
		return cp === null ? null : { coversSeq: cp.coversSeq, bytes: cp.bytes.slice() };
	}

	gcSeq(stream: StreamName): Seq {
		return this.streamMap.get(stream)?.gcSeq ?? 0;
	}

	/** Open sessions in connect order. */
	sessions(): readonly SimSessionInfo[] {
		return Array.from(this.open, (s) => ({ id: s.id, deviceId: s.deviceId, headSeq: s.headSeq, canWrite: s.canWrite }));
	}

	/** Frames appended but not yet committed. */
	pendingCount(): number {
		return this.pending.length;
	}

	// ---- append / commit -------------------------------------------------------

	private sessionsOf(deviceId: DeviceId): SimSession[] {
		return Array.from(this.open).filter((s) => s.deviceId === deviceId);
	}

	private serverClose(session: SimSession, code: number, errorCode: string | null, wasClean: boolean): void {
		this.open.delete(session);
		session.push({ t: "closed", code, errorCode, wasClean });
	}

	private refuse(session: SimSession, stream: StreamName, clientFrameId: ClientFrameId, reason: RefusalReason, retryAfterMs: number | null, conflictSeq: Seq | null): void {
		session.push({ t: "refused", stream, clientFrameId, reason, retryAfterMs, conflictSeq });
	}

	private onAppend(session: SimSession, frame: AppendFrame): void {
		if (!this.open.has(session)) return;
		if (!validStreamName(frame.stream) || !validClientFrameId(frame.clientFrameId)) {
			this.serverClose(session, RELAY_CLOSE.policy, null, true);
			return;
		}
		if (frame.payload.byteLength > this.limits.maxFrameBytes) {
			this.serverClose(session, RELAY_CLOSE.oversize, null, true);
			return;
		}
		if (!session.canWrite) {
			this.refuse(session, frame.stream, frame.clientFrameId, "forbidden", null, null);
			return;
		}
		const key = frameKey(session.deviceId, frame.clientFrameId);
		const pending = this.pendingByKey.get(key);
		if (pending !== undefined) {
			if (pending.stream === frame.stream && bytesEqual(pending.payload, frame.payload)) pending.duplicates.push(session);
			else this.refuse(session, frame.stream, frame.clientFrameId, "frame-id-conflict", null, null);
			return;
		}
		if (this.dailyLimit !== null) {
			this.refuse(session, frame.stream, frame.clientFrameId, "daily-limit", this.dailyLimit.retryAfterMs, null);
			return;
		}
		const entry: PendingFrame = {
			key,
			stream: frame.stream,
			deviceId: session.deviceId,
			clientFrameId: frame.clientFrameId,
			payload: frame.payload.slice(),
			origin: session,
			duplicates: [],
			provisionalTo: [],
		};
		if (isProvisionalStream(frame.stream)) {
			const hk = heldKey(entry.stream, entry.deviceId, entry.clientFrameId);
			for (const peer of this.open) {
				if (peer === session) continue;
				const payload = entry.payload.slice();
				peer.held.set(hk, payload);
				peer.push({ t: "provisional", stream: entry.stream, deviceId: entry.deviceId, clientFrameId: entry.clientFrameId, payload });
				entry.provisionalTo.push(peer);
			}
		}
		this.pending.push(entry);
		this.pendingByKey.set(key, entry);
		this.scheduleCommit();
	}

	private scheduleCommit(): void {
		if (!this.autoCommit || this.paused || this.commitScheduled || this.pending.length === 0) return;
		this.commitScheduled = true;
		this.schedule(() => {
			this.commitScheduled = false;
			if (!this.paused) this.commitNow();
		});
	}

	private windowLookup(state: StreamState, key: string): SimRow | null {
		const stop = Math.max(0, state.rows.length - this.dedupeWindow);
		for (let i = state.rows.length - 1; i >= stop; i--) {
			const row = state.rows[i];
			if (row !== undefined && frameKey(row.deviceId, row.clientFrameId) === key) return row;
		}
		return null;
	}

	private commitNow(): void {
		const frames = this.pending;
		if (frames.length === 0) return;
		this.pending = [];
		this.pendingByKey.clear();
		const failure = this.nextCommitFailure;
		if (failure !== null) {
			this.nextCommitFailure = null;
			this.failCommit(frames, failure.reason, failure.retryAfterMs);
			return;
		}

		// One transaction: contiguous seqs in arrival order.
		const outcomes: Outcome[] = frames.map((frame) => {
			let state = this.streamMap.get(frame.stream);
			const hit = state === undefined ? null : this.windowLookup(state, frame.key);
			if (hit !== null) {
				return bytesEqual(hit.payload, frame.payload) ? { kind: "deduped", seq: hit.seq } : { kind: "conflict", seq: hit.seq };
			}
			if (state === undefined) {
				state = { name: frame.stream, rows: [], lastSeq: 0, checkpoint: null, gcSeq: 0 };
				this.streamMap.set(frame.stream, state);
			}
			const seq = ++this.headSeq;
			state.rows.push({ stream: frame.stream, seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, payload: frame.payload });
			state.lastSeq = seq;
			return { kind: "appended", seq };
		});

		// Broadcasts in seq order, then one receipt batch per origin session.
		const peers = Array.from(this.open);
		const receipts = new Map<SimSession, RelayEvent[]>();
		const addReceipt = (session: SimSession, event: RelayEvent): void => {
			const list = receipts.get(session);
			if (list === undefined) receipts.set(session, [event]);
			else list.push(event);
		};
		frames.forEach((frame, index) => {
			const outcome = outcomes[index];
			if (outcome === undefined) return;
			if (outcome.kind === "conflict") {
				for (const waiter of [frame.origin, ...frame.duplicates]) {
					this.refuse(waiter, frame.stream, frame.clientFrameId, "frame-id-conflict", null, outcome.seq);
				}
				this.dropProvisional(frame);
				return;
			}
			const hk = heldKey(frame.stream, frame.deviceId, frame.clientFrameId);
			for (const peer of peers) {
				if (peer === frame.origin) continue;
				if (frame.provisionalTo.includes(peer)) {
					// COMMIT_NOTICE joined with the held PROVISIONAL (older seq for a store-deduped resend, R7).
					peer.push({ t: "committed", frame: { stream: frame.stream, seq: outcome.seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, payload: peer.takeHeld(hk) } });
				} else if (outcome.kind === "appended") {
					peer.push({ t: "committed", frame: { stream: frame.stream, seq: outcome.seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, payload: frame.payload.slice() } });
				}
			}
			const base = { t: "receipt", stream: frame.stream, clientFrameId: frame.clientFrameId, seq: outcome.seq } as const;
			addReceipt(frame.origin, { ...base, deduped: outcome.kind === "deduped" });
			for (const duplicate of frame.duplicates) addReceipt(duplicate, { ...base, deduped: true });
		});
		for (const [session, list] of receipts) {
			for (const event of list) session.push(event);
			session.push({ t: "head", headSeq: this.headSeq });
		}
	}

	private dropProvisional(frame: PendingFrame): void {
		const hk = heldKey(frame.stream, frame.deviceId, frame.clientFrameId);
		for (const peer of frame.provisionalTo) {
			peer.held.delete(hk);
			peer.push({ t: "provisionalDropped", stream: frame.stream, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId });
		}
	}

	private failCommit(frames: readonly PendingFrame[], reason: "durability" | "daily-limit", retryAfterMs: number): void {
		const after = reason === "daily-limit" ? retryAfterMs : null;
		for (const frame of frames) {
			for (const waiter of [frame.origin, ...frame.duplicates]) this.refuse(waiter, frame.stream, frame.clientFrameId, reason, after, null);
			this.dropProvisional(frame);
		}
		if (reason === "daily-limit") this.dailyLimit = { retryAfterMs };
	}

	// ---- HTTP ------------------------------------------------------------------

	/** Computes the reply now (a snapshot), resolves or rejects it on the next schedule() turn. */
	private reply<T>(compute: () => T): Promise<T> {
		let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
		try {
			if (this.httpFailure) throw new SimRelayError("network_error");
			outcome = { ok: true, value: compute() };
		} catch (error) {
			outcome = { ok: false, error };
		}
		this.httpInFlight++;
		return new Promise<T>((resolve, reject) => {
			this.schedule(() => {
				this.httpInFlight--;
				if (outcome.ok) resolve(outcome.value);
				else reject(outcome.error);
			});
		});
	}

	private feedPage(afterSeq: Seq): FeedPage {
		if (!validSeq(afterSeq)) throw new SimRelayError("invalid_cursor");
		const changed = Array.from(this.streamMap.values())
			.filter((s) => s.lastSeq > afterSeq)
			.sort((a, b) => a.lastSeq - b.lastSeq);
		const limit = Math.max(1, Math.floor(this.limits.feedPageRows));
		const more = changed.length > limit;
		const entries = changed.slice(0, limit).map((s) => ({ stream: s.name, lastSeq: s.lastSeq }));
		const last = entries[entries.length - 1];
		const throughSeq = more && last !== undefined ? last.lastSeq : this.headSeq;
		return { entries, throughSeq, headSeq: this.headSeq, more };
	}

	private readPage(stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean): ReadPage {
		if (!validStreamName(stream)) throw new SimRelayError("invalid_stream");
		if (!validSeq(afterSeq)) throw new SimRelayError("invalid_cursor");
		const state = this.streamMap.get(stream);
		if (state === undefined) return { checkpoint: null, rows: [], lastSeq: 0, checkpointSeq: 0, nextAfterSeq: afterSeq, more: false };
		const cp = state.checkpoint;
		let from = afterSeq;
		let budget = this.limits.readPageBytes;
		let checkpoint: ReadPage["checkpoint"] = null;
		if (cp !== null && (afterSeq < state.gcSeq || (preferCheckpoint && afterSeq < cp.coversSeq))) {
			checkpoint = { coversSeq: cp.coversSeq, bytes: cp.bytes.slice() };
			from = cp.coversSeq;
			budget -= cp.bytes.byteLength;
		}
		const rows: RelayRow[] = [];
		let more = false;
		for (const row of state.rows) {
			if (row.seq <= from || row.seq <= state.gcSeq) continue;
			const hasSome = rows.length > 0 || checkpoint !== null;
			if (hasSome && (budget - row.payload.byteLength < 0 || rows.length >= this.readPageRows)) {
				more = true;
				break;
			}
			rows.push({ seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, payload: row.payload.slice() });
			budget -= row.payload.byteLength;
		}
		const lastRow = rows[rows.length - 1];
		const nextAfterSeq = lastRow?.seq ?? checkpoint?.coversSeq ?? afterSeq;
		return { checkpoint, rows, lastSeq: state.lastSeq, checkpointSeq: cp?.coversSeq ?? 0, nextAfterSeq, more };
	}

	private checkpointPut(session: SimSession, stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): PutCheckpointResult {
		if (!validStreamName(stream)) throw new SimRelayError("invalid_stream");
		if (!Number.isSafeInteger(coversSeq) || coversSeq < 1) throw new SimRelayError("invalid_covers_seq");
		if (!validSeq(expectedPrevCoversSeq)) throw new SimRelayError("invalid_expected_covers_seq");
		if (!session.canWrite) return { t: "refused", reason: "forbidden", retryAfterMs: null };
		if (bytes.byteLength > this.limits.maxCheckpointBytes) return { t: "refused", reason: "too-large", retryAfterMs: null };
		if (this.dailyLimit !== null) return { t: "refused", reason: "daily-limit", retryAfterMs: this.dailyLimit.retryAfterMs };
		const state = this.streamMap.get(stream);
		if (state === undefined) return { t: "refused", reason: "stream-not-found", retryAfterMs: null };
		const current = state.checkpoint?.coversSeq ?? 0;
		if (current !== expectedPrevCoversSeq) return { t: "conflict", currentCoversSeq: current };
		if (coversSeq <= current) return { t: "refused", reason: "not-advancing", retryAfterMs: null };
		if (coversSeq > state.lastSeq) return { t: "refused", reason: "ahead-of-stream", retryAfterMs: null };
		state.checkpoint = { coversSeq, bytes: bytes.slice() };
		if (this.gcOnCheckpoint) {
			for (const row of state.rows) if (row.seq <= coversSeq && row.seq > state.gcSeq) state.gcSeq = row.seq;
		}
		return { t: "ok" };
	}

	private quiescent(): boolean {
		if (this.commitScheduled || this.httpInFlight > 0) return false;
		this.tracked = this.tracked.filter((s) => !s.disposable);
		return this.tracked.every((s) => s.idle);
	}
}
