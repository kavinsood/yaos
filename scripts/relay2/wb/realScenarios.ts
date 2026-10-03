/**
 * Real-client variants of the W4 write-budget scenarios (loaded lazily from wb/scenarios.ts):
 *   I4  (default)              D5 fold / hold / after through a real VaultSync's create collector (commitFreshBody).
 *   (b3-bulk: only I4 is ported; R1 live / DL / C4W / XCRASH real-client variants stay on write-budget-spike.)
 * See realClient.ts for what "real" means (nothing in src/ or packages/ is reimplemented).
 */
import { randomUUID } from "node:crypto";
import { bodyGet } from "../lib/checks";
import { dist, log, now, r2, sleep } from "../lib/common";
import { openOrThrow, type RunCtx } from "../lib/run";
import { rowsDelta } from "./adapters";
import { noteText } from "./corpus";
import { openRealClient } from "./realClient";
import { rowsCounter } from "./scenarios";

type Result = Record<string, unknown>;
const realDevice = (ctx: RunCtx) => ctx.str("real-device", "RC")!;
const settled = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value, at: now() }),
	(error: unknown) => ({ ok: false as const, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), at: now() }));

export async function openRC(ctx: RunCtx, label: string, extra: Partial<Parameters<typeof openRealClient>[3]> = {}) {
	const id = await ctx.dev(realDevice(ctx));
	const collector = ctx.args.flags["collector-ms"] !== undefined ? ctx.num("collector-ms", 300) : undefined;
	return openRealClient(ctx.host, ctx.context, id, { device: realDevice(ctx), label: `${label}-${ctx.tag}`,
		...(collector !== undefined ? { createCollectorDelayMs: collector } : {}), ...extra });
}


// ================================================================================================= I4 (real)
/**
 * I4 through the real VaultSync create collector (W2):
 *   fold  — commitFreshBody(template), then `--paste-at-ms` (100) later commitFreshBody(template+paste) while the
 *           create is still in the collector → first caller cancelled, ONE create-bulk carrying the pasted text, 0 candidates
 *   hold  — commitFreshBody(template) + flushPendingCreates(), then `--hold-paste-ms` (1) later commitFreshBody(template+paste)
 *           while the create-bulk is in flight → the paste is committed as a candidate only after the create receipt
 *   after — create, then `--late-ms` (3000) after the create started open the note like an editor and paste into
 *           Y.Text("body") (socket update + debounced HTTP candidate)
 * Asserts no candidate POST and no body-socket update for the note before the create-bulk response.
 */
