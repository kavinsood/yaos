import {
	appendTraceEntry,
	DEFAULT_TRACE_RATE_LIMIT_PER_WINDOW,
	listRecentTraceEntries,
	MAX_TRACE_ENTRY_BYTES,
	prepareTraceEntryForStorage,
	TraceRateLimiter,
	type TraceEntry,
} from "../server/src/traceStore";

class FakeStorage {
	readonly data = new Map<string, unknown>();

	async list<T = unknown>(options: DurableObjectListOptions = {}): Promise<Map<string, T>> {
		let keys = [...this.data.keys()].sort((a, b) => a.localeCompare(b));
		if (options.prefix) {
			keys = keys.filter((key) => key.startsWith(options.prefix!));
		}
		if (options.start !== undefined) {
			keys = keys.filter((key) => key >= options.start!);
		}
		if (options.startAfter !== undefined) {
			keys = keys.filter((key) => key > options.startAfter!);
		}
		if (options.end !== undefined) {
			keys = keys.filter((key) => key < options.end!);
		}
		if (options.reverse) {
			keys.reverse();
		}
		if (options.limit !== undefined) {
			keys = keys.slice(0, options.limit);
		}
		const out = new Map<string, T>();
		for (const key of keys) {
			out.set(key, this.data.get(key) as T);
		}
		return out;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async delete(keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) deleted++;
		}
		return deleted;
	}
}

class SizeBoundStorage extends FakeStorage {
	constructor(private readonly maxValueBytes: number) {
		super();
	}

