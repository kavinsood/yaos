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
 * Tests, the simulation and harnesses only: the plugin's one carrier is the
 * worker (no product host module may reach this file, scripts/check-deps.mjs).
 */

import type { EngineToMain, MainToEngine } from "./messages";
import type { EngineTransport, HostTransport, Transport } from "./transport";
import { Inbox, macrotaskSchedule, type Schedule } from "./workerTransport";

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
