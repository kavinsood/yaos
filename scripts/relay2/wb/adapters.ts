/**
 * W4 adapters: the seams where W1/W2/W3 plug into the measurement harness.
 *
 * Every hook that depends on unfinished work is marked `TODO(W1)`, `TODO(W2)` or `TODO(W3)`. Each adapter reports
 * `implemented` / `source` in the scenario JSON, so no run can silently present a fallback as the real thing.
 *
 *  - RowsCounter   exact cumulative SQLite rows of the vault DO (W1 debug route), tolerant reader, with fallbacks
 *                  (relay in-memory counter = relay appends only; "none").
 *  - CreateAdapter file creation: `legacy` = today's production import path (admission + candidate + finalize + publish,
 *                  blobs PUT + attachments/publish per attachment); `bulk` = W2 `POST /lifecycle/create-bulk`.
 *  (b3-bulk: the W1 receipt/crash and W3 merge adapters are not ported; see experiments/results/b3/handoff-bulk.md.)
 */
import * as Y from "yjs";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { json, log, now, r2 } from "../lib/common";
import { refreshOperatorCookie, seedNotes, type Context } from "../lib/context";
import { sha256 } from "./corpus";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../../server/src/shared/binaryEnvelope";

type Obj = Record<string, unknown>;

// =================================================================================================== rows counter
export interface RowsReading {
	at: number; wall: number;
	rowsWritten: number | null; rowsRead: number | null;
	/** debug-route = W1 exact counter; relay-diagnostics = relay in-memory counter (relay appends + checkpoints only). */
	source: "debug-route" | "relay-diagnostics" | "none";
	exact: boolean;
	httpStatus?: number; error?: string;
	/** Extra fields the route returned (e.g. per-statement breakdown), passed through untouched. */
	extra?: Obj;
}

/**
 * W1 (c5dc60b): GET /vault/:id/debug/sql-rows (operator session; YAOS_TEST_ONLY_DEBUG_ROUTES=true), cumulative per DO:
 *   { rowsWritten, rowsRead, setAlarms, billedRowsWritten (= rowsWritten + setAlarms, the Free-plan figure), ... }
 * The harness reads billedRowsWritten first (raw rowsWritten stays in `extra`). POST …/sql-rows/reset exists but the
 * harness uses deltas (rowsDelta flags a counter reset on DO restart). Older shapes are still accepted.
 */
export const DEFAULT_ROWS_ROUTE = process.env.WB_ROWS_ROUTE ?? "debug/sql-rows";

const WRITTEN_KEYS = ["billedRowsWritten", "rowsWritten", "rows_written", "written", "rowsWrittenTotal", "totalRowsWritten"];
const READ_KEYS = ["rowsRead", "rows_read", "read", "rowsReadTotal", "totalRowsRead"];
const NEST_KEYS = ["cumulative", "total", "totals", "rows", "counters", "sql", "vault", "result"];

function asNum(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return null;
}
/** Tolerant extraction of {rowsWritten, rowsRead} from an arbitrary JSON payload (top level first, then known nests). */
export function parseRowsPayload(value: unknown): { rowsWritten: number | null; rowsRead: number | null } {
	const visit = (o: unknown, depth: number): { rowsWritten: number | null; rowsRead: number | null } => {
		if (!o || typeof o !== "object" || depth > 3) return { rowsWritten: null, rowsRead: null };
		const r = o as Obj;
		let w: number | null = null, rd: number | null = null;
		for (const k of WRITTEN_KEYS) if (w === null) w = asNum(r[k]);
		for (const k of READ_KEYS) if (rd === null) rd = asNum(r[k]);
		for (const k of NEST_KEYS) {
			if (w !== null && rd !== null) break;
			const inner = visit(r[k], depth + 1);
			w ??= inner.rowsWritten; rd ??= inner.rowsRead;
		}
		return { rowsWritten: w, rowsRead: rd };
	};
	return visit(value, 0);
}

