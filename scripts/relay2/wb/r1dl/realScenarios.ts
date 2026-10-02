/**
 * Real-client R1 live and DL scenarios (loaded lazily from wb/scenarios.ts), ported from the write-budget spike
 * (yaos-wb-int scripts/relay2/wb/realScenarios.ts @ 91b1fac + 4f36c9e hardening), trimmed to:
 *   R1live   closed-file reconcile through the real headless CLI daemon (packages/cli via tests/headless/daemon.ts):
 *            disk edits made while the daemon is stopped, server edits by a RawClient peer, then restart.
 *   DL       D8: simulated Cloudflare daily limit mid-typing (real VaultSync) and mid-bulk-create.
 * See realClient.ts for what "real" means (nothing in src/ or packages/ is reimplemented).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Y from "yjs";
import { deviceBearerHeaders } from "../../../../tests/live/liveIdentity";
import { vaultRoute } from "../../../../tests/live/schema4Live";
import { bodyGet, bodyHead } from "../../lib/checks";
import { log, now, r2, sleep } from "../../lib/common";
import { refreshOperatorCookie } from "../../lib/context";
import { contentHashOf, RawClient } from "../../lib/rawClient";
import { freshSmallNote, openOrThrow, type RunCtx } from "../../lib/run";
import { bodyDocWithEpoch, bulkCreate, bulkCreateAvailable, legacyCreate, listHeads, postCandidate, rowsDelta, type RowsReading } from "./adapters";
import { openRealClient, WB_LOG_DIR, type RealClient } from "../realClient";
import { applyMinimalDiff, MERGE_CASES, rowsCounter } from "./scenarios";

type Result = Record<string, unknown>;
const realDevice = (ctx: RunCtx) => ctx.str("real-device", "RC")!;
const settled = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value, at: now() }),
	(error: unknown) => ({ ok: false as const, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), at: now() }));
const alarms = (r: RowsReading) => (typeof r.extra?.setAlarms === "number" ? r.extra.setAlarms : null);
const countBy = (xs: Array<{ outcome: string }>) => xs.reduce<Record<string, number>>((m, o) => { m[o.outcome] = (m[o.outcome] ?? 0) + 1; return m; }, {});

async function openRC(ctx: RunCtx, label: string, extra: Partial<Parameters<typeof openRealClient>[3]> = {}) {
	const id = await ctx.dev(realDevice(ctx));
	return openRealClient(ctx.host, ctx.context, id, { device: realDevice(ctx), label: `${label}-${ctx.tag}`, ...extra });
}

/** Wait until the real client has no unreceipted candidate for `bodyId`, then compare it, peers, a fresh C and HTTP GET. */
export async function realConvergence(ctx: RunCtx, rc: RealClient, text: Y.Text, bodyId: string, peers: RawClient[], settleMs = 20_000) {
	const deadline = now() + settleMs;
	await sleep(500);
	while (now() < deadline && rc.pendingCandidates(bodyId) > 0) await sleep(100);
	const final = text.toString();
	while (now() < deadline && !peers.every((p) => p.text() === final)) await sleep(50);
	const fresh = await ctx.dev("C");
	let get = await bodyGet(fresh, bodyId);
	while (now() < deadline && get.text !== final) { await sleep(250); get = await bodyGet(fresh, bodyId); }
	const head = await bodyHead(fresh, bodyId);
	const c = new RawClient(fresh, bodyId, undefined, ctx.adapter);
	const cOpen = await c.open(60_000);
	await sleep(200);
	const cText = cOpen.status === "ok" ? c.text() : null;
	await c.close();
	const expected = contentHashOf(final);
	const headValue = head.value as Record<string, unknown> | null | undefined;
	const result = { bodyId, textLength: final.length, unreceiptedCandidates: rc.pendingCandidates(bodyId),
		peersAgree: peers.every((p) => p.text() === final), freshC: { status: cOpen.status, textEqual: cText === final },
		httpGet: { status: get.status, textEqual: get.text === final }, recordedHead: { contentHashEqual: headValue?.contentHash === expected.contentHash,
			generation: headValue?.generation ?? null } };
	return { ...result, pass: result.peersAgree && result.freshC.textEqual && result.httpGet.textEqual && result.recordedHead.contentHashEqual };
}

