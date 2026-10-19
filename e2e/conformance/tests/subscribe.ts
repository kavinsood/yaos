/** Per-stream subscriptions (relay-wire §5.6): the limit, filtered fanout, STREAM_SKIPPED ordering, rejects. */
import type { Ctx } from "../lib/context.ts";
import type { TestDef } from "../lib/results.ts";
import { device, vault } from "../lib/fixture.ts";
import { StreamSocket } from "../lib/socket.ts";
import { id, payloadOf } from "../lib/util.ts";

const MAX_SUBSCRIPTIONS = 128;

/** The run's own vault for these tests: three devices, so a subscribed reader and a never-subscribed one are both peers. */
const subsVault = (ctx: Ctx) => vault(ctx, "subs", ["A", "B", "C"]);

const subscribe = (socket: StreamSocket, streams: unknown) => socket.subscribe(streams);
const processed = (socket: StreamSocket) => socket.processed();

/** Every seq the socket was told about after `from`, per stream, in arrival order (skips, COMMITTED and notices). */
function seqsOf(socket: StreamSocket, from: number): Record<string, number[]> {
	const out: Record<string, number[]> = {};
	for (const frame of socket.frames(from)) {
		if (frame.kind === "skipped") for (const run of frame.runs ?? []) (out[run.stream] ??= []).push(...run.seqs);
		else if (frame.seq !== null) (out[frame.stream] ??= []).push(frame.seq);
	}
	return out;
}

/** `seqsOf` / expected maps compared independently of key order. */
const same = (left: Record<string, number[]>, right: Record<string, number[]>) =>
	JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

/** Waits until the socket has been told about `seq` on `stream`, by any frame kind. */
async function waitSeq(socket: StreamSocket, stream: string, seq: number, from: number): Promise<boolean> {
	return await socket.waitFor((e) => {
		const frame = e.frame;
		if (!frame) return undefined;
		if (frame.kind === "skipped") return frame.runs?.some((run) => run.stream === stream && run.seqs.includes(seq)) ? true : undefined;
		return frame.stream === stream && frame.seq === seq ? true : undefined;
	}, 10000, `${stream}#${seq}`, from).then(() => true, () => false);
}

