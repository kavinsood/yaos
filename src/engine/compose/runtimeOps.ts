/**
 * VaultRuntime operations that are not on the hot path: openDoc (bind),
 * user commands, diagnostics and the epoch-migration steps (§c.12).
 */

import * as Y from "yjs";
import { pathKey } from "../../core/paths/pathKey";
import { EMPTY_CONTENT_HASH, syncedFileKey } from "../../core/plan/planner";
import { streamDocId, type PathKey, type RemoteEntry, type StreamName, type SyncedEntry, type VaultPath } from "../../core/types";
import { ProtocolFailure } from "../../protocol/errors";
import type { EngineResultValue, UserCommand } from "../../protocol/messages";
import type { DiagnosticsBundle } from "../../protocol/status";
import { buildDiagnosticsBundle, DIAGNOSTICS_QUARANTINE_MAX } from "./diagnosticsBundle";
import { PENDING_DB_NAME_PREFIX, STORE, type MetaDocDeletes, type MetaPathBase, type MetaPathMove } from "../store/schema";
import type { DeviceId } from "../../core/types";
import { parseDbName } from "./knownEpoch";
import { readPending, readStoreIdentity } from "./storeIdentity";
import { readBase } from "../reconcile/store";
import { encodeStateAsUpdate } from "../body/yjsCounters";
import { docDeletesKey, pathBaseKey, pathMoveKey } from "./epochBases";
import { KeyringRefusedError } from "../keyring/writeGate";
import type { VaultRuntime } from "./vaultRuntime";
import type { RemoteView } from "../reconcile/deps";
import type { Ctx } from "../reconcile/context";

export async function openDoc(rt: VaultRuntime, path: VaultPath, viewId: number): Promise<EngineResultValue> {
	const cls = rt.rec.ctx.classify(path, 0);
	if (cls.excluded) return { t: "notBindable", reason: cls.reason === "too-large" ? "oversize" : "excluded" };
	if (cls.kind !== "markdown") return { t: "notBindable", reason: "not-markdown" };
	const e = bindTarget(rt, cls.pathKey);
	if (!e || e.kind !== "markdown") {
		rt.engine.bound.waiting.add(path);
		return { t: "notBindable", reason: "untracked" };
	}
	const docId = e.docId;
	const frozen = e.body?.frozen ?? false;
	const first = rt.engine.bound.add(docId, path, viewId);
	try {
		// One replica pin per bound doc (released when its last view closes); the views attach next (bodyAttach).
		if (first) await rt.log.bind(docId);
	} catch (err) {
		rt.engine.bound.remove(docId, viewId);
		throw err;
	}
	// The host closes a frozen bind and waits (host/binding.ts): `bindable` once the doc is released (checkBindable).
	if (frozen) rt.engine.bound.waiting.add(path);
	return { t: "bind", bind: { docId, kind: "markdown", frozen } };
}

/**
 * The live doc a view at `key` binds to (§d.2), or undefined. The remote entry at the path names it, unless the file
 * there is another doc's (the planner's L lookup, §f.2): a doc synced at the path whose file is still there (the
 * remote moved it away or put another doc at its path, and the planner has not moved it yet), or the remote doc
 * synced elsewhere with its file still there (the remote moved it onto a file this device has and the mover never
 * saw). "Where its file is" follows the user's observed renames (planner syncedFileKey): a file renamed onto the path
 * is the renamed doc's, and a doc whose file was renamed away has it there. Binding then merges one doc's file into another's CRDT. The view waits: `bindable` follows the pass that
 * settles the path, or the host asks again at the path the file moves to.
 *
 * Nor while the create's initial content is still missing from the replica (another device's frames in flight, or
 * announced but not applied yet; or an own create whose first merge has not run yet, e.g. the re-create right after an
 * epoch migration): the bind-time merge would take the empty text as the other side, empty the editor (against a base
 * at the create's content) or write it out as a conflict copy (no base); see replicaHasCreate. Same gate as the
 * planner's "body-empty" wait; the pass that applies the body posts `bindable`.
 *
 * Nor a doc whose delete is decided and waits on its own body records (`fileGone`), at its synced path: a file there
 * now is new, and the pass that creates its doc posts `bindable`. At the doc's remote path the file is its own.
 */
