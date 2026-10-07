import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobAddress } from "../ports/crypto";
import { BLOB_TRANSFER_IDLE_MS } from "../core/limits";
import { RelayHttpError } from "../engine/adapters/relayHttp";
import { CALL_OVERHEAD_BYTES, emptyLiveness, SimBlobStore } from "./blobStore";
import { VirtualClock } from "./clock";

const addr = (i: number) => i.toString(16).padStart(64, "0") as BlobAddress;

describe("SimBlobStore", () => {
	it("lists in address order by the last address; deletes between pages do not move the walk", async () => {
		let t = 1000;
		const s = new SimBlobStore({ now: () => t, pageSize: 2 });
		for (const i of [5, 1, 4, 2, 3]) await s.put(addr(i), [new Uint8Array([i])]);
		const p1 = await s.list(null);
		assert.deepEqual(p1.items.map((x) => x.address), [addr(1), addr(2)]);
		assert.equal(p1.next, addr(2));
		await s.deleteIfUploadedBefore([addr(2), addr(3)], ++t);
		const p2 = await s.list(p1.next);
		assert.deepEqual(p2.items.map((x) => x.address), [addr(4), addr(5)]);
		assert.equal(p2.next, null);
	});

	it("a PUT refreshes uploadedAt (newer); a PUT in the HEAD -> delete window is deleted anyway", async () => {
		let t = 1000;
		const s = new SimBlobStore({ now: () => t });
		await s.put(addr(1), [new Uint8Array([1])]);
		await s.put(addr(2), [new Uint8Array([2])]);
		t = 2000;
		await s.put(addr(1), [new Uint8Array([1])]);
		assert.equal(s.uploadedAt(addr(1)), 2000);
		s.hooks.beforeDelete = async () => { await s.put(addr(2), [new Uint8Array([2])]); };
		const r = await s.deleteIfUploadedBefore([addr(1), addr(2), addr(3)], 1500);
		assert.deepEqual(r, [
			{ address: addr(1), result: "newer", uploadedAt: 2000 },
			{ address: addr(2), result: "deleted", uploadedAt: 1000 },
			{ address: addr(3), result: "absent" },
		]);
		assert.equal(s.objects.has(addr(2)), false, "re-PUT inside the window lost");
		assert.deepEqual(s.deleted, [addr(2)]);
	});
});

/** A signal whose abort listeners are counted (added minus removed). */
function counted(ctl: AbortController): { signal: AbortSignal; listeners: () => number } {
	const s = ctl.signal;
	let n = 0;
	const add = s.addEventListener.bind(s);
	const remove = s.removeEventListener.bind(s);
	s.addEventListener = ((...a: Parameters<AbortSignal["addEventListener"]>) => {
		n++;
		add(...a);
	}) as AbortSignal["addEventListener"];
	s.removeEventListener = ((...a: Parameters<AbortSignal["removeEventListener"]>) => {
		n--;
		remove(...a);
	}) as AbortSignal["removeEventListener"];
	return { signal: s, listeners: () => n };
}

/** The promise's outcome so far: "pending", "ok", or the rejection. */
function watch<T>(p: Promise<T>): () => "pending" | "ok" | unknown {
	let out: "pending" | "ok" | unknown = "pending";
	p.then(() => (out = "ok"), (e: unknown) => (out = e));
	return () => out;
}

function stalledError(route: string): (e: unknown) => boolean {
	return (e) => e instanceof RelayHttpError && e.status === 0 && e.code === "stalled" && e.message.includes(route);
}

