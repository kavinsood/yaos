/**
 * DESIGN §c.10, §d.6, §d.7: a reader that meets rules it does not implement halts in `upgrade-required` and tells
 * the user to update; it never guesses. Here the rules arrive as a checkpoint (written by a newer client) on ns,
 * cfg and snap; the reader used to treat the gate's reader-dependent failure as a disputed checkpoint: re-read
 * the rows below it on its old rules, or freeze the stream `checkpoint-disputed` for good when they were GC'd.
 *
 *  (a) newer ns / cfg / snap checkpoints (rows still on the relay): each fold halts at the checkpoint, nothing is
 *      read past it, stored or marked; phase upgrade-required, one error notice and one popup per fold, the
 *      status bar names the vault and what stopped; body streams keep syncing;
 *  (b) the same with the rows below the checkpoints GC'd: still a halt, never a freeze;
 *  (c) the plugin is upgraded (same store, EngineTuning.knownRules raised): the next start adopts the checkpoints
 *      and folds past them, with nothing left of the halt;
 *  (d) a corrupt checkpoint of this rules version is still disputed (rows re-read, or frozen when GC'd);
 *  (e) a checkpoint that does not open for want of a key waits (held, not disputed or frozen) and is adopted once
 *      the keys change;
 *  (f) an ns upgradeRules row above the known version shows upgrade-required too (it used to leave phase live),
 *      and an unopened row is re-gated on the next session start under suite 0 as well (it used to stay halted).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointEncoding } from "../../core/envelope";
import { CFG_FOLD_RULES_VERSION } from "../../core/cfg/fold";
import { encodeCheckpointContent } from "../../core/codec/contents";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../../core/codec/nsFoldV1";
import { FOLD_RULES_VERSION } from "../../core/limits";
import { SNAP_FOLD_RULES_VERSION, snapLive } from "../../core/snap/fold";
import { snapshotId, type SnapRecord } from "../../core/snap/record";
import { CFG_STREAM, NS_STREAM, SNAP_STREAM, type ConfigRelPath, type ContentHash, type Seq, type StreamName, type VaultId, type VaultPath } from "../../core/types";
import { VAULT_UPGRADE_NOTICE, VAULT_UPGRADE_STOPPED, VAULT_UPGRADE_TEXT, type StatusSnapshot } from "../../protocol/status";
import { renderStatus } from "../../host/ui/statusBar";
import { SimRelay } from "../../sim/relay";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { sealCheckpoint } from "../ingest/envelope";
import type { StoragePort } from "../../ports/storage";
import { LOCAL_FLAG_UNOPENED } from "../sync/foldRuntime";
import type { LogEngine } from "./engine";
import { regateUnopened } from "./quarantineRelease";
import { createDoc, docText, faultyCrypto, startTestEngine, until } from "./testHarness";
import type { EngineOptions, EngineTuning } from "./options";

const VAULT = "vault-test" as VaultId;
const APP = "app.json" as ConfigRelPath;
const FOLDS = [NS_STREAM, CFG_STREAM, SNAP_STREAM] as const;
const NO_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 1e9, hardRows: 1e9, hardBytes: 1e15, settleMs: 1e9, fallbackMs: 1e9, nsRows: 1e9, nsBytes: 1e12 };
const TUNING: Partial<EngineTuning> = { checkpoint: NO_CKPT };
/** The plugin after the update: it implements the rules one above this build's (EngineTuning.knownRules). */
const UPGRADED: Partial<EngineTuning> = { ...TUNING, knownRules: { ns: FOLD_RULES_VERSION + 1, cfg: CFG_FOLD_RULES_VERSION + 1, snap: SNAP_FOLD_RULES_VERSION + 1 } };
const RUNNING = { phase: "running", lastError: null } as const;
const noop = createNoopCrypto(createWebHash());
const H = (n: number) => n.toString(16).padStart(64, "0") as ContentHash;
const T0 = Date.UTC(2026, 9, 7);
const snapRec = (createdAtMs: number): SnapRecord => ({
	version: 1, snapshotId: snapshotId(createdAtMs, "daily"), createdAtMs, deviceLabel: "laptop", reason: "daily", format: 1,
	fileCount: 1, totalBytes: 10, bundleDigest: H(1), parts: [{ address: H(2), size: 120, sha256: H(2) }],
});

interface Writer {
	readonly a: LogEngine;
	readonly docs: readonly string[];
	/** Checkpoint coversSeq per fold stream (the writer's fold at the time). */
	readonly covers: Record<string, Seq>;
}

