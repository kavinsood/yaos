/**
 * Relay HTTP surface for the streams client (docs/client-remake/relay-wire.md
 * §2, §6–§8): socket tickets, feed, catch-up read and checkpoint CAS.
 *
 * The credential (device token) is a secret. It is only ever placed in the
 * Authorization header; it never appears in URLs, error messages or logs.
 */

import type { ClockPort } from "../../ports/clock";
import type { FeedPage, PutCheckpointResult, ReadPage, ReadRequest, RelayConnectResult, RelayRow } from "../../ports/relay";
import type { ClientFrameId, DeviceId, StreamName } from "../../core/types";

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
	readonly credential: string;
	readonly fetch?: typeof fetch;
	/** Wall clock for Retry-After dates and resetAt; Date.now when absent. */
	readonly clock?: Pick<ClockPort, "now">;
}

export interface RelayHttp {
	/** POST /vault/:id/auth/ticket {purpose:"streams"}. Never throws. */
	ticket(vaultId: string): Promise<TicketResult>;
	feed(vaultId: string, afterSeq: number, limit: number | null): Promise<FeedPage>;
	read(vaultId: string, stream: string, afterSeq: number, preferCheckpoint: boolean, maxBytes: number | null): Promise<ReadPage>;
	/** Batched read (relay-wire §7.1): pages for a non-empty prefix of `reqs` (the URL is capped at READ_BATCH_MAX_QUERY_CHARS). */
	readBatch(vaultId: string, reqs: readonly ReadRequest[], maxBytes: number | null): Promise<ReadPage[]>;
	putCheckpoint(vaultId: string, stream: string, coversSeq: number, expectedPrevCoversSeq: number, bytes: Uint8Array): Promise<PutCheckpointResult>;
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

export function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.byteLength; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
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
	readonly code: string | null;
	readonly retryAfterMs: number | null;
}

/** Query budget of one batched read URL (CDN URL limits are 8-16 KB); entries past it go in a later batch. */
export const READ_BATCH_MAX_QUERY_CHARS = 6000;

/** One read page (single read body / batched read entry); null when malformed. */
function parsePage(body: Json, afterSeq: number): ReadPage | null {
	const lastSeq = seqField(body, "lastSeq");
	const checkpointSeq = seqField(body, "checkpointSeq") ?? 0;
	const rawRows = body["rows"];
	const nextAfterRaw = body["nextAfter"];
	const nextAfter = nextAfterRaw === null || nextAfterRaw === undefined ? null : seqField(body, "nextAfter");
	if (lastSeq === null || !Array.isArray(rawRows) || (nextAfterRaw !== null && nextAfterRaw !== undefined && nextAfter === null)) return null;
	try {
		let checkpoint: { coversSeq: number; bytes: Uint8Array } | null = null;
		const rawCheckpoint = body["checkpoint"];
		if (isRecord(rawCheckpoint)) {
			const coversSeq = seqField(rawCheckpoint, "coversSeq");
			const bytes = rawCheckpoint["bytes"];
			if (coversSeq === null || typeof bytes !== "string") return null;
			checkpoint = { coversSeq, bytes: base64ToBytes(bytes) };
		}
		const rows: RelayRow[] = [];
		for (const raw of rawRows) {
			if (!isRecord(raw)) return null;
			const seq = seqField(raw, "seq");
			const deviceId = raw["deviceId"];
			const clientFrameId = raw["clientFrameId"];
			const payload = raw["payload"];
			if (seq === null || typeof deviceId !== "string" || typeof clientFrameId !== "string" || typeof payload !== "string") return null;
			rows.push({ seq, deviceId: deviceId as DeviceId, clientFrameId: clientFrameId as ClientFrameId, payload: base64ToBytes(payload) });
		}
		const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
		const nextAfterSeq = nextAfter ?? lastRow?.seq ?? checkpoint?.coversSeq ?? afterSeq;
		return { checkpoint, rows, lastSeq, checkpointSeq, nextAfterSeq, more: nextAfter !== null };
	} catch {
		return null; // invalid base64
	}
}

