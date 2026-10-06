/**
 * Sender (DESIGN §d.4, §d.5, §d.6, §i.1, §i.6).
 *
 * Sends `pending`/`sent` outbox records (both are "maybe sent" after any
 * restart; correctness relies only on idempotence, R4) in lane order, then
 * outbox order, within:
 *  - a token bucket (APPEND_BYTES_PER_SEC, halved for 10 min after backpressure);
 *  - maxInflightAppendBytes of sent-unreceipted bytes (one frame always allowed);
 *  - session.bufferedBytes() <= BUFFERED_HIGH_WATER;
 *  - the ns/cfg send window (first NS_SEND_WINDOW unreceipted frames by order),
 *    opened only after the reconnect late-receipt reads (DESIGN §d.7);
 *  - daily-limit hold, canWrite / forbidden, durability backoff;
 *  - probe mode after a 1008/1009 close: one frame in flight; a frame that
 *    triggers the close again is poisoned.
 */

import { APPEND_BYTES_PER_SEC, NS_SEND_WINDOW, RELAY_CLOSE } from "../../core/limits";
import { CFG_STREAM, NS_STREAM, type ClientFrameId } from "../../core/types";
import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { RelaySession, RefusalReason } from "../../ports/relay";
import type { OutboxRecord } from "../store/schema";

export const BUFFERED_HIGH_WATER = 256 * 1024;
export const BACKPRESSURE_SLOWDOWN_MS = 10 * 60_000;
export const DURABILITY_RETRY_MS = 1_000;
const MAX_BURST = 1024 * 1024;

export interface SenderDeps {
	readonly clock: ClockPort;
	/** Rank: 0 bound body, 1 ns, 2 cfg, 3 background body, 4 bulk (x:, adopted). */
	rankOf(rec: OutboxRecord): number;
	maxInflightBytes(): number;
	/** Lazy T_sent (diagnostics only). */
	onSent(rec: OutboxRecord, attempts: number): void;
	onPoison(rec: OutboxRecord, why: string): void;
	onForbidden(): void;
	/** waitMs: the hold; retryAfterMs: the relay's delay to its reset, null when it did not say. */
	onDailyLimit(waitMs: number, retryAfterMs: number | null): void;
	diag(code: string, fields: Record<string, string | number | boolean | null>): void;
}

interface Entry {
	rec: OutboxRecord;
	attempts: number;
	retryAtMono: number;
}

export class TokenBucket {
	private tokens: number;
	private last: number;
	slowUntil = 0;
	constructor(private capacity: number, private readonly ratePerSec: number, now: number) {
		this.tokens = capacity;
		this.last = now;
	}
	setCapacity(c: number): void {
		this.capacity = c;
		this.tokens = Math.min(this.tokens, c);
	}
	rate(now: number): number {
		return now < this.slowUntil ? this.ratePerSec / 2 : this.ratePerSec;
	}
	private refill(now: number): void {
		const dt = Math.max(0, now - this.last);
		this.last = now;
		this.tokens = Math.min(this.capacity, this.tokens + (dt * this.rate(now)) / 1000);
	}
	/** 0 = taken; otherwise ms to wait. A frame larger than capacity is allowed from a full bucket. */
	take(bytes: number, now: number): number {
		this.refill(now);
		const need = Math.min(bytes, this.capacity);
		if (this.tokens >= need) {
			this.tokens -= bytes;
			return 0;
		}
		return Math.ceil(((need - this.tokens) * 1000) / this.rate(now));
	}
	available(now: number): number {
		this.refill(now);
		return this.tokens;
	}
}

export class Sender {
	private readonly entries = new Map<ClientFrameId, Entry>();
	private readonly inflight = new Map<ClientFrameId, number>();
	private inflightBytes = 0;
	private session: RelaySession | null = null;
	private nsOpen = false;
	private readOnly = false;
	private holdUntilMono = 0;
	private probe: { suspects: Set<ClientFrameId> } | null = null;
	private timer: TimerHandle | null = null;
	private timerAt = Infinity;
	private dirty = true;
	private sorted: Entry[] = [];
	paused = false;
	readonly bucket: TokenBucket;
	stats = { appends: 0, bytes: 0, poisoned: 0 };

