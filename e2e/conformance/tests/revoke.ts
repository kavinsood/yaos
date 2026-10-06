/**
 * D7 revoke, measured on the wire. The victim A uses a raw RFC 6455 client (lib/rawsocket.ts): it can keep sending
 * after the server's close frame (undici's send() drops data once a close frame arrived), and it timestamps the close
 * frame and the TCP end separately. B is an ordinary observer socket of the same vault, and its bearer reads back
 * what committed.
 *
 * - T-REVOKE-GATE: is the inbound write gate shut once the revoke response is back (t1)? PASS iff no A frame sent
 *   after t1 committed. 3 streaming cycles plus 1 cycle where the DO may hibernate before the revoke.
 * - T-REVOKE-SILENCE: PASS iff no revoked socket gets a data-bearing message after t1 while B keeps writing.
 * - T-REVOKE-BUFFER: frames buffered for group commit (B saw PROVISIONAL, no commit yet) when the revoke was sent.
 *   PASS iff none of them ever commits (F17 flipped for the rewrite: drop them in the revoke turn).
 *
 * The decided route DELETE /operator/vaults/:id/devices/:deviceId is tried first. If the Worker has no such route,
 * the owner route DELETE /vault/:id/devices/:deviceId (with B's bearer) is used, as in tests/operator.ts.
 * A's frames go on a `b:` stream, so B receives a PROVISIONAL the moment a frame is admitted (before its commit).
 */
import type { Ctx } from "../lib/context.ts";
import type { Recorder, TestDef } from "../lib/results.ts";
import { createVault, operatorCookie } from "../lib/fixture.ts";
import type { Device, Vault } from "../lib/fixture.ts";
import { RawSocket } from "../lib/rawsocket.ts";
import type { RawEvent, RawOptions } from "../lib/rawsocket.ts";
import { StreamSocket } from "../lib/socket.ts";
import type { SocketEvent } from "../lib/socket.ts";
import { readAll } from "../lib/streams.ts";
import { id, now, payloadOf, round, sleep } from "../lib/util.ts";

const enc = encodeURIComponent;
const ADVERSARIAL: RawOptions = { replyToClose: false };
const POLITE: RawOptions = { replyToClose: true };
const rel = (at: number | null | undefined, ref: number) => (at === null || at === undefined ? null : round(at - ref));

// ---- revoke ---------------------------------------------------------------------------------------------------

interface Revoke { route: string; status: number; error: unknown; pending: unknown; t0: number; t1: number; t1Body: number;
	operatorRouteProbe?: { status: number; error: unknown } }

/** Once the decided operator route is known to be missing, later cycles go straight to the owner route. */
const operatorRouteMissing = new WeakSet<Ctx>();

async function timed(ctx: Ctx, method: string, path: string, options: { token?: string; cookie?: string; json?: unknown }) {
	const headers: Record<string, string> = {};
	if (options.token) headers.Authorization = `Bearer ${options.token}`;
	if (options.cookie) headers.Cookie = options.cookie;
	let body: string | undefined;
	if (options.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(options.json); }
	const t0 = now();
	const response = await fetch(`${ctx.host}${path}`, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30000) });
	const t1 = now();
	const text = await response.text();
	const t1Body = now();
	let value: any = null;
	try { value = text ? JSON.parse(text) : null; } catch { value = null; }
	return { status: response.status, value, t0, t1, t1Body };
}

/** t0 = request sent, t1 = response headers received (the stricter end), t1Body = body read. */
async function revoke(ctx: Ctx, v: Vault, victim: Device, requester: Device, cookie: string): Promise<Revoke> {
	let operatorRouteProbe: Revoke["operatorRouteProbe"];
	if (!operatorRouteMissing.has(ctx)) {
		const r = await timed(ctx, "DELETE", `/operator/vaults/${enc(v.vaultId)}/devices/${enc(victim.deviceId)}`, { cookie });
		const missing = r.status === 404 && (r.value?.error === "not found" || r.value === null);
		if (!missing) return { route: "DELETE /operator/vaults/:vaultId/devices/:deviceId", status: r.status, error: r.value?.error ?? null,
			pending: r.value?.pending ?? null, t0: r.t0, t1: r.t1, t1Body: r.t1Body };
		operatorRouteMissing.add(ctx);
		operatorRouteProbe = { status: r.status, error: r.value?.error ?? null };
	}
	const r = await timed(ctx, "DELETE", `${v.path}/devices/${enc(victim.deviceId)}`, { token: requester.token, json: { requestId: id(18) } });
	return { route: "legacy owner DELETE /vault/:vaultId/devices/:deviceId (decided operator route missing)", status: r.status,
		error: r.value?.error ?? null, pending: r.value?.pending ?? null, t0: r.t0, t1: r.t1, t1Body: r.t1Body,
		...(operatorRouteProbe ? { operatorRouteProbe } : {}) };
}

