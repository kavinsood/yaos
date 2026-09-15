export interface AuthorityStamp {
	vaultGeneration: string;
	authorizationEpoch: number;
	drawingEpoch: number;
}

export interface NativeElementRecord {
	id: string;
	version: number;
	versionNonce: number;
	isDeleted?: boolean;
	[key: string]: unknown;
}

export interface ActorIdentity {
	actorId: string;
	displayName: string;
	color: string;
	deviceId: string;
}

export interface MutationBatch {
	operationId: string;
	sessionId: string;
	actorId: string;
	authority: AuthorityStamp;
	elements: NativeElementRecord[];
}

export interface OperationReceipt {
	operationId: string;
	requestDigest: string;
	sequence: number;
	acceptedElementIds: string[];
	staleElementIds: string[];
}

export interface RoomEvent {
	sequence: number;
	operationId: string;
	actorId: string;
	elements: NativeElementRecord[];
}

export interface RoomSnapshot {
	sequence: number;
	authority: AuthorityStamp;
	elements: NativeElementRecord[];
}

export interface PresencePayload {
	pointer?: { x: number; y: number; tool?: string; button?: "down" | "up" };
	selectedElementIds?: string[];
	viewport?: { scrollX: number; scrollY: number; zoom: number };
	laser?: { x: number; y: number };
}

export interface PresenceRecord {
	sessionId: string;
	identity: ActorIdentity;
	payload: PresencePayload;
	expiresAt: number;
}

interface RoomState {
	authority: AuthorityStamp;
	sequence: number;
	elements: Map<string, NativeElementRecord>;
	receipts: Map<string, OperationReceipt>;
	events: RoomEvent[];
	compactedSnapshot: RoomSnapshot | null;
}

interface SessionRecord {
	identity: ActorIdentity;
	authority: AuthorityStamp;
	lastPresenceAt: number;
	presence: PresencePayload;
}

export type FaultPoint = "before-commit" | "after-commit";

export class AuthorityMismatchError extends Error {}
export class OperationEquivocationError extends Error {}
export class SessionRejectedError extends Error {}
export class InjectedFaultError extends Error {}

const MAX_ELEMENTS_PER_BATCH = 512;
const MAX_SELECTED_ELEMENT_IDS = 512;
const MAX_ABSOLUTE_COORDINATE = 10_000_000;
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 100;

export class DrawingRoomCore {
	private state: RoomState;
	private readonly sessions = new Map<string, SessionRecord>();

	constructor(authority: AuthorityStamp) {
		validateAuthority(authority);
		this.state = {
			authority: structuredClone(authority),
			sequence: 0,
			elements: new Map(),
			receipts: new Map(),
			events: [],
			compactedSnapshot: null,
		};
	}

	setAuthority(authority: AuthorityStamp): void {
		validateAuthority(authority);
		this.state.authority = structuredClone(authority);
		for (const [sessionId, session] of this.sessions) {
			if (!authorityEquals(session.authority, authority)) this.sessions.delete(sessionId);
		}
	}

	applyBatch(batch: MutationBatch, faultPoint?: FaultPoint): OperationReceipt {
		validateBatch(batch);
		this.assertAuthority(batch.authority);
		const session = this.sessions.get(batch.sessionId);
		if (!session || session.identity.actorId !== batch.actorId || !authorityEquals(session.authority, batch.authority)) {
			throw new SessionRejectedError("mutation session is absent, stale, or belongs to another actor");
		}

		const requestDigest = canonicalStringify({
			actorId: batch.actorId,
			authority: batch.authority,
			elements: batch.elements,
			sessionId: batch.sessionId,
		});
		const priorReceipt = this.state.receipts.get(batch.operationId);
		if (priorReceipt) {
			if (priorReceipt.requestDigest !== requestDigest) {
				throw new OperationEquivocationError("operationId was reused with different content");
			}
			return structuredClone(priorReceipt);
		}

		const next = cloneState(this.state);
		const accepted: NativeElementRecord[] = [];
		const staleElementIds: string[] = [];
		for (const incoming of batch.elements) {
			const existing = next.elements.get(incoming.id);
			if (!existing || compareElements(incoming, existing) > 0) {
				const copy = structuredClone(incoming);
				next.elements.set(incoming.id, copy);
				accepted.push(copy);
			} else {
				staleElementIds.push(incoming.id);
			}
		}

		if (accepted.length > 0) {
			next.sequence += 1;
			next.events.push({
				sequence: next.sequence,
				operationId: batch.operationId,
				actorId: batch.actorId,
				elements: structuredClone(accepted),
			});
		}
		const receipt: OperationReceipt = {
			operationId: batch.operationId,
			requestDigest,
			sequence: next.sequence,
			acceptedElementIds: accepted.map((element) => element.id),
			staleElementIds,
		};
		next.receipts.set(batch.operationId, structuredClone(receipt));

		if (faultPoint === "before-commit") throw new InjectedFaultError(faultPoint);
		this.state = next;
		if (faultPoint === "after-commit") throw new InjectedFaultError(faultPoint);
		return receipt;
	}

