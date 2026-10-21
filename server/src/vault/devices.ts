// The vault's enrolled devices and pairing grants, in memory (DECISIONS §6.1: rows read per runtime = meta 1 + grants G
// + devices N, then 0 per bearer auth). Devices are keyed by hex(SHA-256(deviceToken)) for bearer auth and by deviceId
// for the D7 gate; grants by grantId and by hex(SHA-256(grantSecret)) for `Authorization: Grant` (identity-per-store
// §3). Tombstones (`retired_device`) are never loaded: one indexed read at register and enroll.
import { bytesToHex } from "../hex";
import type { StoragePort } from "../ports";

export interface DeviceRecord {
	tokenHash: string;
	deviceId: string;
	deviceName: string;
	/** The D3 enroll request that created the row; "" for a device registered under a grant (no code involved). */
	enrollmentRequestId: string;
	enrolledAt: number;
	/** The pairing grant the device was registered under; null for a device enrolled with a deviceId (old /enroll). */
	grantId: string | null;
	/** hex(SHA-256(retireKey)) of a registered device; null for an old enroll. */
	retireHash: string | null;
	/** UTC day number (ms / 86 400 000) of the device's last ticket; null before the first. */
	lastSeenDay: number | null;
}

type DeviceRow = {
	token_hash: ArrayBuffer;
	device_id: string;
	device_name: string;
	enrollment_request_id: string;
	enrolled_at: number;
	grant_id: string | null;
	retire_hash: ArrayBuffer | null;
	last_seen_day: number | null;
};

export class DeviceMap {
	private readonly byToken = new Map<string, DeviceRecord>();
	private readonly byDeviceId = new Map<string, DeviceRecord>();

	/** One scan of `device` (N rows read), at the first request of a runtime. */
	static load(storage: StoragePort): DeviceMap {
		const map = new DeviceMap();
		const rows = storage.sql.exec<DeviceRow>(
			"SELECT token_hash, device_id, device_name, enrollment_request_id, enrolled_at, grant_id, retire_hash,"
				+ " last_seen_day FROM device",
		);
		for (const row of rows) {
			map.add({
				tokenHash: bytesToHex(new Uint8Array(row.token_hash)),
				deviceId: row.device_id,
				deviceName: row.device_name,
				enrollmentRequestId: row.enrollment_request_id,
				enrolledAt: row.enrolled_at,
				grantId: row.grant_id,
				retireHash: row.retire_hash ? bytesToHex(new Uint8Array(row.retire_hash)) : null,
				lastSeenDay: row.last_seen_day,
			});
		}
		return map;
	}

	get size(): number {
		return this.byToken.size;
	}

	/** Every enrolled device (the operator's device list, name uniqueness at enroll). */
	list(): IterableIterator<DeviceRecord> {
		return this.byDeviceId.values();
	}

	/** The live devices of one grant (a scan of the few device rows in memory). */
	ofGrant(grantId: string): DeviceRecord[] {
		return [...this.byDeviceId.values()].filter((device) => device.grantId === grantId);
	}

	byTokenHash(tokenHash: string): DeviceRecord | undefined {
		return this.byToken.get(tokenHash);
	}

	byId(deviceId: string): DeviceRecord | undefined {
		return this.byDeviceId.get(deviceId);
	}

	/**
	 * The gate seam: whether `deviceId` is enrolled right now. The relay asks it at accept and before every control
	 * and append (`validateActor`). P2 (D7) deletes the entry in the revoke turn, so the gate shuts with the
	 * transaction.
	 */
	admits(deviceId: string): boolean {
		return this.byDeviceId.has(deviceId);
	}

	/** Mirrors an INSERT into `device` (P2 enroll). */
	add(record: DeviceRecord): void {
		this.byToken.set(record.tokenHash, record);
		this.byDeviceId.set(record.deviceId, record);
	}

	/** Mirrors a DELETE from `device` (P2 revoke); returns the removed record. */
	remove(deviceId: string): DeviceRecord | undefined {
		const record = this.byDeviceId.get(deviceId);
		if (!record) return undefined;
		this.byDeviceId.delete(deviceId);
		this.byToken.delete(record.tokenHash);
		return record;
	}
}

