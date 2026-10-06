/**
 * Recovery snapshots (DESIGN §j.4): local snapshots, their upload to the blob store, the snapshot index (`snap`
 * stream) and restore from this device's or any other device's snapshots. Runs in the worker; every operation is
 * serialized. Format, verification chain and retention are described in DESIGN §j.4 and core/snap/*.
 *
 *  - take: streaming export into side-file parts + descriptor (exporter.ts); a manual one is uploaded at once.
 *  - maybeDaily (after a full pass): a daily snapshot when the newest is 24 h old, then maybeUpload: the newest
 *    local daily/manual snapshot not yet in the index (so at most one upload a day besides manual ones).
 *  - restore: pass 1 verifies the whole bundle (remote parts are downloaded to the cache meanwhile), nothing is
 *    written unless it passes; pass 2 re-reads the verified parts and writes each entry (restore.ts). Any failed
 *    check is `content_corrupt`: notice + diagnostic, the download cache is removed, the request fails.
 */
import { SnapCorrupt, snapPartBytes, type SnapManifest } from "../../core/snap/bundle";
import { snapLive } from "../../core/snap/fold";
import { parseRemoteSnapshotId, parseSnapshotId, remoteSnapshotId, snapKey, snapshotId, type SnapReason, type SnapRecord } from "../../core/snap/record";
import { verifyBundle } from "../../core/snap/verify";
import { standInPathKey } from "../../core/plan/pathRules";
import type { DeviceId, DocKind, PathKeyFn, VaultPath } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { ClockPort } from "../../ports/clock";
import type { CryptoPort } from "../../ports/crypto";
import type { SideFilePort } from "../../ports/vault";
import { ProtocolFailure, badRequest } from "../../protocol/errors";
import type { DiskGateway } from "../reconcile/deps";
import { exportSnapshot } from "./exporter";
import { dlName, listLocal, partName, readLocal, removeDownload, removeLocal, sweep, type LocalSnapshot } from "./localStore";
import { keepPart, remotePart, uploadSnapshot, type RemoteDeps, type UploadOutcome } from "./remote";
import { Restorer, type RestoreResult } from "./restore";
import type { SnapIndexPort } from "./snapIndex";

export type { RestoreResult } from "./restore";
/** Event snapshots (brake, epoch, idb, restore, manual) kept locally besides `keepDaily` dailies. */
export const SNAPSHOT_EVENT_KEEP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_RETRY_MS = 60 * 60 * 1000;

export interface SnapshotInfo {
	readonly id: string; readonly createdAtMs: number; readonly reason: SnapReason; readonly files: number; readonly bytes: number;
	readonly where: "local" | "remote" | "both"; readonly device: string | null;
}

export interface SnapshotDeps {
	readonly disk: DiskGateway;
	readonly side: SideFilePort;
	readonly clock: ClockPort;
	readonly crypto: CryptoPort;
	/** Current local tree (files the reconciler tracks). */
	readonly files: () => readonly { readonly path: VaultPath; readonly kind: DocKind; readonly size: number }[];
	readonly settings: () => { readonly enabled: boolean; readonly keepDaily: number; readonly uploadToBlobStore: boolean };
	/** Blob store and snapshot index; null without a blob store (local snapshots only). */
	readonly remote?: { readonly store: BlobPort; readonly index: SnapIndexPort } | null;
	readonly pathKey?: PathKeyFn;
	readonly deviceLabel: string;
	readonly tzOffsetMinutes?: () => number;
	readonly notice?: (level: "info" | "warn", code: string, detail?: string) => void;
	readonly diag?: (line: string) => void;
	/** Zip part size; default snapPartBytes (min(8 MiB, 7/8 of the store's blob limit)). */
	readonly partBytes?: number;
}

type Source =
	| { readonly t: "local"; readonly id: string; readonly record: SnapRecord }
	| { readonly t: "remote"; readonly id: string; readonly key: string; readonly deviceId: DeviceId; readonly record: SnapRecord };

export class SnapshotJob {
	private readonly pk: PathKeyFn;
	private readonly rd: RemoteDeps | null;
	private chain: Promise<unknown> = Promise.resolve();
	private opId = 1;
	private busy: string | null = null;
	private locals: LocalSnapshot[] | null = null;
	private uploadAfterMs = 0;
	/** The remote snapshot whose verified parts are in the download cache (one at most). */
	private cache: { readonly key: string; readonly parts: number; readonly manifest: SnapManifest } | null = null;

	constructor(private readonly deps: SnapshotDeps) {
		this.pk = deps.pathKey ?? standInPathKey;
		this.rd = deps.remote ? { store: deps.remote.store, index: deps.remote.index, crypto: deps.crypto } : null;
	}

