import type {
	ControlPlaneRecordFilter,
	ControlPlaneRecordListOptions,
	ControlPlaneRecordTransactionPort,
	ControlPlaneStoragePort,
	ControlPlaneTransactionPort,
} from "./platformPorts";
import { SQLITE_ROW_SAFE_BYTES } from "./shared/durableLimits";

type SqlValue = ArrayBuffer | string | number | null;

type SqlRow = Record<string, SqlValue>;

interface SqlCursor<T extends SqlRow> extends Iterable<T> {
	toArray(): T[];
	readonly rowsWritten: number;
}

/** The common SQLite surface exposed by Durable Object and Node runtimes. */
export interface ControlPlaneSqlHost {
	readonly sql: {
		exec<T extends SqlRow>(query: string, ...bindings: unknown[]): SqlCursor<T>;
	};
	transactionSync<T>(closure: () => T): T;
}

export const CONTROL_PLANE_COLLECTIONS = [
	"vaults",
	"devices",
	"pairingCodes",
	"operatorSessions",
	"pendingVaultDestroys",
	"pendingDeviceRevocations",
	"enrollmentReplays",
	"principals",
	"vaultMemberships",
	"collaborationCodes",
	"ownershipTransfers",
	"authorizationChanges",
	"securityAuditEvents",
	"vaultGovernanceRequests",
] as const;

export type ControlPlaneCollection = typeof CONTROL_PLANE_COLLECTIONS[number];

const COLLECTIONS = new Set<string>(CONTROL_PLANE_COLLECTIONS);
const textEncoder = new TextEncoder();

interface StoredRecord extends SqlRow {
	sequence: number;
	record_key: string;
	payload_json: string;
}

interface VisibleStoredRecord<T> {
	recordKey: string;
	value: T;
}

interface MarkerRow extends SqlRow {
	found: number;
}

interface RecordMetadata {
	recordKey: string;
	vaultId: string | null;
	vaultGeneration: string | null;
	state: string | null;
	createdAt: number | null;
	expiresAt: number | null;
	principalId: string | null;
	deviceId: string | null;
	tokenHash: string | null;
	codeHash: string | null;
	pairingCodeHash: string | null;
	requestId: string | null;
	authorizationChangeId: string | null;
	role: string | null;
	purpose: string | null;
	consumedAt: number | null;
	completedAt: number | null;
}

interface CollectionSnapshot {
	value: unknown[];
	encodedByKey: ReadonlyMap<string, string>;
}

function objectRecord(value: unknown, collection: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${collection} records must be objects`);
	}
	return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, field: string, collection: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${collection} record has no ${field}`);
	}
	return value;
}

