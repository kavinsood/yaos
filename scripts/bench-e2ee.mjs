#!/usr/bin/env node
/**
 * bench-e2ee.mjs — WP-E7 performance bench of crypto suite 1 against docs/client-remake/e2ee-design.md §16.2.
 *
 * Usage (from the repo root; jiti lets this .mjs import the TypeScript sources under src/):
 *   node --import jiti/register scripts/bench-e2ee.mjs            full run (~40 s)
 *   node --import jiti/register scripts/bench-e2ee.mjs --quick    fewer repetitions
 *   ... --no-bundle                                               skip the esbuild bundle section
 *
 * Exit 1, with a "BUDGET MISSED" line, if any desktop MUST budget is missed. Mobile budgets are printed for
 * reference only: §16.1 assumes mobile is 10x worse, and it cannot be measured here.
 *
 * Every number runs the real code paths over real Node WebCrypto (crypto.subtle) with the production RandomPort
 * (crypto.getRandomValues): sealFrame / sealCheckpoint / openEnvelope (src/engine/ingest/envelope.ts) with
 * realistic AAD bindings, CryptoPort.blobAddress / sealBlob / openBlob, createWebCryptoSuite1 and Keyring.open.
 * Keys are fixed fake byte patterns, never printed. Each path is warmed up, then repeated; the table shows the
 * median and the p95 (nearest rank: with 20 or fewer repetitions that is the maximum) of performance.now() deltas.
 *
 * What each row includes:
 * - typing: one sealFrame of a keystroke-sized bodyUpdate (32 B Yjs update) = inner encode, Padmé pad to 256 B,
 *   frame AAD, 12-byte nonce, AES-256-GCM seal, outer encode. "after idle" waits OPEN_FRAME_IDLE_MS before each
 *   frame, as typing produces them: that is the MUST (<= 1 ms, 1% of the frame interval). It is shown next to two
 *   baselines that need no YAOS code. "steady state" (back-to-back) is the per-call crypto cost, information only.
 * - bootstrap: openEnvelope (header decode, AAD, AES-GCM open, unpad, inner decode, kind check) of every row a
 *   fresh device reads. Content is incompressible, so no inflate (not crypto, and suite 0 pays it too). Only the
 *   opens are timed; the seal-side setup is not. The engine pattern (see benchBootstrap) is the budgeted number.
 * - blob up: blobAddress (1 HMAC) + sealBlob (Padmé copy, AES-GCM seal; the parts [header ‖ nonce, ciphertext]) of the largest suite-1
 *   blob, MAX_BLOB_PLAINTEXT_BYTES_SUITE1 (§7.3: a full 10 MiB plaintext exceeds the suite-1 cap). sha256 of the
 *   plaintext is excluded ("already done today", §16.1).
 * - blob down: openBlob (header decode, AES-GCM open, unpad). The sha256 check after it is excluded likewise.
 * - engine start: createWebCryptoSuite1 with N held epochs (N HKDF imports), Keyring.open twice as the engine
 *   does (pinGate.ts keyed(), then KeyringRuntime.open: the kcv of every epoch, N deriveKey + HMACs), then the
 *   first use of the other six session subkeys (kFrame, kCkpt, kBlob, kWrap of the seal epoch; kAddr, kDiag of
 *   K_1), each through one small real operation. N = 1 gives the 7 deriveKey of §5.1 / §16.1.
 */

import { gzipSync } from "node:zlib";
import { builtinModules } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const QUICK = process.argv.includes("--quick");
const NO_BUNDLE = process.argv.includes("--no-bundle");

/** jiti/register exposes a TS module's named exports under `default` when imported from an .mjs. */
async function load(rel) {
	const m = await import(join(ROOT, rel));
	return Object.keys(m).length === 1 && "default" in m ? m.default : m;
}

const { createWebCryptoSuite1 } = await load("src/engine/adapters/webCryptoSuite1.ts");
const { createWebRandom } = await load("src/engine/adapters/webRandom.ts");
const { createWebHash } = await load("src/engine/adapters/webHash.ts");
const { sealFrame, sealCheckpoint, openEnvelope } = await load("src/engine/ingest/envelope.ts");
const { Keyring } = await load("src/engine/keyring/keyring.ts");
const { buildKeyRecord } = await load("src/engine/keyring/build.ts");
const { KeyRecordKind } = await load("src/engine/keyring/record.ts");
const { newId } = await load("src/core/codec/ids.ts");
const { bytesToHex } = await load("src/core/codec/lib0.ts");
const { bodyStream } = await load("src/core/types.ts");
const { padmeLen } = await load("src/core/codec/padme.ts");
const { OPEN_FRAME_IDLE_MS, MAX_BLOB_PLAINTEXT_BYTES_SUITE1, BUDGETS } = await load("src/core/limits.ts");
const { DEFAULT_RELAY_LIMITS } = await load("src/engine/adapters/wsRelay.ts");
const { DEFAULT_TUNING } = await load("src/engine/runtime/options.ts");

// ---- fixtures (fake keys: fixed byte patterns, never printed) -----------------------------------------------

