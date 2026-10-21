// The vault Durable Object, one per vault: `idFromName(vaultId)` (DECISIONS §2.1). VaultHost holds the logic behind
// the ports; this class binds it to `ctx.storage` and the hibernatable WebSocket API.
import { DurableObject } from "cloudflare:workers";
import { readStreamRelayConfig, type StreamsEnv } from "../streams/relay";
import { SOCKET_KEEPALIVE_REQUEST, SOCKET_KEEPALIVE_RESPONSE } from "../shared/socketLiveness";
import { CLOUDFLARE_UPGRADE_REJECT, CloudflareSocketRegistry } from "./cloudflare";
import type { IdentitySnapshot } from "./devices";
import {
	VaultHost,
	type DeviceListing,
	type FinishRestoreResult,
	type GrantRevokeResult,
	type GrantRotateResult,
	type MintedCode,
	type PrepareRestoreResult,
	type RewindResult,
	type VaultInitResult,
} from "./host";
import { readInactivityRetireDays, type PairingPurpose } from "./pairing";
import { readTicketTtlMs } from "./ticket";

export interface VaultEnv extends StreamsEnv {
	/** "1" turns on POST /vault/:id/debug/simulate-daily-limit (§2.2); otherwise the route answers 404. */
	YAOS_DEBUG_ROUTES?: string;
	/** D4 ticket TTL in ms (default 300000, clamped to [1000, 86400000]). */
	YAOS_TICKET_TTL_MS?: string;
	/** Identity-per-store §6.2 inactivity retirement, in UTC days (default 90, clamped to [1, 3650]). */
	YAOS_INACTIVITY_RETIRE_DAYS?: string;
}

export class VaultDO extends DurableObject<VaultEnv> {
	private readonly host: VaultHost;

	constructor(ctx: DurableObjectState, env: VaultEnv) {
		super(ctx, env);
		// Idle keepalives are answered by the runtime, without waking the DO from hibernation. Set on every
		// construction (a wake from hibernation constructs the object again).
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(SOCKET_KEEPALIVE_REQUEST, SOCKET_KEEPALIVE_RESPONSE));
		this.host = new VaultHost({
			storage: ctx.storage,
			sockets: new CloudflareSocketRegistry(ctx),
			upgrades: CLOUDFLARE_UPGRADE_REJECT,
			relayConfig: readStreamRelayConfig(env),
			ticketTtlMs: readTicketTtlMs(env.YAOS_TICKET_TTL_MS),
			inactivityRetireDays: readInactivityRetireDays(env.YAOS_INACTIVITY_RETIRE_DAYS),
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

	/**
	 * RPC: identity-per-store §3.4 "Revoke pairing": the grant and every device of it, in one synchronous turn (as
	 * `revokeDevice`).
	 */
	revokeGrant(grantId: string): GrantRevokeResult {
		return this.host.revokeGrant(grantId, "operator");
	}

	/** RPC: identity-per-store §3.4 "Rotate secret": a new grant secret, the old one dead from this turn on. */
	rotateGrant(grantId: string): Promise<GrantRotateResult> {
		return this.host.rotateGrant(grantId);
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
	finishRestore(restoreId: string, snapshot: IdentitySnapshot): FinishRestoreResult {
		return this.host.finishRestore(restoreId, snapshot);
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