function revokeBrief(r: Revoke) {
	return { route: r.route, status: r.status, error: r.error, pending: r.pending, requestMs: round(r.t1 - r.t0),
		...(r.operatorRouteProbe ? { operatorRouteProbe: r.operatorRouteProbe } : {}) };
}

const revokeOk = (r: { status: number; pending: unknown }) => r.status === 200 && r.pending !== true;

// ---- fixtures -------------------------------------------------------------------------------------------------

/** Fresh vault: B is the owner-code device (observer and revoke requester), A is the victim. */
async function setup(ctx: Ctx, key: string) {
	const cookie = await operatorCookie(ctx);
	const v = await createVault(ctx, key, ["B", "A"]);
	return { v, A: v.devices.find((d) => d.label === "A")!, B: v.owner, cookie };
}

/** Raw sockets join ctx.openSockets so the runner tears them down after the test (it only calls close()). */
function track(ctx: Ctx, socket: RawSocket): RawSocket {
	ctx.openSockets.add(socket as unknown as StreamSocket);
	return socket;
}

interface Sent { id: string; at: number; written: boolean; note?: string }

/** Per clientFrameId of `deviceId` on `stream`, what a peer socket saw: admission (PROVISIONAL) and commit (NOTICE/COMMITTED). */
function peerView(events: SocketEvent[], stream: string, deviceId: string) {
	const out = new Map<string, { provisionalAt?: number; commitAt?: number; seq?: number }>();
	for (const e of events) {
		const f = e.frame;
		if (!f || f.stream !== stream || f.deviceId !== deviceId) continue;
		const entry = out.get(f.clientFrameId) ?? {};
		if (f.kind === "provisional") entry.provisionalAt ??= e.at;
		else if (entry.commitAt === undefined) { entry.commitAt = e.at; entry.seq = f.seq ?? undefined; }
		out.set(f.clientFrameId, entry);
	}
	return out;
}

/** clientFrameId -> first receipt on the victim's own socket. */
function receiptsOf(events: RawEvent[]) {
	const out = new Map<string, { at: number; seq: number }>();
	for (const e of events) {
		if (e.control?.type !== "STREAM_RECEIPTS") continue;
		for (const r of e.control.receipts ?? []) if (!out.has(r.clientFrameId)) out.set(r.clientFrameId, { at: e.at, seq: r.seq });
	}
	return out;
}

async function committedRows(ctx: Ctx, v: Vault, reader: Device, stream: string, deviceId: string) {
	const rows = (await readAll(ctx, v.path, reader.token, stream)).rows.filter((r) => r.deviceId === deviceId);
	return new Map(rows.map((r) => [r.clientFrameId, r.seq]));
}

/** What the victim's socket received after `after`, summarized (times relative to `ref`). */
function receivedAfter(events: RawEvent[], after: number, ref: number, max = 30) {
	const list = events.filter((e) => e.at > after);
	const counts: Record<string, number> = {};
	const items: string[] = [];
	for (const e of list) {
		const kind = e.type === "control" ? `control:${e.control?.type}${e.control?.code ? `(${e.control.code})` : ""}`
			: e.type === "frame" ? `frame:${e.frame!.kind}` : e.type === "close-frame" ? `close-frame:${e.close!.code}` : e.type;
		counts[kind] = (counts[kind] ?? 0) + 1;
		if (items.length >= max) continue;
		let detail = "";
		if (e.control?.type === "STREAM_RECEIPTS") {
			const ids = (e.control.receipts ?? []).map((r: any) => r.clientFrameId as string);
			detail = ` [${ids.length}: ${ids[0]}${ids.length > 1 ? `..${ids.at(-1)}` : ""}]`;
		} else if (e.frame) detail = ` ${e.frame.stream} ${e.frame.clientFrameId}${e.frame.seq !== null ? `#${e.frame.seq}` : ""}`;
		else if (e.type === "end") detail = `(${e.note})`;
		items.push(`${rel(e.at, ref)} ${kind}${detail}`);
	}
	return { total: list.length, counts, items };
}

function errorFrames(events: RawEvent[], t0: number, t1: number) {
	const errors = events.filter((e) => e.control?.type === "error");
	return { count: errors.length, codes: [...new Set(errors.map((e) => e.control.code))],
		firstRelT0: rel(errors[0]?.at, t0), firstRelT1: rel(errors[0]?.at, t1), lastRelT1: rel(errors.at(-1)?.at, t1) };
}

