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
 */

import type { Unsubscribe } from "../ports/common";
import type { EngineToMain, MainToEngine } from "./messages";
import type { EngineTransport, HostTransport, Transport } from "./transport";
import { Inbox, macrotaskSchedule, type Schedule } from "./inlineTransport";

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
			break;
		}
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

/** Post with the message's own [T] buffers transferred. */
export function postOwned<Out extends MainToEngine | EngineToMain, In>(transport: Transport<Out, In>, message: Out): void {
	transport.post(message, transferablesOf(message));
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
