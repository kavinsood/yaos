// Vault DO host logic behind the ports (DECISIONS §2.1): vault meta, the device map, bearer auth, pairing codes and
// enroll (D3), tickets (D4), revoke (D7), vault delete (D5), reset-streams (D8a), the D8b restore steps, the D8c
// epoch check, the blob bearer check (D9) and the streams relay. vault.ts wraps it in the Cloudflare Durable Object
// class; tests run it on Node with SQLite and fake sockets.
//
// The Worker forwards a device route as `https://vault.internal/<rest>?<query>` (the path after /vault/:id, or
// /enroll), after its own method, path and format checks, with the public origin in `X-YAOS-Origin`. This object
// never calls the config DO (D8b too: the config DO calls prepareRestore, rewind and finishRestore).
//
// Awaits: SHA-256, HMAC and body reads yield the turn, and a revoke or delete may run meanwhile (DO input gates hold
// events only during storage operations). So every handler awaits its crypto first, then re-reads the in-memory
// state and decides and writes in one synchronous stretch: a revoke that won the race is always seen.
import { randomBase64Url } from "../base64url";
import { DailyLimitLatch, dailyLimitResponse, instrumentStorageForDailyLimit } from "../dailyLimit";
import { bytesToHex, hexToBytes } from "../hex";
import { bearerToken, isWebSocketUpgrade, json, notFound, rejectSocket, releaseUnreadBody } from "../http";
import { FailureLimiter, tooManyAttempts } from "../limiter";
import {
	SYSTEM_CLOCK,
	describeError,
	isMissingTableError,
	type ClockPort,
	type SocketPort,
	type SocketRegistryPort,
	type TimerPort,
	type UpgradeRejectPort,
	type VaultStoragePort,
} from "../ports";
import { BoundedBodyError, readBoundedBytes } from "../readBoundedBytes";
import { buildMobileSetupUrl, buildObsidianPairingUrl } from "../setupQr";
import { StreamRelayService, type StreamActor, type StreamRelayConfig } from "../streams/relay";
import { StreamStore } from "../streams/store";
import { isVaultId } from "../vaultId";
import { DeviceMap, type DeviceRecord } from "./devices";
import {
	ENROLL_FAILURE_LIMIT,
	ENROLL_FAILURE_WINDOW_MS,
	PAIRING_CODE_RETENTION_MS,
	PAIRING_CODE_TTL_MS,
	mintPairingSecret,
	parseEnrollRequest,
	uniqueDeviceName,
	type EnrollRequest,
	type PairingPurpose,
} from "./pairing";
import { VAULT_SCHEMA } from "./schema";
import { TICKET_TTL_MS, importTicketKey, signTicket, verifyTicket } from "./ticket";

/** D6: `capabilityDigestForRole("owner")` of the removed server/src/collaboration.ts:93-97, frozen as a literal. */
export const OWNER_CAPABILITY_DIGEST = "97478b5b5cff0be09d2556e1f5b7e08e5a4aa5a9727e768f954c54f55f3b5646";

/** The public origin of the request, set by the Worker on every forward (the vault DO only sees vault.internal). */
export const ORIGIN_HEADER = "X-YAOS-Origin";

/** Small JSON bodies (enroll, ticket, pairing-code): the Worker's /enroll cap (G5) applies to all three. */
const MAX_SMALL_BODY_BYTES = 64 * 1024;

/** D8b: the in-memory `restoring` flag lives 60 s (device routes and enroll → 503, upgrades refused). */
export const RESTORE_FLAG_TTL_MS = 60_000;

/**
 * D8b: Durable Object point-in-time recovery, `ctx.storage.getBookmarkForTime`, `ctx.storage
 * .onNextSessionRestoreBookmark` and `ctx.abort` (vault.ts). Absent → `restore_unsupported`.
 */
export interface PitrPort {
	getBookmarkForTime(at: number): Promise<string>;
	onNextSessionRestoreBookmark(bookmark: string): Promise<unknown>;
	/** Resets the object; the next request runs a new runtime on the restored storage. Always throws. */
	abort(reason: string): never;
}

/**
 * Local workerd has no PITR: `getBookmarkForTime` rejects with "This Durable Object's storage back-end does not
 * implement point-in-time recovery." (measured on wrangler dev 4.147.0). D8b maps it to `501 restore_unsupported`.
 */
export function isPitrUnsupportedError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("does not implement point-in-time recovery");
}

/**
 * Cloudflare's PITR history of an object starts with its first snapshot, 45–55 s after the vault's init (measured on
 * scratch-3, P5). Before that snapshot `getBookmarkForTime` rejects with "This database has no history."; a time before
 * it, with "Requested time is before this database existed." Neither `at` becomes reachable on a retry and nothing was
 * done to the vault, so D8b's `400 invalid_restore_point` (G42).
 */
export function isPitrBeforeHistoryError(error: unknown): boolean {
	return error instanceof Error && (error.message.includes("before this database existed")
		|| error.message.includes("database has no history"));
}

export interface VaultMeta {
	vaultId: string;
	/** D8: the vault epoch, base64url(16 random bytes), minted at init. */
	vaultGeneration: string;
	/** D4: 32 random bytes, made at init, never exported. */
	ticketKey: Uint8Array;
	createdAt: number;
	/** D8b: set by prepare, erased by a real rewind (the rewound state predates it), cleared by finish. */
	pendingRestoreId: string | null;
	/** D8b: the last finished restore (rewind skip, finish idempotency). */
	lastRestoreId: string | null;
	lastRestoreAt: number | null;
}

