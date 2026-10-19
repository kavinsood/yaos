// Node `node:sqlite` stand-in for Durable Object SQL storage, for tests and lab scripts.
// Trimmed from the removed packages/server-node/src/storage.ts: only the surface the remaining
// importers use (open, sql.exec with a Cloudflare-shaped cursor, transactionSync, close).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteBinding = string | number | null | Uint8Array;
export type SqliteRowValue = ArrayBuffer | string | number | null;

/**
 * Durable Object SQL limits (developers.cloudflare.com/durable-objects/platform/limits/): what workerd refuses is
 * refused here too, so a query that only works on Node fails its suite.
 */
export const DO_SQL_MAX_BINDINGS = 100;
export const DO_SQL_MAX_STATEMENT_BYTES = 100 * 1024;
export const DO_SQL_MAX_VALUE_BYTES = 2 * 1024 * 1024;
/** workerd refuses these through `sql.exec`: transactions go through `transactionSync`. */
const DO_SQL_FORBIDDEN = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

function bindSqliteValue(value: unknown): SqliteBinding {
	let bound: SqliteBinding;
	if (value instanceof ArrayBuffer) bound = new Uint8Array(value);
	else if (ArrayBuffer.isView(value)) bound = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	// Durable Object SQL takes ArrayBuffer(View) | string | number | null; a bigint or boolean throws there.
	else if (value === null || typeof value === "string" || typeof value === "number") bound = value;
	else throw new TypeError(`unsupported SQLite binding: ${typeof value}`);
	const size = typeof bound === "string" ? Buffer.byteLength(bound) : bound instanceof Uint8Array ? bound.byteLength : 0;
	if (size > DO_SQL_MAX_VALUE_BYTES) throw new RangeError(`SQL value of ${size} bytes is over the Durable Object limit`);
	return bound;
}

function assertDurableObjectSql(query: string, statements: readonly string[], bindings: number): void {
	if (Buffer.byteLength(query) > DO_SQL_MAX_STATEMENT_BYTES) throw new RangeError("SQL statement too long for a Durable Object");
	if (bindings > DO_SQL_MAX_BINDINGS) throw new RangeError(`too many SQL variables (${bindings} > ${DO_SQL_MAX_BINDINGS})`);
	for (const statement of statements) {
		if (DO_SQL_FORBIDDEN.test(statement)) throw new Error(`Durable Object SQL refuses "${statement.slice(0, 20)}": use transactionSync`);
	}
}

function readSqliteBlob(value: Uint8Array): ArrayBuffer {
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
	) {}

	static open(path: string): NodeSqliteStorage {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const database = new DatabaseSync(path);
		try {
			database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
			return new NodeSqliteStorage(path, database);
		} catch (error) {
			database.close();
			throw error;
		}
	}

	exec<T extends Record<string, SqliteRowValue>>(query: string, ...bindings: unknown[]): NodeSqlCursor<T> {
		this.assertOpen();
		const statements = splitSqlStatements(query);
		assertDurableObjectSql(query, statements, bindings.length);
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
