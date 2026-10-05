/**
 * L5 baseline (D8 option 1 in spirit): time from "edit applied" to "candidate cleared from the client DB"
 * through the REAL production candidate path, with the real 250 ms / 2 s candidate debounce.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/l5-cli-baseline.ts --host <url> \
 *        [--n 100] [--mode prod|nodebounce|relay|relay250|both|all|a,b] [--burst 1] [--burst-interval 80] [--spacing 1500]
 *        [--offline-probe] [--typing-probe] [--persist before-send|after-send] [--out file.json]
 *
 * relay / relay250 (flag-on worker only): the §5.3 harness receipt client (lib/socketReceipts.ts, RECEIPTS.md)
 * settles candidates from the socket BODY_COMMITTED echo; VaultSync's own HTTP candidate debounce is parked at
 * 10 min (fallback only). relay250 adds a 250 ms / 2 s harness-side debounce (merged frames) to separate
 * "relay is faster" from "relay has no debounce". Every sample records per-burst wire counts (WS frames/bytes,
 * HTTP requests/bytes, DO request units).
 *
 * What is real (nothing reimplemented, src/sync/vaultSync.ts untouched):
 *   - `VaultSync.create` (src/sync/vaultSync.ts) with its DEFAULT providerFactory: OwnAwarenessProvider
 *     (y-partyserver) over `fencedWebSocketConstructor(ws)`, real `createSocketTicketCache` tickets,
 *     real `BootstrapHttpPort` + `prepareBootstrapRoot`, real `createFetchRequester` HTTP.
 *   - The client DB is the headless CLI's durable SQLite store (`packages/cli/src/nodeVaultDatabase.ts`,
 *     WAL + synchronous=FULL), the Node analogue of the plugin's IndexedDB. A Proxy only timestamps
 *     putCandidate / confirmPendingCandidate / deleteCandidate around the real calls.
 *   - Browser globals come from the CLI's own shim (`packages/cli/src/globals.ts`), loaded before the
 *     provider graph via a dynamic-import boundary exactly like `packages/cli/src/index.ts`.
 *   - The note is opened like an Obsidian editor would: `acquireEditorBody` + `completeEditorBodyBinding`,
 *     then local Y.Text inserts (origin null = local), which drive the real body-socket update, the
 *     real debounced `captureCandidate` (candidateDigestMaterial + sha256Hex) and the real HTTP
 *     `submitCandidate` → receipt → `confirmPendingCandidate`.
 *
 * Modes: `prod` uses the production debounce (DEFAULT_CANDIDATE_DEBOUNCE_MS=250 / MAX_WAIT=2000, not passed
 * explicitly); `nodebounce` passes candidateDebounceMs=0 / candidateMaxWaitMs=0 (the options VaultSync already
 * exposes) so the RFC can separate "relay is faster" from "relay has no debounce". Each sample also reports
 * captureToClearedMs (candidate persisted → cleared), i.e. the post-debounce part.
 *
 * Differences from the CLI daemon, stated plainly: the CLI daemon never holds editor sessions (it edits closed
 * files via disk → reconciliation), so an open-editor edit burst is driven here directly on the runtime rather
 * than via `yaos` + a file write. The candidate/receipt path after the edit is identical.
 *
 * Provider-in-Node proof: the run records the real provider's socket traffic via an instrumenting `ws`
 * subclass passed as `VaultSyncOptions.webSocket` (see ENVELOPE HOOK below) — root + body sockets open,
 * VAULT_READY arrives, sync frames flow — against a flag-off worker.
 */
import "../../packages/cli/src/globals";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { LOG_DIR, flagNum, flagStr, log, now, parseArgs, r2, series, sleep, startMeta, workerName } from "./lib/common";
import { addDevice, loadContext, seedNotes, smallContent } from "./lib/context";
import { contentHashOf } from "./lib/rawClient";
import { type FrameRecord, type ReceiptOptions, type ReceiptStore, newReceiptStats, pairingSummary, receiptWebSocket } from "./lib/socketReceipts";

const RELAY_PARKED_DEBOUNCE_MS = 600_000;
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

type Obj = Record<string, unknown>;

interface CandidateEvent { at: number; op: "put" | "confirm" | "delete"; candidateId: string; bodyId: string; ms: number }

