/**
 * Streams socket client that logs every frame, control message, error and close with a timestamp
 * (ms since suite start). Tickets are never logged: the URL is not stored.
 */
import type { Ctx } from "./context.ts";
import { secret } from "./context.ts";
import { decodeServerFrame, encodeAppend } from "./codec.ts";
import type { ServerFrame } from "./codec.ts";
import { http, vaultPath } from "./http.ts";
import { now, round, sleep } from "./util.ts";

export interface SocketEvent {
	at: number;
	type: "control" | "frame" | "text" | "bad-frame" | "error" | "close";
	control?: any;
	frame?: ServerFrame;
	close?: { code: number; reason: string };
	note?: string;
}

export interface Receipt { stream: string; clientFrameId: string; seq: number; deduped: boolean; at: number; head: number }

export interface Collected {
	receipts: Map<string, Receipt>;
	rejected: any[];
	errors: any[];
	closed: { code: number; reason: string } | null;
	timedOut: boolean;
}

export interface DeviceLike { deviceId: string; token: string }

export class StreamSocket {
	name: string;
	ws: WebSocket;
	events: SocketEvent[] = [];
	ready: any = null;
	closed: { code: number; reason: string; at: number } | null = null;
	openedAt: number;
	private wakers = new Set<() => void>();

	constructor(name: string, url: string) {
		this.name = name;
		this.openedAt = now();
		this.ws = new WebSocket(url);
		this.ws.binaryType = "arraybuffer";
		this.ws.addEventListener("message", (event: MessageEvent) => {
			const at = now();
			if (typeof event.data === "string") {
				if (event.data.startsWith("__YPS:")) {
					let control: any;
					try { control = JSON.parse(event.data.slice(6)); } catch { control = { type: "<unparseable>" }; }
					this.events.push({ at, type: "control", control });
				} else this.events.push({ at, type: "text", note: event.data.slice(0, 80) });
			} else {
				const bytes = new Uint8Array(event.data as ArrayBuffer);
				try { this.events.push({ at, type: "frame", frame: decodeServerFrame(bytes) }); }
				catch (error) { this.events.push({ at, type: "bad-frame", note: `${bytes.byteLength}B: ${String(error)}` }); }
			}
			this.wakeAll();
		});
		this.ws.addEventListener("error", () => { this.events.push({ at: now(), type: "error" }); this.wakeAll(); });
		this.ws.addEventListener("close", (event: CloseEvent) => {
			const at = now();
			this.closed = { code: event.code, reason: event.reason, at };
			this.events.push({ at, type: "close", close: { code: event.code, reason: event.reason } });
			this.wakeAll();
		});
	}

	private wakeAll() { for (const wake of [...this.wakers]) wake(); }

