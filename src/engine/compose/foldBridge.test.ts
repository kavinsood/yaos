import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientFrameId, ContentHash, DeviceId, DocId, NsEntry, NsFoldEvent, PathKey, Seq } from "../../core/types";
import { foldEffects } from "./foldBridge";
import type { FoldedNsFrame } from "../sync/nsRuntime";

const d = (s: string): DocId => s as DocId;
type Ev = Omit<NsFoldEvent, "seq" | "deviceId" | "clientFrameId">;
const frame = (events: Ev[]): FoldedNsFrame => ({
	seq: 9 as Seq, deviceId: "X" as DeviceId, clientFrameId: "f" as ClientFrameId, ops: [],
	events: events.map((e) => ({ ...e, seq: 9 as Seq, deviceId: "X" as DeviceId, clientFrameId: "f" as ClientFrameId })),
});

test("foldEffects: a bound doc the fold pruned is retargeted by path (into null); merged aliases into their winner", () => {
	const merged: NsEntry = {
		docId: d("m"), kind: "markdown", path: "a.md", pathKey: "a.md" as PathKey, state: "merged", createdSeq: 1 as Seq, createdBy: "X" as DeviceId,
		lastTouchSeq: 5 as Seq, deletedSeq: 0 as Seq, deleteBaseBodySeq: 0 as Seq, createHash: "h" as ContentHash, createSize: 1, blob: null, aliasOf: d("w"),
	};
	const entries = new Map<DocId, NsEntry>([[d("m"), merged]]);
	const bound = new Set([d("p"), d("m"), d("pending")]);
	const fx = foldEffects({
		frames: [frame([
			{ index: -1, docId: null, outcome: { kind: "pruned", docIds: [d("p"), d("q")], entries: [] } },
			{ index: -1, docId: d("m"), outcome: { kind: "merged", into: d("w") } },
			// a bound doc with no entry that no prune named (an own create not folded yet) stays bound
			{ index: -1, docId: d("pending"), outcome: { kind: "ignored", reason: "duplicate-frame" } },
		])],
		self: "Y" as DeviceId,
		committed: (id) => entries.get(id),
		isBound: (id) => bound.has(id),
		pathKey: (p) => p as PathKey,
	});
	assert.deepEqual(fx.retarget, [{ docId: d("p"), into: null }, { docId: d("m"), into: d("w") }]);
	assert.ok(fx.docIds.has(d("q")) && fx.docIds.has(d("p")));
});