/**
 * ENVELOPE HOOK: every frame the real provider sends goes YSyncProvider → FencedWebSocket.send(data) →
 * Base.send(data), where Base = VaultSyncOptions.webSocket. `lib/socketReceipts.ts` is that Base: passive
 * (counting only) in the base modes, and the §5.3 harness receipt client in the relay modes (see RECEIPTS.md).
 */
// native (relay v3): the REAL VaultSync relay receipt channel (src/sync/relayReceipts.ts, client 7d70ea9;
// candidates settle from socket receipts, HTTP only as a 15 s fallback), passive wrapper. (native250 = B5 send-coalescing was measured and removed.)
// relay / relay250 disable the native channel (relayReceipts:false) so frames are not enveloped twice.
type Mode = "prod" | "nodebounce" | "relay" | "relay250" | "native";
const MODES: Mode[] = ["prod", "nodebounce", "relay", "relay250", "native"];
const DEVICE: Record<Mode, string> = { prod: "L5p", nodebounce: "L5n", relay: "L5r", relay250: "L5d", native: "L5v" };

async function runMode(host: string, mode: Mode, opts: { n: number; offlineProbe: boolean; typingProbe: boolean; persist: "before-send" | "after-send"; burst: number; burstInterval: number; spacing: number; tag: string }) {
	const { VaultSync } = await import("../../legacy-src/sync/vaultSync");
	const { createSocketTicketCache } = await import("../../legacy-src/sync/socketTicket");
	const { createFetchRequester } = await import("../../legacy-src/utils/http");
	const { BootstrapHttpPort, prepareBootstrapRoot } = await import("../../legacy-src/sync/bootstrapClient");
	const { NodeVaultDatabase } = await import("../../packages/cli/src/nodeVaultDatabase");

	const context = loadContext(host);
	const identity = await addDevice(context, DEVICE[mode]);
	const relayMode = mode === "relay" || mode === "relay250";
	const bodyId = `${opts.tag}-l5-${mode}`;
	const path = `R2/${opts.tag}/l5-${mode}.md`;
	await seedNotes(context, [{ bodyId, path, content: smallContent(7) }]);

	const dir = join(LOG_DIR, "l5", `${workerName(host)}-${opts.tag}-${mode}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const folderKey = randomBytes(16).toString("hex");
	const real = new NodeVaultDatabase(join(dir, "client.sqlite"), {
		host, realVaultPath: dir, vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration,
		deviceId: identity.deviceId, folderKey });
	const events: CandidateEvent[] = [];
	const traced = new Set(["putCandidate", "confirmPendingCandidate", "deleteCandidate"]);
	const database = new Proxy(real, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver) as unknown;
			if (typeof value !== "function") return value;
			if (!traced.has(String(prop))) return (value as (...a: unknown[]) => unknown).bind(target);
			return async (...args: unknown[]) => {
				const t0 = now();
				const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
				const t1 = now();
				const op = prop === "putCandidate" ? "put" : prop === "confirmPendingCandidate" ? "confirm" : "delete";
				const rec = op === "delete" ? { bodyId: String(args[0]), candidateId: String(args[1]) }
					: { bodyId: String((args[0] as Obj).bodyId), candidateId: String((args[0] as Obj).candidateId) };
				events.push({ at: t1, op, ...rec, ms: r2(t1 - t0) });
				return result;
			};
		},
	});

	const httpLog: Obj[] = [];
	const fetchRequester = createFetchRequester(globalThis.fetch.bind(globalThis));
	const requester: typeof fetchRequester = async (request) => {
		const t0 = now();
		if (process.env.L5_TRACE && /candidate/.test(request.url) && logs.length < 1990) logs.push(`TRACE ${new Error().stack}`);
		const response = await fetchRequester(request);
		const reqBody = (request as { body?: unknown }).body;
		const reqBytes = typeof reqBody === "string" ? Buffer.byteLength(reqBody)
			: reqBody instanceof ArrayBuffer ? reqBody.byteLength : ArrayBuffer.isView(reqBody) ? reqBody.byteLength : 0;
		httpLog.push({ at: r2(t0), method: request.method ?? "GET", reqBytes,
			resBytes: Number(response.headers?.get?.("content-length") ?? 0) || 0,
			path: new URL(request.url).pathname.replace(/\/vault\/[^/]+/, "/vault/<id>").replace(/\/ws\/.*$/, "/ws/…"),
			status: response.status, ms: r2(now() - t0) });
		return response;
	};
	const wsStats = newReceiptStats();
	const frames: FrameRecord[] = [];
	const registry = new Set<import("ws").WebSocket & { bodyId: string | null }>();
	const sendLog: NonNullable<ReceiptOptions["sendLog"]> = [];
	const bodies = new Map<string, { doc: import("yjs").Doc; bodyEpoch: number }>();
	const receiptOptions: ReceiptOptions = { vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration,
		deviceId: identity.deviceId, database: database as unknown as ReceiptStore, bodies, passive: !relayMode,
		debounceMs: mode === "relay250" ? 250 : 0, maxWaitMs: 2000, registry, persist: opts.persist, sendLog };
	const ReceiptWs = receiptWebSocket(receiptOptions, wsStats, frames);
	const logs: string[] = [];
	const t0 = now();
	await prepareBootstrapRoot(new BootstrapHttpPort(host, identity.vaultId, identity.deviceToken, real, requester), real);
	const bootstrapMs = r2(now() - t0);
	const tickets = createSocketTicketCache(requester);
	const vaultSync = await VaultSync.create({
		vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration, deviceId: identity.deviceId,
		host, token: identity.deviceToken, database, request: requester,
		webSocket: ReceiptWs as unknown as typeof globalThis.WebSocket,
		getSocketTicket: async (scope, force = false) => {
			if (force) tickets.invalidate();
			return tickets.get(host, identity.deviceToken, identity.vaultId, scope);
		},
		log: (m) => { if (logs.length < 2000) logs.push(`${r2(now())} ${m}`); },
		...(mode === "nodebounce" ? { candidateDebounceMs: 0, candidateMaxWaitMs: 0 } : {}),
		// Relay modes: VaultSync's own HTTP candidate path is parked (10 min debounce) and stays the fallback.
		...(relayMode ? { candidateDebounceMs: RELAY_PARKED_DEBOUNCE_MS, candidateMaxWaitMs: RELAY_PARKED_DEBOUNCE_MS, relayReceipts: false } : {}),
	});
	vaultSync.setResidencyRuntimeContext("desktop", "foreground");
	const createMs = r2(now() - t0);
	const deadline = now() + 30_000;
	while (!vaultSync.getFileId(path) && now() < deadline) await sleep(100);
	if (!vaultSync.getFileId(path)) throw new Error(`root never showed ${path}`);
	const consumer = `l5-${mode}`;
	const a0 = now();
	await vaultSync.acquireEditorBody(path, consumer);
	vaultSync.completeEditorBodyBinding(consumer);
	const acquireMs = r2(now() - a0);
	const text = vaultSync.getTextForPath(path);
	if (!text) throw new Error("no Y.Text for editor body");
	const realBodyId = vaultSync.getFileId(path)!;
	if (relayMode) bodies.set(realBodyId, { doc: text.doc!, bodyEpoch: await vaultSync.currentBodyEpoch(realBodyId) });
	await sleep(1500);
	const counters = () => ({ wsOut: sum(wsStats.framesOut) + sum(wsStats.envelopesSent), wsBytesOut: wsStats.bytesOut, wsIn: sum(wsStats.framesIn),
		wsBytesIn: wsStats.bytesIn, http: httpLog.length,
		httpBytes: httpLog.reduce((a, h) => a + Number(h.reqBytes ?? 0) + Number(h.resBytes ?? 0), 0) });

	const samples: Obj[] = [];
	for (let i = 0; i < opts.n; i++) {
		const startIdx = events.length;
		const c0 = counters();
		const editAt: number[] = [];
		for (let k = 0; k < opts.burst; k++) {
			text.doc!.transact(() => text.insert(Math.floor(text.length / 2), `[l5 ${i}.${k}]`));
			editAt.push(now());
			if (k < opts.burst - 1) await sleep(opts.burstInterval);
		}
		const first = editAt[0]!;
		const last = editAt.at(-1)!;
		// Settled = every candidate captured after the burst started has been cleared from the DB.
		let settledAt: number | null = null;
		const until = now() + 20_000;
		while (now() < until) {
			const mine = events.slice(startIdx);
			const puts = mine.filter((e) => e.op === "put");
			const cleared = new Set(mine.filter((e) => e.op !== "put").map((e) => e.candidateId));
			// The last edit's own candidate must exist (latest put at/after the last edit), else a no-debounce burst
			// could "settle" on the previous edit's receipt before the last frame was captured.
			if (puts.length > 0 && Math.max(...puts.map((p) => p.at)) >= last && puts.every((p) => cleared.has(p.candidateId))) {
				settledAt = Math.max(...mine.filter((e) => e.op !== "put").map((e) => e.at));
				break;
			}
			await sleep(5);
		}
		const mine = events.slice(startIdx);
		const firstPut = mine.find((e) => e.op === "put");
		const c1 = counters();
		const d = Object.fromEntries(Object.entries(c1).map(([k, v]) => [k, v - (c0 as Record<string, number>)[k]!])) as typeof c1;
		samples.push({ i, burst: opts.burst, firstEditAt: r2(first),
			wire: { ...d, doRequestUnits: r2(d.http + d.wsOut / 20) },
			httpDuring: httpLog.slice(c0.http).map((h) => `${h.method} ${String(h.path).replace(/^.*\/body\/[^/]+/, "body")} +${r2(Number(h.at) - first)}`),
			editToClearedMs: settledAt === null ? null : r2(settledAt - first),
			lastEditToClearedMs: settledAt === null ? null : r2(settledAt - last),
			editToCaptureMs: firstPut ? r2(firstPut.at - first) : null,
			captureToClearedMs: settledAt !== null && firstPut ? r2(settledAt - firstPut.at) : null,
			candidates: mine.filter((e) => e.op === "put").length,
			putMs: firstPut?.ms ?? null, clearMs: mine.find((e) => e.op !== "put")?.ms ?? null });
		if (i % 10 === 0) log(`L5 ${mode} ${i}/${opts.n} editToCleared=${samples.at(-1)!.editToClearedMs}`);
		await sleep(opts.spacing);
	}
	// Offline probe (relay modes): kill the body socket, edit while disconnected (the provider does not queue
	// those frames), let VaultSync reconnect. The offline edits then travel in the provider's step2 reply to the
	// server's step1; the wrapper envelopes that non-empty step2 and it must pair + settle like an update.
	const { diagnostics } = await import("./lib/checks");
	const relayCounters = async () => ((await diagnostics(context.devices.A!)).relay as { counters?: Record<string, number> } | undefined)?.counters ?? {};
	const probe = async (envelopeStep2: boolean) => {
		receiptOptions.envelopeStep2 = envelopeStep2;
		const before = await relayCounters();
		const framesBefore = frames.length;
		const lessBefore = wsStats.envelopeLessBinary.step2 ?? 0;
		const sock = [...registry].find((w) => w.bodyId === realBodyId);
		const p0 = now();
		sock?.terminate();
		await sleep(50);
		for (let k = 0; k < 3; k++) text.doc!.transact(() => text.insert(0, `[offline ${envelopeStep2 ? "e" : "n"}${k}]`));
		const editedAt = now();
		const until = now() + 20_000;
		let settledAt: number | null = null;
		while (now() < until) {
			const mine = frames.slice(framesBefore);
			if (envelopeStep2 ? mine.length > 0 && mine.every((f) => f.outcome !== "pending")
				: (wsStats.envelopeLessBinary.step2 ?? 0) > lessBefore) { settledAt = now(); break; }
			await sleep(20);
		}
		await sleep(1500);
		const after = await relayCounters();
		const delta = Object.fromEntries(Object.keys(after).filter((k) => typeof after[k] === "number" && after[k] !== (before[k] ?? 0))
			.map((k) => [k, after[k]! - (before[k] ?? 0)]));
		receiptOptions.envelopeStep2 = true;
		const mine = frames.slice(framesBefore);
		return { envelopeStep2, terminated: Boolean(sock), editsWhileOffline: 3,
			envelopedFrames: mine.map((f) => ({ kind: f.kind, outcome: f.outcome, echo: f.echo, bytes: f.bytes })),
			envelopeLessStep2Sent: (wsStats.envelopeLessBinary.step2 ?? 0) - lessBefore,
			serverRelayCounterDelta: delta,
			editToSettledMs: settledAt === null ? null : r2(settledAt - editedAt),
			editToSettledMeaning: envelopeStep2 ? "edit → enveloped step2 receipt settled" : "edit → envelope-less step2 sent (no receipt possible)",
			killToSettledMs: settledAt === null ? null : r2(settledAt - p0),
			note: envelopeStep2 ? "offline edits ride the provider's step2 reply; enveloped + candidate → echo settles it"
				: "step2 sent envelope-less (provider-internal behaviour without a wrapper): server appends it (hashUnknown), no echo, no receipt; HTTP candidate would be the fallback" };
	};
	// Typing probe: does the real provider coalesce keystrokes? One Y transaction per keystroke, exactly what
	// y-codemirror.next's ySync does per CodeMirror ViewUpdate (y-sync.js: one ytext.doc.transact per update).
	// Counts the binary update frames the provider hands to the socket (sendLog, before any harness debounce).
	const typingProbe = opts.typingProbe ? await (async () => {
		const out: Obj[] = [];
		for (const cps of [2, 8, 30]) {
			await sleep(1500);
			const from = sendLog.length;
			const keys = cps * 5;
			const t0 = now();
			for (let k = 0; k < keys; k++) {
				text.doc!.transact(() => text.insert(Math.floor(text.length / 2), "abcdefghij"[k % 10]!));
				await sleep(1000 / cps);
			}
			const typedMs = now() - t0;
			await sleep(mode === "relay250" ? 2500 : 500);
			const mine = sendLog.slice(from).filter((f) => f.bodyId === realBodyId && f.kind === "update");
			out.push({ charsPerSec: cps, keystrokes: keys, typedMs: r2(typedMs), providerUpdateFrames: mine.length,
				framesPerKeystroke: r2(mine.length / keys), framesPerSec: r2(mine.length / (typedMs / 1000)),
				meanFrameBytes: mine.length ? r2(mine.reduce((a, f) => a + f.bytes, 0) / mine.length) : null });
		}
		return { note: "provider = y-partyserver OwnAwarenessProvider via real VaultSync; Y.Text driven one transaction per keystroke like y-codemirror.next", rates: out };
	})() : null;
	const offlineProbe = relayMode && opts.offlineProbe ? { enveloped: await probe(true), envelopeLess: await probe(false) } : null;
	const finalText = text.toString();
	const destroyAt = now();
	const receipt = vaultSync.getServerReceiptSnapshot();
	vaultSync.releaseEditorBody(path, consumer);
	await vaultSync.destroy();
	await real.close();
	// Server check: final markdown equals the server's committed body and recorded head hash.
	const { bodyGet, bodyHead } = await import("./lib/checks");
	await sleep(1000);
	const get = await bodyGet(context.devices.A!, bodyId);
	const head = await bodyHead(context.devices.A!, bodyId);
	const expect = contentHashOf(finalText);
	const col = (k: string) => samples.map((s) => s[k] as number | null);
	const submitPosts = httpLog.filter((h) => String(h.method) === "POST" && /candidate/.test(String(h.path)));
	const wire = (k: string) => series(samples.map((s) => (s.wire as Record<string, number>)[k]!), 0);
	const leftover = await (async () => {
		try {
			const again = new NodeVaultDatabase(join(dir, "client.sqlite"), {
				host, realVaultPath: dir, vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration,
				deviceId: identity.deviceId, folderKey });
			const rows = await again.listCandidates();
			await again.close();
			const harnessIds = new Set(frames.map((f) => f.candidateId));
			return { total: rows.length, harness: rows.filter((r) => harnessIds.has(r.candidateId)).length,
				vaultSyncOwn: rows.filter((r) => !harnessIds.has(r.candidateId)).length };
		} catch (e) { return `error: ${String(e)}`; }
	})();
	return {
		mode, bodyId, deviceName: DEVICE[mode],
		debounce: mode === "prod" ? { candidateDebounceMs: "production default (250)", candidateMaxWaitMs: "production default (2000)" }
			: mode === "nodebounce" ? { candidateDebounceMs: 0, candidateMaxWaitMs: 0 }
			: mode === "native" ? { receiptPath: "socket (native VaultSync RelayReceiptChannel)",
				vaultSyncHttpPath: "production debounce; relay-covered candidates confirmed by synthesized receipt, HTTP fallback 15 s" }
			: { receiptPath: "socket (harness receipt client)", harnessDebounceMs: mode === "relay250" ? 250 : 0, harnessMaxWaitMs: 2000,
				vaultSyncHttpPath: `parked (candidateDebounceMs=${RELAY_PARKED_DEBOUNCE_MS}); fallback via restoreCandidates` },
		wirePerSample: { wsFramesOut: wire("wsOut"), wsBytesOut: wire("wsBytesOut"), wsFramesIn: wire("wsIn"), wsBytesIn: wire("wsBytesIn"),
			httpRequests: wire("http"), httpBytes: wire("httpBytes"), doRequestUnits: wire("doRequestUnits"),
			note: "per burst; DO units = HTTP requests + client→DO WebSocket messages / 20 (20:1 billing); HTTP bytes = request body + response content-length" },
		pairing: relayMode ? pairingSummary(wsStats, frames) : null,
		offlineProbe,
		typingProbe,
		leftoverCandidatesInStore: leftover,
		setup: { bootstrapMs, createMs, acquireMs },
		editToClearedMs: series(col("editToClearedMs")),
		lastEditToClearedMs: series(col("lastEditToClearedMs")),
		editToCaptureMs: series(col("editToCaptureMs")),
		captureToClearedMs: series(col("captureToClearedMs")),
		candidateSubmitHttpMs: series(submitPosts.map((h) => h.ms as number)),
		candidatePostsMsAfterPrecedingEdit: submitPosts.map((h) => {
			const prior = samples.map((x) => Number(x.firstEditAt)).filter((t) => t <= Number(h.at)).at(-1);
			return prior === undefined ? null : r2(Number(h.at) - prior); }),
		candidatePostsAfterDestroyStart: submitPosts.filter((h) => Number(h.at) >= destroyAt).length,
		candidateSubmitRoutes: [...new Set(submitPosts.map((h) => `${h.method} ${h.path}`))],
		samples,
		convergence: { pass: get.text === finalText && head.value?.contentHash === expect.contentHash,
			getTextEqual: get.text === finalText, headHashEqual: head.value?.contentHash === expect.contentHash,
			headGeneration: head.value?.generation ?? null },
		providerProof: { framesOut: wsStats.framesOut, framesIn: wsStats.framesIn, sockets: wsStats.sockets,
			bodySockets: wsStats.bodySockets, closes: wsStats.closes, receiptSnapshot: receipt },
		httpSummary: Object.entries(httpLog.reduce<Record<string, number>>((acc, h) => {
			const k = `${h.method} ${h.path} ${h.status}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {})),
		runtimeLogTail: logs.slice(-40),
	};
}

