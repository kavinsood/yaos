/**
 * §7.4 limits: X1 socket ramp, X2 max append rate, X3 large notes, X4 stale catch-up ceiling.
 */
import * as Y from "yjs";
import { decodeBinaryEnvelope } from "../../../server/src/shared/binaryEnvelope";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders } from "../../../tests/live/liveIdentity";
import { log, now, r2, series, sleep } from "../lib/common";
import { smallContent, smallId, wordsContent } from "../lib/context";
import { bodyGet, bodyHead, convergence, diagnostics } from "../lib/checks";
import { RawClient } from "../lib/rawClient";
import { CoverageTracker, freshNotes, keystrokes, openOrThrow, operatorVaultPost, type RunCtx } from "../lib/run";
import { SMALL_COUNT } from "../context";

type Result = Record<string, unknown>;

/**
 * Ramp raw body sockets 100 → 250 → 500 → 1000 → 2000 across ≤4 devices (round-robin over the 100 small notes),
 * with an L2 probe (fresh pair) and diagnostics at each step. Stops after a step where > `--stop-fail` of new opens fail.
 */
export async function X1(ctx: RunCtx): Promise<Result> {
	const steps = (ctx.str("steps", "100,250,500,1000,2000")!).split(",").map(Number);
	const probeN = ctx.num("probe-n", 30);
	const concurrency = ctx.num("concurrency", 25);
	const stopFail = ctx.num("stop-fail", 0.5);
	const devices = ["A", "B", "C", "D"];
	for (const d of devices) await ctx.dev(d);
	const [probeBody] = await freshNotes(ctx, "x1probe", 1, (i) => smallContent(i));
	const clients: RawClient[] = [];
	const failures: Result[] = [];
	const stepResults: Result[] = [];
	let firstFailure: Result | null = null;
	let index = 0;
	for (const target of steps) {
		const stepStart = now();
		let stepAttempts = 0;
		let stepFailures = 0;
		while (clients.length < target) {
			const batch = Math.min(concurrency, target - clients.length);
			const opened = await Promise.all(Array.from({ length: batch }, async () => {
				const i = index++;
				const c = new RawClient(await ctx.dev(devices[i % devices.length]!), smallId(i % SMALL_COUNT), undefined, ctx.adapter);
				c.keepControls = false;
				const outcome = await c.open(30_000);
				return { c, i, outcome };
			}));
			for (const { c, i, outcome } of opened) {
				stepAttempts++;
				if (outcome.status === "ok") clients.push(c);
				else {
					stepFailures++;
					const f = { index: i, openCount: clients.length, ...outcome };
					failures.push(f);
					firstFailure ??= f;
				}
			}
			if (stepFailures > 0 && stepFailures / stepAttempts > stopFail && stepAttempts >= 20) break;
		}
		const openMs = r2(now() - stepStart);
		await sleep(2000);
		const alive = clients.filter((c) => c.isOpen).length;
		const diag = await diagnostics(ctx.context.devices.A!);
		let probe: Result = { skipped: true };
		// Saturated (e.g. base MAX_BODY_SOCKETS=32): free two slots so the probe measures latency at ~cap.
		let probeFreedSlots = 0;
		if (stepFailures > 0) {
			for (const c of clients.filter((x) => x.isOpen).slice(-2)) { await c.close(); probeFreedSlots++; }
			await sleep(500);
		}
		const pa = new RawClient(ctx.context.devices.A!, probeBody!, undefined, ctx.adapter);
		const pb = new RawClient(ctx.context.devices.B!, probeBody!, undefined, ctx.adapter);
		const [oa, ob] = [await pa.open(30_000), await pb.open(30_000)];
		if (oa.status === "ok" && ob.status === "ok") {
			const s = await keystrokes(pa, pb, probeN, 500);
			probe = { propagationMs: series(s.map((x) => x.propagationMs), 5), originAckMs: series(s.map((x) => x.ackMs), 5) };
		} else probe = { openA: oa, openB: ob };
		await pa.close(); await pb.close();
		const closeCodes: Record<string, number> = {};
		for (const c of clients) if (c.closed) closeCodes[c.closed.code] = (closeCodes[c.closed.code] ?? 0) + 1;
		stepResults.push({ target, open: alive, attempted: stepAttempts, failed: stepFailures, openMs, closeCodes, probeFreedSlots, probe, diag });
		log(`X1 step ${target}: alive=${alive} failed=${stepFailures}/${stepAttempts} probe p50=${(probe.propagationMs as { summary?: { p50: number } } | undefined)?.summary?.p50}`);
		if (stepFailures > 0 && stepFailures / Math.max(1, stepAttempts) > stopFail) break;
	}
	const sample = clients.find((c) => c.isOpen);
	// Release every other socket first so fresh C is not refused by the socket cap.
	await Promise.all(clients.filter((c) => c !== sample).map(async (c) => { if (c.isOpen) await c.close(); }));
	await sleep(1000);
	const conv = sample ? await convergence({ bodyId: sample.body, clients: [sample], fresh: await ctx.dev("C"), adapter: ctx.adapter }) : null;
	await Promise.all(clients.map((c) => { c.terminate(); c.doc.destroy(); return null; }));
	const failureModes: Record<string, number> = {};
	for (const f of failures) { const k = `${f.httpStatus ?? ""} ${String(f.message).slice(0, 60)}`; failureModes[k] = (failureModes[k] ?? 0) + 1; }
	return { steps, firstFailure, failureModes, stepResults, failures: failures.slice(0, 200), convergence: conv };
}

