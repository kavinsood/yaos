// D8b restore runner, in the config DO (DECISIONS §3 D8b, §6.3): the journal row, steps 0–4 over vault RPCs, and the
// alarm that resumes a run that did not reach step 4. Cold path only: the operator route and the alarm are the only
// entries, and the vault DO never calls back.
//
// Steps (vault side in vault/host.ts): 0 INSERT the journal row + alarm; 1 prepareRestore (flag, 1013 closes, marker,
// bookmark + devices → journal UPDATE); 2 rewind (arm the bookmark, ctx.abort: the RPC throws by design); 3
// finishRestore (devices, no codes, new epoch; or back to 2); 4 DELETE the journal row → 200 {vaultEpoch}.
import { randomBase64Url } from "../base64url";
import { isCloudflareDailyLimitError } from "../dailyLimit";
import { describeError, isMissingTableError, type ClockPort, type StoragePort } from "../ports";
import type { DeviceRecord } from "../vault/devices";
import type { FinishRestoreResult, PrepareRestoreResult, RewindResult } from "../vault/host";
import type { ConfigFailure, ConfigResult } from "./host";

/** D8b: `at` over 30 days old → `400 invalid_restore_point` (Durable Objects PITR covers the last 30 days). */
export const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** D8b step 0: the alarm is set to now + 30 s. */
export const RESTORE_ALARM_DELAY_MS = 30_000;
/**
 * DECISIONS-GAP: D8b says "the alarm with platform retries" but not how long it keeps trying. Platform retries cover
 * only a handler that throws (at most 6); the handler instead re-arms itself while journal rows remain, after the age
 * of the newest row clamped to 30 s..1 h (about doubling per alarm, and an eviction does not reset it), so a journal
 * row is never left without an alarm.
 */
export const RESTORE_ALARM_MAX_DELAY_MS = 60 * 60 * 1000;
/**
 * DECISIONS-GAP: D8b loops 3 → 2 on a write in the window without a bound. One run tries the rewind at most 3 times,
 * then answers `503 restore_incomplete` (the alarm continues).
 */
export const MAX_REWINDS_PER_RUN = 3;
/**
 * DECISIONS-GAP: D8b retries a restore without an end. Each retry is a config DO wake and write, vault RPCs that set
 * the 60 s `restoring` flag and close every streams socket 1013 (and maybe a PITR rewind), so a restore that cannot
 * finish would kick every device off the vault once an hour for as long as PITR keeps the point (30 days). The alarm
 * gives up on a journal row once it is this old (since its INSERT, or since the press that resumed it): one Cloudflare
 * daily-limit reset (00:00 UTC, at most 24 h away) plus one RESTORE_ALARM_MAX_DELAY_MS interval and an hour of slack,
 * so a free-plan restore that hit the daily row limit still gets an attempt after the reset. About 31 attempts.
 * Giving up does not drop the row (its device snapshot may be the only copy of the pre-restore device table once
 * the vault was rewound): it is marked failed (`restore_failure`), the alarm stops, the operator state reports
 * `failedAt` and `reason`, and the operator actions stay frozen until a press resumes it or the vault is deleted.
 */
export const RESTORE_GIVE_UP_MS = 26 * 60 * 60 * 1000;
/**
 * DECISIONS-GAP: not in §6.3's schema; created on the first give-up (CREATE IF NOT EXISTS), so config DOs created
 * before it need no migration. A missing table reads as no failures. One row per journal row the alarm gave up on.
 */
export const RESTORE_FAILURE_SCHEMA = `CREATE TABLE IF NOT EXISTS restore_failure (vault_id TEXT PRIMARY KEY,
	restore_id TEXT NOT NULL, failed_at INTEGER NOT NULL, reason TEXT NOT NULL) WITHOUT ROWID`;

/** A journal row the alarm gave up on (`restore_failure`, joined to the journal by restore id). */
export interface RestoreFailure {
	vaultId: string;
	restoreId: string;
	failedAt: number;
	reason: string;
}

/** The `restore_failure` rows by vault id; empty when the table was never created. */
export function readRestoreFailures(storage: StoragePort): Map<string, RestoreFailure> {
	try {
		return new Map(storage.sql.exec<{ vault_id: string; restore_id: string; failed_at: number; reason: string }>(
			"SELECT vault_id, restore_id, failed_at, reason FROM restore_failure",
		).toArray().map((row) => [row.vault_id,
			{ vaultId: row.vault_id, restoreId: row.restore_id, failedAt: row.failed_at, reason: row.reason }]));
	} catch (error) {
		if (isMissingTableError(error, "restore_failure")) return new Map();
		throw error;
	}
}

