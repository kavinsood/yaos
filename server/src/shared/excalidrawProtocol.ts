export const EXCALIDRAW_PROTOCOL_VERSION = 1 as const;

export const MAX_EXCALIDRAW_BATCH_ELEMENTS = 512;
export const MAX_EXCALIDRAW_BATCH_BYTES = 900_000;
export const MAX_EXCALIDRAW_INITIALIZE_BYTES = 16 * 1024 * 1024;
export const MAX_EXCALIDRAW_ELEMENT_BYTES = 256 * 1024;
export const MAX_EXCALIDRAW_ACTIVE_ELEMENTS = 10_000;
export const MAX_EXCALIDRAW_SCENE_ELEMENTS = 20_000;
export const MAX_EXCALIDRAW_RESOURCE_MANIFEST_ENTRIES = 2_000;
export const MAX_EXCALIDRAW_REPLAY_EVENTS = 256;
export const MAX_EXCALIDRAW_REPLAY_BYTES = 4 * 1024 * 1024;
export const MAX_EXCALIDRAW_ID_LENGTH = 160;
export const MAX_EXCALIDRAW_MIME_LENGTH = 256;
export const MAX_EXCALIDRAW_METADATA_BYTES = 512 * 1024;
export const MAX_EXCALIDRAW_JSON_DEPTH = 64;