/** The part of the vault runtime bindTarget reads (bindTarget.test.ts builds one). */
export interface BindTargetRuntime {
	readonly port: { view(): Pick<RemoteView, "remote" | "remoteByPathKey"> };
	readonly rec: { readonly ctx: Pick<Ctx, "synced" | "local" | "renames" | "pk"> & { readonly store: Pick<Ctx["store"], "synced"> } };
}

export function bindTarget(rt: BindTargetRuntime, key: PathKey): RemoteEntry | undefined {
	const view = rt.port.view();
	const id = view.remoteByPathKey.get(key);
	const e = id ? view.remote.get(id) : undefined;
	if (!e || e.state !== "live") return undefined;
	if (e.body !== null && e.createHash !== EMPTY_CONTENT_HASH && !replicaHasCreate(e.body)) return undefined;
	const ctx = rt.rec.ctx;
	const s = ctx.synced(e.docId);
	if (s?.fileGone && s.pathKey === key) return undefined;
	// The doc's file is elsewhere: at its synced path, or where an observed rename took it (§f.2 L lookup).
	const own = s ? syncedFileKey(s, ctx.renames, ctx.pk) : null;
	if (own !== null && own !== key && ctx.local.has(own)) return undefined;
	if (!ctx.local.has(key)) return e;
	// The file at the path is another doc's: synced there, or renamed there by the user (sim storm seed 86: B renamed
	// a deleted doc's file offline onto the path the remote then moved a live doc to; the bind merged the deleted
	// doc's text into the live doc and destroyed its content).
	for (const o of ctx.store.synced.values()) {
		if (o.docId !== e.docId && (o.pathKey === key || syncedFileKey(o, ctx.renames, ctx.pk) === key)) return undefined;
	}
	return e;
}

/**
 * The replica may hold the create's content. `hasContent` alone does not say so: it also counts rows the relay
 * announced (remoteHeadSeq) that are not applied yet. While not caught up, the replica holds the create only if a row
 * or checkpoint from another device was applied or this device produced a frame. Otherwise the bind-time merge would
 * see "" against a base at the create's content (a §c.5 merged alias restarts its synced record at the winner's
 * create) and empty the editor: sim seed 23, an epoch migration where concurrent re-creates merge before the
 * winner's frames arrive (bindTarget.test.ts).
 */
function replicaHasCreate(b: NonNullable<RemoteEntry["body"]>): boolean {
	if (!b.hasContent) return false;
	return b.caughtUp || b.version.remoteSeq > 0 || b.version.localOrder > 0;
}

