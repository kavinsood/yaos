/**
 * WP-E7 open question (a): "a reseal does not hold the later frames of its stream" (e2ee-design §14.2 step 4, §8.2).
 *
 * The revoking device sends an own ns (or cfg) frame F under K_1 while its revoke is in flight; F commits past
 * S_rot, so readers ignore it and the author sends a copy of F under r. The device's next own frame F+1 of the same
 * stream is sealed under r at once. The ns and cfg folds apply one author's ops in seq order (a rename by docId, an
 * LWW register), so the copy must commit before F+1, or F's older op overwrites F+1 on every device. The replay
 * window itself accepts either order (the copy stays in the send window, §8.2).
 *
 * Over SimRelay: every device (the author, a re-keyed peer, and a fresh device reading from scratch) ends with F+1's
 * value, and the relay holds the copy before F+1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonRegisterKey } from "../../core/cfg/fold";
import { decodeOuter } from "../../core/codec/envelope";
import { CFG_STREAM, KEYRING_STREAM, NS_STREAM, type ConfigRelPath, type DocId, type StreamName, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "../runtime/engine";
import { converged, until } from "../runtime/testHarness";
import { keyMissing, live, rawAppend, start, stored, type Dev } from "./testkit/engines";
import { K, RK_A, genesis } from "./testkit/world";

const APP = "app.json" as ConfigRelPath;

const epochOf = (payload: Uint8Array) => {
	const d = decodeOuter(payload);
	return d.ok ? d.header.keyEpoch : -1;
};
/** Header epochs of `deviceId`'s rows of `stream` past `seq`, in seq order. */
const epochsPast = (relay: SimRelay, stream: StreamName, deviceId: string, seq: number) =>
	relay.rows(stream).filter((r) => r.deviceId === deviceId && r.seq > seq).map((r) => epochOf(r.payload));
const k2Of = (d: Dev) => d.changes.flatMap((c) => c.keys).find((k) => k.e === 2)!.k;
const pathOf = (e: LogEngine, id: DocId) => e.listDocs().find((d) => d.docId === id)?.path;
const cfgValue = (e: LogEngine) => e.cfgView().json.get(jsonRegisterKey(APP, "k"))?.value ?? null;

async function pair(relay: SimRelay, ...ids: string[]): Promise<Dev[]> {
	const g = await genesis();
	await rawAppend(relay, KEYRING_STREAM, g);
	const devs = await Promise.all(ids.map((id) => start(relay, id, { keys: [{ e: 1, k: K(1) }], records: [g] })));
	for (const d of devs) await live(d);
	return devs;
}

/**
 * x revokes; `first` (sealed under K_1) rides behind the revoke and commits stale; `second` is written as soon as
 * the revoke won (sealed under r). y re-keys by QR; z is a fresh device reading the whole log.
 */
async function scenario(stream: StreamName, setup: (x: LogEngine) => Promise<void>, first: (x: LogEngine) => Promise<unknown>, second: (x: LogEngine) => Promise<unknown>, check: (e: LogEngine, who: string) => void): Promise<void> {
	const relay = new SimRelay();
	const [x, y] = await pair(relay, "dev-x", "dev-y");
	let z: Dev | null = null;
	try {
		await setup(x!.engine);
		await converged([x!.engine, y!.engine]);
		relay.pauseCommits();
		const won = x!.engine.revokeRekey(RK_A.slice());
		await until(() => relay.pendingCount() === 1, 5_000, "the revoke is in flight");
		await first(x!.engine);
		await until(() => relay.pendingCount() === 2, 5_000, "x's first frame behind it");
		relay.resumeCommits();
		assert.equal(await won, "won");
		await second(x!.engine);
		const sRot = relay.rows(KEYRING_STREAM)[1]!.seq;
		await until(() => keyMissing(y!) === "revoked-epoch", 5_000, "y read the revoke");
		assert.equal(await y!.engine.installKeyQr(2, k2Of(x!).slice()), "verified");
		await until(() => x!.engine.c.outbox.size === 0 && y!.engine.c.outbox.size === 0, 8_000, "outboxes drained");
		await converged([x!.engine, y!.engine], 8_000);
		// The scenario happened: the first frame committed stale under K_1, then two rows under r (copy and second).
		assert.deepEqual(epochsPast(relay, stream, "dev-x", sRot), [1, 2, 2], "stale first frame, then the copy and the second frame under r");
		z = await start(relay, "dev-z", stored(x!, { keys: [{ e: 1, k: K(1) }], records: [] }));
		await live(z);
		await converged([x!.engine, y!.engine, z.engine], 8_000);
		check(x!.engine, "author");
		check(y!.engine, "re-keyed peer");
		check(z.engine, "fresh device");
		for (const d of [x!, y!, z]) assert.equal(d.engine.status().counts.quarantinedRows, 0);
	} finally {
		await z?.engine.stop();
		await y!.engine.stop();
		await x!.engine.stop();
	}
}

describe("a reseal holds the later frames of its stream (§14.2 step 4, §8.2)", () => {
	it("ns: a rename written after the revoke won is not undone by the copy of the stale rename before it", async () => {
		let id: DocId | null = null;
		await scenario(
			NS_STREAM,
			async (x) => void (id = await x.createDoc("a.md" as VaultPath, "base")),
			(x) => x.renameDoc(id!, "b.md" as VaultPath),
			(x) => x.renameDoc(id!, "c.md" as VaultPath),
			(e, who) => assert.equal(pathOf(e, id!), "c.md", `${who}: the last own rename wins`),
		);
	});

	it("cfg: a value written after the revoke won is not overwritten by the copy of the stale value before it", async () => {
		await scenario(
			CFG_STREAM,
			(x) => x.submitCfg([{ t: "jsonSet", file: APP, key: "k", valueJson: "0" }]).then(() => undefined),
			(x) => x.submitCfg([{ t: "jsonSet", file: APP, key: "k", valueJson: "1" }]),
			(x) => x.submitCfg([{ t: "jsonSet", file: APP, key: "k", valueJson: "2" }]),
			(e, who) => assert.equal(cfgValue(e), "2", `${who}: the last own value wins`),
		);
	});
});
