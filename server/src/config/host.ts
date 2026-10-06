// Config DO host logic behind the storage port (DECISIONS §2.1, §6.3). config.ts wraps it in the DO class.
// The config DO is never on a device path: only /claim, /operator/* and pre-claim /api/capabilities reach it.
//
// Secrets: the recovery key and session tokens are hashed here (SHA-256, §6.3); the Worker does no crypto (§2.1).
// Every method awaits its hashes first and then runs its reads and writes in one synchronous stretch, so two
// interleaved requests never both pass a check made before an await.
import { randomBase64Url } from "../base64url";
import { FailureLimiter } from "../limiter";
import { SYSTEM_CLOCK, isMissingTableError, type ClockPort, type StoragePort } from "../ports";

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

/** D5: the operator cookie lives 7 days; the session row expires with it. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Session token: base64url(32 random bytes). The Worker checks this format before any config call. */
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/**
 * DECISIONS-GAP: §2.1 names an in-memory login-failure limiter but no numbers. D3's limiter numbers are used:
 * 20 failed logins a minute → `429 too_many_attempts` with Retry-After.
 */
export const LOGIN_FAILURE_LIMIT = 20;
export const LOGIN_FAILURE_WINDOW_MS = 60_000;

export type ConfigFailure = { ok: false; status: number; error: string; retryAfterMs?: number };
export type ConfigResult<T extends object = object> = ({ ok: true } & T) | ConfigFailure;

export interface VaultEntry {
	vaultId: string;
	name: string;
	createdAt: number;
}

export interface OperatorState {
	vaults: VaultEntry[];
	/** D8b: one entry per restore journal row ("Restore incomplete" banner). Always empty until P3. */
	pendingRestores: Array<{ vaultId: string; at: number }>;
}

/** Operator actions D8b freezes while a restore journal row exists for the vault. */
export type FrozenAction = "revoke" | "owner-code" | "reset";

const fail = (status: number, error: string, extra: { retryAfterMs?: number } = {}): ConfigFailure =>
	({ ok: false, status, error, ...extra });

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	if (a.byteLength !== b.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < a.byteLength; index++) difference |= a[index]! ^ b[index]!;
	return difference === 0;
}

export class ConfigHost {
	/** `claimed` = the operator row exists (§6.3); once true it stays true for this object's lifetime. */
	private claimed: boolean;
	private readonly clock: ClockPort;
	private readonly loginFailures: FailureLimiter;

	constructor(private readonly storage: StoragePort, clock: ClockPort = SYSTEM_CLOCK) {
		this.clock = clock;
		this.loginFailures = new FailureLimiter(LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_MS, clock);
		this.claimed = this.probe();
	}

	isClaimed(): boolean {
		if (!this.claimed) this.claimed = this.probe();
		return this.claimed;
	}

	/**
	 * D5 claim, step 2: the operator, the first vault and a session in one write (3 rows). The vault DO was
	 * initialized before this call (step 1); the owner code follows (step 3).
	 */
	async claim(recoveryKey: string, vaultId: string, vaultName: string): Promise<ConfigResult<{ sessionToken: string }>> {
		const keyHash = await sha256(recoveryKey);
		const sessionToken = randomBase64Url(32);
		const sessionHash = await sha256(sessionToken);
		if (this.isClaimed()) return fail(409, "already_claimed");
		const now = this.clock.now();
		this.storage.transactionSync(() => {
			this.storage.sql.exec("INSERT INTO operator (id, key_hash, claimed_at) VALUES (1, ?, ?)", keyHash, now);
			this.storage.sql.exec("INSERT INTO vault (vault_id, name, created_at) VALUES (?, ?, ?)", vaultId, vaultName, now);
			this.storage.sql.exec("INSERT INTO session (token_hash, expires_at) VALUES (?, ?)", sessionHash, now + SESSION_TTL_MS);
		});
		this.claimed = true;
		return { ok: true, sessionToken };
	}

