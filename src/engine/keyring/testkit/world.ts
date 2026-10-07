/**
 * Test-only: fake vault keys, record authors and keyring devices for the WP-E3 tests. The keys are fixed
 * byte ranges (not secrets); records are built by the real adapter and buildKeyRecord.
 */

import { SeededRandom } from "../../../sim/random";
import type { Seq } from "../../../core/types";
import { createWebCryptoSuite1, type Suite1Crypto } from "../../adapters/webCryptoSuite1";
import { buildKeyRecord } from "../build";
import { Keyring, type KeyringChange, type KeyringMode } from "../keyring";
import { KeyRecordKind } from "../record";

export const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const range = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);
/** Honest K_e for e = 1..6, and forged ones (the revoked device's own choice). */
export const K = (e: number): Uint8Array => range(e * 0x20, 32);
export const FORGED = (e: number): Uint8Array => range(0x80 + e * 0x11, 32);
export const RK_A = range(0x40, 35);
export const RK_B = range(0xa0, 35);

let seed = 1;
const random = () => new SeededRandom(seed++);

/** Builds records as the device holding `keys` would (raw keys retained: the author never sets a seal epoch). */
export async function record(kind: KeyRecordKind, e: number, keys: readonly { readonly e: number; readonly k: Uint8Array }[], rk?: Uint8Array, vaultId = VAULT): Promise<Uint8Array> {
	const c = await createWebCryptoSuite1({ vaultId, random: random(), keys: keys.map((x) => ({ e: x.e, k: x.k.slice() })) });
	return buildKeyRecord(c, vaultId, e, kind, rk?.slice());
}

export const genesis = (rk = RK_A, k1 = K(1)) => record(KeyRecordKind.genesis, 1, [{ e: 1, k: k1 }], rk);
/** The genesis of K(1) under RK_A for another vault (the sim's SIM_VAULT_ID). */
export const genesisFor = (vaultId: string, rk = RK_A, k1 = K(1)) => record(KeyRecordKind.genesis, 1, [{ e: 1, k: k1 }], rk, vaultId);
export const roll = (e: number, prev = K(e - 1), next = K(e)) => record(KeyRecordKind.roll, e, [{ e: e - 1, k: prev }, { e, k: next }]);
export const revoke = (e: number, rk = RK_A, prev = K(e - 1), next = K(e)) => record(KeyRecordKind.revoke, e, [{ e: e - 1, k: prev }, { e, k: next }], rk);

export interface Device {
	readonly kr: Keyring;
	readonly kc: Suite1Crypto;
	readonly changes: KeyringChange[];
	readonly diags: { readonly code: string; readonly fields: Record<string, unknown> }[];
	seenCalls: number;
	/** Set to make the next persist calls reject. */
	failPersist: boolean;
	/** Seal epoch observed inside each persist call (persist-before-use). */
	readonly sealAtPersist: number[];
	ingest(...rows: readonly (readonly [Seq, Uint8Array])[]): Promise<void>;
	codes(prefix?: string): string[];
}

export async function device(o: {
	readonly mode?: KeyringMode;
	readonly keys?: readonly { readonly e: number; readonly k: Uint8Array }[];
	readonly records?: readonly Uint8Array[];
	readonly keyringSeen?: boolean;
} = {}): Promise<Device> {
	const kc = await createWebCryptoSuite1({ vaultId: VAULT, random: random(), keys: (o.keys ?? []).map((x) => ({ e: x.e, k: x.k.slice() })) });
	const d: Partial<Device> & { changes: KeyringChange[]; diags: Device["diags"]; sealAtPersist: number[]; seenCalls: number; failPersist: boolean } = {
		kc, changes: [], diags: [], sealAtPersist: [], seenCalls: 0, failPersist: false,
	};
	const mode = o.mode ?? "suite1";
	const kr = await Keyring.open({
		mode, vaultId: VAULT, kc: mode === "suite0" ? null : kc, records: o.records, keyringSeen: o.keyringSeen,
		persist: async (c) => {
			d.sealAtPersist.push(kc.sealEpoch());
			if (d.failPersist) throw new Error("disk full");
			d.changes.push(c);
		},
		diag: (code, fields) => d.diags.push({ code, fields }),
		onKeyringSeen: () => d.seenCalls++,
	});
	return Object.assign(d, {
		kr,
		ingest: (...rows: readonly (readonly [Seq, Uint8Array])[]) => kr.ingest(rows.map(([seq, bytes]) => ({ seq, bytes }))),
		codes: (prefix = "keyring/") => d.diags.map((x) => x.code).filter((c) => c.startsWith(prefix)),
	}) as Device;
}

/** kcv-free identity check: does the device hold exactly `k` for e? (install answers "same" without replacing a verified key.) */
export async function holds(d: Device, e: number, k: Uint8Array): Promise<boolean> {
	if (!d.kc.keyState(e).verified) return false;
	return (await d.kc.install(e, k.slice())) === "same";
}

/** The epochs handed to the host, in order, over every persist call. */
export const persistedEpochs = (d: Device): number[] => d.changes.flatMap((c) => c.keys.map((x) => x.e));
