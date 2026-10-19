/**
 * DESIGN §d.5 "settling an adoptable": the commit observed with the adoptable's (deviceId, clientFrameId), live or in
 * a read page, settles it, whatever the row gates to. A row the gate only accounts (here a body row sealed under a
 * stale epoch, e2ee-design §14.3) settled the adoptable in a read page but not live: live, the adoptable waited for
 * PROVISIONAL_ADOPT_MS and was then re-sent as an own frame (re-appending what this reader just judged stale).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until, createDoc, editDoc } from "../runtime/testHarness";
import { live, rawAppend, start, type Dev } from "./testkit/engines";
import { K, genesis } from "./testkit/world";

/** x and y live; y has x's doc bound and has adopted x's provisional edit, whose commit the relay holds back. */
async function adopted(relay: SimRelay): Promise<{ x: Dev; y: Dev; stream: ReturnType<Dev["engine"]["streamOf"]> }> {
	const g = await genesis();
	await rawAppend(relay, KEYRING_STREAM, g);
	const pin = { keys: [{ e: 1, k: K(1) }], records: [g] };
	const x = await start(relay, "dev-x", pin);
	// The 60 s fallback stays out of the test's window: only a settle can remove the adoptable.
	const y = await start(relay, "dev-y", pin, { tuning: { provisionalAdoptMs: 60_000 } });
	await live(x);
	await live(y);
	const id = await createDoc(x.engine, "a.md" as VaultPath, "base;");
	await converged([x.engine, y.engine]);
	await y.engine.bind(id);
	relay.pauseCommits();
	await editDoc(x.engine, id, (t) => t.insert(t.length, "p;"));
	await until(() => y.engine.c.docs.stats.adopted === 1 && y.engine.c.adoptMap.size === 1, 5_000, "y adopted");
	return { x, y, stream: x.engine.streamOf(id) };
}

const settled = (y: Dev, why: string) => {
	const c = y.engine.c;
	assert.deepEqual([...c.outbox.values()].map((r) => r.state), [], `${why}: the adoptable settled`);
	assert.equal(c.adoptMap.size, 0);
	assert.equal(c.docs.stats.adoptToPending, 0, `${why}: not re-sent`);
};

void describe("an adoptable settles on an accounted commit (§d.5, §14.3)", () => {
	void it("live", async () => {
		const relay = new SimRelay();
		const { x, y, stream } = await adopted(relay);
		try {
			y.engine.c.gateCtx.staleCheck = () => "stale"; // y judges the commit stale: accounted, not stored
			relay.resumeCommits();
			await until(() => x.engine.isIdle(), 5_000, "x committed");
			const rows = relay.rows(stream);
			const seq = rows[rows.length - 1]!.seq;
			await until(() => y.engine.c.repo.cursor.vaultSeq >= seq && y.engine.c.live.idle, 5_000, "y ingested it live");
			settled(y, "live");
		} finally {
			await y.engine.stop();
			await x.engine.stop();
		}
	});

	void it("in a read page", async () => {
		const relay = new SimRelay();
		const { x, y, stream } = await adopted(relay);
		try {
			y.engine.disconnect();
			y.engine.c.gateCtx.staleCheck = () => "stale";
			relay.resumeCommits();
			await until(() => x.engine.isIdle(), 5_000, "x committed");
			await y.engine.reconnect();
			await until(() => y.engine.status().phase === "live" && y.engine.c.repo.stream(stream)?.stale === 0 && y.engine.c.sess.readsInFlight === 0, 5_000, "y read it");
			settled(y, "read");
		} finally {
			await y.engine.stop();
			await x.engine.stop();
		}
	});
});
