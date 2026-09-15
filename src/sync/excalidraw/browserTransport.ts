import { parsePresenceServerFrame, type PresenceClientUpdate, type PresenceServerFrame } from "@shared/presenceProtocol";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../schema";
import { randomId } from "../../utils/randomId";
import type {
	ExcalidrawBatchReceipt,
	ExcalidrawBatchRequest,
	ExcalidrawReplayPage,
	ExcalidrawRoomEvent,
	ExcalidrawSnapshot,
} from "./types";
import type {
	ExcalidrawRecoveryResult,
	ExcalidrawRoomSubscription,
	ExcalidrawSocketTicketPort,
	ExcalidrawTransportPort,
} from "./transport";
import type { AudienceSafePresenceIdentity } from "./browserHost";

export type PublicSharePermission = "read-only" | "read-write";

export interface PublicShareSession {
	publicDrawingId: string;
	drawingEpoch: number;
	permission: PublicSharePermission;
	expiresAt: number;
	grantRevision: number;
}

export interface PublicShareLinkSecret {
	routeEnvelope: string;
	linkSecret: string;
}

export type PublicShareAuthorityEvent =
	| { state: "active"; permission: PublicSharePermission; grantRevision: number; expiresAt: number }
	| { state: "revoked" | "expired"; permission: "read-only"; grantRevision: number; expiresAt: number };

export interface AudienceSafePresenceEntry {
	sessionId: string;
	clientSequence: number;
	expiresInMs: number;
	identity: AudienceSafePresenceIdentity;
	state: Record<string, unknown>;
}

export type AudienceSafePresenceFrame =
	| { type: "presence.snapshot"; presences: AudienceSafePresenceEntry[] }
	| { type: "presence.state"; presence: AudienceSafePresenceEntry }
	| { type: "presence.leave"; sessionId: string; reason: string };

