/**
 * blobs/gc.ts (e2ee-design §10.4): the sweep against SimBlobStore (relay semantics: list by address, delete =
 * check every address then one delete) with fake mark / remark, and once over the HTTP adapter with 429 / 503.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { concatBytes } from "../../core/codec/lib0";
import { sha256Hex } from "../../core/hash/sha256";
import type { ContentHash } from "../../core/types";
import { BLOB_DELETE_BATCH, type BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort } from "../../ports/crypto";
import { SimBlobStore } from "../../sim/blobStore";
import { SeededRandom } from "../../sim/random";
import { createHttpBlob } from "../adapters/httpBlob";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { fakeFetch, jsonResponse, routedXhr, type FakeRequest } from "../adapters/relayTestFakes";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { FakeClock } from "../reconcile/testkit/fakes";
import type { PutPolicy } from "./blobStore";
import { GC_CLOCK_SKEW_MARGIN_MS, sweepBlobs, type GcDeps, type GcMark } from "./gc";

const DAY = 24 * 60 * 60_000;
const GRACE = 7 * DAY;
const hashPort = createWebHash();
const noop = createNoopCrypto(hashPort);

const bytesOf = (i: number) => Uint8Array.from({ length: 16 }, (_, j) => (j === 0 ? i >> 8 : j === 1 ? i : i * 7 + j) & 0xff);
const H = (b: Uint8Array) => sha256Hex(b) as ContentHash;

interface Rig {
	readonly store: SimBlobStore;
	readonly clock: FakeClock;
	/** The store's clock. */
	storeNow: number;
	live: Set<ContentHash>;
	committed: Set<ContentHash>;
	/** remark's live set (default: live). */
	again: (() => GcMark) | null;
	mark: (() => GcMark) | null;
	local: Map<ContentHash, Uint8Array>;
	readonly diag: string[];
	readonly noted: string[];
	readonly ctrl: AbortController;
	readonly deps: () => GcDeps;
	/** Stores the blob for `i` (address under `crypto`), uploaded `ageMs` before the store's now. */
	add(i: number, ageMs: number): Promise<{ hash: ContentHash; address: BlobAddress }>;
}

function rig(o: { pageSize?: number; crypto?: CryptoPort; store?: BlobPort } = {}): Rig {
	const crypto = o.crypto ?? noop;
	const clock = new FakeClock();
	const r: Rig = {
		store: null as unknown as SimBlobStore,
		clock,
		storeNow: clock.now(),
		live: new Set(),
		committed: new Set(),
		again: null,
		mark: null,
		local: new Map(),
		diag: [],
		noted: [],
		ctrl: new AbortController(),
		deps: () => ({
			store: o.store ?? r.store, crypto, hash: hashPort, clock, random: new SeededRandom(7), graceMs: GRACE, signal: r.ctrl.signal,
			mark: async () => r.mark?.() ?? { ok: true, live: r.live, committed: r.committed },
			remark: async () => r.again?.() ?? { ok: true, live: r.live, committed: r.committed },
			bytes: async (h) => r.local.get(h) ?? null,
			policy: { reuse: async () => false, noted: async (_h, a) => void r.noted.push(a) } satisfies PutPolicy,
			diag: (code) => void r.diag.push(code),
		}),
		add: async (i, ageMs) => {
			const b = bytesOf(i);
			const hash = H(b);
			const address = await crypto.blobAddress(hash);
			r.store.objects.set(address, { bytes: concatBytes(await crypto.sealBlob({ address, plaintext: b })), uploadedAt: r.storeNow - ageMs });
			return { hash, address };
		},
	};
	(r as { store: SimBlobStore }).store = new SimBlobStore({ now: () => r.storeNow, pageSize: o.pageSize });
	return r;
}

