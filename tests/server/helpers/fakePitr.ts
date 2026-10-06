// Fake Durable Object point-in-time recovery for the D8b white-box tests (T-RESTORE-RESUME-WB). `capture(at)` copies
// every table of the object's SQLite file (schema and rows, around the row model, so nothing is billed); a bookmark
// names one capture. `abort()` applies the armed capture and restarts the object, as Cloudflare's `ctx.abort()` after
// `ctx.storage.onNextSessionRestoreBookmark()` does (the next session starts on the restored storage), and throws the
// error the caller of a reset object sees (`durableObjectReset: true`).
import type { PitrPort } from "../../../server/src/vault/host";
import type { NodeSqliteStorage, SqliteRowValue } from "./nodeSqliteStorage";

/** Local workerd's rejection of `getBookmarkForTime` (measured on wrangler dev; see vault/host.ts). */
export const PITR_UNSUPPORTED_MESSAGE = "This Durable Object's storage back-end does not implement point-in-time recovery.";

interface TableCopy {
	name: string;
	sql: string;
	rows: Array<Record<string, SqliteRowValue>>;
}

interface Capture {
	at: number;
	bookmark: string;
	tables: TableCopy[];
	indexes: string[];
}

export class FakePitr implements PitrPort {
	/** Behave like local workerd: `getBookmarkForTime` rejects. */
	unsupported = false;
	/** The bookmark the next `abort()` applies. */
	armed: string | null = null;
	/** Every port call, in order. */
	readonly calls: string[] = [];
	/** When set, `onNextSessionRestoreBookmark` waits for it first (a test interleaves a request into the rewind). */
	pause: Promise<void> | null = null;
	private readonly captures: Capture[] = [];
	private nextBookmark = 0;

	constructor(private readonly storage: NodeSqliteStorage, private readonly reset: () => void) {}

	/** Records the object's storage as of `at` (captures are taken in time order). */
	capture(at: number): string {
		const tables = this.storage.sql.exec<{ name: string; sql: string }>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
		).toArray().map(({ name, sql }) => ({
			name, sql, rows: this.storage.sql.exec<Record<string, SqliteRowValue>>(`SELECT * FROM "${name}"`).toArray(),
		}));
		const indexes = this.storage.sql.exec<{ sql: string }>(
			"SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY rowid",
		).toArray().map((row) => row.sql);
		const bookmark = `bookmark-${++this.nextBookmark}`;
		this.captures.push({ at, bookmark, tables, indexes });
		return bookmark;
	}

	getBookmarkForTime(at: number): Promise<string> {
		this.calls.push("getBookmarkForTime");
		if (this.unsupported) return Promise.reject(new Error(PITR_UNSUPPORTED_MESSAGE));
		const capture = this.captures.filter((entry) => entry.at <= at).at(-1);
		return capture ? Promise.resolve(capture.bookmark) : Promise.reject(new Error("fake PITR: no capture at or before at"));
	}

	async onNextSessionRestoreBookmark(bookmark: string): Promise<string> {
		this.calls.push("onNextSessionRestoreBookmark");
		if (this.pause) await this.pause;
		if (!this.captures.some((entry) => entry.bookmark === bookmark)) throw new Error("fake PITR: unknown bookmark");
		this.armed = bookmark;
		return bookmark;
	}

	abort(reason: string): never {
		this.calls.push("abort");
		const armed = this.captures.find((entry) => entry.bookmark === this.armed);
		this.armed = null;
		if (armed) this.apply(armed);
		this.reset();
		throw Object.assign(new Error(reason), { durableObjectReset: true });
	}

	private apply(capture: Capture): void {
		this.storage.transactionSync(() => {
			const current = this.storage.sql.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray();
			for (const { name } of current) this.storage.sql.exec(`DROP TABLE "${name}"`);
			for (const table of capture.tables) {
				this.storage.sql.exec(table.sql);
				for (const row of table.rows) {
					const columns = Object.keys(row);
					this.storage.sql.exec(
						`INSERT INTO "${table.name}" (${columns.map((column) => `"${column}"`).join(", ")})`
							+ ` VALUES (${columns.map(() => "?").join(", ")})`,
						...columns.map((column) => row[column]),
					);
				}
			}
			for (const sql of capture.indexes) this.storage.sql.exec(sql);
		});
	}
}