export interface BrowserFetchResponse {
	ok: boolean;
	status: number;
	headers?: Headers;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export type BrowserFetch = (input: string, init?: RequestInit) => Promise<BrowserFetchResponse>;
export type BrowserWebSocket = WebSocket;
export type BrowserWebSocketConstructor = new (url: string | URL, protocols?: string | string[]) => BrowserWebSocket;

export class BrowserExcalidrawTransportError extends Error {
	constructor(readonly code: string, readonly status: number, readonly retryable: boolean) {
		super(`Excalidraw transport failed: ${code} (${status})`);
		this.name = "BrowserExcalidrawTransportError";
	}
}

const defaultBrowserFetch: BrowserFetch = async (input, init) => await window.fetch(input, init);

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

async function responseBody(response: BrowserFetchResponse): Promise<Record<string, unknown>> {
	let value: unknown = null;
	try { value = await response.json(); } catch { /* malformed below */ }
	return object(value) ?? {};
}

async function requireJson(response: BrowserFetchResponse): Promise<Record<string, unknown>> {
	const body = await responseBody(response);
	if (response.ok) return body;
	const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
	const terminal = ["share_read_only", "share_revoked", "share_expired", "share_revision_stale",
		"authority_superseded"].includes(code);
	throw new BrowserExcalidrawTransportError(code, response.status, !terminal && response.status >= 500);
}

function parseSnapshot(value: Record<string, unknown>, drawingId: string): ExcalidrawSnapshot {
	if (!positiveInteger(value.drawingEpoch) || !Number.isSafeInteger(value.sequence)
		|| !Number.isSafeInteger(value.compactedThrough) || !Array.isArray(value.elements) || !object(value.metadata)) {
		throw new Error("Excalidraw snapshot response malformed");
	}
	return { ...value, protocolVersion: 1, drawingId } as unknown as ExcalidrawSnapshot;
}

function parseReplay(value: Record<string, unknown>, drawingId: string): ExcalidrawReplayPage {
	if (!positiveInteger(value.drawingEpoch) || !Number.isSafeInteger(value.after) || !Number.isSafeInteger(value.through)
		|| !Number.isSafeInteger(value.compactedThrough) || typeof value.snapshotRequired !== "boolean"
		|| !Array.isArray(value.events)) throw new Error("Excalidraw replay response malformed");
	return { ...value, protocolVersion: 1, drawingId } as unknown as ExcalidrawReplayPage;
}

function parseReceipt(value: Record<string, unknown>, drawingId: string): ExcalidrawBatchReceipt {
	if (typeof value.operationId !== "string" || typeof value.requestDigest !== "string"
		|| !positiveInteger(value.drawingEpoch) || !Number.isSafeInteger(value.sequence)
		|| !Array.isArray(value.acceptedElementIds) || !Array.isArray(value.staleElementIds)
		|| typeof value.metadataAccepted !== "boolean" || typeof value.replayed !== "boolean") {
		throw new Error("Excalidraw receipt response malformed");
	}
	return { ...value, protocolVersion: 1, drawingId } as unknown as ExcalidrawBatchReceipt;
}

function safeIdentity(value: unknown): AudienceSafePresenceIdentity | null {
	const identity = object(value);
	if (!identity || typeof identity.participantId !== "string"
		|| (identity.kind !== "member" && identity.kind !== "guest")
		|| typeof identity.displayName !== "string" || typeof identity.color !== "string"
		|| typeof identity.colorLight !== "string") return null;
	return identity as unknown as AudienceSafePresenceIdentity;
}

export function parseAudienceSafePresenceFrame(value: unknown): AudienceSafePresenceFrame | null {
	const frame = object(value);
	if (!frame) return null;
	const entry = (candidate: unknown): AudienceSafePresenceEntry | null => {
		const presence = object(candidate);
		const identity = safeIdentity(presence?.identity);
		if (!presence || typeof presence.sessionId !== "string" || !positiveInteger(presence.clientSequence)
			|| !Number.isSafeInteger(presence.expiresInMs) || !identity || !object(presence.state)) return null;
		return { sessionId: presence.sessionId, clientSequence: presence.clientSequence,
			expiresInMs: presence.expiresInMs as number, identity, state: presence.state as Record<string, unknown> };
	};
	if (frame.type === "presence.state") {
		const presence = entry(frame.presence);
		return presence ? { type: "presence.state", presence } : null;
	}
	if (frame.type === "presence.snapshot" && Array.isArray(frame.presences)) {
		const presences = frame.presences.map(entry);
		return presences.every((presence) => presence !== null)
			? { type: "presence.snapshot", presences: presences.filter((presence): presence is AudienceSafePresenceEntry => presence !== null) }
			: null;
	}
	if (frame.type === "presence.leave" && typeof frame.sessionId === "string" && typeof frame.reason === "string") {
		return { type: "presence.leave", sessionId: frame.sessionId, reason: frame.reason };
	}
	return null;
}

abstract class BrowserTransportBase implements ExcalidrawTransportPort {
	constructor(
		protected readonly fetcher: BrowserFetch,
		private readonly WebSocketImpl: BrowserWebSocketConstructor,
	) {}

	protected abstract route(drawingId: string, resource: "snapshot" | "replay" | "batch"): string;
	protected abstract socket(drawingId: string, drawingEpoch: number): Promise<{ url: string; protocols?: string | string[] }>;
	protected abstract requestInit(method: "GET" | "POST", body?: unknown): RequestInit;
	protected assertWritable(): void {}
	protected authorityFrame(_frame: Record<string, unknown>): boolean { return false; }
	protected safePresence(_frame: AudienceSafePresenceFrame): void {}

