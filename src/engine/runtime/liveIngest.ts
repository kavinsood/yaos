/**
 * Live ingest (DESIGN §d.6, §d.7 "live"): relay events in arrival order ->
 * gate -> one tLive per batch -> outbox cache / sender / replicas / ns fold.
 *
 *  - committed / receipt events are batched (<= liveBatchRows); provisional
 *    and provisionalDropped are handled one at a time in queue order, so an
 *    adoptable always exists before the committed row that settles it;
 *  - own committed rows with an outbox record are receipts (another socket of
 *    this device, or an R7 re-notice);
 *  - overflow (> liveQueueMaxBytes / liveQueueMaxRows): payloads of streams
 *    that are not resident body docs (and not ns/cfg) are dropped, the rows
 *    become T_stale items and the stream is read later;
 *  - a failed tLive drops the batch: its seqs stay unaccounted and the gap
 *    feed / reads recover them.
 *
 * The queue survives a session close (its events are committed facts).
 */

import { NS_STREAM, streamClass, type ClientFrameId, type DeviceId, type Seq, type StreamName } from "../../core/types";
import type { RelayEvent } from "../../ports/relay";
import type { LiveItem } from "../store/repo";
import { gateRow } from "../sync/ingestRow";
import type { EngineCtx } from "./context";

type QueuedEvent = Extract<RelayEvent, { t: "receipt" | "committed" | "provisional" | "provisionalDropped" }>;

function eventBytes(ev: QueuedEvent): number {
	if (ev.t === "committed") return ev.frame.payload?.length ?? 0;
	if (ev.t === "provisional") return ev.payload.length;
	return 0;
}

export class LiveIngest {
	private q: QueuedEvent[] = [];
	private qBytes = 0;
	private draining = false;
	enabled = false;
	stats = { batches: 0, rows: 0, receipts: 0, stale: 0, overflows: 0, failedBatches: 0 };

	constructor(private readonly c: EngineCtx) {}

	get idle(): boolean {
		return this.q.length === 0 && !this.draining;
	}
	get length(): number {
		return this.q.length;
	}

	push(ev: QueuedEvent): void {
		this.q.push(ev);
		this.qBytes += eventBytes(ev);
		if (this.qBytes > this.c.tuning.liveQueueMaxBytes || this.q.length > this.c.tuning.liveQueueMaxRows) this.overflow();
		this.kick();
	}

	enable(): void {
		this.enabled = true;
		this.kick();
	}
	disable(): void {
		this.enabled = false;
	}

	/** A committed event for (deviceId, cfid) is already queued: adopting its provisional is pointless. */
	hasQueuedCommit(deviceId: DeviceId, cfid: ClientFrameId): boolean {
		return this.q.some((e) => e.t === "committed" && e.frame.deviceId === deviceId && e.frame.clientFrameId === cfid);
	}

	private overflow(): void {
		this.stats.overflows++;
		const keep = (stream: StreamName) => {
			const cls = streamClass(stream);
			return cls === "ns" || cls === "cfg" || ((cls === "body" || cls === "canvas") && this.c.handles.isResident(stream));
		};
		const next: QueuedEvent[] = [];
		let bytes = 0;
		for (const e of this.q) {
			if (e.t === "committed" && e.frame.payload && !keep(e.frame.stream)) {
				next.push({ t: "committed", frame: { ...e.frame, payload: null } });
				continue;
			}
			if (e.t === "provisional" && !this.c.handles.isResident(e.stream)) continue;
			next.push(e);
			bytes += eventBytes(e);
		}
		this.q = next;
		this.qBytes = bytes;
		this.c.diag("live-overflow", { rows: next.length, bytes });
	}

	private kick(): void {
		if (!this.enabled || this.draining || this.q.length === 0 || this.c.stopped) return;
		this.draining = true;
		void this.drain()
			.catch((e) => this.c.diag("live-drain-failed", { error: String(e) }))
			.finally(() => {
				this.draining = false;
				if (this.q.length > 0) this.kick();
			});
	}

	private shift(): QueuedEvent {
		const e = this.q.shift()!;
		this.qBytes -= eventBytes(e);
		return e;
	}

	private async drain(): Promise<void> {
		while (this.q.length > 0 && this.enabled && !this.c.stopped) {
			const first = this.q[0]!;
			if (first.t === "provisional") {
				this.shift();
				if (!this.hasQueuedCommit(first.deviceId, first.clientFrameId)) await this.c.docs.onProvisional(first);
				continue;
			}
			if (first.t === "provisionalDropped") {
				this.shift();
				await this.c.docs.onProvisionalDropped(first);
				continue;
			}
			const batch: QueuedEvent[] = [];
			while (this.q.length > 0 && batch.length < this.c.tuning.liveBatchRows) {
				const t = this.q[0]!.t;
				if (t !== "committed" && t !== "receipt") break;
				batch.push(this.shift());
			}
			await this.ingest(batch);
		}
	}

	private async ingest(batch: readonly QueuedEvent[]): Promise<void> {
		const c = this.c;
		const items: LiveItem[] = [];
		const skipApply = new Set<Seq>();
		let stale = 0;
		let receipts = 0;
		const now = c.now();
		for (const ev of batch) {
			if (ev.t === "receipt") {
				items.push({ t: "receipt", stream: ev.stream, clientFrameId: ev.clientFrameId, seq: ev.seq });
				skipApply.add(ev.seq);
				receipts++;
				continue;
			}
			if (ev.t !== "committed") continue;
			const f = ev.frame;
			if (f.deviceId === c.self && c.outbox.get(f.clientFrameId)?.stream === f.stream) {
				items.push({ t: "receipt", stream: f.stream, clientFrameId: f.clientFrameId, seq: f.seq });
				skipApply.add(f.seq);
				receipts++;
				continue;
			}
			if (f.payload === null) {
				items.push({ t: "stale", stream: f.stream, seq: f.seq });
				stale++;
				continue;
			}
			const g = await gateRow(c.gateCtx, c.ports.hash, { stream: f.stream, seq: f.seq, deviceId: f.deviceId, clientFrameId: f.clientFrameId, payload: f.payload }, now);
			const settle = f.deviceId !== c.self ? c.adoptFor(f.deviceId, f.clientFrameId) : null;
			if (settle) skipApply.add(f.seq);
			if (g.t === "row") items.push({ t: "row", row: g.row, settleAdoptable: settle });
			else if (g.t === "quarantine") items.push({ t: "quarantine", rec: g.rec, settleAdoptable: settle });
			else items.push({ t: "account", seq: f.seq });
		}
		let res;
		try {
			res = await c.repo.tLive(items, c.now(), c.day());
		} catch (e) {
			this.stats.failedBatches++;
			c.diag("live-batch-failed", { rows: items.length, error: String(e) });
			return;
		}
		this.stats.batches++;
		this.stats.rows += items.length;
		this.stats.receipts += receipts;
		this.stats.stale += stale;
		if (receipts > 0) c.countReceipts(receipts);
		c.lastSyncedAtMs = c.now();
		c.applyOutboxResult(res);
		await c.docs.applyRows(res.tailPut.filter((r) => !skipApply.has(r.seq)));
		if (res.removed.length > 0 || res.tailPut.some((r) => r.stream === NS_STREAM)) await c.afterNsChange();
		if (stale > 0) c.sess.scheduleCatchUp();
		c.scheduleStatus();
	}
}