function closeReport(a: RawSocket, t0: number, t1: number) {
	return { closeFrame: a.closeFrame ? { code: a.closeFrame.code, reason: a.closeFrame.reason, relT0: rel(a.closeFrame.at, t0),
		relT1: rel(a.closeFrame.at, t1) } : null, closeReplySentRelT0: rel(a.sentClose?.at, t0),
		tcpEnd: a.ended ? { how: a.ended.how, relT0: rel(a.ended.at, t0), relT1: rel(a.ended.at, t1) } : null };
}

const span = (values: number[]) => (values.length ? [Math.min(...values), Math.max(...values)] : null);

/** Fate of every A frame by send phase: before t0, in [t0, t1], after t1. */
function classify(sent: Sent[], t0: number, t1: number, committed: Map<string, number>,
	peer: Map<string, { provisionalAt?: number; commitAt?: number }>, receipts: Map<string, { at: number }>) {
	const written = sent.filter((s) => s.written);
	const phase = (s: Sent) => (s.at < t0 ? "beforeT0" : s.at <= t1 ? "t0toT1" : "afterT1");
	const summary: Record<string, unknown> = {};
	for (const name of ["beforeT0", "t0toT1", "afterT1"]) {
		const group = written.filter((s) => phase(s) === name);
		summary[name] = { sent: group.length, committed: group.filter((s) => committed.has(s.id)).length,
			admitted: group.filter((s) => peer.get(s.id)?.provisionalAt !== undefined).length,
			receipted: group.filter((s) => receipts.has(s.id)).length };
	}
	const windowFrames = written.filter((s) => phase(s) === "t0toT1");
	const afterCommitted = written.filter((s) => phase(s) === "afterT1" && committed.has(s.id));
	const afterAdmitted = written.filter((s) => phase(s) === "afterT1" && peer.get(s.id)?.provisionalAt !== undefined);
	const committedList = written.filter((s) => committed.has(s.id));
	const lastCommitted = committedList.at(-1);
	const firstRejected = written.find((s) => !committed.has(s.id));
	const k = committedList.length;
	return {
		notWritten: sent.length - written.length,
		byPhase: summary,
		window: { sent: windowFrames.length,
			committedSentRelT0: span(windowFrames.filter((s) => committed.has(s.id)).map((s) => round(s.at - t0))),
			notCommittedSentRelT0: span(windowFrames.filter((s) => !committed.has(s.id)).map((s) => round(s.at - t0))) },
		lastCommitted: lastCommitted ? { id: lastCommitted.id, sentRelT0: rel(lastCommitted.at, t0), sentRelT1: rel(lastCommitted.at, t1) } : null,
		firstNotCommitted: firstRejected ? { id: firstRejected.id, sentRelT0: rel(firstRejected.at, t0), sentRelT1: rel(firstRejected.at, t1) } : null,
		committedIsPrefix: written.slice(0, k).every((s) => committed.has(s.id)) && committed.size === k,
		afterT1Committed: afterCommitted.map((s) => ({ id: s.id, sentRelT1: rel(s.at, t1), seq: committed.get(s.id) })),
		afterT1Admitted: afterAdmitted.map((s) => ({ id: s.id, sentRelT1: rel(s.at, t1) })),
		lastSentRelT1: rel(written.at(-1)?.at, t1),
	};
}

// ---- T-REVOKE-GATE ------------------------------------------------------------------------------------------------

async function pingRtt(b: StreamSocket): Promise<{ rttMs: number; runtimeEpoch: string } | null> {
	const from = b.mark();
	const sentAt = b.control({ type: "VAULT_PING", probeId: `p-${id(6)}` });
	try {
		const pong = await b.waitFor((e) => e.control?.type === "VAULT_PONG" ? e.control : undefined, 5000, "VAULT_PONG", from);
		return { rttMs: round(pong.at - sentAt), runtimeEpoch: pong.value.runtimeEpoch };
	} catch { return null; }
}