test("sweep: deletes unreferenced blobs older than the cutoff in batches of ≤100; keeps live and newer ones; the probe leaves no trace", async () => {
	const r = rig();
	const orphans: BlobAddress[] = [];
	for (let i = 0; i < 250; i++) orphans.push((await r.add(i, GRACE + DAY)).address);
	for (let i = 300; i < 305; i++) {
		const { hash } = await r.add(i, 30 * DAY);
		r.live.add(hash);
		r.committed.add(hash);
	}
	for (let i = 400; i < 403; i++) await r.add(i, GRACE - DAY);
	const batches: number[] = [];
	r.store.hooks.beforeDelete = (a) => void batches.push(a.length);
	const out = await sweepBlobs(r.deps());
	assert.deepEqual(out, { deleted: 250, keptNewer: 3, repaired: 0, lost: 0, refused: null, detail: null });
	assert.equal(r.store.deleted.length, 251, "the orphans, then the probe");
	assert.ok(r.store.deleted.slice(0, 250).every((a) => orphans.includes(a)));
	assert.equal(r.store.objects.size, 8);
	assert.ok(batches.every((n) => n <= BLOB_DELETE_BATCH));
	assert.deepEqual(batches, [1, 100, 100, 50, 1], "probe check, three sweep batches, probe removal");
	assert.ok(r.diag.includes("blob-gc-swept"));
});

test("sweep: pagination survives deletes between pages (own batches and another device's), and walks to the end", async () => {
	const r = rig({ pageSize: 7 });
	const orphans = new Set<BlobAddress>();
	const keep = new Set<BlobAddress>();
	for (let i = 0; i < 230; i++) {
		const { hash, address } = await r.add(i, GRACE + DAY);
		if (i % 9 === 0) {
			r.live.add(hash);
			keep.add(address);
		} else orphans.add(address);
	}
	r.committed = new Set(r.live);
	const sorted = [...r.store.objects.keys()].sort();
	let pages = 0;
	let other: BlobAddress | null = null;
	r.store.hooks.beforeList = (cursor) => {
		pages++;
		// Another device deletes an orphan ahead of the cursor.
		if (pages === 3) {
			other = sorted.find((a) => cursor !== null && a > cursor && orphans.has(a) && r.store.objects.has(a)) ?? null;
			if (other) r.store.objects.delete(other);
		}
	};
	const out = await sweepBlobs(r.deps());
	assert.ok(other, "the other device deleted one");
	assert.equal(out.refused, null);
	assert.equal(out.deleted, orphans.size - 1);
	assert.deepEqual(new Set(r.store.objects.keys()), keep, "every orphan gone, every live blob kept");
	assert.ok(pages >= Math.ceil(230 / 7));
});

test("sweep: a blob uploaded again after it was listed (old) survives: the delete call answers \"newer\"", async () => {
	const r = rig({ pageSize: 5 });
	const blobs = [];
	for (let i = 0; i < 12; i++) blobs.push(await r.add(i, GRACE + DAY));
	const sorted = blobs.map((b) => b.address).sort();
	const first = sorted[0]!;
	r.store.hooks.beforeList = (cursor) => {
		// Listed on page 1 as old; re-uploaded (PUT refreshes the time) before the batch is sent.
		if (cursor !== null) r.store.objects.set(first, { bytes: r.store.objects.get(first)!.bytes, uploadedAt: r.storeNow });
	};
	const out = await sweepBlobs(r.deps());
	assert.equal(out.deleted, 11);
	assert.equal(out.keptNewer, 1);
	assert.ok(r.store.objects.has(first));
});

test("R4: a PUT in the check -> delete window is deleted anyway, then uploaded again from local bytes once it is live; without bytes it is lost", async () => {
	for (const haveBytes of [true, false]) {
		const r = rig();
		const x = await r.add(1, GRACE + DAY);
		const y = await r.add(2, GRACE + DAY);
		const keep = await r.add(3, 30 * DAY);
		r.live.add(keep.hash);
		r.committed.add(keep.hash);
		r.store.hooks.beforeDelete = (addresses) => {
			if (!addresses.includes(x.address)) return;
			// Another device re-uploads x and commits a reference to it while the relay is between HEAD and delete.
			r.store.objects.set(x.address, { bytes: r.store.objects.get(x.address)!.bytes, uploadedAt: r.storeNow });
		};
		if (haveBytes) r.local.set(x.hash, bytesOf(1));
		r.again = () => ({ ok: true, live: new Set([keep.hash, x.hash]), committed: new Set([keep.hash, x.hash]) });
		r.storeNow += 1000;
		const out = await sweepBlobs(r.deps());
		assert.equal(out.deleted, 2);
		assert.deepEqual([out.repaired, out.lost], haveBytes ? [1, 0] : [0, 1]);
		assert.equal(r.store.objects.has(x.address), haveBytes);
		assert.ok(!r.store.objects.has(y.address));
		if (haveBytes) {
			assert.equal(r.store.uploadedAt(x.address), r.storeNow, "a fresh upload time");
			assert.deepEqual(r.noted, [x.address], "the repair PUT is noted (R2 / R3 put times)");
		}
	}
});