	constructor(private readonly deps: SenderDeps) {
		this.bucket = new TokenBucket(MAX_BURST, APPEND_BYTES_PER_SEC, deps.clock.monotonic());
	}

	get inflightCount(): number {
		return this.inflight.size;
	}
	get inflightByteCount(): number {
		return this.inflightBytes;
	}
	get queued(): number {
		return this.entries.size;
	}
	get probing(): boolean {
		return this.probe !== null;
	}
	get nsWindowOpen(): boolean {
		return this.nsOpen;
	}
	isInflight(cfid: ClientFrameId): boolean {
		return this.inflight.has(cfid);
	}
	has(cfid: ClientFrameId): boolean {
		return this.entries.has(cfid);
	}

	/** New session. Body frames resend at once; ns/cfg wait for openNs(). */
	attach(session: RelaySession): void {
		this.session = session;
		this.inflight.clear();
		this.inflightBytes = 0;
		this.nsOpen = false;
		this.readOnly = !session.canWrite;
		this.bucket.setCapacity(Math.min(MAX_BURST, session.limits.burstBytes || MAX_BURST));
		this.pump();
	}
	detach(): void {
		this.session = null;
		this.inflight.clear();
		this.inflightBytes = 0;
		this.nsOpen = false;
		this.clearTimer();
	}
	openNs(): void {
		this.nsOpen = true;
		this.pump();
	}

	/** Add or replace a sendable record (pending / sent). Other states are removed. */
	upsert(rec: OutboxRecord): void {
		if (rec.state !== "pending" && rec.state !== "sent") {
			this.remove(rec.clientFrameId);
			return;
		}
		const e = this.entries.get(rec.clientFrameId);
		if (e) e.rec = rec;
		else this.entries.set(rec.clientFrameId, { rec, attempts: rec.attempts, retryAtMono: 0 });
		this.dirty = true;
		this.schedule(0);
	}
	remove(cfid: ClientFrameId): void {
		if (this.entries.delete(cfid)) this.dirty = true;
		const b = this.inflight.get(cfid);
		if (b !== undefined) {
			this.inflight.delete(cfid);
			this.inflightBytes -= b;
		}
		if (this.probe) {
			this.probe.suspects.delete(cfid);
			if (this.probe.suspects.size === 0) this.probe = null;
		}
		this.schedule(0);
	}

	/** Receipt observed (live). The record itself is deleted by T_receipt. */
	onReceipt(cfid: ClientFrameId): void {
		this.remove(cfid);
	}

	onRefused(cfid: ClientFrameId, reason: RefusalReason, retryAfterMs: number | null): void {
		const e = this.entries.get(cfid);
		const b = this.inflight.get(cfid);
		if (b !== undefined) {
			this.inflight.delete(cfid);
			this.inflightBytes -= b;
		}
		const now = this.deps.clock.monotonic();
		this.deps.diag("append-refused", { reason, retryAfterMs });
		switch (reason) {
			case "durability":
				if (e) e.retryAtMono = now + DURABILITY_RETRY_MS;
				this.schedule(DURABILITY_RETRY_MS);
				return;
			case "daily-limit": {
				const wait = Math.max(1_000, retryAfterMs ?? 60_000);
				this.holdUntilMono = Math.max(this.holdUntilMono, now + wait);
				this.deps.onDailyLimit(wait, retryAfterMs);
				this.schedule(wait);
				return;
			}
			case "forbidden":
				this.readOnly = true;
				this.deps.onForbidden();
				return;
			case "frame-id-conflict":
				if (e) {
					this.remove(cfid);
					this.stats.poisoned++;
					this.deps.onPoison(e.rec, "frame-id-conflict");
				}
				return;
		}
	}

	/** Socket closed: unreceipted frames are lost (R3); 1008/1009 enters (or continues) probe mode. */
	onClosed(code: number): void {
		const wasInflight = [...this.inflight.keys()];
		if (code === RELAY_CLOSE.policy || code === RELAY_CLOSE.oversize) {
			if (this.probe && wasInflight.length === 1) {
				const e = this.entries.get(wasInflight[0]!);
				if (e) {
					this.remove(e.rec.clientFrameId);
					this.stats.poisoned++;
					this.deps.onPoison(e.rec, `close-${code}`);
				}
			} else if (wasInflight.length > 0) {
				this.probe = { suspects: new Set([...(this.probe?.suspects ?? []), ...wasInflight]) };
			}
		}
		this.detach();
	}

