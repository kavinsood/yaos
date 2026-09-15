export const PRESENCE_PROTOCOL_VERSION = 2 as const;
export const EXCALIDRAW_PRESENCE_SURFACE_VERSION = 1 as const;

export const PRESENCE_TTL_MS = 15_000;
export const PRESENCE_MIN_BROADCAST_INTERVAL_MS = 50;
export const MAX_PRESENCE_FRAME_BYTES = 16 * 1024;
export const MAX_PRESENCE_INPUT_FRAMES_PER_SECOND = 60;
export const MAX_PRESENCE_SELECTED_ELEMENT_IDS = 256;
export const MAX_PRESENCE_SESSIONS = 256;
export const MAX_PRESENCE_SOCKET_BUFFER_BYTES = 64 * 1024;
export const MAX_SCENE_SOCKET_BUFFER_BYTES = 1024 * 1024;

const MAX_SCENE_COORDINATE = 10_000_000;
const MAX_VIEWPORT_DIMENSION = 100_000;
const MAX_ZOOM = 128;
const TOOL = /^[A-Za-z0-9_-]{1,32}$/;
const IDENTITY = /^[A-Za-z0-9_-]{1,160}$/;
const COLOR = /^hsl\((?:[0-9]|[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]), 72%, 52%\)$/;
const COLOR_LIGHT = /^hsla\((?:[0-9]|[1-9][0-9]|[1-2][0-9]{2}|3[0-5][0-9]), 72%, 52%, 0\.2\)$/;

export interface PresenceSurface {
	kind: "excalidraw";
	version: typeof EXCALIDRAW_PRESENCE_SURFACE_VERSION;
}

export interface ExcalidrawPresencePoint {
	x: number;
	y: number;
}

export interface ExcalidrawPresencePointer extends ExcalidrawPresencePoint {
	tool: string;
	button: "up" | "down";
}

export interface ExcalidrawPresenceViewport {
	scrollX: number;
	scrollY: number;
	zoom: number;
	width: number;
	height: number;
}

export interface ExcalidrawPresenceState {
	pointer?: ExcalidrawPresencePointer;
	laser?: ExcalidrawPresencePoint;
	selectedElementIds?: string[];
	activeElementId?: string | null;
	editingElementId?: string | null;
	interaction?: "idle" | "pointing" | "drawing" | "dragging" | "resizing" | "rotating" | "editing" | "panning";
	viewport?: ExcalidrawPresenceViewport;
	followSessionId?: string | null;
	idle?: "active" | "idle" | "away";
}

export interface PresenceIdentity {
	principalId: string;
	deviceId: string;
	displayName: string;
	color: string;
	colorLight: string;
}

export interface PresenceClientUpdate {
	type: "presence.update";
	presenceProtocolVersion: typeof PRESENCE_PROTOCOL_VERSION;
	surface: PresenceSurface;
	clientSequence: number;
	state: ExcalidrawPresenceState | null;
}

export interface PresenceEntry {
	sessionId: string;
	clientSequence: number;
	expiresInMs: number;
	identity: PresenceIdentity;
	state: ExcalidrawPresenceState;
}

export interface AudienceSafePresenceIdentity {
	participantId: string;
	kind: "member" | "guest";
	displayName: string;
	color: string;
	colorLight: string;
}

export interface AudienceSafePresenceEntry extends Omit<PresenceEntry, "identity"> {
	identity: AudienceSafePresenceIdentity;
}

export type ProjectedPresenceEntry = PresenceEntry | AudienceSafePresenceEntry;

export interface PresenceStateFrame {
	type: "presence.state";
	presenceProtocolVersion: typeof PRESENCE_PROTOCOL_VERSION;
	surface: PresenceSurface;
	presence: PresenceEntry;
}

export interface PresenceSnapshotFrame {
	type: "presence.snapshot";
	presenceProtocolVersion: typeof PRESENCE_PROTOCOL_VERSION;
	surface: PresenceSurface;
	presences: PresenceEntry[];
}

export interface AudienceSafePresenceStateFrame extends Omit<PresenceStateFrame, "presence"> {
	presence: AudienceSafePresenceEntry;
}

export interface AudienceSafePresenceSnapshotFrame extends Omit<PresenceSnapshotFrame, "presences"> {
	presences: AudienceSafePresenceEntry[];
}

