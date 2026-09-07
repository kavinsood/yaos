import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import * as Y from "yjs";
import {
	MAX_CLIENT_MARKDOWN_BYTES,
	SQLITE_ROW_SAFE_BYTES,
} from "../server/src/shared/durableLimits";

/** Historical yaos3 TEXT-row implementation, before the greenfield format change. */
const LEGACY_CHUNK_BYTES = 1024 * 1024;
const LEGACY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LEGACY_DECODE = new Uint8Array(256).fill(0xff);
for (let index = 0; index < LEGACY_ALPHABET.length; index++) {
	LEGACY_DECODE[LEGACY_ALPHABET.charCodeAt(index)] = index;
}

const corpusRoots = [join(process.env.HOME ?? "", "Downloads"), join(process.env.HOME ?? "", "garden")];
const trials = Math.max(1, Number.parseInt(process.env.YAOS_BENCH_TRIALS ?? "3", 10));

interface WorkloadEntry {
	label: string;
	bytes: Uint8Array;
}

interface CorpusEntry {
	root: string;
	path: string;
	sourceBytes: number;
	updateBytes: number;
}

interface TrialMeasurement {
	rows: number;
	sqlPayloadBytes: number;
	databaseBytes: number;
	writeMs: number;
	readMs: number;
}

interface Measurement extends TrialMeasurement {
	mode: "legacy-base64-text" | "final-binary-blob";
	workload: string;
	rawBytes: number;
	trials: number;
	writeRangeMs: [number, number];
	readRangeMs: [number, number];
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

/** Exact codec used by the old TEXT-row implementation. */
function legacyBytesToBase64Url(bytes: Uint8Array): string {
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

/** Exact decoder used by the old TEXT-row implementation. */
function legacyBase64UrlToBytes(value: string): Uint8Array {
	for (let index = 0; index < value.length; index++) {
		if (LEGACY_DECODE[value.charCodeAt(index)] === 0xff) {
			throw new Error(`invalid legacy base64url character at index ${index}`);
		}
	}
	const remainder = value.length % 4;
	if (remainder === 1) throw new Error("invalid legacy base64url length");
	const outputLength = Math.floor(value.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
	const output = new Uint8Array(outputLength);
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

function deterministicBytes(size: number, salt: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let state = (0x9e3779b9 ^ salt) >>> 0;
	for (let index = 0; index < bytes.length; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & 0xff;
	}
	return bytes;
}

async function textFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	async function visit(directory: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name)) found.push(path);
		}
	}
	await visit(root);
	return found;
}

async function realYjsUpdates(): Promise<{
	entries: WorkloadEntry[];
	corpus: CorpusEntry[];
	filesScanned: number;
	filesAboveClientCeiling: number;
}> {
	const candidates = (await Promise.all(corpusRoots.map(textFiles))).flat();
	const sized = await Promise.all(candidates.map(async (path) => ({ path, size: (await stat(path)).size })));
	sized.sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
	const entries: WorkloadEntry[] = [];
	const corpus: CorpusEntry[] = [];
	let filesAboveClientCeiling = 0;
	for (const item of sized) {
		if (item.size > MAX_CLIENT_MARKDOWN_BYTES) {
			filesAboveClientCeiling++;
			continue;
		}
		if (item.size < 32 * 1024) break;
		const text = await readFile(item.path, "utf8");
		const document = new Y.Doc();
		// Yjs otherwise chooses a random client id, which can change varint lengths
		// by a few bytes between otherwise identical benchmark runs.
		document.clientID = entries.length + 1;
		document.getText("body").insert(0, text);
		const update = Y.encodeStateAsUpdate(document);
		document.destroy();
		if (update.byteLength > SQLITE_ROW_SAFE_BYTES) continue;
		const root = corpusRoots.find((candidate) => item.path.startsWith(`${candidate}/`)) ?? corpusRoots[0]!;
		const label = `${basename(root)}:${relative(root, item.path)}`;
		entries.push({ label, bytes: update });
		corpus.push({ root: basename(root), path: relative(root, item.path), sourceBytes: item.size, updateBytes: update.byteLength });
		if (entries.length === 12) break;
	}
	return { entries, corpus, filesScanned: candidates.length, filesAboveClientCeiling };
}