/** A streams a frame every ~10 ms; the revoke goes out mid-stream; A keeps sending (ignoring the close) for 15 s. */
async function streamingCycle(ctx: Ctx, n: number, withSpareTicket: boolean) {
	const { v, A, B, cookie } = await setup(ctx, `revoke-gate-${n}`);
	const stream = `b:gate-${id(6)}`;
	const prefix = `g${n}`;
	const b = await StreamSocket.connect(ctx, v.vaultId, B, `B${n}`);
	const a = track(ctx, await RawSocket.connect(ctx, v.vaultId, A, `A${n}`, ADVERSARIAL));
	const spareTicket = withSpareTicket ? await StreamSocket.ticket(ctx, v.vaultId, A.token) : null;
	const rtt = await pingRtt(b);
	const bFrom = b.mark();
	const sent: Sent[] = [];
	let stopAt = Number.POSITIVE_INFINITY;
	const loop = (async () => {
		while (now() < stopAt && !a.ended) {
			const fid = `${prefix}-${String(sent.length).padStart(5, "0")}`;
			const r = a.append(stream, fid, payloadOf(fid, 48));
			sent.push({ id: fid, at: r.at, written: r.written });
			await sleep(10);
		}
	})();
	await sleep(2000);
	const rv = await revoke(ctx, v, A, B, cookie);
	stopAt = rv.t1 + 15000;
	// A ticket minted before the revoke, used after it: must not open a writable socket.
	let spare: Record<string, unknown> | null = null;
	const spareRun = (async () => {
		if (!spareTicket) return;
		await sleep(Math.max(0, rv.t1 + 500 - now()));
		const s = track(ctx, RawSocket.open(ctx, v.vaultId, spareTicket, `A${n}-spare`, ADVERSARIAL));
		const openedAt = now();
		try {
			await s.waitFor((e) => e.control?.type === "VAULT_READY" || e.type === "close-frame" || e.type === "end" ? true : undefined, 8000, "spare outcome");
		} catch { /* recorded below */ }
		const ready = s.events.some((e) => e.control?.type === "VAULT_READY");
		if (ready) for (let i = 0; i < 5; i++) {
			const fid = `${prefix}-spare-${i}`;
			const r = s.append(stream, fid, payloadOf(fid, 48));
			sent.push({ id: fid, at: r.at, written: r.written, note: "spare-ticket socket" });
			await sleep(100);
		}
		await s.waitEnd(3000);
		const http = s.events.find((e) => e.type === "http");
		spare = { openedRelT1: rel(openedAt, rv.t1), http: http?.status ?? null, upgraded: s.upgraded, gotReady: ready,
			error: s.events.find((e) => e.control?.type === "error")?.control.code ?? null, closeFrame: s.closeFrame?.code ?? null,
			closeFrameAfterOpenMs: rel(s.closeFrame?.at, openedAt), tcpEndAfterOpenMs: rel(s.ended?.at, openedAt), timeline: s.timeline(0, 12, openedAt) };
	})();
	await loop;
	await spareRun;
	await sleep(2500); // group commit max is 1.5 s: let any straggler commit before reading
	sent.sort((x, y) => x.at - y.at);
	const committed = await committedRows(ctx, v, B, stream, A.deviceId);
	const peer = peerView(b.events.slice(bFrom), stream, A.deviceId);
	const receipts = receiptsOf(a.events);
	const fate = classify(sent, rv.t0, rv.t1, committed, peer, receipts);
	const firstError = a.events.find((e) => e.control?.type === "error");
	return {
		cycle: n, kind: "streaming", vault: v.key, revoke: revokeBrief(rv), rttMs: rtt?.rttMs ?? null,
		groupCommit: b.ready?.limits?.groupCommit ?? null, t1BodyRelT1: round(rv.t1Body - rv.t1),
		...fate,
		errorFrame: errorFrames(a.events, rv.t0, rv.t1),
		...closeReport(a, rv.t0, rv.t1),
		receivedAfterT1: receivedAfter(a.events, rv.t1, rv.t1),
		receivedAfterFirstError: firstError ? receivedAfter(a.events, firstError.at, rv.t1).counts : null,
		receiptsAfterT0: receivedAfter(a.events.filter((e) => e.control?.type === "STREAM_RECEIPTS"), rv.t0, rv.t0).items,
		spareTicket: spare,
		pass: fate.afterT1Committed.length === 0 && revokeOk(rv),
	};
}