/**
 * Max sustained append rate: rate steps (edits/s) on one body, then spread over 10 bodies. Propagation per frame
 * via coverage. Stops when p50 > 2× the L1 floor measured at start, or errors/closes.
 */
export async function X2(ctx: RunCtx): Promise<Result> {
	const rates = (ctx.str("rates", "25,50,100,200,400,800")!).split(",").map(Number);
	const stepMs = ctx.num("step-ms", 10_000);
	const bodiesModes = (ctx.str("bodies", "1,10")!).split(",").map(Number);
	const ids = await freshNotes(ctx, "x2", Math.max(...bodiesModes), (i) => smallContent(i));
	// Floor.
	const floorClient = await openOrThrow(await ctx.client("A", ids[0]!));
	const rtts: number[] = [];
	for (let i = 0; i < 20; i++) {
		const probeId = `x2-${i}`;
		const got = floorClient.waitControl((v) => v.type === "VAULT_PONG" && v.probeId === probeId, 5000);
		const t0 = now();
		floorClient.send(`__YPS:${JSON.stringify({ type: "VAULT_PING", probeId })}`);
		const pong = await got;
		if (pong) rtts.push(pong.at - t0);
		await sleep(100);
	}
	await floorClient.close();
	const floor = series(rtts, 5).summary!.p50;
	const modes: Result[] = [];
	const allPairs: Array<[RawClient, RawClient]> = [];
	for (const bodies of bodiesModes) {
		const pairs: Array<[RawClient, RawClient]> = [];
		for (let i = 0; i < bodies; i++) {
			pairs.push([await openOrThrow(await ctx.client("A", ids[i]!)), await openOrThrow(await ctx.client("B", ids[i]!))]);
		}
		allPairs.push(...pairs);
		await sleep(1500);
		const stepsOut: Result[] = [];
		let maxOk = 0;
		for (const rate of rates) {
			const trackers = pairs.map(([, b]) => new CoverageTracker(b.doc));
			const total = Math.round((rate * stepMs) / 1000);
			const t0 = now();
			let sent = 0;
			for (let k = 0; k < total; k++) {
				const wait = t0 + (k * 1000) / rate - now();
				if (wait > 1) await sleep(wait);
				const p = k % pairs.length;
				const [a] = pairs[p]!;
				if (!a.isOpen && !a.reconnecting) break;
				let update: Uint8Array | null = null;
				const cap = (u: Uint8Array, o: unknown) => { if (o !== a) update = u; };
				a.doc.on("update", cap);
				const tracked = a.editTracked((t) => t.insert(t.length, "r"));
				a.doc.off("update", cap);
				if (update) trackers[p]!.sent(k, update, tracked.sentAt);
				sent++;
			}
			const achievedRate = r2(sent / ((now() - t0) / 1000));
			const deadline = now() + 30_000;
			while (trackers.some((t) => t.outstanding > 0) && now() < deadline) await sleep(50);
			const covered = trackers.flatMap((t) => t.coveredMs.filter((v): v is number => typeof v === "number"));
			const lost = trackers.reduce((s, t) => s + t.outstanding, 0);
			trackers.forEach((t) => t.stop());
			const summary = series(covered, 0).summary;
			const lostSince = (c: RawClient) => c.closeLog.filter((x) => !x.byClient && x.at >= t0);
			const closed = pairs.filter(([a, b]) => lostSince(a).length + lostSince(b).length > 0).map(([a, b]) => ({ a: lostSince(a), b: lostSince(b) }));
			const ok = summary !== null && summary.p50 <= 2 * floor && lost === 0 && closed.length === 0;
			stepsOut.push({ rate, sent, achievedRate, propagationMs: summary, lost, closed, withinTwiceFloor: ok });
			log(`X2 bodies=${bodies} rate=${rate} achieved=${achievedRate} p50=${summary?.p50} lost=${lost}`);
			if (ok) maxOk = rate;
			if (closed.length > 0 || lost > 0) break;
			if (!ctx.args.flags["no-stop"] && summary && summary.p50 > 2 * floor && rate >= 100) break;
			await sleep(3000);
		}
		modes.push({ bodies, maxRateWithinTwiceFloor: maxOk, steps: stepsOut });
	}
	const [ca, cb] = allPairs[0]!;
	const conv = await convergence({ bodyId: ca.body, clients: [ca, cb], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000 });
	for (const [a, b] of allPairs) { await a.close(); await b.close(); }
	return { floorPingP50Ms: floor, stepMs, modes, convergence: conv };
}

