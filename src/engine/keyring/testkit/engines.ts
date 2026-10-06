/**
 * Test-only: keyring engines over SimRelay for the WP-E3 engine tests. `start` plays main's part: it hands the
 * pin and stored keys in (init.crypto, §18.4) and records every keyringChanged; a restart with the stored keys and
 * records stands in for main pinning and restarting the engine (§12.4).
 */

import { type ClientFrameId, type DeviceId, type StreamName, type VaultId } from "../../../core/types";
import type { StoragePort } from "../../../ports/storage";
import type { SimRelay } from "../../../sim/relay";
import { createWebCryptoSuite1 } from "../../adapters/webCryptoSuite1";
import { createWebRandom } from "../../adapters/webRandom";
import type { LogEngine } from "../../runtime/engine";
import type { EngineTuning } from "../../runtime/options";
import { startTestEngine, until } from "../../runtime/testHarness";
import type { KeyringChange } from "../keyring";
import type { EngineE2ee } from "../keyringRuntime";
import { VAULT } from "./world";

let raw = 0;
/** A row appended by some other party (a hostile relay, or a device the test does not run). */
export async function rawAppend(relay: SimRelay, stream: StreamName, payload: Uint8Array): Promise<number> {
	const r = await relay.connect({ vaultId: VAULT as VaultId, deviceId: "dev-raw" as DeviceId });
	if (!r.ok) throw new Error(`connect: ${r.reason}`);
	const s = r.session;
	const seq = await new Promise<number>((resolve, reject) => {
		s.onEvent((ev) => {
			if (ev.t === "receipt") resolve(ev.seq);
			else if (ev.t === "refused") reject(new Error(ev.reason));
		});
		s.append({ stream, clientFrameId: `raw-${++raw}` as ClientFrameId, payload });
	});
	s.close(1000, "done");
	return seq;
}

export interface Dev {
	readonly engine: LogEngine;
	readonly storage: StoragePort;
	/** Every keyringChanged, keys copied (the engine zero-fills nothing here; main would store them). */
	readonly changes: KeyringChange[];
}

export type Pin = "unpinned" | "creating" | "seen" | 0 | { readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; readonly records: readonly Uint8Array[] };

export async function start(relay: SimRelay, deviceId: string, pin: Pin, o: { storage?: StoragePort; tuning?: Partial<EngineTuning> } = {}): Promise<Dev> {
	const changes: KeyringChange[] = [];
	const persist = async (ch: KeyringChange) => void changes.push({ keys: ch.keys.map((x) => ({ e: x.e, k: x.k.slice() })), records: ch.records, pending: ch.pending });
	const e2ee: EngineE2ee = pin === 0 ? { suite: 0 }
		: typeof pin === "object" ? { suite: 1, records: pin.records, persist }
		: { suite: null, creating: pin === "creating", keyringSeen: pin === "seen", persist };
	const keys = typeof pin === "object" ? pin.keys.map((x) => ({ e: x.e, k: x.k.slice() })) : [];
	const crypto = pin === 0 ? undefined : await createWebCryptoSuite1({ vaultId: VAULT, random: createWebRandom(), keys });
	const r = await startTestEngine({ relay, deviceId, vaultId: VAULT, e2ee, ...(crypto ? { crypto } : {}), ...(o.storage ? { storage: o.storage } : {}), ...(o.tuning ? { tuning: o.tuning } : {}) });
	return { engine: r.engine, storage: r.storage, changes };
}

/** What main stored from keyringChanged: every key once, the newest record set (§18.4). */
export function stored(d: Dev, before: Pin = "unpinned"): Exclude<Pin, string | 0> {
	const keys = new Map<number, Uint8Array>(typeof before === "object" ? before.keys.map((x) => [x.e, x.k]) : []);
	for (const c of d.changes) for (const x of c.keys) keys.set(x.e, x.k);
	const records = d.changes[d.changes.length - 1]?.records ?? (typeof before === "object" ? before.records : []);
	return { keys: [...keys].map(([e, k]) => ({ e, k })), records };
}

export const keyMissing = (d: Dev) => d.engine.status().e2ee?.keyMissing ?? null;
export const ownRows = (relay: SimRelay, deviceId: string) => relay.streams().flatMap((s) => relay.rows(s)).filter((r) => r.deviceId === deviceId).length;
export const checkpoints = (relay: SimRelay) => relay.streams().filter((s) => relay.checkpoint(s) !== null).length;

/** Waits until the device read `k` on its session and parked in key-missing for `reason`. */
export async function parked(d: Dev, reason: string): Promise<void> {
	await until(() => d.engine.status().phase === "key-missing" && keyMissing(d) === reason && d.engine.isIdle(), 5_000, `key-missing ${reason}`);
}

export async function live(d: Dev): Promise<void> {
	await until(() => d.engine.status().phase === "live", 5_000, "live");
}

/** Whether `needle` occurs in `hay` (plaintext leak checks). */
export function contains(hay: Uint8Array, needle: Uint8Array): boolean {
	outer: for (let i = 0; i + needle.length <= hay.length; i++) {
		for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}
