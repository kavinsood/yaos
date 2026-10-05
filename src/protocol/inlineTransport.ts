/**
 * InlineTransport: same-thread host <-> engine pair. DESIGN §g.1, §g.5.
 *
 * Semantics match the worker carrier exactly (parity is tested):
 *  - every message is structured-cloned at post time, with `transfer` buffers
 *    detached from the sender (structuredClone({transfer}));
 *  - FIFO per direction, one macrotask per message (never synchronous, never
 *    a microtask, so a sender's synchronous code always finishes first);
 *  - messages posted before the receiver registers its first listener are
 *    buffered (the worker side buffers the same way).
 *
 * `schedule` is injectable so the simulation can deliver on its virtual clock.
 */

import type { Unsubscribe } from "../ports/common";
import type { EngineToMain, MainToEngine } from "./messages";
import type { EngineTransport, HostTransport, Transport } from "./transport";

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

export function cloneForTransfer<T>(message: T, transfer: readonly ArrayBuffer[] | undefined): T {
	if (transfer && transfer.length > 0) return structuredClone(message, { transfer: transfer as ArrayBuffer[] });
	return structuredClone(message);
}

function makeSide<Out, In>(self: Inbox<In>, peer: Inbox<Out>, schedule: Schedule, closeBoth: () => void): Transport<Out, In> {
	return {
		kind: "inline",
		post(message: Out, transfer?: readonly ArrayBuffer[]): void {
			if (self.closed || peer.closed) return;
			const copy = cloneForTransfer(message, transfer);
			schedule(() => peer.deliver(copy));
		},
		onMessage: (listener) => self.onMessage(listener),
		onFailure: (listener) => self.onFailure(listener),
		close(): void {
			closeBoth();
		},
	};
}

export interface InlinePair {
	readonly host: HostTransport;
	readonly engine: EngineTransport;
	/**
	 * Test/sim hook: simulate the engine dying (worker crash). Both ends close,
	 * undelivered messages are lost, and the host's onFailure listeners fire on
	 * a later macrotask.
	 */
	kill(reason: string): void;
	readonly closed: boolean;
}

export function createInlinePair(options?: { readonly schedule?: Schedule }): InlinePair {
	const schedule = options?.schedule ?? macrotaskSchedule();
	const hostInbox = new Inbox<EngineToMain>(schedule);
	const engineInbox = new Inbox<MainToEngine>(schedule);
	const closeBoth = () => {
		hostInbox.close();
		engineInbox.close();
	};
	const host = makeSide<MainToEngine, EngineToMain>(hostInbox, engineInbox, schedule, closeBoth);
	const engine = makeSide<EngineToMain, MainToEngine>(engineInbox, hostInbox, schedule, closeBoth);
	return {
		host,
		engine,
		get closed() {
			return hostInbox.closed;
		},
		kill(reason: string) {
			if (hostInbox.closed) return;
			const listeners = hostInbox.failureSnapshot();
			closeBoth();
			schedule(() => {
				for (const l of listeners) l(reason);
			});
		},
	};
}
