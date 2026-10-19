// The socket and timer ports (server/src/ports.ts) for the Node suites: one copy, shared by the Worker harness and the
// streams white-box suites. Each fake `implements` its full port, and refuses what the Cloudflare runtime refuses
// (send after close, an invalid close code or reason, an attachment over the hibernation limit), so a server change
// that would throw on Cloudflare throws here too.
import { serialize } from "node:v8";

import type { SocketPort, SocketRegistryPort, TimerPort, UpgradeRejectPort } from "../../../server/src/ports";
import { decodeServerFrame, type ServerStreamFrame } from "../../../server/src/streams/protocol";
import { decodeServerFrame as decodeServerFrameBySpec } from "../../../e2e/conformance/lib/codec.ts";

export type Control = Record<string, unknown> & { type: string };

/** `serializeAttachment()` limit of a hibernatable WebSocket (Durable Objects WebSocket API; protocol.ts budgets for it). */
export const MAX_SOCKET_ATTACHMENT_BYTES = 2048;
/** RFC 6455 §5.5: a close frame's body is at most 125 bytes, 2 of them the code. */
export const MAX_CLOSE_REASON_BYTES = 123;

/** The close codes `WebSocket.close()` accepts (RFC 6455 §7.4: 1004–1006 and 1015 are reserved, never sent). */
export function validCloseCode(code: number): boolean {
	return Number.isInteger(code) && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999));
}

/** Throws as `WebSocket.close(code, reason)` does on Cloudflare for an invalid code or an over-long reason. */
export function assertValidClose(code: number | undefined, reason: string | undefined): void {
	if (code !== undefined && !validCloseCode(code)) throw new TypeError(`invalid WebSocket close code ${code}`);
	if (reason !== undefined && new TextEncoder().encode(reason).byteLength > MAX_CLOSE_REASON_BYTES) {
		throw new TypeError(`WebSocket close reason is over ${MAX_CLOSE_REASON_BYTES} bytes`);
	}
}

export class FakeSocket implements SocketPort {
	readonly binary: Uint8Array[] = [];
	readonly controls: Control[] = [];
	/** Every message in send order: a binary frame's kind (`skipped`, `committed`, ...) or a control's type. */
	readonly timeline: string[] = [];
	closed: { code?: number; reason?: string } | null = null;
	attachment: unknown = null;
	deserializations = 0;
	close(code?: number, reason?: string): void {
		assertValidClose(code, reason);
		this.closed ??= { code, reason };
	}
	deserializeAttachment(): unknown { this.deserializations++; return structuredClone(this.attachment); }
	serializeAttachment(value: unknown): void {
		const size = serialize(value).byteLength;
		if (size > MAX_SOCKET_ATTACHMENT_BYTES) {
			throw new RangeError(`serializeAttachment: ${size} bytes is over the ${MAX_SOCKET_ATTACHMENT_BYTES}-byte limit`);
		}
		this.attachment = structuredClone(value);
	}
	send(message: ArrayBuffer | ArrayBufferView | string): void {
		if (this.closed) throw new Error("Can't call WebSocket send() after close().");
		if (typeof message === "string") {
			if (!message.startsWith("__YPS:")) throw new Error("control frames carry the __YPS: prefix");
			this.controls.push(JSON.parse(message.slice(6)) as Control);
			this.timeline.push(this.controls.at(-1)!.type);
		} else {
			const view = message instanceof ArrayBuffer ? new Uint8Array(message)
				: new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
			this.binary.push(view.slice());
			// The conformance suite's standalone decoder too: it refuses trailing bytes and invalid UTF-8, which the
			// server's own (lib0) decoder lets through, so a frame no spec client could parse fails here.
			decodeServerFrameBySpec(view);
			this.timeline.push(decodeServerFrame(view).kind);
		}
	}
	all(type: string): Control[] { return this.controls.filter((value) => value.type === type); }
	last(type: string): Control | undefined { return this.all(type).at(-1); }
	frames(): ServerStreamFrame[] { return this.binary.map((bytes) => decodeServerFrame(bytes)); }
	/** Every seq this socket was told about, per stream, in arrival order (live frames and skipped runs). */
	seqs(): Record<string, number[]> {
		const out: Record<string, number[]> = {};
		for (const frame of this.frames()) {
			if (frame.kind === "skipped") for (const run of frame.runs) (out[run.stream] ??= []).push(...run.seqs);
			else if (frame.kind !== "provisional") (out[frame.stream] ??= []).push(frame.seq);
		}
		return out;
	}
	receipts(): Array<{ stream: string; clientFrameId: string; seq: number; deduped: boolean }> {
		return this.all("STREAM_RECEIPTS").flatMap((value) => value.receipts as never[]);
	}
}

