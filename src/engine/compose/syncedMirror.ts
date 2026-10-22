/**
 * Synced-tree mirror (DESIGN §e.4, §i.5): the A/B side-file copy of the
 * `synced` store, written debounced after reconcile passes that changed it,
 * and re-imported into a fresh DB after IndexedDB loss so the planner keeps
 * its sync points (no mass "no-base" merges or conflict copies on recovery).
 *
 * The mirror carries no stat or fingerprint: imported records get size -1 and
 * an empty fingerprint, so the first pass refreshes them with a syncedPut
 * after hashing the file (the content hash is what decides).
 *
 * A doc the outbox mirror lists as unmirrored (own records it could not carry, runtime/mirrors.ts unmirroredDocs)
 * is imported with no trusted content hash (untrustedSyncPoint): the edits its sync point rests on died with the
 * store, so the disk text is merged with no base (kept as a conflict copy), never overwritten as already synced.
 *
 * Nor a CRDT sync point: imported records get bodyVersion null (§i.5 step 3),
 * so the planner sees the remote side as changed and the merge compares
 * content against the synced side. `bodyRemoteSeq` cannot stand in for it: the
 * fresh DB re-reads this device's own rows, which never advance remoteSeq, so
 * own edits the disk never got (an editor buffer lost with the app) would look
 * synced.
 */

import type { DiskFingerprint, DocId, PathKeyFn, Seq } from "../../core/types";
import type { ClockPort } from "../../ports/clock";
import type { HashPort } from "../../ports/crypto";
import type { StorageDb } from "../../ports/storage";
import type { SideFileName, SideFilePort } from "../../ports/vault";
import type { DiskSchema } from "../reconcile/store";
import { decodeSyncedMirror, encodeSyncedMirror, heldTextsOf, nextMirrorSlot, recoveredHeld, pathMovesOf, pickOutboxMirror, pickSyncedMirror, untrustedSyncPoint, type MirrorIdentity } from "../runtime/mirrors";
import { STORE, type HeldTextRecord, type SyncedMirror, type SyncedMirrorEntry, type SyncedRecord } from "../store/schema";

export const SYNCED_FILES: readonly [SideFileName, SideFileName] = ["synced-a.bin", "synced-b.bin"];
const OUTBOX_FILES: readonly SideFileName[] = ["outbox-a.bin", "outbox-b.bin"];
export const SYNCED_MIRROR_DEBOUNCE_MS = 2_000;

/**
 * `texts`: the record's held texts (heldText store, ReconcileStore.loadAllHeld), when it keeps them. A record whose
 * texts are not given is mirrored with its held hash alone.
 */
export function toMirrorEntry(s: SyncedRecord, texts?: Pick<HeldTextRecord, "hash" | "text" | "base">): SyncedMirrorEntry {
	const held = !s.held ? undefined : texts && texts.hash === s.held.hash ? { hash: s.held.hash, text: texts.text, base: texts.base } : { hash: s.held.hash };
	return {
		docId: s.docId, path: s.path, kind: s.kind, contentHash: s.contentHash, nsTouchSeq: s.nsTouchSeq,
		bodyRemoteSeq: s.bodyVersion?.remoteSeq ?? 0, blobRev: s.blobRev,
		...(s.fileGone ? { fileGone: true as const } : {}), ...(s.renamedTo ? { renamedTo: s.renamedTo } : {}), ...(held ? { held } : {}),
	};
}

export function fromMirrorEntry(e: SyncedMirrorEntry, pk: PathKeyFn, nowMs: number): SyncedRecord {
	const held = recoveredHeld(e.held);
	return {
		docId: e.docId, path: e.path, pathKey: pk(e.path), kind: e.kind, contentHash: e.contentHash, fingerprint: "" as DiskFingerprint,
		size: -1, mtimeMs: 0, bodyVersion: null, blobRev: e.blobRev,
		nsTouchSeq: e.nsTouchSeq, hasBase: false, syncedAtMs: nowMs,
		...(e.fileGone ? { fileGone: true as const } : {}), ...(e.renamedTo ? { renamedTo: e.renamedTo } : {}), ...(held ? { held } : {}),
	};
}


async function readSlots(side: SideFilePort, files: readonly SideFileName[] = SYNCED_FILES): Promise<(Uint8Array | null)[]> {
	const out: (Uint8Array | null)[] = [];
	for (const f of files) {
		try {
			out.push(await side.read(f));
		} catch {
			out.push(null);
		}
	}
	return out;
}

/**
 * Fresh DB after loss: import the newest valid synced mirror for this identity
 * into an empty `synced` store, and the previous epoch's unpublished renames it
 * carries into meta (MetaPathMove). Returns the number of records imported.
 */
