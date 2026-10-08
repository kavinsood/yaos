/**
 * SimBlobStore: the relay's R2 blob store as the sim sees it (relay-wire §11.3, §11.3.1), one per vault.
 *
 * - Upload times are the run's clock (the "server" clock: true time, never a device's skewed one); a PUT,
 *   overwrite included, refreshes the time like R2's `uploaded` (server/src/router.ts:787-807).
 * - list() answers address order after the cursor, `pageSize` at a time; `next` is the last address returned
 *   while more remain, so deletes between pages do not move the walk.
 * - deleteIfUploadedBefore() checks every address first, then deletes the old ones in one step, like the
 *   relay's HEADs-then-one-delete (server/src/router.ts:822-836): a PUT that lands in between (the
 *   `beforeDelete` hook) is still deleted and reported "deleted".
 * - Hooks run concurrent work at the two interesting points of a sweep; `fail` throws for one call.
 *
 * Transfer liveness. Devices get this store as their BlobPort directly (net.ts blobPort()): the sim runs no HTTP
 * adapter, so has / put / get here also stand in for the client side of adapters/httpBlob.ts, its transfer()
 * (httpBlob.ts:139-170):
 * - The caller's signal: aborted before the call, it rejects at once; aborted mid-call, the call rejects with the
 *   signal's reason (TransferLink's BlobLinkLostError when the session loop declares the link dead, the blob
 *   queue's stop). The listener is removed whenever the call settles.
 * - Idle window: a call in flight that moves no byte for `idleMs` (BLOB_TRANSFER_IDLE_MS) rejects
 *   RelayHttpError(<route>, 0, "stalled"), the adapter's error (its kick / end("stalled"), httpBlob.ts:159-166);
 *   every byte of progress restarts the window, so a call that keeps moving is never cut, however long it takes
 *   (httpBlob.ts:28-33).
 * - stall (setStall): "path", the store's network path black-holes, every route; "put", the server stops reading
 *   upload bodies (the adapter's evidence, httpBlob.ts:39-41: the server read 2 MiB, then never again, one
 *   progress event, then none, and the idle abort ended it) while exists and get answer. A call the stall
 *   covers that starts during it, and every such call in flight when it begins, moves no byte again: only its
 *   signal or its idle window ends it. Ending the stall does not revive those (a black-holed TCP stream does
 *   not resume on its own, which is why the adapter has the window); calls that start after it answer normally.
 * - slow (setSlow): a call that starts during a slow period moves CALL_OVERHEAD_BYTES plus its body (the PUT's
 *   sealed bytes, the GET's object, the exists list) at the given rate in SLOW_TICK_MS ticks, each a sign of
 *   progress that restarts the idle window; when the period ends, what is left moves at the next tick. A PUT
 *   stores at its end, a GET reads its object at its start, an exists answers at its end.
 * Without a stall or slow period every call answers at once with no timer and no added await (the store as it
 * was). list / delete are not modelled: the adapter bounds the GC routes by a size-proportional deadline, not an
 * idle window (gcCall, httpBlob.ts:299-305).
 * `liveness` counts what the two did (run stats); `slowCut` (an idle end of a call no stall caught) must stay 0.
 */

import { BLOB_DELETE_BATCH, BlobTooLargeError, type BlobDeleteResult, type BlobListItem, type BlobListPage, type BlobPort } from "../ports/blob";
import type { BlobAddress, SealedBlobParts } from "../ports/crypto";
import type { TimerHandle } from "../ports/clock";
import { concatBytes } from "../core/codec/lib0";
import { BLOB_TRANSFER_IDLE_MS, MAX_BLOB_UPLOAD_BYTES } from "../core/limits";
import { RelayHttpError } from "../engine/adapters/relayHttp";
import type { VirtualClock } from "./clock";

export type SimBlobRoute = "has" | "put" | "get" | "list" | "delete";
/** The routes with an idle window (the adapter's transfer()). */
export type SimTransferRoute = "has" | "put" | "get";
/** What a stall black-holes (see the header). */
export type SimStallScope = "path" | "put";

