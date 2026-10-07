/**
 * The suite pin in data.json (e2ee-design §6.1, §12.4). Not secret. Exactly four states:
 *
 *   absent                              unpinned, has not read a k genesis
 *   { suite: null, keyringSeen: true }  unpinned, has read a k genesis for its vault (sticky): no suite-0 link
 *   { suite: 0 }                        pinned plaintext (from a suite-0 link or the creation opt-out)
 *   { suite: 1 }                        pinned encrypted (a verified key, or the creation path)
 *
 * Fail closed: absent means unpinned and blocked (phase key-missing, writes nothing), never suite 0. Nothing is
 * inferred from a stored pairing or from the server, and legacy data is not migrated (DESIGN.md "Legacy YAOS vault
 * data is not migrated"). Main sets a pin only after an authenticated answer: a successful pinSuite0 / enableE2ee,
 * or a keyringChanged that stored a verified key (§18.4). A pin is never lowered and never changed by the server.
 *
 * `creating: { vaultId }` (§15.1) marks a vault this device just created on the server; it is dropped once a pin is
 * set, and only it allows enableE2ee and pinSuite0 "create".
 */

import { isVaultId } from "../../core/codec/ids";

export type E2eePin =
	| { readonly suite: null; readonly keyringSeen: true }
	| { readonly suite: 0 }
	| { readonly suite: 1 };

export interface CreatingMarker {
	readonly vaultId: string;
}

/** The data.json fields this module owns (YaosPluginData has them too). */
export interface PinFields {
	readonly e2ee?: E2eePin;
	readonly creating?: CreatingMarker;
}

/** Tolerant loader: anything but the four states is absent (unpinned). */
export function sanitizePin(raw: unknown): E2eePin | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as { suite?: unknown; keyringSeen?: unknown };
	if (r.suite === 0) return { suite: 0 };
	if (r.suite === 1) return { suite: 1 };
	if (r.suite === null && r.keyringSeen === true) return { suite: null, keyringSeen: true };
	return undefined;
}

export function sanitizeCreating(raw: unknown): CreatingMarker | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const v = (raw as { vaultId?: unknown }).vaultId;
	return typeof v === "string" && isVaultId(v) ? { vaultId: v } : undefined;
}

/** The pinned suite, null when unpinned. */
export function pinnedSuite(pin: E2eePin | undefined): 0 | 1 | null {
	return pin === undefined ? null : pin.suite;
}

export function keyringSeenOf(pin: E2eePin | undefined): boolean {
	return pin !== undefined && pin.suite === null;
}

/** Whether `d` is on the creation path for `vaultId` (§15.1). */
export function isCreating(d: PinFields, vaultId: string | null): boolean {
	return vaultId !== null && d.creating?.vaultId === vaultId && pinnedSuite(d.e2ee) === null;
}

export type PinRefusal = "already-pinned" | "keyring-seen" | "not-creating" | "suite-0-pinned" | "not-encrypted";

/** Main's own check before a pin command reaches the engine (the engine checks `k` itself, §18.4). */
export function refusePinSuite0(d: PinFields, vaultId: string | null, source: "link" | "create"): PinRefusal | null {
	if (pinnedSuite(d.e2ee) !== null) return "already-pinned";
	if (source === "link" && keyringSeenOf(d.e2ee)) return "keyring-seen";
	if (source === "create" && !isCreating(d, vaultId)) return "not-creating";
	return null;
}

export function refuseEnableE2ee(d: PinFields, vaultId: string | null): PinRefusal | null {
	if (pinnedSuite(d.e2ee) !== null) return "already-pinned";
	if (!isCreating(d, vaultId)) return "not-creating";
	return null;
}

/** installKey / revokeRekey: a suite-0 device never takes a key (1 never follows 0 here; §15.2 has no 0 -> 1). */
export function refuseKeyCommand(d: PinFields, t: "installKey" | "revokeRekey"): PinRefusal | null {
	const s = pinnedSuite(d.e2ee);
	if (s === 0) return "suite-0-pinned";
	if (t === "revokeRekey" && s !== 1) return "not-encrypted";
	return null;
}

