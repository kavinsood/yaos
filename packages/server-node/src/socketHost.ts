import { randomUUID } from "node:crypto";
import type { SocketUpgradePort } from "../../../server/src/platformPorts";
import type { VaultSocketPort, VaultSocketRegistryPort } from "../../../server/src/vaultSocketService";
import type { AcceptedWebSocketUpgrade, NodeServerSocket } from "./transport";

const UPGRADE_ID_HEADER = "x-yaos-node-upgrade-id";

interface SocketEvents {
	message(socket: VaultSocketPort, message: string | ArrayBuffer): void;
	close(socket: VaultSocketPort): void;
	error(socket: VaultSocketPort): void;
}

class PendingVaultSocket implements VaultSocketPort {
	private attachment: unknown;
	private accepted = false;
	private connected: NodeServerSocket | null = null;
	private readonly queued: Array<string | Uint8Array> = [];
	private closeFrame: { code?: number; reason?: string } | null = null;

	constructor(private readonly events: SocketEvents) {}

	serializeAttachment(value: unknown): void {
		this.attachment = value;
	}

	deserializeAttachment(): unknown {
		return this.attachment;
	}

	send(message: string | ArrayBuffer | ArrayBufferView): void {
		if (this.closeFrame) throw new Error("WebSocket is closing");
		if (this.connected) {
			this.connected.send(message);
			return;
		}
		if (typeof message === "string") this.queued.push(message);
		else if (message instanceof ArrayBuffer) this.queued.push(new Uint8Array(message).slice());
		else this.queued.push(new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice());
	}

	close(code?: number, reason?: string): void {
		if (this.closeFrame) return;
		this.closeFrame = { code, reason };
		this.connected?.close(code, reason);
	}

	accept(): void {
		this.accepted = true;
	}

	attach(socket: NodeServerSocket): void {
		if (this.connected) throw new Error("pending WebSocket was attached twice");
		if (!this.accepted) throw new Error("pending WebSocket was not accepted by its actor");
		this.connected = socket;
		socket.addEventListener("message", (event) => {
			if (event.data !== undefined) this.events.message(this, event.data);
		});
		socket.addEventListener("close", () => this.events.close(this));
		socket.addEventListener("error", () => this.events.error(this));
		for (const message of this.queued) socket.send(message);
		this.queued.length = 0;
		if (this.closeFrame) socket.close(this.closeFrame.code, this.closeFrame.reason);
	}
}

interface PendingClient {
	readonly socket: PendingVaultSocket;
}
export class NodeSocketHub implements SocketUpgradePort {
	private readonly upgrades = new Map<string, PendingVaultSocket>();

	register(socket: PendingVaultSocket): Response {
		const id = randomUUID();
		this.upgrades.set(id, socket);
		return new Response(null, { status: 200, headers: { [UPGRADE_ID_HEADER]: id } });
	}

	reject(frame: string, closeCode: number, reason: string): Response {
		const socket = new PendingVaultSocket({
			message: () => {},
			close: () => {},
			error: () => {},
		});
		socket.accept();
		socket.send(frame);
		socket.close(closeCode, reason);
		return this.register(socket);
	}

	takeUpgrade(response: Response): AcceptedWebSocketUpgrade | null {
		const id = response.headers.get(UPGRADE_ID_HEADER);
		if (!id) return null;
		const pending = this.upgrades.get(id);
		if (!pending) throw new Error("unknown or already consumed Node WebSocket upgrade");
		this.upgrades.delete(id);
		return {
			accepted: true,
			connected: (socket) => pending.attach(socket),
		};
	}

	clear(): void {
		for (const socket of this.upgrades.values()) socket.close(1012, "server shutdown");
		this.upgrades.clear();
	}
}

export class NodeSocketRegistry implements VaultSocketRegistryPort {
	private readonly active = new Set<PendingVaultSocket>();

	constructor(
		private readonly hub: NodeSocketHub,
		private readonly events: SocketEvents,
	) {}

	sockets(): readonly VaultSocketPort[] {
		return [...this.active];
	}

	createPair(): { client: unknown; server: VaultSocketPort } {
		const socket = new PendingVaultSocket({
			message: (active, message) => this.events.message(active, message),
			close: (active) => {
				this.active.delete(active as PendingVaultSocket);
				this.events.close(active);
			},
			error: (active) => this.events.error(active),
		});
		return { client: { socket } satisfies PendingClient, server: socket };
	}

	accept(socket: VaultSocketPort): void {
		const pending = socket as PendingVaultSocket;
		pending.accept();
		this.active.add(pending);
	}

	upgradeResponse(client: unknown): Response {
		if (!client || typeof client !== "object" || !("socket" in client) || !(client.socket instanceof PendingVaultSocket)) {
			throw new Error("invalid Node WebSocket pair client");
		}
		return this.hub.register(client.socket);
	}

	closeAll(): void {
		for (const socket of this.active) socket.close(1012, "server shutdown");
		this.active.clear();
	}
}