const random = createWebRandom();
const VAULT = newId(random);
const SELF = newId(random);
const PEERS = [newId(random), newId(random), newId(random)];
const fakeKey = (e) => Uint8Array.from({ length: 32 }, (_, i) => (e * 0x31 + i * 7 + 0x5a) & 0xff);
const FAKE_RK = Uint8Array.from({ length: 35 }, (_, i) => (0xa5 + i * 3) & 0xff);
const keysFor = (n) => Array.from({ length: n }, (_, i) => ({ e: i + 1, k: fakeKey(i + 1) })); // fresh copies: put() zero-fills them
const randomBytes = (n) => random.bytes(n);

/** A suite-1 port holding K_1..K_n, verified, sealing under K_n (what a running engine holds). */
async function readyCrypto(n) {
	const kc = await createWebCryptoSuite1({ vaultId: VAULT, random, keys: keysFor(n) });
	for (let e = 1; e <= n; e++) kc.markVerified(e);
	kc.setSealEpoch(n);
	return kc;
}

/** Winning k records for epochs 1..n (genesis, then rolls), built by the real adapter and buildKeyRecord. */
async function buildRecords(n) {
	const author = await createWebCryptoSuite1({ vaultId: VAULT, random, keys: keysFor(n) }); // seal epoch 0: raw keys retained
	const out = [await buildKeyRecord(author, VAULT, 1, KeyRecordKind.genesis, FAKE_RK.slice())];
	for (let e = 2; e <= n; e++) out.push(await buildKeyRecord(author, VAULT, e, KeyRecordKind.roll));
	return out;
}

// ---- timing --------------------------------------------------------------------------------------------------

const now = () => performance.now();
function stats(samples) {
	const s = [...samples].sort((a, b) => a - b);
	const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
	return { median: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2, p95: at(0.95), n: s.length };
}
async function repeat(warm, reps, fn) {
	for (let i = 0; i < warm; i++) await fn(i);
	const out = [];
	for (let i = 0; i < reps; i++) {
		const t = now();
		await fn(warm + i);
		out.push(now() - t);
	}
	return out;
}
const R = QUICK
	? { typingWarm: 200, typing: 500, spaced: 12, bootWarm: 1, boot: 2, blobWarm: 3, blob: 10, startWarm: 3, start: 15 }
	: { typingWarm: 500, typing: 3000, spaced: 40, bootWarm: 1, boot: 5, blobWarm: 5, blob: 30, startWarm: 5, start: 60 };

const rows = [];
/** must: a desktop MUST budget (§16.2); counts for the exit code. */
function row(path, st, budgetMs, mobile, must, note = "") {
	rows.push({ path, median: st.median, p95: st.p95, n: st.n, budgetMs, mobile, must, note, pass: budgetMs === null ? null : st.median <= budgetMs });
}
const log = (s) => process.stdout.write(`${s}\n`);

// ---- typing (§16.2: one frame per OPEN_FRAME_IDLE_MS, <= 1 ms after idle) -----------------------------------

/**
 * The MUST is the wall time of one seal after OPEN_FRAME_IDLE_MS of idle, as a typist produces frames: <= 1 ms, 1% of
 * the 100 ms frame interval (§16.2). It includes the CPU and WebCrypto worker wake-up: a bare subtle.encrypt of 256 B
 * after 100 ms idle alone takes 0.25-0.38 ms on the reference machine, so the former 0.05 ms could not be met by any
 * implementation. The steady-state (back-to-back) per-call cost is printed against 0.05 ms as information.
 */
const TYPING_IDLE_BUDGET_MS = 1;
const TYPING_STEADY_INFO_MS = 0.05;

/** One sample per OPEN_FRAME_IDLE_MS: sleep, then time fn once. */
async function spacedSamples(n, fn) {
	const out = [];
	for (let i = 0; i < n; i++) {
		await sleep(OPEN_FRAME_IDLE_MS);
		const t = now();
		await fn(i);
		out.push(now() - t);
	}
	return out;
}

