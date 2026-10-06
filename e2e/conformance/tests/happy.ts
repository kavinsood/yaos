/** BASELINE T-HAPPY: smoke-equivalent core on a fresh vault (exact seqs). */
import type { TestDef } from "../lib/results.ts";
import { vault } from "../lib/fixture.ts";
import { brief, http } from "../lib/http.ts";
import { StreamSocket } from "../lib/socket.ts";
import { b64, bytesEqual, id, payloadOf, round } from "../lib/util.ts";

export const tests: TestDef[] = [{
	id: "T-HAPPY", group: "baseline", area: "baseline", expectedBefore: "PASS", timeoutMs: 120000,
	async run(ctx, t) {
		const v = await vault(ctx, "happy");
		const [A, B] = [v.devices[0]!, v.devices[1]!];
		t.check("enroll x2 into one vault", v.devices.length === 2);
		const a = await StreamSocket.connect(ctx, v.vaultId, A, "A");
		const b = await StreamSocket.connect(ctx, v.vaultId, B, "B");
		t.check("VAULT_READY A/B: documentId streams, head 0, vaultId, canWrite", [a, b].every((s) => s.ready.documentId === "streams"
			&& s.ready.head === 0 && s.ready.vaultId === v.vaultId && s.ready.canWrite === true && s.ready.vaultEpoch === v.vaultGeneration),
		[a, b].map((s) => ({ head: s.ready.head, documentId: s.ready.documentId, canWrite: s.ready.canWrite })));

		const doc = `b:${id(9)}`;
		const sent = new Map<string, Uint8Array>();
		const nsPayload = payloadOf("ns-1", 300);
		const bPayload = payloadOf("b-1", 2000);
		sent.set("a-b-1", bPayload);
		let fromA = a.mark();
		const fromB = b.mark();
		const t0 = a.append("ns", "a-ns-1", nsPayload);
		a.append(doc, "a-b-1", bPayload);
		const provisional = await b.waitFor((e) => e.frame?.kind === "provisional" && e.frame.clientFrameId === "a-b-1" ? e.frame : undefined,
			10000, "B provisional", fromB);
		t.check("B PROVISIONAL b:<doc>: A's payload, no seq", provisional.value.stream === doc && provisional.value.seq === null
			&& provisional.value.deviceId === A.deviceId && bytesEqual(provisional.value.payload, bPayload));
		const r1 = await a.receipts(["a-ns-1", "a-b-1"], fromA);
		const nsR = r1.get("a-ns-1")!;
		const bR = r1.get("a-b-1")!;
		t.observe("appendToReceiptMs", round(nsR.at - t0));
		t.check("origin receipts: ns seq 1, b: seq 2, not deduped, head 2", nsR.seq === 1 && bR.seq === 2 && !nsR.deduped && !bR.deduped
			&& nsR.head === 2, { ns: { seq: nsR.seq, deduped: nsR.deduped }, b: { seq: bR.seq, deduped: bR.deduped }, head: nsR.head });
		const committed = await b.waitFor((e) => e.frame?.kind === "committed" && e.frame.clientFrameId === "a-ns-1" ? e.frame : undefined,
			10000, "B committed ns", fromB);
		const notice = await b.waitFor((e) => e.frame?.kind === "notice" && e.frame.clientFrameId === "a-b-1" ? e : undefined,
			10000, "B notice", fromB);
		t.check("peer COMMITTED ns with seq 1 + payload", committed.value.seq === 1 && committed.value.stream === "ns"
			&& bytesEqual(committed.value.payload, nsPayload));
		t.check("peer COMMIT_NOTICE b: with seq 2, after its PROVISIONAL", notice.value.frame!.seq === 2 && provisional.at <= notice.at);
		t.check("origin gets no broadcast of its own frames", a.frames(fromA).length === 0, a.frames(fromA).length);

		// bulk: group commit by bytes, contiguous seqs
		const bulkIds: string[] = [];
		fromA = a.mark();
		for (let i = 0; i < 12; i++) {
			const cfid = `a-bulk-${i}`;
			const payload = payloadOf(cfid, 8 * 1024);
			sent.set(cfid, payload);
			bulkIds.push(cfid);
			a.append(doc, cfid, payload);
		}
		const bulk = await a.receipts(bulkIds, fromA);
		const bulkSeqs = bulkIds.map((cfid) => bulk.get(cfid)!.seq);
		t.check("12 bulk receipts contiguous from 3", bulkSeqs.every((seq, index) => seq === 3 + index), bulkSeqs);
		const lastSeq = bulkSeqs.at(-1)!;

		// ping/pong
		fromA = a.mark();
		a.control({ type: "VAULT_PING", probeId: `p-${id(6)}` });
		const pong = await a.waitFor((e) => e.control?.type === "VAULT_PONG" ? e.control : undefined, 5000, "pong", fromA);
		t.check("VAULT_PONG head = last seq", pong.value.head === lastSeq && pong.value.documentId === "streams", { head: pong.value.head });

		// feed
		const feed = await http(ctx, "GET", `${v.path}/streams/feed?after=0`, { token: B.token });
		const changes = new Map<string, number>((feed.value?.changes ?? []).map((c: any) => [c.stream, c.lastSeq]));
		t.check("feed after=0: ns@1 + doc@last, head, nextAfter null, vaultEpoch", feed.status === 200 && changes.get("ns") === 1
			&& changes.get(doc) === lastSeq && feed.value.head === lastSeq && feed.value.nextAfter === null
			&& feed.value.vaultEpoch === v.vaultGeneration, brief(feed, { changes: feed.value?.changes?.length, head: feed.value?.head }));
		const page1 = await http(ctx, "GET", `${v.path}/streams/feed?after=0&limit=1`, { token: B.token });
		const page2 = await http(ctx, "GET", `${v.path}/streams/feed?after=${page1.value?.nextAfter}&limit=1`, { token: B.token });
		t.check("feed paging limit=1", page1.value?.changes?.length === 1 && page1.value.changes[0].stream === "ns"
			&& page1.value.nextAfter === 1 && page2.value?.changes?.[0]?.stream === doc && page2.value.nextAfter === null,
		{ page1NextAfter: page1.value?.nextAfter, page2NextAfter: page2.value?.nextAfter });
		const empty = await http(ctx, "GET", `${v.path}/streams/feed?after=${lastSeq}`, { token: B.token });
		t.check("feed after=head empty", empty.value?.changes?.length === 0);

		// read paging
		const rows: any[] = [];
		let after = 0;
		let pages = 0;
		for (; pages < 50; ) {
			const page = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(doc)}&after=${after}&maxBytes=20000`,
				{ token: B.token });
			pages++;
			if (page.status !== 200) { t.check("read page 200", false, brief(page)); break; }
			rows.push(...page.value.rows);
			if (page.value.nextAfter === null) break;
			after = page.value.nextAfter;
		}
		const expectedIds = ["a-b-1", ...bulkIds];
		t.check("read paging returns every row once, ascending, unmerged", rows.length === expectedIds.length
			&& rows.every((row, index) => row.clientFrameId === expectedIds[index] && bytesEqual(b64(row.payload), sent.get(row.clientFrameId)!)
				&& (index === 0 || row.seq > rows[index - 1].seq) && row.deviceId === A.deviceId),
		{ rows: rows.length, expected: expectedIds.length });
		t.check("read paginated by maxBytes (>= 4 pages)", pages >= 4, pages);

		// checkpoint CAS table
		const q = (stream: string, n: number, m: number) => `${v.path}/streams/checkpoint?stream=${encodeURIComponent(stream)}&coversSeq=${n}&expectedCoversSeq=${m}`;
		const ckpt = payloadOf("checkpoint", 4096);
		const ok = await http(ctx, "PUT", q(doc, lastSeq, 0), { token: A.token, body: ckpt });
		t.check("checkpoint 200", ok.status === 200 && ok.value?.coversSeq === lastSeq && typeof ok.value?.gcSeq === "number",
			brief(ok, { coversSeq: ok.value?.coversSeq, gcSeq: ok.value?.gcSeq, deletedSegments: ok.value?.deletedSegments }));
		const conflict = await http(ctx, "PUT", q(doc, lastSeq, 0), { token: B.token, body: ckpt });
		t.check("409 checkpoint_conflict {current.coversSeq}", conflict.status === 409 && conflict.value?.error === "checkpoint_conflict"
			&& conflict.value?.current?.coversSeq === lastSeq, brief(conflict));
		const notAdvancing = await http(ctx, "PUT", q(doc, lastSeq, lastSeq), { token: A.token, body: ckpt });
		t.check("400 checkpoint_not_advancing", notAdvancing.status === 400 && notAdvancing.value?.error === "checkpoint_not_advancing",
			brief(notAdvancing));
		const ahead = await http(ctx, "PUT", q(doc, lastSeq + 5, lastSeq), { token: A.token, body: ckpt });
		t.check("409 checkpoint_ahead_of_stream {lastSeq}", ahead.status === 409 && ahead.value?.error === "checkpoint_ahead_of_stream"
			&& ahead.value?.lastSeq === lastSeq, brief(ahead, { lastSeq: ahead.value?.lastSeq }));
		const missing = await http(ctx, "PUT", q(`b:none-${id(6)}`, 1, 0), { token: A.token, body: ckpt });
		t.check("404 stream_not_found", missing.status === 404 && missing.value?.error === "stream_not_found", brief(missing));
		const withCkpt = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(doc)}&after=0&checkpoint=1`, { token: B.token });
		t.check("read checkpoint=1 returns the checkpoint bytes", withCkpt.value?.checkpoint?.coversSeq === lastSeq
			&& bytesEqual(b64(withCkpt.value.checkpoint.bytes), ckpt), brief(withCkpt, { coversSeq: withCkpt.value?.checkpoint?.coversSeq }));
	},
}];
