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
import { SimRelay } from "../../sim/relay";
import { converged, sleep, until } from "../runtime/testHarness";
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
		const relay = new SimRelay();
		const g = await genesis();
		await rawAppend(relay, KEYRING_STREAM, g);
		const frozen: string[] = [];
		const pin = { keys: [{ e: 1, k: K(1) }], records: [g] };
		const x = await start(relay, "dev-x", pin);
		const y = await start(relay, "dev-y", pin, { extra: { onDocFrozen: (_id, reason) => void frozen.push(reason) } });
		try {
			await live(x);
			await live(y);
			const id = await x.engine.createDoc("a.md" as VaultPath, "base;");
			await converged([x.engine, y.engine]);
			y.engine.disconnect();
			// `k` moves while y is away (a roll x applies), so y's session start reads `k` over a slow link.
			await rawAppend(relay, KEYRING_STREAM, await roll(2));
			await until(() => x.engine.status().e2ee?.sealEpoch === 2, 5_000, "x rolled");
			relay.setLink("dev-y" as DeviceId, { httpMs: 400 });
			const back = y.engine.reconnect();
			// Rows that commit while y's session start is on the wire (another device's, sealed under e1).
			let rows = 0;
			for (; y.engine.status().phase !== "live"; rows++) {
				await oldEpochFrame(relay, x.engine.streamOf(id), 1, "bodyUpdate", insert(`r${rows};`));
				await sleep(40);
			}
			await back;
			assert.ok(rows >= 5, `${rows} rows during the session start`);
			relay.setLink("dev-y" as DeviceId, {});
			await converged([x.engine, y.engine]);
			const text = await x.engine.docText(id);
			assert.equal(await y.engine.docText(id), text);
			assert.equal(text.length, "base;".length + Array.from({ length: rows }, (_, i) => `r${i};`).join("").length);
			assert.deepEqual(frozen, [], "nothing froze");
			assert.equal(y.engine.status().counts.quarantinedRows, 0);
			assert.equal(y.engine.status().counts.frozenDocs, 0);
		} finally {
			await y.engine.stop();
			await x.engine.stop();
		}
	});
});