/** Deletes the vault's `restore_failure` row, when there is one (no statement otherwise, and no table needed). */
export function clearRestoreFailure(storage: StoragePort, vaultId: string): void {
	if (readRestoreFailures(storage).has(vaultId)) storage.sql.exec("DELETE FROM restore_failure WHERE vault_id = ?", vaultId);
}

/** The vault RPCs the runner calls; `RestorePorts.vault` returns a fresh stub per call. */
export interface RestoreVaultPort {
	prepareRestore(restoreId: string, at: number, refreshOnly: boolean): Promise<PrepareRestoreResult>;
	rewind(restoreId: string, bookmark: string): Promise<RewindResult>;
	finishRestore(restoreId: string, devices: DeviceRecord[]): Promise<FinishRestoreResult>;
}

export interface RestoreAlarmPort {
	getAlarm(): Promise<number | null>;
	setAlarm(scheduledTime: number): Promise<void>;
}

export interface RestorePorts {
	/** A NEW vault stub for every call: after the rewind's `ctx.abort()` the stub that made the call stays broken. */
	vault(vaultId: string): RestoreVaultPort;
	alarms: RestoreAlarmPort;
}

export type RestoreResult = ConfigResult<{ vaultEpoch: string; resumed?: true; at?: string }>;

type JournalRow = {
	vault_id: string; restore_id: string; at: number; bookmark: string | null; devices: ArrayBuffer | null; created_at: number;
};

const JOURNAL_COLUMNS = "vault_id, restore_id, at, bookmark, devices, created_at";

const fail = (status: number, error: string): ConfigFailure => ({ ok: false, status, error });

/**
 * DECISIONS-GAP: D8b says only "ISO8601". A date-time with seconds optional, up to 3 fraction digits and an explicit
 * zone (`Z` or ±hh:mm) is accepted; anything else, including a bare date or a zone-less local time (whose meaning
 * depends on the parser), is `invalid_restore_point`.
 */
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** D8b step 0: the restore point in Unix ms, or null when unparseable, in the future or over 30 days old. */
export function parseRestorePoint(value: unknown, now: number): number | null {
	if (typeof value !== "string" || !ISO_8601_INSTANT.test(value)) return null;
	const at = Date.parse(value);
	if (!Number.isFinite(at) || at > now || at < now - RESTORE_WINDOW_MS) return null;
	return at;
}

/** The error a caller gets when the callee ran `ctx.abort()` (workerd marks it `durableObjectReset`). */
export function isObjectResetError(error: unknown): boolean {
	return error instanceof Error && (error as Error & { durableObjectReset?: unknown }).durableObjectReset === true;
}

function encodeDevices(devices: readonly DeviceRecord[]): ArrayBuffer {
	const bytes = new TextEncoder().encode(JSON.stringify(devices.map((device) => ({
		tokenHash: device.tokenHash, deviceId: device.deviceId, deviceName: device.deviceName,
		enrollmentRequestId: device.enrollmentRequestId, enrolledAt: device.enrolledAt,
	}))));
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function decodeDevices(blob: ArrayBuffer): DeviceRecord[] {
	const value: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(blob)));
	if (!Array.isArray(value)) throw new Error("restore journal: devices is not an array");
	return value.map((entry: Record<string, unknown>) => {
		if (typeof entry?.tokenHash !== "string" || typeof entry.deviceId !== "string" || typeof entry.deviceName !== "string"
			|| typeof entry.enrollmentRequestId !== "string" || typeof entry.enrolledAt !== "number") {
			throw new Error("restore journal: malformed device");
		}
		return { tokenHash: entry.tokenHash, deviceId: entry.deviceId, deviceName: entry.deviceName,
			enrollmentRequestId: entry.enrollmentRequestId, enrolledAt: entry.enrolledAt };
	});
}

export class RestoreRunner {
	/** One run per vault at a time: a second press and the alarm join it. */
	private readonly inFlight = new Map<string, Promise<RestoreResult>>();
	/** Why each vault's last run left its journal row (the reason recorded on give-up). */
	private readonly lastFailure = new Map<string, string>();

	constructor(
		private readonly storage: StoragePort,
		private readonly clock: ClockPort,
		private readonly ports: RestorePorts,
	) {}