export const tests: TestDef[] = [
	{
		id: "T-SUBSCRIBE-READY", group: "baseline", area: "subscriptions", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await subsVault(ctx);
			const socket = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "ready");
			t.expect("limits.maxSubscriptions == 128");
			t.check("limits.maxSubscriptions == 128", socket.ready.limits?.maxSubscriptions === MAX_SUBSCRIPTIONS,
				{ maxSubscriptions: socket.ready.limits?.maxSubscriptions ?? null });
			socket.close();
		},
	},
	{
		id: "T-SUBSCRIBE-FILTER", group: "baseline", area: "subscriptions", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await subsVault(ctx);
			const writer = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A");
			const own = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A-other");
			const reader = await StreamSocket.connect(ctx, v.vaultId, device(v, "B"), "B");
			const never = await StreamSocket.connect(ctx, v.vaultId, device(v, "C"), "C");
			const tag = id(6);
			const wanted = `b:subs-in-${tag}`;
			const unwanted = `b:subs-out-${tag}`;
			const canvas = `c:subs-out-${tag}`;
			const global = `t:subs-${tag}`;
			const fromReader = await subscribe(reader, [wanted]);
			const fromOwn = await subscribe(own, []);
			const fromNever = never.mark();
			const items = [
				{ stream: unwanted, id: `f1-${tag}`, payload: payloadOf("subs-1", 300) },
				{ stream: wanted, id: `f2-${tag}`, payload: payloadOf("subs-2", 300) },
				{ stream: global, id: `f3-${tag}`, payload: payloadOf("subs-3", 300) },
				{ stream: canvas, id: `f4-${tag}`, payload: payloadOf("subs-4", 300) },
				{ stream: unwanted, id: `f5-${tag}`, payload: payloadOf("subs-5", 300) },
			];
			const receipts = await writer.appendAll(items);
			const seqs: Record<string, number[]> = {};
			for (const item of items) (seqs[item.stream] ??= []).push(receipts.get(item.id)!.seq);
			const last = items.at(-1)!;
			for (const socket of [reader, own, never]) await waitSeq(socket, last.stream, receipts.get(last.id)!.seq, 0);
			t.expect("reader: PROVISIONAL+NOTICE for its stream, COMMITTED for t:, the rest as STREAM_SKIPPED; every seq once, ascending");
			const readerFrames = reader.frames(fromReader);
			const provisionals = readerFrames.filter((f) => f.kind === "provisional").map((f) => f.stream);
			t.check("reader: PROVISIONAL only for the subscribed stream", provisionals.length === 1 && provisionals[0] === wanted,
				{ timeline: reader.timeline(fromReader) });
			const skipped = readerFrames.filter((f) => f.kind === "skipped").flatMap((f) => f.runs ?? []).map((run) => run.stream);
			t.check("reader: unsubscribed b:/c: rows arrive as skips, never with a payload",
				readerFrames.every((f) => f.payload === null || f.stream === wanted || f.stream === global)
					&& skipped.includes(unwanted) && skipped.includes(canvas) && !skipped.includes(wanted) && !skipped.includes(global),
				{ timeline: reader.timeline(fromReader) });
			t.check("reader: each seq exactly once, in order, as committed / notice / skipped",
				same(seqsOf(reader, fromReader), seqs), { got: seqsOf(reader, fromReader), want: seqs });
			t.check("own device's other socket (subscribed to nothing) gets its rows, not skips",
				own.frames(fromOwn).every((f) => f.kind !== "skipped") && same(seqsOf(own, fromOwn), seqs),
				{ timeline: own.timeline(fromOwn) });
			const neverFrames = never.frames(fromNever);
			t.check("a socket that never subscribed has the empty set: COMMITTED for t:, every b:/c: row skipped, no PROVISIONAL",
				neverFrames.every((f) => f.kind === "skipped" || (f.kind === "committed" && f.stream === global))
					&& neverFrames.some((f) => f.kind === "committed") && same(seqsOf(never, fromNever), seqs),
				{ timeline: never.timeline(fromNever) });
			for (const socket of [writer, own, reader, never]) socket.close();
		},
	},
	{
		id: "T-SUBSCRIBE-ORDER", group: "baseline", area: "subscriptions", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await subsVault(ctx);
			const writer = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A");
			const both = await StreamSocket.connect(ctx, v.vaultId, device(v, "B"), "B");
			const tag = id(6);
			const from = await subscribe(both, []);
			// Interleave a peer's unsubscribed rows with this socket's own appends (the peer's admitted first, so most
			// share a commit with the append that follows them).
			const own: string[] = [];
			for (let round = 0; round < 5; round++) {
				writer.append(`b:order-${tag}`, `w${round}-${tag}`, payloadOf(`order-w${round}`, 200));
				await processed(writer);
				own.push(`o${round}-${tag}`);
				both.append(`t:order-${tag}`, own.at(-1)!, payloadOf(`order-o${round}`, 200));
			}
			await both.receipts(own, from);
			t.expect("a skipped seq below a receipt's seq arrives before that receipt (broadcasts precede receipts, R2)");
			// Wait for the peer's last row too, then index every skipped seq by arrival position.
			const lastPeer = (await writer.receipts([`w4-${tag}`], 0)).get(`w4-${tag}`)!;
			await waitSeq(both, `b:order-${tag}`, lastPeer.seq, from);
			const skippedAt = new Map<number, number>();
			for (const [index, event] of both.events.entries()) {
				if (index >= from) for (const run of event.frame?.runs ?? []) for (const seq of run.seqs) skippedAt.set(seq, index);
			}
			const late: unknown[] = [];
			let interleaved = 0;
			for (const [index, event] of both.events.entries()) {
				if (index < from || event.control?.type !== "STREAM_RECEIPTS") continue;
				for (const receipt of event.control.receipts) {
					for (const [seq, at] of skippedAt) {
						if (seq >= receipt.seq) continue;
						if (at > index) late.push({ seq, receipt: receipt.seq });
						else if (at >= from) interleaved++;
					}
				}
			}
			const runs = both.frames(from).flatMap((f) => f.runs ?? []).flatMap((run) => run.seqs);
			t.check("skipped seqs ascend", runs.every((seq, index) => index === 0 || seq > runs[index - 1]!), { runs });
			t.check("no skip of a lower seq arrives after a receipt", late.length === 0, { late, timeline: both.timeline(from) });
			if (interleaved === 0) t.info("no receipt followed a skipped lower seq: the interleave did not occur on this run");
			for (const socket of [writer, both]) socket.close();
		},
	},
	{
		id: "T-SUBSCRIBE-REJECT", group: "baseline", area: "subscriptions", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await subsVault(ctx);
			const writer = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A");
			const reader = await StreamSocket.connect(ctx, v.vaultId, device(v, "B"), "B");
			const tag = id(6);
			const kept = `b:keep-${tag}`;
			await subscribe(reader, [kept]);
			const rejectsOf = async (streams: unknown) => {
				const from = reader.mark();
				await subscribe(reader, streams);
				return reader.events.slice(from).filter((e) => e.control?.type === "STREAM_SUBSCRIBE_REJECTED").map((e) => e.control.code);
			};
			t.expect("non-array / invalid name -> invalid; > 128 distinct -> too_many; 128 distinct + repeats accepted; the set is kept");
			const many = Array.from({ length: MAX_SUBSCRIPTIONS + 1 }, (_, index) => `b:many-${index}`);
			const results = {
				nonArray: await rejectsOf("b:x"),
				emptyName: await rejectsOf([""]),
				nonString: await rejectsOf([kept, 7]),
				tooMany: await rejectsOf(many),
			};
			t.check("invalid inputs -> STREAM_SUBSCRIBE_REJECTED invalid", results.nonArray.join() === "invalid"
				&& results.emptyName.join() === "invalid" && results.nonString.join() === "invalid", results);
			t.check("129 distinct names -> too_many", results.tooMany.join() === "too_many", results);
			const from = reader.mark();
			const receipts = await writer.appendAll([
				{ stream: kept, id: `k-${tag}`, payload: payloadOf("keep", 100) },
				{ stream: `b:drop-${tag}`, id: `d-${tag}`, payload: payloadOf("drop", 100) },
			]);
			await waitSeq(reader, `b:drop-${tag}`, receipts.get(`d-${tag}`)!.seq, from);
			const kinds = reader.frames(from).map((f) => `${f.kind}:${f.kind === "skipped" ? f.runs?.map((r) => r.stream).join() : f.stream}`);
			t.check("after the rejects the previous set still filters",
				JSON.stringify(kinds) === JSON.stringify([`provisional:${kept}`, `notice:${kept}`, `skipped:b:drop-${tag}`]), { kinds });
			const accepted = await rejectsOf([...many.slice(0, MAX_SUBSCRIPTIONS), ...many.slice(0, 5)]);
			t.check("128 distinct names plus repeats are accepted", accepted.length === 0 && reader.isOpen, { accepted });
			for (const socket of [writer, reader]) socket.close();
		},
	},
];
