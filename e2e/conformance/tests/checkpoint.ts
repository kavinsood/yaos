/** D8c epoch guard, H7 checkpoint GC, baseline multi-chunk checkpoint. */
import type { Ctx } from "../lib/context.ts";
import type { Recorder, TestDef } from "../lib/results.ts";
import { device, vault } from "../lib/fixture.ts";
import type { Vault } from "../lib/fixture.ts";
import { brief, http } from "../lib/http.ts";
import type { HttpResult } from "../lib/http.ts";
import { checkpointPath, readAll } from "../lib/streams.ts";
import { StreamSocket } from "../lib/socket.ts";
import { b64, bytesEqual, id, payloadOf } from "../lib/util.ts";

/** Appends `n` small rows to a fresh stream with device A of `v`; returns stream + seqs. */
async function seedStream(ctx: Ctx, v: Vault, prefix: string, n: number, size = 200) {
	const socket = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), `seed-${prefix}`);
	const stream = `b:${prefix}-${id(6)}`;
	const items = Array.from({ length: n }, (_, i) => ({ stream, id: `${prefix}-${i}`, payload: payloadOf(`${prefix}-${i}`, size) }));
	const receipts = await socket.appendAll(items);
	socket.close();
	return { stream, items, seqs: items.map((i) => receipts.get(i.id)!.seq) };
}

async function currentEpoch(ctx: Ctx, v: Vault): Promise<string> {
	const feed = await http(ctx, "GET", `${v.path}/streams/feed?after=0&limit=1`, { token: v.owner.token });
	if (typeof feed.value?.vaultEpoch !== "string") throw new Error(`feed has no vaultEpoch ${JSON.stringify(brief(feed))}`);
	return feed.value.vaultEpoch;
}

async function checkpointState(ctx: Ctx, v: Vault, stream: string) {
	const read = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(stream)}&after=0&checkpoint=1`, { token: v.owner.token });
	return { checkpointSeq: read.value?.checkpointSeq ?? null, checkpoint: read.value?.checkpoint?.coversSeq ?? null };
}

function mismatch(t: Recorder, name: string, response: HttpResult, epoch: string) {
	return t.check(`${name} -> 409 vault_generation_mismatch {vaultEpoch: current}`, response.status === 409
		&& response.value?.error === "vault_generation_mismatch" && response.value?.vaultEpoch === epoch,
	brief(response, { vaultEpochIsCurrent: response.value?.vaultEpoch === epoch }));
}

async function epochOk(ctx: Ctx, t: Recorder, epochParam: string) {
	const v = await vault(ctx, "main");
	const seeded = await seedStream(ctx, v, epochParam ? "epok" : "epab", 2);
	const token = v.owner.token;
	const feed = await http(ctx, "GET", `${v.path}/streams/feed?after=0${epochParam}`, { token });
	t.check("feed 200", feed.status === 200 && Array.isArray(feed.value?.changes), brief(feed));
	const read = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(seeded.stream)}&after=0${epochParam}`, { token });
	t.check("read 200 with rows", read.status === 200 && read.value?.rows?.length === 2, brief(read, { rows: read.value?.rows?.length }));
	const put = await http(ctx, "PUT", checkpointPath(v.path, seeded.stream, seeded.seqs[1]!, 0, epochParam), { token, body: payloadOf("ck", 64) });
	t.check("checkpoint 200", put.status === 200 && put.value?.coversSeq === seeded.seqs[1], brief(put));
	const state = await checkpointState(ctx, v, seeded.stream);
	t.check("checkpoint applied", state.checkpointSeq === seeded.seqs[1], state);
}

