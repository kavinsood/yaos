// Relay v3 (YAOS_RELAY_GROUP_COMMIT): storage helpers for the per-body tail row
// and the per-device receipt row. Both tables are WITHOUT ROWID with a TEXT
// primary key and no secondary index, so one UPSERT is one written row in the
// Cloudflare accounting (no autoindex, no index entries). Created lazily, only
// when v3 is on; the flag-off schema is untouched. See docs/relay3-group-commit.md.
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/**
 * Hard ceiling on one tail row's data blob. A group commit that would push the
 * tail past it is written as a lean journal row instead (the v2 path), so a
 * body whose checkpoint cannot progress never grows one row past the SQLite
 * row limit. The soft cap (`gcTailBytes`, 64 KB default) triggers a checkpoint.
 */
export const RELAY_TAIL_HARD_MAX_BYTES = 1024 * 1024;
/** Receipt ring length per device (newest first). Older resends fall back to a CRDT no-op ack. */
export const RELAY_RECEIPT_RING = 256;

export const RELAY_TAIL_SCHEMA = `
	CREATE TABLE IF NOT EXISTS relay_body_tail (
		body_id TEXT PRIMARY KEY,
		body_epoch INTEGER NOT NULL CHECK(body_epoch >= 1),
		base_sequence INTEGER NOT NULL,
		latest_sequence INTEGER NOT NULL,
		generation INTEGER NOT NULL,
		frames INTEGER NOT NULL,
		byte_length INTEGER NOT NULL,
		data BLOB NOT NULL CHECK(typeof(data) = 'blob'),
		content_hash TEXT,
		size INTEGER,
		attr_principal_id TEXT,
		attr_device_id TEXT,
		updated_at INTEGER NOT NULL
	) WITHOUT ROWID;
	CREATE TABLE IF NOT EXISTS relay_device_receipts (
		client_id TEXT PRIMARY KEY,
		last_sequence INTEGER NOT NULL,
		recent TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	) WITHOUT ROWID;
`;

/** One committed group inside a tail row: its vault sequence, generation and (merged) update. */
export interface RelayTailRecord {
	sequence: number;
	generation: number;
	update: Uint8Array;
}

/** One receipt in a device's ring. Short keys: the ring is rewritten on every commit. */
export interface RelayReceiptEntry {
	/** body id */ b: string;
	/** candidate id */ c: string;
	/** candidate digest */ d: string;
	/** body epoch */ e: number;
	/** durable generation */ g: number;
	/** vault sequence */ s: number;
	/** runtime epoch of the socket the candidate arrived on */ r: string;
	/** created at (ms) */ t: number;
	/** principal / membership revision / credential revision (committedOperationOutcome, G14) */
	p?: string; m?: number; k?: number;
}

export function encodeTailRecords(records: readonly RelayTailRecord[]): Uint8Array {
	const encoder = encoding.createEncoder();
	for (const record of records) {
		encoding.writeVarUint(encoder, record.sequence);
		encoding.writeVarUint(encoder, record.generation);
		encoding.writeVarUint8Array(encoder, record.update);
	}
	return encoding.toUint8Array(encoder);
}

export function decodeTailRecords(bytes: Uint8Array): RelayTailRecord[] {
	const decoder = decoding.createDecoder(bytes);
	const records: RelayTailRecord[] = [];
	while (decoding.hasContent(decoder)) {
		const sequence = decoding.readVarUint(decoder);
		const generation = decoding.readVarUint(decoder);
		const update = decoding.readVarUint8Array(decoder).slice();
		if (update.byteLength === 0) throw new Error("relay tail record is empty");
		records.push({ sequence, generation, update });
	}
	return records;
}

export function parseReceiptRing(value: string | null | undefined): RelayReceiptEntry[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed as RelayReceiptEntry[] : [];
	} catch {
		return [];
	}
}
