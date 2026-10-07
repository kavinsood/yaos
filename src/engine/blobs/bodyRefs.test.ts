/**
 * blobs/bodyRefs.ts: the body refs a reader may still resolve, against a fake relay with the server's read rules
 * (rows above gcSeq are served; after < gcSeq gets the checkpoint and the rows above it; server/src/streams/
 * store.ts:476-523).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBodyUpdateRef } from "../../core/codec/contents";
import type { ClientFrameId, ContentHash, DeviceId, Seq, StreamName, VaultId } from "../../core/types";
import type { EnvelopeKind } from "../../core/envelope";
import type { CryptoPort } from "../../ports/crypto";
import type { ReadPage, ReadRequest, RelayRow } from "../../ports/relay";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import { sealFrame } from "../ingest/envelope";
import { scanBodyRefs, type BodyRefScanDeps } from "./bodyRefs";

const VAULT = "vault-test" as VaultId;
const DEV = "dev-a" as DeviceId;
const crypto = createNoopCrypto(createWebHash());
const h = (i: number) => i.toString(16).padStart(64, "0") as ContentHash;

interface FakeStream {
	rows: RelayRow[];
	gcSeq: Seq;
}

class FakeRelay {
	readonly streams = new Map<StreamName, FakeStream>();
	readonly requests: ReadRequest[][] = [];
	pageRows = 1000;
	batchWidth = 8;
	/** Pages served per batch (the server ends a batch early when over its byte budget). */
	serve = Infinity;
	/** Runs before each batch is answered. */
	before: ((n: number) => void) | null = null;

	stream(s: StreamName): FakeStream {
		let st = this.streams.get(s);
		if (!st) this.streams.set(s, (st = { rows: [], gcSeq: 0 }));
		return st;
	}

	async row(s: StreamName, kind: EnvelopeKind, content: Uint8Array, c: CryptoPort = crypto): Promise<Seq> {
		const st = this.stream(s);
		const seq = (st.rows.at(-1)?.seq ?? st.gcSeq) + 1;
		const clientFrameId = `f${String(seq).padStart(21, "0")}` as ClientFrameId;
		const sealed = await sealFrame(c, VAULT, { stream: s, deviceId: DEV, clientFrameId, kind, authorNsSeq: 0 as Seq, flags: 0, frameNo: 0, content });
		st.rows.push({ seq, deviceId: DEV, clientFrameId, payload: sealed.sealed });
		return seq;
	}

	ref(s: StreamName, i: number): Promise<Seq> {
		return this.row(s, "bodyUpdateRef", encodeBodyUpdateRef({ hash: h(i), size: 2_000_000 }));
	}

	collect(s: StreamName, through: Seq): void {
		const st = this.stream(s);
		st.rows = st.rows.filter((r) => r.seq > through);
		st.gcSeq = Math.max(st.gcSeq, through);
	}

	page(r: ReadRequest): ReadPage {
		const st = this.streams.get(r.stream);
		const lastSeq = st ? (st.rows.at(-1)?.seq ?? st.gcSeq) : 0;
		if (!st) return { checkpoint: null, rows: [], lastSeq, checkpointSeq: 0, gcSeq: 0, nextAfterSeq: r.afterSeq, more: false };
		const ck = r.afterSeq < st.gcSeq ? { coversSeq: st.gcSeq, bytes: new Uint8Array([1]) } : null;
		const after = ck ? ck.coversSeq : r.afterSeq;
		const above = st.rows.filter((x) => x.seq > after);
		const rows = above.slice(0, this.pageRows);
		const more = above.length > rows.length;
		return { checkpoint: ck, rows, lastSeq, checkpointSeq: st.gcSeq, gcSeq: st.gcSeq, nextAfterSeq: rows.at(-1)?.seq ?? Math.min(after, lastSeq), more };
	}

	deps(o: Partial<BodyRefScanDeps> = {}): BodyRefScanDeps {
		return {
			session: {
				limits: { readBatchStreams: this.batchWidth } as BodyRefScanDeps["session"]["limits"],
				readBatch: async (reqs) => {
					assert.ok(reqs.length >= 1 && reqs.length <= this.batchWidth);
					this.requests.push([...reqs]);
					this.before?.(this.requests.length);
					return reqs.slice(0, Math.max(1, this.serve)).map((r) => {
						assert.equal(r.preferCheckpoint, false);
						return this.page(r);
					});
				},
			},
			crypto, vaultId: VAULT, signal: new AbortController().signal, yieldNow: async () => undefined,
			...o,
		};
	}
}

const B1 = "b:d000000000000000000001" as StreamName;
const B2 = "b:d000000000000000000002" as StreamName;
const C1 = "c:d000000000000000000003" as StreamName;

