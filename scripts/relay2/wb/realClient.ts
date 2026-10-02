/**
 * Real client for the W4 write-budget scenarios: production `VaultSync` (src/sync/vaultSync.ts, untouched) in Node,
 * set up exactly like scripts/relay2/l5-cli-baseline.ts:
 *   - DEFAULT providerFactory (OwnAwarenessProvider over fencedWebSocket) with a recording `ws` subclass as
 *     `VaultSyncOptions.webSocket` (counts/timestamps frames only; never alters them);
 *   - real `createSocketTicketCache`, `BootstrapHttpPort` + `prepareBootstrapRoot`, `createFetchRequester` HTTP
 *     (wrapped only to timestamp requests and keep 4xx/5xx bodies);
 *   - the CLI's durable SQLite store (`packages/cli/src/nodeVaultDatabase.ts`) with putCandidate /
 *     confirmPendingCandidate / deleteCandidate timestamped through a Proxy;
 *   - CLI browser globals (`packages/cli/src/globals.ts`) loaded lazily, only when a real client is opened.
 *
 * b3-bulk port (from write-budget-spike 91b1fac/4f36c9e): used by I4 only; the D8 daily-limit hook is not ported.
 *
 * Receipt = product event `serverReceiptConfirmed` (emitted by completeCandidateSubmission after the durable receipt
 * is validated and the candidate confirmed). `relayDiagnostics()` feature-detects
 * `VaultSync.prototype.getRelaySeqDiagnostics` (relay-seq client, landing separately) and reports "absent" otherwise.
 */
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import type * as Y from "yjs";
import type { LiveIdentity } from "../../../tests/live/liveIdentity";
import { LOG_DIR, now, r2, sleep, workerName } from "../lib/common";
import type { Context } from "../lib/context";
import { parseSyncFrame } from "../lib/socketReceipts";

type Obj = Record<string, unknown>;
export interface HttpRec { at: number; end: number; method: string; path: string; status: number; reqBytes: number; retryAfter?: string; error?: unknown }
export interface WsOut { at: number; bodyId: string | null; kind: string; bytes: number }
export interface WsIn { at: number; bodyId: string | null; type: string; code?: string; value: Obj }
export interface CandEvent { at: number; op: "put" | "confirm" | "delete"; candidateId: string; bodyId: string }
export interface Receipt { at: number; bodyId: string; candidateId: string; durableGeneration: unknown; path?: string }

export interface RealClientOptions {
	device: string;
	label: string;
	candidateDebounceMs?: number;
	candidateMaxWaitMs?: number;
	createCollectorDelayMs?: number;
	/** Reuse a previous client's SQLite dir (same folderKey) — e.g. to restart after a daily-limit trip. */
	reuse?: { dir: string; folderKey: string };
}

const frameKind = (bytes: Uint8Array) => {
	const p = parseSyncFrame(bytes);
	if (p.type === 0) return p.sync === 0 ? "step1" : p.sync === 1 ? "step2" : p.sync === 2 ? "update" : `sync${p.sync}`;
	return p.type === 1 ? "awareness" : `type${p.type}`;
};
const toBytes = (d: unknown) => (d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d)
	: ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(Buffer.from(String(d))));

