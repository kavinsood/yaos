/**
 * Offline start (DESIGN §e.1): the vaultEpoch of an existing local DB for this
 * vault + device, read from the database names (`yaos2:<vaultId>:<epoch>:<deviceId>`).
 *
 * Exactly one candidate -> that epoch (LogEngine opens it without connecting).
 * None, or several (an epoch migration did not finish retiring the old DB) ->
 * undefined: connect first and let the relay say which epoch is current.
 */

import type { DeviceId, VaultEpoch, VaultId } from "../../core/types";
import type { StoragePort } from "../../ports/storage";
import type { KeyringRecords } from "../keyring/keyring";
import type { YS } from "../store/repo";
import { DB_NAME_PREFIX, DB_SCHEMA_VERSION, STORE, STORE_SPECS } from "../store/schema";

export function parseDbName(name: string): { vaultId: string; vaultEpoch: string; deviceId: string } | null {
	const parts = name.split(":");
	if (parts.length !== 4 || parts[0] !== DB_NAME_PREFIX) return null;
	try {
		return { vaultId: decodeURIComponent(parts[1]!), vaultEpoch: decodeURIComponent(parts[2]!), deviceId: decodeURIComponent(parts[3]!) };
	} catch {
		return null;
	}
}

export async function findKnownEpoch(storage: StoragePort, vaultId: VaultId, deviceId: DeviceId): Promise<VaultEpoch | undefined> {
	let names: readonly string[];
	try {
		names = await storage.listDatabases();
	} catch {
		return undefined;
	}
	const epochs = new Set<string>();
	for (const n of names) {
		const p = parseDbName(n);
		if (p && p.vaultId === vaultId && p.deviceId === deviceId && p.vaultEpoch.length > 0) epochs.add(p.vaultEpoch);
	}
	return epochs.size === 1 ? ([...epochs][0] as VaultEpoch) : undefined;
}

/**
 * The keyring records a DB of this vault + device keeps (MetaKeyringRecords, e2ee-design §6.1), for a suite-1 start
 * whose SecretStorage holds none. Every epoch's DB is read: a device left key-missing never migrates (its key reader
 * has no store), so the copy may sit in an old epoch's DB. The copy whose newest winner is highest is taken (the
 * records are the vault's, not an epoch's: §11.5 re-publishes them verbatim). null: none, or no storage.
 */
export async function storedKeyringRecords(storage: StoragePort, vaultId: VaultId, deviceId: DeviceId): Promise<KeyringRecords | null> {
	let names: readonly string[];
	try {
		names = await storage.listDatabases();
	} catch {
		return null;
	}
	let best: { readonly r: KeyringRecords; readonly top: number } | null = null;
	for (const n of names) {
		const p = parseDbName(n);
		if (!p || p.vaultId !== vaultId || p.deviceId !== deviceId) continue;
		try {
			const db = await storage.open<YS>(n, DB_SCHEMA_VERSION, STORE_SPECS);
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
