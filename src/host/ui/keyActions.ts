/**
 * Getting a vault key onto this device, and changing it after a revoke (e2ee-design §12.1, §12.4, §13.3, §14.2).
 * Pure (no obsidian runtime): the modals in keyModals.ts and the obsidian://yaos handler in registerUi.ts drive it.
 *
 * Nothing here creates a vault or chooses a new vault's encryption: a link, a typed or scanned code and a recovery
 * key only ever take an existing vault's key (installKey) or a `suite=0` link (pinSuite0 "link", which the engine
 * refuses once it has read a key record). Creation is createVault.ts, which this module never imports.
 *
 * SECRETS: vault keys, recovery keys and the links that carry them. They are handed to the engine (a copy per
 * attempt) and zero-filled; no message here ever contains one.
 */

import type { UserCommand } from "../../protocol/messages";
import type { StatusSnapshot } from "../../protocol/status";
import type { YaosPluginData, YaosUiHost } from "./api";
import { keyCommandMessage } from "./e2eeText";
import { waitFor, type WaitOptions } from "./hostWait";
import { buildRekeyLink, buildSetupLink, pairingCodeVaultId, type LinkE2ee, type LinkKey, type SetupLinkParse } from "./pairing";
import { readRecoveryKey } from "./recoveryKeyText";

export type KeyHost = Pick<YaosUiHost, "data" | "status" | "runState" | "onChange" | "command">;

// ---------------------------------------------------------------------------
// obsidian://yaos links
// ---------------------------------------------------------------------------

export type SetupLinkRoute =
	/** Nothing to do; show `message`. */
	| { readonly kind: "ignore"; readonly message: string }
	/**
	 * The link is for the vault this device is already enrolled in (a re-key link, or a setup link whose pairing
	 * code names this vault): take only its key or `suite=0`, never re-enroll (§12.4).
	 */
	| { readonly kind: "apply"; readonly e2ee: LinkE2ee }
	/** Another vault or server, or this device is unpaired or revoked: the pair modal, prefilled. */
	| { readonly kind: "pair"; readonly host: string; readonly pairingCode: string; readonly e2ee: LinkE2ee | null };

/**
 * Where an obsidian://yaos link goes. There is no route to "Create a new vault": a link only ever joins a vault or
 * hands over its key. A route that drops the link zero-fills its key.
 */
export function routeSetupLink(parsed: SetupLinkParse, data: YaosPluginData, status: StatusSnapshot | null): SetupLinkRoute {
	if (!parsed.ok) return { kind: "ignore", message: parsed.reason };
	const identity = data.identity;
	if (parsed.kind === "rekey") {
		if (!identity) {
			parsed.key.k.fill(0);
			return { kind: "ignore", message: "This re-key link is for a device that already syncs the vault. Pair this device first." };
		}
		return { kind: "apply", e2ee: { suite: 1, key: parsed.key } };
	}
	const sameVault = identity !== null
		&& pairingCodeVaultId(parsed.pairingCode) === identity.vaultId
		&& parsed.host === identity.host
		&& status?.phase !== "revoked";
	if (!sameVault) return { kind: "pair", host: parsed.host, pairingCode: parsed.pairingCode, e2ee: parsed.e2ee };
	if (!parsed.e2ee) {
		return { kind: "ignore", message: "This device is already paired with this vault, and the link carries no vault key, so there is nothing to take from it. Use a QR code from one of your devices, or your recovery key." };
	}
	return { kind: "apply", e2ee: parsed.e2ee };
}

// ---------------------------------------------------------------------------
// Commands that may meet a starting engine
// ---------------------------------------------------------------------------

export interface RetryOptions extends WaitOptions {
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}

/** The engine is not up yet (just paired or restarting), or `k` is still being read: worth another try. */
function transient(err: unknown): boolean {
	const m = err instanceof Error ? err.message : "";
	return m === "YAOS is not running." || m.startsWith("not-ready:") || m.startsWith("timeout:") || m.startsWith("refused: k is not read to head yet");
}