/** One pairing grant (identity-per-store §3.1): minted by a grant enroll, revoked by leave or "Revoke pairing". */
export interface GrantRecord {
	grantId: string;
	/** hex(SHA-256(grantSecret)). */
	secretHash: string;
	/** The name every device of the grant carries (§6.3: no "Mac 7" after a few wipes). */
	name: string;
	enrollmentRequestId: string;
	createdAt: number;
	/** Set once, never cleared: a revoked grant answers `401 grant_revoked`. */
	revokedAt: number | null;
	/** The per-grant daily registration counter (§3.3): the UTC day it counts and the count on that day. */
	registeredDay: number;
	registeredCount: number;
	/**
	 * hex(IV || AES-GCM(secret)) of a secret a rotation minted (§3.4, grantWrap.ts): a live device of the grant fetches
	 * it. null: never rotated (the server holds only the hash of the secret the client minted, G56).
	 */
	secretWrap: string | null;
}

type GrantRow = {
	grant_id: string;
	secret_hash: ArrayBuffer;
	grant_name: string;
	enrollment_request_id: string;
	created_at: number;
	revoked_at: number | null;
	registered_day: number;
	registered_count: number;
	secret_wrap: ArrayBuffer | null;
};

export class GrantMap {
	private readonly byGrantId = new Map<string, GrantRecord>();
	private readonly bySecret = new Map<string, GrantRecord>();

	/**
	 * One scan of `pairing_grant` (G rows read). Throws "no such table" on a v1 vault and "no such column: secret_wrap"
	 * on a v2 vault (schema.ts migrates both).
	 */
	static load(storage: StoragePort): GrantMap {
		const map = new GrantMap();
		const rows = storage.sql.exec<GrantRow>(
			"SELECT grant_id, secret_hash, grant_name, enrollment_request_id, created_at, revoked_at, registered_day,"
				+ " registered_count, secret_wrap FROM pairing_grant",
		);
		for (const row of rows) {
			map.add({
				grantId: row.grant_id,
				secretHash: bytesToHex(new Uint8Array(row.secret_hash)),
				name: row.grant_name,
				enrollmentRequestId: row.enrollment_request_id,
				createdAt: row.created_at,
				revokedAt: row.revoked_at,
				registeredDay: row.registered_day,
				registeredCount: row.registered_count,
				secretWrap: row.secret_wrap ? bytesToHex(new Uint8Array(row.secret_wrap)) : null,
			});
		}
		return map;
	}

	list(): IterableIterator<GrantRecord> {
		return this.byGrantId.values();
	}

	byId(grantId: string): GrantRecord | undefined {
		return this.byGrantId.get(grantId);
	}

	bySecretHash(secretHash: string): GrantRecord | undefined {
		return this.bySecret.get(secretHash);
	}

	add(record: GrantRecord): void {
		this.byGrantId.set(record.grantId, record);
		this.bySecret.set(record.secretHash, record);
	}

	/** Mirrors a rotation's UPDATE (§3.4): the old secret stops naming the grant at once. */
	rekey(record: GrantRecord, secretHash: string, secretWrap: string): void {
		this.bySecret.delete(record.secretHash);
		record.secretHash = secretHash;
		record.secretWrap = secretWrap;
		this.bySecret.set(secretHash, record);
	}
}

/** A `retired_device` row: the tombstone of a deviceId that may never come back. */
export interface RetiredRecord {
	deviceId: string;
	grantId: string | null;
	retiredAt: number;
}

/**
 * The authority a D8b restore carries across the rewind: the device table, and (identity v2) the grants and the
 * tombstones, so a restore never brings back a revoked pairing or a retired deviceId ("a restore rewinds content,
 * never authority"). `grants` and `retired` are null in a journal row written before v2: finish then leaves those
 * tables as the rewind left them.
 */
export interface IdentitySnapshot {
	devices: DeviceRecord[];
	grants: GrantRecord[] | null;
	retired: RetiredRecord[] | null;
	/**
	 * The key-roll signal (identity v4, e2ee-design §14.5): a restore must not forget a removal nobody has covered with
	 * a new vault key yet. null in a journal row written before v4: finish leaves the rewound counts.
	 */
	rekey: { removals: number; rekeyed: number } | null;
}
