/**
 * Persistence abstraction for the server-ack candidate state.
 *
 * The real implementation uses local-only IndexedDB (not plugin data.json,
 * which lives under .obsidian and may be synced across devices via Obsidian
 * Sync or third-party sync tools). Candidate state is per-device runtime state
 * and must never cross-contaminate across devices.
 *
 * This module defines the persisted data shape and storage interface.
 */

/** Scope fields used both for invalidation and as the persisted payload key. */
export type ScopeKey = {
	vaultIdHash: string;       // SHA-256 of vaultId, hex-encoded
	serverHostHash: string;    // SHA-256 of server host URL, hex-encoded
	localDeviceId: string;     // server-issued device ID for this enrollment; NOT deviceName
	roomName: string;          // DO room name; changes on server reset/reclaim
	roomGeneration: number; // authoritative sys.generation; isolates reset/reclaim epochs
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
	schema: 2;
	candidateSvBase64: string | null;
	candidateCapturedAt: number | null;
	// Historical-only: NOT restored as active serverAppliedLocalState=true.
	// Level 3 is not durable — the DO may crash before enqueueSave().
	lastKnownServerReceiptEchoAt: number | null;
};

/** Return a usable generation only when local state really contains one. */
export function readKnownRoomGeneration(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

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