export async function command(rt: VaultRuntime, c: UserCommand): Promise<EngineResultValue> {
	switch (c.t) {
		case "reconcileNow":
			rt.sched.request({ t: "full" }, true);
			return { t: "ok" };
		case "approveBrake": {
			if (!rt.brake || rt.brake.id !== c.brakeId) return { t: "ok" };
			await rt.takeSnapshot("brake");
			rt.rec.approveBrake(c.brakeId);
			rt.brake = null;
			rt.sched.request({ t: "full" }, true);
			rt.postStatus();
			return { t: "ok" };
		}
		case "rejectBrake": {
			if (!rt.brake || rt.brake.id !== c.brakeId) return { t: "ok" };
			await rt.rec.rejectBrake(c.brakeId);
			rt.brake = null;
			rt.sched.request({ t: "full" }, true);
			rt.postStatus();
			return { t: "ok" };
		}
		case "createSnapshot":
			// null: over the size cap (a notice says so) or the write failed (logged).
			if ((await rt.takeSnapshot("manual")) === null) throw new Error("the snapshot could not be saved (vault over the 256 MiB snapshot limit, or a write error)");
			return { t: "ok" };
		case "listSnapshots": {
			const list = await rt.snaps.list();
			return {
				t: "snapshots",
				snapshots: list.map((s) => ({ id: s.id, createdAtMs: s.createdAtMs, reason: s.reason, files: s.files, bytes: s.bytes, where: s.where, ...(s.device !== null ? { device: s.device } : {}) })),
			};
		}
		case "snapshotFiles": {
			// Verifies the whole snapshot first (a remote one is downloaded): unknown id bad-request, damaged content_corrupt.
			const m = await rt.snaps.manifest(c.snapshotId);
			return {
				t: "snapshotFiles", snapshotId: c.snapshotId,
				files: m.files.map((f) => ({ path: f.path, kind: f.kind, size: f.size })),
				skipped: m.skipped.map((f) => ({ path: f.path, reason: f.reason })),
			};
		}
		case "restoreSnapshot": {
			const r = await rt.snaps.restore(c.snapshotId, c.paths);
			rt.diag(`restore ${c.snapshotId}: ${r.restored.length} restored, ${r.copies.length} copies, ${r.failed.length} failed`);
			rt.sched.request({ t: "full" }, true);
			return { t: "restored", restored: r.restored.length, unchanged: r.unchanged.length, copies: r.copies, failed: r.failed };
		}
		case "deleteSnapshot":
			await rt.snaps.remove(c.snapshotId);
			return { t: "ok" };
		case "exportDiagnostics":
			return { t: "diagnostics", bundle: await diagnostics(rt, c.includePaths === true) };
		case "releaseQuarantine": {
			if (streamDocId(c.stream as StreamName)) await rt.log.releaseQuarantine(c.stream as StreamName);
			rt.sched.request({ t: "full" });
			return { t: "ok" };
		}
		// e2ee-design §18.4. A runtime runs for a pinned device only (pinGate.ts): the creation path is the KeyReader's.
		case "enableE2ee":
			c.rk.fill(0);
			throw refused("this device is already pinned");
		case "installKey": {
			const r = await keyCommand(() => (c.source === "qr" ? rt.log.installKeyQr(c.e, c.k) : rt.log.installKeyRk(c.rk)));
			// pending: kept unverified (nothing persisted) until `k` shows its record (§12.4 (i)); status says key-missing.
			if (r === "conflict") throw refused("the key does not match the vault's key record for its epoch; a verified key is never replaced");
			return { t: "ok" };
		}
		case "pinSuite0":
			throw refused("this device is already pinned");
		case "revokeRekey": {
			const o = await keyCommand(() => rt.log.revokeRekey(c.rk));
			if (o === "lost") throw refused("another key record won the epoch; revoke again");
			return { t: "ok" };
		}
		case "cleanUpAttachments": {
			const r = await rt.log.cleanUpBlobs(() => rt.blobs.liveHashes());
			return { t: "attachmentsCleaned", ...r };
		}
		default:
			return { t: "ok" };
	}
}

function refused(message: string): ProtocolFailure {
	return new ProtocolFailure({ code: "refused", message, retryable: false });
}

async function keyCommand<T>(f: () => T | Promise<T>): Promise<T> {
	try {
		return await f();
	} catch (e) {
		throw e instanceof KeyringRefusedError ? refused(e.message) : e;
	}
}

async function diagnostics(rt: VaultRuntime, includePaths: boolean): Promise<DiagnosticsBundle> {
	const c = rt.log.c;
	const quarantine: { stream: string; seq: number; reason: string; bytes: number }[] = [];
	const frozen: { stream: string; reason: string }[] = [];
	for (const s of c.repo.streams()) {
		if (s.frozen === 1) frozen.push({ stream: s.stream, reason: s.frozenReason ?? "frozen" });
		if (quarantine.length < DIAGNOSTICS_QUARANTINE_MAX) for (const q of await c.repo.quarantineOf(s.stream)) quarantine.push({ stream: s.stream, seq: q.seq, reason: q.reason, bytes: q.bytes.length });
	}
	const stores: Record<string, { records: number; bytes: number }> = {};
	stores[STORE.synced] = { records: rt.rec.ctx.store.synced.size, bytes: 0 };
	stores[STORE.outbox] = { records: [...c.outbox.values()].length, bytes: 0 };
	stores[STORE.intents] = { records: rt.rec.ctx.store.intents.size, bytes: 0 };
	const synced = rt.rec.ctx.store.synced;
	return buildDiagnosticsBundle({
		generatedAtMs: rt.o.ports.clock.now(), clientVersion: rt.o.clientVersion, status: rt.status(),
		events: rt.log.diagnostics(), quarantine, frozen, stores, pathOf: (docId) => synced.get(docId)?.path ?? null,
	}, rt.o.ports, includePaths);
}

