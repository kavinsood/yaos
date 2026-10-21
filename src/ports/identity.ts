/**
 * IdentityPort: how the engine registers a new store's device identity under the install's pairing grant and
 * then authenticates as it (identity-per-store §3.2, §4; relay-wire §2.4.1). The grant secret stays inside the
 * adapter (it rides `Authorization: Grant <secret>`); the engine only ever sees the outcome.
 *
 * Production: adapters/relayHttp.ts registerDevice over the relay, and a credential cell the relay and blob
 * adapters read per call. Simulation: SimNet's registry.
 */

import type { DeviceId } from "../core/types";

/** A store identity as minted (identity-per-store §4 "Mint"). deviceToken and retireKey are SECRET. */
export interface StoreCredentials {
	readonly deviceId: DeviceId;
	/** SECRET: 32 random bytes, base64url. */
	readonly deviceToken: string;
	/** SECRET: 32 random bytes, base64url; the server keeps its SHA-256 (hex) as the retire hash. */
	readonly retireKey: string;
}

/** Why a registration was refused (relay-wire §2.4.1 errors), or did not reach the server. */
export type RegisterRefusal =
	/** No answer, or a 5xx: retry later. */
	| "network"
	/** `401 unauthorized`: the server does not know the grant (deleted vault, a secret it never saw). Re-pair. */
	| "unauthorized"
	/** `401 grant_revoked`: the pairing was revoked (console or leave). Re-pair. */
	| "grant-revoked"
	/** `403 grant_required`: a device enrolled without a grant. Re-pair. */
	| "grant-required"
	/** `409 device_exists`: the id or the token is taken. Mint again. */
	| "device-exists"
	/** `409 device_retired`: the id was retired once and never comes back. Mint again. */
	| "device-retired"
	/** `409 device_limit`: 50 live devices on this pairing. Retire old stores in the console. */
	| "device-limit"
	/** `429 registration_limit` (+ Retry-After to 00:00 UTC): 20 registrations a UTC day on this pairing. */
	| "registration-limit"
	/** `429 too_many_attempts`, or `503 restore_in_progress` / daily limit: wait and retry. */
	| "rate-limited"
	/** No grant in this install's data (unpaired), or the engine runs without registration. */
	| "no-grant";

export type RegisterOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: RegisterRefusal; readonly retryAfterMs: number | null };

export interface IdentityPort {
	/** `POST /vault/:id/auth/device {deviceId, deviceToken, retireKeyHash}` with the grant. Never throws. */
	register(c: { readonly deviceId: DeviceId; readonly deviceToken: string; readonly retireKeyHash: string }): Promise<RegisterOutcome>;
	/** SECRET: from now on the relay and blob adapters authenticate as this store's device token. */
	use(deviceToken: string): void;
	/**
	 * Sim and tests: the credentials of the next store (deterministic, readable ids). Absent: the engine draws them
	 * from its RandomPort (identity-per-store §4: 16, 32 and 32 random bytes).
	 */
	mint?(): StoreCredentials;
}