	/** STREAM_RESEND: everything unreceipted is resent in order. */
	onResend(): void {
		this.inflight.clear();
		this.inflightBytes = 0;
		this.dirty = true;
		this.schedule(0);
	}

	onBackpressure(): void {
		const now = this.deps.clock.monotonic();
		this.bucket.slowUntil = now + BACKPRESSURE_SLOWDOWN_MS;
		this.holdUntilMono = Math.max(this.holdUntilMono, now + 5_000);
	}

	releaseDailyHold(): void {
		this.holdUntilMono = 0;
		this.schedule(0);
	}

	private clearTimer(): void {
		if (this.timer !== null) this.deps.clock.clearTimer(this.timer);
		this.timer = null;
		this.timerAt = Infinity;
	}

	private schedule(delayMs: number): void {
		if (!this.session) return;
		const at = this.deps.clock.monotonic() + delayMs;
		if (this.timer !== null && this.timerAt <= at) return;
		this.clearTimer();
		this.timerAt = at;
		this.timer = this.deps.clock.setTimer(Math.max(0, delayMs), () => {
			this.timer = null;
			this.timerAt = Infinity;
			this.pump();
		});
	}

	private order(): Entry[] {
		if (this.dirty) {
			this.sorted = [...this.entries.values()].sort((a, b) => this.deps.rankOf(a.rec) - this.deps.rankOf(b.rec) || a.rec.order - b.rec.order);
			this.dirty = false;
		}
		return this.sorted;
	}

	/** First NS_SEND_WINDOW unreceipted frames of ns and of cfg, by order. */
	private window(): Set<ClientFrameId> {
		const ns: Entry[] = [];
		const cfg: Entry[] = [];
		for (const e of this.entries.values()) {
			if (e.rec.stream === NS_STREAM) ns.push(e);
			else if (e.rec.stream === CFG_STREAM) cfg.push(e);
		}
		const out = new Set<ClientFrameId>();
		for (const list of [ns, cfg]) {
			list.sort((a, b) => a.rec.order - b.rec.order);
			for (const e of list.slice(0, NS_SEND_WINDOW)) out.add(e.rec.clientFrameId);
		}
		return out;
	}

	pump(): void {
		const s = this.session;
		if (!s || this.readOnly || this.paused) return;
		const now = this.deps.clock.monotonic();
		if (now < this.holdUntilMono) {
			this.schedule(this.holdUntilMono - now);
			return;
		}
		const nsWindow = this.window();
		const maxInflight = this.deps.maxInflightBytes();
		let nextWake = Infinity;
		for (const e of this.order()) {
			const cfid = e.rec.clientFrameId;
			if (this.inflight.has(cfid)) continue;
			if (this.probe && this.inflight.size > 0) break;
			const isNs = e.rec.stream === NS_STREAM || e.rec.stream === CFG_STREAM;
			if (isNs && (!this.nsOpen || !nsWindow.has(cfid))) continue;
			if (e.retryAtMono > now) {
				nextWake = Math.min(nextWake, e.retryAtMono - now);
				continue;
			}
			const bytes = e.rec.sealed.length;
			if (this.inflight.size > 0 && this.inflightBytes + bytes > maxInflight) break;
			if (s.bufferedBytes() > BUFFERED_HIGH_WATER) {
				nextWake = Math.min(nextWake, 50);
				break;
			}
			const wait = this.bucket.take(bytes, now);
			if (wait > 0) {
				nextWake = Math.min(nextWake, wait);
				break;
			}
			this.inflight.set(cfid, bytes);
			this.inflightBytes += bytes;
			e.attempts++;
			this.stats.appends++;
			this.stats.bytes += bytes;
			s.append({ stream: e.rec.stream, clientFrameId: cfid, payload: e.rec.sealed });
			this.deps.onSent(e.rec, e.attempts);
		}
		if (nextWake < Infinity) this.schedule(nextWake);
	}
}