function recordMetadata(collection: ControlPlaneCollection, value: unknown): RecordMetadata {
	const record = objectRecord(value, collection);
	let recordKey: string;
	switch (collection) {
		case "vaults": recordKey = requiredString(record, "vaultId", collection); break;
		case "devices": recordKey = requiredString(record, "deviceId", collection); break;
		case "pairingCodes": recordKey = requiredString(record, "codeId", collection); break;
		case "operatorSessions": recordKey = requiredString(record, "sessionHash", collection); break;
		case "pendingVaultDestroys": recordKey = requiredString(record, "vaultId", collection); break;
		case "pendingDeviceRevocations": recordKey = requiredString(record, "deviceId", collection); break;
		case "enrollmentReplays": recordKey = requiredString(record, "enrollmentRequestId", collection); break;
		case "principals": recordKey = requiredString(record, "principalId", collection); break;
		case "vaultMemberships": recordKey = `${requiredString(record, "vaultId", collection)}\0${requiredString(record, "principalId", collection)}`; break;
		case "collaborationCodes": recordKey = requiredString(record, "codeId", collection); break;
		case "ownershipTransfers": recordKey = requiredString(record, "transferId", collection); break;
		case "authorizationChanges": recordKey = requiredString(record, "changeId", collection); break;
		case "securityAuditEvents": recordKey = requiredString(record, "eventId", collection); break;
		case "vaultGovernanceRequests": recordKey = requiredString(record, "governanceRequestId", collection); break;
	}
	return {
		recordKey,
		vaultId: typeof record.vaultId === "string" ? record.vaultId : null,
		vaultGeneration: typeof record.vaultGeneration === "string" ? record.vaultGeneration : null,
		state: typeof record.state === "string" ? record.state : null,
		createdAt: Number.isSafeInteger(record.createdAt) ? record.createdAt as number : null,
		expiresAt: Number.isSafeInteger(record.expiresAt)
			? record.expiresAt as number
			: Number.isSafeInteger(record.exp) ? record.exp as number : null,
		principalId: typeof record.principalId === "string" ? record.principalId : null,
		deviceId: typeof record.deviceId === "string" ? record.deviceId : null,
		tokenHash: typeof record.tokenHash === "string" ? record.tokenHash : null,
		codeHash: typeof record.codeHash === "string" ? record.codeHash : null,
		pairingCodeHash: typeof record.pairingCodeHash === "string" ? record.pairingCodeHash : null,
		requestId: typeof record.requestId === "string" ? record.requestId : null,
		authorizationChangeId: typeof record.authorizationChangeId === "string" ? record.authorizationChangeId : null,
		role: typeof record.role === "string" ? record.role : null,
		purpose: typeof record.purpose === "string" ? record.purpose : null,
		consumedAt: Number.isSafeInteger(record.consumedAt) ? record.consumedAt as number : null,
		completedAt: Number.isSafeInteger(record.completedAt) ? record.completedAt as number : null,
	};
}

const FILTER_COLUMNS: Readonly<Record<Exclude<keyof ControlPlaneRecordFilter,
	"expiresAfter" | "expiresAtOrBefore" | "createdBefore" | "completedAtOrBefore" | "consumed">, string>> = {
	recordKey: "record_key",
	vaultId: "vault_id",
	vaultGeneration: "vault_generation",
	principalId: "principal_id",
	deviceId: "device_id",
	tokenHash: "token_hash",
	codeHash: "code_hash",
	pairingCodeHash: "pairing_code_hash",
	requestId: "request_id",
	authorizationChangeId: "authorization_change_id",
	state: "state",
	role: "role",
	purpose: "purpose",
};

function recordWhere(filter: ControlPlaneRecordFilter = {}): { sql: string; bindings: unknown[] } {
	const clauses: string[] = [];
	const bindings: unknown[] = [];
	for (const [field, column] of Object.entries(FILTER_COLUMNS) as Array<[keyof typeof FILTER_COLUMNS, string]>) {
		const value = filter[field];
		if (value === undefined) continue;
		clauses.push(`${column} = ?`);
		bindings.push(value);
	}
	if (filter.expiresAfter !== undefined) { clauses.push("expires_at > ?"); bindings.push(filter.expiresAfter); }
	if (filter.expiresAtOrBefore !== undefined) { clauses.push("expires_at <= ?"); bindings.push(filter.expiresAtOrBefore); }
	if (filter.createdBefore !== undefined) { clauses.push("created_at < ?"); bindings.push(filter.createdBefore); }
	if (filter.completedAtOrBefore !== undefined) { clauses.push("completed_at <= ?"); bindings.push(filter.completedAtOrBefore); }
	if (filter.consumed !== undefined) clauses.push(filter.consumed ? "consumed_at IS NOT NULL" : "consumed_at IS NULL");
	return { sql: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`, bindings };
}

function recordMatchesFilter(collection: ControlPlaneCollection, value: unknown, filter: ControlPlaneRecordFilter): boolean {
	const metadata = recordMetadata(collection, value);
	for (const field of Object.keys(FILTER_COLUMNS) as Array<keyof typeof FILTER_COLUMNS>) {
		const expected = filter[field];
		if (expected === undefined) continue;
		const actual = field === "recordKey" ? metadata.recordKey : metadata[field];
		if (actual !== expected) return false;
	}
	if (filter.expiresAfter !== undefined && !(metadata.expiresAt !== null && metadata.expiresAt > filter.expiresAfter)) return false;
	if (filter.expiresAtOrBefore !== undefined && !(metadata.expiresAt !== null && metadata.expiresAt <= filter.expiresAtOrBefore)) return false;
	if (filter.createdBefore !== undefined && !(metadata.createdAt !== null && metadata.createdAt < filter.createdBefore)) return false;
	if (filter.completedAtOrBefore !== undefined && !(metadata.completedAt !== null && metadata.completedAt <= filter.completedAtOrBefore)) return false;
	if (filter.consumed !== undefined && (metadata.consumedAt !== null) !== filter.consumed) return false;
	return true;
}

interface RecordReadOverlay {
	deletedBy: readonly ControlPlaneRecordFilter[];
	overriddenKeys: readonly string[];
}

function recordOverlayWhere(overlay?: RecordReadOverlay): { sql: string; bindings: unknown[] } {
	if (!overlay) return { sql: "", bindings: [] };
	const clauses: string[] = [];
	const bindings: unknown[] = [];
	for (const filter of overlay.deletedBy) {
		const where = recordWhere(filter);
		if (!where.sql) throw new TypeError("deleteWhere requires at least one filter");
		// Nullable metadata comparisons can evaluate to NULL. Treat that as a
		// non-match so unrelated records remain visible through the overlay.
		clauses.push(`NOT COALESCE((${where.sql.slice(5)}), 0)`);
		bindings.push(...where.bindings);
	}
	for (const recordKey of overlay.overriddenKeys) {
		clauses.push("record_key <> ?");
		bindings.push(recordKey);
	}
	return { sql: clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`, bindings };
}

