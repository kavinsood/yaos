/**
 * Waiting on the host without polling: a probe runs on every YaosUiHost change (status, run state, data) until it
 * answers or the timeout fires. Pure (no obsidian runtime). Used by the encryption flows (createVault.ts,
 * keyActions.ts), which wait for the engine to report what a command did.
 */

import type { YaosUiHost } from "./api";

export interface WaitOptions {
	readonly timeoutMs?: number;
	readonly setTimer?: (ms: number, fn: () => void) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Resolves with the first non-null answer of `probe` (checked now and on every host change), or null after the
 * timeout. Always unsubscribes and clears its timer.
 */
export function waitFor<T>(host: Pick<YaosUiHost, "onChange">, probe: () => T | null, defaultTimeoutMs: number, opts: WaitOptions = {}): Promise<T | null> {
	const setTimer = opts.setTimer ?? ((ms, fn) => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	return new Promise((resolve) => {
		let done = false;
		let timer: unknown = null;
		let unsubscribe: () => void = () => undefined;
		const finish = (value: T | null): void => {
			if (done) return;
			done = true;
			unsubscribe();
			if (timer !== null) clearTimer(timer);
			resolve(value);
		};
		const check = (): void => {
			const v = probe();
			if (v !== null) finish(v);
		};
		unsubscribe = host.onChange(check);
		timer = setTimer(opts.timeoutMs ?? defaultTimeoutMs, () => finish(null));
		check();
	});
}
