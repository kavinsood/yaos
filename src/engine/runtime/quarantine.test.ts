/**
 * Ingest gate at engine level (DESIGN §d.6, §k.3 WP-C #2): reader-dependent and
 * deterministic body failures quarantine + freeze, the cursor still advances,
 * releaseQuarantine re-gates; causal holes re-read then freeze `causal-hole`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { MAX_DOC_TEXT_CHARS, MAX_FRAME_CONTENT_BYTES, QUARANTINE_ROW_BYTES } from "../../core/limits";
import type { ClientFrameId, DeviceId, StreamName, VaultId } from "../../core/types";
import type { RelaySession } from "../../ports/relay";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { sealFrame } from "../ingest/envelope";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { converged, faultyCrypto, sleep, startTestEngine, until } from "./testHarness";

const VAULT = "vault-test" as VaultId;
const noop = createNoopCrypto(createWebHash());

async function live(...es: LogEngine[]): Promise<void> {
	await until(() => es.every((e) => e.status().phase === "live"), 3_000, "live");
}

/** A raw relay member that appends hand-built frames (a buggy or malicious peer). */
async function rawDevice(relay: SimRelay, deviceId = "dev-x") {
	const r = await relay.connect({ vaultId: VAULT, deviceId: deviceId as DeviceId });
	assert.ok(r.ok);
	const s: RelaySession = r.session;
	let n = 0;
	return {
		async send(stream: StreamName, content: Uint8Array): Promise<void> {
			const cf = `rawframe${String(n++).padStart(14, "0")}` as ClientFrameId;
			const sealed = await sealFrame(noop, VAULT, { stream, deviceId: deviceId as DeviceId, clientFrameId: cf, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content });
			s.append({ stream, clientFrameId: cf, payload: sealed.sealed });
		},
		close: () => s.close(1000, "done"),
	};
}

test("quarantine: unknown-key rows freeze the doc, V still advances; releaseQuarantine after the key arrives applies them", async () => {
	const relay = new SimRelay();
	const fc = faultyCrypto();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", crypto: fc });
	try {
		await live(a, b);
		const id = await a.createDoc("q.md", "base;");
		await converged([a, b]);
		const stream = a.streamOf(id);
		fc.failOpen = true;
		for (let i = 0; i < 3; i++) await a.editDoc(id, (t) => t.insert(t.length, `k${i};`));
		await until(() => b.c.repo.stream(stream)?.quarantinedRows === 3, 3_000, "quarantined");
		const rec = b.c.repo.stream(stream)!;
		assert.equal(rec.frozen, 1);
		assert.equal(rec.frozenReason, "crypto-unknown-key");
		assert.equal(await b.docText(id), "base;");
		await until(() => b.isIdle(), 3_000, "b idle while frozen");
		assert.equal(b.c.repo.cursor.vaultSeq, relay.head(), "cursor advances over quarantined rows");
		assert.equal(b.status().counts.quarantinedRows, 3);
		assert.equal(b.status().counts.frozenDocs, 1);
		assert.equal((await b.c.repo.getTail(stream, 0, relay.head())).length > 0, true, "pre-freeze rows stay in tail");

		fc.failOpen = false;
		assert.deepEqual(await b.releaseQuarantine(stream), { passed: 3, dismissed: 0 });
		const after = b.c.repo.stream(stream)!;
		assert.equal(after.frozen, 0);
		assert.equal(after.quarantinedRows, 0);
		assert.equal((await b.c.repo.quarantineOf(stream)).length, 0);
		assert.equal(await b.docText(id), "base;k0;k1;k2;");
		assert.equal(b.status().counts.frozenDocs, 0);
		await b.editDoc(id, (t) => t.insert(0, "B;"));
		await converged([a, b]);
		assert.equal(await a.docText(id), "B;base;k0;k1;k2;");
	} finally {
		await a.stop();
		await b.stop();
	}
});

