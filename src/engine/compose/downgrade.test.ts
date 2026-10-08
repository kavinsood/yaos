/**
 * e2ee-design.md §20.2 "Downgrade", measured: every test tallies each outcome over all its cases and
 * asserts the whole tally (rules: §12.4, §15.1). Every bullet maps to one test; where a single-case test
 * already covers it, that test is cited and the counting form is added here.
 *
 * (a) Suite-0 rows injected into a suite-1 vault -> "a. ...". 25 forged rows (ns, cfg, snap, body, canvas;
 *     hostile and genuine deviceIds) plus checkpoints: the gate's stage 1 says crypto-downgrade for every
 *     subject; each of two devices opens all 25 as suite-downgrade; folds, docs, disk, ns/cfg/snap state and a
 *     replay are unchanged. Existing: webCryptoSuite1.test.ts:61, suite1Envelope.test.ts:146,
 *     suite1Tamper.test.ts:423.
 * (b) Hidden k, key-less join -> "b. ...". 6 join forms (typed code, console link, the same with the protocol
 *     action, plugin link, /mobile-setup QR, resumePendingEnrollment) x 4 vault states (head = 0; head > 0 with
 *     k empty, hidden, hidden under suite-0 data) x 3 seeds, against a hostile server. Every case ends
 *     key-missing/"no-pin"/suite=null with 0 frames, rows, checkpoints, blob calls, IndexedDB stores, side files,
 *     secrets and disk changes; every UI command and key probe is tallied. Only installKey (QR, RK) reaches the
 *     engine. Existing: pluginController.test.ts:165, pinGate.test.ts:191, pinGate.test.ts:267.
 *     - The sim relay reports the true head, so a hidden genesis means head > 0. A server that also reports head 0
 *       gives the device exactly the "empty" state's view.
 *     - The UI layer (src/host/ui/**) over the same controller: the palette is exact, and its only key command is
 *       "yaos-unlock", the two-button blocked screen (keyModals.ts:51-94: [Scan QR from one of your devices]
 *       [Enter recovery key]). "Create a new vault" is not offered (canCreateVault, commands.ts:18-22) and
 *       createAndEnroll refuses "blocked" before any request, against a server that would create;
 *       enableEncryption / optOutOfEncryption stop with no command (no marker); revokeRekey rejects before one;
 *       nothing is saved. The status tooltip (statusBar.ts) names the RK and the QR and offers nothing else.
 * (c) The pin never comes from the server -> "c. ...". Over b's 72 joins: 0 saved e2ee/creating fields, 0
 *     creatable, keyringSeen or suite statuses, 0 pinSuite0 at an engine, 0 commands from the UI flows.
 *     pinCensus() counts every pin setter, pin-shaped write, saveData, markCreating and key-command construction
 *     in the shipped sources. The pin setters are main's (pluginController.ts, keys/pin.ts, ui/api.ts's
 *     sanitizing loader). The key commands are E5's sanctioned sites only, each behind its guard: createVault.ts
 *     enableE2ee and pinSuite0 {create} behind creationCheck (§15.1) and main's marker check; keyActions.ts
 *     pinSuite0 {link}, installKey and revokeRekey behind main's refusals. They are reached only from the
 *     user-initiated modals and the protocol handler (import graph). Behaviourally: createVault's two choices
 *     send nothing short of "creatable", and a suite=0 link routed through routeSetupLink and applyLinkE2ee into
 *     a suite-1, suite-0 or keyringSeen device is refused on main, with 0 engine pins and 0 writes.
 *     Existing: pin.test.ts:17, pin.test.ts:111, pluginController.test.ts:182.
 * (d) Suite-0 link after a genesis -> "d. ...". Live and history genesis x 3 seeds; the server then hides k and
 *     drops the session. parseSetupLink accepts the 4 `suite=0` shapes (§12.4 source (ii)) and rejects the 2
 *     with unknown keys. Every accepted one routes "apply" (routeSetupLink) and applyLinkE2ee's pinSuite0 {link}
 *     is refused (keyring-seen) by main, also after UI writes, a re-pair and a restart. keyringSeen stays saved;
 *     there are 0 writes. Existing: pluginController.test.ts:200, keyReader.test.ts:91, pinGate.test.ts:227,
 *     pin.test.ts:89.
 *     - A restarted engine is not told keyringSeen (e2ee-design.md §18.4 "keyringSeen is not in init.crypto", hostKeys.ts:48), so its own answer
 *       is "ok". The engine never pins: only main does (pluginController.ts:269, :296-301), and main refuses.
 * (e) Creation path -> "e. ...". 5 non-empty vaults (head > 0, or k non-empty) x 3 seeds: never creatable;
 *     enableE2ee and pinSuite0 {create} are refused; no pin, 0 writes. A marker for another vaultId, set before
 *     pairing, while paired, or via a UI write, is ignored. No link reaches the flow: every link class (13
 *     hostile shapes, key-less, suite=0, key, re-key) x 9 device states goes through the protocol handler's
 *     routeSetupLink(parseSetupLink(params)) (registerUi.ts:220-225) to ignore, apply or pair, as §12.4 says;
 *     a pair route enrolls with a key-free /enroll body and attempt, and an apply route sends only pinSuite0
 *     {link} or installKey {qr}, never markCreating. Existing: pinGate.test.ts:243, pin.test.ts:64,
 *     pin.test.ts:30, pluginController.test.ts:295.
 * (f) Unverified key -> "f. ...". 9 QR/RK keys without a matching k record x 3 seeds x {same engine, restart}:
 *     unpinned, 0 SecretStorage writes, 0 writes, no key bytes left on main. Existing: keyReader.test.ts:114,
 *     pluginController.test.ts:216.
 * (g) A suite-0 device sees a k genesis -> "g. ...". 6 timings (live typing, offline with or without edits,
 *     restart, wipe, fresh device) x 3 seeds: encrypted-vault every time. The raw crypto port, tapped behind the
 *     write gate, counts 0 seals after encrypted-vault and 0 through a shut gate. 0 rows and 0 k rows by the
 *     device after it saw the genesis. Existing: keyring.ops.test.ts:81.
 *
 * Residual risk (§12.4): a suite=0 link, or a key with a forged genesis, taken from a hostile source and opened
 * by an unpinned device that has never read a genesis. parseSetupLink accepts `suite=0` by design (source (ii));
 * c and d show it is refused once keyringSeen or any pin is set.
 * Output: counts only, never key bytes, recovery keys, codes or links.
 */
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as Yjs from "yjs";
import { CryptoSuite } from "../../core/envelope";
import { decodeOuter } from "../../core/codec/envelope";
import { bytesToHex } from "../../core/codec/lib0";
import { bytesToHash, newClientFrameId, newDocId } from "../../core/codec/ids";
import { encodeNsOps } from "../../core/codec/nsOps";
import { encodeCfgOps } from "../../core/codec/cfgOps";
import { encodeSnapOps } from "../../core/snap/record";
import {
	CFG_STREAM, KEYRING_STREAM, NS_STREAM, SNAP_STREAM, bodyStream, canvasStream,
	type ClientFrameId, type DeviceId, type Seq, type StreamName, type VaultPath,
} from "../../core/types";
import type { CryptoPort } from "../../ports/crypto";
import type { EnvelopeKind } from "../../core/envelope";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { gate, type GateSubject } from "../ingest/gate";
import { sealCheckpoint, sealFrame } from "../ingest/envelope";
import { simHashPort } from "../../sim/hash";
import { SeededRandom } from "../../sim/random";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SIM_VAULT_ID, SimNet } from "../../sim/net";
import { e2eeOf, isLive, keyMissing, lastStatus, onboardSuite1, oracleKeys, rowsBy, seededRk, settleOn, storedKeys } from "../../sim/e2ee";
import { connectPeer, frame } from "../../sim/a-relay-testkit";
import { FORGED, K, RK_A, RK_B, genesisFor } from "../keyring/testkit/world";
import type { BlobPort } from "../../ports/blob";
import type { UserCommand } from "../../protocol/messages";
import type { StatusSnapshot } from "../../protocol/status";
import type { HostUiSink } from "../../host/hostRuntime";
import { PinRefusedError, YaosController } from "../../host/pluginController";
import { defaultPluginData, type YaosPluginData, type YaosUiHost } from "../../host/ui/api";
import {
	base64Url, buildRekeyLink, buildSetupLink, encodeKeyParam, parseSetupLink, prepareEnrollment,
	type EnrollInput, type EnrollmentAttempt, type HttpRequest, type RequestFn,
} from "../../host/ui/pairing";
import { applyPairedIdentity, PairingSession, resumePendingEnrollment, setPendingEnrollment, withoutPendingEnrollment } from "../../host/ui/pairFlow";
import { renderStatus } from "../../host/ui/statusBar";
import { canCreateVault, UI_COMMANDS } from "../../host/ui/commands";
import { createAndEnroll, CreateVaultError, enableEncryption, optOutOfEncryption } from "../../host/ui/createVault";
import { applyLinkE2ee, revokeRekey, routeSetupLink } from "../../host/ui/keyActions";
import { FakeUiHost, snapshot } from "../../host/ui/testkit/fakeUiHost";

// --- shared helpers ------------------------------------------------------------------------------------------

const MARK = "FORGED-S0-MARK";
const enc = new TextEncoder();

