/**
 * Bootstrap trace for the e2e harness (bootBench.ts): wraps one FullClient's production ports to time every relay
 * HTTP call (by route), the streams socket (constructed -> open -> VAULT_READY), every storage transaction, and
 * samples the engine (phase, reads in flight, feed pages) and the disk (write count) every few ms.
 *
 * Never records secrets: URLs are reduced to their route (no query, no ticket), headers are not kept.
 */
import type { SchemaShape, StorageDb, StoragePort, StoreName } from "../../src/ports/storage";
import type { WebSocketCtor, WebSocketLike } from "../../src/engine/adapters/wsRelay";

export interface HttpEvent { route: string; startMs: number; ms: number; status: number; bytes: number; streams: number }
export interface TxEvent { stores: string; mode: string; startMs: number; ms: number }
export interface Sample { t: number; phase: string | null; reads: number; feeding: boolean; writes: number; readsDone: number; feedPages: number }

function routeOf(url: string): { route: string; streams: number } {
	const u = new URL(url);
	const p = u.pathname.replace(/^\/vault\/[^/]+/, "");
	const streams = u.searchParams.getAll("stream").length;
	return { route: p.startsWith("/blobs") ? "/blobs" : p, streams };
}

export class BootTrace {
	t0 = performance.now();
	readonly http: HttpEvent[] = [];
	readonly tx: TxEvent[] = [];
	readonly samples: Sample[] = [];
	readonly ws: { ctorMs: number; openMs: number | null; readyMs: number | null }[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	now(): number {
		return performance.now() - this.t0;
	}

	reset(): void {
		this.t0 = performance.now();
		this.http.length = 0;
		this.tx.length = 0;
		this.samples.length = 0;
		this.ws.length = 0;
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const { route, streams } = routeOf(url);
		const s = this.now();
		const res = await fetch(input, init);
		const buf = await res.arrayBuffer();
		this.http.push({ route, startMs: s, ms: this.now() - s, status: res.status, bytes: buf.byteLength, streams });
		return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
	};

	get WebSocket(): WebSocketCtor {
		const trace = this;
		const Base = globalThis.WebSocket as unknown as WebSocketCtor;
		return class TracedWs {
			constructor(url: string) {
				const rec = { ctorMs: trace.now(), openMs: null as number | null, readyMs: null as number | null };
				trace.ws.push(rec);
				const ws = new Base(url) as WebSocketLike & { addEventListener(t: string, f: (e: MessageEvent) => void): void };
				ws.addEventListener("open", () => { rec.openMs = trace.now(); });
				ws.addEventListener("message", (e: MessageEvent) => {
					if (rec.readyMs === null && typeof e.data === "string" && e.data.includes("VAULT_READY")) rec.readyMs = trace.now();
				});
				return ws;
			}
		} as unknown as WebSocketCtor;
	}

	wrapStorage(inner: StoragePort): StoragePort {
		const trace = this;
		return {
			...inner,
			async open<S extends SchemaShape>(name: string, version: number, stores: Parameters<StoragePort["open"]>[2]) {
				const db = await inner.open<S>(name, version, stores as never);
				const wrapped: StorageDb<S> = {
					name: db.name,
					tx<T>(st: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: Parameters<StorageDb<S>["tx"]>[2]): Promise<T> {
						const s = trace.now();
						return db.tx(st, mode, body as never).finally(() => {
							trace.tx.push({ stores: [...st].sort().join(","), mode, startMs: s, ms: trace.now() - s });
						}) as Promise<T>;
					},
					close: () => db.close(),
					onLost: (l) => db.onLost(l),
				};
				return wrapped;
			},
		};
	}

	/** Samples `probe` every `everyMs` until stop(). */
	sample(probe: () => Omit<Sample, "t">, everyMs = 5): void {
		this.stop();
		this.timer = setInterval(() => this.samples.push({ t: this.now(), ...probe() }), everyMs);
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}
}
