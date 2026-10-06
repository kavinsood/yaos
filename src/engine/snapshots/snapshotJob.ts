/**
 * Local recovery snapshots (DESIGN §j.4).
 *
 * A snapshot is a zip (fflate) side file `snapshots/<id>.zip` holding
 * `manifest.json` plus `files/<vault path>` for every markdown/canvas file and
 * every blob <= 1 MiB. Capped at 256 MiB of file bytes: above that the snapshot
 * is skipped with a notice. Ids sort by time: `<createdAtMs base36, 9 chars>-<reason>`.
 *
 * Restore writes files as ordinary local edits (the reconciler picks them up
 * on its next scan; nothing is echo-suppressed). A differing current file is
 * first copied to a conflict name (precondition absent); the restore write then
 * uses precondition fingerprint(current) / absent instead of DESIGN's `any`, so a
 * file edited between the read and the write is not clobbered (reported failed).
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { exactFingerprint } from "../../core/hash/markdownLf";
import { conflictName } from "../../core/plan/conflictName";
import { standInPathKey } from "../../core/plan/pathRules";
import type { DiskFingerprint, DocKind, PathKey, PathKeyFn, VaultPath } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort } from "../../ports/crypto";
import type { ClockPort } from "../../ports/clock";
import type { SideFileName, SideFilePort, WritePrecondition } from "../../ports/vault";
import { badRequest } from "../../protocol/errors";
import { LANE, type DiskOp, type DiskOpPurpose, type DiskReadResult, type SnapshotReason } from "../../protocol/messages";
import type { DiskGateway } from "../reconcile/deps";

export const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const SNAPSHOT_BLOB_MAX_BYTES = 1024 * 1024;
/** Event snapshots (brake, epoch, idb, restore, manual) kept besides `keepDaily` dailies. */
export const SNAPSHOT_EVENT_KEEP = 10;
const READ_BATCH = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SnapshotFile { readonly path: VaultPath; readonly kind: DocKind; readonly hash: DiskFingerprint; readonly size: number }
export interface SnapshotManifest {
	readonly formatVersion: 1;
	readonly id: string;
	readonly createdAtMs: number;
	readonly reason: SnapshotReason;
	readonly files: readonly SnapshotFile[];
	readonly skipped: readonly { readonly path: VaultPath; readonly reason: "too-large" | "unreadable" }[];
}
export interface SnapshotInfo { readonly id: string; readonly createdAtMs: number; readonly reason: SnapshotReason; readonly files: number; readonly bytes: number }
export interface RestoreResult {
	readonly restored: readonly VaultPath[];
	readonly unchanged: readonly VaultPath[];
	readonly copies: readonly VaultPath[];
	readonly failed: readonly VaultPath[];
}

export interface SnapshotDeps {
	readonly disk: DiskGateway;
	readonly side: SideFilePort;
	readonly clock: ClockPort;
	/** Current local tree (files the reconciler tracks). */
	readonly files: () => readonly { readonly path: VaultPath; readonly kind: DocKind; readonly size: number }[];
	readonly settings: () => { readonly enabled: boolean; readonly keepDaily: number; readonly uploadToBlobStore: boolean };
	readonly upload?: { readonly store: BlobPort; readonly crypto: CryptoPort } | null;
	readonly pathKey?: PathKeyFn;
	readonly deviceLabel: string;
	readonly tzOffsetMinutes?: () => number;
	readonly notice?: (level: "info" | "warn", code: string, detail?: string) => void;
}

const sideName = (id: string): SideFileName => `snapshots/${id}.zip`;
const MANIFEST = "manifest.json";
const entryName = (path: VaultPath): string => `files/${path}`;

export function snapshotId(createdAtMs: number, reason: SnapshotReason): string {
	return `${Math.max(0, Math.floor(createdAtMs)).toString(36).padStart(9, "0")}-${reason}`;
}
export function parseSnapshotId(id: string): { createdAtMs: number; reason: SnapshotReason } | null {
	const m = /^([0-9a-z]{9})-(daily|brake|epoch|idb|restore|manual)$/.exec(id);
	return m ? { createdAtMs: parseInt(m[1]!, 36), reason: m[2] as SnapshotReason } : null;
}

export class SnapshotJob {
	private readonly pk: PathKeyFn;
	private opId = 1;

	constructor(private readonly deps: SnapshotDeps) {
		this.pk = deps.pathKey ?? standInPathKey;
	}

