// Vault DO schema (DECISIONS §6.1): the three stream tables of streams/store.ts plus the identity tables. The DDL
// runs once, inside the vault-init transaction, and never on a request path (T-PAIR-NOWRITE), with one exception:
// a vault created before identity v2 runs IDENTITY_V2_MIGRATION once, at the first load of a runtime (below).
import { STREAM_SCHEMA } from "../streams/store";
import type { StoragePort } from "../ports";

/** Identity v1 (DECISIONS §6.1 as approved): meta, devices, pairing codes. Never edited: v2 alters it. */
export const VAULT_IDENTITY_SCHEMA = `
	CREATE TABLE vault_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		vault_id TEXT NOT NULL, vault_generation TEXT NOT NULL,
		ticket_key BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		pending_restore_id TEXT,
		last_restore_id TEXT,
		last_restore_at INTEGER
	) WITHOUT ROWID;
	CREATE TABLE device (
		token_hash BLOB PRIMARY KEY,
		device_id TEXT NOT NULL, device_name TEXT NOT NULL,
		enrollment_request_id TEXT NOT NULL, enrolled_at INTEGER NOT NULL
	) WITHOUT ROWID;
	CREATE TABLE pairing_code (
		code_hash BLOB PRIMARY KEY,
		purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
		used_request_id TEXT, used_device_id TEXT
	) WITHOUT ROWID;
`;

/**
 * Identity v2 (identity-per-store §3.1, phase 1): pairing grants, device tombstones, and three device columns. A
 * device enrolled the old way (`/enroll` with a deviceId) has `grant_id` NULL; a registered one has its grant, the
 * SHA-256 of its retire key and `last_seen_day` (the UTC day of its last ticket, at most one write a day).
 * `pairing_code.used_grant_id` is the D3 replay key of a grant enroll. The table is `pairing_grant`, not `grant`
 * (a SQL keyword). Tombstones are never deleted: a retired deviceId never registers or enrolls again.
 */
export const IDENTITY_V2_MIGRATION = [
	"ALTER TABLE device ADD COLUMN grant_id TEXT",
	"ALTER TABLE device ADD COLUMN retire_hash BLOB",
	"ALTER TABLE device ADD COLUMN last_seen_day INTEGER",
	"ALTER TABLE pairing_code ADD COLUMN used_grant_id TEXT",
	`CREATE TABLE pairing_grant (
		grant_id TEXT PRIMARY KEY,
		secret_hash BLOB NOT NULL,
		grant_name TEXT NOT NULL,
		enrollment_request_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		revoked_at INTEGER,
		registered_day INTEGER NOT NULL DEFAULT 0,
		registered_count INTEGER NOT NULL DEFAULT 0
	) WITHOUT ROWID`,
	`CREATE TABLE retired_device (
		device_id TEXT PRIMARY KEY,
		grant_id TEXT,
		retired_at INTEGER NOT NULL
	) WITHOUT ROWID`,
] as const;

/** Every vault DO table, in creation order: init runs v1 and then the v2 migration, so every vault ends identical. */
export const VAULT_SCHEMA = [STREAM_SCHEMA, VAULT_IDENTITY_SCHEMA, ...IDENTITY_V2_MIGRATION] as const;

/**
 * DECISIONS-GAP (G54): identity v2 on a vault initialized before it. `VaultHost.load` reads `pairing_grant` first; "no
 * such table" means a v1 vault, and this runs the v2 DDL in one transaction (so a v1 vault never half-migrates) before
 * the device scan. Once per vault, at the first load of a runtime; an unknown vault never gets here (no `vault_meta`),
 * so T-PAIR-NOWRITE holds. A D8b rewind to a point before the migration simply migrates again on the next load.
 */
export function migrateIdentityV2(storage: StoragePort): void {
	storage.transactionSync(() => {
		for (const ddl of IDENTITY_V2_MIGRATION) storage.sql.exec(ddl);
	});
}
