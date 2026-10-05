/**
 * Doc-side runtime (DESIGN §d.1-§d.6): doc listeners and the open-frame
 * timer, frame close -> T_edit, remote row apply (refs resolved), causal-hole
 * / oversize checks with freeze, provisional apply + T_adopt and the
 * adoptable -> pending transition.
 */

import * as Y from "yjs";
import { MAX_DOC_TEXT_CHARS } from "../../core/limits";
import { streamClass, type ClientFrameId, type StreamName } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { RelayEvent } from "../../ports/relay";
import { buildAdoptFrame, buildBodyFrames, FrameTooLargeError } from "../body/frames";
import { docTextLength, hasCausalHole, type Handle, type HandleHooks } from "../body/handles";
import { resolveRefRow } from "../body/refs";
import { ORIGIN } from "../body/yjsCounters";
import { gate } from "../ingest/gate";
import type { TailRecord } from "../store/schema";
import { adoptKey, type EngineCtx } from "./context";
import type { DocUpdateOrigin } from "./options";

type Provisional = Extract<RelayEvent, { t: "provisional" }>;
type Dropped = Extract<RelayEvent, { t: "provisionalDropped" }>;

export class DocRuntime {
	private chainP: Promise<void> = Promise.resolve();
	private chained = 0;
	private readonly causal = new Map<StreamName, { attempts: number; timer: TimerHandle | null }>();
	stats = { framesClosed: 0, adopted: 0, adoptToPending: 0, causalReads: 0 };

	constructor(private readonly c: EngineCtx) {}

	hooks(): HandleHooks {
		return {
			resolveRef: (row) => resolveRefRow(this.c.deps, row),
			onCreate: (h) => this.attach(h),
			onEvict: (h) => this.detach(h),
			monotonic: () => this.c.mono(),
		};
	}

	/** Serialize edit-side transactions so T_edit order is local order. */
	chain<T>(fn: () => Promise<T>): Promise<T> {
		this.chained++;
		const run = () => fn().finally(() => void this.chained--);
		const p = this.chainP.then(run, run);
		this.chainP = p.then(() => undefined, () => undefined);
		return p;
	}
	get editIdle(): boolean {
		return this.chained === 0;
	}
	causalPending(stream: StreamName): boolean {
		return this.causal.has(stream);
	}

	/** Engine stop: drop every timer this module owns. */
	dispose(): void {
		for (const s of [...this.causal.keys()]) this.clearCausal(s);
		for (const h of this.c.handles.all()) {
			if (h.timer !== null) this.c.ports.clock.clearTimer(h.timer);
			h.timer = null;
		}
	}