	async recover(drawingId: string, drawingEpoch: number | null, afterSequence: number): Promise<ExcalidrawRecoveryResult> {
		const replayResponse = await this.fetcher(`${this.route(drawingId, "replay")}?after=${encodeURIComponent(String(afterSequence))}`,
			this.requestInit("GET"));
		const page = parseReplay(await requireJson(replayResponse), drawingId);
		if (page.snapshotRequired || (drawingEpoch !== null && page.drawingEpoch !== drawingEpoch)) {
			const snapshotResponse = await this.fetcher(this.route(drawingId, "snapshot"), this.requestInit("GET"));
			return { kind: "snapshot", snapshot: parseSnapshot(await requireJson(snapshotResponse), drawingId) };
		}
		if (page.events.length === 0 && page.through === afterSequence) {
			return { kind: "current", drawingEpoch: page.drawingEpoch, sequence: page.through };
		}
		return { kind: "replay", page };
	}

	async submit(drawingId: string, request: ExcalidrawBatchRequest): Promise<ExcalidrawBatchReceipt> {
		this.assertWritable();
		const response = await this.fetcher(this.route(drawingId, "batch"), this.requestInit("POST", request));
		return parseReceipt(await requireJson(response), drawingId);
	}

	async subscribe(drawingId: string, drawingEpoch: number, afterSequence: number, callbacks: {
		onEvent(event: ExcalidrawRoomEvent): void;
		onGap(): void;
		onClose(): void;
		onPresence?(frame: PresenceServerFrame): void;
	}): Promise<ExcalidrawRoomSubscription> {
		const target = await this.socket(drawingId, drawingEpoch);
		const socket = new this.WebSocketImpl(target.url, target.protocols);
		let cursor = afterSequence;
		let closed = false;
		let pendingPresence: string | null = null;
		const publishPresence = (update: PresenceClientUpdate): void => {
			if (closed) return;
			const serialized = JSON.stringify(update);
			if (socket.readyState !== 1) pendingPresence = serialized;
			else socket.send(serialized);
		};
		socket.onopen = () => {
			if (pendingPresence !== null) { socket.send(pendingPresence); pendingPresence = null; }
		};
		socket.onmessage = (message) => {
			try {
				const value = object(JSON.parse(typeof message.data === "string" ? message.data : ""));
				if (!value) throw new Error("invalid frame");
				if (value.type === "hello" || value.type === "pong") return;
				if (this.authorityFrame(value)) return;
				const safePresence = parseAudienceSafePresenceFrame(value);
				if (safePresence) { this.safePresence(safePresence); return; }
				const presence = parsePresenceServerFrame(value);
				if (presence) { callbacks.onPresence?.(presence); return; }
				const eventValue = value.type === "scene" ? object(value.event) : value;
				if (!eventValue) throw new Error("invalid scene frame");
				if (!Number.isSafeInteger(eventValue.sequence) || !positiveInteger(eventValue.drawingEpoch)
					|| !Array.isArray(eventValue.elements) || eventValue.drawingEpoch !== drawingEpoch
					|| eventValue.sequence !== cursor + 1) { callbacks.onGap(); return; }
				cursor = eventValue.sequence;
				callbacks.onEvent({ ...eventValue, protocolVersion: 1 } as unknown as ExcalidrawRoomEvent);
			} catch { callbacks.onGap(); }
		};
		socket.onerror = () => { try { socket.close(); } catch { /* already closed */ } };
		socket.onclose = () => { if (!closed) callbacks.onClose(); };
		return { publishPresence, close: () => { if (closed) return; closed = true; pendingPresence = null; socket.close(); } };
	}
}

export class BrowserMemberSocketTickets implements ExcalidrawSocketTicketPort {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly fetcher: BrowserFetch = defaultBrowserFetch) {
		this.base = host.replace(/\/$/, "");
	}
	async get(drawingId: string, drawingEpoch: number): Promise<{ url: string }> {
		const response = await this.fetcher(`${this.base}/vault/${encodeURIComponent(this.vaultId)}/auth/ticket`, {
			method: "POST", credentials: "include", headers: { authorization: `Bearer ${this.token}`,
				"content-type": "application/json" },
			body: JSON.stringify({ purpose: "excalidraw", documentId: drawingId, drawingEpoch }),
		});
		const body = await requireJson(response);
		if (typeof body.ticket !== "string") throw new Error("Excalidraw member ticket malformed");
		const socketBase = this.base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
		const query = new URLSearchParams({ ticket: body.ticket, sessionId: randomId(32),
			schemaVersion: String(SCHEMA_VERSION), protocolVersion: String(PROTOCOL_VERSION) });
		return { url: `${socketBase}/vault/${encodeURIComponent(this.vaultId)}/ws/excalidraw/${encodeURIComponent(drawingId)}?${query}` };
	}
}