/** Stable JSON of fold state: Maps as sorted entry lists, bytes as hex. */
function fp(v: unknown): string {
	return JSON.stringify(v, (_k, x: unknown) => {
		if (x instanceof Map) return [...x.entries()].map(([k, y]) => [String(k), y]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		if (x instanceof Set) return [...x].map(String).sort();
		if (x instanceof Uint8Array) return `hex:${bytesToHex(x)}`;
		if (typeof x === "bigint") return x.toString();
		return x;
	});
}

function count<K extends string>(tally: Map<K, number>, k: K): void {
	tally.set(k, (tally.get(k) ?? 0) + 1);
}

function tallyObj(tally: ReadonlyMap<string, number>): Record<string, number> {
	return Object.fromEntries([...tally].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function newClock(): VirtualClock {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	return clock;
}

// --- a. suite-0 rows forged into a suite-1 vault ----------------------------------------------------------------

interface Forged {
	readonly what: string;
	readonly stream: StreamName;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly payload: Uint8Array;
	/** Every live device reads this stream (ns, cfg, snap, a body it holds): it must open the row. */
	readonly mustOpen: boolean;
}

/** The fold and disk view of a device that the forged rows must not change. */
async function foldView(clock: VirtualClock, d: SimDevice): Promise<{ disk: string; docs: string; texts: string; ns: string; cfg: string; snap: string; replay: string; rings: number }> {
	const log = d.vrt!.log;
	const docs = log.listDocs().map((x) => ({ docId: x.docId, path: x.path, kind: x.kind, state: x.state, aliasOf: x.aliasOf })).sort((a, b) => (a.docId < b.docId ? -1 : 1));
	const texts: Record<string, string | null> = {};
	for (const x of docs) if (x.state === "live" && x.kind === "markdown") texts[x.path] = d.engineText(x.path);
	const ns = log.nsView().state;
	const cfg = log.cfgView();
	const snap = log.snapView().state;
	let rings = 0;
	for (const r of ns.recentFrames.values()) rings += r.length;
	for (const r of cfg.recentFrames.values()) rings += r.length;
	void clock;
	return {
		disk: fp([...d.vault.snapshot()]),
		docs: fp(docs),
		texts: fp(texts),
		ns: fp(ns.entries),
		cfg: fp({ json: cfg.json, files: cfg.files, plugins: cfg.plugins }),
		snap: fp({ floors: snap.floors, dels: snap.dels, records: snap.records }),
		replay: fp({ ns: ns.replay, cfg: cfg.replay }),
		rings,
	};
}

/** Wraps the device's crypto port open (the ingest gate's, context.ts gateCtx) and tallies suite-0 opens by payload. */
function tapOpens(d: SimDevice): Map<string, Map<string, number>> {
	const byPayload = new Map<string, Map<string, number>>();
	const port = d.vrt!.log.c.gateCtx.crypto as CryptoPort;
	const inner = port.open.bind(port);
	(port as { open: CryptoPort["open"] }).open = async (input) => {
		const r = await inner(input);
		if (input.suite === CryptoSuite.none) {
			const key = bytesToHex(input.sealed);
			let t = byPayload.get(key);
			if (!t) byPayload.set(key, (t = new Map()));
			count(t, r.ok ? "opened" : r.reason);
		}
		return r;
	};
	return byPayload;
}

async function converged(clock: VirtualClock, devs: readonly SimDevice[], paths: readonly string[], horizonMs = 120_000): Promise<boolean> {
	return clock.runUntil(() => devs.every((d) => d.vrt?.log.isIdle() === true && d.vault.pendingEvents() === 0 && paths.every((p) => d.vault.snapshot().get(p) !== undefined && devs.every((o) => o.vault.snapshot().get(p) === d.vault.snapshot().get(p)))), horizonMs);
}

test("a. suite-0 rows forged into a suite-1 vault: every open is suite-downgrade, folds/docs/disk unchanged", async () => {
	const clock = newClock();
	const net = new SimNet(clock, { seed: 11 });
	const X = new SimDevice({ name: "X", clock, net, pin: null });
	const Y = new SimDevice({ name: "Y", clock, net, pin: null });
	const ob = await onboardSuite1(clock, [X, Y], new SeededRandom(101));
	assert.ok(ob.ok, ob.lines.at(-1));
	X.vault.userWrite("notes/a.md", "alpha\n");
	X.vault.userWrite("notes/b.md", "beta\n");
	Y.vault.userWrite("notes/c.md", "gamma\n");
	assert.ok(await converged(clock, [X, Y], ["notes/a.md", "notes/b.md", "notes/c.md"]), "X and Y converge");
	await clock.advance(5_000);
	const devs = [X, Y];
	const keys = oracleKeys(devs);
	assert.ok(keys);
	const before = await Promise.all(devs.map((d) => foldView(clock, d)));
	const oracleBefore = await net.oracle(120_000, keys);
	assert.equal(oracleBefore.error, null);
	const headBefore = net.relay.head();

	// The forged rows: every stream class, under hostile ids and the genuine devices' own ids (a relay can claim any).
	const docOf = (p: string) => X.vrt!.log.listDocs().find((x) => x.path === p && x.state === "live")!.docId;
	const live = [docOf("notes/a.md"), docOf("notes/b.md"), docOf("notes/c.md")];
	const rnd = new SeededRandom(202);
	const noop = createNoopCrypto(simHashPort());
	const authors = ["hostile-1" as DeviceId, "hostile-2" as DeviceId, X.deviceId, Y.deviceId];
	const forged: Forged[] = [];
	let frameNo = 1;
	const add = async (what: string, stream: StreamName, kind: EnvelopeKind, content: Uint8Array, deviceId: DeviceId, mustOpen: boolean, fno = 0) => {
		const clientFrameId = newClientFrameId(rnd);
		const s = await sealFrame(noop, SIM_VAULT_ID, { stream, deviceId, clientFrameId, kind, authorNsSeq: 0 as Seq, flags: 0, frameNo: fno, content });
		forged.push({ what, stream, deviceId, clientFrameId, payload: s.sealed, mustOpen });
	};
	const hash = bytesToHash(new Uint8Array(32).fill(7));
	for (const a of authors) {
		const fresh = newDocId(rnd);
		await add("ns-create", NS_STREAM, "nsOps", encodeNsOps([{ t: "create", docId: fresh, kind: "markdown", path: `notes/${MARK}-${a}.md` as VaultPath, contentHash: hash, size: 3 }]), a, true, frameNo++);
		await add("ns-rename", NS_STREAM, "nsOps", encodeNsOps([{ t: "rename", docId: live[0]!, path: `notes/${MARK}-ren-${a}.md` as VaultPath }]), a, true, frameNo++);
		await add("ns-delete", NS_STREAM, "nsOps", encodeNsOps([{ t: "delete", docId: live[1]!, baseBodySeq: 1_000_000 as Seq }]), a, true, frameNo++);
		await add("cfg-plugin", CFG_STREAM, "cfgOps", encodeCfgOps([{ t: "pluginSet", pluginId: `forged-${MARK}`, enabled: true }]), a, true, frameNo++);
		await add("snap-floor", SNAP_STREAM, "snapOps", encodeSnapOps([{ t: "floor", createdAtMs: 9_000_000_000_000 }]), a, true);
	}
	const yUpdate = (text: string) => {
		const doc = new Yjs.Doc();
		doc.getText("text").insert(0, text);
		return Yjs.encodeStateAsUpdate(doc);
	};
	for (let i = 0; i < live.length; i++) await add("body-live", bodyStream(live[i]!), "bodyUpdate", yUpdate(`${MARK} body ${i}\n`), authors[i % authors.length]!, true);
	const ghost = newDocId(rnd);
	await add("body-unknown", bodyStream(ghost), "bodyUpdate", yUpdate(`${MARK} ghost\n`), authors[0]!, false);
	await add("canvas-unknown", canvasStream(newDocId(rnd)), "bodyUpdate", yUpdate(`${MARK} canvas\n`), authors[1]!, false);

	// Stage 1 directly, for every forged row and the same bytes as a provisional, plus forged checkpoints.
	const port = await createWebCryptoSuite1({ vaultId: SIM_VAULT_ID, random: new SeededRandom(5), keys: storedKeys(X)!.keys });
	const ctx = { crypto: port, vaultId: SIM_VAULT_ID, maxCheckpointStateBytes: 1 << 20, staleCheck: () => null };
	const direct = new Map<string, number>();
	const subjects: GateSubject[] = [];
	for (const f of forged) {
		subjects.push({ t: "row", stream: f.stream, seq: 1 as Seq, deviceId: f.deviceId, clientFrameId: f.clientFrameId, payload: f.payload });
		subjects.push({ t: "provisional", stream: f.stream, deviceId: f.deviceId, clientFrameId: f.clientFrameId, payload: f.payload });
	}
	for (const s of [NS_STREAM, CFG_STREAM, SNAP_STREAM, bodyStream(live[0]!), canvasStream(ghost)]) {
		subjects.push({ t: "checkpoint", stream: s, coversSeq: 7 as Seq, payload: await sealCheckpoint(noop, SIM_VAULT_ID, s, 7 as Seq, enc.encode(`${MARK} checkpoint`), 0 as Seq) });
	}
	for (const s of subjects) {
		const r = await gate(ctx, s);
		count(direct, r.ok ? `pass:${r.t}` : `${r.reason}/${r.readerDependent ? "dep" : "det"}`);
	}
	assert.deepEqual(tallyObj(direct), { "crypto-downgrade/det": subjects.length }, "stage 1: every forged row, provisional and checkpoint is crypto-downgrade, deterministic");

	// Live: the relay commits them and pushes them to every open socket.
	const taps = devs.map(tapOpens);
	const rows = net.relay.forge(forged.map((f) => ({ stream: f.stream, deviceId: f.deviceId, clientFrameId: f.clientFrameId, payload: f.payload })));
	assert.equal(rows.length, forged.length);
	const keyOf = (f: Forged) => bytesToHex(decodeOuter(f.payload).ok ? (decodeOuter(f.payload) as { sealed: Uint8Array }).sealed : new Uint8Array());
	const opened = (d: number) => forged.filter((f) => taps[d]!.has(keyOf(f)));
	const mustOpen = forged.filter((f) => f.mustOpen);
	assert.ok(await clock.runUntil(() => devs.every((d, i) => d.vrt?.log.isIdle() === true && mustOpen.every((f) => taps[i]!.has(keyOf(f)))), 120_000), "both devices read every forged row of a stream they hold");
	await clock.advance(10_000);

	// Every open of a forged row on either device failed, and only as suite-downgrade (open failures by reason).
	const reasons = new Map<string, number>();
	for (const t of taps) for (const per of t.values()) for (const [r, n] of per) reasons.set(r, (reasons.get(r) ?? 0) + n);
	const openedBy = taps.map((t) => forged.filter((f) => t.has(keyOf(f))).length);
	assert.deepEqual(openedBy, [forged.length, forged.length], "each device opened every forged row (all classes are pushed live)");
	assert.deepEqual(tallyObj(reasons), { "suite-downgrade": openedBy[0]! + openedBy[1]! }, "open failures by reason: suite-downgrade only, once per row per device");
	const after = await Promise.all(devs.map((d) => foldView(clock, d)));
	const sideStreams = new Set(forged.filter((f) => !["ns", "cfg", "snap"].includes(f.stream)).map((f) => f.stream));
	for (let i = 0; i < devs.length; i++) {
		const b = before[i]!;
		const a = after[i]!;
		const same = { disk: a.disk === b.disk, docs: a.docs === b.docs, texts: a.texts === b.texts, ns: a.ns === b.ns, cfg: a.cfg === b.cfg, snap: a.snap === b.snap, replay: a.replay === b.replay };
		assert.deepEqual(same, { disk: true, docs: true, texts: true, ns: true, cfg: true, snap: true, replay: true }, `${devs[i]!.name}: folded vault and docs unchanged`);
		// ns/cfg rows fold as empty frames (frameNo 0: no replay window touched, §8.2); their cfid enters the dedupe ring.
		assert.equal(a.rings - b.rings, forged.filter((f) => f.stream === NS_STREAM || f.stream === CFG_STREAM).length, "one ring entry per forged ns/cfg row, nothing else");
		const q = new Map<string, number>();
		const frozen = new Map<string, number>();
		for (const r of devs[i]!.vrt!.log.c.repo.streams()) {
			if (r.frozen === 1) count(frozen, `${sideStreams.has(r.stream) ? "forged" : "other"}:${r.frozenReason}`);
			for (const x of await devs[i]!.vrt!.log.c.repo.quarantineOf(r.stream)) count(q, `${r.stream.slice(0, 2)}${x.reason}`);
		}
		// §9.3: a body/canvas row that fails is quarantined and its doc frozen (DoS only, nothing applied).
		assert.deepEqual(tallyObj(q), { "b:crypto-downgrade": 4, "c:crypto-downgrade": 1 }, "one quarantine record per forged side-stream row, none for ns/cfg/snap");
		assert.deepEqual(tallyObj(frozen), { "forged:crypto-downgrade": sideStreams.size }, "only the forged-into streams are frozen, for that reason");
	}
	const oracleAfter = await net.oracle(120_000, keys);
	assert.equal(oracleAfter.error, null);
	assert.equal(fp(oracleAfter.docs), fp(oracleBefore.docs), "a fresh suite-1 reader folds the same vault");
	assert.equal(net.relay.head(), headBefore + forged.length);
	// The ns fold is not halted (no reader-dependent failure): a genuine write still reaches the other device.
	Y.vault.userWrite("notes/after.md", "after\n");
	assert.ok(await converged(clock, devs, ["notes/after.md"]), "ns fold still live after the forged rows");
	let marks = 0;
	for (const d of devs) {
		for (const [p, t] of d.vault.snapshot()) if (p.includes(MARK) || t.includes(MARK)) marks++;
		const v = await foldView(clock, d);
		for (const s of [v.docs, v.texts, v.ns, v.cfg, v.snap]) if (s.includes(MARK)) marks++;
	}
	for (const doc of oracleAfter.docs) if (doc.path.includes(MARK) || (doc.text ?? "").includes(MARK)) marks++;
	assert.equal(marks, 0, "no forged path, text or plugin id anywhere");
	console.log(`[a] forged rows=${forged.length} (+${subjects.length - 2 * forged.length} checkpoints, ${forged.length} provisionals) stage-1=crypto-downgrade x${subjects.length}; per device opened=${openedBy.join(",")} suite-downgrade=${reasons.get("suite-downgrade")}; quarantined=5 frozen=${sideStreams.size}; folds unchanged; marks=0`);
});

// --- b, c. key-less joins through the plugin controller ----------------------------------------------------------

const HOST = "https://relay.example";
const JOIN_FORMS = ["typed", "console-link", "console-link-protocol-action", "plugin-link", "mobile-setup-qr", "resume"] as const;
type JoinForm = (typeof JOIN_FORMS)[number];
/** head = 0 (empty), and head > 0 with `k` empty, hidden, or hidden under suite-0 data. */
const VAULT_STATES = ["empty", "suite0-data", "hidden-genesis", "hidden-genesis+suite0-data"] as const;
type VaultState = (typeof VAULT_STATES)[number];
const JOIN_SEEDS = [1, 2, 3] as const;

/** Fields a hostile server adds to its capabilities and /enroll answers: none may reach the pin (readEnrollment). */
const HOSTILE_FIELDS = { suite: 0, e2ee: { suite: 0 }, pin: { suite: 0 }, creating: { vaultId: SIM_VAULT_ID }, creatable: true, keyringSeen: false, encryption: "off" };
const IDENTITY_KEYS = ["deviceId", "deviceName", "deviceToken", "host", "vaultGeneration", "vaultId"];

/** A BlobPort that counts every call (pinGate.test.ts countingBlob). */
function countingBlob(): { port: BlobPort; calls: Map<string, number> } {
	const calls = new Map<string, number>();
	const port: BlobPort = {
		maxBlobBytes: 1 << 20,
		has: async () => (count(calls, "has"), new Set()),
		put: async () => void count(calls, "put"),
		get: async () => (count(calls, "get"), null),
		list: async () => (count(calls, "list"), { items: [], next: null }),
		deleteIfUploadedBefore: async () => (count(calls, "delete"), []),
	};
	return { port, calls };
}

function relayState(net: SimNet): { head: number; checkpoints: string } {
	return { head: net.relay.head(), checkpoints: net.relay.streams().map((s) => `${s}:${net.relay.checkpoint(s)?.coversSeq ?? "-"}`).join(",") };
}

/** The relay as a hostile server: claimed streams relay, /enroll accepted, every answer padded with HOSTILE_FIELDS. */
function hostileServer(requests: Map<string, number>): RequestFn {
	return async (req) => {
		const path = req.url.startsWith(HOST) ? req.url.slice(HOST.length) : "other-host";
		count(requests, `${req.method} ${path}`);
		if (req.method === "GET" && path === "/api/capabilities") return { status: 200, json: { claimed: true, streams: 1, attachments: true, serverVersion: "sim", ...HOSTILE_FIELDS } };
		if (req.method === "POST" && path === "/enroll") {
			const b = JSON.parse(req.body ?? "{}") as { deviceId?: string; deviceToken?: string };
			return { status: 200, json: { vaultId: SIM_VAULT_ID, deviceId: b.deviceId, deviceToken: b.deviceToken, host: HOST, deviceName: "Joiner", vaultGeneration: null, ...HOSTILE_FIELDS } };
		}
		return { status: 404, json: null };
	};
}

/** The params Obsidian hands registerObsidianProtocolHandler for an obsidian://yaos?... link (registerUi.ts:220). */
function protocolParams(link: string, action?: string): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [k, v] of new URL(link).searchParams) params[k] = v;
	if (action !== undefined) params.action = action; // Obsidian may report the protocol action instead (host/ui/pairing.ts:828-830)
	return params;
}

/** server/src/console/mobileSetup.ts:47-59 as the page runs it: fragment params, checks, then the obsidian link. */
function mobileSetupPage(url: string): string | null {
	const u = new URL(url);
	const params = new URLSearchParams(u.hash.slice(1));
	const host = (params.get("host") || "").trim().replace(/[/]+$/, "");
	const code = (params.get("pairingCode") || "").trim();
	if (!/^[A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]{32}$/.test(code)) return null;
	if (host !== u.origin) return null;
	return `obsidian://yaos?${new URLSearchParams({ action: "setup", host, pairingCode: code }).toString()}`;
}

/** What each key-less form hands PairingSession.submit (the pair modal's fields). Secrets stay in memory. */
function joinInput(form: JoinForm, code: string): EnrollInput {
	const fromLink = (params: Record<string, string>): EnrollInput => {
		const p = parseSetupLink(params);
		if (!p.ok || p.kind !== "setup") throw new Error(`setup link refused (${form})`);
		return { host: p.host, pairingCode: p.pairingCode, deviceName: "Joiner" };
	};
	// The console's link and setup QR (server/src/console/console.ts:160, :169).
	const consoleLink = `obsidian://yaos?${new URLSearchParams({ action: "setup", host: HOST, pairingCode: code }).toString()}`;
	switch (form) {
		case "typed":
		case "resume":
			return { host: "  relay.example/ ", pairingCode: ` ${code}\n`, deviceName: "  Joiner " };
		case "console-link":
			return fromLink(protocolParams(consoleLink));
		case "console-link-protocol-action":
			return fromLink(protocolParams(consoleLink, "yaos"));
		case "plugin-link":
			return fromLink(protocolParams(buildSetupLink(HOST, code)));
		case "mobile-setup-qr": {
			const link = mobileSetupPage(`${HOST}/mobile-setup#${new URLSearchParams({ host: HOST, pairingCode: code }).toString()}`);
			if (!link) throw new Error("mobile-setup page refused the console QR");
			return fromLink(protocolParams(link));
		}
	}
}

/** Settles `p` on the clock; the outcome as a short label (fixed texts only, never a payload). */
async function outcome(clock: VirtualClock, p: Promise<unknown>, horizonMs = 60_000): Promise<string> {
	let r: string | null = null;
	p.then(
		(v) => {
			const x = v as { t?: string; refused?: string | null } | undefined;
			r = x?.t === "attachmentsCleaned" ? `attachmentsCleaned:${x.refused ?? "none"}` : (x?.t ?? "done");
		},
		(e: unknown) => {
			if (e instanceof PinRefusedError) r = `refused:${e.refusal}`;
			else {
				// The engine's error code: on the raw runtime error, or the "code: message" text main rethrows (safeMessage).
				const m = e instanceof Error ? e.message : String(e);
				const raw = (e as { error?: { code?: unknown } } | null)?.error?.code;
				const code = typeof raw === "string" ? raw : /^([a-z][a-z-]*): /.exec(m)?.[1];
				r = code === "not-ready" || /not running/.test(m) ? "not-ready" : code !== undefined ? `engine:${code}` : `error:${m.slice(0, 80)}`;
			}
		},
	);
	await clock.runUntil(() => r !== null, horizonMs);
	return r ?? "unsettled";
}

/** The relay state a case starts from (before the joining device exists). True when the state hides k from the joiner. */
async function prepareVault(clock: VirtualClock, net: SimNet, state: VaultState): Promise<boolean> {
	if (state === "suite0-data" || state === "hidden-genesis+suite0-data") {
		const b = new SimDevice({ name: "B", clock, net }); // the suite-0 fixture pin: it writes plaintext rows
		b.vault.userWrite("notes/b.md", "from b\n");
		b.vault.userWrite("notes/c.md", "more\n");
		void b.start();
		assert.ok(await clock.runUntil(() => net.relay.rows(NS_STREAM).length > 0 && b.vrt?.log.isIdle() === true, 60_000), "B wrote");
		b.crashApp();
		await clock.advance(1_000);
	}
	if (state === "hidden-genesis" || state === "hidden-genesis+suite0-data") {
		const g = await connectPeer(net.relay, clock, "dev-G");
		g.session.append(frame(KEYRING_STREAM, "g-genesis", await genesisFor(SIM_VAULT_ID)));
		await clock.advance(1_000);
		assert.equal(net.relay.rows(KEYRING_STREAM).length, 1, "the genesis is on the relay");
		return true;
	}
	return false;
}

interface ControllerWorld {
	readonly dev: SimDevice;
	readonly ctl: YaosController;
	readonly saved: YaosPluginData[];
	readonly statuses: StatusSnapshot[];
	readonly engineCommands: Map<string, number>;
	readonly blob: ReturnType<typeof countingBlob>;
	/** The current engine's command, bypassing main's refusals (what a buggy or hostile main could send). */
	readonly direct: (c: UserCommand) => Promise<unknown>;
}

/** A YaosController over a fresh unpinned SimDevice, with every status, saved data.json and engine command recorded. */
function controllerWorld(clock: VirtualClock, net: SimNet, initial: YaosPluginData, name = "J"): ControllerWorld {
	const blob = countingBlob();
	const dev = new SimDevice({ name, clock, net, pin: null, blob: () => blob.port });
	const saved: YaosPluginData[] = [];
	const statuses: StatusSnapshot[] = [];
	const engineCommands = new Map<string, number>();
	let inner: ((c: UserCommand) => Promise<unknown>) | null = null;
	const ctl = new YaosController(initial, {
		makeRuntime: (identity, settings, ui, keys) => {
			const sink: HostUiSink = { ...ui, onStatus: (s) => (statuses.push(s), ui.onStatus(s)) };
			const rt = dev.runtimeFor(identity, settings, sink, keys);
			const raw = rt.command.bind(rt);
			inner = raw;
			rt.command = (c) => (count(engineCommands, c.t === "pinSuite0" ? `pinSuite0:${c.source}` : c.t === "installKey" ? `installKey:${c.source}` : c.t), raw(c));
			return rt;
		},
		saveData: async (d) => void saved.push(JSON.parse(JSON.stringify({ ...d, pendingEnrollment: d.pendingEnrollment ? "set" : undefined })) as YaosPluginData),
		notice: () => undefined,
		clock,
		secrets: dev.secrets,
	});
	const direct = (c: UserCommand): Promise<unknown> => (inner ? inner(c) : Promise.reject(new Error("no runtime")));
	return { dev, ctl, saved, statuses, engineCommands, blob, direct };
}

const noBytes = (b: Uint8Array): boolean => b.byteLength === 0 || b.every((x) => x === 0);

type FlowHost = Pick<YaosUiHost, "data" | "status" | "runState" | "brake" | "onChange" | "updateData" | "command" | "markCreating" | "abandonCreating">;

/**
 * The controller as the UI flows (src/host/ui/**) see it, as plugin.ts hands it to registerUi. Every command main
 * answers is counted as `main answered <command>=<answer>`, and every marker call as `main <method>`.
 */
function uiHostOf(ctl: YaosController, answers: Map<string, number>): FlowHost {
	return {
		data: () => ctl.data(), status: () => ctl.status(), runState: () => ctl.runState(), brake: () => ctl.brake(),
		onChange: (l) => ctl.onChange(l), updateData: (m) => ctl.updateData(m),
		markCreating: (v) => (count(answers, "main markCreating"), ctl.markCreating(v)),
		abandonCreating: (v) => (count(answers, "main abandonCreating"), ctl.abandonCreating(v)),
		command: async (c) => {
			const label = c.t === "pinSuite0" ? `pinSuite0:${c.source}` : c.t === "installKey" ? `installKey:${c.source}` : c.t;
			try {
				const v = await ctl.command(c);
				count(answers, `main answered ${label}=${v.t}`);
				return v;
			} catch (e) {
				count(answers, `main answered ${label}=${e instanceof PinRefusedError ? `refused:${e.refusal}` : "error"}`);
				throw e;
			}
		},
	};
}

/** Settles a UI flow on the clock: "resolved", "CreateVaultError:<code>" or "rejected" (messages are not kept). */
async function flowOutcome(clock: VirtualClock, p: Promise<unknown>): Promise<string> {
	let r: string | null = null;
	p.then(() => (r = "resolved"), (e: unknown) => (r = e instanceof CreateVaultError ? `CreateVaultError:${e.code}` : "rejected"));
	await clock.runUntil(() => r !== null, 60_000);
	return r ?? "unsettled";
}

/** A fixed test operator key (never printed). */
const TEST_OPERATOR_KEY = "0f1e2d3c4b5a6978".repeat(4);

/**
 * A server that would create a vault for anyone: unclaimed, and its claim hands back the device's own vault id and
 * an owner code for it (markedCreating would accept that on an unpinned device). Every request is counted.
 */
function willingCreationServer(requests: Map<string, number>, code: string): RequestFn {
	return async (req) => {
		const path = req.url.startsWith(HOST) ? req.url.slice(HOST.length) : "other-host";
		count(requests, `${req.method} ${path}`);
		if (req.method === "GET" && path === "/api/capabilities") return { status: 200, json: { claimed: false, streams: 1, serverVersion: "sim" } };
		if (req.method === "POST" && path === "/claim") {
			return { status: 200, json: { ok: true, vaultId: SIM_VAULT_ID, pairingCode: code }, headers: { "set-cookie": [`yaos_op=${"s".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Strict`] } };
		}
		if (req.method === "POST" && path === "/operator/logout") return { status: 200, json: { ok: true } };
		if (req.method === "POST" && path === "/enroll") {
			const b = JSON.parse(req.body ?? "{}") as { deviceId?: string; deviceToken?: string };
			return { status: 200, json: { vaultId: SIM_VAULT_ID, deviceId: b.deviceId, deviceToken: b.deviceToken, host: HOST, deviceName: "Joiner", vaultGeneration: null } };
		}
		return { status: 404, json: null };
	};
}

interface JoinTallies {
	cases: number;
	readonly finals: Map<string, number>;
	readonly uiCommands: Map<string, number>;
	readonly probes: Map<string, number>;
	readonly engineCommands: Map<string, number>;
	readonly savedPins: Map<string, number>;
	readonly statusFlags: Map<string, number>;
	readonly writes: Map<string, number>;
	readonly requests: Map<string, number>;
	readonly ui: Map<string, number>;
	/** The UI flows of src/host/ui/** on the blocked device, and every command or marker call they made on main. */
	readonly flows: Map<string, number>;
	headZero: number;
	headPositive: number;
}

async function keylessJoin(form: JoinForm, state: VaultState, seed: number, t: JoinTallies): Promise<void> {
	const clock = newClock();
	const net = new SimNet(clock, { seed: seed * 101 + VAULT_STATES.indexOf(state), linkMs: 10 });
	const hideK = await prepareVault(clock, net, state);
	const rng = new SeededRandom(hashCase(form, state, seed));
	const code = `${SIM_VAULT_ID}.${base64Url(rng.bytes(24))}`; // a D3 code naming the vault (never printed)
	const requests = new Map<string, number>();
	const request = hostileServer(requests);
	const randomBytes = (n: number) => rng.bytes(n);
	const input = joinInput(form, code);
	const initial = form === "resume" ? { ...defaultPluginData("Joiner"), pendingEnrollment: prepareEnrollment(input, randomBytes) } : defaultPluginData("Joiner");
	const w = controllerWorld(clock, net, initial);
	const { dev, ctl } = w;
	// The relay knows the device by its enrolled deviceId (the engine's connect params, net.ts:97): hide k from that id
	// from the moment the attempt exists, before any engine connects.
	const hiddenFrom = new Set<string>();
	const hideFrom = (deviceId: string) => hideK && (hiddenFrom.add(deviceId), net.relay.hideFrom(deviceId as DeviceId, KEYRING_STREAM));
	if (initial.pendingEnrollment) hideFrom(initial.pendingEnrollment.deviceId);
	dev.vault.userWrite("mine.md", "local only\n");
	const before = relayState(net);
	const appendsBefore = net.relay.counters().appendFrames;
	if (before.head === 0) t.headZero++;
	else t.headPositive++;

	// Pair the way each form does (pairModal.ts submit; plugin.ts:130-134 for the resume).
	if (form === "resume") {
		const r = await settleOn(clock, resumePendingEnrollment({ data: () => ctl.data(), updateData: (m) => ctl.updateData(m) }, { request, randomBytes }));
		assert.ok(r.ok && r.value?.ok === true, `resume ${state}`);
		await settleOn(clock, ctl.start());
	} else {
		await settleOn(clock, ctl.start());
		const session = new PairingSession({ request, randomBytes, persist: (a) => (a && hideFrom(a.deviceId), ctl.updateData((d) => (a ? setPendingEnrollment(d, a) : withoutPendingEnrollment(d)))) });
		const id = await settleOn(clock, session.submit(input));
		assert.ok(id.ok, `pair ${form} ${state}`);
		await settleOn(clock, ctl.updateData((d) => applyPairedIdentity(d, id.value)));
	}
	const joiner = ctl.data().identity?.deviceId as DeviceId;
	assert.ok(joiner && (!hideK || hiddenFrom.has(joiner)), "k hidden from the enrolled device");
	const blocked = () => ctl.runState().phase === "running" && ctl.status()?.phase === "key-missing" && ctl.status()?.e2ee?.keyMissing === "no-pin" && ctl.status()?.relay.connected === true;
	assert.ok(await clock.runUntil(blocked, 60_000), `${form} ${state}: blocked, connected`);
	await clock.advance(3_000);

	// Activity that would make a writer write: local edits, a foreground event.
	dev.vault.userWrite("typed-while-blocked.md", "typed while blocked\n");
	dev.platform.emit("visible");
	await clock.advance(5_000);

	// Every UI command the blocked device accepts (commands.ts UI_COMMANDS), and a restart.
	const ui: [string, UserCommand][] = [
		["pause", { t: "pause" }], ["resume", { t: "resume" }], ["reconcileNow", { t: "reconcileNow" }],
		["exportDiagnostics", { t: "exportDiagnostics", includePaths: false }], ["exportDiagnostics+paths", { t: "exportDiagnostics", includePaths: true }],
		["createSnapshot", { t: "createSnapshot" }], ["listSnapshots", { t: "listSnapshots" }], ["rebuildLocalCache", { t: "rebuildLocalCache" }],
		["cleanUpAttachments", { t: "cleanUpAttachments" }],
	];
	for (const [label, c] of ui) count(t.uiCommands, `${label}=${await outcome(clock, ctl.command(c))}`);
	await settleOn(clock, ctl.restartEngine());
	assert.ok(await clock.runUntil(blocked, 60_000), `${form} ${state}: blocked after the restart`);
	count(t.uiCommands, "restartEngine=key-missing/no-pin");

	// Host-layer actions: a QR key and the RK (the genuine ones for the hidden genesis), and every pin command.
	const k = K(1).slice();
	const rk = RK_A.slice();
	const rk2 = seededRk(rng.fork("rk2"));
	const rk3 = seededRk(rng.fork("rk3"));
	count(t.probes, `installKey:qr=${await outcome(clock, ctl.command({ t: "installKey", source: "qr", e: 1, k }))}`);
	count(t.probes, `installKey:rk=${await outcome(clock, ctl.command({ t: "installKey", source: "rk", rk }))}`);
	count(t.probes, `pinSuite0:create=${await outcome(clock, ctl.command({ t: "pinSuite0", source: "create" }))}`);
	count(t.probes, `enableE2ee=${await outcome(clock, ctl.command({ t: "enableE2ee", rk: rk2 }))}`);
	count(t.probes, `revokeRekey=${await outcome(clock, ctl.command({ t: "revokeRekey", rk: rk3 }))}`);
	count(t.probes, `secret buffers wiped=${[k, rk, rk2, rk3].every(noBytes)}`);
	dev.vault.userWrite("typed-after-keys.md", "still blocked\n");
	await clock.advance(10_000);

	// The UI flows a user can reach on this device (§12.4: only a key; §15.1: never creation), against main itself.
	const flowHost = uiHostOf(ctl, t.flows);
	const savesBefore = w.saved.length;
	const dataBefore = fp(ctl.data());
	const creation = new Map<string, number>();
	count(t.flows, `canCreateVault=${canCreateVault(flowHost)}`);
	for (const claimed of [false, true]) {
		const create = createAndEnroll({ server: { host: HOST, claimed }, operatorKey: TEST_OPERATOR_KEY, vaultName: "New vault", deviceName: "Joiner" }, flowHost, { request: willingCreationServer(creation, code), randomBytes });
		count(t.flows, `createAndEnroll ${claimed ? "claimed" : "unclaimed"}=${await flowOutcome(clock, create)}`);
	}
	const rk4 = seededRk(rng.fork("rk4"));
	const rk5 = seededRk(rng.fork("rk5"));
	count(t.flows, `enableEncryption=${await flowOutcome(clock, enableEncryption(flowHost, SIM_VAULT_ID, rk4))}`);
	count(t.flows, `optOutOfEncryption=${await flowOutcome(clock, optOutOfEncryption(flowHost, SIM_VAULT_ID))}`);
	count(t.flows, `revokeRekey=${await flowOutcome(clock, revokeRekey(flowHost, rk5))}`);
	count(t.flows, `flow buffers wiped=${[rk4, rk5].every(noBytes)}`);
	count(t.flows, `creation requests=${[...creation.values()].reduce((a, b) => a + b, 0)}`);
	await clock.advance(3_000);
	count(t.flows, `saves=${w.saved.length - savesBefore}`);
	count(t.flows, `data unchanged=${fp(ctl.data()) === dataBefore}`);

	// The case's outcome.
	const s = ctl.status();
	count(t.finals, `${ctl.runState().phase}/${s?.phase}/${s?.e2ee?.keyMissing}/suite=${s?.e2ee?.suite}`);
	for (const st of w.statuses) {
		if (st.e2ee?.creatable === true) count(t.statusFlags, "creatable");
		if (st.e2ee?.keyringSeen === true) count(t.statusFlags, "keyringSeen");
		if (st.e2ee !== undefined && st.e2ee.suite !== null) count(t.statusFlags, `suite=${st.e2ee.suite}`);
		if (st.phase === "live") count(t.statusFlags, "live");
	}
	if (w.statuses.length > 0) count(t.statusFlags, "cases-with-statuses");
	for (const d of [...w.saved, ctl.data()]) {
		if (d.e2ee !== undefined) count(t.savedPins, `e2ee=${fp(d.e2ee)}`);
		if (d.creating !== undefined) count(t.savedPins, "creating");
	}
	count(t.savedPins, `identity-keys=${Object.keys(ctl.data().identity ?? {}).sort().join(",") === IDENTITY_KEYS.join(",")}`);
	for (const [c, n] of w.engineCommands) t.engineCommands.set(c, (t.engineCommands.get(c) ?? 0) + n);
	for (const [r, n] of requests) t.requests.set(r, (t.requests.get(r) ?? 0) + n);
	const after = relayState(net);
	const writes: Record<string, number> = {
		appends: net.relay.counters().appendFrames - appendsBefore,
		rowsByJoiner: rowsBy(net, joiner, 0),
		headDelta: after.head - before.head,
		checkpointsChanged: after.checkpoints === before.checkpoints ? 0 : 1,
		blobCalls: [...w.blob.calls.values()].reduce((a, b) => a + b, 0),
		indexedDbStores: (await dev.storage.listDatabases()).length,
		sideFileWrites: dev.sideFiles.writes,
		secretWrites: dev.secrets.writes,
		secretsHeld: [...dev.secretBacking.values()].filter((v) => v !== "").length,
		diskNotUsers: [...dev.vault.snapshot().keys()].filter((p) => !["mine.md", "typed-while-blocked.md", "typed-after-keys.md"].includes(p)).length,
	};
	for (const [k2, n] of Object.entries(writes)) t.writes.set(k2, (t.writes.get(k2) ?? 0) + n);
	// The UI layer (src/host/ui/**): the status text and the command list of this state.
	const r = renderStatus(s, ctl.runState());
	count(t.ui, `tooltip names RK+QR=${/recovery key/i.test(r.tooltip) && /scan/i.test(r.tooltip)}`);
	count(t.ui, `tooltip offers plaintext/create=${/unencrypt|without encryption|plain|suite|continue|create|turn off/i.test(r.tooltip)}`);
	const host = { data: () => ctl.data(), status: () => ctl.status(), runState: () => ctl.runState(), brake: () => ctl.brake() };
	for (const spec of UI_COMMANDS) if (spec.available(host)) count(t.ui, `command:${spec.id}`);
	await settleOn(clock, ctl.stop());
	t.cases++;
}

function hashCase(form: string, state: string, seed: number): number {
	let h = seed * 7919;
	for (const ch of `${form}/${state}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return h;
}

let joinMatrix: Promise<JoinTallies> | null = null;

/** Every key-less form x vault state x seed, once per file run (b and c read the same tallies). */
function keylessJoinMatrix(): Promise<JoinTallies> {
	joinMatrix ??= (async () => {
		const t: JoinTallies = {
			cases: 0, finals: new Map(), uiCommands: new Map(), probes: new Map(), engineCommands: new Map(), savedPins: new Map(),
			statusFlags: new Map(), writes: new Map(), requests: new Map(), ui: new Map(), flows: new Map(), headZero: 0, headPositive: 0,
		};
		for (const seed of JOIN_SEEDS) for (const state of VAULT_STATES) for (const form of JOIN_FORMS) await keylessJoin(form, state, seed, t);
		return t;
	})();
	return joinMatrix;
}

/** commands.ts UI_COMMANDS available on a paired device blocked for want of a key (running, not paused, no brake). */
const PALETTE_WHEN_BLOCKED = [
	"yaos-browse-snapshots", "yaos-clean-up-attachments", "yaos-create-snapshot", "yaos-device-check", "yaos-device-check-large", "yaos-export-diagnostics",
	"yaos-export-diagnostics-with-paths", "yaos-pair-another-device", "yaos-pair-device", "yaos-pause",
	"yaos-rebuild-local-cache", "yaos-reconcile-now", "yaos-restart-engine", "yaos-unlock",
] as const;

test("b. hidden k, key-less join: every form x head state x seed ends key-missing/no-pin with zero writes; only installKey (QR, RK) is accepted", async () => {
	const t = await keylessJoinMatrix();
	const n = JOIN_FORMS.length * VAULT_STATES.length * JOIN_SEEDS.length;
	const resumes = VAULT_STATES.length * JOIN_SEEDS.length;
	assert.equal(t.cases, n);
	assert.deepEqual([t.headZero, t.headPositive], [n / VAULT_STATES.length, (n * 3) / VAULT_STATES.length], "head = 0 and head > 0");
	assert.deepEqual(tallyObj(t.finals), { "running/key-missing/no-pin/suite=null": n }, "every case ends blocked, unpinned");
	assert.deepEqual(tallyObj(t.writes), {
		appends: 0, rowsByJoiner: 0, headDelta: 0, checkpointsChanged: 0, blobCalls: 0, indexedDbStores: 0,
		sideFileWrites: 0, secretWrites: 0, secretsHeld: 0, diskNotUsers: 0,
	}, "zero writes: no frame on any stream, no checkpoint, no blob call, no outbox/ns store, no key, nothing on disk");
	assert.deepEqual(tallyObj(t.uiCommands), {
		"pause=ok": n, "resume=ok": n, "reconcileNow=ok": n, "exportDiagnostics=not-ready": n, "exportDiagnostics+paths=not-ready": n,
		"createSnapshot=not-ready": n, "listSnapshots=not-ready": n, "rebuildLocalCache=ok": n,
		"cleanUpAttachments=attachmentsCleaned:keys-unverified": n, "restartEngine=key-missing/no-pin": n,
	}, "no UI command unblocks or writes");
	// Host/engine layer: the only key actions that go through are the RK and a QR key (both left pending here: k is
	// hidden). Everything that would set suite 0, enable encryption or re-key is refused on main.
	assert.deepEqual(tallyObj(t.probes), {
		"installKey:qr=ok": n, "installKey:rk=ok": n, "pinSuite0:create=refused:not-creating": n,
		"enableE2ee=refused:not-creating": n, "revokeRekey=refused:not-encrypted": n, "secret buffers wiped=true": n,
	});
	assert.deepEqual(tallyObj(t.engineCommands), {
		pause: n, resume: n, reconcileNow: n, exportDiagnostics: 2 * n, createSnapshot: n, listSnapshots: n,
		rebuildLocalCache: n, cleanUpAttachments: n, "installKey:qr": n, "installKey:rk": n,
	}, "no pinSuite0, enableE2ee or revokeRekey reached an engine");
	assert.deepEqual(tallyObj(t.requests), { "GET /api/capabilities": n - resumes, "POST /enroll": n }, "every form enrolled against the hostile server");
	// UI layer (src/host/ui/**): the palette of every blocked device, exactly. Its one key command is "yaos-unlock",
	// the blocked screen (keyModals.ts:51-94) with exactly [Scan QR from one of your devices] [Enter recovery key].
	// "Create a new vault" is not offered (canCreateVault, commands.ts:18-22), nor anything that pins or re-keys.
	const commands = Object.keys(tallyObj(t.ui)).filter((k) => k.startsWith("command:"));
	assert.deepEqual(commands, PALETTE_WHEN_BLOCKED.map((id) => `command:${id}`), "the blocked device's palette, exactly");
	assert.deepEqual(commands.filter((c) => /pin\b|suite|e2ee|encrypt|key|plain|unlock|vault|rekey/.test(c)), ["command:yaos-unlock"], "no command that pins, creates a vault or re-keys");
	assert.ok(commands.every((c) => t.ui.get(c) === n));
	assert.equal(t.ui.get("tooltip names RK+QR=true"), n);
	assert.equal(t.ui.get("tooltip offers plaintext/create=false"), n);
	// The flows behind every other button (createVault.ts, keyActions.ts) on the same controller: creation refuses
	// before any request (canCreateVault) against a server that would create, the two choices stop without a marker,
	// re-key needs the key; no command reached main, no marker call, nothing saved.
	assert.deepEqual(tallyObj(t.flows), {
		"canCreateVault=false": n,
		"createAndEnroll claimed=CreateVaultError:blocked": n,
		"createAndEnroll unclaimed=CreateVaultError:blocked": n,
		"enableEncryption=CreateVaultError:stopped": n,
		"optOutOfEncryption=CreateVaultError:stopped": n,
		"revokeRekey=rejected": n,
		"flow buffers wiped=true": n,
		"creation requests=0": n,
		"saves=0": n,
		"data unchanged=true": n,
	}, "the UI flows of a blocked device send nothing and write nothing");
});

test("b. control: the same willing server creates for an unpaired device (the refusal above is not vacuous)", async () => {
	const host = new FakeUiHost();
	const requests = new Map<string, number>();
	const rng = new SeededRandom(5);
	const code = `${SIM_VAULT_ID}.${base64Url(rng.bytes(24))}`;
	assert.equal(canCreateVault(host), true);
	const out = await createAndEnroll({ server: { host: HOST, claimed: false }, operatorKey: TEST_OPERATOR_KEY, vaultName: "New vault", deviceName: "Joiner" }, host, { request: willingCreationServer(requests, code), randomBytes: (k) => rng.bytes(k) });
	assert.equal(out.vaultId, SIM_VAULT_ID);
	assert.deepEqual(tallyObj(requests), { "POST /claim": 1, "POST /enroll": 1, "POST /operator/logout": 1 });
	assert.deepEqual(host.calls, [`markCreating:${SIM_VAULT_ID}`, "updateData"]);
	assert.deepEqual(host.data().creating, { vaultId: SIM_VAULT_ID });
});

test("c. the pin never comes from the server: over every key-less join, 0 suite-0 pins, 0 creatable; every pin setter is main's", async () => {
	const t = await keylessJoinMatrix();
	const n = t.cases;
	assert.ok(n > 0);
	// Dynamic: what the hostile server sent (suite 0, creating, creatable, keyringSeen=false on every answer) set nothing.
	assert.deepEqual(tallyObj(t.savedPins), { "identity-keys=true": n }, "no e2ee or creating field was ever saved; identity has its six fields only");
	assert.deepEqual(tallyObj(t.statusFlags), { "cases-with-statuses": n }, "0 creatable, 0 keyringSeen, 0 suite != null, 0 live statuses");
	assert.equal(t.engineCommands.get("pinSuite0:link") ?? 0, 0);
	assert.equal(t.engineCommands.get("pinSuite0:create") ?? 0, 0);

	// The UI flows on every blocked device (b) sent main no command and made no marker call.
	assert.deepEqual(Object.keys(tallyObj(t.flows)).filter((k) => k.startsWith("main ")), [], "no UI flow reached main");

	// Static: every path that can set a pin, counted in the shipped sources (comments stripped; tests, testkits, spike out).
	const census = pinCensus();
	assert.deepEqual(census, {
		// pluginController.ts: onStatus keyringSeen (:190), pinAfter (:297, only after an engine "ok" to pinSuite0 /
		// enableE2ee that main let through), keyringStored (:310), markCreating (:349).
		"call:sawKeyring": { "host/pluginController.ts": 1 },
		"call:pinnedSuite0": { "host/pluginController.ts": 1 },
		"call:pinnedSuite1": { "host/pluginController.ts": 2 },
		"call:markedCreating": { "host/pluginController.ts": 1 },
		"call:withPin": { "host/keys/pin.ts": 2 },
		// Pin-shaped writes: pin.ts withPin / sawKeyring / pinAcross; api.ts the data.json loader (sanitizePin);
		// keyActions.ts:50 is a route value ({kind: "apply", e2ee: {suite: 1, key}}), not data.json.
		"e2ee-write": { "host/keys/pin.ts": 3, "host/ui/api.ts": 1, "host/ui/keyActions.ts": 1 },
		"creating-write": { "host/keys/pin.ts": 1 },
		saveData: { "host/pluginController.ts": 2, "host/plugin.ts": 1 },
		// plugin.ts:115 wires YaosUiHost.markCreating to main. createVault.ts:117: step 1, after canCreateVault (:114)
		// and the server's creating response; main's markedCreating still refuses it under a pin for that vault.
		markCreating: { "host/plugin.ts": 1, "host/ui/createVault.ts": 1 },
		// createVault.ts:211 enableE2ee and :223 pinSuite0 {create}: only when creationCheck (:206, :221) says
		// "creatable" (§15.1), and main refuses both without the marker (refuseEnableE2ee, refusePinSuite0).
		"command:enableE2ee": { "host/ui/createVault.ts": 1 },
		// keyActions.ts:115 pinSuite0 {link}: main refuses it under any pin or keyringSeen (refusePinSuite0).
		"command:pinSuite0": { "host/ui/createVault.ts": 1, "host/ui/keyActions.ts": 1 },
		// keyActions.ts:119 (QR or link key), :145 (RK): main refuses both on a suite-0 pin (refuseKeyCommand).
		"command:installKey": { "host/ui/keyActions.ts": 2 },
		// keyActions.ts:219: after rekeyBlocked (:215, suite 1 with the current key), and main's refuseKeyCommand.
		"command:revokeRekey": { "host/ui/keyActions.ts": 1 },
		"source-link": { "host/ui/keyActions.ts": 1 },
	}, "no other pin setter, and key commands only at E5's guarded sites");

	// Who can reach those sites: only the user-initiated modals and the protocol handler (registerUi.ts), which
	// plugin.ts registers. createVault.ts sits behind CreateVaultModal alone.
	assert.deepEqual(importersOf(["host/ui/createVault.ts", "host/ui/createVaultModal.ts", "host/ui/keyActions.ts", "host/ui/keyModals.ts", "host/ui/pairModal.ts", "host/ui/registerUi.ts"]), {
		"host/ui/createVault.ts": ["host/ui/createVaultModal.ts"],
		"host/ui/createVaultModal.ts": ["host/ui/registerUi.ts"],
		"host/ui/keyActions.ts": ["host/ui/keyModals.ts", "host/ui/pairModal.ts", "host/ui/registerUi.ts"],
		"host/ui/keyModals.ts": ["host/ui/createVaultModal.ts", "host/ui/registerUi.ts"],
		"host/ui/pairModal.ts": ["host/ui/registerUi.ts"],
		"host/ui/registerUi.ts": ["host/plugin.ts"],
	});
	// registerUi.ts opens CreateVaultModal (:120) only from the two commands and the two settings actions.
	const register = shippedSource("host/ui/registerUi.ts");
	assert.equal(register.match(/new CreateVaultModal\(/g)?.length, 1);
	assert.equal(register.match(/\bopenCreateVault\(/g)?.length, 4);
	assert.deepEqual([...register.matchAll(/^\s*(.*?)\s*=>\s*openCreateVault\((true|false)\)/gm)].map((m) => `${m[1]}(${m[2]})`).sort(), [
		"\"yaos-create-vault\": ()(false)", "\"yaos-finish-creating-vault\": ()(true)", "openCreateVault: ()(false)", "openResumeCreation: ()(true)",
	]);
});

test("c. createVault's two choices send nothing short of \"creatable\" (§15.1), whatever the status claims", async () => {
	const out = new Map<string, number>();
	const marker = { creating: { vaultId: SIM_VAULT_ID } };
	const states: [string, Partial<YaosPluginData>, StatusSnapshot | null][] = [
		["creatable (control)", { ...pairedData(), ...marker }, snapshot("key-missing", { creatable: true })],
		["no marker, status says creatable", pairedData(), snapshot("key-missing", { creatable: true })],
		["unpaired, marker", { ...defaultPluginData("J"), ...marker }, snapshot("key-missing", { creatable: true })],
		["marker for another vault", { ...pairedData(), creating: { vaultId: OTHER_VAULT } }, snapshot("key-missing", { creatable: true })],
		["marker, keyringSeen pin", { ...pairedData(), ...marker, e2ee: { suite: null, keyringSeen: true } }, snapshot("key-missing", { creatable: true })],
		["marker, suite-1 pin", { ...pairedData(), ...marker, e2ee: { suite: 1 } }, snapshot("key-missing", { creatable: true })],
		["marker, suite-0 pin", { ...pairedData(), ...marker, e2ee: { suite: 0 } }, snapshot("key-missing", { creatable: true })],
		["marker, engine read a genesis", { ...pairedData(), ...marker }, snapshot("key-missing", { keyringSeen: true, keyMissing: "encrypted-vault" })],
		["marker, head > 0", { ...pairedData(), ...marker }, snapshot("key-missing", {}, { headSeq: 3 })],
		["marker, engine not reporting", { ...pairedData(), ...marker }, null],
	];
	for (const [name, data, snap] of states) {
		for (const choice of ["enable", "opt-out"] as const) {
			const host = new FakeUiHost(data);
			host.snap = snap;
			const rk = seededRk(new SeededRandom(name.length));
			const r = await (choice === "enable" ? enableEncryption(host, SIM_VAULT_ID, rk) : optOutOfEncryption(host, SIM_VAULT_ID)).then(() => "resolved", (e: unknown) => (e instanceof CreateVaultError ? e.code : "rejected"));
			count(out, `${name}: ${choice}=${r} sent=${host.commands.map((c) => (c.t === "pinSuite0" ? `pinSuite0:${c.source}` : c.t)).join(",") || "none"} rk wiped=${noBytes(rk)}`);
		}
	}
	assert.deepEqual(tallyObj(out), {
		"creatable (control): enable=resolved sent=enableE2ee rk wiped=true": 1,
		"creatable (control): opt-out=resolved sent=pinSuite0:create rk wiped=false": 1,
		"no marker, status says creatable: enable=stopped sent=none rk wiped=true": 1,
		"no marker, status says creatable: opt-out=stopped sent=none rk wiped=false": 1,
		"unpaired, marker: enable=stopped sent=none rk wiped=true": 1,
		"unpaired, marker: opt-out=stopped sent=none rk wiped=false": 1,
		"marker for another vault: enable=stopped sent=none rk wiped=true": 1,
		"marker for another vault: opt-out=stopped sent=none rk wiped=false": 1,
		"marker, keyringSeen pin: enable=not-empty sent=none rk wiped=true": 1,
		"marker, keyringSeen pin: opt-out=not-empty sent=none rk wiped=false": 1,
		"marker, suite-1 pin: enable=stopped sent=none rk wiped=true": 1,
		"marker, suite-1 pin: opt-out=stopped sent=none rk wiped=false": 1,
		"marker, suite-0 pin: enable=stopped sent=none rk wiped=true": 1,
		"marker, suite-0 pin: opt-out=stopped sent=none rk wiped=false": 1,
		"marker, engine read a genesis: enable=not-empty sent=none rk wiped=true": 1,
		"marker, engine read a genesis: opt-out=not-empty sent=none rk wiped=false": 1,
		"marker, head > 0: enable=not-empty sent=none rk wiped=true": 1,
		"marker, head > 0: opt-out=not-empty sent=none rk wiped=false": 1,
		"marker, engine not reporting: enable=unconfirmed sent=none rk wiped=true": 1,
		"marker, engine not reporting: opt-out=unconfirmed sent=none rk wiped=false": 1,
	}, "a command only on the creation path, read creatable");
});

test("c. a suite=0 link never pins a device that holds a pin or has seen a genesis: refused on main, 0 engine pins, 0 writes", async () => {
	const t = { outcomes: new Map<string, number>(), pins: new Map<string, number>(), writes: new Map<string, number>(), engine: new Map<string, number>() };
	const PINS = [["suite 1", { suite: 1 }], ["suite 0", { suite: 0 }], ["keyringSeen", { suite: null, keyringSeen: true }]] as const;
	for (const seed of SEEDS) for (const [name, pin] of PINS) {
		const clock = newClock();
		const net = new SimNet(clock, { seed: seed * 53 + name.length, linkMs: 10 });
		const w = controllerWorld(clock, net, pairedData(J_ID, { e2ee: pin }));
		const { ctl } = w;
		void ctl.start();
		assert.ok(await clock.runUntil(() => ctl.runState().phase === "running" && ctl.status()?.relay.connected === true && ctl.status()?.e2ee !== undefined, 60_000), `${name}: running`);
		await clock.advance(3_000);
		const since = { ...relayState(net), appends: net.relay.counters().appendFrames };
		const answers = new Map<string, number>();
		const host = uiHostOf(ctl, answers);
		const opts = simOpts(clock);
		const rng = new SeededRandom(seed * 7 + name.length);
		const code = `${SIM_VAULT_ID}.${base64Url(rng.bytes(24))}`;
		const links: [string, Record<string, string>][] = [["suite=0", { action: "setup", host: HOST, pairingCode: code, suite: "0" }]];
		if (pin.suite === 0) links.push(["key", { action: "setup", host: HOST, pairingCode: code, key: encodeKeyParam({ e: 1, k: K(1).slice() }) }]);
		for (const [link, params] of links) {
			// What the protocol handler does (registerUi.ts:220-225): route, then applyLink -> applyLinkE2ee.
			const route = routeSetupLink(parseSetupLink(params), ctl.data(), ctl.status());
			const applied = route.kind === "apply" ? await flowOutcome(clock, applyLinkE2ee(host, SIM_VAULT_ID, route.e2ee, opts)) : "-";
			count(t.outcomes, `${name}, ${link} link: route=${route.kind} applyLinkE2ee=${applied}`);
		}
		for (const [k2, v] of answers) count(t.outcomes, `${name}: ${k2}${v > 1 ? ` x${v}` : ""}`);
		await clock.advance(3_000);
		count(t.pins, `${name}: pin unchanged=${fp(ctl.data().e2ee) === fp(pin)}`);
		for (const [c, v] of w.engineCommands) if (/pinSuite0|enableE2ee|installKey|revokeRekey/.test(c)) t.engine.set(c, (t.engine.get(c) ?? 0) + v);
		if (pin.suite !== 0) sumInto(t.writes, await writesOf(net, w, [J_ID], since));
		else count(t.writes, `suite 0: k rows by the device=${net.relay.rows(KEYRING_STREAM).filter((r) => r.deviceId === J_ID).length}`);
		await settleOn(clock, ctl.stop());
	}
	const n = SEEDS.length;
	assert.deepEqual(tallyObj(t.outcomes), {
		"suite 1, suite=0 link: route=apply applyLinkE2ee=rejected": n,
		"suite 1: main answered pinSuite0:link=refused:already-pinned": n,
		"suite 0, suite=0 link: route=apply applyLinkE2ee=rejected": n,
		"suite 0, key link: route=apply applyLinkE2ee=rejected": n,
		"suite 0: main answered pinSuite0:link=refused:already-pinned": n,
		"suite 0: main answered installKey:qr=refused:suite-0-pinned": n,
		"keyringSeen, suite=0 link: route=apply applyLinkE2ee=rejected": n,
		"keyringSeen: main answered pinSuite0:link=refused:keyring-seen": n,
	}, "each link is routed to its vault and refused on main, once (a refusal is not retried)");
	assert.deepEqual(tallyObj(t.pins), { "suite 1: pin unchanged=true": n, "suite 0: pin unchanged=true": n, "keyringSeen: pin unchanged=true": n });
	assert.deepEqual(tallyObj(t.engine), {}, "no pin or key command reached an engine");
	assert.deepEqual(tallyObj(t.writes), { ...ZERO_WRITES, "suite 0: k rows by the device=0": n });
});

// --- shared: a paired, unpinned controller device ------------------------------------------------------------

const J_ID = "dev-J" as DeviceId;
const OTHER_VAULT = "otherVaultBBBBBBBBBBBA"; // canonical: 22 chars, last one carries no stray bits
const SEEDS = [1, 2, 3] as const;

function pairedData(deviceId: string = J_ID, extra: Partial<YaosPluginData> = {}): YaosPluginData {
	// The token is a fixed test value; it is never printed.
	return { ...defaultPluginData("J"), identity: { host: HOST, vaultId: SIM_VAULT_ID, deviceId, deviceToken: "test-token-J", deviceName: "J", vaultGeneration: null }, ...extra };
}

const blockedOn = (ctl: YaosController, reason: string) => (): boolean => {
	const s = ctl.status();
	return ctl.runState().phase === "running" && s?.phase === "key-missing" && s.e2ee?.keyMissing === reason && s.relay.connected === true;
};

/** A peer appends `payload` to `stream` (a forged or honest frame from another device). */
async function peerAppends(clock: VirtualClock, net: SimNet, name: string, stream: StreamName, payload: Uint8Array): Promise<void> {
	const peer = await connectPeer(net.relay, clock, `dev-${name}`);
	peer.session.append(frame(stream, `${name}-${stream}-${clock.now()}`, payload));
	await clock.advance(1_000);
}

/** Every relay write the device could make, as counts (0 = none). */
async function writesOf(net: SimNet, w: ControllerWorld, deviceIds: readonly string[], since: { head: number; appends: number; checkpoints: string }): Promise<Record<string, number>> {
	const now = relayState(net);
	return {
		rows: deviceIds.reduce((n, id) => n + rowsBy(net, id as DeviceId, 0), 0),
		appends: net.relay.counters().appendFrames - since.appends,
		headDelta: now.head - since.head,
		checkpointsChanged: now.checkpoints === since.checkpoints ? 0 : 1,
		blobCalls: [...w.blob.calls.values()].reduce((a, b) => a + b, 0),
		indexedDbStores: (await w.dev.storage.listDatabases()).length,
		secretWrites: w.dev.secrets.writes,
		secretsHeld: [...w.dev.secretBacking.values()].filter((v) => v !== "").length,
	};
}

function sumInto(t: Map<string, number>, r: Record<string, number>): void {
	for (const [k, n] of Object.entries(r)) t.set(k, (t.get(k) ?? 0) + n);
}

const ZERO_WRITES = { rows: 0, appends: 0, headDelta: 0, checkpointsChanged: 0, blobCalls: 0, indexedDbStores: 0, secretWrites: 0, secretsHeld: 0 };

/**
 * suite=0 link shapes as Obsidian hands them to the protocol handler (registerUi.ts:220-225). The first four are
 * what §12.4 source (ii) sanctions and parseSetupLink accepts; the two with an unknown key are rejected.
 */
function suite0LinkParams(code: string): Record<string, string>[] {
	const base = { action: "setup", host: HOST, pairingCode: code };
	return [
		{ ...base, suite: "0" },
		{ ...base, action: "yaos", suite: "0" },
		{ ...base, vault: "My vault", suite: "0" },
		{ ...base, e2ee: "0" },
		{ ...base, e2ee: "off" },
		{ host: HOST, pairingCode: code, suite: "0" },
	];
}

// --- d. suite-0 link after a genesis ------------------------------------------------------------------------

test("d. suite-0 link after a genesis: keyringSeen is sticky, the link is refused at every layer, nothing is written", async () => {
	const t = { cases: 0, outcomes: new Map<string, number>(), links: new Map<string, number>(), writes: new Map<string, number>(), pins: new Map<string, number>() };
	const answers = new Map<string, number>();
	/** Every suite=0 shape as the protocol handler takes it (registerUi.ts:220-225): parse, route, applyLinkE2ee. */
	const viaHandler = async (label: string, clock: VirtualClock, ctl: YaosController, code: string): Promise<void> => {
		for (const params of suite0LinkParams(code)) {
			const parsed = parseSetupLink(params);
			if (!parsed.ok) {
				count(t.links, `${label}: rejected`);
				continue;
			}
			const route = routeSetupLink(parsed, ctl.data(), ctl.status());
			count(t.links, `${label}: ${parsed.kind} suite=${parsed.kind === "setup" ? parsed.e2ee?.suite : "-"} route=${route.kind}`);
			if (route.kind !== "apply") continue;
			const vaultId = ctl.data().identity?.vaultId ?? "";
			count(t.outcomes, `${label}: applyLinkE2ee=${await flowOutcome(clock, applyLinkE2ee(uiHostOf(ctl, answers), vaultId, route.e2ee, simOpts(clock)))}`);
		}
	};
	for (const seed of SEEDS) for (const mode of ["live", "history"] as const) {
		const clock = newClock();
		const net = new SimNet(clock, { seed: seed * 17 + (mode === "live" ? 1 : 2), linkMs: 10 });
		const genesis = await genesisFor(SIM_VAULT_ID);
		if (mode === "history") await peerAppends(clock, net, "G", KEYRING_STREAM, genesis);
		const w = controllerWorld(clock, net, pairedData());
		const { ctl, dev } = w;
		dev.vault.userWrite("mine.md", "local only\n");
		void ctl.start();
		if (mode === "live") {
			assert.ok(await clock.runUntil(blockedOn(ctl, "no-pin"), 60_000), "blocked before the genesis");
			await peerAppends(clock, net, "G", KEYRING_STREAM, genesis);
		}
		assert.ok(await clock.runUntil(blockedOn(ctl, "encrypted-vault"), 60_000), `${mode}: encrypted-vault`);
		await clock.advance(1_000);
		count(t.pins, `after genesis=${fp(ctl.data().e2ee)}`);
		const since = { ...relayState(net), appends: net.relay.counters().appendFrames };

		// The server now hides k and cuts the session; the device reconnects to an "empty" k.
		net.relay.hideFrom(J_ID, KEYRING_STREAM);
		net.relay.dropSession(J_ID);
		await clock.advance(500);
		assert.ok(await clock.runUntil(() => ctl.status()?.relay.connected === true && ctl.status()?.phase === "key-missing", 60_000), "reconnected");
		await clock.advance(3_000);
		count(t.outcomes, `reconnected, k hidden: keyMissing=${ctl.status()?.e2ee?.keyMissing} keyringSeen(engine)=${ctl.status()?.e2ee?.keyringSeen}`);
		dev.vault.userWrite("typed.md", "typed while blocked\n");
		await clock.advance(3_000);

		// The suite=0 link arrives. parseSetupLink accepts the sanctioned shapes (§12.4 source (ii)), routeSetupLink
		// sends them to this vault ("apply"), and applyLinkE2ee's pinSuite0 {link} is refused by main (keyring-seen).
		const rng = new SeededRandom(seed * 1_000 + (mode === "live" ? 1 : 2));
		const code = `${SIM_VAULT_ID}.${base64Url(rng.bytes(24))}`;
		await viaHandler("after genesis", clock, ctl, code);
		// The same command sent to main directly. Main refuses on keyringSeen (refusePinSuite0, pin.ts) ...
		count(t.outcomes, `ctl pinSuite0 link=${await outcome(clock, ctl.command({ t: "pinSuite0", source: "link" }))}`);
		// ... and so does this engine incarnation, which read the genesis before k was hidden (keyReader.ts:229).
		count(t.outcomes, `engine-direct pinSuite0 link (same incarnation)=${await outcome(clock, w.direct({ t: "pinSuite0", source: "link" }))}`);
		// The UI cannot clear the sticky flag (pinAcross keeps main's pin fields, pin.ts:151-157).
		await settleOn(clock, ctl.updateData((d) => ({ ...d, e2ee: undefined, deviceLabel: "J2" })));
		await settleOn(clock, ctl.updateData((d) => ({ ...d, e2ee: { suite: 0 } })));
		count(t.pins, `after UI writes=${fp(ctl.data().e2ee)}`);

		// Re-pair by a key-less link into the same vault (fresh deviceId): keyringSeen survives (same vault).
		const requests = new Map<string, number>();
		const session = new PairingSession({
			request: hostileServer(requests), randomBytes: (n) => rng.bytes(n),
			persist: (a) => (a && net.relay.hideFrom(a.deviceId as DeviceId, KEYRING_STREAM), ctl.updateData((d) => (a ? setPendingEnrollment(d, a) : withoutPendingEnrollment(d)))),
		});
		const repaired = await settleOn(clock, session.submit(joinInput("console-link", code)));
		assert.ok(repaired.ok, "re-paired");
		await settleOn(clock, ctl.updateData((d) => applyPairedIdentity(d, repaired.value)));
		const newId = ctl.data().identity!.deviceId;
		assert.notEqual(newId, J_ID);
		assert.ok(await clock.runUntil(() => ctl.status()?.relay.connected === true && ctl.status()?.phase === "key-missing" && ctl.runState().phase === "running", 60_000), "re-paired, blocked");
		await clock.advance(2_000);
		count(t.pins, `after re-pair=${fp(ctl.data().e2ee)}`);
		await viaHandler("after re-pair", clock, ctl, code);
		count(t.outcomes, `ctl pinSuite0 link after re-pair=${await outcome(clock, ctl.command({ t: "pinSuite0", source: "link" }))}`);
		// A restart: the engine is not told keyringSeen (e2ee-design.md §18.4 "keyringSeen is not in init.crypto", hostKeys.ts:48); main stays the gate.
		await settleOn(clock, ctl.restartEngine());
		assert.ok(await clock.runUntil(() => ctl.status()?.relay.connected === true && ctl.status()?.phase === "key-missing" && ctl.runState().phase === "running", 60_000));
		await clock.advance(2_000);
		await viaHandler("after restart", clock, ctl, code);
		count(t.outcomes, `ctl pinSuite0 link after restart=${await outcome(clock, ctl.command({ t: "pinSuite0", source: "link" }))}`);
		count(t.outcomes, `engine-direct pinSuite0 link after restart=${await outcome(clock, w.direct({ t: "pinSuite0", source: "link" }))}`);
		count(t.outcomes, `final=${ctl.status()?.phase}/suite=${ctl.status()?.e2ee?.suite}`);
		dev.vault.userWrite("typed-2.md", "still blocked\n");
		await clock.advance(5_000);
		count(t.pins, `final=${fp(ctl.data().e2ee)}`);
		count(t.outcomes, `pinSuite0 {link} that reached an engine through main=${w.engineCommands.get("pinSuite0:link") ?? 0}`);
		for (const d of w.saved) if (d.e2ee?.suite === 0 || d.e2ee?.suite === 1) count(t.pins, "saved suite pin");
		if (w.statuses.some((st) => st.e2ee?.suite !== null && st.e2ee?.suite !== undefined)) count(t.pins, "status with a suite");
		sumInto(t.writes, await writesOf(net, w, [J_ID, newId], since));
		await settleOn(clock, ctl.stop());
		t.cases++;
	}
	const n = SEEDS.length * 2;
	assert.equal(t.cases, n);
	const seen = fp({ suite: null, keyringSeen: true });
	assert.deepEqual(tallyObj(t.pins), { [`after genesis=${seen}`]: n, [`after UI writes=${seen}`]: n, [`after re-pair=${seen}`]: n, [`final=${seen}`]: n }, "keyringSeen saved and sticky; no suite pin saved or reported");
	const points = ["after genesis", "after re-pair", "after restart"];
	assert.deepEqual(tallyObj(t.links), tallyObj(new Map(points.flatMap((p) => [[`${p}: rejected`, n * 2], [`${p}: setup suite=0 route=apply`, n * 4]] as const))),
		"the parser accepts the 4 sanctioned suite=0 shapes and rejects the 2 with unknown keys; each accepted one routes to this vault");
	assert.deepEqual(tallyObj(answers), { "main answered pinSuite0:link=refused:keyring-seen": n * 4 * points.length }, "main refused every one, once (not retried); no marker call");
	assert.deepEqual(tallyObj(t.outcomes), {
		...Object.fromEntries(points.map((p) => [`${p}: applyLinkE2ee=rejected`, n * 4])),
		"reconnected, k hidden: keyMissing=encrypted-vault keyringSeen(engine)=true": n,
		"ctl pinSuite0 link=refused:keyring-seen": n,
		"engine-direct pinSuite0 link (same incarnation)=engine:refused": n,
		"ctl pinSuite0 link after re-pair=refused:keyring-seen": n,
		"ctl pinSuite0 link after restart=refused:keyring-seen": n,
		// By design the restarted engine does not know keyringSeen (e2ee-design.md §18.4 "keyringSeen is not in init.crypto"): an engine "ok" sets nothing,
		// only main pins (pluginController.ts:269 -> pinAfter :296-301), and main refused above.
		"engine-direct pinSuite0 link after restart=ok": n,
		"final=key-missing/suite=null": n,
		"pinSuite0 {link} that reached an engine through main=0": n,
	});
	assert.deepEqual(tallyObj(t.writes), ZERO_WRITES, "nothing written after the genesis was read");
});

// --- e. the creation path ------------------------------------------------------------------------------------

/** What a hostile server returns after the creation call: a vault that is not empty (head > 0 or k non-empty). */
const NOT_EMPTY = ["suite0-data", "forged-body-row", "visible-genesis", "garbage-k-row", "hidden-genesis"] as const;

async function notEmptyVault(clock: VirtualClock, net: SimNet, state: (typeof NOT_EMPTY)[number]): Promise<void> {
	switch (state) {
		case "suite0-data":
			return void (await prepareVault(clock, net, "suite0-data"));
		case "forged-body-row": {
			const docId = newDocId(new SeededRandom(5));
			return peerAppends(clock, net, "F", bodyStream(docId), enc.encode(`${MARK} body`));
		}
		case "visible-genesis":
			return peerAppends(clock, net, "G", KEYRING_STREAM, await genesisFor(SIM_VAULT_ID));
		case "garbage-k-row":
			return peerAppends(clock, net, "G", KEYRING_STREAM, new SeededRandom(9).bytes(180));
		case "hidden-genesis":
			await peerAppends(clock, net, "G", KEYRING_STREAM, await genesisFor(SIM_VAULT_ID));
			return net.relay.hideFrom(J_ID, KEYRING_STREAM);
	}
}

test("e. creation path: a non-empty vault never becomes creatable; a marker for another vault is ignored; no link reaches the flow", async () => {
	const t = { outcomes: new Map<string, number>(), flags: new Map<string, number>(), writes: new Map<string, number>(), links: new Map<string, number>(), pins: new Map<string, number>() };
	const probe = async (label: string, clock: VirtualClock, w: ControllerWorld): Promise<void> => {
		const rk = seededRk(new SeededRandom(clock.now() + 1));
		count(t.outcomes, `${label}: enableE2ee=${await outcome(clock, w.ctl.command({ t: "enableE2ee", rk }))}`);
		count(t.outcomes, `${label}: pinSuite0 create=${await outcome(clock, w.ctl.command({ t: "pinSuite0", source: "create" }))}`);
		count(t.outcomes, `${label}: rk zero-filled=${noBytes(rk)}`);
	};
	const creatableSeen = (w: ControllerWorld): number => w.statuses.filter((st) => st.e2ee?.creatable === true).length;

	for (const seed of SEEDS) {
		// (1) The marker names this vault, the server returns a vault that is not empty: abort, no pin, no write.
		for (const state of NOT_EMPTY) {
			const clock = newClock();
			const net = new SimNet(clock, { seed: seed * 31 + NOT_EMPTY.indexOf(state), linkMs: 10 });
			await notEmptyVault(clock, net, state);
			const w = controllerWorld(clock, net, pairedData(J_ID, { creating: { vaultId: SIM_VAULT_ID } }));
			w.dev.vault.userWrite("mine.md", "local\n");
			const since = { ...relayState(net), appends: net.relay.counters().appendFrames };
			void w.ctl.start();
			assert.ok(await clock.runUntil(() => w.ctl.status()?.phase === "key-missing" && w.ctl.status()?.relay.connected === true, 60_000), state);
			await clock.advance(3_000);
			count(t.flags, `not-empty: creatable statuses=${creatableSeen(w)}`);
			await probe("not-empty", clock, w);
			await clock.advance(3_000);
			count(t.pins, `not-empty: ${fp(w.ctl.data().e2ee ?? null)}`);
			sumInto(t.writes, await writesOf(net, w, [J_ID], since));
			await settleOn(clock, w.ctl.stop());
		}

		// (2) A creating marker for another vaultId, over an empty vault (head 0, k empty: only the marker decides).
		for (const how of ["in data.json before pairing", "in data.json while paired", "markCreating while paired"] as const) {
			const clock = newClock();
			const net = new SimNet(clock, { seed: seed * 37 + how.length, linkMs: 10 });
			const other = { creating: { vaultId: OTHER_VAULT } };
			const w = controllerWorld(clock, net, how === "in data.json before pairing" ? { ...defaultPluginData("J"), ...other } : pairedData(J_ID, how === "in data.json while paired" ? other : {}));
			const since = { ...relayState(net), appends: net.relay.counters().appendFrames };
			await settleOn(clock, w.ctl.start());
			if (how === "in data.json before pairing") {
				const rng = new SeededRandom(seed);
				const session = new PairingSession({ request: hostileServer(new Map()), randomBytes: (n) => rng.bytes(n), persist: (a) => w.ctl.updateData((d) => (a ? setPendingEnrollment(d, a) : withoutPendingEnrollment(d))) });
				const id = await settleOn(clock, session.submit(joinInput("typed", `${SIM_VAULT_ID}.${base64Url(rng.bytes(24))}`)));
				assert.ok(id.ok);
				await settleOn(clock, w.ctl.updateData((d) => applyPairedIdentity(d, id.value)));
			}
			if (how === "markCreating while paired") {
				assert.ok((await settleOn(clock, w.ctl.markCreating(OTHER_VAULT))).ok, "marked");
				await settleOn(clock, w.ctl.restartEngine());
			}
			assert.ok(await clock.runUntil(blockedOn(w.ctl, "no-pin"), 60_000), how);
			await clock.advance(3_000);
			count(t.flags, `other-vault marker: creatable statuses=${creatableSeen(w)}`);
			count(t.flags, `other-vault marker: kept=${w.ctl.data().creating?.vaultId === OTHER_VAULT}`);
			await probe("other-vault marker", clock, w);
			count(t.pins, `other-vault marker: ${fp(w.ctl.data().e2ee ?? null)}`);
			const ids = [J_ID, w.ctl.data().identity!.deviceId];
			sumInto(t.writes, await writesOf(net, w, ids, since));
			await settleOn(clock, w.ctl.stop());
		}

		// (3) The UI (or a hostile data.json write through updateData) cannot set the marker or a pin (pinAcross).
		{
			const clock = newClock();
			const net = new SimNet(clock, { seed: seed * 41, linkMs: 10 });
			const w = controllerWorld(clock, net, pairedData());
			await settleOn(clock, w.ctl.start());
			assert.ok(await clock.runUntil(blockedOn(w.ctl, "no-pin"), 60_000));
			for (const forged of [{ creating: { vaultId: SIM_VAULT_ID } }, { e2ee: { suite: 0 as const } }, { e2ee: { suite: 1 as const } }, { e2ee: { suite: 0 as const }, creating: { vaultId: SIM_VAULT_ID } }]) {
				await settleOn(clock, w.ctl.updateData((d) => ({ ...d, ...forged, deviceLabel: `J${clock.now()}` })));
				count(t.pins, `UI write dropped=${w.ctl.data().e2ee === undefined && w.ctl.data().creating === undefined}`);
			}
			await clock.advance(3_000);
			count(t.flags, `UI writes: creatable statuses=${creatableSeen(w)}`);
			await probe("UI writes", clock, w);
			await settleOn(clock, w.ctl.stop());
		}

		// Positive control: the marker for this vault over an empty vault is creatable (the refusals above are not vacuous).
		{
			const clock = newClock();
			const net = new SimNet(clock, { seed: seed * 43, linkMs: 10 });
			const w = controllerWorld(clock, net, pairedData(J_ID, { creating: { vaultId: SIM_VAULT_ID } }));
			await settleOn(clock, w.ctl.start());
			assert.ok(await clock.runUntil(() => w.ctl.status()?.e2ee?.creatable === true, 60_000), "control: creatable");
			count(t.flags, "control: creatable");
			await settleOn(clock, w.ctl.stop());
		}
	}

	// (4) No link reaches the flow. The protocol handler (registerUi.ts:220-225) is routeSetupLink(parseSetupLink(
	// params)) and then a Notice ("ignore"), openPair -> PairModal ("pair") or applyLink -> applyLinkE2ee ("apply").
	// createVault.ts is imported by createVaultModal.ts alone and markCreating is called only there (c's census and
	// import graph). Behaviourally, over every link class x device state: the route is §12.4's, a pair route enrolls
	// with a key-free /enroll body and attempt, and an apply route sends only pinSuite0 {link} or installKey {qr}.
	await linkMatrix(t.links);
	const register = shippedSource("host/ui/registerUi.ts");
	const at = register.indexOf('registerObsidianProtocolHandler("yaos"');
	const body = register.slice(at, register.indexOf("\n\t});", at));
	assert.match(body, /routeSetupLink\(parseSetupLink\(params\), host\.data\(\), host\.status\(\)\)/);
	assert.deepEqual([...body.matchAll(/\b(new Notice|openPair|applyLink)\(/g)].map((m) => m[1]), ["new Notice", "openPair", "applyLink"], "three routes, nothing else");
	assert.doesNotMatch(body, /[Cc]reat|enableE2ee|markCreating|pinSuite0/, "the handler touches no creation flow");
	const between = (from: string, to: string): string => register.slice(register.indexOf(from), register.indexOf(to));
	assert.doesNotMatch(between("const applyLink = ", "const openPair = "), /[Cc]reat|markCreating/);
	assert.doesNotMatch(between("const openPair = ", "const openCreateVault = "), /[Cc]reat|markCreating/);
	assert.deepEqual(pinCensus().markCreating, { "host/plugin.ts": 1, "host/ui/createVault.ts": 1 }, "markCreating: main's wiring and createVault.ts step 1 only");

	const n = SEEDS.length;
	const nNot = n * NOT_EMPTY.length;
	const nOther = n * 3;
	assert.deepEqual(tallyObj(t.flags), {
		"not-empty: creatable statuses=0": nNot, "other-vault marker: creatable statuses=0": nOther, "other-vault marker: kept=true": n * 2,
		"other-vault marker: kept=false": n, "UI writes: creatable statuses=0": n, "control: creatable": n,
	}, "creatable never true except the control; the marker for another vault is dropped on pairing into this one, else ignored");
	assert.deepEqual(tallyObj(t.outcomes), {
		"not-empty: enableE2ee=engine:refused": nNot, "not-empty: pinSuite0 create=engine:refused": nNot, "not-empty: rk zero-filled=true": nNot,
		"other-vault marker: enableE2ee=refused:not-creating": nOther, "other-vault marker: pinSuite0 create=refused:not-creating": nOther, "other-vault marker: rk zero-filled=true": nOther,
		"UI writes: enableE2ee=refused:not-creating": n, "UI writes: pinSuite0 create=refused:not-creating": n, "UI writes: rk zero-filled=true": n,
	});
	assert.deepEqual(tallyObj(t.pins), {
		"not-empty: null": nNot - n, [`not-empty: ${fp({ suite: null, keyringSeen: true })}`]: n,
		"other-vault marker: null": nOther, "UI write dropped=true": n * 4,
	}, "no pin (the visible genesis records keyringSeen; a garbage k row is not a genesis)");
	assert.deepEqual(tallyObj(t.writes), ZERO_WRITES);
	assert.deepEqual(tallyObj(t.links), {
		// 9 device states x 19 links (13 hostile, 3 key-less, suite=0, key, re-key).
		"route hostile=ignore": 13 * 9,
		"route key-less=ignore": 3 * 4, "route key-less=pair": 3 * 5,
		"route suite=0=apply": 4, "route suite=0=pair": 5,
		"route key=apply": 4, "route key=pair": 5,
		"route rekey=apply": 7, "route rekey=ignore": 2,
		"route differs from §12.4": 0,
		"data changed by routing": 0,
		// Pair routes (25): what PairingSession sends and persists, even handed the whole route.
		"pair: identity=ok enroll body=deviceId,deviceName,deviceToken,enrollmentRequestId,pairingCode attempt=deviceId,deviceName,deviceToken,enrollmentRequestId,host,pairingCode key or suite on the wire=false": 25,
		// Apply routes (15): applyLinkE2ee on the device's own vault.
		"apply suite=0: sent=pinSuite0:link outcome=suite0 other host calls=none": 4,
		"apply key: sent=installKey:qr outcome=pending other host calls=none": 3,
		"apply key: sent=installKey:qr outcome=verified other host calls=none": 1,
		"apply rekey: sent=installKey:qr outcome=pending other host calls=none": 5,
		// "same vault, revoked" and "suite 1": the fake reports the suite-1 pin with nothing missing.
		"apply rekey: sent=installKey:qr outcome=verified other host calls=none": 2,
		"apply: key sent is the link's=true, link key zero-filled=true": 4 + 7,
	}, "no link reaches creation: every link is ignored, joins a vault, or hands over its key");
});

/** Device states for the link matrix: [name, data, status]. Same vault = paired with SIM_VAULT_ID at HOST, not revoked. */
function linkDeviceStates(): [string, YaosPluginData, StatusSnapshot | null, boolean][] {
	const paired = pairedData();
	const id = paired.identity!;
	return [
		["unpaired", defaultPluginData("J"), null, false],
		["unpaired, marker", { ...defaultPluginData("J"), creating: { vaultId: SIM_VAULT_ID } }, null, false],
		["same vault, key-missing", paired, snapshot("key-missing"), true],
		["same vault, revoked", pairedData(J_ID, { e2ee: { suite: 1 } }), snapshot("revoked", { suite: 1, sealEpoch: 1, keyMissing: null }), false],
		["other vault", { ...paired, identity: { ...id, vaultId: OTHER_VAULT } }, snapshot("key-missing"), false],
		["other host", { ...paired, identity: { ...id, host: "https://other.example" } }, snapshot("key-missing"), false],
		["creating marker", pairedData(J_ID, { creating: { vaultId: SIM_VAULT_ID } }), snapshot("key-missing", { creatable: true }), true],
		["keyringSeen", pairedData(J_ID, { e2ee: { suite: null, keyringSeen: true } }), snapshot("key-missing", { keyMissing: "encrypted-vault", keyringSeen: true }), true],
		["suite 1", pairedData(J_ID, { e2ee: { suite: 1 } }), snapshot("live", { suite: 1, sealEpoch: 1, keyMissing: null }), true],
	];
}

/** e (4): every link class x device state through routeSetupLink, then the pair or apply flow it leads to. */
async function linkMatrix(out: Map<string, number>): Promise<void> {
	const rng = new SeededRandom(77);
	const code = `${SIM_VAULT_ID}.${base64Url(rng.bytes(24))}`;
	const base = { action: "setup", host: HOST, pairingCode: code };
	const key = K(1);
	const keyParam = encodeKeyParam({ e: 1, k: key.slice() });
	const secrets = [keyParam, base64Url(key)];
	const links: ["hostile" | "key-less" | "suite=0" | "key" | "rekey", Record<string, string>][] = [
		...[
			{ ...base, action: "create" }, { ...base, action: "claim" }, { ...base, action: "new-vault" }, { ...base, action: "enable-e2ee" },
			{ ...base, create: "1" }, { ...base, creating: SIM_VAULT_ID }, { ...base, vaultId: SIM_VAULT_ID }, { ...base, e2ee: "1" },
			{ ...base, suite: "1" }, { ...base, key: "AAAA" }, { ...base, rk: "AAAA" }, { ...base, deviceToken: "x" }, { ...base, operatorKey: "x" },
		].map((l) => ["hostile", l] as ["hostile", Record<string, string>]),
		["key-less", base], ["key-less", { ...base, action: "yaos" }], ["key-less", { ...base, vault: "My vault" }],
		["suite=0", { ...base, suite: "0" }],
		["key", { ...base, key: keyParam }],
		["rekey", protocolParams(buildRekeyLink({ e: 1, k: key.slice() }))],
	];
	for (const [state, data, snap, sameVault] of linkDeviceStates()) {
		for (const [cls, params] of links) {
			const before = fp(data);
			const route = routeSetupLink(parseSetupLink(params), data, snap);
			count(out, `route ${cls}=${route.kind}`);
			const want = cls === "hostile" ? "ignore" : cls === "rekey" ? (data.identity ? "apply" : "ignore") : sameVault ? (cls === "key-less" ? "ignore" : "apply") : "pair";
			out.set("route differs from §12.4", (out.get("route differs from §12.4") ?? 0) + (route.kind === want ? 0 : 1));
			out.set("data changed by routing", (out.get("data changed by routing") ?? 0) + (fp(data) === before ? 0 : 1));
			if (route.kind === "pair") {
				// PairModal.submit sends {host, pairingCode, deviceName} (pairModal.ts:177); hand PairingSession the whole
				// route anyway: the key must not reach /enroll or the persisted attempt.
				const requests: HttpRequest[] = [];
				const attempts: EnrollmentAttempt[] = [];
				const session = new PairingSession({
					request: (req) => (requests.push(req), hostileServer(new Map())(req)),
					randomBytes: (k) => rng.bytes(k),
					persist: async (a) => void (a && attempts.push(a)),
				});
				const r = await session.submit({ ...route, deviceName: "Joiner" }).then(() => "ok", () => "failed");
				const enroll = requests.find((q) => q.url.endsWith("/enroll"));
				const bodyKeys = Object.keys(JSON.parse(enroll?.body ?? "{}") as object).sort().join(",");
				const wire = requests.map((q) => `${q.url}\n${q.body ?? ""}`).join("\n");
				const leaked = secrets.some((x) => wire.includes(x)) || /[?&](key|suite)=/.test(wire) || /"(key|suite|e2ee)"/.test(wire);
				count(out, `pair: identity=${r} enroll body=${bodyKeys} attempt=${attempts.map((x) => Object.keys(x).sort().join(",")).join("|")} key or suite on the wire=${leaked}`);
				if (route.e2ee?.suite === 1) route.e2ee.key.k.fill(0);
			} else if (route.kind === "apply") {
				const clock = newClock();
				const host = new FakeUiHost(data);
				host.snap = snap;
				const linkKey = route.e2ee.suite === 1 ? route.e2ee.key.k : null;
				// As registerUi.ts applyLink: the device's own vault.
				const r = await settleOn(clock, applyLinkE2ee(host, host.data().identity?.vaultId ?? "", route.e2ee, simOpts(clock)));
				const sent = host.commands.map((c) => (c.t === "pinSuite0" ? `pinSuite0:${c.source}` : c.t === "installKey" ? `installKey:${c.source}` : c.t)).join(",");
				const other = host.calls.filter((c) => !c.startsWith("command:")).join(",") || "none";
				count(out, `apply ${cls}: sent=${sent} outcome=${r.ok ? String(r.value) : "rejected"} other host calls=${other}`);
				if (linkKey) {
					const c = host.commands[0];
					const same = c?.t === "installKey" && c.source === "qr" && c.e === 1 && bytesToHex(c.k) === bytesToHex(key);
					count(out, `apply: key sent is the link's=${same}, link key zero-filled=${noBytes(linkKey)}`);
				}
			}
		}
	}
	key.fill(0);
}

