/**
 * LogEngine (DESIGN §d, §e, §i): the log-side engine. Composes the repo
 * (IDB cache), ns fold, doc handles, sender, live ingest, session loop,
 * maintenance and the outbox mirror behind a small host-facing API.
 *
 * Host contract (WP-D wires it): createDoc / renameDoc / deleteDoc author ns
 * ops; bind() returns the replica state for a view, applyLocalUpdate() feeds
 * keystrokes (O(update), never re-encodes the doc), editDoc() applies a
 * disk-merge edit; onDocUpdate forwards remote / provisional / merge updates
 * to bound views.
 */

import * as Y from "yjs";
import { EnvelopeFlag } from "../../core/envelope";
import { NS_STREAM, docStream, kindOfPath, streamClass, type ContentHash, type DocId, type DocKind, type NsOp, type StreamName, type VaultEpoch, type VaultPath } from "../../core/types";
import type { DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import type { RelaySession } from "../../ports/relay";
import { buildBodyFrames, buildNsFrame, initialTextUpdates } from "../body/frames";
import { HandleManager, type Handle } from "../body/handles";
import { Sender } from "../body/sender";
import { encodeStateAsUpdate, ORIGIN } from "../body/yjsCounters";
import { defaultPriority, Repo } from "../store/repo";
import type { QuarantineRecord, TailRecord } from "../store/schema";
import { newDocId } from "../../core/codec/ids";
import { bytesToHex, utf8Encode } from "../../core/codec/lib0";
import { gateRow } from "../sync/ingestRow";
import { NsRuntime, type DocInfo } from "../sync/nsRuntime";
import { EngineCtx } from "./context";
import { DocRuntime } from "./docRuntime";
import { LiveIngest } from "./liveIngest";
import { Maintenance } from "./maintenance";
import { MirrorWriter, recoverFromMirror } from "./mirrorIo";
import type { EngineOptions } from "./options";
import { SessionLoop } from "./sessionLoop";

export class EngineStartError extends Error {
	constructor(readonly reason: string) {
		super(`engine start failed: ${reason}`);
	}
}

export interface BindResult {
	readonly state: Uint8Array;
	readonly stateVector: Uint8Array;
}

function rankOf(c: EngineCtx) {
	return (rec: { stream: StreamName; flags: number }): number => {
		const cls = streamClass(rec.stream);
		if (cls === "ns") return 1;
		if (cls === "cfg") return 2;
		if (cls === "blobchunk" || (rec.flags & EnvelopeFlag.adopted) !== 0) return 4;
		return (c.handles.peek(rec.stream)?.bound ?? 0) > 0 ? 0 : 3;
	};
}

export class LogEngine {
	readonly maint: Maintenance;
	private readonly boundStreams = new Map<DocId, StreamName>();

	private constructor(readonly c: EngineCtx) {
		this.maint = new Maintenance(c);
	}

	static async start(opts: EngineOptions): Promise<LogEngine> {
		let first: RelaySession | null = null;
		let epoch = opts.vaultEpoch;
		if (!epoch) {
			const r = await opts.ports.relay.connect({ vaultId: opts.vaultId, deviceId: opts.deviceId });
			if (!r.ok) throw new EngineStartError(r.reason);
			first = r.session;
			epoch = r.session.vaultEpoch;
		}
		try {
			return await LogEngine.boot(opts, epoch, first);
		} catch (e) {
			first?.close(1000, "start failed");
			throw e;
		}
	}

	private static async boot(opts: EngineOptions, epoch: VaultEpoch, first: RelaySession | null): Promise<LogEngine> {
		const c = new EngineCtx(opts);
		const { storage } = opts.ports;
		const ident = { vaultId: opts.vaultId, vaultEpoch: epoch, deviceId: opts.deviceId, clientVersion: opts.clientVersion };
		let o = await Repo.open(storage, ident, c.now());
		if (!o.repo) {
			o.db.close();
			await storage.deleteDatabase(o.db.name);
			o = await Repo.open(storage, ident, c.now());
			if (!o.repo) throw new EngineStartError("db-identity");
		}
		const repo = o.repo;
		repo.monotonic = () => c.mono();
		repo.priorityFn = (r) => ((c.handles?.peek(r.stream)?.bound ?? 0) > 0 ? -10 : defaultPriority(r));
		c.repo = repo;
		c.ns = new NsRuntime(repo, c.self, c.tuning.nsCandidateModulus);
		c.docs = new DocRuntime(c);
		c.handles = new HandleManager(repo, c.budgets, c.docs.hooks());
		c.sender = new Sender({
			clock: opts.ports.clock,
			rankOf: rankOf(c),
			maxInflightBytes: () => c.budgets.maxInflightAppendBytes,
			onSent: (rec, attempts) => {
				c.sentPending.set(rec.clientFrameId, { attempts, atMs: c.now() });
				const cur = c.outbox.get(rec.clientFrameId);
				if (cur?.state === "pending") c.outbox.put({ ...cur, state: "sent", attempts, lastSentAtMs: c.now() });
			},
			onPoison: (rec, why) => {
				c.diag("frame-poisoned", { why });
				void c.repo.tOutbox([{ t: "state", clientFrameId: rec.clientFrameId, state: "poisoned" }]).then((r) => c.applyOutboxResult(r));
			},
			onForbidden: () => c.onForbidden(),
			onDailyLimit: (ms) => {
				c.dailyLimitUntilMono = c.mono() + ms;
				c.setPhase("daily-limit");
				c.notice("daily-limit");
			},
			diag: (code, f) => c.diag(code, f),
		});
		c.live = new LiveIngest(c);
		c.sess = new SessionLoop(c);
		c.mirror = new MirrorWriter(c, opts.sideFiles ?? null);
		const eng = new LogEngine(c);
		if (o.outcome.t === "fresh" && opts.sideFiles) {
			const n = await recoverFromMirror(c, opts.sideFiles);
			if (n > 0) {
				c.setPhase("recovering");
				c.notice("recovered-from-mirror");
			}
		}
		await c.mirror.readGenerations();
		for (const r of await repo.outboxAll()) {
			c.outbox.put(r);
			if (r.state === "adoptable") c.registerAdopt(r);
			else c.sender.upsert(r);
		}
		await c.ns.load();
		await c.afterNsChange();
		eng.maint.start();
		if (first) void c.sess.onSession(first);
		else c.sess.startLoop();
		return eng;
	}

	// ---------------------------------------------------------------- docs

	listDocs(): DocInfo[] {
		return this.c.ns.listDocs(this.c.outbox);
	}

	streamOf(docId: DocId): StreamName {
		const bound = this.boundStreams.get(docId);
		if (bound) return bound;
		const e = this.c.ns.resolve(docId);
		const kind = e?.kind ?? this.listDocs().find((d) => d.docId === docId)?.kind;
		const s = kind ? docStream(kind, e?.docId ?? docId) : null;
		if (!s) throw new Error(`unknown doc ${docId}`);
		return s;
	}

	private async authorNs(ops: readonly NsOp[]): Promise<void> {
		const c = this.c;
		await c.docs.chain(async () => {
			const f = await buildNsFrame(c.deps, NS_STREAM, ops, c.ns.coversSeq, c.now());
			c.addOutbox(await c.repo.tEdit([f], c.now()));
		});
	}

	async createDoc(path: VaultPath, text: string, kind: DocKind = kindOfPath(path)): Promise<DocId> {
		const c = this.c;
		if (kind === "blob") throw new Error("blob docs are not handled by the log engine");
		if (this.listDocs().some((d) => d.path === path && (d.state === "live" || d.state === "pending"))) throw new Error(`path exists: ${path}`);
		const docId = newDocId(c.ports.random);
		const stream = docStream(kind, docId)!;
		const bytes = utf8Encode(text);
		const contentHash = bytesToHex(await c.ports.hash.sha256(bytes)) as ContentHash;
		await c.docs.chain(async () => {
			const nsFrame = await buildNsFrame(c.deps, NS_STREAM, [{ t: "create", docId, kind, path, contentHash, size: bytes.length }], c.ns.coversSeq, c.now());
			const h = await c.handles.acquire(stream);
			try {
				const frames = [nsFrame];
				if (kind === "markdown" && text.length > 0) {
					for (const u of initialTextUpdates(h.doc, text)) {
						frames.push(...await buildBodyFrames(c.deps, { stream, content: u, flags: EnvelopeFlag.initial, authorNsSeq: c.ns.coversSeq, dependsOn: nsFrame.clientFrameId, nowMs: c.now() }));
					}
				}
				c.addOutbox(await c.repo.tEdit(frames, c.now()));
			} catch (e) {
				c.handles.unpin(h);
				c.handles.drop(stream);
				throw e;
			}
			c.handles.unpin(h);
		});
		return docId;
	}

	renameDoc(docId: DocId, path: VaultPath): Promise<void> {
		return this.authorNs([{ t: "rename", docId, path }]);
	}

	deleteDoc(docId: DocId): Promise<void> {
		const rec = this.c.repo.stream(this.streamOf(docId));
		return this.authorNs([{ t: "delete", docId, baseBodySeq: Math.max(rec?.appliedSeq ?? 0, rec?.lastOwnSeq ?? 0) }]);
	}

	/** Disk-merge style edit: one MERGE transaction, frame closed at once. */
	async editDoc(docId: DocId, fn: (text: Y.Text, doc: Y.Doc) => void): Promise<void> {
		const c = this.c;
		const stream = this.streamOf(docId);
		if (c.repo.stream(stream)?.frozen) throw new Error(`doc frozen: ${c.repo.stream(stream)?.frozenReason}`);
		const h = await c.handles.acquire(stream);
		try {
			h.doc.transact(() => fn(h.doc.getText("text"), h.doc), ORIGIN.MERGE);
			await c.docs.closeFrame(h);
		} finally {
			c.handles.unpin(h);
		}
	}

	/** Host keystroke update on a bound doc: O(update); the open frame closes on its timers. */
	applyLocalUpdate(docId: DocId, update: Uint8Array): void {
		const c = this.c;
		const stream = this.boundStreams.get(docId);
		const h = stream ? c.handles.peek(stream) : undefined;
		if (!h || h.bound === 0) throw new Error(`doc not bound: ${docId}`);
		if (c.repo.stream(h.stream)?.frozen) throw new Error("doc frozen");
		Y.applyUpdate(h.doc, update, ORIGIN.MAIN);
		c.handles.grow(h, update.length);
		h.lastAccessMono = c.mono();
		if (h.builder.push(update, c.mono())) void c.docs.closeFrame(h);
		else c.docs.armBuilder(h);
	}

	async bind(docId: DocId): Promise<BindResult> {
		const c = this.c;
		const stream = this.streamOf(docId);
		const h = await c.handles.load(stream);
		h.bound++;
		this.boundStreams.set(docId, stream);
		c.sess.scheduleCatchUp();
		return { state: encodeStateAsUpdate(h.doc), stateVector: Y.encodeStateVector(h.doc) };
	}

	unbind(docId: DocId): void {
		const c = this.c;
		const stream = this.boundStreams.get(docId);
		const h = stream ? c.handles.peek(stream) : undefined;
		if (!h) return;
		h.bound = Math.max(0, h.bound - 1);
		if (h.bound > 0) return;
		this.boundStreams.delete(docId);
		if (!h.builder.empty) void c.docs.closeFrame(h);
		c.handles.enforceBudget();
	}

	async docText(docId: DocId): Promise<string> {
		const h = await this.c.handles.load(this.streamOf(docId));
		return h.doc.getText("text").toString();
	}

	handleOf(docId: DocId): Handle | undefined {
		return this.c.handles.peek(this.streamOf(docId));
	}

	/** Re-gate quarantined rows (key now available, ...): pass -> tail; the rest dismissed; doc unfrozen. */
	async releaseQuarantine(docId: DocId): Promise<{ passed: number; dismissed: number }> {
		const c = this.c;
		const stream = this.streamOf(docId);
		const pass: TailRecord[] = [];
		const dismiss: QuarantineRecord[] = [];
		for (const q of await c.repo.quarantineOf(stream)) {
			if (q.bytes.length < q.originalSize) {
				dismiss.push(q);
				continue;
			}
			const g = await gateRow(c.gateCtx, c.ports.hash, { stream, seq: q.seq, deviceId: q.deviceId, clientFrameId: q.clientFrameId, payload: q.bytes }, c.now());
			if (g.t === "row") pass.push(g.row);
			else dismiss.push(q);
		}
		await c.repo.tReleaseQuarantine(stream, pass, dismiss, c.now());
		c.docs.clearCausal(stream);
		for (const n of c.noticeList()) {
			if (!n.code.startsWith("frozen:")) continue;
			const reason = n.code.slice("frozen:".length);
			if (![...c.repo.streams()].some((r) => r.frozen === 1 && r.frozenReason === reason)) c.clearNotice(n.code);
		}
		const h = c.handles.peek(stream);
		if (h) {
			if (pass.length > 0) await c.docs.applyToHandle(h, pass);
			c.docs.checkDoc(h);
		}
		c.sess.scheduleCatchUp();
		c.scheduleStatus();
		return { passed: pass.length, dismissed: dismiss.length };
	}

	// ------------------------------------------------------------ lifecycle

	/** Close every open frame, persist T_sent, write the mirror. */
	async flush(): Promise<void> {
		const c = this.c;
		for (const h of [...c.handles.all()]) if (!h.builder.empty) void c.docs.closeFrame(h);
		await c.docs.chain(async () => undefined);
		await this.maint.flushSent();
		await c.mirror.flush();
	}

	/** Nothing open, queued, unreceipted, stale or above V. */
	isIdle(): boolean {
		const c = this.c;
		if (!c.session || !c.live.enabled || !c.docs.editIdle || !c.live.idle || c.sess.readsInFlight > 0 || c.sess.isFeeding) return false;
		for (const h of c.handles.all()) if (!h.builder.empty) return false;
		if (c.outbox.unreceipted() > 0) return false;
		for (const r of c.outbox.values()) if (r.state === "held") return false;
		for (const r of c.repo.streams()) if (r.stale && r.cls !== "other" && !(r.frozen && r.frozenReason === "checkpoint-disputed")) return false;
		return c.repo.cursor.headSeqSeen <= c.repo.cursor.vaultSeq;
	}

	async waitIdle(timeoutMs = 30_000, pollMs = 20): Promise<boolean> {
		const c = this.c;
		const start = c.mono();
		for (;;) {
			if (this.isIdle()) return true;
			if (c.mono() - start > timeoutMs) return false;
			await new Promise<void>((r) => c.ports.clock.setTimer(pollMs, r));
		}
	}

	disconnect(): void {
		this.c.sess.disconnect();
	}
	reconnect(): Promise<void> {
		return this.c.sess.reconnect();
	}

	async stop(): Promise<void> {
		const c = this.c;
		if (c.stopped) return;
		try {
			await this.flush();
		} catch (e) {
			c.diag("stop-flush-failed", { error: String(e) });
		}
		c.sess.disconnect();
		c.stopped = true;
		this.maint.stop();
		c.sess.clearReconnect();
		c.clearStatusTimer();
		c.docs.dispose();
		for (const cfid of [...c.adoptTimers.keys()]) c.unregisterAdopt(cfid);
		await c.mirror.flush();
		await c.repo.drain();
		c.repo.close();
	}

	status(): StatusSnapshot {
		return this.c.status();
	}
	diagnostics(): readonly DiagnosticsEvent[] {
		return this.c.diagnostics();
	}
}

export function startEngine(opts: EngineOptions): Promise<LogEngine> {
	return LogEngine.start(opts);
}
