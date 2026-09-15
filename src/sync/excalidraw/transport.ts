import type { ExcalidrawBatchReceipt, ExcalidrawBatchRequest, ExcalidrawReplayPage,
	ExcalidrawRoomEvent, ExcalidrawSnapshot, ExcalidrawInitializeRequest,
	ExcalidrawPromotionPrepareRequest, ExcalidrawPromotionPrepareReceipt,
	ExcalidrawPromotionFinalizeRequest, ExcalidrawPromotionFinalizeReceipt,
	ExcalidrawLifecycleRequest, ExcalidrawLifecycleReceipt } from "./types";
import type { HttpRequester } from "../../utils/http";
import { obsidianRequest } from "../../utils/http";
import { randomId } from "../../utils/randomId";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../schema";
import { MAX_PRESENCE_SOCKET_BUFFER_BYTES, parsePresenceServerFrame,
	type PresenceClientUpdate, type PresenceServerFrame } from "@shared/presenceProtocol";

export type ExcalidrawRecoveryResult =
	| { kind: "current"; drawingEpoch: number; sequence: number }
	| { kind: "replay"; page: ExcalidrawReplayPage }
	| { kind: "snapshot"; snapshot: ExcalidrawSnapshot };

export interface ExcalidrawRoomSubscription {
	publishPresence?(update: PresenceClientUpdate): void;
	close(): void;
}

export interface ExcalidrawTransportPort {
	recover(drawingId: string, drawingEpoch: number | null, afterSequence: number): Promise<ExcalidrawRecoveryResult>;
	submit(drawingId: string, request: ExcalidrawBatchRequest): Promise<ExcalidrawBatchReceipt>;
	subscribe(drawingId: string, drawingEpoch: number, afterSequence: number, callbacks: {
		onEvent(event: ExcalidrawRoomEvent): void;
		onGap(): void;
		onClose(): void;
		onPresence?(frame: PresenceServerFrame): void;
	}): Promise<ExcalidrawRoomSubscription>;
}

export interface ExcalidrawPromotionTransportPort {
	preparePromotion(request: ExcalidrawPromotionPrepareRequest): Promise<ExcalidrawPromotionPrepareReceipt>;
	initializeDrawing(drawingId: string, request: ExcalidrawInitializeRequest): Promise<ExcalidrawBatchReceipt>;
	finalizePromotion(drawingId: string, request: ExcalidrawPromotionFinalizeRequest): Promise<ExcalidrawPromotionFinalizeReceipt>;
}

export interface ExcalidrawLifecycleTransportPort {
	lifecycle(request: ExcalidrawLifecycleRequest): Promise<ExcalidrawLifecycleReceipt>;
}

export interface ExcalidrawSocketTicketPort {
	get(drawingId: string, drawingEpoch: number): Promise<{ url: string; protocols?: string | string[] }>;
}

export class ExcalidrawMemberSocketTickets implements ExcalidrawSocketTicketPort {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly request: HttpRequester = obsidianRequest) { this.base = host.replace(/\/$/, ""); }
	async get(drawingId: string, drawingEpoch: number): Promise<{ url: string }> {
		const response = await this.request({ url: `${this.base}/vault/${encodeURIComponent(this.vaultId)}/auth/ticket`,
			method: "POST", contentType: "application/json", headers: { Authorization: `Bearer ${this.token}` },
			body: JSON.stringify({ purpose: "excalidraw", documentId: drawingId, drawingEpoch }) });
		if (response.status !== 200) throw new Error(`Excalidraw socket ticket failed (${response.status})`);
		const body = object(response.json);
		if (!body || typeof body.ticket !== "string") throw new Error("Excalidraw socket ticket malformed");
		const socketBase = this.base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
		const query = new URLSearchParams({ ticket: body.ticket, sessionId: randomId(32),
			schemaVersion: String(SCHEMA_VERSION), protocolVersion: String(PROTOCOL_VERSION) });
		return { url: `${socketBase}/vault/${encodeURIComponent(this.vaultId)}/ws/excalidraw/${encodeURIComponent(drawingId)}?${query}` };
	}
}