	connectSession(sessionId: string, identity: ActorIdentity, authority: AuthorityStamp): void {
		validateIdentifier(sessionId, "sessionId");
		validateIdentity(identity);
		this.assertAuthority(authority);
		this.sessions.set(sessionId, {
			identity: structuredClone(identity),
			authority: structuredClone(authority),
			lastPresenceAt: 0,
			presence: {},
		});
	}

	disconnectSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	updatePresence(sessionId: string, untrustedPayload: PresencePayload, now: number, ttlMs = 15_000): PresenceRecord {
		const session = this.sessions.get(sessionId);
		if (!session || !authorityEquals(session.authority, this.state.authority)) {
			throw new SessionRejectedError("presence session is absent or stale");
		}
		if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("invalid presence time");
		const payload = sanitizePresence(untrustedPayload);
		session.lastPresenceAt = now;
		session.presence = payload;
		return {
			sessionId,
			identity: structuredClone(session.identity),
			payload: structuredClone(payload),
			expiresAt: now + ttlMs,
		};
	}

	listPresence(now: number, ttlMs = 15_000): PresenceRecord[] {
		const result: PresenceRecord[] = [];
		for (const [sessionId, session] of this.sessions) {
			if (session.lastPresenceAt === 0 || session.lastPresenceAt + ttlMs <= now) continue;
			result.push({
				sessionId,
				identity: structuredClone(session.identity),
				payload: structuredClone(session.presence),
				expiresAt: session.lastPresenceAt + ttlMs,
			});
		}
		return result.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
	}

	replayAfter(sequence: number): { snapshotRequired: boolean; events: RoomEvent[] } {
		if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("invalid replay sequence");
		const compactedThrough = this.state.compactedSnapshot?.sequence ?? 0;
		if (sequence < compactedThrough) return { snapshotRequired: true, events: [] };
		return {
			snapshotRequired: false,
			events: structuredClone(this.state.events.filter((event) => event.sequence > sequence)),
		};
	}

	compact(): RoomSnapshot {
		const snapshot = this.snapshot();
		this.state.compactedSnapshot = structuredClone(snapshot);
		this.state.events = [];
		return snapshot;
	}

	snapshot(): RoomSnapshot {
		return {
			sequence: this.state.sequence,
			authority: structuredClone(this.state.authority),
			elements: [...this.state.elements.values()]
				.sort((left, right) => left.id.localeCompare(right.id))
				.map((element) => structuredClone(element)),
		};
	}

	receipt(operationId: string): OperationReceipt | null {
		const receipt = this.state.receipts.get(operationId);
		return receipt ? structuredClone(receipt) : null;
	}

	private assertAuthority(authority: AuthorityStamp): void {
		if (!authorityEquals(this.state.authority, authority)) {
			throw new AuthorityMismatchError("vault generation, authorization epoch, or drawing epoch is stale");
		}
	}
}

export function compareElements(left: NativeElementRecord, right: NativeElementRecord): number {
	if (left.version !== right.version) return left.version > right.version ? 1 : -1;
	if (left.versionNonce !== right.versionNonce) return left.versionNonce < right.versionNonce ? 1 : -1;
	const leftCanonical = canonicalStringify(left);
	const rightCanonical = canonicalStringify(right);
	return leftCanonical === rightCanonical ? 0 : leftCanonical > rightCanonical ? 1 : -1;
}

export function canonicalStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const object = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(object).sort()) result[key] = canonicalize(object[key]);
		return result;
	}
	return value;
}