test("R4: local bytes that do not hash to the address are not uploaded; a failed re-check is reported", async () => {
	const r = rig();
	const x = await r.add(1, GRACE + DAY);
	r.local.set(x.hash, bytesOf(99));
	r.again = () => ({ ok: true, live: new Set([x.hash]), committed: new Set([x.hash]) });
	const out = await sweepBlobs(r.deps());
	assert.deepEqual([out.deleted, out.repaired, out.lost], [1, 0, 1]);
	assert.ok(!r.store.objects.has(x.address));

	const r2 = rig();
	await r2.add(1, GRACE + DAY);
	r2.again = () => ({ ok: false, refused: "not-caught-up", detail: "ns is behind" });
	const out2 = await sweepBlobs(r2.deps());
	assert.equal(out2.deleted, 1);
	assert.equal(out2.refused, null);
	assert.match(out2.detail ?? "", /not re-checked \(ns is behind\)/);
});

test("refusals: every mark refusal deletes nothing and removes the probe", async () => {
	for (const refused of ["not-caught-up", "fold-incomplete", "body-unreadable", "offline", "read-only", "keys-unverified"] as const) {
		const r = rig();
		for (let i = 0; i < 20; i++) await r.add(i, GRACE + DAY);
		const before = new Map(r.store.objects);
		r.mark = () => ({ ok: false, refused, detail: "why" });
		const out = await sweepBlobs(r.deps());
		assert.deepEqual(out, { deleted: 0, keptNewer: 0, repaired: 0, lost: 0, refused, detail: "why" });
		assert.ok(r.store.deleted.every((a) => !before.has(a)), "only the probe was deleted");
		assert.deepEqual(r.store.objects, before, "the probe is gone too");
		assert.equal(r.store.calls.list, 0);
	}
});

test("safety net: when no referenced blob is listed under this device's addressing, nothing is deleted", async () => {
	const r = rig();
	for (let i = 0; i < 150; i++) await r.add(i, GRACE + DAY);
	// References whose addresses are not in the store (wrong suite / key: every stored blob looks unknown).
	r.committed = new Set([H(bytesOf(1000)), H(bytesOf(1001))]);
	r.live = new Set([...r.committed, H(bytesOf(1002))]);
	const out = await sweepBlobs(r.deps());
	assert.equal(out.refused, "addressing-mismatch");
	assert.equal(out.deleted, 0);
	assert.equal(r.store.deleted.length, 1, "only the probe");
	assert.equal(r.store.objects.size, 150);

	// Only uncommitted live references (no committed one): any live one is a witness.
	const r2 = rig();
	for (let i = 0; i < 5; i++) await r2.add(i, GRACE + DAY);
	const w = await r2.add(10, GRACE + DAY);
	r2.live = new Set([w.hash]);
	assert.equal((await sweepBlobs(r2.deps())).deleted, 5);
	// Nothing referenced at all: everything old goes.
	const r3 = rig();
	for (let i = 0; i < 5; i++) await r3.add(i, GRACE + DAY);
	assert.equal((await sweepBlobs(r3.deps())).deleted, 5);
});

test("R1: the cutoff follows the store's clock, whatever this device's clock says", async () => {
	for (const skew of [-30 * DAY, 30 * DAY]) {
		const r = rig();
		r.clock.wall = r.storeNow + skew;
		const young = await r.add(1, GRACE - 60_000);
		const old = await r.add(2, GRACE + 60_000);
		const out = await sweepBlobs(r.deps());
		assert.deepEqual([out.deleted, out.keptNewer], [1, 1], `skew ${skew}`);
		assert.ok(r.store.objects.has(young.address));
		assert.ok(!r.store.objects.has(old.address));
		assert.ok(!r.diag.includes("blob-gc-probe-failed"));
	}
});