export class RowsCounter {
	mode: "auto" | "debug-route" | "relay-diagnostics" | "none";
	private resolved: RowsReading["source"] | null = null;
	readonly readings: RowsReading[] = [];
	constructor(private readonly context: Context, private readonly route = DEFAULT_ROWS_ROUTE, mode?: string) {
		this.mode = (mode ?? process.env.WB_ROWS_MODE ?? "auto") as RowsCounter["mode"];
	}
	get source() { return this.resolved; }

	private async viaRoute(): Promise<RowsReading | null> {
		const id = this.context.devices.A!;
		const url = vaultRoute(id, this.route);
		const tries: Array<() => Promise<Response>> = [
			() => fetch(url, { headers: { cookie: this.context.operatorCookie } }),
			() => fetch(url, { headers: deviceBearerHeaders(id) }),
		];
		let last: Response | null = null;
		for (const [i, go] of tries.entries()) {
			let r = await go();
			if (r.status === 401 && i === 0) { await refreshOperatorCookie(this.context); r = await go(); }
			if (r.ok) {
				const value = await json(r);
				const parsed = parseRowsPayload(value);
				if (parsed.rowsWritten === null) return { at: now(), wall: Date.now(), ...parsed, source: "debug-route", exact: false,
					httpStatus: r.status, error: "route answered without a rowsWritten field", extra: value ?? undefined };
				return { at: now(), wall: Date.now(), ...parsed, source: "debug-route", exact: true, httpStatus: r.status,
					extra: value ? Object.fromEntries(Object.entries(value).filter(([k]) => !WRITTEN_KEYS.includes(k) && !READ_KEYS.includes(k))) : undefined };
			}
			await r.arrayBuffer().catch(() => null);
			last = r;
		}
		return last && last.status !== 404 ? { at: now(), wall: Date.now(), rowsWritten: null, rowsRead: null, source: "debug-route", exact: false,
			httpStatus: last.status, error: `rows route ${this.route} → ${last.status}` } : null;
	}

	private async viaRelayDiagnostics(): Promise<RowsReading> {
		const id = this.context.devices.A!;
		const r = await fetch(vaultRoute(id, "diagnostics"), { headers: deviceBearerHeaders(id) }).catch(() => null);
		const v = r?.ok ? await json(r) : null;
		const counters = (v?.relay as Obj | undefined)?.counters as Obj | undefined;
		const w = asNum(counters?.rowsWritten);
		return { at: now(), wall: Date.now(), rowsWritten: w, rowsRead: null, source: w === null ? "none" : "relay-diagnostics", exact: false,
			httpStatus: r?.status, ...(w === null ? { error: "no relay counters (flag off?)" } : {}) };
	}

	async read(): Promise<RowsReading> {
		let reading: RowsReading | null = null;
		try {
			if (this.mode === "none") reading = { at: now(), wall: Date.now(), rowsWritten: null, rowsRead: null, source: "none", exact: false };
			else if (this.mode === "relay-diagnostics") reading = await this.viaRelayDiagnostics();
			else {
				if (this.resolved !== "relay-diagnostics") reading = await this.viaRoute();
				if (!reading && this.mode === "auto") reading = await this.viaRelayDiagnostics();
				reading ??= { at: now(), wall: Date.now(), rowsWritten: null, rowsRead: null, source: "none", exact: false, error: "rows route 404" };
			}
		} catch (error) {
			reading = { at: now(), wall: Date.now(), rowsWritten: null, rowsRead: null, source: "none", exact: false, error: String(error).slice(0, 200) };
		}
		if (this.resolved === null && reading.rowsWritten !== null) { this.resolved = reading.source; log(`rows counter source: ${reading.source}`); }
		this.readings.push(reading);
		if (this.readings.length > 5000) this.readings.splice(0, 2500);
		return reading;
	}
}