/** A and B idle long enough for the DO to hibernate; then revoke; then single A frames at fixed offsets after t1. */
async function hibernationCycle(ctx: Ctx, n: number, idleMs: number, offsets: number[]) {
	const { v, A, B, cookie } = await setup(ctx, `revoke-gate-${n}-idle`);
	const stream = `b:gate-${id(6)}`;
	const prefix = `h${n}`;
	const b = await StreamSocket.connect(ctx, v.vaultId, B, `B${n}`);
	const a = track(ctx, await RawSocket.connect(ctx, v.vaultId, A, `A${n}`, ADVERSARIAL));
	const warm: Sent[] = [];
	for (let i = 0; i < 3; i++) { const fid = `${prefix}-warm-${i}`; const r = a.append(stream, fid, payloadOf(fid, 48)); warm.push({ id: fid, ...r }); }
	await a.waitFor((e) => e.control?.type === "STREAM_RECEIPTS" && e.control.receipts?.some((r: any) => r.clientFrameId === `${prefix}-warm-2`) ? true : undefined,
		10000, "warm-up receipts");
	const idleFrom = now();
	await sleep(idleMs);
	const bFrom = b.mark();
	const rv = await revoke(ctx, v, A, B, cookie);
	const probes: Sent[] = [];
	for (const offset of offsets) {
		await sleep(Math.max(0, rv.t1 + offset - now()));
		const fid = `${prefix}-p${offset}`;
		const r = a.append(stream, fid, payloadOf(fid, 48));
		probes.push({ id: fid, ...r, note: `t1+${offset}` });
	}
	await sleep(1000);
	const pingAt = now();
	const pong = await pingRtt(b);
	await sleep(2500);
	const committed = await committedRows(ctx, v, B, stream, A.deviceId);
	const peer = peerView(b.events.slice(bFrom), stream, A.deviceId);
	const resend = b.events.slice(bFrom).filter((e) => e.control?.type === "STREAM_RESEND");
	const firstResend = resend[0];
	const trigger = firstResend ? [...probes].reverse().find((p) => p.written && p.at < firstResend.at) : undefined;
	const sent = [...warm, ...probes];
	return {
		cycle: n, kind: "hibernation-probe", vault: v.key, idleMs: round(rv.t0 - idleFrom), revoke: revokeBrief(rv),
		probes: probes.map((p) => ({ id: p.id, offset: p.note, sentRelT1: rel(p.at, rv.t1), written: p.written, committed: committed.has(p.id),
			admitted: peer.get(p.id)?.provisionalAt !== undefined })),
		warmCommitted: warm.filter((w) => committed.has(w.id)).length,
		afterT1Committed: sent.filter((s) => s.at > rv.t1 && committed.has(s.id)).map((s) => s.id),
		runtime: {
			// A new runtime epoch after the idle means the DO was evicted or hibernated while idle. Every DO fetch (the
			// revoke's authority fence included) and every socket message sends STREAM_RESEND once per new runtime, so
			// a resend to B before t1 means the fence woke a hibernated DO.
			epochChanged: pong ? pong.runtimeEpoch !== b.ready.runtimeEpoch : null,
			streamResendToB: firstResend ? { relT0: rel(firstResend.at, rv.t0), relT1: rel(firstResend.at, rv.t1), reason: firstResend.control.reason,
				afterProbe: trigger?.id ?? null, msAfterProbe: trigger ? round(firstResend.at - trigger.at) : null,
				beforeBPing: firstResend.at < pingAt } : null,
			streamResendToA: rel(a.events.find((e) => e.at >= rv.t0 && e.control?.type === "STREAM_RESEND")?.at, rv.t0),
		},
		errorFrame: errorFrames(a.events, rv.t0, rv.t1),
		...closeReport(a, rv.t0, rv.t1),
		receivedAfterT1: receivedAfter(a.events, rv.t1, rv.t1),
		pass: sent.every((s) => !(s.at > rv.t1 && committed.has(s.id))) && revokeOk(rv),
	};
}

function gateLine(c: any): string {
	if (c.kind === "streaming") {
		const p = c.byPhase;
		return `cycle ${c.cycle}: ${c.pass ? "gate held" : "GATE LEAK"}; sent before t0 ${p.beforeT0.sent} (committed ${p.beforeT0.committed}), `
			+ `[t0,t1] ${p.t0toT1.sent} (committed ${p.t0toT1.committed}), after t1 ${p.afterT1.sent} (committed ${p.afterT1.committed}, `
			+ `admitted ${p.afterT1.admitted}); revoke ${c.revoke.status} in ${c.revoke.requestMs} ms; last committed sent t0${fmt(c.lastCommitted?.sentRelT0)}`
			+ ` = t1${fmt(c.lastCommitted?.sentRelT1)}; error frame t0${fmt(c.errorFrame.firstRelT0)} (t1${fmt(c.errorFrame.firstRelT1)}); close frame `
			+ `t0${fmt(c.closeFrame?.relT0)}; TCP end ${c.tcpEnd ? `t0${fmt(c.tcpEnd.relT0)}` : "none"}; after t1 A got ${c.receivedAfterT1.total} msgs`
			+ (c.spareTicket ? `; pre-minted ticket after t1: http ${c.spareTicket.http}, ready ${c.spareTicket.gotReady}, error ${c.spareTicket.error}` : "");
	}
	return `cycle ${c.cycle} (idle ${c.idleMs} ms first): ${c.pass ? "gate held" : "GATE LEAK"}; probes ${c.probes.map((p: any) =>
		`${p.offset}:${p.committed ? "COMMITTED" : p.admitted ? "ADMITTED" : "dropped"}`).join(" ")}; DO runtime changed during idle: `
		+ `${c.runtime.epochChanged}; STREAM_RESEND to B ${c.runtime.streamResendToB ? `at t0${fmt(c.runtime.streamResendToB.relT0)}` : "none"}; `
		+ `error frame t0${fmt(c.errorFrame.firstRelT0)} (t1${fmt(c.errorFrame.firstRelT1)}); close frame t0${fmt(c.closeFrame?.relT0)}; TCP end `
		+ `${c.tcpEnd ? `t0${fmt(c.tcpEnd.relT0)}` : "none"}; after t1 A got ${JSON.stringify(c.receivedAfterT1.counts)}`;
}

