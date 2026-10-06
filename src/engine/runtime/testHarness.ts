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
 */

import type { DeviceId, VaultId } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { CryptoPort } from "../../ports/crypto";
import type { RelayPort } from "../../ports/relay";
import type { StoragePort } from "../../ports/storage";
import type { SideFileName, SideFilePort } from "../../ports/vault";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebClock } from "../adapters/webClock";
import { createWebHash } from "../adapters/webHash";
import { createWebRandom } from "../adapters/webRandom";
import type { VirtualClock } from "../../sim/clock";
import { hashLabel, SeededRandom } from "../../sim/random";
import { MemStoragePort } from "../../sim/storage";
import { simHashPort } from "../../sim/hash";
import { LogEngine } from "./engine";
import type { EngineOptions, EngineTuning } from "./options";

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
			for (const d of docs) parts.push(`${d.docId}|${d.path}|${await e.docText(d.docId)}`);
			return parts.join("\n");
		};
		const first = await sig(engines[0]!);
		for (const e of engines.slice(1)) if ((await sig(e)) !== first) return false;
		return true;
	}, timeoutMs, "convergence", clock);
}
