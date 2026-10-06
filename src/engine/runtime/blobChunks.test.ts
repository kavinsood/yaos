import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../core/hash/sha256";
import { blobChunkStream, bodyStream, type ContentHash, type DeviceId, type DocId, type VaultEpoch, type VaultId, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { MemStoragePort } from "../../sim/storage";
import { assembleChunks, splitChunks } from "../blobs/chunks";
import { Repo } from "../store/repo";
import { LogEngine } from "./engine";
import { converged, startTestEngine, until } from "./testHarness";

function blob(n: number, salt = 0): { hash: ContentHash; bytes: Uint8Array } {
	const bytes = new Uint8Array(n);
	for (let i = 0; i < n; i++) bytes[i] = (i * 31 + salt) & 0xff;
	return { hash: sha256Hex(bytes) as ContentHash, bytes };
}

async function stopAll(...es: LogEngine[]): Promise<void> {
	for (const e of es) await e.stop();
}

test("blob chunks: append on A, read + assemble on B; append is idempotent", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		const { hash, bytes } = blob(3_500);
		const chunks = splitChunks(hash, bytes, 1_000);
		assert.equal(chunks.length, 4);
		assert.equal(await a.appendBlobChunks(hash, chunks), true);
		assert.equal(relay.rows(blobChunkStream(hash)).length, 4);
		assert.equal(a.c.outbox.ofStream(blobChunkStream(hash)).length, 0, "receipted");

		const got = await b.readBlobChunks(hash);
		assert.ok(got);
		const asm = assembleChunks(hash, got);
		assert.ok(asm.ok);
		assert.deepEqual(asm.bytes, bytes);

		// Idempotent: everything committed -> true, no new rows; a partial retry adds nothing either.
		assert.equal(await a.appendBlobChunks(hash, chunks), true);
		assert.equal(await b.appendBlobChunks(hash, chunks.slice(1, 3)), true);
		assert.equal(relay.rows(blobChunkStream(hash)).length, 4);

		// Unknown hash: readable, empty. Mismatched hash in a chunk: refused.
		assert.deepEqual(await b.readBlobChunks(blob(10, 7).hash), []);
		assert.equal(await a.appendBlobChunks(blob(10, 9).hash, chunks), false);
		assert.equal(await a.appendBlobChunks(hash, []), true, "nothing to append");
	} finally {
		await stopAll(a, b);
	}
});

test("blob chunks: timeout -> false; the records still commit and a retry adds no rows", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning: { blobAppendTimeoutMs: 200 } });
	try {
		const one = blob(2_500, 1);
		const c1 = splitChunks(one.hash, one.bytes, 1_000);
		relay.pauseCommits();
		assert.equal(await a.appendBlobChunks(one.hash, c1), false, "timeout while commits are paused");
		assert.equal(a.c.outbox.ofStream(blobChunkStream(one.hash)).length, 3, "records stay in the outbox");
		relay.resumeCommits();
		await until(() => a.c.outbox.ofStream(blobChunkStream(one.hash)).length === 0, 3_000, "records committed");
		assert.equal(await a.appendBlobChunks(one.hash, c1), true);
		assert.equal(relay.rows(blobChunkStream(one.hash)).length, 3);
	} finally {
		await a.stop();
	}
});

test("blob chunks: session drop -> false; offline -> false / null; after reconnect a retry waits on the outbox records", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	try {
		const two = blob(1_500, 2);
		const c2 = splitChunks(two.hash, two.bytes, 1_000);
		relay.pauseCommits();
		const p = a.appendBlobChunks(two.hash, c2);
		await until(() => a.c.outbox.ofStream(blobChunkStream(two.hash)).length === 2, 2_000, "authored");
		a.disconnect();
		assert.equal(await p, false, "session dropped");
		assert.equal(await a.appendBlobChunks(two.hash, c2), false, "offline");
		const offline = await a.readBlobChunks(blob(5, 3).hash);
		assert.equal(offline, null, "offline, nothing local");
		relay.resumeCommits();
		await a.reconnect();
		assert.equal(await a.appendBlobChunks(two.hash, c2), true, "retry waits on the outbox records");
		assert.equal(relay.rows(blobChunkStream(two.hash)).length, 2);
	} finally {
		await a.stop();
	}
});

