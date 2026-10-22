/**
 * Predecessor recovery (identity-per-store §5.2; DESIGN §i.5): a new store of an install whose earlier store was lost
 * (IndexedDB lost, a store revoked by the server) adopts what that store left in its side-file dir, under its own
 * identity. Never a clone's twin: the lineage names only this install's stores (§2.4).
 *
 * 1. The fence (retire by key) ran before this store's first connect (compose/protocolEngine.ts resolveIdentity).
 * 2. The newest lineage dir with a valid outbox mirror is the source: a store writes its own mirror (the inherited
 *    frames included, with their origins) before it sends any of them, and removes its predecessors' dirs only after
 *    that, so a newer dir with a mirror always supersedes the older ones. Its frames are opened with that store's
 *    deviceId (the AAD binds it) and re-issued as this store's: a new clientFrameId, a new ns / cfg frameNo from
 *    this store's allocator, sealed under this store, in the same order, `dependsOn` mapped to the new ids. ns / cfg
 *    frames keep their identities there (OutboxRecord.origins) for the commit check after the start reads
 *    (logApi.checkInherited): one that committed there is dropped, never sent twice. Body and canvas frames go out
 *    whatever their state (Yjs updates are idempotent). Snap-index and keyring frames are not inherited: the snapshot
 *    job uploads the moved local snapshots again, and the keyring flow restarts from the committed `k` stream.
 * 3. The newest valid synced mirror among the dirs is imported as at any recovery (§i.5 step 3: hasBase false,
 *    bodyVersion null), in the same transaction as the outbox records (Repo.tInherit). A doc any dir's outbox mirror
 *    lists as unmirrored (own records it could not carry: mirrors.ts unmirroredDocs) gets no trusted content hash:
 *    its edits are gone with the store, so its disk text is re-derived, never taken as already synced.
 * 4. Local snapshots are copied into this store's dir (the predecessor's copies go with its dir).
 * 5. The caller writes this store's outbox mirror before anything is sent; the predecessors' dirs are removed once
 *    this store's outbox and synced mirrors are both on disk (compose/vaultRuntime.ts).
 */

import { newClientFrameId } from "../../core/codec/ids";
import { pathKey } from "../../core/paths/pathKey";
import { streamClass, type DeviceId, type DiskFingerprint, type DocId } from "../../core/types";
import type { SideFileName, SideFilePort } from "../../ports/vault";
import { resolveRefContent } from "../body/refs";
import { openEnvelope, sealFrame } from "../ingest/envelope";
import { descName, listLocal, partName, readLocal } from "../snapshots/localStore";
import type { FrameOrigin, HeldTextRecord, MetaInherit, MetaPathMove, OutboxMirrorFrame, OutboxRecord, SyncedMirrorEntry, SyncedRecord } from "../store/schema";
import type { EngineCtx } from "./context";
import { otherEpochMoves, recoverHeldTexts, pathMovesOf, pickOutboxMirror, pickSyncedMirror, recoveredHeld, untrustedSyncPoint } from "./mirrors";

const OUTBOX: readonly SideFileName[] = ["outbox-a.bin", "outbox-b.bin"];
const SYNCED: readonly SideFileName[] = ["synced-a.bin", "synced-b.bin"];

export interface InheritResult {
	/** The dir the outbox frames came from (null: no dir had a valid outbox mirror). */
	readonly from: DeviceId | null;
	readonly frames: number;
	/** Frames of the mirror not inherited (unreadable, snap index, keyring). */
	readonly skipped: number;
	readonly synced: number;
	readonly snapshots: number;
}

async function readPair(side: SideFilePort, names: readonly SideFileName[]): Promise<(Uint8Array | null)[]> {
	const out: (Uint8Array | null)[] = [];
	for (const n of names) {
		try {
			out.push(await side.read(n));
		} catch {
			out.push(null);
		}
	}
	return out;
}

