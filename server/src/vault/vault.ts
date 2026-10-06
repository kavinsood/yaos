// The vault Durable Object, one per vault: `idFromName(vaultId)` (DECISIONS §2.1). VaultHost holds the logic behind
// the ports; this class binds it to `ctx.storage` and the hibernatable WebSocket API.
import { DurableObject } from "cloudflare:workers";
import { readStreamRelayConfig, type StreamsEnv } from "../streams/relay";
import { CLOUDFLARE_UPGRADE_REJECT, CloudflareSocketRegistry } from "./cloudflare";
import type { DeviceRecord } from "./devices";
import {
	VaultHost,
	type DeviceListing,
	type FinishRestoreResult,
	type MintedCode,
	type PrepareRestoreResult,
	type RewindResult,
	type VaultInitResult,
} from "./host";
import type { PairingPurpose } from "./pairing";
import { readTicketTtlMs } from "./ticket";

export interface VaultEnv extends StreamsEnv {
	/** "1" turns on POST /vault/:id/debug/simulate-daily-limit (§2.2); otherwise the route answers 404. */
	YAOS_DEBUG_ROUTES?: string;
	/** D4 ticket TTL in ms (default 300000, clamped to [1000, 86400000]). */
	YAOS_TICKET_TTL_MS?: string;
}

export class VaultDO extends DurableObject<VaultEnv> {
	private readonly host: VaultHost;

	constructor(ctx: DurableObjectState, env: VaultEnv) {
		super(ctx, env);
		this.host = new VaultHost({
			storage: ctx.storage,
			sockets: new CloudflareSocketRegistry(ctx),
			upgrades: CLOUDFLARE_UPGRADE_REJECT,
			relayConfig: readStreamRelayConfig(env),
			ticketTtlMs: readTicketTtlMs(env.YAOS_TICKET_TTL_MS),
			// D8b: Durable Object point-in-time recovery. Local workerd rejects getBookmarkForTime (→ 501).
			pitr: {
				getBookmarkForTime: (at) => ctx.storage.getBookmarkForTime(at),
				onNextSessionRestoreBookmark: (bookmark) => ctx.storage.onNextSessionRestoreBookmark(bookmark),
				abort: (reason) => {
					ctx.abort(reason);
					throw new Error(reason);
				},
			},
		});
	}

	/** Device routes, forwarded by the Worker as `https://vault.internal/<route>` (see VaultHost). */
	fetch(request: Request): Promise<Response> {
		return this.host.fetch(request);
	}

	/** RPC: idempotent vault init (D5). Claim and create vault call it before the config DO. */
	init(vaultId: string): VaultInitResult {
		return this.host.init(vaultId);
	}

	/** RPC: a one-time owner code (claim: owner-bootstrap; POST /operator/vaults/:id/owner-code). */
	mintOwnerCode(purpose: PairingPurpose): Promise<MintedCode | null> {
		return this.host.mintOwnerCode(purpose);
	}

	/** RPC: GET /operator/vaults/:id/devices. */
	listDevices(): DeviceListing {
		return this.host.listDevices();
	}

	/**
	 * RPC: D7 revoke. Synchronous on purpose: the whole revoke is one turn of this object, and the RPC result (so the
	 * operator's HTTP response) exists only after it.
	 */
	revokeDevice(deviceId: string): { revoked: boolean; droppedFrames: number; closedSockets: number } {
		return this.host.revokeDevice(deviceId);
	}

	/** RPC: D5 vault delete, this object's part (sockets 1001, then `deleteAll()`). */
	deleteVault(): Promise<{ deleted: true }> {
		return this.host.deleteVault();
	}

	/** RPC: D8a reset-streams (one transaction; a daily-limit error propagates). null: no such vault. */
	resetStreams(): { vaultEpoch: string } | null {
		return this.host.resetStreams();
	}

	/** RPC: D8b step 1 (config DO only). */
	prepareRestore(restoreId: string, at: number, refreshOnly: boolean): Promise<PrepareRestoreResult> {
		return this.host.prepareRestore(restoreId, at, refreshOnly);
	}

	/** RPC: D8b step 2 (config DO only). A real rewind aborts this object, so the call throws. */
	rewind(restoreId: string, bookmark: string): Promise<RewindResult> {
		return this.host.rewind(restoreId, bookmark);
	}

	/** RPC: D8b step 3 (config DO only). */
	finishRestore(restoreId: string, devices: DeviceRecord[]): FinishRestoreResult {
		return this.host.finishRestore(restoreId, devices);
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		this.host.webSocketMessage(socket, message);
	}

	webSocketClose(socket: WebSocket): void {
		this.host.webSocketClose(socket);
	}

	webSocketError(socket: WebSocket): void {
		this.host.webSocketError(socket);
	}
}