/** Largest note: seed 1/5/10 MB, fresh client step2 (time/bytes), one edit + ack, forced checkpoint (debug/compact). */
/** One VAULT_PING RTT on an open socket (network-drift probe next to a large open). */
export async function pingRtt(client: RawClient, timeoutMs = 5000): Promise<number | null> {
	if (!client.isOpen) return null;
	const probeId = `x3-${Math.random().toString(36).slice(2)}`;
	const got = client.waitControl((v) => v.type === "VAULT_PONG" && v.probeId === probeId, timeoutMs);
	const t0 = now();
	client.send(`__YPS:${JSON.stringify({ type: "VAULT_PING", probeId })}`);
	const pong = await got;
	return pong ? r2(pong.at - t0) : null;
}

/**
 * Large notes 1/5/10 MB: seed, then `--repeats` socket opens with per-phase timing (ticket, upgrade, step1→step2,
 * step2 bytes), a ping RTT on a separate small socket right before each open (network drift), and two HTTP GETs
 * split into TTFB (server merge/serialise + RTT) and download (transfer). The second GET usually hits the merged
 * cache, so its download time is a pure-network reference for the same byte count: step1→step2 minus that
 * reference ≈ server-side cost of the socket open. `phaseSamples[].sentAtWall` = step1 send time, so analyze.py
 * can join each open with the DO ws-message tail event (wall/cpu) when run with --tail.
 */
