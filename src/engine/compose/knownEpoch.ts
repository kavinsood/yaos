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
import { DB_NAME_PREFIX } from "../store/schema";

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
