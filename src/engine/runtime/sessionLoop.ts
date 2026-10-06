/**
 * Session lifecycle (DESIGN §d.7 "Reconnect", §i.6): connect -> epoch check ->
 * sender.attach (bodies resend at once) -> feed to the session head -> live
 * queue on -> ns/cfg reads (late receipts) -> ns window open -> held release ->
 * live; then stale streams are read with bounded concurrency.
 *
 * Catch-up reads are batched when the relay has the batch form (limits.readBatchStreams > 1): one request reads
 * the first page of up to readBatchStreams stale streams under one readPageBytes budget, and each served stream
 * then runs readStream (which pages on alone if it has more). On the deployed relay a request costs ~9 edge RTTs
 * whatever it carries, so a fresh device reads its N notes in about N / readBatchStreams requests instead of N.
 * catchUpConcurrency bounds lanes: a single read or a batch (until all of its streams are done).
 *
 * Every session gets a generation; callbacks of an older session are ignored.
 * Reconnect timing is relayPolicy's; this module only owns the timer.
 */

import { RELAY_CLOSE } from "../../core/limits";
import { CFG_STREAM, NS_STREAM, SNAP_STREAM, streamClass, type Seq, type StreamName } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { ReadPage, ReadRequest, RelayConnectResult, RelayEvent, RelaySession } from "../../ports/relay";
import { readStream, staleOrder, type ReadResult } from "../sync/catchUp";
import type { EngineCtx } from "./context";
import { connectFailure, newReconnectState, sessionClosed, type ReconnectDecision } from "./relayPolicy";
import { retryReaderQuarantine } from "./quarantineRelease";

type Closed = Extract<RelayEvent, { t: "closed" }>;

const FEED_NO_PROGRESS_PAGES = 3;

