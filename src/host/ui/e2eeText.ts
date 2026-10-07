/**
 * User-facing text for end-to-end encryption (e2ee-design §12.4, §13, §14.2, §15.1). Pure: no obsidian runtime, no
 * DOM, so the exact wording is unit-tested. No text here ever contains a key, a recovery key or a link.
 */

import type { KeyMissingReason } from "../../protocol/status";
import { errorMessage } from "./format";

/** §15.1: every failed check of the creation path ends with this, and sets no pin. */
export const NOT_EMPTY_MESSAGE = "The server returned a vault that is not empty";

/** §12.4, §15.1: "Create a new vault" on a paired device without its vault's pin and key, or before the engine says. */
export const CREATE_BLOCKED_MESSAGE =
	"This device cannot create a vault until it has the key for the vault it is paired with and YAOS is running. Enter your recovery key or scan a QR code from one of your devices first.";

/** §12.4 no-pin text, verbatim. */
export const NO_PIN_TEXT =
	"YAOS can't tell whether this vault is end-to-end encrypted. The server says it holds no encryption key record, but a server can hide one, so this device will not sync until one of your own devices or your recovery key settles it.";

/** Why this device is blocked, one paragraph per §12.4 reason. */
export function keyMissingText(reason: KeyMissingReason): string {
	switch (reason) {
		case "no-pin":
			return NO_PIN_TEXT;
		case "encrypted-vault":
			return "This vault is end-to-end encrypted. This device does not have the vault key, so it will not sync until one of your own devices or your recovery key gives it the key.";
		case "no-key":
			return "This vault is end-to-end encrypted. This device's stored vault key is missing (for example after the system keychain was reset), so it will not sync until one of your own devices or your recovery key gives it the key again.";
		case "revoked-epoch":
			return "This vault is end-to-end encrypted, and its key was changed after a device was removed. This device does not have the new key, so it will not sync until it is re-keyed: scan the re-key QR from the device that changed the key, or enter your recovery key.";
	}
}

/** Shown under the reason while a key from a QR code or link waits for a matching key record (§12.4 (i)). */
export const PENDING_QR_TEXT =
	"The key from the QR code or link you opened does not match any key record of this vault yet. YAOS keeps it in memory only and checks it again as records arrive. If nothing changes, show a fresh QR on one of your devices, or enter your recovery key.";

/** §12.4: what "Scan QR from one of your devices" tells the user. Labels are the real YAOS ones. */
export const SCAN_QR_TEXT =
	"On a device that already syncs this vault, open YAOS settings and choose \"Pair another device\" (or \"Show re-key QR\"), then scan the QR code it shows with this device's camera. On a device without a camera, open the setup link copied from that screen instead.";

/** §12.1: the warning next to "Copy setup link", verbatim. */
export const COPY_LINK_WARNING =
	"This link contains your vault key. Send it only over a channel you trust (AirDrop, a cable), never a chat app.";

/** §13.2: the advice next to a recovery key shown once, verbatim. */
export const STORE_RK_ADVICE = "Store it outside this vault: a password manager or paper";

/** §12.3, D6: the hint next to the device name. */
export const DEVICE_NAME_HINT = "Visible to the server operator";

/** §14.2 step 3: after a revoke re-key. */
export const REKEY_EVERY_DEVICE_TEXT =
	"Re-key EVERY other device you keep: scan this QR with each one's camera, or enter the recovery key there. A device that is not re-keyed stops syncing until it is.";

/** The engine's refusal texts (src/engine/compose/keyReader.ts, runtimeOps.ts, keyringRuntime.ts) and what the user reads. */
const ENGINE_REFUSALS: readonly (readonly [string, string])[] = [
	["the key does not match the vault's key record for its epoch", "This key does not match the vault's key record, so YAOS did not use it. Take the QR code or link from one of your own devices that syncs this vault, or enter your recovery key."],
	["this device does not hold the vault key; install it first", "This device does not have the vault key yet. Enter your recovery key or scan a QR code from one of your devices first."],
	["revoke needs", "Re-keying needs an end-to-end encrypted vault whose key this device holds."],
	["this device cannot hold a vault key", "This vault is not encrypted on this device, so it cannot take a vault key."],
	["this device is pinned to suite 0", "This vault is not encrypted on this device, so it cannot take a vault key."],
	["this device is already pinned", "This device's encryption setting for the vault is already decided."],
	["not on the creation path", "YAOS could not confirm that this is the empty vault this device just created."],
	["this device has read an encryption key record for the vault", "This vault is end-to-end encrypted, so a link without a key cannot set it up. Use a QR code from one of your devices, or your recovery key."],
	["k is not read to head yet", "YAOS is still reading the vault's encryption records. Try again in a moment."],
	["k is not empty", "This vault has encryption key records, so a link without a key cannot set it up. Use a QR code from one of your devices, or your recovery key."],
	["a key record is already in flight", "YAOS is already writing an encryption key record. Wait for it to finish."],
	["another genesis won", NOT_EMPTY_MESSAGE + "."],
	["another key record won the epoch", "Another device changed the vault key at the same moment. Run \"Re-key after revoking a device\" again."],
	["the genesis was not committed", "The server did not save the encryption key record. Try again."],
];

/**
 * The text for a failed key or pin command (host.command rejects with an Error whose message is safe): the engine's
 * `refused: ...` texts get a plain sentence, main's own refusals (PinRefusedError, "YAOS: ...") lose their prefix.
 * The result has no "YAOS:" prefix; callers add it where a notice needs it.
 */
export function keyCommandMessage(err: unknown): string {
	const raw = errorMessage(err);
	if (raw.startsWith("refused: ")) {
		const detail = raw.slice("refused: ".length);
		for (const [needle, text] of ENGINE_REFUSALS) if (detail.startsWith(needle)) return text;
		return `The vault refused this: ${detail}.`;
	}
	if (raw.startsWith("YAOS: ")) {
		const rest = raw.slice("YAOS: ".length);
		return rest.charAt(0).toUpperCase() + rest.slice(1);
	}
	if (raw === "YAOS is not running.") return "YAOS is not running. Wait until it has started, then try again.";
	return raw;
}
