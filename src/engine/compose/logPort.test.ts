import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentHash, DocId, VaultPath } from "../../core/types";
import { EMPTY_CONTENT_HASH } from "../../core/plan/planner";
import { SYNC_HASH_MAX_BYTES } from "../../core/limits";
import { markdownCanonicalBytes } from "../../core/hash/markdownLf";
import { markdownHashRef } from "../../core/hash/testkit/hashRef";
import { SimRelay } from "../../sim/relay";
import { startTestEngine, until, createDoc, editDoc } from "../runtime/testHarness";
import { ComposedLog } from "./logPort";
import { loadTextHash } from "../reconcile/runner";

const NOT_EMPTY = "ab".repeat(32) as ContentHash;

/** Sim heavy seeds 17, 90, 194: the creator lost its store before its initial body frames were acked. */
test("lostCreateBody: own live create with no rows and nothing pending; not a peer's, not one with a body", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		const lost = "lostDoc000000000000000" as DocId;
		const born = "bornEmpty0000000000000" as DocId;
		await a.submitNs([
			{ t: "create", docId: lost, kind: "markdown", path: "lost.md" as VaultPath, contentHash: NOT_EMPTY, size: 9 },
			{ t: "create", docId: born, kind: "markdown", path: "empty.md" as VaultPath, contentHash: EMPTY_CONTENT_HASH, size: 0 },
		]);
		const withBody = await createDoc(a, "body.md" as VaultPath, "some text");
		await until(() => a.isIdle() && a.c.outbox.size === 0, 2_000, "a receipted");
		await until(() => b.nsView().state.entries.has(withBody), 2_000, "b folded");

		const la = new ComposedLog(a);
		assert.equal(la.view().lostCreateBody.size, 0, "not before ns was caught up in this session");
		la.nsCaughtUp = true;
		la.invalidate();
		assert.deepEqual([...la.view().lostCreateBody], [lost]);

		const lb = new ComposedLog(b);
		lb.nsCaughtUp = true;
		assert.equal(lb.view().lostCreateBody.size, 0, "a peer waits for the creator");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("textHash: warmTextHashes digests resident replicas through HashPort; view() hashes only a small changed one itself", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	try {
		const smallText = "small\r\n";
		const bigText = "line of text\r\n".repeat(1000);
		assert.ok(markdownCanonicalBytes(bigText).length > SYNC_HASH_MAX_BYTES);
		const small = await createDoc(a, "small.md" as VaultPath, smallText);
		const big = await createDoc(a, "big.md" as VaultPath, bigText);
		await until(() => a.isIdle() && a.c.outbox.size === 0, 2_000, "a receipted");
		assert.ok(a.c.handles.peek(a.streamOf(small)) && a.c.handles.peek(a.streamOf(big)), "both replicas resident");
		const la = new ComposedLog(a);
		assert.equal(la.view().textHash.get(small), markdownHashRef(smallText), "a small text is hashed by view() itself");
		assert.equal(la.view().textHash.has(big), false, "a large one only by the warm (view() never blocks on a digest)");
		await la.warmTextHashes();
		assert.equal(la.view().textHash.get(big), markdownHashRef(bigText));
		// An edit moves the body version: the hash taken for the old text is never paired with the new one.
		await editDoc(a, big, (t) => t.insert(0, "x"));
		la.invalidate();
		assert.equal(la.view().textHash.has(big), false);
		assert.equal(la.view().textHash.get(small), markdownHashRef(smallText), "unchanged: still from the memo");
		await la.warmTextHashes();
		assert.equal(la.view().textHash.get(big), markdownHashRef(`x${bigText}`));
	} finally {
		await a.stop();
	}
});

/**
 * Sim randomized-tuning seeds 86, 163: the planner's collapse waited on "text-hash" for a peer's doc on a device whose
 * residency budget was full of bound docs. loadTextHash loaded the doc, released it (the release evicted it at once:
 * the only clean handle) and warmed after that, so no pass ever had the hash and the loser rename never ran.
 */
test("textHash: a doc loaded for its hash keeps it when the full residency budget evicts it at its release", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { budgets: { maxResidentDocs: 1 } } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		const open = await createDoc(a, "open.md" as VaultPath, "open here\n");
		await a.bind(open);
		const text = "a peer's note\n";
		const peer = await createDoc(b, "peer.md" as VaultPath, text);
		await until(() => b.isIdle() && b.c.outbox.size === 0, 2_000, "b receipted");
		await until(() => a.isIdle() && a.c.outbox.size === 0 && a.bodyInfo(peer)?.caughtUp === true && a.bodyInfo(peer)?.hasContent === true, 2_000, "a caught up");
		const la = new ComposedLog(a);
		la.nsCaughtUp = true;
		assert.equal(a.c.handles.isResident(a.streamOf(peer)), false, "not resident");
		assert.equal(la.view().textHash.has(peer), false, "no hash before the load");

		assert.equal(await loadTextHash(la, peer), "ok");
		assert.equal(a.c.handles.isResident(a.streamOf(peer)), false, "evicted at its release (the bound doc fills the budget)");
		await la.warmTextHashes();
		assert.equal(la.view().textHash.get(peer), markdownHashRef(text), "the next pass still reads the hash");

		// A new row moves the body version: the hash of the old text is never paired with the new one.
		const before = a.bodyInfo(peer)?.version.remoteSeq ?? 0;
		await editDoc(b, peer, (t) => t.insert(0, "x"));
		await until(() => b.isIdle() && b.c.outbox.size === 0, 2_000, "b receipted the edit");
		await until(() => a.isIdle() && a.bodyInfo(peer)?.caughtUp === true && (a.bodyInfo(peer)?.version.remoteSeq ?? 0) > before, 2_000, "a caught up on the edit");
		la.invalidate();
		assert.equal(la.view().textHash.has(peer), false, "stale once the version moved");
		assert.equal(await loadTextHash(la, peer), "ok");
		assert.equal(la.view().textHash.get(peer), markdownHashRef(`x${text}`));
	} finally {
		await a.stop();
		await b.stop();
	}
});