// --- f. an unverified key ------------------------------------------------------------------------------------

interface KeyCase {
	readonly name: string;
	/** k on the relay: nothing, records visible to the device, or records hidden from it. */
	readonly k: () => Promise<{ readonly records: readonly Uint8Array[]; readonly hidden: boolean }>;
	readonly key: () => UserCommand & { t: "installKey" };
	/** The case has a matching record behind the hiding: unhiding it must pin suite 1 (the control). */
	readonly control?: boolean;
}

const KEY_CASES: readonly KeyCase[] = [
	{ name: "qr, empty k", k: async () => ({ records: [], hidden: false }), key: () => ({ t: "installKey", source: "qr", e: 1, k: K(1).slice() }) },
	{ name: "qr, genuine genesis hidden", k: async () => ({ records: [await genesisFor(SIM_VAULT_ID)], hidden: true }), key: () => ({ t: "installKey", source: "qr", e: 1, k: K(1).slice() }), control: true },
	{ name: "qr, garbage k row", k: async () => ({ records: [new SeededRandom(3).bytes(200)], hidden: false }), key: () => ({ t: "installKey", source: "qr", e: 1, k: K(1).slice() }) },
	{ name: "qr, genesis for another vault", k: async () => ({ records: [await genesisFor(OTHER_VAULT)], hidden: false }), key: () => ({ t: "installKey", source: "qr", e: 1, k: K(1).slice() }) },
	{ name: "qr, other key for the genesis epoch", k: async () => ({ records: [await genesisFor(SIM_VAULT_ID)], hidden: false }), key: () => ({ t: "installKey", source: "qr", e: 1, k: K(2).slice() }) },
	{ name: "qr, epoch with no record", k: async () => ({ records: [await genesisFor(SIM_VAULT_ID)], hidden: false }), key: () => ({ t: "installKey", source: "qr", e: 2, k: K(2).slice() }) },
	{ name: "qr, forged genesis (attacker RK and key)", k: async () => ({ records: [await genesisFor(SIM_VAULT_ID, RK_B, FORGED(1))], hidden: false }), key: () => ({ t: "installKey", source: "qr", e: 1, k: K(1).slice() }) },
	{ name: "rk, other recovery key", k: async () => ({ records: [await genesisFor(SIM_VAULT_ID)], hidden: false }), key: () => ({ t: "installKey", source: "rk", rk: RK_B.slice() }) },
	{ name: "rk, genuine genesis hidden", k: async () => ({ records: [await genesisFor(SIM_VAULT_ID)], hidden: true }), key: () => ({ t: "installKey", source: "rk", rk: RK_A.slice() }), control: true },
];

