// Write-budget spike (W1): TEST-ONLY exact SQL row accounting for one Durable
// Object. Wraps the DO storage so every `sql.exec` cursor's `rowsWritten` /
// `rowsRead` (the numbers Cloudflare bills) and every `setAlarm` call (billed
// as one row written) are summed. Only constructed when the test-only debug
// routes are enabled; production storage is never wrapped.

interface CountedCursor {
	readonly rowsWritten: number;
	readonly rowsRead: number;
}

interface Tracked {
	cursor: CountedCursor;
	written: number;
	read: number;
}

/** Cursors whose counters may still grow (lazy iteration); older ones are folded and dropped. */
const RING_SIZE = 64;

export interface SqlRowSnapshot {
	rowsWritten: number;
	rowsRead: number;
	setAlarms: number;
	/** rowsWritten + setAlarms: the Free-plan "rows written" figure. */
	billedRowsWritten: number;
	execs: number;
	sinceMs: number;
	at: number;
}

export class SqlRowCounter {
	private rowsWritten = 0;
	private rowsRead = 0;
	private setAlarms = 0;
	private execs = 0;
	private since = Date.now();
	private ring: Tracked[] = [];

	/** Returns a storage object whose `sql.exec` and `setAlarm` are counted. */
	wrap<T extends object>(storage: T): T {
		const counter = this;
		const sqlTarget = (storage as { sql?: object }).sql;
		const sql = sqlTarget ? new Proxy(sqlTarget, {
			get(target, property) {
				const value = Reflect.get(target, property, target) as unknown;
				if (property === "exec" && typeof value === "function") {
					return (...args: unknown[]) => {
						const cursor = (value as (...input: unknown[]) => CountedCursor).apply(target, args);
						counter.track(cursor);
						return cursor;
					};
				}
				return typeof value === "function" ? (value as (...input: unknown[]) => unknown).bind(target) : value;
			},
		}) : undefined;
		return new Proxy(storage, {
			get(target, property) {
				if (property === "sql" && sql) return sql;
				const value = Reflect.get(target, property, target) as unknown;
				if (property === "setAlarm" && typeof value === "function") {
					return (...args: unknown[]) => {
						counter.setAlarms++;
						return (value as (...input: unknown[]) => unknown).apply(target, args);
					};
				}
				return typeof value === "function" ? (value as (...input: unknown[]) => unknown).bind(target) : value;
			},
		});
	}

	private track(cursor: CountedCursor): void {
		this.execs++;
		this.fold();
		const tracked: Tracked = { cursor, written: 0, read: 0 };
		this.foldOne(tracked);
		this.ring.push(tracked);
		if (this.ring.length > RING_SIZE) {
			const evicted = this.ring.shift()!;
			this.foldOne(evicted);
		}
	}

	private foldOne(tracked: Tracked): void {
		let written = tracked.written;
		let read = tracked.read;
		try {
			written = Number(tracked.cursor.rowsWritten) || 0;
			read = Number(tracked.cursor.rowsRead) || 0;
		} catch { /* cursor without counters */ }
		this.rowsWritten += Math.max(0, written - tracked.written);
		this.rowsRead += Math.max(0, read - tracked.read);
		tracked.written = Math.max(tracked.written, written);
		tracked.read = Math.max(tracked.read, read);
	}

	private fold(): void {
		for (const tracked of this.ring) this.foldOne(tracked);
	}

	snapshot(now = Date.now()): SqlRowSnapshot {
		this.fold();
		return {
			rowsWritten: this.rowsWritten,
			rowsRead: this.rowsRead,
			setAlarms: this.setAlarms,
			billedRowsWritten: this.rowsWritten + this.setAlarms,
			execs: this.execs,
			sinceMs: now - this.since,
			at: now,
		};
	}

	/** Returns the totals so far, then starts again from zero. */
	reset(now = Date.now()): SqlRowSnapshot {
		const snapshot = this.snapshot(now);
		this.rowsWritten = 0;
		this.rowsRead = 0;
		this.setAlarms = 0;
		this.execs = 0;
		this.since = now;
		// Later growth of already-seen cursors still counts (from their current values).
		return snapshot;
	}
}