const IDENTITY = /^[A-Za-z0-9_-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export type ExcalidrawDrawingEpoch = number;

export interface ExcalidrawElementRecord {
	id: string;
	version: number;
	versionNonce: number;
	isDeleted: boolean;
	index?: string;
	[key: string]: unknown;
}

export interface ExcalidrawEmbeddedResource {
	kind: "embedded";
	resourceId: string;
	contentHash: string;
	size: number;
	mime: string;
	created: number;
	lastRetrieved?: number;
}

export interface ExcalidrawVaultResource {
	kind: "vault";
	resourceId: string;
	fileId: string;
	contentHash?: string;
	size?: number;
	mime?: string;
}

/** Same-vault resources are references, not recursive publication authority. */
export type ExcalidrawResourceManifestEntry = ExcalidrawEmbeddedResource | ExcalidrawVaultResource;

export interface ExcalidrawResourceManifest {
	version: 1;
	entries: ExcalidrawResourceManifestEntry[];
}

export interface ExcalidrawSceneMetadata {
	appState?: Record<string, unknown>;
	plugin?: Record<string, unknown>;
	resourceManifest: ExcalidrawResourceManifest;
}

export interface ExcalidrawBatchRequest {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	elements: ExcalidrawElementRecord[];
	metadata?: ExcalidrawSceneMetadata;
}

export interface ExcalidrawInitializeRequest {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	prepareOperationId: string;
	drawingEpoch: 1;
	elements: ExcalidrawElementRecord[];
	metadata: ExcalidrawSceneMetadata;
}

export type ExcalidrawSourceAuthority =
	| { kind: "markdown"; documentId: string; fileId: string; bodyEpoch: number; generation: number; contentHash: string; size: number }
	| { kind: "attachment"; revision: string; contentHash: string; size: number };

export interface ExcalidrawPromotionPrepareRequest {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	path: string;
	source: ExcalidrawSourceAuthority;
	initializationRequestDigest: string;
}

export interface ExcalidrawPromotionPrepareReceipt {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	drawingEpoch: 1;
	path: string;
	source: ExcalidrawSourceAuthority;
	preparePermitId: string;
	replayed: boolean;
}

export interface ExcalidrawPromotionFinalizeRequest {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	prepareOperationId: string;
	initializationOperationId: string;
	initializationRequestDigest: string;
}

export interface ExcalidrawPromotionFinalizeReceipt {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	drawingEpoch: 1;
	path: string;
	vaultSequence: number;
	rootGeneration: number;
	replayed: boolean;
}

export type ExcalidrawLifecycleRequest = {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
} & (
	| { kind: "rename"; fromPath: string; toPath: string }
	| { kind: "delete"; path: string }
);

export interface ExcalidrawLifecycleReceipt {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	kind: "rename" | "delete";
	resultPath: string;
	resultLifecycle: "active" | "tombstoned";
	vaultSequence: number;
	rootGeneration: number;
	replayed: boolean;
}

export interface ExcalidrawBatchReceipt {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	sequence: number;
	acceptedElementIds: string[];
	staleElementIds: string[];
	metadataAccepted: boolean;
	replayed: boolean;
}

export interface ExcalidrawRoomEvent {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	sequence: number;
	operationId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	elements: ExcalidrawElementRecord[];
	metadata?: ExcalidrawSceneMetadata;
}

export interface ExcalidrawSnapshot {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	drawingId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	sequence: number;
	compactedThrough: number;
	elements: ExcalidrawElementRecord[];
	metadata: ExcalidrawSceneMetadata;
}

export interface ExcalidrawReplayPage {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	drawingId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	after: number;
	through: number;
	compactedThrough: number;
	snapshotRequired: boolean;
	events: ExcalidrawRoomEvent[];
	nextCursor: number | null;
}

export interface ExcalidrawResetRequest {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	previousDrawingEpoch: ExcalidrawDrawingEpoch;
	drawingEpoch: ExcalidrawDrawingEpoch;
	elements: ExcalidrawElementRecord[];
	metadata: ExcalidrawSceneMetadata;
}

export interface ExcalidrawAuthorityReservationRequest {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	kind: "initialize" | "mutate" | "reset" | "connect";
	prepareOperationId?: string;
	previousDrawingEpoch?: number;
}

export interface ExcalidrawAuthorityPermit {
	protocolVersion: typeof EXCALIDRAW_PROTOCOL_VERSION;
	operationId: string;
	requestDigest: string;
	drawingId: string;
	drawingEpoch: ExcalidrawDrawingEpoch;
	permitId: string;
	principalId: string;
	membershipRevision: number;
	deviceId: string;
	deviceCredentialRevision: number;
	displayName: string;
	colorSeed: string;
	replayed: boolean;
}

export type ExcalidrawElementDecision = "incoming" | "current" | "equal" | "divergent";

/** Matches pinned upstream Excalidraw: higher version, then lower nonce. */
export function decideExcalidrawElement(
	incoming: ExcalidrawElementRecord,
	current: ExcalidrawElementRecord,
): ExcalidrawElementDecision {
	if (incoming.version !== current.version) return incoming.version > current.version ? "incoming" : "current";
	if (incoming.versionNonce !== current.versionNonce) {
		return incoming.versionNonce < current.versionNonce ? "incoming" : "current";
	}
	return canonicalExcalidrawJson(incoming) === canonicalExcalidrawJson(current) ? "equal" : "divergent";
}

export function canonicalExcalidrawJson(value: unknown): string {
	return JSON.stringify(canonicalize(value, new Set<object>(), 0));
}

export function excalidrawRequestDigestInput<T extends { requestDigest: string }>(request: T): Omit<T, "requestDigest"> {
	const { requestDigest: _requestDigest, ...input } = request;
	return input;
}

export function isExcalidrawIdentity(value: unknown): value is string {
	return typeof value === "string" && IDENTITY.test(value);
}

export function isExcalidrawDigest(value: unknown): value is string {
	return typeof value === "string" && DIGEST.test(value);
}

export function isExcalidrawEpoch(value: unknown): value is ExcalidrawDrawingEpoch {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function isSupportedExcalidrawPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1_024
		&& !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => !part || part === "." || part === "..")
		&& (value.endsWith(".excalidraw") || value.endsWith(".excalidraw.md"));
}

export function validateExcalidrawElement(value: unknown): asserts value is ExcalidrawElementRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_excalidraw_element");
	const element = value as Record<string, unknown>;
	if (!isExcalidrawIdentity(element.id)
		|| !Number.isSafeInteger(element.version) || (element.version as number) < 1
		|| !Number.isSafeInteger(element.versionNonce) || (element.versionNonce as number) < 0
		|| typeof element.isDeleted !== "boolean"
		|| (element.index !== undefined && (typeof element.index !== "string" || element.index.length > 64))) {
		throw new TypeError("invalid_excalidraw_element");
	}
	if (encodedLength(value) > MAX_EXCALIDRAW_ELEMENT_BYTES) throw new TypeError("excalidraw_element_too_large");
}

export function validateExcalidrawElements(values: unknown, maximum = MAX_EXCALIDRAW_BATCH_ELEMENTS,
	allowEmpty = false): asserts values is ExcalidrawElementRecord[] {
	if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.length > maximum) {
		throw new TypeError("invalid_excalidraw_element_count");
	}
	const ids = new Set<string>();
	for (const value of values) {
		validateExcalidrawElement(value);
		if (ids.has(value.id)) throw new TypeError("duplicate_excalidraw_element_id");
		ids.add(value.id);
	}
}