export interface VaultState {
	meta: VaultMeta;
	devices: DeviceMap;
}

export interface VaultInitResult {
	vaultId: string;
	vaultGeneration: string;
	/** false: the vault already existed (init is idempotent, D5). */
	created: boolean;
}

export interface MintedCode {
	pairingCode: string;
	expiresAt: number;
	purpose: PairingPurpose;
}

export interface DeviceListing {
	devices: Array<{ deviceId: string; deviceName: string; enrolledAt: number }>;
}

/** D8b step 1. `skip`: a resume after the rewind (the marker is gone); the journal's snapshot stands. */
export type PrepareRestoreResult =
	| { kind: "prepared"; bookmark: string; devices: DeviceRecord[] }
	| { kind: "skip" }
	| { kind: "finished"; vaultEpoch: string }
	| { kind: "unsupported" }
	| { kind: "invalid_point" }
	| { kind: "unknown_vault" };

/** D8b step 2. A real rewind never returns: `ctx.abort()` makes the RPC throw. */
export type RewindResult = { kind: "finished"; vaultEpoch: string } | { kind: "unsupported" } | { kind: "unknown_vault" };

/** D8b step 3. `rewind_needed`: back to step 2. */
export type FinishRestoreResult = { kind: "finished"; vaultEpoch: string } | { kind: "rewind_needed" } | { kind: "unknown_vault" };

/** The VAULT_READY identity of a device (D6 constants). */
export function ownerActor(meta: VaultMeta, device: DeviceRecord): StreamActor {
	return {
		vaultId: meta.vaultId,
		vaultGeneration: meta.vaultGeneration,
		principalId: `owner:${meta.vaultId}`,
		membershipRevision: 1,
		deviceId: device.deviceId,
		...(device.deviceName ? { deviceName: device.deviceName } : {}),
		deviceCredentialRevision: 1,
		role: "owner",
		policyVersion: 1,
		capabilityDigest: OWNER_CAPABILITY_DIGEST,
	};
}

export interface VaultHostOptions {
	storage: VaultStoragePort;
	sockets: SocketRegistryPort;
	upgrades: UpgradeRejectPort;
	relayConfig: StreamRelayConfig;
	/** D4 ticket TTL (`readTicketTtlMs(env.YAOS_TICKET_TTL_MS)`); default 5 min. */
	ticketTtlMs?: number;
	clock?: ClockPort;
	timers?: TimerPort;
	runtimeEpoch?: string;
	/** D8b PITR; absent (or local workerd) → `restore_unsupported`. */
	pitr?: PitrPort;
}

type MetaRow = {
	vault_id: string; vault_generation: string; ticket_key: ArrayBuffer; created_at: number;
	pending_restore_id: string | null; last_restore_id: string | null; last_restore_at: number | null;
};
type CodeRow = { expires_at: number; used_at: number | null; used_request_id: string | null; used_device_id: string | null };

function sameDevice(a: DeviceRecord, b: DeviceRecord): boolean {
	return a.tokenHash === b.tokenHash && a.deviceId === b.deviceId && a.deviceName === b.deviceName
		&& a.enrollmentRequestId === b.enrollmentRequestId && a.enrolledAt === b.enrolledAt;
}

/** D8b `503 restore_in_progress` with `Retry-After` (the flag's remaining seconds, at least 1). */
function restoreInProgress(retryAfterMs: number): Response {
	const response = json({ error: "restore_in_progress" }, 503);
	response.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
	return response;
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** A small JSON body; anything unreadable or not JSON is `{}` (legacy ticket and code routes did the same). */
async function readSmallJson(request: Request): Promise<Record<string, unknown>> {
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedBytes(request, MAX_SMALL_BODY_BYTES, { allowEmpty: true });
	} catch (error) {
		if (error instanceof BoundedBodyError) return {};
		throw error;
	}
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function publicOrigin(request: Request): string {
	const value = request.headers.get(ORIGIN_HEADER) ?? "";
	let url: URL;
	try { url = new URL(value); } catch { throw new Error(`missing or invalid ${ORIGIN_HEADER}`); }
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value) {
		throw new Error(`missing or invalid ${ORIGIN_HEADER}`);
	}
	return value;
}

export class VaultHost {
	/** New per runtime: a hibernation wake or eviction makes a new one (relay-wire STREAM_RESEND). */
	readonly runtimeEpoch: string;
	/** D8 daily-limit latch, shared by the storage instrument and the relay. */
	readonly latch: DailyLimitLatch;
	readonly relay: StreamRelayService;
	private readonly storage: VaultStoragePort;
	private readonly store: StreamStore;
	private readonly clock: ClockPort;
	private readonly sockets: SocketRegistryPort;
	private readonly upgrades: UpgradeRejectPort;
	private readonly ticketTtlMs: number;
	/** D3: 20 failed enrolls a minute (unknown, expired or used code) → 429. */
	private readonly enrollFailures: FailureLimiter;
	/** undefined: not read yet in this runtime; null: never initialized ("no such table", cached per §6.1). */
	private state: VaultState | null | undefined = undefined;
	/** The imported HMAC key, once per runtime (D4: the key never rotates; vault delete drops it). */
	private ticketKey: Promise<CryptoKey> | null = null;
	private readonly pitr: PitrPort | null;
	/** D8b `restoring` flag (memory only, 60 s TTL): set by prepare, cleared by finish, lost with the runtime. */
	private restoring: { restoreId: string; until: number } | null = null;
	/**
	 * D8b: identity rows this runtime wrote (codes, enroll, revoke, reset, the restore marker). With the relay's
	 * `writesThisRuntime` (commits and checkpoints) it tells finish whether anything was written since the rewind.
	 */
	private identityWrites = 0;
	/** D8b step 2 armed a bookmark and is about to abort this runtime. */
	private rewinding = false;

