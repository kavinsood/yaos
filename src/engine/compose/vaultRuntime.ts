/**
 * One vault epoch's worth of engine (DESIGN §f, §i): the LogEngine (log side)
 * composed with the Reconciler, BlobQueue, CfgSync, SnapshotJob and the synced
 * mirror (disk side), plus the pass scheduler that drives them.
 *
 *   LogEngine.onNsFold   -> own fold events (S1) + docs pass + retargets
 *   LogEngine.onCfgFold  -> CfgSync pass
 *   LogEngine.onStatus   -> ns caught up once (planner gate), epoch change
 *   observations/events  -> Reconciler scan -> pass
 *   pass                 -> plan + jobs (disk I/O over HostLink on main)
 *
 * Snapshots (§j.4) are taken before brake approval, before epoch migration
 * and after IndexedDB recovery (before the first pass of the new DB).
 */

import type { BrakeReport, DocId, DocKind, PathKey, PlanScope, VaultEpoch, VaultPath } from "../../core/types";
import type { Budgets } from "../../core/limits";
import { pathKey } from "../../core/paths/pathKey";
import type { EnginePorts } from "../../ports";
import type { StorageDb } from "../../ports/storage";
import type { VaultEvent, VaultStat } from "../../ports/vault";
import type { EngineInitConfig, EngineResultValue, EngineSettings, LocalObservation, UserCommand } from "../../protocol/messages";
import type { StatusSnapshot } from "../../protocol/status";
import type { LifecycleEvent } from "../../ports/platform";
import { BlobQueue } from "../blobs/blobQueue";
import { Reconciler, type PassReport } from "../reconcile/reconciler";
import type { OwnFoldEvent } from "../reconcile/deps";
import type { ReconcileSettings } from "../reconcile/context";
import type { DiskSchema } from "../reconcile/store";
import { LogEngine } from "../runtime/engine";
import type { EngineTuning } from "../runtime/options";
import { CFG_BLOB_DOC, CfgSync } from "../settings/cfgSync";
import { SnapshotJob } from "../snapshots/snapshotJob";
import type { FoldedNsFrame } from "../sync/nsRuntime";
import type { BoundDocs } from "./boundDocs";
import { foldEffects } from "./foldBridge";
import type { HostLink } from "./hostLink";
import { ComposedLog } from "./logPort";
import { PassScheduler } from "./passScheduler";
import { mergeStatus, type DiskSideStatus } from "./statusMerge";
import { importSyncedMirror, SyncedMirrorWriter } from "./syncedMirror";
import * as ops from "./runtimeOps";

export type RestartReason = "retry" | "epoch" | "storage-lost" | "rebuild" | "settings";

/** What a runtime needs from the protocol engine that owns it. */
export interface RuntimeOwner {
	readonly link: HostLink;
	readonly bound: BoundDocs;
	onEpochChanged(epoch: VaultEpoch | null): void;
	onStorageLost(): void;
}

export interface VaultRuntimeStart {
	readonly engine: RuntimeOwner;
	readonly config: EngineInitConfig;
	readonly settings: EngineSettings;
	readonly ports: EnginePorts;
	readonly carrier: "worker" | "inline";
	readonly clientVersion: string;
	readonly vaultEpoch: VaultEpoch | undefined;
	readonly reason: RestartReason | null;
	readonly tuning?: Partial<EngineTuning>;
	readonly budgets?: Partial<Budgets>;
	readonly paused: boolean;
	readonly tzOffsetMinutes?: () => number;
	readonly log?: (line: string) => void;
	/** Path-keyed bases carried over an epoch migration (§c.12 step 3). */
	readonly pathBases?: ReadonlyMap<PathKey, string> | null;
	/** Old epoch whose DB is deleted once the new one reaches live (§c.12 step 6). */
	readonly retireEpoch?: VaultEpoch | null;
}

export function reconcileSettings(s: EngineSettings): ReconcileSettings {
	return { excludePatterns: s.excludePatterns, syncAttachments: s.syncAttachments, maxAttachmentBytes: s.maxAttachmentBytes, trashMode: s.trashMode };
}

type Notice = DiskSideStatus["notices"][number];

