const TRACE_KEY_PREFIX = "trace:";
const TRACE_ELLIPSIS = "...";

export const MAX_TRACE_ENTRY_BYTES = 16 * 1024;
const MAX_TRACE_STRING_BYTES = 2048;
const MAX_TRACE_ARRAY_ITEMS = 20;
const MAX_TRACE_OBJECT_KEYS = 20;
const MAX_TRACE_DEPTH = 4;

/**
 * INV-OBS-02: bounded per-room trace budget. Pathological clients (or hot
 * loops) emitting traces faster than this rate are dropped. Drops are
 * counted and surfaced via a single throttled summary entry the next time
 * an admit succeeds, so the loss is observable but does not itself cause
 * unbounded writes.
 *
 * The default budget (600 events / 60s) is the draft target named in
 * sync-invariants.md and tightenable per workload. Constructor allows
 * tests and DO code to override.
 */
export const DEFAULT_TRACE_RATE_LIMIT_PER_WINDOW = 600;
export const DEFAULT_TRACE_RATE_WINDOW_MS = 60_000;
export const TRACE_RATE_THROTTLE_EVENT = "trace-throttled";

export class TraceRateLimiter {
	private readonly admitted: number[] = [];
	private dropped = 0;

	constructor(
		private readonly maxPerWindow: number = DEFAULT_TRACE_RATE_LIMIT_PER_WINDOW,
		private readonly windowMs: number = DEFAULT_TRACE_RATE_WINDOW_MS,
	) {}

	/**
	 * Try to admit a trace event. Returns true if admitted (caller should
	 * proceed to write); false if dropped (caller should not write).
	 */
	admit(now: number = Date.now()): boolean {
		this.compactWindow(now);
		if (this.admitted.length >= this.maxPerWindow) {
			this.dropped++;
			return false;
		}
		this.admitted.push(now);
		return true;
	}

	/**
	 * Returns the drop count accumulated since the last drain and resets
	 * it to zero. Callers use this to decide whether to emit a single
	 * throttled-summary entry.
	 */
	drainDropped(): number {
		const value = this.dropped;
		this.dropped = 0;
		return value;
	}

	private compactWindow(now: number): void {
		const cutoff = now - this.windowMs;
		// Sliding window is small (bounded by maxPerWindow); shift is fine.
		while (this.admitted.length > 0 && this.admitted[0] < cutoff) {
			this.admitted.shift();
		}
	}
}

export interface TraceEntry {
	ts: string;
	event: string;
	roomId: string;
	[key: string]: unknown;
}

interface TraceStorageLike {
	list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
	put<T>(key: string, value: T): Promise<void>;
	delete(keys: string[]): Promise<number>;
}

function paddedTimestamp(tsMs: number): string {
	return String(tsMs).padStart(13, "0");
}

function randomSuffix(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function jsonByteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	if (encoder.encode(value).byteLength <= maxBytes) {
		return value;
	}
	const ellipsisBytes = encoder.encode(TRACE_ELLIPSIS).byteLength;
	if (ellipsisBytes >= maxBytes) {
		return decoder.decode(encoder.encode(value).slice(0, maxBytes));
	}

	let low = 0;
	let high = value.length;
	let best = "";
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = `${value.slice(0, mid)}${TRACE_ELLIPSIS}`;
		if (encoder.encode(candidate).byteLength <= maxBytes) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best || TRACE_ELLIPSIS;
}