/**
 * The DO's socket set. Like `ctx.getWebSockets()`, `sockets()` still lists a socket after the server's `close()`
 * (developers.cloudflare.com/durable-objects/api/state/#getwebsockets); `disconnect()` drops it, as the runtime does
 * once the close completes. Node's Response cannot carry status 101, so the "upgrade" answers 200 and keeps the client.
 */
export class FakeRegistry implements SocketRegistryPort {
	readonly list: FakeSocket[] = [];
	lastClient: FakeSocket | null = null;
	walks = 0;
	sockets(): readonly SocketPort[] { this.walks++; return [...this.list]; }
	createPair() { const server = new FakeSocket(); return { client: server, server }; }
	accept(socket: SocketPort): void {
		if (this.list.includes(socket as FakeSocket)) throw new Error("socket already accepted");
		this.list.push(socket as FakeSocket);
	}
	upgradeResponse(client: unknown): Response {
		this.lastClient = client as FakeSocket;
		return new Response(null, { status: 200, headers: { "X-Test-Upgrade": "accepted" } });
	}
	/** The close completed: the runtime forgets the socket. */
	disconnect(socket: FakeSocket): void {
		const at = this.list.indexOf(socket);
		if (at >= 0) this.list.splice(at, 1);
	}
	/** The connection dropped (the peer sees 1006, which no endpoint sends): the runtime forgets the socket. */
	drop(socket: FakeSocket): void {
		socket.closed ??= { code: 1006, reason: "connection dropped" };
		this.disconnect(socket);
	}
	/** Every close the server began has completed (the peer answered): those sockets leave `sockets()`. */
	completeCloses(): void {
		for (const socket of this.list.filter((entry) => entry.closed)) this.disconnect(socket);
	}
}

/** Records each refused upgrade; answers 200 with a marker header (no 101 on Node). */
export class RecordingUpgrades implements UpgradeRejectPort {
	readonly rejected: Array<{ frame: Control; code: number; reason: string }> = [];
	reject(frame: string, code: number, reason: string): Response {
		if (!frame.startsWith("__YPS:")) throw new Error("control frames carry the __YPS: prefix");
		assertValidClose(code, reason);
		this.rejected.push({ frame: JSON.parse(frame.slice("__YPS:".length)) as Control, code, reason });
		return new Response(null, { status: 200, headers: { "X-Test-Upgrade": "rejected" } });
	}
}

/** Timers that fire only when the test advances them. */
export class ManualTimers implements TimerPort {
	private nextId = 0;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();
	constructor(public now = 1_700_000_000_000) {}
	set(callback: () => void, ms: number): unknown {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.now + ms, callback });
		return id;
	}
	clear(handle: unknown): void { this.timers.delete(handle as number); }
	pending(): number { return this.timers.size; }
	/** Moves the clock forward by `ms`, firing every timer that falls due, in time order. */
	advance(ms: number): void {
		const until = this.now + ms;
		for (;;) {
			let next: [number, { at: number; callback: () => void }] | undefined;
			for (const entry of this.timers) if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
			if (!next) break;
			this.timers.delete(next[0]);
			this.now = Math.max(this.now, next[1].at);
			next[1].callback();
		}
		this.now = until;
	}
}