export async function I4real(ctx: RunCtx): Promise<Result> {
	const rows = rowsCounter(ctx);
	const pasteAt = ctx.num("paste-at-ms", 100), holdAt = ctx.num("hold-paste-ms", 1), late = ctx.num("late-ms", 3000);
	const cases = (ctx.str("cases", "fold,hold,after")!).split(",");
	const reps = ctx.num("reps", 3);
	const paste = noteText({ kind: "note", index: 0, path: "paste.md", bodyId: "x", bytes: ctx.num("paste-bytes", 10_000), seed: 99, huge: false });
	const template = "# New note\n";
	const rc = await openRC(ctx, "i4");
	await sleep(1500);
	const out: Result[] = [];
	try {
		for (const name of cases) for (let rep = 0; rep < reps; rep++) {
			const bodyId = `${ctx.tag}-i4r-${name}-${rep}`;
			const path = `WB/${ctx.tag}/i4r-${name}-${rep}.md`;
			const mk = (content: string) => ({ bodyId, path, content, reason: `wb-i4-${name}`, candidateId: randomUUID() });
			const h0 = rc.http.length, w0 = rc.wsOut.length;
			const r0 = await rows.read();
			const t0 = now();
			const ev: Result = { case: name, rep, bodyId };
			const expected = template + paste;
			if (name === "fold") {
				const p1 = settled(rc.vs.commitFreshBody(mk(template)));
				await sleep(pasteAt);
				ev.pasteCalledMs = r2(now() - t0);
				const p2 = settled(rc.vs.commitFreshBody(mk(expected)));
				const [a, b] = await Promise.all([p1, p2]);
				ev.firstCaller = a.ok ? "created (NOT folded)" : a.error;
				ev.secondCaller = b.ok ? "created" : b.error;
			} else if (name === "hold") {
				const p1 = settled(rc.vs.commitFreshBody(mk(template)));
				await sleep(0);
				rc.vs.flushPendingCreates();
				await sleep(holdAt);
				const pasteCalled = now();
				ev.pasteCalledMs = r2(pasteCalled - t0);
				const p2 = settled(rc.vs.commitFreshBody(mk(expected)));
				const [a, b] = await Promise.all([p1, p2]);
				ev.firstCaller = a.ok ? "created" : a.error;
				ev.secondCaller = b.ok ? ((b.value as { receipt?: unknown }).receipt ? "committed after create receipt" : "created") : b.error;
				ev.pasteHeldMs = r2(b.at - pasteCalled);
			} else {
				const a = await settled(rc.vs.commitFreshBody(mk(template)));
				ev.firstCaller = a.ok ? "created" : a.error;
				await sleep(Math.max(0, t0 + late - now()));
				const text = await rc.openEditor(path);
				const typedAt = rc.type(text, paste);
				ev.pasteTypedMs = r2(typedAt - t0);
				const until = now() + 20_000;
				while (now() < until && rc.receiptCovering(bodyId, typedAt) === null) await sleep(20);
				const rAt = rc.receiptCovering(bodyId, typedAt);
				ev.pasteReceiptMs = rAt === null ? null : r2(rAt - typedAt);
				rc.closeEditor(path);
			}
			const reqs = rc.http.slice(h0);
			const creates = reqs.filter((h) => h.path.endsWith("/lifecycle/create-bulk"));
			const candPosts = reqs.filter((h) => /\/candidates?$/.test(h.path));
			const createEnd = creates[0]?.end ?? Infinity;
			ev.createBulkPosts = creates.length;
			ev.candidatePosts = candPosts.length;
			ev.createSentMs = creates[0] ? r2(creates[0].at - t0) : null;
			ev.createReceiptMs = creates[0] ? r2(creates[0].end - t0) : null;
			if (name === "hold") ev.pasteDuringCreateInFlight = creates[0] ? (t0 + Number(ev.pasteCalledMs) >= creates[0].at && t0 + Number(ev.pasteCalledMs) < creates[0].end) : false;
			ev.candidateBeforeCreateReceipt = candPosts.filter((h) => h.at < createEnd).length;
			ev.bodyFramesBeforeCreateReceipt = rc.wsOut.slice(w0).filter((f) => f.bodyId === bodyId && f.at < createEnd && (f.kind === "update" || f.kind === "step2")).length;
			ev.requests = rc.httpSummary(t0);
			const b = await openOrThrow(await ctx.client("B", bodyId), 60_000);
			const visibleAt = await b.waitText((t) => t === expected, 20_000);
			ev.peerVisibleMs = visibleAt === null ? null : r2(visibleAt - t0);
			await b.close();
			await sleep(ctx.num("settle-ms", 3000));
			ev.rows = rowsDelta(r0, await rows.read());
			const g = await bodyGet(await ctx.dev("C"), bodyId);
			ev.serverTextOk = g.text === expected;
			ev.serverGeneration = g.generation ?? null;
			const want = name === "fold" ? { createBulkPosts: 1, candidatePosts: 0 } : name === "hold" ? { createBulkPosts: 1, candidatePosts: 1 } : { createBulkPosts: 1 };
			ev.shapeOk = Object.entries(want).every(([k, v]) => ev[k] === v) && (name !== "fold" || String(ev.firstCaller).includes("FreshAdmissionCancelledError"));
			out.push(ev);
			log(`I4(real) ${name}#${rep}: rows ${(ev.rows as Result).rowsWritten} creates ${ev.createBulkPosts} cand ${ev.candidatePosts} early ${ev.candidateBeforeCreateReceipt}/${ev.bodyFramesBeforeCreateReceipt} visible ${ev.peerVisibleMs} ok ${ev.serverTextOk}`);
		}
	} finally { await rc.close().catch(() => undefined); }
	const byCase: Result = {};
	for (const name of cases) {
		const xs = out.filter((e) => e.case === name);
		byCase[name] = { rows: dist(xs.map((e) => (e.rows as Result).rowsWritten as number | null)), peerVisibleMs: dist(xs.map((e) => e.peerVisibleMs as number | null)),
			createBulkPosts: xs.map((e) => e.createBulkPosts), candidatePosts: xs.map((e) => e.candidatePosts), allTextOk: xs.every((e) => e.serverTextOk), allShapeOk: xs.every((e) => e.shapeOk) };
	}
	const noEarly = out.every((e) => e.candidateBeforeCreateReceipt === 0 && e.bodyFramesBeforeCreateReceipt === 0);
	return { client: "real VaultSync (commitFreshBody / flushPendingCreates / editor Y.Text)", collectorMs: ctx.num("collector-ms", 300),
		relayDiagnostics: null, byCase, cases: out, noEditBeforeCreateReceipt: noEarly,
		convergence: { pass: noEarly && out.every((e) => e.serverTextOk && e.peerVisibleMs !== null && e.shapeOk) } };
}