test("f. unverified key: a QR key (or RK) with no matching k record leaves the device unpinned and persists nothing", async () => {
	const t = { outcomes: new Map<string, number>(), state: new Map<string, number>(), writes: new Map<string, number>(), control: new Map<string, number>() };
	for (const seed of SEEDS) for (const kc of KEY_CASES) for (const restart of [false, true]) {
		const clock = newClock();
		const net = new SimNet(clock, { seed: seed * 53 + KEY_CASES.indexOf(kc) * 2 + (restart ? 1 : 0), linkMs: 10 });
		const k = await kc.k();
		for (const r of k.records) await peerAppends(clock, net, "G", KEYRING_STREAM, r);
		if (k.hidden) net.relay.hideFrom(J_ID, KEYRING_STREAM);
		const w = controllerWorld(clock, net, pairedData());
		w.dev.vault.userWrite("mine.md", "local\n");
		const since = { ...relayState(net), appends: net.relay.counters().appendFrames };
		void w.ctl.start();
		assert.ok(await clock.runUntil(() => w.ctl.status()?.phase === "key-missing" && w.ctl.status()?.relay.connected === true, 60_000), kc.name);
		await clock.advance(2_000);
		const cmd = kc.key();
		const buf = cmd.source === "qr" ? cmd.k : cmd.rk;
		count(t.outcomes, `${kc.name}=${await outcome(clock, w.ctl.command(cmd))}`);
		count(t.outcomes, `key bytes left on main=${!noBytes(buf)}`);
		w.dev.vault.userWrite("typed.md", "typed\n");
		await clock.advance(5_000);
		if (restart) {
			await settleOn(clock, w.ctl.restartEngine());
			assert.ok(await clock.runUntil(() => w.ctl.status()?.phase === "key-missing" && w.ctl.status()?.relay.connected === true, 60_000));
			await clock.advance(2_000);
		}
		const s = w.ctl.status();
		count(t.state, `${s?.phase}/suite=${s?.e2ee?.suite}/pin=${w.ctl.data().e2ee?.suite ?? "none"}`);
		for (const d of w.saved) if (d.e2ee?.suite === 0 || d.e2ee?.suite === 1) count(t.state, "saved suite pin");
		sumInto(t.writes, await writesOf(net, w, [J_ID], since));
		// Control: the same device sees the matching record once the server stops hiding it. Without a restart the
		// pending key verifies and pins suite 1 (so "nothing persisted" above was the missing record, not a broken
		// path); after a restart the pending key is gone, because it was never persisted.
		if (kc.control) {
			net.relay.unhideFrom(J_ID, KEYRING_STREAM);
			net.relay.dropSession(J_ID);
			await clock.runUntil(() => w.ctl.data().e2ee?.suite === 1, 30_000);
			await clock.advance(2_000);
			count(t.control, `${restart ? "after restart" : "same engine"}: pin=${w.ctl.data().e2ee?.suite ?? "none"} keyStored=${w.dev.secrets.writes > 0}`);
		}
		await settleOn(clock, w.ctl.stop());
	}
	const n = SEEDS.length * 2;
	const qrCases = KEY_CASES.length;
	assert.deepEqual(tallyObj(t.outcomes), {
		"qr, empty k=ok": n, "qr, genuine genesis hidden=ok": n, "qr, garbage k row=ok": n, "qr, genesis for another vault=ok": n,
		"qr, other key for the genesis epoch=ok": n, "qr, epoch with no record=ok": n, "qr, forged genesis (attacker RK and key)=ok": n,
		"rk, other recovery key=ok": n, "rk, genuine genesis hidden=ok": n,
		"key bytes left on main=false": qrCases * n,
	}, "every key is held pending, unverified: \"conflict\" is only against a verified key (webCryptoSuite1.ts:167); a record whose kcv does not match the QR key is judged invalid (evaluate.ts:72-75). Main never keeps the key bytes");
	assert.deepEqual(tallyObj(t.state), { "key-missing/suite=null/pin=none": qrCases * n }, "every case stays unpinned and blocked");
	assert.deepEqual(tallyObj(t.writes), ZERO_WRITES, "SecretStorage writes 0, nothing held, nothing written");
	assert.deepEqual(tallyObj(t.control), { "same engine: pin=1 keyStored=true": 2 * SEEDS.length, "after restart: pin=none keyStored=false": 2 * SEEDS.length });
});

