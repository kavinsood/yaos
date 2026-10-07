import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintRef } from "../core/hash/testkit/hashRef";
import type { EngineResultValue } from "../protocol/messages";
import { simHashOracle } from "../sim/hash";
import { engineHashOracle, MAX_BATCH_BYTES, MAX_BATCH_ITEMS, type HashRequestBody } from "./hashOracle";

test("engineHashOracle: bounded batches, sent one at a time, answers in order, bytes owned for transfer", async () => {
	const sent: HashRequestBody[] = [];
	let inFlight = 0;
	const request = async (body: HashRequestBody): Promise<EngineResultValue> => {
		assert.equal(++inFlight, 1, "one batch in flight");
		sent.push(body);
		await new Promise((r) => setTimeout(r, 1));
		inFlight--;
		for (const it of body.items) assert.equal(it.bytes.byteOffset === 0 && it.bytes.byteLength === it.bytes.buffer.byteLength, true);
		return { t: "hashes", values: body.items.map((it) => ({ hash: `${it.path}:${it.want}`, textLength: it.bytes.byteLength })) };
	};
	const oracle = engineHashOracle(request);
	const big = new Uint8Array(MAX_BATCH_BYTES - 10);
	const shared = new Uint8Array(32);
	const items = [
		{ path: "big.bin", want: "fingerprint" as const, bytes: big },
		{ path: "view.md", want: "contentHash" as const, bytes: shared.subarray(4, 20) }, // not owned: copied
		...Array.from({ length: MAX_BATCH_ITEMS + 3 }, (_, i) => ({ path: `n${i}.md`, want: "fingerprint" as const, bytes: new Uint8Array(1) })),
	];
	const out = await oracle.hash(items);
	assert.deepEqual(out.map((v) => v.hash), items.map((it) => `${it.path}:${it.want}`));
	assert.equal(out[1]!.textLength, 16);
	assert.deepEqual(sent.map((b) => b.items.length), [1, MAX_BATCH_ITEMS, 4], "byte bound splits after big; count bound after 64");
	for (const b of sent) assert.ok(b.items.length === 1 || b.items.reduce((n, it) => n + it.bytes.byteLength, 0) <= MAX_BATCH_BYTES);
	assert.deepEqual(await oracle.hash([]), []);
});

test("engineHashOracle rejects on a wrong answer or a stopped engine", async () => {
	const item = { path: "a.md", want: "fingerprint" as const, bytes: new Uint8Array([1]) };
	await assert.rejects(engineHashOracle(async () => ({ t: "ok" })).hash([item]), /unexpected hashRequest answer/);
	await assert.rejects(engineHashOracle(async () => ({ t: "hashes", values: [] })).hash([item]), /unexpected/);
	await assert.rejects(engineHashOracle(() => Promise.reject(new Error("engine not running"))).hash([item]), /not running/);
});

test("simHashOracle answers like the engine and moves owned buffers like a transfer", async () => {
	const bytes = new TextEncoder().encode("hello");
	const [v] = await simHashOracle().hash([{ path: "a.md", want: "fingerprint", bytes }]);
	assert.deepEqual(v, { hash: fingerprintRef(new TextEncoder().encode("hello")), textLength: 5 });
	assert.equal(bytes.byteLength, 0, "detached");
});
