/**
 * Builds a k record from keys the adapter holds (e2ee-design §11.1, §11.4, §14.2, §15.1).
 * Wraps are made in field order (next, prev, recovery), so a scripted RandomPort sees nonces in that order.
 */

import type { KeyringCrypto } from "../../ports/crypto";
import { KeyRecordKind, encodeKeyRecord, newKeyRecord, wrapAad, wrapsOf } from "./record";

/**
 * genesis needs K_e and the RK; roll needs K_{e−1} and K_e (raw K_{e−1} retained); revoke needs K_{e−1}, K_e
 * and the RK. The RK is used only for the recovery wrap and is not kept.
 */
export async function buildKeyRecord(kc: KeyringCrypto, vaultId: string, e: number, kind: KeyRecordKind, rk?: Uint8Array): Promise<Uint8Array> {
	const kcv = await kc.kcv(e);
	const head = { e, kind, prevEpoch: kind === KeyRecordKind.genesis ? 0 : e - 1, kcv };
	const has = wrapsOf(kind);
	const next = has.next ? await kc.wrap("next", e, wrapAad(vaultId, head, "next")) : undefined;
	const prev = has.prev ? await kc.wrap("prev", e, wrapAad(vaultId, head, "prev")) : undefined;
	const recovery = has.recovery ? await kc.wrap("recovery", e, wrapAad(vaultId, head, "recovery"), rk) : undefined;
	return encodeKeyRecord(newKeyRecord(e, kind, kcv, { next, prev, recovery }));
}
