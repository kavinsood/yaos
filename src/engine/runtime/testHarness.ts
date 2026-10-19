/**
 * Test harness for LogEngine (tests and e2e scripts only; not imported by
 * engine code). Real web clock / hash / random adapters (Node globals), suite-0
 * crypto with a switchable "unknown key" fault, in-memory storage stand-in.
 *
 * Deterministic mode: pass a VirtualClock as `clock` to startTestEngine and to
 * until / sleep / converged / drive, and build the SimRelay with the same
 * clock (`new SimRelay({ clock })`). The engine then gets the virtual clock, a
 * seeded random, the microtask sha256 and storage whose idle check runs before
 * every timer; virtual time only moves inside until / sleep / drive, so any
 * engine call that may wait on a timer (start, stop, flush) must go through
 * drive().
 *
 * Authoring: createDoc / renameDoc / deleteDoc / editDoc / docText drive an
 * engine the way a test wants to, without the host's reconciler (production
 * authors through submitNs and openBody).
 */

import type * as Y from "yjs";
import { EnvelopeFlag } from "../../core/envelope";
import { newDocId } from "../../core/codec/ids";
import { bytesToHex, utf8Encode } from "../../core/codec/lib0";
import { docStream, kindOfPath, type ContentHash, type DeviceId, type DocId, type DocKind, type VaultId, type VaultPath } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { CryptoPort } from "../../ports/crypto";
import type { RelayPort } from "../../ports/relay";
import type { StoragePort } from "../../ports/storage";
import type { SideFileName, SideFilePort } from "../../ports/vault";
import { createNoopCrypto } from "../adapters/noopCrypto";
import type { EngineE2ee } from "../keyring/keyringRuntime";
import { createWebClock } from "../adapters/webClock";
import { createWebHash } from "../adapters/webHash";
import { createWebRandom } from "../adapters/webRandom";
import { buildBodyFrames, initialTextUpdates } from "../body/frames";
import { ORIGIN } from "../body/yjsCounters";
import type { VirtualClock } from "../../sim/clock";
import { hashLabel, SeededRandom } from "../../sim/random";
import { MemStoragePort } from "../../sim/storage";
import { simHashPort } from "../../sim/hash";
import { LogEngine } from "./engine";
import { submitNs } from "./logApi";
import type { EngineOptions, EngineTuning } from "./options";
import { retryReaderQuarantine } from "./quarantineRelease";

/** Timers shrunk so multi-engine tests settle in well under a second. */
export const FAST_TUNING: Partial<EngineTuning> = {
	frameStretch: 0.02,
	maintenanceMs: 25,
	gapMs: 150,
	statusIntervalMs: 50,
	mirrorDebounceMs: 10,
	provisionalAdoptMs: 400,
	causalRetryMs: 60,
	causalRetries: 2,
	readBackoffMs: 50,
	reconnectBaseMs: 20,
	refRetryMs: 50,
	refRetryMaxMs: 400,
	subscribeDebounceMs: 20,
	// Skipped streams are read at once: tests that wait for isIdle() need no deferral (subscriptions.ts).
	skipSettleMs: 0,
	skipMaxDeferMs: 0,
};

export interface FaultyCrypto extends CryptoPort {
	/** While true, open() of frames sealed by `faultyFor` (or every frame) fails "unknown-key". */
	failOpen: boolean;
}

export function faultyCrypto(): FaultyCrypto {
	const base = createNoopCrypto(createWebHash());
	const c: FaultyCrypto = {
		...base,
		failOpen: false,
		async open(input) {
			if (c.failOpen) return { ok: false, reason: "unknown-key" };
			return base.open(input);
		},
	};
	return c;
}

export class MemSideFiles implements SideFilePort {
	readonly files = new Map<string, Uint8Array>();
	writes = 0;
	async read(name: SideFileName): Promise<Uint8Array | null> {
		return this.files.get(name)?.slice() ?? null;
	}
	async write(name: SideFileName, bytes: Uint8Array): Promise<void> {
		this.writes++;
		this.files.set(name, bytes.slice());
	}
	async remove(name: SideFileName): Promise<void> {
		this.files.delete(name);
	}
	async list(prefix: "snapshots/"): Promise<readonly SideFileName[]> {
		return [...this.files.keys()].filter((k) => k.startsWith(prefix)) as SideFileName[];
	}
}

