/** STAND-IN engine: main -> engine message handling. See engine.ts. */

import * as Y from "yjs";
import type { MainToEngine, UserCommand, EngineResultValue } from "../../protocol/messages";
import { PROTOCOL_VERSION } from "../../protocol/messages";
import { MAIN_IN, persistedOf } from "./docs";
import { isSyncedPath, project, readPaths } from "./diskSync";
import type { StandinEngine } from "./engine";

const CLOSE_PROJECT_DELAY_MS = 250;

export function handleMessage(e: StandinEngine, m: MainToEngine): void {
	switch (m.t) {
		case "ping":
			e.answer(m.rid, { t: "pong" });
			return;
		case "init": {
			if (e.options.initError) {
				e.fail(m.rid, e.options.initError);
				return;
			}
			if (m.config.protocolVersion !== PROTOCOL_VERSION) {
				e.fail(m.rid, { code: "version-mismatch", message: `host protocol ${m.config.protocolVersion}`, retryable: false });
				return;
			}
			e.config = m.config;
			const recovered = e.loadStore();
			e.joinHub();
			e.answer(m.rid, { t: "ready", protocolVersion: PROTOCOL_VERSION, vaultEpoch: null, recovered });
			e.postStatus();
			return;
		}
		case "result":
			e.settle(m.re, m.value, null);
			return;
		case "error":
			e.settle(m.re, null, m.error);
			return;
		default:
			break;
	}
	if (!e.config) {
		if ("rid" in m) e.fail(m.rid, { code: "not-ready", message: "init first", retryable: true });
		return;
	}
	switch (m.t) {
		case "shutdown":
			flushPersist(e);
			e.answer(m.rid, { t: "ok" });
			return;
		case "lifecycle":
			if (m.event === "hidden" || m.event === "pagehide" || m.event === "freeze") flushPersist(e);
			return;
		case "observations":
			e.scanChunk(m.chunk.map((o) => o.stat));
			e.answer(m.rid, { t: "ok" });
			if (m.complete) {
				for (const st of e.docs.values()) {
					if (st.bound.size === 0 && st.diskText === null) project(e, st);
				}
				e.postStatus();
			}
			return;
		case "vaultEvents": {
			const paths: string[] = [];
			for (const ev of m.events) {
				if (ev.t === "create" || ev.t === "modify") paths.push(ev.path);
				else if (ev.t === "rename") paths.push(ev.to);
			}
			const synced = [...new Set(paths)].filter(isSyncedPath);
			if (synced.length > 0) void readPaths(e, synced);
			return;
		}
		case "openDoc": {
			const key = e.keyOf(m.path);
			const st = e.docs.get(key);
			if (!st) {
				if (!isSyncedPath(m.path)) {
					e.answer(m.rid, { t: "notBindable", reason: "not-markdown" });
					return;
				}
				e.waiting.add(key);
				e.answer(m.rid, { t: "notBindable", reason: "untracked" });
				return;
			}
			st.bound.add(m.viewId);
			e.waiting.delete(key);
			e.dropDocUpdates(st.docId); // the bind state covers everything queued
			const value: EngineResultValue = {
				t: "bind",
				bind: { docId: st.docId, kind: "markdown", state: Y.encodeStateAsUpdate(st.doc), stateVector: Y.encodeStateVector(st.doc), baseText: st.base, baseHash: null, frozen: false },
			};
			e.answer(m.rid, value);
			return;
		}
		case "closeDoc": {
			const st = e.byDocId.get(m.docId);
			if (!st) return;
			st.bound.delete(m.viewId);
			if (st.bound.size > 0) return;
			e.dropDocUpdates(st.docId);
			e.options.clock.setTimer(CLOSE_PROJECT_DELAY_MS, () => {
				if (!e.disposed && st.bound.size === 0) project(e, st);
			});
			return;
		}
		case "localUpdate":
		case "bindDelta": {
			const st = e.byDocId.get(m.docId);
			if (!st) return;
			e.stats.localUpdates++;
			Y.applyUpdate(st.doc, m.update, MAIN_IN);
			return;
		}
		case "boundSaved": {
			const st = e.byDocId.get(m.docId);
			if (!st) return;
			st.base = m.text;
			st.diskText = m.text;
			st.diskFp = m.fingerprint;
			e.seen.set(st.key, { size: m.stat.size, mtimeMs: m.stat.mtimeMs });
			e.persistNow(st);
			return;
		}
		case "boundExternalMerged":
			return;
		case "docCredit":
			e.onCredit(m.bytes);
			return;
		case "command":
			e.answer(m.rid, command(e, m.command));
			return;
		default:
			return;
	}
}

function flushPersist(e: StandinEngine): void {
	const store = e.options.store;
	if (!store) return;
	for (const st of e.docs.values()) {
		if (st.persistTimer !== null) e.options.clock.clearTimer(st.persistTimer);
		st.persistTimer = null;
		store.set(st.key, persistedOf(st));
	}
}

function command(e: StandinEngine, c: UserCommand): EngineResultValue {
	switch (c.t) {
		case "listSnapshots":
			return { t: "snapshots", snapshots: [] };
		case "exportDiagnostics": {
			e.postStatus();
			return { t: "ok" };
		}
		default:
			return { t: "ok" };
	}
}