/**
 * §c.12 steps 1 and 3 on the old runtime: save bound views, snapshot, and read for the new epoch's merges the synced
 * bases by path (the old `baseText` rows that read back as written) and what each old doc deleted (oldDeletes).
 * Both are stored with the new DB's identity (epochBases.ts), and so are the user's renames this device had not
 * published (§c.12 "Renames": observed, or kept on a synced record): the new epoch has no record to keep them on.
 */
export async function prepareEpochMigration(rt: VaultRuntime): Promise<{ bases: MetaPathBase[]; docDeletes: MetaDocDeletes[]; moves: MetaPathMove[] }> {
	const bound = [...rt.engine.bound.byId.keys()];
	if (bound.length > 0) {
		await rt.engine.link.request({ t: "saveViews", docIds: bound }).catch(() => undefined);
		// The saves' disk check now (boundSaved: the synced base the new epoch merges against), not after its debounce.
		await Promise.all(bound.map((d) => {
			const b = rt.engine.bound.get(d);
			return b ? rt.engine.boundDisk.checkSaved(b) : undefined;
		}));
	}
	// Step 5 drops the outbox: own edits only the replica holds go to the files first (mergeStrandedEdits). Passes
	// stopped with `migrating`; the one running finishes before.
	await rt.sched.drain();
	const merged = await rt.rec.mergeStrandedEdits().catch((e) => {
		rt.diag(`epoch stranded-edit merge failed: ${String(e)}`);
		return 0;
	});
	if (merged > 0) rt.diag(`epoch: ${merged} doc(s) with own unsent edits merged to disk`);
	await rt.takeSnapshot("epoch");
	const bases = new Map<PathKey, MetaPathBase>();
	const docDeletes: MetaDocDeletes[] = [];
	const rows = await rt.db.tx([STORE.baseText], "readonly", (tx) => tx.getAll(STORE.baseText)).catch(() => []);
	const byDoc = new Map(rows.map((r) => [r.docId, r]));
	for (const s of rt.rec.ctx.store.synced.values()) {
		if (s.kind === "blob") continue;
		const del = await oldDeletes(rt, s);
		if (del) docDeletes.push(del);
		const r = s.hasBase ? byDoc.get(s.docId) : undefined; // markdown text or canvas merge text
		if (!r || (await readBase(r, rt.o.ports.hash)) === null) continue;
		const k = pathKey(s.path);
		bases.set(k, {
			key: pathBaseKey(k), contentHash: r.contentHash, deflated: r.deflated, chars: r.chars,
			...(del?.keys ? { deleted: del.keys } : {}),
		});
	}
	return { bases: [...bases.values()], docDeletes, moves: unpublishedRenames(rt) };
}

/**
 * The user's renames the old epoch had not published, by source path key (the latest wins): those a synced record
 * kept (fileGone, renamedTo: the write gate refused the nsRename, or ns was not ready), and the observed ones in
 * memory. The new epoch's planner reads them as observed renames, so the doc at the old path moves with its file;
 * dropped with the old store, the file became a new doc and the doc came back at the old path (sim suite-1
 * wipe/revoke/roll seed 40: a canvas edited and renamed key-missing, then an epoch restore and a store loss).
 */
