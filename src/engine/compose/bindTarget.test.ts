import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SimNet } from "../../sim/net";
import type { DocId, LocalEntry, PathKey, RemoteBodyInfo, RemoteEntry, StreamName } from "../../core/types";
import { EMPTY_CONTENT_HASH } from "../../core/plan/planner";
import { bindTarget, type BindTargetRuntime } from "./runtimeOps";
import type { SyncedRecord } from "../store/schema";

function world(): { clock: VirtualClock; a: SimDevice; b: SimDevice } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	return { clock, a: new SimDevice({ name: "A", clock, net }), b: new SimDevice({ name: "B", clock, net }) };
}

test("openDoc: a path the remote moved a doc onto, holding a file of this device's the mover never saw, does not bind that doc", async () => {
	const { clock, a, b } = world();
	a.vault.userWrite("n2.md", "two\n");
	a.vault.userWrite("n6.md", "six\n");
	void a.start();
	void b.start();
	await clock.advance(5_000);
	assert.equal(b.vault.textOf("n6.md"), "six\n");
	// A restarts offline: its ns is not caught up, so its own rename below is not submitted until it reconnects.
	a.setOnline(false);
	a.crashApp();
	await clock.advance(100);
	void a.restartApp();
	a.setOnline(false);
	await clock.advance(2_000);
	assert.ok(b.vault.userRename("n6.md", "r7.md"));
	await clock.advance(2_000);
	assert.ok(a.vault.userRename("n2.md", "r7.md"));
	await clock.advance(1_000);
	const v = a.workspace.openFile("r7.md");
	assert.ok(v);
	await clock.advance(500);
	// On reconnect A learns that n6's doc moved to r7.md before it learns its own rename lost the path.
	a.setOnline(true);
	await clock.advance(20_000);
	for (const d of [a, b]) {
		assert.equal(d.vault.textOf("r7.md"), "six\n", d.name);
		assert.equal(d.vault.textOf("r7 (2).md"), "two\n", d.name);
	}
	assert.equal(v.path, "r7 (2).md");
	assert.equal(v.getText(), "two\n");
});

test("bindTarget: a doc whose delete waits (fileGone) does not bind at its synced path; at its remote path the file is its own", () => {
	const live = (docId: string, path: string) => ({ docId, path, pathKey: path, state: "live", createHash: "h0", body: { hasContent: true, caughtUp: true, version: { remoteSeq: 1, localOrder: 0 } } });
	const fake = (remote: ReturnType<typeof live>[], synced: { docId: string; pathKey: string; fileGone?: true }[], local: string[]) => {
		const s = new Map(synced.map((e) => [e.docId, e]));
		return {
			port: { view: () => ({ remote: new Map(remote.map((r) => [r.docId, r])), remoteByPathKey: new Map(remote.map((r) => [r.pathKey, r.docId])) }) },
			rec: { ctx: { synced: (id: string) => s.get(id), local: new Map(local.map((k) => [k, {}])), store: { synced: s } } },
		} as never;
	};
	// gone at a.md, the doc still live there: a file at a.md is new
	assert.equal(bindTarget(fake([live("d1", "a.md")], [{ docId: "d1", pathKey: "a.md", fileGone: true }], ["a.md"]), "a.md" as never), undefined);
	// gone at a.md, the doc moved to b.md (an own rename marked offline): the file at b.md is the doc's, a new file at a.md does not block it
	const moved = fake([live("d1", "b.md")], [{ docId: "d1", pathKey: "a.md", fileGone: true }], ["a.md", "b.md"]);
	assert.equal(bindTarget(moved, "b.md" as never)?.docId, "d1");
	// not gone: the doc's file still at a.md blocks the bind at b.md (the planner has not moved it yet)
	const notGone = fake([live("d1", "b.md")], [{ docId: "d1", pathKey: "a.md" }], ["a.md", "b.md"]);
	assert.equal(bindTarget(notGone, "b.md" as never), undefined);
});

/**
 * bindTarget (DESIGN §d.2), create content: a view does not bind while the replica lacks the create's content.
 * `hasContent` also counts body rows the relay announced but this device has not applied, so it alone is not enough: sim seed 23
 * (BLOB_FAULTS, sim-pipeline) bound a view to a §c.5 merged alias whose synced record
 * restarts at the winner's create while the winner's frames were announced, not applied. The bind-time merge read
 * the empty replica against that base as a deletion, emptied the editor, and its save destroyed the note.
 */
const KEY = "notes/a.md" as PathKey;
const DOC = "doc-a" as DocId;

function entry(body: Partial<RemoteBodyInfo>, createHash = "c".repeat(64)): RemoteEntry {
	return {
		docId: DOC, kind: "markdown", path: KEY as never, pathKey: KEY, state: "live", lastTouchSeq: 1, deletedSeq: 0, deleteBaseBodySeq: 0,
		createHash: createHash as never, blob: null, aliasOf: null, pendingLocal: false,
		body: { stream: `b:${DOC}` as StreamName, version: { remoteSeq: 0, localOrder: 0 }, caughtUp: true, hasContent: true, frozen: false, ...body },
	};
}

function rt(e: RemoteEntry): BindTargetRuntime {
	const view = { remote: new Map([[DOC, e]]), remoteByPathKey: new Map([[KEY, DOC]]) };
	const ctx = { synced: () => undefined, local: new Map<PathKey, LocalEntry>(), store: { synced: new Map<DocId, SyncedRecord>() } };
	return { port: { view: () => view }, rec: { ctx } };
}

const binds = (body: Partial<RemoteBodyInfo>, createHash?: string): boolean => bindTarget(rt(entry(body, createHash)), KEY) !== undefined;

test("bindTarget: binds a caught-up doc with content", () => {
	assert.equal(binds({}), true);
});

test("bindTarget: waits while the create's frames are not here (no content)", () => {
	assert.equal(binds({ hasContent: false }), false);
	assert.equal(binds({ hasContent: false, caughtUp: false }), false);
});

test("bindTarget: waits while the create's rows are announced but none applied (seed 23)", () => {
	assert.equal(binds({ hasContent: true, caughtUp: false }), false);
});

test("bindTarget: binds a doc behind on rows once some content is applied or produced here", () => {
	assert.equal(binds({ caughtUp: false, version: { remoteSeq: 7, localOrder: 0 } }), true);
	assert.equal(binds({ caughtUp: false, version: { remoteSeq: 0, localOrder: 3 } }), true);
});

test("bindTarget: an empty create binds without content", () => {
	assert.equal(binds({ hasContent: false, caughtUp: false }, EMPTY_CONTENT_HASH), true);
});