export class BrowserMemberExcalidrawTransport extends BrowserTransportBase {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly tickets: ExcalidrawSocketTicketPort,
		fetcher: BrowserFetch = defaultBrowserFetch,
		WebSocketImpl: BrowserWebSocketConstructor = WebSocket) {
		super(fetcher, WebSocketImpl);
		this.base = host.replace(/\/$/, "");
	}
	protected route(drawingId: string, resource: "snapshot" | "replay" | "batch"): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/excalidraw/${encodeURIComponent(drawingId)}/${resource}`;
	}
	protected socket(drawingId: string, drawingEpoch: number): Promise<{ url: string; protocols?: string | string[] }> {
		return this.tickets.get(drawingId, drawingEpoch);
	}
	protected requestInit(method: "GET" | "POST", body?: unknown): RequestInit {
		return { method, credentials: "include", headers: { authorization: `Bearer ${this.token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }) };
	}
}

export class PublicShareSessionClient {
	private readonly base: string;
	constructor(host: string, private readonly fetcher: BrowserFetch = defaultBrowserFetch) {
		this.base = host.replace(/\/$/, "");
	}
	async exchange(secret: PublicShareLinkSecret, displayName?: string): Promise<PublicShareSession> {
		if (!secret.routeEnvelope || secret.routeEnvelope.length > 4096
			|| !secret.linkSecret || secret.linkSecret.length > 4096) throw new Error("invalid public share secret");
		const response = await this.fetcher(`${this.base}/api/excalidraw/shares/session`, {
			method: "POST", credentials: "include", referrerPolicy: "no-referrer",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ ...secret, displayName }),
		});
		const value = await requireJson(response);
		if (typeof value.publicDrawingId !== "string" || !positiveInteger(value.drawingEpoch)
			|| (value.permission !== "read-only" && value.permission !== "read-write")
			|| !positiveInteger(value.grantRevision) || !Number.isSafeInteger(value.expiresAt)) {
			throw new Error("public share session response malformed");
		}
		return value as unknown as PublicShareSession;
	}

	static consumeFragment(location: Pick<Location, "hash">, history: Pick<History, "replaceState">,
		pathname: string, search = ""): PublicShareLinkSecret {
		const rawFragment = location.hash.startsWith("#") ? location.hash.slice(1) : "";
		history.replaceState(null, "", `${pathname}${search}`);
		const fragment = decodeURIComponent(rawFragment);
		return decodePublicShareFragment(fragment);
	}
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error("invalid share fragment encoding");
	const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodePublicShareFragment(secret: PublicShareLinkSecret): string {
	if (!secret.routeEnvelope || !secret.linkSecret) throw new Error("share link secret is incomplete");
	return `yaos-share-v1.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(secret)))}`;
}

export function decodePublicShareFragment(fragment: string): PublicShareLinkSecret {
	const prefix = "yaos-share-v1.";
	if (!fragment.startsWith(prefix) || fragment.length > 4_096) throw new Error("share link is missing its secret fragment");
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(base64UrlDecode(fragment.slice(prefix.length)))); }
	catch { throw new Error("share link secret fragment is malformed"); }
	const secret = object(value);
	if (!secret || typeof secret.routeEnvelope !== "string" || !secret.routeEnvelope
		|| typeof secret.linkSecret !== "string" || !secret.linkSecret
		|| secret.routeEnvelope.length + secret.linkSecret.length > 3_072 || secret.linkSecret.length > 512) {
		throw new Error("share link secret fragment is malformed");
	}
	return { routeEnvelope: secret.routeEnvelope, linkSecret: secret.linkSecret };
}