/** A writes notes, settings and a snapshot record; no device writes checkpoints of its own. */
async function writer(relay: SimRelay): Promise<Writer> {
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a-0123456789abcdef", tuning: TUNING });
	const docs: string[] = [];
	for (let i = 0; i < 6; i++) {
		const path = `Notes/n${i}.md` as VaultPath;
		await createDoc(a, path, `body ${i}`);
		docs.push(path);
	}
	for (let i = 0; i < 4; i++) await a.submitCfg([{ t: "jsonSet", file: APP, key: `k${i}`, valueJson: String(i) }]);
	await a.submitSnap([{ t: "put", record: snapRec(T0) }]);
	await until(() => a.isIdle() && a.c.ns.coversSeq > 0 && a.c.cfg.coversSeq > 0 && a.c.snap.coversSeq > 0, 5_000, "writer idle");
	return { a, docs, covers: { [NS_STREAM]: a.c.ns.coversSeq, [CFG_STREAM]: a.c.cfg.coversSeq, [SNAP_STREAM]: a.c.snap.coversSeq } };
}

/** Put a checkpoint straight into the relay store (the CAS a newer client's putCheckpoint would win). */
async function putCheckpoint(relay: SimRelay, stream: StreamName, coversSeq: Seq, encoding: CheckpointEncoding, foldRulesVersion: number, state: Uint8Array, payload?: Uint8Array): Promise<void> {
	const bytes = payload ?? await sealCheckpoint(noop, VAULT, stream, coversSeq, encodeCheckpointContent({ encoding, coversSeq, foldRulesVersion, state }), 0 as Seq);
	const r = relay.store.putCheckpoint(stream, coversSeq, relay.checkpoint(stream)?.coversSeq ?? 0, bytes);
	assert.ok(r.ok, `putCheckpoint ${stream}`);
}

/** What a client with fold rules one above this build's writes: the writer's own folds, at rules + 1. */
async function newerCheckpoints(relay: SimRelay, w: Writer): Promise<void> {
	const ns = decodeNsFoldV1(w.a.c.ns.encodeState())!;
	ns.foldRulesVersion = FOLD_RULES_VERSION + 1;
	await putCheckpoint(relay, NS_STREAM, w.covers[NS_STREAM]!, CheckpointEncoding.nsFoldV1, FOLD_RULES_VERSION + 1, encodeNsFoldV1(ns));
	await putCheckpoint(relay, CFG_STREAM, w.covers[CFG_STREAM]!, CheckpointEncoding.cfgFoldV1, CFG_FOLD_RULES_VERSION + 1, w.a.c.cfg.encodeState());
	await putCheckpoint(relay, SNAP_STREAM, w.covers[SNAP_STREAM]!, CheckpointEncoding.snapFoldV1, SNAP_FOLD_RULES_VERSION + 1, w.a.c.snap.encodeState());
}

interface Reader {
	readonly engine: LogEngine;
	readonly storage: StoragePort;
	readonly popups: { level: string; code: string; message: string }[];
	readonly diags: string[];
}

async function reader(relay: SimRelay, o: { storage?: StoragePort; tuning?: Partial<EngineTuning>; extra?: Partial<EngineOptions>; crypto?: ReturnType<typeof faultyCrypto> } = {}): Promise<Reader> {
	const popups: Reader["popups"] = [];
	const diags: string[] = [];
	const { engine, storage } = await startTestEngine({
		relay, deviceId: "dev-b-0123456789abcdef", tuning: o.tuning ?? TUNING, ...(o.storage ? { storage: o.storage } : {}), ...(o.crypto ? { crypto: o.crypto } : {}),
		extra: { onHostNotice: (level, code, message) => popups.push({ level, code, message }), onDiag: (e) => diags.push(e.code), ...(o.extra ?? {}) },
	});
	return { engine, storage, popups, diags };
}

const upgradeNotices = (s: StatusSnapshot) => s.notices.filter((n) => n.code.startsWith(VAULT_UPGRADE_NOTICE)).map((n) => `${n.code}/${n.level}`).sort();