export interface RowsDelta { rowsWritten: number | null; rowsRead: number | null; source: string; exact: boolean; counterReset: boolean; ms: number }
/** after − before; a decrease means the counter reset (DO restart) → null + counterReset. */
export function rowsDelta(a: RowsReading, b: RowsReading): RowsDelta {
	const d = (x: number | null, y: number | null) => (x === null || y === null ? null : y - x);
	const w = d(a.rowsWritten, b.rowsWritten), rd = d(a.rowsRead, b.rowsRead);
	const reset = (w !== null && w < 0) || (rd !== null && rd < 0);
	return { rowsWritten: reset ? null : w, rowsRead: reset ? null : rd, source: a.source === b.source ? a.source : `${a.source}→${b.source}`,
		exact: a.exact && b.exact && !reset, counterReset: reset, ms: r2(b.at - a.at) };
}

// =================================================================================================== create
export interface NoteInput { kind: "note"; path: string; bodyId: string; content: string }
export interface AttachmentInput { kind: "attachment"; path: string; bytes: Uint8Array; mime: string }
export type CreateInput = NoteInput | AttachmentInput;
export type ItemOutcome = "created" | "exists-identical" | "exists-different" | "rejected" | "error";
export interface CreateBatch {
	index: number; files: number; notes: number; attachments: number; bytes: number;
	startedAtWall: number; endedAtWall: number; ms: number; httpStatus: number | null; requests: number; error?: string;
	/** Rows counter delta for this batch when the scenario reads the counter between batches. */
	rows?: RowsDelta;
}
export interface CreateResult {
	adapter: string; implemented: boolean;
	outcomes: Array<{ path: string; outcome: ItemOutcome; detail?: string }>;
	batches: CreateBatch[];
	requests: number; blobUploads: number; wallMs: number;
	oversizeSingles: number;
}
export interface CreateOptions {
	maxFiles?: number; maxBytes?: number;
	/** Called after each batch (scenarios read the rows counter here). */
	afterBatch?: (b: CreateBatch) => Promise<void>;
	device?: string;
	onProgress?: (done: number, total: number) => void;
}
export interface CreateAdapter {
	readonly name: string;
	readonly implemented: boolean;
	create(context: Context, items: readonly CreateInput[], options?: CreateOptions): Promise<CreateResult>;
}

/**
 * Bytes an item adds to a create REQUEST body. Attachment bytes go up separately (PUT blobs/:sha256 first), so only their
 * metadata counts (confirmed by W2: the bulk request carries {hash,size,mime}; bulk measures update-frame bytes).
 */
export const ATTACHMENT_META_BYTES = 256;
const inputBytes = (i: CreateInput) => (i.kind === "note" ? Buffer.byteLength(i.content) : ATTACHMENT_META_BYTES);

