import assert from "node:assert/strict";
import { test } from "node:test";
import { SimRelay } from "../../sim/relay";
import { OPEN_FRAME_MAX_MS } from "../../core/limits";
import { converged, sleep, startTestEngine, until } from "./testHarness";

test("engine: two engines converge on ns + body through SimRelay", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		await until(() => a.status().phase === "live" && b.status().phase === "live", 3_000, "live");
		const id = await a.createDoc("notes/one.md", "hello world");
		await converged([a, b]);
		assert.equal(await b.docText(id), "hello world");
		assert.equal(b.listDocs().find((d) => d.docId === id)?.path, "notes/one.md");

		await b.editDoc(id, (t) => t.insert(t.length, " from b"));
		await a.editDoc(id, (t) => t.insert(0, "A: "));
		await converged([a, b]);
		assert.equal(await a.docText(id), "A: hello world from b");

		await a.renameDoc(id, "notes/renamed.md");
		await converged([a, b]);
		assert.equal(b.listDocs().find((d) => d.docId === id)?.path, "notes/renamed.md");

		const s = a.status();
		assert.equal(s.counts.outboxFrames, 0);
		assert.equal(s.vaultSeq, relay.head());
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("engine: a no-op editor change (retain only) produces no frame and keeps the body version", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	try {
		await until(() => a.status().phase === "live", 3_000, "live");
		const id = await a.createDoc("n.md", "hello world");
		await a.editDoc(id, (t) => t.delete(0, 6));
		await converged([a]);
		const stream = `b:${id}` as never;
		const rows0 = relay.rows(stream).length;
		const v0 = a.c.repo.stream(stream)?.bodyVersion;
		await a.bind(id);
		assert.equal(a.boundText(id), "world");
		assert.equal(a.applyEditorChanges(id, [6]), false, "changes over another length do not fit");
		assert.equal(a.applyEditorChanges(id, [5]), true);
		await sleep(OPEN_FRAME_MAX_MS + 200);
		await converged([a]);
		assert.equal(relay.rows(stream).length, rows0, "no body row for a no-op change");
		assert.deepEqual(a.c.repo.stream(stream)?.bodyVersion, v0, "body version unchanged");
		// A real edit still goes out.
		assert.equal(a.applyEditorChanges(id, [[0, "x"], 5]), true);
		await until(() => relay.rows(stream).length === rows0 + 1, 3_000, "edit row");
		assert.equal(await a.docText(id), "xworld");
	} finally {
		await a.stop();
	}
});
