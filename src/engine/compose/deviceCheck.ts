/**
 * The on-device self-test (commands "YAOS: Run device check" and "YAOS: Run large attachment check (max size)"). Main
 * sends `deviceCheck` (protocol/messages.ts); protocolEngine.ts answers it here, in the engine, on its live ports, and
 * main only shows the report. Nothing in the vault, the local database or the relay's log changes.
 *
 * Steps, quick:
 *  - engine: the carrier (must be the worker), the engine clock when init answered ready (in the worker:
 *    webClock = performance.now(), whose origin is the worker's start), the last vault runtime start and its
 *    Repo.open (IndexedDB), the platform the host saw and the dependencies the engine's own scope exposes;
 *  - sha256-*: random bytes through the HashPort (WebCrypto in the worker), MB/s;
 *  - seal-*: suite 1 only, sealBlob + openBlob of the largest quick size through the runtime's CryptoPort (the
 *    write-gated one: a shut gate refuses it, and the seal counts towards the key's roll trigger like any other);
 *  - relay-socket: the live session and one VAULT_PING / VAULT_PONG round trip on it (RelaySession.ping);
 *  - relay-http: one feed page from the vault cursor through relayHttp, as the session loop reads it;
 *  - blob-*: random bytes stored and fetched back through the transfer queue's path (blobs/blobStore.ts): putSealed
 *    (HashPort digest, CryptoPort blobAddress, has, sealBlob, put) and getOpened (get, openBlob, sha256 check), on the
 *    runtime's TransferLink-wrapped, write-gated BlobPort (httpBlob), each phase timed, the upload progress events and
 *    download chunks counted (ports/blob.ts BlobProgress). A real upload with no progress event fails: httpBlob's
 *    idle window (BLOB_TRANSFER_IDLE_MS) restarts on them, so a longer upload would be ended as stalled;
 *  - limits: the blob caps the engine uses, and the memory the platform exposes (or "not exposed").
 * Large: engine, blob-max at the blob queue's maxBlobBytes (blobStore.ts storePlaintextCap), limits.
 *
 * The test blobs reference nothing and no put time is recorded for them (a PutPolicy that notes nothing), so a
 * blob GC sweep ("Clean up unused server attachments") deletes them once they are older than its grace. A step
 * whose relay link drops mid-transfer fails with the transfer's error (blobs/transferLink.ts aborts it), as any
 * transfer would; the report says the link was lost.
 */

import { bytesToHex, concatBytes } from "../../core/codec/lib0";
import { bounded } from "../../core/deadline";
import { BLOB_TRANSFER_IDLE_MS, type DeviceClass } from "../../core/limits";
import type { ContentHash, Seq } from "../../core/types";
import type { BlobPort, BlobProgress } from "../../ports/blob";
import type { ClockPort } from "../../ports/clock";
import type { CryptoPort, HashPort } from "../../ports/crypto";
import type { PlatformInfo } from "../../ports/platform";
import type { RandomPort } from "../../ports/random";
import type { RelaySession } from "../../ports/relay";
import { DEVICE_CHECK_QUICK_BYTES } from "../../protocol/messages";
import type { DeviceCheckMode, DeviceCheckReport, DeviceCheckStep, DeviceEnv, EnginePhase } from "../../protocol/status";
import { getOpened, putSealed, type PutPolicy } from "../blobs/blobStore";

/** The relay's liveness timeout (VAULT_READY.liveness.timeoutMs; wsRelay DEFAULT_LIVENESS): the ping step's deadline. */
const RELAY_PING_TIMEOUT_MS = 15_000;

/** Engine startup times the composed engine records (protocolEngine.ts); null = not recorded. */
export interface StartupTimes {
	/** The engine's monotonic clock when init answered ready (in the worker: ms since the worker started). */
	readonly readyAtMs: number | null;
	/** The last vault runtime start (VaultRuntime.start, which opens the store and imports the mirrors). */
	readonly runtimeStartMs: number | null;
	/** Its Repo.open: IndexedDB open and identity check (runtime/context.ts repoOpenMs). */
	readonly repoOpenMs: number | null;
}

