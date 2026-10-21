/**
 * Offline start (DESIGN §e.1): the vaultEpoch of an existing store of this vault and install, read from the
 * database names (`yaos3:<vaultId>:<epoch>:<installKey>`, identity-per-store §2.4).
 *
 * Exactly one candidate -> that epoch (LogEngine opens it without connecting).
 * None, or several (an epoch migration did not finish retiring the old DB) ->
 * undefined: connect first and let the relay say which epoch is current.
 */

import type { VaultEpoch, VaultId } from "../../core/types";
import type { StoragePort } from "../../ports/storage";
import type { KeyringRecords } from "../keyring/keyring";
import type { YS } from "../store/repo";
import { DB_NAME_PREFIX, DB_SCHEMA_VERSION, STORE, STORE_SPECS } from "../store/schema";

/** A `yaos3:` store name's parts; null for any other name (the legacy `yaos2:` layout included). */
export function parseDbName(name: string): { vaultId: string; vaultEpoch: string; storeKey: string } | null {
	const parts = name.split(":");
	if (parts.length !== 4 || parts[0] !== DB_NAME_PREFIX) return null;
	try {
		return { vaultId: decodeURIComponent(parts[1]!), vaultEpoch: decodeURIComponent(parts[2]!), storeKey: decodeURIComponent(parts[3]!) };
	} catch {
		return null;
	}
}

/** This vault and install's store DBs, by epoch (throws when the origin cannot list its databases). */
export async function storeDbs(storage: StoragePort, vaultId: VaultId, storeKey: string): Promise<{ readonly name: string; readonly vaultEpoch: VaultEpoch }[]> {
	const out: { name: string; vaultEpoch: VaultEpoch }[] = [];
	for (const n of await storage.listDatabases()) {
		const p = parseDbName(n);
		if (p && p.vaultId === vaultId && p.storeKey === storeKey && p.vaultEpoch.length > 0) out.push({ name: n, vaultEpoch: p.vaultEpoch as VaultEpoch });
	}
	return out;
}

export async function findKnownEpoch(storage: StoragePort, vaultId: VaultId, storeKey: string): Promise<VaultEpoch | undefined> {
	let dbs: { readonly vaultEpoch: VaultEpoch }[];
	try {
		dbs = await storeDbs(storage, vaultId, storeKey);
	} catch {
		return undefined;
	}
	const epochs = new Set(dbs.map((d) => d.vaultEpoch));
	return epochs.size === 1 ? [...epochs][0] : undefined;
}

/**
 * The keyring records a store of this vault and install keeps (MetaKeyringRecords, e2ee-design §6.1), for a suite-1
 * start whose SecretStorage holds none. Every epoch's DB is read: a device left key-missing never migrates (its key
 * reader has no store), so the copy may sit in an old epoch's DB. The copy whose newest winner is highest is taken
 * (the records are the vault's, not an epoch's: §11.5 re-publishes them verbatim). null: none, or no storage.
 */
export async function storedKeyringRecords(storage: StoragePort, vaultId: VaultId, storeKey: string): Promise<KeyringRecords | null> {
	let dbs: { readonly name: string }[];
	try {
		dbs = await storeDbs(storage, vaultId, storeKey);
	} catch {
		return null;
	}
	let best: { readonly r: KeyringRecords; readonly top: number } | null = null;
	for (const { name } of dbs) {
		try {
			const db = await storage.open<YS>(name, DB_SCHEMA_VERSION, STORE_SPECS);
			try {
				const m = await db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "keyringRecords"));
				if (m?.key !== "keyringRecords" || m.winners.length + m.open.length === 0) continue;
				const top = m.winners.length;
				if (!best || top > best.top) best = { r: { winners: m.winners, open: m.open }, top };
			} finally {
				db.close();
			}
		} catch {
			// An unreadable DB holds no usable copy.
		}
	}
	return best?.r ?? null;
}