export class VaultRuntime {
	rec!: Reconciler;
	blobs!: BlobQueue;
	cfg: CfgSync | null = null;
	snaps!: SnapshotJob;
	mirror!: SyncedMirrorWriter;
	readonly port: ComposedLog;
	readonly sched: PassScheduler;
	recovered = false;
	paused: boolean;
	stopped = false;
	listingComplete = false;
	brake: BrakeReport | null = null;
	settings: EngineSettings;
	migrating = false;
	private idbSnapshotDue = false;
	private ownQueue: OwnFoldEvent[] = [];
	private readonly notices: Notice[] = [];
	private lastLog: StatusSnapshot | null = null;
	private lastFullAtMs: number | null = null;
	private cfgRunning: Promise<void> | null = null;
	private cfgAgain = false;
	private readonly offs: (() => void)[] = [];
	readonly stats = { passes: 0, ownFoldEvents: 0, retargets: 0, bindable: 0, cfgPasses: 0, snapshots: 0, bodyChanges: 0 };

	private constructor(readonly o: VaultRuntimeStart, readonly log: LogEngine) {
		this.settings = o.settings;
		this.paused = o.paused;
		this.port = new ComposedLog(log, () => this.checkBindable());
		const b = log.c.budgets;
		this.sched = new PassScheduler({
			clock: o.ports.clock,
			run: (scope) => this.runPass(scope),
			ready: () => !this.stopped && !this.paused && !this.migrating && this.listingComplete && this.rec !== undefined,
			nextBlobDueInMs: () => this.blobs?.nextDueInMs() ?? null,
			fullIntervalMs: b.fullReconcileIntervalMs,
			onError: (e) => this.diag(`pass failed: ${e instanceof Error ? e.message : String(e)}`),
		});
	}

	get engine(): RuntimeOwner {
		return this.o.engine;
	}

	get vaultEpoch(): VaultEpoch {
		return this.log.c.repo.identity.vaultEpoch;
	}

	get db(): StorageDb<DiskSchema> {
		return this.log.c.repo.db as unknown as StorageDb<DiskSchema>;
	}

	static async start(o: VaultRuntimeStart): Promise<VaultRuntime> {
		const holder: { rt: VaultRuntime | null } = { rt: null };
		const { engine, config } = o;
		const log = await LogEngine.start({
			ports: o.ports, vaultId: config.vaultId, deviceId: config.deviceId, deviceClass: config.deviceClass,
			clientVersion: o.clientVersion, vaultEpoch: o.vaultEpoch, sideFiles: engine.link.sideFiles,
			provisionalBroadcast: o.settings.provisionalBroadcast, tuning: o.tuning, budgets: o.budgets,
			onDocUpdate: (docId, update, origin) => engine.bound.push(docId, update, origin === "local" ? "merge" : origin),
			onDocFrozen: (docId, reason) => holder.rt?.onFrozen(docId, reason),
			onNsFold: (frames, reloaded) => holder.rt?.onNsFold(frames, reloaded),
			onCfgFold: () => holder.rt?.requestCfg(),
			onBodyChange: (docIds) => holder.rt?.onBodyChange(docIds),
			onOwnBodySettled: (docIds) => holder.rt?.onOwnBodySettled(docIds),
			onStatus: (s) => holder.rt?.onLogStatus(s),
		});
		const rt = new VaultRuntime(o, log);
		holder.rt = rt;
		try {
			await rt.init();
		} catch (e) {
			holder.rt = null;
			rt.stopped = true;
			rt.sched.stop();
			await log.stop().catch(() => undefined);
			throw e;
		}
		return rt;
	}

	private notice = (level: "info" | "warn" | "error", code: string, message?: string): void => {
		const n = { code, level, atMs: this.o.ports.clock.now() };
		const i = this.notices.findIndex((x) => x.code === code);
		if (i >= 0) this.notices.splice(i, 1);
		this.notices.push(n);
		if (this.notices.length > 32) this.notices.shift();
		this.engine.link.post({ t: "notice", level, code, message: message ?? code });
	};

	/** After a full unbraked pass: queued blob transfers the plan no longer wants are stale. */
	private async pruneBlobQueue(): Promise<void> {
		const want = new Set<string>();
		for (const op of this.rec.lastPlan) {
			if (op.op === "pushBlob") want.add(`up:${op.hash}`);
			else if (op.op === "fetchBlob") want.add(`down:${op.hash}`);
		}
		const intentDocs = new Set<string>();
		for (const i of this.rec.ctx.store.intents.values()) if (i.docId) intentDocs.add(i.docId);
		const n = await this.blobs.retain((q) => q.docId === CFG_BLOB_DOC || intentDocs.has(q.docId) || want.has(`${q.direction}:${q.hash}`));
		if (n > 0) this.diag(`blob queue: dropped ${n} stale transfer(s)`);
	}

	diag(line: string): void {
		this.o.log?.(line);
	}