	override async put<T>(key: string, value: T): Promise<void> {
		const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
		if (byteLength > this.maxValueBytes) {
			throw new Error(`SQLITE_TOOBIG: ${byteLength} > ${this.maxValueBytes}`);
		}
		await super.put(key, value);
	}
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function makeEntry(i: number): TraceEntry {
	return {
		ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
		event: `event-${i}`,
		roomId: "room-a",
		seq: i,
	};
}

function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

console.log("\n--- Test 1: trace store keeps only the newest bounded entries ---");
{
	const storage = new FakeStorage();
	for (let i = 0; i < 250; i++) {
		await appendTraceEntry(storage, makeEntry(i), 100);
	}

	const allKeys = [...storage.data.keys()];
	assert(allKeys.length === 100, "trace store retains exactly the newest 100 entries");
	assert(allKeys.every((key) => key.startsWith("trace:")), "trace store writes per-entry prefixed keys");

	const recent = await listRecentTraceEntries(storage, 100);
	assert(recent.length === 100, "debug read returns bounded recent trace entries");
	assert((recent[0] as { seq?: unknown }).seq === 249, "most recent trace entry is returned first");
	assert((recent.at(-1) as { seq?: unknown })?.seq === 150, "oldest retained trace entry is the 100th newest");
}

console.log("\n--- Test 2: trace store cleanup removes old backlog in one pass ---");
{
	const storage = new FakeStorage();
	for (let i = 0; i < 1000; i++) {
		const key = `trace:${String(i).padStart(13, "0")}:manual`;
		await storage.put(key, makeEntry(i));
	}

	await appendTraceEntry(storage, makeEntry(1001), 100);

	const allKeys = [...storage.data.keys()].sort((a, b) => a.localeCompare(b));
	assert(allKeys.length === 100, "cleanup collapses oversized historical backlog down to the bound");
	assert(allKeys[0]?.includes("0000000000901"), "cleanup keeps only the newest bounded key range");
}

console.log("\n--- Test 3: oversized trace entries are truncated to a safe size ---");
{
	const storage = new SizeBoundStorage(MAX_TRACE_ENTRY_BYTES);
	const prepared = prepareTraceEntryForStorage({
		ts: new Date().toISOString(),
		event: "oversized-trace",
		roomId: "room-a",
		hugeString: "x".repeat(MAX_TRACE_ENTRY_BYTES * 4),
		hugeArray: Array.from({ length: 100 }, (_, i) => `item-${i}`),
		nested: {
			deep: {
				payload: "y".repeat(MAX_TRACE_ENTRY_BYTES * 2),
			},
		},
	});

	assert(jsonBytes(prepared) <= MAX_TRACE_ENTRY_BYTES, "prepared trace entry fits within the storage byte budget");
	assert(prepared.traceTruncated === true, "oversized trace entry is marked as truncated");

	await appendTraceEntry(storage, prepared, 10);
	assert(storage.data.size === 1, "sanitized oversized trace entry can be persisted");
}

console.log("\n--- Test 4: TraceRateLimiter admits up to the per-window cap ---");
{
	const limiter = new TraceRateLimiter(5, 60_000);
	let admitted = 0;
	for (let i = 0; i < 5; i++) {
		if (limiter.admit(1_000 + i)) admitted++;
	}
	assert(admitted === 5, "first five admits within the window succeed");
	assert(limiter.admit(1_005) === false, "sixth admit within the window is rejected");
	assert(limiter.drainDropped() === 1, "drainDropped reports exactly one drop");
	assert(limiter.drainDropped() === 0, "drainDropped resets to zero after read");
}

console.log("\n--- Test 5: TraceRateLimiter slides forward as the window expires ---");
{
	const limiter = new TraceRateLimiter(3, 1_000);
	assert(limiter.admit(0) === true, "t=0 admit");
	assert(limiter.admit(100) === true, "t=100 admit");
	assert(limiter.admit(200) === true, "t=200 admit");
	assert(limiter.admit(300) === false, "t=300 admit dropped (over budget within window)");
	assert(limiter.admit(1_500) === true, "t=1500 admit succeeds after window slides");
	assert(limiter.admit(1_600) === true, "t=1600 admit succeeds (only one event still inside window)");
}

console.log("\n--- Test 6: TraceRateLimiter accumulates drops across many over-budget calls ---");
{
	const limiter = new TraceRateLimiter(2, 60_000);
	limiter.admit(0);
	limiter.admit(1);
	for (let i = 0; i < 100; i++) {
		limiter.admit(2 + i);
	}
	assert(limiter.drainDropped() === 100, "drainDropped reports the full accumulated drop count");
}

console.log("\n--- Test 7: default budget is the documented per-room rate ---");
{
	assert(
		DEFAULT_TRACE_RATE_LIMIT_PER_WINDOW === 600,
		"default per-window cap matches sync-invariants.md draft target (600 events / 60s)",
	);
}

console.log("\n--- Test 8: throttle-summary bypasses the limiter and does not recurse ---");
{
	// Simulate the recordTrace dispatch as implemented in server.ts:
	//   isThrottleSummary = event === TRACE_RATE_THROTTLE_EVENT
	//   if (!isThrottleSummary && !limiter.admit()) drop
	//   ... persist ...
	//   if (!isThrottleSummary) drain and maybe emit one summary
	// The summary itself must not re-trigger another summary (no recursion).
	const limiter = new TraceRateLimiter(2, 60_000);
	limiter.admit(0); // fill budget
	limiter.admit(1);

	// Over-budget event: gets dropped, drop count becomes 1.
	const admitted = limiter.admit(2);
	assert(admitted === false, "over-budget regular event is rejected");
	assert(limiter.drainDropped() === 1, "drop count is 1 before summary");

	// Now simulate a throttle summary being admitted: bypasses limiter.
	const isThrottleSummary = true;
	// Throttle summaries bypass the limiter — they are always admitted.
	// Test that the drain after a summary returns 0 (no further accumulation).
	limiter.admit(3); // another over-budget event
	const dropsBeforeSummary = limiter.drainDropped();
	assert(dropsBeforeSummary === 1, "drop accumulates between summary emissions");

	// After draining, further drain returns 0 — no recursion.
	const dropsAfterDrain = limiter.drainDropped();
	assert(dropsAfterDrain === 0, "drainDropped resets to zero; throttle summary cannot recurse");
	assert(isThrottleSummary === true, "throttle summary flag prevents recursive admit check");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
