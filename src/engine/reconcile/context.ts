/**
 * Shared state and helpers of the disk side. The Reconciler (reconciler.ts) is
 * the public face; jobs (diskJobs.ts, mergeJob.ts), the scan (scan.ts), intent
 * resume (intents.ts) and the plan runner (runner.ts) all work on one Ctx.
 */

import type {
	BrakeConfig, BrakeReport, DocId, DocKind, LocalEntry, MergeLimits, ObservedRename, PathKey, PathKeyFn, Seq, SyncedEntry, VaultPath,
} from "../../core/types";
import { DEFAULT_BRAKE, type BrakeWindow, type DestructiveKind } from "../../core/plan/brake";
import { conflictCopyNotice } from "../../core/plan/conflictName";
import { DEFAULT_MERGE_LIMITS } from "../../core/merge/merge";
import { standInPathKey } from "../../core/plan/pathRules";
import type { ClockPort } from "../../ports/clock";
import type { HashPort } from "../../ports/crypto";
import type { RandomPort } from "../../ports/random";
import type { TrashMode, VaultStat } from "../../ports/vault";
import { LANE, type DiskOp, type DiskReadResult, type Lane } from "../../protocol/messages";
import type { SyncedRecord } from "../store/schema";
import type { DiskGateway, ExecResult, LogPort, OwnFoldEvent } from "./deps";
import { EchoTable } from "./echo";
import { classify, compileExcludes, toRecord, type Classified, type ClassifySettings } from "./localState";
import type { DiskChange, DiskSchema, ReconcileStore } from "./store";
import type { StorageDb } from "../../ports/storage";

/** One blob a job moves: content `hash` (sha256 hex of the plaintext) for `docId` at `path`, `size` bytes. */
export interface BlobReq {
	readonly hash: string;
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly size: number;
}

/** Where an upload reads its bytes when it starts (blobJobs.ts pushBlob). */
export interface UploadSource {
	/** The file's bytes now; null = unreadable or gone (the path is marked for a re-hash). */
	read(): Promise<Uint8Array | null>;
	/** The bytes read no longer hash to the claimed hash: the file changed under the upload (re-hash it). */
	changed(): void;
}

/**
 * A job's claim on an upload. stored = readers can fetch the hash (the store confirmed it): the job submits the
 * ns op referencing it. busy = started or joined in the background; the doc is planned again when it settles.
 * unavailable = failed recently (backing off) or no store. refused = the store refused these bytes by size for
 * good (the job holds; no retry).
 */
export type UploadClaim = "stored" | "busy" | "unavailable" | "refused";

/** A job's claim on a download: the verified bytes (single use), busy (as for uploads), or unavailable. */
export type DownloadClaim = { readonly t: "bytes"; readonly bytes: Uint8Array } | { readonly t: "busy" } | { readonly t: "unavailable" };

/**
 * What the disk side needs from the blob store (src/engine/blobs/blobQueue.ts implements it). Plan jobs claim
 * transfers and never wait on one: a transfer runs in the background and its docs are planned again when it
 * settles, so a 100 MB attachment does not hold up the pass (the plan runner runs jobs one by one).
 */
export interface BlobTransfer {
	/** Largest blob the store takes; 0 = no blob store (attachments are not synced, nothing is queued). */
	readonly maxBlobBytes: number;
	claimUpload(req: BlobReq, source: UploadSource): UploadClaim;
	claimDownload(req: BlobReq): DownloadClaim;
	/** A pass begins; returns its token for endPass. */
	beginPass?(): number;
	/** The pass ended: downloads ready before it began for docs it covered, and taken by no job, are stale (dropped). */
	endPass?(token: number, covers: (docId: DocId, path: VaultPath) => boolean): void;
	/** Awaited upload (settings sync, small files): true once readers can fetch `hash`; false = failed now (queued for retry), or no store. */
	upload(req: { readonly hash: string; readonly docId: DocId; readonly path: VaultPath; readonly bytes: Uint8Array }): Promise<boolean>;
	/** Awaited download (settings sync): verified bytes, or null = unavailable now (queued with backoff). */
	download(req: BlobReq): Promise<Uint8Array | null>;
}

export interface ReconcileSettings {
	readonly excludePatterns: readonly string[];
	readonly syncAttachments: boolean;
	readonly maxAttachmentBytes: number;
	readonly trashMode: TrashMode;
}

