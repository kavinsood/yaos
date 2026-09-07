/**
 * Deployment-only Durable Object storage benchmark.
 *
 * This entry point is deliberately absent from the production Worker. It is
 * deployed only through wrangler.storage-benchmark.toml, and every route is
 * additionally guarded by an enable flag and a secret header.
 */
import { SQLITE_ROW_SAFE_BYTES } from "./shared/durableLimits";

const LEGACY_CHUNK_BYTES = 1024 * 1024;
const MAX_SOURCE_PART_BYTES = 512 * 1024;
const LEGACY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LEGACY_DECODE = new Uint8Array(256).fill(0xff);
for (let index = 0; index < LEGACY_ALPHABET.length; index++) {
	LEGACY_DECODE[LEGACY_ALPHABET.charCodeAt(index)] = index;
}

export interface BenchmarkEnvironment {
	STORAGE_BENCHMARK_RUNS: DurableObjectNamespace;
	YAOS_ENABLE_STORAGE_BENCHMARK?: string;
	YAOS_STORAGE_BENCHMARK_SECRET?: string;
}

interface RunRow extends Record<string, SqlStorageValue> {
	mode: string;
	workload: string;
	status: string;
	expected_parts: number;
	expected_entries: number;
	expected_bytes: number;
	expected_checksum: number;
	write_part_cursor: number;
	write_sequence: number;
	write_chunk_index: number;
	write_carry: ArrayBuffer;
	read_row_cursor: number;
	read_bytes: number;
	read_checksum: number;
	write_ms: number;
	read_ms: number;
	write_invocations: number;
	read_invocations: number;
	database_bytes_before: number;
	database_bytes_after_write: number;
	error: string | null;
}

interface SourceRow extends Record<string, SqlStorageValue> {
	part_index: number;
	entry_index: number;
	end_of_entry: number;
	data: ArrayBuffer;
}

interface OutputRow extends Record<string, SqlStorageValue> {
	id: number;
	data: ArrayBuffer | string;
}

export function benchmarkJson(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

const json = benchmarkJson;

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBytes(value: ArrayBuffer): Uint8Array {
	return new Uint8Array(value);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
	return Uint8Array.from(bytes).buffer;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left, 0);
	result.set(right, left.byteLength);
	return result;
}

/** Exact hand-written encoder used by the historical TEXT-row design. */
export function legacyBytesToBase64Url(bytes: Uint8Array): string {
	let output = "";
	let index = 0;
	for (; index + 2 < bytes.length; index += 3) {
		const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
		output += LEGACY_ALPHABET[value >> 18 & 63];
		output += LEGACY_ALPHABET[value >> 12 & 63];
		output += LEGACY_ALPHABET[value >> 6 & 63];
		output += LEGACY_ALPHABET[value & 63];
	}
	const remainder = bytes.length - index;
	if (remainder === 1) {
		const value = bytes[index]! << 16;
		output += LEGACY_ALPHABET[value >> 18 & 63];
		output += LEGACY_ALPHABET[value >> 12 & 63];
	} else if (remainder === 2) {
		const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
		output += LEGACY_ALPHABET[value >> 18 & 63];
		output += LEGACY_ALPHABET[value >> 12 & 63];
		output += LEGACY_ALPHABET[value >> 6 & 63];
	}
	return output;
}

/** Exact hand-written decoder used by the historical TEXT-row design. */
export function legacyBase64UrlToBytes(value: string): Uint8Array {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code > 255 || LEGACY_DECODE[code] === 0xff) throw new Error(`invalid legacy base64url character at ${index}`);
	}
	const remainder = value.length % 4;
	if (remainder === 1) throw new Error("invalid legacy base64url length");
	const output = new Uint8Array(Math.floor(value.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0));
	let outputIndex = 0;
	let index = 0;
	for (; index + 3 < value.length; index += 4) {
		const a = LEGACY_DECODE[value.charCodeAt(index)]!;
		const b = LEGACY_DECODE[value.charCodeAt(index + 1)]!;
		const c = LEGACY_DECODE[value.charCodeAt(index + 2)]!;
		const d = LEGACY_DECODE[value.charCodeAt(index + 3)]!;
		output[outputIndex++] = (a << 2) | (b >> 4);
		output[outputIndex++] = ((b & 0xf) << 4) | (c >> 2);
		output[outputIndex++] = ((c & 0x3) << 6) | d;
	}
	if (remainder === 2) {
		const a = LEGACY_DECODE[value.charCodeAt(index)]!;
		const b = LEGACY_DECODE[value.charCodeAt(index + 1)]!;
		output[outputIndex] = (a << 2) | (b >> 4);
	} else if (remainder === 3) {
		const a = LEGACY_DECODE[value.charCodeAt(index)]!;
		const b = LEGACY_DECODE[value.charCodeAt(index + 1)]!;
		const c = LEGACY_DECODE[value.charCodeAt(index + 2)]!;
		output[outputIndex++] = (a << 2) | (b >> 4);
		output[outputIndex] = ((b & 0xf) << 4) | (c >> 2);
	}
	return output;
}