function unpublishedRenames(rt: VaultRuntime): MetaPathMove[] {
	const out = new Map<PathKey, MetaPathMove>();
	const add = (from: VaultPath, to: VaultPath, atMs: number): void => {
		const k = pathKey(from);
		const had = out.get(k);
		if (!had || had.atMs <= atMs) out.set(k, { key: pathMoveKey(k), from, to, atMs });
	};
	for (const s of rt.rec.ctx.store.synced.values()) if (s.fileGone && s.renamedTo) add(s.path, s.renamedTo.to, s.renamedTo.atMs);
	for (const r of rt.rec.ctx.renames) add(r.from, r.to, r.atMs);
	return [...out.values()];
}

/**
 * What the old doc deleted (DESIGN §c.12 "Deletes"), so the new epoch can delete it again; null: nothing.
 *  - Canvas: the record keys. A Y.Map key keeps its deleted item after GC (only the content goes), and record ids
 *    are stable: they are in the file, so they name the record in a restored doc and in one a peer re-created alike.
 *  - Markdown: the delete set. GC keeps only the deleted items' ids and lengths, so it names characters only in the
 *    same doc, which a restore keeps (and a reset does not).
 */
async function oldDeletes(rt: VaultRuntime, s: SyncedEntry): Promise<MetaDocDeletes | null> {
	if (s.kind !== "canvas" && s.kind !== "markdown") return null;
	const h = await rt.rec.ctx.log.acquireBody(s.docId, s.kind).catch(() => null);
	if (!h) return null;
	try {
		const key = docDeletesKey(s.docId);
		if (s.kind === "markdown") {
			if (Y.createDeleteSetFromStructStore(h.doc.store).clients.size === 0) return null;
			// Encoded against the doc's own state vector: no structs, the delete set only.
			return { key, kind: "markdown", update: encodeStateAsUpdate(h.doc, Y.encodeStateVector(h.doc)) };
		}
		const keys: string[] = [];
		for (const [map, prefix] of [["nodes", "n:"], ["edges", "e:"]] as const) {
			for (const [id, item] of h.doc.getMap(map)._map) if (item.deleted) keys.push(prefix + id);
		}
		return keys.length > 0 ? { key, kind: "canvas", keys } : null;
	} finally {
		h.release();
	}
}

/**
 * §c.12 step 6: the new epoch reached live; retire and delete every other epoch's DB of this vault and install. Not
 * only the one the migration left: a crash between the migration and this step leaves two DBs, the restart connects
 * first (knownEpoch.ts) and opens the current one without migrating, and the old one would stay for good, every later
 * start waiting for the relay to name the epoch. Once the new DB exists the old one holds nothing it needs: the bases
 * were stored with the new DB's identity.
 *
 * Each old DB is a store with its own identity (identity-per-store §4 "vaultEpoch change", decision 2): it is retired
 * by its retire key first (the self-retire; already gone counts), so the server's device list does not keep it. A
 * retire that gets no answer keeps the DB, and the next time this store goes live tries again. A DB under this store's
 * own deviceId (none since identities per store) is only deleted.
 */
export async function retireOldEpochs(rt: VaultRuntime): Promise<void> {
	const { vaultId, installKey } = rt.o.config;
	const self = rt.log.c.self;
	const storage = rt.o.ports.storage;
	let names: readonly string[];
	try {
		names = await storage.listDatabases();
	} catch (e) {
		rt.diag(`old epoch DB listing failed: ${String(e)}`);
		return;
	}
	for (const name of names) {
		const p = parseDbName(name);
		if (!p || p.vaultId !== vaultId || p.storeKey !== installKey || p.vaultEpoch === rt.vaultEpoch) continue;
		try {
			const old = await readStoreIdentity(storage, name).catch(() => null);
			const identity = rt.o.ports.identity;
			if (old && old.deviceId !== self && old.retireKey !== undefined && identity?.retire) {
				const r = await identity.retire({ deviceId: old.deviceId, retireKey: old.retireKey });
				if (!r.ok) {
					rt.diag(`old epoch store retire failed (${r.reason}): kept until the next live`);
					continue;
				}
				rt.diag(`old epoch store ${r.retired ? "retired" : "already gone"}`);
			}
			if (rt.stopped) return;
			await storage.deleteDatabase(name);
			rt.diag(`old epoch DB deleted`);
		} catch (e) {
			rt.diag(`old epoch DB delete failed: ${String(e)}`);
		}
	}
}