	private async init(): Promise<void> {
		const { o, log } = this;
		const { ports, config } = o;
		const link = this.engine.link;
		const c = log.c;
		const db = this.db;
		const identity = { vaultId: config.vaultId, vaultEpoch: this.vaultEpoch, deviceId: config.deviceId };
		const imported = await importSyncedMirror({ db, side: link.sideFiles, hash: ports.hash, identity, pathKey, nowMs: ports.clock.now() });
		this.recovered = imported > 0 || c.noticeList().some((n) => n.code === "recovered-from-mirror");
		this.idbSnapshotDue = this.recovered || o.reason === "storage-lost";
		if (imported > 0) this.diag(`synced mirror imported: ${imported} records`);
		const tz = o.tzOffsetMinutes ?? (() => 0);
		this.blobs = await BlobQueue.open({ db, clock: ports.clock, crypto: ports.crypto, store: ports.blob, chunkLog: this.port.chunks, notice: this.notice });
		this.rec = await Reconciler.open({
			db, log: this.port, disk: link.disk, clock: ports.clock, random: ports.random, blobs: this.blobs,
			settings: reconcileSettings(this.settings), deviceLabel: config.deviceLabel, pathKey, tzOffsetMinutes: tz,
			notice: this.notice, onBrake: (r) => this.onBrake(r), pathBase: o.pathBases ? (k: PathKey) => o.pathBases!.get(k) ?? null : undefined,
			pathBaseKeys: o.pathBases ? new Set(o.pathBases.keys()) : undefined,
		});
		await this.rec.start();
		if (this.settings.syncSettings) {
			this.cfg = new CfgSync({ db, config: link.configDir, log: this.port.cfg, blobs: this.blobs, clock: ports.clock, notice: this.notice });
		}
		this.snaps = new SnapshotJob({
			disk: link.disk, side: link.sideFiles, clock: ports.clock, files: () => this.snapshotFiles(), settings: () => this.settings.snapshots,
			upload: ports.blob && this.settings.snapshots.uploadToBlobStore ? { store: ports.blob, crypto: ports.crypto } : null,
			pathKey, deviceLabel: config.deviceLabel, tzOffsetMinutes: tz, notice: this.notice,
		});
		this.mirror = new SyncedMirrorWriter({
			side: link.sideFiles, hash: ports.hash, clock: ports.clock, identity: () => identity,
			entries: () => this.rec.ctx.store.synced.values(), nsCoversSeq: () => c.ns.coversSeq,
			onError: (e) => this.diag(`synced mirror write failed: ${String(e)}`),
		});
		this.offs.push(c.repo.db.onLost((failure) => {
			if (this.stopped) return;
			this.diag(`storage lost: ${failure}`);
			this.engine.onStorageLost();
		}));
		if (this.lastLog?.phase === "live") this.onLogStatus(this.lastLog);
		this.sched.request({ t: "full" });
	}

	private snapshotFiles(): { path: VaultPath; kind: DocKind; size: number }[] {
		const out: { path: VaultPath; kind: DocKind; size: number }[] = [];
		for (const l of this.rec.ctx.local.values()) if (!l.excluded) out.push({ path: l.path, kind: l.kind, size: l.size });
		return out;
	}

	// ---- log callbacks --------------------------------------------------------------

	onNsFold(frames: readonly FoldedNsFrame[], reloaded: boolean): void {
		if (this.stopped) return;
		this.port.invalidate();
		const c = this.log.c;
		const bound = this.engine.bound;
		const fx = foldEffects({ frames, self: this.o.config.deviceId, committed: (d) => c.ns.state.entries.get(d), isBound: (d) => bound.isBound(d), pathKey });
		if (fx.own.length > 0) {
			this.ownQueue.push(...fx.own);
			this.stats.ownFoldEvents += fx.own.length;
		}
		for (const r of fx.retarget) {
			bound.drop(r.docId);
			this.log.unbind(r.docId);
			this.stats.retargets++;
			this.engine.link.post({ t: "docRetarget", docId: r.docId, change: { t: "merged", into: r.into } });
		}
		this.checkBindable();
		if (reloaded) this.sched.request({ t: "full" });
		else if (fx.docIds.size > 0 || fx.own.length > 0) this.sched.request({ t: "docs", docIds: [...fx.docIds], pathKeys: [...fx.pathKeys] });
	}

	/** Remote body rows / checkpoints / provisionals changed docs: project them (§f.2 docs scope). */
	onBodyChange(docIds: readonly DocId[]): void {
		if (this.stopped || docIds.length === 0) return;
		this.port.invalidate();
		const pathKeys: PathKey[] = [];
		const ns = this.log.c.ns.state.entries;
		for (const d of docIds) {
			const e = ns.get(d);
			if (e) pathKeys.push(e.pathKey);
		}
		this.stats.bodyChanges += docIds.length;
		this.sched.request({ t: "docs", docIds: [...docIds], pathKeys });
	}