/** Recovery from the lineage dirs `inh.dirs` (newest first) into this fresh store (header). */
export async function inheritFromLineage(c: EngineCtx, inh: MetaInherit, side: (dir: DeviceId) => SideFilePort): Promise<InheritResult> {
	const vaultId = c.opts.vaultId;
	const vaultEpoch = c.repo.identity.vaultEpoch;
	const dirs = inh.dirs.filter((d) => d !== c.self);
	let outbox: { dir: DeviceId; frames: readonly OutboxMirrorFrame[] } | null = null;
	let synced: { dir: DeviceId; recs: SyncedRecord[]; held: HeldTextRecord[]; moves: MetaPathMove[] } | null = null;
	// Every dir's list, not only the source's: the synced mirror may come from an older dir than the outbox frames.
	const untrusted = new Set<DocId>();
	const moves = new Map<string, MetaPathMove>();
	const addMoves = (list: readonly MetaPathMove[]): void => {
		for (const m of list) if ((moves.get(m.key)?.atMs ?? -1) <= m.atMs) moves.set(m.key, m);
	};
	for (const dir of dirs) {
		const id = { vaultId, vaultEpoch, deviceId: dir };
		const ob = await pickOutboxMirror(await readPair(side(dir), OUTBOX), id, c.ports.hash);
		for (const d of ob?.mirror.unmirrored ?? []) untrusted.add(d);
		if (!outbox && ob) outbox = { dir, frames: ob.mirror.frames };
		if (!synced) {
			const picked = await pickSyncedMirror(await readPair(side(dir), SYNCED), id, c.ports.hash);
			if (picked) {
				// The held edits' texts, from the same dir's held-text files (its store wrote them).
				const held = await recoverHeldTexts(side(dir), picked.mirror.entries, id, c.ports.hash);
				synced = { dir, recs: picked.mirror.entries.map((e) => syncedRecordOf(e, c.now(), held.get(e.docId))), held: [...held.values()], moves: pathMovesOf(picked.mirror.moves) };
			}
		}
		// A predecessor lost before it migrated to this epoch: its unpublished renames, as the migration carries them.
		addMoves(await otherEpochMoves(await readPair(side(dir), SYNCED), id, c.ports.hash));
	}
	if (synced && untrusted.size > 0) synced = { ...synced, recs: synced.recs.map((r) => untrustedSyncPoint(r, untrusted)) };
	const { records, skipped } = outbox ? await reissue(c, outbox.dir, outbox.frames) : { records: [], skipped: 0 };
	const syncedN = await c.repo.tInherit(records, synced?.recs ?? [], synced?.held ?? []);
	// The previous epoch's unpublished renames the predecessors kept (§c.12 "Renames"): they are this store's too.
	addMoves(synced?.moves ?? []);
	await c.repo.addPathMoves([...moves.values()]);
	let snapshots = 0;
	for (const dir of dirs) snapshots += await copySnapshots(side(dir), c.opts.sideFiles ?? null, (e) => c.diag("inherit-snapshot-failed", { error: String(e) }));
	c.diag("inherited", { from: outbox?.dir ?? null, frames: records.length, skipped, synced: syncedN, untrusted: untrusted.size, snapshots, fenced: inh.fenced });
	return { from: outbox?.dir ?? null, frames: records.length, skipped, synced: syncedN, snapshots };
}

/** A synced mirror entry as recovery imports it (§i.5 step 3); compose/syncedMirror.ts fromMirrorEntry. */
function syncedRecordOf(e: { readonly docId: SyncedRecord["docId"]; readonly path: SyncedRecord["path"]; readonly kind: SyncedRecord["kind"]; readonly contentHash: SyncedRecord["contentHash"]; readonly nsTouchSeq: number; readonly blobRev: number; readonly fileGone?: true; readonly renamedTo?: SyncedRecord["renamedTo"]; readonly held?: SyncedMirrorEntry["held"] }, nowMs: number, texts: HeldTextRecord | undefined): SyncedRecord {
	const held = recoveredHeld(e.held, texts);
	return {
		docId: e.docId, path: e.path, pathKey: pathKey(e.path), kind: e.kind, contentHash: e.contentHash, fingerprint: "" as DiskFingerprint,
		size: -1, mtimeMs: 0, bodyVersion: null, blobRev: e.blobRev, nsTouchSeq: e.nsTouchSeq, hasBase: false, syncedAtMs: nowMs,
		...(e.fileGone ? { fileGone: true as const } : {}), ...(e.renamedTo ? { renamedTo: e.renamedTo } : {}), ...(held ? { held } : {}),
	};
}

