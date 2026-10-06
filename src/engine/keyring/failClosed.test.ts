/**
 * §12.4 "Fail closed" at engine level, over SimRelay: an unpinned or key-less device reads `k` and writes nothing
 * (no frame, no checkpoint), pinSuite0 is refused once a key record was seen, a suite-0 device that reads a genesis
 * stops without sealing, and an unverified QR key persists nothing. Keys are the testkit's fixed byte ranges.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { checkpoints, keyMissing, ownRows, parked, rawAppend, start, type Dev } from "./testkit/engines";
import { K, genesis } from "./testkit/world";
import { KeyMissingError, KeyringRefusedError } from "./writeGate";

async function assertWritesNothing(relay: SimRelay, d: Dev, deviceId: string): Promise<void> {
	const head = relay.head();
	await assert.rejects(d.engine.createDoc("x.md" as VaultPath, "secret"), KeyMissingError);
	await new Promise((r) => setTimeout(r, 300)); // maintenance and the sender run many times over FAST_TUNING
	assert.equal(relay.head(), head, "nothing appended");
	assert.equal(ownRows(relay, deviceId), 0);
	assert.equal(checkpoints(relay), 0, "no checkpoint");
	assert.equal(d.changes.length, 0, "nothing persisted");
}

describe("fail closed (§12.4)", () => {
	it("a key-less join with an empty k at head 0 stays blocked (no-pin) and writes nothing; pinSuite0 {link} is allowed", async () => {
		const relay = new SimRelay();
		const b = await start(relay, "dev-b", "unpinned");
		try {
			await parked(b, "no-pin");
			await assertWritesNothing(relay, b, "dev-b");
			b.engine.pinSuite0("link");
			assert.throws(() => b.engine.pinSuite0("create"), KeyringRefusedError, "not started on the creation path");
			assert.equal(relay.head(), 0);
		} finally {
			await b.engine.stop();
		}
	});

	it("a key-less join at head > 0 (a suite-0 vault, empty k) reads only k and writes nothing", async () => {
		const relay = new SimRelay();
		const a = await start(relay, "dev-a", 0);
		await until(() => a.engine.status().phase === "live", 5_000, "a live");
		await a.engine.createDoc("a.md" as VaultPath, "plain");
		await converged([a.engine]);
		await a.engine.stop();
		const head = relay.head();
		assert.ok(head > 0);
		const b = await start(relay, "dev-b", "unpinned");
		try {
			await parked(b, "no-pin");
			assert.deepEqual(b.engine.listDocs(), [], "ns is not read while unpinned");
			await assertWritesNothing(relay, b, "dev-b");
			assert.equal(relay.head(), head);
		} finally {
			await b.engine.stop();
		}
	});

	it("pinSuite0 is refused once keyringSeen is stored, and once k shows a record (encrypted-vault)", async () => {
		const relay = new SimRelay();
		const seen = await start(relay, "dev-s", "seen");
		try {
			await parked(seen, "encrypted-vault");
			assert.throws(() => seen.engine.pinSuite0("link"), KeyringRefusedError);
		} finally {
			await seen.engine.stop();
		}
		await rawAppend(relay, KEYRING_STREAM, await genesis());
		const b = await start(relay, "dev-b", "unpinned");
		try {
			await parked(b, "encrypted-vault");
			assert.equal(b.engine.status().e2ee?.keyringSeen, true);
			assert.throws(() => b.engine.pinSuite0("link"), KeyringRefusedError);
			await assertWritesNothing(relay, b, "dev-b");
		} finally {
			await b.engine.stop();
		}
	});

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

	it("an unverified QR key persists nothing; once k shows its record it is handed to main, and the pin stays main's", async () => {
		const relay = new SimRelay();
		const b = await start(relay, "dev-b", "unpinned");
		try {
			await parked(b, "no-pin");
			assert.equal(await b.engine.installKeyQr(1, K(1)), "pending");
			assert.equal(b.changes.length, 0);
			await assertWritesNothing(relay, b, "dev-b");
			await rawAppend(relay, KEYRING_STREAM, await genesis());
			await until(() => b.changes.length > 0, 5_000, "persist");
			assert.deepEqual(b.changes.flatMap((c) => c.keys.map((x) => x.e)), [1]);
			assert.equal(keyMissing(b), "encrypted-vault", "still unpinned: main pins suite 1 and restarts");
			assert.equal(ownRows(relay, "dev-b"), 0);
		} finally {
			await b.engine.stop();
		}
	});
});
