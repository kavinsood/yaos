// Vault DO host logic behind the ports (DECISIONS §2.1): vault meta, the device map, bearer auth, pairing codes and
// enroll (D3), tickets (D4), revoke (D7), vault delete (D5), reset-streams (D8a), the D8b restore steps, the D8c
// epoch check, the blob bearer checks (D9, and the blob GC limit) and the streams relay. vault.ts wraps it in the Cloudflare Durable Object
// class; tests run it on Node with SQLite and fake sockets.
//
// Pairing grants (identity-per-store §3, phase 1): a grant enroll, register, retire by key, self-retire, leave,
// grant-authenticated pairing codes, the per-grant limits, tombstones, `last_seen_day`, and the operator's revoke
// pairing. Every retire (self, by key, operator, grant revoke, inactivity) is a D7 revoke plus a tombstone, in one turn.
// Phase 5: the lazy inactivity sweep (retireInactive), grant rotation (rotateGrant) and the device's grant fetch.
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
import { bearerToken, grantSecret, isWebSocketUpgrade, json, notFound, rejectSocket, releaseUnreadBody } from "../http";
import { WindowLimiter, tooManyAttempts } from "../limiter";
import {
	SYSTEM_CLOCK,
	describeError,
	isMissingColumnError,
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
import {
	DeviceMap,
	GrantMap,
	type DeviceRecord,
	type GrantRecord,
	type IdentitySnapshot,
	type RetiredRecord,
} from "./devices";
import {
	DAY_MS,
	ENROLL_FAILURE_LIMIT,
	ENROLL_FAILURE_WINDOW_MS,
	GRANT_LIVE_DEVICE_LIMIT,
	GRANT_REGISTRATIONS_PER_DAY,
	INACTIVITY_RETIRE_BATCH,
	INACTIVITY_RETIRE_DAYS,
	PAIRING_CODE_RETENTION_MS,
	PAIRING_CODE_TTL_MS,
	mintPairingSecret,
	parseEnrollRequest,
	parseRegisterRequest,
	parseDeviceStatusRequest, parseRetireRequest,
	uniqueDeviceName,
	utcDay,
	utcDayString,
	type EnrollRequest,
	type GrantEnrollRequest,
	type PairingPurpose,
} from "./pairing";
import { unwrapGrantSecret, wrapGrantSecret } from "./grantWrap";
import { VAULT_SCHEMA, migrateIdentityV2, migrateIdentityV3, migrateIdentityV4 } from "./schema";
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
 * Blob GC (relay-wire §11.3.1, E2EE design §19 A3): the list and batch-delete routes share 60 authenticated
 * requests a minute per vault DO, in memory like D3 (a new runtime starts a fresh window). A batch delete of up to 100
 * addresses is one request. A sweep is a cold path (a user command, at most monthly); 60/min caps a looping device at
 * one DO request a second, and at most 1000 listed or 100 deleted blobs a second.
 */
export const BLOB_GC_REQUEST_LIMIT = 60;
export const BLOB_GC_WINDOW_MS = 60_000;

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
	/** Identity v4, the key-roll signal (e2ee-design §14.5): blocking removals by the operator. */
	removals: number;
	/** Identity v4: the highest `removals` a device has covered with a new vault key (never above `removals`). */
	rekeyed: number;
}

export interface VaultState {
	meta: VaultMeta;
	devices: DeviceMap;
	grants: GrantMap;
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

/**
 * `GET /operator/vaults/:id/devices` (T-DEVICES-LIST: no token, secret or retire-key material). A device carries
 * `grantId` and `lastSeenDay` (`YYYY-MM-DD`, UTC) only when it has them, so an old enroll lists as before. `grants`
 * (identity-per-store §6.3) lists every grant, revoked ones too; `lastSeenDay` is the latest over its live devices.
 */
export interface DeviceListing {
	devices: Array<{ deviceId: string; deviceName: string; enrolledAt: number; grantId?: string; lastSeenDay?: string }>;
	grants: Array<{ grantId: string; name: string; createdAt: number; revokedAt: number | null; liveDevices: number;
		lastSeenDay: string | null }>;
}

/** `POST /operator/vaults/:id/grants/:grantId/rotate` (§3.4). `rotated: false`: unknown or revoked (nothing written). */
export interface GrantRotateResult {
	rotated: boolean;
	grantId: string;
}

/** The operator's "Revoke pairing" (`DELETE /operator/vaults/:id/grants/:grantId`) and the device's leave. */
export interface GrantRevokeResult {
	/** false: unknown or already revoked (idempotent). */
	revoked: boolean;
	retiredDevices: number;
	droppedFrames: number;
	closedSockets: number;
}

/** D8b step 1. `skip`: a resume after the rewind (the marker is gone); the journal's snapshot stands. */
export type PrepareRestoreResult =
	| ({ kind: "prepared"; bookmark: string } & IdentitySnapshot)
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
	/** Inactivity retirement threshold in UTC days (`readInactivityRetireDays(env.YAOS_INACTIVITY_RETIRE_DAYS)`); default 90. */
	inactivityRetireDays?: number;
}

type MetaRow = {
	vault_id: string; vault_generation: string; ticket_key: ArrayBuffer; created_at: number;
	pending_restore_id: string | null; last_restore_id: string | null; last_restore_at: number | null;
	removals: number; rekeyed: number;
};

const META_SELECT = "SELECT vault_id, vault_generation, ticket_key, created_at, pending_restore_id, last_restore_id,"
	+ " last_restore_at, removals, rekeyed FROM vault_meta WHERE id = 1";
type CodeRow = {
	expires_at: number; used_at: number | null; used_request_id: string | null; used_device_id: string | null;
	used_grant_id: string | null;
};

/** The authority fields of a device row (`lastSeenDay` is bookkeeping: a restore updates it in place). */
function sameDevice(a: DeviceRecord, b: DeviceRecord): boolean {
	return a.tokenHash === b.tokenHash && a.deviceId === b.deviceId && a.deviceName === b.deviceName
		&& a.enrollmentRequestId === b.enrollmentRequestId && a.enrolledAt === b.enrolledAt
		&& a.grantId === b.grantId && a.retireHash === b.retireHash;
}

