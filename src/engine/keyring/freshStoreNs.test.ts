/**
 * A fresh store under suite 1 and the ns fold it has not read yet (sim suite-1 seed 42, "A log busy"): A lost its
 * store, parked key-missing behind an ns checkpoint sealed under a key it did not hold, and turned live the moment
 * the key arrived, before ns was read. Onboarding then planned against an empty fold and the first frameNo
 * allocation took R = 0 (e2ee-design §8.2), so the onboarding create reused a frameNo <= R - 64 and folded as
 * ignored/replay-stale. Its receipt took it out of the outbox, its docs never entered the fold, and the body
 * frames held on it (DESIGN §e.1) waited forever.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeNsOps } from "../../core/codec/nsOps";
import { NS_DEDUPE_RING } from "../../core/limits";
import { KEYRING_STREAM, NS_STREAM, docStream, type ClientFrameId, type ContentHash, type DeviceId, type DocId, type VaultId, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { createWebRandom } from "../adapters/webRandom";
import { sealFrame } from "../ingest/envelope";
import type { LogEngine } from "../runtime/engine";
import { until, createDoc } from "../runtime/testHarness";
import { keyMissing, live, rawAppend, start, type Dev } from "./testkit/engines";
import { K, RK_A, VAULT, genesis } from "./testkit/world";

const DEV_A = "dev-a" as DeviceId;

const NS_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 10, hardRows: 1e9, hardBytes: 1e15, settleMs: 1e9, fallbackMs: 50, nsRows: 3, nsBytes: 1e9 };

const LOST_DOC = "lostTimelineDocAAAAAAA" as DocId;

/** An ns frame dev-a sealed under K_1 before it lost its store (still in flight then), at `frameNo`. */
async function lostTimelineFrame(frameNo: number) {
	const kc = await createWebCryptoSuite1({ vaultId: VAULT, random: createWebRandom(), keys: [{ e: 1, k: K(1) }] });
	kc.markVerified(1);
	kc.setSealEpoch(1);
	const clientFrameId = "lostTimelineFrameAAAAA" as ClientFrameId;
	const content = encodeNsOps([{ t: "create", docId: LOST_DOC, kind: "markdown", path: "lost.md" as VaultPath, contentHash: "0".repeat(64) as ContentHash, size: 0 }]);
	const { sealed } = await sealFrame(kc, VAULT as VaultId, { stream: NS_STREAM, deviceId: DEV_A, clientFrameId, kind: "nsOps", authorNsSeq: 0, flags: 0, frameNo, content });
	return { stream: NS_STREAM, deviceId: DEV_A, clientFrameId, payload: sealed };
}

async function pinned(relay: SimRelay) {
	const g = await genesis();
	await rawAppend(relay, KEYRING_STREAM, g);
	return { keys: [{ e: 1, k: K(1) }], records: [g] };
}

describe("fresh store, ns not read yet (suite 1)", () => {
	it("held body frames of a create the fold ignored (replay-stale) are deleted, not held for good", async () => {
		const relay = new SimRelay();
		const pin = await pinned(relay);
		const a = await start(relay, "dev-a", pin);
		try {
			await live(a);
			a.engine.c.ns.wallMs = () => 0; // the skip's NS_DEDUPE_RING part only (no wall-clock floor, e2ee-design §8.2)
			relay.pauseCommits();
			const d = await createDoc(a.engine, "three.md" as VaultPath, "body");
			const stream = docStream("markdown", d)!;
			const create = a.engine.c.outbox.ofStream(NS_STREAM)[0]!;
			assert.equal(create.frameNo, NS_DEDUPE_RING + 1, "R = 0: the vault has no ns frame of dev-a yet");
			assert.equal(a.engine.c.outbox.ofStream(stream)[0]?.state, "held");
			// A frame of dev-a's lost timeline lands first, far above: the create folds as replay-stale.
			relay.forge([await lostTimelineFrame((create.frameNo ?? 0) + NS_DEDUPE_RING)]);
			relay.resumeCommits();
			await until(() => !a.engine.c.outbox.has(create.clientFrameId), 5_000, "create receipted");
			const seq = relay.rows(NS_STREAM).find((r) => r.clientFrameId === create.clientFrameId)!.seq;
			await until(() => a.engine.c.ns.coversSeq >= seq && a.engine.isIdle(), 5_000, "create folded, engine idle");
			assert.equal(a.engine.c.ns.state.entries.get(d), undefined, "the fold ignored the create");
			assert.ok(a.engine.c.ns.state.entries.has(LOST_DOC));
			assert.equal(a.engine.c.outbox.size, 0, "its held body frame is gone");
			assert.equal(relay.rows(stream).length, 0, "and was never sent");
		} finally {
			await a.engine.stop();
		}
	});

	it("parked key-missing behind an ns checkpoint it cannot open, the device turns live only after reading ns", async () => {
		const relay = new SimRelay();
		const pin = await pinned(relay);
		const x = await start(relay, "dev-x", pin, { tuning: { checkpoint: NS_CKPT, nsCandidateModulus: 2 } });
		let y: Dev | null = null;
		try {
			await live(x);
			assert.equal(await x.engine.revokeRekey(RK_A.slice()), "won");
			for (let i = 0; i < 4; i++) await createDoc(x.engine, `n${i}.md`, "");
			await until(() => relay.checkpoint(NS_STREAM) !== null && x.engine.isIdle(), 5_000, "ns checkpoint under K_2");
			const docs = x.engine.c.ns.state.entries.size;
			let ye: LogEngine | null = null;
			let atLive: number | null = null; // ns docs at the switch to live
			y = await start(relay, "dev-y", pin, {
				extra: { onDiag: (ev) => { if (ev.code === "phase" && ev.fields.to === "live" && atLive === null && ye) atLive = ye.c.ns.state.entries.size; } },
			});
			ye = y.engine;
			await until(() => keyMissing(y!) === "revoked-epoch" && y!.engine.status().phase === "key-missing" && y!.engine.isIdle(), 5_000, "y parked");
			assert.equal(y.engine.c.ns.state.entries.size, 0, "the ns checkpoint waits for K_2");
			const k2 = x.changes.flatMap((c) => c.keys).find((k) => k.e === 2)!.k;
			assert.equal(await y.engine.installKeyQr(2, k2.slice()), "verified");
			await live(y);
			assert.equal(atLive, docs, "live (the host's nsCaughtUp) only once the ns fold has the vault's docs");
		} finally {
			await y?.engine.stop();
			await x.engine.stop();
		}
	});
});
