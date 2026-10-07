/**
 * Test support for the relay adapters (not used by production code): a manual
 * ClockPort, a scriptable fake WebSocket and a routed fake fetch. Kept free of
 * Node APIs so it typechecks under the production tsconfig as well.
 */

import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { WebSocketCtor, WebSocketLike } from "./wsRelay";
import { CONTROL_PREFIX, decodeAppend, encodeServerFrame, type WireAppend, type WireServerFrame } from "./relayFrames";

export class ManualClock implements ClockPort {
	private mono = 0;
	private readonly timers = new Map<TimerHandle, { at: number; fn: () => void }>();
	private nextHandle = 1;
	constructor(private readonly wallBase = 1_700_000_000_000) {}

	now(): number { return this.wallBase + this.mono; }
	monotonic(): number { return this.mono; }
	setTimer(delayMs: number, fn: () => void): TimerHandle {
		const handle = this.nextHandle++;
		this.timers.set(handle, { at: this.mono + Math.max(0, delayMs), fn });
		return handle;
	}
	clearTimer(handle: TimerHandle): void { this.timers.delete(handle); }
	yieldNow(): Promise<void> { return Promise.resolve(); }

	get pendingTimers(): number { return this.timers.size; }

	/** Advances time, firing due timers in deadline order (timers set by timers included). */
	advance(ms: number): void {
		const target = this.mono + ms;
		for (;;) {
			let due: [TimerHandle, { at: number; fn: () => void }] | null = null;
			for (const entry of this.timers) if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
			if (due === null) break;
			this.timers.delete(due[0]);
			this.mono = Math.max(this.mono, due[1].at);
			due[1].fn();
		}
		this.mono = target;
	}
}

export class FakeSocket implements WebSocketLike {
	binaryType = "blob";
	bufferedAmount = 0;
	readyState = 0;
	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;
	readonly sent: (string | Uint8Array)[] = [];
	clientClose: { code: number | undefined; reason: string | undefined } | null = null;

	constructor(readonly url: string) {}

	send(data: string | ArrayBufferLike | ArrayBufferView): void {
		if (this.readyState !== 1) throw new Error("fake socket not open");
		if (typeof data === "string") this.sent.push(data);
		else if (ArrayBuffer.isView(data)) this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
		else this.sent.push(new Uint8Array(data).slice());
	}

	close(code?: number, reason?: string): void {
		this.clientClose = { code, reason };
		this.readyState = 2;
	}

	// ---- server side ----

	accept(): void {
		this.readyState = 1;
		this.onopen?.({ type: "open" } as Event);
	}

	text(raw: string): void {
		this.onmessage?.({ data: raw } as MessageEvent);
	}

	control(message: Readonly<Record<string, unknown>>): void {
		this.text(CONTROL_PREFIX + JSON.stringify(message));
	}

	binary(frame: WireServerFrame | Uint8Array): void {
		const bytes = frame instanceof Uint8Array ? frame : encodeServerFrame(frame);
		this.onmessage?.({ data: bytes.slice().buffer } as MessageEvent);
	}

	serverClose(code: number, wasClean = true, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason, wasClean } as CloseEvent);
	}

	sentControls(): Record<string, unknown>[] {
		const out: Record<string, unknown>[] = [];
		for (const item of this.sent) {
			if (typeof item !== "string" || !item.startsWith(CONTROL_PREFIX)) continue;
			const parsed: unknown = JSON.parse(item.slice(CONTROL_PREFIX.length));
			if (typeof parsed === "object" && parsed !== null) out.push({ ...parsed });
		}
		return out;
	}

	sentAppends(): WireAppend[] {
		const out: WireAppend[] = [];
		for (const item of this.sent) {
			if (typeof item === "string") continue;
			const frame = decodeAppend(item);
			if (frame) out.push(frame);
		}
		return out;
	}
}

export function fakeSockets(onCreate?: (socket: FakeSocket) => void): { sockets: FakeSocket[]; Ctor: WebSocketCtor } {
	const sockets: FakeSocket[] = [];
	class Registered extends FakeSocket {
		constructor(url: string) {
			super(url);
			sockets.push(this);
			if (onCreate) onCreate(this);
		}
	}
	return { sockets, Ctor: Registered };
}

export interface FakeRequest {
	readonly method: string;
	readonly url: URL;
	readonly headers: Headers;
	readonly body: string | Uint8Array | null;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch that routes every call through `route`; `"network"` simulates a TypeError (offline). */
export function fakeFetch(route: (req: FakeRequest) => Response | "network" | Promise<Response | "network">): {
	fetch: typeof fetch;
	requests: FakeRequest[];
} {
	const requests: FakeRequest[] = [];
	const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const raw = init?.body;
		const body = raw === undefined || raw === null ? null
			: typeof raw === "string" ? raw
			: raw instanceof Uint8Array ? raw.slice()
			: raw instanceof ArrayBuffer ? new Uint8Array(raw).slice()
			: raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer())
			: null;
		const req: FakeRequest = { method: init?.method ?? "GET", url: new URL(href), headers: new Headers(init?.headers), body };
		requests.push(req);
		const result = await route(req);
		if (result === "network") throw new TypeError("fetch failed");
		return result;
	};
	return { fetch: impl, requests };
}
