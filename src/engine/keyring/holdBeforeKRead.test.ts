/**
 * e2ee-design §14.3 / DESIGN §d.6: a reconnecting suite-1 device judges nothing before its session's `k` read.
 * Live rows that arrive while that read is on the wire are left stale (read after it), not gated "hold": a hold
 * then would quarantine and freeze the doc, and the quarantine could land after the session start's retry and
 * stay frozen until the next session. Found by the E7 suite-1 sim (DEFAULT_FAULTS seed 157: a body frozen
 * `keyring-hold` with `k` complete and nothing left to retry it).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { KEYRING_STREAM, type DeviceId, type VaultPath } from "../../core/types";
import { VirtualClock } from "../../sim/clock";
import { SIM_IDLE_ONLY_GROUP_COMMIT, SimRelay } from "../../sim/relay";
import { converged, drive, sleep, until, createDoc, docText } from "../runtime/testHarness";
import { live, oldEpochFrame, rawAppend, start } from "./testkit/engines";
import { K, genesis, roll } from "./testkit/world";

/** A concurrent insert, as an update of its own doc. */
function insert(text: string): Uint8Array {
	const d = new Y.Doc();
	d.getText("text").insert(0, text);
	return Y.encodeStateAsUpdate(d);
}

describe("live rows before the session's k read (§14.3)", () => {
	it("are read after it: no keyring-hold quarantine, no freeze", async () => {
		// Opt-out: needs >= 5 commits inside one slow session start; the server's 1000 ms commit floor allows ~1.
		const clock = new VirtualClock();
		const run = <T>(p: Promise<T>): Promise<T> => drive(p, clock);
		const relay = new SimRelay({ clock, groupCommit: SIM_IDLE_ONLY_GROUP_COMMIT });
		const g = await genesis();
		await run(rawAppend(relay, KEYRING_STREAM, g));
		const frozen: string[] = [];
		const pin = { keys: [{ e: 1, k: K(1) }], records: [g] };
		const x = await start(relay, "dev-x", pin, { clock });
		const y = await start(relay, "dev-y", pin, { clock, extra: { onDocFrozen: (_id, reason) => void frozen.push(reason) } });
		try {
			await live(x, clock);
			await live(y, clock);
			const id = await run(createDoc(x.engine, "a.md" as VaultPath, "base;"));
			await converged([x.engine, y.engine], 8_000, clock);
			y.engine.disconnect();
			// `k` moves while y is away (a roll x applies), so y's session start reads `k` over a slow link.
			await run(rawAppend(relay, KEYRING_STREAM, await roll(2)));
			await until(() => x.engine.status().e2ee?.sealEpoch === 2, 5_000, "x rolled", clock);
			relay.setLink("dev-y" as DeviceId, { httpMs: 400 });
			// y's `k` page lands 1 s late: the window, between `k` arriving and being judged, where a body read issued
			// after it can land first (on the real clock: WebCrypto and IndexedDB time; here explicit, so it is the same
			// on every host).
			relay.setReadDelay((d, streams) => (d === "dev-y" && streams.includes(KEYRING_STREAM) ? 1_000 : 0));
			const back = y.engine.reconnect();
			// Rows that commit while y's session start is on the wire (another device's, sealed under e1).
			let rows = 0;
			for (; y.engine.status().phase !== "live"; rows++) {
				await run(oldEpochFrame(relay, x.engine.streamOf(id), 1, "bodyUpdate", insert(`r${rows};`), 0, clock));
				await sleep(40, clock);
			}
			await run(back);
			assert.ok(rows >= 5, `${rows} rows during the session start`);
			relay.setLink("dev-y" as DeviceId, {});
			relay.setReadDelay(null);
			await converged([x.engine, y.engine], 8_000, clock);
			const text = await docText(x.engine, id);
			assert.equal(await docText(y.engine, id), text);
			assert.equal(text.length, "base;".length + Array.from({ length: rows }, (_, i) => `r${i};`).join("").length);
			assert.deepEqual(frozen, [], "nothing froze");
			assert.equal(y.engine.status().counts.quarantinedRows, 0);
			assert.equal(y.engine.status().counts.frozenDocs, 0);
		} finally {
			await run(y.engine.stop());
			await run(x.engine.stop());
		}
	});
});
