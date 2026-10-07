/**
 * WorkerTransport: Blob-URL dedicated worker carrier. DESIGN §g.1, §g.4.
 *
 * Host side wraps a `Worker`; engine side wraps the worker global scope.
 * Both are structural (WorkerLike / WorkerScopeLike) so Node tests can run the
 * real code over a MessageChannel or worker_threads.
 *
 * Also home of the [T] transfer helpers used by every sender:
 *  - `transferablesOf(message)` lists the buffers of every [T] field and asserts
 *    each is exclusively owned (byteOffset 0, full length, plain ArrayBuffer);
 *  - `owned(bytes)` returns bytes itself when exclusively owned, else a copy;
 *  - `postOwned(transport, message)` = post with transferablesOf(message).
 * After a post the sender's buffers are detached (byteLength 0) on both
 * carriers: touching them is a bug that shows up immediately.
 *
 * SECRET buffers (keys, recovery keys: e2ee-design §6.3, §18.4) are transferred too. When a sender falls back to a
 * structured-clone copy (TransferOwnershipError), `wipeSecrets(message)` zero-fills the originals it still holds,
 * so the sending side keeps no copy either way.
 *
 * And of the receiver queue (Inbox, macrotaskSchedule) the in-process pair of tests and harnesses
 * (inlineTransport.ts) reuses, so both carriers deliver alike.
 */

import type { Unsubscribe } from "../ports/common";
import type { EngineToMain, MainToEngine, UserCommand } from "./messages";
import type { EngineTransport, HostTransport, Transport } from "./transport";

// ---------------------------------------------------------------------------
// Transfer ownership
// ---------------------------------------------------------------------------

export class TransferOwnershipError extends Error {
	constructor(readonly field: string) {
		super(`[T] field ${field} is not an exclusively owned buffer (use owned())`);
		this.name = "TransferOwnershipError";
	}
}

export function isExclusivelyOwned(bytes: Uint8Array): boolean {
	const buf = bytes.buffer;
	return (
		buf instanceof ArrayBuffer &&
		bytes.byteOffset === 0 &&
		bytes.byteLength === buf.byteLength
	);
}

/** bytes when exclusively owned, else a tight copy (DESIGN §g.4). */
export function owned(bytes: Uint8Array): Uint8Array {
	return isExclusivelyOwned(bytes) ? bytes : bytes.slice();
}

function add(out: ArrayBuffer[], seen: Set<ArrayBuffer>, bytes: Uint8Array, field: string): void {
	if (!isExclusivelyOwned(bytes)) throw new TransferOwnershipError(field);
	const buf = bytes.buffer as ArrayBuffer;
	if (seen.has(buf)) throw new TransferOwnershipError(`${field} (buffer shared with another field)`);
	seen.add(buf);
	out.push(buf);
}

/** Buffers of every [T] field of a protocol message (either direction). */
export function transferablesOf(message: MainToEngine | EngineToMain): ArrayBuffer[] {
	const out: ArrayBuffer[] = [];
	const seen = new Set<ArrayBuffer>();
	switch (message.t) {
		case "init": {
			const s = message.config.sideState;
			s.outboxMirror.forEach((b, i) => b && add(out, seen, b, `init.sideState.outboxMirror[${i}]`));
			s.syncedMirror.forEach((b, i) => b && add(out, seen, b, `init.sideState.syncedMirror[${i}]`));
			const c = message.config.crypto;
			if (c.suite === 1) {
				c.keys.forEach((key, i) => add(out, seen, key.k, `init.crypto.keys[${i}].k`));
				c.records.forEach((r, i) => add(out, seen, r, `init.crypto.records[${i}]`));
			}
			break;
		}
		case "command": {
			const secret = commandSecret(message.command);
			if (secret) add(out, seen, secret, `command.${message.command.t}`);
			break;
		}
		case "keyringChanged":
			message.keys.forEach((key, i) => add(out, seen, key.k, `keyringChanged.keys[${i}].k`));
			message.records.forEach((r, i) => add(out, seen, r, `keyringChanged.records[${i}]`));
			break;
		case "textChunk":
			add(out, seen, message.bytes, "textChunk.bytes");
			break;
		case "hashRequest":
			message.items.forEach((it, i) => add(out, seen, it.bytes, `hashRequest.items[${i}].bytes`));
			break;
		case "sideFileWrite":
			add(out, seen, message.bytes, "sideFileWrite.bytes");
			break;
		case "diskOps":
			message.ops.forEach((op, i) => {
				if (op.t === "write" && op.data.t === "bytes") add(out, seen, op.data.bytes, `diskOps.ops[${i}].data.bytes`);
			});
			break;
		case "result": {
			const v = message.value;
			switch (v.t) {
				case "reads":
					v.results.forEach((r, i) => r.ok && add(out, seen, r.bytes, `result.reads[${i}].bytes`));
					break;
				case "sideFile":
					if (v.bytes) add(out, seen, v.bytes, "result.sideFile.bytes");
					break;
				default:
					break;
			}
			break;
		}
		default:
			break;
	}
	return out;
}