	/**
	 * `POST /operator/vaults/:id/restore {"at"}` after the session and registry check. Step 0: a bad `at` → 400 before
	 * any effect. A journal row for the vault means a restore is pending: it is resumed (joined when it is running),
	 * this request's `at` is ignored, and the answer carries `resumed: true` and the journaled `at`. Else the row is
	 * inserted (1 row) and the alarm set to now + 30 s, then steps 1–4 run. DECISIONS-GAP: `at` is validated even when
	 * a restore is pending (D8b orders "PK conflict → resume" before the `at` check without saying which wins).
	 */
	async restore(vaultId: string, requested: unknown): Promise<RestoreResult> {
		const at = parseRestorePoint(requested, this.clock.now());
		if (at === null) return fail(400, "invalid_restore_point");
		const pending = this.journal(vaultId);
		if (pending) {
			// A restore the alarm gave up on: this press resumes it with a new RESTORE_GIVE_UP_MS of alarm retries.
			if (!this.inFlight.has(vaultId) && readRestoreFailures(this.storage).has(vaultId)) {
				pending.created_at = this.clock.now();
				this.storage.transactionSync(() => {
					clearRestoreFailure(this.storage, vaultId);
					this.storage.sql.exec("UPDATE restore_journal SET created_at = ? WHERE vault_id = ? AND restore_id = ?",
						pending.created_at, vaultId, pending.restore_id);
				});
			}
			const result = await (this.inFlight.get(vaultId) ?? this.track(vaultId, () => this.run(pending)));
			if (!result.ok) return await this.keepAlarm(result);
			return { ...result, resumed: true, at: new Date(pending.at).toISOString() };
		}
		const now = this.clock.now();
		const row: JournalRow = { vault_id: vaultId, restore_id: randomBase64Url(16), at, bookmark: null, devices: null, created_at: now };
		this.storage.sql.exec("INSERT INTO restore_journal (vault_id, restore_id, at, created_at) VALUES (?, ?, ?, ?)",
			vaultId, row.restore_id, at, now);
		const result = await this.track(vaultId, async () => {
			await this.ports.alarms.setAlarm(now + RESTORE_ALARM_DELAY_MS);
			return await this.run(row);
		});
		return result.ok ? result : await this.keepAlarm(result);
	}

	/**
	 * The config DO alarm: resumes every journal row not given up on, marks failed each one still left that is
	 * RESTORE_GIVE_UP_MS old, then re-arms while any live row is left (the backoff follows the newest live row).
	 */
	async alarm(): Promise<void> {
		const failed = readRestoreFailures(this.storage);
		const rows = this.storage.sql.exec<JournalRow>(
			`SELECT ${JOURNAL_COLUMNS} FROM restore_journal ORDER BY created_at, vault_id`,
		).toArray().filter((row) => failed.get(row.vault_id)?.restoreId !== row.restore_id);
		let newest: number | null = null;
		for (const row of rows) {
			try {
				await (this.inFlight.get(row.vault_id) ?? this.track(row.vault_id, () => this.run(row)));
			} catch (error) {
				console.error("[yaos-config] restore alarm: run failed", describeError(error));
				this.lastFailure.set(row.vault_id, isCloudflareDailyLimitError(error) ? "cf_daily_limit" : `error: ${describeError(error)}`);
			}
			const left = this.journal(row.vault_id);
			if (left?.restore_id !== row.restore_id) continue;
			const now = this.clock.now();
			if (now - left.created_at >= RESTORE_GIVE_UP_MS) {
				this.giveUp(left, now);
				continue;
			}
			newest = Math.max(newest ?? left.created_at, left.created_at);
		}
		if (newest === null) return;
		const now = this.clock.now();
		const delay = Math.min(Math.max(now - newest, RESTORE_ALARM_DELAY_MS), RESTORE_ALARM_MAX_DELAY_MS);
		await this.ports.alarms.setAlarm(now + delay);
	}

	/** RESTORE_GIVE_UP_MS: the row stays (frozen actions, device snapshot) and is marked failed; no more alarms for it. */
	private giveUp(row: JournalRow, now: number): void {
		const reason = this.lastFailure.get(row.vault_id) ?? "restore_incomplete";
		this.storage.sql.exec(RESTORE_FAILURE_SCHEMA);
		this.storage.sql.exec("INSERT OR REPLACE INTO restore_failure (vault_id, restore_id, failed_at, reason) VALUES (?, ?, ?, ?)",
			row.vault_id, row.restore_id, now, reason);
		console.error(`[yaos-config] restore: gave up on vault ${row.vault_id} (restore to ${new Date(row.at).toISOString()})`
			+ ` after ${Math.round((now - row.created_at) / 3_600_000)} h of retries: ${reason}; a press resumes it`);
	}

	private track(vaultId: string, start: () => Promise<RestoreResult>): Promise<RestoreResult> {
		const run: Promise<RestoreResult> = start().finally(() => {
			if (this.inFlight.get(vaultId) === run) this.inFlight.delete(vaultId);
		});
		this.inFlight.set(vaultId, run);
		return run;
	}

	/** A run that left its journal row (503) must leave an alarm behind; the standing one is kept. */
	private async keepAlarm(result: ConfigFailure): Promise<ConfigFailure> {
		if (result.status === 503 && await this.ports.alarms.getAlarm() === null) {
			await this.ports.alarms.setAlarm(this.clock.now() + RESTORE_ALARM_DELAY_MS);
		}
		return result;
	}