/** (a) / (b): every fold halted at its checkpoint, nothing stored or marked, the user told; bodies synced. */
async function assertHalted(relay: SimRelay, w: Writer, r: Reader): Promise<void> {
	const b = r.engine;
	const c = b.c;
	// The session start settles (every read done or held) before anything is judged.
	await until(() => b.isIdle() && (b.status().phase === "live" || b.status().phase === "upgrade-required"), 5_000, "session settled");
	for (const [rt, s] of [[c.ns, NS_STREAM], [c.cfg, CFG_STREAM], [c.snap, SNAP_STREAM]] as const) {
		const rec = c.repo.stream(s)!;
		assert.equal(rec.frozenReason, null, `${s}: not frozen`);
		assert.equal(rec.frozen, 0);
		assert.equal(rec.disputedCheckpointCoversSeq, 0, `${s}: no disputed marker`);
		assert.deepEqual(rt.halted, { seq: w.covers[s], reason: "newer-checkpoint", upgrade: true }, `${s}: halted at the checkpoint`);
		assert.equal(rec.stale, 1, `${s}: stays stale`);
		assert.equal(rec.appliedSeq, 0, `${s}: the cursor did not move past the checkpoint`);
		assert.equal(rec.snapshotCoversSeq, 0, `${s}: not adopted`);
		assert.equal(rec.quarantinedRows, 0);
		assert.equal((await c.repo.getTail(s, 0)).length, 0, `${s}: no row read past the checkpoint on old rules`);
		assert.equal(await c.repo.getSnapshot(s), undefined);
	}
	assert.equal(b.listDocs().length, 0, "no ns row folded on the old rules");
	assert.equal(b.nsView().caughtUp, false);
	assert.equal(b.snapView().caughtUp, false, "the snapshot index is not ready");
	assert.equal(b.cfgView().json.size, 0);
	assert.ok(!r.diags.includes("checkpoint-disputed"), "never disputed");
	// The user is told, once per fold, what to do and what stopped.
	const st = b.status();
	assert.equal(st.phase, "upgrade-required");
	assert.deepEqual(upgradeNotices(st), ["upgrade-required:cfg/error", "upgrade-required:ns/error", "upgrade-required:snap/error"]);
	const shown = renderStatus(st, RUNNING);
	assert.equal(shown.text, "YAOS: update required");
	assert.equal(shown.level, "error");
	assert.ok(shown.tooltip.includes(VAULT_UPGRADE_TEXT), shown.tooltip);
	for (const f of ["ns", "cfg", "snap"] as const) assert.ok(shown.tooltip.includes(VAULT_UPGRADE_STOPPED[f]), `tooltip names ${f}`);
	assert.ok(!shown.tooltip.includes("server needs"), "not the server's message");
	assert.deepEqual(r.popups.map((p) => `${p.level}:${p.code}`).sort(), ["error:upgrade-required:cfg", "error:upgrade-required:ns", "error:upgrade-required:snap"]);
	for (const p of r.popups) assert.ok(p.message.includes(VAULT_UPGRADE_TEXT), p.message);
	// The session stays up and the body streams keep syncing (§c.10); the engine is idle, not stuck reading.
	const bodies = relay.streams().filter((s) => s.startsWith("b:"));
	assert.equal(bodies.length, w.docs.length);
	await until(() => b.isIdle() && bodies.every((s) => c.repo.stream(s)?.stale === 0), 5_000, "bodies read, engine idle");
	assert.equal(st.relay.connected, true);
	assert.equal(c.ns.candidate, null, "nothing to checkpoint from a halted fold");
}

void test("(a) newer ns / cfg / snap checkpoints halt their folds in upgrade-required, no dispute, the user told", async () => {
	const relay = new SimRelay({ sealBytes: 64, gcOnCheckpoint: false });
	const w = await writer(relay);
	let r: Reader | null = null;
	try {
		await newerCheckpoints(relay, w);
		r = await reader(relay);
		await assertHalted(relay, w, r);
		// A reconnect reads them again and halts again: still nothing stored, no second popup.
		r.engine.disconnect();
		await r.engine.reconnect();
		await until(() => r!.engine.status().phase === "upgrade-required" && r!.engine.isIdle(), 5_000, "halted again");
		assert.equal(r.popups.length, 3);
		for (const s of FOLDS) assert.equal(r.engine.c.repo.stream(s)!.frozen, 0);
	} finally {
		await r?.engine.stop();
		await w.a.stop();
	}
});