export async function X3(ctx: RunCtx): Promise<Result> {
	const sizes = (ctx.str("sizes-mb", "1,5,10")!).split(",").map(Number);
	const repeats = ctx.num("repeats", 3);
	const results: Result[] = [];
	const phaseSamples: Result[] = [];
	let lastConv: Result | null = null;
	const pinger = await openOrThrow(await ctx.client("A", await freshNotes(ctx, "x3-ping", 1, () => smallContent(3)).then((ids) => ids[0]!)));
	for (const mb of sizes) {
		const bytes = Math.round(mb * 1_000_000);
		const content = wordsContent(mb * 7, bytes);
		const r: Result = { mb, bytes };
		const t0 = now();
		let id: string | null = null;
		try { id = (await freshNotes(ctx, `x3-${mb}mb`, 1, () => content))[0]!; r.seedMs = r2(now() - t0); }
		catch (error) { r.seedError = String(error).slice(0, 300); r.seedMs = r2(now() - t0); results.push(r); log(`X3 ${mb} MB seed failed`); continue; }
		const d0 = await diagnostics(ctx.context.devices.A!);
		const opens: Result[] = [];
		let c: RawClient | null = null;
		for (let k = 0; k < repeats; k++) {
			if (c) { c.terminate(); c.doc.destroy(); await sleep(1000); }
			const pingBeforeMs = await pingRtt(pinger);
			c = await ctx.client("B", id);
			const outcome = await c.open(180_000);
			const phases = c.openPhases();
			const row = { k, ...outcome, pingBeforeMs, ...phases, bytesIn: c.bytesIn,
				correct: outcome.status === "ok" ? c.text() === content : null, pingAfterMs: await pingRtt(pinger) };
			opens.push(row);
			phaseSamples.push({ mb, k, sentAtWall: phases.step1SentWall, step1ToStep2Ms: phases.step1ToStep2Ms, step2Bytes: phases.step2Bytes });
			log(`X3 ${mb} MB open#${k}: ${JSON.stringify(row).slice(0, 220)}`);
			if (outcome.status !== "ok") break;
		}
		r.opens = opens;
		r.open = opens[0] ?? null;
		const d1 = await diagnostics(ctx.context.devices.A!);
		const gets: Result[] = [];
		for (let k = 0; k < 2; k++) {
			const g = await bodyGet(ctx.context.devices.C!, id);
			gets.push({ k, status: g.status, ttfbMs: g.ttfbMs, downloadMs: g.downloadMs ?? null, totalMs: g.elapsedMs, bytes: g.bytes,
				mbitPerSec: g.downloadMs ? r2((g.bytes * 8) / 1000 / g.downloadMs) : null, cfRay: g.cfRay, textEqual: g.text === content });
		}
		r.gets = gets;
		const netRef = gets.at(-1)?.downloadMs as number | undefined;
		const s2 = opens.filter((o) => typeof o.step1ToStep2Ms === "number").map((o) => o.step1ToStep2Ms as number);
		r.breakdown = { step1ToStep2Ms: s2, networkRefDownloadMs: netRef ?? null, pingMs: opens.map((o) => o.pingBeforeMs),
			inferredServerMs: netRef !== undefined ? s2.map((v) => r2(v - netRef - Number(opens[0]?.pingBeforeMs ?? 0))) : null,
			note: "inferredServerMs = step1→step2 − cached-GET download time for the same bytes − ping RTT (inferred; tail wall time is the direct measure)" };
		if (c && c.isOpen) {
			const tracked = c.editTracked((t) => t.insert(Math.floor(t.length / 2), "X3"));
			const ack = await c.waitAck(tracked.frameId, tracked.sentAt, 30_000);
			r.editAckMs = ack ? r2(ack.at - tracked.sentAt) : null;
			r.closedAfterEdit = await c.waitClose(1000);
		}
		const c0 = now();
		r.compact = { ...(await operatorVaultPost(ctx, "debug/compact")), ms: r2(now() - c0) };
		const g = await bodyGet(ctx.context.devices.C!, id);
		r.get = { status: g.status, ms: g.elapsedMs, ttfbMs: g.ttfbMs, bytes: g.bytes, textEqual: c ? g.text === c.text() : null };
		r.diagnostics = { before: d0, afterOpen: d1, afterCompact: await diagnostics(ctx.context.devices.A!) };
		if (c?.isOpen) lastConv = await convergence({ bodyId: id, clients: [c], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 60_000 });
		if (c) { c.terminate(); c.doc.destroy(); }
		results.push(r);
	}
	await pinger.close();
	return { sizesMb: sizes, repeats, results, phaseSamples, convergence: lastConv };
}

