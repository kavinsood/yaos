/**
 * `releaseQuarantine{stream}` releases the stream it names (DESIGN §d.6). A merged duplicate's doc id resolves to
 * the doc it merged into, so a release that went through the doc id released the wrong stream and the frozen one
 * stayed frozen for good. Found by the E7 suite-1 sim (E2EE_FAULTS seed 15: forged rows on a merged create's stream).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyStream } from "../../core/types";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { lastStatus } from "../../sim/e2ee";
import { SimNet } from "../../sim/net";

test("releaseQuarantine releases a merged duplicate's frozen stream", async () => {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const a = new SimDevice({ name: "A", clock, net });
	const b = new SimDevice({ name: "B", clock, net });
	// The same file created on both devices before they meet: one create merges into the other (core/ns/place.ts).
	a.vault.userWrite("d.md", "same\n");
	b.vault.userWrite("d.md", "same\n");
	void a.start();
	void b.start();
	await clock.advance(10_000);
	const ns = a.vrt!.log.c.ns;
	const merged = [...ns.state.entries.values()].filter((e) => e.state === "merged");
	assert.equal(merged.length, 1, "one create merged");
	const stream = bodyStream(merged[0]!.docId);
	assert.notEqual(ns.resolve(merged[0]!.docId)?.docId, merged[0]!.docId);
	net.relay.forge([{ stream, deviceId: "dev-forger" as never, clientFrameId: "f".repeat(32) as never, payload: new Uint8Array(64).fill(0x5a) }]);
	await clock.advance(3_000);
	const frozenDocs = (d: SimDevice): number => lastStatus(d)?.counts.frozenDocs ?? -1;
	assert.deepEqual([frozenDocs(a), frozenDocs(b)], [1, 1]);
	const released = Promise.all([a, b].map((d) => d.runtime.command({ t: "releaseQuarantine", stream })));
	await clock.advance(5_000);
	assert.deepEqual((await released).map((r) => r.t), ["ok", "ok"]);
	assert.deepEqual([frozenDocs(a), frozenDocs(b)], [0, 0]);
	assert.equal(a.vault.textOf("d.md"), "same\n");
	assert.equal(b.vault.textOf("d.md"), "same\n");
});
