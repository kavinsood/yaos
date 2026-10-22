/**
 * MirrorWriter.onUnmirrored (DESIGN §e.4): a doc whose own records leave the outbox mirror (an own stale commit's
 * unsealed copy, the size limit) rests on its synced-mirror record from then on, so the writer tells the composer,
 * which writes the synced mirror at once (compose/vaultRuntime.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientFrameId, DeviceId, StreamName, VaultEpoch, VaultId } from "../../core/types";
import { createWebHash } from "../adapters/webHash";
import type { OutboxRecord } from "../store/schema";
import { MirrorWriter, type MirrorWriterCtx } from "./mirrorIo";
import { MemSideFiles } from "./testHarness";

const STREAM = "c:yOAbXIYLto__XlPYCwLsZQ";
const record = (cfid: string, stream: string, sealed: Uint8Array): OutboxRecord => ({
	clientFrameId: cfid as ClientFrameId, order: 1, stream: stream as StreamName, kind: "canvasUpdate", state: "pending", sealed, content: new Uint8Array([1]),
	authorNsSeq: 0, flags: 0, frameNo: null, keyEpoch: 1, dependsOn: null, adoptOf: null, createdAtMs: 0,
});

test("onUnmirrored fires once when a doc's own record leaves the outbox mirror (its unsealed copy), not on every write", async () => {
	// Sim suite-1 wipe/revoke/roll seed 40: a revoked device's canvas edit committed stale; its copy (unsealed) left the
	// outbox mirror while the synced mirror, a debounce behind, had no record of the doc. The store was lost in
	// between: recovery knew nothing of the doc here and put the remote canvas back at a path the user had renamed.
	let records: OutboxRecord[] = [record("cf-1", STREAM, new Uint8Array([9, 9]))];
	const c: MirrorWriterCtx = {
		outbox: { all: () => records }, ports: { hash: createWebHash(), clock: { setTimer: () => 1, clearTimer: () => undefined } },
		tuning: { mirrorDebounceMs: 1 }, opts: { vaultId: "v" as VaultId }, repo: { identity: { vaultEpoch: "e" as VaultEpoch } },
		self: "dev" as DeviceId, stopped: false, now: () => 0, diag: (code: string, f: unknown) => assert.fail(`${code} ${JSON.stringify(f)}`),
	};
	const w = new MirrorWriter(c, new MemSideFiles());
	let fired = 0;
	w.onUnmirrored = () => fired++;
	w.schedule();
	await w.flush();
	assert.equal(fired, 0, "the frame is in the mirror");
	records = [{ ...records[0]!, clientFrameId: "cf-copy" as ClientFrameId, sealed: new Uint8Array(0) }];
	w.schedule();
	await w.flush();
	assert.equal(fired, 1, "the doc left the mirror");
	w.schedule();
	await w.flush();
	assert.equal(fired, 1, "still out: nothing new");
	records = [];
	w.schedule();
	await w.flush();
	records = [record("cf-2", STREAM, new Uint8Array(0))];
	w.schedule();
	await w.flush();
	assert.equal(fired, 2, "out again after it was back");
});