async function benchTyping() {
	const crypto = await readyCrypto(1);
	const stream = bodyStream(newId(random));
	const content = randomBytes(32);
	const frame = (cfid) => ({ stream, deviceId: SELF, clientFrameId: cfid, kind: "bodyUpdate", authorNsSeq: 4242, flags: 0, frameNo: 0, content });
	const total = R.typingWarm + R.typing;
	const ids = Array.from({ length: total }, () => newId(random));
	const sealed = new Array(total);
	const seal = async (i) => { sealed[i] = (await sealFrame(crypto, VAULT, frame(ids[i]))).sealed; };
	const b2b = await repeat(R.typingWarm, R.typing, seal);
	// After idle: one frame per OPEN_FRAME_IDLE_MS, as typing produces them. The CPU, its caches and the WebCrypto
	// worker thread have idled for 100 ms, so this is wake-up latency more than crypto cost; the two baselines below
	// (bare subtle.encrypt, and a crypto-free JS loop) measure the same idle effect without any YAOS code.
	const spacedIds = Array.from({ length: R.spaced }, () => newId(random));
	const spaced = await spacedSamples(R.spaced, (i) => sealFrame(crypto, VAULT, frame(spacedIds[i])));
	const aes = await globalThis.crypto.subtle.importKey("raw", fakeKey(99), "AES-GCM", false, ["encrypt"]);
	const pt = randomBytes(padmeLen(1));
	const aad = randomBytes(64);
	const bare = () => globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: random.bytes(12), additionalData: aad }, aes, pt);
	const bareHot = await repeat(R.typingWarm, R.typing, bare);
	const bareSpaced = await spacedSamples(R.spaced, bare);
	let sink = 0;
	const jsLoop = async () => { for (let j = 0; j < 2000; j++) sink = (sink + j * 31) ^ (sink >>> 3); };
	const jsHot = await repeat(R.typingWarm, R.typing, jsLoop);
	const jsSpaced = await spacedSamples(R.spaced, jsLoop);
	if (sink === 0.5) log("");
	// Receiver side: openEnvelope of the same frames (info).
	const open = await repeat(R.typingWarm, R.typing, async (i) => {
		const r = await openEnvelope(crypto, VAULT, { t: "frame", stream, deviceId: SELF, clientFrameId: ids[i] }, sealed[i]);
		if (!r.ok) throw new Error(`typing open failed: ${r.reason}`);
	});
	if (sealed[0].length < padmeLen(1)) throw new Error("typing frame was not padded");
	const med = (a) => stats(a).median;
	row(`typing: seal 1 frame after ${OPEN_FRAME_IDLE_MS} ms idle`, stats(spaced), TYPING_IDLE_BUDGET_MS, "<= 10 ms", true, "wall incl. CPU/worker wake-up");
	row("typing: seal 1 frame, steady state (info)", stats(b2b), TYPING_STEADY_INFO_MS, "-", false, "per-call crypto cost (back-to-back)");
	row(`  bare subtle.encrypt ${pt.length} B after idle (info)`, stats(bareSpaced), null, "-", false, `platform floor, no YAOS code; hot ${med(bareHot).toFixed(4)} ms`);
	row(`  crypto-free 2000-step JS loop after idle (info)`, stats(jsSpaced), null, "-", false, `CPU idle effect; hot ${med(jsHot).toFixed(4)} ms`);
	row("typing: open 1 frame, steady state (info)", stats(open), TYPING_STEADY_INFO_MS, "-", false, "receiver side");
}

// ---- bootstrap (§16.2: 10k docs, 200 MiB of checkpoints and tail, <= 0.3 s total crypto) --------------------

const DOCS = 10_000;
const TOTAL_BYTES = 200 * 1024 * 1024;
const PER_DOC = Math.floor(TOTAL_BYTES / DOCS); // 20971 B of content per doc

const { REMOTE_CHECKPOINT_ROWS } = await load("src/core/limits.ts");

/**
 * Scenario streams: one b:<docId> per doc with a checkpoint (preferCheckpoint read of a fresh device) and
 * `tailOf(d)` frames after it, from three other devices. Sealed through the real sealCheckpoint / sealFrame.
 */
async function buildStreams(crypto, ckptBytes, tailOf, tailBytes) {
	const ckptContent = randomBytes(ckptBytes); // incompressible: the deflate rule (DESIGN §b.1) leaves it raw
	const tailContent = randomBytes(Math.max(1, tailBytes));
	const out = new Array(DOCS);
	let bytes = 0;
	let opens = 0;
	for (let d = 0; d < DOCS; d++) {
		const stream = bodyStream(newId(random));
		const coversSeq = 1000 + d;
		const ckpt = await sealCheckpoint(crypto, VAULT, stream, coversSeq, ckptContent, 7);
		bytes += ckpt.length;
		const tail = tailOf(d);
		opens += 1 + tail;
		const rowsOut = [];
		for (let t = 0; t < tail; t++) {
			const deviceId = PEERS[t % PEERS.length];
			const clientFrameId = newId(random);
			const s = await sealFrame(crypto, VAULT, { stream, deviceId, clientFrameId, kind: "bodyUpdate", authorNsSeq: 7, flags: 0, frameNo: 0, content: tailContent });
			bytes += s.sealed.length;
			rowsOut.push({ deviceId, clientFrameId, payload: s.sealed });
		}
		out[d] = { stream, coversSeq, ckpt, rows: rowsOut };
	}
	return { streams: out, sealedBytes: bytes, opens };
}

/** One stream as readStream gates it: the checkpoint (catchUp.ts:127), then each row in order (catchUp.ts:178-189). */
async function openStream(crypto, s) {
	const c = await openEnvelope(crypto, VAULT, { t: "checkpoint", stream: s.stream, coversSeq: s.coversSeq }, s.ckpt);
	if (!c.ok) throw new Error(`checkpoint open failed: ${c.reason}`);
	for (const r of s.rows) {
		const g = await openEnvelope(crypto, VAULT, { t: "frame", stream: s.stream, deviceId: r.deviceId, clientFrameId: r.clientFrameId }, r.payload);
		if (!g.ok) throw new Error(`row open failed: ${g.reason}`);
	}
}

