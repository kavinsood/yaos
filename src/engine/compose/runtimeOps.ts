/**
 * VaultRuntime operations that are not on the hot path: openDoc (bind),
 * user commands, diagnostics and the epoch-migration steps (§c.12).
 */

import * as Y from "yjs";
import { pathKey } from "../../core/paths/pathKey";
import { streamDocId, type DocId, type PathKey, type StreamName, type VaultEpoch, type VaultPath } from "../../core/types";
import type { EngineResultValue, UserCommand } from "../../protocol/messages";
import type { DiagnosticsBundle } from "../../protocol/status";
import { utf8Encode } from "../../core/codec/lib0";
import { encodeStateAsUpdate } from "../body/yjsCounters";
import { dbName, STORE } from "../store/schema";
import { readBase } from "../reconcile/store";
import type { VaultRuntime } from "./vaultRuntime";

export async function openDoc(rt: VaultRuntime, path: VaultPath, viewId: number): Promise<EngineResultValue> {
	const cls = rt.rec.ctx.classify(path, 0);
	if (cls.excluded) return { t: "notBindable", reason: cls.reason === "too-large" ? "oversize" : "excluded" };
	if (cls.kind !== "markdown") return { t: "notBindable", reason: "not-markdown" };
	const view = rt.port.view();
	const id = view.remoteByPathKey.get(cls.pathKey);
	const e = id ? view.remote.get(id) : undefined;
	if (!e || e.state !== "live" || e.kind !== "markdown") {
		rt.engine.bound.waiting.add(path);
		return { t: "notBindable", reason: "untracked" };
	}
	const docId = e.docId;
	const first = rt.engine.bound.add(docId, path, viewId);
	let bind: { state: Uint8Array; stateVector: Uint8Array };
	try {
		bind = await rt.log.bind(docId);
		if (!first) rt.log.unbind(docId);
	} catch (err) {
		rt.engine.bound.remove(docId, viewId);
		throw err;
	}
	const s = rt.rec.ctx.synced(docId);
	const baseText = s?.hasBase ? await rt.rec.ctx.store.loadBase(docId) : null;
	return {
		t: "bind",
		bind: {
			docId, kind: "markdown", state: bind.state, stateVector: bind.stateVector, baseText,
			baseHash: baseText !== null && s ? s.contentHash : null, frozen: e.body?.frozen ?? false,
		},
	};
}

export function fullState(rt: VaultRuntime, docId: DocId): Uint8Array | null {
	const h = rt.log.handleOf(docId);
	return h ? encodeStateAsUpdate(h.doc) : null;
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
			await rt.takeSnapshot("manual");
			return { t: "ok" };
		case "listSnapshots": {
			const list = await rt.snaps.list();
			return { t: "snapshots", snapshots: list.map((s) => ({ id: s.id, createdAtMs: s.createdAtMs, files: s.files, bytes: s.bytes })) };
		}
		case "restoreSnapshot": {
			const r = await rt.snaps.restore(c.snapshotId, c.paths);
			rt.diag(`restore ${c.snapshotId}: ${r.restored.length} restored, ${r.copies.length} copies, ${r.failed.length} failed`);
			rt.sched.request({ t: "full" }, true);
			return { t: "ok" };
		}
		case "exportDiagnostics":
			return { t: "diagnostics", bundle: await diagnostics(rt) };
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

async function diagnostics(rt: VaultRuntime): Promise<DiagnosticsBundle> {
	const c = rt.log.c;
	const quarantine: { stream: string; seq: number; reason: string; bytes: number }[] = [];
	const frozenDocs: { pathHash: string; reason: string }[] = [];
	for (const s of c.repo.streams()) {
		if (s.frozen === 1) frozenDocs.push({ pathHash: await shortHash(rt, s.stream), reason: s.frozenReason ?? "frozen" });
		if (quarantine.length < 200) for (const q of await c.repo.quarantineOf(s.stream)) quarantine.push({ stream: s.stream, seq: q.seq, reason: q.reason, bytes: q.bytes.length });
	}
	const stores: Record<string, { records: number; bytes: number }> = {};
	stores[STORE.synced] = { records: rt.rec.ctx.store.synced.size, bytes: 0 };
	stores[STORE.outbox] = { records: [...c.outbox.values()].length, bytes: 0 };
	stores[STORE.intents] = { records: rt.rec.ctx.store.intents.size, bytes: 0 };
	return {
		generatedAtMs: rt.o.ports.clock.now(), clientVersion: rt.o.clientVersion, status: rt.status(),
		recentEvents: rt.log.diagnostics().slice(-200), quarantine, frozenDocs, stores, paths: null,
	};
}

async function shortHash(rt: VaultRuntime, s: string): Promise<string> {
	const h = await rt.o.ports.hash.sha256(utf8Encode(s));
	let out = "";
	for (let i = 0; i < 6; i++) out += h[i]!.toString(16).padStart(2, "0");
	return out;
}

/**
 * §c.12 steps 1 and 3 on the old runtime: save bound views, snapshot, and read
 * the synced bases into a path-keyed map for the new epoch's merges.
 */
export async function prepareEpochMigration(rt: VaultRuntime): Promise<Map<PathKey, string>> {
	const bound = [...rt.engine.bound.byId.keys()];
	if (bound.length > 0) await rt.engine.link.request({ t: "saveViews", docIds: bound }).catch(() => undefined);
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
