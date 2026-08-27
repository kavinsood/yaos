import type {
	CandidateStore,
	PersistedCandidateState,
	ScopeKey,
} from "../../../src/sync/candidateStore";

/** In-memory CandidateStore for candidate lifecycle tests. */
export class InMemoryCandidateStore implements CandidateStore {
	private stored: PersistedCandidateState | null = null;
	simulateWriteFailure = false;

	async load(scope: ScopeKey): Promise<PersistedCandidateState | null> {
		if (!this.stored || !scopeKeyMatches(this.stored, scope)) return null;
		return this.stored;
	}

	async save(state: PersistedCandidateState): Promise<void> {
		if (this.simulateWriteFailure) throw new Error("simulated write failure");
		this.stored = state;
	}

	async clear(): Promise<void> {
		this.stored = null;
	}

	get rawStored(): PersistedCandidateState | null {
		return this.stored;
	}
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
