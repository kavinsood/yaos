// Residency (DESIGN §d.1): clean handles are evicted when a load or applied rows push the device over its byte
// budget, not only at the next maintenance tick (sim invariant 6 "evictable docs resident over budget").
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocId, VaultPath } from "../../core/types";
import { VirtualClock } from "../../sim/clock";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { drive, startTestEngine, until, createDoc, editDoc } from "./testHarness";
import { EvictedHandleError, evictedHandleUses, type HandleHooks } from "../body/handles";

const BUDGETS = { maxResidentDocs: 16, maxResidentBytes: 8 * 1024 };
/** No maintenance tick in the test's horizon: only the load / apply path can evict. */
const NO_TICKS = { maintenanceMs: 1e9, maintenanceIdleMaxMs: 1e9 };
const BIG = "x".repeat(6 * 1024); // 3 x 6 KiB of replica estimate: alone past the budget

async function pair(clock: VirtualClock) {
	const relay = new SimRelay({ clock });
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", clock });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", clock, tuning: NO_TICKS, extra: { budgets: BUDGETS } });
	await until(() => a.status().phase === "live" && b.status().phase === "live", 5_000, "live", clock);
	return { a, b };
}

async function caughtUp(clock: VirtualClock, a: LogEngine, b: LogEngine, ids: readonly DocId[]): Promise<void> {
	await until(() => a.isIdle() && a.c.outbox.size === 0, 10_000, "a receipted", clock);
	const want = ids.map((id) => a.bodyInfo(id)?.version.remoteSeq ?? 0);
	await until(() => b.isIdle() && ids.every((id, i) => (b.bodyInfo(id)?.version.remoteSeq ?? 0) >= want[i]!), 10_000, "b caught up", clock);
}

/** A clean resident replica on b: bound, then unbound (unbind keeps it, it fits the budget). */
async function residentClean(clock: VirtualClock, b: LogEngine, id: DocId): Promise<void> {
	await drive(b.bind(id), clock);
	b.unbind(id);
	const h = b.c.handles.peek(b.streamOf(id));
	assert.ok(h && b.c.handles.isClean(h), "clean and resident");
}

test("residency: a load past the byte budget evicts the clean replicas it pushed over, not itself", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const { a, b } = await pair(clock);
	try {
		const small = await drive(createDoc(a, "small.md" as VaultPath, "small\n"), clock);
		const big = await drive(createDoc(a, "big.md" as VaultPath, BIG), clock);
		await caughtUp(clock, a, b, [small, big]);
		await residentClean(clock, b, small);
		await drive(b.bind(big), clock);
		const hs = b.c.handles;
		assert.ok(hs.isResident(b.streamOf(big)), "the loaded doc stays (bound, over budget: DESIGN §d.1)");
		assert.ok(hs.bytes > BUDGETS.maxResidentBytes, "over budget");
		assert.equal(hs.isResident(b.streamOf(small)), false, "the clean replica is evicted at the load");
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});

test("residency: rows that grow a clean replica past the byte budget evict it", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const { a, b } = await pair(clock);
	try {
		const id = await drive(createDoc(a, "note.md" as VaultPath, "note\n"), clock);
		await caughtUp(clock, a, b, [id]);
		await residentClean(clock, b, id);
		await drive(editDoc(a, id, (t) => t.insert(t.length, BIG)), clock);
		await caughtUp(clock, a, b, [id]);
		assert.equal(b.c.handles.isResident(b.streamOf(id)), false, "evicted once the rows grew it past the budget");
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});

test("residency: acquire returns a pinned, resident handle even when an eviction runs before its caller resumes", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const { a, b } = await pair(clock);
	try {
		const id = await drive(createDoc(a, "note.md" as VaultPath, "note\n"), clock);
		await caughtUp(clock, a, b, [id]);
		const hs = b.c.handles;
		const stream = b.streamOf(id);
		assert.equal(hs.isResident(stream), false);
		// The first load is evicted in the microtask after it registers, before acquire's continuation runs.
		const hooks = (hs as unknown as { hooks: HandleHooks }).hooks;
		const onLoaded = hooks.onLoaded.bind(hooks);
		let once = true;
		hooks.onLoaded = (h) => {
			onLoaded(h);
			if (once) queueMicrotask(() => hs.evictAllClean());
			once = false;
		};
		const loads = hs.loads;
		const h = await drive(hs.acquire(stream), clock);
		assert.equal(hs.loads, loads + 2, "loaded again after the eviction");
		assert.equal(hs.peek(stream), h, "the handle returned is the resident one");
		assert.equal(h.pins, 1);
		hs.unpin(h);
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});

test("residency: the debug guard throws (and records) when an evicted handle is used", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const { a, b } = await pair(clock);
	try {
		const id = await drive(createDoc(a, "note.md" as VaultPath, "note\n"), clock);
		await caughtUp(clock, a, b, [id]);
		await residentClean(clock, b, id);
		const hs = b.c.handles;
		const h = hs.peek(b.streamOf(id))!;
		void h.doc.getText("text").length; // resident: usable
		const n = evictedHandleUses.length;
		assert.equal(hs.evictAllClean(), 1);
		assert.throws(() => h.doc, EvictedHandleError);
		assert.throws(() => hs.grow(h, 1), EvictedHandleError);
		assert.equal(evictedHandleUses.length, n + 2, "recorded for the sim");
		evictedHandleUses.length = n;
	} finally {
		await drive(a.stop(), clock);
		await drive(b.stop(), clock);
	}
});
