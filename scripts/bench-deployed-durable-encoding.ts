import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import * as Y from "yjs";
import {
	MAX_CLIENT_MARKDOWN_BYTES,
	SQLITE_ROW_SAFE_BYTES,
} from "../server/src/shared/durableLimits";

const SOURCE_PART_BYTES = 512 * 1024;
const CHECKPOINT_BYTES = 48 * 1024 * 1024;
const FNV_OFFSET = 0x811c9dc5;

type Mode = "legacy-base64-text" | "final-binary-blob";
type Workload = "journal" | "checkpoint";

interface SourceEntry {
	label: string;
	bytes: Uint8Array;
}

interface Part {
	entry: number;
	end: boolean;
	bytes: Uint8Array;
}

interface RunResult {
	mode: Mode;
	workload: Workload;
	status: string;
	output: { rows: number; payloadBytes: number; textRows: number; blobRows: number };
	timing: { writeMs: number; readMs: number; writeInvocations: number; readInvocations: number };
	database: { bytesBefore: number; bytesAfterWrite: number; writeGrowthBytes: number; currentBytes: number };
	verification: { bytes: number; checksum: number; matches: boolean | null };
	client: { uploadMs: number; runMs: number; requests: number };
}

interface Measurement {
	mode: Mode;
	workload: Workload;
	trials: number;
	rawBytes: number;
	rows: number;
	payloadBytes: number;
	databaseGrowthBytes: number;
	serverWriteMs: number;
	serverReadMs: number;
	clientRunMs: number;
	writeRangeMs: [number, number];
	readRangeMs: [number, number];
}

const host = required("YAOS_DEPLOYED_BENCH_HOST").replace(/\/+$/u, "");
const secret = required("YAOS_DEPLOYED_BENCH_SECRET");
const accessClientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
	throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be supplied together");
}
const trials = integerEnv("YAOS_DEPLOYED_BENCH_TRIALS", 3, 1, 10);
const roots = [join(process.env.HOME ?? "", "Downloads"), join(process.env.HOME ?? "", "garden")];

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
	const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function updateFnv1a(checksum: number, bytes: Uint8Array): number {
	let value = checksum >>> 0;
	for (const byte of bytes) {
		value ^= byte;
		value = Math.imul(value, 0x01000193) >>> 0;
	}
	return value;
}

function deterministicBytes(size: number, salt = 0): Uint8Array {
	const bytes = new Uint8Array(size);
	let state = (0x9e3779b9 ^ salt) >>> 0;
	for (let index = 0; index < size; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & 0xff;
	}
	return bytes;
}

async function textFiles(root: string): Promise<string[]> {
	const result: string[] = [];
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
			else if (entry.isFile() && /\.(?:md|txt)$/iu.test(entry.name)) result.push(path);
		}
	}
	await visit(root);
	return result;
}

async function journalCorpus(): Promise<{ entries: SourceEntry[]; filesScanned: number }> {
	const files = (await Promise.all(roots.map(textFiles))).flat();
	const sized = await Promise.all(files.map(async (path) => ({ path, size: (await stat(path)).size })));
	sized.sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
	const entries: SourceEntry[] = [];
	for (const item of sized) {
		if (item.size > MAX_CLIENT_MARKDOWN_BYTES) continue;
		if (item.size < 32 * 1024) break;
		const document = new Y.Doc();
		document.clientID = entries.length + 1;
		document.getText("body").insert(0, await readFile(item.path, "utf8"));
		const bytes = Y.encodeStateAsUpdate(document);
		document.destroy();
		if (bytes.byteLength > SQLITE_ROW_SAFE_BYTES) continue;
		const root = roots.find((candidate) => item.path.startsWith(`${candidate}/`)) ?? roots[0]!;
		entries.push({ label: `${basename(root)}:${relative(root, item.path)}`, bytes });
		if (entries.length === 12) break;
	}
	if (entries.length === 0) {
		entries.push({ label: "synthetic-journal-boundary", bytes: deterministicBytes(SQLITE_ROW_SAFE_BYTES - 4096, 1000) });
	}
	return { entries, filesScanned: files.length };
}

function parts(entries: readonly SourceEntry[]): Part[] {
	const result: Part[] = [];
	for (const [entry, source] of entries.entries()) {
		for (let offset = 0; offset < source.bytes.byteLength; offset += SOURCE_PART_BYTES) {
			const end = Math.min(source.bytes.byteLength, offset + SOURCE_PART_BYTES);
			result.push({ entry, end: end === source.bytes.byteLength, bytes: source.bytes.subarray(offset, end) });
		}
	}
	return result;
}

function checksum(entries: readonly SourceEntry[]): number {
	let value = FNV_OFFSET;
	for (const entry of entries) value = updateFnv1a(value, entry.bytes);
	return value >>> 0;
}

