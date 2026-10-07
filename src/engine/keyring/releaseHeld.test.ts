/**
 * DESIGN §d.6 / e2ee-design §14.3: a user release (`releaseQuarantine`) dismisses what fails its re-gate, but a row
 * that re-gates `keyring-hold` has not failed: it waits for this session's `k` to be judged to its seq, and opens
 * (or is found stale) once it is. Dismissing it lost a genuine row at this reader. Found by the E7 suite-1 sim
 * (E2EE_FAULTS, 4 devices, seed 37: a release while a replayed `k` row was still unjudged dismissed another
 * device's frame under the current key).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { live, rawAppend, start } from "./testkit/engines";
import { K, genesis } from "./testkit/world";

describe("releaseQuarantine and keyring-hold rows (§d.6, §14.3)", () => {
	it("a held row is kept, not dismissed; it opens once k is judged, and the doc unfreezes", async () => {
		const relay = new SimRelay();
		const g = await genesis();
		await rawAppend(relay, KEYRING_STREAM, g);
		const pin = { keys: [{ e: 1, k: K(1) }], records: [g] };
		const x = await start(relay, "dev-x", pin);
		const y = await start(relay, "dev-y", pin);
		try {
			await live(x);
			await live(y);
			const id = await x.engine.createDoc("a.md" as VaultPath, "base;");
			await converged([x.engine, y.engine]);
			const stream = x.engine.streamOf(id);
			// y's `k` is not judged past what it has (a `k` row arrived and is not read yet): rows above it are held.
			const ctx = y.engine.c.gateCtx;
			const judged = ctx.staleCheck;
			ctx.staleCheck = () => "hold";
			for (let i = 0; i < 2; i++) await x.engine.editDoc(id, (t) => t.insert(t.length, `h${i};`));
			await until(() => y.engine.c.repo.stream(stream)?.quarantinedRows === 2, 5_000, "held");
			assert.equal(y.engine.c.repo.stream(stream)?.frozen, 1);

			assert.deepEqual(await y.engine.releaseQuarantine(stream), { passed: 0, dismissed: 0 }, "nothing failed");
			const kept = (await y.engine.c.repo.quarantineOf(stream)).filter((q) => !q.detail.startsWith("dismissed:"));
			assert.deepEqual(kept.map((q) => q.reason), ["keyring-hold", "keyring-hold"], "the held rows are kept whole");
			assert.equal(y.engine.c.repo.stream(stream)?.frozen, 1, "still frozen: its rows are not applied yet");

			ctx.staleCheck = judged; // `k` judged
			assert.equal(await y.engine.retryQuarantine(), 1);
			assert.equal(y.engine.c.repo.stream(stream)?.frozen, 0);
			await converged([x.engine, y.engine]);
			assert.equal(await y.engine.docText(id), "base;h0;h1;");
			assert.equal(y.engine.status().counts.quarantinedRows, 0);
		} finally {
			await y.engine.stop();
			await x.engine.stop();
		}
	});
});