	private journal(vaultId: string): JournalRow | undefined {
		return this.storage.sql.exec<JournalRow>(
			`SELECT ${JOURNAL_COLUMNS} FROM restore_journal WHERE vault_id = ?`, vaultId,
		).toArray()[0];
	}

	/** Vault delete wins (D8b): it deletes the journal row first, and the run stops before its next vault call. */
	private current(row: JournalRow): boolean {
		return this.journal(row.vault_id)?.restore_id === row.restore_id;
	}

	private drop(row: JournalRow): void {
		clearRestoreFailure(this.storage, row.vault_id);
		this.storage.sql.exec("DELETE FROM restore_journal WHERE vault_id = ? AND restore_id = ?", row.vault_id, row.restore_id);
	}

	/** Step 4: the journal row goes (1 row); `200 {vaultEpoch}`. */
	private complete(row: JournalRow, vaultEpoch: string): RestoreResult {
		this.drop(row);
		return { ok: true, vaultEpoch };
	}

	/**
	 * Steps 1–4 for one journal row. Resume: when the journal already holds a snapshot, step 1 only refreshes it while
	 * the vault still carries this restore's marker (not rewound); then always 2 → 3 → 4. Any failure before step 4 →
	 * `503 restore_incomplete` with the row kept (a daily-limit error is rethrown for O9's `cf_daily_limit`).
	 * DECISIONS-GAP: a vault that answers `unknown_vault`, or whose journal row vanished mid-run (vault delete), ends the
	 * run with `404 unknown_vault`; `restore_unsupported` and `invalid_restore_point` from the vault drop the row first.
	 */
	private async run(row: JournalRow): Promise<RestoreResult> {
		try {
			let bookmark = row.bookmark;
			let devices = row.devices ? decodeDevices(row.devices) : null;
			if (!this.current(row)) return fail(404, "unknown_vault");
			const prepared = await this.ports.vault(row.vault_id).prepareRestore(row.restore_id, row.at, bookmark !== null);
			switch (prepared.kind) {
				case "finished":
					return this.complete(row, prepared.vaultEpoch);
				case "unsupported":
					this.drop(row);
					return fail(501, "restore_unsupported");
				case "invalid_point":
					this.drop(row);
					return fail(400, "invalid_restore_point");
				case "unknown_vault":
					this.drop(row);
					return fail(404, "unknown_vault");
				case "prepared":
					if (!this.current(row)) return fail(404, "unknown_vault");
					bookmark = prepared.bookmark;
					devices = prepared.devices;
					this.storage.sql.exec(
						"UPDATE restore_journal SET bookmark = ?, devices = ? WHERE vault_id = ? AND restore_id = ?",
						bookmark, encodeDevices(devices), row.vault_id, row.restore_id,
					);
					break;
				case "skip":
					break;
			}
			if (bookmark === null || devices === null) throw new Error("restore journal: no snapshot after step 1");
			for (let attempt = 0; attempt < MAX_REWINDS_PER_RUN; attempt++) {
				if (!this.current(row)) return fail(404, "unknown_vault");
				const rewound = await this.rewind(row, bookmark);
				if (rewound?.kind === "finished") return this.complete(row, rewound.vaultEpoch);
				if (rewound?.kind === "unknown_vault") {
					this.drop(row);
					return fail(404, "unknown_vault");
				}
				if (rewound?.kind === "unsupported") {
					this.drop(row);
					return fail(501, "restore_unsupported");
				}
				if (!this.current(row)) return fail(404, "unknown_vault");
				const finished = await this.ports.vault(row.vault_id).finishRestore(row.restore_id, devices);
				if (finished.kind === "finished") return this.complete(row, finished.vaultEpoch);
				if (finished.kind === "unknown_vault") {
					this.drop(row);
					return fail(404, "unknown_vault");
				}
			}
			console.warn("[yaos-config] restore: the vault was written after every rewind; the alarm retries");
			this.lastFailure.set(row.vault_id, "rewind_contended");
			return fail(503, "restore_incomplete");
		} catch (error) {
			if (isCloudflareDailyLimitError(error)) throw error;
			console.error("[yaos-config] restore step failed", describeError(error));
			this.lastFailure.set(row.vault_id, `error: ${describeError(error)}`);
			return fail(503, "restore_incomplete");
		}
	}

	/** Step 2. null: the vault aborted as designed (the rewind is armed). Any other error propagates. */
	private async rewind(row: JournalRow, bookmark: string): Promise<RewindResult | null> {
		try {
			return await this.ports.vault(row.vault_id).rewind(row.restore_id, bookmark);
		} catch (error) {
			if (isObjectResetError(error)) return null;
			throw error;
		}
	}
}
