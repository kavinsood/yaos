/**
 * Relay v3 (group commit) scenarios: CRASH (pending buffer lost to a simulated isolate eviction), FENCE (cumulative
 * acks never pass a refused frame), HTTPSAVE (closed-note disk path: one HTTP candidate per scheduler max-wait).
 * Needs a v3 worker (YAOS_RELAY_GROUP_COMMIT=1) with YAOS_TEST_ONLY_DEBUG_ROUTES for CRASH.
 */
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import { log, now, r2, series, sleep } from "../lib/common";
import { bodyGet, convergence, diagnostics } from "../lib/checks";
import { RawClient } from "../lib/rawClient";
import { CoverageTracker, freshNotes, openOrThrow, operatorVaultPost, type RunCtx } from "../lib/run";
import { smallContent } from "../lib/context";

/** One fresh body per call (the shared small-note helper reuses one id/path per run). */
const note = async (ctx: RunCtx, prefix: string, bytes: number) => (await freshNotes(ctx, prefix, 1, () => smallContent(7, bytes)))[0]!;
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders } from "../../../tests/live/liveIdentity";

type Result = Record<string, unknown>;
type Counters = Record<string, number>;
const relayCounters = async (ctx: RunCtx): Promise<Counters> =>
	((await diagnostics(ctx.context.devices.A!)).relay as { counters?: Counters } | undefined)?.counters ?? {};
const delta = (a: Counters, b: Counters, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]));
const V3_KEYS = ["groupCommits", "groupFrames", "groupDropped", "groupFlushIdle", "groupFlushMax", "groupFlushBytes", "groupFlushForced",
	"groupFlushDedupes", "wakeResyncs", "wakeResyncSockets", "wakeHeldAcks", "wakeHeldAcksDropped", "pendingReplayFrames", "failedSocketDrops",
	"tooLargeCloses", "rateLimitCloses", "appendFrames", "noopSkips", "dedupeHits", "updateFrames", "rowsWritten"];

/** Durable state (HTTP GET) contains each update? */
async function durableCoverage(ctx: RunCtx, bodyId: string, updates: Uint8Array[]) {
	const res = await fetch(vaultRoute(ctx.context.devices.A!, `body/${encodeURIComponent(bodyId)}`), { headers: deviceBearerHeaders(ctx.context.devices.A!) });
	if (!res.ok) return { status: res.status, missing: updates.length, text: null as string | null };
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
	const snap = Y.snapshot(doc);
	const missing = updates.filter((u) => !Y.snapshotContainsUpdate(snap, u)).length;
	const text = doc.getText("body").toString();
	doc.destroy();
	return { status: res.status, missing, text };
}

function typeOne(a: RawClient, updates: Uint8Array[], ch: string) {
	const capture = (u: Uint8Array, origin: unknown) => { if (origin !== a) updates.push(u); };
	a.doc.on("update", capture);
	try { a.edit((t) => t.insert(t.length, ch)); } finally { a.doc.off("update", capture); }
}

/**
 * CRASH `--rounds 5` per mode. A types 20 keys at 10/s into a body B also has open; with frames still buffered
 * (idle 300 ms not elapsed) the test-only `debug/relay-crash` drops the buffer unacked and swaps in a new runtime.
 *   online:  A stays connected, types 5 more keys (its next frame wakes the new runtime → wake re-sync step1 → A's
 *            step2 carries the lost frames); A also resends unacked frames after 5 s (client resend emulation).
 *   offline: A is terminated right after B has received its frames and BEFORE the commit; B (idle, connected) sends
 *            one VAULT_PING (a webSocketMessage wakes the runtime) → wake re-sync pulls A's frames from B.
 * Then: durable GET must contain every update A made (framesLost = 0) and a fresh device C must converge.
 */