test("quarantine: disallowed Yjs type from a peer freezes every reader; release dismisses it, then edits merge again", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	const x = await rawDevice(relay);
	try {
		await live(a, b);
		const id = await a.createDoc("evil.md", "fine;");
		await converged([a, b]);
		const stream = a.streamOf(id);
		const evil = new Y.Doc();
		evil.getMap("meta").set("k", "v");
		await x.send(stream, Y.encodeStateAsUpdate(evil));
		await x.send(stream, new Uint8Array([0xff, 0xff, 0xff, 0x01, 0x07])); // undecodable
		const noise = new Uint8Array(MAX_FRAME_CONTENT_BYTES + 1); // incompressible: fits the relay frame, not the content cap
		for (let i = 0; i < noise.length; i += 65536) globalThis.crypto.getRandomValues(noise.subarray(i, i + 65536));
		await x.send(stream, noise);
		for (const e of [a, b]) await until(() => e.c.repo.stream(stream)?.quarantinedRows === 3, 3_000, "quarantined");
		for (const e of [a, b]) {
			const rec = e.c.repo.stream(stream)!;
			assert.equal(rec.frozen, 1);
			assert.equal(rec.frozenReason, "oversize", "frozenReason = latest quarantine");
			const qs = await e.c.repo.quarantineOf(stream);
			assert.deepEqual(qs.map((q) => q.reason).sort(), ["decode-failed", "disallowed-type", "oversize"]);
			assert.ok(qs.every((q) => q.deviceId === "dev-x"));
			const big = qs.find((q) => q.reason === "oversize")!;
			assert.equal(big.bytes.length, QUARANTINE_ROW_BYTES, "stored bytes truncated; full size + hash kept");
			assert.ok(big.originalSize > MAX_FRAME_CONTENT_BYTES);
		}
		// No local frames into a frozen doc; valid remote rows keep flowing into its replica (the host stops projecting it).
		await assert.rejects(a.editDoc(id, (t) => t.insert(0, "nope")), /frozen/);
		const ok = new Y.Doc();
		ok.getText("text").insert(0, "X;");
		await x.send(stream, Y.encodeStateAsUpdate(ok));
		for (const e of [a, b]) await until(async () => (await e.docText(id)).includes("X;"), 3_000, "ingests while frozen");
		assert.equal(await a.docText(id), await b.docText(id));

		for (const e of [a, b]) {
			assert.deepEqual(await e.releaseQuarantine(stream), { passed: 0, dismissed: 3 });
			const rec = e.c.repo.stream(stream)!;
			assert.equal(rec.frozen, 0);
			assert.equal(rec.quarantinedRows, 0);
			const qs = await e.c.repo.quarantineOf(stream);
			assert.equal(qs.length, 3, "dismissed records stay for diagnostics");
			assert.ok(qs.every((q) => q.detail.startsWith("dismissed:")));
			assert.equal(e.status().counts.quarantinedRows, 0);
		}
		await b.editDoc(id, (t) => t.insert(0, "after;"));
		await converged([a, b]);
		assert.ok((await a.docText(id)).startsWith("after;"));
		assert.equal((await a.docText(id)).length, "after;fine;X;".length);
	} finally {
		x.close();
		await a.stop();
		await b.stop();
	}
});

test("causal hole: missing structs -> re-read causalRetries times -> freeze causal-hole; the missing row + release resolves it", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const x = await rawDevice(relay);
	try {
		await live(a);
		const id = await a.createDoc("hole.md", "doc;");
		await until(() => a.isIdle(), 3_000, "idle");
		await a.docText(id); // resident: the check stage runs at apply time
		const stream = a.streamOf(id);
		const src = new Y.Doc();
		const t = src.getText("text");
		const u1: Uint8Array[] = [];
		const u2: Uint8Array[] = [];
		let sink = u1;
		src.on("update", (u: Uint8Array) => sink.push(u));
		t.insert(0, "ab");
		sink = u2;
		t.insert(2, "c"); // depends on u1's structs
		const reads0 = a.c.docs.stats.causalReads;
		await x.send(stream, u2[0]!);
		await until(() => a.c.repo.stream(stream)?.frozen === 1, 3_000, "frozen causal-hole");
		assert.equal(a.c.repo.stream(stream)!.frozenReason, "causal-hole");
		assert.equal(a.c.docs.stats.causalReads - reads0, 2, "re-read causalRetries times before freezing");
		assert.ok(a.status().notices.some((n) => n.code === "frozen:causal-hole"));
		assert.equal(a.c.repo.stream(stream)!.quarantinedRows, 0, "a causal hole is not quarantine: the row stays in tail");
		assert.equal(a.c.repo.cursor.vaultSeq, relay.head());

		const h0 = relay.head();
		await x.send(stream, u1[0]!);
		// The relay group-commits: wait for the row to commit, then for a to ingest it.
		await until(() => relay.head() > h0 && a.c.repo.cursor.vaultSeq === relay.head() && a.c.live.idle, 3_000, "u1 ingested");
		await sleep(30);
		assert.deepEqual(await a.releaseQuarantine(stream), { passed: 0, dismissed: 0 });
		assert.equal(a.c.repo.stream(stream)!.frozen, 0);
		assert.ok(!a.status().notices.some((n) => n.code === "frozen:causal-hole"));
		const text = await a.docText(id);
		assert.ok(text.includes("abc") && text.includes("doc;"), text);
		await sleep(200);
		assert.equal(a.c.repo.stream(stream)!.frozen, 0, "no re-freeze once the hole is filled");
	} finally {
		x.close();
		await a.stop();
	}
});