	/**
	 * Takes a snapshot; null when too large, or when snapshots are disabled. A user action (manual, and the
	 * safety snapshot before a restore) takes one even when disabled.
	 */
	async take(reason: SnapshotReason): Promise<{ id: string; address: BlobAddress | null } | null> {
		const { deps } = this;
		if (!deps.settings().enabled && reason !== "manual" && reason !== "restore") return null;
		const eligible = deps.files().filter((f) => f.kind !== "blob" || f.size <= SNAPSHOT_BLOB_MAX_BYTES);
		const planned = eligible.reduce((n, f) => n + f.size, 0);
		if (planned > SNAPSHOT_MAX_BYTES) {
			deps.notice?.("warn", "snapshot-too-large", `${planned} bytes`);
			return null;
		}
		const createdAtMs = deps.clock.now();
		const id = snapshotId(createdAtMs, reason);
		const zip: Zippable = {};
		const files: SnapshotFile[] = [];
		const skipped: { path: VaultPath; reason: "too-large" | "unreadable" }[] = [];
		let total = 0;
		for (let i = 0; i < eligible.length; i += READ_BATCH) {
			const batch = eligible.slice(i, i + READ_BATCH);
			const res = await deps.disk.read(batch.map((f) => ({ area: "vault" as const, path: f.path, maxBytes: f.kind === "blob" ? SNAPSHOT_BLOB_MAX_BYTES : SNAPSHOT_MAX_BYTES })), LANE.bulk);
			batch.forEach((f, j) => {
				const r = res[j];
				if (!r || !r.ok) {
					if (r?.ok === false && r.reason === "missing") return;
					skipped.push({ path: f.path, reason: r?.ok === false && r.reason === "too-large" ? "too-large" : "unreadable" });
					return;
				}
				total += r.bytes.length;
				zip[entryName(f.path)] = [r.bytes, { level: f.kind === "blob" ? 0 : 6 }];
				files.push({ path: f.path, kind: f.kind, hash: exactFingerprint(r.bytes), size: r.bytes.length });
			});
			if (total > SNAPSHOT_MAX_BYTES) {
				deps.notice?.("warn", "snapshot-too-large", `${total} bytes`);
				return null;
			}
		}
		const manifest: SnapshotManifest = { formatVersion: 1, id, createdAtMs, reason, files, skipped };
		zip[MANIFEST] = strToU8(JSON.stringify(manifest));
		const bytes = zipSync(zip, { mtime: new Date(1980, 0, 1) });
		await deps.side.write(sideName(id), bytes);
		let address: BlobAddress | null = null;
		if (deps.settings().uploadToBlobStore && deps.upload) {
			const { store, crypto } = deps.upload;
			try {
				address = await crypto.blobAddress(exactFingerprint(bytes) as string as Parameters<CryptoPort["blobAddress"]>[0]);
				await store.put(address, await crypto.sealBlob({ address, plaintext: bytes }));
			} catch {
				address = null;
				deps.notice?.("warn", "snapshot-upload-failed");
			}
		}
		await this.prune();
		return { id, address };
	}

	/** Daily snapshot when the newest daily one is older than 24 h. */
	async maybeDaily(): Promise<string | null> {
		const dailies = (await this.ids()).filter((s) => s.reason === "daily");
		const latest = dailies[dailies.length - 1];
		if (latest && this.deps.clock.now() - latest.createdAtMs < DAY_MS) return null;
		return (await this.take("daily"))?.id ?? null;
	}

	async list(): Promise<SnapshotInfo[]> {
		const out: SnapshotInfo[] = [];
		for (const s of await this.ids()) {
			const m = await this.manifest(s.id);
			if (m) out.push({ id: s.id, createdAtMs: m.createdAtMs, reason: m.reason, files: m.files.length, bytes: m.files.reduce((n, f) => n + f.size, 0) });
		}
		return out;
	}

	async manifest(id: string): Promise<SnapshotManifest | null> {
		const zip = await this.deps.side.read(sideName(checkId(id)));
		if (!zip) return null;
		const m = unzipSync(zip, { filter: (f) => f.name === MANIFEST })[MANIFEST];
		return m ? (JSON.parse(strFromU8(m)) as SnapshotManifest) : null;
	}

	/** Deletes snapshot `id`. Throws bad-request for a malformed or unknown id. */
	async remove(id: string): Promise<void> {
		const name = sideName(checkId(id));
		if (!(await this.deps.side.list("snapshots/")).includes(name)) throw notFound(id);
		await this.deps.side.remove(name);
	}

