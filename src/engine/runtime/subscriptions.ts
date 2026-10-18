/**
 * Stream subscriptions and the deferred read of skipped streams (DESIGN §d.7 "Subscriptions").
 *
 * The set: bound streams, then streams with own outbox records (own frames in flight, adoptables), then the
 * recentUnboundKeep most recently unbound docs for recentUnboundMs, capped at limits.maxSubscriptions. Each new
 * session gets it right after VAULT_READY (before the feed); later changes are debounced (subscribeDebounceMs)
 * and sent only when the set changed. The adapter resends it on STREAM_RESEND. Nothing is sent when the relay has
 * no subscriptions (maxSubscriptions 0), when the session has no subscribe(), or with EngineOptions.subscribe false.
 *
 * Deferral: a skipped row (another device's b:/c: row outside the set) makes its stream stale and records the
 * skip time (in memory: after a restart the stream is read under the normal rules). sessionLoop.scheduleCatchUp
 * holds such a stream's read until no skip arrived for settleMs, or maxDeferMs passed since the first one; the
 * maintenance tick re-runs it, so an expired deferral needs no timer of its own. Never deferred: a bound stream,
 * one with own outbox records (C-3: its adoptables settle and its frames sequence through what it reads), and one
 * the disk side waits on (wantFresh, until a read leaves it caught up). A read started for the stream ends its
 * deferral.
 */

import { streamClass, type StreamName } from "../../core/types";
import type { SkipDefer } from "../../core/limits";
import type { TimerHandle } from "../../ports/clock";
import type { RelaySession } from "../../ports/relay";
import type { StreamRecord } from "../store/schema";
import type { EngineCtx } from "./context";

const FRESH_MAX = 4096;

interface SkipRecord {
	/** Monotonic time of the first and the last skipped row since the stream's last read started. */
	first: number;
	last: number;
}

export class Subscriptions {
	private readonly bound = new Set<StreamName>();
	/** Unbound docs' streams -> monotonic unbind time, oldest first. */
	private readonly recent = new Map<StreamName, number>();
	private readonly skips = new Map<StreamName, SkipRecord>();
	/** wantFresh streams: never deferred until a read leaves them caught up (skips may still be on their way). */
	private readonly fresh = new Set<StreamName>();
	private timer: TimerHandle | null = null;
	/** The set last sent on the current session (sorted, "\n"-joined); null = nothing sent on it yet. */
	private sent: string | null = null;
	stats = { sends: 0, skippedRows: 0, deferredReads: 0 };

	constructor(private readonly c: EngineCtx, private readonly defer: SkipDefer, private readonly enabled: boolean) {}

	// ---- the set -------------------------------------------------------------------

	/**
	 * A doc was bound (its first view). Sent at once when the stream is not subscribed yet: the open note's rows and
	 * provisionals should be pushed from the first keystroke on, not one debounce later.
	 */
	noteBound(stream: StreamName): void {
		this.bound.add(stream);
		this.recent.delete(stream);
		this.wantFresh([stream]);
		if (this.sent !== null && this.sent.split("\n").includes(stream)) return;
		this.cancel();
		this.flush();
	}

	/** A doc's last view unbound. */
	noteUnbound(stream: StreamName): void {
		if (!this.bound.delete(stream)) return;
		this.recent.delete(stream);
		this.recent.set(stream, this.c.mono());
		while (this.recent.size > this.c.tuning.recentUnboundKeep) this.recent.delete(this.recent.keys().next().value as StreamName);
		this.poke();
	}

	/** Own outbox records or bindings changed: the set may have. Debounced. */
	poke(): void {
		const s = this.c.session;
		if (this.timer !== null || !this.usable(s)) return;
		this.timer = this.c.ports.clock.setTimer(this.c.tuning.subscribeDebounceMs, () => {
			this.timer = null;
			this.flush();
		});
	}

	/** A new session (VAULT_READY): send the set now, before the feed. */
	onSession(): void {
		this.cancel();
		this.sent = null;
		this.flush();
	}

	/** The session closed (or the engine stops). */
	onClosed(): void {
		this.cancel();
		this.sent = null;
	}