test("causal hole filled before the retries run out: no freeze", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", tuning: { causalRetryMs: 150, causalRetries: 3 } });
	const x = await rawDevice(relay);
	try {
		await live(a);
		const id = await a.createDoc("heal.md", "");
		await until(() => a.isIdle(), 3_000, "idle");
		await a.docText(id);
		const stream = a.streamOf(id);
		const src = new Y.Doc();
		const ups: Uint8Array[] = [];
		src.on("update", (u: Uint8Array) => ups.push(u));
		src.getText("text").insert(0, "12");
		src.getText("text").insert(2, "3");
		await x.send(stream, ups[1]!);
		await sleep(60);
		await x.send(stream, ups[0]!);
		await until(async () => (await a.docText(id)) === "123", 3_000, "hole filled");
		await sleep(600);
		assert.equal(a.c.repo.stream(stream)!.frozen, 0);
		assert.ok(!a.status().notices.some((n) => n.code.startsWith("frozen:")));
	} finally {
		x.close();
		await a.stop();
	}
});

test("oversize-remote: valid rows pushing the text past MAX_DOC_TEXT_CHARS freeze the doc (rows stay in tail, not quarantine)", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const x = await rawDevice(relay);
	try {
		await live(a);
		const id = await a.createDoc("huge.md", "");
		await until(() => a.isIdle(), 3_000, "idle");
		await a.docText(id);
		const stream = a.streamOf(id);
		const src = new Y.Doc();
		const ups: Uint8Array[] = [];
		src.on("update", (u: Uint8Array) => ups.push(u));
		const chunk = "y".repeat(1_000_000);
		while (src.getText("text").length <= MAX_DOC_TEXT_CHARS) src.getText("text").insert(src.getText("text").length, chunk);
		for (const u of ups) await x.send(stream, u);
		await until(() => a.c.repo.stream(stream)?.frozen === 1, 10_000, "frozen oversize-remote");
		const rec = a.c.repo.stream(stream)!;
		assert.equal(rec.frozenReason, "oversize-remote");
		assert.equal(rec.quarantinedRows, 0);
		await until(() => a.c.repo.cursor.vaultSeq === relay.head(), 5_000, "V at head");
		assert.ok(a.status().notices.some((n) => n.code === "frozen:oversize-remote"));
		assert.deepEqual(await a.releaseQuarantine(stream), { passed: 0, dismissed: 0 });
		await until(() => a.c.repo.stream(stream)!.frozen === 1, 3_000, "release re-checks the doc: still oversize -> frozen again");
	} finally {
		x.close();
		await a.stop();
	}
});

