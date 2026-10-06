/**
 * Session lifecycle (DESIGN §d.7 "Reconnect", §i.6): connect -> epoch check ->
 * sender.attach (bodies resend at once) -> feed to the session head -> live
 * queue on -> ns/cfg reads (late receipts) -> ns window open -> held release ->
 * live; then stale streams are read with bounded concurrency.
 *
 * Every session gets a generation; callbacks of an older session are ignored.
 * Reconnect timing is relayPolicy's; this module only owns the timer.
 */

import { RELAY_CLOSE } from "../../core/limits";
import { CFG_STREAM, NS_STREAM, streamClass, type Seq, type StreamName } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { RelayConnectResult, RelayEvent, RelaySession } from "../../ports/relay";
import { readStream, staleOrder, type ReadResult } from "../sync/catchUp";
import type { EngineCtx } from "./context";
import { connectFailure, newReconnectState, sessionClosed, type ReconnectDecision } from "./relayPolicy";

type Closed = Extract<RelayEvent, { t: "closed" }>;

const FEED_NO_PROGRESS_PAGES = 3;

export class SessionLoop {
	private st = newReconnectState();
	private reconnectTimer: TimerHandle | null = null;
	reconnectAtMono: number | null = null;
	private connecting = false;
	private manual = false;
	private backpressureFlag = false;
	private unsub: (() => void) | null = null;
	private feeding: Promise<void> | null = null;
	private readonly reads = new Map<StreamName, Promise<void>>();
	private readonly readBackoff = new Map<StreamName, number>();
	stats = { sessions: 0, connectFailures: 0, feedPages: 0, reads: 0, readFailures: 0 };

	constructor(private readonly c: EngineCtx) {}

	get readsInFlight(): number {
		return this.reads.size;
	}
	get isFeeding(): boolean {
		return this.feeding !== null;
	}
	isReading(stream: StreamName): boolean {
		return this.reads.has(stream);
	}

	startLoop(): void {
		void this.connectOnce();
	}

	private random = () => this.c.ports.random.float();

	async connectOnce(): Promise<void> {
		const c = this.c;
		if (this.connecting || c.session || c.stopped) return;
		this.connecting = true;
		let r: RelayConnectResult;
		try {
			r = await c.ports.relay.connect({ vaultId: c.opts.vaultId, deviceId: c.self });
		} catch (e) {
			c.diag("connect-threw", { error: String(e) });
			r = { ok: false, reason: "unavailable", retryAfterMs: null };
		} finally {
			this.connecting = false;
		}
		if (c.stopped || this.manual) {
			if (r.ok) r.session.close(RELAY_CLOSE.normal, "stopped");
			return;
		}
		if (!r.ok) {
			this.stats.connectFailures++;
			c.diag("connect-failed", { reason: r.reason });
			this.decide(connectFailure(r.reason, r.retryAfterMs, this.st, this.random, c.tuning.reconnectBaseMs));
			return;
		}
		await this.onSession(r.session);
	}

	private decide(d: ReconnectDecision): void {
		const c = this.c;
		c.setPhase(d.phase);
		if (d.notice) c.notice(d.notice);
		if (d.retryMs !== null && c.opts.autoReconnect !== false && !this.manual && !c.stopped) this.scheduleReconnect(d.retryMs);
	}

	private scheduleReconnect(ms: number): void {
		this.clearReconnect();
		this.reconnectAtMono = this.c.mono() + ms;
		this.reconnectTimer = this.c.ports.clock.setTimer(ms, () => {
			this.reconnectTimer = null;
			this.reconnectAtMono = null;
			void this.connectOnce();
		});
	}
	clearReconnect(): void {
		if (this.reconnectTimer !== null) this.c.ports.clock.clearTimer(this.reconnectTimer);
		this.reconnectTimer = null;
		this.reconnectAtMono = null;
	}