function normalizeTraceValue(value: unknown, depth = 0): unknown {
	if (value === null) return null;
	if (typeof value === "string") {
		return truncateUtf8(value, MAX_TRACE_STRING_BYTES);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : String(value);
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (depth >= MAX_TRACE_DEPTH) {
		return "[trace-depth-truncated]";
	}
	if (Array.isArray(value)) {
		const normalized = value
			.slice(0, MAX_TRACE_ARRAY_ITEMS)
			.map((item) => normalizeTraceValue(item, depth + 1));
		if (value.length > MAX_TRACE_ARRAY_ITEMS) {
			normalized.push(`[+${value.length - MAX_TRACE_ARRAY_ITEMS} more items]`);
		}
		return normalized;
	}
	if (value instanceof Uint8Array) {
		return {
			type: "Uint8Array",
			byteLength: value.byteLength,
		};
	}
	if (ArrayBuffer.isView(value)) {
		return {
			type: value.constructor?.name ?? "ArrayBufferView",
			byteLength: value.byteLength,
		};
	}
	if (value instanceof ArrayBuffer) {
		return {
			type: "ArrayBuffer",
			byteLength: value.byteLength,
		};
	}
	if (typeof value === "object") {
		const normalized: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>);
		for (const [key, nested] of entries.slice(0, MAX_TRACE_OBJECT_KEYS)) {
			normalized[key] = normalizeTraceValue(nested, depth + 1);
		}
		if (entries.length > MAX_TRACE_OBJECT_KEYS) {
			normalized.__truncatedKeys = entries.length - MAX_TRACE_OBJECT_KEYS;
		}
		return normalized;
	}
	if (typeof value === "string") {
		return truncateUtf8(value, MAX_TRACE_STRING_BYTES);
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return value;
	}
	if (typeof value === "symbol") {
		return truncateUtf8(value.description ?? "symbol", MAX_TRACE_STRING_BYTES);
	}
	return null;
}

export function prepareTraceEntryForStorage(entry: TraceEntry): TraceEntry {
	const core: TraceEntry = {
		ts: truncateUtf8(entry.ts, 128),
		event: truncateUtf8(entry.event, 256),
		roomId: truncateUtf8(entry.roomId, 256),
	};
	let truncated = core.ts !== entry.ts || core.event !== entry.event || core.roomId !== entry.roomId;

	for (const [key, value] of Object.entries(entry)) {
		if (key === "ts" || key === "event" || key === "roomId") continue;
		const normalized = normalizeTraceValue(value);
		core[key] = normalized;
		truncated ||= JSON.stringify(normalized) !== JSON.stringify(value);
	}
	if (truncated) {
		core.traceTruncated = true;
	}

	if (jsonByteLength(core) <= MAX_TRACE_ENTRY_BYTES) {
		return core;
	}

	const metadata: TraceEntry = {
		ts: core.ts,
		event: core.event,
		roomId: core.roomId,
		traceTruncated: true,
		traceOriginalKeys: truncateUtf8(
			Object.keys(entry)
				.filter((key) => key !== "ts" && key !== "event" && key !== "roomId")
				.join(","),
			1024,
		),
	};
	if (jsonByteLength(metadata) <= MAX_TRACE_ENTRY_BYTES) {
		return metadata;
	}

	return {
		ts: core.ts,
		event: truncateUtf8(core.event, 64),
		roomId: truncateUtf8(core.roomId, 64),
		traceTruncated: true,
	};
}

export function createTraceKey(ts = Date.now()): string {
	return `${TRACE_KEY_PREFIX}${paddedTimestamp(ts)}:${randomSuffix()}`;
}

export async function appendTraceEntry(
	storage: TraceStorageLike,
	entry: TraceEntry,
	maxEntries: number,
): Promise<void> {
	const traceTs = Date.parse(entry.ts);
	await storage.put(createTraceKey(Number.isFinite(traceTs) ? traceTs : Date.now()), entry);
	if (maxEntries <= 0) return;

	const recent = await storage.list<TraceEntry>({
		prefix: TRACE_KEY_PREFIX,
		reverse: true,
		limit: maxEntries + 1,
	});
	if (recent.size <= maxEntries) return;

	const keys = Array.from(recent.keys());
	const cutoffKey = keys.at(-1);
	if (!cutoffKey) return;

	const older = await storage.list<TraceEntry>({
		prefix: TRACE_KEY_PREFIX,
		end: cutoffKey,
	});
	const deleteKeys = [...older.keys(), cutoffKey];
	if (deleteKeys.length > 0) {
		await storage.delete(deleteKeys);
	}
}

export async function listRecentTraceEntries(
	storage: TraceStorageLike,
	limit: number,
): Promise<TraceEntry[]> {
	if (limit <= 0) return [];
	const recent = await storage.list<TraceEntry>({
		prefix: TRACE_KEY_PREFIX,
		reverse: true,
		limit,
	});
	return Array.from(recent.values());
}