export const tests: TestDef[] = [
	{
		id: "T-EPOCH-MISMATCH", group: "decision", area: "D8c epoch", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const epoch = await currentEpoch(ctx, v);
			const token = v.owner.token;
			const wrong = `${epoch.slice(0, 4)}${id(8)}`;
			const rd = await seedStream(ctx, v, "epm", 2);
			t.expect("present-and-different epoch (incl. empty) -> 409 {error:vault_generation_mismatch, vaultEpoch:current}; checked before the CAS");
			for (const [label, value] of [["wrong", wrong], ["empty", ""]] as const) {
				const q = `&epoch=${encodeURIComponent(value)}`;
				mismatch(t, `feed epoch=${label}`, await http(ctx, "GET", `${v.path}/streams/feed?after=0${q}`, { token }), epoch);
				mismatch(t, `read epoch=${label}`, await http(ctx, "GET",
					`${v.path}/streams/read?stream=${encodeURIComponent(rd.stream)}&after=0${q}`, { token }), epoch);
				const ck = await seedStream(ctx, v, `epc${label[0]}`, 1);
				const put = await http(ctx, "PUT", checkpointPath(v.path, ck.stream, ck.seqs[0]!, 0, q), { token, body: payloadOf("ck", 64) });
				mismatch(t, `checkpoint epoch=${label}`, put, epoch);
				const state = await checkpointState(ctx, v, ck.stream);
				t.check(`checkpoint epoch=${label} not applied`, state.checkpointSeq === 0 && state.checkpoint === null, state);
			}
		},
	},
	{
		id: "T-EPOCH-MATCH", group: "decision", area: "D8c epoch", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const epoch = await currentEpoch(ctx, v);
			t.expect("epoch=current -> feed/read/checkpoint behave normally (200, checkpoint applied)");
			await epochOk(ctx, t, `&epoch=${encodeURIComponent(epoch)}`);
		},
	},
	{
		id: "T-EPOCH-ABSENT", group: "decision", area: "D8c epoch", expectedBefore: "PASS",
		async run(ctx, t) {
			t.expect("no epoch param -> feed/read/checkpoint behave normally (200, checkpoint applied)");
			await epochOk(ctx, t, "");
		},
	},
	{
		id: "T-CKPT-MULTICHUNK", group: "baseline", area: "baseline", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const seeded = await seedStream(ctx, v, "ck", 1);
			const bytes = payloadOf(`multichunk-${id(4)}`, 2_500_000);
			const put = await http(ctx, "PUT", checkpointPath(v.path, seeded.stream, seeded.seqs[0]!, 0), { token: v.owner.token, body: bytes,
				timeoutMs: 120000 });
			t.expect("PUT 2.5 MB checkpoint -> 200; read checkpoint=1 returns identical bytes");
			t.check("PUT 200", put.status === 200 && put.value?.coversSeq === seeded.seqs[0], brief(put));
			const read = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(seeded.stream)}&after=0&checkpoint=1&maxBytes=4194304`,
				{ token: device(v, "B").token, timeoutMs: 120000 });
			const got = read.value?.checkpoint?.bytes ? b64(read.value.checkpoint.bytes) : null;
			t.check("read checkpoint=1 returns identical 2.5 MB", read.status === 200 && read.value.checkpoint.coversSeq === seeded.seqs[0]
				&& bytesEqual(got, bytes), brief(read, { bytes: got?.byteLength ?? null }));
		},
	},
	{
		id: "T-RETIRED-GC", group: "decision", area: "H7 GC", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "gc", ["A", "B"]);
			const seeded = await seedStream(ctx, v, "rgc", 3);
			const lastSeq = seeded.seqs[2]!;
			const put = await http(ctx, "PUT", checkpointPath(v.path, seeded.stream, lastSeq, 0), { token: v.owner.token, body: payloadOf("rgc-ck", 128) });
			t.expect("checkpoint coversSeq=lastSeq -> gcSeq == lastSeq; read after=0 (no checkpoint=1) -> checkpoint included, rows empty; "
				+ "next append readable after old lastSeq");
			t.check("checkpoint 200 with gcSeq == lastSeq", put.status === 200 && put.value?.gcSeq === lastSeq,
				brief(put, { gcSeq: put.value?.gcSeq ?? null, lastSeq, deletedSegments: put.value?.deletedSegments ?? null }));
			const read = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(seeded.stream)}&after=0`, { token: device(v, "B").token });
			t.check("read after=0: checkpoint included, rows empty", read.status === 200 && read.value?.checkpoint?.coversSeq === lastSeq
				&& read.value?.rows?.length === 0, brief(read, { checkpoint: read.value?.checkpoint?.coversSeq ?? null, rows: read.value?.rows?.length,
				gcSeq: read.value?.gcSeq ?? null }));
			const socket = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "rgc");
			const next = (await socket.appendAll([{ stream: seeded.stream, id: "rgc-next", payload: payloadOf("rgc-next", 100) }])).get("rgc-next")!;
			const tail = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(seeded.stream)}&after=${lastSeq}`, { token: device(v, "B").token });
			t.check("read after=old lastSeq returns the new row", tail.status === 200 && tail.value?.rows?.length === 1 && tail.value.rows[0].seq === next.seq,
				brief(tail, { rows: tail.value?.rows?.length }));
		},
	},
	{
		id: "T-PARTIAL-GC", group: "baseline", area: "H7 GC", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "gc", ["A", "B"]);
			const seeded = await seedStream(ctx, v, "pgc", 5);
			const covers = seeded.seqs[2]!;
			const put = await http(ctx, "PUT", checkpointPath(v.path, seeded.stream, covers, 0), { token: v.owner.token, body: payloadOf("pgc-ck", 128) });
			t.expect("checkpoint coversSeq < lastSeq -> rows above coversSeq stay readable (byte-identical)");
			t.check("checkpoint 200", put.status === 200 && put.value?.coversSeq === covers, brief(put, { gcSeq: put.value?.gcSeq ?? null }));
			const above = await readAll(ctx, v.path, device(v, "B").token, seeded.stream, covers);
			t.check("read after=coversSeq returns rows coversSeq+1..lastSeq", above.rows.length === 2
				&& above.rows.every((r, i) => r.seq === seeded.seqs[3 + i] && bytesEqual(b64(r.payload), seeded.items[3 + i]!.payload)),
			{ rows: above.rows.map((r) => r.seq), expected: seeded.seqs.slice(3) });
			const withCkpt = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(seeded.stream)}&after=0&checkpoint=1`,
				{ token: device(v, "B").token });
			t.check("read checkpoint=1: checkpoint@coversSeq + rows above", withCkpt.value?.checkpoint?.coversSeq === covers
				&& withCkpt.value?.rows?.map((r: any) => r.seq).join() === seeded.seqs.slice(3).join(),
			brief(withCkpt, { checkpoint: withCkpt.value?.checkpoint?.coversSeq ?? null, rows: withCkpt.value?.rows?.map((r: any) => r.seq) }));
		},
	},
];