function encodeRecord(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError("control-plane values must be JSON serializable");
	if (textEncoder.encode(encoded).byteLength > SQLITE_ROW_SAFE_BYTES) {
		throw new RangeError("one control-plane record exceeds the SQLite row safety limit");
	}
	return encoded;
}

function encodeScalar(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError("control-plane values must be JSON serializable");
	if (textEncoder.encode(encoded).byteLength > SQLITE_ROW_SAFE_BYTES) {
		throw new RangeError("one control-plane scalar exceeds the SQLite row safety limit");
	}
	return encoded;
}

function decodeJson(encoded: string): unknown {
	return JSON.parse(encoded) as unknown;
}

function isCollection(key: string): key is ControlPlaneCollection {
	return COLLECTIONS.has(key);
}

/**
 * Fresh-schema control-plane storage.
 *
 * Collection-shaped state is persisted as one indexed SQLite row per record.
 * The legacy-looking get/put surface is retained only as an in-process API for
 * the request handlers; a mutation writes only rows whose canonical JSON
 * changed, plus rows that were inserted/deleted. No collection is ever placed
 * in a Durable Object value or a SQLite cell.
 */
export class SqlControlPlaneStorage implements ControlPlaneStoragePort {
	private operationTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly host: ControlPlaneSqlHost,
		private readonly namespace: string,
	) {
		if (!namespace) throw new TypeError("control-plane namespace is required");
		host.sql.exec(`
			CREATE TABLE IF NOT EXISTS control_plane_scalars (
				namespace TEXT NOT NULL,
				key TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				PRIMARY KEY (namespace, key)
			);
			CREATE TABLE IF NOT EXISTS control_plane_collections (
				namespace TEXT NOT NULL,
				collection TEXT NOT NULL,
				PRIMARY KEY (namespace, collection)
			);
			CREATE TABLE IF NOT EXISTS control_plane_records (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				namespace TEXT NOT NULL,
				collection TEXT NOT NULL,
				record_key TEXT NOT NULL,
				vault_id TEXT,
				vault_generation TEXT,
				state TEXT,
				created_at INTEGER,
				expires_at INTEGER,
				principal_id TEXT,
				device_id TEXT,
				token_hash TEXT,
				code_hash TEXT,
				pairing_code_hash TEXT,
				request_id TEXT,
				authorization_change_id TEXT,
				role TEXT,
				purpose TEXT,
				consumed_at INTEGER,
				completed_at INTEGER,
				payload_json TEXT NOT NULL,
				UNIQUE (namespace, collection, record_key)
			);
			CREATE INDEX IF NOT EXISTS control_plane_records_vault
				ON control_plane_records(namespace, collection, vault_id, sequence);
			CREATE INDEX IF NOT EXISTS control_plane_records_vault_generation
				ON control_plane_records(namespace, collection, vault_id, vault_generation, state, sequence);
			CREATE INDEX IF NOT EXISTS control_plane_records_state
				ON control_plane_records(namespace, collection, state, sequence);
			CREATE INDEX IF NOT EXISTS control_plane_records_expiry
				ON control_plane_records(namespace, collection, expires_at);
			CREATE INDEX IF NOT EXISTS control_plane_records_created
				ON control_plane_records(namespace, collection, created_at, sequence);
			CREATE INDEX IF NOT EXISTS control_plane_records_principal
				ON control_plane_records(namespace, collection, vault_id, principal_id, sequence);
			CREATE INDEX IF NOT EXISTS control_plane_records_device
				ON control_plane_records(namespace, collection, device_id);
			CREATE INDEX IF NOT EXISTS control_plane_records_token
				ON control_plane_records(namespace, collection, token_hash);
			CREATE INDEX IF NOT EXISTS control_plane_records_code
				ON control_plane_records(namespace, collection, code_hash);
			CREATE INDEX IF NOT EXISTS control_plane_records_pairing_code
				ON control_plane_records(namespace, collection, pairing_code_hash);
			CREATE INDEX IF NOT EXISTS control_plane_records_request
				ON control_plane_records(namespace, collection, vault_id, request_id);
			CREATE INDEX IF NOT EXISTS control_plane_records_authorization_change
				ON control_plane_records(namespace, collection, authorization_change_id);
			CREATE INDEX IF NOT EXISTS control_plane_records_role
				ON control_plane_records(namespace, collection, vault_id, role, state);
		`);
	}

	get<T = unknown>(key: string): Promise<T | undefined> {
		return this.enqueue(() => this.readDirect<T>(key).value);
	}

	put(key: string, value: unknown): Promise<void> {
		return this.enqueue(() => {
			this.host.transactionSync(() => this.writeDirect(key, value));
		});
	}

	delete(key: string): Promise<boolean> {
		return this.enqueue(() => this.host.transactionSync(() => this.deleteDirect(key)));
	}

	transaction<T>(closure: (transaction: ControlPlaneTransactionPort) => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const transaction = new SqlControlPlaneTransaction(this);
			const result = await closure(transaction);
			this.host.transactionSync(() => transaction.commit());
			return result;
		});
	}

	/** Indexed access for bounded consoles, diagnostics, and focused tests. */
	async countRecords(collection: ControlPlaneCollection, vaultId?: string): Promise<number> {
		return this.enqueue(() => {
			const row = this.host.sql.exec<{ count: number }>(
				vaultId === undefined
					? "SELECT COUNT(*) AS count FROM control_plane_records WHERE namespace = ? AND collection = ?"
					: "SELECT COUNT(*) AS count FROM control_plane_records WHERE namespace = ? AND collection = ? AND vault_id = ?",
				this.namespace,
				collection,
				...(vaultId === undefined ? [] : [vaultId]),
			).toArray()[0];
			return row?.count ?? 0;
		});
	}

	getRecordDirect<T = unknown>(
		collection: ControlPlaneCollection,
		filter: ControlPlaneRecordFilter,
		overlay?: RecordReadOverlay,
	): T | undefined {
		const where = recordWhere(filter);
		const overlayWhere = recordOverlayWhere(overlay);
		const row = this.host.sql.exec<{ payload_json: string }>(
			`SELECT payload_json FROM control_plane_records
			 WHERE namespace = ? AND collection = ?${where.sql}${overlayWhere.sql} ORDER BY sequence LIMIT 1`,
			this.namespace, collection, ...where.bindings, ...overlayWhere.bindings,
		).toArray()[0];
		return row ? decodeJson(row.payload_json) as T : undefined;
	}

	countRecordsDirect(
		collection: ControlPlaneCollection,
		filter: ControlPlaneRecordFilter = {},
		overlay?: RecordReadOverlay,
	): number {
		const where = recordWhere(filter);
		const overlayWhere = recordOverlayWhere(overlay);
		return this.host.sql.exec<{ count: number }>(
			`SELECT COUNT(*) AS count FROM control_plane_records
			 WHERE namespace = ? AND collection = ?${where.sql}${overlayWhere.sql}`,
			this.namespace, collection, ...where.bindings, ...overlayWhere.bindings,
		).toArray()[0]?.count ?? 0;
	}

	listRecordsDirect<T = unknown>(
		collection: ControlPlaneCollection,
		options: ControlPlaneRecordListOptions = {},
		overlay?: RecordReadOverlay,
	): T[] {
		return this.listRecordEntriesDirect<T>(collection, options, overlay).map((entry) => entry.value);
	}

	listRecordEntriesDirect<T = unknown>(
		collection: ControlPlaneCollection,
		options: ControlPlaneRecordListOptions = {},
		overlay?: RecordReadOverlay,
		includedKeys: readonly string[] = [],
	): VisibleStoredRecord<T>[] {
		const limit = options.limit ?? 1_000;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
			throw new RangeError("control-plane record query limit must be between 1 and 10000");
		}
		const where = recordWhere(options);
		const overlayWhere = recordOverlayWhere(overlay);
		const queryIncludedKeys = where.sql ? includedKeys : [];
		const inclusionSql = queryIncludedKeys.length === 0
			? where.sql
			: ` AND ((${where.sql.slice(5)}) OR record_key IN (${queryIncludedKeys.map(() => "?").join(", ")}))`;
		const rows = this.host.sql.exec<StoredRecord>(
			`SELECT sequence, record_key, payload_json FROM control_plane_records
			 WHERE namespace = ? AND collection = ?${inclusionSql}${overlayWhere.sql}
			 ORDER BY sequence ${options.reverse ? "DESC" : "ASC"} LIMIT ?`,
			this.namespace,
			collection,
			...where.bindings,
			...queryIncludedKeys,
			...overlayWhere.bindings,
			limit + queryIncludedKeys.length,
		).toArray();
		return rows.map((row) => ({ recordKey: row.record_key, value: decodeJson(row.payload_json) as T }));
	}

	upsertRecordDirect(collection: ControlPlaneCollection, value: unknown): void {
		const metadata = recordMetadata(collection, value);
		this.host.sql.exec(
			`INSERT INTO control_plane_records(
				namespace, collection, record_key, vault_id, vault_generation, state, created_at, expires_at,
				principal_id, device_id, token_hash, code_hash, pairing_code_hash, request_id, authorization_change_id, role, purpose,
				consumed_at, completed_at, payload_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(namespace, collection, record_key) DO UPDATE SET
				vault_id = excluded.vault_id, vault_generation = excluded.vault_generation, state = excluded.state,
				created_at = excluded.created_at, expires_at = excluded.expires_at,
				principal_id = excluded.principal_id, device_id = excluded.device_id,
				token_hash = excluded.token_hash, code_hash = excluded.code_hash,
				pairing_code_hash = excluded.pairing_code_hash,
				request_id = excluded.request_id, authorization_change_id = excluded.authorization_change_id,
				role = excluded.role, purpose = excluded.purpose,
				consumed_at = excluded.consumed_at,
				completed_at = excluded.completed_at,
				payload_json = excluded.payload_json`,
			this.namespace, collection, metadata.recordKey, metadata.vaultId, metadata.vaultGeneration, metadata.state,
			metadata.createdAt, metadata.expiresAt, metadata.principalId, metadata.deviceId,
			metadata.tokenHash, metadata.codeHash, metadata.pairingCodeHash, metadata.requestId,
			metadata.authorizationChangeId, metadata.role,
			metadata.purpose, metadata.consumedAt, metadata.completedAt, encodeRecord(value),
		);
		this.host.sql.exec(
			"INSERT INTO control_plane_collections(namespace, collection) VALUES (?, ?) ON CONFLICT DO NOTHING",
			this.namespace, collection,
		);
	}

	deleteRecordDirect(collection: ControlPlaneCollection, recordKey: string): boolean {
		return this.host.sql.exec(
			"DELETE FROM control_plane_records WHERE namespace = ? AND collection = ? AND record_key = ?",
			this.namespace, collection, recordKey,
		).rowsWritten !== 0;
	}

	deleteRecordsDirect(collection: ControlPlaneCollection, filter: ControlPlaneRecordFilter): number {
		const where = recordWhere(filter);
		if (!where.sql) throw new TypeError("deleteWhere requires at least one filter");
		return this.host.sql.exec(
			`DELETE FROM control_plane_records WHERE namespace = ? AND collection = ?${where.sql}`,
			this.namespace, collection, ...where.bindings,
		).rowsWritten;
	}

	retainRecordsDirect(collection: ControlPlaneCollection, maximumRecords: number): void {
		if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 1_000_000) {
			throw new RangeError("invalid control-plane retention limit");
		}
		this.host.sql.exec(
			`DELETE FROM control_plane_records WHERE sequence IN (
				SELECT sequence FROM control_plane_records
				WHERE namespace = ? AND collection = ?
				ORDER BY sequence DESC LIMIT -1 OFFSET ?
			)`,
			this.namespace,
			collection,
			maximumRecords,
		);
	}

	readDirect<T = unknown>(key: string): { value: T | undefined; snapshot?: CollectionSnapshot } {
		if (!isCollection(key)) {
			const row = this.host.sql.exec<{ payload_json: string }>(
				"SELECT payload_json FROM control_plane_scalars WHERE namespace = ? AND key = ?",
				this.namespace,
				key,
			).toArray()[0];
			return { value: row ? decodeJson(row.payload_json) as T : undefined };
		}
		const marker = this.host.sql.exec<MarkerRow>(
			"SELECT 1 AS found FROM control_plane_collections WHERE namespace = ? AND collection = ?",
			this.namespace,
			key,
		).toArray()[0];
		if (!marker) return { value: undefined };
		const rows = this.host.sql.exec<StoredRecord>(
			`SELECT record_key, payload_json FROM control_plane_records
			 WHERE namespace = ? AND collection = ? ORDER BY sequence`,
			this.namespace,
			key,
		).toArray();
		const value = rows.map((row) => decodeJson(row.payload_json));
		return {
			value: value as T,
			snapshot: { value, encodedByKey: new Map(rows.map((row) => [row.record_key, row.payload_json])) },
		};
	}

	writeDirect(key: string, value: unknown, snapshot?: CollectionSnapshot): void {
		if (!isCollection(key)) {
			this.host.sql.exec(
				`INSERT INTO control_plane_scalars(namespace, key, payload_json) VALUES (?, ?, ?)
				 ON CONFLICT(namespace, key) DO UPDATE SET payload_json = excluded.payload_json
				 WHERE payload_json <> excluded.payload_json`,
				this.namespace,
				key,
				encodeScalar(value),
			);
			return;
		}
		if (!Array.isArray(value)) throw new TypeError(`${key} must be an array`);
		this.host.sql.exec(
			"INSERT INTO control_plane_collections(namespace, collection) VALUES (?, ?) ON CONFLICT DO NOTHING",
			this.namespace,
			key,
		);
		const existing = snapshot?.encodedByKey ?? new Map(
			this.host.sql.exec<StoredRecord>(
				"SELECT record_key, payload_json FROM control_plane_records WHERE namespace = ? AND collection = ?",
				this.namespace,
				key,
			).toArray().map((row) => [row.record_key, row.payload_json]),
		);
		const retained = new Set<string>();
		for (const item of value) {
			const metadata = recordMetadata(key, item);
			if (retained.has(metadata.recordKey)) throw new TypeError(`${key} contains duplicate record keys`);
			retained.add(metadata.recordKey);
			const encoded = encodeRecord(item);
			if (existing.get(metadata.recordKey) === encoded) continue;
			this.upsertRecordDirect(key, item);
		}
		for (const recordKey of existing.keys()) {
			if (retained.has(recordKey)) continue;
			this.host.sql.exec(
				"DELETE FROM control_plane_records WHERE namespace = ? AND collection = ? AND record_key = ?",
				this.namespace,
				key,
				recordKey,
			);
		}
	}

	deleteDirect(key: string): boolean {
		if (!isCollection(key)) {
			return this.host.sql.exec(
				"DELETE FROM control_plane_scalars WHERE namespace = ? AND key = ?",
				this.namespace,
				key,
			).rowsWritten !== 0;
		}
		const existed = this.host.sql.exec<MarkerRow>(
			"SELECT 1 AS found FROM control_plane_collections WHERE namespace = ? AND collection = ?",
			this.namespace,
			key,
		).toArray().length !== 0;
		this.host.sql.exec(
			"DELETE FROM control_plane_records WHERE namespace = ? AND collection = ?",
			this.namespace,
			key,
		);
		this.host.sql.exec(
			"DELETE FROM control_plane_collections WHERE namespace = ? AND collection = ?",
			this.namespace,
			key,
		);
		return existed;
	}

	private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.operationTail.then(operation);
		this.operationTail = result.then(() => undefined, () => undefined);
		return result;
	}
}