	constructor(options: VaultHostOptions) {
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.sockets = options.sockets;
		this.upgrades = options.upgrades;
		this.pitr = options.pitr ?? null;
		this.ticketTtlMs = options.ticketTtlMs ?? TICKET_TTL_MS;
		this.enrollFailures = new FailureLimiter(ENROLL_FAILURE_LIMIT, ENROLL_FAILURE_WINDOW_MS, this.clock);
		this.latch = new DailyLimitLatch(() => this.clock.now());
		this.storage = instrumentStorageForDailyLimit(options.storage, this.latch);
		// The schema exists exactly when the vault does: init creates it, and no request path runs DDL.
		this.store = new StreamStore(this.storage, { schemaReady: true });
		this.runtimeEpoch = options.runtimeEpoch ?? crypto.randomUUID();
		this.relay = new StreamRelayService({
			config: options.relayConfig,
			store: () => this.store,
			sockets: options.sockets,
			sendControl: (socket, value) => {
				const frame = `__YPS:${JSON.stringify(value)}`;
				try { socket.send(frame); } catch { /* closed */ }
			},
			validateActor: (actor) => this.admits(actor.deviceId),
			dailyLimitActive: () => this.latch.active(),
			noteCommitError: (error) => { this.latch.note(error); },
			vaultId: () => this.state?.meta.vaultId ?? "",
			vaultGeneration: () => this.state?.meta.vaultGeneration ?? "",
			runtimeEpoch: this.runtimeEpoch,
			clock: this.clock,
			...(options.timers ? { timers: options.timers } : {}),
		});
	}

	/** Meta and devices, read once per runtime (1 + N rows); null for a vault that was never initialized. */
	load(): VaultState | null {
		if (this.state !== undefined) return this.state;
		let row: MetaRow | undefined;
		try {
			row = this.storage.sql.exec<MetaRow>(
				"SELECT vault_id, vault_generation, ticket_key, created_at, pending_restore_id, last_restore_id,"
					+ " last_restore_at FROM vault_meta WHERE id = 1",
			).toArray()[0];
		} catch (error) {
			if (!isMissingTableError(error, "vault_meta")) throw error;
		}
		this.state = row
			? {
				meta: { vaultId: row.vault_id, vaultGeneration: row.vault_generation,
					ticketKey: new Uint8Array(row.ticket_key), createdAt: row.created_at,
					pendingRestoreId: row.pending_restore_id, lastRestoreId: row.last_restore_id,
					lastRestoreAt: row.last_restore_at },
				devices: DeviceMap.load(this.storage),
			}
			: null;
		return this.state;
	}

	/** The D7 gate: `deviceId` is enrolled in this vault right now (memory only after the first load). */
	admits(deviceId: string): boolean {
		return this.load()?.devices.admits(deviceId) === true;
	}

	/**
	 * Idempotent vault init (D5: claim and create vault call it first): one transaction runs the §6.1 DDL and inserts
	 * `vault_meta` (1 row). An existing vault is returned unchanged.
	 */
	init(vaultId: string): VaultInitResult {
		if (!isVaultId(vaultId)) throw new TypeError("invalid vaultId");
		const existing = this.load();
		if (existing) {
			if (existing.meta.vaultId !== vaultId) throw new Error("vault object holds another vaultId");
			return { vaultId, vaultGeneration: existing.meta.vaultGeneration, created: false };
		}
		const ticketKey = crypto.getRandomValues(new Uint8Array(32));
		const vaultGeneration = randomBase64Url(16);
		const meta: VaultMeta = { vaultId, vaultGeneration, ticketKey, createdAt: this.clock.now(),
			pendingRestoreId: null, lastRestoreId: null, lastRestoreAt: null };
		this.storage.transactionSync(() => {
			for (const ddl of VAULT_SCHEMA) this.storage.sql.exec(ddl);
			this.storage.sql.exec(
				"INSERT INTO vault_meta (id, vault_id, vault_generation, ticket_key, created_at)"
					+ " VALUES (1, ?, ?, ?, ?)",
				meta.vaultId, meta.vaultGeneration, ticketKey.buffer, meta.createdAt,
			);
		});
		this.state = { meta, devices: new DeviceMap() };
		return { vaultId, vaultGeneration: meta.vaultGeneration, created: true };
	}

	async fetch(request: Request): Promise<Response> {
		try {
			return await this.route(request);
		} catch (error) {
			console.error("[yaos-vault] request failed", error);
			// D8: the free-plan daily row limit is a typed, retry-after answer.
			if (this.latch.note(error) || this.latch.active()) {
				return dailyLimitResponse(this.clock.now(), this.latch.body()?.kind);
			}
			return json({ error: "internal_error" }, 500);
		} finally {
			await releaseUnreadBody(request);
		}
	}

