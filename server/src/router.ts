// Worker router (DECISIONS §2.1, §2.2): the route table, method and path match, size caps and format checks, then a
// forward to one Durable Object. worker.ts is the entry module that serves it. Stateless except for `claimed`, cached
// in isolate memory once seen (D2). It does no crypto and no storage writes, and device routes never touch the config
// DO (T-HOTPATH).
import { randomBase64Url } from "./base64url";
import { CONFIG_OBJECT_NAME, type ConfigDO } from "./config/config";
import { consolePage } from "./console/console";
import { mobileSetupPage } from "./console/mobileSetup";
import { SESSION_TOKEN_PATTERN, SESSION_TTL_MS, type FrozenAction } from "./config/host";
import { dailyLimitKind, dailyLimitResponse, isCloudflareDailyLimitError } from "./dailyLimit";
import {
	corsPreflight,
	json,
	notFound,
	rejectSocket,
	releaseUnreadBody,
	withCors,
} from "./http";
import { tooManyAttempts } from "./limiter";
import type { UpgradeRejectPort } from "./ports";
import { BoundedBodyError, declaredBodyLength, readBoundedBytes } from "./readBoundedBytes";
import { buildMobileSetupUrl, buildObsidianPairingUrl, renderSetupQrDataUrl } from "./setupQr";
import { MAX_STREAM_CHECKPOINT_BYTES, STREAMS_CAPABILITY_VERSION } from "./streams/protocol";
import { ORIGIN_HEADER } from "./vault/host";
import { isPairingPurpose, type PairingPurpose } from "./vault/pairing";
import type { VaultDO, VaultEnv } from "./vault/vault";
import { isVaultId } from "./vaultId";
import { SERVER_VERSION } from "./version";

export interface WorkerEnv extends VaultEnv {
	YAOS_VAULT: DurableObjectNamespace<VaultDO>;
	YAOS_CONFIG: DurableObjectNamespace<ConfigDO>;
	YAOS_BUCKET?: R2Bucket;
}

/** Capabilities `maxBlobUploadBytes` and the blob PUT cap (relay-wire §11.3, unchanged). */
export const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;
/**
 * DECISIONS-GAP: §2.2 caps the claim JSON at 64 KiB but names no cap for /enroll, whose body the Worker must parse to
 * route by code. The same 64 KiB is used; a larger body is `413 body_too_large`.
 */
export const MAX_ENROLL_BODY_BYTES = 64 * 1024;
/** D3: `<vaultId>.<secret>`, base64url(16 B) + "." + base64url(24 B), checked after trim. */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$/;
/** §2.2 blob address (relay-wire §11.3 after §5: 64 lowercase hex, no hash check). */
export const BLOB_ADDRESS_PATTERN = /^[0-9a-f]{64}$/;
/** D9: `POST /vault/:id/blobs/exists` answers for at most 50 addresses (legacy routes/blobs.ts:11 slice). */
export const MAX_BLOB_EXISTS_ADDRESSES = 50;
/** R2 HEADs in flight for one `exists` (legacy routes/blobs.ts:12). */
export const BLOB_HEAD_CONCURRENCY = 4;
/**
 * DECISIONS-GAP: D9 caps `exists` at 50 addresses but names no body cap; legacy read the body unbounded. 64 KiB (the
 * operator JSON cap; 50 addresses are ~3.5 KiB) is used; a larger body is `413 body_too_large`.
 */
export const MAX_BLOB_EXISTS_BODY_BYTES = 64 * 1024;
/**
 * DECISIONS-GAP: §2.2 does not give a format for the `:deviceId` path segment of the operator devices route. The
 * enroll body's deviceId format (legacy routes/enroll.ts:36) is used; anything else is 404.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The vault DO's internal origin. The Worker forwards `/vault/:id/<rest>` as `<origin>/<rest>`, `/enroll` as is. */
export const VAULT_INTERNAL_ORIGIN = "https://vault.internal";

