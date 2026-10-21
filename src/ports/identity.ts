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

/** `POST /auth/device/retire` (the successor fence, identity-per-store §5.2 step 1), as the engine reads it. */
export type RetireOutcome =
	/** 200: retired now (`retired: true`), or already gone (`false`: retired before, or never registered). */
	| { readonly ok: true; readonly retired: boolean }
	/** 401 (a wrong key, or a device without one), 429 / 503, or no answer: the fence did not happen. */
	| { readonly ok: false; readonly reason: "unauthorized" | "rate-limited" | "network" };

/** `GET /vault/:id/auth/grant` as the store's device (identity-per-store §3.4): the grant's current secret. */
export type GrantFetchOutcome =
	| { readonly ok: true; readonly grantSecret: string }
	/**
	 * no-store: no device token in use yet; unavailable: never rotated (`404`, the client's own secret is current);
	 * refused: `401` / `403` (a retired store, a revoked pairing, an old enroll); network: no answer, 429 or 5xx.
	 */
	| { readonly ok: false; readonly reason: "no-store" | "unavailable" | "refused" | "network" };

/** A device's state as the server knows it (`POST /auth/device/status`, the abandoned-creator rule). */
export type DeviceState = "live" | "retired" | "unknown";

export interface IdentityPort {
	/** `POST /vault/:id/auth/device {deviceId, deviceToken, retireKeyHash}` with the grant. Never throws. */
	register(c: { readonly deviceId: DeviceId; readonly deviceToken: string; readonly retireKeyHash: string }): Promise<RegisterOutcome>;
	/** SECRET: from now on the relay and blob adapters authenticate as this store's device token. */
	use(deviceToken: string): void;
	/**
	 * `POST /vault/:id/auth/device/retire {deviceId, retireKey}`: retire a predecessor store by its retire key (the
	 * successor fence, identity-per-store §5.2 step 1). Never throws. Absent: no fence (§5.2 "without the fence").
	 */
	retire?(c: { readonly deviceId: DeviceId; readonly retireKey: string }): Promise<RetireOutcome>;
	/**
	 * `POST /vault/:id/auth/device/status {deviceIds}` as this store's device: which of these devices the server holds
	 * live, retired (tombstoned) or does not know. null: no answer. Never throws. Absent: never known retired.
	 */
	status?(deviceIds: readonly DeviceId[]): Promise<ReadonlyMap<DeviceId, DeviceState> | null>;
	/**
	 * `GET /vault/:id/auth/grant` as this store's device (identity-per-store §3.4): the grant's secret after a rotation.
	 * Never throws. Absent: no rotation support (a rotated grant then needs a re-pair).
	 */
	fetchGrant?(): Promise<GrantFetchOutcome>;
	/** SECRET: from now on registration authenticates with this grant secret (a rotation's, fetched by fetchGrant). */
	useGrant?(grantSecret: string): void;
	/**
	 * Sim and tests: the credentials of the next store (deterministic, readable ids). Absent: the engine draws them
	 * from its RandomPort (identity-per-store §4: 16, 32 and 32 random bytes).
	 */
	mint?(): StoreCredentials;
}
