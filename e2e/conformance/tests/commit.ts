/** H2 dedupe window, H6 per-device limits, baseline per-socket rate gate. */
import type { Ctx } from "../lib/context.ts";
import type { TestDef } from "../lib/results.ts";
import { ensureDevice, vault } from "../lib/fixture.ts";
import { readAll } from "../lib/streams.ts";
import { StreamSocket } from "../lib/socket.ts";
import { b64, bytesEqual, id, now, payloadOf, round, sleep } from "../lib/util.ts";

const KiB = 1024;
const RATE = 256 * KiB;
const BURST = 2 * 1024 * KiB;

/** Seconds to wait so a token bucket that was drained by `bytes` is full again. */
const refillMs = (bytes: number) => Math.ceil((Math.min(bytes, BURST) / RATE) * 1000) + 1000;

interface Item { stream: string; id: string; payload: Uint8Array }

async function paced(socket: StreamSocket, items: Item[], bytesPerSec: number) {
	const t0 = now();
	let sent = 0;
	for (const item of items) {
		const due = t0 + (sent / bytesPerSec) * 1000;
		const wait = due - now();
		if (wait > 0) await sleep(wait);
		socket.append(item.stream, item.id, item.payload);
		sent += item.payload.byteLength + item.id.length + item.stream.length + 8;
	}
	return round(now() - t0);
}

/** Samples bufferedAmount until the socket closes or drains + settles, for an upload throughput estimate. */
async function uploadProfile(socket: StreamSocket, totalBytes: number, t0: number, maxMs: number) {
	let drainedAt: number | null = null;
	let bufferedAtClose: number | null = null;
	const deadline = t0 + maxMs;
	while (now() < deadline) {
		const buffered = socket.ws.bufferedAmount;
		if (socket.closed) { bufferedAtClose = buffered; break; }
		if (buffered === 0 && drainedAt === null) drainedAt = now();
		if (drainedAt !== null && now() - drainedAt > 3000) break;
		await sleep(10);
	}
	const end = socket.closed?.at ?? drainedAt ?? now();
	const uploaded = totalBytes - (bufferedAtClose ?? 0);
	return { drainedAtMs: drainedAt === null ? null : round(drainedAt - t0), closedAtMs: socket.closed ? round(socket.closed.at - t0) : null,
		bufferedAtClose, uploadedBytes: uploaded, approxUploadKiBps: Math.round(uploaded / KiB / Math.max(0.001, (end - t0) / 1000)) };
}

function backpressureThen1013(socket: StreamSocket) {
	const bp = socket.events.find((e) => e.control?.type === "VAULT_BACKPRESSURE");
	return { backpressure: !!bp, reason: bp?.control.reason ?? null, closeCode: socket.closed?.code ?? null,
		ordered: !!bp && !!socket.closed && bp.at <= socket.closed.at, ok: !!bp && socket.closed?.code === 1013 && bp.at <= socket.closed.at };
}

async function dedupeRun(ctx: Ctx, label: string, items: Item[], send: (socket: StreamSocket, items: Item[]) => Promise<unknown>,
	waitMs: number, receiptTimeoutMs: number) {
	const v = await vault(ctx, "dedupe", ["A"]);
	const d = await ensureDevice(ctx, v, label);
	const s1 = await StreamSocket.connect(ctx, v.vaultId, d, `${label}-1`);
	let from = s1.mark();
	await send(s1, items);
	const first = await s1.receipts(items.map((i) => i.id), from, receiptTimeoutMs);
	s1.close();
	await sleep(waitMs);
	const s2 = await StreamSocket.connect(ctx, v.vaultId, d, `${label}-2`);
	from = s2.mark();
	await send(s2, items);
	const second = await s2.collect(items.map((i) => i.id), from, receiptTimeoutMs);
	const rows = (await readAll(ctx, v.path, d.token, items[0]!.stream)).rows;
	const deduped = items.filter((i) => second.receipts.get(i.id)?.deduped === true).length;
	const sameSeq = items.filter((i) => second.receipts.get(i.id)?.seq === first.get(i.id)?.seq).length;
	return { v, first, second, rows, deduped, sameSeq, observed: { frames: items.length, firstReceipts: first.size,
		resendReceipts: second.receipts.size, deduped, sameSeq, rowsAfter: rows.length, rejected: second.rejected.length,
		closed: second.closed?.code ?? null, timedOut: second.timedOut,
		firstSeqs: `${first.get(items[0]!.id)?.seq}..${first.get(items.at(-1)!.id)?.seq}` } };
}

