/**
 * §12.4 "Fail closed" at engine level, over SimRelay: an unpinned or key-less device reads `k` and writes nothing
 * (no frame, no checkpoint), pinSuite0 is refused once a key record was seen, a suite-0 device that reads a genesis
 * stops without sealing, and an unverified QR key persists nothing. Keys are the testkit's fixed byte ranges.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type ClientFrameId, type DeviceId, type StreamName, type VaultId, type VaultPath } from "../../core/types";
import type { StoragePort } from "../../ports/storage";
import { SimRelay } from "../../sim/relay";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebRandom } from "../adapters/webRandom";
import type { LogEngine } from "../runtime/engine";
import { converged, startTestEngine, until } from "../runtime/testHarness";
import type { KeyringChange } from "./keyring";
import type { EngineE2ee } from "./keyringRuntime";
import { K, VAULT, genesis } from "./testkit/world";
import { KeyMissingError, KeyringRefusedError } from "./writeGate";

let raw = 0;
/** A row appended by some other party (a hostile relay, or a device this test does not run). */
async function rawAppend(relay: SimRelay, stream: StreamName, payload: Uint8Array): Promise<number> {
	const r = await relay.connect({ vaultId: VAULT as VaultId, deviceId: "dev-raw" as DeviceId });
	if (!r.ok) throw new Error(`connect: ${r.reason}`);
	const s = r.session;
	const seq = await new Promise<number>((resolve, reject) => {
		s.onEvent((ev) => {
			if (ev.t === "receipt") resolve(ev.seq);
			else if (ev.t === "refused") reject(new Error(ev.reason));
		});
		s.append({ stream, clientFrameId: `raw-${++raw}` as ClientFrameId, payload });
	});
	s.close(1000, "done");
	return seq;
}

interface Dev {
	readonly engine: LogEngine;
	readonly storage: StoragePort;
	readonly changes: KeyringChange[];
}

async function start(relay: SimRelay, deviceId: string, pin: "unpinned" | "creating" | "seen" | 0 | { keys: { e: number; k: Uint8Array }[]; records: Uint8Array[] }, storage?: StoragePort): Promise<Dev> {
	const changes: KeyringChange[] = [];
	const persist = async (ch: KeyringChange) => void changes.push({ keys: ch.keys.map((x) => ({ e: x.e, k: x.k.slice() })), records: ch.records, pending: ch.pending });
	const e2ee: EngineE2ee = pin === 0 ? { suite: 0 }
		: typeof pin === "object" ? { suite: 1, records: pin.records, persist }
		: { suite: null, creating: pin === "creating", keyringSeen: pin === "seen", persist };
	const keys = typeof pin === "object" ? pin.keys.map((x) => ({ e: x.e, k: x.k.slice() })) : [];
	const crypto = pin === 0 ? undefined : await createWebCryptoSuite1({ vaultId: VAULT, random: createWebRandom(), keys });
	const r = await startTestEngine({ relay, deviceId, vaultId: VAULT, e2ee, ...(crypto ? { crypto } : {}), ...(storage ? { storage } : {}) });
	return { engine: r.engine, storage: r.storage, changes };
}

const keyMissing = (d: Dev) => d.engine.status().e2ee?.keyMissing ?? null;
const ownRows = (relay: SimRelay, deviceId: string) => relay.streams().flatMap((s) => relay.rows(s)).filter((r) => r.deviceId === deviceId).length;
const checkpoints = (relay: SimRelay) => relay.streams().filter((s) => relay.checkpoint(s) !== null).length;

/** Waits until the device read `k` on its session and parked in key-missing for `reason`. */
async function parked(d: Dev, reason: string): Promise<void> {
	await until(() => d.engine.status().phase === "key-missing" && keyMissing(d) === reason && d.engine.isIdle(), 5_000, `key-missing ${reason}`);
}

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
		a = await start(relay, "dev-a", 0, a.storage);
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