/** The running vault runtime's ports and state. */
export interface DeviceCheckLive {
	/** The write-gated CryptoPort (runtime/context.ts deps.crypto). */
	readonly crypto: CryptoPort;
	/** The write-gated, link-aborted BlobPort (deps.blob); null = the relay has no blob store. */
	readonly blob: BlobPort | null;
	/** The blob queue's plaintext cap (blobQueue.ts maxBlobBytes). */
	readonly maxBlobBytes: number;
	readonly maxAttachmentBytes: number;
	readonly blobBytesInFlight: number;
	readonly blobGcGraceMs: number;
	readonly phase: () => EnginePhase;
	readonly session: () => RelaySession | null;
	/** The vault cursor V (where the session loop's feed starts). */
	readonly vaultSeq: () => Seq;
	/** Bumped on every session start and end (runtime/context.ts gen): a change during a step = the link was lost. */
	readonly linkGen: () => number;
}

export interface DeviceCheckDeps {
	readonly carrier: "worker" | "inline";
	readonly clientVersion: string;
	/** What the host probed on main (init config). */
	readonly platform: PlatformInfo;
	readonly deviceClass: DeviceClass;
	/** The device's pin (init config): null = unpinned. */
	readonly suite: 0 | 1 | null;
	readonly startup: StartupTimes;
	/** What the engine's own scope exposes, read when called (null: not known on this carrier). */
	readonly env: () => DeviceEnv | null;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly hash: HashPort;
	/** The running vault runtime, or why there is none (the steps that need it fail with that). */
	readonly live: DeviceCheckLive | string;
	/** Ends the check's network calls (the engine stops). */
	readonly signal?: AbortSignal;
}

type Data = Record<string, string | number | boolean | null>;
interface Outcome {
	readonly status?: DeviceCheckStep["status"];
	readonly detail: string;
	readonly data?: Data;
	readonly error?: string | null;
}

/** A PutPolicy that always PUTs and records nothing: the test blob is never "touched" (blobs/touch.ts). */
const UNRECORDED: PutPolicy = { reuse: async () => false, noted: async () => undefined };