function cloneState(state: RoomState): RoomState {
	return {
		authority: structuredClone(state.authority),
		sequence: state.sequence,
		elements: new Map([...state.elements].map(([id, element]) => [id, structuredClone(element)])),
		receipts: new Map([...state.receipts].map(([id, receipt]) => [id, structuredClone(receipt)])),
		events: structuredClone(state.events),
		compactedSnapshot: state.compactedSnapshot ? structuredClone(state.compactedSnapshot) : null,
	};
}

function authorityEquals(left: AuthorityStamp, right: AuthorityStamp): boolean {
	return left.vaultGeneration === right.vaultGeneration
		&& left.authorizationEpoch === right.authorizationEpoch
		&& left.drawingEpoch === right.drawingEpoch;
}

function validateAuthority(authority: AuthorityStamp): void {
	validateIdentifier(authority.vaultGeneration, "vaultGeneration");
	if (!Number.isSafeInteger(authority.authorizationEpoch) || authority.authorizationEpoch < 0) throw new TypeError("invalid authorizationEpoch");
	if (!Number.isSafeInteger(authority.drawingEpoch) || authority.drawingEpoch < 0) throw new TypeError("invalid drawingEpoch");
}

function validateBatch(batch: MutationBatch): void {
	validateIdentifier(batch.operationId, "operationId");
	validateIdentifier(batch.sessionId, "sessionId");
	validateIdentifier(batch.actorId, "actorId");
	validateAuthority(batch.authority);
	if (!Array.isArray(batch.elements) || batch.elements.length === 0 || batch.elements.length > MAX_ELEMENTS_PER_BATCH) {
		throw new TypeError("invalid batch element count");
	}
	const ids = new Set<string>();
	for (const element of batch.elements) {
		validateIdentifier(element.id, "element.id");
		if (!Number.isSafeInteger(element.version) || element.version < 0) throw new TypeError("invalid element.version");
		if (!Number.isSafeInteger(element.versionNonce) || element.versionNonce < 0) throw new TypeError("invalid element.versionNonce");
		if (ids.has(element.id)) throw new TypeError("batch contains duplicate element ids");
		ids.add(element.id);
		canonicalStringify(element);
	}
}

function validateIdentity(identity: ActorIdentity): void {
	validateIdentifier(identity.actorId, "actorId");
	validateIdentifier(identity.deviceId, "deviceId");
	if (typeof identity.displayName !== "string" || identity.displayName.length > 128) throw new TypeError("invalid displayName");
	if (!/^#[0-9a-fA-F]{6}$/.test(identity.color)) throw new TypeError("invalid color");
}

function validateIdentifier(value: string, name: string): void {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new TypeError(`invalid ${name}`);
}

function sanitizePresence(payload: PresencePayload): PresencePayload {
	if (payload === null || typeof payload !== "object") throw new TypeError("invalid presence payload");
	const result: PresencePayload = {};
	if (payload.pointer) {
		result.pointer = {
			x: boundedCoordinate(payload.pointer.x),
			y: boundedCoordinate(payload.pointer.y),
			...(typeof payload.pointer.tool === "string" && payload.pointer.tool.length <= 64 ? { tool: payload.pointer.tool } : {}),
			...(payload.pointer.button === "down" || payload.pointer.button === "up" ? { button: payload.pointer.button } : {}),
		};
	}
	if (payload.selectedElementIds) {
		if (!Array.isArray(payload.selectedElementIds) || payload.selectedElementIds.length > MAX_SELECTED_ELEMENT_IDS) {
			throw new TypeError("invalid selectedElementIds");
		}
		result.selectedElementIds = [...new Set(payload.selectedElementIds.map((id) => {
			validateIdentifier(id, "selectedElementId");
			return id;
		}))];
	}
	if (payload.viewport) {
		const zoom = payload.viewport.zoom;
		if (!Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) throw new TypeError("invalid zoom");
		result.viewport = {
			scrollX: boundedCoordinate(payload.viewport.scrollX),
			scrollY: boundedCoordinate(payload.viewport.scrollY),
			zoom,
		};
	}
	if (payload.laser) result.laser = { x: boundedCoordinate(payload.laser.x), y: boundedCoordinate(payload.laser.y) };
	return result;
}

function boundedCoordinate(value: number): number {
	if (!Number.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_COORDINATE) throw new TypeError("coordinate out of bounds");
	return value;
}