	private async route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		const state = this.load();
		switch (route) {
			case "POST /enroll":
				// D3: an unknown vault answers like an unknown secret, with zero writes and no DDL.
				if (!state) return json({ error: "invalid_code" }, 404);
				// DECISIONS-GAP: D8b blocks enroll while restoring without placing the check; it runs first, before
				// the code is read (no write can start), so a malformed body also gets the 503.
				return this.restoreBlocked() ?? await this.enroll(request, state);
			case "GET /ws/streams":
				// §2.2: an unknown vault gets the `unauthorized` frame and 1008.
				return state ? await this.upgrade(request, url, state) : rejectSocket(request, this.upgrades, "unauthorized");
			case "GET /streams/feed":
			case "GET /streams/read":
			case "PUT /streams/checkpoint":
			case "POST /auth/ticket":
			case "POST /auth/pairing-code":
			case "POST /blobs/auth":
			case "POST /debug/simulate-daily-limit":
				break;
			default:
				return notFound();
		}
		// §2.2: an unknown vault answers exactly like a bad credential (no existence oracle).
		const device = state ? await this.authenticate(request) : null;
		if (!device) return json({ error: "unauthorized" }, 401);
		// D8c: right after bearer auth, before any other validation or effect.
		if (route === "GET /streams/feed" || route === "GET /streams/read" || route === "PUT /streams/checkpoint") {
			const mismatch = this.epochMismatch(url);
			if (mismatch) return mismatch;
		}
		// DECISIONS-GAP: D8b's 503 for device routes is placed after auth (and after D8c), so an unauthenticated
		// caller learns nothing about a restore; the blob bearer check and the debug route count as device routes.
		const blocked = this.restoreBlocked();
		if (blocked) return blocked;
		this.wake();
		switch (route) {
			case "GET /streams/feed":
				return this.relay.feed(url);
			case "GET /streams/read":
				return this.relay.read(url);
			case "PUT /streams/checkpoint":
				// D7: a revoke during the body read wins; the checkpoint is not written.
				return await this.relay.putCheckpoint(request, url, () => this.admits(device.deviceId));
			case "POST /auth/ticket":
				return await this.issueTicket(request, device);
			case "POST /auth/pairing-code":
				return await this.devicePairingCode(request, device);
			case "POST /blobs/auth":
				// D9: the Worker asks this before any R2 call; 204 = an enrolled device's bearer.
				return new Response(null, { status: 204 });
			default:
				return await this.simulateDailyLimit(request);
		}
	}

	/** D8c: `epoch=` present and not the current vaultEpoch (empty included) → 409 with the current one. */
	private epochMismatch(url: URL): Response | null {
		const state = this.load();
		if (!state || !url.searchParams.has("epoch")) return null;
		const current = state.meta.vaultGeneration;
		return url.searchParams.get("epoch") === current
			? null
			: json({ error: "vault_generation_mismatch", vaultEpoch: current }, 409);
	}

	/** D8b: ms left on the `restoring` flag; 0 when unset or expired (an expired flag is dropped). */
	private restoringRemainingMs(): number {
		if (!this.restoring) return 0;
		const left = this.restoring.until - this.clock.now();
		if (left > 0) return left;
		this.restoring = null;
		return 0;
	}

	private restoreBlocked(): Response | null {
		const left = this.restoringRemainingMs();
		return left > 0 ? restoreInProgress(left) : null;
	}

	/**
	 * TEST-ONLY H3 `POST /vault/:id/debug/simulate-daily-limit {"enabled": boolean}` (the Worker forwards it only with
	 * `YAOS_DEBUG_ROUTES=1`) → `latch.simulate(enabled)`. DECISIONS-GAP: H3 gives no body rules or answer; `enabled`
	 * must be a boolean (else `400 invalid_request`), and the answer is `200 {ok, enabled}`.
	 */
	private async simulateDailyLimit(request: Request): Promise<Response> {
		const body = await readSmallJson(request);
		if (typeof body.enabled !== "boolean") return json({ error: "invalid_request" }, 400);
		this.latch.simulate(body.enabled);
		return json({ ok: true, enabled: body.enabled });
	}

	/**
	 * Bearer auth: SHA-256 of the token against the in-memory device map (0 rows). The map is read after the hash,
	 * so a revoke or vault delete that ran during it wins (D7: a revoked bearer gets 401 on every device route).
	 */
	private async authenticate(request: Request): Promise<DeviceRecord | null> {
		const token = bearerToken(request);
		if (!token) return null;
		const tokenHash = bytesToHex(await sha256(token));
		return this.load()?.devices.byTokenHash(tokenHash) ?? null;
	}

	// ---- D3 pairing codes and enroll -------------------------------------------------------------------------

	/**
	 * Mints a one-time code: 1 row (INSERT), +1 per row expired more than 24 h ago (§6.1). `stillAllowed` runs after
	 * the hash, in the writing turn: a code is never minted for a device revoked meanwhile. null: refused (or the
	 * vault is gone).
	 */
	private async mintCode(purpose: PairingPurpose, stillAllowed: () => boolean): Promise<MintedCode | null> {
		const state = this.load();
		if (!state) return null;
		const { code, secret } = mintPairingSecret(state.meta.vaultId);
		const codeHash = await sha256(secret);
		if (!this.load() || !stillAllowed()) return null;
		const now = this.clock.now();
		const expiresAt = now + PAIRING_CODE_TTL_MS;
		this.storage.transactionSync(() => {
			this.storage.sql.exec("DELETE FROM pairing_code WHERE expires_at < ?", now - PAIRING_CODE_RETENTION_MS);
			this.storage.sql.exec("INSERT INTO pairing_code (code_hash, purpose, expires_at) VALUES (?, ?, ?)",
				codeHash.buffer, purpose, expiresAt);
		});
		this.identityWrites++;
		return { pairingCode: code, expiresAt, purpose };
	}

	/** RPC for the operator routes (claim, owner-code): a code for the owner-bootstrap or -recovery purpose. */
	mintOwnerCode(purpose: PairingPurpose): Promise<MintedCode | null> {
		return this.mintCode(purpose, () => true);
	}

	/**
	 * `POST /auth/pairing-code` (bearer): §5 row 2.5, purpose `device` only (absent = device; else `400
	 * invalid_purpose`) → `{pairingCode, expiresAt, purpose, obsidianUrl, mobileSetupUrl}`.
	 */
	private async devicePairingCode(request: Request, device: DeviceRecord): Promise<Response> {
		const body = await readSmallJson(request);
		if (body.purpose !== undefined && body.purpose !== "device") return json({ error: "invalid_purpose" }, 400);
		const host = publicOrigin(request);
		const minted = await this.mintCode("device", () => this.admits(device.deviceId));
		if (!minted) return json({ error: "unauthorized" }, 401);
		return json({ pairingCode: minted.pairingCode, expiresAt: minted.expiresAt, purpose: minted.purpose,
			obsidianUrl: buildObsidianPairingUrl(host, minted.pairingCode),
			mobileSetupUrl: buildMobileSetupUrl(host, minted.pairingCode) });
	}

	/**
	 * `POST /enroll` (D3) on an initialized vault. Rows: 2 (UPDATE pairing_code + INSERT device); a replay 0.
	 * DECISIONS-GAP: D3's limiter counts "failures" without a list; the code failures count (404 invalid_code, 410
	 * expired_code, 409 used_code), not malformed bodies, conflicts or replays.
	 */
	private async enroll(request: Request, state: VaultState): Promise<Response> {
		const blocked = this.enrollFailures.retryAfterMs();
		if (blocked > 0) return tooManyAttempts(blocked);
		const parsed = parseEnrollRequest(await readSmallJson(request));
		if (parsed === "code") return json({ error: "invalid_code" }, 400);
		if (parsed === "request") return json({ error: "invalid enrollment request" }, 400);
		const host = publicOrigin(request);
		if (parsed.vaultId !== state.meta.vaultId) return this.codeFailure(404, "invalid_code");
		const [codeHash, tokenDigest] = await Promise.all([sha256(parsed.secret), sha256(parsed.deviceToken)]);
		// Synchronous from here to the response: the code row, the device map and the write are one turn.
		const current = this.load();
		if (!current) return json({ error: "invalid_code" }, 404);
		// D8b: a prepare that ran during the hashes wins (its device snapshot would drop this device).
		const restoring = this.restoreBlocked();
		if (restoring) return restoring;
		const tokenHash = bytesToHex(tokenDigest);
		const code = this.storage.sql.exec<CodeRow>(
			"SELECT expires_at, used_at, used_request_id, used_device_id FROM pairing_code WHERE code_hash = ?",
			codeHash.buffer,
		).toArray()[0];
		if (!code) return this.codeFailure(404, "invalid_code");
		if (code.used_at !== null) {
			// DECISIONS-GAP: a replay is answered after the code's expiry too (D3 keys it on the used code only); the
			// row lives until a later mint prunes it, more than 24 h after expiry.
			if (code.used_request_id === parsed.enrollmentRequestId) return this.replay(current, parsed, code, tokenHash, host);
			return this.codeFailure(409, "used_code");
		}
		if (code.expires_at <= this.clock.now()) return this.codeFailure(410, "expired_code");
		// DECISIONS-GAP: D3 does not cover a deviceId or token already enrolled under another code; legacy's `409
		// device_exists` (removed config.ts:820) is kept, so one device never holds two rows.
		if (current.devices.byId(parsed.deviceId) || current.devices.byTokenHash(tokenHash)) {
			return json({ error: "device_exists" }, 409);
		}
		const names = new Set<string>();
		for (const device of current.devices.list()) names.add(device.deviceName);
		const record: DeviceRecord = {
			tokenHash,
			deviceId: parsed.deviceId,
			deviceName: uniqueDeviceName(parsed.deviceName, names),
			enrollmentRequestId: parsed.enrollmentRequestId,
			enrolledAt: this.clock.now(),
		};
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				"UPDATE pairing_code SET used_at = ?, used_request_id = ?, used_device_id = ? WHERE code_hash = ?",
				record.enrolledAt, record.enrollmentRequestId, record.deviceId, codeHash.buffer,
			);
			this.storage.sql.exec(
				"INSERT INTO device (token_hash, device_id, device_name, enrollment_request_id, enrolled_at)"
					+ " VALUES (?, ?, ?, ?, ?)",
				tokenDigest.buffer, record.deviceId, record.deviceName, record.enrollmentRequestId, record.enrolledAt,
			);
		});
		this.identityWrites++;
		current.devices.add(record);
		return this.enrolled(current, record, parsed.deviceToken, host);
	}

	/**
	 * D3 replay of a used code with the same enrollmentRequestId: the same deviceId and token hash while the row this
	 * code created still exists → the same 200, 0 rows; another deviceId or token → `409
	 * enrollment_request_conflict`; the row is gone (revoked) → `409 used_code`. deviceName is not part of the key.
	 */
	private replay(state: VaultState, request: EnrollRequest, code: CodeRow, tokenHash: string, host: string): Response {
		if (code.used_device_id !== request.deviceId) return json({ error: "enrollment_request_conflict" }, 409);
		const device = state.devices.byId(request.deviceId);
		// The row must be the one this code created: a device revoked and enrolled again holds another request id.
		if (!device || device.enrollmentRequestId !== request.enrollmentRequestId) return this.codeFailure(409, "used_code");
		if (device.tokenHash !== tokenHash) return json({ error: "enrollment_request_conflict" }, 409);
		return this.enrolled(state, device, request.deviceToken, host);
	}

	/** D3 200 body: exactly the six fields `readEnrollment` reads (src/host/ui/pairing.ts:363-389). */
	private enrolled(state: VaultState, device: DeviceRecord, deviceToken: string, host: string): Response {
		return json({ host, deviceToken, vaultId: state.meta.vaultId, deviceId: device.deviceId,
			deviceName: device.deviceName, vaultGeneration: state.meta.vaultGeneration });
	}

	private codeFailure(status: number, error: string): Response {
		this.enrollFailures.fail();
		return json({ error }, status);
	}

	// ---- D4 tickets and the streams socket ----------------------------------------------------------------------

	private importedKey(state: VaultState): Promise<CryptoKey> {
		this.ticketKey ??= importTicketKey(state.meta.ticketKey);
		return this.ticketKey;
	}

	/** `POST /auth/ticket` (D4): 0 rows. The request must name purpose `streams` (legacy body rules). */
	private async issueTicket(request: Request, device: DeviceRecord): Promise<Response> {
		const body = await readSmallJson(request);
		if (body.purpose !== "streams" || (body.documentId !== undefined && body.documentId !== "streams")
			|| body.rootEpoch !== undefined || body.bodyEpoch !== undefined) {
			return json({ error: "invalid_ticket_scope" }, 400);
		}
		const state = this.load();
		if (!state || !state.devices.admits(device.deviceId)) return json({ error: "unauthorized" }, 401);
		const issued = await signTicket(await this.importedKey(state), ownerActor(state.meta, device), this.clock.now(),
			this.ticketTtlMs);
		// A revoke during the signature wins: the ticket would not open a socket anyway (the upgrade re-checks).
		if (!this.admits(device.deviceId)) return json({ error: "unauthorized" }, 401);
		return json(issued);
	}

	/**
	 * `GET /ws/streams?ticket=…` (D4): the ticket must verify with this vault's key and generation, and its device
	 * must be in the device map after the verification (D7). Any failure: the `unauthorized` frame and 1008.
	 */
	private async upgrade(request: Request, url: URL, state: VaultState): Promise<Response> {
		const ticket = url.searchParams.get("ticket");
		const expected = { vaultId: state.meta.vaultId, vaultGeneration: state.meta.vaultGeneration };
		const payload = ticket ? await verifyTicket(await this.importedKey(state), ticket, expected, this.clock.now()) : null;
		const current = this.load();
		if (!payload || !current || current.meta.vaultGeneration !== payload.vaultGeneration
			|| !current.devices.admits(payload.deviceId)) {
			return rejectSocket(request, this.upgrades, "unauthorized");
		}
		// D8b: upgrades are refused while restoring: the error frame and 1013 `restore_in_progress` (relay-wire §5
		// row 10). DECISIONS-GAP: D8b says "refused" without the shape; it is checked after the ticket (no oracle), and
		// a request that is not an upgrade gets the device routes' 503.
		const left = this.restoringRemainingMs();
		if (left > 0) {
			if (!isWebSocketUpgrade(request)) return restoreInProgress(left);
			const frame = `__YPS:${JSON.stringify({ type: "error", code: "restore_in_progress" })}`;
			return this.upgrades.reject(frame, 1013, "restore_in_progress");
		}
		// DECISIONS-GAP: a valid ticket on a request that is not a WebSocket upgrade has no §2.2 answer (legacy fell
		// through to its DO's 404). `426 upgrade_required`: the runtime cannot answer such a request with a socket.
		if (!isWebSocketUpgrade(request)) return json({ error: "upgrade_required" }, 426);
		return this.acceptStreams(payload.deviceId);
	}

	/** Admits a streams socket for an enrolled device with the D6 constants. The relay re-checks `validateActor`. */
	acceptStreams(deviceId: string): Response {
		const state = this.load();
		const device = state?.devices.byId(deviceId);
		if (!state || !device) throw new Error("acceptStreams: unknown vault or device");
		this.wake();
		return this.relay.accept(ownerActor(state.meta, device), true);
	}

	// ---- operator RPCs: devices, D7 revoke, D5 delete --------------------------------------------------------------

	/** `GET /operator/vaults/:id/devices`: no token material (T-DEVICES-LIST). 0 rows written. */
	listDevices(): DeviceListing {
		const state = this.load();
		const devices = state ? [...state.devices.list()] : [];
		devices.sort((a, b) => a.enrolledAt - b.enrolledAt || a.deviceId.localeCompare(b.deviceId));
		return { devices: devices.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, enrolledAt: d.enrolledAt })) };
	}

	/**
	 * D7 revoke: ONE synchronous turn, no await. The device row is deleted (1 row; §6.1: no secondary index, the
	 * DELETE scans the few device rows) and its device-map entry removed, so the gate shuts with the transaction;
	 * then the relay drops the device's buffered frames (never committed, no receipt; no flush), tells peers that
	 * held their PROVISIONALs, and sends each of the device's sockets `authority_superseded` + close 4403. The
	 * caller's HTTP response leaves after this returns. Idempotent: an unknown device is `revoked: false`.
	 */
	revokeDevice(deviceId: string): { revoked: boolean; droppedFrames: number; closedSockets: number } {
		const state = this.load();
		const record = state?.devices.byId(deviceId);
		if (state && record) {
			this.storage.transactionSync(() => {
				this.storage.sql.exec("DELETE FROM device WHERE device_id = ?", deviceId);
			});
			this.identityWrites++;
			state.devices.remove(deviceId);
		}
		const { droppedFrames, closedSockets } = this.relay.revokeDevice(deviceId);
		return { revoked: record !== undefined, droppedFrames, closedSockets };
	}

	/**
	 * D8a reset-streams, the vault DO's part. ONE `transactionSync` deletes every row of the 3 stream tables (H+S+C
	 * rows) and writes a new generation (1 row), so a daily-limit hit rolls both back and the error reaches the Worker
	 * (`503 cf_daily_limit`). After the commit the pending buffer, head cache and dedupe index are discarded and every
	 * streams socket closes 1001. Devices, codes, the ticket key and blobs stay. null: the vault does not exist.
	 */
	resetStreams(): { vaultEpoch: string } | null {
		const state = this.load();
		if (!state) return null;
		const vaultGeneration = randomBase64Url(16);
		this.storage.transactionSync(() => {
			this.store.deleteAllStreamRows();
			this.storage.sql.exec("UPDATE vault_meta SET vault_generation = ? WHERE id = 1", vaultGeneration);
		});
		this.identityWrites++;
		state.meta.vaultGeneration = vaultGeneration;
		this.relay.discardAll(1001, "streams reset");
		return { vaultEpoch: vaultGeneration };
	}

	// ---- D8b restore steps (called by the config DO's runner, config/restore.ts) --------------------------------

	/**
	 * D8b step 1: `restoring` flag (60 s), streams sockets close 1013 (the buffer is dropped), the marker
	 * `pending_restore_id = restoreId` (1 row; skipped when already set), and `{bookmark: getBookmarkForTime(at),
	 * devices}`. `refreshOnly` (a resume whose journal already holds a snapshot): when the marker is gone the vault was
	 * rewound, its device table is T's, and the journal's snapshot stands (`skip`). No effect before the bookmark: no
	 * PITR → `unsupported`; a time before the vault or its PITR history → `invalid_point`.
	 */
	async prepareRestore(restoreId: string, at: number, refreshOnly: boolean): Promise<PrepareRestoreResult> {
		const state = this.load();
		if (!state) return { kind: "unknown_vault" };
		if (state.meta.lastRestoreId === restoreId) return { kind: "finished", vaultEpoch: state.meta.vaultGeneration };
		if (refreshOnly && state.meta.pendingRestoreId !== restoreId) return { kind: "skip" };
		if (!this.pitr) return { kind: "unsupported" };
		// DECISIONS-GAP: a point before the vault's init would rewind to storage with no vault; it is refused as
		// `400 invalid_restore_point` with no effect and no PITR call (D8b's list is unparseable, future, over 30 days).
		if (at < state.meta.createdAt) return { kind: "invalid_point" };
		let bookmark: string;
		try {
			bookmark = await this.pitr.getBookmarkForTime(at);
		} catch (error) {
			if (isPitrUnsupportedError(error)) return { kind: "unsupported" };
			if (isPitrBeforeHistoryError(error)) return { kind: "invalid_point" };
			console.error("[yaos-vault] getBookmarkForTime failed", describeError(error));
			throw error;
		}
		// Synchronous from here: re-read the state the await may have changed.
		const current = this.load();
		if (!current) return { kind: "unknown_vault" };
		if (current.meta.lastRestoreId === restoreId) return { kind: "finished", vaultEpoch: current.meta.vaultGeneration };
		if (current.meta.pendingRestoreId !== restoreId) {
			this.storage.sql.exec("UPDATE vault_meta SET pending_restore_id = ? WHERE id = 1", restoreId);
			this.identityWrites++;
			current.meta.pendingRestoreId = restoreId;
		}
		this.restoring = { restoreId, until: this.clock.now() + RESTORE_FLAG_TTL_MS };
		this.relay.discardAll(1013, "restore_in_progress");
		return { kind: "prepared", bookmark, devices: [...current.devices.list()].map((device) => ({ ...device })) };
	}

	/**
	 * D8b step 2: `last_restore_id == restoreId` → already finished. Otherwise arm `bookmark` for the next session and
	 * `ctx.abort()`: the RPC throws by design, and the next call runs a new runtime on storage as of T.
	 */
	async rewind(restoreId: string, bookmark: string): Promise<RewindResult> {
		const state = this.load();
		if (!state) return { kind: "unknown_vault" };
		if (state.meta.lastRestoreId === restoreId) return { kind: "finished", vaultEpoch: state.meta.vaultGeneration };
		if (!this.pitr) return { kind: "unsupported" };
		this.rewinding = true;
		try {
			await this.pitr.onNextSessionRestoreBookmark(bookmark);
		} catch (error) {
			this.rewinding = false;
			throw error;
		}
		return this.pitr.abort("restore rewind");
	}

	/**
	 * D8b step 3. Idempotent on `last_restore_id`. `rewind_needed` when the marker is still this restore's (no rewind
	 * happened) or when this runtime wrote anything (a commit, checkpoint, enroll or code since the rewind), so content
	 * is exactly T. Else ONE `transactionSync` (≈ D+P+1 rows): the device table becomes `devices` (rows that differ are
	 * deleted and inserted), every pairing code is deleted, and meta gets a new epoch, `last_restore_id`,
	 * `last_restore_at` and no marker. Then the flag clears and every streams socket closes 1001.
	 */
	finishRestore(restoreId: string, devices: readonly DeviceRecord[]): FinishRestoreResult {
		const state = this.load();
		if (!state) return { kind: "unknown_vault" };
		if (state.meta.lastRestoreId === restoreId) return { kind: "finished", vaultEpoch: state.meta.vaultGeneration };
		// DECISIONS-GAP: D8b's "pending_restore_id still set" is read as "== restoreId": the rewound state may hold
		// another restore's marker from before T (a restore in flight at T), and that one never clears by rewinding.
		if (state.meta.pendingRestoreId === restoreId) return { kind: "rewind_needed" };
		if (this.relay.writesThisRuntime + this.identityWrites > 0) return { kind: "rewind_needed" };
		const wanted = new Map(devices.map((device) => [device.tokenHash, device]));
		const present = new Map([...state.devices.list()].map((device) => [device.tokenHash, device]));
		const vaultGeneration = randomBase64Url(16);
		const now = this.clock.now();
		this.storage.transactionSync(() => {
			for (const [tokenHash, device] of present) {
				const keep = wanted.get(tokenHash);
				if (keep && sameDevice(keep, device)) continue;
				this.storage.sql.exec("DELETE FROM device WHERE token_hash = ?", hexToBytes(tokenHash).buffer);
			}
			for (const [tokenHash, device] of wanted) {
				const have = present.get(tokenHash);
				if (have && sameDevice(have, device)) continue;
				this.storage.sql.exec(
					"INSERT INTO device (token_hash, device_id, device_name, enrollment_request_id, enrolled_at)"
						+ " VALUES (?, ?, ?, ?, ?)",
					hexToBytes(tokenHash).buffer, device.deviceId, device.deviceName, device.enrollmentRequestId,
					device.enrolledAt,
				);
			}
			this.storage.sql.exec("DELETE FROM pairing_code");
			this.storage.sql.exec(
				"UPDATE vault_meta SET vault_generation = ?, pending_restore_id = NULL, last_restore_id = ?,"
					+ " last_restore_at = ? WHERE id = 1",
				vaultGeneration, restoreId, now,
			);
		});
		this.identityWrites++;
		const map = new DeviceMap();
		for (const device of wanted.values()) map.add({ ...device });
		state.devices = map;
		state.meta.vaultGeneration = vaultGeneration;
		state.meta.pendingRestoreId = null;
		state.meta.lastRestoreId = restoreId;
		state.meta.lastRestoreAt = now;
		this.restoring = null;
		this.relay.discardAll(1001, "vault restored");
		return { kind: "finished", vaultEpoch: vaultGeneration };
	}

	/**
	 * D5 vault delete, the vault DO's part: streams sockets close 1001, the buffer and caches are dropped, the
	 * in-memory state becomes "no vault" at once (every device route → 401), then `deleteAll()` wipes the storage.
	 */
	async deleteVault(): Promise<{ deleted: true }> {
		// A wipe now would be undone: the armed bookmark restores the storage when this runtime aborts. The delete
		// fails before any effect; the operator's retry reaches the next runtime (the journal row is already gone).
		if (this.rewinding) throw new Error("vault delete: a restore rewind is in flight; retry");
		for (const socket of this.sockets.sockets()) {
			if (!this.relay.owns(socket)) continue;
			try { socket.close(1001, "vault deleted"); } catch { /* closed */ }
		}
		this.relay.reset();
		this.state = null;
		this.ticketKey = null;
		this.restoring = null;
		try {
			await this.storage.deleteAll();
		} catch (error) {
			// The wipe did not happen (deleteAll is atomic): read the storage again on the next request.
			this.state = undefined;
			throw error;
		}
		return { deleted: true };
	}

	// ---- sockets ------------------------------------------------------------------------------------------------

	webSocketMessage(socket: SocketPort, message: string | ArrayBuffer): void {
		this.load();
		this.wake();
		this.relay.message(socket, message);
	}

	webSocketClose(socket: SocketPort): void {
		this.relay.socketClosed(socket);
	}

	webSocketError(socket: SocketPort): void {
		try { socket.close(1011, "socket error"); } catch { /* already closed */ }
		this.relay.socketClosed(socket);
	}

	/** Once per runtime: sockets admitted by an earlier runtime are told to resend unacknowledged appends. */
	private wake(): void {
		if (!this.state) return;
		try { this.relay.ensureWakeNotice(); }
		catch (error) { console.warn("[yaos-vault] wake notice failed", error); }
	}
}