/** httpBlob.ts route names (its RelayHttpError messages). */
const WIRE: Readonly<Record<SimTransferRoute, string>> = { has: "blobs/exists", put: "blobs/put", get: "blobs/get" };
/** Bytes a call moves besides its body in the slow model: request and response headers. */
export const CALL_OVERHEAD_BYTES = 512;
/** One address in the exists body (`"<64 hex>",`). */
const EXISTS_BYTES_PER_ADDRESS = 67;
/** A slow call's progress step. */
export const SLOW_TICK_MS = 1_000;

export interface SimBlobHooks {
	/** Before a list page is computed (another device PUTs or deletes between pages). */
	beforeList?: (cursor: BlobAddress | null) => void | Promise<void>;
	/** After a delete call's checks, before its delete (the HEAD -> delete window). */
	beforeDelete?: (addresses: readonly BlobAddress[]) => void | Promise<void>;
	/** An error to throw for this call instead of answering (network, exhausted 429/503 retries). */
	fail?: (route: SimBlobRoute) => Error | null;
}

export interface SimBlobStoreOptions {
	/** The store's clock (ms). */
	readonly now: () => number;
	/** Timers and elapsed time of the stall / slow models (the run's VirtualClock); setStall / setSlow need it. */
	readonly timers?: Pick<VirtualClock, "setTimer" | "clearTimer" | "monotonic">;
	/** The idle window; default BLOB_TRANSFER_IDLE_MS. */
	readonly idleMs?: number;
	readonly pageSize?: number;
	/** The PUT cap in sealed bytes; default the relay's (MAX_BLOB_UPLOAD_BYTES). Over it, put throws BlobTooLargeError. */
	readonly maxBlobBytes?: number;
}

/** What the stall and slow models did (SimReport.stats.blobs). */
export interface SimBlobLiveness {
	/** Calls a stall caught (started during one, or in flight when it began), by route. */
	readonly stalled: Record<SimTransferRoute, number>;
	/** Calls started during a slow period, by route. */
	readonly slowed: Record<SimTransferRoute, number>;
	/** Calls the idle window ended ("stalled"). */
	watchdog: number;
	/** Calls their signal ended mid-call (link lost, queue stopped). */
	aborted: number;
	/** Slow calls that completed; the longest, and how many took longer than the idle window. */
	slowDone: number;
	slowMaxMs: number;
	slowOverIdle: number;
	/** Idle ends of calls no stall caught: a call that kept moving was cut. Must be 0. */
	slowCut: number;
}

export function emptyLiveness(): SimBlobLiveness {
	return {
		stalled: { has: 0, put: 0, get: 0 }, slowed: { has: 0, put: 0, get: 0 },
		watchdog: 0, aborted: 0, slowDone: 0, slowMaxMs: 0, slowOverIdle: 0, slowCut: 0,
	};
}

/** A has / put / get in flight under a stall or slow period. */
interface Call {
	readonly route: SimTransferRoute;
	readonly startedAt: number;
	/** Bytes still to move. */
	left: number;
	/** A stall caught it: it never moves again. */
	caught: boolean;
	tick: TimerHandle | null;
	idle: TimerHandle | null;
}

interface SimObject {
	readonly bytes: Uint8Array;
	readonly uploadedAt: number;
}

export class SimBlobStore implements BlobPort {
	readonly maxBlobBytes: number;
	readonly objects = new Map<BlobAddress, SimObject>();
	readonly calls: Record<SimBlobRoute, number> = { has: 0, put: 0, get: 0, list: 0, delete: 0 };
	/** Every address a delete call removed, in order. */
	readonly deleted: BlobAddress[] = [];
	hooks: SimBlobHooks = {};
	readonly liveness: SimBlobLiveness = emptyLiveness();
	private readonly pageSize: number;
	private readonly idleMs: number;
	private readonly inflight = new Set<Call>();
	private stall: SimStallScope | null = null;
	private rate: number | null = null;

