/**
 * §7.3 behaviour scenarios: B1 hibernation/restart, B2 catch-up, B3 bootstrap, B4 revocation,
 * B6 lost-ack resend / candidate-id reuse (relay), B7 overload, B8 delete while open. (B5 lives with the reset work.)
 */
import { createHash, randomBytes } from "node:crypto";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { decodeBinaryEnvelope } from "../../../server/src/shared/binaryEnvelope";
import { vaultRoute, mutateLifecycle } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import type { LifecycleRequest } from "../../../server/src/contracts";
import { log, now, r2, series, sleep } from "../lib/common";
import { addDevice, smallContent, smallId } from "../lib/context";
import { bodyGet, bodyHead, convergence, diagnostics } from "../lib/checks";
import { contentHashOf, RawClient } from "../lib/rawClient";
import { CoverageTracker, ensureOpen, freshNotes, freshSmallNote, freshTraceBody, keystrokes, loadTrace, openOrThrow,
	operatorVaultPost, pctChange, replayTrace, revokeDevice, type RunCtx } from "../lib/run";
import { SMALL_COUNT } from "../context";

type Result = Record<string, unknown>;

async function wakeProbe(a: RawClient, b: RawClient, label: string): Promise<Result> {
	if (!a.isOpen) return { label, aClosed: a.closed, bClosed: b.closed, propagationMs: null, ackMs: null, sent: false };
	const tracker = new CoverageTracker(b.doc);
	let update: Uint8Array | null = null;
	const cap = (u: Uint8Array, o: unknown) => { if (o !== a) update = u; };
	a.doc.on("update", cap);
	const tracked = a.editTracked((t) => t.insert(t.length, ` ${label} `));
	a.doc.off("update", cap);
	const [p, k] = await Promise.all([
		update && b.isOpen ? tracker.sentAndWait(0, update, tracked.sentAt, 15_000) : Promise.resolve(null),
		a.waitAck(tracked.frameId, tracked.sentAt, 15_000)]);
	tracker.stop();
	await sleep(1000);
	const out: Result = { label, sent: true, propagationMs: p, ackMs: k ? r2(k.at - tracked.sentAt) : null, ack: k?.value ?? null,
		aClosed: a.closed, bClosed: b.closed };
	// Base closes a socket that outlived its runtime (1008 "socket authority mismatch") on the next
	// runtime-dependent frame. Measure what a real client pays: reconnect + sync until B sees the edit.
	if (p === null && (!a.isOpen || !b.isOpen)) {
		const marker = ` ${label} `;
		const closeAt = Math.min(...[a.closed?.at, b.closed?.at].filter((x): x is number => typeof x === "number" && x >= tracked.sentAt));
		const reopenStart = now();
		const reopenA = !a.isOpen ? await a.open(30_000) : null;
		const reopenB = !b.isOpen ? await b.open(30_000) : null;
		const deadline = now() + 15_000;
		while (now() < deadline && !b.text().includes(marker)) await sleep(10);
		out.recovery = { reopenedA: reopenA?.status ?? null, reopenedB: reopenB?.status ?? null,
			delivered: b.text().includes(marker),
			// Harness-inclusive (starts after the probe's 15 s wait); do not report as latency.
			editToVisibleViaReconnectMs: b.text().includes(marker) ? r2(now() - tracked.sentAt) : null,
			closeAfterEditMs: Number.isFinite(closeAt) ? r2(closeAt - tracked.sentAt) : null,
			reconnectToVisibleMs: b.text().includes(marker) ? r2(now() - reopenStart) : null,
			// What an immediately-reconnecting client pays: server close latency + reopen/sync to peer visibility.
			clientPathMs: b.text().includes(marker) && Number.isFinite(closeAt) ? r2(closeAt - tracked.sentAt + now() - reopenStart) : null };
	}
	return out;
}