export interface ReconcilerDeps {
	readonly db: StorageDb<DiskSchema>;
	readonly log: LogPort;
	readonly disk: DiskGateway;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	/** Every content hash the disk side takes (file reads, bases, canvas projections, brake ids). */
	readonly hash: HashPort;
	readonly blobs: BlobTransfer | null;
	readonly settings: ReconcileSettings;
	readonly deviceLabel: string;
	readonly pathKey?: PathKeyFn;
	/** Local time zone offset in minutes for conflict names (core may not read Date). */
	readonly tzOffsetMinutes?: () => number;
	readonly brake?: BrakeConfig;
	readonly maxDiskIoBytesInFlight?: number;
	readonly mergeLimits?: MergeLimits;
	readonly notice?: (level: "info" | "warn" | "error", code: string, message: string) => void;
	readonly onBrake?: (report: BrakeReport) => void;
	/** Sync completed a conflict copy `to` of `from` (status `conflictCopiesToday`). */
	readonly onConflictCopy?: (from: VaultPath, to: VaultPath) => void;
	/**
	 * A rebind moved the synced record of `from` to `into` (§c.13 merged alias, identical-loser collapse,
	 * §c.12 migrated loser): an editor bound to `from` must re-open as `into`, or its typing keeps going
	 * to the loser while the file is the winner's.
	 */
	readonly onRebind?: (from: DocId, into: DocId) => void;
	/** Path-keyed base text carried over a vaultEpoch migration (§c.12 step 3); null = none. */
	readonly pathBase?: (key: PathKey) => string | null;
	/** The keys `pathBase` answers for (the planner's migrated-loser merge). */
	readonly pathBaseKeys?: ReadonlySet<PathKey>;
	/**
	 * A bound doc's replica already holds `text` (canonical): a save of one of its editors read it, or it is the
	 * last disk text the replica absorbed (boundDisk). Such a disk side is not an edit: the merge base is the text.
	 */
	readonly boundSavedText?: (docId: DocId, text: string) => boolean;
	/**
	 * Own ns ops folded since the last call (S1, §c.13), handed over and forgotten. A pass applies them right
	 * before its plan reads the view, so no plan sees a folded own op without its synced update.
	 */
	readonly takeOwnFold?: () => readonly OwnFoldEvent[];
	/**
	 * true = the runtime is stopping: the plan runner starts no further job, so a restart (settings, epoch) does
	 * not wait out a long plan. Stopping between jobs is a subset of crashing between them (DESIGN §f.2).
	 */
	readonly stopping?: () => boolean;
}

export const BRAKE_WINDOW_MS = 10 * 60_000;

/** A DiskOp without its opId (assigned by Ctx.exec). */
type WithoutOpId<T> = T extends unknown ? Omit<T, "opId"> : never;
export type DiskOpSpec = WithoutOpId<DiskOp>;

export class Ctx {
	readonly pk: PathKeyFn;
	readonly local = new Map<PathKey, LocalEntry>();
	localComplete = false;
	readonly echo: EchoTable;
	renames: ObservedRename[] = [];
	readonly brake: BrakeConfig;
	readonly mergeLimits: MergeLimits;
	brakeApproval: string | null = null;
	/**
	 * Creates are live (DESIGN §d.4): set after the first full pass with the namespace ready and the scan complete.
	 * Until then (onboarding, the first pass after every start) creates keep their body frames held until they fold.
	 */
	liveCreates = false;
	readonly classifySettings: ClassifySettings;
	private readonly excludes: (p: VaultPath) => boolean;
	private readonly destructive: { kind: DestructiveKind; at: number }[] = [];
	private opId = 0;
	private readonly noticed = new Set<string>();
	private copies: { readonly from: VaultPath; readonly to: VaultPath }[] = [];

	constructor(readonly deps: ReconcilerDeps, readonly store: ReconcileStore) {
		this.pk = deps.pathKey ?? standInPathKey;
		this.echo = new EchoTable(this.pk, () => deps.clock.monotonic());
		this.brake = deps.brake ?? DEFAULT_BRAKE;
		this.mergeLimits = deps.mergeLimits ?? DEFAULT_MERGE_LIMITS;
		this.classifySettings = {
			excludePatterns: deps.settings.excludePatterns,
			syncAttachments: deps.settings.syncAttachments,
			maxAttachmentBytes: deps.settings.maxAttachmentBytes,
			maxBlobBytes: deps.blobs?.maxBlobBytes ?? 0,
		};
		this.excludes = compileExcludes(deps.settings.excludePatterns);
	}