	/**
	 * Own edits of unbound docs are all sequenced: a local delete waiting on them ("pending-body") can
	 * go out now with a base that covers them. Bound docs are skipped (typing settles every frame).
	 */
	onOwnBodySettled(docIds: readonly DocId[]): void {
		if (this.stopped) return;
		const ids = docIds.filter((d) => !this.engine.bound.isBound(d));
		if (ids.length === 0) return;
		this.port.invalidate();
		const ns = this.log.c.ns.state.entries;
		const pathKeys: PathKey[] = [];
		for (const d of ids) {
			const e = ns.get(d);
			if (e) pathKeys.push(e.pathKey);
		}
		this.sched.request({ t: "docs", docIds: ids, pathKeys });
	}

	onFrozen(docId: DocId, reason: string): void {
		if (!this.engine.bound.isBound(docId)) return;
		this.engine.bound.drop(docId);
		this.log.unbind(docId);
		this.engine.link.post({ t: "docRetarget", docId, change: { t: "frozen", reason } });
	}

	onLogStatus(s: StatusSnapshot): void {
		this.lastLog = s;
		if (this.stopped) return;
		if (s.phase === "live" && !this.port.nsCaughtUp && this.rec) {
			this.port.nsCaughtUp = true;
			this.port.invalidate();
			this.sched.request({ t: "full" });
			if (this.o.retireEpoch) void ops.retireOldEpoch(this, this.o.retireEpoch);
		}
		if (s.phase === "epoch-migrating" && !this.migrating) {
			this.migrating = true;
			this.engine.onEpochChanged(null);
		}
		this.postStatus();
	}

	// ---- passes ---------------------------------------------------------------------

	private async runPass(scope: PlanScope): Promise<PassReport> {
		if (this.ownQueue.length > 0) {
			const q = this.ownQueue;
			this.ownQueue = [];
			await this.rec.applyOwnFold(q);
			this.mirror.markDirty();
		}
		if (this.idbSnapshotDue) {
			// §i.5: snapshot the disk state the recovered DB is about to reconcile against.
			this.idbSnapshotDue = false;
			await this.takeSnapshot("idb");
		}
		this.port.invalidate();
		const syncedBefore = this.syncedSignature();
		const r = await this.rec.pass(scope);
		this.port.invalidate();
		this.stats.passes++;
		if (r.brake === null && this.brake !== null) {
			this.brake = null;
			this.postStatus();
		}
		if (this.syncedSignature() !== syncedBefore || r.ok > 0) this.mirror.markDirty();
		if (scope.t === "full") {
			this.lastFullAtMs = this.o.ports.clock.now();
			if (r.brake === null && this.listingComplete) await this.pruneBlobQueue();
			this.requestCfg();
			if (this.settings.snapshots.enabled) void this.snaps.maybeDaily().catch((e) => this.diag(`daily snapshot failed: ${String(e)}`));
		}
		this.checkBindable();
		this.postStatus();
		return r;
	}

	/** Cheap change detector for the synced tree (size + summed touch seqs). */
	private syncedSignature(): string {
		let n = 0;
		let h = 0;
		for (const s of this.rec.ctx.store.synced.values()) {
			n++;
			h = (h + s.nsTouchSeq * 31 + s.blobRev + (s.bodyVersion?.remoteSeq ?? 0) + s.contentHash.charCodeAt(5) + s.path.length) % 2_147_483_647;
		}
		return `${n}:${h}`;
	}

	async takeSnapshot(reason: "brake" | "epoch" | "idb" | "manual"): Promise<string | null> {
		if (!this.settings.snapshots.enabled && reason !== "manual") return null;
		try {
			const r = await this.snaps.take(reason);
			if (r) this.stats.snapshots++;
			return r?.id ?? null;
		} catch (e) {
			this.diag(`snapshot ${reason} failed: ${String(e)}`);
			return null;
		}
	}

	requestCfg(): void {
		if (!this.cfg || this.stopped || this.paused || !this.listingComplete) return;
		if (this.cfgRunning) {
			this.cfgAgain = true;
			return;
		}
		this.cfgRunning = (async () => {
			do {
				this.cfgAgain = false;
				try {
					await this.cfg!.pass();
					this.stats.cfgPasses++;
				} catch (e) {
					this.diag(`cfg pass failed: ${String(e)}`);
				}
			} while (this.cfgAgain && !this.stopped);
		})().finally(() => {
			this.cfgRunning = null;
		});
	}