export interface PresenceLeaveFrame {
	type: "presence.leave";
	presenceProtocolVersion: typeof PRESENCE_PROTOCOL_VERSION;
	surface: PresenceSurface;
	sessionId: string;
	reason: "client" | "closed" | "expired" | "fenced" | "reset";
}

export type PresenceServerFrame = PresenceStateFrame | PresenceSnapshotFrame | PresenceLeaveFrame;

export function parsePresenceClientUpdate(value: unknown): PresenceClientUpdate | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (input.type !== "presence.update" || input.presenceProtocolVersion !== PRESENCE_PROTOCOL_VERSION
		|| !isPresenceSurface(input.surface) || !Number.isSafeInteger(input.clientSequence)
		|| (input.clientSequence as number) < 1) return null;
	if (input.state === null) return {
		type: "presence.update", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, clientSequence: input.clientSequence as number, state: null,
	};
	const state = parseExcalidrawPresenceState(input.state);
	return state ? {
		type: "presence.update", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, clientSequence: input.clientSequence as number, state,
	} : null;
}

export function parsePresenceServerFrame(value: unknown): PresenceServerFrame | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (input.presenceProtocolVersion !== PRESENCE_PROTOCOL_VERSION || !isPresenceSurface(input.surface)) return null;
	if (input.type === "presence.state") {
		const presence = parsePresenceEntry(input.presence);
		return presence ? { type: "presence.state", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
			surface: EXCALIDRAW_PRESENCE_SURFACE, presence } : null;
	}
	if (input.type === "presence.snapshot") {
		if (!Array.isArray(input.presences) || input.presences.length > MAX_PRESENCE_SESSIONS) return null;
		const presences: PresenceEntry[] = [];
		const sessions = new Set<string>();
		for (const value of input.presences) {
			const presence = parsePresenceEntry(value);
			if (!presence || sessions.has(presence.sessionId)) return null;
			sessions.add(presence.sessionId);
			presences.push(presence);
		}
		return { type: "presence.snapshot", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
			surface: EXCALIDRAW_PRESENCE_SURFACE, presences };
	}
	if (input.type === "presence.leave" && typeof input.sessionId === "string" && IDENTITY.test(input.sessionId)
		&& ["client", "closed", "expired", "fenced", "reset"].includes(input.reason as string)) {
		return { type: "presence.leave", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
			surface: EXCALIDRAW_PRESENCE_SURFACE, sessionId: input.sessionId,
			reason: input.reason as PresenceLeaveFrame["reason"] };
	}
	return null;
}

export const EXCALIDRAW_PRESENCE_SURFACE: PresenceSurface = Object.freeze({
	kind: "excalidraw", version: EXCALIDRAW_PRESENCE_SURFACE_VERSION,
});

export function presenceColors(seed: string): { color: string; colorLight: string } {
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index++) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const hue = hash % 360;
	return { color: `hsl(${hue}, 72%, 52%)`, colorLight: `hsla(${hue}, 72%, 52%, 0.2)` };
}

function isPresenceSurface(value: unknown): value is PresenceSurface {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const surface = value as Record<string, unknown>;
	return surface.kind === "excalidraw" && surface.version === EXCALIDRAW_PRESENCE_SURFACE_VERSION;
}

function parsePresenceEntry(value: unknown): PresenceEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const state = parseExcalidrawPresenceState(input.state);
	const identity = parsePresenceIdentity(input.identity);
	if (typeof input.sessionId !== "string" || !IDENTITY.test(input.sessionId)
		|| !Number.isSafeInteger(input.clientSequence) || (input.clientSequence as number) < 1
		|| !Number.isSafeInteger(input.expiresInMs) || (input.expiresInMs as number) < 0
		|| (input.expiresInMs as number) > PRESENCE_TTL_MS || !state || !identity) return null;
	return { sessionId: input.sessionId, clientSequence: input.clientSequence as number,
		expiresInMs: input.expiresInMs as number, identity, state };
}