const PATTERNS = {
	/** Non-batched relay (readBatchStreams 1): scheduleCatchUp runs single reads in catchUpConcurrency lanes. */
	lanes: (n) => async (crypto, streams) => {
		let next = 0;
		await Promise.all(Array.from({ length: n }, async () => {
			while (next < streams.length) await openStream(crypto, streams[next++]);
		}));
	},
	/** Batched relay: every member of a batch gates concurrently once the batch arrives; one batch after another. */
	batches: (w) => async (crypto, streams) => {
		for (let i = 0; i < streams.length; i += w) await Promise.all(streams.slice(i, i + w).map((s) => openStream(crypto, s)));
	},
	sequential: () => async (crypto, streams) => {
		for (const s of streams) await openStream(crypto, s);
	},
	all: () => (crypto, streams) => Promise.all(streams.map((s) => openStream(crypto, s))),
};

async function benchBootstrap(label, ckptBytes, tailOf, tailBytes, must) {
	const crypto = await readyCrypto(1);
	const t0 = now();
	const sc = await buildStreams(crypto, ckptBytes, tailOf, tailBytes);
	const setupS = (now() - t0) / 1000;
	const lanes = BUDGETS.desktop.catchUpConcurrency;
	const perStream = sc.sealedBytes / DOCS;
	// Batch width: the first pages that fit one readPageBytes budget (sessionLoop.ts:10-11), at most readBatchStreams.
	const width = Math.max(1, Math.min(DEFAULT_TUNING.readBatchStreams, Math.floor(DEFAULT_RELAY_LIMITS.readPageBytes / perStream)));
	log(`  ${label}: ${DOCS} streams, ${sc.opens} opens, ${(sc.sealedBytes / 1048576).toFixed(1)} MiB sealed (setup ${setupS.toFixed(1)} s, not timed); batch width ${width}, lanes ${lanes}`);
	const run = (fn) => repeat(R.bootWarm, R.boot, () => fn(crypto, sc.streams));
	row(`bootstrap ${label}: engine, ${lanes} lanes`, stats(await run(PATTERNS.lanes(lanes))), 300, "<= 3 s", must, "non-batched relay");
	row(`bootstrap ${label}: engine, batches of ${width}`, stats(await run(PATTERNS.batches(width))), 300, "<= 3 s", must, "batched relay, 1 lane");
	row(`bootstrap ${label}: all sequential (info)`, stats(await run(PATTERNS.sequential())), 300, "<= 3 s", false, "no engine path does this");
	row(`bootstrap ${label}: Promise.all (info)`, stats(await run(PATTERNS.all())), 300, "<= 3 s", false, "unbounded");
	sc.streams.length = 0;
}

// ---- blob (§16.2: one 10 MiB blob <= 10 ms) -----------------------------------------------------------------

async function benchBlob() {
	const crypto = await readyCrypto(1);
	const n = MAX_BLOB_PLAINTEXT_BYTES_SUITE1;
	const plaintext = randomBytes(n);
	const hash = bytesToHex(await createWebHash().sha256(plaintext)); // excluded: "already done today" (§16.1)
	let address = null;
	let sealed = null;
	const up = await repeat(R.blobWarm, R.blob, async () => {
		address = await crypto.blobAddress(hash);
		sealed = await crypto.sealBlob({ address, plaintext });
	});
	const { concatBytes } = await load("src/core/codec/lib0.ts");
	sealed = concatBytes(sealed); // sealBlob returns parts; the stored object is their concatenation (not timed)
	let last = null;
	const down = await repeat(R.blobWarm, R.blob, async () => {
		const r = await crypto.openBlob({ address, sealed });
		if (!r.ok) throw new Error(`openBlob failed: ${r.reason}`);
		last = r.plaintext;
	});
	if (bytesToHex(await createWebHash().sha256(last)) !== hash) throw new Error("blob round trip mismatch");
	const mib = (n / 1048576).toFixed(2);
	row(`blob up: ${mib} MiB, HMAC addr + seal`, stats(up), 10, "<= 100 ms", true, "max suite-1 plaintext");
	row(`blob down: ${mib} MiB, open + unpad`, stats(down), 10, "<= 100 ms", true);
}

/**
 * Blob memory (e2ee-design §10.3) and the end-to-end store path, information only. Each path runs the real code:
 * - up (in-memory store): blobStore.putSealed = blobAddress, has, sealBlob, BlobPort.put, over an in-memory BlobPort
 *   that keeps what put receives by reference (no copy), so the numbers are this code's own buffers.
 * - up (httpBlob): the same through the real httpBlob.put; its stub fetch builds the real Request from (url, init),
 *   i.e. Node's fetch body extraction, so the transport's copy of the body is included.
 * - down: blobStore.getOpened (get, openBlob; the sha256 check excluded as in benchBlob), then owned(): the copy
 *   hostLink.exec makes when write bytes are not a whole buffer, before transferring them to main.
 * Memory, from a gc()'d baseline: "allocated" = the process.memoryUsage() delta when the operation returns, before
 * any gc(); "kept" = the delta after gc(), i.e. what is still referenced (the stored object, the opened and sent
 * bytes). A GC during the operation would hide some of it: external-memory pressure (tens of MiB) starts one, so
 * the memory loop turns off incremental marking and counts external memory in the global limit, and still
 * discards and counts any sample a GC overlapped. Node counts WebCrypto's output buffers in `external` but not in
 * `arrayBuffers`, and a Blob's copy in `arrayBuffers` but not in `external`: both are shown. Timing runs after,
 * with the default GC flags and no forced GC, >= 100 repetitions.
 */