// --- g. a suite-0 device that sees a k genesis ----------------------------------------------------------------

interface SealTally {
	total: number;
	/** Seals that reached the raw port while the write gate was shut (a bypass of writeGate.ts). */
	whileShut: number;
	/** Seals after this device first reported "encrypted-vault" (sticky across restarts and wipes). */
	afterSeen: number;
	/** Seals after the genesis was on the relay but before the device had read it. */
	beforeSeen: number;
	beforeGenesis: number;
	seen: boolean;
	genesisOnRelay: boolean;
}

/** Wraps the seal and sealBlob of the device's raw crypto port (behind gatedCrypto, runtime/context.ts:129) once per engine. */
function tapSeals(d: SimDevice, t: SealTally, tapped: WeakSet<object>): void {
	const c = d.vrt?.log.c;
	if (!c) return;
	const port = c.gateCtx.crypto as CryptoPort;
	if (tapped.has(port)) return;
	tapped.add(port);
	const note = (): void => {
		t.total++;
		if (c.gate() !== null) t.whileShut++;
		if (c.keyring?.keyMissing() === "encrypted-vault") t.seen = true;
		if (t.seen) t.afterSeen++;
		else if (t.genesisOnRelay) t.beforeSeen++;
		else t.beforeGenesis++;
	};
	const seal = port.seal.bind(port);
	const sealBlob = port.sealBlob.bind(port);
	(port as { seal: CryptoPort["seal"] }).seal = async (input) => (note(), seal(input));
	(port as { sealBlob: CryptoPort["sealBlob"] }).sealBlob = async (input) => (note(), sealBlob(input));
}