/** §2.2: the claim JSON is at most 64 KiB; the other operator JSON bodies get the same cap. */
export const MAX_OPERATOR_BODY_BYTES = 64 * 1024;
/** D5 operator session cookie (the legacy name, removed identity.ts:11). */
export const OPERATOR_COOKIE = "yaos_op";
/** The first vault's name at claim (legacy routes/auth.ts:355). */
export const CLAIM_VAULT_NAME = "Personal";
/** Create vault: a blank name is "Vault" (legacy routes/operator.ts:121). */
export const DEFAULT_VAULT_NAME = "Vault";
/** DECISIONS-GAP: D5 names no vault-name limit; legacy's rename cap (routes/operator.ts:193) of 80 is used. */
export const MAX_VAULT_NAME_LENGTH = 80;
/**
 * D5 R2 purge: 1000 keys per list and delete (R2 `delete` takes at most 1000 keys). DECISIONS-GAP: D5 does not bound
 * the batches in one request; 20 (20,000 objects) keeps one delete well inside the per-request subrequest budget, and
 * a larger vault answers `503 purge_incomplete` and continues on the retry.
 */
export const PURGE_BATCH_SIZE = 1000;
export const MAX_PURGE_BATCHES = 20;

export interface RouterPorts {
	upgrades: UpgradeRejectPort;
}

/** streamsVersion as the legacy route read it (removed routes/vault.ts:146-151): blank or malformed → null. */
function declaredVersion(url: URL, name: string): number | null {
	const raw = url.searchParams.get(name);
	if (raw === null || raw.trim() === "") return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** `Set-Cookie` for a new session: D5 HttpOnly, Secure, SameSite=Strict, 7 days. */
export function sessionCookie(token: string): string {
	return `${OPERATOR_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export const CLEAR_SESSION_COOKIE = `${OPERATOR_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

/** The operator session token from `Cookie`, or null; a value that is not a session token's format counts as none. */
function sessionToken(request: Request): string | null {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const trimmed = part.trim();
		if (!trimmed.startsWith(`${OPERATOR_COOKIE}=`)) continue;
		const value = trimmed.slice(OPERATOR_COOKIE.length + 1).trim();
		return SESSION_TOKEN_PATTERN.test(value) ? value : null;
	}
	return null;
}

function withCookie(response: Response, cookie: string): Response {
	response.headers.append("Set-Cookie", cookie);
	return response;
}

/**
 * D5: "Operator JSON routes require `Content-Type: application/json` and a same-origin `Origin`." A browser sends
 * `Origin` on every non-GET fetch (Fetch standard), so a cross-site form or fetch is refused before any DO call.
 * DECISIONS-GAP: the D7 revoke DELETE has no body, so it needs `Origin` only; the other non-GET operator routes and
 * `/claim` need both. GETs need neither (they change nothing; SameSite=Strict keeps the cookie off cross-site loads).
 */
function crossSiteRejection(request: Request, url: URL, needsJson: boolean): Response | null {
	if (request.headers.get("Origin") !== url.origin) return json({ error: "forbidden_origin" }, 403);
	const mediaType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
	if (needsJson && mediaType !== "application/json") return json({ error: "unsupported_media_type" }, 415);
	return null;
}

type OperatorBody = { kind: "ok"; value: Record<string, unknown> } | { kind: "invalid" } | { kind: "too_large" };

/** An operator JSON body (≤ 64 KiB): an object, `invalid` (not JSON or not an object), or `too_large` (413). */
async function readOperatorBody(request: Request): Promise<OperatorBody> {
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedBytes(request, MAX_OPERATOR_BODY_BYTES, { allowEmpty: true });
	} catch (error) {
		if (!(error instanceof BoundedBodyError)) throw error;
		return error.kind === "body_too_large" ? { kind: "too_large" } : { kind: "invalid" };
	}
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return value && typeof value === "object" && !Array.isArray(value)
			? { kind: "ok", value: value as Record<string, unknown> }
			: { kind: "invalid" };
	} catch {
		return { kind: "invalid" };
	}
}

const bodyTooLarge = () => json({ error: "body_too_large" }, 413);
const unauthorized = () => json({ error: "unauthorized" }, 401);

/** The recovery key of a claim or login body, trimmed; legacy refused anything under 32 characters with 400. */
function recoveryKey(body: Record<string, unknown>): string | null {
	const key = typeof body.operatorRecoveryKey === "string" ? body.operatorRecoveryKey.trim() : "";
	return key.length >= 32 ? key : null;
}