test("R1 fallback: a probe that fails uses this device's clock minus the grace and the skew margin", async () => {
	const r = rig();
	let puts = 0;
	r.store.hooks.fail = (route) => (route === "put" && ++puts === 1 ? new Error("503") : null);
	const inMargin = await r.add(1, GRACE + GC_CLOCK_SKEW_MARGIN_MS - 60_000);
	const past = await r.add(2, GRACE + GC_CLOCK_SKEW_MARGIN_MS + 60_000);
	const out = await sweepBlobs(r.deps());
	assert.ok(r.diag.includes("blob-gc-probe-failed"));
	assert.deepEqual([out.deleted, out.keptNewer, out.refused], [1, 1, null]);
	assert.ok(r.store.objects.has(inMargin.address));
	assert.ok(!r.store.objects.has(past.address));
});

test("interrupted: a store failure mid-sweep stops with the counts so far; R4 still checks what was deleted", async () => {
	const r = rig();
	for (let i = 0; i < 250; i++) await r.add(i, GRACE + DAY);
	let deletes = 0;
	r.store.hooks.fail = (route) => (route === "delete" && ++deletes === 3 ? new Error("relay 500") : null);
	let remarks = 0;
	r.again = () => {
		remarks++;
		return { ok: true, live: r.live, committed: r.committed };
	};
	const out = await sweepBlobs(r.deps());
	assert.equal(out.refused, "interrupted");
	assert.equal(out.deleted, 100);
	assert.match(out.detail ?? "", /relay 500/);
	assert.equal(remarks, 1);
	assert.ok(r.diag.includes("blob-gc-interrupted"));
});

test("stop: an aborted sweep deletes nothing more", async () => {
	const r = rig({ pageSize: 10 });
	for (let i = 0; i < 250; i++) await r.add(i, GRACE + DAY);
	r.store.hooks.beforeList = (cursor) => { if (cursor !== null) r.ctrl.abort(); };
	const out = await sweepBlobs(r.deps());
	assert.equal(out.refused, "interrupted");
	assert.equal(out.deleted, 0, "fewer than a batch was collected before the stop");
	assert.equal(r.store.deleted.length, 0, "not even the probe (best effort; a later sweep collects it)");
});

test("a listing that does not advance stops the sweep", async () => {
	const r = rig();
	const a = await r.add(1, GRACE + DAY);
	const stuck: BlobPort = {
		maxBlobBytes: r.store.maxBlobBytes,
		has: (x) => r.store.has(x), put: (x, b) => r.store.put(x, b), get: (x) => r.store.get(x),
		list: async () => ({ items: [{ address: a.address, uploadedAt: 0 }], next: a.address }),
		deleteIfUploadedBefore: (x, c, s) => r.store.deleteIfUploadedBefore(x, c, s),
	};
	const out = await sweepBlobs({ ...r.deps(), store: stuck });
	assert.equal(out.refused, "interrupted");
	assert.match(out.detail ?? "", /did not advance/);
	assert.equal(out.deleted, 0);
});