describe("SimBlobStore liveness (the adapter's idle window, httpBlob.ts transfer())", () => {
	const world = () => {
		const clock = new VirtualClock();
		return { clock, s: new SimBlobStore({ now: () => clock.now(), timers: clock }) };
	};

	it("has / put / get honour the signal: aborted before, they reject at once with its reason; aborted mid-call, too; the listener goes when the call settles", async () => {
		const { clock, s } = world();
		const gone = new Error("link lost");
		const pre = new AbortController();
		pre.abort(gone);
		await assert.rejects(s.has([addr(1)], pre.signal), (e) => e === gone);
		await assert.rejects(s.put(addr(1), [new Uint8Array([1])], pre.signal), (e) => e === gone);
		await assert.rejects(s.get(addr(1), pre.signal), (e) => e === gone);
		assert.equal(s.objects.size, 0);

		s.setStall("path");
		for (const route of ["has", "put", "get"] as const) {
			const ctl = new AbortController();
			const sig = counted(ctl);
			const call: Promise<unknown> = route === "has" ? s.has([addr(2)], sig.signal) : route === "put" ? s.put(addr(2), [new Uint8Array([2])], sig.signal) : s.get(addr(2), sig.signal);
			const out = watch(call);
			await clock.advance(1_000);
			assert.equal(out(), "pending", `${route} stalled`);
			assert.equal(sig.listeners(), 1);
			const why = new Error(`abort ${route}`);
			ctl.abort(why);
			await clock.advance(0);
			assert.equal(out(), why, `${route} rejects with the signal's reason`);
			assert.equal(sig.listeners(), 0, `${route}: listener removed`);
		}
		assert.equal(s.liveness.aborted, 3);
		assert.deepEqual(s.transfers(), []);
		assert.equal(clock.pendingTimers(), 0, "no idle window left armed");

		// Settled by the idle window: the listener goes too.
		const ctl = new AbortController();
		const sig = counted(ctl);
		const out = watch(s.get(addr(3), sig.signal));
		await clock.advance(BLOB_TRANSFER_IDLE_MS);
		assert.ok(stalledError("blobs/get")(out()), String(out()));
		assert.equal(sig.listeners(), 0);
	});

	it("stall: a call moves nothing; the idle window ends it at BLOB_TRANSFER_IDLE_MS, not a millisecond before; ending the stall leaves it dead, a new call answers", async () => {
		const { clock, s } = world();
		await s.put(addr(1), [new Uint8Array([1, 2, 3])]);
		s.setStall("path");
		const t0 = clock.monotonic();
		const get = watch(s.get(addr(1), new AbortController().signal));
		const put = watch(s.put(addr(2), [new Uint8Array([9])]));
		assert.deepEqual(s.transfers().map((c) => [c.route, c.startedAt, c.stalled]), [["get", t0, true], ["put", t0, true]]);
		await clock.advance(30_000);
		s.setStall(null);
		assert.deepEqual(await s.get(addr(1)), new Uint8Array([1, 2, 3]), "a call after the stall answers at once");
		await clock.advance(BLOB_TRANSFER_IDLE_MS - 30_000 - 1);
		assert.equal(get(), "pending", "still dead after the stall ended, inside the window");
		assert.equal(put(), "pending");
		assert.equal(s.liveness.watchdog, 0);
		await clock.advance(1);
		assert.equal(clock.monotonic() - t0, BLOB_TRANSFER_IDLE_MS);
		assert.ok(stalledError("blobs/get")(get()), String(get()));
		assert.ok(stalledError("blobs/put")(put()), String(put()));
		assert.equal(s.objects.has(addr(2)), false, "a dead PUT stores nothing");
		assert.deepEqual({ ...s.liveness, stalled: { ...s.liveness.stalled } }, { ...emptyLiveness(), stalled: { has: 0, put: 1, get: 1 }, watchdog: 2 });
	});

	it("slow: a call moves at the rate in ticks that restart the window; one longer than the window completes uncut; the end of the period moves the rest; a stall catches calls in flight", async () => {
		const { clock, s } = world();
		const rate = 10_000;
		s.setSlow(rate);
		const body = new Uint8Array(1_000_000);
		const t0 = clock.monotonic();
		const put = watch(s.put(addr(1), [body]));
		const total = Math.ceil(((CALL_OVERHEAD_BYTES + body.length) / rate) * 1000);
		assert.ok(total > 1.5 * BLOB_TRANSFER_IDLE_MS, `${total} ms`);
		await clock.advance(total - 1);
		assert.equal(put(), "pending");
		assert.equal(s.objects.has(addr(1)), false, "stored at the end");
		await clock.advance(1);
		assert.equal(put(), "ok");
		assert.equal(s.uploadedAt(addr(1)), clock.now());
		assert.equal(s.liveness.slowMaxMs, clock.monotonic() - t0);
		assert.deepEqual([s.liveness.slowDone, s.liveness.slowOverIdle, s.liveness.watchdog, s.liveness.slowCut], [1, 1, 0, 0]);

		// The period ends: what is left moves at the next tick.
		const get = watch(s.get(addr(1)));
		await clock.advance(5_500);
		s.setSlow(null);
		assert.equal(get(), "pending");
		await clock.advance(500);
		assert.equal(get(), "ok");

		// A stall catches a slow call in flight: it moves no more, the window runs from its last tick.
		s.setSlow(rate);
		const caught = watch(s.get(addr(1)));
		await clock.advance(3_000);
		s.setStall("path");
		await clock.advance(BLOB_TRANSFER_IDLE_MS - 1);
		assert.equal(caught(), "pending");
		await clock.advance(1);
		assert.ok(stalledError("blobs/get")(caught()), String(caught()));
		assert.deepEqual([s.liveness.stalled.get, s.liveness.slowed.get, s.liveness.watchdog, s.liveness.slowCut], [1, 2, 1, 0]);
		assert.equal(clock.pendingTimers(), 0);
	});

	it("a \"put\" stall black-holes upload bodies only: exists and get answer; a slow PUT in flight is caught, a slow GET is not", async () => {
		const { clock, s } = world();
		await s.put(addr(1), [new Uint8Array([1])]);
		s.setStall("put");
		assert.equal(s.stalled, "put");
		assert.deepEqual(await s.has([addr(1), addr(2)]), new Set([addr(1)]), "exists answers at once");
		assert.deepEqual(await s.get(addr(1)), new Uint8Array([1]), "get answers at once");
		const put = watch(s.put(addr(2), [new Uint8Array([2])]));
		await clock.advance(BLOB_TRANSFER_IDLE_MS - 1);
		assert.equal(put(), "pending");
		await clock.advance(1);
		assert.ok(stalledError("blobs/put")(put()), String(put()));
		s.setStall(null);

		s.setSlow(1_000);
		const slowPut = watch(s.put(addr(3), [new Uint8Array(20_000)]));
		const slowGet = watch(s.get(addr(1)));
		await clock.advance(200);
		s.setStall("put");
		assert.deepEqual(s.transfers().map((c) => [c.route, c.stalled]), [["put", true], ["get", false]]);
		await clock.advance(BLOB_TRANSFER_IDLE_MS);
		assert.ok(stalledError("blobs/put")(slowPut()), String(slowPut()));
		assert.equal(slowGet(), "ok", "the GET kept moving");
		assert.equal(s.objects.has(addr(3)), false);
		assert.deepEqual([s.liveness.stalled.put, s.liveness.stalled.has, s.liveness.stalled.get, s.liveness.watchdog, s.liveness.slowCut], [2, 0, 0, 2, 0]);
	});

	it("without the run's clock the models refuse to start (a store answering at once stays as it was)", () => {
		const s = new SimBlobStore({ now: () => 0 });
		assert.throws(() => s.setStall("path"), /need the run's clock/);
		assert.throws(() => s.setSlow(1024), /need the run's clock/);
	});
});
