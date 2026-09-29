/**
 * L5 baseline (D8 option 1 in spirit): time from "edit applied" to "candidate cleared from the client DB"
 * through the REAL production candidate path, with the real 250 ms / 2 s candidate debounce.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/l5-cli-baseline.ts --host <url> \
 *        [--n 100] [--mode prod|nodebounce|both] [--burst 1] [--burst-interval 80] [--spacing 1500] [--out file.json]
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
import WebSocket from "ws";
import { LOG_DIR, flagNum, flagStr, log, now, parseArgs, r2, series, sleep, startMeta, workerName } from "./lib/common";
import { addDevice, loadContext, seedNotes, smallContent } from "./lib/context";
import { contentHashOf } from "./lib/rawClient";

type Obj = Record<string, unknown>;

interface CandidateEvent { at: number; op: "put" | "confirm" | "delete"; candidateId: string; bodyId: string; ms: number }

/**
 * ENVELOPE HOOK (documented for the relay client): every frame the real provider sends goes
 * YSyncProvider → FencedWebSocket.send(data) → Base.send(data), where Base = VaultSyncOptions.webSocket.
 * A relay client can pass a Base whose send() emits `__YPS:{BODY_UPDATE_ENVELOPE…}` immediately before a
 * binary sync step2/update frame (bytes[0]==0 && bytes[1] in {1,2}). The required envelope fields are all
 * derivable at this layer: bodyId from the socket URL (/ws/body/<id>), bodyEpoch from
 * VaultSync.currentBodyEpoch(bodyId), payloadDigest = sha256(inner update) from the frame itself, clientFrameId
 * generated here. Optional contentHash/size/stateVector need the body Y.Doc (VaultSync.getTextForPath).
 * `connectDocument`'s webSocketPolyfill param is the same seam. Here the hook only observes (flag-off worker).
 */
function instrumentedWebSocket(stats: Obj) {
	const frames = (stats.frames ??= { out: { binary: 0, text: 0, syncUpdate: 0, syncStep1: 0, syncStep2: 0 }, in: { binary: 0, text: 0 } }) as {
		out: Record<string, number>; in: Record<string, number> };
	const sockets = (stats.sockets ??= []) as Obj[];
	const controlsIn = (stats.controlsIn ??= {}) as Record<string, number>;
	return class InstrumentedWebSocket extends WebSocket {
		private readonly rec: Obj;
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols ?? []);
			const u = new URL(String(url));
			this.rec = { path: u.pathname.replace(/\/vault\/[^/]+/, "/vault/<id>"), openedAt: null, closed: null, createdAt: r2(now()) };
			sockets.push(this.rec);
			this.on("open", () => { this.rec.openedAt = r2(now()); });
			this.on("close", (code, reason) => { this.rec.closed = { code, reason: reason.toString(), at: r2(now()) }; });
			this.on("message", (data, isBinary) => {
				if (isBinary) { frames.in.binary!++; return; }
				frames.in.text!++;
				const text = data.toString();
				if (text.startsWith("__YPS:")) {
					try { const t = String((JSON.parse(text.slice(6)) as Obj).type); controlsIn[t] = (controlsIn[t] ?? 0) + 1; } catch { /* ignore */ }
				}
			});
		}
		override send(data: unknown, ...rest: unknown[]): void {
			if (typeof data === "string") frames.out.text!++;
			else {
				frames.out.binary!++;
				const b = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
				if (b[0] === 0) frames.out[b[1] === 0 ? "syncStep1" : b[1] === 1 ? "syncStep2" : "syncUpdate"]!++;
				// Relay: `super.send("__YPS:" + JSON.stringify(envelope))` would go here, before the binary frame.
			}
			(super.send as (...a: unknown[]) => void)(data, ...rest);
		}
	};
}

