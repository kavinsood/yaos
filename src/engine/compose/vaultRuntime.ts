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

import type { BrakeReport, ContentHash, DocId, DocKind, PathKey, PlanScope, PlannerOp, VaultEpoch, VaultPath } from "../../core/types";
import { bytesToHex } from "../../core/codec/lib0";
import { FULL_RECONCILE_IDLE_MAX_MS, type Budgets } from "../../core/limits";
import { pathKey } from "../../core/paths/pathKey";
import type { EnginePorts } from "../../ports";
import type { BlobPort } from "../../ports/blob";
import type { TimerHandle } from "../../ports/clock";
import type { StorageDb } from "../../ports/storage";
import type { SideFileName, VaultEvent, VaultStat } from "../../ports/vault";
import type { EngineInitConfig, EngineResultValue, EngineSettings, LocalObservation, UserCommand } from "../../protocol/messages";
import type { DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import type { LifecycleEvent } from "../../ports/platform";
import { BlobQueue } from "../blobs/blobQueue";
import { Reconciler, type PassReport } from "../reconcile/reconciler";
import type { OwnFoldEvent } from "../reconcile/deps";
import type { ReconcileSettings } from "../reconcile/context";
import type { DiskSchema } from "../reconcile/store";
import { LogEngine } from "../runtime/engine";
import type { EngineTuning } from "../runtime/options";
import type { MetaDocDeletes, MetaPathBase } from "../store/schema";
import { CFG_BLOB_DOC, CfgSync } from "../settings/cfgSync";
import { listLocal, partName } from "../snapshots/localStore";
import { SnapshotJob } from "../snapshots/snapshotJob";
import type { FoldedNsFrame } from "../sync/nsRuntime";
import type { BoundDisk } from "./boundDisk";
import type { BoundDocs } from "./boundDocs";
import { foldEffects } from "./foldBridge";
import type { HostKeyring } from "./hostKeyring";
import type { HostLink } from "./hostLink";
import type { EngineE2ee } from "../keyring/keyringRuntime";
import { localDay, LocalDayCounter } from "./localDayCounter";
import { EpochBases } from "./epochBases";
import { ComposedLog } from "./logPort";
import { CreatorStatus } from "./creatorStatus";
import { PassScheduler } from "./passScheduler";
import { mergeStatus, type DiskSideStatus } from "./statusMerge";
import { importSyncedMirror, SyncedMirrorWriter } from "./syncedMirror";
import { dropPending, type ResolvedIdentity } from "./storeIdentity";
import * as ops from "./runtimeOps";

/** A store's mirror files (DESIGN §e.4). */
const MIRROR_FILES: readonly SideFileName[] = ["outbox-a.bin", "outbox-b.bin", "synced-a.bin", "synced-b.bin"];

export type RestartReason = "retry" | "epoch" | "storage-lost" | "rebuild" | "settings" | "blob-store" | "revoked";

/** What a runtime needs from the protocol engine that owns it. */
export interface RuntimeOwner {
	readonly link: HostLink;
	/** The keyring main stored (null before init). */
	readonly keyring: HostKeyring | null;
	readonly bound: BoundDocs;
	readonly boundDisk: Pick<BoundDisk, "checkSaved" | "pendingConflictCopies">;
	onEpochChanged(epoch: VaultEpoch | null): void;
	onStorageLost(): void;
	/** The server refused this store (phase revoked: retired or removed): replace it if the grant still holds. */
	onStoreRevoked(): void;
	/** Started without a blob store, and a later connect found one (EngineOptions.onBlobStore): restart on it. */
	onBlobStore(store: BlobPort): void;
	/**
	 * The first runtime of an init that asks gets true: it also removes lineage dirs when its store did not inherit
	 * (dirs a crash left behind before the store that inherited from them wrote its mirrors). Absent: never.
	 */
	claimLineageSweep?(): boolean;
}

export interface VaultRuntimeStart {
	readonly engine: RuntimeOwner;
	readonly config: EngineInitConfig;
	/** The store this runtime runs on (identity-per-store §4): `self`, and the secrets a fresh DB records. */
	readonly identity: ResolvedIdentity;
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
	/** The LogEngine's diagnostics events (test hook, CreateEngineOptions.onDiag). */
	readonly onDiag?: (event: DiagnosticsEvent) => void;
	/** Test hook (sim coverage, CreateEngineOptions.observe): committed ns frames folded, and every reconcile pass's plan. */
	readonly observe?: RuntimeObserver;
	/** Path-keyed bases carried over an epoch migration (§c.12 step 3), stored in the new DB (epochBases.ts). */
	readonly pathBases?: readonly MetaPathBase[] | null;
	/** The old epoch's docs' deletes by docId (§c.12 "Deletes"), stored in the new DB (epochBases.ts). */
	readonly docDeletes?: readonly MetaDocDeletes[] | null;
}

/** Observational test hook: called after the engine acted; it must not change anything (production: absent). */
export interface RuntimeObserver {
	nsFold?(frames: readonly FoldedNsFrame[], reloaded: boolean): void;
	/** A reconcile pass ran `ops` (its executable plan) and reported `report`. */
	pass?(ops: readonly PlannerOp[], report: PassReport): void;
}

export function reconcileSettings(s: EngineSettings): ReconcileSettings {
	return { excludePatterns: s.excludePatterns, syncAttachments: s.syncAttachments, maxAttachmentBytes: s.maxAttachmentBytes, trashMode: s.trashMode };
}

type Notice = DiskSideStatus["notices"][number];

/** Phone / constrained close the socket after this long hidden (DESIGN §i.4). */
export const HIDDEN_CLOSE_MS = 30_000;
/** `online` and the relay session that follows it count as one network-back wake (networkBack). */
export const NETWORK_BACK_MIN_GAP_MS = 5_000;

export class VaultRuntime {
	rec!: Reconciler;
	blobs!: BlobQueue;
	/** The old epoch's bases by path, until their paths settle (§c.12). */
	bases!: EpochBases;
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
	/** Backgrounded (DESIGN §i.4): reconcile passes wait until visible / resume. */
	background = false;
	private hiddenTimer: TimerHandle | null = null;
	/** Monotonic time of the last networkBack wake. */
	private networkBackAtMono: number | null = null;
	private idbSnapshotDue = false;
	private ownQueue: OwnFoldEvent[] = [];
	private readonly notices: Notice[] = [];
	private readonly conflictCopies = new LocalDayCounter(() => localDay(this.o.ports.clock.now(), (this.o.tzOffsetMinutes ?? (() => 0))()));
	private lastLog: StatusSnapshot | null = null;
	private lastFullAtMs: number | null = null;
	private cfgRunning: Promise<void> | null = null;
	private cfgAgain = false;
	private readonly offs: (() => void)[] = [];
	/** Retired creators of body-less docs (DESIGN §i.5 "Abandoned creates"). */
	readonly creators: CreatorStatus;
	readonly stats = { passes: 0, ownFoldEvents: 0, retargets: 0, bindable: 0, cfgPasses: 0, snapshots: 0, bodyChanges: 0 };

	private constructor(readonly o: VaultRuntimeStart, readonly log: LogEngine) {
		this.settings = o.settings;
		this.paused = o.paused;
		const status = o.ports.identity?.status?.bind(o.ports.identity) ?? null;
		this.creators = new CreatorStatus({
			status, mono: () => log.c.mono(), setTimer: (ms, fn) => o.ports.clock.setTimer(ms, fn), clearTimer: (h) => o.ports.clock.clearTimer(h),
			graceMs: log.c.tuning.abandonedCreateGraceMs, recheckMs: log.c.tuning.creatorStatusRecheckMs, recheckMaxMs: log.c.tuning.creatorStatusRecheckMaxMs,
			onAbandoned: () => {
				this.port.invalidate();
				this.sched.request({ t: "full" });
			},
			diag: (line) => this.diag(line),
		});
		this.port = new ComposedLog(log, () => this.checkBindable(), this.creators);
		const b = log.c.budgets;
		this.sched = new PassScheduler({
			clock: o.ports.clock,
			run: (scope) => this.runPass(scope),
			ready: () => !this.stopped && !this.paused && !this.migrating && !this.background && this.listingComplete && this.rec !== undefined,
			nextBlobDueInMs: () => this.blobs?.nextDueInMs() ?? null,
			fullIntervalMs: b.fullReconcileIntervalMs,
			fullIdleMaxMs: FULL_RECONCILE_IDLE_MAX_MS,
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
		return this.log.c.repo.db;
	}

	static async start(o: VaultRuntimeStart): Promise<VaultRuntime> {
		const holder: { rt: VaultRuntime | null } = { rt: null };
		const { engine, config } = o;
		const log = await LogEngine.start({
			ports: o.ports, vaultId: config.vaultId, deviceId: o.identity.creds.deviceId, deviceClass: config.deviceClass,
			store: {
				installKey: config.installKey, deviceToken: o.identity.creds.deviceToken, retireKey: o.identity.creds.retireKey,
				// A pending identity is consumed right before its store is created (storeIdentity.ts).
				...(o.identity.source === "pending" ? { beforeCreate: () => dropPending(o.ports.storage, config.vaultId, config.installKey) } : {}),
			},
			...(o.identity.lineage ? { lineage: o.identity.lineage } : {}),
			inherit: o.identity.inherit ?? null,
			supersedes: o.identity.supersedes ?? null,
			lineageSideFiles: (deviceId) => engine.link.sideFilesOf(deviceId),
			clientVersion: o.clientVersion, vaultEpoch: o.vaultEpoch, sideFiles: engine.link.sideFiles, pathBases: o.pathBases ?? null, docDeletes: o.docDeletes ?? null,
			provisionalBroadcast: o.settings.provisionalBroadcast, tuning: o.tuning, budgets: o.budgets,
			onBoundText: (docId, changes, length, origin) => engine.bound.onText(docId, changes, length, origin),
			onFrameTaken: (docId) => engine.bound.frameTaken(docId),
			onDocFrozen: (docId, reason) => holder.rt?.onFrozen(docId, reason),
			onNsFold: (frames, reloaded) => holder.rt?.onNsFold(frames, reloaded),
			onCfgFold: () => holder.rt?.requestCfg(),
			onBodyChange: (docIds) => holder.rt?.onBodyChange(docIds),
			onOwnBodySettled: (docIds) => holder.rt?.onOwnBodySettled(docIds),
			onStatus: (s) => holder.rt?.onLogStatus(s),
			...(o.onDiag ? { onDiag: o.onDiag } : {}),
			onHostNotice: (level, code, message) => engine.link.post({ t: "notice", level, code, message }),
			e2ee: e2eeOf(config.crypto, engine.keyring),
			blobBytes: (hash) => holder.rt?.localBlobBytes(hash) ?? Promise.resolve(null),
			onBlobStore: (store) => engine.onBlobStore(store),
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
		const remote = this.port.view().remote;
		for (const op of this.rec.lastPlan) {
			if (op.op === "pushBlob") want.add(`up:${op.hash}`);
			else if (op.op === "fetchBlob") want.add(`down:${op.hash}`);
			else if (op.op === "diskMaterialize") {
				const r = remote.get(op.docId);
				if (r?.state === "live" && r.blob) want.add(`down:${r.blob.hash}`);
			}
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
		const identity = { vaultId: config.vaultId, vaultEpoch: this.vaultEpoch, deviceId: o.identity.creds.deviceId };
		const imported = await importSyncedMirror({ db, side: link.sideFiles, hash: ports.hash, identity, pathKey, nowMs: ports.clock.now() });
		this.recovered = imported > 0 || c.noticeList().some((n) => n.code === "recovered-from-mirror");
		this.idbSnapshotDue = this.recovered || o.reason === "storage-lost";
		if (imported > 0) this.diag(`synced mirror imported: ${imported} records`);
		const tz = o.tzOffsetMinutes ?? (() => 0);
		// The write-gated, link-aborted ports (context.ts): no attachment or snapshot-part upload while the keyring
		// reports key-missing; every transfer in flight ends when the session loop declares the link dead.
		const { crypto, blob } = c.deps;
		this.blobs = await BlobQueue.open({
			db, clock: ports.clock, crypto, hash: ports.hash, store: blob, touch: c.touch, notice: this.notice, diag: (l) => this.diag(l),
			budgetBytes: c.budgets.blobBytesInFlight,
			// Transfers start when a pass could run (pump() on unpause / foreground / online); running ones finish.
			admit: () => !this.stopped && !this.paused && !this.migrating && !this.background,
			wake: (who) => this.sched.request({ t: "docs", docIds: who.map((w) => w.docId), pathKeys: who.map((w) => pathKey(w.path)) }),
		});
		const bases = (this.bases = await EpochBases.load(c.repo, ports.hash));
		if (bases.keys.size > 0) this.diag(`epoch bases: ${bases.keys.size} path(s)`);
		this.rec = await Reconciler.open({
			db, log: this.port, disk: link.disk, clock: ports.clock, random: ports.random, hash: ports.hash, blobs: this.blobs,
			settings: reconcileSettings(this.settings), deviceLabel: config.deviceLabel, pathKey, tzOffsetMinutes: tz,
			notice: this.notice, onBrake: (r) => this.onBrake(r), onConflictCopy: () => this.conflictCopies.add(), onRebind: (from, into) => this.retarget(from, into),
			pathBase: (k: PathKey) => bases.get(k), pathBaseKeys: bases.keys, pathDeleted: (k: PathKey) => bases.deleted(k),
			docDeletes: (d) => bases.docDeletes(d), docDeletesApplied: (d) => bases.applied(d),
			boundSavedText: (docId, text) => {
				const b = o.engine.bound.get(docId);
				return b !== undefined && (text === b.diskText || b.candidates.includes(text));
			},
			takeOwnFold: () => this.takeOwnFold(),
			stopping: () => this.stopped,
		});
		await this.rec.start();
		if (this.settings.syncSettings) {
			this.cfg = new CfgSync({ db, config: link.configDir, log: this.port.cfg, blobs: this.blobs, clock: ports.clock, hash: ports.hash, notice: this.notice, mobile: config.platform.isMobile, seed: this.settings.syncSettingsSeed, remoteReady: () => this.port.nsCaughtUp, upgradeRequired: () => this.log.c.cfg.halted?.upgrade === true });
		}
		this.snaps = new SnapshotJob({
			disk: link.disk, side: link.sideFiles, clock: ports.clock, crypto, hash: ports.hash, files: () => this.snapshotFiles(), settings: () => this.settings.snapshots,
			remote: blob ? { store: blob, index: this.port.snap, touch: c.touch } : null,
			pathKey, deviceLabel: config.deviceLabel, tzOffsetMinutes: tz, notice: this.notice, diag: (l) => this.diag(l),
		});
		this.mirror = new SyncedMirrorWriter({
			side: link.sideFiles, hash: ports.hash, clock: ports.clock, identity: () => identity,
			entries: () => this.rec.ctx.store.synced.values(), nsCoversSeq: () => c.ns.coversSeq,
			onError: (e) => this.diag(`synced mirror write failed: ${String(e)}`),
			before: () => c.mirror.flushed(),
			onWritten: () => void this.dropLineageDirs(),
		});
		this.offs.push(c.repo.db.onLost((failure) => {
			if (this.stopped) return;
			this.diag(`storage lost: ${failure}`);
			this.engine.onStorageLost();
		}));
		if (this.lastLog?.phase === "live" || this.lastLog?.phase === "upgrade-required") this.onLogStatus(this.lastLog);
		this.sched.request({ t: "full" });
	}

	/**
	 * identity-per-store §5.2 step 7: once this store's outbox and synced mirrors are on disk they replace its lineage
	 * predecessors' (recovery reads the newest dir with a mirror, and this store's mirror holds whatever it inherited),
	 * so their dirs go: the mirror files and the local snapshots (copied into this store's dir at recovery). Only this
	 * install's earlier stores (the lineage), never a foreign dir. Once, in the runtime of a store this start created
	 * with a lineage; and once per init in any runtime (claimLineageSweep, phase 5's orphan sweep): a dir a crash left
	 * behind after the import but before this store's first mirror write. Safe then too: a running store has finished
	 * any import it was created with (LogEngine.start runs it, and MetaIdentity.inherit is cleared in the import's
	 * transaction), and its own mirrors, just written, hold everything it inherited. Best effort.
	 */
	private lineageDropped = false;
	private async dropLineageDirs(): Promise<void> {
		if (this.lineageDropped || this.stopped) return;
		const sweep = this.o.identity.inherit ? true : this.engine.claimLineageSweep?.() ?? false;
		const lineage = sweep ? [...(this.o.identity.lineage ?? [])] : [];
		if (lineage.length === 0) return;
		this.lineageDropped = true;
		const link = this.engine.link;
		let n = 0;
		for (const dir of lineage) {
			try {
				const side = link.sideFilesOf(dir);
				const names: SideFileName[] = [...MIRROR_FILES, ...(await side.list("snapshots/"))];
				for (const name of names) {
					await side.remove(name);
					n++;
				}
			} catch (e) {
				this.diag(`lineage dir ${dir.slice(0, 8)}: ${String(e)}`);
			}
		}
		if (n > 0) this.diag(`lineage dirs: removed ${n} file(s)`);
	}

	/**
	 * Local plaintext of blob `hash` (EngineOptions.blobBytes: e2ee-design §10.4 R3 / R4 re-uploads), checked
	 * against it: a vault file the local tree has at that hash, a config file the cfg view stores as that blob, or
	 * a part of an own local snapshot. null = none here.
	 */
	async localBlobBytes(hash: ContentHash): Promise<Uint8Array | null> {
		if (this.stopped || !this.rec) return null;
		const { ports } = this.o;
		const link = this.engine.link;
		const check = async (bytes: Uint8Array | null | undefined): Promise<Uint8Array | null> =>
			bytes && bytesToHex(await ports.hash.sha256(bytes)) === hash ? bytes : null;
		for (const l of this.rec.ctx.local.values()) {
			if (l.excluded || l.kind !== "blob" || l.hash !== hash) continue;
			const r = await this.rec.ctx.read(l.diskPath, l.size).catch(() => null);
			const got = await check(r?.ok ? r.bytes : null);
			if (got) return got;
		}
		const c = this.log.c;
		for (const [file, reg] of c.cfg.view(c.outbox).files) {
			if (reg.value?.content.t !== "blob" || reg.value.content.hash !== hash) continue;
			const got = await check(await link.configDir.readBytes(file).catch(() => null));
			if (got) return got;
		}
		for (const s of await listLocal(link.sideFiles).catch(() => [])) {
			for (let i = 0; i < s.record.parts.length; i++) {
				if (s.record.parts[i]!.sha256 !== hash) continue;
				const got = await check(await link.sideFiles.read(partName(s.id, i)).catch(() => null));
				if (got) return got;
			}
		}
		return null;
	}

	private snapshotFiles(): { path: VaultPath; kind: DocKind; size: number }[] {
		const out: { path: VaultPath; kind: DocKind; size: number }[] = [];
		for (const l of this.rec.ctx.local.values()) if (!l.excluded) out.push({ path: l.path, kind: l.kind, size: l.size });
		return out;
	}

	// ---- log callbacks --------------------------------------------------------------

	onNsFold(frames: readonly FoldedNsFrame[], reloaded: boolean): void {
		if (this.stopped) return;
		this.o.observe?.nsFold?.(frames, reloaded);
		this.port.invalidate();
		const c = this.log.c;
		const bound = this.engine.bound;
		const fx = foldEffects({ frames, self: this.o.identity.creds.deviceId, committed: (d) => c.ns.state.entries.get(d), isBound: (d) => bound.isBound(d), pathKey });
		if (fx.own.length > 0) {
			this.ownQueue.push(...fx.own);
			this.stats.ownFoldEvents += fx.own.length;
		}
		for (const r of fx.retarget) this.retarget(r.docId, r.into);
		this.checkBindable();
		if (reloaded) this.sched.request({ t: "full" });
		else if (fx.docIds.size > 0 || fx.own.length > 0) this.sched.request({ t: "docs", docIds: [...fx.docIds], pathKeys: [...fx.pathKeys] });
	}

	/**
	 * A bound doc's identity moved to `into` (merged alias fold, planner rebind), or the fold pruned it (null: the
	 * doc is dead, sim smallPrune seed 169): the host re-opens its views by path.
	 */
	private retarget(docId: DocId, into: DocId | null): void {
		const b = this.engine.bound.get(docId);
		if (!b) return;
		this.engine.bound.drop(docId);
		this.log.unbind(docId);
		this.stats.retargets++;
		this.engine.link.post({ t: "docRetarget", docId, change: into ? { t: "merged", into } : { t: "renamed", path: b.path } });
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
		this.checkBindable(); // a body that arrived or a doc released (quarantineRelease.ts) may bind now
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
		this.port.invalidate(); // view() carries body.frozen: a stale one re-binds the doc (openDoc) and loops on attach
		if (!this.engine.bound.isBound(docId)) return;
		this.engine.bound.drop(docId);
		this.log.unbind(docId);
		this.engine.link.post({ t: "docRetarget", docId, change: { t: "frozen", reason } });
	}

	onLogStatus(s: StatusSnapshot): void {
		const was = this.lastLog?.phase;
		const wasConnected = this.lastLog?.relay.connected ?? false;
		this.lastLog = s;
		if (this.stopped) return;
		// Writes are back (a re-key settled the vault key): the passes that failed on the write gate meanwhile only
		// retry on their backoff (up to a minute), so plan the vault now; local deletes and edits made while
		// key-missing go out at once.
		if (was === "key-missing" && s.phase !== "key-missing" && this.rec) this.sched.request({ t: "full" }, true);
		if (s.relay.connected && !wasConnected) this.networkBack();
		if (s.phase === "revoked" && was !== "revoked") this.engine.onStoreRevoked();
		// upgrade-required with a session: a fold is halted for a newer writer (§c.10) and the session caught up;
		// the planner's nsReady and the cfg / snap readiness still see that fold's halt. daily-limit with a session: the
		// session caught up under the relay's daily hold (the engine never leaves catching-up for it before the start
		// reads end); local edits keep filling the outbox (DESIGN §i.6), so the planner runs as when live. Without
		// it a store that catches up during the hold plans nothing until it lifts (soak 1622834076 run 157).
		const caughtUp = s.phase === "live" || ((s.phase === "upgrade-required" || s.phase === "daily-limit") && s.relay.connected);
		if (caughtUp && !this.port.nsCaughtUp && this.rec) {
			this.port.nsCaughtUp = true;
			this.port.invalidate();
			this.sched.request({ t: "full" });
			// Once per runtime, in order: this install's other-epoch stores, then the orphan stores of lost install keys.
			void ops.retireOldEpochs(this).then(() => ops.sweepOrphanStores(this));
		}
		if (s.phase === "epoch-migrating" && !this.migrating) {
			this.migrating = true;
			this.engine.onEpochChanged(null);
		}
		this.postStatus();
	}

	// ---- passes ---------------------------------------------------------------------

	/** S1 events for the reconciler, which applies them right before a plan reads the view. */
	private takeOwnFold(): readonly OwnFoldEvent[] {
		const q = this.ownQueue;
		if (q.length === 0) return q;
		this.ownQueue = [];
		this.mirror.markDirty();
		return q;
	}

	private async runPass(scope: PlanScope): Promise<PassReport> {
		if (this.idbSnapshotDue) {
			// §i.5: snapshot the disk state the recovered DB is about to reconcile against.
			this.idbSnapshotDue = false;
			await this.takeSnapshot("idb");
		}
		this.port.invalidate();
		const syncedBefore = this.syncedSignature();
		const r = await this.rec.pass(scope);
		this.o.observe?.pass?.(this.rec.lastPlan, r);
		this.port.invalidate();
		this.stats.passes++;
		// Only a full pass clears the brake: a docs-scoped pass that planned none of the held units returns no brake
		// either, and clearing on it made the user's approve / reject of the report shown a no-op (runtimeOps checks
		// rt.brake.id) while the held ops waited for the next periodic full pass (sim storms, mass-overwrite).
		if (r.brake === null && this.brake !== null && scope.t === "full") {
			this.brake = null;
			this.postStatus();
		}
		if (this.syncedSignature() !== syncedBefore || r.ok > 0) this.mirror.markDirty();
		if (scope.t === "full") {
			this.lastFullAtMs = this.o.ports.clock.now();
			const settled = await this.bases.settle(this.port.view(), this.rec.ctx.store.synced.values(), (k) => this.rec.ctx.local.has(k));
			if (settled > 0) this.diag(`epoch bases: ${settled} path(s) settled, ${this.bases.keys.size} left`);
			if (r.brake === null && this.listingComplete) await this.pruneBlobQueue();
			this.requestCfg();
			if (this.settings.snapshots.enabled) void this.snaps.maybeDaily().catch((e) => this.diag(`daily snapshot failed: ${String(e)}`));
		}
		this.retargetCreatedUnderViews();
		this.checkBindable();
		this.postStatus();
		return r;
	}

	/**
	 * The pass created a doc for the file a bound doc's views show (a local rename of the open note that lost to a
	 * concurrent remote move: the doc went to the remote's path, the renamed file became a new doc). The views now
	 * show that doc's file, so they re-open on it; the old doc, unbound, gets its own file written again (an
	 * editor's save would only ever reach the view's file; sim DEV3 F seed 452).
	 */
	private retargetCreatedUnderViews(): void {
		const bound = this.engine.bound;
		if (bound.size === 0) return;
		for (const op of this.rec.lastPlan) {
			if (op.op !== "nsCreate") continue;
			const key = pathKey(op.path);
			if (this.rec.ctx.synced(op.docId)?.pathKey !== key) continue;
			for (const b of [...bound.byId.values()]) {
				if (b.docId === op.docId || pathKey(b.path) !== key) continue;
				this.retarget(b.docId, op.docId);
				this.sched.request({ t: "docs", docIds: [b.docId], pathKeys: [] });
			}
		}
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

	/** Paths answered `untracked` that the optimistic remote now knows, or a frozen bind whose doc thawed: tell the host. */
	checkBindable(): void {
		const waiting = this.engine.bound.waiting;
		if (waiting.size === 0) return;
		for (const path of [...waiting]) {
			const e = ops.bindTarget(this, pathKey(path));
			if (!e || e.kind === "blob" || e.body?.frozen) continue;
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

	boundSaved(docId: DocId, path: VaultPath, stat: VaultStat): void {
		this.rec.onVaultEvents([{ t: "modify", path, stat }]);
		this.sched.request({ t: "docs", docIds: [docId], pathKeys: [pathKey(path)] });
	}

	/**
	 * DESIGN §i.4. hidden: flush; phone / constrained also pause background work and close the socket after
	 * HIDDEN_CLOSE_MS (desktop and tablet keep syncing: an occluded desktop window reports hidden too).
	 * pagehide / freeze: flush, pause, close now. visible / resume: reconnect at once, full pass.
	 * Background closes keep the phase and never back off; the user's pause wins over visible / online.
	 */
	lifecycle(event: LifecycleEvent): void {
		switch (event) {
			case "hidden":
			case "pagehide":
			case "freeze": {
				void this.log.flush().catch(() => undefined);
				void this.mirror.flush();
				const mobile = this.o.config.deviceClass === "phone" || this.o.config.deviceClass === "constrained";
				if (event === "hidden" && !mobile) return;
				this.setBackground(true);
				if (event !== "hidden") {
					this.clearHiddenTimer();
					this.log.park();
				} else if (this.hiddenTimer === null) {
					this.hiddenTimer = this.o.ports.clock.setTimer(HIDDEN_CLOSE_MS, () => {
						this.hiddenTimer = null;
						this.log.park();
					});
				}
				return;
			}
			case "visible":
			case "resume":
				this.clearHiddenTimer();
				this.setBackground(false);
				void this.log.wake().catch(() => undefined);
				this.sched.poke();
				this.sched.request({ t: "full" });
				return;
			case "offline":
				void this.log.setNetwork(false);
				return;
			case "online":
				void this.log.setNetwork(true).catch(() => undefined);
				this.networkBack();
				this.blobs?.pump();
				this.sched.request({ t: "full" });
				return;
		}
	}

	/**
	 * The network came back (lifecycle `online`, or a relay session after none): blob transfers, unresolved body refs
	 * and held frames' blob re-PUTs that are waiting out a backoff retry now, not up to BLOB_RETRY_MAX_MS later.
	 * Attempt counts are kept, so a failure that persists keeps backing off. `online` and the session that follows
	 * it arrive together: one wake per NETWORK_BACK_MIN_GAP_MS.
	 */
	private networkBack(): void {
		const mono = this.o.ports.clock.monotonic();
		if (this.networkBackAtMono !== null && mono - this.networkBackAtMono < NETWORK_BACK_MIN_GAP_MS) return;
		this.networkBackAtMono = mono;
		this.log.retryBlobsNow();
		if ((this.blobs?.retryNow() ?? 0) > 0) this.sched.request({ t: "full" });
	}

	private setBackground(on: boolean): void {
		this.background = on;
		this.log.setBackground(on);
		if (!on) this.blobs?.pump();
	}

	private clearHiddenTimer(): void {
		if (this.hiddenTimer !== null) this.o.ports.clock.clearTimer(this.hiddenTimer);
		this.hiddenTimer = null;
	}

	command(c: UserCommand): Promise<EngineResultValue> {
		return ops.command(this, c);
	}

	setPaused(p: boolean): void {
		this.paused = p;
		if (p) this.log.disconnect();
		else {
			void this.log.reconnect().catch(() => undefined);
			this.blobs?.pump();
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
			pendingDiskOps: this.rec?.ctx.store.intents.size ?? 0, pendingBlobs: this.blobs?.queued().length ?? 0, conflictCopiesToday: this.conflictCopies.value,
			lastFullReconcileAtMs: this.lastFullAtMs, bootstrap: null, maxBlobBytes: this.blobs?.maxBlobBytes ?? null, notices: this.notices,
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
		this.clearHiddenTimer();
		this.creators.stop();
		if (crash) this.log.disconnect();
		this.sched.stop();
		// Transfers end at once (aborted; no pass job awaits one); the pass in flight starts no further job.
		const blobs = this.blobs?.stop();
		await this.sched.drain().catch(() => undefined);
		if (this.cfgRunning) await this.cfgRunning.catch(() => undefined);
		await blobs?.catch(() => undefined);
		for (const off of this.offs) off();
		await this.mirror?.stop();
		await this.log.stop();
	}
}

/**
 * init.crypto -> EngineOptions.e2ee (e2ee-design §12.4, §18.4). Suite-1 keys reach the crypto port in makePorts,
 * not here; the records are the set main holds now (a runtime started after a keyring change sees it). The gate
 * builds no runtime for an unpinned device (pinGate.ts).
 */
function e2eeOf(crypto: EngineInitConfig["crypto"], keyring: HostKeyring | null): EngineE2ee {
	if (crypto.suite === 0) return { suite: 0 };
	if (crypto.suite === 1 && keyring) return { suite: 1, records: keyring.records, persist: keyring.persist };
	throw new Error("e2ee: an unpinned device has no vault runtime");
}