const r1 = (v: number): number => Math.round(v * 10) / 10;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** "1 MB", "10 MB", "99.9 MB" (decimal MB, as the relay's 100 MB cap). */
function sizeLabel(bytes: number): string {
	return `${r1(bytes / 1e6)} MB`;
}

/** MB per second (decimal), null for a zero duration. */
function mbPerS(bytes: number, ms: number): number | null {
	return ms > 0 ? r1(bytes / ms / 1000) : null;
}

function msText(ms: number): string {
	return ms >= 1000 ? `${r1(ms / 1000)} s` : `${Math.round(ms)} ms`;
}

function rate(bytes: number, ms: number): string {
	const v = mbPerS(bytes, ms);
	return v === null ? "" : `, ${v} MB/s`;
}

async function step(clock: ClockPort, id: string, name: string, run: () => Promise<Outcome>): Promise<DeviceCheckStep> {
	const t0 = clock.monotonic();
	let o: Outcome;
	try {
		o = await run();
	} catch (e) {
		o = { status: "fail", detail: errorText(e), error: errorText(e) };
	}
	return { id, name, status: o.status ?? "pass", ms: r1(clock.monotonic() - t0), detail: o.detail, error: o.error ?? null, data: o.data ?? {} };
}

/** The web APIs the engine's adapters need in its scope (blob PUT, relay socket, local store, hashing and sealing). */
const API_NAMES: Readonly<Record<keyof DeviceEnv["apis"], string>> = { xmlHttpRequest: "XMLHttpRequest", webSocket: "WebSocket", idb: "IndexedDB", subtleCrypto: "WebCrypto" };

function engineStep(d: DeviceCheckDeps): Outcome {
	const { startup: s, platform: p } = d;
	const env = d.env();
	const worker = d.carrier === "worker";
	const missing = env ? (Object.keys(API_NAMES) as (keyof DeviceEnv["apis"])[]).filter((api) => !env.apis[api]).map((api) => API_NAMES[api]) : [];
	const parts = [
		worker ? "background worker" : `${d.carrier} carrier, not the worker`,
		s.readyAtMs === null ? "ready time not recorded" : worker ? `ready ${msText(s.readyAtMs)} after the worker started` : `ready at ${msText(s.readyAtMs)} on the engine clock`,
		s.runtimeStartMs === null ? "no vault runtime start recorded" : `vault runtime start ${msText(s.runtimeStartMs)}`,
		s.repoOpenMs === null ? "IndexedDB open time not recorded" : `IndexedDB open ${msText(s.repoOpenMs)}`,
		`${p.os}${p.isTablet ? " tablet" : p.isMobile ? " phone" : ""}, ${d.deviceClass} class, ${env?.hardwareConcurrency ?? p.hardwareConcurrency} cores`,
	];
	if (!env) parts.push("the engine scope's APIs were not probed");
	if (missing.length > 0) parts.push(`missing in the engine's scope: ${missing.join(", ")}`);
	return {
		status: worker && missing.length === 0 ? "pass" : "fail",
		detail: parts.join("; "),
		data: {
			carrier: d.carrier, readyAtMs: s.readyAtMs === null ? null : r1(s.readyAtMs), runtimeStartMs: s.runtimeStartMs === null ? null : r1(s.runtimeStartMs),
			repoOpenMs: s.repoOpenMs === null ? null : r1(s.repoOpenMs), os: p.os, isMobile: p.isMobile, isTablet: p.isTablet, deviceClass: d.deviceClass,
			hostHardwareConcurrency: p.hardwareConcurrency, workerSupported: p.workerSupported, suite: d.suite,
			userAgent: env?.userAgent ?? null, engineHardwareConcurrency: env?.hardwareConcurrency ?? null,
			xmlHttpRequest: env?.apis.xmlHttpRequest ?? null, webSocket: env?.apis.webSocket ?? null, idb: env?.apis.idb ?? null, subtleCrypto: env?.apis.subtleCrypto ?? null,
		},
	};
}

async function hashStep(d: DeviceCheckDeps, size: number): Promise<Outcome> {
	const bytes = d.random.bytes(size);
	const t0 = d.clock.monotonic();
	await d.hash.sha256(bytes);
	const ms = d.clock.monotonic() - t0;
	return { detail: `${msText(ms)}${rate(size, ms)}`, data: { bytes: size, ms: r1(ms), mbPerS: mbPerS(size, ms) } };
}

async function sealStep(d: DeviceCheckDeps, size: number): Promise<Outcome> {
	if (d.suite !== 1) return { status: "skip", detail: "the vault is not end-to-end encrypted: nothing is sealed" };
	if (typeof d.live === "string") return { status: "fail", detail: d.live };
	const crypto = d.live.crypto;
	const bytes = d.random.bytes(size);
	const hash = bytesToHex(await d.hash.sha256(bytes)) as ContentHash;
	const address = await crypto.blobAddress(hash);
	let t0 = d.clock.monotonic();
	const sealed = concatBytes(await crypto.sealBlob({ address, plaintext: bytes }));
	const sealMs = d.clock.monotonic() - t0;
	t0 = d.clock.monotonic();
	const opened = await crypto.openBlob({ address, sealed });
	const openMs = d.clock.monotonic() - t0;
	const data: Data = { bytes: size, sealedBytes: sealed.byteLength, sealMs: r1(sealMs), sealMbPerS: mbPerS(size, sealMs), openMs: r1(openMs), openMbPerS: mbPerS(size, openMs) };
	if (!opened.ok) return { status: "fail", detail: `the sealed bytes did not open: ${opened.reason}`, data };
	if (bytesToHex(await d.hash.sha256(opened.plaintext)) !== hash) return { status: "fail", detail: "the opened bytes differ from the sealed ones", data };
	return { detail: `seal ${msText(sealMs)}${rate(size, sealMs)}, open ${msText(openMs)}${rate(size, openMs)}`, data };
}

async function socketStep(d: DeviceCheckDeps): Promise<Outcome> {
	if (typeof d.live === "string") return { status: "fail", detail: d.live };
	const live = d.live;
	const s = live.session();
	if (!s) return { status: "fail", detail: `not connected (phase ${live.phase()})`, data: { connected: false, phase: live.phase() } };
	if (!s.ping) return { status: "fail", detail: "this relay session cannot ping", data: { connected: true, phase: live.phase() } };
	const ping = s.ping.bind(s);
	const t0 = d.clock.monotonic();
	const pong = await bounded(RELAY_PING_TIMEOUT_MS, d.signal, d.clock, () => ping(),
		(why) => new Error(why === "timeout" ? `no pong within ${RELAY_PING_TIMEOUT_MS / 1000} s` : "aborted"));
	const ms = d.clock.monotonic() - t0;
	return { detail: `connected (${live.phase()}), round trip ${msText(ms)}`, data: { connected: true, phase: live.phase(), canWrite: s.canWrite, rttMs: r1(ms), headSeq: pong.headSeq } };
}

async function httpStep(d: DeviceCheckDeps): Promise<Outcome> {
	if (typeof d.live === "string") return { status: "fail", detail: d.live };
	const s = d.live.session();
	if (!s) return { status: "fail", detail: `not connected (phase ${d.live.phase()})` };
	const from = d.live.vaultSeq();
	const t0 = d.clock.monotonic();
	const page = await s.feed(from);
	const ms = d.clock.monotonic() - t0;
	return {
		detail: `feed from seq ${from}: ${page.entries.length} stream(s) changed, head ${page.headSeq}, ${msText(ms)}`,
		data: { route: "feed", afterSeq: from, ms: r1(ms), entries: page.entries.length, headSeq: page.headSeq, more: page.more },
	};
}

/** What one blob round trip measured. */
class BlobMeter {
	hashMs: number | null = null;
	existsMs: number | null = null;
	sealMs: number | null = null;
	sealedBytes: number | null = null;
	uploadMs: number | null = null;
	uploadEvents = 0;
	uploadedBytes = 0;
	firstProgressMs: number | null = null;
	maxProgressGapMs = 0;
	/** From the last upload progress event to the PUT's answer (the relay storing the object). */
	afterLastProgressMs: number | null = null;
	downloadMs: number | null = null;
	downloadChunks = 0;
	downloadBytes = 0;
	openMs: number | null = null;
	verifyMs: number | null = null;

	constructor(private readonly clock: ClockPort) {}

	/** `p`, its duration (until it settles, either way) handed to `done`. */
	timed<T>(p: Promise<T>, t0: number, done: (ms: number) => void): Promise<T> {
		return p.finally(() => done(this.clock.monotonic() - t0));
	}

	data(size: number): Data {
		const o = (v: number | null) => (v === null ? null : r1(v));
		return {
			bytes: size, sealedBytes: this.sealedBytes, hashMs: o(this.hashMs), existsMs: o(this.existsMs), sealMs: o(this.sealMs),
			uploadMs: o(this.uploadMs), uploadMbPerS: this.uploadMs === null ? null : mbPerS(this.sealedBytes ?? size, this.uploadMs),
			uploadProgressEvents: this.uploadEvents, uploadProgressBytes: this.uploadedBytes, firstProgressMs: o(this.firstProgressMs),
			maxProgressGapMs: r1(this.maxProgressGapMs), afterLastProgressMs: o(this.afterLastProgressMs),
			downloadMs: o(this.downloadMs), downloadMbPerS: this.downloadMs === null ? null : mbPerS(this.downloadBytes, this.downloadMs),
			downloadChunks: this.downloadChunks, downloadBytes: this.downloadBytes, openMs: o(this.openMs), verifyMs: o(this.verifyMs),
		};
	}
}

/** `inner` with put / get / has timed and the put's progress events and the get's chunks counted. */
function meteredStore(inner: BlobPort, m: BlobMeter, clock: ClockPort): BlobPort {
	return {
		get maxBlobBytes() {
			return inner.maxBlobBytes;
		},
		has: (addresses, signal) => m.timed(inner.has(addresses, signal), clock.monotonic(), (ms) => { m.existsMs = ms; }),
		// Not async: the parts are not held here for the upload's length (httpBlob put).
		put: (address, parts, signal) => {
			m.sealedBytes = parts.reduce((n, p) => n + p.byteLength, 0);
			const t0 = clock.monotonic();
			let last = t0;
			const progress: BlobProgress = (sent) => {
				const now = clock.monotonic();
				if (m.uploadEvents === 0) m.firstProgressMs = now - t0;
				m.maxProgressGapMs = Math.max(m.maxProgressGapMs, now - last);
				last = now;
				m.uploadEvents++;
				m.uploadedBytes = sent;
			};
			return m.timed(inner.put(address, parts, signal, progress), t0, (ms) => {
				m.uploadMs = ms;
				if (m.uploadEvents > 0) m.afterLastProgressMs = clock.monotonic() - last;
			});
		},
		get: (address, signal) => {
			const chunk: BlobProgress = (n) => {
				m.downloadChunks++;
				m.downloadBytes += n;
			};
			return m.timed(inner.get(address, signal, chunk), clock.monotonic(), (ms) => { m.downloadMs = ms; });
		},
		list: (cursor, signal) => inner.list(cursor, signal),
		deleteIfUploadedBefore: (addresses, cutoffMs, signal) => inner.deleteIfUploadedBefore(addresses, cutoffMs, signal),
	};
}

/** `inner` with sealBlob / openBlob timed. */
function meteredCrypto(inner: CryptoPort, m: BlobMeter, clock: ClockPort): CryptoPort {
	return {
		get suite() {
			return inner.suite;
		},
		sealEpoch: () => inner.sealEpoch(),
		keyState: (e) => inner.keyState(e),
		seal: (input) => inner.seal(input),
		open: (input) => inner.open(input),
		sealBlob: (input) => {
			const t0 = clock.monotonic();
			return m.timed(inner.sealBlob(input), t0, (ms) => { m.sealMs = ms; });
		},
		openBlob: (input) => {
			const t0 = clock.monotonic();
			return m.timed(inner.openBlob(input), t0, (ms) => { m.openMs = ms; });
		},
		blobAddress: (hash) => inner.blobAddress(hash),
		diagHash: (bytes) => inner.diagHash(bytes),
	};
}

async function blobStep(d: DeviceCheckDeps, size: number): Promise<Outcome> {
	if (typeof d.live === "string") return { status: "fail", detail: d.live };
	const live = d.live;
	if (!live.blob) return { status: "skip", detail: "the relay has no blob store: attachments do not sync", data: { bytes: size } };
	if (size <= 0) return { status: "skip", detail: "the blob store takes no blob of this size", data: { bytes: size } };
	const { clock } = d;
	const m = new BlobMeter(clock);
	const store = meteredStore(live.blob, m, clock);
	const crypto = meteredCrypto(live.crypto, m, clock);
	const gen = live.linkGen();
	const sha256 = async (b: Uint8Array): Promise<string> => bytesToHex(await d.hash.sha256(b));
	let failure: string | null = null;
	let error: string | null = null;
	try {
		// The plaintext is out of scope once stored: the download does not hold it too.
		const hash = await (async (): Promise<ContentHash> => {
			const bytes = d.random.bytes(size);
			const t0 = clock.monotonic();
			const h = (await sha256(bytes)) as ContentHash;
			m.hashMs = clock.monotonic() - t0;
			await putSealed(store, crypto, h, bytes, UNRECORDED, d.signal);
			return h;
		})();
		const got = await getOpened(store, crypto, hash, async (b) => {
			const t0 = clock.monotonic();
			const h = await sha256(b);
			m.verifyMs = clock.monotonic() - t0;
			return h;
		}, d.signal);
		if (!got.ok) failure = got.reason === "absent" ? "the blob just stored was not found" : `the downloaded blob failed its check: ${got.reason}`;
	} catch (e) {
		error = errorText(e);
		failure = live.linkGen() !== gen ? `${error} (the relay link was lost during the transfer)` : error;
	}
	const data: Data = { ...m.data(size), linkLost: live.linkGen() !== gen };
	if (failure !== null) return { status: "fail", detail: failure, data, error };
	if (m.uploadEvents === 0) {
		return {
			status: "fail", data,
			detail: `the upload sent no progress event: transfers restart their ${BLOB_TRANSFER_IDLE_MS / 1000} s idle window only on those, so an upload longer than that would be ended as stalled`,
		};
	}
	if (m.downloadChunks === 0) return { status: "fail", data, detail: "the download delivered no body chunk" };
	const up = m.uploadMs ?? 0;
	const down = m.downloadMs ?? 0;
	return {
		data,
		detail: `up ${msText(up)}${rate(m.sealedBytes ?? size, up)} (${m.uploadEvents} progress events, largest gap ${msText(m.maxProgressGapMs)}), `
			+ `down ${msText(down)}${rate(m.downloadBytes, down)} (${m.downloadChunks} chunks), hash ${msText(m.hashMs ?? 0)}, `
			+ `seal ${msText(m.sealMs ?? 0)}, open ${msText(m.openMs ?? 0)}, sha256 verified`,
	};
}

function limitsStep(d: DeviceCheckDeps): Outcome {
	const env = d.env();
	const heap = env?.jsHeap ?? null;
	const MiB = 1024 * 1024;
	const memory = [
		d.platform.deviceMemoryGiB === null && (env?.deviceMemoryGiB ?? null) === null
			? "device memory not exposed"
			: `device memory ${d.platform.deviceMemoryGiB ?? env?.deviceMemoryGiB} GiB`,
		heap ? `JS heap ${Math.round(heap.usedBytes / MiB)} MiB used of ${Math.round(heap.limitBytes / MiB)} MiB` : "performance.memory not exposed",
	].join("; ");
	const mem: Data = {
		hostDeviceMemoryGiB: d.platform.deviceMemoryGiB, engineDeviceMemoryGiB: env?.deviceMemoryGiB ?? null,
		jsHeapUsedBytes: heap?.usedBytes ?? null, jsHeapTotalBytes: heap?.totalBytes ?? null, jsHeapLimitBytes: heap?.limitBytes ?? null,
	};
	if (typeof d.live === "string") return { status: "fail", detail: `${d.live}; ${memory}`, data: mem };
	const live = d.live;
	const storeCap = live.blob?.maxBlobBytes ?? 0;
	const attachmentCap = Math.min(live.maxBlobBytes, live.maxAttachmentBytes);
	const blobs = live.blob === null
		? "no blob store: attachments do not sync"
		: `attachments up to ${sizeLabel(attachmentCap)} (blob store ${sizeLabel(storeCap)}, ${sizeLabel(live.maxBlobBytes)} of plaintext under suite ${live.crypto.suite})`;
	return {
		detail: `${blobs}; ${memory}`,
		data: {
			maxBlobBytes: live.maxBlobBytes, storeMaxBlobBytes: storeCap, maxAttachmentBytes: live.maxAttachmentBytes, attachmentCapBytes: attachmentCap,
			blobBytesInFlight: live.blobBytesInFlight, suite: live.crypto.suite, ...mem,
		},
	};
}

/** Runs the steps in order (each times itself; a throw fails only its own step) and builds the report. */
export async function runDeviceCheck(mode: DeviceCheckMode, d: DeviceCheckDeps): Promise<DeviceCheckReport> {
	const { clock } = d;
	const startedAtMs = clock.now();
	const t0 = clock.monotonic();
	const steps: DeviceCheckStep[] = [];
	const notes: string[] = [];
	const run = async (id: string, name: string, f: () => Outcome | Promise<Outcome>): Promise<void> => {
		steps.push(await step(clock, id, name, async () => f()));
	};
	const key = (bytes: number) => `${r1(bytes / 1e6)}mb`;
	const blobSizes: number[] = [];
	await run("engine", "Engine basics", () => engineStep(d));
	if (mode === "quick") {
		for (const size of DEVICE_CHECK_QUICK_BYTES) await run(`sha256-${key(size)}`, `SHA-256 ${sizeLabel(size)} (WebCrypto)`, () => hashStep(d, size));
		const largest = Math.max(...DEVICE_CHECK_QUICK_BYTES);
		await run(`seal-${key(largest)}`, `Seal and open ${sizeLabel(largest)} (AES-GCM)`, () => sealStep(d, largest));
		await run("relay-socket", "Relay socket round trip", () => socketStep(d));
		await run("relay-http", "Relay HTTP read", () => httpStep(d));
		for (const size of DEVICE_CHECK_QUICK_BYTES) {
			blobSizes.push(size);
			await run(`blob-${key(size)}`, `Blob round trip ${sizeLabel(size)}`, () => blobStep(d, size));
		}
	} else {
		const size = typeof d.live === "string" ? 0 : d.live.maxBlobBytes;
		blobSizes.push(size);
		await run("blob-max", size > 0 ? `Blob round trip at the max size (${sizeLabel(size)})` : "Blob round trip at the max size", () => blobStep(d, size));
	}
	await run("limits", "Memory and limits", () => limitsStep(d));
	const uploaded = steps.filter((s) => s.id.startsWith("blob-") && typeof s.data.sealedBytes === "number");
	if (uploaded.length > 0 && typeof d.live !== "string") {
		const days = Math.round(d.live.blobGcGraceMs / 86_400_000);
		notes.push(`The test blobs (${blobSizes.map(sizeLabel).join(", ")}) belong to no file. "Clean up unused server attachments" deletes them once they are older than ${days} day(s).`);
	}
	return { mode, clientVersion: d.clientVersion, startedAtMs, totalMs: r1(clock.monotonic() - t0), steps, notes };
}