async function benchBlobMemory() {
	const v8 = await import("node:v8");
	const vm = await import("node:vm");
	const { PerformanceObserver } = await import("node:perf_hooks");
	if (typeof globalThis.gc !== "function") v8.setFlagsFromString("--expose-gc");
	const gc = globalThis.gc ?? vm.runInNewContext("gc");
	const { putSealed, getOpened } = await load("src/engine/blobs/blobStore.ts");
	const { createHttpBlob } = await load("src/engine/adapters/httpBlob.ts");
	const { owned } = await load("src/protocol/workerTransport.ts");
	const { concatBytes } = await load("src/core/codec/lib0.ts");
	const crypto = await readyCrypto(1);
	const n = MAX_BLOB_PLAINTEXT_BYTES_SUITE1;
	const MiB = 1048576;
	const plaintext = randomBytes(n);
	const hash = bytesToHex(await createWebHash().sha256(plaintext));
	const address = await crypto.blobAddress(hash);
	const policy = { reuse: async () => false, noted: async () => {} };
	const objects = new Map();
	const mem = {
		maxBlobBytes: 10 * MiB,
		has: async (as) => new Set(as.filter((a) => objects.has(a))),
		put: async (a, b) => void objects.set(a, b),
		get: async (a) => objects.get(a) ?? null,
		list: async () => ({ items: [], next: null }),
		deleteIfUploadedBefore: async () => [],
	};
	let lastRequest = null;
	const http = createHttpBlob({
		baseUrl: "http://bench.invalid", vaultId: "bench", credential: "bench", maxBlobBytes: 10 * MiB,
		fetch: async (url, init) => {
			if (String(url).endsWith("/exists")) return new Response(JSON.stringify({ present: [] }), { status: 200 });
			lastRequest = new Request(url, init); // Node's fetch body extraction (undici extractBody)
			return new Response(null, { status: 204 });
		},
	});
	const sealed = concatBytes(await crypto.sealBlob({ address, plaintext }));
	const paths = {
		"up, in-memory store (putSealed)": { run: () => putSealed(mem, crypto, hash, plaintext, policy), reset: () => objects.clear() },
		"up, httpBlob.put + Request body": { run: () => putSealed(http, crypto, hash, plaintext, policy), reset: () => { lastRequest = null; } },
		"down, getOpened + owned()": {
			setup: () => objects.set(address, sealed),
			run: async () => {
				const got = await getOpened(mem, crypto, hash, null);
				if (!got.ok) throw new Error(`getOpened failed: ${got.reason}`);
				return [got.bytes, owned(got.bytes)];
			},
			reset: () => objects.clear(),
		},
	};
	const gcAt = [];
	const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcAt.push(e.startTime); });
	obs.observe({ entryTypes: ["gc"] });
	const flushGcEntries = () => new Promise((r) => setTimeout(r, 5));
	const m = () => process.memoryUsage();
	const memReps = QUICK ? 8 : 20;
	const timeReps = 100;
	const lines = [];
	v8.setFlagsFromString("--no-incremental-marking");
	v8.setFlagsFromString("--external-memory-accounted-in-global-limit");
	for (const [label, p] of Object.entries(paths)) {
		const samples = [];
		let gcHit = 0;
		for (let i = 0; i < memReps + 2; i++) {
			p.setup?.();
			gc(); gc();
			const a = m();
			const t0 = performance.now();
			let keep = await p.run();
			const t1 = performance.now();
			const b = m();
			await flushGcEntries();
			const hit = gcAt.some((t) => t >= t0 && t <= t1);
			gc(); gc();
			const c = m();
			keep = null;
			p.reset();
			if (i < 2) continue; // warm-up
			if (hit) gcHit++;
			else samples.push({ ext: b.external - a.external, ab: b.arrayBuffers - a.arrayBuffers, heap: b.heapUsed - a.heapUsed, keptExt: c.external - a.external, keptAb: c.arrayBuffers - a.arrayBuffers });
			if (keep !== null) throw new Error("unreachable");
		}
		const med = (k) => stats(samples.map((s) => s[k])).median / MiB;
		lines.push({ label, p, ext: med("ext"), ab: med("ab"), heap: med("heap"), keptExt: med("keptExt"), keptAb: med("keptAb"), clean: samples.length, gcHit });
	}
	obs.disconnect();
	v8.setFlagsFromString("--incremental-marking");
	v8.setFlagsFromString("--no-external-memory-accounted-in-global-limit");
	for (const l of lines) {
		l.p.setup?.();
		l.t = stats(await repeat(5, timeReps, async () => { await l.p.run(); }));
		l.p.reset();
		row(`blob ${l.label} (info)`, l.t, null, "-", false, `alloc ext ${l.ext.toFixed(1)} / ab ${l.ab.toFixed(1)} MiB per blob`);
	}
	const f = (x) => x.toFixed(2).padStart(7);
	log("");
	log(`Blob memory per ${(n / MiB).toFixed(2)} MiB blob (sealed ${(sealed.length / MiB).toFixed(2)} MiB); MiB, medians of clean samples (no GC during the operation)`);
	log(`  ${"path".padEnd(34)} ${"alloc ext".padStart(9)} ${"alloc ab".padStart(9)} ${"kept ext".padStart(9)} ${"kept ab".padStart(9)} ${"heapUsed".padStart(9)} ${"clean/gc".padStart(9)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"n".padStart(4)}`);
	for (const l of lines) {
		log(`  ${l.label.padEnd(34)} ${f(l.ext).padStart(9)} ${f(l.ab).padStart(9)} ${f(l.keptExt).padStart(9)} ${f(l.keptAb).padStart(9)} ${f(l.heap).padStart(9)} ${`${l.clean}/${l.gcHit}`.padStart(9)} ${l.t.median.toFixed(2).padStart(8)} ${l.t.p95.toFixed(2).padStart(8)} ${String(l.t.n).padStart(4)}`);
	}
	log(`  load average: ${os.loadavg().map((x) => x.toFixed(2)).join(" ")}`);
}