	get log(): LogPort { return this.deps.log; }
	now(): number { return this.deps.clock.now(); }

	notice(level: "info" | "warn" | "error", code: string, message: string, onceKey?: string): void {
		if (onceKey !== undefined) {
			if (this.noticed.has(onceKey)) return;
			this.noticed.add(onceKey);
		}
		this.deps.notice?.(level, code, message);
	}

	classify(diskPath: string, size: number): Classified {
		return classify(diskPath, size, this.classifySettings, this.excludes, this.pk);
	}

	localAt(path: VaultPath): LocalEntry | undefined {
		return this.local.get(this.pk(path));
	}

	/** Exact on-disk spelling for a planner path (NFD-safe). */
	diskPathOf(path: VaultPath): string {
		return this.localAt(path)?.diskPath ?? path;
	}

	async exec(spec: DiskOpSpec, lane: Lane = LANE.background): Promise<ExecResult> {
		const op = { ...spec, opId: ++this.opId } as DiskOp;
		const [res] = await this.deps.disk.exec([op], lane);
		if (!res) throw new Error("disk gateway returned no result");
		return res;
	}

	async read(path: string, maxBytes: number, lane: Lane = LANE.background): Promise<DiskReadResult> {
		const [res] = await this.deps.disk.read([{ area: "vault", path, maxBytes }], lane);
		if (!res) throw new Error("disk gateway returned no read result");
		return res;
	}

	/** LocalEntry after a write/rename the engine performed itself (hash known). */
	localEntry(path: VaultPath, stat: VaultStat, kind: DocKind, hash: LocalEntry["hash"], fingerprint: LocalEntry["fingerprint"]): LocalEntry {
		return {
			diskPath: stat.path, path, pathKey: this.pk(path), kind, size: stat.size, mtimeMs: stat.mtimeMs,
			hash, fingerprint, hashedAtMs: this.now(), excluded: false, bound: false,
		};
	}

	/** Commit store changes plus local-tree entries; the in-memory tree follows only on success. */
	async commit(change: DiskChange, local: readonly LocalEntry[] = [], localRemove: readonly PathKey[] = []): Promise<void> {
		await this.store.commit({ ...change, localPut: [...(change.localPut ?? []), ...local.map(toRecord)], localDrop: [...(change.localDrop ?? []), ...localRemove] });
		for (const k of localRemove) this.local.delete(k);
		for (const e of local) this.local.set(e.pathKey, e);
	}

	synced(docId: DocId): SyncedRecord | undefined {
		return this.store.synced.get(docId);
	}

	record(e: SyncedEntry): SyncedRecord {
		return { ...e, syncedAtMs: this.now() };
	}

	/** nsTouchSeq for a synced write: the view's lastTouchSeq unless own ns ops are pending (S1 sets it on fold). */
	touchSeq(docId: DocId): Seq {
		const r = this.log.view().remote.get(docId);
		if (!r || r.pendingLocal) return this.synced(docId)?.nsTouchSeq ?? 0;
		return r.lastTouchSeq;
	}

	noteDestructive(kind: DestructiveKind): void {
		this.destructive.push({ kind, at: this.deps.clock.monotonic() });
	}

	/** Sync wrote a conflict copy `to` of `from` (restore copies do not come here). */
	noteConflictCopy(from: VaultPath, to: VaultPath): void {
		this.noteDestructive("conflict");
		this.copies.push({ from, to });
		this.deps.onConflictCopy?.(from, to);
	}

	/** One warn for the conflict copies written since the last call (end of a pass): the count and the first path. */
	flushConflictCopies(): void {
		const first = this.copies[0];
		if (!first) return;
		const n = this.copies.length;
		this.copies = [];
		this.notice("warn", "conflict-copy", conflictCopyNotice(first, n), `conflict-copy:${first.to}`);
	}

	window(): BrakeWindow {
		const cutoff = this.deps.clock.monotonic() - BRAKE_WINDOW_MS;
		while (this.destructive.length > 0 && this.destructive[0]!.at <= cutoff) this.destructive.shift();
		const w = { nsDelete: 0, diskTrash: 0, overwrite: 0, conflict: 0 };
		for (const d of this.destructive) w[d.kind]++;
		return w;
	}

	/** Docs with an unresolved intent are not planned until the intent is resolved. */
	intentDocs(): Set<DocId> {
		const out = new Set<DocId>();
		for (const i of this.store.intents.values()) if (i.docId !== null) out.add(i.docId);
		return out;
	}
}
