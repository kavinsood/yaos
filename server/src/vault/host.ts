// Vault DO host logic behind the ports (DECISIONS §2.1): vault meta, the device map, bearer auth, pairing codes and
// enroll (D3), tickets (D4), revoke (D7), vault delete (D5) and the streams relay. vault.ts wraps it in the
// Cloudflare Durable Object class; tests run it on Node with SQLite and fake sockets.
//
// The Worker forwards a device route as `https://vault.internal/<rest>?<query>` (the path after /vault/:id, or
// /enroll), after its own method, path and format checks, with the public origin in `X-YAOS-Origin`. This object
// never calls the config DO.
//
// Awaits: SHA-256, HMAC and body reads yield the turn, and a revoke or delete may run meanwhile (DO input gates hold
// events only during storage operations). So every handler awaits its crypto first, then re-reads the in-memory
// state and decides and writes in one synchronous stretch: a revoke that won the race is always seen.
import { randomBase64Url } from "../base64url";
import { DailyLimitLatch, dailyLimitResponse, instrumentStorageForDailyLimit } from "../dailyLimit";
import { bytesToHex } from "../hex";
import { bearerToken, isWebSocketUpgrade, json, notFound, notImplemented, rejectSocket, releaseUnreadBody } from "../http";
import { FailureLimiter, tooManyAttempts } from "../limiter";
import {
	SYSTEM_CLOCK,
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

export interface VaultMeta {
	vaultId: string;
	/** D8: the vault epoch, base64url(16 random bytes), minted at init. */
	vaultGeneration: string;
	/** D4: 32 random bytes, made at init, never exported. */
	ticketKey: Uint8Array;
	createdAt: number;
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
}

type MetaRow = { vault_id: string; vault_generation: string; ticket_key: ArrayBuffer; created_at: number };
type CodeRow = { expires_at: number; used_at: number | null; used_request_id: string | null; used_device_id: string | null };

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

	constructor(options: VaultHostOptions) {
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.sockets = options.sockets;
		this.upgrades = options.upgrades;
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
				const frame = `__YPS:${JSON.stringify(this.latch.decorateControl(value))}`;
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
				"SELECT vault_id, vault_generation, ticket_key, created_at FROM vault_meta WHERE id = 1",
			).toArray()[0];
		} catch (error) {
			if (!isMissingTableError(error, "vault_meta")) throw error;
		}
		this.state = row
			? {
				meta: { vaultId: row.vault_id, vaultGeneration: row.vault_generation,
					ticketKey: new Uint8Array(row.ticket_key), createdAt: row.created_at },
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
		const meta: VaultMeta = { vaultId, vaultGeneration, ticketKey, createdAt: this.clock.now() };
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
				return state ? await this.enroll(request, state) : json({ error: "invalid_code" }, 404);
			case "GET /ws/streams":
				// §2.2: an unknown vault gets the `unauthorized` frame and 1008.
				return state ? await this.upgrade(request, url, state) : rejectSocket(request, this.upgrades, "unauthorized");
			case "GET /streams/feed":
			case "GET /streams/read":
			case "PUT /streams/checkpoint":
			case "POST /auth/ticket":
			case "POST /auth/pairing-code":
			case "POST /debug/simulate-daily-limit":
				break;
			default:
				return notFound();
		}
		// §2.2: an unknown vault answers exactly like a bad credential (no existence oracle).
		const device = state ? await this.authenticate(request) : null;
		if (!device) return json({ error: "unauthorized" }, 401);
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
			default:
				// P3: simulate-daily-limit (H3).
				return notImplemented();
		}
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
			state.devices.remove(deviceId);
		}
		const { droppedFrames, closedSockets } = this.relay.revokeDevice(deviceId);
		return { revoked: record !== undefined, droppedFrames, closedSockets };
	}

	/**
	 * D5 vault delete, the vault DO's part: streams sockets close 1001, the buffer and caches are dropped, the
	 * in-memory state becomes "no vault" at once (every device route → 401), then `deleteAll()` wipes the storage.
	 */
	async deleteVault(): Promise<{ deleted: true }> {
		for (const socket of this.sockets.sockets()) {
			if (!this.relay.owns(socket)) continue;
			try { socket.close(1001, "vault deleted"); } catch { /* closed */ }
		}
		this.relay.reset();
		this.state = null;
		this.ticketKey = null;
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