export function validateExcalidrawManifest(value: unknown): asserts value is ExcalidrawResourceManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_excalidraw_resource_manifest");
	const manifest = value as Record<string, unknown>;
	if (manifest.version !== 1 || !Array.isArray(manifest.entries)
		|| manifest.entries.length > MAX_EXCALIDRAW_RESOURCE_MANIFEST_ENTRIES) {
		throw new TypeError("invalid_excalidraw_resource_manifest");
	}
	const resourceIds = new Set<string>();
	for (const unknownEntry of manifest.entries) {
		if (!unknownEntry || typeof unknownEntry !== "object" || Array.isArray(unknownEntry)) throw new TypeError("invalid_excalidraw_resource");
		const entry = unknownEntry as Record<string, unknown>;
		if (!isExcalidrawIdentity(entry.resourceId) || resourceIds.has(entry.resourceId)) throw new TypeError("invalid_excalidraw_resource_id");
		resourceIds.add(entry.resourceId);
		if (entry.kind === "embedded") {
			if (!isExcalidrawDigest(entry.contentHash) || !validSize(entry.size) || !validMime(entry.mime)
				|| !Number.isSafeInteger(entry.created) || (entry.created as number) < 0
				|| (entry.lastRetrieved !== undefined && (!Number.isSafeInteger(entry.lastRetrieved) || (entry.lastRetrieved as number) < 0))) {
				throw new TypeError("invalid_excalidraw_embedded_resource");
			}
		} else if (entry.kind === "vault") {
			if (!isExcalidrawIdentity(entry.fileId)
				|| (entry.contentHash !== undefined && !isExcalidrawDigest(entry.contentHash))
				|| (entry.size !== undefined && !validSize(entry.size))
				|| (entry.mime !== undefined && !validMime(entry.mime))) throw new TypeError("invalid_excalidraw_vault_resource");
		} else throw new TypeError("invalid_excalidraw_resource_kind");
	}
}

export function validateExcalidrawMetadata(value: unknown): asserts value is ExcalidrawSceneMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_excalidraw_metadata");
	const metadata = value as Record<string, unknown>;
	validateExcalidrawManifest(metadata.resourceManifest);
	for (const key of ["appState", "plugin"] as const) {
		const field = metadata[key];
		if (field !== undefined && (!field || typeof field !== "object" || Array.isArray(field))) throw new TypeError("invalid_excalidraw_metadata");
	}
	if (encodedLength(value) > MAX_EXCALIDRAW_METADATA_BYTES) throw new TypeError("excalidraw_metadata_too_large");
}

function canonicalize(value: unknown, ancestors: Set<object>, depth: number): unknown {
	if (depth > MAX_EXCALIDRAW_JSON_DEPTH) throw new TypeError("excalidraw_json_too_deep");
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (hasLoneSurrogate(value)) throw new TypeError("invalid_excalidraw_unicode");
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new TypeError("invalid_excalidraw_number");
		}
		return value;
	}
	if (typeof value !== "object") throw new TypeError("invalid_excalidraw_json_value");
	if (ancestors.has(value)) throw new TypeError("cyclic_excalidraw_json");
	const prototype = Reflect.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
		throw new TypeError("invalid_excalidraw_json_prototype");
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("sparse_excalidraw_array");
				result.push(canonicalize(value[index], ancestors, depth + 1));
			}
			return result;
		}
		const source = value as Record<string, unknown>;
		const result = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(source).sort(compareUnicodeCodePoints)) {
			if (hasLoneSurrogate(key)) throw new TypeError("invalid_excalidraw_unicode");
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!descriptor || !("value" in descriptor)) throw new TypeError("invalid_excalidraw_json_accessor");
			result[key] = canonicalize(descriptor.value, ancestors, depth + 1);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function compareUnicodeCodePoints(left: string, right: string): number {
	const leftPoints = [...left].map((character) => character.codePointAt(0)!);
	const rightPoints = [...right].map((character) => character.codePointAt(0)!);
	for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
		if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
	}
	return leftPoints.length - rightPoints.length;
}

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function validSize(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validMime(value: unknown): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_EXCALIDRAW_MIME_LENGTH;
}

function encodedLength(value: unknown): number {
	return new TextEncoder().encode(canonicalExcalidrawJson(value)).byteLength;
}