/** The SECRET buffer a user command carries (e2ee-design §18.4), or null. */
function commandSecret(c: UserCommand): Uint8Array | null {
	switch (c.t) {
		case "enableE2ee":
		case "revokeRekey":
			return c.rk;
		case "installKey":
			return c.source === "qr" ? c.k : c.rk;
		default:
			return null;
	}
}

/** Every SECRET buffer of a message: key bytes and recovery keys (records are public and not listed). */
export function secretBuffersOf(message: MainToEngine | EngineToMain): Uint8Array[] {
	switch (message.t) {
		case "init": {
			const c = message.config.crypto;
			return c.suite === 1 ? c.keys.map((key) => key.k) : [];
		}
		case "command": {
			const secret = commandSecret(message.command);
			return secret ? [secret] : [];
		}
		case "keyringChanged":
			return message.keys.map((key) => key.k);
		default:
			return [];
	}
}

/**
 * Zero-fill the SECRET buffers the sender still holds after a post. A transferred buffer is detached (length 0)
 * and left alone; one a structured clone copied is wiped, so no key outlives the post on the sending side.
 */
export function wipeSecrets(message: MainToEngine | EngineToMain): void {
	for (const b of secretBuffersOf(message)) if (b.byteLength > 0) b.fill(0);
}

/** Post with the message's own [T] buffers transferred. */
export function postOwned<Out extends MainToEngine | EngineToMain, In>(transport: Transport<Out, In>, message: Out): void {
	transport.post(message, transferablesOf(message));
}

// ---------------------------------------------------------------------------
// Receiver queue (both carriers)
// ---------------------------------------------------------------------------

/** Run fn on a later macrotask, FIFO with every other scheduled fn. */
export type Schedule = (fn: () => void) => void;

export function macrotaskSchedule(): Schedule {
	// MessageChannel gives an unclamped macrotask in browsers; setTimeout(0) elsewhere.
	if (typeof MessageChannel === "function") {
		const queue: (() => void)[] = [];
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			const fn = queue.shift();
			if (fn) fn();
		};
		// Node: an open MessagePort keeps the process alive. unref when available.
		const port = channel.port1 as unknown as { unref?: () => void };
		const port2 = channel.port2 as unknown as { unref?: () => void };
		if (typeof port.unref === "function") port.unref();
		if (typeof port2.unref === "function") port2.unref();
		return (fn) => {
			queue.push(fn);
			channel.port2.postMessage(0);
		};
	}
	return (fn) => {
		setTimeout(fn, 0);
	};
}

/**
 * Receiver-side queue shared by both carriers: buffers until the first
 * listener, then drains in order on a scheduled macrotask so that buffered
 * and newly arriving messages keep FIFO.
 */
export class Inbox<In> {
	private readonly listeners: ((message: In) => void)[] = [];
	private readonly failureListeners: ((reason: string) => void)[] = [];
	private readonly buffered: In[] = [];
	private flushScheduled = false;
	closed = false;

	constructor(private readonly schedule: Schedule) {}

	deliver(message: In): void {
		if (this.closed) return;
		if (this.listeners.length === 0 || this.buffered.length > 0) {
			this.buffered.push(message);
			return;
		}
		this.dispatch(message);
	}

	onMessage(listener: (message: In) => void): Unsubscribe {
		this.listeners.push(listener);
		if (this.buffered.length > 0 && !this.flushScheduled) {
			this.flushScheduled = true;
			this.schedule(() => {
				this.flushScheduled = false;
				while (!this.closed && this.listeners.length > 0 && this.buffered.length > 0) {
					this.dispatch(this.buffered.shift() as In);
				}
			});
		}
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i >= 0) this.listeners.splice(i, 1);
		};
	}

	onFailure(listener: (reason: string) => void): Unsubscribe {
		this.failureListeners.push(listener);
		return () => {
			const i = this.failureListeners.indexOf(listener);
			if (i >= 0) this.failureListeners.splice(i, 1);
		};
	}

	failureSnapshot(): ((reason: string) => void)[] {
		return this.failureListeners.slice();
	}

	close(): void {
		this.closed = true;
		this.buffered.length = 0;
	}

	private dispatch(message: In): void {
		for (const l of this.listeners.slice()) {
			try {
				l(message);
			} catch (err) {
				// A throwing listener must not break FIFO delivery (a worker's onmessage
				// throwing does not stop the port either).
				reportListenerError(err);
			}
		}
	}
}

