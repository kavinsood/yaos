import assert from "node:assert/strict";
import { test } from "node:test";
import type { RelayPort, RelaySession } from "../../ports/relay";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { converged, startTestEngine, until } from "./testHarness";

const NO_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 1e9, settleMs: 1e9, fallbackMs: 1e9, nsRows: 1e9, nsBytes: 1e12 };
const DOCS = 30;

/** DOCS notes; with `long`, every third note also gets 6 more rows of ~150 bytes (several pages under a small budget). */
async function seeded(relay: SimRelay, long = false): Promise<LogEngine> {
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning: { checkpoint: NO_CKPT } });
	await until(() => a.status().phase === "live", 3_000, "a live");
	for (let i = 0; i < DOCS; i++) {
		const id = await a.createDoc(`d/n${i}.md`, `note ${i} `.repeat(4));
		if (!long || i % 3 !== 0) continue;
		for (let k = 0; k < 6; k++) {
			await a.editDoc(id, (t) => t.insert(t.length, ` row ${k} `.repeat(15)));
			await a.flush();
		}
	}
	await converged([a]);
	return a;
}

/** A relay port whose sessions fail the first `n` readBatch calls. */
function failingBatches(relay: SimRelay, n: number): RelayPort & { failed: number } {
	const port = {
		failed: 0,
		async connect(params: Parameters<RelayPort["connect"]>[0]) {
			const r = await relay.connect(params);
			if (!r.ok) return r;
			const inner = r.session;
			const session = new Proxy(inner, {
				get(target, key) {
					if (key === "readBatch") {
						return (...a: Parameters<RelaySession["readBatch"]>) => port.failed++ < n ? Promise.reject(new Error("batch down")) : target.readBatch(...a);
					}
					const v: unknown = Reflect.get(target, key);
					return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
				},
			});
			return { ok: true as const, session };
		},
	};
	return port;
}

test("fresh device: catch-up reads go in batches (ns + cfg in one request before live); same result as single reads", async () => {
	const relay = new SimRelay();
	const a = await seeded(relay);
	const engines: LogEngine[] = [a];
	try {
		const before = relay.readRequests;
		const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", tuning: { checkpoint: NO_CKPT, readBatchStreams: 8 } });
		engines.push(b);
		await converged([a, b]);
		const batched = relay.readRequests - before;
		assert.ok(b.c.sess.stats.readBatches >= Math.ceil(DOCS / 8), `batches ${b.c.sess.stats.readBatches}`);
		assert.ok(batched <= Math.ceil((DOCS + 1) / 8) + 3, `${batched} read requests for ${DOCS} docs + ns`);
		assert.equal(b.listDocs().length, DOCS);

		const mid = relay.readRequests;
		const { engine: c } = await startTestEngine({ relay, deviceId: "dev-c", tuning: { checkpoint: NO_CKPT, readBatchStreams: 1 } });
		engines.push(c);
		await converged([a, b, c]);
		assert.equal(c.c.sess.stats.readBatches, 0, "readBatchStreams 1: single reads only");
		assert.ok(relay.readRequests - mid >= DOCS, "one request per stream");
	} finally {
		for (const e of engines) await e.stop();
	}
});

test("batched catch-up: a small page budget serves a prefix per request; the rest are re-requested until caught up", async () => {
	const relay = new SimRelay({ limits: { readPageBytes: 400 }, link: { httpMs: 5 } });
	const a = await seeded(relay, true);
	const engines: LogEngine[] = [a];
	try {
		const before = relay.readRequests;
		relay.maxReadsOnWire = 0;
		const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", tuning: { checkpoint: NO_CKPT } });
		engines.push(b);
		await converged([a, b], 15_000);
		assert.equal(b.listDocs().length, DOCS);
		const used = relay.readRequests - before;
		const onWire = relay.maxReadsOnWire;
		assert.ok(onWire <= b.c.budgets.catchUpConcurrency, `${onWire} read requests at once (continuations stay in their batch's lane)`);
		for (const d of a.listDocs()) assert.equal(await b.docText(d.docId), await a.docText(d.docId));

		const mid = relay.readRequests;
		const { engine: c } = await startTestEngine({ relay, deviceId: "dev-c", tuning: { checkpoint: NO_CKPT, readBatchStreams: 1 } });
		engines.push(c);
		await converged([a, b, c], 15_000);
		const single = relay.readRequests - mid;
		assert.ok(used > 2 && used < single, `batched ${used} requests vs ${single} single reads`);
	} finally {
		for (const e of engines) await e.stop();
	}
});

test("batched catch-up: streams that need more pages read on one at a time per batch (request concurrency stays bounded)", async () => {
	const relay = new SimRelay({ readPageRows: 2, link: { httpMs: 5 } });
	const a = await seeded(relay, true);
	const engines: LogEngine[] = [a];
	try {
		relay.maxReadsOnWire = 0;
		const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", tuning: { checkpoint: NO_CKPT } });
		engines.push(b);
		await converged([a, b], 15_000);
		assert.ok(relay.readRequests > 10, "multi-page streams read on");
		assert.ok(relay.maxReadsOnWire <= b.c.budgets.catchUpConcurrency, `${relay.maxReadsOnWire} read requests at once`);
		for (const d of a.listDocs()) assert.equal(await b.docText(d.docId), await a.docText(d.docId));
	} finally {
		for (const e of engines) await e.stop();
	}
});

test("batched catch-up: a failed batch request backs its streams off, then they are read", async () => {
	const relay = new SimRelay();
	const a = await seeded(relay);
	const engines: LogEngine[] = [a];
	try {
		const port = failingBatches(relay, 2);
		const { engine: b } = await startTestEngine({ relay: port, deviceId: "dev-b", tuning: { checkpoint: NO_CKPT } });
		engines.push(b);
		await converged([a, b], 15_000);
		assert.ok(port.failed >= 2, "the first batches failed");
		assert.ok(b.c.sess.stats.readFailures >= 1);
		assert.equal(b.listDocs().length, DOCS);
		assert.equal(b.status().phase, "live");
	} finally {
		for (const e of engines) await e.stop();
	}
});