/** Sends `make()` (a fresh command per attempt: its bytes are transferred) until it answers or is refused for good. */
async function sendRetrying(host: KeyHost, make: () => UserCommand, opts: RetryOptions, timeoutMs: number): Promise<void> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = now() + (opts.timeoutMs ?? timeoutMs);
	for (;;) {
		try {
			await host.command(make());
			return;
		} catch (err) {
			if (!transient(err) || now() >= deadline) throw new Error(keyCommandMessage(err));
			await sleep(1000);
		}
	}
}

/** Pinned to suite 1 by main and the engine reports a usable key: the key was verified against a `k` record. */
function keyUsable(host: Pick<YaosUiHost, "data" | "status">): boolean {
	return host.data().e2ee?.suite === 1 && host.status()?.e2ee?.keyMissing === null;
}

export type KeyOutcome =
	/** A key record matched: main pinned suite 1 and the device syncs. */
	| "verified"
	/** The engine holds the key in memory until a matching record arrives (§12.4 (i)); the device stays blocked. */
	| "pending"
	/** A `suite=0` link: this device now syncs the vault without end-to-end encryption. */
	| "suite0";

/**
 * Applies a link's encryption part to the vault this device is enrolled in (`vaultId`). A key goes to the engine
 * as installKey "qr", and `e2ee.key.k` is zero-filled; `suite=0` is pinSuite0 "link". Rejects with a safe message.
 */
export async function applyLinkE2ee(host: KeyHost, vaultId: string, e2ee: LinkE2ee, opts: RetryOptions = {}): Promise<KeyOutcome> {
	try {
		if (host.data().identity?.vaultId !== vaultId) throw new Error("This device is no longer paired with the vault of that link.");
		if (e2ee.suite === 0) {
			await sendRetrying(host, () => ({ t: "pinSuite0", source: "link" }), opts, 60_000);
			return "suite0";
		}
		const { e, k } = e2ee.key;
		await sendRetrying(host, () => ({ t: "installKey", source: "qr", e, k: k.slice() }), opts, 60_000);
		k.fill(0);
		const ok = await waitFor(host, () => (keyUsable(host) ? true : null), 20_000, opts);
		return ok ? "verified" : "pending";
	} finally {
		if (e2ee.suite === 1) e2ee.key.k.fill(0);
	}
}

// ---------------------------------------------------------------------------
// Recovery key (§13.3)
// ---------------------------------------------------------------------------

export const RK_MALFORMED_MESSAGE = "That is not a complete recovery key. It starts with YAOS-RK1- and has 14 groups of 4 characters.";
export const RK_CHECKSUM_MESSAGE = "This recovery key has a typo: its checksum does not match. Check each group and try again.";

/**
 * "Enter recovery key": checked on main first (format, then the engine's checksum), then installKey "rk". The
 * engine opens the vault's wrapped keys with it; a key that opens none stays pending, which a wrong but well-formed
 * recovery key also does. Rejects with a safe message.
 */
export async function installRecoveryKey(host: KeyHost & Pick<YaosUiHost, "rkChecksum">, text: string, opts: RetryOptions = {}): Promise<Exclude<KeyOutcome, "suite0">> {
	const read = await readRecoveryKey(text, (s) => host.rkChecksum(s)).catch((err: unknown) => { throw new Error(keyCommandMessage(err)); });
	if (!read.ok) throw new Error(read.reason === "malformed" ? RK_MALFORMED_MESSAGE : RK_CHECKSUM_MESSAGE);
	const rk = read.rk;
	try {
		await sendRetrying(host, () => ({ t: "installKey", source: "rk", rk: rk.slice() }), opts, 30_000);
	} finally {
		rk.fill(0);
	}
	const ok = await waitFor(host, () => (keyUsable(host) ? true : null), 20_000, opts);
	return ok ? "verified" : "pending";
}

// ---------------------------------------------------------------------------
// QR codes this device shows (§12.1, §14.2 step 3)
// ---------------------------------------------------------------------------

/**
 * The encryption part of a pairing link from this device: its key when it holds one, `suite=0` when it is pinned
 * to suite 0, null otherwise (unpinned, or the key is missing: it has nothing to hand on). The key is a SECRET copy.
 */