export function createRelayHttp(opts: RelayHttpOptions): RelayHttp {
	const base = normalizeBaseUrl(opts.baseUrl);
	const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const now = (): number => (opts.clock ? opts.clock.now() : Date.now());
	const auth = `Bearer ${opts.credential}`;

	const vaultPath = (vaultId: string, rest: string): string => `${base}/vault/${encodeURIComponent(vaultId)}${rest}`;

	/** null = network failure. Never rejects. */
	async function call(url: string, init: { method: string; body?: BodyInit; contentType?: string }): Promise<HttpReply | null> {
		const headers: Record<string, string> = { Authorization: auth };
		if (init.contentType) headers["Content-Type"] = init.contentType;
		let res: Response;
		try {
			res = await doFetch(url, { method: init.method, headers, body: init.body });
		} catch {
			return null;
		}
		let body: Json | null = null;
		try {
			const text = await res.text();
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
		return { status: res.status, body, code, retryAfterMs };
	}

	function fail(route: string, reply: HttpReply | null): RelayHttpError {
		if (reply === null) return new RelayHttpError(route, 0, "network_error", null);
		return new RelayHttpError(route, reply.status, reply.code, reply.retryAfterMs);
	}

	function malformed(route: string, status: number): RelayHttpError {
		return new RelayHttpError(route, status, "malformed_response", null);
	}

	return {
		async ticket(vaultId) {
			const reply = await call(vaultPath(vaultId, "/auth/ticket"), {
				method: "POST",
				body: JSON.stringify({ purpose: "streams" }),
				contentType: "application/json",
			});
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

		async feed(vaultId, afterSeq, limit) {
			const q = `after=${afterSeq}${limit !== null ? `&limit=${limit}` : ""}`;
			const reply = await call(vaultPath(vaultId, `/streams/feed?${q}`), { method: "GET" });
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

		async read(vaultId, stream, afterSeq, preferCheckpoint, maxBytes) {
			const q = `stream=${encodeURIComponent(stream)}&after=${afterSeq}`
				+ (maxBytes !== null ? `&maxBytes=${maxBytes}` : "")
				+ (preferCheckpoint ? "&checkpoint=1" : "");
			const reply = await call(vaultPath(vaultId, `/streams/read?${q}`), { method: "GET" });
			if (reply === null || reply.status !== 200) throw fail("read", reply);
			const page = reply.body === null ? null : parsePage(reply.body, afterSeq);
			if (page === null) throw malformed("read", reply.status);
			return page;
		},

		async readBatch(vaultId, reqs, maxBytes) {
			let q = maxBytes !== null ? `maxBytes=${maxBytes}` : "";
			let sent = 0;
			for (const r of reqs) {
				const entry = `r=${r.afterSeq}.${r.preferCheckpoint ? 1 : 0}.${encodeURIComponent(r.stream)}`;
				if (sent > 0 && q.length + entry.length + 1 > READ_BATCH_MAX_QUERY_CHARS) break;
				q += `${q === "" ? "" : "&"}${entry}`;
				sent++;
			}
			if (sent === 0) throw new RangeError("readBatch: no requests");
			const reply = await call(vaultPath(vaultId, `/streams/read?${q}`), { method: "GET" });
			if (reply === null || reply.status !== 200) throw fail("read", reply);
			const raw = reply.body?.["pages"];
			if (!Array.isArray(raw) || raw.length === 0 || raw.length > sent) throw malformed("read", reply.status);
			const pages: ReadPage[] = [];
			for (let i = 0; i < raw.length; i++) {
				const item: unknown = raw[i];
				const page = isRecord(item) && item["stream"] === reqs[i]!.stream ? parsePage(item, reqs[i]!.afterSeq) : null;
				if (page === null) throw malformed("read", reply.status);
				pages.push(page);
			}
			return pages;
		},

		async putCheckpoint(vaultId, stream, coversSeq, expectedPrevCoversSeq, bytes) {
			const q = `stream=${encodeURIComponent(stream)}&coversSeq=${coversSeq}&expectedCoversSeq=${expectedPrevCoversSeq}`;
			const reply = await call(vaultPath(vaultId, `/streams/checkpoint?${q}`), {
				method: "PUT",
				body: bytes.slice(),
				contentType: "application/octet-stream",
			});
			if (reply === null) throw fail("checkpoint", reply);
			const { status, code, retryAfterMs } = reply;
			if (status === 200) return { t: "ok" };
			if (status === 409 && code === "checkpoint_conflict") {
				const current = reply.body !== null ? reply.body["current"] : undefined;
				const currentCoversSeq = isRecord(current) ? seqField(current, "coversSeq") : null;
				if (currentCoversSeq === null) throw malformed("checkpoint", status);
				return { t: "conflict", currentCoversSeq };
			}
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
