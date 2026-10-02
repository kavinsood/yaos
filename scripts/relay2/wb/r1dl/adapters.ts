/**
 * Harness adapters for the R1 (closed-file merge) and DL (D8 daily limit) scenarios, ported from the write-budget
 * spike (yaos-wb-int scripts/relay2/wb/adapters.ts) and trimmed to what R1/DL need on relay v3:
 *
 *  - RowsCounter   cumulative SQLite rows of the vault DO: `debug/sql-rows` when the server has it (not on relay v3),
 *                  else the relay in-memory counter from /diagnostics (labelled `relay-diagnostics`, inexact), else none.
 *  - create        `legacyCreate` = today's production import path (lib/context.seedNotes). `bulkCreate` = the spike's W2
 *                  `lifecycle/create-bulk` (NOT on relay v3); `bulkCreateAvailable` probes for it so DL's bulk phase can skip.
 *  - catalog       listHeads (GET /heads, all pages).
 *  - candidate     closed-file HTTP candidate POST (VaultServerPort.submitCandidate shape) for the DL probe.
 *  - merge (R1)    src/sync/lineMerge.ts (`--merge-module` / WB_MERGE_MODULE) or the harness reference diff3.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as Y from "yjs";
import { vaultRoute } from "../../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../../tests/live/liveIdentity";
import { json, log, now, r2 } from "../../lib/common";
import { refreshOperatorCookie, seedNotes, type Context } from "../../lib/context";
import { mergeNoBase, merge3, type MergeResult, type NoBaseResult } from "./diff3";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../../../server/src/shared/binaryEnvelope";

type Obj = Record<string, unknown>;

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// =================================================================================================== rows counter
export interface RowsReading {
	at: number; wall: number;
	rowsWritten: number | null; rowsRead: number | null;
	/** debug-route = exact per-DO counter; relay-diagnostics = relay in-memory counter (relay appends + checkpoints only). */
	source: "debug-route" | "relay-diagnostics" | "none";
	exact: boolean;
	httpStatus?: number; error?: string;
	/** Requests of this reading that hit ROWS_READ_TIMEOUT_MS and were retried (see fetchRows). */
	timeouts?: number;
	/** Extra fields the route returned (e.g. setAlarms), passed through untouched. */
	extra?: Obj;
}

/** Exact rows route of the write-budget spike (absent on relay v3; RowsCounter falls back, labelled). */
export const DEFAULT_ROWS_ROUTE = process.env.WB_ROWS_ROUTE ?? "debug/sql-rows";

/**
 * Per-request timeout for rows reads. Local `wrangler dev` can park a proxied GET until the next request reaches its
 * ProxyWorker; aborting and retrying is that next request. The count is reported so a real server stall stays visible.
 */
export const ROWS_READ_TIMEOUT_MS = Number(process.env.WB_ROWS_TIMEOUT_MS ?? 10_000);

