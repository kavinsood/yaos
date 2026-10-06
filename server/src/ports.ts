// Injected ports (DECISIONS §1 D1): the streams core and the DO hosts depend only on these, so the core runs on
// Node in tests (tests/server/helpers/nodeSqliteStorage.ts, fake sockets, virtual timers). The Cloudflare adapters
// live in vault/cloudflare.ts. Every interface is the structural subset of the Workers API the core calls.

/** A SQLite cell as Durable Object SQL returns it (`SqlStorageValue`). */
export type SqlValue = ArrayBuffer | string | number | null;

export interface SqlCursor<T> {
	toArray(): T[];
	one(): T;
	[Symbol.iterator](): Iterator<T>;
}

/** The subset of `ctx.storage` used here: synchronous SQL and `transactionSync`. */
export interface StoragePort {
	sql: {
		exec<T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
	};
	transactionSync<T>(closure: () => T): T;
}

/** The vault DO's storage: the SQL port plus `deleteAll()` for vault delete (D5). */
export interface VaultStoragePort extends StoragePort {
	deleteAll(): Promise<void>;
}

/**
 * A read of a table that was never created throws SQLite's "no such table: <name>" (workerd appends
 * ": SQLITE_ERROR"). The DOs probe their first table this way, so an unknown object costs no write and no DDL.
 */
export function isMissingTableError(error: unknown, table: string): boolean {
	return error instanceof Error && error.message.includes(`no such table: ${table}`);
}

/**
 * `name: message` for logs. An error that crossed a DO RPC logs as its local stack only (measured on scratch-3: the
 * `restore step failed` lines carried no message), so log sites print this instead of the error object.
 */
export function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** One accepted (hibernatable) WebSocket. */
export interface SocketPort {
	close(code?: number, reason?: string): void;
	deserializeAttachment(): unknown;
	serializeAttachment(value: unknown): void;
	send(message: ArrayBuffer | ArrayBufferView | string): void;
}

/** The DO's socket set: `ctx.getWebSockets()`, `new WebSocketPair()`, `ctx.acceptWebSocket()` and the 101. */
export interface SocketRegistryPort {
	sockets(): readonly SocketPort[];
	createPair(): { client: unknown; server: SocketPort };
	accept(socket: SocketPort): void;
	upgradeResponse(client: unknown): Response;
}

/** A refused WebSocket upgrade (relay-wire §3.1): accept, send one `__YPS:` error frame, close, answer the 101. */
export interface UpgradeRejectPort {
	reject(frame: string, code: number, reason: string): Response;
}

export interface ClockPort {
	now(): number;
}

/** Timer seam (tests drive virtual time). */
export interface TimerPort {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const SYSTEM_CLOCK: ClockPort = { now: () => Date.now() };

export const SYSTEM_TIMERS: TimerPort = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