const fmt = (x: number | null | undefined) => (x === null || x === undefined ? "?" : x >= 0 ? `+${x}` : `${x}`);

// ---- T-REVOKE-SILENCE -----------------------------------------------------------------------------------------

async function silence(ctx: Ctx, t: Recorder) {
	const { v, A, B, cookie } = await setup(ctx, "revoke-silence");
	const bs = `b:silence-${id(6)}`;
	const xs = `x:silence-${id(6)}`;
	const b = await StreamSocket.connect(ctx, v.vaultId, B, "B");
	const a1 = track(ctx, await RawSocket.connect(ctx, v.vaultId, A, "A-polite", POLITE));
	const a2 = track(ctx, await RawSocket.connect(ctx, v.vaultId, A, "A-ignores-close", ADVERSARIAL));
	// Positive control: before the revoke both A sockets receive B's data.
	await b.appendAll([{ stream: bs, id: "pre-b", payload: payloadOf("pre-b", 64) }, { stream: xs, id: "pre-x", payload: payloadOf("pre-x", 64) }]);
	await sleep(500);
	const control = (a: RawSocket) => ({
		provisional: a.events.some((e) => e.frame?.kind === "provisional" && e.frame.clientFrameId === "pre-b"),
		notice: a.events.some((e) => e.frame?.kind === "notice" && e.frame.clientFrameId === "pre-b"),
		committed: a.events.some((e) => e.frame?.kind === "committed" && e.frame.clientFrameId === "pre-x"),
	});
	const controls = { polite: control(a1), ignoresClose: control(a2) };
	const rv = await revoke(ctx, v, A, B, cookie);
	const writes: { id: string; at: number }[] = [];
	const bFrom = b.mark();
	while (now() < rv.t1 + 15000 && !(a1.ended && a2.ended)) {
		const i = writes.length;
		const stream = i % 2 ? xs : bs;
		const fid = `post-${String(i).padStart(3, "0")}`;
		writes.push({ id: fid, at: b.append(stream, fid, payloadOf(fid, 64)) });
		await sleep(250);
	}
	const lastWrite = writes.at(-1)?.at ?? rv.t1;
	const bReceipts = await b.collect(writes.map((w) => w.id), bFrom, 5000);
	// B is idle from here: does the polite socket's TCP end follow B's last write (DO idle) or the revoke?
	await Promise.all([a1.waitEnd(15000), a2.waitEnd(15000)]);
	const report = (a: RawSocket) => {
		const after = a.events.filter((e) => e.at > rv.t1);
		const data = after.filter((e) => e.type === "frame" || e.type === "bad-frame" || e.type === "text"
			|| (e.type === "control" && e.control?.type !== "error"));
		return { dataBearingAfterT1: data.length, lastDataRelT1: rel(data.at(-1)?.at, rv.t1), receivedAfterT1: receivedAfter(a.events, rv.t1, rv.t1),
			errorFrame: errorFrames(a.events, rv.t0, rv.t1), ...closeReport(a, rv.t0, rv.t1),
			tcpEndAfterLastBWriteMs: rel(a.ended?.at, lastWrite) };
	};
	const polite = report(a1);
	const ignoresClose = report(a2);
	const observed = { vault: v.key, revoke: revokeBrief(rv), positiveControl: controls, bWritesAfterT1: writes.length,
		bWritesReceipted: bReceipts.receipts.size, bWritingRelT1: [rel(writes[0]?.at, rv.t1), rel(lastWrite, rv.t1)], polite, ignoresClose };
	t.observe("result", observed);
	t.expect("after t1, neither revoked socket (one echoing the close, one ignoring it) receives COMMITTED, COMMIT_NOTICE, "
		+ "PROVISIONAL, receipts or any other non-error message while B keeps writing");
	t.check("revoke 200", revokeOk(rv), revokeBrief(rv));
	t.check("positive control: both A sockets got B's PROVISIONAL, NOTICE and COMMITTED before the revoke",
		Object.values(controls).every((c) => c.provisional && c.notice && c.committed), controls);
	t.check("B kept writing after t1", writes.length > 0 && bReceipts.receipts.size === writes.length,
		{ writes: writes.length, receipted: bReceipts.receipts.size });
	t.check("polite socket: no data-bearing message after t1", polite.dataBearingAfterT1 === 0, polite.receivedAfterT1);
	t.check("close-ignoring socket: no data-bearing message after t1", ignoresClose.dataBearingAfterT1 === 0, ignoresClose.receivedAfterT1);
	for (const [name, r] of [["polite (echoes close)", polite], ["ignores close", ignoresClose]] as const) {
		const echoed = r.closeReplySentRelT0 !== null ? `, close echoed t0${fmt(r.closeReplySentRelT0)}` : "";
		const tcp = r.tcpEnd ? `t1${fmt(r.tcpEnd.relT1)} (${r.tcpEndAfterLastBWriteMs} ms after B's last write)` : "none within 15 s after B stopped";
		t.info(`${name}: error frame t1${fmt(r.errorFrame.firstRelT1)}, close frame t1${fmt(r.closeFrame?.relT1)}${echoed}, TCP end ${tcp}; `
			+ `after t1: ${JSON.stringify(r.receivedAfterT1.counts)}`);
	}
	t.info(`B wrote every 250 ms from t1${fmt(observed.bWritingRelT1[0])} to t1${fmt(observed.bWritingRelT1[1])} (${writes.length} frames, `
		+ `${bReceipts.receipts.size} receipted)`);
}

