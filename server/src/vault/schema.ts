// Vault DO schema (DECISIONS §6.1): the three stream tables of streams/store.ts plus the identity tables. The DDL
// runs once, inside the vault-init transaction, and never on a request path (T-PAIR-NOWRITE).
import { STREAM_SCHEMA } from "../streams/store";

/**
 * The identity tables (DECISIONS §6.1, identity-per-store §3).
 *
 * - `vault_meta`: one row. `removals` counts the operator's removals that block a device ("Revoke pairing", and
 *   "Revoke" of a device enrolled without a grant); `rekeyed` is the highest such count a device has since covered
 *   with a new vault key (`VAULT_REKEYED`, relay-wire §4.2). A vault is due a key roll while `removals > rekeyed`
 *   (e2ee-design §14.5). Authority, not content: a D8b restore carries both across the rewind.
 * - `device`: a device enrolled the old way (`/enroll` with a deviceId) has `grant_id` NULL; a registered one has its
 *   grant, the SHA-256 of its retire key (`retire_hash`) and `last_seen_day` (the UTC day of its last ticket, at most
 *   one write a day).
 * - `pairing_code`: `used_grant_id` is the D3 replay key of a grant enroll.
 * - `pairing_grant` (not `grant`, a SQL keyword): `secret_wrap` is the grant secret a rotation minted, AES-GCM-wrapped
 *   under a key derived from the vault's ticket key (grantWrap.ts), so a live device of the grant can fetch it
 *   (`GET /vault/:id/auth/grant`). NULL for a grant never rotated: the server keeps only the hash of a secret the
 *   client minted (G56).
 * - `retired_device`: device tombstones, never deleted: a retired deviceId never registers or enrolls again.
 */
const VAULT_IDENTITY_SCHEMA = `
	CREATE TABLE vault_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		vault_id TEXT NOT NULL, vault_generation TEXT NOT NULL,
		ticket_key BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		pending_restore_id TEXT,
		last_restore_id TEXT,
		last_restore_at INTEGER,
		removals INTEGER NOT NULL DEFAULT 0,
		rekeyed INTEGER NOT NULL DEFAULT 0
	) WITHOUT ROWID;
	CREATE TABLE device (
		token_hash BLOB PRIMARY KEY,
		device_id TEXT NOT NULL, device_name TEXT NOT NULL,
		enrollment_request_id TEXT NOT NULL, enrolled_at INTEGER NOT NULL,
		grant_id TEXT,
		retire_hash BLOB,
		last_seen_day INTEGER
	) WITHOUT ROWID;
	CREATE TABLE pairing_code (
		code_hash BLOB PRIMARY KEY,
		purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
		used_request_id TEXT, used_device_id TEXT,
		used_grant_id TEXT
	) WITHOUT ROWID;
	CREATE TABLE pairing_grant (
		grant_id TEXT PRIMARY KEY,
		secret_hash BLOB NOT NULL,
		grant_name TEXT NOT NULL,
		enrollment_request_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		revoked_at INTEGER,
		registered_day INTEGER NOT NULL DEFAULT 0,
		registered_count INTEGER NOT NULL DEFAULT 0,
		secret_wrap BLOB
	) WITHOUT ROWID;
	CREATE TABLE retired_device (
		device_id TEXT PRIMARY KEY,
		grant_id TEXT,
		retired_at INTEGER NOT NULL
	) WITHOUT ROWID;
`;

/** Every vault DO table, in creation order. */
export const VAULT_SCHEMA = [STREAM_SCHEMA, VAULT_IDENTITY_SCHEMA] as const;