class SqlControlPlaneTransaction implements ControlPlaneTransactionPort {
	private readonly writes = new Map<string, { deleted: true } | { deleted: false; value: unknown }>();
	private readonly reads = new Map<string, { value: unknown; snapshot?: CollectionSnapshot }>();
	private readonly recordAppends: Array<{
		collection: ControlPlaneCollection;
		maximumRecords: number;
	}> = [];
	private readonly recordWrites = new Map<string, {
		collection: ControlPlaneCollection;
		recordKey: string;
		value?: unknown;
		deleted: boolean;
	}>();
	private readonly recordDeletes: Array<{ collection: ControlPlaneCollection; filter: ControlPlaneRecordFilter }> = [];

	private overlayFor(collection: ControlPlaneCollection): RecordReadOverlay {
		return {
			deletedBy: this.recordDeletes.filter((deletion) => deletion.collection === collection).map((deletion) => deletion.filter),
			overriddenKeys: [...this.recordWrites.values()]
				.filter((write) => write.collection === collection)
				.map((write) => write.recordKey),
		};
	}

	private pendingRecords<T>(collection: ControlPlaneCollection, filter: ControlPlaneRecordFilter): T[] {
		return [...this.recordWrites.values()]
			.filter((write) => write.collection === collection && !write.deleted
				&& recordMatchesFilter(collection, write.value, filter))
			.map((write) => write.value as T);
	}