	/** Login: 1 row (the session) + 1 per expired session pruned. */
	async login(recoveryKey: string): Promise<ConfigResult<{ sessionToken: string }>> {
		const blocked = this.loginFailures.retryAfterMs();
		if (blocked > 0) return fail(429, "too_many_attempts", { retryAfterMs: blocked });
		const keyHash = await sha256(recoveryKey);
		const sessionToken = randomBase64Url(32);
		const sessionHash = await sha256(sessionToken);
		const row = this.isClaimed()
			? this.storage.sql.exec<{ key_hash: ArrayBuffer }>("SELECT key_hash FROM operator WHERE id = 1").toArray()[0]
			: undefined;
		if (!row || !equalBytes(row.key_hash, keyHash)) {
			this.loginFailures.fail();
			return fail(401, "unauthorized");
		}
		const now = this.clock.now();
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM session WHERE expires_at <= ?", now);
			this.storage.sql.exec("INSERT INTO session (token_hash, expires_at) VALUES (?, ?)", sessionHash, now + SESSION_TTL_MS);
		});
		return { ok: true, sessionToken };
	}

	/** Logout: deletes the session row (1 row; 0 when it is already gone). */
	async logout(sessionToken: string): Promise<{ ok: true }> {
		const sessionHash = await sha256(sessionToken);
		if (this.isClaimed()) this.storage.sql.exec("DELETE FROM session WHERE token_hash = ?", sessionHash);
		return { ok: true };
	}

	/**
	 * The operator gate of every `/operator/*` route but login and logout: a live session (else 401); with a vaultId,
	 * a registered vault (else `404 unknown_vault`); with a frozen action, no restore journal row for the vault (else
	 * D8b's `409 restore_in_progress`). Reads only.
	 */
	async authorize(sessionToken: string, vaultId?: string, action?: FrozenAction): Promise<ConfigResult> {
		const sessionHash = await sha256(sessionToken);
		if (!this.sessionLive(sessionHash)) return fail(401, "unauthorized");
		if (vaultId === undefined) return { ok: true };
		const vault = this.storage.sql.exec("SELECT vault_id FROM vault WHERE vault_id = ?", vaultId).toArray()[0];
		// DECISIONS-GAP: §2.2 names no answer for an operator route on an unregistered vault; legacy's `404
		// unknown_vault` (removed routes/operator.ts) is kept.
		if (!vault) return fail(404, "unknown_vault");
		if (action && this.restorePending(vaultId)) return fail(409, "restore_in_progress");
		return { ok: true };
	}

	/** `GET /operator/state`: the registry and the pending restore journal rows. */
	async state(sessionToken: string): Promise<ConfigResult<OperatorState>> {
		const sessionHash = await sha256(sessionToken);
		if (!this.sessionLive(sessionHash)) return fail(401, "unauthorized");
		const vaults = this.storage.sql.exec<{ vault_id: string; name: string; created_at: number }>(
			"SELECT vault_id, name, created_at FROM vault ORDER BY created_at, vault_id",
		).toArray().map((row) => ({ vaultId: row.vault_id, name: row.name, createdAt: row.created_at }));
		const pendingRestores = this.storage.sql.exec<{ vault_id: string; at: number }>(
			"SELECT vault_id, at FROM restore_journal ORDER BY created_at, vault_id",
		).toArray().map((row) => ({ vaultId: row.vault_id, at: row.at }));
		return { ok: true, vaults, pendingRestores };
	}

	/** D5 create vault, last step: the registry row (1 row), after the vault DO's init. */
	registerVault(vaultId: string, name: string): ConfigResult<{ vault: VaultEntry }> {
		if (!this.isClaimed()) return fail(401, "unauthorized");
		const createdAt = this.clock.now();
		this.storage.sql.exec("INSERT INTO vault (vault_id, name, created_at) VALUES (?, ?, ?)", vaultId, name, createdAt);
		return { ok: true, vault: { vaultId, name, createdAt } };
	}

	/** D8b: "Vault delete wins: it deletes the journal row first" (0 rows when there is none). */
	beginDeleteVault(vaultId: string): { ok: true } {
		if (this.isClaimed()) this.storage.sql.exec("DELETE FROM restore_journal WHERE vault_id = ?", vaultId);
		return { ok: true };
	}

	/** D5 delete vault, last step: the registry row (1 row), after the wipe and the R2 purge. */
	unregisterVault(vaultId: string): { ok: true } {
		if (this.isClaimed()) this.storage.sql.exec("DELETE FROM vault WHERE vault_id = ?", vaultId);
		return { ok: true };
	}

	private sessionLive(sessionHash: ArrayBuffer): boolean {
		if (!this.isClaimed()) return false;
		const row = this.storage.sql.exec<{ expires_at: number }>(
			"SELECT expires_at FROM session WHERE token_hash = ?", sessionHash,
		).toArray()[0];
		return row !== undefined && row.expires_at > this.clock.now();
	}

	private restorePending(vaultId: string): boolean {
		return this.storage.sql.exec("SELECT vault_id FROM restore_journal WHERE vault_id = ?", vaultId).toArray().length > 0;
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