export class SessionLoop {
	private st = newReconnectState();
	private reconnectTimer: TimerHandle | null = null;
	reconnectAtMono: number | null = null;
	private connecting = false;
	private manual = false;
	/** Deliberately closed for the background (DESIGN §i.4): no offline phase, no backoff, until wake(). */
	private parked = false;
	/** The platform reported offline: no automatic reconnect attempts until online (or a session opens). */
	private netDown = false;
	private backpressureFlag = false;
	private unsub: (() => void) | null = null;
	private feeding: Promise<void> | null = null;
	private readonly reads = new Map<StreamName, Promise<void>>();
	private readonly readBackoff = new Map<StreamName, number>();
	/** Catch-up lanes in use: single reads and batches (bounded by catchUpConcurrency). */
	private lanes = 0;
	stats = { sessions: 0, connectFailures: 0, feedPages: 0, reads: 0, readFailures: 0, readBatches: 0 };

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
		if (c.stopped || this.manual || this.parked) {
			if (r.ok) r.session.close(RELAY_CLOSE.normal, this.parked ? "background" : "stopped");
			return;
		}
		if (!r.ok) {
			this.stats.connectFailures++;
			c.diag("connect-failed", { reason: r.reason });
			if (r.reason === "daily-limit") c.dailyLimitPopup(r.retryAfterMs);
			this.decide(connectFailure(r.reason, r.retryAfterMs, this.st, this.random, c.tuning.reconnectBaseMs));
			return;
		}
		await this.onSession(r.session);
	}

	private decide(d: ReconnectDecision): void {
		const c = this.c;
		c.setPhase(d.phase);
		if (d.notice) c.notice(d.notice);
		if (d.retryMs !== null && c.opts.autoReconnect !== false && !this.manual && !c.stopped && !this.parked && !this.netDown) this.scheduleReconnect(d.retryMs);
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
		this.netDown = false;
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
			await this.readInOrder([NS_STREAM, CFG_STREAM, SNAP_STREAM].filter((s) => c.repo.stream(s)?.stale));
			if (gen !== c.gen) return;
			c.sender.openNs();
			await c.afterNsChange();
			await c.afterCfgChange();
			await c.afterSnapChange();
			if (gen !== c.gen) return;
			c.setPhase(c.dailyLimitUntilMono > c.mono() ? "daily-limit" : "live");
			this.st = newReconnectState();
			// Reader-dependent quarantine is retried on every session start (new keys / version, §d.6).
			await retryReaderQuarantine(c).catch((e) => c.diag("quarantine-retry-failed", { error: String(e) }));
			if (gen !== c.gen) return;
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
		if (this.parked && !c.stopped && !this.manual) return;
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
		this.lanes++;
		const p = this.readOne(s, gen, stream, fromSeq, undefined).finally(() => {
			this.reads.delete(stream);
			this.lanes--;
			this.scheduleCatchUp();
		});
		this.reads.set(stream, p);
		return p;
	}

	private async readOne(s: RelaySession, gen: number, stream: StreamName, fromSeq: Seq | undefined, first: (ReadRequest & { page: ReadPage }) | undefined): Promise<void> {
		const c = this.c;
		this.stats.reads++;
		try {
			const res = await readStream(c.deps, s, stream, { headSeq: s.headSeq, fromSeq, first, stillValid: () => gen === c.gen && c.session === s });
			await this.postRead(stream, res);
		} catch (e) {
			this.stats.readFailures++;
			this.readBackoff.set(stream, c.mono() + c.tuning.readBackoffMs);
			c.diag("read-failed", { cls: streamClass(stream), error: String(e) });
		}
	}

	private batching(s: RelaySession): number {
		return Math.max(1, Math.min(s.limits.readBatchStreams, this.c.tuning.readBatchStreams));
	}

	/**
	 * One batched request for `streams` (none being read), one lane until every served stream is read. inOrder:
	 * stream i is applied after stream i - 1 (ns before cfg). Resolves with the streams the batch did not serve
	 * (still stale; a later batch or read takes them). A failed request backs every stream off, like a failed read.
	 */
	private runBatch(s: RelaySession, streams: readonly StreamName[], inOrder: boolean): Promise<StreamName[]> {
		const c = this.c;
		const gen = c.gen;
		this.lanes++;
		this.stats.readBatches++;
		const reqs: ReadRequest[] = streams.map((stream) => {
			const afterSeq = c.repo.stream(stream)?.appliedSeq ?? 0;
			return { stream, afterSeq, preferCheckpoint: afterSeq === 0 };
		});
		const batch = s.readBatch(reqs).catch((e: unknown): null => {
			this.stats.readFailures++;
			c.diag("read-batch-failed", { streams: reqs.length, error: String(e) });
			const until = c.mono() + c.tuning.readBackoffMs;
			for (const q of reqs) this.readBackoff.set(q.stream, until);
			return null;
		});
		const unserved: StreamName[] = [];
		let prev: Promise<void> = Promise.resolve();
		// Members that must read on (more pages, or the stream moved since the request) go one at a time: the
		// batch is one lane, so it has at most one request on the wire.
		let net: Promise<void> = Promise.resolve();
		const members = reqs.map((q, i) => {
			const after = prev;
			const p = (async () => {
				const pages = await batch;
				if (inOrder) await after;
				const page = pages?.[i];
				if (!page) {
					if (pages) unserved.push(q.stream);
					return;
				}
				const first = { ...q, page };
				if (!page.more && (c.repo.stream(q.stream)?.appliedSeq ?? 0) === q.afterSeq) return this.readOne(s, gen, q.stream, undefined, first);
				const before = net;
				let release = () => {};
				net = new Promise<void>((r) => (release = r));
				try {
					await before;
					await this.readOne(s, gen, q.stream, undefined, first);
				} finally {
					release();
				}
			})().finally(() => {
				this.reads.delete(q.stream);
				this.scheduleCatchUp();
			});
			this.reads.set(q.stream, p);
			prev = p;
			return p;
		});
		return Promise.allSettled(members).then(() => {
			this.lanes--;
			this.scheduleCatchUp();
			return unserved;
		});
	}

	/** Reads `streams` one after another (session start: ns, cfg); batched into one request when possible. */
	private async readInOrder(streams: readonly StreamName[]): Promise<void> {
		const s = this.c.session;
		if (!s) return;
		let rest: readonly StreamName[] = streams;
		const fresh = streams.filter((st) => !this.reads.has(st));
		if (fresh.length > 1 && this.batching(s) > 1) {
			const unserved = await this.runBatch(s, fresh, true);
			rest = streams.filter((st) => this.reads.has(st) || unserved.includes(st));
		}
		for (const st of rest) await this.runRead(st);
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
			// A completed read makes the stream caught up (§d.7), which the disk side waits on, even when
			// every row is own (the author re-reading after its DB was lost); own plain rows change content too.
			if (res.checkpointState || res.t === "done" || res.apply.length > 0 || res.tailPut.some((r) => r.deviceId !== c.self)) c.noteBodyChange([stream]);
		} else if (cls === "ns") await c.afterNsChange(res.replacedFold);
		else if (cls === "cfg") await c.afterCfgChange(res.replacedFold);
		else if (cls === "snap") await c.afterSnapChange(res.replacedFold);
		else if (cls === "blobchunk" && res.tailPut.length > 0) await c.docs.retryRefs();
		if (cls !== "ns" && res.removed.length > 0) await c.afterNsChange();
		if (res.rows > 0 || res.t === "done") c.lastSyncedAtMs = c.now();
		c.scheduleStatus();
	}

	/** Start reads for stale streams, bound docs first: up to catchUpConcurrency lanes, batched when the relay can. */
	scheduleCatchUp(): void {
		const c = this.c;
		const s = c.session;
		if (!s || !c.live.enabled || c.stopped || c.background) return;
		let slots = c.budgets.catchUpConcurrency - this.lanes;
		if (slots <= 0) return;
		const now = c.mono();
		const order = staleOrder(c.repo.streams(), (r) => c.repo.priorityFn(r), (r) =>
			this.reads.has(r.stream) || r.cls === "other" || (r.frozen === 1 && r.frozenReason === "checkpoint-disputed") || (this.readBackoff.get(r.stream) ?? 0) > now);
		const per = this.batching(s);
		for (let i = 0; slots > 0 && i < order.length; slots--) {
			const group = order.slice(i, i + per).map((r) => r.stream);
			i += group.length;
			if (group.length === 1) void this.runRead(group[0]!);
			else void this.runBatch(s, group, false);
		}
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
		this.parked = false;
		this.clearReconnect();
		this.st = newReconnectState();
		await this.connectOnce();
	}

	/** Background close (1000): the phase stays, nothing backs off, nothing reconnects until wake(). */
	park(): void {
		const c = this.c;
		this.parked = true;
		this.clearReconnect();
		const s = c.session;
		if (!s) return;
		const gen = c.gen;
		try {
			s.close(RELAY_CLOSE.normal, "background");
		} catch {
			/* already closed */
		}
		this.handleClosed(gen, { t: "closed", code: RELAY_CLOSE.normal, errorCode: null, wasClean: true });
	}

	/**
	 * visible / resume: connect at once on a fresh backoff unless the user paused. It tries once even after
	 * offline, so a missed online event cannot strand the device; while offline a failure arms no backoff.
	 */
	wake(): Promise<void> {
		this.parked = false;
		return this.connectNow(true);
	}

	/** offline: stop reconnect attempts (an open socket stays until it fails); online: connect at once. */
	setNetwork(online: boolean): Promise<void> {
		this.netDown = !online;
		if (online) return this.connectNow();
		this.clearReconnect();
		return Promise.resolve();
	}

	private async connectNow(evenOffline = false): Promise<void> {
		const c = this.c;
		if (this.manual || this.parked || (this.netDown && !evenOffline) || c.stopped || c.opts.autoReconnect === false) return;
		this.clearReconnect();
		this.st = newReconnectState();
		await this.connectOnce();
	}

	async idleReads(): Promise<void> {
		while (this.reads.size > 0 || this.feeding) await Promise.all([...this.reads.values(), this.feeding]);
	}
}