export async function CRASH(ctx: RunCtx): Promise<Result> {
	const rounds = ctx.num("rounds", 5);
	const modes = (ctx.str("modes", "online,offline") ?? "online,offline").split(",");
	const out: Result[] = [];
	for (const mode of modes) {
		for (let r = 0; r < rounds; r++) {
			let attempt = 0;
			let rec: Result | null = null;
			while (attempt < 3) {
				attempt++;
				rec = await crashRound(ctx, mode, r, attempt);
				if (Number(rec.droppedRelayFrames ?? 0) > 0) break;
				log(`CRASH ${mode} r${r}: nothing buffered at crash (attempt ${attempt}); retrying`);
			}
			out.push(rec!);
			log(`CRASH ${mode} r${r}: dropped=${rec!.droppedRelayFrames} lost=${rec!.framesLost} recovery=${rec!.recoveryMs} conv=${(rec!.convergence as Result)?.pass}`);
		}
	}
	const meaningful = out.filter((x) => Number(x.droppedRelayFrames ?? 0) > 0);
	const summary = Object.fromEntries(modes.map((m) => {
		const xs = out.filter((x) => x.mode === m);
		return [m, { rounds: xs.length, withDroppedBuffer: xs.filter((x) => Number(x.droppedRelayFrames ?? 0) > 0).length,
			droppedRelayFrames: xs.reduce((n, x) => n + Number(x.droppedRelayFrames ?? 0), 0),
			framesLost: xs.reduce((n, x) => n + Number(x.framesLost ?? 0), 0),
			converged: xs.filter((x) => (x.convergence as Result)?.pass === true).length,
			recoveryMs: series(xs.map((x) => x.recoveryMs as number | null), 0) }];
	}));
	const pass = out.every((x) => x.framesLost === 0 && (x.convergence as Result)?.pass === true) && meaningful.length > 0;
	return { rounds, modes, summary, rounds_: out, framesLostTotal: out.reduce((n, x) => n + Number(x.framesLost ?? 0), 0),
		pass, convergence: { pass } };
}

async function crashRound(ctx: RunCtx, mode: string, r: number, attempt: number): Promise<Result> {
	const body = await note(ctx, `crash-${mode}${r}a${attempt}`, 2048);
	const a = await openOrThrow(await ctx.client("A", body));
	const b = await openOrThrow(await ctx.client("B", body));
	a.resendAfterMs = 5000;
	await sleep(1000);
	const c0 = await relayCounters(ctx);
	const updates: Uint8Array[] = [];
	const tracker = new CoverageTracker(b.doc);
	const tag = `[${mode}${r}.${attempt}:`;
	for (let i = 0; i < 20; i++) {
		const t0 = now();
		const before = updates.length;
		typeOne(a, updates, i === 0 ? tag : String.fromCharCode(97 + (i % 26)));
		if (updates.length > before) tracker.sent(i, updates.at(-1)!, t0);
		await sleep(100);
	}
	let crash: { status: number; value: unknown };
	let crashAt: number;
	if (mode === "offline") {
		// Wait for B to hold every frame (≈ 70 ms), then cut A and crash at once (no await between: both before the 300 ms idle).
		const until = now() + 2000;
		while (tracker.outstanding > 0 && now() < until) await sleep(5);
		a.terminate();
		crashAt = now();
		crash = await operatorVaultPost(ctx, "debug/relay-crash");
	} else {
		crashAt = now();
		crash = await operatorVaultPost(ctx, "debug/relay-crash");
	}
	tracker.stop();
	const crashMs = r2(now() - crashAt);
	const v = (crash.value ?? {}) as Result;
	// Wake trigger.
	if (mode === "online") {
		for (let i = 0; i < 5; i++) { typeOne(a, updates, "]"); await sleep(100); }
	} else {
		b.send(`__YPS:${JSON.stringify({ type: "VAULT_PING", probeId: `wake-${r}` })}`);
	}
	// Recovery: durable state covers every update A made.
	const t0 = now();
	let cov = await durableCoverage(ctx, body, updates);
	while (cov.missing > 0 && now() - t0 < 20_000) { await sleep(200); cov = await durableCoverage(ctx, body, updates); }
	const recoveryMs = cov.missing === 0 ? r2(now() - t0 + crashMs) : null;
	if (mode === "online") { const until = now() + 15_000; while (a.unacked > 0 && now() < until) await sleep(100); }
	const c1 = await relayCounters(ctx);
	const conv = await convergence({ bodyId: body, clients: mode === "online" ? [a, b] : [b], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 20_000 });
	const result: Result = { mode, round: r, attempt, bodyId: body, edits: updates.length, crashStatus: crash.status,
		droppedRelayFrames: v.droppedRelayFrames ?? null, crashResponse: v, crashRequestMs: crashMs,
		durableMissingAfterRecovery: cov.missing, framesLost: cov.missing, recoveryMs,
		originUnackedAtEnd: mode === "online" ? a.unacked : null, originTimeoutResends: a.timeoutResends,
		originAckPrefix: a.ackPrefixCheck(),
		counterDeltaNewRuntime: delta({}, c1, V3_KEYS), counterBefore: Object.fromEntries(V3_KEYS.map((k) => [k, c0[k] ?? 0])),
		convergence: conv };
	if (a.isOpen) await a.close();
	await b.close();
	return result;
}

