/**
 * Relay HTTP surface for the streams client (docs/client-remake/relay-wire.md
 * §2, §6–§8): socket tickets, feed, catch-up read (binary reply, §7.2) and checkpoint CAS.
 *
 * The credential (device token) is a secret. It is only ever placed in the
 * Authorization header; it never appears in URLs, error messages or logs.
 *
 * No call waits forever (core/deadline.ts). ticket() ends at connect's deadline (wsRelay.ts). feed, read and
 * readBatch are watched: their reply body is read chunk by chunk, so a dead connection ends in seconds, not at a
 * deadline sized to the largest page: RELAY_HTTP_BASE_MS (15 s) to the response headers, then RELAY_HTTP_IDLE_MS
 * (10 s) without a chunk ends the call "stalled", and a backstop (relayHttpDeadlineMs of the reply's byte bound:
 * 79 s for the largest read page, a 4 MiB checkpoint) ends a reply that trickles. putCheckpoint is bounded: a fetch
 * reports no upload progress (httpBlob.ts has the evidence), so its deadline is proportional to the body it sends
 * (15 s + 64 KiB/s); it is background duty, retried, and on no read path. The session's own signal, aborted when
 * the session closes (wsRelay.ts), ends every call as soon as the link is gone. untilAborted makes all of this
 * hold even when a fetch ignores its signal. These calls always run on the engine's fetch (a streaming body), never
 * on Obsidian's requestUrl (it buffers the reply and takes no signal). A blob, up to 100 MB, gets an idle window
 * and no total (httpBlob.ts).
 */

import type { ClockPort } from "../../ports/clock";
import type { FeedPage, PutCheckpointResult, ReadPage, ReadRequest, RelayConnectResult, RelayRow } from "../../ports/relay";
import type { ClientFrameId, DeviceId, StreamName } from "../../core/types";
import type { DeviceState, GrantFetchOutcome, RegisterOutcome, RetireOutcome } from "../../ports/identity";
import { bounded as boundedCall, relayHttpDeadlineMs, RELAY_HTTP_BASE_MS, RELAY_HTTP_IDLE_MS, RELAY_REPLY_BYTES, untilAborted, watched } from "../../core/deadline";
import { decodeReadReply, type WireReadPage } from "./relayFrames";
import { createWebClock } from "./webClock";

export type ConnectFailureReason = Extract<RelayConnectResult, { ok: false }>["reason"];

/** A failed relay HTTP call. The message carries the route, status and wire code only (never secrets). */
export class RelayHttpError extends Error {
	readonly status: number;
	/** Wire `error` code (e.g. "invalid_cursor", "cf_daily_limit"); "network_error" / "malformed_response" locally. */
	readonly code: string | null;
	readonly retryAfterMs: number | null;
	constructor(route: string, status: number, code: string | null, retryAfterMs: number | null) {
		super(`relay ${route} failed: ${status === 0 ? "network" : `HTTP ${status}`}${code === null ? "" : ` ${code}`}`);
		this.name = "RelayHttpError";
		this.status = status;
		this.code = code;
		this.retryAfterMs = retryAfterMs;
	}
}

export type TicketResult =
	| { readonly ok: true; readonly ticket: string }
	| { readonly ok: false; readonly reason: ConnectFailureReason; readonly retryAfterMs: number | null };

export interface RelayHttpOptions {
	readonly baseUrl: string;
	/** SECRET: the device token, or a getter read per call (the composed engine's store identity). */
	readonly credential: string | (() => string);
	readonly fetch?: typeof fetch;
	/** Wall clock for Retry-After dates and resetAt, and the deadlines' timers; a web clock when absent. */
	readonly clock?: Pick<ClockPort, "now" | "setTimer" | "clearTimer">;
}

/**
 * feed / read / readBatch reject with RelayHttpError status 0, code "timeout" without response headers within
 * RELAY_HTTP_BASE_MS or past their backstop, "stalled" when the body delivers nothing for RELAY_HTTP_IDLE_MS;
 * putCheckpoint with "timeout" at its deadline. Each rejects "aborted" as soon as `signal` aborts (the session closed).
 */
