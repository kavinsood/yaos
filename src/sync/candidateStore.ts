/**
 * Persistence abstraction for the server-ack candidate state.
 *
 * The real implementation uses local-only IndexedDB (not plugin data.json,
 * which lives under .obsidian and may be synced across devices via Obsidian
 * Sync or third-party sync tools). Candidate state is per-device runtime state
 * and must never cross-contaminate across devices.
 *
 * This module defines the interface and an in-memory implementation for tests.
 */

/** Scope fields used both for invalidation and as the persisted payload key. */
export type ScopeKey = {
	vaultIdHash: string;       // SHA-256 of vaultId, hex-encoded
	serverHostHash: string;    // SHA-256 of server host URL, hex-encoded
	localDeviceId: string;     // stable per-install UUID; NOT deviceName
	roomName: string;          // DO room name; changes on server reset/reclaim
	docSchemaVersion: number;  // CRDT doc schema version at capture time
};

/** Metadata recorded alongside scope; not used for invalidation. */
export type ScopeMetadata = {
	pluginVersion: string;    // semver at capture time; for diagnostics only
	// Local IndexedDB ack-store schema version. Distinct from PersistedCandidateState.schema,
	// which versions the JSON record shape.
	ackStoreVersion: number;  // increment when persisted format changes
};

export type PersistedCandidateState = ScopeKey & ScopeMetadata & {
	schema: 1;
	candidateSvBase64: string | null;
	candidateCapturedAt: number | null;
	// Historical-only: NOT restored as active serverAppliedLocalState=true.
	// Level 3 is not durable — the DO may crash before enqueueSave().
	lastKnownServerReceiptEchoAt: number | null;
};

export interface CandidateStore {
	/**
	 * Load persisted state for the given scope. Returns null if:
	 * - No state is stored.
	 * - Stored scope does not match (vault/server/device/room/schema mismatch).
	 * - Stored state is corrupt or undeserializable.
	 * Never throws — failures always produce null (fail closed).
	 */
	load(scope: ScopeKey): Promise<PersistedCandidateState | null>;

	/**
	 * Persist state. Throws on write failure — caller is responsible for
	 * incrementing candidatePersistenceFailureCount and setting health flag.
	 */
	save(state: PersistedCandidateState): Promise<void>;

	/** Discard any stored candidate state. */
	clear(): Promise<void>;
}

/** In-memory CandidateStore for tests. Not durable across restarts. */
export class InMemoryCandidateStore implements CandidateStore {
	private _stored: PersistedCandidateState | null = null;
	/** Set to true to simulate write failures. */
	simulateWriteFailure = false;

	async load(scope: ScopeKey): Promise<PersistedCandidateState | null> {
		if (!this._stored) return null;
		if (!scopeKeyMatches(this._stored, scope)) return null;
		return this._stored;
	}

	async save(state: PersistedCandidateState): Promise<void> {
		if (this.simulateWriteFailure) throw new Error("simulated write failure");
		this._stored = state;
	}

	async clear(): Promise<void> {
		this._stored = null;
	}

	/** Test helper: read raw stored state without scope check. */
	get rawStored(): PersistedCandidateState | null { return this._stored; }
}

function scopeKeyMatches(stored: PersistedCandidateState, scope: ScopeKey): boolean {
	return (
		stored.vaultIdHash === scope.vaultIdHash &&
		stored.serverHostHash === scope.serverHostHash &&
		stored.localDeviceId === scope.localDeviceId &&
		stored.roomName === scope.roomName &&
		stored.docSchemaVersion === scope.docSchemaVersion
	);
}