export function updateFnv1a(checksum: number, bytes: Uint8Array): number {
	let value = checksum >>> 0;
	for (const byte of bytes) {
		value ^= byte;
		value = Math.imul(value, 0x01000193) >>> 0;
	}
	return value;
}

function secureEqual(left: string, right: string): boolean {
	let mismatch = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		mismatch |= (left.charCodeAt(index % Math.max(1, left.length)) || 0)
			^ (right.charCodeAt(index % Math.max(1, right.length)) || 0);
	}
	return mismatch === 0;
}

export function authorizeBenchmarkRequest(request: Request, env: BenchmarkEnvironment): Response | null {
	if (env.YAOS_ENABLE_STORAGE_BENCHMARK !== "true") return json({ error: "not_found" }, 404);
	const configured = env.YAOS_STORAGE_BENCHMARK_SECRET ?? "";
	const supplied = request.headers.get("x-yaos-benchmark-secret") ?? "";
	if (configured.length < 24 || !secureEqual(configured, supplied)) return json({ error: "unauthorized" }, 401);
	return null;
}

function runIdFrom(pathname: string): { runId: string; rest: string } | null {
	const match = pathname.match(/^\/__yaos\/benchmark\/runs\/([A-Za-z0-9_-]{1,100})(\/.*)?$/);
	return match?.[1] ? { runId: match[1], rest: match[2] || "/" } : null;
}

const benchmarkWorker = {
	async fetch(request: Request, env: BenchmarkEnvironment): Promise<Response> {
		const rejection = authorizeBenchmarkRequest(request, env);
		if (rejection) return rejection;
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__yaos/benchmark/health") {
			return json({ ok: true, isolated: true, maximumSourcePartBytes: MAX_SOURCE_PART_BYTES });
		}
		const route = runIdFrom(url.pathname);
		if (!route) return json({ error: "not_found" }, 404);
		const object = env.STORAGE_BENCHMARK_RUNS.get(env.STORAGE_BENCHMARK_RUNS.idFromName(route.runId));
		const internal = new URL(request.url);
		internal.pathname = route.rest;
		const headers = new Headers(request.headers);
		headers.delete("x-yaos-benchmark-secret");
		return object.fetch(new Request(internal, { method: request.method, headers, body: request.body }));
	},
};

export class StorageBenchmarkRun implements DurableObject {
	private readonly sql: SqlStorage;

	constructor(private readonly state: DurableObjectState) {
		this.sql = state.storage.sql;
		this.ensureSchema();
	}

