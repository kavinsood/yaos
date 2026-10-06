// Vault DO host logic behind the ports (DECISIONS §2.1): vault meta, the device map, bearer auth, the streams relay.
// vault.ts wraps it in the Cloudflare Durable Object class; tests run it on Node with SQLite and fake sockets.
//
// The Worker forwards a device route as `https://vault.internal/<rest>?<query>` (the path after /vault/:id, or
// /enroll), after its own method, path and format checks. This object never calls the config DO.
import { randomBase64Url } from "../base64url";
import { DailyLimitLatch, dailyLimitResponse, instrumentStorageForDailyLimit } from "../dailyLimit";
import { sha256Hex } from "../hex";
import { bearerToken, json, notFound, notImplemented, rejectSocket, releaseUnreadBody } from "../http";
import {
	SYSTEM_CLOCK,
	isMissingTableError,
	type ClockPort,
	type SocketPort,
	type SocketRegistryPort,
	type StoragePort,
	type TimerPort,
	type UpgradeRejectPort,
} from "../ports";
import { StreamRelayService, type StreamActor, type StreamRelayConfig } from "../streams/relay";
import { StreamStore } from "../streams/store";
import { isVaultId } from "../vaultId";
import { DeviceMap, type DeviceRecord } from "./devices";
import { VAULT_SCHEMA } from "./schema";

/** D6: `capabilityDigestForRole("owner")` of the removed server/src/collaboration.ts:93-97, frozen as a literal. */
export const OWNER_CAPABILITY_DIGEST = "97478b5b5cff0be09d2556e1f5b7e08e5a4aa5a9727e768f954c54f55f3b5646";

export interface VaultMeta {
	vaultId: string;
	/** D8: the vault epoch, base64url(16 random bytes), minted at init. */
	vaultGeneration: string;
	/** D4: 32 random bytes, made at init, never exported (P2 signs tickets with it). */
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
	storage: StoragePort;
	sockets: SocketRegistryPort;
	upgrades: UpgradeRejectPort;
	relayConfig: StreamRelayConfig;
	clock?: ClockPort;
	timers?: TimerPort;
	runtimeEpoch?: string;
}

type MetaRow = { vault_id: string; vault_generation: string; ticket_key: ArrayBuffer; created_at: number };

export class VaultHost {
	/** New per runtime: a hibernation wake or eviction makes a new one (relay-wire STREAM_RESEND). */
	readonly runtimeEpoch: string;
	/** D8 daily-limit latch, shared by the storage instrument and the relay. */
	readonly latch: DailyLimitLatch;
	readonly relay: StreamRelayService;
	private readonly storage: StoragePort;
	private readonly store: StreamStore;
	private readonly clock: ClockPort;
	private readonly upgrades: UpgradeRejectPort;
	/** undefined: not read yet in this runtime; null: never initialized ("no such table", cached per §6.1). */
	private state: VaultState | null | undefined = undefined;

	constructor(options: VaultHostOptions) {
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.upgrades = options.upgrades;
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
			validateActor: (actor) => this.load()?.devices.admits(actor.deviceId) === true,
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
				// D3: an unknown vault answers like an unknown secret, with zero writes and no DDL. P2: the code
				// lookup, replay and the device insert.
				return state ? notImplemented() : json({ error: "invalid_code" }, 404);
			case "GET /ws/streams":
				// §2.2: an unknown vault gets the `unauthorized` frame and 1008. P2 (D4): verify the ticket with
				// meta.ticketKey and the device map, then acceptStreams(device).
				return state ? notImplemented() : rejectSocket(request, this.upgrades, "unauthorized");
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
		const device = state ? await this.authenticate(request, state) : null;
		if (!state || !device) return json({ error: "unauthorized" }, 401);
		this.wake();
		switch (route) {
			case "GET /streams/feed":
				return this.relay.feed(url);
			case "GET /streams/read":
				return this.relay.read(url);
			case "PUT /streams/checkpoint":
				return await this.relay.putCheckpoint(request, url);
			default:
				// P2: ticket (D4) and pairing-code (D3); P3: simulate-daily-limit (H3).
				return notImplemented();
		}
	}

	/** Bearer auth: SHA-256 of the token against the in-memory device map (0 rows). */
	private async authenticate(request: Request, state: VaultState): Promise<DeviceRecord | null> {
		const token = bearerToken(request);
		if (!token) return null;
		return state.devices.byTokenHash(await sha256Hex(new TextEncoder().encode(token))) ?? null;
	}

	/**
	 * Admits a streams socket for an enrolled device with the D6 constants (the port seam P2's ticket verification
	 * calls). The relay re-checks the device through `validateActor`.
	 */
	acceptStreams(deviceId: string): Response {
		const state = this.load();
		const device = state?.devices.byId(deviceId);
		if (!state || !device) throw new Error("acceptStreams: unknown vault or device");
		this.wake();
		return this.relay.accept(ownerActor(state.meta, device), true);
	}

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