/** A BoundedBodyError as `413 body_too_large` or `400 <kind>`; anything else is rethrown. */
function boundedBodyRejection(error: unknown): Response {
	if (!(error instanceof BoundedBodyError)) throw error;
	return json({ error: error.kind }, error.kind === "body_too_large" ? 413 : 400);
}

/** 413 or 400 for a Content-Length the cap refuses; null when the body may pass. */
function contentLengthRejection(request: Request, maxBytes: number): Response | null {
	try {
		declaredBodyLength(request, maxBytes);
		return null;
	} catch (error) {
		return boundedBodyRejection(error);
	}
}

export class Router {
	/** D2: `true` once the config DO said so; never re-read in this isolate. */
	private claimedSeen = false;

	constructor(private readonly ports: RouterPorts) {}

	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		try {
			return await this.route(request, env);
		} catch (error) {
			// O9: a Cloudflare daily-limit failure (here or thrown by a DO RPC) on any route is the typed `cf_daily_limit`.
			if (isCloudflareDailyLimitError(error)) return withCors(dailyLimitResponse(Date.now(), dailyLimitKind(error)));
			console.error("[yaos-worker] request failed", error);
			// DECISIONS-GAP: §2.2 names no status for an unexpected Worker failure; 500 `internal_error`.
			return withCors(json({ error: "internal_error" }, 500));
		} finally {
			await releaseUnreadBody(request);
		}
	}

	private async route(request: Request, env: WorkerEnv): Promise<Response> {
		const url = new URL(request.url);
		const { method } = request;
		const path = url.pathname;
		if (method === "OPTIONS" && (path.startsWith("/api/") || path === "/enroll" || path.startsWith("/vault/"))) {
			return corsPreflight();
		}
		switch (`${method} ${path}`) {
			case "GET /":
				return consolePage();
			case "GET /mobile-setup":
				return mobileSetupPage();
			case "GET /api/capabilities":
				return withCors(json(await this.capabilities(env)));
			case "POST /enroll":
				return withCors(await this.enroll(request, env));
			case "POST /claim":
				return await this.claim(request, env, url);
			case "POST /operator/login":
				return await this.login(request, env, url);
			case "POST /operator/logout":
				return await this.logout(request, env, url);
			case "GET /operator/state":
				return await this.operatorState(request, env);
			case "POST /operator/vaults":
				return await this.createVault(request, env, url);
		}
		const parts = path.split("/").slice(1);
		if (parts[0] === "operator" && parts[1] === "vaults" && isVaultId(parts[2])) {
			return await this.operatorVault(request, env, url, parts[2], parts.slice(3));
		}
		if (parts[0] === "vault" && isVaultId(parts[1])) {
			return this.vault(request, env, url, parts[1], parts.slice(2));
		}
		return withCors(notFound());
	}

	private config(env: WorkerEnv): DurableObjectStub<ConfigDO> {
		return env.YAOS_CONFIG.get(env.YAOS_CONFIG.idFromName(CONFIG_OBJECT_NAME));
	}

	private vaultObject(env: WorkerEnv, vaultId: string): DurableObjectStub<VaultDO> {
		return env.YAOS_VAULT.get(env.YAOS_VAULT.idFromName(vaultId));
	}

	/** `GET /api/capabilities`: the §5 (2.1) fields only. The config DO is asked until it says `claimed`. */
	private async capabilities(env: WorkerEnv): Promise<Record<string, unknown>> {
		if (!this.claimedSeen) this.claimedSeen = await this.config(env).isClaimed();
		return {
			claimed: this.claimedSeen,
			attachments: Boolean(env.YAOS_BUCKET),
			maxBlobUploadBytes: MAX_BLOB_UPLOAD_BYTES,
			serverVersion: SERVER_VERSION,
			streams: STREAMS_CAPABILITY_VERSION,
		};
	}

	// ---- D5 claim, login and sessions -------------------------------------------------------------------------

	/**
	 * `POST /claim` (D5): vault init → config claim (operator, vault, session: 3 rows) → owner code. The body and
	 * response are the legacy ones (§5 row 2.2). A failure after the config claim → 503: the server is claimed, and the
	 * operator logs in and uses owner-code.
	 */
	private async claim(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
		const rejected = crossSiteRejection(request, url, true);
		if (rejected) return rejected;
		const body = await readOperatorBody(request);
		if (body.kind === "too_large") return bodyTooLarge();
		if (body.kind === "invalid") return json({ error: "invalid json" }, 400);
		const key = recoveryKey(body.value);
		if (!key) return json({ error: "invalid operatorRecoveryKey" }, 400);
		const config = this.config(env);
		if (this.claimedSeen || await config.isClaimed()) {
			this.claimedSeen = true;
			return json({ error: "already_claimed" }, 409);
		}
		const vaultId = randomBase64Url(16);
		const vault = this.vaultObject(env, vaultId);
		await vault.init(vaultId);
		const claimed = await config.claim(key, vaultId, CLAIM_VAULT_NAME);
		if (!claimed.ok) {
			if (claimed.error === "already_claimed") this.claimedSeen = true;
			return json({ error: claimed.error }, claimed.status);
		}
		this.claimedSeen = true;
		const cookie = sessionCookie(claimed.sessionToken);
		const host = url.origin;
		try {
			const minted = await vault.mintOwnerCode("owner-bootstrap");
			if (!minted) throw new Error("the new vault refused the owner code");
			const mobileSetupQrDataUrl = await renderSetupQrDataUrl(buildMobileSetupUrl(host, minted.pairingCode));
			return withCookie(json({
				ok: true,
				host,
				vaultId,
				vaultName: CLAIM_VAULT_NAME,
				pairingCode: minted.pairingCode,
				pairingExpiresAt: minted.expiresAt,
				obsidianUrl: buildObsidianPairingUrl(host, minted.pairingCode),
				mobileSetupQrDataUrl,
				capabilities: await this.capabilities(env),
			}), cookie);
		} catch (error) {
			console.error("[yaos-worker] claim: owner code failed after the claim", error);
			// DECISIONS-GAP: D5 gives the status (503) but no code; `claim_incomplete`. The session is valid, so its
			// cookie is still set.
			return withCookie(json({ error: "claim_incomplete" }, 503), cookie);
		}
	}

	/** `POST /operator/login` (D5): 1 row (+1 per pruned session); the limiter answers 429 with Retry-After. */
	private async login(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
		const rejected = crossSiteRejection(request, url, true);
		if (rejected) return rejected;
		const body = await readOperatorBody(request);
		if (body.kind === "too_large") return bodyTooLarge();
		if (body.kind === "invalid") return json({ error: "invalid json" }, 400);
		const key = recoveryKey(body.value);
		if (!key) return json({ error: "invalid operatorRecoveryKey" }, 400);
		const result = await this.config(env).login(key);
		if (!result.ok) {
			return result.status === 429 ? tooManyAttempts(result.retryAfterMs ?? 1000) : json({ error: result.error }, result.status);
		}
		return withCookie(json({ ok: true }), sessionCookie(result.sessionToken));
	}

	/** `POST /operator/logout` (D5): deletes the session row (1 row) and clears the cookie. */
	private async logout(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
		const rejected = crossSiteRejection(request, url, true);
		if (rejected) return rejected;
		const token = sessionToken(request);
		if (token) await this.config(env).logout(token);
		return withCookie(json({ ok: true }), CLEAR_SESSION_COOKIE);
	}

	/** `GET /operator/state`: `{vaults: [{vaultId, name, createdAt}], pendingRestores: [{vaultId, at}]}`. */
	private async operatorState(request: Request, env: WorkerEnv): Promise<Response> {
		const token = sessionToken(request);
		if (!token) return unauthorized();
		const state = await this.config(env).state(token);
		if (!state.ok) return json({ error: state.error }, state.status);
		return json({ vaults: state.vaults, pendingRestores: state.pendingRestores });
	}

	/** `POST /operator/vaults` (D5): vault init first (1 row there), the registry row last (1 row). */
	private async createVault(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
		const rejected = crossSiteRejection(request, url, true);
		if (rejected) return rejected;
		const token = sessionToken(request);
		if (!token) return unauthorized();
		const config = this.config(env);
		const allowed = await config.authorize(token);
		if (!allowed.ok) return json({ error: allowed.error }, allowed.status);
		const body = await readOperatorBody(request);
		if (body.kind === "too_large") return bodyTooLarge();
		// Legacy: a body that is not JSON is `{}`, and a blank name is "Vault".
		const raw = body.kind === "ok" && typeof body.value.name === "string" ? body.value.name.trim() : "";
		const name = raw || DEFAULT_VAULT_NAME;
		if (name.length > MAX_VAULT_NAME_LENGTH) return json({ error: "invalid_name" }, 400);
		const vaultId = randomBase64Url(16);
		await this.vaultObject(env, vaultId).init(vaultId);
		const registered = await config.registerVault(vaultId, name);
		if (!registered.ok) return json({ error: registered.error }, registered.status);
		return json({ ok: true, vault: registered.vault });
	}

	// ---- /operator/vaults/:id/... ---------------------------------------------------------------------------

	/**
	 * `/operator/vaults/:id/...` (§2.2): owner code, devices, D7 revoke, D8a reset-streams, D8b restore, D5 delete. Every
	 * route asks the config DO for the session and the registry first; revoke, owner-code and reset-streams also pass
	 * D8b's authority freeze there.
	 */
	private async operatorVault(request: Request, env: WorkerEnv, url: URL, vaultId: string, rest: string[]):
		Promise<Response> {
		const route = `${request.method} ${rest.join("/")}`;
		const revokeTarget = request.method === "DELETE" && rest.length === 2 && rest[0] === "devices"
			&& DEVICE_ID_PATTERN.test(rest[1]!) ? rest[1]! : null;
		const known = route === "DELETE " || route === "POST owner-code" || route === "GET devices"
			|| route === "POST reset-streams" || route === "POST restore" || revokeTarget !== null;
		if (!known) return withCors(notFound());
		if (request.method !== "GET") {
			const rejected = crossSiteRejection(request, url, revokeTarget === null);
			if (rejected) return rejected;
		}
		const token = sessionToken(request);
		if (!token) return unauthorized();
		const action: FrozenAction | undefined = revokeTarget !== null ? "revoke"
			: route === "POST owner-code" ? "owner-code"
			: route === "POST reset-streams" ? "reset" : undefined;
		const config = this.config(env);
		const allowed = await config.authorize(token, vaultId, action);
		if (!allowed.ok) return json({ error: allowed.error }, allowed.status);
		if (route === "POST restore") return await this.restore(request, config, vaultId);
		const vault = this.vaultObject(env, vaultId);
		if (revokeTarget !== null) {
			// D7: the vault DO revokes in one synchronous turn; this response leaves only after it.
			const { revoked } = await vault.revokeDevice(revokeTarget);
			return json({ ok: true, deviceId: revokeTarget, revoked });
		}
		if (route === "GET devices") {
			const { devices } = await vault.listDevices();
			return json({ devices });
		}
		if (route === "POST owner-code") return await this.ownerCode(request, url, vault);
		if (route === "POST reset-streams") return await this.resetStreams(request, vault, vaultId);
		return await this.deleteVault(request, env, config, vault, vaultId);
	}

	/**
	 * `POST /operator/vaults/:id/reset-streams` (D8a): `{"confirmVaultId"}` must match (else `400
	 * confirmation_mismatch`); the vault DO deletes every stream row and mints a new epoch in one transaction, then closes
	 * its streams sockets 1001. Devices stay enrolled; R2 blobs stay. A daily-limit failure rolls the transaction back
	 * and reaches `fetch`'s catch as `503 cf_daily_limit` (O9).
	 */
	private async resetStreams(request: Request, vault: DurableObjectStub<VaultDO>, vaultId: string): Promise<Response> {
		const body = await readOperatorBody(request);
		if (body.kind === "too_large") return bodyTooLarge();
		if (body.kind !== "ok" || body.value.confirmVaultId !== vaultId) return json({ error: "confirmation_mismatch" }, 400);
		const reset = await vault.resetStreams();
		// A registered vault is always initialized (D5); null means its storage is gone (an unfinished delete).
		if (!reset) return json({ error: "unknown_vault" }, 404);
		return json({ vaultEpoch: reset.vaultEpoch });
	}

	/**
	 * `POST /operator/vaults/:id/restore {"at"}` (D8b): the config DO runs steps 0–4 and answers `200 {vaultEpoch}`, with
	 * `resumed: true` and the journaled `at` when it finished a pending restore instead. DECISIONS-GAP: a body that is
	 * not a JSON object counts as `{}` (no `at`: `400 invalid_restore_point`), the create-vault rule.
	 */
	private async restore(request: Request, config: DurableObjectStub<ConfigDO>, vaultId: string): Promise<Response> {
		const body = await readOperatorBody(request);
		if (body.kind === "too_large") return bodyTooLarge();
		const result = await config.restore(vaultId, body.kind === "ok" ? body.value.at : undefined);
		if (!result.ok) return json({ error: result.error }, result.status);
		return json(result.resumed ? { vaultEpoch: result.vaultEpoch, resumed: true, at: result.at } : { vaultEpoch: result.vaultEpoch });
	}

	/**
	 * `POST /operator/vaults/:id/owner-code`: §5 row 2.5 fields plus the claim's `mobileSetupQrDataUrl`. Purpose: absent
	 * → owner-bootstrap; any D3 purpose; anything else `400 invalid_purpose` (the bearer route's rule).
	 */
	private async ownerCode(request: Request, url: URL, vault: DurableObjectStub<VaultDO>): Promise<Response> {
		const body = await readOperatorBody(request);
		if (body.kind === "too_large") return bodyTooLarge();
		const requested = body.kind === "ok" ? body.value.purpose : undefined;
		if (requested !== undefined && !isPairingPurpose(requested)) return json({ error: "invalid_purpose" }, 400);
		const purpose: PairingPurpose = requested ?? "owner-bootstrap";
		const minted = await vault.mintOwnerCode(purpose);
		// A registered vault is always initialized (D5); null means its storage is gone (an unfinished delete).
		if (!minted) return json({ error: "unknown_vault" }, 404);
		const host = url.origin;
		const mobileSetupUrl = buildMobileSetupUrl(host, minted.pairingCode);
		return json({
			ok: true,
			pairingCode: minted.pairingCode,
			expiresAt: minted.expiresAt,
			purpose: minted.purpose,
			obsidianUrl: buildObsidianPairingUrl(host, minted.pairingCode),
			mobileSetupUrl,
			mobileSetupQrDataUrl: await renderSetupQrDataUrl(mobileSetupUrl),
		});
	}

	/**
	 * `DELETE /operator/vaults/:id` (D5): `{"confirmVaultId"}` must match. The restore journal row goes first (D8b:
	 * "vault delete wins"), then the vault DO closes its sockets 1001 and runs `deleteAll()`, then the R2 prefix purge,
	 * then the registry row. An incomplete purge → `503 purge_incomplete`; the retry repeats every step.
	 */
	private async deleteVault(request: Request, env: WorkerEnv, config: DurableObjectStub<ConfigDO>,
		vault: DurableObjectStub<VaultDO>, vaultId: string): Promise<Response> {
		const body = await readOperatorBody(request);
		if (body.kind === "too_large") return bodyTooLarge();
		if (body.kind !== "ok" || body.value.confirmVaultId !== vaultId) return json({ error: "confirmation_mismatch" }, 400);
		await config.beginDeleteVault(vaultId);
		await vault.deleteVault();
		if (env.YAOS_BUCKET && !await purgeVaultBlobs(env.YAOS_BUCKET, vaultId)) {
			return json({ error: "purge_incomplete" }, 503);
		}
		await config.unregisterVault(vaultId);
		return json({ ok: true, vaultId });
	}

	/**
	 * `POST /enroll` (D3): the vault comes from the code. A malformed code is `400 invalid_code` with no DO call; the
	 * vault DO answers the rest, including `404 invalid_code` for an unknown vault.
	 */
	private async enroll(request: Request, env: WorkerEnv): Promise<Response> {
		let bytes: Uint8Array;
		try {
			bytes = await readBoundedBytes(request, MAX_ENROLL_BODY_BYTES, { allowEmpty: true });
		} catch (error) {
			if (!(error instanceof BoundedBodyError)) throw error;
			if (error.kind === "body_too_large") return json({ error: "body_too_large" }, 413);
			bytes = new Uint8Array();
		}
		let body: unknown = null;
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			// DECISIONS-GAP: a body that is not JSON carries no well-formed code, so it gets D3's `400 invalid_code`
			// (legacy answered `400 "invalid json"`, removed routes/enroll.ts:25-28; the client sends JSON only).
		}
		const raw = body && typeof body === "object" ? (body as { pairingCode?: unknown }).pairingCode : undefined;
		const code = typeof raw === "string" ? raw.trim() : "";
		if (!PAIRING_CODE_PATTERN.test(code)) return json({ error: "invalid_code" }, 400);
		const vault = this.vaultObject(env, code.slice(0, 22));
		return vault.fetch(new Request(`${VAULT_INTERNAL_ORIGIN}/enroll`, {
			method: "POST",
			headers: { "Content-Type": "application/json", [ORIGIN_HEADER]: new URL(request.url).origin },
			body: bytes,
		}));
	}

	/** `/vault/:id/...` (§2.2). Every listed route reaches only the vault DO named by `:id`. */
	private async vault(
		request: Request, env: WorkerEnv, url: URL, vaultId: string, rest: string[],
	): Promise<Response> {
		const route = `${request.method} ${rest.join("/")}`;
		switch (route) {
			case "POST auth/pairing-code":
			case "POST auth/ticket":
			case "GET streams/feed":
			case "GET streams/read":
				return withCors(await this.forward(request, env, url, vaultId, rest));
			case "PUT streams/checkpoint":
				return withCors(contentLengthRejection(request, MAX_STREAM_CHECKPOINT_BYTES)
					?? await this.forward(request, env, url, vaultId, rest));
			case "GET ws/streams": {
				// DECISIONS-GAP: §2.2 puts the streamsVersion check in the Worker, so it now runs before the
				// ticket check (legacy routes/vault.ts:166-179 checked the ticket and the device first). A stale
				// client learns `update_required` without a valid ticket; the check reveals nothing about the vault.
				const version = declaredVersion(url, "streamsVersion");
				const response = version === STREAMS_CAPABILITY_VERSION
					? await this.forward(request, env, url, vaultId, rest)
					: rejectSocket(request, this.ports.upgrades, "update_required", {
						reason: "streams_version_mismatch",
						clientStreamsVersion: version,
						serverStreamsVersion: STREAMS_CAPABILITY_VERSION,
					});
				return response.status === 101 ? response : withCors(response);
			}
			case "POST debug/simulate-daily-limit":
				return withCors(env.YAOS_DEBUG_ROUTES === "1"
					? await this.forward(request, env, url, vaultId, rest)
					: notFound());
			case "POST blobs/exists":
				return withCors(await this.blob(request, env, vaultId, null));
		}
		if (rest.length === 2 && rest[0] === "blobs" && (request.method === "GET" || request.method === "PUT")) {
			return withCors(await this.blob(request, env, vaultId, rest[1]!));
		}
		return withCors(notFound());
	}

	/**
	 * Blob routes (D9): the Worker checks, in the legacy order of the removed routes/blobs.ts:111-127 (bucket, address,
	 * size), then the vault DO checks the bearer (`POST /blobs/auth`: no config call, no storage write), then the Worker
	 * does the R2 I/O under `v/<vaultId>/<address>`. The address is opaque: no hash check, and PUT overwrites.
	 */
	private async blob(request: Request, env: WorkerEnv, vaultId: string, address: string | null): Promise<Response> {
		const bucket = env.YAOS_BUCKET;
		if (!bucket) return json({ error: "attachments_unavailable" }, 503);
		// DECISIONS-GAP: §2.2 requires the address regex but names no error; `400 invalid_address`.
		if (address !== null && !BLOB_ADDRESS_PATTERN.test(address)) return json({ error: "invalid_address" }, 400);
		let declared: number | null = null;
		if (request.method === "PUT") {
			try {
				declared = declaredBodyLength(request, MAX_BLOB_UPLOAD_BYTES);
			} catch (error) {
				return boundedBodyRejection(error);
			}
		}
		const auth = await this.vaultObject(env, vaultId).fetch(new Request(`${VAULT_INTERNAL_ORIGIN}/blobs/auth`, {
			method: "POST",
			headers: { Authorization: request.headers.get("Authorization") ?? "" },
		}));
		if (auth.status !== 204) return auth;
		if (address === null) return await blobExists(request, bucket, vaultId);
		const key = blobKey(vaultId, address);
		if (request.method === "GET") {
			const object = await bucket.get(key);
			if (!object) return json({ error: "not found" }, 404);
			// DECISIONS-GAP: legacy echoed the uploader's Content-Type. Blobs are opaque (E2EE ciphertext included) and
			// share the console's origin, so a GET is always `application/octet-stream` with `nosniff`: an uploaded
			// HTML or SVG body can never render as a page here.
			return new Response(object.body, {
				headers: {
					"Content-Type": "application/octet-stream",
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "no-store",
				},
			});
		}
		if (declared !== null && declared > 0 && request.body) {
			// A declared length within the cap bounds the body (HTTP framing): stream it to R2 without buffering.
			await bucket.put(key, request.body);
			return new Response(null, { status: 204 });
		}
		let bytes: Uint8Array;
		try {
			bytes = await readBoundedBytes(request, MAX_BLOB_UPLOAD_BYTES);
		} catch (error) {
			return boundedBodyRejection(error);
		}
		await bucket.put(key, bytes);
		return new Response(null, { status: 204 });
	}

	/**
	 * Streams the request (method, headers, query, body) to the vault DO at `<internal origin>/<rest>`. The public
	 * origin rides in `X-YAOS-Origin`, set (not appended) so a client-sent value never reaches the DO.
	 */
	private forward(request: Request, env: WorkerEnv, url: URL, vaultId: string, rest: string[]): Promise<Response> {
		const forwarded = new Request(`${VAULT_INTERNAL_ORIGIN}/${rest.join("/")}${url.search}`, request);
		forwarded.headers.set(ORIGIN_HEADER, url.origin);
		return this.vaultObject(env, vaultId).fetch(forwarded);
	}
}