export interface TestEngineOpts {
	readonly relay: RelayPort;
	readonly deviceId: string;
	readonly vaultId?: string;
	readonly storage?: StoragePort;
	readonly crypto?: CryptoPort;
	readonly sideFiles?: SideFilePort | null;
	readonly tuning?: Partial<EngineTuning>;
	readonly extra?: Partial<EngineOptions>;
	/** The pin (e2ee-design §12.4). Default: suite 0, which only the suite-0 (noop) crypto port can run. */
	readonly e2ee?: EngineE2ee;
	/** Deterministic mode (see the header). The relay must run on the same clock. */
	readonly clock?: VirtualClock;
}

export function testPorts(relay: RelayPort, storage: StoragePort, crypto: CryptoPort | null = null, clock?: VirtualClock, seed = 1): EnginePorts {
	if (clock) {
		const hash = simHashPort();
		return { relay, storage, clock, random: new SeededRandom(seed), crypto: crypto ?? createNoopCrypto(hash), hash, blob: null };
	}
	const hash = createWebHash();
	return { relay, storage, clock: createWebClock(), random: createWebRandom(), crypto: crypto ?? createNoopCrypto(hash), hash, blob: null };
}

/** Storage for a test engine: in clock mode the idle check also runs before every virtual timer. */
export function testStorage(clock?: VirtualClock): MemStoragePort {
	return new MemStoragePort(clock ? { beforeNextTimer: clock.beforeNextTimer } : {});
}

/** Engines started per virtual clock: a restarted device must not replay its random ids (frame ids would collide). */
const starts = new WeakMap<VirtualClock, number>();

export async function startTestEngine(o: TestEngineOpts): Promise<{ engine: LogEngine; storage: StoragePort }> {
	const storage = o.storage ?? testStorage(o.clock);
	let seed = 1;
	if (o.clock) {
		const n = (starts.get(o.clock) ?? 0) + 1;
		starts.set(o.clock, n);
		seed = hashLabel(`${o.deviceId}#${n}`);
	}
	const engine = await drive(LogEngine.start({
		ports: testPorts(o.relay, storage, o.crypto ?? null, o.clock, seed),
		vaultId: (o.vaultId ?? "vault-test") as VaultId,
		deviceId: o.deviceId as DeviceId,
		clientVersion: "test",
		sideFiles: o.sideFiles ?? null,
		tuning: { ...FAST_TUNING, ...(o.tuning ?? {}) },
		e2ee: o.e2ee ?? { suite: 0 },
		...(o.extra ?? {}),
	}), o.clock);
	return { engine, storage };
}

/** Real clock: setTimeout. Virtual clock: advance virtual time by ms. */
export function sleep(ms: number, clock?: VirtualClock): Promise<void> {
	if (clock) return clock.advance(ms);
	return new Promise((r) => setTimeout(r, ms));
}

/** Await `p`; with a virtual clock, run the clock until p settles (throws after horizonMs of virtual time). */
export async function drive<T>(p: Promise<T>, clock?: VirtualClock, horizonMs = 60_000, what = "promise"): Promise<T> {
	if (!clock) return p;
	let settled = false;
	p.then(() => (settled = true), () => (settled = true));
	if (!(await clock.runUntil(() => settled, horizonMs))) throw new Error(`timed out (virtual ${horizonMs} ms) waiting for ${what}`);
	return p;
}

/**
 * Poll until `pred` holds (or throw after timeoutMs). Real clock: every 10 ms.
 * Virtual clock: after every timer (clock.runUntil; an async pred is awaited
 * between steps), timeoutMs of virtual time.
 */
