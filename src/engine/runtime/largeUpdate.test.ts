/**
 * Large updates end to end through SimRelay (DESIGN §b.6, §j.1; §k.3 WP-C #3):
 * > MAX_INLINE_UPDATE_BYTES -> x: chunks + held bodyUpdateRef, resolved by live
 * peers, bound views and fresh catch-up; > MAX_LOG_BLOB_BYTES without a blob
 * store -> oversize-local freeze with the replica reloaded from durable state.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { BLOB_CHUNK_BYTES, MAX_INLINE_UPDATE_BYTES, MAX_LOG_BLOB_BYTES } from "../../core/limits";
import { streamClass, type DocId } from "../../core/types";
import { SimRelay } from "../sync/__standins__/simRelay";
import type { LogEngine } from "./engine";
import { converged, sleep, startTestEngine, until } from "./testHarness";

const BUDGETS = { maxResidentBytes: 1024 * 1024 * 1024, maxResidentDocs: 64 };

async function live(...es: LogEngine[]): Promise<void> {
	await until(() => es.every((e) => e.status().phase === "live"), 3_000, "live");
}

test("large update: x: chunks + bodyUpdateRef reach a live peer, its bound view, and a fresh engine via catch-up", async () => {
	const relay = new SimRelay();
	const host = new Y.Doc();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { budgets: BUDGETS } });
	const { engine: b } = await startTestEngine({
		relay, deviceId: "dev-b",
		extra: { budgets: BUDGETS, onDocUpdate: (_id: DocId, u: Uint8Array) => Y.applyUpdate(host, u, "engine") },
	});
	let c: LogEngine | null = null;
	try {
		await live(a, b);
		const id = await a.createDoc("big.md", "seed;");
		await converged([a, b]);
		Y.applyUpdate(host, (await b.bind(id)).state, "engine");
		const big = "z".repeat(MAX_INLINE_UPDATE_BYTES + 300_000);
		await a.editDoc(id, (t) => t.insert(t.length, big));
		await converged([a, b], 15_000);
		const want = "seed;" + big;
		assert.equal(await b.docText(id), want);
		assert.equal(host.getText("text").toString(), want, "bound view got the resolved update");
		const xs = relay.streams().filter((s) => streamClass(s) === "blobchunk");
		assert.equal(xs.length, 1);
		const chunkRows = relay.rows(xs[0]!);
		assert.ok(chunkRows.length >= 2 && chunkRows.length <= Math.ceil((big.length + 64) / BLOB_CHUNK_BYTES));
		const refRow = relay.rows(a.streamOf(id)).at(-1)!;
		assert.ok(refRow.seq > chunkRows.at(-1)!.seq, "ref committed after its last chunk");
		assert.ok(refRow.payload.length < 1024, "the body row carries only the ref");
		assert.equal(a.c.outbox.size, 0);

		c = (await startTestEngine({ relay, deviceId: "dev-c", extra: { budgets: BUDGETS } })).engine;
		await converged([a, b, c], 15_000);
		assert.equal(await c.docText(id), want);
		await c.editDoc(id, (t) => t.insert(0, "C;"));
		await converged([a, b, c], 15_000);
		assert.ok((await a.docText(id)).startsWith("C;seed;zzz"));
	} finally {
		await a.stop();
		await b.stop();
		await c?.stop();
	}
});

test("oversize-local: an update > MAX_LOG_BLOB_BYTES with no blob store freezes the doc, nothing is sent, the replica reloads from durable state", async () => {
	const relay = new SimRelay();
	const frozen: string[] = [];
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { budgets: BUDGETS, onDocFrozen: (_id: DocId, r: string) => frozen.push(r) } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", extra: { budgets: BUDGETS } });
	try {
		await live(a, b);
		const id = await a.createDoc("over.md", "keep;");
		await converged([a, b]);
		const head0 = relay.head();
		await a.editDoc(id, (t) => t.insert(t.length, "o".repeat(MAX_LOG_BLOB_BYTES + 1000)));
		await until(() => a.c.repo.stream(a.streamOf(id))?.frozen === 1, 10_000, "frozen");
		const rec = a.c.repo.stream(a.streamOf(id))!;
		assert.equal(rec.frozenReason, "oversize-local");
		assert.deepEqual(frozen, ["oversize-local"]);
		assert.ok(a.status().notices.some((n) => n.code === "frozen:oversize-local"));
		await sleep(100);
		assert.equal(relay.head(), head0, "nothing appended");
		assert.equal(a.c.outbox.size, 0);
		assert.equal(await a.docText(id), "keep;", "replica = durable state (unsent update discarded)");
		await assert.rejects(a.editDoc(id, (t) => t.insert(0, "x")), /frozen/);

		assert.deepEqual(await a.releaseQuarantine(id), { passed: 0, dismissed: 0 });
		assert.equal(a.c.repo.stream(a.streamOf(id))!.frozen, 0);
		await a.editDoc(id, (t) => t.insert(0, "after;"));
		await converged([a, b]);
		assert.equal(await b.docText(id), "after;keep;");
		assert.equal(b.c.repo.stream(b.streamOf(id))!.frozen, 0, "peer never saw a dependency on unsent structs");
	} finally {
		await a.stop();
		await b.stop();
	}
});