export async function fetchRows(url: string, init: RequestInit, onTimeout: () => void, timeoutMs = ROWS_READ_TIMEOUT_MS): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		try {
			const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
			const body = await r.arrayBuffer();
			return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
		} catch (error) {
			const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			if (!timedOut || attempt >= 3) throw error;
			onTimeout();
			log(`rows read timed out after ${timeoutMs} ms (attempt ${attempt}); retrying ${new URL(url).pathname}`);
		}
	}
}

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
	timeouts = 0;
	private pendingTimeouts = 0;
	private readonly countTimeout = () => { this.timeouts++; this.pendingTimeouts++; };

	private async viaRoute(): Promise<RowsReading | null> {
		const id = this.context.devices.A!;
		const url = vaultRoute(id, this.route);
		const tries: Array<() => Promise<Response>> = [
			() => fetchRows(url, { headers: { cookie: this.context.operatorCookie } }, this.countTimeout),
			() => fetchRows(url, { headers: deviceBearerHeaders(id) }, this.countTimeout),
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
		const r = await fetchRows(vaultRoute(id, "diagnostics"), { headers: deviceBearerHeaders(id) }, this.countTimeout).catch(() => null);
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
		if (this.pendingTimeouts > 0) { reading.timeouts = this.pendingTimeouts; this.pendingTimeouts = 0; }
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
export type ItemOutcome = "created" | "exists-identical" | "exists-different" | "rejected" | "error";
export interface CreateResult {
	adapter: string;
	outcomes: Array<{ path: string; outcome: ItemOutcome; detail?: string }>;
	requests: number; wallMs: number;
}

/** Today's production import path (VaultSync.commitFreshBodies via lib/context.seedNotes, 32 notes per call). */
export async function legacyCreate(context: Context, items: readonly NoteInput[]): Promise<CreateResult> {
	const t0 = now();
	const result: CreateResult = { adapter: "legacy", outcomes: [], requests: 0, wallMs: 0 };
	try {
		const r = await seedNotes(context, items.map((i) => ({ bodyId: i.bodyId, path: i.path, content: i.content })), 64 * 1024 * 1024);
		result.requests = r.requests;
		for (const i of items) result.outcomes.push({ path: i.path, outcome: "created" });
	} catch (error) {
		const detail = String(error).slice(0, 300);
		for (const i of items) result.outcomes.push({ path: i.path, outcome: "error", detail });
	}
	result.wallMs = r2(now() - t0);
	return result;
}

/** W2 bulk create route of the write-budget spike. Not on relay v3 (owned by the b3-bulk work). */
export const BULK_ROUTE = process.env.WB_BULK_ROUTE ?? "lifecycle/create-bulk";
/**
 * Does the server expose the bulk create route? An empty POST: 404 = absent (the Worker allowlist answers 404 for
 * unknown vault routes); anything else (400/409/415/…) = present.
 */
export async function bulkCreateAvailable(identity: LiveIdentity): Promise<{ available: boolean; status: number }> {
	const r = await fetch(vaultRoute(identity, BULK_ROUTE), { method: "POST",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/octet-stream" }), body: new Uint8Array(0) });
	await r.arrayBuffer().catch(() => null);
	return { available: r.status !== 404, status: r.status };
}

/** Split by caps (≤ maxFiles, ≤ maxBytes); an item larger than maxBytes travels alone. */
export function splitBatches<T>(items: readonly T[], maxFiles: number, maxBytes: number, size: (i: T) => number): T[][] {
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
export interface BulkBatch { index: number; files: number; httpStatus: number | null; ms: number; error?: string }
/**
 * Notes-only bulk create in the write-budget spike's W2 wire format (binary envelope
 * { batchId, rootEpoch, files: [{ operationId, bodyId, path, updates }], attachments: [] } → { outcomes: [...] }).
 * Only used by DL when `bulkCreateAvailable` says the route exists; if a later branch changes the wire format, this
 * adapter must follow it.
 */
export async function bulkCreate(context: Context, items: readonly NoteInput[], options: { device?: string; maxFiles?: number; maxBytes?: number;
	afterBatch?: (b: BulkBatch) => Promise<void> } = {}): Promise<CreateResult & { batches: BulkBatch[] }> {
	const identity = context.devices[options.device ?? "A"]!;
	const t0 = now();
	const result: CreateResult & { batches: BulkBatch[] } = { adapter: "bulk", outcomes: [], requests: 0, wallMs: 0, batches: [] };
	const frames = new Map(items.map((i) => [i, bodyFrames(i.content)] as const));
	const sizeOf = (i: NoteInput) => frames.get(i)!.reduce((s, f) => s + f.byteLength, 0);
	let rootEpoch = await currentRootEpoch(identity); result.requests++;
	for (const batch of splitBatches(items, options.maxFiles ?? 500, options.maxBytes ?? 4 * 1024 * 1024, sizeOf)) {
		const s0 = now();
		const opOf = new Map<string, NoteInput>();
		const files = batch.map((i) => { const operationId = `wb-file-${crypto.randomUUID()}`; opOf.set(operationId, i);
			return { operationId, bodyId: i.bodyId, path: i.path, updates: frames.get(i)! }; });
		const batchId = `wb-${crypto.randomUUID()}`;
		const send = () => fetch(vaultRoute(identity, BULK_ROUTE), { method: "POST",
			headers: deviceBearerHeaders(identity, { "Content-Type": YAOS_BINARY_CONTENT_TYPE }),
			body: encodeBinaryEnvelope({ batchId, rootEpoch, files, attachments: [] }) });
		let r = await send(); result.requests++;
		const read = async () => r.headers.get("content-type")?.includes(YAOS_BINARY_CONTENT_TYPE)
			? decodeBinaryEnvelope(new Uint8Array(await r.arrayBuffer())) as Obj : await json(r);
		let body = await read();
		if (r.status === 409 && /epoch/i.test(String(body?.error ?? body?.code ?? ""))) { // root epoch moved: re-read, retry once
			rootEpoch = await currentRootEpoch(identity);
			r = await send(); result.requests += 2; body = await read();
		}
		const b: BulkBatch = { index: result.batches.length, files: batch.length, httpStatus: r.status, ms: r2(now() - s0),
			...(r.ok ? {} : { error: `${r.status} ${String(body?.error ?? "").slice(0, 200)}` }) };
		const list = (r.ok ? body?.outcomes : undefined) as Obj[] | undefined;
		const byOp = new Map((Array.isArray(list) ? list : []).map((x) => [String(x.operationId ?? ""), x]));
		const known: ItemOutcome[] = ["created", "exists-identical", "exists-different", "rejected"];
		for (const [op, i] of opOf) {
			const x = byOp.get(op);
			const o = String(x?.outcome ?? "") as ItemOutcome;
			result.outcomes.push(known.includes(o) ? { path: i.path, outcome: o, ...(x?.reason ? { detail: String(x.reason) } : {}) }
				: { path: i.path, outcome: "error", detail: r.ok ? `missing outcome for ${op}` : `${r.status} ${String(body?.error ?? "")}` });
		}
		result.batches.push(b);
		await options.afterBatch?.(b);
	}
	result.wallMs = r2(now() - t0);
	return result;
}

// =================================================================================================== catalog
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

// =================================================================================================== closed-file candidate
/**
 * Closed-file HTTP candidate (the real client's VaultServerPort.submitCandidate, src/sync/vaultSync.ts): one Yjs update
 * as `application/octet-stream` to `POST body/:bodyId/candidate` with x-yaos-body-epoch / x-yaos-candidate-id /
 * x-yaos-candidate-digest. A single frame's digest is SHA-256(frame) (server/src/shared/candidateDigest.ts).
 * 200 → DurableReceipt; daily limit → typed 503 `cf_daily_limit` (see DL).
 */
export function candidateRequest(bodyId: string, bodyEpoch: number, update: Uint8Array, candidateId: string) {
	return {
		path: `body/${encodeURIComponent(bodyId)}/candidate`,
		headers: { "content-type": "application/octet-stream", "x-yaos-body-epoch": String(bodyEpoch),
			"x-yaos-candidate-id": candidateId, "x-yaos-candidate-digest": sha256(update) },
		body: update,
	};
}
export interface CandidatePost { status: number; ms: number; reqBytes: number; retryAfter: string | null; value: Obj | null }
export async function postCandidate(identity: LiveIdentity, bodyId: string, bodyEpoch: number, update: Uint8Array, candidateId: string): Promise<CandidatePost> {
	const req = candidateRequest(bodyId, bodyEpoch, update, candidateId);
	const t0 = now();
	const r = await fetch(vaultRoute(identity, req.path), { method: "POST", headers: { ...deviceBearerHeaders(identity), ...req.headers }, body: req.body });
	const value = await json(r).catch(() => null) as Obj | null;
	return { status: r.status, ms: r2(now() - t0), reqBytes: update.byteLength, retryAfter: r.headers.get("retry-after"), value };
}
/** GET body → { doc, epoch } (the epoch a candidate must carry). */
export async function bodyDocWithEpoch(identity: LiveIdentity, bodyId: string): Promise<{ doc: Y.Doc; epoch: number; status: number }> {
	const r = await fetch(vaultRoute(identity, `body/${encodeURIComponent(bodyId)}`), { headers: deviceBearerHeaders(identity) });
	const bytes = new Uint8Array(await r.arrayBuffer());
	const doc = new Y.Doc();
	if (r.ok) Y.applyUpdate(doc, bytes);
	return { doc, epoch: Number(r.headers.get("x-yaos-body-epoch")), status: r.status };
}

// =================================================================================================== merge (R1)
export interface MergeAdapter {
	name: string; source: "product-module" | "harness-reference";
	merge(base: string, ours: string, theirs: string): MergeResult | Promise<MergeResult>;
	noBase(ours: string, theirs: string): NoBaseResult | Promise<NoBaseResult>;
}
function normalizeMerge(v: unknown): MergeResult {
	const o = (v ?? {}) as Obj;
	const kind = String(o.kind ?? o.status ?? o.outcome ?? "");
	if (o.conflict === true || kind === "conflict" || kind === "conflict-copy" || kind === "too-large") return { kind: "conflict", reason: String(o.reason ?? kind) };
	const text = (o.text ?? o.content ?? o.merged ?? o.result) as unknown; // mergeThreeWayLines → {kind:"clean", content}
	if (typeof text === "string") return { kind: "clean", text };
	if (typeof v === "string") return { kind: "clean", text: v };
	return { kind: "conflict", reason: `unrecognised merge result ${JSON.stringify(v).slice(0, 80)}` };
}
/**
 * `--merge-module src/sync/lineMerge.ts` (or WB_MERGE_MODULE) exports mergeThreeWayLines(base, disk, body) →
 * ThreeWayMergeResult {kind: clean(content) | conflict | too-large}. The product has no separate no-base function
 * (no-base is identical → settle, else conflict artifact, in the closed-file planner), so noBase falls back to the
 * reference rule (same policy). The product merges adjacent-line edits cleanly; the reference conflicts ("either").
 */
export async function mergeAdapter(modulePath?: string): Promise<MergeAdapter> {
	const path = modulePath ?? process.env.WB_MERGE_MODULE;
	if (!path) return { name: "reference-diff3", source: "harness-reference", merge: merge3, noBase: mergeNoBase };
	const m = await import(pathToFileURL(path).href) as Obj;
	const fn = (m.mergeThreeWayLines ?? m.merge3 ?? m.threeWayMerge ?? m.diff3Merge ?? m.mergeLines ?? m.default) as ((...a: string[]) => unknown) | undefined;
	if (typeof fn !== "function") throw new Error(`merge module ${path} has no mergeThreeWayLines/merge3/threeWayMerge/diff3Merge/mergeLines export`);
	const nb = (m.mergeNoBase ?? m.reconcileNoBase) as ((a: string, b: string) => unknown) | undefined;
	return { name: `module:${path}`, source: "product-module",
		merge: async (b, o, t) => normalizeMerge(await fn(b, o, t)),
		noBase: async (o, t) => {
			if (typeof nb !== "function") return mergeNoBase(o, t);
			const v = (await nb(o, t)) as Obj;
			return v?.kind === "skip" || v?.skip === true ? { kind: "skip" } : { kind: "conflict", reason: String(v?.reason ?? "conflict") };
		} };
}
