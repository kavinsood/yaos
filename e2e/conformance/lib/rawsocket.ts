/**
 * Minimal RFC 6455 client over node:tls / node:net for the revoke tests. It exposes what the global WebSocket (undici)
 * hides:
 * - when the server's close frame arrives, as distinct from when the TCP connection ends. undici fires `close` only
 *   when TCP ends;
 * - sending after a close frame. undici's send() silently drops data once a close frame has arrived, so it cannot
 *   act as a revoked client that ignores the close (`replyToClose: false`).
 * The URL (it carries the ticket) is never stored or logged.
 */
import { createHash, randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Ctx } from "./context.ts";
import { decodeServerFrame, encodeAppend } from "./codec.ts";
import type { ServerFrame } from "./codec.ts";
import { StreamSocket } from "./socket.ts";
import type { DeviceLike } from "./socket.ts";
import { now, round } from "./util.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface RawEvent {
	at: number;
	type: "http" | "control" | "frame" | "text" | "bad-frame" | "close-frame" | "ping" | "pong" | "end" | "error";
	control?: any;
	frame?: ServerFrame;
	close?: { code: number; reason: string };
	status?: number;
	note?: string;
}

export interface RawOptions {
	/** true: echo the server's close frame at once (what browsers and undici do). false: never answer it, keep sending. */
	replyToClose: boolean;
}

export interface SendResult { at: number; written: boolean }

export class RawSocket {
	name: string;
	opts: RawOptions;
	events: RawEvent[] = [];
	openedAt: number;
	status: number | null = null;
	upgraded = false;
	closeFrame: { code: number; reason: string; at: number } | null = null;
	sentClose: { code: number; at: number } | null = null;
	ended: { at: number; how: string } | null = null;
	ready: any = null;
	private sock: Socket;
	private buf: Buffer = Buffer.alloc(0);
	private fragments: { opcode: number; parts: Buffer[] } | null = null;
	private key = randomBytes(16).toString("base64");
	private wakers = new Set<() => void>();

