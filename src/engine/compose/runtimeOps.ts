/**
 * VaultRuntime operations that are not on the hot path: openDoc (bind),
 * user commands, diagnostics and the epoch-migration steps (§c.12).
 */

import * as Y from "yjs";
import { pathKey } from "../../core/paths/pathKey";
import { EMPTY_CONTENT_HASH } from "../../core/plan/planner";
import { streamDocId, type DocId, type PathKey, type RemoteEntry, type StreamName, type VaultEpoch, type VaultPath } from "../../core/types";
import { badRequest } from "../../protocol/errors";
import type { EngineResultValue, UserCommand } from "../../protocol/messages";
import type { DiagnosticsBundle } from "../../protocol/status";
import { buildDiagnosticsBundle, DIAGNOSTICS_QUARANTINE_MAX } from "./diagnosticsBundle";
import { dbName, STORE } from "../store/schema";
import { readBase } from "../reconcile/store";
import type { VaultRuntime } from "./vaultRuntime";

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
	const first = rt.engine.bound.add(docId, path, viewId);
	try {
		// One replica pin per bound doc (released when its last view closes); the views attach next (bodyAttach).
		if (first) await rt.log.bind(docId);
	} catch (err) {
		rt.engine.bound.remove(docId, viewId);
		throw err;
	}
	return { t: "bind", bind: { docId, kind: "markdown", frozen: e.body?.frozen ?? false } };
}

/**
 * The live doc a view at `key` binds to (§d.2), or undefined. The remote entry at the path names it, unless the file
 * there is another doc's (the planner's L lookup, §f.2): a doc synced at the path whose file is still there (the
 * remote moved it away or put another doc at its path, and the planner has not moved it yet), or the remote doc
 * synced elsewhere with its file still there (the remote moved it onto a file this device has and the mover never
 * saw). Binding then merges one doc's file into another's CRDT. The view waits: `bindable` follows the pass that
 * settles the path, or the host asks again at the path the file moves to.
 *
 * Nor while the create's initial content is still missing from the body (another device's frames in flight, or an
 * own create whose first merge has not run yet, e.g. the re-create right after an epoch migration): the bind-time
 * merge would take the empty text, with no base, as the other side of a conflict, empty the editor and write it out
 * as a conflict copy. Same gate as the planner's "body-empty" wait; the pass that fills the body posts `bindable`.
 *
 * Nor a doc whose delete is decided and waits on its own body records (`fileGone`), at its synced path: a file there
 * now is new, and the pass that creates its doc posts `bindable`. At the doc's remote path the file is its own.
 */
export function bindTarget(rt: VaultRuntime, key: PathKey): RemoteEntry | undefined {
	const view = rt.port.view();
	const id = view.remoteByPathKey.get(key);
	const e = id ? view.remote.get(id) : undefined;
	if (!e || e.state !== "live") return undefined;
	if (e.body !== null && !e.body.hasContent && e.createHash !== EMPTY_CONTENT_HASH) return undefined;
	const ctx = rt.rec.ctx;
	const s = ctx.synced(e.docId);
	if (s?.fileGone && s.pathKey === key) return undefined;
	if (s && !s.fileGone && s.pathKey !== key && ctx.local.has(s.pathKey)) return undefined;
	if (!ctx.local.has(key)) return e;
	for (const o of ctx.store.synced.values()) if (o.pathKey === key && o.docId !== e.docId) return undefined;
	return e;
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
			return { t: "snapshots", snapshots: list.map((s) => ({ id: s.id, createdAtMs: s.createdAtMs, reason: s.reason, files: s.files, bytes: s.bytes })) };
		}
		case "snapshotFiles": {
			const m = await rt.snaps.manifest(c.snapshotId);
			if (!m) throw badRequest(`snapshot ${c.snapshotId} not found`);
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
			const docId = streamDocId(c.stream as StreamName);
			if (docId) await rt.log.releaseQuarantine(docId);
			rt.sched.request({ t: "full" });
			return { t: "ok" };
		}
		default:
			return { t: "ok" };
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
 * §c.12 steps 1 and 3 on the old runtime: save bound views, snapshot, and read
 * the synced bases into a path-keyed map for the new epoch's merges.
 */
export async function prepareEpochMigration(rt: VaultRuntime): Promise<Map<PathKey, string>> {
	const bound = [...rt.engine.bound.byId.keys()];
	if (bound.length > 0) {
		await rt.engine.link.request({ t: "saveViews", docIds: bound }).catch(() => undefined);
		// The saves' disk check now (boundSaved: the synced base the new epoch merges against), not after its debounce.
		await Promise.all(bound.map((d) => {
			const b = rt.engine.bound.get(d);
			return b ? rt.engine.boundDisk.checkSaved(b) : undefined;
		}));
	}
	await rt.takeSnapshot("epoch");
	const bases = new Map<PathKey, string>();
	const rows = await rt.db.tx([STORE.baseText], "readonly", (tx) => tx.getAll(STORE.baseText)).catch(() => []);
	const byDoc = new Map(rows.map((r) => [r.docId, r]));
	for (const s of rt.rec.ctx.store.synced.values()) {
		if (s.kind !== "markdown" || !s.hasBase) continue;
		const r = byDoc.get(s.docId);
		const text = r ? readBase(r) : null;
		if (text !== null) bases.set(pathKey(s.path), text);
	}
	return bases;
}

/** §c.12 step 6: the new epoch reached live; delete the old DB. */
export async function retireOldEpoch(rt: VaultRuntime, old: VaultEpoch): Promise<void> {
	if (old === rt.vaultEpoch) return;
	const name = dbName(rt.o.config.vaultId, old, rt.o.config.deviceId);
	try {
		await rt.o.ports.storage.deleteDatabase(name);
		rt.diag(`old epoch DB deleted`);
	} catch (e) {
		rt.diag(`old epoch DB delete failed: ${String(e)}`);
	}
}

/** Y.Doc text of a resident replica (tests). */
export function residentText(rt: VaultRuntime, docId: DocId): string | null {
	const h = rt.log.handleOf(docId);
	return h ? (h.doc as Y.Doc).getText("text").toString() : null;
}
