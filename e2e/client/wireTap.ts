/**
 * Harness-side wire timeline for the full-client latency runs (fullLatency.ts, fullScenarios1.ts). One tap per
 * vault records, in performance.now() time:
 *   - each client's APPEND (the frame handed to its socket) and the receipt it got for it;
 *   - each client's COMMITTED / COMMIT_NOTICE and PROVISIONAL arrivals (any device's frames);
 *   - each client's STREAM_SKIPPED rows (another device's b:/c: rows outside its subscription, relay-wire §5.6) and
 *     COMMIT_NOTICEs without a payload: both leave the stream stale until a read;
 *   - each client's HTTP reads (read / readBatch): request start, response, and the seq each page covers;
 *   - each client's engine writes to vault and config paths (SimVault onMutation, by "sync");
 *   - the relay's group-commit limits, read from VAULT_READY.limits.groupCommit (relay-wire.md §3.2; the
 *     client's wsRelay mapLimits drops them).
 * FullClient feeds it from its NetSwitch session wrapper and a WebSocket wrapper: no production hook.
 *
 * quiet() waits until the relay has had no commit for longer than groupCommit.quietMs (+ a margin), seen as the
 * newest receipt or COMMITTED arrival on any client, with no APPEND still waiting for its receipt. Then the next
 * append opens an empty buffer after the quiet time and takes the relay's leading-edge commit
 * (server/src/streams/relay.ts schedule(): lead only when pending.length === 1 and now - lastCommitAt >= quietMs).
 */
import type { AppendFrame, ReadPage, RelayEvent } from "../../src/ports/relay";
import { CONTROL_PREFIX } from "../../src/engine/adapters/relayFrames";
import type { WebSocketCtor, WebSocketLike } from "../../src/engine/adapters/wsRelay";
import type { Report } from "./engineKit";

export interface GroupCommitLimits {
	readonly idleMs: number;
	readonly maxMs: number;
	readonly maxBytes: number;
	readonly minIntervalMs: number;
	readonly leadMs: number;
	readonly quietMs: number;
}

export interface SessionTap {
	append(frame: AppendFrame): void;
	event(e: RelayEvent): void;
	/** One read / readBatch answered: the streams asked, the request's start (performance.now()) and its pages. */
	read?(streams: readonly string[], start: number, pages: readonly ReadPage[]): void;
}

interface Sent {
	readonly key: string;
	readonly stream: string;
	readonly t: number;
	receiptAt: number | null;
	/** The seq the relay gave it (from the receipt). */
	seq: number | null;
}

/** A row a client did not get pushed: STREAM_SKIPPED, or a COMMIT_NOTICE without its payload. */
interface Notice { readonly seq: number; readonly t: number }
/** A page a client read: rows and checkpoint of `stream` through seq `through`, requested at start, answered at end. */
interface ReadRec { readonly stream: string; readonly start: number; readonly end: number; readonly through: number }

/**
 * How the critical frame reached the peer:
 *   pushed  its payload came on the socket (COMMITTED, or PROVISIONAL for an open editor): a subscribed stream;
 *   read    STREAM_SKIPPED (or a payload-less COMMIT_NOTICE) on the socket, then an HTTP read that covered it: a
 *           stream outside the peer's subscription, read once its deferral ran out (DESIGN §d.7), or at once when
 *           the disk side wants it (wantFresh: a create).
 */
export type DeliveryPath = "pushed" | "read";

/** One lone sample split at the critical frame: the last of the sender's frames the peer needed. */
export interface Breakdown {
	readonly path: DeliveryPath;
	/** Local change -> the critical frame's APPEND on the sender's socket. */
	readonly sender: number;
	/** That APPEND -> the frame on the peer: its pushed arrival, or (path read) the response of the read that covered it. */
	readonly relay: number;
	/** That arrival -> bytes on the peer's disk (or in its open view). */
	readonly receiver: number;
	/** Path read: the APPEND -> the frame's skip notice on the peer (null: the read came first). */
	readonly skip: number | null;
	/** Path read: the skip notice (else the APPEND) -> the read's request. Holds the deferral. */
	readonly defer: number | null;
	/** Path read: the newest skip of the stream on the peer before the read -> the read's request (the quiet the deferral waited for). */
	readonly quiet: number | null;
	/** Path read: the read's request -> its response. */
	readonly read: number | null;
	/** The critical frame's APPEND -> the sender's receipt (the relay's commit, seen by the sender). */
	readonly receipt: number | null;
	/** Local change -> the sender's first APPEND. */
	readonly firstAppend: number;
	/** The sender's APPENDs between the change and the arrival. */
	readonly frames: number;
	/** The critical frame's stream kind (ns, b, c, ...). */
	readonly stream: string;
}