// ---- engine start (§16.2 <= 5 ms) ---------------------------------------------------------------------------

async function benchStart(n) {
	const records = await buildRecords(n);
	const opts = (kc) => ({ mode: "suite1", vaultId: VAULT, kc, records, persist: async () => {} });
	const small = randomBytes(64);
	const smallHash = bytesToHex(await createWebHash().sha256(small));
	const stream = bodyStream(newId(random));
	const garbageWrap = randomBytes(60);
	const parts = { create: [], keyring: [], first: [] };
	const once = async () => {
		const keys = keysFor(n);
		const t0 = now();
		const kc = await createWebCryptoSuite1({ vaultId: VAULT, random, keys }); // N HKDF base-key imports
		const t1 = now();
		const gate = await Keyring.open(opts(kc)); // pinGate.ts keyed(): kcv of every epoch
		const keyed = gate.keyMissing() === null;
		gate.dispose();
		const kr = await Keyring.open(opts(kc)); // KeyringRuntime.open
		const t2 = now();
		await sealFrame(kc, VAULT, { stream, deviceId: SELF, clientFrameId: newId(random), kind: "bodyUpdate", authorNsSeq: 1, flags: 0, frameNo: 0, content: small }); // kFrame
		await sealCheckpoint(kc, VAULT, stream, 1, small, 1); // kCkpt
		const address = await kc.blobAddress(smallHash); // kAddr (K_1)
		await kc.sealBlob({ address, plaintext: small }); // kBlob
		await kc.diagHash(small); // kDiag (K_1)
		const unwrapped = await kc.unwrap("next", n + 1, small, garbageWrap); // kWrap of the seal epoch (fails the tag: no state change)
		const t3 = now();
		if (!keyed || kr.keyMissing() !== null || kc.sealEpoch() !== n || unwrapped) throw new Error(`engine start: keyring did not verify (n=${n})`);
		kr.dispose();
		return [t1 - t0, t2 - t1, t3 - t2];
	};
	for (let i = 0; i < R.startWarm; i++) await once();
	const total = [];
	for (let i = 0; i < R.start; i++) {
		const [a, b, c] = await once();
		parts.create.push(a);
		parts.keyring.push(b);
		parts.first.push(c);
		total.push(a + b + c);
	}
	row(`engine start: ${n} epoch${n > 1 ? "s" : ""}, total`, stats(total), 5, "<= 20 ms", true, `${n} import + ${n + 6} deriveKey`);
	const fmt = (s) => `${stats(s).median.toFixed(3)}`;
	rows.at(-1).note += `; create ${fmt(parts.create)} + keyring ${fmt(parts.keyring)} + first use ${fmt(parts.first)} ms`;
}

// ---- bundle (§16.2: +0 KB WebCrypto; qrcode +9.6 KB gzip; ~2 KB base32/record) ------------------------------