// ================================================================================================= R1 live (CLI daemon)
const R1_LIVE_DEFAULT = "nonoverlap-edits,overlap-differ,nobase-identical,nobase-different";
const ARTIFACT_RE = / \(YAOS conflict - (\w+) from .+\)\.md$/;

/**
 * The real closed-file reconcile: the headless CLI daemon (`packages/cli`, `tests/headless/daemon.ts`) holds the vault
 * on disk. Per case the daemon is stopped, disk gets `ours` and the server gets `theirs` (RawClient B, minimal splice;
 * no-base cases: the note is created on the server by A and written to disk at the same path while the daemon is down),
 * then the daemon restarts and its startup reconcile (mergeThreeWayLines / no-base preservation) decides. Rows are the
 * counter delta over restart → settle (a no-change control restart is reported alongside).
 */
export async function R1live(ctx: RunCtx): Promise<Result> {
	const { enroll, startDaemon } = await import("../../../../tests/headless/daemon.ts");
	const rows = rowsCounter(ctx);
	const ids = (ctx.str("live-cases", R1_LIVE_DEFAULT)!).split(",");
	const settleMs = ctx.num("settle-ms", 4000);
	const root = join(WB_LOG_DIR, "wb-r1", `${ctx.tag}`);
	rmSync(root, { recursive: true, force: true });
	const vaultPath = join(root, "vault"), xdgStateHome = join(root, "xdg");
	mkdirSync(vaultPath, { recursive: true }); mkdirSync(xdgStateHome, { recursive: true });
	const a = ctx.context.devices.A!;
	// Product bug seen on the spike: the CLI's BootstrapClient.materializeCatalog asks bootstrap/:id/bodies for up to
	// 1000 ids at once but the server caps MAX_CATCH_UP_BODIES at 100 (400 invalid_body_batch), so a full CLI bootstrap
	// of a vault with > 100 active notes fails. Fail fast with the reason instead of a daemon that never becomes ready.
	{
		const active = (await listHeads(a)).entries.filter((e) => (e.lifecycle ?? "active") === "active").length;
		if (active > 100 && ctx.args.flags["force-daemon"] === undefined) {
			throw new Error(`R1 live daemon: vault has ${active} active notes (> 100); the CLI bootstrap bodies() call may not be chunked to the server's 100-body cap. Use a vault with ≤ 100 notes (context.ts --seed none), R1 (emulated), or --force-daemon.`);
		}
	}
	const pr = await fetch(vaultRoute(a, "auth/pairing-code"), { method: "POST", headers: deviceBearerHeaders(a, { "Content-Type": "application/json" }), body: JSON.stringify({ purpose: "device" }) });
	const pairing = await pr.json() as { pairingCode?: string };
	if (!pr.ok || !pairing.pairingCode) throw new Error(`pairing failed ${pr.status}`);
	process.env.YAOS_DEBUG = "true";
	await enroll(vaultPath, { xdgStateHome, host: ctx.host, pairingCode: pairing.pairingCode });
	const daemonOpts = { vaultPath, vaultId: ctx.context.vaultId, xdgStateHome };
	type D = ReturnType<typeof startDaemon>;
	let daemon: D | null = null;
	const logs: string[] = [];
	const start = async () => { const t0 = now(); daemon = startDaemon(daemonOpts); await daemon.waitForReady(); return r2(now() - t0); };
	const stop = async () => { if (!daemon) return; await daemon.stop("SIGTERM"); logs.push(daemon.stderr()); daemon = null; };
	const disk = (rel: string) => { const p = join(vaultPath, rel); return existsSync(p) ? readFileSync(p, "utf8") : null; };
	const waitFor = async (pred: () => boolean | Promise<boolean>, ms: number) => { const d = now() + ms; while (now() < d) { if (await pred()) return true; await sleep(200); } return false; };
	const artifactsFor = (rel: string) => {
		const dir = join(vaultPath, rel, ".."); const base = rel.split("/").pop()!.replace(/\.md$/, "");
		return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${base} (YAOS conflict`)).map((f) => ({ file: f, source: f.match(ARTIFACT_RE)?.[1] ?? null,
			content: readFileSync(join(dir, f), "utf8") })) : [];
	};
	const conflictLines = (rel: string) => ((daemon as D | null)?.stderr() ?? "").split("\n").filter((l) => l.includes(rel.replace(/\.md$/, ""))
		&& /conflict|three-way|no-common-base|preserved-unresolved|candidate committed|divergence/i.test(l)).map((l) => l.trim().slice(0, 300));
	const out: Result[] = [];
	let control: Result | null = null;
	let restartCheck: Result | null = null;
	try {
		const readyMs = await start();
		log(`R1 live: daemon ready in ${readyMs} ms`);
		// Control: restart with no change → rows a bare daemon restart costs (bootstrap, sockets, reconcile scan).
		await sleep(3000);
		await stop();
		{
			const r0 = await rows.read();
			const ms = await start();
			await sleep(settleMs + 2000);
			control = { restartReadyMs: ms, rows: rowsDelta(r0, await rows.read()) };
			log(`R1 live control restart rows ${(control.rows as Result).rowsWritten}`);
		}
		for (const id of ids) {
			const c = MERGE_CASES.find((m) => m.id === id);
			if (!c) throw new Error(`unknown R1 case ${id}`);
			const bodyId = `${ctx.tag}-r1l-${id}`, rel = `WB/${ctx.tag}/r1l-${id}.md`;
			const ev: Result = { id, expect: c.expect };
			if (c.base !== null) {
				const created = await legacyCreate(ctx.context, [{ kind: "note", path: rel, bodyId, content: c.base }]);
				ev.baseCreate = created.outcomes[0]?.outcome;
				ev.baseOnDisk = await waitFor(() => disk(rel) === c.base, 30_000);
				await sleep(1500); // let the daemon record its disk baseline
				await stop();
				writeFileSync(join(vaultPath, rel), c.ours);
				const b = await openOrThrow(await ctx.client("B", bodyId), 60_000);
				b.edit((t) => applyMinimalDiff(t, c.theirs));
				await waitFor(async () => (await bodyGet(a, bodyId)).text === c.theirs, 15_000);
				await b.close();
			} else {
				await stop();
				const created = await legacyCreate(ctx.context, [{ kind: "note", path: rel, bodyId, content: c.theirs }]);
				ev.serverCreate = created.outcomes[0]?.outcome;
				mkdirSync(join(vaultPath, rel, ".."), { recursive: true });
				writeFileSync(join(vaultPath, rel), c.ours);
			}
			await sleep(ctx.num("pre-settle-ms", 3000)); // let the create / B edit's deferred (alarm) writes land before r0
			const generationOf = async () => ((await bodyHead(a, bodyId)).value as Record<string, unknown> | null | undefined)?.generation ?? null;
			const g0 = await generationOf();
			const r0 = await rows.read();
			const t0 = now();
			ev.restartReadyMs = await start();
			const want = c.expect === "clean" ? c.merged! : c.theirs;
			const done = await waitFor(async () => {
				const d = disk(rel); const g = await bodyGet(a, bodyId);
				if (c.expect === "clean") return d === want && g.text === want;
				if (c.expect === "skip") return d === want && g.text === want;
				// overlap: artifact (crdt = theirs), disk keeps ours, body untouched; no-base: artifact (disk = ours), disk ← body.
				return artifactsFor(rel).length > 0 && (c.base !== null || g.text === d);
			}, ctx.num("case-timeout-ms", 30_000));
			ev.settledMs = r2(now() - t0);
			await sleep(settleMs);
			ev.rows = rowsDelta(r0, await rows.read());
			const g1 = await generationOf();
			const server = await bodyGet(a, bodyId);
			const arts = artifactsFor(rel);
			ev.converged = done;
			ev.diskText = disk(rel) === server.text ? "== server" : "differs from server";
			ev.serverText = server.text === c.merged ? "merged" : server.text === c.theirs ? "theirs" : server.text === c.ours ? "ours" : "other";
			ev.submissions = typeof g0 === "number" && typeof g1 === "number" ? g1 - g0 : null;
			ev.generation = { before: g0, after: g1 };
			ev.artifacts = arts.map((x) => ({ file: x.file.replace(/\d{4}-\d\d-\d\dT[\d-]+Z?/, "<ts>"), source: x.source,
				holds: x.content === c.ours ? "ours" : x.content === c.theirs ? "theirs" : "other" }));
			ev.daemonLines = [...new Set(conflictLines(rel))].slice(-6);
			// The CLI builds DiskMirror without a trace sink, so `conflict-artifact-created {reason}` is never logged; the
			// reason follows from the artifact source: crdt ← merge conflict ("three-way-overlap"), disk ← no-base
			// preservation ("closed-file-both-changed-no-common-base").
			ev.reasonInferred = arts.map((x) => (x.source === "crdt" ? "three-way-overlap" : x.source === "disk" ? "closed-file-both-changed-no-common-base" : "?"));
			ev.pass = c.expect === "clean" ? done && ev.serverText === "merged" && arts.length === 0 && ev.submissions === 1
				: c.expect === "skip" ? done && arts.length === 0 && ev.submissions === 0
				: c.base !== null ? done && arts.length === 1 && arts[0]!.source === "crdt" && arts[0]!.content === c.theirs && disk(rel) === c.ours && server.text === c.theirs && ev.submissions === 0
				: done && arts.length === 1 && arts[0]!.source === "disk" && arts[0]!.content === c.ours && disk(rel) === c.theirs && server.text === c.theirs;
			out.push(ev);
			ev.rel = rel;
			log(`R1 live ${id}: pass ${ev.pass} rows ${(ev.rows as Result).rowsWritten} submissions ${ev.submissions} artifacts ${arts.map((x) => x.source).join(",") || 0} server ${ev.serverText}`);
		}
		// Unresolved overlaps across restarts: does every daemon restart preserve the same overlap again?
		const before = Object.fromEntries(out.map((e) => [e.id as string, artifactsFor(e.rel as string).length]));
		await stop();
		await start();
		await sleep(settleMs + 2000);
		const after = Object.fromEntries(out.map((e) => [e.id as string, artifactsFor(e.rel as string).length]));
		restartCheck = { artifactsBefore: before, artifactsAfterOneMoreRestart: after,
			duplicatedOnRestart: Object.keys(after).filter((k) => after[k]! > before[k]!) };
	} finally {
		await stop().catch(() => undefined);
		writeFileSync(join(root, "daemon-stderr.log"), logs.join("\n---- restart ----\n"));
	}
	return { live: out, control, restartCheck, daemonLog: join(root, "daemon-stderr.log"), source: "real CLI daemon (packages/cli/src/index.ts daemon) — closed-file reconcile" };
}

// ================================================================================================= DL (D8)
async function simulateDailyLimit(ctx: RunCtx, enabled: boolean) {
	const url = vaultRoute(ctx.context.devices.A!, "debug/simulate-daily-limit");
	const go = () => fetch(url, { method: "POST", headers: { cookie: ctx.context.operatorCookie, "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
	let r = await go();
	if (r.status === 401) { await refreshOperatorCookie(ctx.context); r = await go(); }
	const text = await r.text();
	let value: unknown = text; try { value = JSON.parse(text); } catch { /* text */ }
	return { status: r.status, value, at: now() };
}

/** Bulk phase skip marker when the bulk create route is absent (b3-bulk owns bulk create). */
export const DL_BULK_SKIPPED = "bulk create not on this branch";

/**
 * DL verdict (pure; selftested). `result` is DL's result object before checks. A bulk phase with `skipped` makes the
 * bulk-only checks `null` (not applicable) — they never fail the run, and never pass it either.
 * destroyTimedOut is a failure: the destroy-while-tripped hang is fixed on this branch.
 */
export function dlChecks(result: Result) {
	const t = result.typing as Result, rcT = t.realClient as Result, b = (result.bulk ?? {}) as Result;
	const bulkSkipped = typeof b.skipped === "string";
	const probe = result.candidateProbeWhileLimited as Result | undefined;
	const typed503 = [...((rcT.http503Sample as Result[]) ?? []), ...((b.http503Probes as Result[]) ?? []), ...((b.realClient503 as Result[]) ?? []),
		...(probe ? [{ status: probe.status, retryAfter: probe.retryAfter, body: probe.value }] : [])];
	const anyTyped503 = typed503.some((p) => { const e = (p.body ?? p.error) as Result | undefined; return p.status !== undefined && p.status !== 503 ? false : e?.error === "cf_daily_limit" && typeof e.resetAt === "number" && p.retryAfter != null; });
	const socketSignal = (rcT.vaultErrors as number) > 0 || ((t.raw as Result).vaultErrors as number) > 0;
	const vaultErrorTyped = [...((rcT.vaultErrorSample as Result[]) ?? []), (t.raw as Result).firstVaultError as Result | null].some((v) => v?.code === "cf_daily_limit");
	const tripped = ((rcT.onDailyLimit as unknown[]) ?? []).length > 0 || (b.realClientDailyLimitState ?? null) !== null;
	const typingNoLoss = ((result.typingNoLoss as Result).convergence as { pass: boolean }).pass;
	const bulkNoLoss = bulkSkipped ? null : b.missingAfterRetry === 0;
	const noLoss = typingNoLoss && bulkNoLoss !== false;
	const closeOk = (c: unknown) => typeof c === "object" && c !== null && (c as Result).destroyTimedOut === false;
	const checks: Record<string, boolean | null> = {
		typed503WithRetryAfterAndResetAt: anyTyped503,
		createBulkTyped503: bulkSkipped ? null : ((b.http503Probes as Result[]) ?? []).some((p) => p.status === 503),
		candidateTyped503: probe?.status === 503 && (probe.value as Result | null)?.error === "cf_daily_limit",
		socketVaultError: socketSignal, vaultErrorTyped, realClientTripped: tripped,
		typingNoLossAfterDisable: typingNoLoss, bulkNoLossAfterDisable: bulkNoLoss,
		destroySettlesWhileTripped: closeOk(result.trippedClientClose), finalCloseSettles: closeOk(result.finalClientClose),
		noUnhandledRejections: ((result.unhandledRejections as Result | undefined)?.count ?? 0) === 0,
	};
	const applicable = Object.values(checks).filter((v): v is boolean => v !== null);
	return { checks, notApplicable: Object.keys(checks).filter((k) => checks[k] === null), assertionsPass: applicable.every(Boolean), noLoss };
}

/**
 * D8 daily limit (`POST debug/simulate-daily-limit {"enabled":…}`, operator, YAOS_TEST_ONLY_DEBUG_ROUTES):
 *  phase typing — a real VaultSync types into an open note (`--rate` 5/s for `--seconds` 8); the limit turns on after
 *    `--enable-after-ms` (2000) and stays on for `--limited-ms` (5000); a RawClient (`--adapter`) types alongside to
 *    see the raw socket signal; a closed-file HTTP candidate is probed while limited. Rows/setAlarms read before,
 *    during and after. The tripped client is closed with a bounded destroy (`--destroy-timeout-ms` 5000; a timeout
 *    FAILS the run) and restarted on the same store to prove no loss.
 *  phase bulk — when the server has `lifecycle/create-bulk`: bulk create of `--bulk-notes` (60) in `--bulk-batch`
 *    (10)-file batches with the limit turned on after the first batch, leftovers retried after. Without the route the
 *    bulk create is skipped (`bulk.skipped`); the real-client create (commitFreshBody) while limited still runs.
 * Asserts typed 503 + Retry-After + resetAt, VAULT_ERROR{code:cf_daily_limit}, the real client's getDailyLimitState()
 * trip, no loss once the limit is off, bounded destroy, and no unhandled rejections.
 */
export async function DL(ctx: RunCtx): Promise<Result> {
	const rows = rowsCounter(ctx);
	const rate = ctx.num("rate", 5), seconds = ctx.num("seconds", 8), enableAfter = ctx.num("enable-after-ms", 2000), limitedMs = ctx.num("limited-ms", 5000);
	const destroyTimeoutMs = ctx.num("destroy-timeout-ms", 5000);
	// The spike saw a destroy() abandoned while tripped leave a half-stopped runtime whose sockets still delivered
	// control frames (queueBodyWake rejected "vault work scheduler is stopped", uncaught). Fixed on this branch; still
	// captured so a regression is reported (noUnhandledRejections) instead of killing Node.
	const unhandled: string[] = [];
	const onUnhandled = (reason: unknown) => { unhandled.push(String((reason as Error)?.message ?? reason).slice(0, 200)); };
	process.on("unhandledRejection", onUnhandled);
	const reset = await simulateDailyLimit(ctx, false); // a killed earlier run may have left the latch on
	log(`DL: initial disable ${reset.status}`);
	if (reset.status === 404) {
		process.off("unhandledRejection", onUnhandled);
		throw new Error("DL: debug/simulate-daily-limit → 404 (deploy with YAOS_TEST_ONLY_DEBUG_ROUTES=true)");
	}
	const body = await freshSmallNote(ctx);
	log(`DL: note ${body}`);
	const path = `R2/${ctx.tag}/note-0.md`;
	let rc = await openRC(ctx, "dl");
	const result: Result = { bodyId: body };
	const reads: Result[] = [];
	const snap = async (label: string) => { const r = await rows.read(); reads.push({ label, at: r2(now()), rowsWritten: r.rowsWritten, rowsRead: r.rowsRead, setAlarms: alarms(r), source: r.source }); return r; };
	try {
		// ---------------------------------------------------------------- phase typing
		log("DL: phase typing");
		const text = await rc.openEditor(path);
		const rawAdapter = ctx.adapter;
		const raw = await openOrThrow(new RawClient(await ctx.dev("A"), body, undefined, rawAdapter), 60_000);
		raw.reconnect = false;
		const peer = await openOrThrow(await ctx.client("B", body), 60_000);
		await sleep(2000);
		const r0 = await snap("before");
		const t0 = now();
		let enabledAt = 0, disabledAt = 0;
		const typed: number[] = [];
		const wsOpensBefore = rc.sockets.filter((s) => s.kind === "open").length;
		const timers: Array<Promise<unknown>> = [];
		timers.push((async () => { await sleep(enableAfter); const e = await simulateDailyLimit(ctx, true); enabledAt = e.at; result.enable = { status: e.status, value: e.value }; log(`DL: limit on ${e.status}`); })());
		const keys = Math.round(seconds * rate);
		for (let k = 0; k < keys; k++) {
			const wait = t0 + k * (1000 / rate) - now();
			if (wait > 1) await sleep(wait);
			typed.push(rc.type(text, String.fromCharCode(97 + (k % 26))));
			if (k % 3 === 0) raw.edit((t) => t.insert(t.length, `r${k} `));
		}
		log("DL: typing done");
		await Promise.all(timers);
		const left = enabledAt + limitedMs - now();
		const limitedRead = await snap("limited+early");
		if (left > 0) await sleep(left);
		const limitedRead2 = await snap("limited+late");
		// HTTP probe while limited: a closed-file candidate (VaultServerPort.submitCandidate shape) on the same body.
		{
			const A = await ctx.dev("A");
			const { doc: pd, epoch } = await bodyDocWithEpoch(A, body);
			let u: Uint8Array | null = null; pd.on("update", (x: Uint8Array) => { u = x; });
			pd.getText("body").insert(0, "[limited-probe]");
			result.candidateProbeWhileLimited = await postCandidate(A, body, epoch, u!, randomUUID());
			pd.destroy();
		}
		const tripState = rc.vs.getDailyLimitState();
		const d = await simulateDailyLimit(ctx, false); disabledAt = d.at;
		log(`DL: limit off ${d.status}`);
		result.disable = { status: d.status, value: d.value };
		await sleep(3000);
		const rAfter = await snap("after-disable+3s");
		await sleep(5000);
		const rAfter2 = await snap("after-disable+8s");
		const limitedWindowS = (disabledAt - enabledAt) / 1000;
		const http503 = rc.http.filter((h) => h.status === 503);
		const vaultErrors = rc.wsIn.filter((m) => m.type === "VAULT_ERROR");
		const rawErrors = raw.rejects.filter((x) => x.value.type === "VAULT_ERROR");
		const opensAfterTrip = rc.dailyLimits.length ? rc.sockets.filter((s) => s.kind === "open" && s.at > rc.dailyLimits[0]!.at).length : null;
		const candPostsAfterTrip = rc.dailyLimits.length ? rc.http.filter((h) => /candidates?$/.test(h.path) && h.at > rc.dailyLimits[0]!.at).length : null;
		result.typing = {
			keys, raw: { adapter: rawAdapter.name, frames: raw.nonEmptyFramesSent, vaultErrors: rawErrors.length, firstVaultError: rawErrors[0]?.value ?? null, closes: raw.closeLog.slice(0, 3) },
			limitedWindowMs: r2(disabledAt - enabledAt),
			realClient: {
				http503: http503.length, http503Sample: http503.slice(0, 2).map((h) => ({ path: h.path, retryAfter: h.retryAfter ?? null, error: h.error })),
				vaultErrors: vaultErrors.length, vaultErrorSample: vaultErrors.slice(0, 2).map((m) => m.value),
				onDailyLimit: rc.dailyLimits.map((x) => ({ atMsAfterEnable: r2(x.at - enabledAt), info: x.info })),
				getDailyLimitStateBeforeDisable: tripState, getDailyLimitStateAfterDisable: rc.vs.getDailyLimitState(),
				socketOpensBeforeLimit: wsOpensBefore, socketOpensAfterTrip: opensAfterTrip, candidatePostsAfterTrip: candPostsAfterTrip,
				socketCloses: rc.sockets.filter((s) => s.kind === "close" && s.at > enabledAt).map((s) => ({ atMsAfterEnable: r2(s.at - enabledAt), code: s.code, body: s.bodyId === body })),
				pendingCandidatesAtDisable: rc.pendingCandidates(body),
				relayDiagnostics: rc.relayDiagnostics(),
			},
			rows: { beforeToLimitedEarly: rowsDelta(r0, limitedRead), limitedEarlyToLate: rowsDelta(limitedRead, limitedRead2), afterDisable8s: rowsDelta(limitedRead2, rAfter2) },
			setAlarms: { before: alarms(r0), limitedEarly: alarms(limitedRead), limitedLate: alarms(limitedRead2), after3s: alarms(rAfter), after8s: alarms(rAfter2),
				duringLimitPerSecond: alarms(limitedRead2) !== null && alarms(r0) !== null ? r2((alarms(limitedRead2)! - alarms(r0)!) / Math.max(0.001, limitedWindowS)) : null },
		};
		// No-loss: restart the tripped client on the same store (bounded destroy first; a timeout is a failure).
		const localText = text.toString();
		const rawText = raw.text();
		raw.terminate();
		const tripped = rc;
		log("DL: closing tripped client");
		result.trippedClientClose = await tripped.close({ timeoutMs: destroyTimeoutMs });
		if ((result.trippedClientClose as Result).destroyTimedOut) log(`DL: FAIL VaultSync.destroy() did not settle within ${destroyTimeoutMs} ms after a daily-limit trip — abandoned`);
		log("DL: reopening on same store");
		rc = await openRC(ctx, "dl2", { reuse: { dir: tripped.dir, folderKey: tripped.folderKey } });
		const text2 = await rc.openEditor(path);
		// The raw typist resyncs on a new socket with the same doc (its step2 carries anything the server dropped).
		const rawAgain = await openOrThrow(new RawClient(await ctx.dev("A"), body, raw.doc, rawAdapter), 60_000).catch(() => null);
		await sleep(1000);
		log("DL: restarted client, waiting for convergence");
		const conv = await realConvergence(ctx, rc, text2, body, rawAgain ? [peer, rawAgain] : [peer], 30_000);
		const final = text2.toString();
		const strip = (x: string) => x.replace(/r\d+ /g, "").replace("[limited-probe]", "");
		result.typingNoLoss = { restartedClientHasLocalText: strip(final).includes(strip(localText)), localTextBeforeRestart: localText.length,
			rawEditsOnServer: rawText.split(" ").filter((t) => /^r\d+$/.test(t)).every((t) => final.includes(t)), typedChars: typed.length, convergence: conv };
		await peer.close();
		if (rawAgain) await rawAgain.close();
		// ---------------------------------------------------------------- phase bulk
		log("DL: phase bulk");
		const bulkProbe = await bulkCreateAvailable(await ctx.dev("A"));
		const n = ctx.num("bulk-notes", 60), batch = ctx.num("bulk-batch", 10);
		const items = Array.from({ length: n }, (_v, i) => ({ kind: "note" as const, path: `WB/${ctx.tag}/dl-bulk-${String(i).padStart(3, "0")}.md`, bodyId: `${ctx.tag}-dlb-${i}`, content: `# dl ${i}\n${"x".repeat(200)}\n` }));
		const bulk: Result = { notes: n, batch, routeProbeStatus: bulkProbe.status };
		const b0 = await snap("bulk-before");
		let bulkFirst: Awaited<ReturnType<typeof bulkCreate>> | null = null;
		const probes: Result[] = [];
		if (!bulkProbe.available) {
			// SKIPPED (b3-bulk owns bulk create): no lifecycle/create-bulk on this server. Enable the limit directly so the
			// real-client create below still runs while limited.
			bulk.skipped = DL_BULK_SKIPPED;
			log(`DL: bulk create skipped (${DL_BULK_SKIPPED}; route probe ${bulkProbe.status})`);
			await simulateDailyLimit(ctx, true);
		} else {
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const res = await realFetch(input, init);
				if (String(input).includes("create-bulk") && res.status >= 400 && probes.length < 5) {
					const clone = res.clone();
					probes.push({ status: res.status, retryAfter: res.headers.get("retry-after"), body: await clone.json().catch(() => null) });
				}
				return res;
			}) as typeof fetch;
			let enabledMid = false;
			try {
				bulkFirst = await bulkCreate(ctx.context, items, { device: "A", maxFiles: batch, maxBytes: 4 * 1024 * 1024,
					afterBatch: async () => { if (!enabledMid) { enabledMid = true; await simulateDailyLimit(ctx, true); } } });
			} finally { globalThis.fetch = realFetch; }
		}
		const bLimited = await snap("bulk-limited");
		// A real client's create while limited (production commitFreshBody path → 503 → tripDailyLimit). Bounded.
		const rcCreateTimeoutMs = ctx.num("create-timeout-ms", 15_000);
		const rcCreate = await Promise.race([
			settled(rc.vs.commitFreshBody({ bodyId: `${ctx.tag}-dl-rc`, path: `WB/${ctx.tag}/dl-rc.md`, content: "# while limited\n", reason: "wb-dl", candidateId: randomUUID() })),
			sleep(rcCreateTimeoutMs).then(() => ({ ok: false as const, error: `timeout after ${rcCreateTimeoutMs} ms (held)`, at: now() })),
		]);
		await simulateDailyLimit(ctx, false);
		if (bulkFirst) {
			const okPaths = new Set(bulkFirst.outcomes.filter((o) => o.outcome === "created").map((o) => o.path));
			const leftover = items.filter((i) => !okPaths.has(i.path));
			const retry = leftover.length ? await bulkCreate(ctx.context, leftover, { device: "A", maxFiles: batch }) : null;
			await sleep(3000);
			const heads = await listHeads(await ctx.dev("C"));
			const have = new Map(heads.entries.map((e) => [e.path, e.contentHash]));
			Object.assign(bulk, {
				firstPass: { outcomes: countBy(bulkFirst.outcomes), batchStatuses: bulkFirst.batches.map((x) => x.httpStatus),
					errors: [...new Set(bulkFirst.batches.map((x) => x.error).filter(Boolean))] },
				http503Probes: probes, retried: leftover.length, retryOutcomes: retry ? countBy(retry.outcomes) : null,
				missingAfterRetry: items.filter((i) => have.get(i.path) !== contentHashOf(i.content).contentHash).length,
			});
		} else await sleep(3000);
		const bAfter = await snap("bulk-after");
		Object.assign(bulk, {
			realClientCreateWhileLimited: rcCreate.ok ? "created (limit not enforced?)" : rcCreate.error,
			realClientDailyLimitState: rc.vs.getDailyLimitState(),
			realClient503: rc.http.filter((h) => h.status === 503).slice(0, 2).map((h) => ({ path: h.path, retryAfter: h.retryAfter ?? null, error: h.error })),
			rows: { firstPass: rowsDelta(b0, bLimited), afterDisable: rowsDelta(bLimited, bAfter) },
			setAlarms: { before: alarms(b0), limited: alarms(bLimited), after: alarms(bAfter) },
		});
		result.bulk = bulk;
	} finally {
		await simulateDailyLimit(ctx, false).catch(() => undefined);
		result.finalClientClose = await rc.close({ timeoutMs: destroyTimeoutMs }).catch((e) => String(e));
		await sleep(500);
		process.off("unhandledRejection", onUnhandled);
		result.unhandledRejections = { count: unhandled.length, distinct: [...new Set(unhandled)] };
	}
	const verdict = dlChecks(result);
	// convergence = data (no loss, peers agree); the product assertions are in `checks` / `assertionsPass`.
	return { ...result, rowReads: reads, rowsSource: rows.source, checks: verdict.checks, checksNotApplicable: verdict.notApplicable,
		assertionsPass: verdict.assertionsPass, convergence: { pass: verdict.noLoss } };
}