function parsePresenceIdentity(value: unknown): PresenceIdentity | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (typeof input.principalId !== "string" || !IDENTITY.test(input.principalId)
		|| typeof input.deviceId !== "string" || !IDENTITY.test(input.deviceId)
		|| typeof input.displayName !== "string" || !validDisplayName(input.displayName)
		|| typeof input.color !== "string" || !COLOR.test(input.color)
		|| typeof input.colorLight !== "string" || !COLOR_LIGHT.test(input.colorLight)) return null;
	return { principalId: input.principalId, deviceId: input.deviceId, displayName: input.displayName,
		color: input.color, colorLight: input.colorLight };
}

function validDisplayName(value: string): boolean {
	if (value.length < 1 || value.length > 128) return false;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

function parseExcalidrawPresenceState(value: unknown): ExcalidrawPresenceState | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const pointer = input.pointer === undefined ? undefined : parsePointer(input.pointer);
	const laser = input.laser === undefined ? undefined : parsePoint(input.laser);
	const viewport = input.viewport === undefined ? undefined : parseViewport(input.viewport);
	if ((input.pointer !== undefined && !pointer) || (input.laser !== undefined && !laser)
		|| (input.viewport !== undefined && !viewport)) return null;
	const selectedElementIds = input.selectedElementIds === undefined ? undefined : parseSelectedIds(input.selectedElementIds);
	if (input.selectedElementIds !== undefined && !selectedElementIds) return null;
	const activeElementId = parseNullableIdentity(input.activeElementId);
	const editingElementId = parseNullableIdentity(input.editingElementId);
	const followSessionId = parseNullableIdentity(input.followSessionId);
	if (activeElementId === false || editingElementId === false || followSessionId === false) return null;
	if (input.interaction !== undefined && !["idle", "pointing", "drawing", "dragging", "resizing", "rotating", "editing", "panning"].includes(input.interaction as string)) return null;
	if (input.idle !== undefined && !["active", "idle", "away"].includes(input.idle as string)) return null;
	return {
		...(pointer ? { pointer } : {}),
		...(laser ? { laser } : {}),
		...(selectedElementIds ? { selectedElementIds } : {}),
		...(activeElementId !== undefined ? { activeElementId } : {}),
		...(editingElementId !== undefined ? { editingElementId } : {}),
		...(input.interaction !== undefined ? { interaction: input.interaction as ExcalidrawPresenceState["interaction"] } : {}),
		...(viewport ? { viewport } : {}),
		...(followSessionId !== undefined ? { followSessionId } : {}),
		...(input.idle !== undefined ? { idle: input.idle as ExcalidrawPresenceState["idle"] } : {}),
	};
}

function parsePointer(value: unknown): ExcalidrawPresencePointer | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const point = parsePoint(input);
	if (!point || typeof input.tool !== "string" || !TOOL.test(input.tool)
		|| (input.button !== "up" && input.button !== "down")) return null;
	return { ...point, tool: input.tool, button: input.button };
}

function parsePoint(value: unknown): ExcalidrawPresencePoint | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	return boundedNumber(input.x, MAX_SCENE_COORDINATE) && boundedNumber(input.y, MAX_SCENE_COORDINATE)
		? { x: input.x as number, y: input.y as number } : null;
}

function parseViewport(value: unknown): ExcalidrawPresenceViewport | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (!boundedNumber(input.scrollX, MAX_SCENE_COORDINATE) || !boundedNumber(input.scrollY, MAX_SCENE_COORDINATE)
		|| !boundedNumber(input.zoom, MAX_ZOOM, 0.01) || !boundedNumber(input.width, MAX_VIEWPORT_DIMENSION, 0)
		|| !boundedNumber(input.height, MAX_VIEWPORT_DIMENSION, 0)) return null;
	return { scrollX: input.scrollX as number, scrollY: input.scrollY as number, zoom: input.zoom as number,
		width: input.width as number, height: input.height as number };
}

function parseSelectedIds(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MAX_PRESENCE_SELECTED_ELEMENT_IDS) return null;
	const ids = value as unknown[];
	if (ids.some((id) => typeof id !== "string" || !IDENTITY.test(id))) return null;
	const unique = new Set(ids as string[]);
	return unique.size === ids.length ? [...unique] : null;
}

function parseNullableIdentity(value: unknown): string | null | undefined | false {
	if (value === undefined || value === null) return value;
	return typeof value === "string" && IDENTITY.test(value) ? value : false;
}

function boundedNumber(value: unknown, maximum: number, minimum = -maximum): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
