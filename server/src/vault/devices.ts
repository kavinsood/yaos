// The vault's enrolled devices, in memory (DECISIONS §6.1: rows read per runtime = meta 1 + devices N, then 0 per
// bearer auth). Keyed by hex(SHA-256(deviceToken)) for bearer auth and by deviceId for the D7 gate.
import { bytesToHex } from "../hex";
import type { StoragePort } from "../ports";

export interface DeviceRecord {
	tokenHash: string;
	deviceId: string;
	deviceName: string;
	enrollmentRequestId: string;
	enrolledAt: number;
}

type DeviceRow = {
	token_hash: ArrayBuffer;
	device_id: string;
	device_name: string;
	enrollment_request_id: string;
	enrolled_at: number;
};

export class DeviceMap {
	private readonly byToken = new Map<string, DeviceRecord>();
	private readonly byDeviceId = new Map<string, DeviceRecord>();

	/** One scan of `device` (N rows read), at the first request of a runtime. */
	static load(storage: StoragePort): DeviceMap {
		const map = new DeviceMap();
		const rows = storage.sql.exec<DeviceRow>(
			"SELECT token_hash, device_id, device_name, enrollment_request_id, enrolled_at FROM device",
		);
		for (const row of rows) {
			map.add({
				tokenHash: bytesToHex(new Uint8Array(row.token_hash)),
				deviceId: row.device_id,
				deviceName: row.device_name,
				enrollmentRequestId: row.enrollment_request_id,
				enrolledAt: row.enrolled_at,
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