	constructor(private readonly opts: SimBlobStoreOptions) {
		this.maxBlobBytes = opts.maxBlobBytes ?? MAX_BLOB_UPLOAD_BYTES;
		this.pageSize = opts.pageSize ?? 1000;
		this.idleMs = opts.idleMs ?? BLOB_TRANSFER_IDLE_MS;
	}

	/** The stall in force, null when there is none. */
	get stalled(): SimStallScope | null {
		return this.stall;
	}

	/** Bytes per second of the slow period, null when there is none. */
	get slowRate(): number | null {
		return this.rate;
	}

	/** The has / put / get calls in flight (a stall or slow period holds them), oldest first. */
	transfers(): readonly { readonly route: SimTransferRoute; readonly startedAt: number; readonly stalled: boolean }[] {
		return [...this.inflight].map((c) => ({ route: c.route, startedAt: c.startedAt, stalled: c.caught }));
	}

	/** Begin a stall over `scope`, or end it (null); ending it leaves the calls it caught dead (see the header). */
	setStall(scope: SimStallScope | null): void {
		if (scope !== null) this.clock();
		this.stall = scope;
		for (const c of this.inflight) if (this.stalls(c.route)) this.catch(c);
	}

	private stalls(route: SimTransferRoute): boolean {
		return this.stall === "path" || (this.stall === "put" && route === "put");
	}

	/** Begin a slow period at `bytesPerSec`, or end it (null). */
	setSlow(bytesPerSec: number | null): void {
		if (bytesPerSec !== null) {
			this.clock();
			if (!(bytesPerSec > 0)) throw new Error(`SimBlobStore: slow rate ${bytesPerSec} B/s`);
		}
		this.rate = bytesPerSec;
	}

	private clock(): NonNullable<SimBlobStoreOptions["timers"]> {
		const t = this.opts.timers;
		if (!t) throw new Error("SimBlobStore: the stall and slow models need the run's clock (timers)");
		return t;
	}

	private enter(route: SimBlobRoute, signal?: AbortSignal): void {
		if (signal?.aborted) throw signal.reason;
		this.calls[route]++;
		const error = this.hooks.fail?.(route) ?? null;
		if (error) throw error;
	}

	private catch(c: Call): void {
		if (c.caught) return;
		c.caught = true;
		this.liveness.stalled[c.route]++;
		if (c.tick !== null) this.clock().clearTimer(c.tick);
		c.tick = null;
	}