/** Idle ≥150 s with no app traffic (raw clients send no pings), edit on the same sockets; then simulate-restart and repeat. */
export async function B1(ctx: RunCtx): Promise<Result> {
	const idleMs = ctx.num("idle", 150_000);
	const body = await freshSmallNote(ctx);
	const a = await openOrThrow(await ctx.client("A", body));
	const b = await openOrThrow(await ctx.client("B", body));
	const preEpoch = a.runtimeEpoch;
	const warm = await wakeProbe(a, b, "warm");
	const d0 = await diagnostics(ctx.context.devices.C ?? await ctx.dev("C"));
	log(`B1 idling ${idleMs} ms`);
	const idleStart = new Date().toISOString();
	await sleep(idleMs);
	const idleEnd = new Date().toISOString();
	const closedDuringIdle = { a: a.closed, b: b.closed };
	const afterIdle = await wakeProbe(a, b, "after-idle");
	const second = await wakeProbe(a, b, "after-idle-2");
	const d1 = await diagnostics(await ctx.dev("C"));
	const restart = await operatorVaultPost(ctx, "debug/simulate-restart");
	await sleep(500);
	const afterRestart = await wakeProbe(a, b, "after-restart");
	const afterRestart2 = await wakeProbe(a, b, "after-restart-2");
	const d2 = await diagnostics(await ctx.dev("C"));
	const reopened = { a: !a.isOpen, b: !b.isOpen };
	await ensureOpen(a); await ensureOpen(b);
	const conv = await convergence({ bodyId: body, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close(); await b.close();
	return { bodyId: body, idleMs, idleStart, idleEnd, preRuntimeEpoch: preEpoch,
		runtimeEpochs: { beforeIdle: d0.runtimeEpoch, afterIdle: d1.runtimeEpoch, afterRestart: d2.runtimeEpoch },
		warm, closedDuringIdle, afterIdle, second, restart, afterRestart, afterRestart2,
		reopenedForConvergence: reopened, convergence: conv };
}

/** B offline while A makes `--edits` edits (default 50, reps n) and separately the 5,000-frame quick trace. */
export async function B2(ctx: RunCtx): Promise<Result> {
	const reps = ctx.n(10);
	const edits = ctx.num("edits", 50);
	const body = await freshSmallNote(ctx);
	const a = await openOrThrow(await ctx.client("A", body));
	const offlineDoc = new Y.Doc({ guid: body });
	await (await openOrThrow(await ctx.client("B", body, offlineDoc))).close();
	const small: Result[] = [];
	let last: RawClient | null = null;
	for (let rep = 0; rep < reps; rep++) {
		for (let i = 0; i < edits; i++) { a.edit((t) => t.insert(Math.floor(t.length / 2), `e${rep}.${i} `)); await sleep(40); }
		const lastFrame = a.sent.at(-1)!;
		await a.waitAck(lastFrame.clientFrameId, lastFrame.at, 5000); // base: debounced commit; relay: last frame's ack
		await sleep(1000);
		const b = await ctx.client("B", body, offlineDoc);
		const outcome = await b.open(30_000);
		const target = a.text();
		const cur = await b.waitText((t) => t === target, 15_000);
		small.push({ rep, status: outcome.status, timeToCurrentMs: cur ? r2(cur - b.startedAt) : null,
			sinceWsOpenMs: cur ? r2(cur - b.openAt) : null, bytesIn: b.bytesIn, bytesOut: b.bytesOut, updateBytesIn: b.updateBytesIn,
			transport: b.transportBytes() });
		if (rep < reps - 1) await b.close(); else last = b;
		await sleep(300);
	}
	const conv1 = await convergence({ bodyId: body, clients: [a, last!], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close(); await last?.close();
	let traceResult: Result | null = null;
	if (!ctx.args.flags["skip-trace"]) {
		const trace = loadTrace();
		const tbody = await freshTraceBody(ctx, trace);
		const ta = await openOrThrow(await ctx.client("A", tbody), 60_000);
		const tdoc = new Y.Doc({ guid: tbody });
		await (await openOrThrow(await ctx.client("B", tbody, tdoc), 60_000)).close();
		const d0 = await diagnostics(ctx.context.devices.A!);
		const replay = await replayTrace(ta, trace.frames, ctx.num("replay-rate", 100), { onProgress: (i) => log(`B2 trace ${i}`) });
		// Wait until the server has the final state (HTTP GET text equals A).
		const deadline = now() + 60_000;
		while (now() < deadline) { const g = await bodyGet(await ctx.dev("C"), tbody); if (g.text === ta.text()) break; await sleep(500); }
		const d1 = await diagnostics(ctx.context.devices.A!);
		const tb = await ctx.client("B", tbody, tdoc);
		const outcome = await tb.open(60_000);
		const target = ta.text();
		const cur = await tb.waitText((t) => t === target, 30_000);
		traceResult = { bodyId: tbody, frames: replay.sent, status: outcome.status, timeToCurrentMs: cur ? r2(cur - tb.startedAt) : null,
			sinceWsOpenMs: cur ? r2(cur - tb.openAt) : null, bytesIn: tb.bytesIn, updateBytesIn: tb.updateBytesIn, transport: tb.transportBytes(),
			sequenceDelta: Number(d1.sequence) - Number(d0.sequence), diagnostics: { before: d0, after: d1 },
			convergence: await convergence({ bodyId: tbody, clients: [ta, tb], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000 }) };
		await ta.close(); await tb.close();
	}
	const col = (k: string) => small.map((s) => s[k] as number | null);
	return { bodyId: body, reps, edits,
		small: { timeToCurrentMs: series(col("timeToCurrentMs"), 0), sinceWsOpenMs: series(col("sinceWsOpenMs"), 0), bytesIn: series(col("bytesIn"), 0), samples: small },
		trace: traceResult,
		convergence: { pass: conv1.pass && (traceResult ? (traceResult.convergence as { pass: boolean }).pass : true), small: conv1 } };
}

/** Paginated bootstrap with the batch bodies endpoint (as bootstrapClient does). */
async function bootstrap(identity: LiveIdentity) {
	const t0 = now();
	let bytes = 0;
	let requests = 0;
	const req = async (suffix: string, init?: RequestInit) => {
		requests++;
		const response = await fetch(vaultRoute(identity, suffix), { ...init, headers: deviceBearerHeaders(identity, init?.headers as Record<string, string> | undefined) });
		const buf = new Uint8Array(await response.arrayBuffer());
		bytes += buf.byteLength;
		if (!response.ok) throw new Error(`${suffix} → ${response.status} ${new TextDecoder().decode(buf).slice(0, 200)}`);
		return buf;
	};
	const started = JSON.parse(new TextDecoder().decode(await req("bootstrap/start", { method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ attemptId: `relay2-${crypto.randomUUID()}` }) }))) as { bootstrapId: string };
	const id = encodeURIComponent(started.bootstrapId);
	const root = new Y.Doc();
	Y.applyUpdate(root, await req(`bootstrap/${id}/root`));
	const entries: Array<{ bodyId: string; contentHash: string | null }> = [];
	let cursor: string | null = null;
	do {
		const page = JSON.parse(new TextDecoder().decode(await req(`bootstrap/${id}/catalog?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`))) as
			{ entries: Array<{ bodyId: string; contentHash: string | null }>; nextCursor: string | null };
		entries.push(...page.entries);
		cursor = page.nextCursor;
	} while (cursor);
	const texts = new Map<string, string>();
	for (let i = 0; i < entries.length; i += 100) {
		const ids = entries.slice(i, i + 100).map((e) => e.bodyId);
		const decoded = decodeBinaryEnvelope(await req(`bootstrap/${id}/bodies`, { method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ bodyIds: ids }) })) as { bodies: Array<{ bodyId: string; encodedState: Uint8Array }> };
		for (const body of decoded.bodies) {
			const doc = new Y.Doc(); Y.applyUpdate(doc, body.encodedState); texts.set(body.bodyId, doc.getText("body").toString()); doc.destroy();
		}
	}
	await req(`bootstrap/${id}/complete`, { method: "POST" });
	return { ms: r2(now() - t0), bytes, requests, entries: entries.length, texts };
}