type WebSocketConstructor = new (url: string | URL, protocols?: string | string[]) => WebSocket;

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Authenticated member transport for the RFC-13 route surface. */
export class ExcalidrawHttpTransport implements ExcalidrawTransportPort, ExcalidrawPromotionTransportPort,
	ExcalidrawLifecycleTransportPort {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly tickets: ExcalidrawSocketTicketPort, private readonly request: HttpRequester = obsidianRequest,
		private readonly WebSocketImpl: WebSocketConstructor = WebSocket) {
		this.base = host.replace(/\/$/, "");
	}

	async recover(drawingId: string, drawingEpoch: number | null, afterSequence: number): Promise<ExcalidrawRecoveryResult> {
		const response = await this.request({ url: `${this.drawingRoute(drawingId)}/replay?after=${encodeURIComponent(String(afterSequence))}`,
			method: "GET", headers: this.headers() });
		if (response.status !== 200) throw new Error(`Excalidraw replay failed (${response.status})`);
		const body = object(response.json);
		if (!body || !Array.isArray(body.events) || !Number.isSafeInteger(body.drawingEpoch)
			|| !Number.isSafeInteger(body.through)) throw new Error("Excalidraw replay response malformed");
		const page = body as unknown as ExcalidrawReplayPage;
		if (page.snapshotRequired || (drawingEpoch !== null && page.drawingEpoch !== drawingEpoch)) {
			const snapshotResponse = await this.request({ url: `${this.drawingRoute(drawingId)}/snapshot`,
				method: "GET", headers: this.headers() });
			if (snapshotResponse.status !== 200) throw new Error(`Excalidraw snapshot failed (${snapshotResponse.status})`);
			const snapshotValue = object(snapshotResponse.json);
			if (!snapshotValue || !Array.isArray(snapshotValue.elements)) throw new Error("Excalidraw snapshot response malformed");
			return { kind: "snapshot", snapshot: snapshotValue as unknown as ExcalidrawSnapshot };
		}
		if (page.events.length === 0 && page.through === afterSequence) {
			return { kind: "current", drawingEpoch: page.drawingEpoch, sequence: page.through };
		}
		return { kind: "replay", page };
	}

	async submit(drawingId: string, request: ExcalidrawBatchRequest): Promise<ExcalidrawBatchReceipt> {
		const response = await this.request({ url: `${this.drawingRoute(drawingId)}/batch`, method: "POST",
			contentType: "application/json", body: JSON.stringify(request), headers: this.headers() });
		if (response.status !== 200) throw new Error(`Excalidraw operation failed (${response.status})`);
		const receipt = object(response.json);
		if (!receipt || receipt.protocolVersion !== 1 || typeof receipt.operationId !== "string"
			|| typeof receipt.requestDigest !== "string" || typeof receipt.drawingId !== "string"
			|| !Number.isSafeInteger(receipt.drawingEpoch) || !Number.isSafeInteger(receipt.sequence)
			|| !Array.isArray(receipt.acceptedElementIds) || !Array.isArray(receipt.staleElementIds)) {
			throw new Error("Excalidraw receipt malformed");
		}
		return receipt as unknown as ExcalidrawBatchReceipt;
	}

	async preparePromotion(request: ExcalidrawPromotionPrepareRequest): Promise<ExcalidrawPromotionPrepareReceipt> {
		return this.postPromotion<ExcalidrawPromotionPrepareReceipt>(request.drawingId, "authority/prepare", request);
	}

	async initializeDrawing(drawingId: string, request: ExcalidrawInitializeRequest): Promise<ExcalidrawBatchReceipt> {
		return this.postPromotion<ExcalidrawBatchReceipt>(drawingId, "initialize", request);
	}

	async finalizePromotion(drawingId: string,
		request: ExcalidrawPromotionFinalizeRequest): Promise<ExcalidrawPromotionFinalizeReceipt> {
		return this.postPromotion<ExcalidrawPromotionFinalizeReceipt>(drawingId, "authority/finalize", request);
	}

	async lifecycle(request: ExcalidrawLifecycleRequest): Promise<ExcalidrawLifecycleReceipt> {
		const response = await this.request({ url: `${this.drawingRoute(request.drawingId)}/authority/lifecycle`, method: "POST",
			contentType: "application/json", body: JSON.stringify(request), headers: this.headers() });
		if (response.status !== 200) throw new Error(`Excalidraw lifecycle failed (${response.status})`);
		const receipt = object(response.json);
		if (!receipt || receipt.protocolVersion !== 1 || receipt.operationId !== request.operationId
			|| receipt.requestDigest !== request.requestDigest || receipt.drawingId !== request.drawingId
			|| receipt.drawingEpoch !== request.drawingEpoch || receipt.kind !== request.kind
			|| typeof receipt.resultPath !== "string" || !Number.isSafeInteger(receipt.vaultSequence)
			|| !Number.isSafeInteger(receipt.rootGeneration)) throw new Error("Excalidraw lifecycle receipt malformed");
		return receipt as unknown as ExcalidrawLifecycleReceipt;
	}

	async subscribe(drawingId: string, drawingEpoch: number, afterSequence: number, callbacks: {
		onEvent(event: ExcalidrawRoomEvent): void; onGap(): void; onClose(): void;
		onPresence?(frame: PresenceServerFrame): void;
	}): Promise<ExcalidrawRoomSubscription> {
		const ticket = await this.tickets.get(drawingId, drawingEpoch);
		const socket = new this.WebSocketImpl(ticket.url, ticket.protocols);
		let closed = false;
		let cursor = afterSequence;
		let lastActivity = Date.now();
		let localSessionId: string | null = null;
		let pendingPresence: string | null = null;
		const publishPresence = (update: PresenceClientUpdate) => {
			if (closed) return;
			const serialized = JSON.stringify(update);
			if (socket.readyState !== 1) { pendingPresence = serialized; return; }
			if (socket.bufferedAmount <= MAX_PRESENCE_SOCKET_BUFFER_BYTES) socket.send(serialized);
		};
		socket.onopen = () => {
			if (pendingPresence === null) return;
			const serialized = pendingPresence;
			pendingPresence = null;
			if (socket.bufferedAmount <= MAX_PRESENCE_SOCKET_BUFFER_BYTES) socket.send(serialized);
		};
		const liveness = window.setInterval(() => {
			if (closed) return;
			if (Date.now() - lastActivity > 45_000) { socket.close(); return; }
			if (socket.readyState === 1) {
				try { socket.send(JSON.stringify({ type: "ping", nonce: randomId(24) })); }
				catch { socket.close(); }
			}
		}, 15_000);
		socket.onmessage = (message) => {
			try {
				lastActivity = Date.now();
				const value = object(JSON.parse(typeof message.data === "string" ? message.data : ""));
				if (!value) throw new Error("invalid frame");
				if (value.type === "hello") {
					if (value.drawingEpoch !== drawingEpoch || !Number.isSafeInteger(value.sequence)
						|| (value.sequence as number) > cursor) callbacks.onGap();
					if (typeof value.sessionId === "string") localSessionId = value.sessionId;
					return;
				}
				if (value.type === "pong") return;
				const presence = parsePresenceServerFrame(value);
				if (presence) {
					if (presence.type === "presence.state" && presence.presence.sessionId === localSessionId) return;
					if (presence.type === "presence.snapshot" && localSessionId) callbacks.onPresence?.({ ...presence,
						presences: presence.presences.filter((entry) => entry.sessionId !== localSessionId) });
					else callbacks.onPresence?.(presence);
					return;
				}
				if (typeof value.type === "string" && value.type.startsWith("presence.")) {
					socket.close(1002, "invalid_presence_frame"); return;
				}
				const eventValue = value.type === "scene" && object(value.event) ? value.event : value;
				const event = eventValue as ExcalidrawRoomEvent;
				if (event.protocolVersion !== 1 || event.drawingEpoch !== drawingEpoch || !Number.isSafeInteger(event.sequence)
					|| !Array.isArray(event.elements)) throw new Error("invalid commit");
				if (event.sequence !== cursor + 1) { callbacks.onGap(); return; }
				cursor = event.sequence;
				callbacks.onEvent(event);
			} catch { callbacks.onGap(); }
		};
		socket.onclose = () => { window.clearInterval(liveness); if (!closed) callbacks.onClose(); };
		socket.onerror = () => { try { socket.close(); } catch { /* closing */ } };
		return { publishPresence, close: () => { if (closed) return; closed = true; pendingPresence = null;
			window.clearInterval(liveness); socket.close(); } };
	}

	private drawingRoute(drawingId: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/excalidraw/${encodeURIComponent(drawingId)}`;
	}
	private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` }; }
	private async postPromotion<T>(drawingId: string, resource: string, body: unknown): Promise<T> {
		const response = await this.request({ url: `${this.drawingRoute(drawingId)}/${resource}`, method: "POST",
			contentType: "application/json", body: JSON.stringify(body), headers: this.headers() });
		if (response.status !== 200 && response.status !== 201) {
			throw new Error(`Excalidraw promotion ${resource} failed (${response.status})`);
		}
		if (!object(response.json)) throw new Error(`Excalidraw promotion ${resource} response malformed`);
		return response.json as T;
	}
}
