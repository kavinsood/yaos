import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanScope } from "../../core/types";
import type { PassReport } from "../reconcile/reconciler";
import { FakeClock } from "../reconcile/testkit/fakes";
import { PassScheduler } from "./passScheduler";

function report(o: Partial<PassReport> = {}): PassReport {
	return {
		ok: 0, failed: 0, held: 0, deferred: 0, transferring: 0, skipped: 0, waits: 0, needHash: 0, nsSubmitted: 0, failedDocs: new Set(),
		planned: 0, actionable: 0, unread: 0, brake: null, openIntents: 0, ...o,
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function harness(reports: PassReport[], fullIdleMaxMs?: number) {
	const clock = new FakeClock();
	const scopes: PlanScope[] = [];
	const s = new PassScheduler({
		clock, ready: () => true, nextBlobDueInMs: () => null, fullIntervalMs: 600_000, debounceMs: 10, fullIdleMaxMs,
		run: async (scope) => {
			scopes.push(scope);
			return reports.shift() ?? report();
		},
	});
	const step = async (ms: number): Promise<void> => {
		clock.advance(ms);
		await flush();
	};
	return { clock, scopes, s, step };
}

test("passScheduler: an unread file schedules a full retry pass with backoff", async () => {
	const h = harness([report({ unread: 1 }), report({ unread: 1 }), report()]);
	h.s.request({ t: "docs", docIds: [], pathKeys: ["k" as never] });
	await h.step(10);
	assert.equal(h.scopes.length, 1);
	await h.step(999);
	assert.equal(h.scopes.length, 1, "no retry before the 1 s backoff");
	await h.step(1);
	await h.step(0);
	assert.equal(h.scopes.length, 2);
	assert.deepEqual(h.scopes[1], { t: "full" });
	await h.step(1_999);
	assert.equal(h.scopes.length, 2, "second retry backs off to 2 s");
	await h.step(1);
	await h.step(0);
	assert.equal(h.scopes.length, 3);
	await h.step(120_000);
	assert.equal(h.scopes.length, 3, "a clean pass stops retrying");
	h.s.stop();
});

test("passScheduler: an unproductive actionable pass retries; a quiet pass does not", async () => {
	const h = harness([report({ actionable: 2, ok: 0 }), report()]);
	h.s.request();
	await h.step(10);
	await h.step(1_000);
	await h.step(0);
	assert.equal(h.scopes.length, 2);
	await h.step(120_000);
	assert.equal(h.scopes.length, 2);
	h.s.stop();
});

test("passScheduler: a productive docs pass's follow-up covers the paths it vacated", async () => {
	// A fileGone doc's delete drops its record: the new file at its path is planned (nsCreate) by the follow-up.
	const h = harness([report({ actionable: 2, ok: 2, vacated: ["x.md" as never] }), report()]);
	h.s.request({ t: "docs", docIds: ["d1" as never], pathKeys: ["y.md" as never] });
	await h.step(10);
	await h.step(0);
	assert.equal(h.scopes.length, 2);
	assert.deepEqual(h.scopes[1], { t: "docs", docIds: ["d1"], pathKeys: ["y.md", "x.md"] });
	h.s.stop();
});

test("passScheduler: the periodic full pass backs off while it finds nothing, and a docs request resets it", async () => {
	const MIN = 60_000;
	const h = harness([], 40 * MIN);
	const fulls = (): number => h.scopes.filter((x) => x.t === "full").length;
	h.s.request();
	await h.step(10);
	assert.equal(fulls(), 1);
	// Idle passes: next ones after 20, 40, 40 min (base 10 min doubling, capped at 40).
	for (const [wait, n] of [[20, 2], [40, 3], [40, 4]] as const) {
		await h.step(wait * MIN - 1);
		assert.equal(fulls(), n - 1, `not before ${wait} min`);
		await h.step(1);
		await h.step(10);
		assert.equal(fulls(), n, `after ${wait} min`);
	}
	h.s.request({ t: "docs", docIds: [], pathKeys: ["k" as never] });
	await h.step(10);
	await h.step(10 * MIN);
	await h.step(10);
	assert.equal(fulls(), 5, "back to the 10 min base after activity");
	h.s.stop();
});

test("passScheduler: without fullIdleMaxMs the periodic pass keeps its interval", async () => {
	const h = harness([]);
	h.s.request();
	await h.step(10);
	for (let i = 2; i <= 4; i++) {
		await h.step(600_000);
		await h.step(10);
		assert.equal(h.scopes.length, i);
	}
	h.s.stop();
});
