import { hostname } from "node:os";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { NodeSqliteStorage, SqliteRowValue } from "./storage";

export const LOCKED_EXIT_CODE = 17;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_ALARM_LEASE_MS = 30_000;
const ALARM_RETRY_DELAY_MS = 1_000;
const MAX_ABANDONED_DISPATCHES = 3;

export class DataDirectoryLockedError extends Error {
	readonly exitCode = LOCKED_EXIT_CODE;

	constructor(readonly lockPath: string) {
		super(`another YAOS Node server owns ${lockPath}`);
		this.name = "DataDirectoryLockedError";
	}
}

function isSqliteBusy(error: unknown): boolean {
	return error instanceof Error && (error.message.includes("database is locked") || error.message.includes("SQLITE_BUSY"));
}

/** A separate SQLite exclusive transaction is an OS-backed process lock released by SIGKILL. */
export class ProcessDataLock {
	private released = false;

	private constructor(
		readonly path: string,
		private readonly database: DatabaseSync,
	) {}

	static acquire(dataDirectory: string): ProcessDataLock {
		mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
		const path = join(dataDirectory, "runtime.lock");
		const descriptor = openSync(path, "a", 0o600);
		closeSync(descriptor);
		chmodSync(path, 0o600);
		const database = new DatabaseSync(path);
		try {
			database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS lock_identity (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL);");
			database.exec("BEGIN EXCLUSIVE");
			database.prepare("INSERT OR REPLACE INTO lock_identity(id, owner) VALUES (1, ?)").run(JSON.stringify({
				pid: process.pid,
				hostname: hostname(),
				startedAt: Date.now(),
				nonce: randomUUID(),
			}));
			return new ProcessDataLock(path, database);
		} catch (error) {
			database.close();
			if (isSqliteBusy(error)) throw new DataDirectoryLockedError(path);
			throw error;
		}
	}

	ownsLock(): boolean {
		if (this.released) return false;
		try {
			this.database.prepare("SELECT 1").get();
			return true;
		} catch {
			return false;
		}
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		try {
			this.database.exec("ROLLBACK");
		} finally {
			this.database.close();
		}
	}
}

export type ActorKind = "config" | "vault" | "recovery-job";
export interface RuntimeActor {
	fetch?(request: Request): Promise<Response>;
	dispatch?(dispatchId: string): Promise<void>;
	close?(): Promise<void> | void;
}
export type ActorFactory = (kind: ActorKind, name: string) => RuntimeActor;

class SerializedActor {
	private entryTail: Promise<void> = Promise.resolve();
	private readonly inFlight = new Set<Promise<void>>();
	private accepting = true;
	private actor: RuntimeActor | null = null;

	constructor(
		readonly kind: ActorKind,
		readonly name: string,
		private readonly factory: ActorFactory,
	) {}

	run<T>(operation: (actor: RuntimeActor) => Promise<T>): Promise<T> {
		if (!this.accepting) return Promise.reject(new Error(`actor ${this.kind}:${this.name} is draining`));
		let operationResult: Promise<T> | null = null;
		const entered = this.entryTail.then(() => {
			if (!this.actor) this.actor = this.factory(this.kind, this.name);
			operationResult = operation(this.actor);
		});
		this.entryTail = entered.then(
			() => undefined,
			() => undefined,
		);
		const result = entered.then(() => {
			if (!operationResult) throw new Error(`actor ${this.kind}:${this.name} did not enter its operation`);
			return operationResult;
		});
		const tracked = result.then(
			() => undefined,
			() => undefined,
		);
		this.inFlight.add(tracked);
		void tracked.then(() => this.inFlight.delete(tracked));
		return result;
	}

	async drain(): Promise<void> {
		if (!this.accepting) {
			await this.entryTail;
			await Promise.all(this.inFlight);
			return;
		}
		this.accepting = false;
		await this.entryTail;
		await Promise.all(this.inFlight);
		await this.actor?.close?.();
	}
}

export class ActorRegistry {
	private readonly actors = new Map<string, SerializedActor>();
	private accepting = true;

	constructor(private readonly factory: ActorFactory) {}

	call<T>(kind: ActorKind, name: string, operation: (actor: RuntimeActor) => Promise<T>): Promise<T> {
		if (!this.accepting) return Promise.reject(new Error("actor registry is draining"));
		if (!name || name.includes("\0")) return Promise.reject(new Error("invalid actor name"));
		const key = `${kind}\0${name}`;
		let actor = this.actors.get(key);
		if (!actor) {
			actor = new SerializedActor(kind, name, this.factory);
			this.actors.set(key, actor);
		}
		return actor.run(operation);
	}

	fetch(kind: ActorKind, name: string, request: Request): Promise<Response> {
		return this.call(kind, name, async (actor) => {
			if (!actor.fetch) throw new Error(`actor ${kind}:${name} does not accept HTTP calls`);
			return await actor.fetch(request);
		});
	}