	private async idle(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const wake = () => { clearTimeout(timer); this.wakers.delete(wake); resolve(); };
			const timer = setTimeout(wake, Math.max(1, ms));
			this.wakers.add(wake);
		});
	}

	static url(ctx: Ctx, vaultId: string, ticket: string | null, query = "streamsVersion=1"): string {
		const ticketPart = ticket === null ? "" : `ticket=${encodeURIComponent(ticket)}&`;
		return `${ctx.wsHost}${vaultPath(vaultId)}/ws/streams?${ticketPart}${query}`;
	}

	static async ticket(ctx: Ctx, vaultId: string, token: string): Promise<string> {
		const response = await http(ctx, "POST", `${vaultPath(vaultId)}/auth/ticket`, { token, json: { purpose: "streams" } });
		if (response.status !== 200 || typeof response.value?.ticket !== "string") {
			throw new Error(`ticket failed ${response.status} ${String(response.value?.error ?? "")}`);
		}
		secret(ctx, response.value.ticket);
		return response.value.ticket;
	}

	/** Opens a socket with a raw ticket (or none) without waiting for VAULT_READY. */
	static raw(ctx: Ctx, vaultId: string, ticket: string | null, name: string, query?: string): StreamSocket {
		const socket = new StreamSocket(name, StreamSocket.url(ctx, vaultId, ticket, query));
		ctx.openSockets.add(socket);
		return socket;
	}

	/** Ticket + connect + wait for VAULT_READY. */
	static async connect(ctx: Ctx, vaultId: string, device: DeviceLike, name: string, timeoutMs = 15000): Promise<StreamSocket> {
		const ticket = await StreamSocket.ticket(ctx, vaultId, device.token);
		const socket = StreamSocket.raw(ctx, vaultId, ticket, name);
		const ready = await socket.waitFor((e) => e.control?.type === "VAULT_READY" ? e.control : undefined, timeoutMs, "VAULT_READY");
		socket.ready = ready.value;
		return socket;
	}

	mark() { return this.events.length; }
	append(stream: string, clientFrameId: string, payload: Uint8Array): number { this.ws.send(encodeAppend(stream, clientFrameId, payload)); return now(); }
	sendRaw(bytes: Uint8Array): number { this.ws.send(bytes); return now(); }
	control(value: unknown): number { this.ws.send(`__YPS:${JSON.stringify(value)}`); return now(); }
	get isOpen() { return this.ws.readyState === WebSocket.OPEN; }

	async waitFor<T>(match: (event: SocketEvent) => T | undefined, timeoutMs: number, what: string, from = 0): Promise<{ value: T; at: number }> {
		const deadline = now() + timeoutMs;
		let index = from;
		for (;;) {
			while (index < this.events.length) {
				const event = this.events[index++]!;
				const value = match(event);
				if (value !== undefined) return { value, at: event.at };
			}
			if (this.closed) throw new Error(`${this.name}: socket closed ${this.closed.code} ${this.closed.reason} waiting for ${what}`);
			const left = deadline - now();
			if (left <= 0) throw new Error(`${this.name}: timeout waiting for ${what}`);
			await this.idle(left);
		}
	}

	/** Resolves with the close (or null on timeout). */
	async waitClose(timeoutMs: number): Promise<{ code: number; reason: string; at: number } | null> {
		const deadline = now() + timeoutMs;
		while (!this.closed) {
			const left = deadline - now();
			if (left <= 0) return null;
			await this.idle(left);
		}
		return this.closed;
	}

	/** Non-throwing: collects receipts / rejections / errors for `ids` after `from` until all receipted, closed or timeout. */
	async collect(ids: string[], from: number, timeoutMs = 10000): Promise<Collected> {
		const wanted = new Set(ids);
		const out: Collected = { receipts: new Map(), rejected: [], errors: [], closed: null, timedOut: false };
		const deadline = now() + timeoutMs;
		let index = from;
		for (;;) {
			while (index < this.events.length) {
				const event = this.events[index++]!;
				const control = event.control;
				if (control?.type === "STREAM_RECEIPTS") {
					for (const receipt of control.receipts ?? []) {
						if (wanted.has(receipt.clientFrameId) && !out.receipts.has(receipt.clientFrameId)) {
							out.receipts.set(receipt.clientFrameId, { ...receipt, at: event.at, head: control.head });
						}
					}
				} else if (control?.type === "STREAM_APPEND_REJECTED") {
					if (wanted.has(control.clientFrameId)) out.rejected.push(control);
				} else if (control?.type === "VAULT_ERROR" || control?.type === "error") out.errors.push(control);
			}
			const settled = out.receipts.size + new Set(out.rejected.map((r) => r.clientFrameId)).size;
			if (settled >= wanted.size) return out;
			if (this.closed) { out.closed = { code: this.closed.code, reason: this.closed.reason }; return out; }
			const left = deadline - now();
			if (left <= 0) { out.timedOut = true; return out; }
			await this.idle(left);
		}
	}

	/** Throwing variant for setup steps: every id must get a receipt. */
	async receipts(ids: string[], from: number, timeoutMs = 10000): Promise<Map<string, Receipt>> {
		const got = await this.collect(ids, from, timeoutMs);
		if (got.receipts.size !== ids.length) {
			throw new Error(`${this.name}: ${got.receipts.size}/${ids.length} receipts (rejected ${got.rejected.length}, errors ${
				JSON.stringify(got.errors.map((e) => e.code)).slice(0, 200)}, closed ${got.closed?.code ?? "-"}, timedOut ${got.timedOut})`);
		}
		return got.receipts;
	}

	/** Appends and waits for receipts; returns seq by id. */
	async appendAll(items: { stream: string; id: string; payload: Uint8Array }[], timeoutMs = 10000): Promise<Map<string, Receipt>> {
		const from = this.mark();
		for (const item of items) this.append(item.stream, item.id, item.payload);
		return this.receipts(items.map((item) => item.id), from, timeoutMs);
	}

	/** Waits until the socket's send buffer drained; returns the drain time. */
	async drained(timeoutMs = 60000): Promise<number> {
		const deadline = now() + timeoutMs;
		while (this.ws.bufferedAmount > 0 && this.ws.readyState === WebSocket.OPEN && now() < deadline) await sleep(5);
		return now();
	}

	frames(from = 0) { return this.events.slice(from).filter((e) => e.frame).map((e) => e.frame!); }

	/** Compact, secret-free timeline: [ms since open, event]. */
	timeline(from = 0, max = 40): string[] {
		const out = this.events.slice(from).map((e) => {
			const t = round(e.at - this.openedAt);
			if (e.type === "control") return `${t} ${e.control?.type ?? "?"}${e.control?.code ? `:${e.control.code}` : ""}`;
			if (e.type === "frame") return `${t} ${e.frame!.kind}${e.frame!.seq !== null ? `#${e.frame!.seq}` : ""}`;
			if (e.type === "close") return `${t} close:${e.close!.code}${e.close!.reason ? `(${e.close!.reason.slice(0, 60)})` : ""}`;
			return `${t} ${e.type}${e.note ? `(${e.note.slice(0, 60)})` : ""}`;
		});
		return out.length > max ? [...out.slice(0, max / 2), `... ${out.length - max} more ...`, ...out.slice(-max / 2)] : out;
	}

	close(code = 1000) { try { if (this.ws.readyState <= WebSocket.OPEN) this.ws.close(code, "conformance done"); } catch { /* closed */ } }
}