export interface RelayHttp {
	/**
	 * `POST /vault/:id/auth/device` with `Authorization: Grant <secret>` (identity-per-store §3.2, relay-wire §2.4.1):
	 * register a new store's identity under the install's grant. Never throws; bounded at the small-reply deadline.
	 */
	registerDevice(vaultId: string, grantSecret: string, body: { readonly deviceId: string; readonly deviceToken: string; readonly retireKeyHash: string }): Promise<RegisterOutcome>;
	/**
	 * `POST /vault/:id/auth/device/retire {deviceId, retireKey}` (identity-per-store §5.2 step 1, the successor fence):
	 * the retire key is the credential. Never throws; bounded at the small-reply deadline.
	 */
	retireDevice(vaultId: string, body: { readonly deviceId: string; readonly retireKey: string }): Promise<RetireOutcome>;
	/**
	 * `POST /vault/:id/auth/device/status {deviceIds}` with this device's bearer: the server's state of each id (the
	 * abandoned-creator rule, DESIGN §i.5). null: no usable answer. Never throws.
	 */
	deviceStatus(vaultId: string, deviceIds: readonly string[]): Promise<ReadonlyMap<string, DeviceState> | null>;
	/**
	 * `GET /vault/:id/auth/grant` with this device's bearer (identity-per-store §3.4): the pairing grant's secret after a
	 * rotation. Never throws; bounded at the small-reply deadline.
	 */
	fetchGrant(vaultId: string): Promise<GrantFetchOutcome>;
	/** POST /vault/:id/auth/ticket {purpose:"streams"}. Never throws; "unavailable" once `signal` aborts (connect's deadline). */
	ticket(vaultId: string, signal?: AbortSignal): Promise<TicketResult>;
	/**
	 * feed / read / readBatch: `vaultEpoch` is the session's (VAULT_READY). A reply of another epoch (the vault was reset
	 * or restored while the request was in flight) rejects RelayHttpError code "epoch_mismatch": its seqs and rows are
	 * not this epoch's and must never reach this epoch's store (relay-wire §1 "seqs are only comparable within one epoch").
	 */
	feed(vaultId: string, vaultEpoch: string, afterSeq: number, limit: number | null, signal?: AbortSignal): Promise<FeedPage>;
	read(vaultId: string, vaultEpoch: string, stream: string, afterSeq: number, preferCheckpoint: boolean, maxBytes: number | null, signal?: AbortSignal): Promise<ReadPage>;
	/** Batched read (relay-wire §7.1): pages for a non-empty prefix of `reqs` (the URL is capped at READ_BATCH_MAX_QUERY_CHARS). */
	readBatch(vaultId: string, vaultEpoch: string, reqs: readonly ReadRequest[], maxBytes: number | null, signal?: AbortSignal): Promise<ReadPage[]>;
	/**
	 * `vaultEpoch`: the epoch whose rows the bytes merge (the session's VAULT_READY): the relay refuses the put once its
	 * epoch is another (409 epoch_mismatch -> refused "epoch-mismatch", relay-wire §8), so a put in flight across a
	 * reset or restore never lands in the new epoch.
	 */
	putCheckpoint(
		vaultId: string, vaultEpoch: string, stream: string, coversSeq: number, expectedPrevCoversSeq: number, bytes: Uint8Array, signal?: AbortSignal,
	): Promise<PutCheckpointResult>;
}

/**
 * Wire bytes per page payload byte of rows. The payload travels raw in the binary reply (relay-wire §7.2), with
 * per-row fields (varuint seq, deviceId, clientFrameId and the payload length: at most ~300 B at the relay's name
 * limits, ~50 B with this client's ids); 2× covers rows of 300 B or more at the limits, 50 B or more in practice. A
 * page of smaller rows can exceed its bound; its backstop then assumes a faster link, by that ratio.
 */