	dispatch(kind: ActorKind, name: string, dispatchId: string): Promise<void> {
		return this.call(kind, name, async (actor) => {
			if (!actor.dispatch) throw new Error(`actor ${kind}:${name} has no alarm dispatcher`);
			await actor.dispatch(dispatchId);
		});
	}

	async drain(): Promise<void> {
		if (!this.accepting) return;
		this.accepting = false;
		await Promise.all(Array.from(this.actors.values(), (actor) => actor.drain()));
		this.actors.clear();
	}
}

interface AlarmRow extends Record<string, SqliteRowValue> {
	actor_kind: ActorKind;
	actor_name: string;
	deadline_ms: number | null;
	lease_id: string | null;
	lease_until_ms: number | null;
	abandoned_dispatches: number;
	quarantine_reason: string | null;
	revision: number;
}

interface AlarmClaim {
	kind: ActorKind;
	name: string;
	dispatchId: string;
	revision: number;
}

export interface AlarmPort {
	setAlarm(scheduledTime: number | Date): Promise<void>;
	deleteAlarm(): Promise<void>;
}

export interface AlarmSchedulerOptions {
	readonly leaseMs?: number;
	readonly now?: () => number;
	readonly onDispatchError?: (error: unknown, actor: { kind: ActorKind; name: string }) => void;
	readonly onQuarantine?: (actor: { kind: ActorKind; name: string; abandonedDispatches: number }) => void;
}

/** Timers only wake work; deadlines and pre-dispatch leases live in control.sqlite. */
export class DurableAlarmScheduler {
	private readonly leaseMs: number;
	private readonly now: () => number;
	private timer: NodeJS.Timeout | undefined;
	private started = false;
	private stopping = false;
	private wakeRunning = false;