/**
 * FENCE `--rounds 5`: cumulative-ack safety. Variant toolarge: 3 small frames, one frame over the durable value
 * limit (close 1009), 3 small frames, all in one tick (they reach the server before the close takes effect).
 * Variant rate: `--rate-frames` (default 80) × 32 KiB frames in one tick (2.6 MB, over the 1.75 MB burst → 1013). Pass = no frame sent after the
 * refused one is acked (ackPrefix), none of them is durable, and the frames before it are durable (their acks may
 * be lost with the closed socket: group commit acks after the close, the client resends on reconnect).
 */
export async function FENCE(ctx: RunCtx): Promise<Result> {
	const rounds = ctx.num("rounds", 5);
	const out: Result[] = [];
	for (const variant of (ctx.str("variants", "toolarge,rate") ?? "toolarge,rate").split(",")) {
		for (let r = 0; r < rounds; r++) {
			const body = await note(ctx, `fence-${variant}${r}`, 1024);
			const a = await ctx.client("A", body);
			a.reconnect = false;
			await openOrThrow(a);
			await sleep(800);
			const c0 = await relayCounters(ctx);
			const pre: Uint8Array[] = [], post: Uint8Array[] = [];
			const preIds: string[] = [], postIds: string[] = [];
			const push = (arr: Uint8Array[], ids: string[], fn: (t: Y.Text) => void) => {
				const cap = (u: Uint8Array, o: unknown) => { if (o !== a) arr.push(u); };
				a.doc.on("update", cap);
				try { ids.push(a.editTracked(fn).frameId); } finally { a.doc.off("update", cap); }
			};
			let refusedId = "";
			if (variant === "toolarge") {
				for (let i = 0; i < 3; i++) push(pre, preIds, (t) => t.insert(0, `p${i}`));
				const big: Uint8Array[] = [];
				const bigIds: string[] = [];
				push(big, bigIds, (t) => t.insert(t.length, "x".repeat(1_800_000)));
				refusedId = bigIds[0]!;
				for (let i = 0; i < 3; i++) push(post, postIds, (t) => t.insert(0, `q${i}`));
			} else {
				const chunk = "y".repeat(32 * 1024);
				for (let i = 0; i < ctx.num("rate-frames", 80); i++) push(post, postIds, (t) => t.insert(0, `${i}:${chunk}`));
			}
			const closed = await a.waitClose(10_000);
			await sleep(2500);   // group commit window + slack
			const c1 = await relayCounters(ctx);
			const acked = new Set(a.acks.map((k) => k.frameId));
			const prefix = a.ackPrefixCheck();
			const cov = await durableCoverage(ctx, body, [...pre, ...post]);
			const snapDoc = new Y.Doc();
			const res = await fetch(vaultRoute(ctx.context.devices.A!, `body/${encodeURIComponent(body)}`), { headers: deviceBearerHeaders(ctx.context.devices.A!) });
			Y.applyUpdate(snapDoc, new Uint8Array(await res.arrayBuffer()));
			const snap = Y.snapshot(snapDoc);
			const durable = (u: Uint8Array) => Y.snapshotContainsUpdate(snap, u);
			snapDoc.destroy();
			// rate: the refused frame is the first unacked one; every later one must be unacked and non-durable.
			const firstUnacked = prefix.firstUnacked;
			const rec: Result = { variant, round: r, bodyId: body, close: closed, refusedFrameId: refusedId || (firstUnacked >= 0 ? postIds[firstUnacked] : null),
				preFrames: pre.length, preAcked: preIds.filter((id) => acked.has(id)).length, preDurable: pre.filter(durable).length,
				postFrames: post.length, postAcked: postIds.filter((id) => acked.has(id)).length,
				postDurable: post.filter(durable).length, firstUnackedIndex: firstUnacked, ackPrefix: prefix,
				afterRefusalAcked: variant === "rate" ? (firstUnacked < 0 ? 0 : postIds.slice(firstUnacked + 1).filter((id) => acked.has(id)).length) : postIds.filter((id) => acked.has(id)).length,
				afterRefusalDurable: variant === "rate" ? (firstUnacked < 0 ? 0 : post.slice(firstUnacked + 1).filter(durable).length) : post.filter(durable).length,
				counterDelta: delta(c0, c1, V3_KEYS), durableMissing: cov.missing };
			rec.pass = prefix.prefix && rec.afterRefusalAcked === 0 && rec.afterRefusalDurable === 0
				&& (variant !== "toolarge" || rec.preDurable === 3) && closed !== null;
			out.push(rec);
			log(`FENCE ${variant} r${r}: close=${closed?.code} pre ${rec.preAcked}/${rec.preFrames} acked; afterRefusal acked=${rec.afterRefusalAcked} durable=${rec.afterRefusalDurable} pass=${rec.pass}`);
			a.terminate();
		}
	}
	const pass = out.every((x) => x.pass === true);
	return { rounds, results: out, passCount: out.filter((x) => x.pass === true).length, total: out.length, pass, convergence: { pass } };
}