export const RELAY_PAGE_WIRE_FACTOR = 2;
/** The largest single item of a read page: a checkpoint (relay-wire §8: 413 over 4 MiB); a frame is at most 1 MiB. */
export const RELAY_PAGE_ITEM_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The largest read budget this client asks for (the relay's own cap is 4 MiB, relay-wire §7), and the budget when
 * the call names none. At 2 MiB a page of rows (2 × 2 MiB on the wire) is no larger than a page carrying one
 * checkpoint, so every read's backstop is that of the checkpoint page (readPageBound: 79 s); a 4 MiB budget would
 * double it for nothing a 220 ms round trip per page costs (the relay's default, 1 MiB, is below it anyway).
 */
export const RELAY_READ_CLIENT_MAX_BYTES = 2 * 1024 * 1024;
/** The relay's feed page cap (relay-wire §6: "the max is 5000"): the page size when the call names none. */
export const RELAY_FEED_MAX_ENTRIES = 5000;
/** One feed entry on the wire: {"stream":<name, at most 256 UTF-8 bytes, JSON-escaped>,"lastSeq":<seq>}. */
export const RELAY_FEED_ENTRY_BYTES = 300;

/** The read budget sent: the call's, at most RELAY_READ_CLIENT_MAX_BYTES. */
function readBudget(maxBytes: number | null): number {
	return Math.max(1, Math.min(maxBytes ?? RELAY_READ_CLIENT_MAX_BYTES, RELAY_READ_CLIENT_MAX_BYTES));
}

/**
 * The byte bound of a read / readBatch reply under a `budget`. maxBytes "bounds payload bytes per page, checkpoint
 * included", but "a page always carries at least one row or the checkpoint" (relay-wire §7, §7.1;
 * server/src/streams/store.ts read): a page is either rows within the budget (with their fields, ×
 * RELAY_PAGE_WIRE_FACTOR) or one item past it, a checkpoint (raw) or a frame, at most RELAY_PAGE_ITEM_MAX_BYTES.
 */
export function readPageBound(budget: number): number {
	return RELAY_REPLY_BYTES + Math.max(RELAY_PAGE_WIRE_FACTOR * budget, RELAY_PAGE_ITEM_MAX_BYTES);
}

/** Strips trailing slashes: "https://h/" -> "https://h". */
export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

/**
 * Wait until a daily-limit `resetAt` (the relay's next 00:00 UTC). That is never
 * more than a day away, whatever this device's clock says: a slow clock would
 * otherwise wait days, a fast one gets null (the caller's default backoff).
 */
export function dailyResetDelayMs(resetAtMs: number, nowMs: number): number | null {
	const d = resetAtMs - nowMs;
	return d > 0 ? Math.min(d, 86_400_000) : null;
}

/** Retry-After (delta-seconds or HTTP-date) in ms; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function seqField(o: Json, key: string): number | null {
	const v = o[key];
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

interface HttpReply {
	readonly status: number;
	readonly body: Json | null;
	/** The body of a 200 read reply (relay-wire §7.2); then body is null. */
	readonly bytes: Uint8Array | null;
	readonly code: string | null;
	readonly retryAfterMs: number | null;
}

/** Query budget of one batched read URL (CDN URL limits are 8-16 KB); entries past it go in a later batch. */
export const READ_BATCH_MAX_QUERY_CHARS = 6000;

/**
 * One page of a read reply (relay-wire §7.2). The next cursor is nextAfter when more rows remain, else the last row,
 * else the checkpoint, else the request's cursor.
 */
function pageFromWire(page: WireReadPage, afterSeq: number): ReadPage {
	const rows: RelayRow[] = page.rows.map((r) => ({ seq: r.seq, deviceId: r.deviceId as DeviceId, clientFrameId: r.clientFrameId as ClientFrameId, payload: r.payload }));
	const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
	const nextAfterSeq = page.nextAfter ?? lastRow?.seq ?? page.checkpoint?.coversSeq ?? afterSeq;
	return { checkpoint: page.checkpoint, rows, lastSeq: page.lastSeq, checkpointSeq: page.checkpointSeq, gcSeq: page.gcSeq, nextAfterSeq, more: page.nextAfter !== null };
}

export function createRelayHttp(opts: RelayHttpOptions): RelayHttp {
	const base = normalizeBaseUrl(opts.baseUrl);
	const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const clock = opts.clock ?? createWebClock();
	const now = (): number => clock.now();
	const cred = opts.credential;
	const bearer = (): string => `Bearer ${typeof cred === "function" ? cred() : cred}`;

	const vaultPath = (vaultId: string, rest: string): string => `${base}/vault/${encodeURIComponent(vaultId)}${rest}`;

	/**
	 * The whole body, read chunk by chunk; `progress` on every chunk (the watched call's idle window). Rejects when the
	 * body fails or `signal` aborts (the reader is then cancelled).
	 */
	async function readAll(res: Response, signal: AbortSignal | undefined, progress: () => void): Promise<Uint8Array> {
		if (res.body === null) return new Uint8Array(await untilAborted(res.arrayBuffer(), signal));
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let n = 0;
		try {
			for (;;) {
				const r = await untilAborted(reader.read(), signal);
				if (signal?.aborted) throw signal.reason;
				if (r.done) break;
				progress();
				chunks.push(r.value);
				n += r.value.length;
			}
		} catch (e) {
			reader.cancel().catch(() => undefined);
			throw e;
		}
		if (chunks.length === 1) return chunks[0]!;
		const out = new Uint8Array(n);
		let at = 0;
		for (const c of chunks) {
			out.set(c, at);
			at += c.length;
		}
		return out;
	}

	/**
	 * null = network failure, or `signal` aborted before the whole reply arrived. Never rejects. `binary`: a 200 reply
	 * is the binary read reply (relay-wire §7.2), returned as bytes; errors are JSON. `progress` on the headers and
	 * on every body chunk.
	 */
	async function call(
		url: string, init: { method: string; body?: BodyInit; contentType?: string; binary?: true; authorization?: string }, signal?: AbortSignal, progress: () => void = () => undefined,
	): Promise<HttpReply | null> {
		const headers: Record<string, string> = { Authorization: init.authorization ?? bearer() };
		if (init.contentType) headers["Content-Type"] = init.contentType;
		let res: Response;
		try {
			res = await untilAborted(doFetch(url, { method: init.method, headers, body: init.body, ...(signal ? { signal } : {}) }), signal);
		} catch {
			return null;
		}
		progress();
		let raw: Uint8Array;
		try {
			raw = await readAll(res, signal, progress);
		} catch {
			if (signal?.aborted || (init.binary && res.status === 200)) return null;
			raw = new Uint8Array(0);
		}
		if (init.binary && res.status === 200) return { status: res.status, body: null, bytes: raw, code: null, retryAfterMs: null };
		let body: Json | null = null;
		try {
			const text = new TextDecoder().decode(raw);
			if (text !== "") {
				const parsed: unknown = JSON.parse(text);
				body = isRecord(parsed) ? parsed : null;
			}
		} catch {
			body = null;
		}
		const code = body !== null && typeof body["error"] === "string" ? body["error"] : null;
		let retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now());
		if (retryAfterMs === null && code === "cf_daily_limit" && body !== null && typeof body["resetAt"] === "number") {
			retryAfterMs = dailyResetDelayMs(body["resetAt"], now());
		}
		return { status: res.status, body, bytes: null, code, retryAfterMs };
	}

	/**
	 * A watched call (core/deadline.ts watched): RELAY_HTTP_BASE_MS to the headers, RELAY_HTTP_IDLE_MS between body
	 * chunks, relayHttpDeadlineMs(`bytes`) in all, or until `signal` aborts. The reply, null for a network failure;
	 * RelayHttpError "timeout", "stalled" or "aborted" when the call was ended from this side.
	 */
	function watch(route: string, bytes: number, signal: AbortSignal | undefined, run: (s: AbortSignal, progress: () => void) => Promise<HttpReply | null>): Promise<HttpReply | null> {
		const limits = { firstByteMs: RELAY_HTTP_BASE_MS, idleMs: RELAY_HTTP_IDLE_MS, totalMs: relayHttpDeadlineMs(bytes) };
		return watched(limits, signal, clock, run, (why) => new RelayHttpError(route, 0, why, null));
	}

	/** A call whose transport reports no progress (a fetch PUT): ended at relayHttpDeadlineMs(`bytes`) or when `signal` aborts. */
	function bounded(route: string, bytes: number, signal: AbortSignal | undefined, run: (s: AbortSignal) => Promise<HttpReply | null>): Promise<HttpReply | null> {
		return boundedCall(relayHttpDeadlineMs(bytes), signal, clock, run, (why) => new RelayHttpError(route, 0, why, null));
	}

	function fail(route: string, reply: HttpReply | null): RelayHttpError {
		if (reply === null) return new RelayHttpError(route, 0, "network_error", null);
		return new RelayHttpError(route, reply.status, reply.code, reply.retryAfterMs);
	}

	function malformed(route: string, status: number): RelayHttpError {
		return new RelayHttpError(route, status, "malformed_response", null);
	}

	/** A 200 reply of another vault epoch than the caller's session. */
	function epochMismatch(route: string): RelayHttpError {
		return new RelayHttpError(route, 200, "epoch_mismatch", null);
	}

	return {
		async registerDevice(vaultId, grantSecret, body) {
			const reply = await bounded("auth/device", RELAY_REPLY_BYTES, undefined, (s) => call(vaultPath(vaultId, "/auth/device"), {
				method: "POST",
				body: JSON.stringify({ deviceId: body.deviceId, deviceToken: body.deviceToken, retireKeyHash: body.retireKeyHash }),
				contentType: "application/json",
				authorization: `Grant ${grantSecret}`,
			}, s)).catch(() => null);
			return registerOutcome(reply);
		},

		async retireDevice(vaultId, body) {
			const reply = await bounded("auth/device/retire", RELAY_REPLY_BYTES, undefined, (s) => call(vaultPath(vaultId, "/auth/device/retire"), {
				method: "POST",
				body: JSON.stringify({ deviceId: body.deviceId, retireKey: body.retireKey }),
				contentType: "application/json",
			}, s)).catch(() => null);
			return retireOutcome(reply);
		},

		async deviceStatus(vaultId, deviceIds) {
			const reply = await bounded("auth/device/status", RELAY_REPLY_BYTES, undefined, (s) => call(vaultPath(vaultId, "/auth/device/status"), {
				method: "POST",
				body: JSON.stringify({ deviceIds }),
				contentType: "application/json",
			}, s)).catch(() => null);
			return deviceStatusOf(reply);
		},

		async fetchGrant(vaultId) {
			const reply = await bounded("auth/grant", RELAY_REPLY_BYTES, undefined, (s) => call(vaultPath(vaultId, "/auth/grant"), { method: "GET" }, s)).catch(() => null);
			return grantFetchOutcome(reply);
		},

		async ticket(vaultId, signal) {
			const reply = await call(vaultPath(vaultId, "/auth/ticket"), {
				method: "POST",
				body: JSON.stringify({ purpose: "streams" }),
				contentType: "application/json",
			}, signal);
			if (reply === null) return { ok: false, reason: "unavailable", retryAfterMs: null };
			const { status, code, retryAfterMs } = reply;
			if (status === 200) {
				const ticket = reply.body !== null ? reply.body["ticket"] : undefined;
				if (typeof ticket === "string" && ticket !== "") return { ok: true, ticket };
				return { ok: false, reason: "unavailable", retryAfterMs: null };
			}
			const reason: ConnectFailureReason =
				code === "unclaimed" ? "unclaimed"
				: status === 401 || status === 403 ? "unauthorized"
				: status === 404 ? "not-found"
				: status === 409 && code === "authority_superseded" ? "superseded"
				: status === 503 && code === "cf_daily_limit" ? "daily-limit"
				: status === 426 || (status === 400 && code === "invalid_ticket_scope") ? "update-required"
				: "unavailable";
			return { ok: false, reason, retryAfterMs };
		},

		async feed(vaultId, vaultEpoch, afterSeq, limit, signal) {
			const q = `after=${afterSeq}${limit !== null ? `&limit=${limit}` : ""}`;
			const bound = RELAY_REPLY_BYTES + Math.min(limit ?? RELAY_FEED_MAX_ENTRIES, RELAY_FEED_MAX_ENTRIES) * RELAY_FEED_ENTRY_BYTES;
			const reply = await watch("feed", bound, signal, (s, p) => call(vaultPath(vaultId, `/streams/feed?${q}`), { method: "GET" }, s, p));
			if (reply === null || reply.status !== 200) throw fail("feed", reply);
			const body = reply.body;
			if (body === null) throw malformed("feed", reply.status);
			const head = seqField(body, "head");
			const changes = body["changes"];
			const nextAfterRaw = body["nextAfter"];
			const nextAfter = nextAfterRaw === null || nextAfterRaw === undefined ? null : seqField(body, "nextAfter");
			if (head === null || !Array.isArray(changes) || (nextAfterRaw !== null && nextAfterRaw !== undefined && nextAfter === null)) {
				throw malformed("feed", reply.status);
			}
			if (body["vaultEpoch"] !== vaultEpoch) throw epochMismatch("feed");
			const entries: { stream: StreamName; lastSeq: number }[] = [];
			for (const change of changes) {
				if (!isRecord(change)) throw malformed("feed", reply.status);
				const stream = change["stream"];
				const lastSeq = seqField(change, "lastSeq");
				if (typeof stream !== "string" || lastSeq === null) throw malformed("feed", reply.status);
				entries.push({ stream: stream as StreamName, lastSeq });
			}
			return { entries, throughSeq: nextAfter ?? head, headSeq: head, more: nextAfter !== null };
		},

		async read(vaultId, vaultEpoch, stream, afterSeq, preferCheckpoint, maxBytes, signal) {
			const budget = readBudget(maxBytes);
			const q = `stream=${encodeURIComponent(stream)}&after=${afterSeq}&maxBytes=${budget}`
				+ (preferCheckpoint ? "&checkpoint=1" : "");
			const reply = await watch("read", readPageBound(budget), signal, (s, p) => call(vaultPath(vaultId, `/streams/read?${q}`), { method: "GET", binary: true }, s, p));
			if (reply === null || reply.status !== 200) throw fail("read", reply);
			const wire = reply.bytes === null ? null : decodeReadReply(reply.bytes);
			if (wire === null || wire.pages.length !== 1 || wire.pages[0]!.stream !== stream) throw malformed("read", reply.status);
			if (wire.vaultEpoch !== vaultEpoch) throw epochMismatch("read");
			return pageFromWire(wire.pages[0]!, afterSeq);
		},

		async readBatch(vaultId, vaultEpoch, reqs, maxBytes, signal) {
			const budget = readBudget(maxBytes);
			let q = `maxBytes=${budget}`;
			let sent = 0;
			for (const r of reqs) {
				const entry = `r=${r.afterSeq}.${r.preferCheckpoint ? 1 : 0}.${encodeURIComponent(r.stream)}`;
				if (sent > 0 && q.length + entry.length + 1 > READ_BATCH_MAX_QUERY_CHARS) break;
				q += `&${entry}`;
				sent++;
			}
			if (sent === 0) throw new RangeError("readBatch: no requests");
			// One budget for the whole batch (relay-wire §7.1), so one page's bound.
			const reply = await watch("read", readPageBound(budget), signal, (s, p) => call(vaultPath(vaultId, `/streams/read?${q}`), { method: "GET", binary: true }, s, p));
			if (reply === null || reply.status !== 200) throw fail("read", reply);
			const wire = reply.bytes === null ? null : decodeReadReply(reply.bytes);
			if (wire === null || wire.pages.length === 0 || wire.pages.length > sent) throw malformed("read", reply.status);
			if (wire.vaultEpoch !== vaultEpoch) throw epochMismatch("read");
			return wire.pages.map((page, i) => {
				if (page.stream !== reqs[i]!.stream) throw malformed("read", reply.status);
				return pageFromWire(page, reqs[i]!.afterSeq);
			});
		},

		async putCheckpoint(vaultId, vaultEpoch, stream, coversSeq, expectedPrevCoversSeq, bytes, signal) {
			const q = `stream=${encodeURIComponent(stream)}&coversSeq=${coversSeq}&expectedCoversSeq=${expectedPrevCoversSeq}`
				+ `&vaultEpoch=${encodeURIComponent(vaultEpoch)}`;
			const reply = await bounded("checkpoint", RELAY_REPLY_BYTES + bytes.byteLength, signal, (s) => call(vaultPath(vaultId, `/streams/checkpoint?${q}`), {
				method: "PUT",
				body: bytes.slice(),
				contentType: "application/octet-stream",
			}, s));
			if (reply === null) throw fail("checkpoint", reply);
			const { status, code, retryAfterMs } = reply;
			if (status === 200) return { t: "ok" };
			if (status === 409 && code === "checkpoint_conflict") {
				const current = reply.body !== null ? reply.body["current"] : undefined;
				const currentCoversSeq = isRecord(current) ? seqField(current, "coversSeq") : null;
				if (currentCoversSeq === null) throw malformed("checkpoint", status);
				return { t: "conflict", currentCoversSeq };
			}
			if (status === 409 && code === "epoch_mismatch") return { t: "refused", reason: "epoch-mismatch", retryAfterMs: null };
			if (status === 409 && code === "checkpoint_ahead_of_stream") return { t: "refused", reason: "ahead-of-stream", retryAfterMs: null };
			if (status === 400 && code === "checkpoint_not_advancing") return { t: "refused", reason: "not-advancing", retryAfterMs: null };
			if (status === 404) return { t: "refused", reason: "stream-not-found", retryAfterMs: null };
			if (status === 413) return { t: "refused", reason: "too-large", retryAfterMs: null };
			if (status === 503 && code === "cf_daily_limit") return { t: "refused", reason: "daily-limit", retryAfterMs };
			if (status === 403) return { t: "refused", reason: "forbidden", retryAfterMs: null };
			throw fail("checkpoint", reply);
		},
	};
}

