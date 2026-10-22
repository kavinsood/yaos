/**
 * deadReason (DESIGN §b.5 "retired", §c.9): a stream is retired on positive evidence only, a merged entry or a
 * record of its deleted entry's prune. A doc with no entry and no stub is never dead, however complete the fold: a body row can reach
 * the relay before its create's ns row (sim suite-1 seed 264 retired a canvas body that way and lost the canvas), a
 * stub can age out of PRUNED_STUB_CAP, and merged aliases leave none. Keeping the stream costs space, never content.
 * A device whose own fold pruned the entry keeps its delete base (StreamRecord.prunedDeleteBase): evidence as well.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId, NsEntry, NsPrunedStub, StreamName } from "../../core/types";
import { deadReason, type FoldCompleteness, type PruneEvidence } from "./retire";

const D = "doc-1" as DocId;
const rec = (cls: "body" | "canvas" | "ns" = "body") => ({ cls, docId: cls === "ns" ? null : D, remoteHeadSeq: 40, stream: "b:doc-1" as StreamName });
const COMPLETE: FoldCompleteness = { complete: true, vaultSeq: 100 };
const STUB_ONLY: NsPrunedStub = { deleteBaseBodySeq: 30, prunedSeq: 50 };
const NOTHING: PruneEvidence = { stub: undefined, keptBase: undefined };
const STUB: PruneEvidence = { stub: STUB_ONLY, keptBase: undefined };
const KEPT: PruneEvidence = { stub: undefined, keptBase: 30 };
const none = () => false;
const entry = (state: NsEntry["state"]) => ({ state }) as NsEntry;

test("deadReason: no entry and no record of a prune is not dead, even with the fold complete and caught up (a create not folded yet, an aged-out stub)", () => {
	assert.equal(deadReason(rec(), undefined, NOTHING, COMPLETE, none), null);
	assert.equal(deadReason(rec("canvas"), undefined, NOTHING, COMPLETE, none), null);
});

test("deadReason: the delete base this device's fold kept when it pruned the entry is evidence too (its stub aged out)", () => {
	assert.equal(deadReason(rec(), undefined, KEPT, COMPLETE, none), "pruned");
	assert.equal(deadReason(rec(), undefined, KEPT, { complete: false, vaultSeq: 100 }, none), null);
});

test("deadReason: a pruned-delete stub with the fold complete is pruned; an incomplete fold, a lagging cursor or a pending create is not yet", () => {
	assert.equal(deadReason(rec(), undefined, STUB, COMPLETE, none), "pruned");
	assert.equal(deadReason(rec(), undefined, STUB, { complete: false, vaultSeq: 100 }, none), null);
	assert.equal(deadReason(rec(), undefined, STUB, { complete: true, vaultSeq: 39 }, none), null);
	assert.equal(deadReason(rec(), undefined, STUB, COMPLETE, () => true), null);
});

test("deadReason: a merged entry is merged; live and deleted entries are not dead, stub or not", () => {
	assert.equal(deadReason(rec(), entry("merged"), NOTHING, { complete: false, vaultSeq: 0 }, none), "merged");
	assert.equal(deadReason(rec(), entry("live"), NOTHING, COMPLETE, none), null);
	assert.equal(deadReason(rec(), entry("deleted"), STUB, COMPLETE, none), null);
});

test("deadReason: only body and canvas streams", () => {
	assert.equal(deadReason(rec("ns"), undefined, STUB, COMPLETE, none), null);
});