/** D9: the R2 key of a blob, `v/<vaultId>/<address>` (no epoch: a blob survives reset-streams and restore). */
export function blobKey(vaultId: string, address: string): string {
	return `${blobPrefix(vaultId)}${address}`;
}

function blobPrefix(vaultId: string): string {
	return `v/${vaultId}/`;
}

/**
 * `POST /vault/:id/blobs/exists {"hashes": [...]}` → `{present: [...]}` (relay-wire §11.3): the first 50 entries, the
 * well-formed addresses among them, HEADed 4 at a time. The legacy errors stay: `400 "invalid json"` and `400 "missing
 * hashes array"`.
 */
async function blobExists(request: Request, bucket: R2Bucket, vaultId: string): Promise<Response> {
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedBytes(request, MAX_BLOB_EXISTS_BODY_BYTES, { allowEmpty: true });
	} catch (error) {
		if (!(error instanceof BoundedBodyError)) throw error;
		if (error.kind === "body_too_large") return bodyTooLarge();
		return json({ error: "invalid json" }, 400);
	}
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const hashes = body && typeof body === "object" ? (body as { hashes?: unknown }).hashes : undefined;
	if (!Array.isArray(hashes)) return json({ error: "missing hashes array" }, 400);
	const addresses = hashes.slice(0, MAX_BLOB_EXISTS_ADDRESSES)
		.filter((hash): hash is string => typeof hash === "string" && BLOB_ADDRESS_PATTERN.test(hash));
	const present = addresses.map(() => false);
	let next = 0;
	const worker = async () => {
		while (next < addresses.length) {
			const index = next++;
			present[index] = await bucket.head(blobKey(vaultId, addresses[index]!)) !== null;
		}
	};
	await Promise.all(Array.from({ length: Math.min(BLOB_HEAD_CONCURRENCY, addresses.length) }, worker));
	return json({ present: addresses.filter((_, index) => present[index]) });
}

/**
 * D5 R2 purge of `v/<vaultId>/`: list up to 1000 keys, delete them, again until the listing is not truncated. Each
 * listing starts from the beginning: the keys before it are gone. false: keys may remain after MAX_PURGE_BATCHES.
 */
export async function purgeVaultBlobs(bucket: R2Bucket, vaultId: string): Promise<boolean> {
	const prefix = blobPrefix(vaultId);
	for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
		const listed = await bucket.list({ prefix, limit: PURGE_BATCH_SIZE });
		if (listed.objects.length > 0) await bucket.delete(listed.objects.map((object) => object.key));
		if (!listed.truncated) return true;
	}
	return false;
}