/** A retire-by-key reply as the engine reads it (relay-wire §2.4.1); null = no reply. */
export function retireOutcome(reply: { readonly status: number; readonly body: Json | null } | null): RetireOutcome {
	if (reply === null) return { ok: false, reason: "network" };
	if (reply.status === 200) return { ok: true, retired: reply.body !== null && reply.body["retired"] === true };
	if (reply.status === 401) return { ok: false, reason: "unauthorized" };
	if (reply.status === 429 || reply.status === 503) return { ok: false, reason: "rate-limited" };
	return { ok: false, reason: "network" };
}

/** A grant fetch reply (`{grantId, grantName, grantSecret}`) as the engine reads it; null = no reply. */
export function grantFetchOutcome(reply: { readonly status: number; readonly body: Json | null } | null): GrantFetchOutcome {
	if (reply === null) return { ok: false, reason: "network" };
	const secret = reply.body?.["grantSecret"];
	if (reply.status === 200) return typeof secret === "string" && GRANT_SECRET_SHAPE.test(secret) ? { ok: true, grantSecret: secret } : { ok: false, reason: "network" };
	if (reply.status === 404) return { ok: false, reason: "unavailable" };
	if (reply.status === 401 || reply.status === 403) return { ok: false, reason: "refused" };
	return { ok: false, reason: "network" };
}