/** Fresh device bootstraps the vault after 20 of the 100 small notes were edited over sockets. */
export async function B3(ctx: RunCtx): Promise<Result> {
	const editedCount = ctx.num("edited", 20);
	const expected = new Map<string, string>();
	const clients: RawClient[] = [];
	for (let i = 0; i < editedCount; i++) {
		const c = await openOrThrow(await ctx.client("A", smallId(i)));
		for (let k = 0; k < 5; k++) { c.edit((t) => t.insert(t.length, ` ${ctx.tag}.${k}`)); await sleep(30); }
		clients.push(c);
	}
	await sleep(3000);
	for (const c of clients) expected.set(c.body, c.text());
	const reps = ctx.n(3);
	const runs: Result[] = [];
	for (let r = 0; r < reps; r++) {
		const identity = await addDevice(ctx.context, `boot-${ctx.tag}-${r}`);
		const result = await bootstrap(identity);
		let mismatches = 0;
		for (let i = 0; i < SMALL_COUNT; i++) {
			const want = expected.get(smallId(i)) ?? null;
			const got = result.texts.get(smallId(i));
			if (want !== null ? got !== want : !got?.startsWith(smallContent(i).slice(0, 12))) mismatches++;
		}
		runs.push({ rep: r, ms: result.ms, bytes: result.bytes, requests: result.requests, entries: result.entries, mismatches });
		log(`B3 rep ${r}: ${result.ms} ms entries=${result.entries} mismatches=${mismatches}`);
	}
	const conv = await convergence({ bodyId: clients[0]!.body, clients: [clients[0]!], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	for (const c of clients) await c.close();
	return { edited: editedCount, reps, bootstrapMs: series(runs.map((r) => r.ms as number), 0), runs,
		allMatch: runs.every((r) => r.mismatches === 0), convergence: { ...conv, pass: conv.pass && runs.every((r) => r.mismatches === 0) } };
}

/** Revoke a freshly enrolled streaming device; expect close 4403 ≤1 s and no append after revocation. */
export async function B4(ctx: RunCtx): Promise<Result> {
	const reps = ctx.n(1);
	const streamMs = ctx.num("stream-interval", 50);
	const runs: Result[] = [];
	let lastConv: Result | null = null;
	for (let r = 0; r < reps; r++) {
		const body = await freshSmallNote(ctx);
		const victim = await addDevice(ctx.context, `rev-${ctx.tag}-${r}`);
		const a = await openOrThrow(await ctx.client("A", body));
		const v = await openOrThrow(new RawClient(victim, body, undefined, ctx.adapter));
		const marks: Array<{ i: number; at: number }> = [];
		let i = 0;
		let stop = false;
		const streamer = (async () => {
			while (!stop && v.isOpen) { v.edit((t) => t.insert(t.length, `<v${i}>`)); marks.push({ i, at: now() }); i++; await sleep(streamMs); }
		})();
		await sleep(ctx.num("pre-stream", 2000));
		const revokeStart = now();
		const revoke = await revokeDevice(ctx, victim.deviceId);
		const revokeDone = now();
		const closed = await v.waitClose(5000);
		stop = true;
		await streamer;
		await sleep(3000);
		const get = await bodyGet(await ctx.dev("C"), body);
		const serverText = get.text ?? "";
		const present = marks.filter((m) => serverText.includes(`<v${m.i}>`));
		const afterStart = marks.filter((m) => m.at > revokeStart);
		const afterDone = marks.filter((m) => m.at > revokeDone);
		runs.push({ rep: r, bodyId: body, revoke, revokeRequestMs: r2(revokeDone - revokeStart),
			close: closed ? { code: closed.code, reason: closed.reason, sinceRevokeStartMs: r2(closed.at - revokeStart), sinceRevokeDoneMs: r2(closed.at - revokeDone) } : null,
			framesSent: marks.length, sentAfterRevokeStart: afterStart.length, sentAfterRevokeDone: afterDone.length,
			appendedTotal: present.length,
			appendedSentAfterRevokeStart: present.filter((m) => m.at > revokeStart).length,
			appendedSentAfterRevokeDone: present.filter((m) => m.at > revokeDone).length,
			pass: closed?.code === 4403 && closed.at - revokeDone <= 1000 && present.filter((m) => m.at > revokeDone).length === 0 });
		lastConv = await convergence({ bodyId: body, clients: [a], fresh: await ctx.dev("C"), adapter: ctx.adapter });
		await a.close();
	}
	return { reps, streamIntervalMs: streamMs, runs, allPass: runs.every((r) => r.pass), convergence: lastConv };
}

/**
 * One client floods `--mibps` (default 5) MiB/s of insert+delete pairs on its own body; others' L2 p50 must stay
 * within 20% of idle.
 */
export async function B7(ctx: RunCtx): Promise<Result> {
	const n = ctx.n(40);
	const mibps = ctx.num("mibps", 5);
	const floodMs = ctx.num("flood-ms", 30_000);
	const chunk = ctx.num("chunk", 64 * 1024);
	const [lat, floodBody] = await freshNotes(ctx, "b7", 2, (i) => smallContent(i));
	const a = await openOrThrow(await ctx.client("A", lat!));
	const b = await openOrThrow(await ctx.client("B", lat!));
	await sleep(1500);
	const idle = await keystrokes(a, b, n, 500);
	const flooder = await openOrThrow(await ctx.client("D", floodBody!));
	let stop = false;
	let floodBytes = 0;
	let floodFrames = 0;
	const floodStart = now();
	const payload = "x".repeat(chunk);
	const flood = (async () => {
		const perSecond = (mibps * 1024 * 1024) / chunk;
		let k = 0;
		while (!stop && flooder.isOpen) {
			const target = floodStart + (k * 1000) / perSecond;
			const wait = target - now();
			if (wait > 1) await sleep(wait);
			const buffered = (flooder.socket as unknown as { bufferedAmount: number }).bufferedAmount;
			if (buffered > 16 * 1024 * 1024) { await sleep(10); continue; }
			const before = flooder.bytesOut;
			flooder.edit((t) => t.insert(0, payload));
			flooder.edit((t) => t.delete(0, chunk));
			floodBytes += flooder.bytesOut - before;
			floodFrames += 2;
			k++;
		}
	})();
	await sleep(2000);
	const loaded = await keystrokes(a, b, n, 500);
	stop = true;
	await flood;
	const floodDurationMs = r2(now() - floodStart);
	await sleep(Math.max(0, floodMs - floodDurationMs));
	const flooderClosed = flooder.closed;
	await ensureOpen(a); await ensureOpen(b);
	const conv = await convergence({ bodyId: lat!, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close(); await b.close(); await flooder.close();
	const idleS = series(idle.map((s) => s.propagationMs));
	const loadS = series(loaded.map((s) => s.propagationMs));
	const change = pctChange(idleS.summary?.p50, loadS.summary?.p50);
	return { n, targetMiBps: mibps, chunk, floodFrames, floodBytes, floodDurationMs, achievedMiBps: r2(floodBytes / 1048576 / (floodDurationMs / 1000)),
		flooderClosed, idle: { propagationMs: idleS, samples: idle }, underFlood: { propagationMs: loadS, samples: loaded },
		p50ChangePct: change, pass: change !== null && change <= 20, convergence: conv };
}

/** Delete a body via lifecycle while A and B have it open: sockets fenced/closed, later appends rejected. */
export async function B8(ctx: RunCtx): Promise<Result> {
	const body = await freshSmallNote(ctx);
	const a = await openOrThrow(await ctx.client("A", body));
	const b = await openOrThrow(await ctx.client("B", body));
	await keystrokes(a, b, 3, 300);
	const headBefore = await bodyHead(await ctx.dev("C"), body);
	const lifecycle: LifecycleRequest = { operationId: `delete-${crypto.randomUUID()}`, kind: "delete", fileId: body, bodyId: body, bodyEpoch: 1,
		path: `R2/${ctx.tag}/note-0.md` };
	const t0 = now();
	let deleteError: string | null = null;
	try { await mutateLifecycle(ctx.context.devices.C!, lifecycle); } catch (error) { deleteError = String(error); }
	const deleteMs = r2(now() - t0);
	const [ca, cb] = await Promise.all([a.waitClose(5000), b.waitClose(5000)]);
	let postEdit: Result = { attempted: false };
	if (a.isOpen) {
		const tracked = a.editTracked((t) => t.insert(t.length, "after-delete"));
		const ack = await a.waitAck(tracked.frameId, tracked.sentAt, 5000);
		const bGot = await b.waitText((t) => t.includes("after-delete"), 2000);
		postEdit = { attempted: true, ack: ack?.value ?? null, propagatedToB: bGot !== null, aClosedAfter: await a.waitClose(3000) };
	}
	const reopen = await (await ctx.client("B", body)).open(10_000);
	const headAfter = await bodyHead(await ctx.dev("C"), body);
	const getAfter = await bodyGet(await ctx.dev("C"), body);
	const d = await diagnostics(ctx.context.devices.A!);
	await a.close(); await b.close();
	const closeInfo = (c: { code: number; reason: string; at: number } | null) => c ? { code: c.code, reason: c.reason, sinceDeleteMs: r2(c.at - t0) } : null;
	const pass = !deleteError && (headAfter.status !== 200 || headAfter.value === null);
	return { bodyId: body, deleteMs, deleteError, headBefore: headBefore.value, closes: { a: closeInfo(ca), b: closeInfo(cb) },
		postEdit, reopenAfterDelete: reopen, headAfter, getAfterStatus: getAfter.status, diagnostics: d,
		convergence: { pass, note: "body deleted: convergence = head/GET report not active" } };
}

/**
 * B6 (relay): lost-ack resend + candidate-id reuse. One local edit is sent as envelope(candidateId X)+frame, then
 * the SAME envelope+frame is resent twice on the same socket and once more after a reconnect (a client that
 * lost the ack). Expected: exactly one append (relay counters appends +1, dedupeHits +3), every resend answered
 * with BODY_COMMITTED deduped:true carrying the same vaultSequence/durableGeneration. Then a different update
 * reusing candidateId X must get BODY_UPDATE_REJECTED {reason:"candidate_id_reused"} and must not be appended;
 * resending it under a fresh id recovers. Base: not applicable (no socket candidates) — reported as skipped.
 */
export async function B6(ctx: RunCtx): Promise<Result> {
	if (!ctx.adapter.name.startsWith("relay") || ctx.adapter.name.includes("nocand")) {
		return { skipped: "B6 needs a relay adapter with candidate fields", convergence: { pass: null } };
	}
	const resends = ctx.num("resends", 3);
	const body = await freshSmallNote(ctx);
	const a = await openOrThrow(await ctx.client("A", body));
	const b = await openOrThrow(await ctx.client("B", body));
	const diagDev = await ctx.dev("C");
	const counters = async () => ((await diagnostics(diagDev)).relay as { counters?: Record<string, number> } | undefined)?.counters ?? {};
	const captureLocal = (fn: (t: Y.Text) => void) => {
		let update: Uint8Array | null = null;
		const cap = (u: Uint8Array, o: unknown) => { if (o !== a) update = u; };
		a.forwardLocal = false;
		a.doc.on("update", cap);
		a.edit(fn);
		a.doc.off("update", cap);
		a.forwardLocal = true;
		return update!;
	};
	const frameOf = (update: Uint8Array) => {
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, 0);
		syncProtocol.writeUpdate(e, update);
		return encoding.toUint8Array(e);
	};
	const envelopeFor = (update: Uint8Array, candidateId: string, clientFrameId: string) => {
		const digest = createHash("sha256").update(update).digest("hex");
		const { contentHash, size } = contentHashOf(a.text());
		return `__YPS:${JSON.stringify({ type: "BODY_UPDATE_ENVELOPE", bodyId: body, bodyEpoch: a.bodyEpoch, clientFrameId,
			payloadDigest: digest, candidateId, candidateDigest: digest, contentHash, size, frameKind: "update",
			stateVector: Buffer.from(Y.encodeStateVector(a.doc)).toString("base64") })}`;
	};
	const sendOnce = async (client: RawClient, update: Uint8Array, candidateId: string, label: string) => {
		const clientFrameId = `${label}-${randomBytes(4).toString("hex")}`;
		const t0 = now();
		const wait = client.waitControl((v) => v.clientFrameId === clientFrameId
			&& (v.type === "BODY_COMMITTED" || v.type === "BODY_UPDATE_REJECTED"), 10_000);
		client.send(envelopeFor(update, candidateId, clientFrameId));
		client.send(frameOf(update));
		const got = await wait;
		const v = got?.value ?? null;
		return { label, clientFrameId, ms: got ? r2(got.at - t0) : null, type: v?.type ?? null, deduped: v?.deduped ?? null,
			noop: v?.noop ?? null, reason: v?.reason ?? null, vaultSequence: v?.vaultSequence ?? null,
			durableGeneration: v?.durableGeneration ?? null, candidateId: v?.candidateId ?? null, candidateDigest: v?.candidateDigest ?? null };
	};
	await sleep(500);
	const c0 = await counters();
	const update = captureLocal((t) => t.insert(t.length, ` b6-${ctx.tag} `));
	const candidateId = crypto.randomUUID();
	const sends: Result[] = [await sendOnce(a, update, candidateId, "first")];
	for (let i = 0; i < resends - 1; i++) sends.push(await sendOnce(a, update, candidateId, `resend${i + 1}`));
	await sleep(1000);
	const c1 = await counters();
	// Lost ack across a reconnect: close, reopen, let the reconnect's own step1/step2 exchange finish (its
	// step2 reply may carry the delete set and is appended/counted on its own), then resend the same candidate.
	await a.close();
	await openOrThrow(a);
	await sleep(2000);
	const c1r = await counters();
	sends.push(await sendOnce(a, update, candidateId, "resend-after-reconnect"));
	await sleep(1000);
	const c1s = await counters();
	const first = sends[0]!;
	const repeats = sends.slice(1);
	const sameReceipt = repeats.every((s) => s.type === "BODY_COMMITTED" && s.deduped === true
		&& s.vaultSequence === first.vaultSequence && s.durableGeneration === first.durableGeneration
		&& s.candidateId === candidateId && s.candidateDigest === first.candidateDigest);
	const d = (x: Record<string, number>, y: Record<string, number>, k: string) => (y[k] ?? 0) - (x[k] ?? 0);
	const appends = d(c0, c1, "appends") + d(c1r, c1s, "appends");
	const resend = { sends, appendsDelta: appends, dedupeHitsDelta: d(c0, c1, "dedupeHits") + d(c1r, c1s, "dedupeHits"),
		reconnectExchange: { appends: d(c1, c1r, "appends"), step2Replies: d(c1, c1r, "step2Replies"), emptySkips: d(c1, c1r, "emptySkips"),
			note: "the reconnect's own step1/step2 exchange, excluded from the resend accounting" },
		exactlyOneAppend: appends === 1, sameReceiptReturned: sameReceipt, firstDeduped: first.deduped };

	// HTTP fallback after a socket commit whose ack was lost: POST /candidate with the same id + digest must return
	// the same receipt (shared vault_candidate_receipts), not a second append. And the reverse: HTTP first, then socket.
	const postCandidate = async (upd: Uint8Array, id: string) => {
		const digest = createHash("sha256").update(upd).digest("hex");
		const t0 = now();
		const res = await fetch(vaultRoute(a.identity, `body/${encodeURIComponent(body)}/candidate`), { method: "POST",
			headers: { ...deviceBearerHeaders(a.identity), "content-type": "application/octet-stream", "x-yaos-body-epoch": String(a.bodyEpoch),
				"x-yaos-candidate-id": id, "x-yaos-candidate-digest": digest }, body: upd });
		const v = await res.json().catch(() => null) as Record<string, unknown> | null;
		return { status: res.status, ms: r2(now() - t0), durableGeneration: v?.durableGeneration ?? null, candidateId: v?.candidateId ?? null,
			candidateDigest: v?.candidateDigest ?? null, runtimeEpoch: v?.runtimeEpoch ?? null, body: res.ok ? null : v };
	};
	const h0 = await counters();
	const httpAfterSocket = await postCandidate(update, candidateId);
	const viaHttp = captureLocal((t) => t.insert(t.length, ` http-first-${ctx.tag} `));
	const httpId = crypto.randomUUID();
	const httpFirst = await postCandidate(viaHttp, httpId);
	await sleep(500);
	const socketAfterHttp = await sendOnce(a, viaHttp, httpId, "socket-after-http");
	await sleep(1000);
	const h1 = await counters();
	const httpFallback = { httpAfterSocket, httpAfterSocketSameReceipt: httpAfterSocket.status === 200
			&& httpAfterSocket.durableGeneration === first.durableGeneration && httpAfterSocket.candidateId === candidateId,
		httpFirst, socketAfterHttp, socketAfterHttpDeduped: socketAfterHttp.type === "BODY_COMMITTED" && socketAfterHttp.deduped === true
			&& socketAfterHttp.durableGeneration === httpFirst.durableGeneration,
		relayAppendsDelta: d(h0, h1, "appends"), dedupeHitsDelta: d(h0, h1, "dedupeHits"),
		note: "relayAppendsDelta counts socket appends only; the HTTP candidate goes through the base candidate path" };

	// Reused candidateId with different bytes → rejected, not appended.
	const other = captureLocal((t) => t.insert(0, ` reuse-${ctx.tag} `));
	await sleep(500);
	const c2 = await counters();
	const reuse = await sendOnce(a, other, candidateId, "reuse");
	await sleep(1500);
	const c3 = await counters();
	const serverAfterReuse = await bodyGet(diagDev, body);
	const bSawReuse = b.text().includes(`reuse-${ctx.tag}`);
	const recovery = await sendOnce(a, other, crypto.randomUUID(), "recover-fresh-id");
	const reused = { result: reuse, rejected: reuse.type === "BODY_UPDATE_REJECTED" && reuse.reason === "candidate_id_reused",
		appendsDelta: (c3.appends ?? 0) - (c2.appends ?? 0), notOnServer: !(serverAfterReuse.text ?? "").includes(`reuse-${ctx.tag}`),
		notFannedOutToB: !bSawReuse, socketStillOpen: a.isOpen, recovery };
	const conv = await convergence({ bodyId: body, clients: [a, b], fresh: diagDev, adapter: ctx.adapter });
	await a.close(); await b.close();
	const pass = resend.exactlyOneAppend && resend.sameReceiptReturned && reused.rejected && reused.appendsDelta === 0
		&& reused.notOnServer && httpFallback.httpAfterSocketSameReceipt && httpFallback.socketAfterHttpDeduped && conv.pass === true;
	return { bodyId: body, resends, resend, httpFallback, reused, counters: { before: c0, afterResends: c1, afterReconnect: c1r, afterReconnectResend: c1s,
		beforeReuse: c2, afterReuse: c3 },
		pass, convergence: { ...conv, pass: conv.pass === true && pass } };
}