function headers(extra?: HeadersInit): Headers {
	const result = new Headers(extra);
	result.set("x-yaos-benchmark-secret", secret);
	if (accessClientId && accessClientSecret) {
		result.set("CF-Access-Client-Id", accessClientId);
		result.set("CF-Access-Client-Secret", accessClientSecret);
	}
	return result;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${host}${path}`, { ...init, headers: headers(init?.headers) });
	const body = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 300)}`);
	}
	if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 500)}`);
	return parsed as T;
}

async function run(mode: Mode, workload: Workload, entries: readonly SourceEntry[], trial: number): Promise<RunResult> {
	const runId = `${workload}-${mode === "legacy-base64-text" ? "legacy" : "blob"}-${trial}-${randomUUID()}`;
	const route = `/__yaos/benchmark/runs/${runId}`;
	const sourceParts = parts(entries);
	const rawBytes = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
	let requests = 0;
	await call(`${route}/init`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode, workload, expectedParts: sourceParts.length, expectedEntries: entries.length,
			expectedBytes: rawBytes, expectedChecksum: checksum(entries) }),
	});
	requests++;
	const uploadStarted = performance.now();
	for (const [partIndex, part] of sourceParts.entries()) {
		await call(`${route}/source/${partIndex}?entry=${part.entry}&end=${part.end ? 1 : 0}`, {
			method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: part.bytes,
		});
		requests++;
	}
	await call(`${route}/seal`, { method: "POST" });
	requests++;
	const uploadMs = performance.now() - uploadStarted;
	const runStarted = performance.now();
	let result: RunResult | null = null;
	for (let step = 0; step < 10_000; step++) {
		result = await call<RunResult>(`${route}/step?maxUnits=2`, { method: "POST" });
		requests++;
		if (result.status === "complete") break;
		if (result.status === "failed") throw new Error(`${runId} failed: ${JSON.stringify(result)}`);
	}
	if (!result || result.status !== "complete" || result.verification.matches !== true) {
		throw new Error(`${runId} did not complete and verify`);
	}
	result.client = { uploadMs: round(uploadMs), runMs: round(performance.now() - runStarted), requests };
	await call(`${route}/`, { method: "DELETE" });
	return result;
}

function summarize(mode: Mode, workload: Workload, rawBytes: number, results: readonly RunResult[]): Measurement {
	const writes = results.map((result) => result.timing.writeMs);
	const reads = results.map((result) => result.timing.readMs);
	return {
		mode, workload, trials: results.length, rawBytes,
		rows: median(results.map((result) => result.output.rows)),
		payloadBytes: median(results.map((result) => result.output.payloadBytes)),
		databaseGrowthBytes: median(results.map((result) => result.database.writeGrowthBytes)),
		serverWriteMs: round(median(writes)), serverReadMs: round(median(reads)),
		clientRunMs: round(median(results.map((result) => result.client.runMs))),
		writeRangeMs: [round(Math.min(...writes)), round(Math.max(...writes))],
		readRangeMs: [round(Math.min(...reads)), round(Math.max(...reads))],
	};
}

function improvement(legacy: Measurement, final: Measurement): Record<string, number> {
	return {
		rowsReductionPercent: round((1 - final.rows / legacy.rows) * 100),
		payloadReductionPercent: round((1 - final.payloadBytes / legacy.payloadBytes) * 100),
		databaseGrowthReductionPercent: round((1 - final.databaseGrowthBytes / legacy.databaseGrowthBytes) * 100),
		serverWriteSpeedup: round(legacy.serverWriteMs / final.serverWriteMs),
		serverReadSpeedup: round(legacy.serverReadMs / final.serverReadMs),
		clientRunSpeedup: round(legacy.clientRunMs / final.clientRunMs),
	};
}

const health = await call<{ ok: boolean; isolated: boolean }>("/__yaos/benchmark/health");
if (!health.ok || !health.isolated) throw new Error("benchmark Worker health contract failed");
const corpus = await journalCorpus();
const journalEntries: SourceEntry[] = [];
for (let repeat = 0; repeat < 6; repeat++) {
	for (const [index, size] of [4 * 1024, 64 * 1024, 512 * 1024, 1_200_000, 1_700_000].entries()) {
		journalEntries.push({ label: `synthetic-${repeat}-${size}`, bytes: deterministicBytes(size, repeat * 10 + index) });
	}
}
journalEntries.push(...corpus.entries);
const workloads: Array<{ workload: Workload; entries: SourceEntry[] }> = [
	{ workload: "journal", entries: journalEntries },
	{ workload: "checkpoint", entries: [{ label: "synthetic-48MiB-checkpoint", bytes: deterministicBytes(CHECKPOINT_BYTES, 999) }] },
];
const measurements: Measurement[] = [];
for (const item of workloads) {
	const rawBytes = item.entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
	const modes: readonly Mode[] = item.workload === "checkpoint"
		? ["final-binary-blob", "legacy-base64-text"]
		: ["legacy-base64-text", "final-binary-blob"];
	for (const mode of modes) {
		const results: RunResult[] = [];
		for (let trial = 0; trial < trials; trial++) results.push(await run(mode, item.workload, item.entries, trial));
		measurements.push(summarize(mode, item.workload, rawBytes, results));
	}
}
const comparisons = workloads.map(({ workload }) => {
	const legacy = measurements.find((item) => item.workload === workload && item.mode === "legacy-base64-text")!;
	const final = measurements.find((item) => item.workload === workload && item.mode === "final-binary-blob")!;
	return { workload, ...improvement(legacy, final) };
});
console.log(JSON.stringify({
	target: host, trials, corpus: { filesScanned: corpus.filesScanned,
		realEntries: corpus.entries.map((entry) => ({ label: entry.label, bytes: entry.bytes.byteLength })),
		journalEntries: journalEntries.length, syntheticJournalEntries: journalEntries.length - corpus.entries.length },
	measurements, comparisons,
}, null, 2));
