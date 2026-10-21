/**
 * The store's device identity (identity-per-store §2, §4): find it in this install's store, or mint one for the
 * next store and register it under the install's pairing grant.
 *
 *  - A store (`yaos3:<vaultId>:<epoch>:<installKey>`) holds its identity in meta.identity. Found: that identity,
 *    whatever the grant (offline start works as before, §4 "App start, existing store").
 *  - No store: the identity of this install's next store. Minting needs the network (registration), and naming the
 *    store needs the epoch, which only a connect (as that identity) learns. So the minted identity waits in a
 *    pending DB (`yaos3-pending:<vaultId>:<installKey>`) until its store is created: a restart offline, or a key
 *    reader that runs for days without a store, reuses it instead of registering a device per start (the grant's 20
 *    a day and 50 live, §3.3). LogEngine deletes the pending DB right before it creates the store
 *    (EngineOptions.store.beforeCreate), so a pending identity serves at most one store, crash or not.
 *  - Lost with IndexedDB: the store and the pending DB go together (one origin), and the next store gets a new
 *    identity. A clone (another install: another install key) never finds this install's store (§2.4).
 *
 * `device_exists` / `device_retired` drop the pending identity and mint again; the other refusals end the start
 * (IdentityRefused) and the composed engine reports them (notices) and retries on its backoff, or stops for the
 * ones only a re-pair fixes.
 */

import { base64urlEncode } from "../../core/codec/ids";
import { bytesToHex, utf8Encode } from "../../core/codec/lib0";
import type { DeviceId, VaultEpoch, VaultId } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import type { IdentityPort, RegisterRefusal, StoreCredentials } from "../../ports/identity";
import type { RandomPort } from "../../ports/random";
import type { StoragePort } from "../../ports/storage";
import type { YS } from "../store/repo";
import { DB_SCHEMA_VERSION, LEGACY_DB_NAME_PREFIX, PENDING_DB_NAME_PREFIX, STORE, STORE_SPECS, type MetaIdentity, type MetaInherit, type MetaPendingIdentity } from "../store/schema";
import { storeDbs } from "./knownEpoch";

/** A registration refusal that ends this start (identity-per-store §3.2). */
export class IdentityRefused extends Error {
	constructor(readonly reason: RegisterRefusal, readonly retryAfterMs: number | null) {
		super(`device registration refused: ${reason}`);
		this.name = "IdentityRefused";
	}
}

/** Refusals only a new pairing fixes: the engine stops retrying (relay-wire §2.4.1). */
export function needsRepair(reason: RegisterRefusal): boolean {
	return reason === "grant-revoked" || reason === "unauthorized" || reason === "grant-required" || reason === "no-grant";
}

export interface ResolvedIdentity {
	readonly creds: StoreCredentials;
	/** store: read from this install's store; pending: minted for the next store (consumed when it is created). */
	readonly source: "store" | "pending";
	/** The epoch of the one store DB (offline start); undefined: none, or several (connect first). */
	readonly epoch: VaultEpoch | undefined;
	/** This install's earlier stores, never `creds.deviceId` (EngineOptions.lineage; set by the composed engine). */
	readonly lineage?: ReadonlySet<DeviceId>;
	/**
	 * A pending identity's predecessor recovery (identity-per-store §5.2; EngineOptions.inherit): the lineage dirs,
	 * newest first, and whether the newest store was fenced. null: a store already exists, or the install has none.
	 */
	readonly inherit?: MetaInherit | null;
}

/** `yaos3-pending:<vaultId>:<installKey>`. */
export function pendingDbName(vaultId: VaultId, installKey: string): string {
	return `${PENDING_DB_NAME_PREFIX}:${encodeURIComponent(vaultId)}:${encodeURIComponent(installKey)}`;
}

/** identity-per-store §4 "Mint": deviceId 16 random bytes, token 32, retire key 32, all base64url. */
export function mintCredentials(random: RandomPort): StoreCredentials {
	return {
		deviceId: base64urlEncode(random.bytes(16)) as DeviceId,
		deviceToken: base64urlEncode(random.bytes(32)),
		retireKey: base64urlEncode(random.bytes(32)),
	};
}

/** Lowercase hex SHA-256 of the retire key's UTF-8 (relay-wire §2.4.1 `retireKeyHash`, as the server hashes it). */
export async function retireKeyHash(hash: HashPort, retireKey: string): Promise<string> {
	return bytesToHex(await hash.sha256(utf8Encode(retireKey)));
}

/** meta.identity of `name`, or null when it has none. Throws when the DB cannot be read (the start retries). */
async function readStoreIdentity(storage: StoragePort, name: string): Promise<MetaIdentity | null> {
	const db = await storage.open<YS>(name, DB_SCHEMA_VERSION, STORE_SPECS);
	try {
		const m = await db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "identity"));
		return m?.key === "identity" ? m : null;
	} finally {
		db.close();
	}
}

async function readPending(storage: StoragePort, name: string): Promise<MetaPendingIdentity | null> {
	if (!(await storage.listDatabases()).includes(name)) return null;
	const db = await storage.open<YS>(name, DB_SCHEMA_VERSION, STORE_SPECS);
	try {
		const m = await db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "pendingIdentity"));
		return m?.key === "pendingIdentity" ? m : null;
	} finally {
		db.close();
	}
}