const G_CASES = ["live, typing through the genesis", "offline, genesis, reconnect", "offline edits, genesis, reconnect", "restart after the genesis", "wipe and restart after the genesis", "fresh suite-0 device, genesis already there"] as const;

test("g. a suite-0 device that sees a k genesis stops with encrypted-vault and issues no seal", async () => {
	const t = { cases: 0, finals: new Map<string, number>(), seals: new Map<string, number>(), rows: new Map<string, number>() };
	for (const seed of SEEDS) for (const gc of G_CASES) {
		const clock = newClock();
		const net = new SimNet(clock, { seed: seed * 59 + G_CASES.indexOf(gc), linkMs: 10, jitterMs: 5 });
		const tally: SealTally = { total: 0, whileShut: 0, afterSeen: 0, beforeSeen: 0, beforeGenesis: 0, seen: false, genesisOnRelay: false };
		const tapped = new WeakSet<object>();
		const fresh = gc === "fresh suite-0 device, genesis already there";
		const writer = new SimDevice({ name: fresh ? "W" : "A", clock, net }); // suite-0 fixture pin
		writer.vault.userWrite("notes/a.md", "a\n");
		void writer.start();
		assert.ok(await clock.runUntil(() => isLive(writer) && writer.vrt?.log.isIdle() === true && net.relay.rows(NS_STREAM).length > 0, 60_000), "suite-0 vault live");
		const d = fresh ? new SimDevice({ name: "A", clock, net }) : writer;
		if (fresh) writer.crashApp();
		const drive = async (ms: number, until?: () => boolean): Promise<boolean> =>
			clock.runUntil(() => {
				tapSeals(d, tally, tapped);
				if (keyMissing(d) === "encrypted-vault") tally.seen = true;
				return until?.() ?? false;
			}, ms);
		let typed = 0;
		const type = (): void => d.vault.userWrite(`typed/${typed++}.md`, `typed ${typed}\n`);
		// G connects first; the genesis is appended between two clock steps, and from that call on a seal counts as
		// "after the genesis landed" (conservative: it reaches the relay one link later).
		const genesisBytes = await genesisFor(SIM_VAULT_ID);
		const peer = await connectPeer(net.relay, clock, "dev-G");
		const appendGenesis = (): void => {
			peer.session.append(frame(KEYRING_STREAM, "g-genesis", genesisBytes));
			tally.genesisOnRelay = true;
		};
		switch (gc) {
			case "live, typing through the genesis": {
				await drive(2_000);
				for (let i = 0; i < 6; i++) (type(), await drive(300));
				appendGenesis();
				for (let i = 0; i < 20; i++) (type(), await drive(i < 10 ? 7 : 250)); // edits inside the link delay too
				break;
			}
			case "offline, genesis, reconnect":
			case "offline edits, genesis, reconnect":
				await drive(2_000);
				d.setOnline(false);
				await drive(1_000);
				if (gc === "offline edits, genesis, reconnect") for (let i = 0; i < 5; i++) (type(), await drive(500));
				appendGenesis();
				await drive(1_000);
				d.setOnline(true);
				for (let i = 0; i < 10; i++) (type(), await drive(400));
				break;
			case "restart after the genesis":
			case "wipe and restart after the genesis":
				await drive(2_000);
				appendGenesis();
				assert.ok(await drive(60_000, () => tally.seen), "saw the genesis before the restart");
				if (gc === "restart after the genesis") await settleOn(clock, d.runtime.stop());
				d.crashApp({ wipe: gc === "wipe and restart after the genesis" });
				await drive(1_000);
				type();
				void d.restartApp();
				for (let i = 0; i < 10; i++) (type(), await drive(400));
				break;
			case "fresh suite-0 device, genesis already there":
				appendGenesis();
				await drive(1_000);
				d.vault.userWrite("mine.md", "local\n");
				void d.start();
				for (let i = 0; i < 10; i++) (type(), await drive(400));
				break;
		}
		assert.ok(await drive(60_000, () => tally.seen && keyMissing(d) === "encrypted-vault"), `${gc}: encrypted-vault`);
		const seenSeq = net.relay.head();
		const genesisSeq = net.relay.rows(KEYRING_STREAM)[0]!.seq;
		for (let i = 0; i < 10; i++) (type(), await drive(500));
		d.platform.emit("visible");
		await drive(10_000);
		count(t.finals, `${lastStatus(d)?.phase}/${keyMissing(d)}/suite=${e2eeOf(d)?.suite}`);
		count(t.finals, `k rows=${net.relay.rows(KEYRING_STREAM).length}`);
		sumInto(t.seals, { whileShut: tally.whileShut, afterSeen: tally.afterSeen });
		sumInto(t.rows, {
			"rows by A after it reported encrypted-vault": rowsBy(net, d.deviceId, seenSeq),
			"k rows by A": net.relay.rows(KEYRING_STREAM).filter((r) => r.deviceId === d.deviceId).length,
		});
		count(t.rows, `${gc}: seals before the genesis=${tally.beforeGenesis > 0 ? "some" : 0}, rows by A after the genesis=${rowsBy(net, d.deviceId, genesisSeq) > 0 ? "some" : 0}, sealed in the link delay=${tally.beforeSeen > 0 ? "some" : 0}`);
		await settleOn(clock, d.runtime.stop());
		t.cases++;
	}
	const n = SEEDS.length * G_CASES.length;
	assert.equal(t.cases, n);
	assert.deepEqual(tallyObj(t.finals), { "key-missing/encrypted-vault/suite=0": n, "k rows=1": n });
	assert.deepEqual(tallyObj(t.seals), { whileShut: 0, afterSeen: 0 });
	const per = (gc: (typeof G_CASES)[number], before: 0 | "some", after: 0 | "some", delay: 0 | "some"): [string, number] => [
		`${gc}: seals before the genesis=${before}, rows by A after the genesis=${after}, sealed in the link delay=${delay}`,
		SEEDS.length,
	];
	assert.deepEqual(tallyObj(t.rows), {
		"rows by A after it reported encrypted-vault": 0,
		"k rows by A": 0,
		// Only the live case commits rows after the genesis: frames it sealed before reading it (in the link delay).
		...Object.fromEntries([
			per("live, typing through the genesis", "some", "some", "some"),
			per("offline, genesis, reconnect", 0, 0, 0),
			per("offline edits, genesis, reconnect", "some", 0, 0),
			per("restart after the genesis", 0, 0, 0),
			per("wipe and restart after the genesis", 0, 0, 0),
			per("fresh suite-0 device, genesis already there", 0, 0, 0),
		]),
	});
	console.log(`[g] cases=${n} final=key-missing/encrypted-vault x${n}; seals after encrypted-vault=0, through a shut gate=0; rows by A after encrypted-vault=0; k rows by A=0`);
});

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The shipped sources: src/{core,engine,host,ports,protocol}, without tests, testkits or the spike. */
function shippedFiles(): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name !== "testkit" && e.name !== "spike") walk(p);
			} else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(p);
		}
	};
	for (const d of ["core", "engine", "host", "ports", "protocol"]) walk(join(SRC_ROOT, d));
	assert.ok(files.length > 100, "walked the sources");
	return files;
}

