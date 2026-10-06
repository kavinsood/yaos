// Cloudflare adapters for the ports in ../ports.ts (hibernatable WebSockets on the vault DO's state).
import type { SocketPort, SocketRegistryPort, UpgradeRejectPort } from "../ports";

/** `ctx.getWebSockets()`, `new WebSocketPair()`, `ctx.acceptWebSocket()` (hibernation API) and the 101. */
export class CloudflareSocketRegistry implements SocketRegistryPort {
	constructor(private readonly ctx: DurableObjectState) {}

	sockets(): readonly SocketPort[] {
		return this.ctx.getWebSockets();
	}

	createPair(): { client: unknown; server: SocketPort } {
		const pair = new WebSocketPair();
		return { client: pair[0], server: pair[1] };
	}

	accept(socket: SocketPort): void {
		this.ctx.acceptWebSocket(socket as WebSocket);
	}

	upgradeResponse(client: unknown): Response {
		return new Response(null, { status: 101, webSocket: client as WebSocket });
	}
}

/**
 * Refuses an upgrade with a non-hibernating pair: the error frame and the close leave before the 101. The legacy
 * `reciprocateSocketClose` is gone: with compatibility date 2026-04-07 (`web_socket_auto_reply_to_close`) the
 * runtime completes a peer-initiated close itself.
 */
export const CLOUDFLARE_UPGRADE_REJECT: UpgradeRejectPort = {
	reject(frame: string, code: number, reason: string): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.accept();
		server.send(frame);
		server.close(code, reason);
		return new Response(null, { status: 101, webSocket: client });
	},
};