test("findKnownEpoch: none, after a start, the newest of several; passed as vaultEpoch a restart boots offline", async () => {
	const vaultId = "vault-test" as VaultId;
	const dev = "dev-a" as DeviceId;
	const empty = new MemStoragePort();
	assert.equal(await LogEngine.findKnownEpoch(empty, vaultId, dev), undefined);

	const relay = new SimRelay();
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a" });
	const d = await a.createDoc("x.md" as VaultPath, "hi");
	await converged([a]);
	await a.stop();
	assert.equal(await LogEngine.findKnownEpoch(storage, vaultId, dev), relay.vaultEpoch());
	assert.equal(await LogEngine.findKnownEpoch(storage, vaultId, "dev-b" as DeviceId), undefined);
	assert.equal(await LogEngine.findKnownEpoch(storage, "other" as VaultId, dev), undefined);

	relay.setConnectFailure("unavailable");
	await assert.rejects(startTestEngine({ relay, deviceId: "dev-a", storage }), "start never looks the epoch up itself");
	const vaultEpoch = await LogEngine.findKnownEpoch(storage, vaultId, dev);
	const { engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", storage, extra: { vaultEpoch } });
	try {
		assert.equal(a2.c.repo.identity.vaultEpoch, relay.vaultEpoch());
		assert.equal(await a2.docText(d), "hi", "offline boot from the known DB");
	} finally {
		await a2.stop();
	}

	const multi = new MemStoragePort();
	for (const [epoch, at] of [["e-old", 1_000], ["e-new", 3_000], ["e-mid", 2_000]] as const) {
		const o = await Repo.open(multi, { vaultId, vaultEpoch: epoch as VaultEpoch, deviceId: dev, clientVersion: "t" }, at);
		o.db.close();
	}
	assert.equal(await LogEngine.findKnownEpoch(multi, vaultId, dev), "e-new");
});

test("onBodyChange: fires on the peer for remote body rows, not for own edits", async () => {
	const relay = new SimRelay();
	const seenA: DocId[] = [];
	const seenB: DocId[] = [];
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { onBodyChange: (ids) => seenA.push(...ids) } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", extra: { onBodyChange: (ids) => seenB.push(...ids) } });
	try {
		const d = await a.createDoc("n.md" as VaultPath, "first");
		await converged([a, b]);
		await until(() => seenB.includes(d), 2_000, "b sees a's body");
		const h = (await a.openBody(d, "markdown"))!;
		h.doc.transact(() => h.doc.getText("text").insert(0, "x"), h.mergeOrigin);
		await h.commitEdits();
		h.release();
		const before = seenB.length;
		await converged([a, b]);
		await until(() => seenB.length > before, 2_000, "b sees the edit");
		assert.ok(seenB.slice(before).every((id) => id === d));
		assert.equal(seenA.includes(d), false, "own rows do not fire on the author");
		assert.equal(await b.docText(d), "xfirst");
	} finally {
		await stopAll(a, b);
	}
});

/** Sim seed 179: after an IDB wipe the author re-reads its doc; every row is its own, and the disk side waited on caughtUp. */
test("onBodyChange: a completed catch-up read fires even when every row is own (author with a fresh DB)", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	let a2: LogEngine | null = null;
	try {
		const d = await a.createDoc("n.md" as VaultPath, "first");
		await until(() => a.isIdle() && a.c.outbox.size === 0, 2_000, "a's frames receipted");
		await a.stop();
		const seen: DocId[] = [];
		a2 = (await startTestEngine({ relay, deviceId: "dev-a", extra: { onBodyChange: (ids) => seen.push(...ids) } })).engine; // fresh DB
		const e = a2;
		await until(() => e.isIdle() && e.c.repo.stream(bodyStream(d))?.stale === 0, 2_000, "body caught up");
		assert.equal(await e.docText(d), "first");
		assert.ok(seen.includes(d), "the body became caught up: the disk side must re-plan it");
	} finally {
		await a2?.stop();
	}
});