	/** Maintenance tick: recently unbound docs past recentUnboundMs leave the set. */
	tick(): void {
		const cutoff = this.c.mono() - this.c.tuning.recentUnboundMs;
		let changed = false;
		for (const [stream, at] of this.recent) {
			if (at > cutoff) break;
			this.recent.delete(stream);
			changed = true;
		}
		if (changed) this.poke();
	}

	/** The set as it would be sent now (sorted), or null when this session takes none. */
	desired(): StreamName[] | null {
		const s = this.c.session;
		if (!this.usable(s)) return null;
		const max = s.limits.maxSubscriptions;
		const out = new Set<StreamName>();
		const add = (stream: StreamName): void => {
			if (out.size < max) out.add(stream);
		};
		for (const stream of this.bound) add(stream);
		for (const stream of this.c.outbox.liveStreams()) if (isDocStream(stream)) add(stream);
		const cutoff = this.c.mono() - this.c.tuning.recentUnboundMs;
		for (const [stream, at] of [...this.recent].reverse()) if (at > cutoff) add(stream);
		return [...out].sort();
	}

	private usable(s: RelaySession | null): s is RelaySession {
		return this.enabled && s !== null && s.subscribe !== undefined && s.limits.maxSubscriptions > 0 && !this.c.stopped;
	}

	private flush(): void {
		const s = this.c.session;
		const set = this.desired();
		if (s === null || set === null) return;
		const key = set.join("\n");
		if (key === this.sent) return;
		this.sent = key;
		this.stats.sends++;
		try {
			s.subscribe!(set);
		} catch (e) {
			this.sent = null;
			this.c.diag("subscribe-failed", { error: String(e) });
		}
	}

	private cancel(): void {
		if (this.timer !== null) this.c.ports.clock.clearTimer(this.timer);
		this.timer = null;
	}

	// ---- deferral ------------------------------------------------------------------

	/** Skipped rows of `stream` were accounted (the stream is stale now). */
	noteSkipped(stream: StreamName, rows: number): void {
		const now = this.c.mono();
		this.stats.skippedRows += rows;
		const r = this.skips.get(stream);
		if (r) r.last = now;
		else this.skips.set(stream, { first: now, last: now });
	}

	/**
	 * Read these streams under the normal rules until they are caught up: skipped rows that arrive meanwhile (the
	 * body frames behind a create the disk side waits for) do not defer them.
	 */
	wantFresh(streams: Iterable<StreamName>): void {
		let any = false;
		for (const s of streams) {
			if (!isDocStream(s)) continue;
			this.fresh.delete(s);
			this.fresh.add(s);
			if (this.skips.delete(s)) any = true;
		}
		// A wanted doc whose body never comes (a create whose frames were lost) is never read: bound the set.
		while (this.fresh.size > FRESH_MAX) this.fresh.delete(this.fresh.values().next().value as StreamName);
		if (any) this.c.sess.scheduleCatchUp();
	}

	/** A read of `stream` starts: it covers every skip so far. */
	readStarted(stream: StreamName): void {
		this.skips.delete(stream);
	}

	/** A read of `stream` ended: once caught up, a wantFresh on it is answered. */
	readEnded(stream: StreamName): void {
		if (this.c.repo.stream(stream)?.stale !== 1) this.fresh.delete(stream);
	}

	/** The stream's read waits (stale through skipped rows only, quiet for less than settleMs, younger than maxDeferMs). */
	deferred(rec: StreamRecord, nowMono: number): boolean {
		const k = this.skips.get(rec.stream);
		if (k === undefined) return false;
		if (!rec.stale) {
			this.skips.delete(rec.stream);
			return false;
		}
		if (this.fresh.has(rec.stream) || this.exempt(rec.stream)) return false;
		return nowMono - k.last < this.defer.settleMs && nowMono - k.first < this.defer.maxDeferMs;
	}

	/** Some skipped stream's read is deferred now (diagnostics, tests). */
	get deferredCount(): number {
		const now = this.c.mono();
		let n = 0;
		for (const stream of this.skips.keys()) {
			const rec = this.c.repo.stream(stream);
			if (rec && this.deferred(rec, now)) n++;
		}
		return n;
	}

	private exempt(stream: StreamName): boolean {
		return (this.c.handles.peek(stream)?.bound ?? 0) > 0 || this.c.outbox.hasLive(stream);
	}
}

function isDocStream(stream: StreamName): boolean {
	const cls = streamClass(stream);
	return cls === "body" || cls === "canvas";
}
