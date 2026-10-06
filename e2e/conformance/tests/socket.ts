/** D6 VAULT_READY, H1 codec, H8 min interval, baseline socket behaviour (oversize, two sockets, id conflict). */
import type { Ctx } from "../lib/context.ts";
import type { Recorder, TestDef } from "../lib/results.ts";
import { device, ensureDevice, vault } from "../lib/fixture.ts";
import type { Device, Vault } from "../lib/fixture.ts";
import { rawAppend, utf8Bytes, varUintBytes } from "../lib/codec.ts";
import { brief, http } from "../lib/http.ts";
import { StreamSocket } from "../lib/socket.ts";
import { b64, bytesEqual, id, median, payloadOf, round, sleep } from "../lib/util.ts";

const isStr = (x: unknown) => typeof x === "string" && x.length > 0;
const isUint = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
const isPos = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0;

function readyFieldErrors(ready: any, v: Vault, d: Device): string[] {
	const spec: [string, (x: unknown) => boolean][] = [
		["type", (x) => x === "VAULT_READY"], ["documentId", (x) => x === "streams"], ["socketSessionId", isStr],
		["vaultId", (x) => x === v.vaultId], ["vaultGeneration", isStr], ["vaultEpoch", isStr], ["runtimeEpoch", isStr], ["head", isUint],
		["liveness.version", (x) => x === 1], ["liveness.idleMs", isPos], ["liveness.timeoutMs", isPos],
		["capabilities.streams", (x) => x === 1],
		...["maxStreamNameBytes", "maxClientFrameIdBytes", "maxPayloadBytes", "maxBinaryMessageBytes", "maxTextMessageBytes",
			"maxCheckpointBytes", "feedDefaultLimit", "feedMaxLimit", "readDefaultBytes", "readMaxBytes", "rateBytesPerSec", "burstBytes",
		].map((k) => [`limits.${k}`, isPos] as [string, (x: unknown) => boolean]),
		["limits.groupCommit.idleMs", isPos], ["limits.groupCommit.maxMs", isPos], ["limits.groupCommit.maxBytes", isPos],
		["limits.groupCommit.minIntervalMs", isUint],
		["canWrite", (x) => x === true], ["principalId", isStr], ["deviceId", (x) => x === d.deviceId], ["role", (x) => x === "owner"],
		["membershipRevision", isUint], ["deviceCredentialRevision", isUint], ["policyVersion", isUint], ["capabilityDigest", isStr],
	];
	const errors: string[] = [];
	for (const [path, ok] of spec) {
		const value = path.split(".").reduce((node: any, key) => node?.[key], ready);
		if (!ok(value)) errors.push(`${path}=${typeof value === "string" ? (["role", "type", "documentId"].includes(path) ? value : "<string>") : JSON.stringify(value)}`);
	}
	return errors;
}

/** Sends one raw frame on a fresh socket; expects close 1008 and no receipt. */
async function malformedCase(ctx: Ctx, t: Recorder, bytes: Uint8Array, frameId: string) {
	const v = await vault(ctx, "main");
	const socket = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "codec");
	const from = socket.mark();
	socket.sendRaw(bytes);
	const close = await socket.waitClose(6000);
	await sleep(200);
	const receipts = socket.events.slice(from).filter((e) => e.control?.type === "STREAM_RECEIPTS")
		.flatMap((e) => e.control.receipts.map((r: any) => ({ stream: JSON.stringify(r.stream), clientFrameIdMatches: r.clientFrameId === frameId,
			seq: r.seq, deduped: r.deduped })));
	const observed = { closeCode: close?.code ?? null, closeReason: close?.reason ?? null, receipts, frameBytes: bytes.byteLength,
		timeline: socket.timeline(from) };
	t.expect("close 1008, no receipt");
	t.observe("result", observed);
	t.check("closed 1008", close?.code === 1008, { closeCode: close?.code ?? null });
	t.check("no receipt", receipts.length === 0, receipts);
	socket.close();
}

function codecTest(testId: string, expectedBefore: "PASS" | "FAIL", build: (frameId: string) => Uint8Array): TestDef {
	return { id: testId, group: "decision", area: "H1 codec", expectedBefore, async run(ctx, t) {
		const frameId = `${testId.toLowerCase()}-${id(6)}`;
		await malformedCase(ctx, t, build(frameId), frameId);
	} };
}

const payload = () => Array.from(payloadOf("codec", 64));