	/** restoreSnapshot{id, paths|null}: a "restore" snapshot first, then conflict-copy + write per file. */
	async restore(id: string, paths: readonly VaultPath[] | null): Promise<RestoreResult> {
		const zip = await this.deps.side.read(sideName(checkId(id)));
		if (!zip) throw notFound(id);
		const want = paths ? new Set(paths) : null;
		const content = unzipSync(zip, { filter: (f) => f.name === MANIFEST || want === null || (f.name.startsWith("files/") && want.has(f.name.slice(6))) });
		const manifest = JSON.parse(strFromU8(content[MANIFEST]!)) as SnapshotManifest;
		await this.take("restore");
		const taken = new Set<PathKey>(this.deps.files().map((f) => this.pk(f.path)));
		const out = { restored: [] as VaultPath[], unchanged: [] as VaultPath[], copies: [] as VaultPath[], failed: [] as VaultPath[] };
		for (const f of manifest.files) {
			if (want && !want.has(f.path)) continue;
			const bytes = content[entryName(f.path)];
			if (!bytes || exactFingerprint(bytes) !== f.hash) { out.failed.push(f.path); continue; }
			const [cur] = await this.deps.disk.read([{ area: "vault", path: f.path, maxBytes: SNAPSHOT_MAX_BYTES }], LANE.background);
			let pre: WritePrecondition = { t: "absent" };
			if (cur?.ok) {
				const fp = exactFingerprint(cur.bytes);
				if (fp === f.hash) { out.unchanged.push(f.path); continue; }
				const copy = conflictName({
					path: f.path, docId: null, deviceLabel: this.deps.deviceLabel, nowMs: this.deps.clock.now(),
					tzOffsetMinutes: this.deps.tzOffsetMinutes?.() ?? 0, pathKey: this.pk, isTaken: (k) => taken.has(k),
				});
				if (!(await this.write(copy, cur.bytes, { t: "absent" }, "conflict-copy"))) { out.failed.push(f.path); continue; }
				taken.add(this.pk(copy));
				out.copies.push(copy);
				pre = { t: "fingerprint", fingerprint: fp };
			} else if (!isMissing(cur)) {
				out.failed.push(f.path);
				continue;
			}
			if (await this.write(f.path, bytes, pre, "snapshot-restore")) {
				taken.add(this.pk(f.path));
				out.restored.push(f.path);
			} else out.failed.push(f.path);
		}
		return out;
	}

	private async write(path: VaultPath, bytes: Uint8Array, precondition: WritePrecondition, purpose: DiskOpPurpose): Promise<boolean> {
		const op: DiskOp = { t: "write", opId: this.opId++, area: "vault", path, data: { t: "bytes", bytes }, precondition, docId: null, purpose };
		const [res] = await this.deps.disk.exec([op], LANE.background);
		return res?.t === "write" && res.outcome.ok;
	}

	private async ids(): Promise<{ id: string; createdAtMs: number; reason: SnapshotReason }[]> {
		const names = await this.deps.side.list("snapshots/");
		return names
			.map((n) => n.slice("snapshots/".length, -".zip".length))
			.flatMap((id) => { const p = parseSnapshotId(id); return p ? [{ id, ...p }] : []; })
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	/** Keep the newest `keepDaily` daily snapshots and SNAPSHOT_EVENT_KEEP others. */
	private async prune(): Promise<void> {
		const all = await this.ids();
		const keepDaily = Math.max(0, this.deps.settings().keepDaily);
		const daily = all.filter((s) => s.reason === "daily");
		const other = all.filter((s) => s.reason !== "daily");
		const drop = [...daily.slice(0, Math.max(0, daily.length - keepDaily)), ...other.slice(0, Math.max(0, other.length - SNAPSHOT_EVENT_KEEP))];
		for (const s of drop) await this.deps.side.remove(sideName(s.id));
	}
}

/** Ids come from the host: only well-formed ones name a side file (no path tricks). */
function checkId(id: string): string {
	if (parseSnapshotId(id) === null) throw badRequest("not a snapshot id");
	return id;
}

function notFound(id: string): Error {
	return badRequest(`snapshot ${id} not found`);
}

function isMissing(r: DiskReadResult | undefined): boolean {
	return r !== undefined && !r.ok && r.reason === "missing";
}