	/**
	 * Moves `bytes` for one call: null (answer now) outside a stall or slow period, else a promise that settles
	 * when they moved, or rejects when the signal or the idle window ends the call.
	 */
	private move(route: SimTransferRoute, bytes: number, signal: AbortSignal | undefined): Promise<void> | null {
		const stalled = this.stalls(route);
		if (!stalled && this.rate === null) return null;
		const clock = this.clock();
		const c: Call = { route, startedAt: clock.monotonic(), left: bytes, caught: false, tick: null, idle: null };
		this.inflight.add(c);
		if (stalled) this.catch(c);
		else this.liveness.slowed[route]++;
		return new Promise<void>((resolve, reject) => {
			const settle = (error: unknown): void => {
				if (!this.inflight.delete(c)) return;
				if (c.tick !== null) clock.clearTimer(c.tick);
				if (c.idle !== null) clock.clearTimer(c.idle);
				c.tick = c.idle = null;
				signal?.removeEventListener("abort", onAbort);
				if (error === null) resolve();
				else reject(error);
			};
			const onAbort = (): void => {
				this.liveness.aborted++;
				settle(signal!.reason);
			};
			const kick = (): void => {
				if (c.idle !== null) clock.clearTimer(c.idle);
				c.idle = clock.setTimer(this.idleMs, () => {
					c.idle = null;
					this.liveness.watchdog++;
					if (!c.caught) this.liveness.slowCut++;
					settle(new RelayHttpError(WIRE[route], 0, "stalled", null));
				}, "sim-blob-idle");
			};
			const done = (): void => {
				const ms = clock.monotonic() - c.startedAt;
				this.liveness.slowDone++;
				this.liveness.slowMaxMs = Math.max(this.liveness.slowMaxMs, ms);
				if (ms > this.idleMs) this.liveness.slowOverIdle++;
				settle(null);
			};
			const step = (): void => {
				c.tick = null;
				if (c.caught) return;
				const rate = this.rate;
				if (rate === null) {
					done();
					return;
				}
				const chunk = (rate * SLOW_TICK_MS) / 1000;
				const last = c.left <= chunk;
				c.tick = clock.setTimer(last ? Math.ceil((c.left / rate) * 1000) : SLOW_TICK_MS, () => {
					c.tick = null;
					c.left = Math.max(0, c.left - chunk);
					kick();
					if (last) done();
					else step();
				}, "sim-blob-tick");
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			kick();
			step();
		});
	}

	async has(addresses: readonly BlobAddress[], signal?: AbortSignal): Promise<ReadonlySet<BlobAddress>> {
		this.enter("has", signal);
		const moving = this.move("has", CALL_OVERHEAD_BYTES + EXISTS_BYTES_PER_ADDRESS * addresses.length, signal);
		if (moving) await moving;
		return new Set(addresses.filter((a) => this.objects.has(a)));
	}

	async put(address: BlobAddress, parts: SealedBlobParts, signal?: AbortSignal): Promise<void> {
		this.enter("put", signal);
		const bytes = concatBytes(parts);
		// The edge answers 413 from the Content-Length, before the body moves.
		if (bytes.byteLength > this.maxBlobBytes) throw new BlobTooLargeError(bytes.byteLength);
		const moving = this.move("put", CALL_OVERHEAD_BYTES + bytes.byteLength, signal);
		if (moving) await moving;
		this.objects.set(address, { bytes, uploadedAt: this.opts.now() });
	}

	async get(address: BlobAddress, signal?: AbortSignal): Promise<Uint8Array | null> {
		this.enter("get", signal);
		const o = this.objects.get(address);
		const moving = this.move("get", CALL_OVERHEAD_BYTES + (o?.bytes.byteLength ?? 0), signal);
		if (moving) await moving;
		return o?.bytes.slice() ?? null;
	}

	async list(cursor: BlobAddress | null, signal?: AbortSignal): Promise<BlobListPage> {
		if (signal?.aborted) throw new Error("sim blob list: aborted");
		this.enter("list");
		await this.hooks.beforeList?.(cursor);
		const after = [...this.objects.keys()].filter((a) => cursor === null || a > cursor).sort();
		const page = after.slice(0, this.pageSize);
		const items: BlobListItem[] = page.map((address) => ({ address, uploadedAt: this.objects.get(address)!.uploadedAt }));
		return { items, next: after.length > page.length ? page[page.length - 1]! : null };
	}

	async deleteIfUploadedBefore(addresses: readonly BlobAddress[], cutoffMs: number, signal?: AbortSignal): Promise<readonly BlobDeleteResult[]> {
		if (signal?.aborted) throw new Error("sim blob delete: aborted");
		if (addresses.length === 0 || addresses.length > BLOB_DELETE_BATCH || new Set(addresses).size !== addresses.length) {
			throw new Error("sim blob delete: 400 invalid_addresses");
		}
		this.enter("delete");
		const results = addresses.map((address): BlobDeleteResult => {
			const o = this.objects.get(address);
			if (!o) return { address, result: "absent" };
			return o.uploadedAt < cutoffMs ? { address, result: "deleted", uploadedAt: o.uploadedAt } : { address, result: "newer", uploadedAt: o.uploadedAt };
		});
		await this.hooks.beforeDelete?.(addresses);
		for (const r of results) {
			if (r.result !== "deleted") continue;
			this.objects.delete(r.address);
			this.deleted.push(r.address);
		}
		return results;
	}

	uploadedAt(address: BlobAddress): number | null {
		return this.objects.get(address)?.uploadedAt ?? null;
	}
}