export const tests: TestDef[] = [
	{
		id: "T-DEDUPE-LARGE", group: "decision", area: "H2 dedupe", expectedBefore: "FAIL", slow: true, timeoutMs: 180000,
		async run(ctx, t) {
			const stream = `b:dl-${id(6)}`;
			const items = [0, 1, 2].map((i) => ({ stream, id: `dl-${i}`, payload: payloadOf(`dl-${i}-${id(4)}`, 600 * KiB) }));
			const total = items.reduce((s, i) => s + i.payload.byteLength, 0);
			const r = await dedupeRun(ctx, "L", items, async (socket, list) => { for (const i of list) socket.append(i.stream, i.id, i.payload); },
				refillMs(total), 30000);
			t.expect("resend on a new socket -> 3 receipts deduped:true with the original seqs; read shows 3 rows");
			t.observe("result", r.observed);
			t.check("3 deduped receipts", r.deduped === 3, { deduped: r.deduped });
			t.check("same seqs", r.sameSeq === 3, { sameSeq: r.sameSeq });
			t.check("read shows 3 rows", r.rows.length === 3, { rows: r.rows.length });
		},
	},
	{
		id: "T-DEDUPE-SMALL", group: "decision", area: "H2 dedupe", expectedBefore: "FAIL", slow: true, timeoutMs: 180000,
		async run(ctx, t) {
			const stream = `b:ds-${id(6)}`;
			const items = Array.from({ length: 400 }, (_, i) => ({ stream, id: `ds-${i}`, payload: payloadOf(`ds-${i}`, 4 * KiB) }));
			const r = await dedupeRun(ctx, "S", items, (socket, list) => paced(socket, list, 200 * KiB), 3000, 30000);
			t.expect("400x4 KiB paced at ~200 KiB/s, resend on a new socket -> all 400 deduped with the original seqs");
			t.observe("result", r.observed);
			t.check("all deduped", r.deduped === 400, { deduped: r.deduped });
			t.check("same seqs", r.sameSeq === 400, { sameSeq: r.sameSeq });
			t.check("no new rows", r.rows.length === 400, { rows: r.rows.length });
		},
	},
	{
		id: "T-RATE-SOCKET", group: "baseline", area: "H6 rate", expectedBefore: "PASS", slow: true, timeoutMs: 180000,
		async run(ctx, t) {
			const v = await vault(ctx, "rate", ["A"]);
			const d = await ensureDevice(ctx, v, "R");
			const socket = await StreamSocket.connect(ctx, v.vaultId, d, "R1");
			const stream = `b:rs-${id(6)}`;
			const order: Item[] = [];
			for (let i = 0; i < 8; i++) {
				order.push({ stream, id: `rs-${i}-s`, payload: payloadOf(`rs-${i}-s`, 4 * KiB) });
				order.push({ stream, id: `rs-${i}-l`, payload: payloadOf(`rs-${i}-l`, 512 * KiB) });
			}
			const total = order.reduce((s, i) => s + i.payload.byteLength, 0);
			const from = socket.mark();
			const t0 = now();
			for (const item of order) socket.append(item.stream, item.id, item.payload);
			const upload = await uploadProfile(socket, total, t0, 30000);
			await socket.waitClose(5000);
			const gate = backpressureThen1013(socket);
			t.expect("~4 MiB burst on one socket -> VAULT_BACKPRESSURE then 1013; committed frames are a prefix of the send order; "
				+ "accepted-but-unreceipted frames commit; resending them on a new socket -> deduped, same seqs");
			t.observe("upload", { totalBytes: total, ...upload });
			t.observe("gate", gate);
			t.observe("timeline", socket.timeline(from));
			if (!gate.backpressure && !socket.closed) {
				t.fail(`no trip: socket still open after ${round(total / KiB)} KiB (upload ~${upload.approxUploadKiBps} KiB/s; tripping needs `
					+ `X*(1-256KiB/s/B) > 2 MiB)`);
				return;
			}
			t.check("VAULT_BACKPRESSURE relay_rate_limit then close 1013", gate.ok && gate.reason === "relay_rate_limit", gate);
			const receipted = new Map<string, number>();
			for (const e of socket.events.slice(from)) {
				if (e.control?.type === "STREAM_RECEIPTS") for (const r of e.control.receipts) receipted.set(r.clientFrameId, r.seq);
			}
			await sleep(2500); // the buffered tail commits on the idle / max timer
			const rows = (await readAll(ctx, v.path, d.token, stream)).rows;
			const committed = rows.map((r) => r.clientFrameId);
			const sendIds = order.map((i) => i.id);
			const prefix = committed.every((cid, index) => cid === sendIds[index])
				&& rows.every((r) => bytesEqual(b64(r.payload), order.find((i) => i.id === r.clientFrameId)!.payload));
			t.check("committed rows are a prefix of the send order (byte-identical)", prefix, { committed: committed.length });
			t.check("frames after the trip were not committed", committed.length < order.length, { committed: committed.length, sent: order.length });
			t.check("every receipted frame is committed with its receipt seq", [...receipted].every(([cid, seq]) => rows.find((r) => r.clientFrameId === cid)?.seq === seq),
				{ receipted: receipted.size });
			const unreceipted = rows.filter((r) => !receipted.has(r.clientFrameId));
			const lastReceipted = rows.filter((r) => receipted.has(r.clientFrameId)).at(-1);
			const resend = [...unreceipted, ...(lastReceipted ? [lastReceipted] : [])].sort((a, b) => a.seq - b.seq);
			t.observe("commit", { receipted: receipted.size, committed: committed.length, acceptedUnreceipted: unreceipted.length,
				resent: resend.length });
			await sleep(refillMs(total));
			const s2 = await StreamSocket.connect(ctx, v.vaultId, d, "R2");
			const items = resend.map((r) => order.find((i) => i.id === r.clientFrameId)!);
			const from2 = s2.mark();
			for (const item of items) s2.append(item.stream, item.id, item.payload);
			const got = await s2.collect(items.map((i) => i.id), from2, 15000);
			const dedupedSame = resend.filter((r) => got.receipts.get(r.clientFrameId)?.deduped === true && got.receipts.get(r.clientFrameId)?.seq === r.seq);
			t.check("resent accepted frames -> deduped with the committed seqs", resend.length > 0 && dedupedSame.length === resend.length,
				{ resent: resend.length, dedupedSameSeq: dedupedSame.length, receipts: got.receipts.size, closed: got.closed?.code ?? null });
		},
	},
	{
		id: "T-RATE-DEVICE", group: "decision", area: "H6 rate", expectedBefore: "FAIL", slow: true, timeoutMs: 120000,
		async run(ctx, t) {
			const v = await vault(ctx, "rate", ["A"]);
			const d = await ensureDevice(ctx, v, "D");
			const s1 = await StreamSocket.connect(ctx, v.vaultId, d, "D1");
			const s2 = await StreamSocket.connect(ctx, v.vaultId, d, "D2");
			const marks = [s1.mark(), s2.mark()];
			const t0 = now();
			for (let i = 0; i < 3; i++) {
				s1.append(`b:rd1-${id(4)}`, `rd1-${i}`, payloadOf(`rd1-${i}`, 512 * KiB));
				s2.append(`b:rd2-${id(4)}`, `rd2-${i}`, payloadOf(`rd2-${i}`, 512 * KiB));
			}
			const [u1, u2] = await Promise.all([uploadProfile(s1, 1536 * KiB, t0, 30000), uploadProfile(s2, 1536 * KiB, t0, 30000)]);
			await sleep(1500);
			const g = [backpressureThen1013(s1), backpressureThen1013(s2)];
			t.expect("2 sockets of one device x 1.5 MiB each -> at least one gets VAULT_BACKPRESSURE then 1013 (per-device bucket)");
			t.observe("sockets", g.map((gate, i) => ({ ...gate, upload: [u1, u2][i], timeline: [s1, s2][i]!.timeline(marks[i]) })));
			t.check("at least one socket: VAULT_BACKPRESSURE then 1013", g.some((gate) => gate.ok), g.map((gate) => ({ bp: gate.backpressure, close: gate.closeCode })));
		},
	},
	{
		id: "T-SOCKET-CAP-DEVICE", group: "decision", area: "H6 rate", expectedBefore: "FAIL", timeoutMs: 120000,
		async run(ctx, t) {
			const v = await vault(ctx, "rate", ["A"]);
			const d = await ensureDevice(ctx, v, "K");
			const sockets: StreamSocket[] = [];
			let fifthReady = false;
			for (let i = 1; i <= 5; i++) {
				try {
					sockets.push(await StreamSocket.connect(ctx, v.vaultId, d, `K${i}`));
					if (i === 5) fifthReady = true;
				} catch (error) {
					t.info(`socket ${i} did not reach VAULT_READY`, { error: String(error).slice(0, 160) });
				}
				await sleep(300);
			}
			// Server-initiated closes outside a message handler can reach the client ~10 s late on today's Worker (see T-REVOKE-4403).
			await (sockets[0]?.waitClose(15000) ?? sleep(2000));
			const codes = sockets.map((s) => ({ name: s.name, closeCode: s.closed?.code ?? null, open: s.isOpen,
				timeline: s.timeline(0, 6) }));
			t.expect("opening a 5th socket for one device -> the 1st closes 1001, the 5th gets VAULT_READY");
			t.observe("sockets", codes);
			t.check("1st socket closed 1001", sockets[0]?.closed?.code === 1001, codes[0]);
			t.check("5th socket got VAULT_READY and is open", fifthReady && !!sockets[4]?.isOpen, codes[4] ?? null);
		},
	},
];