export async function openRealClient(host: string, context: Context, identity: LiveIdentity, opts: RealClientOptions) {
	// @ts-expect-error globals.ts is a side-effect script (no exports), loaded lazily so RawClient-only runs never see `window`.
	await import("../../../packages/cli/src/globals");
	const { VaultSync } = await import("../../../src/sync/vaultSync");
	const { PRODUCT_EVENT_KIND } = await import("../../../src/observability/productEventKinds");
	const { createSocketTicketCache } = await import("../../../src/sync/socketTicket");
	const { createFetchRequester } = await import("../../../src/utils/http");
	const { BootstrapHttpPort, prepareBootstrapRoot } = await import("../../../src/sync/bootstrapClient");
	const { NodeVaultDatabase } = await import("../../../packages/cli/src/nodeVaultDatabase");

	const dir = opts.reuse?.dir ?? join(LOG_DIR, "wb-real", `${workerName(host)}-${opts.label}-${Date.now().toString(36)}`);
	const folderKey = opts.reuse?.folderKey ?? randomBytes(16).toString("hex");
	if (!opts.reuse) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
	const real = new NodeVaultDatabase(join(dir, "client.sqlite"), {
		host, realVaultPath: dir, vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration, deviceId: identity.deviceId, folderKey });

	const cand: CandEvent[] = [];
	const traced = new Set(["putCandidate", "confirmPendingCandidate", "deleteCandidate"]);
	const database = new Proxy(real, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver) as unknown;
			if (typeof value !== "function") return value;
			if (!traced.has(String(prop))) return (value as (...a: unknown[]) => unknown).bind(target);
			return async (...args: unknown[]) => {
				const t0 = now();
				const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
				const op = prop === "putCandidate" ? "put" : prop === "confirmPendingCandidate" ? "confirm" : "delete";
				const rec = op === "delete" ? { bodyId: String(args[0]), candidateId: String(args[1]) }
					: { bodyId: String((args[0] as Obj).bodyId), candidateId: String((args[0] as Obj).candidateId) };
				cand.push({ at: t0, op, ...rec });
				return result;
			};
		},
	});

	const http: HttpRec[] = [];
	const fetchRequester = createFetchRequester(globalThis.fetch.bind(globalThis));
	const requester: typeof fetchRequester = async (request) => {
		const t0 = now();
		const response = await fetchRequester(request);
		const reqBody = request.body;
		const rec: HttpRec = { at: r2(t0), end: r2(now()), method: request.method ?? "GET", status: response.status,
			reqBytes: typeof reqBody === "string" ? Buffer.byteLength(reqBody) : reqBody instanceof ArrayBuffer ? reqBody.byteLength : 0,
			path: new URL(request.url).pathname.replace(/\/vault\/[^/]+/, "").replace(/\/body\/[^/]+/, "/body/<id>") };
		if (response.status >= 400) {
			rec.retryAfter = response.headers["retry-after"];
			try { rec.error = response.json ?? response.text.slice(0, 300); } catch { rec.error = response.text.slice(0, 300); }
		}
		http.push(rec);
		return response;
	};

	const wsOut: WsOut[] = [];
	const wsIn: WsIn[] = [];
	const sockets: Array<{ at: number; bodyId: string | null; kind: "open" | "close"; code?: number }> = [];
	const live = new Set<RecordingWs>();
	class RecordingWs extends WebSocket {
		readonly bodyId: string | null;
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols ?? []);
			const m = new URL(String(url)).pathname.match(/\/ws\/body\/([^/?]+)/);
			this.bodyId = m ? decodeURIComponent(m[1]!) : null;
			sockets.push({ at: r2(now()), bodyId: this.bodyId, kind: "open" });
			live.add(this);
			this.on("close", (code) => { live.delete(this); sockets.push({ at: r2(now()), bodyId: this.bodyId, kind: "close", code }); });
			this.on("message", (data, isBinary) => {
				if (isBinary) return;
				const text = data.toString();
				if (!text.startsWith("__YPS:")) return;
				try {
					const value = JSON.parse(text.slice(6)) as Obj;
					if (value.type === "awareness" || value.type === "PING" || value.type === "PONG") return;
					wsIn.push({ at: r2(now()), bodyId: this.bodyId, type: String(value.type), ...(typeof value.code === "string" ? { code: value.code } : {}), value });
				} catch { /* not json */ }
			});
		}
		override send(data: unknown, ...rest: unknown[]): void {
			if (typeof data === "string") wsOut.push({ at: r2(now()), bodyId: this.bodyId, kind: data.startsWith("__YPS:") ? "control" : "text", bytes: Buffer.byteLength(data) });
			else { const b = toBytes(data); wsOut.push({ at: r2(now()), bodyId: this.bodyId, kind: frameKind(b), bytes: b.byteLength }); }
			(super.send as (...a: unknown[]) => void)(data, ...rest);
		}
	}

	const receipts: Receipt[] = [];
	const productEvents: Array<{ at: number; kind: string; path?: string; data?: unknown }> = [];
	const logs: string[] = [];
	const t0 = now();
	await prepareBootstrapRoot(new BootstrapHttpPort(host, identity.vaultId, identity.deviceToken, real, requester), real);
	const tickets = createSocketTicketCache(requester);
	const vs = await VaultSync.create({
		vaultId: identity.vaultId, vaultGeneration: context.vaultGeneration, deviceId: identity.deviceId,
		host, token: identity.deviceToken, database, request: requester,
		webSocket: RecordingWs as unknown as typeof globalThis.WebSocket,
		getSocketTicket: async (scope, force = false) => {
			if (force) tickets.invalidate();
			return tickets.get(host, identity.deviceToken, identity.vaultId, scope);
		},
		log: (m) => { if (logs.length < 4000) logs.push(`${r2(now())} ${m}`); },
		onProductEvent: (e) => {
			const ev = e as unknown as { kind: string; path?: string; data?: Obj };
			productEvents.push({ at: r2(now()), kind: ev.kind, path: ev.path, data: ev.data });
			if (ev.kind === PRODUCT_EVENT_KIND.serverReceiptConfirmed && ev.data) {
				receipts.push({ at: now(), bodyId: String(ev.data.bodyId), candidateId: String(ev.data.candidateId), durableGeneration: ev.data.durableGeneration, path: ev.path });
			}
		},
		...(opts.candidateDebounceMs !== undefined ? { candidateDebounceMs: opts.candidateDebounceMs } : {}),
		...(opts.candidateMaxWaitMs !== undefined ? { candidateMaxWaitMs: opts.candidateMaxWaitMs } : {}),
		...(opts.createCollectorDelayMs !== undefined ? { createCollectorDelayMs: opts.createCollectorDelayMs } : {}),
	});
	vs.setResidencyRuntimeContext("desktop", "foreground");
	const setupMs = r2(now() - t0);
	const consumers = new Map<string, string>();

	const client = {
		vs, dir, folderKey, http, wsOut, wsIn, sockets, cand, receipts, productEvents, logs, setupMs,
		get liveSockets() { return [...live]; },
		async waitPath(path: string, timeoutMs = 30_000) {
			const deadline = now() + timeoutMs;
			while (!vs.getFileId(path) && now() < deadline) await sleep(50);
			return vs.getFileId(path) ?? null;
		},
		/** Open a note like an editor: acquire + bind the body, return its Y.Text("body"). */
		async openEditor(path: string): Promise<Y.Text> {
			if (!await client.waitPath(path)) throw new Error(`root never showed ${path}`);
			const consumer = `${opts.label}-${path}`;
			await vs.acquireEditorBody(path, consumer);
			vs.completeEditorBodyBinding(consumer);
			consumers.set(path, consumer);
			const text = vs.getTextForPath(path);
			if (!text) throw new Error(`no Y.Text for ${path}`);
			return text;
		},
		closeEditor(path: string) {
			const c = consumers.get(path);
			if (c) { vs.releaseEditorBody(path, c); consumers.delete(path); }
		},
		/** One local transaction per keystroke, like y-codemirror.next's ySync (origin null = local). */
		type(text: Y.Text, s: string, at = text.length) { text.doc!.transact(() => text.insert(at, s)); return now(); },
		relayDiagnostics(): unknown {
			const fn = (vs as unknown as { getRelaySeqDiagnostics?: () => unknown }).getRelaySeqDiagnostics;
			if (typeof fn !== "function") return "absent";
			try { return fn.call(vs); } catch (e) { return `error: ${String(e)}`; }
		},
		/** Candidates (by put) captured at/after `since` for `bodyId`, and whether each is receipted. */
		candidatesSince(bodyId: string, since: number) {
			return cand.filter((c) => c.op === "put" && c.bodyId === bodyId && c.at >= since).map((c) => ({
				...c, receiptAt: receipts.find((r) => r.candidateId === c.candidateId)?.at ?? null }));
		},
		/** First receipt whose candidate was captured at/after `editAt` (the receipt covering that edit). */
		receiptCovering(bodyId: string, editAt: number): number | null {
			const covering = cand.filter((c) => c.op === "put" && c.bodyId === bodyId && c.at >= editAt).map((c) => c.candidateId);
			const r = receipts.filter((x) => covering.includes(x.candidateId)).map((x) => x.at);
			return r.length ? Math.min(...r) : null;
		},
		pendingCandidates(bodyId?: string) {
			const cleared = new Set(cand.filter((c) => c.op !== "put").map((c) => c.candidateId));
			return cand.filter((c) => c.op === "put" && !cleared.has(c.candidateId) && (!bodyId || c.bodyId === bodyId)).length;
		},
		/**
		 * destroy() + database close. With `timeoutMs`, a destroy that does not settle is abandoned (the DB is left open
		 * for the zombie runtime) and reported: VaultSync.destroy() flushes pending candidates through
		 * waitForSubmissionWindow(), which sleeps out a daily-limit trip (until resetAt / the hourly probe).
		 */
		async close(opts: { timeoutMs?: number } = {}): Promise<{ destroyMs: number; destroyTimedOut: boolean }> {
			for (const p of [...consumers.keys()]) client.closeEditor(p);
			const t = now();
			const done = vs.destroy().then(() => false);
			const timedOut = opts.timeoutMs === undefined ? await done
				: await Promise.race([done, sleep(opts.timeoutMs).then(() => true)]);
			if (!timedOut) await real.close();
			return { destroyMs: r2(now() - t), destroyTimedOut: timedOut };
		},
		httpSummary(since = 0) {
			return Object.entries(http.filter((h) => h.at >= since).reduce<Record<string, number>>((acc, h) => {
				const k = `${h.method} ${h.path} ${h.status}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}));
		},
		logTail(n = 30) { return logs.slice(-n); },
	};
	return client;
}
export type RealClient = Awaited<ReturnType<typeof openRealClient>>;
