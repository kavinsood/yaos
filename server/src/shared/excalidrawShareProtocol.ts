import { canonicalExcalidrawJson, isExcalidrawDigest, isExcalidrawIdentity } from "./excalidrawProtocol";

export const EXCALIDRAW_SHARE_PROTOCOL_VERSION = 1 as const;
export const MAX_EXCALIDRAW_SHARES_PER_DRAWING = 16;
export const MAX_EXCALIDRAW_SHARE_RESOURCES = 256;
export const MAX_EXCALIDRAW_SHARE_RESOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_EXCALIDRAW_SHARE_TOTAL_BYTES = 250 * 1024 * 1024;
export const MAX_EXCALIDRAW_INBOUND_RESOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_EXCALIDRAW_SHARE_SESSIONS = 64;
export const EXCALIDRAW_SHARE_SESSION_TTL_MS = 15 * 60 * 1_000;
export const MIN_EXCALIDRAW_SHARE_TTL_MS = 60 * 60 * 1_000;
export const MAX_EXCALIDRAW_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** Exact public-projection-v1 field surface pinned to @excalidraw/excalidraw 0.18.0. */
export const PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1 = Object.freeze([
	"angle", "autoResize", "backgroundColor", "boundElements", "containerId", "crop", "elbowed",
	"endArrowhead", "endBinding", "endIsSpecial", "fileId", "fillStyle", "fixedSegments", "fontFamily",
	"fontSize", "frameId", "groupIds", "height", "id", "index", "isDeleted", "lastCommittedPoint",
	"lineHeight", "locked", "name", "opacity", "originalText", "points", "pressures",
	"roughness", "roundness", "scale", "seed", "simulatePressure", "startArrowhead", "startBinding",
	"startIsSpecial", "status", "strokeColor", "strokeStyle", "strokeWidth", "text", "textAlign", "type",
	"updated", "version", "versionNonce", "verticalAlign", "width", "x", "y",
] as const);

/** SHA-256 of the canonical JSON encoding of PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1. */
export const PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1_HASH = "65aef5ceab5f58c5c721af0bf03510d8a358b3620fd4d5a503c06af6467f9bb2";

export const PUBLIC_EXCALIDRAW_ELEMENT_TYPES_V1 = Object.freeze([
	"rectangle", "diamond", "ellipse", "line", "arrow", "text", "image", "frame", "freedraw",
] as const);

export type ExcalidrawSharePermission = "read-only" | "read-write";

export interface ExcalidrawPublicResource {
	publicResourceId: string;
	sourceResourceId: string;
	contentHash: string;
	size: number;
	mime: string;
}

export interface ExcalidrawShareCreateRequest {
	protocolVersion: typeof EXCALIDRAW_SHARE_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	shareId: string;
	publicDrawingId: string;
	linkSecretHash: string;
	permission: ExcalidrawSharePermission;
	expiresAt: number;
	resources: ExcalidrawPublicResource[];
}

export interface ExcalidrawShareUpdateRequest {
	protocolVersion: typeof EXCALIDRAW_SHARE_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	shareId: string;
	expectedGrantRevision: number;
	permission: ExcalidrawSharePermission;
	expiresAt: number;
	resources: ExcalidrawPublicResource[];
}

export interface ExcalidrawShareRevokeRequest {
	protocolVersion: typeof EXCALIDRAW_SHARE_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	shareId: string;
	expectedGrantRevision: number;
}

export interface ExcalidrawShareGrantPublic {
	protocolVersion: typeof EXCALIDRAW_SHARE_PROTOCOL_VERSION;
	shareId: string;
	publicDrawingId: string;
	drawingEpoch: number;
	grantRevision: number;
	permission: ExcalidrawSharePermission;
	expiresAt: number;
	state: "active" | "revoked";
	resources: Array<Omit<ExcalidrawPublicResource, "sourceResourceId">>;
}

export interface ExcalidrawShareRouteEnvelope {
	v: 1;
	vaultId: string;
	vaultGeneration: string;
	drawingId: string;
	drawingEpoch: number;
	shareId: string;
	publicDrawingId: string;
}

export interface ExcalidrawShareSessionEnvelope extends ExcalidrawShareRouteEnvelope {
	sessionId: string;
	sessionToken: string;
	expiresAt: number;
}

export function excalidrawShareDigestInput<T extends { requestDigest: string }>(request: T): Omit<T, "requestDigest"> {
	const { requestDigest: _requestDigest, ...input } = request;
	return input;
}

export function validateExcalidrawPublicResources(value: unknown): asserts value is ExcalidrawPublicResource[] {
	if (!Array.isArray(value) || value.length > MAX_EXCALIDRAW_SHARE_RESOURCES) throw new TypeError("invalid_excalidraw_share_resources");
	const publicIds = new Set<string>();
	const sourceIds = new Set<string>();
	let total = 0;
	for (const unknownEntry of value) {
		if (!unknownEntry || typeof unknownEntry !== "object" || Array.isArray(unknownEntry)) throw new TypeError("invalid_excalidraw_share_resource");
		const entry = unknownEntry as Record<string, unknown>;
		if (!isExcalidrawIdentity(entry.publicResourceId) || !isExcalidrawIdentity(entry.sourceResourceId)
			|| !isExcalidrawDigest(entry.contentHash) || !Number.isSafeInteger(entry.size)
			|| (entry.size as number) < 0 || (entry.size as number) > MAX_EXCALIDRAW_SHARE_RESOURCE_BYTES
			|| typeof entry.mime !== "string" || entry.mime.length < 1 || entry.mime.length > 256
			|| /[\r\n]/.test(entry.mime) || publicIds.has(entry.publicResourceId) || sourceIds.has(entry.sourceResourceId)) {
			throw new TypeError("invalid_excalidraw_share_resource");
		}
		publicIds.add(entry.publicResourceId);
		sourceIds.add(entry.sourceResourceId);
		total += entry.size as number;
	}
	if (total > MAX_EXCALIDRAW_SHARE_TOTAL_BYTES) throw new TypeError("excalidraw_share_resource_bytes_exceeded");
}

export function validateExcalidrawShareExpiry(expiresAt: unknown, now = Date.now()): asserts expiresAt is number {
	if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < now + MIN_EXCALIDRAW_SHARE_TTL_MS
		|| (expiresAt as number) > now + MAX_EXCALIDRAW_SHARE_TTL_MS) throw new TypeError("invalid_excalidraw_share_expiry");
}

export function isExcalidrawSharePermission(value: unknown): value is ExcalidrawSharePermission {
	return value === "read-only" || value === "read-write";
}

export function canonicalExcalidrawShareJson(value: unknown): string {
	return canonicalExcalidrawJson(value);
}