/** Metafile paths of packages resolve through the node_modules symlink (e.g. ../yaos-client/node_modules/qrcode/...). */
const npmPath = (p) => p.replace(/^.*?node_modules\//, "node_modules/");
const GROUPS = [
	["WebCrypto adapter", (p) => p === "src/engine/adapters/webCryptoSuite1.ts" || p === "src/engine/adapters/suite1Primitives.ts"],
	["keyring engine", (p) => p.startsWith("src/engine/keyring/") && !p.includes("/testkit/") && !p.endsWith(".test.ts")],
	["E2EE codecs (base32 RK, Padme, sealed blob)", (p) => ["src/core/codec/recoveryKey.ts", "src/core/codec/padme.ts", "src/core/codec/sealedBlob.ts"].includes(p)],
	["host keys (src/host/keys)", (p) => p.startsWith("src/host/keys/") && !p.includes("/testkit/") && !p.endsWith(".test.ts")],
	["E2EE compose (pinGate, keyReader, hostKeyring)", (p) => ["src/engine/compose/pinGate.ts", "src/engine/compose/keyReader.ts", "src/engine/compose/hostKeyring.ts"].includes(p)],
	["qrcode (+ dijkstrajs)", (p) => /^node_modules\/(qrcode|dijkstrajs)\//.test(npmPath(p))],
];
/** Third-party crypto: "+0 KB for WebCrypto" means none of these reach the bundle. */
const THIRD_PARTY_CRYPTO = /^node_modules\/(@noble|@stablelib|tweetnacl|libsodium|crypto-js|node-forge|asmcrypto|sjcl|elliptic|hash\.js|js-sha256|aes-js|@peculiar)/;

async function benchBundle() {
	const esbuild = (await import("esbuild")).default ?? (await import("esbuild"));
	const outDir = join(os.tmpdir(), "yaos-bench-e2ee");
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	// The production options of esbuild.config.mjs (mainOptions with prod = true), written to /tmp only.
	const base = {
		absWorkingDir: ROOT, bundle: true, format: "cjs", platform: "browser", target: "es2018", treeShaking: true,
		minify: true, legalComments: "none", metafile: true, logLevel: "silent", sourcemap: false,
		external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
	};
	const outfile = join(outDir, "main.js");
	const r = await esbuild.build({
		...base, entryPoints: ["src/host/entry.ts"], outfile, write: true,
		banner: { js: "(function __yaosBundle(require, module, exports, __yaosWorkerScope) {" }, footer: { js: "})(require, module, exports);" },
	});
	const output = Object.values(r.metafile.outputs).find((o) => o.entryPoint === "src/host/entry.ts");
	const { readFileSync } = await import("node:fs");
	const mainBytes = readFileSync(outfile);
	const mainGz = gzipSync(mainBytes, { level: 9 }).length;
	const ratio = mainGz / mainBytes.length;
	const inputs = Object.entries(output.inputs);
	const kb = (n) => `${(n / 1000).toFixed(1)} KB`;
	const lines = [];
	let e2eeRaw = 0;
	for (const [name, match] of GROUPS) {
		const hit = inputs.filter(([p]) => match(p));
		const raw = hit.reduce((a, [, v]) => a + v.bytesInOutput, 0);
		if (!name.startsWith("qrcode")) e2eeRaw += raw;
		lines.push([name, raw, hit.length]);
	}
	const crypto3p = inputs.filter(([p]) => THIRD_PARTY_CRYPTO.test(npmPath(p)));
	const crypto3pRaw = crypto3p.reduce((a, [, v]) => a + v.bytesInOutput, 0);
	// qrcode alone: the one import the UI uses (src/host/ui/pairModal.ts: `import { toCanvas } from "qrcode"`).
	const qr = await esbuild.build({ ...base, stdin: { contents: 'import { toCanvas } from "qrcode"; globalThis.__qr = toCanvas;', resolveDir: ROOT, loader: "js" }, write: false, outfile: join(outDir, "qr.js") });
	const qrBytes = qr.outputFiles[0].contents;
	const qrGz = gzipSync(qrBytes, { level: 9 }).length;
	log("");
	log(`Bundle (esbuild production options, minified, written to ${outfile}; gzip = zlib level 9)`);
	log(`  whole bundle: ${kb(mainBytes.length)} raw, ${kb(mainGz)} gzip (ratio ${ratio.toFixed(3)})`);
	log(`  ${"group".padEnd(48)} ${"files".padStart(5)} ${"raw bytesInOutput".padStart(18)} ${"gzip est.*".padStart(11)}`);
	for (const [name, raw, files] of lines) log(`  ${name.padEnd(48)} ${String(files).padStart(5)} ${kb(raw).padStart(18)} ${kb(raw * ratio).padStart(11)}`);
	log(`  ${"E2EE code total (all groups but qrcode)".padEnd(48)} ${"".padStart(5)} ${kb(e2eeRaw).padStart(18)} ${kb(e2eeRaw * ratio).padStart(11)}`);
	log(`  ${"third-party crypto libraries".padEnd(48)} ${String(crypto3p.length).padStart(5)} ${kb(crypto3pRaw).padStart(18)}`);
	log(`  qrcode alone (toCanvas, own minified bundle): ${kb(qrBytes.length)} raw, ${kb(qrGz)} gzip (§16.2 says +9.6 KB gzip [M])`);
	log("  * gzip est. = raw bytesInOutput x the whole bundle's gzip ratio (per-input gzip is not separable)");
	const named = ["src/core/codec/recoveryKey.ts", "src/core/codec/sealedBlob.ts", "src/engine/compose/pinGate.ts", "src/engine/compose/keyReader.ts", "src/engine/compose/hostKeyring.ts"];
	const absent = named.filter((f) => !inputs.some(([p]) => p === f));
	if (absent.length > 0) log(`  not reachable from src/host/entry.ts (0 B in the bundle): ${absent.join(", ")}`);
	rows.push({ path: "bundle: third-party crypto (WebCrypto +0 KB)", median: crypto3pRaw / 1000, p95: null, n: 1, budgetMs: 0, mobile: "-", must: true, unit: "KB", note: `${crypto3p.length} files`, pass: crypto3pRaw === 0 });
	rows.push({ path: "bundle: qrcode alone, gzip (info)", median: qrGz / 1000, p95: null, n: 1, budgetMs: 9.6, mobile: "-", must: false, unit: "KB", note: "[M] figure, not a MUST", pass: qrGz <= 9600 * 1.1 });
	rows.push({ path: "bundle: E2EE code, gzip est. (info)", median: (e2eeRaw * ratio) / 1000, p95: null, n: 1, budgetMs: null, mobile: "-", must: false, unit: "KB", note: "§16.2: ~15 KB gzip [M], accepted", pass: null });
}

// ---- main ---------------------------------------------------------------------------------------------------

const load0 = os.loadavg();
log(`bench-e2ee ${QUICK ? "(quick)" : "(full)"}: node ${process.version}, ${os.cpus().length} x ${os.cpus()[0]?.model ?? "?"}, UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? "4 (default)"}`);
log(`load average at start: ${load0.map((x) => x.toFixed(2)).join(" ")}`);
const t0 = now();
await benchTyping();
log("bootstrap scenarios:");
await benchBootstrap("A (10k ckpt)", PER_DOC, () => 0, 0, true);
// S, the steady state the checkpoint policy leaves (DESIGN §d.9): quiet docs are settled to their checkpoint, and up
// to 32 docs still in an edit session carry REMOTE_CHECKPOINT_ROWS - 1 typing frames each, the most below the hot
// rule. They are spread over the stream order, one per batch: the slow case, as each such batch waits for its tail.
const ACTIVE = 32;
const ACTIVE_TAIL = REMOTE_CHECKPOINT_ROWS - 1;
const STRIDE = Math.floor(DOCS / ACTIVE);
await benchBootstrap(`S (steady ${ACTIVE}x${ACTIVE_TAIL})`, PER_DOC, (d) => (d % STRIDE === 0 && d / STRIDE < ACTIVE ? ACTIVE_TAIL : 0), 128, true);
// C (information): the settle cap reached on a vault-wide scripted edit, one frame left on every doc (20k opens).
await benchBootstrap("C (cap +10k tail)", PER_DOC, () => 1, 128, false);
// B (stress, information): same 200 MiB, but each doc also carries 4 tail frames (5 opens per doc, 50k opens; 2.5x
// the §16.2 call model). The settle rule checkpoints such tails once the docs are quiet, so a fresh device does not
// meet it in practice.
const TAIL = 4;
const TAIL_BYTES = 1146;
await benchBootstrap("B (stress +40k tail)", PER_DOC - TAIL * TAIL_BYTES, () => TAIL, TAIL_BYTES, false);
await benchBlob();
await benchBlobMemory();
for (const n of [1, 3, 10]) await benchStart(n);
if (!NO_BUNDLE) await benchBundle();
const load1 = os.loadavg();

log("");
log(`Results (${QUICK ? "quick" : "full"}; desktop = this machine; mobile assumed 10x worse per §16.1, not measured)`);
const head = `${"path".padEnd(52)} ${"median".padStart(10)} ${"p95".padStart(10)} ${"n".padStart(5)} ${"desktop budget".padStart(15)} ${"result".padStart(9)} ${"mobile (ref)".padStart(13)}  note`;
log(head);
log("-".repeat(head.length + 20));
const fmtV = (v, unit) => (v === null ? "-" : unit === "KB" ? `${v.toFixed(1)} KB` : `${v < 1 ? v.toFixed(4) : v.toFixed(2)} ms`);
const missed = [];
for (const r of rows) {
	const budget = r.budgetMs === null ? "-" : r.unit === "KB" ? (r.budgetMs === 0 ? "0 KB" : `${r.budgetMs} KB`) : `<= ${r.budgetMs} ms`;
	const result = r.pass === null ? "-" : r.must ? (r.pass ? "PASS" : "FAIL") : r.pass ? "(ok)" : "(over)";
	if (r.must && r.pass === false) missed.push(r.path);
	log(`${r.path.padEnd(52)} ${fmtV(r.median, r.unit).padStart(10)} ${fmtV(r.p95, r.unit).padStart(10)} ${String(r.n).padStart(5)} ${budget.padStart(15)} ${result.padStart(9)} ${String(r.mobile).padStart(13)}  ${r.note}`);
}
log("");
log(`load average at end: ${load1.map((x) => x.toFixed(2)).join(" ")}; wall ${((now() - t0) / 1000).toFixed(1)} s`);
log("PASS/FAIL compares the median with the desktop budget; (ok)/(over) rows are information, not MUST budgets.");
if (missed.length > 0) {
	log("");
	log(`!!! BUDGET MISSED: ${missed.join("; ")}`);
	log(`!!! (load average ${load1[0].toFixed(2)} on ${os.cpus().length} cores: rerun on an idle machine before concluding)`);
	process.exit(1);
}
log("all desktop MUST budgets met");