export async function importSyncedMirror(o: {
	readonly db: StorageDb<DiskSchema>; readonly side: SideFilePort; readonly hash: HashPort; readonly identity: MirrorIdentity;
	readonly pathKey: PathKeyFn; readonly nowMs: number;
}): Promise<number> {
	const picked = await pickSyncedMirror(await readSlots(o.side), o.identity, o.hash);
	if (!picked) return 0;
	const moves = pathMovesOf(picked.mirror.moves);
	if (moves.length > 0) {
		await o.db.tx([STORE.meta], "readwrite", async (tx) => {
			for (const m of moves) if (!(await tx.get(STORE.meta, m.key))) tx.put(STORE.meta, m);
		});
	}
	if (picked.mirror.entries.length === 0) return 0;
	const outbox = await pickOutboxMirror(await readSlots(o.side, OUTBOX_FILES), o.identity, o.hash);
	const untrusted = new Set(outbox?.mirror.unmirrored ?? []);
	const recs = picked.mirror.entries.map((e) => untrustedSyncPoint(fromMirrorEntry(e, o.pathKey, o.nowMs), untrusted));
	const held = heldTextsOf(picked.mirror.entries);
	return o.db.tx([STORE.synced, STORE.heldText], "readwrite", async (tx) => {
		const existing = await tx.getAll(STORE.synced);
		if (existing.length > 0) return 0;
		for (const r of recs) tx.put(STORE.synced, r);
		for (const t of held) tx.put(STORE.heldText, t);
		return recs.length;
	});
}

export interface SyncedMirrorDeps {
	readonly side: SideFilePort;
	readonly hash: HashPort;
	readonly clock: ClockPort;
	readonly identity: () => MirrorIdentity;
	readonly entries: () => Iterable<SyncedRecord>;
	/** The held edits' texts (heldText store, ReconcileStore.loadAllHeld), read from IDB for each write, never kept. */
	readonly heldTexts?: () => Promise<ReadonlyMap<DocId, HeldTextRecord>>;
	readonly nsCoversSeq: () => Seq;
	/** The previous epoch's unpublished renames (EpochBases.renames): they ride the mirror (SyncedMirror.moves). */
	readonly moves?: () => NonNullable<SyncedMirror["moves"]>;
	readonly debounceMs?: number;
	readonly onError?: (e: unknown) => void;
	/**
	 * Bring the outbox mirror up to the outbox; false when that failed. Runs
	 * after the entries are taken and before they are written: a sync point
	 * may rest on own frames still unacked, and a synced mirror ahead of the
	 * outbox mirror makes recovery take the disk as base without those frames.
	 */
	readonly before?: () => Promise<boolean>;
	/** After each write that landed (identity-per-store §5.2 step 7: the predecessors' dirs may go then). */
	readonly onWritten?: () => void;
}

export class SyncedMirrorWriter {
	private gens: [number | null, number | null] | null = null;
	private timer: number | null = null;
	private writing: Promise<void> | null = null;
	private dirty = false;
	private stopped = false;
	stats = { writes: 0, failures: 0, lastEntries: 0 };

	constructor(private readonly deps: SyncedMirrorDeps) {}

	markDirty(): void {
		if (this.stopped) return;
		this.dirty = true;
		if (this.timer !== null) return;
		this.timer = this.deps.clock.setTimer(this.deps.debounceMs ?? SYNCED_MIRROR_DEBOUNCE_MS, () => {
			this.timer = null;
			void this.flush();
		});
	}

	/** Write now if dirty (serialized with a running write). */
	async flush(): Promise<void> {
		if (this.timer !== null) {
			this.deps.clock.clearTimer(this.timer);
			this.timer = null;
		}
		while (this.writing) await this.writing;
		if (!this.dirty) return;
		this.dirty = false;
		this.writing = this.write().catch((e) => {
			this.stats.failures++;
			this.dirty = true;
			this.deps.onError?.(e);
		}).finally(() => {
			this.writing = null;
		});
		await this.writing;
	}

	async stop(): Promise<void> {
		await this.flush().catch(() => undefined);
		this.stopped = true;
	}

	private async loadGens(): Promise<[number | null, number | null]> {
		const id = this.deps.identity();
		const raw = await readSlots(this.deps.side);
		const gens: [number | null, number | null] = [null, null];
		for (let i = 0; i < 2; i++) {
			const b = raw[i];
			const m = b ? await decodeSyncedMirror(b, this.deps.hash).catch(() => null) : null;
			if (m && m.vaultId === id.vaultId && m.vaultEpoch === id.vaultEpoch && m.deviceId === id.deviceId) gens[i] = m.generation;
		}
		return gens;
	}

	private async write(): Promise<void> {
		this.gens ??= await this.loadGens();
		const { slot, generation } = nextMirrorSlot(this.gens);
		const records = [...this.deps.entries()];
		const texts = records.some((r) => r.held?.bytes !== undefined) ? await this.deps.heldTexts?.() : undefined;
		const entries = records.map((r) => toMirrorEntry(r, texts?.get(r.docId))).sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
		if (this.deps.before && !(await this.deps.before())) throw new Error("outbox mirror not written");
		const moves = this.deps.moves?.() ?? [];
		const bytes = await encodeSyncedMirror({
			...this.deps.identity(), generation, writtenAtMs: this.deps.clock.now(), nsCoversSeq: this.deps.nsCoversSeq(), entries,
			...(moves.length > 0 ? { moves } : {}),
		}, this.deps.hash);
		await this.deps.side.write(SYNCED_FILES[slot], bytes);
		this.gens[slot] = generation;
		this.stats.writes++;
		this.stats.lastEntries = entries.length;
		this.deps.onWritten?.();
	}
}