	private ensureSchema(): void {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS benchmark_run (
			id INTEGER PRIMARY KEY CHECK (id = 1), mode TEXT NOT NULL, workload TEXT NOT NULL, status TEXT NOT NULL,
			expected_parts INTEGER NOT NULL, expected_entries INTEGER NOT NULL, expected_bytes INTEGER NOT NULL,
			expected_checksum INTEGER NOT NULL, write_part_cursor INTEGER NOT NULL DEFAULT 0,
			write_sequence INTEGER NOT NULL DEFAULT 0, write_chunk_index INTEGER NOT NULL DEFAULT 0,
			write_carry BLOB NOT NULL, read_row_cursor INTEGER NOT NULL DEFAULT 0,
			read_bytes INTEGER NOT NULL DEFAULT 0, read_checksum INTEGER NOT NULL DEFAULT 2166136261,
			write_ms REAL NOT NULL DEFAULT 0, read_ms REAL NOT NULL DEFAULT 0,
			write_invocations INTEGER NOT NULL DEFAULT 0, read_invocations INTEGER NOT NULL DEFAULT 0,
			database_bytes_before INTEGER NOT NULL DEFAULT 0, database_bytes_after_write INTEGER NOT NULL DEFAULT 0,
			error TEXT
		);
		CREATE TABLE IF NOT EXISTS source_parts (
			part_index INTEGER PRIMARY KEY, entry_index INTEGER NOT NULL, end_of_entry INTEGER NOT NULL CHECK(end_of_entry IN (0,1)),
			data BLOB NOT NULL
		);
		CREATE TABLE IF NOT EXISTS benchmark_chunks (
			id INTEGER PRIMARY KEY AUTOINCREMENT, sequence INTEGER NOT NULL, chunk_index INTEGER NOT NULL, data NOT NULL,
			UNIQUE(sequence, chunk_index)
		);`);
	}

	private run(): RunRow | null {
		return this.sql.exec<RunRow>("SELECT * FROM benchmark_run WHERE id = 1").toArray()[0] ?? null;
	}

	private fail(message: string): Response {
		this.sql.exec("UPDATE benchmark_run SET status = 'failed', error = ? WHERE id = 1", message.slice(0, 1000));
		return json({ error: message }, 500);
	}

	private async initialize(request: Request): Promise<Response> {
		if (this.run()) return json({ error: "run_already_initialized" }, 409);
		try {
			const body: unknown = await request.json();
			if (!isRecord(body)) throw new Error("request body must be an object");
			const mode = body.mode;
			const workload = body.workload;
			if (mode !== "legacy-base64-text" && mode !== "final-binary-blob") throw new Error("invalid mode");
			if (workload !== "journal" && workload !== "checkpoint") throw new Error("invalid workload");
			const expectedParts = integer(body.expectedParts, "expectedParts", 1, 100_000);
			const expectedEntries = integer(body.expectedEntries, "expectedEntries", 1, 100_000);
			const expectedBytes = integer(body.expectedBytes, "expectedBytes", 1, 1024 * 1024 * 1024);
			const expectedChecksum = integer(body.expectedChecksum, "expectedChecksum", 0, 0xffff_ffff);
			this.sql.exec(`INSERT INTO benchmark_run (
				id, mode, workload, status, expected_parts, expected_entries, expected_bytes, expected_checksum, write_carry
			) VALUES (1, ?, ?, 'uploading', ?, ?, ?, ?, ?)`,
			mode, workload, expectedParts, expectedEntries, expectedBytes, expectedChecksum, new ArrayBuffer(0));
			return json({ ok: true, mode, workload, maximumSourcePartBytes: MAX_SOURCE_PART_BYTES }, 201);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	}

	private async upload(request: Request, partIndex: number): Promise<Response> {
		const run = this.run();
		if (!run || run.status !== "uploading") return json({ error: "run_not_uploading" }, 409);
		const url = new URL(request.url);
		let entryIndex: number;
		let endOfEntry: number;
		try {
			entryIndex = integer(Number(url.searchParams.get("entry")), "entry", 0, run.expected_entries - 1);
			endOfEntry = url.searchParams.get("end") === "1" ? 1 : 0;
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
		const existing = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM source_parts").toArray()[0]!.count;
		if (partIndex !== existing) return json({ error: "parts_must_be_uploaded_contiguously", expectedPartIndex: existing }, 409);
		const buffer = await request.arrayBuffer();
		if (buffer.byteLength === 0 || buffer.byteLength > MAX_SOURCE_PART_BYTES) {
			return json({ error: "invalid_source_part_size", maximumSourcePartBytes: MAX_SOURCE_PART_BYTES }, 413);
		}
		this.sql.exec("INSERT INTO source_parts(part_index, entry_index, end_of_entry, data) VALUES (?, ?, ?, ?)",
			partIndex, entryIndex, endOfEntry, buffer);
		return json({ ok: true, partIndex, bytes: buffer.byteLength });
	}

	private seal(): Response {
		const run = this.run();
		if (!run || run.status !== "uploading") return json({ error: "run_not_uploading" }, 409);
		const summary = this.sql.exec<{
			parts: number; bytes: number; entries: number; minimum_part: number; maximum_part: number;
		}>(`SELECT COUNT(*) AS parts, COALESCE(SUM(length(data)), 0) AS bytes,
			COALESCE(SUM(end_of_entry), 0) AS entries, COALESCE(MIN(part_index), -1) AS minimum_part,
			COALESCE(MAX(part_index), -1) AS maximum_part FROM source_parts`).toArray()[0]!;
		if (summary.parts !== run.expected_parts || summary.bytes !== run.expected_bytes
			|| summary.entries !== run.expected_entries || summary.minimum_part !== 0
			|| summary.maximum_part !== run.expected_parts - 1) {
			return json({ error: "source_manifest_mismatch", expected: {
				parts: run.expected_parts, bytes: run.expected_bytes, entries: run.expected_entries,
			}, actual: summary }, 409);
		}
		const boundaries = this.sql.exec<{ entry_index: number }>(
			"SELECT entry_index FROM source_parts WHERE end_of_entry = 1 ORDER BY part_index",
		).toArray();
		if (boundaries.some((row, index) => row.entry_index !== index)) {
			return json({ error: "entries_must_be_contiguous_and_end_in_order" }, 409);
		}
		if (run.mode === "final-binary-blob" && run.workload === "journal") {
			const oversized = this.sql.exec<{ entry_index: number; bytes: number }>(
				"SELECT entry_index, SUM(length(data)) AS bytes FROM source_parts GROUP BY entry_index HAVING bytes > ? LIMIT 1",
				SQLITE_ROW_SAFE_BYTES,
			).toArray()[0];
			if (oversized) return json({ error: "final_journal_entry_exceeds_row_ceiling", ...oversized }, 413);
		}
		this.sql.exec("UPDATE benchmark_run SET status = 'sealed', database_bytes_before = ? WHERE id = 1", this.sql.databaseSize);
		return this.status();
	}

	private insertChunk(run: RunRow, sequence: number, chunkIndex: number, bytes: Uint8Array): void {
		const value = run.mode === "legacy-base64-text" ? legacyBytesToBase64Url(bytes) : ownedBuffer(bytes);
		this.sql.exec("INSERT INTO benchmark_chunks(sequence, chunk_index, data) VALUES (?, ?, ?)",
			sequence, chunkIndex, value);
	}

	private writeStep(maxUnits: number): Response {
		const initial = this.run();
		if (!initial || !["sealed", "writing"].includes(initial.status)) return json({ error: "run_not_writable" }, 409);
		const started = performance.now();
		try {
			let done = false;
			this.state.storage.transactionSync(() => {
				const run = this.run()!;
				const sourceRows = this.sql.exec<SourceRow>(
					"SELECT part_index, entry_index, end_of_entry, data FROM source_parts WHERE part_index >= ? ORDER BY part_index LIMIT ?",
					run.write_part_cursor, maxUnits,
				).toArray();
				let cursor = run.write_part_cursor;
				let sequence = run.write_sequence;
				let chunkIndex = run.write_chunk_index;
				let carry = asBytes(run.write_carry);
				const target = run.mode === "legacy-base64-text"
					? LEGACY_CHUNK_BYTES
					: run.workload === "checkpoint" ? SQLITE_ROW_SAFE_BYTES : Number.MAX_SAFE_INTEGER;
				for (const row of sourceRows) {
					if (row.entry_index !== sequence) throw new Error(`unexpected source entry ${row.entry_index}; expected ${sequence}`);
					carry = concatenate(carry, asBytes(row.data));
					if (run.mode === "final-binary-blob" && run.workload === "journal" && carry.byteLength > SQLITE_ROW_SAFE_BYTES) {
						throw new Error("final journal entry exceeds the Durable Object row ceiling");
					}
					while (carry.byteLength >= target) {
						this.insertChunk(run, sequence, chunkIndex++, carry.subarray(0, target));
						carry = Uint8Array.from(carry.subarray(target));
					}
					if (row.end_of_entry === 1) {
						if (carry.byteLength > 0) this.insertChunk(run, sequence, chunkIndex++, carry);
						carry = new Uint8Array(0);
						sequence++;
						chunkIndex = 0;
					}
					cursor = row.part_index + 1;
				}
				done = cursor === run.expected_parts;
				if (done && (carry.byteLength !== 0 || sequence !== run.expected_entries)) {
					throw new Error("write finished with an incomplete entry");
				}
				this.sql.exec(`UPDATE benchmark_run SET status = ?, write_part_cursor = ?, write_sequence = ?,
					write_chunk_index = ?, write_carry = ? WHERE id = 1`,
				done ? "reading" : "writing", cursor, sequence, chunkIndex, ownedBuffer(carry));
			});
			const elapsed = performance.now() - started;
			this.sql.exec(`UPDATE benchmark_run SET write_ms = write_ms + ?, write_invocations = write_invocations + 1,
				database_bytes_after_write = CASE WHEN ? THEN ? ELSE database_bytes_after_write END WHERE id = 1`,
			elapsed, done ? 1 : 0, this.sql.databaseSize);
			return this.status();
		} catch (error) {
			return this.fail(error instanceof Error ? error.message : String(error));
		}
	}

	private readStep(maxUnits: number): Response {
		const run = this.run();
		if (!run || run.status !== "reading") return json({ error: "run_not_readable" }, 409);
		const started = performance.now();
		try {
			const output = this.sql.exec<OutputRow>(
				"SELECT id, data FROM benchmark_chunks WHERE id > ? ORDER BY id LIMIT ?", run.read_row_cursor, maxUnits,
			).toArray();
			let cursor = run.read_row_cursor;
			let bytesRead = run.read_bytes;
			let checksum = run.read_checksum >>> 0;
			for (const row of output) {
				let bytes: Uint8Array;
				if (run.mode === "legacy-base64-text") {
					if (typeof row.data !== "string") throw new Error("legacy benchmark row was not TEXT");
					bytes = legacyBase64UrlToBytes(row.data);
				} else {
					if (typeof row.data === "string") throw new Error("final benchmark row was not BLOB");
					bytes = asBytes(row.data);
				}
				bytesRead += bytes.byteLength;
				checksum = updateFnv1a(checksum, bytes);
				cursor = row.id;
			}
			const remaining = this.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM benchmark_chunks WHERE id > ?", cursor,
			).toArray()[0]!.count;
			const done = remaining === 0;
			const matches = !done || (bytesRead === run.expected_bytes && checksum === (run.expected_checksum >>> 0));
			const elapsed = performance.now() - started;
			this.sql.exec(`UPDATE benchmark_run SET status = ?, read_row_cursor = ?, read_bytes = ?, read_checksum = ?,
				read_ms = read_ms + ?, read_invocations = read_invocations + 1, error = ? WHERE id = 1`,
				done ? matches ? "complete" : "failed" : "reading", cursor, bytesRead, checksum, elapsed,
				done && !matches ? "reconstructed bytes/checksum mismatch" : null);
			return this.status();
		} catch (error) {
			return this.fail(error instanceof Error ? error.message : String(error));
		}
	}

	private status(): Response {
		const run = this.run();
		if (!run) return json({ error: "run_not_initialized" }, 404);
		const output = this.sql.exec<{ rows: number; bytes: number; text_rows: number; blob_rows: number }>(
			`SELECT COUNT(*) AS rows, COALESCE(SUM(length(data)), 0) AS bytes,
			 COALESCE(SUM(CASE WHEN typeof(data) = 'text' THEN 1 ELSE 0 END), 0) AS text_rows,
			 COALESCE(SUM(CASE WHEN typeof(data) = 'blob' THEN 1 ELSE 0 END), 0) AS blob_rows FROM benchmark_chunks`,
		).toArray()[0]!;
		return json({
			mode: run.mode, workload: run.workload, status: run.status,
			expected: { parts: run.expected_parts, entries: run.expected_entries, bytes: run.expected_bytes, checksum: run.expected_checksum >>> 0 },
			progress: { writtenSourceParts: run.write_part_cursor, readRowsThrough: run.read_row_cursor },
			output: { rows: output.rows, payloadBytes: output.bytes, textRows: output.text_rows, blobRows: output.blob_rows },
			timing: { writeMs: run.write_ms, readMs: run.read_ms, writeInvocations: run.write_invocations, readInvocations: run.read_invocations },
			database: {
				bytesBefore: run.database_bytes_before, bytesAfterWrite: run.database_bytes_after_write,
				writeGrowthBytes: Math.max(0, run.database_bytes_after_write - run.database_bytes_before), currentBytes: this.sql.databaseSize,
			},
			verification: { bytes: run.read_bytes, checksum: run.read_checksum >>> 0,
				matches: run.status === "complete" ? true : run.status === "failed" ? false : null },
			error: run.error,
		});
	}

	private destroy(): Response {
		this.sql.exec("DELETE FROM benchmark_chunks; DELETE FROM source_parts; DELETE FROM benchmark_run;");
		return json({ ok: true, destroyed: true });
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/init") return this.initialize(request);
		const source = url.pathname.match(/^\/source\/(\d+)$/);
		if (request.method === "PUT" && source?.[1]) return this.upload(request, Number(source[1]));
		if (request.method === "POST" && url.pathname === "/seal") return this.seal();
		if (request.method === "POST" && url.pathname === "/step") {
			const run = this.run();
			if (!run) return json({ error: "run_not_initialized" }, 404);
			const maxUnits = integer(Number(url.searchParams.get("maxUnits") ?? "1"), "maxUnits", 1, 8);
			if (run.status === "sealed" || run.status === "writing") return this.writeStep(maxUnits);
			if (run.status === "reading") return this.readStep(maxUnits);
			return this.status();
		}
		if (request.method === "GET" && url.pathname === "/status") return this.status();
		if (request.method === "DELETE" && url.pathname === "/") return this.destroy();
		return json({ error: "not_found" }, 404);
	}
}

export default benchmarkWorker;