export async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 5_000, what = "condition", clock?: VirtualClock): Promise<void> {
	if (clock) {
		const end = clock.monotonic() + timeoutMs;
		for (;;) {
			await clock.settleMicrotasks();
			if (await pred()) return;
			if (!(await clock.step(end))) {
				await clock.settleMicrotasks();
				if (await pred()) return;
				throw new Error(`timed out (virtual ${timeoutMs} ms) waiting for ${what}`);
			}
		}
	}
	const start = Date.now();
	for (;;) {
		if (await pred()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

/** Every engine idle, and their doc lists / texts equal. */
export async function converged(engines: readonly LogEngine[], timeoutMs = 8_000, clock?: VirtualClock): Promise<void> {
	await until(async () => {
		for (const e of engines) if (!e.isIdle()) return false;
		const sig = async (e: LogEngine) => {
			const docs = e.listDocs().filter((d) => d.state === "live").sort((a, b) => (a.docId < b.docId ? -1 : 1));
			const parts: string[] = [];
			for (const d of docs) parts.push(`${d.docId}|${d.path}|${await docText(e, d.docId)}`);
			return parts.join("\n");
		};
		const first = await sig(engines[0]!);
		for (const e of engines.slice(1)) if ((await sig(e)) !== first) return false;
		return true;
	}, timeoutMs, "convergence", clock);
}

// ---------------------------------------------------------------- authoring

/** A create and its initial body frames, committed in one T_edit. */
export async function createDoc(e: LogEngine, path: VaultPath, text: string, kind: DocKind = kindOfPath(path)): Promise<DocId> {
	const c = e.c;
	if (kind === "blob") throw new Error("blob docs are not handled by the log engine");
	c.assertWritable();
	if (e.listDocs().some((d) => d.path === path && (d.state === "live" || d.state === "pending"))) throw new Error(`path exists: ${path}`);
	const docId = newDocId(c.ports.random);
	const stream = docStream(kind, docId)!;
	const bytes = utf8Encode(text);
	const contentHash = bytesToHex(await c.ports.hash.sha256(bytes)) as ContentHash;
	const h = await c.handles.acquire(stream);
	try {
		await submitNs(c, [{ t: "create", docId, kind, path, contentHash, size: bytes.length }], async ([nsFrame]) => {
			const frames = [];
			if (kind === "markdown" && text.length > 0) {
				for (const u of initialTextUpdates(h.doc, text)) {
					frames.push(...await buildBodyFrames(c.deps, { stream, content: u, flags: EnvelopeFlag.initial, authorNsSeq: c.ns.coversSeq, dependsOn: nsFrame!.clientFrameId, nowMs: c.now() }));
				}
			}
			return frames;
		});
	} catch (err) {
		c.handles.unpin(h);
		c.handles.drop(stream);
		throw err;
	}
	c.handles.unpin(h);
	return docId;
}

export async function renameDoc(e: LogEngine, docId: DocId, path: VaultPath): Promise<void> {
	await e.submitNs([{ t: "rename", docId, path }]);
}

export async function deleteDoc(e: LogEngine, docId: DocId): Promise<void> {
	const rec = e.c.repo.stream(e.streamOf(docId));
	await e.submitNs([{ t: "delete", docId, baseBodySeq: Math.max(rec?.appliedSeq ?? 0, rec?.lastOwnSeq ?? 0) }]);
}

/** Disk-merge style edit: one MERGE transaction, frame closed at once. */
export async function editDoc(e: LogEngine, docId: DocId, fn: (text: Y.Text, doc: Y.Doc) => void): Promise<void> {
	const c = e.c;
	const stream = e.streamOf(docId);
	if (c.repo.stream(stream)?.frozen) throw new Error(`doc frozen: ${c.repo.stream(stream)?.frozenReason}`);
	c.assertWritable();
	const h = await c.handles.acquire(stream);
	try {
		h.doc.transact(() => fn(h.doc.getText("text"), h.doc), ORIGIN.MERGE);
		await c.docs.closeFrame(h);
	} finally {
		c.handles.unpin(h);
	}
}

/** The doc's replica text (loads it). */
export async function docText(e: LogEngine, docId: DocId): Promise<string> {
	const h = await e.c.handles.load(e.streamOf(docId));
	return h.doc.getText("text").toString();
}

/** The retry of reader-dependent quarantine that runs after every session start, run now. */
export function retryQuarantine(e: LogEngine): Promise<number> {
	return retryReaderQuarantine(e.c);
}