async function runMode(host: string, mode: "prod" | "nodebounce", opts: { n: number; burst: number; burstInterval: number; spacing: number; tag: string }) {
	const { VaultSync } = await import("../../src/sync/vaultSync");
	const { createSocketTicketCache } = await import("../../src/sync/socketTicket");
	const { createFetchRequester } = await import("../../src/utils/http");
	const { BootstrapHttpPort, prepareBootstrapRoot } = await import("../../src/sync/bootstrapClient");
	const { NodeVaultDatabase } = await import("../../packages/cli/src/nodeVaultDatabase");

	const context = loadContext(host);
	const identity = await addDevice(context, `L5${mode === "prod" ? "p" : "n"}`);
	const bodyId = `${opts.tag}-l5-${mode}`;
	const path = `R2/${opts.tag}/l5-${mode}.md`;
	await seedNotes(context, [{ bodyId, path, content: smallContent(7) }]);

	const dir = join(LOG_DIR, "l5", `${workerName(host)}-${opts.tag}-${mode}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const real = new NodeVaultDatabase(join(dir, "client.sqlite"), {
		host, realVaultPath: dir, vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration,
		deviceId: identity.deviceId, folderKey: randomBytes(16).toString("hex") });
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
		const response = await fetchRequester(request);
		httpLog.push({ at: r2(t0), method: request.method ?? "GET",
			path: new URL(request.url).pathname.replace(/\/vault\/[^/]+/, "/vault/<id>").replace(/\/ws\/.*$/, "/ws/…"),
			status: response.status, ms: r2(now() - t0) });
		return response;
	};
	const wsStats: Obj = {};
	const logs: string[] = [];
	const t0 = now();
	await prepareBootstrapRoot(new BootstrapHttpPort(host, identity.vaultId, identity.deviceToken, real, requester), real);
	const bootstrapMs = r2(now() - t0);
	const tickets = createSocketTicketCache(requester);
	const vaultSync = await VaultSync.create({
		vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration, deviceId: identity.deviceId,
		host, token: identity.deviceToken, database, request: requester,
		webSocket: instrumentedWebSocket(wsStats) as unknown as typeof globalThis.WebSocket,
		getSocketTicket: async (scope, force = false) => {
			if (force) tickets.invalidate();
			return tickets.get(host, identity.deviceToken, identity.vaultId, scope);
		},
		log: (m) => { if (logs.length < 2000) logs.push(`${r2(now())} ${m}`); },
		...(mode === "nodebounce" ? { candidateDebounceMs: 0, candidateMaxWaitMs: 0 } : {}),
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
	await sleep(1500);

	const samples: Obj[] = [];
	for (let i = 0; i < opts.n; i++) {
		const startIdx = events.length;
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
			if (puts.length > 0 && puts.every((p) => cleared.has(p.candidateId))) {
				settledAt = Math.max(...mine.filter((e) => e.op !== "put").map((e) => e.at));
				break;
			}
			await sleep(5);
		}
		const mine = events.slice(startIdx);
		const firstPut = mine.find((e) => e.op === "put");
		samples.push({ i, burst: opts.burst,
			editToClearedMs: settledAt === null ? null : r2(settledAt - first),
			lastEditToClearedMs: settledAt === null ? null : r2(settledAt - last),
			editToCaptureMs: firstPut ? r2(firstPut.at - first) : null,
			captureToClearedMs: settledAt !== null && firstPut ? r2(settledAt - firstPut.at) : null,
			candidates: mine.filter((e) => e.op === "put").length,
			putMs: firstPut?.ms ?? null, clearMs: mine.find((e) => e.op !== "put")?.ms ?? null });
		if (i % 10 === 0) log(`L5 ${mode} ${i}/${opts.n} editToCleared=${samples.at(-1)!.editToClearedMs}`);
		await sleep(opts.spacing);
	}
	const finalText = text.toString();
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
	return {
		mode, bodyId, deviceName: `L5${mode === "prod" ? "p" : "n"}`,
		debounce: mode === "prod" ? { candidateDebounceMs: "production default (250)", candidateMaxWaitMs: "production default (2000)" }
			: { candidateDebounceMs: 0, candidateMaxWaitMs: 0 },
		setup: { bootstrapMs, createMs, acquireMs },
		editToClearedMs: series(col("editToClearedMs")),
		lastEditToClearedMs: series(col("lastEditToClearedMs")),
		editToCaptureMs: series(col("editToCaptureMs")),
		captureToClearedMs: series(col("captureToClearedMs")),
		candidateSubmitHttpMs: series(submitPosts.map((h) => h.ms as number)),
		candidateSubmitRoutes: [...new Set(submitPosts.map((h) => `${h.method} ${h.path}`))],
		samples,
		convergence: { pass: get.text === finalText && head.value?.contentHash === expect.contentHash,
			getTextEqual: get.text === finalText, headHashEqual: head.value?.contentHash === expect.contentHash,
			headGeneration: head.value?.generation ?? null },
		providerProof: { ...wsStats, receiptSnapshot: receipt },
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
	const opts = { n: flagNum(args, "n", 100), burst: flagNum(args, "burst", 1), burstInterval: flagNum(args, "burst-interval", 80),
		spacing: flagNum(args, "spacing", 1500), tag: `l5${Date.now().toString(36)}` };
	const meta = await startMeta("L5", host, "base (real VaultSync)");
	const out = flagStr(args, "out") ?? join(LOG_DIR, "runs", `${workerName(host)}-L5-${Date.now()}.json`);
	const modes: Array<"prod" | "nodebounce"> = modeArg === "both" ? ["prod", "nodebounce"] : [modeArg as "prod" | "nodebounce"];
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