	private attach(h: Handle): void {
		h.doc.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin === ORIGIN.MERGE) {
				if (h.builder.push(u, this.c.mono())) void this.closeFrame(h);
				else this.armBuilder(h);
				this.forward(h, u, "local");
			} else if (origin === ORIGIN.REMOTE) this.forward(h, u, "remote");
			else if (origin === ORIGIN.PROVISIONAL) this.forward(h, u, "provisional");
		});
	}
	private detach(h: Handle): void {
		if (h.timer !== null) this.c.ports.clock.clearTimer(h.timer);
		h.timer = null;
		this.clearCausal(h.stream);
	}
	private forward(h: Handle, u: Uint8Array, origin: DocUpdateOrigin): void {
		if (h.bound > 0) this.c.opts.onDocUpdate?.(h.docId, u, origin);
	}

	/** (Re)arm the open-frame close timer from the builder's due time. */
	armBuilder(h: Handle): void {
		const due = h.builder.dueAt(this.c.frameStretch());
		if (h.timer !== null) this.c.ports.clock.clearTimer(h.timer);
		h.timer = null;
		if (due === null) return;
		h.timer = this.c.ports.clock.setTimer(Math.max(0, due - this.c.mono()), () => {
			h.timer = null;
			void this.closeFrame(h);
		});
	}

	/** Close the open frame: take it now (order), seal + T_edit on the chain. */
	closeFrame(h: Handle): Promise<void> {
		if (h.timer !== null) this.c.ports.clock.clearTimer(h.timer);
		h.timer = null;
		const taken = h.builder.take();
		if (!taken) return this.chain(async () => undefined);
		h.pins++;
		const c = this.c;
		return this.chain(async () => {
			try {
				const dependsOn = c.outbox.newestAdoptable(h.stream)?.clientFrameId ?? c.outbox.heldDependency(h.stream);
				const frames = await buildBodyFrames(c.deps, { stream: h.stream, content: taken.content, flags: taken.flags, authorNsSeq: c.ns.coversSeq, dependsOn, nowMs: c.now() });
				c.addOutbox(await c.repo.tEdit(frames, c.now()));
				c.ckpt.lastActivity.set(h.stream, c.mono());
				this.stats.framesClosed++;
			} catch (e) {
				if (e instanceof FrameTooLargeError) await c.freeze(h.stream, "oversize-local");
				else c.diag("frame-close-failed", { error: String(e) });
			} finally {
				c.handles.unpin(h);
			}
		});
	}

	/** Committed body / x: rows (receipts and settled adoptables excluded) -> resident replicas. */
	async applyRows(rows: readonly TailRecord[]): Promise<void> {
		const byStream = new Map<StreamName, TailRecord[]>();
		let chunks = false;
		for (const row of rows) {
			const cls = streamClass(row.stream);
			if (cls === "blobchunk") chunks = true;
			if (cls !== "body" && cls !== "canvas") continue;
			let l = byStream.get(row.stream);
			if (!l) byStream.set(row.stream, (l = []));
			l.push(row);
		}
		for (const [stream, list] of byStream) {
			this.c.ckpt.lastActivity.set(stream, this.c.mono());
			let h = this.c.handles.peek(stream);
			if (!h) {
				const loading = this.c.handles.loadingOf(stream);
				if (loading) h = await loading.catch(() => undefined);
			}
			if (!h) continue;
			await this.applyToHandle(h, list);
			this.checkDoc(h);
		}
		if (chunks) await this.retryRefs();
	}

	/** Apply rows to one replica in one REMOTE transaction; unresolved refs are kept for retry. */
	async applyToHandle(h: Handle, rows: readonly TailRecord[], extra: Uint8Array | null = null): Promise<void> {
		const updates: Uint8Array[] = extra && extra.length > 0 ? [extra] : [];
		for (const row of rows) {
			if (row.kind === "bodyUpdate" || row.kind === "canvasUpdate") {
				if (row.content.length > 0) updates.push(row.content);
			} else if (row.kind === "bodyUpdateRef") {
				const u = await resolveRefRow(this.c.deps, row);
				if (u) updates.push(u);
				else if (!h.unresolvedRows.some((r) => r.seq === row.seq)) {
					h.unresolvedRefs++;
					h.unresolvedRows.push(row);
				}
			}
		}
		if (updates.length === 0) return;
		let bytes = 0;
		h.doc.transact(() => {
			for (const u of updates) {
				Y.applyUpdate(h.doc, u, ORIGIN.REMOTE);
				bytes += u.length;
			}
		}, ORIGIN.REMOTE);
		this.c.handles.grow(h, bytes);
	}

	/** New x: rows (or blob store answers): retry every unresolved ref row. */
	async retryRefs(): Promise<void> {
		for (const h of [...this.c.handles.all()]) {
			if (h.unresolvedRows.length === 0) continue;
			const rows = h.unresolvedRows.splice(0);
			h.unresolvedRefs = 0;
			await this.applyToHandle(h, rows);
			this.checkDoc(h);
		}
	}

	/** Stage 3 (DESIGN §d.6): oversize -> freeze; causal hole on a caught-up stream -> re-read timer. */
	checkDoc(h: Handle): void {
		const rec = this.c.repo.stream(h.stream);
		if (!rec || rec.frozen) return;
		if (docTextLength(h) > MAX_DOC_TEXT_CHARS) {
			void this.c.freeze(h.stream, "oversize-remote");
			return;
		}
		if (hasCausalHole(h.doc)) {
			if (!rec.stale) this.armCausal(h.stream);
		} else this.clearCausal(h.stream);
	}

	private armCausal(stream: StreamName): void {
		if (this.causal.has(stream)) return;
		const st = { attempts: 0, timer: null as TimerHandle | null };
		this.causal.set(stream, st);
		st.timer = this.c.ports.clock.setTimer(this.c.tuning.causalRetryMs, () => void this.causalRetry(stream));
		this.c.diag("causal-hole", { cls: streamClass(stream) });
	}
	clearCausal(stream: StreamName): void {
		const st = this.causal.get(stream);
		if (!st) return;
		if (st.timer !== null) this.c.ports.clock.clearTimer(st.timer);
		this.causal.delete(stream);
	}
	private async causalRetry(stream: StreamName): Promise<void> {
		const st = this.causal.get(stream);
		if (!st) return;
		st.timer = null;
		const h = this.c.handles.peek(stream);
		const rec = this.c.repo.stream(stream);
		if (!h || !rec || rec.frozen || !hasCausalHole(h.doc)) {
			this.clearCausal(stream);
			return;
		}
		if (st.attempts >= this.c.tuning.causalRetries) {
			this.clearCausal(stream);
			await this.c.freeze(stream, "causal-hole");
			return;
		}
		st.attempts++;
		this.stats.causalReads++;
		await this.c.sess.runRead(stream, rec.snapshotCoversSeq);
		if (this.causal.get(stream) === st) st.timer = this.c.ports.clock.setTimer(this.c.tuning.causalRetryMs, () => void this.causalRetry(stream));
	}

	/** Another device's provisional on a bound doc: apply, then T_adopt (DESIGN §d.5). */
	async onProvisional(ev: Provisional): Promise<void> {
		const c = this.c;
		if (c.opts.provisionalBroadcast === false || ev.deviceId === c.self) return;
		const h = c.handles.peek(ev.stream);
		if (!h || h.bound === 0 || c.repo.stream(ev.stream)?.frozen) return;
		const key = adoptKey(ev.deviceId, ev.clientFrameId);
		if (c.adoptMap.has(key)) return;
		const g = await gate(c.gateCtx, { t: "provisional", stream: ev.stream, deviceId: ev.deviceId, clientFrameId: ev.clientFrameId, payload: ev.payload });
		if (!g.ok || g.t !== "body") return; // refs / failures: wait for the committed row
		h.pins++;
		try {
			await this.chain(async () => {
				if (c.adoptMap.has(key)) return;
				Y.applyUpdate(h.doc, g.update, ORIGIN.PROVISIONAL);
				c.handles.grow(h, g.update.length);
				const now = c.now();
				const f = await buildAdoptFrame(c.deps, ev.stream, g.inner.kind, g.inner.authorNsSeq, g.inner.flags, g.update,
					{ deviceId: ev.deviceId, clientFrameId: ev.clientFrameId, receivedAtMs: now }, now);
				c.addOutbox(await c.repo.tEdit([f], now, false));
				this.stats.adopted++;
			});
		} finally {
			c.handles.unpin(h);
		}
		this.checkDoc(h);
	}

	onProvisionalDropped(ev: Dropped): Promise<void> {
		const own = this.c.adoptMap.get(adoptKey(ev.deviceId, ev.clientFrameId));
		return own ? this.adoptToPending(own, "dropped") : Promise.resolve();
	}

	/** Dropped / 60 s without commit: the adopted copy is sent as our own frame. */
	async adoptToPending(cfid: ClientFrameId, why: string): Promise<void> {
		this.c.unregisterAdopt(cfid);
		const rec = this.c.outbox.get(cfid);
		if (!rec || rec.state !== "adoptable") return;
		this.c.applyOutboxResult(await this.c.repo.tOutbox([{ t: "state", clientFrameId: cfid, state: "pending" }]));
		this.stats.adoptToPending++;
		this.c.diag("adopt-pending", { why });
	}
}
