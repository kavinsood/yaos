/** gateRow's §14.3 rows (e2ee-design §9.3): stale ns/cfg fold as empty, stale bodies are accounted only, hold waits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CFG_STREAM, NS_STREAM, type ClientFrameId, type DeviceId, type StreamName, type VaultId } from "../../core/types";
import { encodeOuter } from "../../core/codec/envelope";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import type { GateCtx } from "../ingest/gate";
import { gateRow } from "./ingestRow";
import { LOCAL_FLAG_STALE_EPOCH, LOCAL_FLAG_UNOPENED } from "./foldRuntime";

const hash = createWebHash();
const ctx: GateCtx = { crypto: createNoopCrypto(hash), vaultId: "v1" as VaultId, maxCheckpointStateBytes: 1 << 20, staleCheck: (e) => (e === 9 ? "hold" : e < 3 ? "stale" : null) };
const under = (e: number) => encodeOuter({ formatVersion: 1, suite: 1, keyEpoch: e }, new Uint8Array(48).fill(5));
const at = (stream: StreamName, e: number) => gateRow(ctx, hash, { stream, seq: 11, deviceId: "dev-x" as DeviceId, clientFrameId: "cf" as ClientFrameId, payload: under(e) }, 0);

test("gateRow: stale ns/cfg rows are stored flagged and empty, frameNo 0; stale body/canvas/x are accounted only", async () => {
	for (const [stream, kind] of [[NS_STREAM, "nsOps"], [CFG_STREAM, "cfgOps"]] as const) {
		const r = await at(stream, 2);
		assert.ok(r.t === "row");
		assert.equal(r.row.kind, kind);
		assert.equal(r.row.flags, LOCAL_FLAG_STALE_EPOCH);
		assert.equal(r.row.frameNo, 0, "never touches the replay window");
		assert.equal(r.row.content.length, 0);
	}
	for (const s of ["b:doc1", "c:doc2", "x:blob"]) assert.deepEqual(await at(s as StreamName, 2), { t: "account" }, `${s}: no quarantine, no freeze`);
});

test("gateRow: hold keeps ns rows unopened (raw payload, the fold halts) and quarantines bodies as keyring-hold", async () => {
	const ns = await at(NS_STREAM, 9);
	assert.ok(ns.t === "row" && ns.row.flags === LOCAL_FLAG_UNOPENED);
	assert.deepEqual(ns.row.content, under(9));
	const body = await at("b:doc1" as StreamName, 9);
	assert.ok(body.t === "quarantine" && body.rec.reason === "keyring-hold");
});