/** A grant secret's shape (server pairing.ts GRANT_SECRET_PATTERN): base64url, 43 to 256 characters. */
const GRANT_SECRET_SHAPE = /^[A-Za-z0-9_-]{43,256}$/;

/** A device status reply (`{devices: [{deviceId, state}]}`); null for anything else. */
export function deviceStatusOf(reply: { readonly status: number; readonly body: Json | null } | null): ReadonlyMap<string, DeviceState> | null {
	if (reply === null || reply.status !== 200 || reply.body === null) return null;
	const list = reply.body["devices"];
	if (!Array.isArray(list)) return null;
	const out = new Map<string, DeviceState>();
	for (const d of list) {
		if (!isRecord(d) || typeof d["deviceId"] !== "string") continue;
		const st = d["state"];
		if (st === "live" || st === "retired" || st === "unknown") out.set(d["deviceId"], st);
	}
	return out;
}

/** A register reply as the engine reads it (relay-wire §2.4.1 errors); null = no reply (network, deadline). */
export function registerOutcome(reply: { readonly status: number; readonly code: string | null; readonly retryAfterMs: number | null } | null): RegisterOutcome {
	if (reply === null) return { ok: false, reason: "network", retryAfterMs: null };
	const { status, code, retryAfterMs } = reply;
	if (status === 200) return { ok: true };
	if (status === 401) return { ok: false, reason: code === "grant_revoked" ? "grant-revoked" : "unauthorized", retryAfterMs: null };
	if (status === 403 && code === "grant_required") return { ok: false, reason: "grant-required", retryAfterMs: null };
	if (status === 409 && code === "device_exists") return { ok: false, reason: "device-exists", retryAfterMs: null };
	if (status === 409 && code === "device_retired") return { ok: false, reason: "device-retired", retryAfterMs: null };
	if (status === 409 && code === "device_limit") return { ok: false, reason: "device-limit", retryAfterMs: null };
	if (status === 429 && code === "registration_limit") return { ok: false, reason: "registration-limit", retryAfterMs };
	if (status === 429 || (status === 503 && code !== null && code !== "server_error")) return { ok: false, reason: "rate-limited", retryAfterMs };
	return { ok: false, reason: "network", retryAfterMs };
}