	readonly records: ControlPlaneRecordTransactionPort = {
		get: async <T = unknown>(collection: string, filter: ControlPlaneRecordFilter) => {
			if (!isCollection(collection)) throw new TypeError(`unknown control-plane collection: ${collection}`);
			const pending = this.pendingRecords<T>(collection, filter)[0];
			return pending ?? this.storage.getRecordDirect<T>(collection, filter, this.overlayFor(collection));
		},
		upsert: async (collection, record) => {
			if (!isCollection(collection)) throw new TypeError(`unknown control-plane collection: ${collection}`);
			const metadata = recordMetadata(collection, record);
			this.recordWrites.set(`${collection}\0${metadata.recordKey}`, {
				collection, recordKey: metadata.recordKey, value: record, deleted: false,
			});
		},
		delete: async (collection, recordKey) => {
			if (!isCollection(collection)) throw new TypeError(`unknown control-plane collection: ${collection}`);
			const key = `${collection}\0${recordKey}`;
			const existed = await this.records.get(collection, { recordKey }) !== undefined;
			this.recordWrites.set(key, { collection, recordKey, deleted: true });
			return existed;
		},
		deleteWhere: async (collection, filter) => {
			if (!isCollection(collection)) throw new TypeError(`unknown control-plane collection: ${collection}`);
			if (!recordWhere(filter).sql) throw new TypeError("deleteWhere requires at least one filter");
			const count = await this.records.count(collection, filter);
			this.recordDeletes.push({ collection, filter });
			for (const [key, write] of this.recordWrites) {
				if (write.collection === collection && !write.deleted && recordMatchesFilter(collection, write.value, filter)) {
					this.recordWrites.set(key, { collection, recordKey: write.recordKey, deleted: true });
				}
			}
			return count;
		},
		count: async (collection, filter = {}) => {
			if (!isCollection(collection)) throw new TypeError(`unknown control-plane collection: ${collection}`);
			return this.storage.countRecordsDirect(collection, filter, this.overlayFor(collection))
				+ this.pendingRecords(collection, filter).length;
		},
		append: async (collection, record, maximumRecords) => {
			if (!isCollection(collection)) throw new TypeError(`unknown control-plane collection: ${collection}`);
			if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 1_000_000) {
				throw new RangeError("invalid control-plane retention limit");
			}
			const metadata = recordMetadata(collection, record);
			this.recordWrites.set(`${collection}\0${metadata.recordKey}`, {
				collection, recordKey: metadata.recordKey, value: record, deleted: false,
			});
			this.recordAppends.push({ collection, maximumRecords });
		},
		list: async <T = unknown>(collection: string, options: ControlPlaneRecordListOptions = {}) => {
			if (!isCollection(collection)) throw new TypeError(`unknown control-plane collection: ${collection}`);
			const limit = options.limit ?? 1_000;
			const writes = new Map([...this.recordWrites.values()]
				.filter((write) => write.collection === collection)
				.map((write) => [write.recordKey, write]));
			const stored = this.storage.listRecordEntriesDirect<T>(
				collection,
				options,
				{ deletedBy: this.overlayFor(collection).deletedBy, overriddenKeys: [] },
				[...writes.keys()],
			);
			const seen = new Set<string>();
			const existing: T[] = [];
			for (const entry of stored) {
				const write = writes.get(entry.recordKey);
				if (!write) {
					existing.push(entry.value);
					continue;
				}
				seen.add(entry.recordKey);
				if (!write.deleted && recordMatchesFilter(collection, write.value, options)) existing.push(write.value as T);
			}
			const inserted = [...writes.values()]
				.filter((write) => !seen.has(write.recordKey) && !write.deleted
					&& recordMatchesFilter(collection, write.value, options))
				.map((write) => write.value as T);
			return (options.reverse ? [...inserted.reverse(), ...existing] : [...existing, ...inserted]).slice(0, limit);
		},
	};

	constructor(private readonly storage: SqlControlPlaneStorage) {}

	async get<T = unknown>(key: string): Promise<T | undefined> {
		if (this.writes.has(key)) {
			const write = this.writes.get(key)!;
			return write.deleted ? undefined : write.value as T;
		}
		let read = this.reads.get(key);
		if (!read) {
			read = this.storage.readDirect(key);
			this.reads.set(key, read);
		}
		return read.value as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.writes.set(key, { deleted: false, value });
	}

	async delete(key: string): Promise<boolean> {
		const existed = await this.get(key) !== undefined;
		this.writes.set(key, { deleted: true });
		return existed;
	}

	commit(): void {
		for (const [key, write] of this.writes) {
			if (write.deleted) this.storage.deleteDirect(key);
			else this.storage.writeDirect(key, write.value, this.reads.get(key)?.snapshot);
		}
		for (const deletion of this.recordDeletes) {
			this.storage.deleteRecordsDirect(deletion.collection, deletion.filter);
		}
		for (const write of this.recordWrites.values()) {
			if (write.deleted) this.storage.deleteRecordDirect(write.collection, write.recordKey);
			else this.storage.upsertRecordDirect(write.collection, write.value);
		}
		for (const append of this.recordAppends) {
			this.storage.retainRecordsDirect(append.collection, append.maximumRecords);
		}
	}
}