// ---- T-REVOKE-BUFFER ------------------------------------------------------------------------------------------

async function buffered(ctx: Ctx, t: Recorder) {
	const { v, A, B, cookie } = await setup(ctx, "revoke-buffer");
	const stream = `b:buf-${id(6)}`;
	const b = await StreamSocket.connect(ctx, v.vaultId, B, "B");
	const a = track(ctx, await RawSocket.connect(ctx, v.vaultId, A, "A", ADVERSARIAL));
	const gc = b.ready?.limits?.groupCommit ?? null;
	const bFrom = b.mark();
	const sent: Sent[] = [];
	const T = now();
	for (let i = 0; i < 20; i++) { const fid = `buf-burst-${String(i).padStart(2, "0")}`; const r = a.append(stream, fid, payloadOf(fid, 48)); sent.push({ id: fid, ...r }); }
	// A trickle every 100 ms keeps the idle flush (300 ms) from firing; the max flush is 1.5 s after the burst.
	let stopAt = Number.POSITIVE_INFINITY;
	const trickle = (async () => {
		for (let i = 0; now() < stopAt && !a.ended; i++) {
			await sleep(100);
			if (now() >= stopAt) break;
			const fid = `buf-trickle-${String(i).padStart(2, "0")}`;
			const r = a.append(stream, fid, payloadOf(fid, 48));
			sent.push({ id: fid, ...r });
		}
	})();
	const burstIds = sent.slice(0, 20).map((s) => s.id);
	await b.waitFor((e) => e.frame?.clientFrameId === burstIds.at(-1) && e.frame?.kind === "provisional" ? true : undefined, 1500, "burst PROVISIONAL", bFrom)
		.catch(() => undefined);
	await sleep(Math.max(0, T + 400 - now()));
	const rv = await revoke(ctx, v, A, B, cookie);
	stopAt = rv.t1;
	await trickle;
	await sleep(3000);
	const committed = await committedRows(ctx, v, B, stream, A.deviceId);
	const peer = peerView(b.events.slice(bFrom), stream, A.deviceId);
	const receipts = receiptsOf(a.events);
	const isBuffered = (s: Sent) => s.written && (peer.get(s.id)?.provisionalAt ?? Infinity) < rv.t0
		&& !((peer.get(s.id)?.commitAt ?? Infinity) < rv.t0) && !((receipts.get(s.id)?.at ?? Infinity) < rv.t0);
	const set = sent.filter(isBuffered);
	const leaked = set.filter((s) => committed.has(s.id));
	const firstError = a.events.find((e) => e.control?.type === "error");
	const maxDeadline = gc?.maxMs ? T + gc.maxMs : null;
	const commitTimes = set.map((s) => peer.get(s.id)?.commitAt).filter((x): x is number => x !== undefined);
	const observed = {
		vault: v.key, revoke: revokeBrief(rv), groupCommit: gc, revokeSentAfterBurstMs: round(rv.t0 - T),
		bufferedAtT0: set.length, bufferedCommitted: leaked.length,
		bufferedReceiptsOnA: set.filter((s) => receipts.has(s.id)).length,
		receiptsRelT0: span(set.map((s) => receipts.get(s.id)?.at).filter((x): x is number => x !== undefined).map((x) => round(x - rv.t0))),
		receiptsBeforeErrorFrame: firstError ? set.filter((s) => (receipts.get(s.id)?.at ?? Infinity) <= firstError.at).length : null,
		bCommitNoticesRelT0: span(commitTimes.map((x) => round(x - rv.t0))),
		commitBeforeMaxFlushDeadline: maxDeadline === null || commitTimes.length === 0 ? null : Math.max(...commitTimes) < maxDeadline,
		maxFlushDeadlineRelT0: maxDeadline === null ? null : round(maxDeadline - rv.t0),
		sentInT0T1: sent.filter((s) => s.written && s.at >= rv.t0 && s.at <= rv.t1).map((s) => ({ id: s.id, committed: committed.has(s.id) })),
		errorFrame: errorFrames(a.events, rv.t0, rv.t1),
		...closeReport(a, rv.t0, rv.t1),
		timelineA: a.timeline(0, 30, rv.t0),
	};
	t.observe("result", observed);
	t.expect("frames buffered for group commit when the revoke was sent (B saw PROVISIONAL, no commit, no receipt) never commit");
	t.check("revoke 200", revokeOk(rv), revokeBrief(rv));
	t.check("at least one frame was buffered when the revoke was sent", set.length > 0, { bufferedAtT0: set.length });
	t.check("no buffered frame committed", leaked.length === 0, { committed: leaked.length, of: set.length, ids: leaked.slice(0, 5).map((s) => s.id) });
	t.info(`${set.length} frames buffered at t0 (revoke sent ${observed.revokeSentAfterBurstMs} ms after the burst); ${leaked.length} committed; `
		+ `A got receipts for ${observed.bufferedReceiptsOnA} at t0${fmt(observed.receiptsRelT0?.[0])}..${fmt(observed.receiptsRelT0?.[1])} `
		+ `(${observed.receiptsBeforeErrorFrame} before the error frame at t0${fmt(observed.errorFrame.firstRelT0)}); B's commit notices t0`
		+ `${fmt(observed.bCommitNoticesRelT0?.[0])}..${fmt(observed.bCommitNoticesRelT0?.[1])}, max-flush deadline t0${fmt(observed.maxFlushDeadlineRelT0)}`);
}

