/**
 * Live creates (DESIGN §d.4, §e.1): a create's initial body frames are pending with dependsOn = the ns create,
 * sent right after it and committed with it; a create that folds merged away drops its unreceipted frames and
 * its committed ones stay junk on the loser's stream; a non-live create still holds its frames until the fold.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { newDocId } from "../../core/codec/ids";
import { NS_STREAM, docStream, type ContentHash, type DeviceId, type DocId, type NsOp } from "../../core/types";
import { SimRelay, type SimCommitInfo } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { converged, startTestEngine, until } from "./testHarness";

async function stopAll(...es: LogEngine[]): Promise<void> {
	for (const e of es) await e.stop();
}

function create(a: LogEngine, path: string, contentHash = "0".repeat(64)): Extract<NsOp, { t: "create" }> {
	return { t: "create", docId: newDocId(a.c.ports.random), kind: "markdown", path, contentHash: contentHash as ContentHash, size: 1 };
}

async function write(a: LogEngine, docId: DocId, text: string): Promise<void> {
	const h = (await a.openBody(docId, "markdown"))!;
	h.doc.transact(() => h.doc.getText("text").insert(0, text), h.mergeOrigin);
	await h.commitEdits();
	h.release();
}

void test("live create: body frames pending behind the create, sent right after it, one group commit, peer reads the text", async () => {
	const relay = new SimRelay();
	const commits: SimCommitInfo[] = [];
	relay.onCommit((c) => commits.push(c));
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		const op = create(a, "live.md");
		const stream = docStream("markdown", op.docId)!;
		const uncork = a.corkNs();
		const [createCfid] = await a.submitNs([op], { liveCreates: true });
		await write(a, op.docId, "first ");
		await write(a, op.docId, "second ");
		const recs = a.c.outbox.ofStream(stream);
		assert.equal(recs.length, 2);
		assert.ok(recs.every((r) => r.state === "pending" && r.dependsOn === createCfid), "pending, after the create");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(commits.length, 0, "corked: nothing sent yet");
		uncork();
		await converged([a, b]);
		assert.equal(await b.docText(op.docId), "second first ");
		const withCreate = commits.find((c) => c.frames.some((f) => f.clientFrameId === createCfid))!;
		assert.deepEqual(withCreate.frames.map((f) => f.stream), [NS_STREAM, stream, stream], "one commit: the create, then its body frames");
		assert.equal(a.c.outbox.size, 0);
	} finally {
		await stopAll(a, b);
	}
});

void test("non-live create (onboarding, first pass after start): body frames held until the create folds", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		relay.pauseCommits();
		const op = create(a, "held.md");
		const [createCfid] = await a.submitNs([op]);
		await write(a, op.docId, "body");
		const recs = a.c.outbox.ofStream(docStream("markdown", op.docId)!);
		assert.equal(recs.length, 1);
		assert.equal(recs[0]!.state, "held");
		assert.equal(recs[0]!.dependsOn, createCfid);
		relay.resumeCommits();
		await converged([a, b]);
		assert.equal(await b.docText(op.docId), "body");
	} finally {
		await stopAll(a, b);
	}
});

void test("live create merged away (§c.5 identical duplicate) with frames sent: the loser's frames never reach a doc, a's outbox drains", async () => {
	const relay = new SimRelay();
	const commits: SimCommitInfo[] = [];
	relay.onCommit((c) => commits.push(c));
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		const w = await b.createDoc("same.md", "WINNER");
		await converged([a, b]);
		const hash = b.nsView().state.entries.get(w)!.createHash;

		// 1. Frames committed with the create: junk rows on the loser's stream.
		relay.setConnectFailure("unavailable");
		relay.dropSession("dev-a" as DeviceId);
		const l1 = create(a, "same.md", hash);
		await a.submitNs([l1], { liveCreates: true });
		await write(a, l1.docId, "LOSER1");
		assert.equal(a.c.outbox.ofStream(docStream("markdown", l1.docId)!)[0]!.state, "pending");
		relay.setConnectFailure(null);
		await until(() => a.c.ns.state.entries.get(l1.docId)?.state === "merged" && a.c.outbox.size === 0, 8_000, "l1 folded merged, outbox drained");

		// 2. The create commits while a is away; its body frame (written offline) is dropped once a sees the merge.
		relay.pauseCommits();
		const l2 = create(a, "same.md", hash);
		const [c2] = await a.submitNs([l2], { liveCreates: true });
		await until(() => a.c.outbox.get(c2!)?.state === "sent", 3_000, "create sent");
		relay.setConnectFailure("unavailable");
		relay.dropSession("dev-a" as DeviceId);
		await write(a, l2.docId, "LOSER2");
		relay.commitNow();
		relay.resumeCommits();
		relay.setConnectFailure(null);
		await until(() => a.c.ns.state.entries.get(l2.docId)?.state === "merged" && a.c.outbox.size === 0, 8_000, "l2 folded merged, outbox drained");

		// 3. The create commits alone; the body frame goes before a sees the receipt and is dropped, unreceipted, at
		// the merge. The relay still commits it later: junk, and a late receipt for a record a no longer has.
		relay.setLink("dev-a" as DeviceId, { downlinkMs: 300 });
		relay.pauseCommits();
		const l3 = create(a, "same.md", hash);
		const [c3] = await a.submitNs([l3], { liveCreates: true });
		await until(() => a.c.outbox.get(c3!)?.state === "sent", 3_000, "create sent");
		relay.commitNow();
		await write(a, l3.docId, "LOSER3");
		const b3 = a.c.outbox.ofStream(docStream("markdown", l3.docId)!)[0]!;
		assert.equal(b3.dependsOn, c3);
		await until(() => a.c.outbox.get(b3.clientFrameId)?.state === "sent", 3_000, "body sent before the receipt");
		await until(() => a.c.ns.state.entries.get(l3.docId)?.state === "merged" && a.c.outbox.size === 0, 8_000, "sent body dropped at the merge");
		relay.resumeCommits();
		await relay.flush();
		relay.setLink("dev-a" as DeviceId, {});

		await converged([a, b]);
		assert.ok(commits.some((c) => c.frames.some((f) => f.clientFrameId === b3.clientFrameId)), "l3's body still committed (junk)");
		const s1 = docStream("markdown", l1.docId)!;
		const s2 = docStream("markdown", l2.docId)!;
		assert.ok(commits.some((c) => c.frames.some((f) => f.stream === NS_STREAM && f.deviceId === "dev-a") && c.frames.some((f) => f.stream === s1)), "l1's body committed with its create: junk on the loser's stream");
		assert.ok(!commits.some((c) => c.frames.some((f) => f.stream === s2)), "l2's unsent body frame was dropped");
		for (const e of [a, b]) {
			const live = e.listDocs().filter((d) => d.state === "live");
			assert.deepEqual(live.map((d) => d.docId), [w], "only the winner is live");
			assert.equal(await e.docText(w), "WINNER", "the loser's frames never reach the winner");
			for (const l of [l1, l2, l3]) assert.equal(e.listDocs().find((d) => d.docId === l.docId)?.state, "merged");
		}
	} finally {
		await stopAll(a, b);
	}
});

void test("live create ignored as duplicate-docid (a docId collision): its body frames go to that doc, as released held frames do; devices converge", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		const w = await b.createDoc("theirs.md", "THEIRS");
		await converged([a, b]);
		// Fresh docIds are 16 random bytes (Reconciler.freshIds): the collision is forced here.
		const dup = { ...create(a, "mine.md"), docId: w };
		const uncork = a.corkNs();
		const [c] = await a.submitNs([dup], { liveCreates: true });
		await write(a, w, "MINE");
		const body = a.c.outbox.ofStream(docStream("markdown", w)!)[0]!;
		assert.equal(body.state, "pending");
		assert.equal(body.dependsOn, c);
		uncork();
		await converged([a, b]);
		assert.equal(a.c.outbox.size, 0, "no orphaned record");
		for (const e of [a, b]) {
			assert.equal(await e.docText(w), "MINETHEIRS");
			assert.deepEqual(e.listDocs().map((d) => [d.docId, d.path, d.state]), [[w, "theirs.md", "live"]], "the create was ignored");
		}
	} finally {
		await stopAll(a, b);
	}
});
