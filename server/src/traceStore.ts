const TRACE_KEY_PREFIX = "trace:";
const TRACE_ELLIPSIS = "...";

/**
 * Second, disjoint key space for events that arrive at sync-message rate.
 *
 * With a single ring the noisiest class evicts every other: measured on a live
 * vault after ~6,000 edits, 98 of the 100 entries the debug endpoint returned
 * were `server.ydoc.update_observed`, and every save, compaction, cold-load and
 * tombstone-reap event had been evicted within seconds.  The only diagnostic
 * surface the room has was empty of diagnostics exactly when the room was busy.
 *
 * Two prefixes trim independently, so neither class can crowd out the other.
 * "tracehot:" is deliberately NOT nested under "trace:", so a `list` of either
 * prefix cannot see the other's keys.
 */
const TRACE_HIGH_VOLUME_KEY_PREFIX = "tracehot:";

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
 * The default budget is 600 events per 60 seconds. Constructor parameters let
 * tests and the Durable Object tighten it for a workload.
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
		while (this.admitted.length > 0 && this.admitted[0]! < cutoff) {
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

/**
 * Events recorded once per inbound sync message, so they outnumber every other
 * event by orders of magnitude.
 *
 * Membership buys an entry its own storage budget, not a lower priority:
 * nothing here is sampled or dropped.  Add an event when its rate is tied to
 * client traffic rather than to a persistence decision — per-save events
 * (`server.save.*`) fire once per flush and belong with the diagnostics.
 */
export const HIGH_VOLUME_TRACE_EVENTS: Record<string, true> = {
	"server.ydoc.update_observed": true,
};

export function isHighVolumeTraceEvent(event: string): boolean {
	return HIGH_VOLUME_TRACE_EVENTS[event] === true;
}

/**
 * Share of a debug read reserved for low-volume events when both classes hold
 * more than the window can show.
 *
 * Separate retention alone does not make rare events visible: during a flood
 * the newest N timestamps in the room are all high-volume, so a strict
 * newest-N-overall merge would still return nothing but `update_observed`.
 * Unused reserve is handed back to the other class, so a quiet room still
 * fills the window with whatever it has.
 */
export const LOW_VOLUME_TRACE_READ_RESERVE = 0.5;

/**
 * Appends a ring tolerates before it reconciles with storage.
 *
 * Seeding costs one `list` over the whole prefix, so doing it on the first
 * append charges every short-lived instance ~maxEntries rows read.  That is the
 * common case: a hibernating room wakes, writes a checkpoint-load trace or two,
 * and is evicted again — measured at ~200 of the ~344 rows a single wake of a
 * real room cost.  Amortising over appends does nothing for an instance that
 * only ever makes two.
 *
 * Deferring instead means an instance that appends fewer than this never lists
 * at all, and a busy one pays ~maxEntries rows per this many appends.  The
 * price is bounded overshoot: a prefix holds at most maxEntries + this many
 * entries between reconciliations, which does not affect reads because
 * listRecentTraceEntries asks for the newest N regardless.
 */
export const TRACE_SEED_AFTER_APPENDS = 200;

/**
 * Append-and-trim ring over one key prefix.
 *
 * WHY THIS IS A CLASS AND NOT A FUNCTION
 *
 * The obvious implementation — put the entry, then list the prefix to find what
 * to evict — costs one `list` per trace.  On a SQLite-backed Durable Object the
 * KV API is billed as SQL rows, and a `list` with `limit: maxEntries + 1` reads
 * up to that many rows.  At maxEntries = 200 that is ~201 rows read for every
 * ~2 rows written, and since a trace is recorded per inbound sync message it
 * dominated the room's entire storage profile.
 *
 * Measured in production, 300 update messages against one room:
 *
 *   rowsRead 43,696   rowsWritten 455   ratio 96.0
 *   => 143 rows read per trace (below 201 only because the ring was filling)
 *
 * That ratio held at 80-101 across every day of a 30-day window on two
 * separate vaults, and was the entire read-amplification story: the journal
 * COUNT/SUM in the doc store accounts for barely a tenth of it.
 *
 * Keeping the key list in memory removes the per-trace `list` entirely.  One
 * `list` seeds the ring per Durable Object instance, and eviction then deletes
 * known keys directly.
 */
class TracePrefixRing {
	/** Stored keys, oldest first.  null until seeded from storage. */
	private keys: string[] | null = null;
	/** Appends made by this instance while unseeded, or since the last re-seed. */
	private appendsSinceSeed = 0;

	private readonly seedAfterAppends: number;

	/**
	 * @param seedAfterAppends appends tolerated before reconciling with storage.
	 *   Defaults to TRACE_SEED_AFTER_APPENDS.  Pass 1 to reconcile on every
	 *   append, which is what the stateless helper needs to keep its exact
	 *   retention semantics.
	 */
	constructor(
		private readonly prefix: string,
		private readonly maxEntries: number,
		seedAfterAppends = TRACE_SEED_AFTER_APPENDS,
	) {
		this.seedAfterAppends = Math.max(1, seedAfterAppends);
	}

	async append(storage: TraceStorageLike, entry: TraceEntry): Promise<void> {
		const traceTs = Date.parse(entry.ts);
		const ts = Number.isFinite(traceTs) ? traceTs : Date.now();
		const key = `${this.prefix}${paddedTimestamp(ts)}:${randomSuffix()}`;
		await storage.put(key, entry);
		if (this.maxEntries <= 0) return;

		this.appendsSinceSeed++;

		// Held in a local: `this.keys` is a mutable field, so TypeScript discards
		// any narrowing across the awaits below.
		const cached = this.keys;
		if (cached !== null && this.appendsSinceSeed < this.seedAfterAppends) {
			cached.push(key);
			const excess = cached.length - this.maxEntries;
			if (excess <= 0) return;
			await storage.delete(cached.splice(0, excess));
			return;
		}
		if (cached === null && this.appendsSinceSeed < this.seedAfterAppends) {
			// Unseeded and still within the tolerated overshoot: skip the list
			// entirely.  Most instances never get past this branch.
			return;
		}

		// Reconcile with storage.  Listed AFTER the put, so `key` is included.
		const stored = await storage.list<TraceEntry>({ prefix: this.prefix });
		const keys = Array.from(stored.keys());
		this.appendsSinceSeed = 0;
		this.keys = keys;

		const excess = keys.length - this.maxEntries;
		if (excess <= 0) return;
		await storage.delete(keys.splice(0, excess));
	}
}

/**
 * One ring per event class, so a flood of high-volume events cannot evict the
 * rare ones that are actually diagnostic.
 *
 * Each class gets the full `maxEntriesPerClass` budget rather than a slice of a
 * shared one: retention depth costs nothing in rows written (a trimmed entry is
 * deleted either way) and reads are capped by `limit`, not by what is stored.
 *
 * Stored entries stay bounded at 2 * (maxEntriesPerClass +
 * TRACE_SEED_AFTER_APPENDS) — 800 at the server's cap of 200 — because each
 * prefix trims to its own budget plus one reconciliation window of overshoot.
 */
export class TraceRing {
	private readonly highVolume: TracePrefixRing;
	private readonly lowVolume: TracePrefixRing;

	constructor(maxEntriesPerClass: number) {
		this.highVolume = new TracePrefixRing(TRACE_HIGH_VOLUME_KEY_PREFIX, maxEntriesPerClass);
		this.lowVolume = new TracePrefixRing(TRACE_KEY_PREFIX, maxEntriesPerClass);
	}

	async append(storage: TraceStorageLike, entry: TraceEntry): Promise<void> {
		const ring = isHighVolumeTraceEvent(entry.event) ? this.highVolume : this.lowVolume;
		await ring.append(storage, entry);
	}
}

/**
 * Stateless append.  Equivalent to a single-use ring over the low-volume
 * prefix, so it still pays one `list` per call and keeps exact retention —
 * retained for callers that have nowhere to keep state, and for tests that
 * assert retention semantics directly.  Long-lived callers should hold a
 * TraceRing instead; see the note on TracePrefixRing.
 */
export async function appendTraceEntry(
	storage: TraceStorageLike,
	entry: TraceEntry,
	maxEntries: number,
): Promise<void> {
	await new TracePrefixRing(TRACE_KEY_PREFIX, maxEntries, 1).append(storage, entry);
}

interface TraceRow {
	/** Key without its class prefix: `<paddedTs>:<rand>`, comparable across classes. */
	suffix: string;
	entry: TraceEntry;
}

async function listNewestByPrefix(
	storage: TraceStorageLike,
	prefix: string,
	limit: number,
): Promise<TraceRow[]> {
	const listed = await storage.list<TraceEntry>({ prefix, reverse: true, limit });
	return Array.from(listed, ([key, entry]) => ({ suffix: key.slice(prefix.length), entry }));
}

/**
 * Newest `limit` entries, newest first, merged across both event classes with
 * up to LOW_VOLUME_TRACE_READ_RESERVE of the window held for rare events.
 *
 * Costs two lists of `limit` rows.  This runs on a manual debug request, never
 * on the sync path.
 */
export async function listRecentTraceEntries(
	storage: TraceStorageLike,
	limit: number,
): Promise<TraceEntry[]> {
	if (limit <= 0) return [];
	const [lowVolume, highVolume] = await Promise.all([
		listNewestByPrefix(storage, TRACE_KEY_PREFIX, limit),
		listNewestByPrefix(storage, TRACE_HIGH_VOLUME_KEY_PREFIX, limit),
	]);
	const reserved = Math.ceil(limit * LOW_VOLUME_TRACE_READ_RESERVE);
	const lowTake = Math.min(lowVolume.length, Math.max(reserved, limit - highVolume.length));
	const highTake = Math.min(highVolume.length, limit - lowTake);
	const merged = [...lowVolume.slice(0, lowTake), ...highVolume.slice(0, highTake)];
	// Both key spaces share the `<paddedTs>:<rand>` suffix, so suffix order is
	// timestamp order across classes — the same ordering a single reverse list
	// gave before the split.
	merged.sort((a, b) => (a.suffix < b.suffix ? 1 : a.suffix > b.suffix ? -1 : 0));
	return merged.map((row) => row.entry);
}