function chunks(bytes: Uint8Array, maximum: number): Uint8Array[] {
	const result: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += maximum) {
		result.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + maximum)));
	}
	return result;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function measureOnce(
	mode: Measurement["mode"],
	entries: readonly WorkloadEntry[],
	checkpoint: boolean,
): TrialMeasurement {
	const directory = mkdtempSync(join(tmpdir(), "yaos-storage-bench-"));
	const path = join(directory, "bench.sqlite");
	const database = new DatabaseSync(path);
	database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
		CREATE TABLE chunks(sequence INTEGER, chunk_index INTEGER, data ${mode === "legacy-base64-text" ? "TEXT" : "BLOB"} NOT NULL,
		PRIMARY KEY(sequence, chunk_index));`);
	const insert = database.prepare("INSERT INTO chunks(sequence, chunk_index, data) VALUES (?, ?, ?)");
	const writeStarted = performance.now();
	database.exec("BEGIN IMMEDIATE");
	try {
		for (let sequence = 0; sequence < entries.length; sequence++) {
			const maximum = mode === "legacy-base64-text"
				? LEGACY_CHUNK_BYTES
				: checkpoint ? SQLITE_ROW_SAFE_BYTES : Number.MAX_SAFE_INTEGER;
			for (const [chunkIndex, chunk] of chunks(entries[sequence]!.bytes, maximum).entries()) {
				const value = mode === "legacy-base64-text"
					? legacyBytesToBase64Url(chunk)
					: Uint8Array.from(chunk);
				insert.run(sequence, chunkIndex, value);
			}
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
	const writeMs = performance.now() - writeStarted;
	database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	const summary = database.prepare(
		"SELECT COUNT(*) AS rows, COALESCE(SUM(length(data)), 0) AS bytes FROM chunks",
	).get() as { rows: number; bytes: number };
	const readStarted = performance.now();
	let reconstructedBytes = 0;
	let sequence = -1;
	let sequenceParts: Uint8Array[] = [];
	const finishSequence = (): void => {
		if (sequenceParts.length === 0) return;
		reconstructedBytes += concatenate(sequenceParts).byteLength;
		sequenceParts = [];
	};
	for (const row of database.prepare(
		"SELECT sequence, data FROM chunks ORDER BY sequence, chunk_index",
	).iterate() as Iterable<{ sequence: number; data: string | Uint8Array }>) {
		if (row.sequence !== sequence) {
			finishSequence();
			sequence = row.sequence;
		}
		sequenceParts.push(typeof row.data === "string" ? legacyBase64UrlToBytes(row.data) : row.data);
	}
	finishSequence();
	const readMs = performance.now() - readStarted;
	const rawBytes = entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
	if (reconstructedBytes !== rawBytes) throw new Error(`${mode} reconstructed ${reconstructedBytes}, expected ${rawBytes}`);
	database.close();
	const databaseBytes = statSync(path).size;
	rmSync(directory, { recursive: true, force: true });
	return { rows: summary.rows, sqlPayloadBytes: summary.bytes, databaseBytes, writeMs, readMs };
}

function measure(
	mode: Measurement["mode"],
	workload: string,
	entries: readonly WorkloadEntry[],
	checkpoint: boolean,
): Measurement {
	const results = Array.from({ length: trials }, () => measureOnce(mode, entries, checkpoint));
	const writes = results.map((result) => result.writeMs);
	const reads = results.map((result) => result.readMs);
	const representative = results[0]!;
	return {
		mode,
		workload,
		rawBytes: entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
		rows: representative.rows,
		sqlPayloadBytes: representative.sqlPayloadBytes,
		databaseBytes: representative.databaseBytes,
		writeMs: round(median(writes)),
		readMs: round(median(reads)),
		trials,
		writeRangeMs: [round(Math.min(...writes)), round(Math.max(...writes))],
		readRangeMs: [round(Math.min(...reads)), round(Math.max(...reads))],
	};
}

const real = await realYjsUpdates();
const journalEntries: WorkloadEntry[] = [];
for (let repeat = 0; repeat < 6; repeat++) {
	for (const [index, size] of [4 * 1024, 64 * 1024, 512 * 1024, 1_200_000, 1_700_000].entries()) {
		journalEntries.push({ label: `synthetic-${repeat}-${size}`, bytes: deterministicBytes(size, repeat * 10 + index) });
	}
}
journalEntries.push(...real.entries);
const checkpointEntries = [{ label: "48MiB-checkpoint", bytes: deterministicBytes(48 * 1024 * 1024, 999) }];

const measurements: Measurement[] = [];
for (const [workload, entries, checkpoint] of [
	["journal", journalEntries, false],
	["checkpoint-48MiB", checkpointEntries, true],
] as const) {
	// Alternate order by workload so one design does not always get the warmer filesystem cache.
	const modes: Measurement["mode"][] = checkpoint
		? ["final-binary-blob", "legacy-base64-text"]
		: ["legacy-base64-text", "final-binary-blob"];
	for (const mode of modes) measurements.push(measure(mode, workload, entries, checkpoint));
}

const comparisons = Object.fromEntries(["journal", "checkpoint-48MiB"].map((workload) => {
	const legacy = measurements.find((value) => value.workload === workload && value.mode === "legacy-base64-text")!;
	const final = measurements.find((value) => value.workload === workload && value.mode === "final-binary-blob")!;
	return [workload, {
		rowReductionPercent: round((1 - final.rows / legacy.rows) * 100),
		sqlPayloadReductionPercent: round((1 - final.sqlPayloadBytes / legacy.sqlPayloadBytes) * 100),
		databaseReductionPercent: round((1 - final.databaseBytes / legacy.databaseBytes) * 100),
		writeSpeedup: round(legacy.writeMs / final.writeMs),
		readSpeedup: round(legacy.readMs / final.readMs),
	}];
}));

console.log(JSON.stringify({
	environment: { node: process.version, platform: `${process.platform}-${process.arch}`, trials },
	method: {
		legacy: "Exact historical hand-written base64url codec, 1 MiB chunks, SQLite TEXT",
		final: `Raw binary, ${SQLITE_ROW_SAFE_BYTES}-byte checkpoint chunks, one BLOB row per admitted journal update`,
		timing: "Median of isolated SQLite databases; FULL synchronous writes; reads include decoding and chunk concatenation",
	},
	realCorpus: {
		roots: corpusRoots,
		filesScanned: real.filesScanned,
		filesAboveClientCeiling: real.filesAboveClientCeiling,
		filesUsed: real.corpus,
	},
	workloads: {
		journal: { entries: journalEntries.length, syntheticEntries: journalEntries.length - real.entries.length },
		checkpoint: { entries: 1, bytes: checkpointEntries[0]!.bytes.byteLength },
	},
	measurements,
	comparisons,
}, null, 2));