void test("(b) + (c) rows below the checkpoints GC'd: a halt, never a freeze; the upgraded client adopts them on its next start", async () => {
	const relay = new SimRelay({ sealBytes: 64 });
	const w = await writer(relay);
	let r: Reader | null = null;
	try {
		await newerCheckpoints(relay, w);
		for (const s of FOLDS) assert.ok(relay.gcSeq(s) > 0, `${s}: rows below the checkpoint are gone`);
		r = await reader(relay);
		await assertHalted(relay, w, r);
		const store = r.storage;
		await r.engine.stop();

		// (c) The plugin is upgraded: the same store, a client that implements the newer rules.
		r = await reader(relay, { storage: store, tuning: UPGRADED });
		const b = r.engine;
		await until(() => b.isIdle() && b.status().phase === "live" && FOLDS.every((s) => b.c.repo.stream(s)?.stale === 0), 5_000, "upgraded reader live");
		for (const [rt, s] of [[b.c.ns, NS_STREAM], [b.c.cfg, CFG_STREAM], [b.c.snap, SNAP_STREAM]] as const) {
			assert.equal(rt.halted, null, `${s}: no halt`);
			const rec = b.c.repo.stream(s)!;
			assert.equal(rec.snapshotCoversSeq, w.covers[s], `${s}: checkpoint adopted`);
			assert.equal(rec.frozen, 0);
			assert.equal(rec.disputedCheckpointCoversSeq, 0);
		}
		assert.equal(b.c.ns.state.foldRulesVersion, FOLD_RULES_VERSION + 1, "the newer rules govern the fold");
		assert.deepEqual(b.listDocs().filter((d) => d.state === "live").map((d) => d.path).sort(), [...w.docs].sort());
		assert.equal(b.cfgView().json.get(`${APP}\u0000k3`)?.value, "3");
		assert.deepEqual(snapLive(b.snapView().state).map((s) => s.record.snapshotId), [snapRec(T0).snapshotId]);
		assert.equal(b.snapView().caughtUp, true);
		assert.deepEqual(upgradeNotices(b.status()), [], "nothing left of the halt");
		assert.equal(r.popups.length, 0);
		// Rows past the checkpoint fold on the upgraded client.
		const id = await createDoc(w.a, "Notes/after.md" as VaultPath, "after");
		await until(async () => b.listDocs().some((d) => d.docId === id) && (await docText(b, id)) === "after", 5_000, "a row past the checkpoint folds");
	} finally {
		await r?.engine.stop();
		await w.a.stop();
	}
});

void test("(d) a corrupt checkpoint of this rules version is still disputed: rows re-read, or frozen when GC'd", async () => {
	for (const gc of [false, true]) {
		const relay = new SimRelay({ sealBytes: 64, gcOnCheckpoint: gc });
		const w = await writer(relay);
		let r: Reader | null = null;
		try {
			// V2: a seq past coversSeq. Same rules version as this reader: the writer's fault, not a newer client.
			const ns = decodeNsFoldV1(w.a.c.ns.encodeState())!;
			const [docId, e] = [...ns.entries][0]!;
			ns.entries.set(docId, { ...e, lastTouchSeq: ns.coversSeq + 5 });
			await putCheckpoint(relay, NS_STREAM, w.covers[NS_STREAM]!, CheckpointEncoding.nsFoldV1, FOLD_RULES_VERSION, encodeNsFoldV1(ns));
			r = await reader(relay);
			const b = r.engine;
			const rec = () => b.c.repo.stream(NS_STREAM)!;
			if (gc) {
				await until(() => rec()?.frozen === 1, 5_000, "frozen");
				assert.equal(rec().frozenReason, "checkpoint-disputed");
				assert.equal(b.c.ns.halted, null, "not an upgrade halt");
			} else {
				await until(() => b.isIdle() && b.listDocs().length === w.docs.length, 5_000, "rows re-read");
				assert.equal(rec().frozen, 0);
			}
			assert.equal(rec().disputedCheckpointCoversSeq, w.covers[NS_STREAM]);
			assert.ok(r.diags.includes("checkpoint-disputed"));
			await until(() => b.isIdle(), 5_000, "idle");
			assert.notEqual(b.status().phase, "upgrade-required");
			assert.deepEqual(upgradeNotices(b.status()), []);
			assert.equal(r.popups.length, 0);
		} finally {
			await r?.engine.stop();
			await w.a.stop();
		}
	}
});