test("quarantine: reader-dependent rows are retried automatically on the next session (keys arrived); still missing -> stay quarantined", async () => {
	const relay = new SimRelay();
	const fc = faultyCrypto();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", crypto: fc });
	try {
		await live(a, b);
		const id = await a.createDoc("r.md", "base;");
		await converged([a, b]);
		const stream = a.streamOf(id);
		fc.failOpen = true;
		for (let i = 0; i < 2; i++) await a.editDoc(id, (t) => t.insert(t.length, `k${i};`));
		await until(() => b.c.repo.stream(stream)?.quarantinedRows === 2, 3_000, "quarantined");
		const sessions = b.c.sess.stats.sessions;
		// Reconnect with the key still missing: nothing is released or dismissed.
		relay.dropSession("dev-b" as DeviceId);
		await until(() => b.c.sess.stats.sessions > sessions && b.status().phase === "live", 5_000, "b reconnected");
		await until(() => b.isIdle(), 3_000, "b idle");
		assert.equal(b.c.repo.stream(stream)!.frozen, 1);
		assert.equal((await b.c.repo.quarantineOf(stream)).filter((q) => !q.detail.startsWith("dismissed:")).length, 2);
		// The key arrives; the next session start re-gates and applies.
		fc.failOpen = false;
		const s2 = b.c.sess.stats.sessions;
		relay.dropSession("dev-b" as DeviceId);
		await until(() => b.c.sess.stats.sessions > s2 && b.c.repo.stream(stream)!.frozen === 0, 5_000, "released on reconnect");
		assert.equal(await b.docText(id), "base;k0;k1;");
		assert.equal(b.status().counts.frozenDocs, 0);
		await b.editDoc(id, (t) => t.insert(0, "B;"));
		await converged([a, b]);
		assert.equal(await a.docText(id), "B;base;k0;k1;");
	} finally {
		await a.stop();
		await b.stop();
	}
});

// A re-gate runs on a snapshot of the quarantine: a row quarantined while it runs is neither in it nor released
// by it. Found by the E7 suite-1 sim (a keyring-hold row stored after the retry that `k` completing ran).
test("quarantine: a release whose snapshot predates a later row keeps the doc frozen with that row counted", async () => {
	const relay = new SimRelay();
	const fc = faultyCrypto();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", crypto: fc });
	try {
		await live(a, b);
		const id = await a.createDoc("s.md", "base;");
		await converged([a, b]);
		const stream = a.streamOf(id);
		fc.failOpen = true;
		for (let i = 0; i < 2; i++) await a.editDoc(id, (t) => t.insert(t.length, `k${i};`));
		await until(() => b.c.repo.stream(stream)?.quarantinedRows === 2, 3_000, "quarantined");
		const snapshot = await b.c.repo.quarantineOf(stream);
		await a.editDoc(id, (t) => t.insert(t.length, "k2;"));
		await until(() => b.c.repo.stream(stream)?.quarantinedRows === 3, 3_000, "a third row quarantined");
		const r = await b.c.repo.tReleaseQuarantine(stream, [], snapshot, Date.now());
		assert.equal(r.frozen, 1, "the later row still freezes the doc");
		assert.equal(r.quarantinedRows, 1);
		assert.equal((await b.c.repo.quarantineOf(stream)).filter((q) => !q.detail.startsWith("dismissed:")).length, 1);
		assert.equal(b.status().counts.frozenDocs, 1);
	} finally {
		await a.stop();
		await b.stop();
	}
});

// The keys arrive between a row's gate and its store: the re-gate they trigger ran before the row was stored.
test("quarantine: a reader-dependent row this reader opens by the time it is stored is released without a new session", async () => {
	const relay = new SimRelay();
	const fc = faultyCrypto();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", crypto: fc });
	try {
		await live(a, b);
		const id = await a.createDoc("t.md", "base;");
		await converged([a, b]);
		const stream = a.streamOf(id);
		const repo = b.c.repo;
		const tLive = repo.tLive.bind(repo);
		let raced = 0;
		repo.tLive = (items, nowMs, day) => {
			if (fc.failOpen && items.some((it) => it.t === "quarantine")) {
				fc.failOpen = false; // the key arrives after the gate failed, before the store
				raced++;
			}
			return tLive(items, nowMs, day);
		};
		const sessions = b.c.sess.stats.sessions;
		fc.failOpen = true;
		await a.editDoc(id, (t) => t.insert(t.length, "k0;"));
		await until(() => raced === 1, 3_000, "gated while the key was missing");
		await until(() => repo.stream(stream)?.frozen === 0, 3_000, "released");
		assert.equal(b.c.sess.stats.sessions, sessions, "on this session");
		assert.equal(await b.docText(id), "base;k0;");
		assert.equal(b.status().counts.quarantinedRows, 0);
		await converged([a, b]);
	} finally {
		await a.stop();
		await b.stop();
	}
});