export interface SampleRow {
	readonly peer: string;
	readonly total: number;
	/** The peer engine's writes of the path during the sample (vault paths only). */
	readonly writes?: number;
	readonly split: Breakdown | null;
}

const keyOf = (deviceId: string, stream: string, cfid: string) => `${deviceId}\u0000${stream}\u0000${cfid}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** An APPEND older than this without a receipt is not waited for (a dropped session, a refused frame's echo). */
const UNRECEIPTED_HORIZON_MS = 10_000;

export class WireTap {
	groupCommit: GroupCommitLimits | null = null;
	/** Per-sample rows by metric (recordSample), for the results file. */
	readonly samples: Record<string, SampleRow[]> = {};
	/** Newest receipt or COMMITTED / COMMIT_NOTICE seen on any client. */
	lastCommitAt = Number.NEGATIVE_INFINITY;
	private readonly sent = new Map<string, Sent[]>();
	private readonly byKey = new Map<string, Sent>();
	private readonly arrivals = { committed: new Map<string, Map<string, number>>(), provisional: new Map<string, Map<string, number>>() };
	private readonly unreceipted = new Map<string, { readonly client: string; readonly t: number }>();
	/** client -> stream -> rows not pushed to it, oldest first. */
	private readonly notices = new Map<string, Map<string, Notice[]>>();
	/** client -> pages it read, oldest first. */
	private readonly reads = new Map<string, ReadRec[]>();
	private readonly writes = new Map<string, number[]>();

	/** The session hooks for one client (NetSwitch). */
	forClient(client: string, deviceId: string): SessionTap {
		return {
			append: (f) => {
				const t = performance.now();
				const key = keyOf(deviceId, f.stream, f.clientFrameId);
				const s: Sent = { key, stream: f.stream, t, receiptAt: null, seq: null };
				let list = this.sent.get(client);
				if (!list) this.sent.set(client, (list = []));
				list.push(s);
				this.byKey.set(key, s);
				this.unreceipted.set(key, { client, t });
			},
			event: (e) => {
				const t = performance.now();
				switch (e.t) {
					case "receipt": {
						const key = keyOf(deviceId, e.stream, e.clientFrameId);
						const s = this.byKey.get(key);
						if (s && s.receiptAt === null) {
							s.receiptAt = t;
							s.seq = e.seq;
						}
						this.unreceipted.delete(key);
						this.lastCommitAt = t;
						break;
					}
					case "refused":
						this.unreceipted.delete(keyOf(deviceId, e.stream, e.clientFrameId));
						break;
					case "committed":
						// A payload-less COMMIT_NOTICE leaves the stream stale: the frame reaches the engine through a read.
						if (e.frame.payload === null) this.notice(client, e.frame.stream, e.frame.seq, t);
						else this.arrive(this.arrivals.committed, keyOf(e.frame.deviceId, e.frame.stream, e.frame.clientFrameId), client, t);
						this.lastCommitAt = t;
						break;
					case "skipped":
						for (const r of e.rows) this.notice(client, r.stream, r.seq, t);
						this.lastCommitAt = t;
						break;
					case "provisional":
						this.arrive(this.arrivals.provisional, keyOf(e.deviceId, e.stream, e.clientFrameId), client, t);
						break;
					case "closed":
						for (const [k, u] of this.unreceipted) if (u.client === client) this.unreceipted.delete(k);
						break;
					default:
						break;
				}
			},
			read: (streams, start, pages) => {
				const end = performance.now();
				let list = this.reads.get(client);
				if (!list) this.reads.set(client, (list = []));
				for (const [i, p] of pages.entries()) {
					// A page covers its rows and checkpoint; the last page of a stream covers everything committed at read time.
					const through = Math.max(p.rows.at(-1)?.seq ?? 0, p.checkpoint?.coversSeq ?? 0, p.more ? 0 : p.lastSeq);
					list.push({ stream: streams[i]!, start, end, through });
				}
			},
		};
	}

	/** A WebSocket constructor that reads VAULT_READY.limits.groupCommit off every socket `base` opens. */
	webSocket(base?: WebSocketCtor): WebSocketCtor {
		const Base = base ?? (globalThis.WebSocket as unknown as WebSocketCtor);
		const onReady = (text: string) => {
			let gc: Record<string, unknown> | undefined;
			try {
				gc = (JSON.parse(text.slice(CONTROL_PREFIX.length)) as { limits?: { groupCommit?: Record<string, unknown> } }).limits?.groupCommit;
			} catch {
				return; // not ours to judge: the adapter parses the same frame
			}
			const n = (k: string) => (typeof gc?.[k] === "number" ? gc[k] : NaN);
			const limits = { idleMs: n("idleMs"), maxMs: n("maxMs"), maxBytes: n("maxBytes"), minIntervalMs: n("minIntervalMs"), leadMs: n("leadMs"), quietMs: n("quietMs") };
			if (Object.values(limits).every(Number.isFinite)) this.groupCommit = limits;
		};
		return class TappedWs {
			constructor(url: string) {
				const ws = new Base(url) as WebSocketLike & { addEventListener(t: string, f: (e: MessageEvent) => void): void };
				ws.addEventListener("message", (e: MessageEvent) => {
					if (typeof e.data === "string" && e.data.startsWith(CONTROL_PREFIX) && e.data.includes("\"VAULT_READY\"")) onReady(e.data);
				});
				return ws;
			}
		} as unknown as WebSocketCtor;
	}

	/** `client`'s engine wrote, renamed or trashed `path` (a config path is prefixed with the config dir). */
	disk(client: string, path: string): void {
		const k = `${client}\u0000${path}`;
		let list = this.writes.get(k);
		if (!list) this.writes.set(k, (list = []));
		list.push(performance.now());
	}

	/** `client`'s engine writes to `path` in [from, to]: the count and the newest time. */
	diskWrites(client: string, path: string, from: number, to: number): { readonly n: number; readonly last: number | null } {
		const ts = (this.writes.get(`${client}\u0000${path}`) ?? []).filter((t) => t >= from && t <= to);
		return { n: ts.length, last: ts.length > 0 ? ts[ts.length - 1]! : null };
	}

	/** Waits until no commit for more than quietMs + marginMs and no APPEND awaits its receipt; returns the wait. */
	async quiet(marginMs: number, timeoutMs = 30_000): Promise<number> {
		const gc = this.groupCommit;
		if (!gc) throw new Error("no VAULT_READY.limits.groupCommit seen");
		const t0 = performance.now();
		for (;;) {
			const now = performance.now();
			for (const [k, u] of this.unreceipted) if (now - u.t > UNRECEIPTED_HORIZON_MS) this.unreceipted.delete(k);
			const left = gc.quietMs + marginMs - (now - this.lastCommitAt);
			if (this.unreceipted.size === 0 && left < 0) return now - t0;
			if (now - t0 > timeoutMs) throw new Error(`relay not quiet after ${timeoutMs} ms (${this.unreceipted.size} unreceipted)`);
			await sleep(this.unreceipted.size > 0 ? 10 : Math.max(2, Math.ceil(left) + 1));
		}
	}

	/**
	 * How `s` reached `peer` by `done`: pushed (its `via` arrival), else read (the earliest read of its stream started
	 * after the APPEND, answered by `done`, that covered its seq; with the skip notice, if one came). null: neither.
	 */
	private delivery(s: Sent, peer: string, done: number, via: "committed" | "provisional"): { readonly at: number; readonly path: DeliveryPath; readonly notice: number | null; readonly readStart: number | null; readonly quietFrom: number | null } | null {
		const pushed = this.arrivals[via].get(s.key)?.get(peer);
		if (pushed !== undefined && pushed <= done) return { at: pushed, path: "pushed", notice: null, readStart: null, quietFrom: null };
		if (s.seq === null) return null;
		const seq = s.seq;
		let rd: ReadRec | null = null;
		for (const r of this.reads.get(peer) ?? []) if (r.stream === s.stream && r.start >= s.t && r.end <= done && r.through >= seq && (rd === null || r.end < rd.end)) rd = r;
		if (!rd) return null;
		const ns = this.notices.get(peer)?.get(s.stream) ?? [];
		const notice = ns.find((n) => n.seq === seq)?.t ?? null;
		let quietFrom: number | null = null;
		for (const n of ns) if (n.t <= rd.start) quietFrom = n.t;
		return { at: rd.end, path: "read", notice, readStart: rd.start, quietFrom };
	}

	/**
	 * Splits sender -> peer at the critical frame: of the sender's APPENDs in [t0, done], the one that reached the
	 * peer last at or before `done`, pushed or read (delivery()). null when none did.
	 */
	breakdown(sender: string, peer: string, t0: number, done: number, via: "committed" | "provisional" = "committed"): Breakdown | null {
		const frames = (this.sent.get(sender) ?? []).filter((s) => s.t >= t0 && s.t <= done);
		let crit: Sent | null = null;
		let d: ReturnType<WireTap["delivery"]> = null;
		for (const s of frames) {
			const x = this.delivery(s, peer, done, via);
			if (x && (d === null || x.at >= d.at)) {
				crit = s;
				d = x;
			}
		}
		if (!crit || !d) return null;
		const read = d.path === "read" && d.readStart !== null;
		return {
			path: d.path, sender: crit.t - t0, relay: d.at - crit.t, receiver: done - d.at,
			skip: read && d.notice !== null ? d.notice - crit.t : null,
			defer: read ? d.readStart! - (d.notice ?? crit.t) : null,
			quiet: read && d.quietFrom !== null ? d.readStart! - d.quietFrom : null,
			read: read ? d.at - d.readStart! : null,
			receipt: crit.receiptAt === null ? null : crit.receiptAt - crit.t,
			firstAppend: frames[0]!.t - t0, frames: frames.length, stream: crit.stream.split(":")[0] ?? crit.stream,
		};
	}

	/**
	 * The sender's APPENDs in [t0, done], oldest first: stream kind, then the APPEND, the sender's receipt, the
	 * delivery on the peer (pushed arrival or read response) and, for path read, the skip notice and the read's
	 * request, in ms after t0 (null = not seen).
	 */
	timeline(sender: string, peer: string, t0: number, done: number, via: "committed" | "provisional" = "committed") {
		const rel = (t: number | null) => (t === null ? null : r1(t - t0));
		return (this.sent.get(sender) ?? []).filter((s) => s.t >= t0 && s.t <= done).map((s) => {
			const d = this.delivery(s, peer, done, via);
			return { stream: s.stream.split(":")[0] ?? s.stream, append: r1(s.t - t0), receipt: rel(s.receiptAt), path: d?.path ?? null, arrival: rel(d?.at ?? null),
				skip: rel(d?.notice ?? null), readStart: rel(d?.readStart ?? null) };
		});
	}

	private notice(client: string, stream: string, seq: number, t: number): void {
		let per = this.notices.get(client);
		if (!per) this.notices.set(client, (per = new Map()));
		let list = per.get(stream);
		if (!list) per.set(stream, (list = []));
		list.push({ seq, t });
	}

	private arrive(m: Map<string, Map<string, number>>, key: string, client: string, t: number): void {
		let per = m.get(key);
		if (!per) m.set(key, (per = new Map()));
		if (!per.has(client)) per.set(client, t);
	}
}

const r1 = (ms: number) => Math.round(ms * 10) / 10;

/**
 * Records `<base>_ms` (t0 -> done, every sample) and, split at the critical frame, per delivery path
 * (`pushed`: the stream was in the peer's subscription; `read`: skipped, then read): `<base>_<path>_ms`,
 * `_<path>_sender_ms`, `_<path>_relay_ms`, `_<path>_receiver_ms`, and for path read `_read_skip_ms`,
 * `_read_defer_ms`, `_read_quiet_ms`, `_read_read_ms`. Keeps the row in tap.samples[base].
 */
export function recordSample(R: Report, tap: WireTap, base: string, sender: string, peer: string, t0: number, done: number,
	via: "committed" | "provisional" = "committed", writes?: number): Breakdown | null {
	R.record(`${base}_ms`, done - t0);
	const b = tap.breakdown(sender, peer, t0, done, via);
	if (b) {
		const p = `${base}_${b.path}`;
		R.record(`${p}_ms`, done - t0);
		R.record(`${p}_sender_ms`, b.sender);
		R.record(`${p}_relay_ms`, b.relay);
		R.record(`${p}_receiver_ms`, b.receiver);
		for (const k of ["skip", "defer", "quiet", "read"] as const) {
			const v = b[k];
			if (v !== null) R.record(`${p}_${k}_ms`, v);
		}
	}
	const n1 = (v: number | null) => (v === null ? null : r1(v));
	const split = b && { ...b, sender: r1(b.sender), relay: r1(b.relay), receiver: r1(b.receiver), skip: n1(b.skip), defer: n1(b.defer), quiet: n1(b.quiet),
		read: n1(b.read), receipt: n1(b.receipt), firstAppend: r1(b.firstAppend) };
	(tap.samples[base] ??= []).push({ peer, total: r1(done - t0), ...(writes !== undefined ? { writes } : {}), split });
	return b;
}