void test("(e) a checkpoint that does not open for want of a key waits, is never disputed or frozen, and is adopted once keys change", async () => {
	const relay = new SimRelay({ sealBytes: 64 });
	const w = await writer(relay);
	let r: Reader | null = null;
	try {
		// A genuine checkpoint of this rules version; the rows below it are gone.
		await putCheckpoint(relay, NS_STREAM, w.covers[NS_STREAM]!, CheckpointEncoding.nsFoldV1, FOLD_RULES_VERSION, w.a.c.ns.encodeState());
		assert.ok(relay.gcSeq(NS_STREAM) > 0);
		const crypto = faultyCrypto();
		crypto.failOpen = true; // unknown-key: reader-dependent, not a newer writer
		r = await reader(relay, { crypto });
		const b = r.engine;
		await until(() => r!.diags.includes("checkpoint-held") && b.isIdle(), 5_000, "held, idle");
		const rec = b.c.repo.stream(NS_STREAM)!;
		assert.equal(rec.frozen, 0, "not frozen");
		assert.equal(rec.disputedCheckpointCoversSeq, 0, "not disputed");
		assert.equal(rec.stale, 1);
		assert.ok(!r.diags.includes("checkpoint-disputed"));
		assert.notEqual(b.c.ns.halted?.reason, "newer-checkpoint");
		assert.notEqual(b.status().phase, "upgrade-required", "a missing key is not an upgrade");
		assert.deepEqual(upgradeNotices(b.status()), []);

		// The keys arrive (the keyring's re-gate): the held read runs again and adopts the checkpoint.
		crypto.failOpen = false;
		await regateUnopened(b.c);
		await until(() => b.c.repo.stream(NS_STREAM)?.snapshotCoversSeq === w.covers[NS_STREAM] && b.c.repo.stream(NS_STREAM)?.stale === 0, 5_000, "adopted");
		assert.deepEqual(b.listDocs().filter((d) => d.state === "live").map((d) => d.path).sort(), [...w.docs].sort());
	} finally {
		await r?.engine.stop();
		await w.a.stop();
	}
});

void test("(f) an upgradeRules row halts in upgrade-required; unopened rows are re-gated on the next session start", async () => {
	const relay = new SimRelay();
	const w = await writer(relay);
	let r: Reader | null = null;
	try {
		// An unopened ns row (no key for it): halted reader-dependent, not an upgrade.
		const crypto = faultyCrypto();
		crypto.failOpen = true;
		r = await reader(relay, { crypto });
		await until(() => r!.engine.c.ns.halted?.reason === "reader-dependent" && r!.engine.isIdle(), 5_000, "unopened halt");
		assert.equal(r.engine.c.ns.halted?.upgrade, false);
		assert.notEqual(r.engine.status().phase, "upgrade-required");
		assert.ok((await r.engine.c.repo.getTail(NS_STREAM, 0)).some((t) => t.flags & LOCAL_FLAG_UNOPENED));
		const store = r.storage;
		await r.engine.stop();
		// Restarted with a port that opens it (suite 0: no keyring change re-gates): the session start does.
		r = await reader(relay, { storage: store });
		await until(() => r!.engine.c.ns.halted === null && r!.engine.listDocs().length === w.docs.length, 5_000, "re-gated on session start");

		// upgradeRules{known + 1}: the ns fold halts, and now the phase and the notice say so.
		await w.a.submitNs([{ t: "upgradeRules", version: FOLD_RULES_VERSION + 1 }]);
		await until(() => r!.engine.c.ns.halted?.reason === "rules-version" && r!.engine.status().phase === "upgrade-required", 5_000, "rules halt");
		assert.deepEqual(upgradeNotices(r.engine.status()), ["upgrade-required:ns/error"]);
		assert.equal(r.popups.filter((p) => p.code === "upgrade-required:ns").length, 1);
		const tooltip = renderStatus(r.engine.status(), RUNNING).tooltip;
		assert.ok(tooltip.includes(VAULT_UPGRADE_TEXT) && tooltip.includes(VAULT_UPGRADE_STOPPED.ns), tooltip);
		const store2 = r.storage;
		await r.engine.stop();
		// Upgraded: the same stored row folds.
		r = await reader(relay, { storage: store2, tuning: UPGRADED });
		await until(() => r!.engine.isIdle() && r!.engine.status().phase === "live", 5_000, "upgraded live");
		assert.equal(r.engine.c.ns.halted, null);
		assert.equal(r.engine.c.ns.state.foldRulesVersion, FOLD_RULES_VERSION + 1);
		assert.equal(r.engine.c.ns.rulesVersion, FOLD_RULES_VERSION + 1, "its checkpoints carry the state's rules, as V2 wants");
	} finally {
		await r?.engine.stop();
		await w.a.stop();
	}
});
