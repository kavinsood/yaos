// Vault DO schema (DECISIONS §6.1): the three stream tables of streams/store.ts plus three identity tables. The DDL
// runs once, inside the vault-init transaction, and never on a request path (T-PAIR-NOWRITE).
import { STREAM_SCHEMA } from "../streams/store";

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

/** Every vault DO table, in creation order. */
export const VAULT_SCHEMA = [STREAM_SCHEMA, VAULT_IDENTITY_SCHEMA] as const;

