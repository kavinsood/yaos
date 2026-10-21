/**
 * Edits while the write gate is shut (e2ee-design §9.3): the open frame cannot close, so its updates are held in
 * the builder; every FRAME_MAX_UPDATES they are merged (memory follows the bytes typed). The gate opening closes the
 * frame and the held text reaches the relay.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_MAX_UPDATES, OPEN_FRAME_MAX_MS } from "../../core/limits";
import type { KeyMissingReason } from "../../protocol/status";
import { SimRelay } from "../../sim/relay";
import { ORIGIN } from "../body/yjsCounters";
import { VirtualClock } from "../../sim/clock";
import { converged, createDoc, docText, drive, sleep, startTestEngine, until } from "./testHarness";

test("write gate shut: keystrokes are held merged (never FRAME_MAX_UPDATES buffers); gate open sends them all", async () => {
	// Virtual time: "held while shut" is checked once the open frame's close timer would have fired many times over
	// (OPEN_FRAME_MAX_MS), not after a real 50 ms sleep that a loaded machine stretches arbitrarily.
	const clock = new VirtualClock();
	const run = <T>(p: Promise<T>): Promise<T> => drive(p, clock);
	const relay = new SimRelay({ clock });
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", clock });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", clock });
	try {
		await until(() => a.status().phase === "live" && b.status().phase === "live", 3_000, "live", clock);
		const id = await run(createDoc(a, "held.md", ""));
		await converged([a, b], 8_000, clock);
		const open = a.c.gate;
		const shut = (): KeyMissingReason | null => "revoked-epoch";
		Object.defineProperty(a.c, "gate", { value: shut, configurable: true, writable: true });
		const h = await run(a.c.handles.acquire(a.streamOf(id)));
		const n = 3 * FRAME_MAX_UPDATES + 7;
		let maxHeld = 0;
		try {
			for (let i = 0; i < n; i++) {
				h.doc.transact(() => h.doc.getText("text").insert(i, "k"), ORIGIN.MERGE);
				maxHeld = Math.max(maxHeld, h.builder.count);
			}
			await sleep(10 * OPEN_FRAME_MAX_MS, clock);
			assert.ok(!h.builder.empty, "held while shut");
			assert.ok(maxHeld <= FRAME_MAX_UPDATES, `held ${maxHeld} buffers`);
			assert.ok(h.builder.count < FRAME_MAX_UPDATES);
		} finally {
			a.c.handles.unpin(h);
		}
		Object.defineProperty(a.c, "gate", { value: open, configurable: true, writable: true });
		await run(a.c.docs.closeFrame(h));
		await converged([a, b], 8_000, clock);
		assert.equal(await run(docText(b, id)), "k".repeat(n));
	} finally {
		await run(a.stop());
		await run(b.stop());
	}
});