export function pairingLinkE2ee(host: Pick<YaosUiHost, "data" | "vaultKeyForQr">): LinkE2ee | null {
	const suite = host.data().e2ee?.suite;
	if (suite === 0) return { suite: 0 };
	if (suite !== 1) return null;
	const key = host.vaultKeyForQr();
	return key ? { suite: 1, key } : null;
}

/** SECRET: a setup link with this device's key or `suite=0`, from a pairing code; the copied key is zero-filled. */
export function pairingLink(host: string, pairingCode: string, e2ee: LinkE2ee): string {
	try {
		return buildSetupLink(host, pairingCode, e2ee);
	} finally {
		if (e2ee.suite === 1) e2ee.key.k.fill(0);
	}
}

/** SECRET: the re-key link of the key this device seals under, or null when it holds none. */
export function rekeyLinkNow(host: Pick<YaosUiHost, "data" | "vaultKeyForQr">): string | null {
	if (host.data().e2ee?.suite !== 1) return null;
	const key: LinkKey | null = host.vaultKeyForQr();
	if (!key) return null;
	try {
		return buildRekeyLink(key);
	} finally {
		key.k.fill(0);
	}
}

// ---------------------------------------------------------------------------
// Re-key after a revoke (§14.2, decisions D1, D8)
// ---------------------------------------------------------------------------

/** Why this device cannot re-key now, or null when it can: it must be pinned to suite 1 and hold the current key. */
export function rekeyBlocked(host: Pick<YaosUiHost, "data" | "status">): string | null {
	const suite = host.data().e2ee?.suite;
	if (suite === 0) return "This vault is not end-to-end encrypted on this device, so there is no key to change.";
	if (suite !== 1) return "This device does not have the vault key yet. Enter your recovery key or scan a QR code from one of your devices first.";
	const e2ee = host.status()?.e2ee;
	if (!e2ee) return "YAOS is not running. Wait until it has started, then try again.";
	if (e2ee.keyMissing !== null) return "This device does not have the vault's current key. Enter your recovery key first.";
	return null;
}

/**
 * Seals a new epoch's key and wraps it under `rk` (35 bytes; the existing recovery key or a new one the user has
 * just saved and confirmed). `rk` is transferred and zero-filled. Resolves with the new epoch once the engine seals
 * under it; then show rekeyLinkNow on every device the user keeps. Rejects with a safe message.
 *
 * The engine does not check that a typed `rk` is the one in force: from the new epoch on, the key given here is the
 * recovery key (D8).
 */
export async function revokeRekey(host: KeyHost, rk: Uint8Array, opts: WaitOptions = {}): Promise<number> {
	try {
		const blocked = rekeyBlocked(host);
		if (blocked) throw new Error(blocked);
		const before = host.status()?.e2ee?.sealEpoch ?? 0;
		try {
			await host.command({ t: "revokeRekey", rk: rk.slice() });
		} catch (err) {
			throw new Error(keyCommandMessage(err));
		}
		const epoch = await waitFor(host, () => {
			const e2ee = host.status()?.e2ee;
			return e2ee && e2ee.keyMissing === null && e2ee.sealEpoch > before ? e2ee.sealEpoch : null;
		}, 60_000, opts);
		if (epoch === null) throw new Error("The new key record was sent, but YAOS has not seen the server keep it yet. Wait until this device is online, then run \"Show re-key QR\".");
		return epoch;
	} finally {
		if (rk.byteLength > 0) rk.fill(0);
	}
}

// ---------------------------------------------------------------------------
// Pending keys (§12.4 (i)): kept in memory, shown on the blocked screen
// ---------------------------------------------------------------------------

/** Vaults for which a key from a QR or link is waiting for a matching record. Memory only, like the key itself. */
export class PendingQrKeys {
	private readonly vaults = new Set<string>();
	mark(vaultId: string): void { this.vaults.add(vaultId); }
	clear(vaultId: string): void { this.vaults.delete(vaultId); }
	/** Pending for the enrolled vault, while the device is still blocked. */
	shows(host: Pick<YaosUiHost, "data" | "status">): boolean {
		const vaultId = host.data().identity?.vaultId;
		if (!vaultId || !this.vaults.has(vaultId)) return false;
		if (keyUsable(host)) {
			this.vaults.delete(vaultId);
			return false;
		}
		return true;
	}
}