	private onBrake(r: BrakeReport): void {
		const same = this.brake?.id === r.id;
		this.brake = r;
		if (!same) this.engine.link.post({ t: "brake", report: r });
		this.postStatus();
	}

	/** Paths answered `untracked` that the optimistic remote now knows: tell the host. */
	checkBindable(): void {
		const waiting = this.engine.bound.waiting;
		if (waiting.size === 0) return;
		for (const path of [...waiting]) {
			const e = ops.bindTarget(this, pathKey(path));
			if (!e || e.kind === "blob") continue;
			waiting.delete(path);
			this.stats.bindable++;
			this.engine.link.post({ t: "bindable", path });
		}
	}

	// ---- host-facing ----------------------------------------------------------------

	async observations(chunk: readonly LocalObservation[], complete: boolean): Promise<void> {
		await this.rec.onObservations(chunk, complete);
		if (!complete) return;
		const first = !this.listingComplete;
		this.listingComplete = true;
		this.sched.request({ t: "full" }, first);
		if (first) this.requestCfg();
	}

	vaultEvents(events: readonly VaultEvent[]): void {
		this.rec.onVaultEvents(events);
		const paths: PathKey[] = [];
		for (const e of events) {
			if (e.t === "rename") paths.push(pathKey(e.from), pathKey(e.to));
			else paths.push(pathKey(e.path));
		}
		this.sched.request({ t: "docs", docIds: [], pathKeys: paths });
	}

	openDoc(path: VaultPath, viewId: number): Promise<EngineResultValue> {
		return ops.openDoc(this, path, viewId);
	}

	closeDoc(docId: DocId, viewId: number): void {
		if (!this.engine.bound.remove(docId, viewId)) return;
		this.log.unbind(docId);
		this.sched.request({ t: "docs", docIds: [docId], pathKeys: [] });
	}

	fullState(docId: DocId): Uint8Array | null {
		return ops.fullState(this, docId);
	}

	localUpdate(docId: DocId, update: Uint8Array): void {
		try {
			this.log.applyLocalUpdate(docId, update);
		} catch (e) {
			this.diag(`localUpdate dropped: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	boundSaved(docId: DocId, path: VaultPath, stat: VaultStat): void {
		this.rec.onVaultEvents([{ t: "modify", path, stat }]);
		this.sched.request({ t: "docs", docIds: [docId], pathKeys: [pathKey(path)] });
	}

	lifecycle(event: LifecycleEvent): void {
		if (event === "online" || event === "resume" || event === "visible") {
			void this.log.reconnect().catch(() => undefined);
			this.sched.request({ t: "full" });
		} else if (event === "pagehide" || event === "freeze" || event === "hidden") {
			void this.log.flush().catch(() => undefined);
			void this.mirror.flush();
		}
	}

	command(c: UserCommand): Promise<EngineResultValue> {
		return ops.command(this, c);
	}

	setPaused(p: boolean): void {
		this.paused = p;
		if (p) this.log.disconnect();
		else {
			void this.log.reconnect().catch(() => undefined);
			this.sched.poke();
			this.sched.request({ t: "full" });
		}
		this.postStatus();
	}

	/** Settings that apply in place (the owner restarts for the rest). */
	updateSettings(s: EngineSettings): void {
		this.settings = s;
		this.sched.request({ t: "full" });
	}

	checkBindableNow(path: VaultPath): void {
		this.engine.bound.waiting.add(path);
		this.checkBindable();
	}

	status(): StatusSnapshot {
		const log = this.lastLog ?? this.log.status();
		return mergeStatus(log, {
			transport: this.o.carrier, paused: this.paused, migrating: this.migrating, brake: this.brake,
			pendingDiskOps: this.rec?.ctx.store.intents.size ?? 0, pendingBlobs: this.blobs?.queued().length ?? 0, conflictCopiesToday: 0,
			lastFullReconcileAtMs: this.lastFullAtMs, bootstrap: null, notices: this.notices,
		});
	}

	postStatus(): void {
		if (this.stopped) return;
		this.engine.link.post({ t: "status", status: this.status() });
	}

	/** crash: the carrier died (sim/tests): the socket goes first so nothing in flight escapes. */
	async stop(crash = false): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (crash) this.log.disconnect();
		this.sched.stop();
		await this.sched.drain().catch(() => undefined);
		if (this.cfgRunning) await this.cfgRunning.catch(() => undefined);
		for (const off of this.offs) off();
		await this.mirror?.stop();
		await this.log.stop();
	}
}