function sameGrant(a: GrantRecord, b: GrantRecord): boolean {
	return a.grantId === b.grantId && a.secretHash === b.secretHash && a.name === b.name
		&& a.enrollmentRequestId === b.enrollmentRequestId && a.createdAt === b.createdAt && a.revokedAt === b.revokedAt
		&& a.registeredDay === b.registeredDay && a.registeredCount === b.registeredCount && a.secretWrap === b.secretWrap;
}

const DEVICE_INSERT = "INSERT INTO device (token_hash, device_id, device_name, enrollment_request_id, enrolled_at,"
	+ " grant_id, retire_hash, last_seen_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const GRANT_INSERT = "INSERT INTO pairing_grant (grant_id, secret_hash, grant_name, enrollment_request_id, created_at,"
	+ " revoked_at, registered_day, registered_count, secret_wrap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

function deviceRow(device: DeviceRecord): unknown[] {
	return [hexToBytes(device.tokenHash).buffer, device.deviceId, device.deviceName, device.enrollmentRequestId,
		device.enrolledAt, device.grantId, device.retireHash === null ? null : hexToBytes(device.retireHash).buffer,
		device.lastSeenDay];
}

function grantRow(grant: GrantRecord): unknown[] {
	return [grant.grantId, hexToBytes(grant.secretHash).buffer, grant.name, grant.enrollmentRequestId, grant.createdAt,
		grant.revokedAt, grant.registeredDay, grant.registeredCount,
		grant.secretWrap === null ? null : hexToBytes(grant.secretWrap).buffer];
}

const unauthorized = () => json({ error: "unauthorized" }, 401);

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
	private readonly enrollFailures: WindowLimiter;
	/** Blob GC: 60 authenticated list or batch-delete requests a minute → 429. */
	private readonly blobGcRequests: WindowLimiter;
	/** undefined: not read yet in this runtime; null: never initialized ("no such table", cached per §6.1). */
	private state: VaultState | null | undefined = undefined;
	/** The imported ticket key, once per runtime (D4: the key never rotates; vault delete drops it). */
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
	/** Inactivity retirement threshold, UTC days (§6.2, owner decision 4). */
	private readonly inactivityRetireDays: number;
	/** The UTC day the inactivity sweep last finished in this runtime (-1: not yet): at most one full sweep a day. */
	private inactivitySweptDay = -1;

	constructor(options: VaultHostOptions) {
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.sockets = options.sockets;
		this.upgrades = options.upgrades;
		this.pitr = options.pitr ?? null;
		this.ticketTtlMs = options.ticketTtlMs ?? TICKET_TTL_MS;
		this.inactivityRetireDays = options.inactivityRetireDays ?? INACTIVITY_RETIRE_DAYS;
		this.enrollFailures = new WindowLimiter(ENROLL_FAILURE_LIMIT, ENROLL_FAILURE_WINDOW_MS, this.clock);
		this.blobGcRequests = new WindowLimiter(BLOB_GC_REQUEST_LIMIT, BLOB_GC_WINDOW_MS, this.clock);
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
			rekey: () => ({ removals: this.state?.meta.removals ?? 0, rekeyed: this.state?.meta.rekeyed ?? 0 }),
			onRekeyed: (removals) => { this.noteRekeyed(removals); },
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
			row = this.readMeta();
		} catch (error) {
			if (!isMissingTableError(error, "vault_meta")) throw error;
		}
		if (!row) {
			this.state = null;
			return null;
		}
		// Grants first: "no such table" here is a v1 vault, migrated before the device scan reads the v2 columns.
		const grants = this.loadGrants();
		this.state = {
			meta: { vaultId: row.vault_id, vaultGeneration: row.vault_generation,
				ticketKey: new Uint8Array(row.ticket_key), createdAt: row.created_at,
				pendingRestoreId: row.pending_restore_id, lastRestoreId: row.last_restore_id,
				lastRestoreAt: row.last_restore_at, removals: row.removals, rekeyed: row.rekeyed },
			devices: DeviceMap.load(this.storage),
			grants,
		};
		return this.state;
	}

	/** The meta row, or the identity v4 migration of a vault before it (schema.ts) and the read again. */
	private readMeta(): MetaRow | undefined {
		try {
			return this.storage.sql.exec<MetaRow>(META_SELECT).toArray()[0];
		} catch (error) {
			if (!isMissingColumnError(error, "removals")) throw error;
		}
		migrateIdentityV4(this.storage);
		return this.storage.sql.exec<MetaRow>(META_SELECT).toArray()[0];
	}

	/**
	 * The grant scan, or the identity v2 + v3 migration of a v1 vault (schema.ts G54), or the v3 migration of a v2 vault
	 * (G65) and the scan again. Neither is an `identityWrites` write.
	 */
	private loadGrants(): GrantMap {
		try {
			return GrantMap.load(this.storage);
		} catch (error) {
			if (isMissingColumnError(error, "secret_wrap")) {
				migrateIdentityV3(this.storage);
				return GrantMap.load(this.storage);
			}
			if (!isMissingTableError(error, "pairing_grant")) throw error;
		}
		migrateIdentityV2(this.storage);
		return new GrantMap();
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
			pendingRestoreId: null, lastRestoreId: null, lastRestoreAt: null, removals: 0, rekeyed: 0 };
		this.storage.transactionSync(() => {
			for (const ddl of VAULT_SCHEMA) this.storage.sql.exec(ddl);
			this.storage.sql.exec(
				"INSERT INTO vault_meta (id, vault_id, vault_generation, ticket_key, created_at)"
					+ " VALUES (1, ?, ?, ?, ?)",
				meta.vaultId, meta.vaultGeneration, ticketKey.buffer, meta.createdAt,
			);
		});
		this.state = { meta, devices: new DeviceMap(), grants: new GrantMap() };
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
			// Identity-per-store §3.2. An unknown vault answers like a bad credential (§2.2), before any body read.
			case "POST /auth/device":
				return state ? await this.registerDevice(request) : unauthorized();
			case "POST /auth/device/retire":
				return state ? await this.retireByKey(request) : unauthorized();
			case "DELETE /auth/grant":
				return state ? await this.leaveGrant(request) : unauthorized();
			case "POST /auth/pairing-code":
				// A grant secret may mint a code too (owner decision 3); a bearer takes the device path below.
				if (grantSecret(request) !== null) return state ? await this.grantPairingCode(request) : unauthorized();
				break;
			case "DELETE /auth/device":
			case "POST /auth/device/status":
			case "GET /auth/grant":
			case "GET /streams/feed":
			case "GET /streams/read":
			case "PUT /streams/checkpoint":
			case "POST /auth/ticket":
			case "POST /blobs/auth":
			case "POST /blobs/gc-auth":
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
			case "DELETE /auth/device":
				return this.selfRetire(device);
			case "POST /auth/device/status":
				return await this.deviceStatus(request);
			case "GET /auth/grant":
				return await this.fetchGrant(device);
			case "POST /blobs/auth":
				// D9: the Worker asks this before any R2 call; 204 = an enrolled device's bearer.
				return new Response(null, { status: 204 });
			case "POST /blobs/gc-auth": {
				// A3: the same bearer check for the blob GC routes, plus their request limit. Only an authenticated
				// request counts, so a stranger cannot spend the vault's window; a refused one does not count.
				const wait = this.blobGcRequests.retryAfterMs();
				if (wait > 0) return tooManyAttempts(wait);
				this.blobGcRequests.record();
				return new Response(null, { status: 204 });
			}
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
	private devicePairingCode(request: Request, device: DeviceRecord): Promise<Response> {
		return this.pairingCodeResponse(request, () => this.admits(device.deviceId));
	}

	/** The pairing-code body rule and answer; `stillAllowed` is the credential's check in the writing turn. */
	private async pairingCodeResponse(request: Request, stillAllowed: () => boolean): Promise<Response> {
		const body = await readSmallJson(request);
		if (body.purpose !== undefined && body.purpose !== "device") return json({ error: "invalid_purpose" }, 400);
		const host = publicOrigin(request);
		const minted = await this.mintCode("device", stillAllowed);
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
		if ("grantSecret" in parsed) return await this.enrollGrant(parsed, host);
		const [codeHash, tokenDigest] = await Promise.all([sha256(parsed.secret), sha256(parsed.deviceToken)]);
		// Synchronous from here to the response: the code row, the device map and the write are one turn.
		const current = this.load();
		if (!current) return json({ error: "invalid_code" }, 404);
		// D8b: a prepare that ran during the hashes wins (its device snapshot would drop this device).
		const restoring = this.restoreBlocked();
		if (restoring) return restoring;
		const tokenHash = bytesToHex(tokenDigest);
		const code = this.codeRow(codeHash);
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
		// Identity-per-store §3.3: a retired deviceId never comes back, through the old enroll either (it used to: the
		// live-row check above sees only live rows). The current client mints a new deviceId per attempt.
		if (this.isRetired(parsed.deviceId)) return json({ error: "device_retired" }, 409);
		const names = new Set<string>();
		for (const device of current.devices.list()) names.add(device.deviceName);
		const record: DeviceRecord = {
			tokenHash,
			deviceId: parsed.deviceId,
			deviceName: uniqueDeviceName(parsed.deviceName, names),
			enrollmentRequestId: parsed.enrollmentRequestId,
			enrolledAt: this.clock.now(),
			grantId: null,
			retireHash: null,
			lastSeenDay: null,
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
		this.enrollFailures.record();
		return json({ error }, status);
	}

	private codeRow(codeHash: Uint8Array): CodeRow | undefined {
		return this.storage.sql.exec<CodeRow>(
			"SELECT expires_at, used_at, used_request_id, used_device_id, used_grant_id FROM pairing_code WHERE code_hash = ?",
			codeHash.buffer,
		).toArray()[0];
	}

	/** One PK read of `retired_device` (tombstones are never loaded into memory, §6.2). */
	private isRetired(deviceId: string): boolean {
		return this.storage.sql.exec("SELECT device_id FROM retired_device WHERE device_id = ?", deviceId).toArray().length > 0;
	}

	// ---- identity-per-store §3: pairing grants --------------------------------------------------------------------

	/**
	 * `POST /enroll {pairingCode, enrollmentRequestId, grantSecret, grantName}` (§3.2): the code buys a grant. Rows: 2
	 * (UPDATE pairing_code + INSERT pairing_grant); a replay 0. The D3 replay rule holds with the grant in the
	 * device's place: the same code, request id and secret hash while the grant is live → the same 200; another
	 * secret → `409 enrollment_request_conflict`; the grant revoked → `409 used_code`. The 200 echoes the secret the
	 * client sent (as the old body echoes deviceToken) and names the grant; no device is registered here.
	 */
	private async enrollGrant(parsed: GrantEnrollRequest, host: string): Promise<Response> {
		const [codeHash, secretDigest] = await Promise.all([sha256(parsed.secret), sha256(parsed.grantSecret)]);
		const current = this.load();
		if (!current) return json({ error: "invalid_code" }, 404);
		const restoring = this.restoreBlocked();
		if (restoring) return restoring;
		const secretHash = bytesToHex(secretDigest);
		const code = this.codeRow(codeHash);
		if (!code) return this.codeFailure(404, "invalid_code");
		if (code.used_at !== null) {
			if (code.used_request_id !== parsed.enrollmentRequestId) return this.codeFailure(409, "used_code");
			// The code was used by an old (device) enroll with this request id: another body under the same id.
			if (code.used_grant_id === null) return json({ error: "enrollment_request_conflict" }, 409);
			const grant = current.grants.byId(code.used_grant_id);
			if (!grant || grant.revokedAt !== null) return this.codeFailure(409, "used_code");
			if (grant.secretHash !== secretHash) return json({ error: "enrollment_request_conflict" }, 409);
			return this.grantEnrolled(current, grant, parsed.grantSecret, host);
		}
		if (code.expires_at <= this.clock.now()) return this.codeFailure(410, "expired_code");
		// One secret, one grant: a secret already in use (even a revoked grant's) is refused, never shared.
		if (current.grants.bySecretHash(secretHash)) return json({ error: "grant_exists" }, 409);
		const names = new Set<string>();
		for (const grant of current.grants.list()) if (grant.revokedAt === null) names.add(grant.name);
		for (const device of current.devices.list()) if (device.grantId === null) names.add(device.deviceName);
		const now = this.clock.now();
		const grant: GrantRecord = {
			grantId: randomBase64Url(16),
			secretHash,
			name: uniqueDeviceName(parsed.grantName, names),
			enrollmentRequestId: parsed.enrollmentRequestId,
			createdAt: now,
			revokedAt: null,
			registeredDay: 0,
			registeredCount: 0,
			secretWrap: null,
		};
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				"UPDATE pairing_code SET used_at = ?, used_request_id = ?, used_grant_id = ? WHERE code_hash = ?",
				now, parsed.enrollmentRequestId, grant.grantId, codeHash.buffer,
			);
			this.storage.sql.exec(GRANT_INSERT, ...grantRow(grant));
		});
		this.identityWrites++;
		current.grants.add(grant);
		return this.grantEnrolled(current, grant, parsed.grantSecret, host);
	}

	/** The grant enroll 200: `{host, vaultId, grantId, grantSecret, grantName, vaultGeneration}`. */
	private grantEnrolled(state: VaultState, grant: GrantRecord, secret: string, host: string): Response {
		return json({ host, vaultId: state.meta.vaultId, grantId: grant.grantId, grantSecret: secret,
			grantName: grant.name, vaultGeneration: state.meta.vaultGeneration });
	}

	/**
	 * The grant named by `Authorization: Grant <secret>`, read after the hash (a revoke during it wins). `unknown`
	 * counts against the D3 failure limiter (§3.3: wrong secrets are guesses); a revoked grant is a known credential.
	 */
	private async grantOf(request: Request): Promise<{ kind: "none" | "unknown" } | { kind: "grant"; grant: GrantRecord }> {
		const secret = grantSecret(request);
		if (secret === null) return { kind: "none" };
		const secretHash = bytesToHex(await sha256(secret));
		const grant = this.load()?.grants.bySecretHash(secretHash);
		if (!grant) {
			this.enrollFailures.record();
			return { kind: "unknown" };
		}
		return { kind: "grant", grant };
	}

	/**
	 * `POST /auth/device {deviceId, deviceToken, retireKeyHash}` (§3.2 register): a new store's identity under a
	 * grant, authenticated by the grant secret or by the bearer of a live device of that grant (the epoch migration's
	 * old store). Rows: 2 (INSERT device + UPDATE the grant's day counter); an idempotent retry 0. Order: limiter →
	 * credential (401; `401 grant_revoked`; `403 grant_required` for a device enrolled without a grant) → restore →
	 * body (400) → same deviceId and token under the same grant (200 again) → `409 device_exists` → tombstone (`409
	 * device_retired`, one read) → `429 registration_limit` (20 a UTC day, Retry-After to midnight) → `409
	 * device_limit` (50 live). The device takes the grant's name.
	 */
	private async registerDevice(request: Request): Promise<Response> {
		const blocked = this.enrollFailures.retryAfterMs();
		if (blocked > 0) return tooManyAttempts(blocked);
		const token = grantSecret(request) === null ? bearerToken(request) : null;
		if (grantSecret(request) === null && token === null) return unauthorized();
		const [credential, bearer, body] = await Promise.all([this.grantOf(request),
			token === null ? Promise.resolve(null) : this.authenticate(request), readSmallJson(request)]);
		const parsed = parseRegisterRequest(body);
		const tokenDigest = parsed ? await sha256(parsed.deviceToken) : null;
		// Synchronous from here to the response: the grant, the device map and the write are one turn.
		const current = this.load();
		if (!current) return unauthorized();
		let grant: GrantRecord | undefined;
		if (credential.kind === "grant") grant = current.grants.byId(credential.grant.grantId);
		else if (credential.kind === "unknown") return unauthorized();
		else {
			const device = bearer ? current.devices.byId(bearer.deviceId) : undefined;
			if (!device) return unauthorized();
			if (device.grantId === null) return json({ error: "grant_required" }, 403);
			grant = current.grants.byId(device.grantId);
		}
		if (!grant) return unauthorized();
		if (grant.revokedAt !== null) return json({ error: "grant_revoked" }, 401);
		const restoring = this.restoreBlocked();
		if (restoring) return restoring;
		if (!parsed || !tokenDigest) return json({ error: "invalid_request" }, 400);
		// §6.2: a registration is one of the lazy sweep's triggers; it runs before the 50-live cap is counted.
		this.retireInactive();
		const tokenHash = bytesToHex(tokenDigest);
		const existing = current.devices.byId(parsed.deviceId);
		if (existing) {
			if (existing.tokenHash === tokenHash && existing.grantId === grant.grantId && existing.retireHash === parsed.retireHash) {
				return this.registered(current, existing);
			}
			return json({ error: "device_exists" }, 409);
		}
		if (current.devices.byTokenHash(tokenHash)) return json({ error: "device_exists" }, 409);
		if (this.isRetired(parsed.deviceId)) return json({ error: "device_retired" }, 409);
		const now = this.clock.now();
		const today = utcDay(now);
		const usedToday = grant.registeredDay === today ? grant.registeredCount : 0;
		if (usedToday >= GRANT_REGISTRATIONS_PER_DAY) {
			const response = json({ error: "registration_limit" }, 429);
			response.headers.set("Retry-After", String(Math.max(1, Math.ceil(((today + 1) * DAY_MS - now) / 1000))));
			return response;
		}
		// DECISIONS-GAP (G59): at the cap, refuse; nothing is retired to make room beyond what the inactivity sweep
		// above retired (devices not seen for 90 days).
		if (current.devices.ofGrant(grant.grantId).length >= GRANT_LIVE_DEVICE_LIMIT) {
			return json({ error: "device_limit" }, 409);
		}
		const record: DeviceRecord = {
			tokenHash,
			deviceId: parsed.deviceId,
			deviceName: grant.name,
			enrollmentRequestId: "",
			enrolledAt: now,
			grantId: grant.grantId,
			retireHash: parsed.retireHash,
			// Registering is being seen: the store's first ticket today writes nothing more.
			lastSeenDay: today,
		};
		const grantId = grant.grantId;
		this.storage.transactionSync(() => {
			this.storage.sql.exec(DEVICE_INSERT, ...deviceRow(record));
			this.storage.sql.exec("UPDATE pairing_grant SET registered_day = ?, registered_count = ? WHERE grant_id = ?",
				today, usedToday + 1, grantId);
		});
		this.identityWrites++;
		grant.registeredDay = today;
		grant.registeredCount = usedToday + 1;
		current.devices.add(record);
		return this.registered(current, record);
	}

	/** The register 200: no token material (the client holds its token and retire key). */
	private registered(state: VaultState, device: DeviceRecord): Response {
		return json({ vaultId: state.meta.vaultId, deviceId: device.deviceId, deviceName: device.deviceName,
			grantId: device.grantId, vaultGeneration: state.meta.vaultGeneration });
	}

	/**
	 * `POST /auth/device/retire {deviceId, retireKey}` (§3.2, the successor fence of §5.2): the key's hash must be the
	 * device's `retire_hash`. A device that is gone (retired, or never registered) is `200 {retired: false}`: "already
	 * gone counts as done". A wrong key, or a device without a retire key (old enroll), is `401 unauthorized` and
	 * counts against the D3 limiter. Rows: 2 (DELETE device + INSERT tombstone).
	 */
	private async retireByKey(request: Request): Promise<Response> {
		const blocked = this.enrollFailures.retryAfterMs();
		if (blocked > 0) return tooManyAttempts(blocked);
		const parsed = parseRetireRequest(await readSmallJson(request));
		if (!parsed) return json({ error: "invalid_request" }, 400);
		const keyHash = bytesToHex(await sha256(parsed.retireKey));
		const current = this.load();
		if (!current) return unauthorized();
		const device = current.devices.byId(parsed.deviceId);
		// DECISIONS-GAP (G60): gone or never registered is done, not an error.
		if (!device) return json({ ok: true, deviceId: parsed.deviceId, retired: false });
		if (device.retireHash === null || device.retireHash !== keyHash) return this.codeFailure(401, "unauthorized");
		const restoring = this.restoreBlocked();
		if (restoring) return restoring;
		this.retireDevices(current, [device]);
		return json({ ok: true, deviceId: device.deviceId, retired: true });
	}

	/**
	 * `POST /auth/device/status {deviceIds}` (bearer; at most 32 ids): each id's state, `live` (registered),
	 * `retired` (tombstoned) or `unknown`. A client asks it about the creators of docs whose initial body never
	 * arrived (DESIGN §i.5 "Abandoned creates"): a retired store never sends again. Rows read: one PK read of
	 * `retired_device` per id that is not live; no write, except the inactivity sweep this request triggers (§6.2): a
	 * creator not seen for 90 days reads `retired` here, so its body-less creates resolve without the console.
	 */
	private async deviceStatus(request: Request): Promise<Response> {
		const ids = parseDeviceStatusRequest(await readSmallJson(request));
		if (!ids) return json({ error: "invalid_request" }, 400);
		const current = this.load();
		if (!current) return unauthorized();
		this.retireInactive();
		const devices = ids.map((deviceId) => ({
			deviceId,
			state: current.devices.byId(deviceId) ? "live" : this.isRetired(deviceId) ? "retired" : "unknown",
		}));
		return json({ ok: true, devices });
	}

	/**
	 * `DELETE /auth/device` (bearer, §3.2 self-retire): the bearer's own device is retired. `200 {ok, deviceId,
	 * retired: true}`; a second call is 401 (the token is dead), which the client's `retireDeviceEnrollment` counts
	 * as done. Works for a device of the old enroll too. Rows: 2.
	 */
	private selfRetire(device: DeviceRecord): Response {
		const current = this.load();
		const live = current?.devices.byId(device.deviceId);
		if (!current || !live || live.tokenHash !== device.tokenHash) return unauthorized();
		this.retireDevices(current, [live]);
		return json({ ok: true, deviceId: live.deviceId, retired: true });
	}

	/**
	 * `DELETE /auth/grant` (grant secret, §3.2 leave): the grant is revoked and its devices retired, as the
	 * operator's "Revoke pairing". `200 {ok, grantId, revoked, retiredDevices}`; an already revoked grant is
	 * `revoked: false`, so a retry after a lost response is a no-op.
	 */
	private async leaveGrant(request: Request): Promise<Response> {
		const blocked = this.enrollFailures.retryAfterMs();
		if (blocked > 0) return tooManyAttempts(blocked);
		const credential = await this.grantOf(request);
		if (credential.kind !== "grant") return unauthorized();
		const restoring = this.restoreBlocked();
		if (restoring) return restoring;
		const result = this.revokeGrant(credential.grant.grantId, "holder");
		return json({ ok: true, grantId: credential.grant.grantId, revoked: result.revoked,
			retiredDevices: result.retiredDevices });
	}

	/**
	 * `POST /auth/pairing-code` with `Authorization: Grant <secret>` (owner decision 3: main holds the grant, not a
	 * device token). Same body, purpose rule and answer as the bearer route; `401 grant_revoked` for a revoked grant.
	 */
	private async grantPairingCode(request: Request): Promise<Response> {
		const blocked = this.enrollFailures.retryAfterMs();
		if (blocked > 0) return tooManyAttempts(blocked);
		const credential = await this.grantOf(request);
		if (credential.kind !== "grant") return unauthorized();
		if (credential.grant.revokedAt !== null) return json({ error: "grant_revoked" }, 401);
		const restoring = this.restoreBlocked();
		if (restoring) return restoring;
		const grantId = credential.grant.grantId;
		return await this.pairingCodeResponse(request,
			() => this.load()?.grants.byId(grantId)?.revokedAt === null);
	}

	/**
	 * `GET /auth/grant` (bearer, §3.4): the device's grant secret after a rotation, so the install rewrites data.json
	 * without a re-pair: `200 {grantId, grantName, grantSecret}`. `403 grant_required` for a device of the old enroll,
	 * `401 grant_revoked`, `404 grant_secret_unavailable` for a grant never rotated (the server holds only the hash of
	 * the secret the client minted, G56; the client keeps the one it has). 0 rows.
	 */
	private async fetchGrant(device: DeviceRecord): Promise<Response> {
		const state = this.load();
		if (!state) return unauthorized();
		if (device.grantId === null) return json({ error: "grant_required" }, 403);
		const grant = state.grants.byId(device.grantId);
		if (!grant) return unauthorized();
		if (grant.revokedAt !== null) return json({ error: "grant_revoked" }, 401);
		if (grant.secretWrap === null) return json({ error: "grant_secret_unavailable" }, 404);
		const wrap = grant.secretWrap;
		const secret = await unwrapGrantSecret(state.meta.ticketKey, state.meta.vaultId, grant.grantId, hexToBytes(wrap));
		// The await yields: a revoke or another rotation that ran meanwhile wins (answer what is current, or nothing).
		const current = this.load()?.grants.byId(grant.grantId);
		if (!this.admits(device.deviceId) || !current) return unauthorized();
		if (current.revokedAt !== null) return json({ error: "grant_revoked" }, 401);
		if (current.secretWrap !== wrap) return json({ error: "grant_rotating" }, 409);
		if (secret === null) {
			console.error("[yaos-vault] a grant's wrapped secret does not open");
			return json({ error: "grant_secret_unavailable" }, 404);
		}
		return json({ grantId: grant.grantId, grantName: grant.name, grantSecret: secret });
	}

	/**
	 * Identity-per-store §3.4 "Rotate secret" (operator RPC, `POST /operator/vaults/:id/grants/:grantId/rotate`): a new
	 * grant secret (32 random bytes, base64url) replaces the old one in ONE UPDATE (1 row). From that turn on the old
	 * secret is unknown (`401 unauthorized` on every grant route, counted by the D3 failure limiter); the grant's live
	 * devices keep working (they authenticate by their own tokens) and fetch the new secret with `GET /auth/grant`. The
	 * secret is not returned: no one but a live device of the grant needs it. Unknown or revoked: `rotated: false`.
	 */
	async rotateGrant(grantId: string): Promise<GrantRotateResult> {
		const state = this.load();
		const grant = state?.grants.byId(grantId);
		if (!state || !grant || grant.revokedAt !== null) return { rotated: false, grantId };
		const secret = randomBase64Url(32);
		const [digest, wrap] = await Promise.all([sha256(secret),
			wrapGrantSecret(state.meta.ticketKey, state.meta.vaultId, grantId, secret)]);
		// Synchronous from here: a revoke that ran during the crypto wins.
		const current = this.load();
		const live = current?.grants.byId(grantId);
		if (!current || !live || live.revokedAt !== null) return { rotated: false, grantId };
		this.storage.sql.exec("UPDATE pairing_grant SET secret_hash = ?, secret_wrap = ? WHERE grant_id = ?",
			digest.buffer, wrap.buffer, grantId);
		this.identityWrites++;
		current.grants.rekey(live, bytesToHex(digest), bytesToHex(wrap));
		return { rotated: true, grantId };
	}

	/**
	 * Identity-per-store §6.2 inactivity retirement (owner decision 4; phase 5), lazy: run by the requests that need an
	 * accurate list (registration, device status, the operator listing), never by a timer or alarm. A device whose
	 * `last_seen_day` (the UTC day of its last ticket; for an old enroll never ticketed, its enroll day) is more than
	 * `inactivityRetireDays` before today is retired like every other retire path (`retireDevices`: D7 + tombstone).
	 *
	 * Cost: the scan is over the in-memory device map (0 rows read); a full sweep runs at most once a UTC day per
	 * runtime (the eligibility changes only at a day boundary). Writes only when it retires: 2 rows per device, at most
	 * INACTIVITY_RETIRE_BATCH devices per sweep in one transaction (a later trigger goes on). A stale device with an
	 * open streams socket is not retired: it is seen now, and gets the day's `last_seen_day` write (noteSeen). Skipped
	 * while a restore runs or the daily limit is latched; a failure never fails the request that triggered it.
	 * DECISIONS-GAP (G66): its retirements are `identityWrites` (authority), so one that lands in a D8b rewind window
	 * makes finish rewind again, like an enroll there (G62).
	 */
	private retireInactive(): void {
		const state = this.load();
		if (!state) return;
		const today = utcDay(this.clock.now());
		if (this.inactivitySweptDay === today || this.restoringRemainingMs() > 0 || this.latch.active()) return;
		const cutoff = today - this.inactivityRetireDays;
		const stale = [...state.devices.list()].filter((device) => (device.lastSeenDay ?? utcDay(device.enrolledAt)) < cutoff);
		try {
			const gone: DeviceRecord[] = [];
			if (stale.length > 0) {
				const connected = this.relay.connectedDevices();
				for (const device of stale) {
					if (connected.has(device.deviceId)) this.noteSeen(device);
					else gone.push(device);
				}
			}
			const batch = gone.slice(0, INACTIVITY_RETIRE_BATCH);
			if (batch.length > 0) {
				this.retireDevices(state, batch);
				console.log(`[yaos-vault] inactivity retirement: ${batch.length} device(s) not seen for over ${this.inactivityRetireDays} days`);
			}
			if (gone.length <= batch.length) this.inactivitySweptDay = today;
		} catch (error) {
			this.latch.note(error);
			console.warn("[yaos-vault] inactivity retirement failed", describeError(error));
		}
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
		const live = this.load()?.devices.byId(device.deviceId);
		if (!live) return json({ error: "unauthorized" }, 401);
		this.noteSeen(live);
		return json(issued);
	}

	/**
	 * DECISIONS-GAP (G63). Identity-per-store §6.2 `last_seen_day`: the first ticket of a UTC day writes it (and the
	 * inactivity sweep, for a stale device with an open socket), so ≤ 1 row per device per day
	 * (owner decision 4 accepts this deviation from §6.1's "0 rows per bearer auth"). Bookkeeping only: skipped while
	 * the daily limit is latched, and a failed write never refuses the ticket. Not an `identityWrites` write: a ticket
	 * in the D8b rewind window must not force a re-rewind, and finish sets every row's value from the snapshot anyway.
	 */
	private noteSeen(device: DeviceRecord): void {
		const today = utcDay(this.clock.now());
		if (device.lastSeenDay === today || this.latch.active()) return;
		try {
			this.storage.sql.exec("UPDATE device SET last_seen_day = ? WHERE token_hash = ?", today,
				hexToBytes(device.tokenHash).buffer);
			device.lastSeenDay = today;
		} catch (error) {
			this.latch.note(error);
			console.warn("[yaos-vault] last_seen_day write failed", describeError(error));
		}
	}

	/**
	 * `GET /ws/streams?ticket=…` (D4): the ticket must verify with this vault's ticket key and generation, and its
	 * device must be in the device map after the verification (D7). Any failure: the `unauthorized` frame and 1008.
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

	/**
	 * `GET /operator/vaults/:id/devices`: no token material (T-DEVICES-LIST). 0 rows written, except the inactivity sweep
	 * it triggers (§6.2: a stale device is retired before it is listed). DECISIONS-GAP (G61).
	 */
	listDevices(): DeviceListing {
		this.retireInactive();
		const state = this.load();
		const devices = state ? [...state.devices.list()] : [];
		devices.sort((a, b) => a.enrolledAt - b.enrolledAt || a.deviceId.localeCompare(b.deviceId));
		const grants = state ? [...state.grants.list()] : [];
		grants.sort((a, b) => a.createdAt - b.createdAt || a.grantId.localeCompare(b.grantId));
		return {
			devices: devices.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, enrolledAt: d.enrolledAt,
				...(d.grantId !== null ? { grantId: d.grantId } : {}),
				...(d.lastSeenDay !== null ? { lastSeenDay: utcDayString(d.lastSeenDay) } : {}) })),
			grants: grants.map((g) => {
				const live = devices.filter((d) => d.grantId === g.grantId);
				const seen = Math.max(-1, ...live.map((d) => d.lastSeenDay ?? -1));
				return { grantId: g.grantId, name: g.name, createdAt: g.createdAt, revokedAt: g.revokedAt,
					liveDevices: live.length, lastSeenDay: seen < 0 ? null : utcDayString(seen) };
			}),
		};
	}

	/**
	 * D7 revoke ("Remove device"): ONE synchronous turn, no await (`retireDevices`). Idempotent: an unknown device is
	 * `revoked: false`. Identity-per-store §6.2: the removed deviceId is tombstoned, so it never comes back; an install
	 * that still holds a live grant registers a new device on its next start (§3.4).
	 *
	 * Key-roll signal (e2ee-design §14.5): a device enrolled without a grant cannot come back, so its removal blocks it
	 * and counts as a removal; a store under a live grant is only tidied (its install keeps syncing) and does not.
	 */
	revokeDevice(deviceId: string): { revoked: boolean; droppedFrames: number; closedSockets: number } {
		const state = this.load();
		const record = state?.devices.byId(deviceId);
		if (state && record) {
			const blocks = record.grantId === null;
			const { droppedFrames, closedSockets } = this.retireDevices(state, [record],
				blocks ? () => { this.countRemoval(); } : undefined);
			if (blocks) this.removalCounted(state);
			return { revoked: true, droppedFrames, closedSockets };
		}
		const { droppedFrames, closedSockets } = this.relay.revokeDevice(deviceId);
		return { revoked: false, droppedFrames, closedSockets };
	}

	/**
	 * Identity-per-store §3.4 "Revoke pairing" (operator) and leave (the grant's holder): ONE synchronous turn. The
	 * grant gets `revoked_at` (it is kept, so its secret answers `401 grant_revoked` and is never reused) and every
	 * live device of it is retired: 1 + 2·D rows. Idempotent: an unknown or already revoked grant is `revoked: false`.
	 * The operator's revoke is a blocking removal (e2ee-design §14.5: + 1 row, `vault_meta.removals`); a leave is not.
	 */
	revokeGrant(grantId: string, by: "operator" | "holder"): GrantRevokeResult {
		const state = this.load();
		const grant = state?.grants.byId(grantId);
		if (!state || !grant || grant.revokedAt !== null) {
			return { revoked: false, retiredDevices: 0, droppedFrames: 0, closedSockets: 0 };
		}
		const now = this.clock.now();
		const devices = state.devices.ofGrant(grantId);
		const { droppedFrames, closedSockets } = this.retireDevices(state, devices, () => {
			this.storage.sql.exec("UPDATE pairing_grant SET revoked_at = ? WHERE grant_id = ?", now, grantId);
			if (by === "operator") this.countRemoval();
		});
		grant.revokedAt = now;
		if (by === "operator") this.removalCounted(state);
		return { revoked: true, retiredDevices: devices.length, droppedFrames, closedSockets };
	}

	/**
	 * Every retire (D7 revoke, self, by key, grant revoke, inactivity): ONE `transactionSync` deletes the device rows (1 row each;
	 * §6.1: no secondary index, the DELETE scans the few device rows), inserts their tombstones (1 row each) and runs
	 * `alsoWrite`; the device-map entries go with it, so the gate shuts with the transaction. Then, per device, the
	 * relay drops its buffered frames (never committed, no receipt; no flush), tells peers that held their
	 * PROVISIONALs, and sends each of its sockets `authority_superseded` + close 4403. The caller's response leaves
	 * after this returns.
	 */
	private retireDevices(state: VaultState, devices: readonly DeviceRecord[], alsoWrite?: () => void):
		{ droppedFrames: number; closedSockets: number } {
		const now = this.clock.now();
		this.storage.transactionSync(() => {
			alsoWrite?.();
			for (const device of devices) {
				this.storage.sql.exec("DELETE FROM device WHERE device_id = ?", device.deviceId);
				this.storage.sql.exec("INSERT OR IGNORE INTO retired_device (device_id, grant_id, retired_at) VALUES (?, ?, ?)",
					device.deviceId, device.grantId, now);
			}
		});
		this.identityWrites++;
		for (const device of devices) state.devices.remove(device.deviceId);
		let droppedFrames = 0;
		let closedSockets = 0;
		for (const device of devices) {
			const revoked = this.relay.revokeDevice(device.deviceId);
			droppedFrames += revoked.droppedFrames;
			closedSockets += revoked.closedSockets;
		}
		return { droppedFrames, closedSockets };
	}

	// ---- the key-roll signal (e2ee-design §14.5) ------------------------------------------------------------------

	/** Inside a retire's transaction: + 1 blocking removal (the memory copy follows in `removalCounted`). */
	private countRemoval(): void {
		this.storage.sql.exec("UPDATE vault_meta SET removals = removals + 1 WHERE id = 1");
	}

	/** After the retire's transaction committed: the memory copy, then every remaining socket hears of it. */
	private removalCounted(state: VaultState): void {
		state.meta.removals++;
		this.relay.broadcastRekey();
	}

	/**
	 * A device's `VAULT_REKEYED {removals}` (relay-wire §4.2): it rolled the vault key (a revoke record, e2ee-design
	 * §14.2) after it had seen `removals`. Only a count above `rekeyed` and at most `removals` is taken (1 row), and
	 * every socket hears the new state; anything else is ignored (a late or repeated ack, or a count the vault never
	 * had). The relay admitted the socket's device just before (D7), so a removed device cannot ack. A failed write
	 * (the daily limit) is dropped: the device acks again on its next session.
	 */
	private noteRekeyed(removals: number): void {
		const state = this.load();
		if (!state || removals <= state.meta.rekeyed || removals > state.meta.removals) return;
		try {
			this.storage.sql.exec("UPDATE vault_meta SET rekeyed = ? WHERE id = 1", removals);
		} catch (error) {
			this.latch.note(error);
			console.warn("[yaos-vault] rekeyed write failed", describeError(error));
			return;
		}
		this.identityWrites++;
		state.meta.rekeyed = removals;
		this.relay.broadcastRekey();
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
		// Identity v2: the grants and the tombstones cross the rewind with the devices (R rows read, cold path).
		const retired = this.storage.sql.exec<{ device_id: string; grant_id: string | null; retired_at: number }>(
			"SELECT device_id, grant_id, retired_at FROM retired_device").toArray()
			.map((row): RetiredRecord => ({ deviceId: row.device_id, grantId: row.grant_id, retiredAt: row.retired_at }));
		return { kind: "prepared", bookmark, devices: [...current.devices.list()].map((device) => ({ ...device })),
			grants: [...current.grants.list()].map((grant) => ({ ...grant })), retired,
			rekey: { removals: current.meta.removals, rekeyed: current.meta.rekeyed } };
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
	 * is exactly T. Else ONE `transactionSync` (≈ D+P+1 rows, + G' + R'): the device table becomes the snapshot's
	 * (rows that differ in an authority field are deleted and inserted; a row that differs only in `last_seen_day`
	 * gets one UPDATE),
	 * likewise the grant table (G' differing rows), the snapshot's tombstones are inserted where missing (R'; a
	 * tombstone is never deleted), every pairing code is deleted, and meta gets a new epoch, `last_restore_id`,
	 * `last_restore_at` and no marker. Then the flag clears and every streams socket closes 1001. A snapshot without
	 * grants or tombstones (a journal row from before identity v2) leaves those tables as the rewind left them.
	 */
	finishRestore(restoreId: string, snapshot: IdentitySnapshot): FinishRestoreResult {
		const { devices, grants, retired, rekey } = snapshot;
		const state = this.load();
		if (!state) return { kind: "unknown_vault" };
		if (state.meta.lastRestoreId === restoreId) return { kind: "finished", vaultEpoch: state.meta.vaultGeneration };
		// DECISIONS-GAP: D8b's "pending_restore_id still set" is read as "== restoreId": the rewound state may hold
		// another restore's marker from before T (a restore in flight at T), and that one never clears by rewinding.
		if (state.meta.pendingRestoreId === restoreId) return { kind: "rewind_needed" };
		if (this.relay.writesThisRuntime + this.identityWrites > 0) return { kind: "rewind_needed" };
		const wanted = new Map(devices.map((device) => [device.tokenHash, device]));
		const present = new Map([...state.devices.list()].map((device) => [device.tokenHash, device]));
		const wantedGrants = grants ? new Map(grants.map((grant) => [grant.grantId, grant])) : null;
		const presentGrants = new Map([...state.grants.list()].map((grant) => [grant.grantId, grant]));
		const vaultGeneration = randomBase64Url(16);
		const now = this.clock.now();
		this.storage.transactionSync(() => {
			for (const [tokenHash, device] of present) {
				const keep = wanted.get(tokenHash);
				if (keep && sameDevice(keep, device)) {
					// Bookkeeping only: one UPDATE, not a DELETE + INSERT of the row.
					if (keep.lastSeenDay !== device.lastSeenDay) {
						this.storage.sql.exec("UPDATE device SET last_seen_day = ? WHERE token_hash = ?", keep.lastSeenDay,
							hexToBytes(tokenHash).buffer);
					}
					continue;
				}
				this.storage.sql.exec("DELETE FROM device WHERE token_hash = ?", hexToBytes(tokenHash).buffer);
			}
			for (const [tokenHash, device] of wanted) {
				const have = present.get(tokenHash);
				if (have && sameDevice(have, device)) continue;
				this.storage.sql.exec(DEVICE_INSERT, ...deviceRow(device));
			}
			if (wantedGrants) {
				for (const [grantId, grant] of presentGrants) {
					const keep = wantedGrants.get(grantId);
					if (keep && sameGrant(keep, grant)) continue;
					this.storage.sql.exec("DELETE FROM pairing_grant WHERE grant_id = ?", grantId);
				}
				for (const [grantId, grant] of wantedGrants) {
					const have = presentGrants.get(grantId);
					if (have && sameGrant(have, grant)) continue;
					this.storage.sql.exec(GRANT_INSERT, ...grantRow(grant));
				}
			}
			for (const tombstone of retired ?? []) {
				this.storage.sql.exec("INSERT OR IGNORE INTO retired_device (device_id, grant_id, retired_at) VALUES (?, ?, ?)",
					tombstone.deviceId, tombstone.grantId, tombstone.retiredAt);
			}
			this.storage.sql.exec("DELETE FROM pairing_code");
			// The key-roll signal crosses the rewind in the same meta row write (a snapshot without it keeps T's).
			this.storage.sql.exec(
				"UPDATE vault_meta SET vault_generation = ?, pending_restore_id = NULL, last_restore_id = ?,"
					+ " last_restore_at = ?, removals = ?, rekeyed = ? WHERE id = 1",
				vaultGeneration, restoreId, now, rekey?.removals ?? state.meta.removals, rekey?.rekeyed ?? state.meta.rekeyed,
			);
		});
		this.identityWrites++;
		const map = new DeviceMap();
		for (const device of wanted.values()) map.add({ ...device });
		state.devices = map;
		if (wantedGrants) {
			const grantMap = new GrantMap();
			for (const grant of wantedGrants.values()) grantMap.add({ ...grant });
			state.grants = grantMap;
		}
		state.meta.vaultGeneration = vaultGeneration;
		state.meta.pendingRestoreId = null;
		state.meta.lastRestoreId = restoreId;
		state.meta.lastRestoreAt = now;
		if (rekey) {
			state.meta.removals = rekey.removals;
			state.meta.rekeyed = rekey.rekeyed;
		}
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
