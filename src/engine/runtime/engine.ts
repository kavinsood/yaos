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
import { EnvelopeFlag, type BlobChunkContent } from "../../core/envelope";
import type { CfgFoldEvent } from "../../core/cfg/fold";
import { NS_STREAM, docStream, kindOfPath, streamClass, type BodyVersion, type CfgFoldState, type CfgOp, type ClientFrameId, type ContentHash, type DocId, type DocKind, type NsOp, type RemoteBodyInfo, type StreamName, type DeviceId, type VaultEpoch, type VaultId, type VaultPath } from "../../core/types";
import type { DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import type { RelaySession } from "../../ports/relay";
import type { StoragePort } from "../../ports/storage";
import { buildBodyFrames, initialTextUpdates } from "../body/frames";
import { HandleManager, type Handle } from "../body/handles";
import { Sender } from "../body/sender";
import { encodeStateAsUpdate, ORIGIN } from "../body/yjsCounters";
import { defaultPriority, Repo, type YS } from "../store/repo";
import { DB_NAME_PREFIX, DB_SCHEMA_VERSION, STORE, STORE_SPECS, dbName, type MetaIdentity } from "../store/schema";
import { newDocId } from "../../core/codec/ids";
import { bytesToHex, utf8Encode } from "../../core/codec/lib0";
import { releaseQuarantine, retryReaderQuarantine } from "./quarantineRelease";
import type { BodyHandle } from "../reconcile/deps";
import { decodeNsOps } from "../../core/codec/nsOps";
import { CfgRuntime } from "../sync/cfgRuntime";
import { NsRuntime, type DocInfo } from "../sync/nsRuntime";
import * as api from "./logApi";
import * as blobs from "./blobChunks";
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

	/**
	 * Epoch of an existing local DB of (vaultId, deviceId), from the DB names
	 * (store/schema dbName); several: the most recently created. undefined =
	 * none. Pass it as opts.vaultEpoch to boot offline (start() never looks it up
	 * itself: without vaultEpoch the first connect decides, which is what an
	 * epoch change needs). A relay on another epoch moves the phase to epoch-migrating.
	 */
	static async findKnownEpoch(storage: StoragePort, vaultId: VaultId, deviceId: DeviceId): Promise<VaultEpoch | undefined> {
		const found: VaultEpoch[] = [];
		for (const name of await storage.listDatabases()) {
			const parts = name.split(":");
			if (parts.length !== 4 || parts[0] !== DB_NAME_PREFIX) continue;
			try {
				if (decodeURIComponent(parts[1]!) !== vaultId || decodeURIComponent(parts[3]!) !== deviceId) continue;
				found.push(decodeURIComponent(parts[2]!) as VaultEpoch);
			} catch {
				continue; // not URI-encoded by dbName: not ours
			}
		}
		if (found.length <= 1) return found[0];
		let best: { epoch: VaultEpoch; at: number } | undefined;
		for (const epoch of found) {
			const db = await storage.open<YS>(dbName(vaultId, epoch, deviceId), DB_SCHEMA_VERSION, STORE_SPECS);
			try {
				const ident = await db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "identity")) as MetaIdentity | undefined;
				if (ident && ident.vaultEpoch === epoch && (!best || ident.createdAtMs > best.at)) best = { epoch, at: ident.createdAtMs };
			} finally {
				db.close();
			}
		}
		return best?.epoch;
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
		c.cfg = new CfgRuntime(repo, c.self, c.tuning.nsCandidateModulus);
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
			if (r.stream === NS_STREAM && r.state !== "poisoned") {
				for (const op of decodeNsOps(r.content) ?? []) if (op.t === "create") c.pendingCreates.set(op.docId, r.clientFrameId);
			}
		}
		await c.afterNsChange(true);
		await c.afterCfgChange(true);
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
		await api.submitNs(this.c, ops);
	}

	async createDoc(path: VaultPath, text: string, kind: DocKind = kindOfPath(path)): Promise<DocId> {
		const c = this.c;
		if (kind === "blob") throw new Error("blob docs are not handled by the log engine");
		if (this.listDocs().some((d) => d.path === path && (d.state === "live" || d.state === "pending"))) throw new Error(`path exists: ${path}`);
		const docId = newDocId(c.ports.random);
		const stream = docStream(kind, docId)!;
		const bytes = utf8Encode(text);
		const contentHash = bytesToHex(await c.ports.hash.sha256(bytes)) as ContentHash;
		const h = await c.handles.acquire(stream);
		try {
			await api.submitNs(c, [{ t: "create", docId, kind, path, contentHash, size: bytes.length }], async ([nsFrame]) => {
				const frames = [];
				if (kind === "markdown" && text.length > 0) {
					for (const u of initialTextUpdates(h.doc, text)) {
						frames.push(...await buildBodyFrames(c.deps, { stream, content: u, flags: EnvelopeFlag.initial, authorNsSeq: c.ns.coversSeq, dependsOn: nsFrame!.clientFrameId, nowMs: c.now() }));
					}
				}
				return frames;
			});
		} catch (e) {
			c.handles.unpin(h);
			c.handles.drop(stream);
			throw e;
		}
		c.handles.unpin(h);
		return docId;
	}

	renameDoc(docId: DocId, path: VaultPath): Promise<void> {
		return this.authorNs([{ t: "rename", docId, path }]);
	}

	deleteDoc(docId: DocId): Promise<void> {
		const rec = this.c.repo.stream(this.streamOf(docId));
		return this.authorNs([{ t: "delete", docId, baseBodySeq: Math.max(rec?.appliedSeq ?? 0, rec?.lastOwnSeq ?? 0) }]);
	}

	// ------------------------------------------------------------ ns / cfg

	/** Own ns ops -> frames (<= MAX_NS_OPS_PER_FRAME) in the outbox; resolves once committed (in nsView()). */
	submitNs(ops: readonly NsOp[]): Promise<ClientFrameId[]> {
		return api.submitNs(this.c, ops);
	}

	/** Committed fold + own pending ns frames (§f.1). */
	nsView(): api.NsView {
		return api.nsView(this.c);
	}

	/** Own cfg ops -> frames in the outbox; resolves once committed (in cfgView()). */
	submitCfg(ops: readonly CfgOp[]): Promise<ClientFrameId[]> {
		return api.submitCfg(this.c, ops);
	}

	/** Committed cfg fold + own pending cfg frames (a copy). */
	cfgView(): CfgFoldState {
		return api.cfgView(this.c);
	}

	/** Body info of a markdown / canvas doc; null = unknown doc or blob. `kind` skips the lookup. */
	bodyInfo(docId: DocId, kind?: DocKind): RemoteBodyInfo | null {
		return api.bodyInfo(this.c, docId, kind ?? api.docKind(this.c, docId));
	}

	/** BlobChunkLog.appendChunks: x:<hash> frames via the outbox; true once all are committed (blobChunks.ts). */
	appendBlobChunks(hash: ContentHash, chunks: readonly BlobChunkContent[]): Promise<boolean> {
		return blobs.appendBlobChunks(this.c, hash, chunks);
	}

	/** BlobChunkLog.readChunks: committed chunks of x:<hash> from the relay; null = not readable now. */
	readBlobChunks(hash: ContentHash): Promise<BlobChunkContent[] | null> {
		return blobs.readBlobChunks(this.c, hash);
	}

	/** Docs with own body / canvas frames in the outbox. */
	docsWithPendingBody(): Set<DocId> {
		return api.docsWithPendingBody(this.c);
	}

	/**
	 * Pin the worker replica of a doc's body stream (markdown -> b:, canvas -> c:) for a merge job (§d.1).
	 * Works for docs only in the optimistic view (own pending create). null = the stream is frozen.
	 */
	async openBody(docId: DocId, kind: "markdown" | "canvas"): Promise<BodyHandle | null> {
		const c = this.c;
		const stream = docStream(kind, docId)!;
		if (c.repo.stream(stream)?.frozen) return null;
		const h = await c.handles.acquire(stream);
		let released = false;
		const version = (): BodyVersion => c.repo.stream(stream)?.bodyVersion ?? { remoteSeq: 0, localOrder: 0 };
		return {
			docId,
			doc: h.doc,
			mergeOrigin: ORIGIN.MERGE,
			get bound() {
				return h.bound > 0;
			},
			commitEdits: async () => {
				await c.docs.closeFrame(h);
				return version();
			},
			version,
			release: () => {
				if (released) return;
				released = true;
				if (!h.builder.empty) void c.docs.closeFrame(h);
				c.handles.unpin(h);
			},
		};
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
		// Yjs emits "update" only when the transaction changed the doc. A no-op update (a bindDelta carrying only
		// the known delete set) must not become a frame: it would bump the body version and count as an edit
		// (a peer's delete would then be undone by edit-beats-delete).
		let changed = false;
		const probe = (_u: Uint8Array, origin: unknown) => {
			if (origin === ORIGIN.MAIN) changed = true;
		};
		h.doc.on("update", probe);
		try {
			Y.applyUpdate(h.doc, update, ORIGIN.MAIN);
		} finally {
			h.doc.off("update", probe);
		}
		h.lastAccessMono = c.mono();
		if (!changed && h.doc.store.pendingStructs === null && h.doc.store.pendingDs === null) return;
		c.handles.grow(h, update.length);
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
	releaseQuarantine(docId: DocId): Promise<{ passed: number; dismissed: number }> {
		return releaseQuarantine(this.c, this.streamOf(docId));
	}

	/** Automatic retry of reader-dependent quarantine (runs after every session start). */
	retryQuarantine(): Promise<number> {
		return retryReaderQuarantine(this.c);
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