// ---- registry -------------------------------------------------------------------------------------------------

export const tests: TestDef[] = [
	{
		id: "T-REVOKE-GATE", group: "decision", area: "D7 revoke", expectedBefore: "PASS", timeoutMs: 420000,
		async run(ctx, t) {
			t.expect("no A frame sent after the revoke response (t1) commits; 3 streaming cycles + 1 cycle after an idle period");
			const cycles: any[] = [];
			for (let n = 1; n <= 3; n++) {
				const c = await streamingCycle(ctx, n, n === 1);
				cycles.push(c);
				t.check(`cycle ${n}: revoke 200`, revokeOk(c.revoke), c.revoke);
				t.check(`cycle ${n}: no frame sent after t1 committed`, c.afterT1Committed.length === 0, c.afterT1Committed.slice(0, 5));
				t.info(gateLine(c));
			}
			const h = await hibernationCycle(ctx, 4, 20000, [0, 50, 500, 2000, 5000, 8000]);
			cycles.push(h);
			t.check("idle cycle: revoke 200", revokeOk(h.revoke), h.revoke);
			t.check("idle cycle: no probe sent after t1 committed", h.afterT1Committed.length === 0, h.afterT1Committed);
			t.info(gateLine(h));
			if (cycles.some((c) => (c.afterT1Admitted?.length ?? 0) > 0 || c.probes?.some((p: any) => p.admitted))) {
				t.info("WARNING: a frame sent after t1 was admitted (PROVISIONAL broadcast to B) although it did not commit");
			}
			if (cycles[0].revoke.operatorRouteProbe) t.info("decided route DELETE /operator/vaults/:vaultId/devices/:deviceId is missing; revoked via the legacy owner route");
			t.observe("cycles", cycles);
		},
	},
	{
		id: "T-REVOKE-SILENCE", group: "decision", area: "D7 revoke", expectedBefore: "PASS", timeoutMs: 120000,
		run: silence,
	},
	{
		id: "T-REVOKE-BUFFER", group: "decision", area: "D7 revoke", expectedBefore: "FAIL", timeoutMs: 90000,
		run: buffered,
	},
];