/** 100 bodies × 50 edits while B is stale: HTTP /catch-up (one batch) and socket reopen of every body. */
export async function X4(ctx: RunCtx): Promise<Result> {
	const bodyCount = ctx.num("bodies", 100);
	const edits = ctx.num("edits", 50);
	const ids = await freshNotes(ctx, "x4", bodyCount, (i) => smallContent(i));
	const docs = new Map<string, Y.Doc>();
	const gens = new Map<string, number>();
	// B syncs every body once, then goes offline.
	for (let i = 0; i < ids.length; i += 25) {
		await Promise.all(ids.slice(i, i + 25).map(async (id) => {
			const doc = new Y.Doc({ guid: id });
			const c = await openOrThrow(await ctx.client("B", id, doc));
			await c.close();
			docs.set(id, doc);
		}));
	}
	for (const id of ids) {
		const h = await bodyHead(ctx.context.devices.B!, id);
		if (typeof h.value?.generation === "number") gens.set(id, h.value.generation);
	}
	// A edits every body, ≤25 sockets at a time.
	const editStart = now();
	const finalA = new Map<string, string>();
	for (let i = 0; i < ids.length; i += 25) {
		await Promise.all(ids.slice(i, i + 25).map(async (id) => {
			const a = await openOrThrow(await ctx.client("A", id));
			for (let k = 0; k < edits; k++) { a.edit((t) => t.insert(Math.floor(t.length / 2), `x${k} `)); await sleep(20); }
			const last = a.sent.at(-1)!;
			await a.waitAck(last.clientFrameId, last.at, 10_000);
			finalA.set(id, a.text());
			await a.close();
		}));
		log(`X4 edited ${Math.min(i + 25, ids.length)}/${ids.length}`);
	}
	const editMs = r2(now() - editStart);
	await sleep(3000);
	// HTTP catch-up in one request (MAX_CATCH_UP_BODIES = 100, MAX_CATCH_UP_BYTES = 8 MiB).
	const c0 = now();
	const response = await fetch(vaultRoute(ctx.context.devices.B!, "catch-up"), { method: "POST",
		headers: deviceBearerHeaders(ctx.context.devices.B!, { "Content-Type": "application/json" }),
		body: JSON.stringify({ bodies: ids.map((id) => ({ bodyId: id, bodyEpoch: 1, ...(gens.has(id) ? { generation: gens.get(id) } : {}) })) }) });
	const buf = new Uint8Array(await response.arrayBuffer());
	const catchUpMs = r2(now() - c0);
	let httpCurrent = 0;
	let statuses: Record<string, number> = {};
	if (response.ok) {
		const decoded = decodeBinaryEnvelope(buf) as { bodies: Array<{ bodyId: string; status: number; update?: Uint8Array }> };
		statuses = decoded.bodies.reduce((m, b) => { m[b.status] = (m[b.status] ?? 0) + 1; return m; }, {} as Record<string, number>);
		for (const b of decoded.bodies) {
			if (!b.update) continue;
			const doc = new Y.Doc(); Y.applyUpdate(doc, docs.get(b.bodyId) ? Y.encodeStateAsUpdate(docs.get(b.bodyId)!) : new Uint8Array([0, 0]));
			Y.applyUpdate(doc, b.update);
			if (doc.getText("body").toString() === finalA.get(b.bodyId)) httpCurrent++;
			doc.destroy();
		}
	}
	// Socket reopen of every stale body with its old doc (≤25 at a time).
	const s0 = now();
	let socketBytes = 0;
	let socketCurrent = 0;
	let lastClient: RawClient | null = null;
	for (let i = 0; i < ids.length; i += 25) {
		await Promise.all(ids.slice(i, i + 25).map(async (id) => {
			const c = await ctx.client("B", id, docs.get(id));
			const outcome = await c.open(30_000);
			if (outcome.status === "ok" && await c.waitText((t) => t === finalA.get(id), 10_000)) socketCurrent++;
			socketBytes += c.bytesIn;
			if (id === ids[0]) lastClient = c; else await c.close();
		}));
	}
	const socketMs = r2(now() - s0);
	const conv = lastClient ? await convergence({ bodyId: ids[0]!, clients: [lastClient], fresh: await ctx.dev("C"), adapter: ctx.adapter }) : null;
	await (lastClient as RawClient | null)?.close();
	return { bodies: bodyCount, editsPerBody: edits, editMs,
		httpCatchUp: { status: response.status, ms: catchUpMs, bytes: buf.byteLength, statuses, current: httpCurrent,
			envelopeLimitHit: response.status === 413, error: response.ok ? null : new TextDecoder().decode(buf).slice(0, 200) },
		socketReopen: { ms: socketMs, bytesIn: socketBytes, current: socketCurrent },
		convergence: conv };
}