	async onSession(session: RelaySession): Promise<void> {
		const c = this.c;
		if (session.vaultEpoch !== c.repo.identity.vaultEpoch) {
			session.close(RELAY_CLOSE.normal, "epoch-mismatch");
			c.diag("epoch-mismatch", { db: c.repo.identity.vaultEpoch, relay: session.vaultEpoch });
			c.setPhase("epoch-migrating");
			c.notice("epoch-changed");
			return;
		}
		const gen = ++c.gen;
		c.session = session;
		this.stats.sessions++;
		this.backpressureFlag = false;
		this.unsub = session.onEvent((ev) => this.onEvent(gen, ev));
		c.gateCtx.maxCheckpointStateBytes = Math.max(c.tuning.maxCheckpointStateBytes, session.limits.maxCheckpointBytes * 8);
		const cur = c.repo.cursor;
		if (session.headSeq > cur.headSeqSeen) cur.headSeqSeen = session.headSeq;
		c.sender.attach(session);
		c.setPhase("catching-up");
		try {
			await this.feedTo(gen, session.headSeq);
			if (gen !== c.gen) return;
			c.live.enable();
			for (const s of [NS_STREAM, CFG_STREAM]) if (c.repo.stream(s)?.stale) await this.runRead(s);
			if (gen !== c.gen) return;
			c.sender.openNs();
			await c.afterNsChange();
			await c.afterCfgChange();
			if (gen !== c.gen) return;
			c.setPhase(c.dailyLimitUntilMono > c.mono() ? "daily-limit" : "live");
			this.st = newReconnectState();
			this.scheduleCatchUp();
		} catch (e) {
			c.diag("session-start-failed", { error: String(e) });
			if (gen !== c.gen) return;
			try {
				session.close(RELAY_CLOSE.normal, "engine-error");
			} catch {
				/* already closed */
			}
			this.handleClosed(gen, { t: "closed", code: RELAY_CLOSE.abnormal, errorCode: null, wasClean: false });
		}
	}

	/** Feed pages from V until the relay says nothing more through `head` (DESIGN §d.7 feed). */
	feedTo(gen: number, head: Seq): Promise<void> {
		if (this.feeding) return this.feeding;
		const p = this.feedLoop(gen, head).finally(() => {
			this.feeding = null;
		});
		this.feeding = p;
		return p;
	}

	private async feedLoop(gen: number, head: Seq): Promise<void> {
		const c = this.c;
		let noProgress = 0;
		for (;;) {
			const s = c.session;
			if (!s || gen !== c.gen || c.stopped) return;
			const v = c.repo.cursor.vaultSeq;
			const page = await s.feed(v);
			if (gen !== c.gen) return;
			const res = await c.repo.tFeedPage(page.entries, page.throughSeq, page.headSeq, c.now());
			this.stats.feedPages++;
			if (page.headSeq > c.repo.cursor.headSeqSeen) c.repo.cursor.headSeqSeen = page.headSeq;
			noProgress = res.vaultSeq > v ? 0 : noProgress + 1;
			if (!page.more && page.throughSeq >= head) return;
			if (noProgress >= FEED_NO_PROGRESS_PAGES) {
				c.diag("feed-no-progress", { v: res.vaultSeq, head });
				return;
			}
		}
	}

	private onEvent(gen: number, ev: RelayEvent): void {
		const c = this.c;
		if (gen !== c.gen) return;
		const cur = c.repo.cursor;
		switch (ev.t) {
			case "committed":
				if (ev.frame.seq > cur.headSeqSeen) cur.headSeqSeen = ev.frame.seq;
				c.live.push(ev);
				return;
			case "receipt":
				if (ev.seq > cur.headSeqSeen) cur.headSeqSeen = ev.seq;
				c.live.push(ev);
				return;
			case "provisional":
			case "provisionalDropped":
				c.live.push(ev);
				return;
			case "refused":
				c.diag("frame-refused", { reason: ev.reason });
				c.sender.onRefused(ev.clientFrameId, ev.reason, ev.retryAfterMs);
				return;
			case "resendUnreceipted":
				if (ev.headSeq > cur.headSeqSeen) cur.headSeqSeen = ev.headSeq;
				c.diag("stream-resend", { headSeq: ev.headSeq });
				c.sender.onResend();
				return;
			case "backpressure":
				this.backpressureFlag = true;
				c.sender.onBackpressure();
				return;
			case "head":
				if (ev.headSeq > cur.headSeqSeen) cur.headSeqSeen = ev.headSeq;
				return;
			case "closed":
				this.handleClosed(gen, ev);
				return;
		}
	}