test("scanBodyRefs: a probe for lastSeq / gcSeq, then every ref above gcSeq; collected rows and other kinds are not refs", async () => {
	const relay = new FakeRelay();
	await relay.ref(B1, 1);
	await relay.row(B1, "bodyUpdate", new Uint8Array([1, 2, 3]));
	await relay.ref(B1, 2);
	await relay.ref(B1, 3);
	await relay.row(B1, "bodyUpdate", new Uint8Array([4]));
	relay.collect(B1, 2);
	await relay.ref(C1, 4);
	const r = await scanBodyRefs(relay.deps(), [B1, C1, B2]);
	assert.ok(r.ok);
	assert.deepEqual([...r.hashes].sort(), [h(2), h(3), h(4)]);
	assert.deepEqual(r.through, new Map([[B1, 5], [C1, 1], [B2, 0]]));
	assert.deepEqual(relay.requests[0]!.map((q) => q.afterSeq), [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
	assert.deepEqual(relay.requests[1]!.map((q) => [q.stream, q.afterSeq]), [[B1, 2], [C1, 0]], "an unknown stream reads nothing more");
});

test("scanBodyRefs: a fully collected stream reads no rows; pages are followed to the end", async () => {
	const relay = new FakeRelay();
	await relay.ref(B1, 1);
	relay.collect(B1, 1);
	for (let i = 0; i < 10; i++) await relay.ref(B2, 100 + i);
	relay.pageRows = 3;
	const r = await scanBodyRefs(relay.deps(), [B1, B2]);
	assert.ok(r.ok);
	assert.equal(r.hashes.size, 10);
	assert.deepEqual(r.through, new Map([[B1, 1], [B2, 10]]));
	assert.ok(relay.requests.slice(1).every((b) => b.every((q) => q.stream === B2)));
	assert.equal(relay.requests.length, 1 + 4);
});

test("scanBodyRefs: compaction moving gcSeq past the cursor restarts the stream at the new gcSeq", async () => {
	const relay = new FakeRelay();
	for (let i = 1; i <= 9; i++) await relay.ref(B1, i);
	relay.pageRows = 2;
	relay.before = (n) => { if (n === 3) relay.collect(B1, 6); };
	const r = await scanBodyRefs(relay.deps(), [B1]);
	assert.ok(r.ok);
	assert.deepEqual([...r.hashes].sort(), [1, 2, 7, 8, 9].map(h), "rows 3..6 went before they were read: no reader can get them");
	assert.deepEqual(relay.requests.map((b) => b[0]!.afterSeq), [Number.MAX_SAFE_INTEGER, 0, 2, 6, 8]);
});

test("scanBodyRefs: batches of readBatchStreams; a batch the server ends early continues with the rest", async () => {
	const relay = new FakeRelay();
	const streams: StreamName[] = [];
	for (let i = 0; i < 7; i++) {
		const s = `b:d00000000000000000001${i}` as StreamName;
		streams.push(s);
		await relay.ref(s, 200 + i);
	}
	relay.batchWidth = 3;
	relay.serve = 2;
	const r = await scanBodyRefs(relay.deps(), streams);
	assert.ok(r.ok);
	assert.equal(r.hashes.size, 7);
	assert.equal(r.through.size, 7);
	assert.ok(relay.requests.every((b) => b.length <= 3));
});

test("scanBodyRefs: a row this reader cannot open for reader-dependent reasons refuses; a malformed row is skipped", async () => {
	const relay = new FakeRelay();
	await relay.ref(B1, 1);
	relay.stream(B1).rows.push({ seq: 2, deviceId: DEV, clientFrameId: `f${"9".repeat(21)}` as ClientFrameId, payload: new Uint8Array([1, 0, 0]) });
	await relay.ref(B1, 3);
	const ok = await scanBodyRefs(relay.deps(), [B1]);
	assert.ok(ok.ok);
	assert.deepEqual([...ok.hashes].sort(), [h(1), h(3)]);

	relay.stream(B1).rows[1] = { ...relay.stream(B1).rows[1]!, payload: new Uint8Array([9, 9, 9]) };
	assert.deepEqual(await scanBodyRefs(relay.deps(), [B1]), { ok: false, stream: B1, seq: 2, reason: "unsupported-version" });

	const locked: CryptoPort = { ...crypto, open: async () => ({ ok: false, reason: "unknown-key" }) };
	const refused = await scanBodyRefs(relay.deps({ crypto: locked }), [B2, B1]);
	assert.deepEqual(refused, { ok: false, stream: B1, seq: 1, reason: "unknown-key" });
});

test("scanBodyRefs: `from` rescans only rows committed since (R4), probing streams it does not cover", async () => {
	const relay = new FakeRelay();
	await relay.ref(B1, 1);
	await relay.ref(B1, 2);
	const first = await scanBodyRefs(relay.deps(), [B1]);
	assert.ok(first.ok);
	await relay.ref(B1, 3);
	await relay.ref(B2, 4);
	relay.requests.length = 0;
	const again = await scanBodyRefs(relay.deps(), [B1, B2], first.through);
	assert.ok(again.ok);
	assert.deepEqual([...again.hashes].sort(), [h(3), h(4)]);
	assert.deepEqual(relay.requests[0]!.map((q) => [q.stream, q.afterSeq]), [[B1, 2], [B2, Number.MAX_SAFE_INTEGER]]);
	assert.deepEqual(again.through, new Map([[B1, 3], [B2, 1]]));
});

test("scanBodyRefs: an aborted signal stops the scan", async () => {
	const relay = new FakeRelay();
	await relay.ref(B1, 1);
	const ctrl = new AbortController();
	ctrl.abort();
	await assert.rejects(scanBodyRefs(relay.deps({ signal: ctrl.signal }), [B1]), /aborted/);
	assert.equal(relay.requests.length, 0);
});

test("scanBodyRefs: the sweep's stop ends a read the relay never answers (the stop does not wait for the read's own deadline)", async () => {
	const relay = new FakeRelay();
	await relay.ref(B1, 1);
	const ctrl = new AbortController();
	let reads = 0;
	const deps = relay.deps({ signal: ctrl.signal });
	const hung: BodyRefScanDeps = { ...deps, session: { ...deps.session, readBatch: () => (reads++, new Promise<readonly ReadPage[]>(() => undefined)) } };
	let out: unknown = "pending";
	scanBodyRefs(hung, [B1]).then((v) => (out = v), (e: unknown) => (out = e));
	const settled = (): unknown => out;
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	assert.equal(reads, 1);
	assert.equal(settled(), "pending");
	ctrl.abort(new Error("sweep stopped"));
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	const end = settled();
	assert.ok(end instanceof Error && end.message === "sweep stopped", String(end));
});
