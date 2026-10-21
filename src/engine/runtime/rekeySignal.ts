/**
 * The key-roll signal on the engine side (e2ee-design §14.5, relay-wire §3.2, §4.2, §4.3).
 *
 * The relay counts the operator's blocking device removals (`removals`) and the highest count a device has covered
 * with a new vault key (`rekeyed`). This engine keeps the latest pair (VAULT_READY.rekey on every session, then each
 * VAULT_REKEY) for its status, where main decides whether to prompt the user (src/host/ui/rekeyPrompt.ts).
 *
 * A won revoke record (§14.2 step 2) covers the removals this engine had seen when the command started: it owes the
 * relay a VAULT_REKEYED for that count, sent at once and again on every later session of this engine until a signal
 * shows `rekeyed` at or above it. An engine that dies before then loses the debt: the prompt comes back and a second
 * revoke is harmless (one more epoch). Nothing here is secret, and nothing here rolls a key: only the user does,
 * with the recovery key (a revoke record needs `recoveryWrap`, §11.1; a roll would reach the removed device).
 */

import type { RekeySignal, RelaySession } from "../../ports/relay";

export class RekeySignalState {
	/** The latest signal; null before the first session of this engine. */
	signal: RekeySignal | null = null;
	/** Removals a won revoke record covered and the relay has not yet acknowledged; 0 = none. */
	private owed = 0;

	constructor(
		/** The live session (only its VAULT_REKEYED send is used). */
		private readonly session: () => Pick<RelaySession, "ackRekey"> | null,
		private readonly changed: () => void,
	) {}

	/** VAULT_READY.rekey of a new session, or a VAULT_REKEY. */
	note(signal: RekeySignal): void {
		const same = this.signal !== null && this.signal.removals === signal.removals && this.signal.rekeyed === signal.rekeyed;
		this.signal = signal;
		if (signal.rekeyed >= this.owed) this.owed = 0;
		this.flush();
		if (!same) this.changed();
	}

	/** A revoke record of this engine won; `removals` is the count it had seen when the command started. */
	covered(removals: number): void {
		if (removals <= (this.signal?.rekeyed ?? 0) || removals <= this.owed) return;
		this.owed = removals;
		this.flush();
	}

	/** The count still owed to the relay (tests, diagnostics); 0 = none. */
	get pendingAck(): number {
		return this.owed;
	}

	private flush(): void {
		if (this.owed === 0) return;
		const s = this.session();
		if (!s) return; // sent by note() at the next session's VAULT_READY
		try {
			s.ackRekey(this.owed);
		} catch {
			// A read-only session never carries a won revoke; nothing to send there.
		}
	}
}
