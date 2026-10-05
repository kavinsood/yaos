/**
 * Test harness for LogEngine (tests and e2e scripts only; not imported by
 * engine code). Real web clock / hash / random adapters (Node globals), suite-0
 * crypto with a switchable "unknown key" fault, in-memory storage stand-in.
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
import { MemStoragePort } from "../sync/__standins__/memStorage";
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
}

export function testPorts(relay: RelayPort, storage: StoragePort, crypto: CryptoPort | null = null): EnginePorts {
	const hash = createWebHash();
	return { relay, storage, clock: createWebClock(), random: createWebRandom(), crypto: crypto ?? createNoopCrypto(hash), hash, blob: null };
}

export async function startTestEngine(o: TestEngineOpts): Promise<{ engine: LogEngine; storage: StoragePort }> {
	const storage = o.storage ?? new MemStoragePort();
	const engine = await LogEngine.start({
		ports: testPorts(o.relay, storage, o.crypto ?? null),
		vaultId: (o.vaultId ?? "vault-test") as VaultId,
		deviceId: o.deviceId as DeviceId,
		clientVersion: "test",
		sideFiles: o.sideFiles ?? null,
		tuning: { ...FAST_TUNING, ...(o.tuning ?? {}) },
		...(o.extra ?? {}),
	});
	return { engine, storage };
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `pred` holds (or throw after timeoutMs). */
export async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 5_000, what = "condition"): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await pred()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

/** Every engine idle, and their doc lists / texts equal. */
export async function converged(engines: readonly LogEngine[], timeoutMs = 8_000): Promise<void> {
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
	}, timeoutMs, "convergence");
}
