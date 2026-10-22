/**
 * LogEngine (DESIGN §d, §e, §i): the log-side engine. Composes the repo
 * (IDB cache), ns fold, doc handles, sender, live ingest, session loop,
 * maintenance and the outbox mirror behind a small host-facing API.
 *
 * Host contract (WP-D wires it): submitNs authors ns ops; bind() pins the
 * replica for bound views, applyEditorChanges() applies their CodeMirror
 * changes (O(change), never re-encodes the doc), openBody() hands a merge job
 * the replica; onBoundText reports every change of a bound body as CodeMirror
 * changes (DESIGN §d.3). The tests' authoring calls (createDoc, editDoc, ...)
 * are in testHarness.ts.
 */

import * as Y from "yjs";
import type { SnapFoldState } from "../../core/snap/fold";
import type { SnapOp } from "../../core/snap/record";
import { NS_STREAM, docStream, type BodyVersion, type CfgFoldState, type CfgOp, type ClientFrameId, type ContentHash, type DocId, type DocKind, type NsOp, type RemoteBodyInfo, type StreamName, type VaultEpoch } from "../../core/types";
import type { DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import type { RelaySession } from "../../ports/relay";
import { HandleManager } from "../body/handles";
import { applyChanges, changesBaseLength, type TextChanges } from "../body/textChanges";
import { Sender, sendRank } from "../body/sender";
import { ORIGIN } from "../body/yjsCounters";
import { defaultPriority, Repo } from "../store/repo";
import { dbName } from "../store/schema";
import { recheckStored, releaseQuarantine } from "./quarantineRelease";
import type { BodyHandle } from "../reconcile/deps";
import { decodeNsOps } from "../../core/codec/nsOps";
import { CfgRuntime } from "../sync/cfgRuntime";
import { SnapRuntime } from "../sync/snapRuntime";
import { NsRuntime, type DocInfo } from "../sync/nsRuntime";
import * as api from "./logApi";
import { BlobGc } from "./blobGc";
import type { GcOutcome } from "../blobs/gc";
import { EngineCtx } from "./context";
import { DocRuntime } from "./docRuntime";
import { LiveIngest } from "./liveIngest";
import { Maintenance } from "./maintenance";
import { MirrorWriter, recoverFromMirror } from "./mirrorIo";
import { inheritFromLineage } from "./inherit";
import { Resealer } from "./reseal";
import { resolveSkipDefer, type EngineOptions } from "./options";
import { Subscriptions } from "./subscriptions";
import { SessionLoop } from "./sessionLoop";
import { KeyringRuntime } from "../keyring/keyringRuntime";
import type { OwnOutcome, QrResult } from "../keyring/keyring";

export class EngineStartError extends Error {
	constructor(readonly reason: string) {
		super(`engine start failed: ${reason}`);
	}
}

/**
 * The store's DB did not match its identity (another schema, vault or device) and was deleted: a new DB is a new
 * store, so the next start mints a new identity (identity-per-store §1.3, §4 "Repo.open mismatch").
 */
export class StoreResetError extends EngineStartError {
	constructor() {
		super("store-reset");
	}
}

/**
 * The relay named an epoch this store has no DB for (identity-per-store §4 "vaultEpoch change"): the new epoch's DB is
 * a new store, so it gets a new identity, never this one (§1.3). The composed engine mints and starts again on `epoch`.
 */
export class StoreEpochError extends EngineStartError {
	constructor(readonly epoch: VaultEpoch) {
		super("store-epoch");
	}
}

export class LogEngine {
	readonly maint: Maintenance;
	private readonly gc: BlobGc;
	private readonly boundStreams = new Map<DocId, StreamName>();

	private constructor(readonly c: EngineCtx) {
		this.maint = new Maintenance(c);
		this.gc = new BlobGc(c);
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
		const store = opts.store;
		const ident = {
			vaultId: opts.vaultId, vaultEpoch: epoch, deviceId: opts.deviceId, clientVersion: opts.clientVersion,
			...(store ? { storeKey: store.installKey, deviceToken: store.deviceToken, retireKey: store.retireKey } : {}),
		};
		const openOpts = { pathBases: opts.pathBases ?? null, docDeletes: opts.docDeletes ?? null, inherit: opts.inherit ?? null, supersedes: opts.supersedes ?? null };
		const openedAt = c.mono();
		// A pending identity is consumed before its store exists, so it can serve no second store (storeIdentity.ts).
		if (store?.beforeCreate) await store.beforeCreate();
		// A store's identity opens only that store: no new DB (another epoch's) under it (identity-per-store §1.3).
		else if (store && !(await storage.listDatabases()).includes(dbName(opts.vaultId, epoch, store.installKey))) throw new StoreEpochError(epoch);
		let o = await Repo.open(storage, ident, c.now(), openOpts);
		if (!o.repo) {
			o.db.close();
			await storage.deleteDatabase(o.db.name);
			// Identity-per-store: the deleted DB was a store; the next one gets a new identity (the caller re-mints).
			if (store) throw new StoreResetError();
			o = await Repo.open(storage, ident, c.now(), openOpts);
			if (!o.repo) throw new EngineStartError("db-identity");
		}
		c.repoOpenMs = c.mono() - openedAt;
		const repo = o.repo;
		repo.monotonic = () => c.mono();
		repo.priorityFn = (r) => ((c.handles?.peek(r.stream)?.bound ?? 0) > 0 ? -10 : defaultPriority(r));
		repo.onQuarantineFrozen = (recs) => {
			for (const r of recs) c.frozen(r.stream, r.frozenReason ?? "quarantine", r.cls);
		};
		repo.onStored = (quarantined, rows) => recheckStored(c, quarantined, rows);
		c.repo = repo;
		c.daily = { ...repo.dailyAtOpen }; // the daily soft budget (§i.6) counts across restarts
		c.keyring = await KeyringRuntime.open(c, opts.e2ee);
		c.ns = new NsRuntime(repo, c.self, c.tuning.nsCandidateModulus, c.tuning.knownRules.ns, c.tuning.nsPrune);
		c.cfg = new CfgRuntime(repo, c.self, c.tuning.nsCandidateModulus);
		c.snap = new SnapRuntime(repo, c.self, c.tuning.nsCandidateModulus);
		c.docs = new DocRuntime(c);
		c.handles = new HandleManager(repo, c.budgets, c.docs.hooks());
		const resealer = new Resealer(c);
		c.sender = new Sender({
			clock: opts.ports.clock,
			rankOf: (rec) => sendRank(rec, (stream) => (c.handles.peek(stream)?.bound ?? 0) > 0),
			maxInflightBytes: () => c.budgets.maxInflightAppendBytes,
			onPoison: (rec, why) => {
				c.diag("frame-poisoned", { why });
				void c.repo.tOutbox([{ t: "state", clientFrameId: rec.clientFrameId, state: "poisoned" }]).then((r) => c.applyOutboxResult(r), (e: unknown) => c.diag("frame-poison-failed", { error: String(e) }));
			},
			onForbidden: () => c.onForbidden(),
			writeBlocked: () => c.gate() !== null || !c.keyring.sendReady(),
			minSendEpoch: () => c.keyring.minSendEpoch(),
			reseal: (rec) => resealer.request(rec),
			onDailyLimit: (ms, retryAfterMs) => {
				c.dailyLimitUntilMono = c.mono() + ms;
				// Only a caught-up session turns daily-limit here. A refusal during catch-up (body frames go out right
				// after VAULT_READY, DESIGN §d.7 "Reconnect order") keeps it catching-up; the end of the start reads
				// takes livePhase(), which reads the hold. The host takes daily-limit with a session, as it takes live,
				// for ns caught up (vaultRuntime onLogStatus).
				if (c.phase === "live") c.setPhase("daily-limit");
				c.notice("daily-limit");
				c.dailyLimitPopup(retryAfterMs);
			},
			diag: (code, f) => c.diag(code, f),
			gate: c.touch,
			blockedBy: (rec) => (rec.dependsOn !== null && c.outbox.has(rec.dependsOn) ? rec.dependsOn : null),
		});
		c.live = new LiveIngest(c);
		c.sess = new SessionLoop(c);
		c.subs = new Subscriptions(c, resolveSkipDefer(c.deviceClass, c.tuning));
		c.mirror = new MirrorWriter(c, opts.sideFiles ?? null);
		const eng = new LogEngine(c);
		// identity-per-store §5.2: a new store of an install with a lineage adopts its predecessor's mirrors. Recorded at
		// the store's creation and cleared by the import's own transaction, so a crash in between runs it again.
		const inherit = repo.identity.inherit ?? null;
		let inherited = 0;
		if (inherit && opts.lineageSideFiles) {
			const r = await inheritFromLineage(c, inherit, opts.lineageSideFiles);
			inherited = r.frames;
			if (r.frames > 0 || r.synced > 0) {
				c.setPhase("recovering");
				c.notice("recovered-from-mirror");
			}
			// Without the fence a frame of the dead store may still be in the relay's buffer: the commit check waits.
			if (!inherit.fenced && r.frames > 0) c.inheritCheckAtMono = c.mono() + c.tuning.inheritUnfencedWaitMs;
		} else if (o.outcome.t === "fresh" && opts.sideFiles && !inherit) {
			// A store under the same deviceId (engine tests without a store identity): its own mirror (DESIGN §i.5).
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
				// After a restart a create's later body frames are held until its fold (§e.1).
				for (const op of decodeNsOps(r.content) ?? []) if (op.t === "create") c.pendingCreates.set(op.docId, { cfid: r.clientFrameId, live: false });
			}
		}
		c.mirror.scheduleIfBehind(c.outbox.all());
		// The inherited frames are on this store's mirror before any of them is sent (inherit.ts header step 5).
		if (inherited > 0) {
			c.mirror.schedule();
			if (!(await c.mirror.flushed())) c.diag("inherit-mirror-unwritten", { frames: inherited });
		}
		await c.refold(true);
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

	// ------------------------------------------------------------ ns / cfg

	/**
	 * Own ns ops -> frames (<= MAX_NS_OPS_PER_FRAME) in the outbox; resolves once committed (in nsView()).
	 * `liveCreates`: the creates' body frames go right after them instead of waiting for their fold (DESIGN §d.4).
	 */
	async submitNs(ops: readonly NsOp[], opts?: { readonly liveCreates?: boolean }): Promise<ClientFrameId[]> {
		this.c.assertWritable();
		return api.submitNs(this.c, ops, undefined, opts?.liveCreates === true);
	}

	/** Hold ns frames until the returned release or NS_CORK_MAX_MS (Sender.corkNs, DESIGN §d.4). */
	corkNs(): () => void {
		return this.c.sender.corkNs();
	}

	/** Committed fold + own pending ns frames (§f.1). */
	nsView(): api.NsView {
		return api.nsView(this.c);
	}

	/** Own cfg ops -> frames in the outbox; resolves once committed (in cfgView()). */
	async submitCfg(ops: readonly CfgOp[]): Promise<ClientFrameId[]> {
		this.c.assertWritable();
		return api.submitCfg(this.c, ops);
	}

	/** Committed cfg fold + own pending cfg frames (a copy). */
	cfgView(): CfgFoldState {
		return api.cfgView(this.c);
	}

	/** Own snapshot-index ops (DESIGN §j.4) -> frames in the outbox; resolves once committed (in snapView()). */
	submitSnap(ops: readonly SnapOp[]): Promise<ClientFrameId[]> {
		return api.submitSnap(this.c, ops);
	}

	/** Snapshot index fold + own pending snap frames (a copy). */
	snapView(): { readonly state: SnapFoldState; readonly caughtUp: boolean } {
		return api.snapView(this.c);
	}

	/** Body info of a markdown / canvas doc; null = unknown doc or blob. `kind` skips the lookup. */
	bodyInfo(docId: DocId, kind?: DocKind): RemoteBodyInfo | null {
		return api.bodyInfo(this.c, docId, kind ?? api.docKind(this.c, docId));
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
			assertWritable: () => c.assertWritable(),
			commitEdits: async () => {
				c.assertWritable();
				await c.docs.closeFrame(h);
				return version();
			},
			version,
			unframed: () => !h.builder.empty,
			release: () => {
				if (released) return;
				released = true;
				if (!h.builder.empty) void c.docs.closeFrame(h);
				c.handles.unpin(h);
			},
		};
	}

	/**
	 * Bound-view editor changes (CodeMirror ChangeSet JSON over the replica text now, textChanges.ts): one MAIN
	 * transaction, O(change); the open frame closes on its timers. false = the changes do not fit the text length.
	 */
	applyEditorChanges(docId: DocId, changes: TextChanges): boolean {
		const c = this.c;
		const stream = this.boundStreams.get(docId);
		const h = stream ? c.handles.peek(stream) : undefined;
		if (!h || h.bound === 0) throw new Error(`doc not bound: ${docId}`);
		if (c.repo.stream(h.stream)?.frozen) throw new Error("doc frozen");
		const ytext = h.doc.getText("text");
		if (changesBaseLength(changes) !== ytext.length) return false;
		let update = null as Uint8Array | null;
		const grab = (u: Uint8Array, origin: unknown) => {
			if (origin === ORIGIN.MAIN) update = u;
		};
		h.doc.on("update", grab);
		try {
			h.doc.transact(() => applyChanges(ytext, changes), ORIGIN.MAIN);
		} finally {
			h.doc.off("update", grab);
		}
		h.lastAccessMono = c.mono();
		if (update === null) return true;
		c.handles.grow(h, update.length);
		if (h.builder.push(update, c.mono())) void c.docs.closeFrame(h);
		else c.docs.armBuilder(h);
		return true;
	}

	/** Everything applied to the doc's replica is in committed storage (no open frame, no T_edit pending). */
	bodyDurable(docId: DocId): boolean {
		const h = this.c.handles.peek(this.streamOf(docId));
		return (!h || h.builder.empty) && this.c.docs.editIdle;
	}

	/**
	 * Merge edit on a bound doc, synchronous (the attach / reload merge of the bound views): one MERGE
	 * transaction on the resident replica, its frame closed at once. Returns the frame's commit.
	 */
	editBound(docId: DocId, fn: (text: Y.Text) => void): Promise<void> {
		const c = this.c;
		const stream = this.boundStreams.get(docId);
		const h = stream ? c.handles.peek(stream) : undefined;
		if (!h || h.bound === 0) throw new Error(`doc not bound: ${docId}`);
		if (c.repo.stream(h.stream)?.frozen) throw new Error("doc frozen");
		h.doc.transact(() => fn(h.doc.getText("text")), ORIGIN.MERGE);
		h.lastAccessMono = c.mono();
		return h.builder.empty ? Promise.resolve() : c.docs.closeFrame(h);
	}

	/** The bound replica's text (O(N), worker only: attach, reload, save marks). */
	boundText(docId: DocId): string {
		const stream = this.boundStreams.get(docId);
		const h = stream ? this.c.handles.peek(stream) : undefined;
		if (!h || h.bound === 0) throw new Error(`doc not bound: ${docId}`);
		return h.doc.getText("text").toString();
	}

	/** The bound replica's length (O(1)). */
	boundLength(docId: DocId): number {
		const stream = this.boundStreams.get(docId);
		const h = stream ? this.c.handles.peek(stream) : undefined;
		return h && h.bound > 0 ? h.doc.getText("text").length : -1;
	}

	/** The doc is bound and frozen (no edits accepted). */
	boundFrozen(docId: DocId): boolean {
		const stream = this.boundStreams.get(docId);
		return stream ? Boolean(this.c.repo.stream(stream)?.frozen) : false;
	}

	/** Pin the replica of a bound doc (one per bound doc; unbind releases it). */
	async bind(docId: DocId): Promise<void> {
		const c = this.c;
		const stream = this.streamOf(docId);
		const h = await c.handles.load(stream);
		h.bound++;
		this.boundStreams.set(docId, stream);
		// Subscribed (debounced) and read at once: a bound stream is never deferred, and first in catch-up order.
		c.subs.noteBound(stream);
		c.sess.scheduleCatchUp();
	}

	unbind(docId: DocId): void {
		const c = this.c;
		const stream = this.boundStreams.get(docId);
		const h = stream ? c.handles.peek(stream) : undefined;
		if (!h) return;
		h.bound = Math.max(0, h.bound - 1);
		if (h.bound > 0) return;
		this.boundStreams.delete(docId);
		c.subs.noteUnbound(h.stream);
		if (!h.builder.empty) void c.docs.closeFrame(h);
		c.handles.enforceBudget();
	}

	/**
	 * Re-gate a stream's quarantined rows (key now available, ...): pass -> tail; the rest dismissed; doc unfrozen.
	 * By stream, not doc id: a merged duplicate's id resolves to another doc's stream (streamOf).
	 */
	releaseQuarantine(stream: StreamName): Promise<{ passed: number; dismissed: number }> {
		return releaseQuarantine(this.c, stream);
	}

	/**
	 * One blob GC sweep (runtime/blobGc.ts, e2ee-design §10.4). `queued`: hashes local transfers still need.
	 * Never throws: a refusal or failure is in the outcome.
	 */
	cleanUpBlobs(queued: () => Iterable<ContentHash>): Promise<GcOutcome> {
		return this.gc.run(queued);
	}

	// ------------------------------------------------------------ lifecycle

	/** Close every open frame, write the mirror. */
	async flush(): Promise<void> {
		const c = this.c;
		for (const h of [...c.handles.all()]) if (!h.builder.empty) void c.docs.closeFrame(h);
		await c.docs.chain(async () => undefined);
		await c.mirror.flush();
	}

	/**
	 * The disk side waits for these docs' bodies (a plan's "body-not-caught-up"): their reads are not deferred
	 * (DESIGN §d.7). Unknown docs are ignored.
	 */
	wantFresh(docIds: readonly DocId[]): void {
		const streams: StreamName[] = [];
		for (const id of docIds) {
			try {
				streams.push(this.streamOf(id));
			} catch {
				// unknown doc: nothing to read
			}
		}
		this.c.subs.wantFresh(streams);
	}

	/**
	 * Nothing open, queued, unreceipted (own `k` appends included), stale or above V: converged with the relay. A stream whose read is deferred
	 * (skipped rows, DESIGN §d.7) is stale, so it keeps the engine busy until read; tests that wait for quiescence
	 * use tuning skipSettleMs 0 (FAST_TUNING). Status staleStreams leaves deferred streams out (nothing is fetched).
	 */
	isIdle(): boolean {
		const c = this.c;
		if (!c.session || !c.live.enabled || !c.docs.editIdle || !c.live.idle || c.sess.readsInFlight > 0 || c.sess.isFeeding) return false;
		for (const h of c.handles.all()) if (!h.builder.empty) return false;
		if (c.outbox.unreceipted() > 0 || c.keyring.busy()) return false;
		for (const r of c.outbox.values()) if (r.state === "held") return false;
		const onlyK = c.keyring.readsOnlyK();
		for (const r of c.repo.streams()) if (r.stale && r.cls !== "other" && (!onlyK || r.cls === "keyring") && !(r.frozen && r.frozenReason === "checkpoint-disputed") && !c.sess.isHeld(r.stream)) return false;
		return c.repo.cursor.headSeqSeen <= c.repo.cursor.vaultSeq;
	}

	disconnect(): void {
		this.c.sess.disconnect();
	}
	reconnect(): Promise<void> {
		return this.c.sess.reconnect();
	}

	/** DESIGN §i.4: background work (stale reads, compaction, checkpoints) waits while backgrounded. */
	setBackground(on: boolean): void {
		const c = this.c;
		if (c.background === on) return;
		c.background = on;
		c.onActivity?.(); // background work waits or resumes: maintenance back to its base interval
		if (!on) c.sess.scheduleCatchUp();
	}
	/** Deliberate background close: no offline phase, no backoff; wake() reconnects. */
	park(): void {
		this.c.sess.park();
	}
	wake(): Promise<void> {
		return this.c.sess.wake();
	}
	setNetwork(online: boolean): Promise<void> {
		return this.c.sess.setNetwork(online);
	}
	/** The network came back: unresolved body refs and held frames' blob re-PUTs retry now (backoff counts kept). */
	retryBlobsNow(): void {
		this.c.docs.retryRefsNow();
		this.c.touch.retryNow();
	}

	async stop(): Promise<void> {
		const c = this.c;
		if (c.stopped) return;
		await this.gc.stop();
		try {
			await this.flush();
		} catch (e) {
			c.diag("stop-flush-failed", { error: String(e) });
		}
		c.sess.disconnect();
		c.stopped = true;
		c.keyring.stop();
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

	// ------------------------------------------------------------ keyring (e2ee-design §18.4)

	/** installKey {source: "qr"}: zero-fills `k`; persists only once it verifies against a `k` record. */
	installKeyQr(e: number, k: Uint8Array): Promise<QrResult> {
		return this.c.keyring.installQr(e, k);
	}
	/** installKey {source: "rk"}: zero-fills `rk`. */
	installKeyRk(rk: Uint8Array): Promise<"verified" | "pending"> {
		return this.c.keyring.installRk(rk);
	}
	/**
	 * §14.2 step 2: zero-fills `rk`. A won record covers the blocking removals this engine had seen when it started
	 * (e2ee-design §14.5): the relay is told so (VAULT_REKEYED), and the other devices stop prompting.
	 */
	async revokeRekey(rk: Uint8Array): Promise<OwnOutcome> {
		const seen = this.c.rekey.signal?.removals ?? 0;
		const o = await this.c.keyring.revokeRekey(rk);
		if (o === "won") this.c.rekey.covered(seen);
		return o;
	}
	diagnostics(): readonly DiagnosticsEvent[] {
		return this.c.diagnostics();
	}
}