/** At most this many orphan stores are looked at per sweep: the device status route takes 32 ids. */
export const ORPHAN_SWEEP_MAX = 32;

/**
 * identity-per-store §6.4 orphan sweep (phase 5), once per runtime when it goes live, after retireOldEpochs: the
 * stores of this vault on this origin under another install key (`yaos3:<vaultId>:*:<key>` and
 * `yaos3-pending:<vaultId>:<key>`). Such a store is this registration's after its install key was lost (local storage
 * cleared, IndexedDB kept) or, on a shared desktop origin, another registration's of the same vault: the two cannot be
 * told apart here, so nothing is deleted on age or on name. The server decides: a store whose identity it reports
 * `retired` (tombstoned: it never authenticates again, so the store can never send; its own install, if one still
 * exists, replaces it from its mirrors, which this sweep never touches; inactivity retirement gets an abandoned one
 * there after 90 days) is deleted. `live` and `unknown` are kept and asked again at a later live: an unknown identity
 * may be a pending one another registration is registering right now, or one a server restore forgot whose install
 * has not started since.
 *
 * Never touched: this install's own stores (retireOldEpochs owns the other epochs), and any side-file dir (an orphan's
 * `state/<deviceId>/` may be another install's, synced into this folder; a lineage dir goes only with
 * VaultRuntime.dropLineageDirs). No timer: one listDatabases per live, and one status call only while orphans exist.
 */
export async function sweepOrphanStores(rt: VaultRuntime): Promise<void> {
	const { vaultId, installKey } = rt.o.config;
	const status = rt.o.ports.identity?.status?.bind(rt.o.ports.identity);
	const storage = rt.o.ports.storage;
	const self = rt.log.c.self;
	if (!status || rt.stopped) return;
	const pendingPrefix = `${PENDING_DB_NAME_PREFIX}:${encodeURIComponent(vaultId)}:`;
	const ownPending = `${pendingPrefix}${encodeURIComponent(installKey)}`;
	let names: readonly string[];
	try {
		names = await storage.listDatabases();
	} catch (e) {
		rt.diag(`orphan sweep: listing failed: ${String(e)}`);
		return;
	}
	const found: { name: string; deviceId: DeviceId }[] = [];
	for (const name of names) {
		if (found.length >= ORPHAN_SWEEP_MAX || rt.stopped) break;
		const p = parseDbName(name);
		const store = p !== null && p.vaultId === vaultId && p.storeKey !== installKey;
		const pending = !store && name.startsWith(pendingPrefix) && name !== ownPending;
		if (!store && !pending) continue;
		try {
			if (store) {
				const id = await readStoreIdentity(storage, name);
				if (id && id.deviceId !== self) found.push({ name, deviceId: id.deviceId });
			} else {
				const id = await readPending(storage, name);
				if (id && id.deviceId !== self) found.push({ name, deviceId: id.deviceId });
			}
		} catch (e) {
			rt.diag(`orphan sweep: unreadable store skipped: ${String(e)}`);
		}
	}
	if (found.length === 0 || rt.stopped) return;
	const states = await status([...new Set(found.map((f) => f.deviceId))]);
	if (!states) {
		rt.diag("orphan sweep: no device status answer; kept until a later live");
		return;
	}
	let deleted = 0;
	for (const f of found) {
		if (states.get(f.deviceId) !== "retired") continue;
		if (rt.stopped) return;
		try {
			await storage.deleteDatabase(f.name);
			deleted++;
		} catch (e) {
			rt.diag(`orphan sweep: delete failed: ${String(e)}`);
		}
	}
	rt.diag(`orphan sweep: ${found.length} orphan store(s), ${deleted} deleted`);
}
