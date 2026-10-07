/**
 * §12.4 "Fail closed" inside a pinned engine, over SimRelay: a suite-0 device that reads a genesis stops without
 * sealing, live and after a restart. Unpinned and key-less devices never run a LogEngine (compose/pinGate.ts); their
 * tests are compose/pinGate.test.ts and compose/keyReader.test.ts. Keys are the testkit's fixed byte ranges.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { keyMissing, ownRows, parked, rawAppend, start } from "./testkit/engines";
import { genesis } from "./testkit/world";
import { KeyMissingError } from "./writeGate";

describe("fail closed (§12.4)", () => {
	it("a suite-0 device that reads a genesis stops with no seal, live and after a restart", async () => {
		const relay = new SimRelay();
		let a = await start(relay, "dev-a", 0);
		await until(() => a.engine.status().phase === "live", 5_000, "a live");
		const id = await a.engine.createDoc("a.md" as VaultPath, "plain");
		await converged([a.engine]);
		const before = ownRows(relay, "dev-a");
		await rawAppend(relay, KEYRING_STREAM, await genesis());
		try {
			await parked(a, "encrypted-vault");
			await assert.rejects(a.engine.editDoc(id, (t) => t.insert(0, "more ")), KeyMissingError);
			await new Promise((r) => setTimeout(r, 300));
			assert.equal(ownRows(relay, "dev-a"), before, "no frame after the genesis");
			assert.equal(a.engine.status().e2ee?.sealEpoch, 0);
		} finally {
			await a.engine.stop();
		}
		a = await start(relay, "dev-a", 0, { storage: a.storage });
		try {
			assert.equal(keyMissing(a), "encrypted-vault", "the stored k tail blocks before any session");
			await parked(a, "encrypted-vault");
			assert.equal(ownRows(relay, "dev-a"), before);
		} finally {
			await a.engine.stop();
		}
	});
});