export const PIN_REFUSAL_TEXT: Readonly<Record<PinRefusal, string>> = {
	"already-pinned": "this device's encryption setting for the vault is already decided",
	"keyring-seen": "this vault is encrypted; pair with a key (QR code or recovery key) instead of a plain link",
	"not-creating": "only the device that just created this vault can choose its encryption",
	"suite-0-pinned": "this vault is not encrypted on this device",
	"not-encrypted": "this device does not hold the vault key yet",
};

/** Drop the creation marker together with setting a pin. */
function withPin<T extends PinFields>(d: T, pin: E2eePin): T {
	const { creating: _dropped, ...rest } = d;
	return { ...rest, e2ee: pin } as T;
}

/** After a successful pinSuite0 (§12.4 (ii), (iii)). Unchanged when the transition is not allowed. */
export function pinnedSuite0<T extends PinFields>(d: T): T {
	return pinnedSuite(d.e2ee) === null ? withPin(d, { suite: 0 }) : d;
}

/** After a successful enableE2ee, or a keyringChanged that stored a verified key (§12.4 (i), (iii)). */
export function pinnedSuite1<T extends PinFields>(d: T): T {
	return pinnedSuite(d.e2ee) === null ? withPin(d, { suite: 1 }) : d;
}

/** The engine reported a k genesis while unpinned (sticky; nothing changes once pinned). */
export function sawKeyring<T extends PinFields>(d: T): T {
	return d.e2ee === undefined ? { ...d, e2ee: { suite: null, keyringSeen: true } } : d;
}

/** Leaving a vault (unpair, another vault or relay): the pin and marker belong to the old vault. */
export function withoutPin<T extends PinFields>(d: T): T {
	if (d.e2ee === undefined && d.creating === undefined) return d;
	const { e2ee: _e, creating: _c, ...rest } = d;
	return rest as T;
}

/**
 * §15.1 step 1 done: this device created `vaultId` on the server. Written before enrolling (crash recovery), so the
 * device may still be enrolled in another vault; it is refused only for the vault the device is enrolled in and
 * already pinned for (a pin is never re-decided).
 */
export function markedCreating<T extends PinFields>(d: T, vaultId: string, enrolledVaultId: string | null): T {
	if (enrolledVaultId === vaultId && pinnedSuite(d.e2ee) !== null) return d;
	return { ...d, creating: { vaultId } };
}

/**
 * §15.1: the creation flow for `vaultId` failed its step-3 check ("The server returned a vault that is not empty").
 * The marker goes, so the device stays unpinned and blocked (§12.4) and never resumes as a creation. A marker for
 * another vault is left alone.
 */
export function withoutCreating<T extends PinFields>(d: T, vaultId: string): T {
	if (d.creating?.vaultId !== vaultId) return d;
	const { creating: _c, ...rest } = d;
	return rest as T;
}

/**
 * The pin fields across a data.json update (the UI never writes them). The pin is kept while the device stays in
 * the same vault and dropped otherwise. The creation marker is written before the enroll it precedes (§15.1), so
 * it survives until the device enrolls in a vault other than the marked one.
 */
export function pinAcross<T extends PinFields>(prev: PinFields, next: T, sameVault: boolean, nextVaultId: string | null): T {
	const { e2ee: _e, creating: _c, ...rest } = next;
	const pin = sameVault ? prev.e2ee : undefined;
	const marker = prev.creating;
	const keepMarker = marker !== undefined && (sameVault || nextVaultId === null || nextVaultId === marker.vaultId);
	return { ...rest, ...(pin ? { e2ee: pin } : {}), ...(keepMarker ? { creating: marker } : {}) } as T;
}

/**
 * Should a stored keyringChanged pin suite 1 (§18.4 (i))? Only on an unpinned device, only once nothing is pending
 * (a proposed record not yet settled), and only when the store holds a key and a record for the vault.
 */
export function pinsFromKeyring(pin: E2eePin | undefined, pending: number | null, stored: { readonly keys: number; readonly records: number }): boolean {
	return pinnedSuite(pin) === null && pending === null && stored.keys > 0 && stored.records > 0;
}
