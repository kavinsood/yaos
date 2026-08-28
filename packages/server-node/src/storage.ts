import { createHash } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import type { ControlPlaneStoragePort, ControlPlaneTransactionPort } from "../../../server/src/platformPorts";

export const NODE_STORAGE_VERSION = 1;

export class NewerStorageVersionError extends Error {
	readonly exitCode = 18;

	constructor(
		readonly databasePath: string,
		readonly foundVersion: number,
		readonly supportedVersion = NODE_STORAGE_VERSION,
	) {
		super(`storage at ${databasePath} has version ${foundVersion}; this server supports ${supportedVersion}`);
		this.name = "NewerStorageVersionError";
	}
}

export interface SqlMigration {
	readonly version: number;
	readonly migrate: (database: DatabaseSync) => void;
}

export type SqliteBinding = string | number | bigint | null | Uint8Array;
export type SqliteRowValue = ArrayBuffer | string | number | null;
export type NodeStorageReadinessFailure = "migration" | "storage";


export function bindSqliteValue(value: unknown): SqliteBinding {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
		return value;
	}
	throw new TypeError(`unsupported SQLite binding: ${typeof value}`);
}

export function readSqliteBlob(value: Uint8Array): ArrayBuffer {
	if (value.buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
		return value.buffer;
	}
	const owned = new Uint8Array(value.byteLength);
	owned.set(value);
	return owned.buffer;
}

function normalizeRow<T extends Record<string, SqliteRowValue>>(row: Record<string, unknown>): T {
	const normalized: Record<string, SqliteRowValue> = {};
	for (const [key, value] of Object.entries(row)) {
		if (value instanceof Uint8Array) normalized[key] = readSqliteBlob(value);
		else if (value === null || typeof value === "string" || typeof value === "number") {
			normalized[key] = value;
		} else {
			throw new TypeError(`unsupported SQLite result for column ${key}`);
		}
	}
	return normalized as T;
}

function totalChanges(database: DatabaseSync): number {
	const row = database.prepare("SELECT total_changes() AS value").get() as { value: number | bigint };
	return Number(row.value);
}

function splitSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let start = 0;
	let quote: "'" | "\"" | "`" | "]" | null = null;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < sql.length; index++) {
		const character = sql[index]!;
		const next = sql[index + 1];
		if (lineComment) {
			if (character === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (quote !== null) {
			if (quote === "]") {
				if (character === "]") quote = null;
				continue;
			}
			if (character === quote) {
				if (sql[index + 1] === quote) index++;
				else quote = null;
			}
			continue;
		}
		if (character === "-" && next === "-") {
			lineComment = true;
			index++;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			index++;
			continue;
		}
		if (character === "'" || character === "\"" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "[") {
			quote = "]";
			continue;
		}
		if (character === ";") {
			const statement = sql.slice(start, index).trim();
			if (statement) statements.push(statement);
			start = index + 1;
		}
	}
	const finalStatement = sql.slice(start).trim();
	if (finalStatement) statements.push(finalStatement);
	return statements;
}

export class NodeSqlCursor<T extends Record<string, SqliteRowValue>> implements Iterable<T> {
	private iterator: Iterator<Record<string, unknown>> | null;
	private buffered: T[] | null = null;
	private started = false;
	private complete = false;
	private readCount = 0;
	private writtenCount: number;

	constructor(
		private readonly database: DatabaseSync,
		iterator: Iterator<Record<string, unknown>> | null,
		private readonly changesBefore: number,
		rowsWritten = 0,
	) {
		this.iterator = iterator;
		this.complete = iterator === null;
		this.writtenCount = rowsWritten;
	}

	get rowsRead(): number {
		return this.readCount;
	}

	get rowsWritten(): number {
		if (!this.complete) this.finishForMetadata();
		return this.writtenCount;
	}

	[Symbol.iterator](): Iterator<T> {
		if (this.started) throw new Error("SQLite cursor can only be consumed once");
		this.started = true;
		if (this.buffered !== null) {
			const rows = this.buffered;
			this.buffered = null;
			return rows[Symbol.iterator]();
		}
		return this.lazyIterator();
	}

	toArray(): T[] {
		return Array.from(this);
	}

	one(): T {
		const iterator = this[Symbol.iterator]();
		const first = iterator.next();
		if (first.done) throw new Error("SQLite cursor expected one row, received zero");
		const second = iterator.next();
		if (!second.done) {
			for (let next = iterator.next(); !next.done; next = iterator.next()) {
				// Drain so write accounting remains exact before reporting the cardinality error.
			}
			throw new Error("SQLite cursor expected one row, received more than one");
		}
		return first.value;
	}

	private lazyIterator(): Iterator<T> {
		const source = this.iterator;
		if (source === null) return [][Symbol.iterator]();
		return {
			next: (): IteratorResult<T> => {
				const next = source.next();
				if (next.done) {
					this.markComplete();
					return { done: true, value: undefined };
				}
				this.readCount++;
				return { done: false, value: normalizeRow<T>(next.value) };
			},
			return: (): IteratorResult<T> => {
				if (typeof source.return === "function") source.return();
				this.markComplete();
				return { done: true, value: undefined };
			},
		};
	}

	private finishForMetadata(): void {
		const source = this.iterator;
		if (source === null) return;
		const rows: T[] | null = this.started ? null : [];
		for (let next = source.next(); !next.done; next = source.next()) {
			this.readCount++;
			if (rows) rows.push(normalizeRow<T>(next.value));
		}
		this.buffered = rows;
		this.markComplete();
	}

	private markComplete(): void {
		if (this.complete) return;
		this.complete = true;
		this.iterator = null;
		this.writtenCount = totalChanges(this.database) - this.changesBefore;
	}
}

export class NodeSqliteStorage {
	readonly sql = {
		exec: <T extends Record<string, SqliteRowValue>>(query: string, ...bindings: unknown[]): NodeSqlCursor<T> =>
			this.exec<T>(query, ...bindings),
	};

	private transactionDepth = 0;
	private savepointSequence = 0;
	private closed = false;

	constructor(
		readonly path: string,
		readonly database: DatabaseSync,
		private readonly supportedVersion = NODE_STORAGE_VERSION,
	) {}

	static open(path: string, migrations: readonly SqlMigration[] = BASE_MIGRATIONS): NodeSqliteStorage {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const database = new DatabaseSync(path);
		try {
			database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
			applyForwardMigrations(database, path, migrations);
			return new NodeSqliteStorage(path, database, migrations.length);
		} catch (error) {
			database.close();
			throw error;
		}
	}

	exec<T extends Record<string, SqliteRowValue>>(query: string, ...bindings: unknown[]): NodeSqlCursor<T> {
		this.assertOpen();
		const statements = splitSqlStatements(query);
		if (statements.length === 0) return new NodeSqlCursor<T>(this.database, null, totalChanges(this.database));
		if (statements.length > 1) {
			if (bindings.length !== 0) throw new Error("bindings are not supported for multi-statement SQLite exec");
			const before = totalChanges(this.database);
			this.database.exec(query);
			return new NodeSqlCursor<T>(this.database, null, before, totalChanges(this.database) - before);
		}
		const statement = this.database.prepare(statements[0]!);
		const values = bindings.map(bindSqliteValue);
		const before = totalChanges(this.database);
		if (statement.columns().length === 0) {
			const result = statement.run(...values);
			return new NodeSqlCursor<T>(this.database, null, before, Number(result.changes));
		}
		const iterator = statement.iterate(...values) as Iterator<Record<string, unknown>>;
		return new NodeSqlCursor<T>(this.database, iterator, before);
	}

	transactionSync<T>(closure: () => T): T {
		this.assertOpen();
		const savepoint = this.beginTransaction();
		try {
			const result = closure();
			if (result !== null && typeof result === "object" && "then" in result) {
				throw new TypeError("transactionSync closure returned a Promise");
			}
			this.commitTransaction(savepoint);
			return result;
		} catch (error) {
			this.rollbackTransaction(savepoint);
			throw error;
		}
	}

	async transaction<T>(closure: () => Promise<T>): Promise<T> {
		this.assertOpen();
		const savepoint = this.beginTransaction();
		try {
			const result = await closure();
			this.commitTransaction(savepoint);
			return result;
		} catch (error) {
			this.rollbackTransaction(savepoint);
			throw error;
		}
	}

	readinessFailure(): NodeStorageReadinessFailure | null {
		if (this.closed) return "storage";
		try {
			const versionRow = this.database.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
			const version = Number(versionRow.user_version);
			if (!Number.isSafeInteger(version) || version !== this.supportedVersion) return "migration";
			const probe = this.database.prepare("SELECT 1 AS value").get() as { value: number | bigint } | undefined;
			return probe && Number(probe.value) === 1 ? null : "storage";
		} catch {
			return "storage";
		}
	}

	async deleteAll(): Promise<void> {
		this.assertOpen();
		if (this.transactionDepth !== 0) throw new Error("cannot delete all SQLite storage inside a transaction");
		const rows = this.database.prepare(
			`SELECT type, name FROM sqlite_schema
			 WHERE name NOT LIKE 'sqlite_%' AND type IN ('trigger', 'view', 'table')
			 ORDER BY CASE type WHEN 'trigger' THEN 1 WHEN 'view' THEN 2 ELSE 3 END`,
		).all() as Array<{ type: "trigger" | "view" | "table"; name: string }>;
		this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
		try {
			for (const row of rows) {
				const identifier = `"${row.name.replaceAll("\"", "\"\"")}"`;
				this.database.exec(`DROP ${row.type.toUpperCase()} IF EXISTS ${identifier}`);
			}
			this.database.exec("COMMIT; PRAGMA foreign_keys = ON");
		} catch (error) {
			this.database.exec("ROLLBACK; PRAGMA foreign_keys = ON");
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		if (this.transactionDepth !== 0) throw new Error(`cannot close SQLite database with ${this.transactionDepth} open transaction(s)`);
		this.closed = true;
		this.database.close();
	}

	private beginTransaction(): string | null {
		if (this.transactionDepth === 0) {
			this.database.exec("BEGIN IMMEDIATE");
			this.transactionDepth = 1;
			return null;
		}
		const savepoint = `yaos_sp_${++this.savepointSequence}`;
		this.database.exec(`SAVEPOINT ${savepoint}`);
		this.transactionDepth++;
		return savepoint;
	}

	private commitTransaction(savepoint: string | null): void {
		if (savepoint === null) this.database.exec("COMMIT");
		else this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
		this.transactionDepth--;
	}

	private rollbackTransaction(savepoint: string | null): void {
		try {
			if (savepoint === null) this.database.exec("ROLLBACK");
			else this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
		} finally {
			this.transactionDepth--;
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error(`SQLite database is closed: ${this.path}`);
	}
}

function applyForwardMigrations(
	database: DatabaseSync,
	path: string,
	migrations: readonly SqlMigration[],
): void {
	const ordered = [...migrations].sort((left, right) => left.version - right.version);
	for (let index = 0; index < ordered.length; index++) {
		if (ordered[index]!.version !== index + 1) throw new Error("SQLite migrations must be contiguous and start at version 1");
	}
	const row = database.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
	let current = Number(row.user_version);
	const supported = ordered.length;
	if (current > supported) throw new NewerStorageVersionError(path, current, supported);
	while (current < supported) {
		const migration = ordered[current]!;
		database.exec("BEGIN IMMEDIATE");
		try {
			migration.migrate(database);
			database.exec(`PRAGMA user_version = ${migration.version}`);
			database.exec("COMMIT");
			current = migration.version;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}
}

const BASE_MIGRATIONS: readonly SqlMigration[] = [{
	version: 1,
	migrate: () => {},
}];

const CONTROL_MIGRATIONS: readonly SqlMigration[] = [{
	version: 1,
	migrate: (database) => {
		database.exec(`
			CREATE TABLE node_kv (
				namespace TEXT NOT NULL,
				key TEXT NOT NULL,
				value BLOB NOT NULL,
				PRIMARY KEY (namespace, key)
			) WITHOUT ROWID;
			CREATE TABLE node_alarms (
				actor_kind TEXT NOT NULL,
				actor_name TEXT NOT NULL,
				deadline_ms INTEGER,
				lease_id TEXT,
				lease_until_ms INTEGER,
				abandoned_dispatches INTEGER NOT NULL DEFAULT 0,
				quarantine_reason TEXT,
				revision INTEGER NOT NULL DEFAULT 1,
				PRIMARY KEY (actor_kind, actor_name),
				CHECK ((lease_id IS NULL) = (lease_until_ms IS NULL)),
				CHECK (abandoned_dispatches BETWEEN 0 AND 3)
			) WITHOUT ROWID;
			CREATE INDEX node_alarms_due ON node_alarms(deadline_ms)
				WHERE deadline_ms IS NOT NULL AND quarantine_reason IS NULL;
		`);
	},
}];

export interface KvListOptions {
	readonly prefix?: string;
	readonly start?: string;
	readonly end?: string;
	readonly limit?: number;
	readonly reverse?: boolean;
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

class StagedKvTransaction implements ControlPlaneTransactionPort {
	private readonly writes = new Map<string, Uint8Array>();
	private readonly deletes = new Set<string>();
	private readonly reads = new Map<string, unknown>();

	constructor(private readonly load: <T>(key: string) => T | undefined) {}

	async get<T = unknown>(key: string): Promise<T | undefined> {
		if (this.deletes.has(key)) return undefined;
		if (this.writes.has(key)) return deserialize(this.writes.get(key)!) as T;
		if (!this.reads.has(key)) this.reads.set(key, this.load<T>(key));
		return this.reads.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.deletes.delete(key);
		this.writes.set(key, serialize(value));
	}

	async delete(key: string): Promise<boolean> {
		const existed = this.writes.has(key) || await this.get(key) !== undefined;
		this.writes.delete(key);
		this.deletes.add(key);
		return existed;
	}

	commit(remove: (key: string) => void, write: (key: string, value: Uint8Array) => void): void {
		for (const key of this.deletes) remove(key);
		for (const [key, value] of this.writes) write(key, value);
	}
}

export class SqliteKvStore implements ControlPlaneStoragePort {
	private operationTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly storage: NodeSqliteStorage,
		readonly namespace: string,
	) {
		if (!namespace) throw new Error("KV namespace is required");
	}

	get<T>(key: string): Promise<T | undefined> {
		return this.enqueue(() => this.getDirect<T>(key));
	}

	put(key: string, value: unknown): Promise<void> {
		return this.enqueue(() => this.putDirect(key, value));
	}

	delete(key: string): Promise<boolean> {
		return this.enqueue(() => this.deleteDirect(key));
	}

	list<T>(options: KvListOptions = {}): Promise<Map<string, T>> {
		return this.enqueue(() => {
			const clauses = ["namespace = ?"];
			const bindings: unknown[] = [this.namespace];
			if (options.prefix !== undefined) {
				clauses.push("key LIKE ? ESCAPE '\\\\'");
				bindings.push(`${escapeLike(options.prefix)}%`);
			}
			if (options.start !== undefined) {
				clauses.push("key >= ?");
				bindings.push(options.start);
			}
			if (options.end !== undefined) {
				clauses.push("key < ?");
				bindings.push(options.end);
			}
			const limit = options.limit ?? 1_000;
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
				throw new RangeError("KV list limit must be between 1 and 10000");
			}
			bindings.push(limit);
			const rows = this.storage.sql.exec<{ key: string; value: ArrayBuffer }>(
				`SELECT key, value FROM node_kv WHERE ${clauses.join(" AND ")} ORDER BY key ${options.reverse ? "DESC" : "ASC"} LIMIT ?`,
				...bindings,
			);
			const result = new Map<string, T>();
			for (const row of rows) result.set(row.key, deserialize(Buffer.from(row.value)) as T);
			return result;
		});
	}

	transaction<T>(closure: (transaction: ControlPlaneTransactionPort) => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const transaction = new StagedKvTransaction(<V>(key: string) => this.getDirect<V>(key));
			const result = await closure(transaction);
			this.storage.transactionSync(() => transaction.commit(
				(key) => {
					this.deleteDirect(key);
				},
				(key, value) => {
					this.putEncodedDirect(key, value);
				},
			));
			return result;
		});
	}

	private getDirect<T>(key: string): T | undefined {
		const row = this.storage.sql.exec<{ value: ArrayBuffer }>(
			"SELECT value FROM node_kv WHERE namespace = ? AND key = ?",
			this.namespace,
			key,
		).toArray()[0];
		return row ? deserialize(Buffer.from(row.value)) as T : undefined;
	}

	private putDirect(key: string, value: unknown): void {
		this.putEncodedDirect(key, serialize(value));
	}

	private putEncodedDirect(key: string, encoded: Uint8Array): void {
		this.storage.sql.exec(
			`INSERT INTO node_kv(namespace, key, value) VALUES (?, ?, ?)
			 ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`,
			this.namespace,
			key,
			encoded,
		);
	}

	private deleteDirect(key: string): boolean {
		return this.storage.sql.exec(
			"DELETE FROM node_kv WHERE namespace = ? AND key = ?",
			this.namespace,
			key,
		).rowsWritten !== 0;
	}

	private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export class NodeDatabaseSet {
	readonly control: NodeSqliteStorage;
	private readonly vaults = new Map<string, NodeSqliteStorage>();
	private readonly jobs = new Map<string, NodeSqliteStorage>();
	private closed = false;

	constructor(readonly dataDirectory: string) {
		mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
		const vaultDirectory = join(dataDirectory, "vaults");
		const jobDirectory = join(dataDirectory, "jobs");
		mkdirSync(vaultDirectory, { recursive: true, mode: 0o700 });
		mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
		this.control = NodeSqliteStorage.open(join(dataDirectory, "control.sqlite"), CONTROL_MIGRATIONS);
		try {
			for (const directory of [vaultDirectory, jobDirectory]) {
				for (const entry of readdirSync(directory, { withFileTypes: true })) {
					if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
					const database = NodeSqliteStorage.open(join(directory, entry.name));
					database.close();
				}
			}
		} catch (error) {
			this.control.close();
			throw error;
		}
	}

	controlKv(actorName: string): SqliteKvStore {
		return new SqliteKvStore(this.control, actorName);
	}

	vault(actorName: string): NodeSqliteStorage {
		return this.actorDatabase("vault", actorName, this.vaults);
	}

	job(actorName: string): NodeSqliteStorage {
		return this.actorDatabase("job", actorName, this.jobs);
	}

	readinessFailure(): NodeStorageReadinessFailure | null {
		const controlFailure = this.control.readinessFailure();
		if (controlFailure) return controlFailure;
		for (const database of this.vaults.values()) {
			const failure = database.readinessFailure();
			if (failure) return failure;
		}
		for (const database of this.jobs.values()) {
			const failure = database.readinessFailure();
			if (failure) return failure;
		}
		return null;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const database of this.jobs.values()) database.close();
		for (const database of this.vaults.values()) database.close();
		this.control.close();
		this.jobs.clear();
		this.vaults.clear();
	}

	private actorDatabase(
		kind: "vault" | "job",
		actorName: string,
		cache: Map<string, NodeSqliteStorage>,
	): NodeSqliteStorage {
		if (this.closed) throw new Error("Node database set is closed");
		const existing = cache.get(actorName);
		if (existing) return existing;
		const hash = createHash("sha256").update(actorName).digest("hex");
		const database = NodeSqliteStorage.open(join(this.dataDirectory, `${kind}s`, `${hash}.sqlite`));
		cache.set(actorName, database);
		return database;
	}
}