	constructor(
		private readonly storage: NodeSqliteStorage,
		private readonly dispatch: (kind: ActorKind, name: string, dispatchId: string) => Promise<void>,
		private readonly options: AlarmSchedulerOptions = {},
	) {
		this.leaseMs = options.leaseMs ?? DEFAULT_ALARM_LEASE_MS;
		this.now = options.now ?? Date.now;
		if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000) throw new RangeError("alarm lease must be at least one second");
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.stopping = false;
		queueMicrotask(() => void this.wake());
	}

	forActor(kind: ActorKind, name: string): AlarmPort {
		return {
			setAlarm: async (scheduledTime) => {
				await this.set(kind, name, scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime);
			},
			deleteAlarm: async () => {
				await this.delete(kind, name);
			},
		};
	}

	async set(kind: ActorKind, name: string, deadlineMs: number): Promise<void> {
		if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new RangeError("alarm deadline must be a non-negative safe integer");
		const write = this.storage.sql.exec(
			`INSERT INTO node_alarms(actor_kind, actor_name, deadline_ms)
			 VALUES (?, ?, ?)
			 ON CONFLICT(actor_kind, actor_name) DO UPDATE SET
				deadline_ms = excluded.deadline_ms,
				revision = node_alarms.revision + 1
			 WHERE node_alarms.quarantine_reason IS NULL`,
			kind,
			name,
			deadlineMs,
		);
		if (write.rowsWritten === 0) throw new Error(`alarm ${kind}:${name} is quarantined; use retryQuarantined`);
		this.armNext();
	}

	async delete(kind: ActorKind, name: string): Promise<void> {
		this.storage.sql.exec("DELETE FROM node_alarms WHERE actor_kind = ? AND actor_name = ?", kind, name);
		this.armNext();
	}

	async retryQuarantined(kind: ActorKind, name: string, deadlineMs = this.now()): Promise<void> {
		if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) throw new RangeError("alarm deadline must be a non-negative safe integer");
		const write = this.storage.sql.exec(
			`UPDATE node_alarms
			 SET deadline_ms = ?, lease_id = NULL, lease_until_ms = NULL,
				abandoned_dispatches = 0, quarantine_reason = NULL, revision = revision + 1
			 WHERE actor_kind = ? AND actor_name = ? AND quarantine_reason IS NOT NULL`,
			deadlineMs,
			kind,
			name,
		);
		if (write.rowsWritten === 0) throw new Error(`alarm ${kind}:${name} is not quarantined`);
		this.armNext();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		while (this.wakeRunning) await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}

	private async wake(): Promise<void> {
		if (this.stopping || this.wakeRunning) return;
		this.wakeRunning = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		try {
			const claim = this.claimDue();
			if (claim) {
				try {
					await this.dispatch(claim.kind, claim.name, claim.dispatchId);
					this.finishDispatch(claim);
				} catch (error) {
					this.retryDispatch(claim);
					this.options.onDispatchError?.(error, { kind: claim.kind, name: claim.name });
				}
			}
		} finally {
			this.wakeRunning = false;
			if (!this.stopping) this.armNext();
		}
	}

	private claimDue(): AlarmClaim | null {
		return this.storage.transactionSync(() => {
			const now = this.now();
			const row = this.storage.sql.exec<AlarmRow>(
				`SELECT actor_kind, actor_name, deadline_ms, lease_id, lease_until_ms,
					abandoned_dispatches, quarantine_reason, revision
				 FROM node_alarms
				 WHERE quarantine_reason IS NULL
					AND ((lease_id IS NULL AND deadline_ms <= ?) OR (lease_id IS NOT NULL AND lease_until_ms <= ?))
				 ORDER BY COALESCE(lease_until_ms, deadline_ms), actor_kind, actor_name
				 LIMIT 1`,
				now,
				now,
			).toArray()[0];
			if (!row) return null;
			if (row.lease_id !== null) {
				const abandoned = row.abandoned_dispatches + 1;
				if (abandoned >= MAX_ABANDONED_DISPATCHES) {
					this.storage.sql.exec(
						`UPDATE node_alarms SET deadline_ms = NULL, lease_id = NULL, lease_until_ms = NULL,
							abandoned_dispatches = ?, quarantine_reason = 'three_abandoned_dispatches', revision = revision + 1
						 WHERE actor_kind = ? AND actor_name = ? AND revision = ?`,
						abandoned,
						row.actor_kind,
						row.actor_name,
						row.revision,
					);
					this.options.onQuarantine?.({ kind: row.actor_kind, name: row.actor_name, abandonedDispatches: abandoned });
					return null;
				}
				const backoff = Math.min(60_000, 1_000 * (2 ** (abandoned - 1)));
				this.storage.sql.exec(
					`UPDATE node_alarms SET deadline_ms = ?, lease_id = NULL, lease_until_ms = NULL,
						abandoned_dispatches = ?, revision = revision + 1
					 WHERE actor_kind = ? AND actor_name = ? AND revision = ?`,
					now + backoff,
					abandoned,
					row.actor_kind,
					row.actor_name,
					row.revision,
				);
				return null;
			}
			const dispatchId = randomUUID();
			const write = this.storage.sql.exec(
				`UPDATE node_alarms SET lease_id = ?, lease_until_ms = ?, revision = revision + 1
				 WHERE actor_kind = ? AND actor_name = ? AND revision = ? AND lease_id IS NULL`,
				dispatchId,
				now + this.leaseMs,
				row.actor_kind,
				row.actor_name,
				row.revision,
			);
			return write.rowsWritten === 1
				? { kind: row.actor_kind, name: row.actor_name, dispatchId, revision: row.revision + 1 }
				: null;
		});
	}

	private finishDispatch(claim: AlarmClaim): void {
		this.storage.transactionSync(() => {
			const current = this.storage.sql.exec<Pick<AlarmRow, "lease_id" | "revision"> & Record<string, SqliteRowValue>>(
				"SELECT lease_id, revision FROM node_alarms WHERE actor_kind = ? AND actor_name = ?",
				claim.kind,
				claim.name,
			).toArray()[0];
			if (!current || current.lease_id !== claim.dispatchId) return;
			if (current.revision === claim.revision) {
				this.storage.sql.exec("DELETE FROM node_alarms WHERE actor_kind = ? AND actor_name = ? AND lease_id = ?", claim.kind, claim.name, claim.dispatchId);
			} else {
				this.storage.sql.exec(
					`UPDATE node_alarms SET lease_id = NULL, lease_until_ms = NULL,
						abandoned_dispatches = 0, revision = revision + 1
					 WHERE actor_kind = ? AND actor_name = ? AND lease_id = ?`,
					claim.kind,
					claim.name,
					claim.dispatchId,
				);
			}
		});
	}

	private retryDispatch(claim: AlarmClaim): void {
		const retryDeadline = Math.min(Number.MAX_SAFE_INTEGER, this.now() + ALARM_RETRY_DELAY_MS);
		this.storage.sql.exec(
			`UPDATE node_alarms SET
				deadline_ms = CASE WHEN revision = ? THEN ? ELSE deadline_ms END,
				lease_id = NULL, lease_until_ms = NULL,
				abandoned_dispatches = 0, revision = revision + 1
			 WHERE actor_kind = ? AND actor_name = ? AND lease_id = ?`,
			claim.revision,
			retryDeadline,
			claim.kind,
			claim.name,
			claim.dispatchId,
		);
	}

	private armNext(): void {
		if (!this.started || this.stopping || this.wakeRunning) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		const row = this.storage.sql.exec<{ due: number | null }>(
			`SELECT MIN(CASE WHEN lease_id IS NULL THEN deadline_ms ELSE lease_until_ms END) AS due
			 FROM node_alarms WHERE quarantine_reason IS NULL`,
		).toArray()[0];
		if (row?.due === null || row?.due === undefined) return;
		const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, row.due - this.now()));
		this.timer = setTimeout(() => void this.wake(), delay);
		this.timer.unref();
	}
}