export class PublicShareExcalidrawTransport extends BrowserTransportBase {
	private readonly base: string;
	private permission: PublicSharePermission;
	constructor(host: string, private readonly session: PublicShareSession, options: {
		fetcher?: BrowserFetch;
		WebSocketImpl?: BrowserWebSocketConstructor;
		onAuthority?(event: PublicShareAuthorityEvent): void;
		onPresence?(frame: AudienceSafePresenceFrame): void;
	} = {}) {
		super(options.fetcher ?? defaultBrowserFetch, options.WebSocketImpl ?? WebSocket);
		this.base = `${host.replace(/\/$/, "")}/api/excalidraw/shares/session`;
		this.permission = session.permission;
		this.onAuthority = options.onAuthority ? (event) => options.onAuthority?.(event) : undefined;
		this.onPresence = options.onPresence ? (frame) => options.onPresence?.(frame) : undefined;
	}
	private onAuthority?: (event: PublicShareAuthorityEvent) => void;
	private onPresence?: (frame: AudienceSafePresenceFrame) => void;

	setPermission(permission: PublicSharePermission): void { this.permission = permission; }
	setAuthorityListener(listener: ((event: PublicShareAuthorityEvent) => void) | undefined): void {
		this.onAuthority = listener;
	}
	setPresenceListener(listener: ((frame: AudienceSafePresenceFrame) => void) | undefined): void {
		this.onPresence = listener;
	}
	override async submit(drawingId: string, request: ExcalidrawBatchRequest): Promise<ExcalidrawBatchReceipt> {
		try { return await super.submit(drawingId, request); }
		catch (error) {
			if (error instanceof BrowserExcalidrawTransportError && !error.retryable) {
				const state = error.code === "share_expired" ? "expired"
					: error.code === "share_read_only" ? "active" : "revoked";
				this.permission = "read-only";
				this.onAuthority?.(state === "active"
					? { state, permission: "read-only", grantRevision: this.session.grantRevision,
						expiresAt: this.session.expiresAt }
					: { state, permission: "read-only", grantRevision: this.session.grantRevision,
						expiresAt: this.session.expiresAt });
			}
			throw error;
		}
	}
	protected assertWritable(): void {
		if (this.permission !== "read-write") throw new BrowserExcalidrawTransportError("share_read_only", 403, false);
	}
	protected route(drawingId: string, resource: "snapshot" | "replay" | "batch"): string {
		if (drawingId !== this.session.publicDrawingId) throw new Error("public drawing identity mismatch");
		return `${this.base}/${resource}`;
	}
	protected async socket(drawingId: string, drawingEpoch: number): Promise<{ url: string }> {
		if (drawingId !== this.session.publicDrawingId || drawingEpoch !== this.session.drawingEpoch) {
			throw new Error("public socket scope mismatch");
		}
		return { url: `${this.base.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/ws` };
	}
	protected requestInit(method: "GET" | "POST", body?: unknown): RequestInit {
		return { method, credentials: "include", referrerPolicy: "no-referrer",
			headers: body === undefined ? {} : { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }) };
	}
	protected authorityFrame(frame: Record<string, unknown>): boolean {
		if (frame.type !== "share.authority" || (frame.state !== "active" && frame.state !== "revoked" && frame.state !== "expired")
			|| !positiveInteger(frame.grantRevision) || !Number.isSafeInteger(frame.expiresAt)) return false;
		const permission = frame.permission === "read-write" && frame.state === "active" ? "read-write" : "read-only";
		const expiresAt = frame.expiresAt as number;
		this.permission = permission;
		const event: PublicShareAuthorityEvent = frame.state === "active"
			? { state: "active", permission, grantRevision: frame.grantRevision, expiresAt }
			: { state: frame.state, permission: "read-only", grantRevision: frame.grantRevision,
				expiresAt };
		this.onAuthority?.(event);
		return true;
	}
	protected safePresence(frame: AudienceSafePresenceFrame): void { this.onPresence?.(frame); }
}