/** The predecessor `dir`'s mirrored frames as this store's records (header step 2). */
async function reissue(c: EngineCtx, dir: DeviceId, frames: readonly OutboxMirrorFrame[]): Promise<{ records: OutboxRecord[]; skipped: number }> {
	const now = c.now();
	const ids = new Map<string, ReturnType<typeof newClientFrameId>>();
	const kept: { f: OutboxMirrorFrame; kind: OutboxRecord["kind"]; flags: number; frameNo: number; content: Uint8Array }[] = [];
	let skipped = 0;
	for (const f of [...frames].sort((a, b) => a.order - b.order)) {
		const cls = streamClass(f.stream);
		if (cls === "snap" || cls === "keyring" || cls === "other") {
			skipped++;
			continue;
		}
		const o = await openEnvelope(c.ports.crypto, c.opts.vaultId, { t: "frame", stream: f.stream, deviceId: dir, clientFrameId: f.clientFrameId }, f.sealed);
		if (!o.ok) {
			c.diag("mirror-frame-unreadable", { reason: o.reason });
			skipped++;
			continue;
		}
		ids.set(f.clientFrameId, newClientFrameId(c.ports.random));
		kept.push({ f, kind: o.inner.kind, flags: o.inner.flags, frameNo: o.inner.frameNo, content: o.inner.content });
	}
	const records: OutboxRecord[] = [];
	for (const { f, kind, flags, frameNo: oldNo, content } of kept) {
		const authorNsSeq = f.authorNsSeq;
		const cls = streamClass(f.stream);
		const clientFrameId = ids.get(f.clientFrameId)!;
		const numbered = cls === "ns" || cls === "cfg";
		const frameNo = numbered ? (cls === "ns" ? c.ns : c.cfg).allocFrameNo(c.outbox) : 0;
		const s = await sealFrame(c.deps.crypto, c.opts.vaultId, { stream: f.stream, deviceId: c.self, clientFrameId, kind, authorNsSeq, flags, frameNo, content });
		// The record keeps a ref frame's resolved update (body/frames.ts); the frame carries the ref.
		let local = content;
		if (kind === "bodyUpdateRef") {
			local = (await resolveRefContent(c.deps, f.stream, content)) ?? new Uint8Array(0);
			if (local.length === 0) c.diag("mirror-ref-content-missing", {});
		}
		const origins: FrameOrigin[] = numbered ? [{ deviceId: dir, clientFrameId: f.clientFrameId, frameNo: oldNo }, ...(f.origins ?? [])] : [];
		records.push({
			// "sent" (mirrors before DB schema 2) was a pending record in flight: maybe sent, resent like any pending one.
			clientFrameId, order: f.order, stream: f.stream, kind, state: f.state === "sent" ? "pending" : f.state, sealed: s.sealed, content: local,
			authorNsSeq, flags, frameNo: numbered ? frameNo : null, keyEpoch: s.keyEpoch,
			dependsOn: f.dependsOn === null ? null : (ids.get(f.dependsOn) ?? f.dependsOn),
			adoptOf: f.adoptOf ? { ...f.adoptOf, receivedAtMs: now } : null, createdAtMs: now,
			...(origins.length > 0 ? { origins } : {}),
		});
	}
	return { records, skipped };
}

/** Copies `from`'s local snapshots this store does not have (parts first, the descriptor last). Returns how many. */
async function copySnapshots(from: SideFilePort, to: SideFilePort | null, onError: (e: unknown) => void): Promise<number> {
	if (!to) return 0;
	let n = 0;
	try {
		for (const s of await listLocal(from)) {
			if (await readLocal(to, s.id)) continue;
			let whole = true;
			for (let i = 0; i < s.record.parts.length; i++) {
				const bytes = await from.read(partName(s.id, i));
				if (!bytes) {
					whole = false;
					break;
				}
				await to.write(partName(s.id, i), bytes);
			}
			if (!whole) continue;
			const desc = await from.read(descName(s.id));
			if (!desc) continue;
			await to.write(descName(s.id), desc);
			n++;
		}
	} catch (e) {
		onError(e);
	}
	return n;
}
