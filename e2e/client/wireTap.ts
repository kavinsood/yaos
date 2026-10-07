/**
 * Harness-side wire timeline for the full-client latency runs (fullLatency.ts, fullScenarios1.ts). One tap per
 * vault records, in performance.now() time:
 *   - each client's APPEND (the frame handed to its socket) and the receipt it got for it;
 *   - each client's COMMITTED / COMMIT_NOTICE and PROVISIONAL arrivals (any device's frames);
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
import type { AppendFrame, RelayEvent } from "../../src/ports/relay";
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
}

interface Sent {
	readonly key: string;
	readonly stream: string;
	readonly t: number;
	receiptAt: number | null;
}

/** One lone sample split at the critical frame: the last of the sender's frames the peer needed. */
export interface Breakdown {
	/** Local change -> the critical frame's APPEND on the sender's socket. */
	readonly sender: number;
	/** That APPEND -> its COMMITTED / COMMIT_NOTICE (or PROVISIONAL, for an open editor) on the peer. */
	readonly relay: number;
	/** That arrival -> bytes on the peer's disk (or in its open view). */
	readonly receiver: number;
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
	private readonly writes = new Map<string, number[]>();

	/** The session hooks for one client (NetSwitch). */
	forClient(client: string, deviceId: string): SessionTap {
		return {
			append: (f) => {
				const t = performance.now();
				const key = keyOf(deviceId, f.stream, f.clientFrameId);
				const s: Sent = { key, stream: f.stream, t, receiptAt: null };
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
						if (s && s.receiptAt === null) s.receiptAt = t;
						this.unreceipted.delete(key);
						this.lastCommitAt = t;
						break;
					}
					case "refused":
						this.unreceipted.delete(keyOf(deviceId, e.stream, e.clientFrameId));
						break;
					case "committed":
						this.arrive(this.arrivals.committed, keyOf(e.frame.deviceId, e.frame.stream, e.frame.clientFrameId), client, t);
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
		};
	}

	/** A WebSocket constructor that reads VAULT_READY.limits.groupCommit off every socket `base` opens. */
	webSocket(base?: WebSocketCtor): WebSocketCtor {
		const Base = base ?? (globalThis.WebSocket as unknown as WebSocketCtor);
		const onReady = (text: string) => {
			const gc = (JSON.parse(text) as { limits?: { groupCommit?: Record<string, unknown> } }).limits?.groupCommit;
			const n = (k: string) => (typeof gc?.[k] === "number" ? gc[k] : NaN);
			const limits = { idleMs: n("idleMs"), maxMs: n("maxMs"), maxBytes: n("maxBytes"), minIntervalMs: n("minIntervalMs"), leadMs: n("leadMs"), quietMs: n("quietMs") };
			if (Object.values(limits).every(Number.isFinite)) this.groupCommit = limits;
		};
		return class TappedWs {
			constructor(url: string) {
				const ws = new Base(url) as WebSocketLike & { addEventListener(t: string, f: (e: MessageEvent) => void): void };
				ws.addEventListener("message", (e: MessageEvent) => {
					if (typeof e.data === "string" && e.data.includes("\"VAULT_READY\"")) onReady(e.data);
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
	 * Splits sender -> peer at the critical frame: of the sender's APPENDs in [t0, done], the one whose
	 * `via` arrival on the peer is the newest at or before `done`. null when none arrived.
	 */
	breakdown(sender: string, peer: string, t0: number, done: number, via: "committed" | "provisional" = "committed"): Breakdown | null {
		const frames = (this.sent.get(sender) ?? []).filter((s) => s.t >= t0 && s.t <= done);
		let crit: Sent | null = null;
		let at = Number.NEGATIVE_INFINITY;
		for (const s of frames) {
			const t = this.arrivals[via].get(s.key)?.get(peer);
			if (t !== undefined && t <= done && t >= at) {
				crit = s;
				at = t;
			}
		}
		if (!crit) return null;
		return {
			sender: crit.t - t0, relay: at - crit.t, receiver: done - at, receipt: crit.receiptAt === null ? null : crit.receiptAt - crit.t,
			firstAppend: frames[0]!.t - t0, frames: frames.length, stream: crit.stream.split(":")[0] ?? crit.stream,
		};
	}

	private arrive(m: Map<string, Map<string, number>>, key: string, client: string, t: number): void {
		let per = m.get(key);
		if (!per) m.set(key, (per = new Map()));
		if (!per.has(client)) per.set(client, t);
	}
}

const r1 = (ms: number) => Math.round(ms * 10) / 10;

/**
 * Records `<base>_ms` (t0 -> done) and, split at the critical frame, `<base>_sender_ms`, `_relay_ms` and
 * `_receiver_ms`; keeps the row in tap.samples[base].
 */
export function recordSample(R: Report, tap: WireTap, base: string, sender: string, peer: string, t0: number, done: number,
	via: "committed" | "provisional" = "committed", writes?: number): Breakdown | null {
	R.record(`${base}_ms`, done - t0);
	const b = tap.breakdown(sender, peer, t0, done, via);
	if (b) {
		R.record(`${base}_sender_ms`, b.sender);
		R.record(`${base}_relay_ms`, b.relay);
		R.record(`${base}_receiver_ms`, b.receiver);
	}
	const split = b && { ...b, sender: r1(b.sender), relay: r1(b.relay), receiver: r1(b.receiver), receipt: b.receipt === null ? null : r1(b.receipt), firstAppend: r1(b.firstAppend) };
	(tap.samples[base] ??= []).push({ peer, total: r1(done - t0), ...(writes !== undefined ? { writes } : {}), split });
	return b;
}