	handleClosed(gen: number, ev: Closed): void {
		const c = this.c;
		if (gen !== c.gen || c.session === null) return;
		c.gen++;
		this.unsub?.();
		this.unsub = null;
		c.session = null;
		c.sender.onClosed(ev.code);
		c.live.disable();
		c.lastCloseCode = ev.code;
		c.diag("session-closed", { code: ev.code, errorCode: ev.errorCode, wasClean: ev.wasClean });
		if (c.stopped || this.manual) {
			c.setPhase("offline");
			return;
		}
		const bp = this.backpressureFlag;
		this.backpressureFlag = false;
		this.decide(sessionClosed(ev.code, ev.errorCode, bp, this.st, this.random, c.tuning.reconnectBaseMs));
	}

	/** One read of one stream (deduplicated). Causal-hole re-reads pass fromSeq. */
	runRead(stream: StreamName, fromSeq?: Seq): Promise<void> {
		const existing = this.reads.get(stream);
		if (existing) return existing;
		const c = this.c;
		const s = c.session;
		if (!s) return Promise.resolve();
		const gen = c.gen;
		this.stats.reads++;
		const p = (async () => {
			try {
				const res = await readStream(c.deps, s, stream, { headSeq: s.headSeq, fromSeq, stillValid: () => gen === c.gen && c.session === s });
				await this.postRead(stream, res);
			} catch (e) {
				this.stats.readFailures++;
				this.readBackoff.set(stream, c.mono() + c.tuning.readBackoffMs);
				c.diag("read-failed", { cls: streamClass(stream), error: String(e) });
			}
		})().finally(() => {
			this.reads.delete(stream);
			this.scheduleCatchUp();
		});
		this.reads.set(stream, p);
		return p;
	}

	private async postRead(stream: StreamName, res: ReadResult): Promise<void> {
		const c = this.c;
		c.applyOutboxResult(res);
		if (res.t === "retry" || (res.t === "aborted" && res.error)) this.readBackoff.set(stream, c.mono() + c.tuning.readBackoffMs);
		const cls = streamClass(stream);
		if (cls === "body" || cls === "canvas") {
			let h = c.handles.peek(stream);
			if (!h) {
				const loading = c.handles.loadingOf(stream);
				if (loading) h = await loading.catch(() => undefined);
			}
			if (h) {
				if (res.checkpointState || res.apply.length > 0) await c.docs.applyToHandle(h, res.apply, res.checkpointState);
				c.docs.checkDoc(h);
			}
		} else if (cls === "ns") await c.afterNsChange(res.replacedFold);
		else if (cls === "cfg") await c.afterCfgChange(res.replacedFold);
		else if (cls === "blobchunk" && res.tailPut.length > 0) await c.docs.retryRefs();
		if (cls !== "ns" && res.removed.length > 0) await c.afterNsChange();
		if (res.rows > 0 || res.t === "done") c.lastSyncedAtMs = c.now();
		c.scheduleStatus();
	}

	/** Start reads for stale streams, bound docs first, up to catchUpConcurrency. */
	scheduleCatchUp(): void {
		const c = this.c;
		if (!c.session || !c.live.enabled || c.stopped) return;
		const slots = c.budgets.catchUpConcurrency - this.reads.size;
		if (slots <= 0) return;
		const now = c.mono();
		const order = staleOrder(c.repo.streams(), (r) => c.repo.priorityFn(r), (r) =>
			this.reads.has(r.stream) || r.cls === "other" || (r.frozen === 1 && r.frozenReason === "checkpoint-disputed") || (this.readBackoff.get(r.stream) ?? 0) > now);
		for (const r of order.slice(0, slots)) void this.runRead(r.stream);
	}

	/** Manual disconnect: no automatic reconnect until reconnect(). */
	disconnect(): void {
		const c = this.c;
		this.manual = true;
		this.clearReconnect();
		const s = c.session;
		if (!s) {
			c.setPhase("offline");
			return;
		}
		const gen = c.gen;
		try {
			s.close(RELAY_CLOSE.normal, "client");
		} catch {
			/* already closed */
		}
		this.handleClosed(gen, { t: "closed", code: RELAY_CLOSE.normal, errorCode: null, wasClean: true });
	}

	async reconnect(): Promise<void> {
		this.manual = false;
		this.clearReconnect();
		this.st = newReconnectState();
		await this.connectOnce();
	}

	async idleReads(): Promise<void> {
		while (this.reads.size > 0 || this.feeding) await Promise.all([...this.reads.values(), this.feeding]);
	}
}