/** Split by the W2 caps (≤ maxFiles, ≤ maxBytes); an item larger than maxBytes travels alone. */
export function splitBatches<T extends CreateInput>(items: readonly T[], maxFiles: number, maxBytes: number, size: (i: T) => number = inputBytes): T[][] {
	const out: T[][] = [];
	let cur: T[] = [], bytes = 0;
	for (const it of items) {
		const b = size(it);
		if (cur.length && (cur.length >= maxFiles || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
		cur.push(it); bytes += b;
	}
	if (cur.length) out.push(cur);
	return out;
}

async function putBlob(identity: LiveIdentity, bytes: Uint8Array): Promise<{ hash: string; status: number; ms: number }> {
	const hash = sha256(bytes);
	const t0 = now();
	const r = await fetch(vaultRoute(identity, `blobs/${hash}`), { method: "PUT",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/octet-stream" }), body: bytes });
	await r.arrayBuffer().catch(() => null);
	return { hash, status: r.status, ms: r2(now() - t0) };
}

/**
 * Today's production path (what relay v2 / 3b66f1b clients do). Comparator for I1/I3; cannot express I2 outcomes.
 * NOTE: W2 removes lifecycle/admissions, so this adapter only works against a pre-W2 server (wbbase / 3b66f1b).
 */
export const legacyCreate: CreateAdapter = {
	name: "legacy", implemented: true,
	async create(context, items, options = {}) {
		const identity = context.devices[options.device ?? "A"]!;
		const t0 = now();
		const result: CreateResult = { adapter: "legacy", implemented: true, outcomes: [], batches: [], requests: 0, blobUploads: 0, wallMs: 0, oversizeSingles: 0 };
		const notes = items.filter((i): i is NoteInput => i.kind === "note");
		const atts = items.filter((i): i is AttachmentInput => i.kind === "attachment");
		// Notes: seedNotes = VaultSync.commitFreshBodies, 32 per call (the production import batch size).
		for (const [k, batch] of splitBatches(notes, 32, 4 * 1024 * 1024).entries()) {
			const b: CreateBatch = { index: result.batches.length, files: batch.length, notes: batch.length, attachments: 0,
				bytes: batch.reduce((s, i) => s + inputBytes(i), 0), startedAtWall: Date.now(), endedAtWall: 0, ms: 0, httpStatus: null, requests: 0 };
			const s0 = now();
			try {
				const r = await seedNotes(context, batch.map((i) => ({ bodyId: i.bodyId, path: i.path, content: i.content })), 64 * 1024 * 1024);
				b.requests = r.requests; b.httpStatus = 200;
				for (const i of batch) result.outcomes.push({ path: i.path, outcome: "created" });
			} catch (error) {
				b.error = String(error).slice(0, 300);
				for (const i of batch) result.outcomes.push({ path: i.path, outcome: "error", detail: b.error });
			}
			b.ms = r2(now() - s0); b.endedAtWall = Date.now(); result.requests += b.requests; result.batches.push(b);
			await options.afterBatch?.(b);
			options.onProgress?.(result.outcomes.length, items.length);
			void k;
		}
		// Attachments: blob PUT + one attachments/publish per file (≤ 2 root events per commit today).
		const rootEpoch = atts.length ? await currentRootEpoch(identity) : 1;
		for (const a of atts) {
			const b: CreateBatch = { index: result.batches.length, files: 1, notes: 0, attachments: 1, bytes: a.bytes.byteLength,
				startedAtWall: Date.now(), endedAtWall: 0, ms: 0, httpStatus: null, requests: 0 };
			const s0 = now();
			const blob = await putBlob(identity, a.bytes);
			result.blobUploads++;
			const r = await fetch(vaultRoute(identity, "attachments/publish"), { method: "POST",
				headers: deviceBearerHeaders(identity, { "Content-Type": "application/json" }),
				body: JSON.stringify({ rootEpoch, operationId: `wb-att-${crypto.randomUUID()}`, kind: "upsert", path: a.path,
					expectedRevision: null, hash: blob.hash, size: a.bytes.byteLength, mime: a.mime }) });
			const body = await json(r);
			b.httpStatus = r.status; b.requests = 2; b.ms = r2(now() - s0); b.endedAtWall = Date.now();
			result.outcomes.push({ path: a.path, outcome: r.ok && blob.status < 300 ? "created" : "error",
				...(r.ok ? {} : { detail: `${blob.status}/${r.status} ${String(body?.error ?? "")}` }) });
			result.requests += 2; result.batches.push(b);
			await options.afterBatch?.(b);
			options.onProgress?.(result.outcomes.length, items.length);
		}
		result.wallMs = r2(now() - t0);
		return result;
	},
};

/**
 * W2 bulk create, wired to wb-w2 @33e1cc5 (server/src/vaultBulkCreateService.ts):
 *   POST /vault/:id/lifecycle/create-bulk, body = binary envelope (server/src/shared/binaryEnvelope.ts)
 *     { batchId, rootEpoch, files: [{ operationId, bodyId, path, updates: Uint8Array[] }],
 *       attachments: [{ operationId, path, hash, size, mime }] }   (blob bytes PUT to /blobs/:hash first, D6)
 *   200 → binary envelope { batchId, outcomes: [{ kind, operationId, path, outcome, reason?, ... }], vaultSequence,
 *         rootGeneration, rootEpoch, replayed, rootUpdate? }; errors → JSON { error } (409 epoch mismatch, 413 caps).
 * Caps: ≤ 500 items, ≤ 4 MiB of update-frame bytes (one lone note may use up to 6 MiB). Frames ≤ 1.75 MB, ≤ 16/file.
 * The batch byte budget is measured on the encoded frames, not on the text.
 */
export const BULK_ROUTE = process.env.WB_BULK_ROUTE ?? "lifecycle/create-bulk";
const FRAME_CHARS = 400_000; // ≤ 1.6 MB per frame even at 4 bytes/char (server row-safe cap 1.75 MB)
export function bodyFrames(text: string): Uint8Array[] {
	const doc = new Y.Doc();
	const frames: Uint8Array[] = [];
	for (let offset = 0; offset < text.length; offset += FRAME_CHARS) {
		const before = Y.encodeStateVector(doc);
		doc.getText("body").insert(offset, text.slice(offset, offset + FRAME_CHARS));
		frames.push(Y.encodeStateAsUpdate(doc, before));
	}
	doc.destroy();
	return frames;
}
export async function currentRootEpoch(identity: LiveIdentity): Promise<number> {
	const r = await fetch(vaultRoute(identity, "root"), { headers: deviceBearerHeaders(identity) });
	await r.arrayBuffer().catch(() => null);
	const epoch = Number(r.headers.get("x-yaos-root-epoch"));
	if (!r.ok || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error(`root read for epoch failed (${r.status})`);
	return epoch;
}
export function bulkCreate(_contentHash?: (text: string) => { contentHash: string; size: number }): CreateAdapter {
	return {
		name: "bulk", implemented: true,
		async create(context, items, options = {}) {
			const identity = context.devices[options.device ?? "A"]!;
			const maxFiles = options.maxFiles ?? 500, maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
			const t0 = now();
			const result: CreateResult = { adapter: "bulk", implemented: true, outcomes: [], batches: [], requests: 0, blobUploads: 0, wallMs: 0, oversizeSingles: 0 };
			const frames = new Map<CreateInput, Uint8Array[]>();
			for (const i of items) if (i.kind === "note") frames.set(i, bodyFrames(i.content));
			const sizeOf = (i: CreateInput) => i.kind === "note" ? frames.get(i)!.reduce((s, f) => s + f.byteLength, 0) : 0;
			let rootEpoch = await currentRootEpoch(identity); result.requests++;
			for (const batch of splitBatches(items, maxFiles, maxBytes, sizeOf)) {
				const bytes = batch.reduce((s, i) => s + sizeOf(i), 0);
				if (batch.length === 1 && bytes > maxBytes) result.oversizeSingles++;
				const b: CreateBatch = { index: result.batches.length, files: batch.length, notes: batch.filter((i) => i.kind === "note").length,
					attachments: batch.filter((i) => i.kind === "attachment").length, bytes, startedAtWall: Date.now(), endedAtWall: 0, ms: 0, httpStatus: null, requests: 0 };
				const s0 = now();
				const opOf = new Map<string, CreateInput>();
				const attachments: Obj[] = [];
				for (const a of batch) if (a.kind === "attachment") {
					const blob = await putBlob(identity, a.bytes); result.blobUploads++; b.requests++;
					const operationId = `wb-att-${crypto.randomUUID()}`; opOf.set(operationId, a);
					attachments.push({ operationId, path: a.path, hash: blob.hash, size: a.bytes.byteLength, mime: a.mime });
				}
				const files = batch.filter((i): i is NoteInput => i.kind === "note").map((i) => {
					const operationId = `wb-file-${crypto.randomUUID()}`; opOf.set(operationId, i);
					return { operationId, bodyId: i.bodyId, path: i.path, updates: frames.get(i)! };
				});
				const batchId = `wb-${crypto.randomUUID()}`;
				const send = () => fetch(vaultRoute(identity, BULK_ROUTE), { method: "POST",
					headers: deviceBearerHeaders(identity, { "Content-Type": YAOS_BINARY_CONTENT_TYPE }),
					body: encodeBinaryEnvelope({ batchId, rootEpoch, files, attachments }) });
				let r = await send(); b.requests++;
				let body: Obj | null = null;
				const read = async () => r.headers.get("content-type")?.includes(YAOS_BINARY_CONTENT_TYPE)
					? decodeBinaryEnvelope(new Uint8Array(await r.arrayBuffer())) as Obj : await json(r);
				body = await read();
				if (r.status === 409 && /epoch/i.test(String(body?.error ?? body?.code ?? ""))) { // root epoch moved: re-read, retry once
					rootEpoch = await currentRootEpoch(identity); b.requests++;
					r = await send(); b.requests++; body = await read();
				}
				b.httpStatus = r.status; b.ms = r2(now() - s0); b.endedAtWall = Date.now();
				const list = (r.ok ? body?.outcomes : undefined) as Obj[] | undefined;
				const byOp = new Map((Array.isArray(list) ? list : []).map((x) => [String(x.operationId ?? ""), x]));
				const known: ItemOutcome[] = ["created", "exists-identical", "exists-different", "rejected"];
				for (const [op, i] of opOf) {
					const x = byOp.get(op);
					const o = String(x?.outcome ?? "") as ItemOutcome;
					result.outcomes.push(known.includes(o) ? { path: i.path, outcome: o, ...(x?.reason ? { detail: String(x.reason) } : {}) }
						: { path: i.path, outcome: "error", detail: r.ok ? `missing outcome for ${op}` : `${r.status} ${String(body?.error ?? "")}` });
				}
				if (!r.ok) b.error = `${r.status} ${String(body?.error ?? "").slice(0, 200)}`;
				result.requests += b.requests; result.batches.push(b);
				await options.afterBatch?.(b);
				options.onProgress?.(result.outcomes.length, items.length);
			}
			result.wallMs = r2(now() - t0);
			return result;
		},
	};
}

export function createAdapterFor(name: string | undefined, contentHash: (text: string) => { contentHash: string; size: number }): CreateAdapter {
	const n = name ?? process.env.WB_CREATE ?? "legacy";
	if (n === "legacy") return legacyCreate;
	if (n === "bulk") return bulkCreate(contentHash);
	throw new Error(`unknown create adapter ${n} (legacy|bulk)`);
}

export function outcomeCounts(r: CreateResult) {
	const c: Record<string, number> = {};
	for (const o of r.outcomes) c[o.outcome] = (c[o.outcome] ?? 0) + 1;
	return c;
}

// =================================================================================================== catalog / root
export interface HeadEntry { bodyId: string; path: string; contentHash: string | null; size: number | null; lifecycle?: string }
/** GET /heads, all pages (active catalog: path + contentHash per body). */
export async function listHeads(identity: LiveIdentity): Promise<{ entries: HeadEntry[]; requests: number; ms: number }> {
	const t0 = now();
	const entries: HeadEntry[] = [];
	let cursor = "", requests = 0;
	for (;;) {
		const r = await fetch(vaultRoute(identity, `heads?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), { headers: deviceBearerHeaders(identity) });
		requests++;
		const v = await json(r);
		if (!r.ok || !v) throw new Error(`heads ${r.status}`);
		for (const e of (v.entries as Obj[]) ?? []) entries.push({ bodyId: String(e.bodyId), path: String(e.path), contentHash: (e.contentHash as string) ?? null,
			size: asNum(e.size), lifecycle: e.lifecycle as string | undefined });
		cursor = (v.nextCursor as string | null) ?? "";
		if (!cursor) break;
	}
	return { entries, requests, ms: r2(now() - t0) };
}

/** GET /root → Y root doc maps (pathToId, pathToBlob). */
export async function rootMaps(identity: LiveIdentity): Promise<{ pathToId: Map<string, unknown>; pathToBlob: Map<string, unknown>; bytes: number }> {
	const r = await fetch(vaultRoute(identity, "root"), { headers: deviceBearerHeaders(identity) });
	const bytes = new Uint8Array(await r.arrayBuffer());
	if (!r.ok) throw new Error(`root ${r.status}`);
	const doc = new Y.Doc();
	Y.applyUpdate(doc, bytes);
	const out = { pathToId: new Map(doc.getMap("pathToId").entries()), pathToBlob: new Map(doc.getMap("pathToBlob").entries()), bytes: bytes.byteLength };
	doc.destroy();
	return out;
}