	/** Local snapshots, oldest first (cached; only this job writes snapshot side files). */
	private async local(): Promise<LocalSnapshot[]> {
		this.locals ??= await listLocal(this.deps.side, (n) => this.deps.diag?.(`snapshot descriptor ${n} unreadable`));
		return this.locals;
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	/** Takes a snapshot; null when too large or disabled (manual and the pre-restore one are taken regardless). */
	take(reason: SnapReason): Promise<{ id: string; upload: UploadOutcome | null } | null> {
		return this.serial(async () => {
			const r = await this.takeNow(reason);
			if (!r) return null;
			const upload = reason === "manual" ? await this.upload(r, true) : null;
			return { id: r.snapshotId, upload };
		});
	}

	/** Daily snapshot when the newest daily is 24 h old; then the pending upload, if any. */
	maybeDaily(): Promise<string | null> {
		return this.serial(async () => {
			const latest = (await this.local()).filter((s) => s.record.reason === "daily").pop();
			const due = !latest || this.deps.clock.now() - latest.record.createdAtMs >= DAY_MS;
			const taken = due ? await this.takeNow("daily") : null;
			await this.maybeUpload();
			return taken?.snapshotId ?? null;
		});
	}

	async list(): Promise<SnapshotInfo[]> {
		const local = await this.local();
		const live = this.rd ? snapLive(this.rd.index.view().state) : [];
		const self = this.rd?.index.self;
		const own = new Set(live.filter((e) => e.deviceId === self).map((e) => e.record.snapshotId));
		const info = (id: string, r: SnapRecord, where: SnapshotInfo["where"], device: string | null): SnapshotInfo =>
			({ id, createdAtMs: r.createdAtMs, reason: r.reason, files: r.fileCount, bytes: r.totalBytes, where, device });
		const out = local.map((s) => info(s.id, s.record, own.has(s.id) ? "both" : "local", null));
		const localIds = new Set(local.map((s) => s.id));
		for (const e of live) {
			if (e.deviceId === self && localIds.has(e.record.snapshotId)) continue;
			out.push(info(remoteSnapshotId(e.deviceId, e.record.snapshotId), e.record, "remote", e.record.deviceLabel));
		}
		return out.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	/** The verified manifest (the whole bundle is verified; a remote one is downloaded to the cache for restore). */
	manifest(id: string): Promise<SnapManifest> {
		return this.serial(async () => this.verified(await this.resolve(id)));
	}

	/** restoreSnapshot{id, paths|null}: verify, take a "restore" snapshot, then conflict-copy + write per file. */
	restore(id: string, paths: readonly VaultPath[] | null): Promise<RestoreResult> {
		return this.serial(async () => {
			const src = await this.resolve(id);
			try {
				const manifest = await this.verified(src);
				await this.takeNow("restore");
				const d = this.deps;
				const restorer = new Restorer({
					disk: d.disk, clock: d.clock, pathKey: this.pk, deviceLabel: d.deviceLabel, tzOffsetMinutes: d.tzOffsetMinutes?.() ?? 0,
					taken: d.files().map((f) => f.path), nextOpId: () => this.opId++,
				}, paths ? new Set(paths) : null);
				const part = src.t === "local" ? (i: number) => d.side.read(partName(src.id, i)) : (i: number) => d.side.read(dlName(i));
				await this.corruptGuard(src, "pass2", () => verifyBundle({ record: src.record, part, expect: manifest, onEntry: restorer.entry }));
				return restorer.out;
			} finally {
				if (src.t === "remote") await this.dropCache();
			}
		});
	}

	/** Deletes snapshot `id` everywhere it is: the local copy, and its index record when it was uploaded. */
	remove(id: string): Promise<void> {
		return this.serial(async () => {
			const src = await this.resolve(id);
			if (src.t === "local") {
				this.locals = null;
				await removeLocal(this.deps.side, src.id, src.record.parts.length);
				const index = this.rd?.index;
				if (index && index.view().state.records.has(snapKey(index.self, src.id))) await index.submit([{ t: "del", deviceId: index.self, snapshotId: src.id }]);
			} else await this.rd!.index.submit([{ t: "del", deviceId: src.deviceId, snapshotId: src.record.snapshotId }]);
		});
	}

	// ---- internals (run inside serial) ---------------------------------------------------------------------

	private async takeNow(reason: SnapReason): Promise<SnapRecord | null> {
		const d = this.deps;
		if (!d.settings().enabled && reason !== "manual" && reason !== "restore") return null;
		let createdAtMs = d.clock.now();
		while (await readLocal(d.side, snapshotId(createdAtMs, reason))) createdAtMs++;
		const id = snapshotId(createdAtMs, reason);
		const store = this.rd?.store;
		const partBytes = d.partBytes ?? snapPartBytes(store ? store.maxBlobBytes : null);
		this.busy = id;
		this.locals = null;
		try {
			const r = await exportSnapshot({
				disk: d.disk, side: d.side, files: d.files(), id, createdAtMs, reason, partBytes, deviceLabel: d.deviceLabel,
				address: async (h) => d.crypto.blobAddress(h),
			});
			if (r.t === "too-large") {
				d.notice?.("warn", "snapshot-too-large", r.detail);
				return null;
			}
			return r.record;
		} finally {
			this.busy = null;
			await this.prune();
		}
	}

	/** The newest local daily/manual snapshot, when uploads are on and it is not in the index yet. */
	private async maybeUpload(): Promise<void> {
		if (!this.rd || !this.deps.settings().uploadToBlobStore || this.deps.clock.now() < this.uploadAfterMs) return;
		const newest = (await this.local()).filter((s) => s.record.reason === "daily" || s.record.reason === "manual").pop();
		if (newest) await this.upload(newest.record, false);
	}

	private async upload(record: SnapRecord, user: boolean): Promise<UploadOutcome | null> {
		if (!this.rd || !this.deps.settings().uploadToBlobStore) return null;
		try {
			const out = await uploadSnapshot(this.rd, this.deps.side, record, this.deps.settings().keepDaily);
			if (out === "uploaded") this.deps.diag?.(`snapshot ${record.snapshotId} uploaded (${record.parts.length} parts)`);
			return out;
		} catch (e) {
			this.uploadAfterMs = this.deps.clock.now() + UPLOAD_RETRY_MS;
			this.deps.diag?.(`snapshot upload ${record.snapshotId} failed: ${String(e)}`);
			if (user) this.deps.notice?.("warn", "snapshot-upload-failed", `The snapshot was saved on this device but could not be uploaded: ${e instanceof Error ? e.message : String(e)}`);
			return null;
		}
	}

	private async resolve(id: string): Promise<Source> {
		const remote = parseRemoteSnapshotId(id);
		const index = this.rd?.index;
		if (remote) {
			const e = index?.view().state.records.get(snapKey(remote.deviceId, remote.snapshotId));
			if (!e) throw notFound(id);
			return { t: "remote", id, key: snapKey(remote.deviceId, remote.snapshotId), deviceId: remote.deviceId, record: e.record };
		}
		if (!parseSnapshotId(id)) throw badRequest("not a snapshot id");
		const record = await readLocal(this.deps.side, id);
		if (record) return { t: "local", id, record };
		const own = index?.view().state.records.get(snapKey(index.self, id));
		if (own) return { t: "remote", id, key: snapKey(index!.self, id), deviceId: index!.self, record: own.record };
		throw notFound(id);
	}

	/** Pass 1: verifies the whole bundle without writing to the vault; a remote one stays in the download cache. */
	private async verified(src: Source): Promise<SnapManifest> {
		if (src.t === "local") {
			return this.corruptGuard(src, "pass1", () => verifyBundle({ record: src.record, part: (i) => this.deps.side.read(partName(src.id, i)) }));
		}
		if (this.cache?.key === src.key) return this.cache.manifest;
		await this.dropCache();
		const rd = this.rd!;
		try {
			const manifest = await this.corruptGuard(src, "pass1", () => verifyBundle({ record: src.record, part: remotePart(rd, src.record), onPart: keepPart(this.deps.side) }));
			this.cache = { key: src.key, parts: src.record.parts.length, manifest };
			return manifest;
		} catch (e) {
			await removeDownload(this.deps.side, src.record.parts.length);
			throw e;
		}
	}

	private async corruptGuard<T>(src: Source, pass: "pass1" | "pass2", fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			if (!(e instanceof SnapCorrupt)) throw e;
			const what = pass === "pass1" ? "nothing was restored" : "the restore stopped";
			const message = `Snapshot ${src.id} is damaged (${e.check}); ${what}.`;
			// Part details name only indexes and sizes; entry checks would name vault paths, which diagnostics leave out.
			this.deps.diag?.(`content_corrupt snapshot=${src.id} check=${e.check}${e.check.startsWith("part-") ? ` ${e.detail}` : ""}`);
			this.deps.notice?.("warn", "content_corrupt", message);
			throw new ProtocolFailure({ code: "content_corrupt", message, retryable: false });
		}
	}

	private async dropCache(): Promise<void> {
		if (!this.cache) return;
		const n = this.cache.parts;
		this.cache = null;
		await removeDownload(this.deps.side, n);
	}

	/** Keep the newest `keepDaily` daily snapshots and SNAPSHOT_EVENT_KEEP others; remove export leftovers. */
	private async prune(): Promise<void> {
		this.locals = null;
		const all = await this.local();
		const keepDaily = Math.max(0, this.deps.settings().keepDaily);
		const daily = all.filter((s) => s.record.reason === "daily");
		const other = all.filter((s) => s.record.reason !== "daily");
		const drop: LocalSnapshot[] = [...daily.slice(0, Math.max(0, daily.length - keepDaily)), ...other.slice(0, Math.max(0, other.length - SNAPSHOT_EVENT_KEEP))];
		this.locals = null;
		for (const s of drop) await removeLocal(this.deps.side, s.id, s.record.parts.length);
		await sweep(this.deps.side, this.busy, this.cache !== null);
	}
}

function notFound(id: string): Error {
	return badRequest(`snapshot ${id} not found`);
}