async function main() {
	const args = parseArgs();
	const host = flagStr(args, "host")?.replace(/\/+$/, "");
	if (!host) { console.error("usage: l5-cli-baseline.ts --host <url> [--n 100] [--mode prod|nodebounce|both]"); process.exit(2); }
	const modeArg = flagStr(args, "mode", "both")!;
	const opts = { n: flagNum(args, "n", 100), offlineProbe: args.flags["offline-probe"] === true, typingProbe: args.flags["typing-probe"] === true,
		persist: (flagStr(args, "persist", "before-send") === "after-send" ? "after-send" : "before-send") as "before-send" | "after-send", burst: flagNum(args, "burst", 1), burstInterval: flagNum(args, "burst-interval", 80),
		spacing: flagNum(args, "spacing", 1500), tag: `l5${Date.now().toString(36)}` };
	const meta = await startMeta("L5", host, `real VaultSync; modes ${modeArg}`);
	const out = flagStr(args, "out") ?? join(LOG_DIR, "runs", `${workerName(host)}-L5-${Date.now()}.json`);
	const modes: Mode[] = modeArg === "both" ? ["prod", "nodebounce"] : modeArg === "all" ? MODES : modeArg.split(",") as Mode[];
	if (!modes.every((m) => MODES.includes(m))) { console.error(`--mode must be one of ${MODES.join(",")},both,all`); process.exit(2); }
	const results: Obj = {};
	let error: string | null = null;
	for (const m of modes) {
		try { results[m] = await runMode(host, m, opts); }
		catch (e) { error = String(e instanceof Error ? e.stack : e); console.error(e); break; }
	}
	const convs = Object.values(results).map((r) => (r as { convergence: { pass: boolean } }).convergence);
	const body = { ...opts, results, error, convergencePass: convs.length > 0 && convs.every((c) => c.pass) };
	mkdirSync(join(LOG_DIR, "runs"), { recursive: true });
	writeFileSync(out, JSON.stringify({ ...meta, endedAt: new Date().toISOString(), ...body }, null, 2) + "\n");
	log(`wrote ${out}; convergence=${body.convergencePass}`);
	process.exit(error ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