/**
 * HTTPSAVE `--seconds 300 --interval-ms 5000`: closed-note disk path. A plugin rewriting a CLOSED note every 1 s
 * never lets the 2 s settle elapse, so the scheduler admits once per 5 s max-wait (inferred from
 * markdownAdmissionScheduler semantics, client 21bc79d). Emulated as one HTTP candidate POST per `interval-ms`
 * (each carrying the last 5 rewrites merged) on a body with no open socket. Rows per POST come from gql phaseLevel.
 */
export async function HTTPSAVE(ctx: RunCtx): Promise<Result> {
	const seconds = ctx.num("seconds", 300);
	const interval = ctx.num("interval-ms", 5000);
	const body = await note(ctx, "httpsave", 4096);
	const owner = ctx.context.devices.A!;
	const res = await fetch(vaultRoute(owner, `body/${encodeURIComponent(body)}`), { headers: deviceBearerHeaders(owner) });
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
	const text = doc.getText("body");
	const c0 = await relayCounters(ctx);
	const posts: Result[] = [];
	const t0 = now();
	for (let i = 0; now() - t0 < seconds * 1000; i++) {
		const wait = t0 + i * interval - now();
		if (wait > 1) await sleep(wait);
		const ups: Uint8Array[] = [];
		const cap = (u: Uint8Array) => ups.push(u);
		doc.on("update", cap);
		for (let k = 0; k < Math.max(1, Math.round(interval / 1000)); k++) {
			doc.transact(() => {
				if (text.toString().startsWith("[autosave ")) text.delete(0, 32);
				text.insert(0, `[autosave ${String(i * 10 + k).padStart(6, "0")} ${Date.now().toString(36)}]`.padEnd(32, " ").slice(0, 32));
			});
		}
		doc.off("update", cap);
		const upd = Y.mergeUpdates(ups);
		const digest = createHash("sha256").update(upd).digest("hex");
		const p0 = now();
		const r = await fetch(vaultRoute(owner, `body/${encodeURIComponent(body)}/candidate`), { method: "POST",
			headers: { ...deviceBearerHeaders(owner), "content-type": "application/octet-stream", "x-yaos-body-epoch": "1",
				"x-yaos-candidate-id": randomUUID(), "x-yaos-candidate-digest": digest }, body: upd });
		await r.text();
		posts.push({ i, status: r.status, ms: r2(now() - p0), bytes: upd.byteLength });
	}
	await sleep(2000);
	const c1 = await relayCounters(ctx);
	const get = await bodyGet(owner, body);
	const ok = get.text === text.toString();
	doc.destroy();
	return { seconds, intervalMs: interval, rewritesPerPost: Math.max(1, Math.round(interval / 1000)), posts: posts.length,
		okPosts: posts.filter((p) => p.status === 200).length, postMs: series(posts.map((p) => p.ms as number), 0),
		statuses: [...new Set(posts.map((p) => p.status))], counterDelta: delta(c0, c1, V3_KEYS), samples: posts,
		convergence: { pass: ok, httpGetEqual: ok } };
}
