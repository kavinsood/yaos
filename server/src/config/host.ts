// Config DO host logic behind the storage port (DECISIONS §2.1, §6.3). config.ts wraps it in the DO class.
// The config DO is never on a device path: only /claim, /operator/* and pre-claim /api/capabilities reach it.
import { isMissingTableError, type StoragePort } from "../ports";

/** DECISIONS §6.3, verbatim. */
export const CONFIG_SCHEMA = `
	CREATE TABLE operator (id INTEGER PRIMARY KEY CHECK (id = 1),
		key_hash BLOB NOT NULL, claimed_at INTEGER NOT NULL) WITHOUT ROWID;
	CREATE TABLE session (token_hash BLOB PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
	CREATE TABLE vault (vault_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
	CREATE TABLE restore_journal (vault_id TEXT PRIMARY KEY, restore_id TEXT NOT NULL, at INTEGER NOT NULL,
		bookmark TEXT, devices BLOB,
		created_at INTEGER NOT NULL) WITHOUT ROWID;
`;

export class ConfigHost {
	/** `claimed` = the operator row exists (§6.3); once true it stays true for this object's lifetime. */
	private claimed: boolean;

	constructor(private readonly storage: StoragePort) {
		this.claimed = this.probe();
	}

	isClaimed(): boolean {
		if (!this.claimed) this.claimed = this.probe();
		return this.claimed;
	}

	/**
	 * Reads the operator row. A missing table means a new singleton: the §6.3 DDL runs once, in one transaction.
	 * DECISIONS-GAP: §6.3 does not say when the config DDL runs. It runs at the singleton's first construction; the
	 * config DO is off the hot path, so this one-time cost lands on the first claim, login or pre-claim probe.
	 */
	private probe(): boolean {
		try {
			return this.storage.sql.exec("SELECT id FROM operator WHERE id = 1").toArray().length > 0;
		} catch (error) {
			if (!isMissingTableError(error, "operator")) throw error;
		}
		this.storage.transactionSync(() => this.storage.sql.exec(CONFIG_SCHEMA));
		return false;
	}
}