async function writePending(storage: StoragePort, name: string, rec: MetaPendingIdentity): Promise<void> {
	const db = await storage.open<YS>(name, DB_SCHEMA_VERSION, STORE_SPECS);
	try {
		await db.tx([STORE.meta], "readwrite", async (tx) => tx.put(STORE.meta, rec));
	} finally {
		db.close();
	}
}

/** Drop the pending identity (consumed by its store, or refused by the server). */
export async function dropPending(storage: StoragePort, vaultId: VaultId, installKey: string): Promise<void> {
	const name = pendingDbName(vaultId, installKey);
	if ((await storage.listDatabases()).includes(name)) await storage.deleteDatabase(name);
}

/**
 * identity-per-store §13: the identity-less `yaos2:<vaultId>:*` stores of the old layout. Their unsent edits are on
 * disk and the onboarding scan re-derives them. Best effort; returns how many were deleted.
 */
export async function deleteLegacyDbs(storage: StoragePort, vaultId: VaultId): Promise<number> {
	let n = 0;
	const prefix = `${LEGACY_DB_NAME_PREFIX}:${encodeURIComponent(vaultId)}:`;
	for (const name of await storage.listDatabases()) {
		if (!name.startsWith(prefix)) continue;
		await storage.deleteDatabase(name);
		n++;
	}
	return n;
}

export interface ResolveDeps {
	readonly storage: StoragePort;
	readonly random: RandomPort;
	readonly hash: HashPort;
	readonly identity: IdentityPort;
	readonly vaultId: VaultId;
	readonly installKey: string;
	readonly log?: (line: string) => void;
}

/** Mints before giving up on device_exists / device_retired answers in one start. */
const MAX_MINTS = 3;

/**
 * This install's identity for its next start (header). Throws IdentityRefused for a refused registration, and
 * whatever storage throws (the caller retries the start).
 */
export async function resolveStoreIdentity(d: ResolveDeps): Promise<ResolvedIdentity> {
	const dbs = await storeDbs(d.storage, d.vaultId, d.installKey);
	let found: MetaIdentity | null = null;
	for (const db of dbs) {
		const id = await readStoreIdentity(d.storage, db.name);
		if (id && (!found || id.createdAtMs > found.createdAtMs)) found = id;
	}
	if (found && found.deviceToken !== undefined && found.retireKey !== undefined) {
		// A pending identity left by a crash between its consumption and the store's first commit cannot exist (it
		// is deleted first); one minted while a store existed cannot either. Dropped all the same: never two stores.
		await dropPending(d.storage, d.vaultId, d.installKey).catch(() => undefined);
		const epochs = new Set(dbs.map((x) => x.vaultEpoch));
		return {
			creds: { deviceId: found.deviceId, deviceToken: found.deviceToken, retireKey: found.retireKey },
			source: "store",
			epoch: epochs.size === 1 ? [...epochs][0] : undefined,
		};
	}
	// A store without a usable identity (none written, or not by a grant install) is no store of this install.
	for (const db of dbs) await d.storage.deleteDatabase(db.name);
	return { creds: await registerPending(d), source: "pending", epoch: undefined };
}

/**
 * The install's pending identity, minted (or the one a crash left) and registered with the grant; the stores are not
 * touched. A revoked store's successor is registered this way before the store is deleted (identity-per-store §4,
 * "Store revoked by the server"): a refusal leaves the store as it was. Throws IdentityRefused or a storage error.
 */
export async function registerPending(d: ResolveDeps): Promise<StoreCredentials> {
	const name = pendingDbName(d.vaultId, d.installKey);
	let pending = await readPending(d.storage, name);
	for (let mints = 0; ; ) {
		if (!pending) {
			if (mints >= MAX_MINTS) throw new IdentityRefused("device-exists", null);
			mints++;
			const c = d.identity.mint?.() ?? mintCredentials(d.random);
			pending = { key: "pendingIdentity", deviceId: c.deviceId, deviceToken: c.deviceToken, retireKey: c.retireKey, registered: false };
			await writePending(d.storage, name, pending);
			d.log?.("store identity minted");
		}
		if (pending.registered) break;
		const r = await d.identity.register({ deviceId: pending.deviceId, deviceToken: pending.deviceToken, retireKeyHash: await retireKeyHash(d.hash, pending.retireKey) });
		if (r.ok) {
			pending = { ...pending, registered: true };
			await writePending(d.storage, name, pending);
			d.log?.("store identity registered");
			break;
		}
		if (r.reason !== "device-exists" && r.reason !== "device-retired") throw new IdentityRefused(r.reason, r.retryAfterMs);
		d.log?.(`store identity refused (${r.reason}): minting another`);
		await d.storage.deleteDatabase(name);
		pending = null;
	}
	return { deviceId: pending.deviceId, deviceToken: pending.deviceToken, retireKey: pending.retireKey };
}

/** Deletes this install's stores (every epoch). A revoked store goes once its successor is registered. */
export async function deleteStoreDbs(storage: StoragePort, vaultId: VaultId, installKey: string): Promise<number> {
	const dbs = await storeDbs(storage, vaultId, installKey);
	for (const db of dbs) await storage.deleteDatabase(db.name);
	return dbs.length;
}
