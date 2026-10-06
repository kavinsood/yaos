// The vault Durable Object, one per vault: `idFromName(vaultId)` (DECISIONS §2.1). VaultHost holds the logic behind
// the ports; this class binds it to `ctx.storage` and the hibernatable WebSocket API.
import { DurableObject } from "cloudflare:workers";
import { readStreamRelayConfig, type StreamsEnv } from "../streams/relay";
import { CLOUDFLARE_UPGRADE_REJECT, CloudflareSocketRegistry } from "./cloudflare";
import { VaultHost, type VaultInitResult } from "./host";

export interface VaultEnv extends StreamsEnv {
	/** "1" turns on POST /vault/:id/debug/simulate-daily-limit (§2.2); otherwise the route answers 404. */
	YAOS_DEBUG_ROUTES?: string;
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
		});
	}

	/** Device routes, forwarded by the Worker as `https://vault.internal/<route>` (see VaultHost). */
	fetch(request: Request): Promise<Response> {
		return this.host.fetch(request);
	}

	/** RPC: idempotent vault init (D5). P2's claim and create-vault routes call it before the config DO. */
	init(vaultId: string): VaultInitResult {
		return this.host.init(vaultId);
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
