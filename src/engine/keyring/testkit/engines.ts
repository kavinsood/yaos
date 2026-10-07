/**
 * Test-only: keyring engines over SimRelay for the WP-E3 engine tests. `start` plays main's part: it hands the
 * pin and stored keys in (init.crypto, §18.4) and records every keyringChanged; a restart with the stored keys and
 * records stands in for main restarting the engine. A LogEngine runs for a pinned device only: unpinned devices
 * and the creation path are the compose layer's KeyReader (compose/keyReader.test.ts).
 */

import type { EnvelopeKind } from "../../../core/envelope";
import { type ClientFrameId, type DeviceId, type StreamName, type VaultId } from "../../../core/types";
import type { StoragePort } from "../../../ports/storage";
import type { SimRelay } from "../../../sim/relay";
import { createWebCryptoSuite1 } from "../../adapters/webCryptoSuite1";
import { createWebRandom } from "../../adapters/webRandom";
import type { LogEngine } from "../../runtime/engine";
import type { EngineTuning } from "../../runtime/options";
import { sealFrame } from "../../ingest/envelope";
import { startTestEngine, until, type TestEngineOpts } from "../../runtime/testHarness";
import type { KeyringChange } from "../keyring";
import type { EngineE2ee } from "../keyringRuntime";
import { K, VAULT } from "./world";

let raw = 0;
export const RAW_DEVICE = "dev-raw" as DeviceId;
/** A row appended by some other party (a hostile relay, or a device the test does not run); `payload` may be sealed for its frame id. */
export async function rawAppend(relay: SimRelay, stream: StreamName, payload: Uint8Array | ((cf: ClientFrameId) => Promise<Uint8Array>)): Promise<number> {
	const clientFrameId = `raw${++raw}`.padEnd(22, "A") as ClientFrameId;
	const bytes = typeof payload === "function" ? await payload(clientFrameId) : payload;
	const r = await relay.connect({ vaultId: VAULT as VaultId, deviceId: RAW_DEVICE });
	if (!r.ok) throw new Error(`connect: ${r.reason}`);
	const s = r.session;
	const seq = await new Promise<number>((resolve, reject) => {
		s.onEvent((ev) => {
			if (ev.t === "receipt") resolve(ev.seq);
			else if (ev.t === "refused") reject(new Error(ev.reason));
		});
		s.append({ stream, clientFrameId, payload: bytes });
	});
	s.close(1000, "done");
	return seq;
}

/** A frame RAW_DEVICE seals under the testkit's K_e: what a revoked device can still do with the keys below r (§14.4). */
export async function oldEpochFrame(relay: SimRelay, stream: StreamName, e: number, kind: EnvelopeKind, content: Uint8Array, frameNo = 0): Promise<number> {
	const kc = await createWebCryptoSuite1({ vaultId: VAULT, random: createWebRandom(), keys: [{ e, k: K(e) }] });
	kc.markVerified(e);
	kc.setSealEpoch(e);
	return rawAppend(relay, stream, async (clientFrameId) =>
		(await sealFrame(kc, VAULT as VaultId, { stream, deviceId: RAW_DEVICE, clientFrameId, kind, authorNsSeq: 0, flags: 0, frameNo, content })).sealed);
}

export interface Dev {
	readonly engine: LogEngine;
	readonly storage: StoragePort;
	/** Every keyringChanged, keys copied (the engine zero-fills nothing here; main would store them). */
	readonly changes: KeyringChange[];
}

export type Pin = 0 | { readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; readonly records: readonly Uint8Array[] };

export async function start(relay: SimRelay, deviceId: string, pin: Pin, o: { storage?: StoragePort; tuning?: Partial<EngineTuning>; extra?: TestEngineOpts["extra"] } = {}): Promise<Dev> {
	const changes: KeyringChange[] = [];
	const persist = async (ch: KeyringChange) => void changes.push({ keys: ch.keys.map((x) => ({ e: x.e, k: x.k.slice() })), records: ch.records, pending: ch.pending });
	const e2ee: EngineE2ee = pin === 0 ? { suite: 0 } : { suite: 1, records: pin.records, persist };
	const keys = pin === 0 ? [] : pin.keys.map((x) => ({ e: x.e, k: x.k.slice() }));
	const crypto = pin === 0 ? undefined : await createWebCryptoSuite1({ vaultId: VAULT, random: createWebRandom(), keys });
	const r = await startTestEngine({ relay, deviceId, vaultId: VAULT, e2ee, ...(crypto ? { crypto } : {}), ...(o.storage ? { storage: o.storage } : {}), ...(o.tuning ? { tuning: o.tuning } : {}), ...(o.extra ? { extra: o.extra } : {}) });
	return { engine: r.engine, storage: r.storage, changes };
}

/** What main stored from keyringChanged: every key once, the newest record set (§18.4). */
export function stored(d: Dev, before: Exclude<Pin, 0> = { keys: [], records: [] }): Exclude<Pin, 0> {
	const keys = new Map<number, Uint8Array>(before.keys.map((x) => [x.e, x.k]));
	for (const c of d.changes) for (const x of c.keys) keys.set(x.e, x.k);
	const records = d.changes[d.changes.length - 1]?.records ?? before.records;
	return { keys: [...keys].map(([e, k]) => ({ e, k })), records };
}

export const keyMissing = (d: Dev) => d.engine.status().e2ee?.keyMissing ?? null;
export const ownRows = (relay: SimRelay, deviceId: string) => relay.streams().flatMap((s) => relay.rows(s)).filter((r) => r.deviceId === deviceId).length;

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