export const tests: TestDef[] = [
	{
		id: "T-READY-SHAPE", group: "decision", area: "D6 ready", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			t.expect("every §3.2 field with its contract type; role owner; canWrite true");
			for (const label of ["A", "B"]) {
				const d = device(v, label);
				const socket = await StreamSocket.connect(ctx, v.vaultId, d, `ready-${label}`);
				const errors = readyFieldErrors(socket.ready, v, d);
				t.check(`device ${label} VAULT_READY fields`, errors.length === 0, errors);
				if (label === "A") {
					t.observe("limits", socket.ready.limits);
					t.observe("liveness", socket.ready.liveness);
					t.observe("role", socket.ready.role);
					t.observe("vaultEpochEqualsVaultGeneration", socket.ready.vaultEpoch === socket.ready.vaultGeneration);
					t.observe("keys", Object.keys(socket.ready).sort());
				}
				socket.close();
			}
		},
	},
	{
		id: "T-MININTERVAL-READY", group: "decision", area: "H8 min interval", expectedBefore: "FAIL",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const socket = await StreamSocket.connect(ctx, v.vaultId, v.owner, "ready");
			const value = socket.ready.limits?.groupCommit?.minIntervalMs;
			t.check("limits.groupCommit.minIntervalMs == 1000", value === 1000, { minIntervalMs: value ?? null });
			socket.close();
		},
	},
	codecTest("T-CODEC-UTF8", "PASS", (fid) => rawAppend({ stream: [0x62, 0x3a, 0xff, 0x78], id: utf8Bytes(fid), payload: payload() })),
	codecTest("T-CODEC-SURROGATE", "PASS", (fid) => rawAppend({ stream: [0x62, 0x3a, 0xed, 0xa0, 0x80], id: utf8Bytes(fid), payload: payload() })),
	codecTest("T-CODEC-OVERLONG", "PASS", (fid) => rawAppend({ stream: [0x62, 0x3a, 0xc0, 0xaf], id: utf8Bytes(fid), payload: payload() })),
	codecTest("T-CODEC-NONMINIMAL", "FAIL", (fid) => rawAppend({ streamLen: [0x82, 0x00], stream: utf8Bytes("zq"), id: utf8Bytes(fid),
		payload: payload() })),
	codecTest("T-CODEC-TRAILING", "PASS", (fid) => rawAppend({ stream: utf8Bytes("b:trailing"), id: utf8Bytes(fid), payload: payload(),
		trailing: [0x00] })),
	{
		id: "T-CODEC-VALID", group: "decision", area: "H1 codec", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const stream = "b:é✓😀";
			const fid = `codec-valid-${id(6)}`;
			const body = payloadOf("valid", 128);
			const a = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A");
			const b = await StreamSocket.connect(ctx, v.vaultId, device(v, "B"), "B");
			const fromB = b.mark();
			const frame = rawAppend({ stream: utf8Bytes(stream), id: utf8Bytes(fid), payload: Array.from(body) });
			t.check("encoder emits minimal lengths", frame[1] === utf8Bytes(stream).byteLength && varUintBytes(utf8Bytes(stream).byteLength).length === 1);
			const from = a.mark();
			a.sendRaw(frame);
			const got = await a.collect([fid], from, 10000);
			const receipt = got.receipts.get(fid);
			t.check("receipt names the identical stream string", receipt?.stream === stream,
				{ receipt: receipt ? { stream: JSON.stringify(receipt.stream), seq: receipt.seq } : null, closed: got.closed, rejected: got.rejected });
			const notice = await b.waitFor((e) => e.frame?.kind === "notice" && e.frame.clientFrameId === fid ? e.frame : undefined, 10000,
				"notice", fromB).catch(() => null);
			const provisional = b.frames(fromB).find((f) => f.kind === "provisional" && f.clientFrameId === fid);
			t.check("peer PROVISIONAL + NOTICE carry the identical stream string", provisional?.stream === stream && notice?.value.stream === stream
				&& bytesEqual(provisional?.payload, body), { provisional: provisional ? JSON.stringify(provisional.stream) : null,
				notice: notice ? JSON.stringify(notice.value.stream) : null });
			const read = await http(ctx, "GET", `${v.path}/streams/read?stream=${encodeURIComponent(stream)}&after=0`, { token: device(v, "B").token });
			t.check("read by name returns the row byte-identical", read.status === 200 && read.value?.stream === stream
				&& read.value.rows?.length === 1 && bytesEqual(b64(read.value.rows[0].payload), body), brief(read, { rows: read.value?.rows?.length }));
			const feed = await http(ctx, "GET", `${v.path}/streams/feed?after=0`, { token: device(v, "B").token });
			t.check("feed lists the identical stream string", (feed.value?.changes ?? []).some((c: any) => c.stream === stream), brief(feed));
		},
	},
	{
		id: "T-OVERSIZE-1009", group: "baseline", area: "baseline", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const d = await ensureDevice(ctx, v, "O");
			t.expect("close 1009 for payload > 1 MiB (both below and above the raw 1 MiB + 1 KiB message cap)");
			const variants: [string, number][] = [["payload 1 MiB + 1 B", 1024 * 1024 + 1], ["payload 1 MiB + 4 KiB", 1024 * 1024 + 4096]];
			for (const [index, [name, size]] of variants.entries()) {
				if (index > 0) await sleep(5000); // let a (possibly per-device) bucket refill
				const socket = await StreamSocket.connect(ctx, v.vaultId, d, `oversize-${index}`);
				const fid = `oversize-${index}-${id(4)}`;
				const from = socket.mark();
				socket.append(`b:oversize-${id(4)}`, fid, payloadOf(fid, size));
				const close = await socket.waitClose(15000);
				const receipts = socket.events.slice(from).filter((e) => e.control?.type === "STREAM_RECEIPTS").length;
				t.check(`${name}: close 1009, no receipt`, close?.code === 1009 && receipts === 0,
					{ closeCode: close?.code ?? null, reason: close?.reason ?? null, receipts, timeline: socket.timeline(from) });
				socket.close();
			}
		},
	},
	{
		id: "T-TWO-SOCKETS", group: "baseline", area: "baseline", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const a1 = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A1");
			const a2 = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A2");
			const b = await StreamSocket.connect(ctx, v.vaultId, device(v, "B"), "B");
			const docStream = `b:two-${id(6)}`;
			const plainStream = `t:two-${id(6)}`;
			const pb = payloadOf("two-b", 500);
			const pt = payloadOf("two-t", 700);
			const marks = [a1.mark(), a2.mark()];
			const receipts = await b.appendAll([{ stream: docStream, id: "two-b", payload: pb }, { stream: plainStream, id: "two-t", payload: pt }]);
			t.check("origin got both receipts", receipts.size === 2, [...receipts.values()].map((r) => ({ seq: r.seq, deduped: r.deduped })));
			for (const [index, socket] of [a1, a2].entries()) {
				const notice = await socket.waitFor((e) => e.frame?.kind === "notice" && e.frame.clientFrameId === "two-b" ? e.frame : undefined,
					10000, "notice", marks[index]).catch(() => null);
				const committed = await socket.waitFor((e) => e.frame?.kind === "committed" && e.frame.clientFrameId === "two-t" ? e.frame : undefined,
					10000, "committed", marks[index]).catch(() => null);
				const provisional = socket.frames(marks[index]).find((f) => f.kind === "provisional" && f.clientFrameId === "two-b");
				t.check(`${socket.name}: PROVISIONAL + NOTICE(b:) and COMMITTED(t:) with origin's seqs`, !!provisional && bytesEqual(provisional.payload, pb)
					&& notice?.value.seq === receipts.get("two-b")?.seq && committed?.value.seq === receipts.get("two-t")?.seq
					&& bytesEqual(committed?.value.payload, pt) && provisional.deviceId === device(v, "B").deviceId,
				{ timeline: socket.timeline(marks[index]) });
			}
		},
	},
	{
		id: "T-DEDUPE-CONFLICT", group: "baseline", area: "H2 dedupe", expectedBefore: "PASS",
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const a = await StreamSocket.connect(ctx, v.vaultId, device(v, "A"), "A");
			const stream = `b:dc-${id(6)}`;
			const fid = `dc-${id(6)}`;
			const first = (await a.appendAll([{ stream, id: fid, payload: payloadOf("dc-1", 200) }])).get(fid)!;
			const from = a.mark();
			a.append(stream, fid, payloadOf("dc-2 different bytes", 200));
			const got = await a.collect([fid], from, 10000);
			const rejected = got.rejected[0];
			t.expect("STREAM_APPEND_REJECTED client_frame_id_conflict (seq = original when present)");
			t.check("same id, different bytes -> client_frame_id_conflict", rejected?.code === "client_frame_id_conflict"
				&& (rejected.seq === undefined || rejected.seq === first.seq) && got.receipts.size === 0,
			{ rejected: rejected ? { code: rejected.code, seqMatches: rejected.seq === first.seq } : null, receipts: got.receipts.size,
				closed: got.closed });
		},
	},
	{
		id: "T-MININTERVAL-TIMING", group: "decision", area: "H8 min interval", expectedBefore: "FAIL", slow: true,
		async run(ctx, t) {
			const v = await vault(ctx, "main");
			const d = await ensureDevice(ctx, v, "M");
			const socket = await StreamSocket.connect(ctx, v.vaultId, d, "M");
			const stream = `b:mi-${id(6)}`;
			const gaps: number[] = [];
			const firstLatency: number[] = [];
			for (let trial = 0; trial < 5; trial++) {
				await sleep(1500);
				const f1 = `mi-${trial}-1`;
				const f2 = `mi-${trial}-2`;
				const t1 = Date.now();
				const r1 = (await socket.appendAll([{ stream, id: f1, payload: payloadOf(f1, 256) }])).get(f1)!;
				firstLatency.push(Date.now() - t1);
				const from = socket.mark();
				socket.append(stream, f2, payloadOf(f2, 256));
				const r2 = (await socket.receipts([f2], from)).get(f2)!;
				gaps.push(round(r2.at - r1.at));
			}
			const med = median(gaps)!;
			t.expect("median(second receipt - first receipt) >= ~900 ms (second append sent on first receipt)");
			t.observe("gapsMs", gaps);
			t.observe("firstAppendToReceiptMs", firstLatency);
			t.check("median gap >= 900 ms", med >= 900, { medianGapMs: med });
		},
	},
];