	constructor(name: string, url: string, opts: RawOptions) {
		this.name = name;
		this.opts = opts;
		this.openedAt = now();
		const u = new URL(url);
		const secure = u.protocol === "wss:" || u.protocol === "https:";
		const port = Number(u.port || (secure ? 443 : 80));
		const request = `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
			+ `Sec-WebSocket-Key: ${this.key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: yaos-conformance-raw\r\n\r\n`;
		this.sock = secure
			? tlsConnect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["http/1.1"] }, () => this.sock.write(request))
			: netConnect({ host: u.hostname, port }, () => this.sock.write(request));
		this.sock.setNoDelay(true);
		this.sock.on("data", (chunk: Buffer) => this.onData(chunk));
		this.sock.on("end", () => this.onEnd("fin"));
		this.sock.on("close", (hadError: boolean) => this.onEnd(hadError ? "close-error" : "close"));
		this.sock.on("error", (error: Error) => { this.push({ at: now(), type: "error", note: error.message.slice(0, 80) }); });
	}

	/** Opens with a raw ticket (or none) without waiting for anything. */
	static open(ctx: Ctx, vaultId: string, ticket: string | null, name: string, opts: RawOptions): RawSocket {
		return new RawSocket(name, StreamSocket.url(ctx, vaultId, ticket), opts);
	}

	/** Ticket, connect, then wait for VAULT_READY. */
	static async connect(ctx: Ctx, vaultId: string, device: DeviceLike, name: string, opts: RawOptions, timeoutMs = 15000): Promise<RawSocket> {
		const ticket = await StreamSocket.ticket(ctx, vaultId, device.token);
		const socket = RawSocket.open(ctx, vaultId, ticket, name, opts);
		const ready = await socket.waitFor((e) => e.control?.type === "VAULT_READY" ? e.control : undefined, timeoutMs, "VAULT_READY");
		socket.ready = ready.value;
		return socket;
	}

	private push(event: RawEvent) { this.events.push(event); for (const wake of [...this.wakers]) wake(); }

	private onEnd(how: string) {
		if (this.ended) return;
		const at = now();
		this.ended = { at, how };
		this.push({ at, type: "end", note: how });
	}

	private onData(chunk: Buffer) {
		const at = now();
		if (!this.upgraded && this.status !== null) return;
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		if (!this.upgraded) {
			const end = this.buf.indexOf("\r\n\r\n");
			if (end < 0) return;
			const head = this.buf.subarray(0, end).toString("latin1").split("\r\n");
			this.buf = this.buf.subarray(end + 4);
			this.status = Number(head[0]?.split(" ")[1] ?? 0);
			const accept = head.find((line) => /^sec-websocket-accept:/i.test(line))?.split(":")[1]?.trim();
			const expected = createHash("sha1").update(this.key + GUID).digest("base64");
			if (this.status !== 101 || accept !== expected) {
				// Not upgraded: record the status (and a JSON `error` if the first chunk has one), then drop the connection.
				let error: unknown = null;
				try { error = JSON.parse(this.buf.toString("utf8").slice(0, 2000))?.error ?? null; } catch { /* not json, or split */ }
				this.buf = Buffer.alloc(0);
				this.push({ at, type: "http", status: this.status, note: this.status === 101 ? "bad Sec-WebSocket-Accept"
					: typeof error === "string" ? error.slice(0, 60) : undefined });
				setTimeout(() => this.close(), 500);
				return;
			}
			this.upgraded = true;
			this.push({ at, type: "http", status: 101 });
		}
		this.parse(at);
	}

	private parse(at: number) {
		for (;;) {
			const b = this.buf;
			if (b.length < 2) return;
			const fin = (b[0]! & 0x80) !== 0;
			const opcode = b[0]! & 0x0f;
			const masked = (b[1]! & 0x80) !== 0;
			let length = b[1]! & 0x7f;
			let offset = 2;
			if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
			else if (length === 127) { if (b.length < 10) return; length = Number(b.readBigUInt64BE(2)); offset = 10; }
			const maskAt = offset;
			if (masked) offset += 4;
			if (b.length < offset + length) return;
			const payload = Buffer.from(b.subarray(offset, offset + length));
			if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= b[maskAt + (i % 4)]!;
			this.buf = b.subarray(offset + length);
			this.frame(at, fin, opcode, payload);
		}
	}

	private frame(at: number, fin: boolean, opcode: number, payload: Buffer) {
		if (opcode === OP.close) {
			const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
			const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
			if (!this.closeFrame) this.closeFrame = { code, reason, at };
			this.push({ at, type: "close-frame", close: { code, reason } });
			if (this.opts.replyToClose) this.sendClose(code === 1005 ? 1000 : code);
			return;
		}
		if (opcode === OP.ping) { this.push({ at, type: "ping" }); this.write(OP.pong, payload); return; }
		if (opcode === OP.pong) { this.push({ at, type: "pong" }); return; }
		if (opcode === OP.cont) {
			if (!this.fragments) { this.push({ at, type: "bad-frame", note: "continuation without start" }); return; }
			this.fragments.parts.push(payload);
			if (!fin) return;
			const { opcode: first, parts } = this.fragments;
			this.fragments = null;
			this.message(at, first, Buffer.concat(parts));
			return;
		}
		if (!fin) { this.fragments = { opcode, parts: [payload] }; return; }
		this.message(at, opcode, payload);
	}

	private message(at: number, opcode: number, data: Buffer) {
		if (opcode === OP.text) {
			const text = data.toString("utf8");
			if (text.startsWith("__YPS:")) {
				let control: any;
				try { control = JSON.parse(text.slice(6)); } catch { control = { type: "<unparseable>" }; }
				this.push({ at, type: "control", control });
			} else this.push({ at, type: "text", note: text.slice(0, 80) });
		} else if (opcode === OP.binary) {
			const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
			try { this.push({ at, type: "frame", frame: decodeServerFrame(bytes) }); }
			catch (error) { this.push({ at, type: "bad-frame", note: `${bytes.byteLength}B: ${String(error)}` }); }
		} else this.push({ at, type: "bad-frame", note: `opcode ${opcode}` });
	}

	/** Writes one masked frame. `written` is false once the TCP connection is gone (or the write threw). */
	private write(opcode: number, payload: Uint8Array): SendResult {
		const at = now();
		if (this.ended || this.sock.destroyed || !this.sock.writable) return { at, written: false };
		const length = payload.byteLength;
		const head = length < 126 ? 2 : length < 65536 ? 4 : 10;
		const out = Buffer.alloc(head + 4 + length);
		out[0] = 0x80 | opcode;
		if (length < 126) out[1] = 0x80 | length;
		else if (length < 65536) { out[1] = 0x80 | 126; out.writeUInt16BE(length, 2); }
		else { out[1] = 0x80 | 127; out.writeBigUInt64BE(BigInt(length), 2); }
		const mask = randomBytes(4);
		mask.copy(out, head);
		for (let i = 0; i < length; i++) out[head + 4 + i] = payload[i]! ^ mask[i % 4]!;
		try { this.sock.write(out); } catch { return { at, written: false }; }
		return { at, written: true };
	}

	append(stream: string, clientFrameId: string, payload: Uint8Array): SendResult { return this.write(OP.binary, encodeAppend(stream, clientFrameId, payload)); }
	control(value: unknown): SendResult { return this.write(OP.text, Buffer.from(`__YPS:${JSON.stringify(value)}`)); }
	sendClose(code = 1000): SendResult {
		const body = Buffer.alloc(2);
		body.writeUInt16BE(code, 0);
		const result = this.write(OP.close, body);
		if (result.written && !this.sentClose) this.sentClose = { code, at: result.at };
		return result;
	}

	get isOpen() { return this.upgraded && !this.ended; }
	mark() { return this.events.length; }

	private async idle(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const wake = () => { clearTimeout(timer); this.wakers.delete(wake); resolve(); };
			const timer = setTimeout(wake, Math.max(1, ms));
			this.wakers.add(wake);
		});
	}

	async waitFor<T>(match: (event: RawEvent) => T | undefined, timeoutMs: number, what: string, from = 0): Promise<{ value: T; at: number }> {
		const deadline = now() + timeoutMs;
		let index = from;
		for (;;) {
			while (index < this.events.length) {
				const event = this.events[index++]!;
				const value = match(event);
				if (value !== undefined) return { value, at: event.at };
			}
			if (this.ended) {
				const http = this.events.find((e) => e.type === "http");
				throw new Error(`${this.name}: connection ended (${this.ended.how}, http ${http?.status ?? "-"} ${http?.note ?? ""}) waiting for ${what}`);
			}
			const left = deadline - now();
			if (left <= 0) throw new Error(`${this.name}: timeout waiting for ${what}`);
			await this.idle(left);
		}
	}

	/** Resolves when TCP ends (or null on timeout). */
	async waitEnd(timeoutMs: number): Promise<{ at: number; how: string } | null> {
		const deadline = now() + timeoutMs;
		while (!this.ended) {
			const left = deadline - now();
			if (left <= 0) return null;
			await this.idle(left);
		}
		return this.ended;
	}

	/** Compact, secret-free timeline: [ms since open, event]. */
	timeline(from = 0, max = 40, origin = this.openedAt): string[] {
		const out = this.events.slice(from).map((e) => {
			const t = round(e.at - origin);
			if (e.type === "control") return `${t} ${e.control?.type ?? "?"}${e.control?.code ? `:${e.control.code}` : ""}`;
			if (e.type === "frame") return `${t} ${e.frame!.kind}${e.frame!.seq !== null ? `#${e.frame!.seq}` : ""}`;
			if (e.type === "close-frame") return `${t} close-frame:${e.close!.code}${e.close!.reason ? `(${e.close!.reason.slice(0, 60)})` : ""}`;
			if (e.type === "http") return `${t} http:${e.status}${e.note ? `(${e.note})` : ""}`;
			return `${t} ${e.type}${e.note ? `(${e.note.slice(0, 60)})` : ""}`;
		});
		return out.length > max ? [...out.slice(0, max / 2), `... ${out.length - max} more ...`, ...out.slice(-max / 2)] : out;
	}

	/** Hard teardown (no close handshake). */
	close() { try { this.sock.destroy(); } catch { /* gone */ } }
}