test("suite 1: live hashes are compared as HMAC addresses; no plaintext hash reaches the store", async () => {
	const s1 = await createWebCryptoSuite1({ vaultId: "AAAAAAAAAAAAAAAAAAAAAA", random: new SeededRandom(3), keys: [{ e: 1, k: Uint8Array.from({ length: 32 }, (_, i) => i) }] });
	s1.markVerified(1);
	s1.setSealEpoch(1);
	const r = rig({ crypto: s1 });
	const seen: string[] = [];
	const spy = r.store.hooks;
	spy.beforeDelete = (a) => void seen.push(...a);
	spy.beforeList = (c) => void (c && seen.push(c));
	const plain: ContentHash[] = [];
	for (let i = 0; i < 10; i++) {
		const { hash, address } = await r.add(i, GRACE + DAY);
		assert.notEqual(address, hash);
		plain.push(hash);
		if (i < 3) {
			r.live.add(hash);
			r.committed.add(hash);
		}
	}
	const out = await sweepBlobs(r.deps());
	assert.equal(out.deleted, 7);
	assert.equal(r.store.objects.size, 3);
	for (const a of [...r.store.objects.keys(), ...seen]) assert.ok(!plain.includes(a as ContentHash));
	// The same live set under suite-0 addressing would look unknown: the net refuses instead of deleting.
	const wrong = rig({ crypto: s1 });
	for (let i = 0; i < 4; i++) {
		const b = bytesOf(i);
		wrong.store.objects.set(H(b) as string as BlobAddress, { bytes: b, uploadedAt: 0 });
	}
	wrong.live = new Set([H(bytesOf(0))]);
	wrong.committed = new Set(wrong.live);
	assert.equal((await sweepBlobs(wrong.deps())).refused, "addressing-mismatch");
	assert.equal(wrong.store.objects.size, 4);
});

test("HTTP adapter: list and delete retry 429 / 503 list_incomplete after Retry-After within one sweep", async () => {
	const objects = new Map<string, number>();
	const NOW = 1_800_000_000_000;
	const addr = (i: number) => sha256Hex(bytesOf(i));
	for (let i = 0; i < 120; i++) objects.set(addr(i), NOW - GRACE - DAY);
	let lists = 0;
	let deletes = 0;
	const route = (req: FakeRequest): Response => {
		const path = req.url.pathname;
		if (req.method === "PUT") {
			objects.set(path.split("/").pop()!, NOW);
			return new Response(null, { status: 204 });
		}
		if (req.method === "GET" && path.endsWith("/blobs")) {
			if (++lists === 1) return jsonResponse({ error: "list_incomplete" }, 503, { "Retry-After": "2" });
			const cursor = req.url.searchParams.get("cursor");
			const items = [...objects].filter(([a]) => cursor === null || a > cursor).sort((x, y) => (x[0] < y[0] ? -1 : 1)).slice(0, 50);
			const more = [...objects.keys()].filter((a) => a > (items.at(-1)?.[0] ?? "")).length > 0;
			return jsonResponse({ items: items.map(([address, uploadedAt]) => ({ address, uploadedAt })), next: more ? items.at(-1)![0] : null });
		}
		if (req.method === "POST" && path.endsWith("/blobs/delete")) {
			const body = JSON.parse(String(req.body)) as { ifUploadedBefore: number; addresses: string[] };
			if (body.addresses.length > 1 && ++deletes === 1) return jsonResponse({ error: "too_many_attempts" }, 429, { "Retry-After": "1" });
			return jsonResponse({ results: body.addresses.map((address) => {
				const at = objects.get(address);
				if (at === undefined) return { address, result: "absent" };
				if (at >= body.ifUploadedBefore) return { address, result: "newer", uploadedAt: at };
				objects.delete(address);
				return { address, result: "deleted", uploadedAt: at };
			}) });
		}
		return jsonResponse({ error: "unexpected" }, 500);
	};
	const f = fakeFetch(route);
	const waits: number[] = [];
	const clock = new FakeClock();
	// The retry waits fire at once; the idle window (never reached) neither fires nor counts.
	const NEVER = Number.MAX_SAFE_INTEGER;
	const store = createHttpBlob({
		baseUrl: "https://r.example", vaultId: "v1", credential: "tok", fetch: f.fetch, xhr: routedXhr(route, f.requests), idleMs: NEVER,
		clock: {
			...clock, now: () => clock.now(), monotonic: () => 0, yieldNow: async () => undefined, clearTimer: () => undefined,
			setTimer: (ms, fn) => {
				if (ms === NEVER) return 0;
				waits.push(ms);
				queueMicrotask(fn);
				return waits.length;
			},
		},
	});
	const r = rig({ store });
	const out = await sweepBlobs(r.deps());
	assert.deepEqual([out.deleted, out.refused], [120, null]);
	assert.deepEqual(waits, [2000, 1000]);
	assert.equal(objects.size, 0, "the probe was removed too");
});
