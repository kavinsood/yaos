/**
 * The key-roll prompt after a device removal (e2ee-design §14.5). Pure: registerUi.ts opens the modal.
 *
 * Device governance lives in the server's operator console. When the operator blocks a device there ("Revoke
 * pairing", or "Revoke" of a device enrolled without a grant), the relay tells every live socket of the vault
 * (VAULT_REKEY) and every later one (VAULT_READY.rekey); the engine puts the pair in its status. While a removal is
 * not covered by a new vault key, an encrypted device that can make one asks the user, once per removal count per
 * plugin start. Nothing is stored on this device: the relay keeps the count until some device's won revoke record
 * covers it, so the prompt comes back after a restart, stops on every device once any of them rolled the key, and is
 * never shown as a status row. The roll itself is the existing "Re-key after revoking a device" flow (it needs the
 * recovery key; it is never automatic and has no "turn off" switch).
 */

import type { YaosUiHost } from "./api";
import { canRekey } from "./commands";

type StateHost = Pick<YaosUiHost, "data" | "status">;

export const REKEY_PROMPT_TITLE = "A device was removed from this vault";
export const REKEY_PROMPT_TEXT = "A device was removed in your server console. It can no longer sync, but it still has the vault key, so it could read notes written from now on if it ever got hold of them. Make a new vault key that it never gets.\n\nYou need your recovery key, or you can make a new one. Afterwards, scan the re-key QR code on each of your other devices.";
export const REKEY_PROMPT_CONFIRM = "Make a new vault key";
export const REKEY_PROMPT_LATER = "Not now";

/**
 * The removal count a key roll is due for, when this device should ask: it is pinned to suite 1 and holds the
 * current key (a suite-0 vault has no key to roll; a key-missing device cannot make one), and the relay's signal
 * shows a removal no new key covers yet. null otherwise, and while the engine has not reported a signal.
 */
export function rekeyDue(h: StateHost): number | null {
	if (!canRekey(h)) return null;
	const signal = h.status()?.rekey;
	if (!signal || signal.removals <= signal.rekeyed) return null;
	return signal.removals;
}

/** Remembers which (vault, removal count) pairs were shown in this plugin start, so each asks at most once. */
export class RekeyPromptTracker {
	private readonly shown = new Set<string>();

	/** True the first time a roll is due for this vault at this removal count. */
	shouldOpen(h: StateHost): boolean {
		const due = rekeyDue(h);
		const vaultId = h.data().identity?.vaultId;
		if (due === null || !vaultId) return false;
		const key = `${vaultId}\u0000${due}`;
		if (this.shown.has(key)) return false;
		this.shown.add(key);
		return true;
	}
}