function reportListenerError(err: unknown): void {
	const c = (globalThis as { console?: { error?: (...a: unknown[]) => void } }).console;
	c?.error?.("[yaos] transport listener threw", err);
}

// ---------------------------------------------------------------------------
// Worker carrier
// ---------------------------------------------------------------------------

interface MessageEventLike {
	readonly data: unknown;
}

/** The parts of `Worker` the host uses. */
export interface WorkerLike {
	postMessage(message: unknown, transfer: Transferable[]): void;
	addEventListener(type: "message", listener: (ev: MessageEventLike) => void): void;
	addEventListener(type: "error" | "messageerror", listener: (ev: unknown) => void): void;
	terminate(): void;
}

/** The parts of `DedicatedWorkerGlobalScope` the engine uses. */
export interface WorkerScopeLike {
	postMessage(message: unknown, transfer: Transferable[]): void;
	addEventListener(type: "message", listener: (ev: MessageEventLike) => void): void;
	addEventListener(type: "messageerror", listener: (ev: unknown) => void): void;
	close(): void;
}

function describe(ev: unknown): string {
	if (ev && typeof ev === "object") {
		const e = ev as { message?: unknown; type?: unknown };
		if (typeof e.message === "string" && e.message) return e.message;
		if (typeof e.type === "string") return e.type;
	}
	return String(ev);
}

/**
 * Host side. The worker's message listener is attached immediately; messages
 * that arrive before the first onMessage listener are buffered (same as the
 * inline carrier). An `error` / `messageerror` event or close() terminates the
 * worker; failure listeners fire once.
 */
export function createWorkerHostTransport(worker: WorkerLike, options?: { readonly schedule?: Schedule }): HostTransport {
	const inbox = new Inbox<EngineToMain>(options?.schedule ?? macrotaskSchedule());
	let failed = false;
	const fail = (reason: string) => {
		if (failed || inbox.closed) return;
		failed = true;
		const listeners = inbox.failureSnapshot();
		inbox.close();
		try {
			worker.terminate();
		} catch {
			// already gone
		}
		for (const l of listeners) l(reason);
	};
	worker.addEventListener("message", (ev) => inbox.deliver(ev.data as EngineToMain));
	worker.addEventListener("error", (ev) => fail(`worker error: ${describe(ev)}`));
	worker.addEventListener("messageerror", (ev) => fail(`worker messageerror: ${describe(ev)}`));
	return {
		kind: "worker",
		post(message: MainToEngine, transfer?: readonly ArrayBuffer[]): void {
			if (inbox.closed) return;
			// A DataCloneError is a programming bug: it propagates to the caller.
			worker.postMessage(message, transfer ? (transfer as ArrayBuffer[]) : []);
		},
		onMessage: (listener) => inbox.onMessage(listener),
		onFailure: (listener) => inbox.onFailure(listener),
		close(): void {
			if (inbox.closed) return;
			inbox.close();
			worker.terminate();
		},
	};
}

/** Engine side, inside the worker. */
export function createWorkerEngineTransport(scope: WorkerScopeLike, options?: { readonly schedule?: Schedule }): EngineTransport {
	const inbox = new Inbox<MainToEngine>(options?.schedule ?? macrotaskSchedule());
	scope.addEventListener("message", (ev) => inbox.deliver(ev.data as MainToEngine));
	scope.addEventListener("messageerror", () => {
		// A message that cannot be deserialized is lost; the host's request will
		// time out and be retried. Nothing else to do here.
	});
	return {
		kind: "worker",
		post(message: EngineToMain, transfer?: readonly ArrayBuffer[]): void {
			if (inbox.closed) return;
			scope.postMessage(message, transfer ? (transfer as ArrayBuffer[]) : []);
		},
		onMessage: (listener: (message: MainToEngine) => void): Unsubscribe => inbox.onMessage(listener),
		onFailure: (listener: (reason: string) => void): Unsubscribe => inbox.onFailure(listener),
		close(): void {
			if (inbox.closed) return;
			inbox.close();
			scope.close();
		},
	};
}