const srcPath = (f: string): string => relative(SRC_ROOT, f).split(sep).join("/");

/** A shipped file's source with comments stripped. */
function shippedSource(rel: string): string {
	return stripComments(readFileSync(join(SRC_ROOT, rel), "utf8"));
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** For each target (src-relative), the shipped files that import it (static, dynamic or re-export), sorted. */
function importersOf(targets: readonly string[]): Record<string, string[]> {
	const out: Record<string, string[]> = Object.fromEntries(targets.map((t) => [t, [] as string[]]));
	for (const f of shippedFiles()) {
		const src = stripComments(readFileSync(f, "utf8"));
		for (const m of src.matchAll(/\b(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
			const spec = m[1] ?? "";
			const r = srcPath(resolve(dirname(f), spec.endsWith(".ts") ? spec : `${spec}.ts`));
			const list = out[r];
			if (list && !list.includes(srcPath(f))) list.push(srcPath(f));
		}
	}
	for (const list of Object.values(out)) list.sort();
	return out;
}

/** WaitOptions/RetryOptions on the virtual clock, as a UI flow under test needs them. */
function simOpts(clock: VirtualClock): { now: () => number; sleep: (ms: number) => Promise<void>; setTimer: (ms: number, fn: () => void) => unknown; clearTimer: (h: unknown) => void } {
	return { now: () => clock.now(), sleep: (ms) => clock.sleep(ms), setTimer: (ms, fn) => clock.setTimer(ms, fn), clearTimer: (h) => clock.clearTimer(h as number) };
}

/** Pin setters, pin-shaped writes, data.json saves and key commands in the shipped sources, by file. */
function pinCensus(): Record<string, Record<string, number>> {
	const files = shippedFiles();
	const out: Record<string, Record<string, number>> = {};
	const add = (k: string, f: string): void => {
		const r = srcPath(f);
		const m = (out[k] ??= {});
		m[r] = (m[r] ?? 0) + 1;
	};
	for (const f of files) {
		const src = stripComments(readFileSync(f, "utf8"));
		for (const m of src.matchAll(/(?<![.\w])(pinnedSuite0|pinnedSuite1|sawKeyring|markedCreating|withoutPin|withPin)\s*\(/g)) {
			const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
			if (!/\bfunction\s/.test(line)) add(`call:${m[1]}`, f);
		}
		for (const _ of src.matchAll(/\be2ee\s*:\s*(pin\b|\{)/g)) add("e2ee-write", f);
		for (const _ of src.matchAll(/\bcreating\s*:\s*\{/g)) add("creating-write", f);
		for (const _ of src.matchAll(/\.saveData\(/g)) add("saveData", f);
		for (const _ of src.matchAll(/\.markCreating\(/g)) add("markCreating", f);
		for (const m of src.matchAll(/\bt:\s*"(pinSuite0|enableE2ee|installKey|revokeRekey)"\s*,/g)) add(`command:${m[1]}`, f);
		for (const _ of src.matchAll(/source:\s*"link"\s*[,}]/g)) add("source-link", f);
	}
	return out;
}
