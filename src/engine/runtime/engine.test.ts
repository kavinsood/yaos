import assert from "node:assert/strict";
import { test } from "node:test";
import { SimRelay } from "../sync/__standins__/simRelay";
import { converged, startTestEngine, until } from "./testHarness";

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
