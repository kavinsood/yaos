/**
 * Server-applied state tracker for FU-8 (Level 3 ack).
 *
 * Captures a local candidate state vector on every ack-tracked local update,
 * compares it against server SV echoes received via provider custom-message,
 * and persists candidate state across plugin restarts so offline edits can be
 * confirmed after reconnect.
 *
 * This module is intentionally Obsidian-free so it can be tested under Node.
 * It does not import Y directly — callers pass encodeStateVector as a callback.
 */

import { isStateVectorGe } from "./stateVectorAck";
import { encodeBytesBase64, decodeBytesBase64 } from "./svEchoMessage";
import { isAckTrackedLocalOrigin } from "./ackOrigins";
import type { CandidateStore, ScopeKey, ScopeMetadata, PersistedCandidateState } from "./candidateStore";
import type { TraceRecord } from "../observability/traceContext";
import { fnv1a32Bytes, toHex8 } from "../utils/fnv1a";

export type { ScopeKey, ScopeMetadata, PersistedCandidateState } from "./candidateStore";

export interface ServerAckState {
	readonly serverAppliedLocalState: boolean | null;
	// Timestamp of the last valid server SV echo this session. When
	// serverAppliedLocalState is false, this is historical and does not confirm
	// the current candidate.
	readonly lastServerReceiptEchoAt: number | null;
	readonly lastKnownServerReceiptEchoAt: number | null;
	readonly candidatePersistenceHealthy: boolean;
	readonly candidatePersistenceFailureCount: number;
	readonly hasUnconfirmedCandidate: boolean;
	readonly candidateCapturedAt: number | null;
	/** Receipts from this server prove a durable write, not just in-memory apply. */
	readonly receiptGuaranteeIsDurable: boolean;
	/** Server reported it cannot durably store writes. */
	readonly serverPersistenceDegraded: boolean;
}

export class ServerAckTracker {
	private _lastUnconfirmedCandidateSv: Uint8Array | null = null;
	private _candidateCapturedAt: number | null = null;
	private _serverAppliedLocalState: boolean | null = null;
	private _lastServerReceiptEchoAt: number | null = null;
	private _lastKnownServerReceiptEchoAt: number | null = null;
	private _candidatePersistenceHealthy = true;
	private _candidatePersistenceFailureCount = 0;

	private _lastCandidateId: string | null = null;
	private _lastConfirmedCandidateId: string | null = null;
	private _lastCandidateSvHash: string | null = null;
	private _lastCausedByOpId: string | null = null;

	/**
	 * Server persist counter observed when the pending candidate was captured.
	 *
	 * Confirmation requires the server to report a HIGHER value, which is what
	 * distinguishes "stored" from "applied" and is the only signal that works
	 * for deletion-only changes.
	 */
	private _generationAtCapture: number | null = null;
	private _lastSeenServerGeneration: number | null = null;
	private _lastServerGenerationEpoch: string | null = null;

	private _encodeStateVector: (() => Uint8Array) | null = null;
	private _store: CandidateStore | null = null;
	private _scope: (ScopeKey & ScopeMetadata) | null = null;
	private _onFlight?: (event: Record<string, unknown>) => void;

	constructor(
		private readonly trace?: TraceRecord,
		onFlight?: (event: Record<string, unknown>) => void,
	) {
		this._onFlight = onFlight;
	}

	/**
	 * Record the opId of the CRDT mutation that will trigger a candidate capture.
	 * Prefer withActiveOpId() so Y.Doc update observers see the op during the transaction.
	 */
	setActiveOpId(opId: string | undefined): void {
		this._lastCausedByOpId = opId ?? null;
	}

	withActiveOpId<T>(opId: string | undefined, work: () => T): T {
		const previous = this._lastCausedByOpId;
		this._lastCausedByOpId = opId ?? null;
		try {
			return work();
		} finally {
			this._lastCausedByOpId = previous;
		}
	}

	/**
	 * Attach to a Y.Doc update event stream. Must be called before onStartup.
	 *
	 * @param doc               Minimal doc interface — only the "update" event is used.
	 * @param encodeStateVector Callback to get the current doc state vector after a transaction.
	 *                          Typically () => Y.encodeStateVector(doc).
	 * @param provider          The sync provider object (remote updates use this as origin).
	 * @param persistence       The IDB persistence object (replay loads use this as origin).
	 */
	attach(
		doc: { on: (event: "update", handler: (update: Uint8Array, origin: unknown) => void) => void },
		encodeStateVector: () => Uint8Array,
		provider: unknown,
		persistence: unknown,
	): void {
		this._encodeStateVector = encodeStateVector;
		doc.on("update", (_update: Uint8Array, origin: unknown) => {
			if (isAckTrackedLocalOrigin(origin, provider, persistence)) {
				this._lastUnconfirmedCandidateSv = encodeStateVector();
				this._candidateCapturedAt = Date.now();
				this._serverAppliedLocalState = false;
				// Baseline for the durability check.  The candidate is confirmed
				// only once the server reports a persist counter beyond this.
				this._generationAtCapture = this._lastSeenServerGeneration;
				this.trace?.("receipt", "receipt-candidate-captured", {
					candidateBytes: this._lastUnconfirmedCandidateSv.byteLength,
					candidateCapturedAt: this._candidateCapturedAt,
					originType: typeof origin,
				});
				this._lastCandidateId = `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				this._lastCandidateSvHash = this._computeSvHash(this._lastUnconfirmedCandidateSv);
				this._onFlight?.({
					priority: "critical",
					kind: "server.receipt.candidate_captured",
					severity: "info",
					scope: "connection",
					source: "serverAckTracker",
					layer: "server",
					candidateId: this._lastCandidateId,
					svHash: this._lastCandidateSvHash,
					data: {
						candidateBytes: this._lastUnconfirmedCandidateSv.byteLength,
						causedByOpId: this._lastCausedByOpId,
					},
				});
				this._persistAsync();
			}
		});
	}

	/**
	 * Load persisted candidate state. Call after IDB has loaded CRDT state so
	 * encodeStateVector() reflects the fully-loaded document.
	 *
	 * Persisted serverAppliedLocalState=true is NOT restored as active truth —
	 * Level 3 is not durable. Candidate is validated against the current doc SV
	 * and active state stays null until a fresh server echo revalidates it.
	 */
	async onStartup(store: CandidateStore, scope: ScopeKey & ScopeMetadata): Promise<void> {
		this._store = store;
		this._scope = scope;

		let stored: PersistedCandidateState | null;
		try {
			stored = await store.load(scope);
		} catch {
			this.trace?.("receipt", "receipt-startup-load-failed", {
				scopeKnown: Boolean(scope.vaultIdHash && scope.serverHostHash && scope.localDeviceId),
			});
			stored = null;
		}

		if (!stored || !stored.candidateSvBase64) return;

		const sv = decodeBytesBase64(stored.candidateSvBase64);
		if (!sv) return; // corrupt base64 — fail closed

		// attach() runs before persisted startup validation so early local edits
		// are not missed. If such a live candidate exists, startup must not
		// overwrite it with older persisted state.
		if (this._lastUnconfirmedCandidateSv === null) {
			this._lastUnconfirmedCandidateSv = sv;
			this._candidateCapturedAt = stored.candidateCapturedAt;
			// Active state is always null after startup — never restore true.
			this._serverAppliedLocalState = null;
		}
		this._lastKnownServerReceiptEchoAt = stored.lastKnownServerReceiptEchoAt;

		this._validateCandidateAgainstDoc();
	}

	/**
	 * Call when the server sends an SV echo (provider "custom-message" handler,
	 * after parsing with parseSvEchoMessage).
	 *
	 * CONFIRMATION RULE
	 *
	 * A state vector describes inserts only; deletions live in the delete set,
	 * which it does not describe.  So a deletion-only local change produces a
	 * candidate state vector IDENTICAL to the previous one, which the server
	 * already had — and `isStateVectorGe` then returns true on the very next
	 * echo.  Deleting a paragraph was reported as "the server has your state"
	 * without the server having received, let alone stored, anything.
	 *
	 * When the server supplies a durability marker we require its persist
	 * counter to have ADVANCED past the value seen when the candidate was
	 * captured.  That is true for deletions and insertions alike, and it raises
	 * the meaning from "applied in memory" to "written to storage", which is
	 * what the receipt has always claimed.
	 *
	 * The state-vector comparison remains the fallback for servers that predate
	 * the marker, preserving their existing (weaker) behaviour rather than
	 * withdrawing receipts from them.
	 */
	private _serverPersistenceDegraded = false;

	/**
	 * Whether the server most recently reported that it cannot durably store
	 * writes.  Distinct from the receipt: a receipt can be outstanding simply
	 * because nothing was sent, whereas this says storage itself is failing.
	 */
	get serverPersistenceDegraded(): boolean {
		return this._serverPersistenceDegraded;
	}

	/**
	 * Whether receipts from this server carry the durable guarantee.
	 *
	 * True once a durability marker has been seen: the server's persist counter
	 * advances only after a completed write, so confirming against it means the
	 * state reached storage.  False against a server predating the marker, where
	 * the state-vector fallback proves only that the update was applied in
	 * memory.  The UI must not claim the stronger guarantee for the weaker
	 * mechanism, so the label is driven by this rather than assuming.
	 */
	get receiptGuaranteeIsDurable(): boolean {
		return this._lastServerGenerationEpoch !== null;
	}

	recordServerSvEcho(
		serverSv: Uint8Array,
		durability: { generation: number; epoch: string; degraded?: boolean } | null = null,
	): void {
		this._lastServerReceiptEchoAt = Date.now();
		// Absent marker means a server too old to report health; keep the last
		// known value rather than claiming healthy.
		if (durability !== null) this._serverPersistenceDegraded = durability.degraded === true;

		// A restart resets the counter, so a client holding generation 40 would
		// otherwise wait forever for 41.  Re-baseline instead, and leave any
		// pending candidate unconfirmed: the new instance loaded from storage and
		// may not hold an unsaved change, so claiming otherwise would be a lie.
		const epochChanged =
			durability !== null
			&& this._lastServerGenerationEpoch !== null
			&& durability.epoch !== this._lastServerGenerationEpoch;
		if (epochChanged) {
			this._generationAtCapture = durability.generation;
		}
		if (durability !== null) {
			this._lastServerGenerationEpoch = durability.epoch;
			this._lastSeenServerGeneration = durability.generation;
		}

		let confirmed: boolean | null = null;
		if (this._lastUnconfirmedCandidateSv !== null) {
			if (durability !== null) {
				// Cannot confirm until a baseline exists to advance past.
				confirmed =
					!epochChanged
					&& this._generationAtCapture !== null
					&& durability.generation > this._generationAtCapture;
				if (this._generationAtCapture === null) {
					this._generationAtCapture = durability.generation;
				}
			} else {
				confirmed = isStateVectorGe(serverSv, this._lastUnconfirmedCandidateSv);
			}
			this._serverAppliedLocalState = confirmed;
			if (confirmed) {
				this._lastKnownServerReceiptEchoAt = this._lastServerReceiptEchoAt;
				this._lastConfirmedCandidateId = this._lastCandidateId;
			}
		}
		this.trace?.("receipt", "receipt-server-echo", {
			serverSvBytes: serverSv.byteLength,
			candidateBytes: this._lastUnconfirmedCandidateSv?.byteLength ?? null,
			hasCandidate: this._lastUnconfirmedCandidateSv !== null,
			serverDominatesCandidate: confirmed,
			serverAppliedLocalState: this._serverAppliedLocalState,
			lastServerReceiptEchoAt: this._lastServerReceiptEchoAt,
		});
		const echoSvHash = this._computeSvHash(serverSv);
		this._onFlight?.({
			priority: "critical",
			kind: confirmed ? "server.receipt.confirmed" : "server.sv_echo.seen",
			severity: "info",
			scope: "connection",
			source: "serverAckTracker",
			layer: "server",
			candidateId: this._lastCandidateId ?? undefined,
			svHash: confirmed ? echoSvHash : this._lastCandidateSvHash ?? undefined,
			data: {
				serverSvBytes: serverSv.byteLength,
				confirmed,
				hasCandidate: this._lastUnconfirmedCandidateSv !== null,
				echoSvHash,
				candidateSvHash: this._lastCandidateSvHash,
			},
		});
		this._persistAsync();
	}

	get serverAppliedLocalState(): boolean | null { return this._serverAppliedLocalState; }
	get lastServerReceiptEchoAt(): number | null { return this._lastServerReceiptEchoAt; }
	get lastKnownServerReceiptEchoAt(): number | null { return this._lastKnownServerReceiptEchoAt; }
	get candidatePersistenceHealthy(): boolean { return this._candidatePersistenceHealthy; }
	get candidatePersistenceFailureCount(): number { return this._candidatePersistenceFailureCount; }
	get hasUnconfirmedCandidate(): boolean {
		return (
			this._lastUnconfirmedCandidateSv !== null &&
			this._serverAppliedLocalState !== true
		);
	}
	get candidateCapturedAt(): number | null { return this._candidateCapturedAt; }
	get lastCandidateId(): string | null { return this._lastCandidateId; }
	get lastConfirmedCandidateId(): string | null { return this._lastConfirmedCandidateId; }

	getState(): ServerAckState {
		return {
			serverAppliedLocalState: this._serverAppliedLocalState,
			lastServerReceiptEchoAt: this._lastServerReceiptEchoAt,
			lastKnownServerReceiptEchoAt: this._lastKnownServerReceiptEchoAt,
			candidatePersistenceHealthy: this._candidatePersistenceHealthy,
			candidatePersistenceFailureCount: this._candidatePersistenceFailureCount,
			hasUnconfirmedCandidate: this.hasUnconfirmedCandidate,
			candidateCapturedAt: this._candidateCapturedAt,
			receiptGuaranteeIsDurable: this.receiptGuaranteeIsDurable,
			serverPersistenceDegraded: this._serverPersistenceDegraded,
		};
	}

	async clearLocalReceiptState(clearStore = true): Promise<void> {
		this._generationAtCapture = null;
		this._lastUnconfirmedCandidateSv = null;
		this._candidateCapturedAt = null;
		this._serverAppliedLocalState = null;
		this._lastServerReceiptEchoAt = null;
		this._lastKnownServerReceiptEchoAt = null;
		this._candidatePersistenceFailureCount = 0;
		if (clearStore && this._store) {
			// Enqueue the clear through the same persistence chain so it
			// cannot race with in-flight saves. A slow save that lands
			// after a direct clear would resurrect stale state.
			await this._enqueuePersistence(async () => {
				await this._store!.clear();
			});
		}
	}

	// ── Private ──────────────────────────────────────────────────────────────

	private _computeSvHash(sv: Uint8Array): string {
		// Short non-cryptographic fingerprint for correlation only.
		return toHex8(fnv1a32Bytes(sv));
	}

	private _validateCandidateAgainstDoc(): void {
		if (!this._lastUnconfirmedCandidateSv || !this._encodeStateVector) return;
		const currentSv = this._encodeStateVector();
		const docDominatesCandidate = isStateVectorGe(currentSv, this._lastUnconfirmedCandidateSv);
		const candidateDominatesDoc = isStateVectorGe(this._lastUnconfirmedCandidateSv, currentSv);

		if (docDominatesCandidate && candidateDominatesDoc) {
			// Equal — candidate is valid; wait for fresh echo.
			this.trace?.("receipt", "receipt-startup-candidate-validation", {
				outcome: "equal",
			});
			return;
		}

		if (docDominatesCandidate && !candidateDominatesDoc) {
			// Local doc advanced past candidate (e.g. IDB crash gap, merged offline edits).
			// Replace candidate with current doc SV and mark unconfirmed.
			// This is conservative: the new candidate may include remote state, but the
			// server dominance check prevents that from producing a false true.
			this._lastUnconfirmedCandidateSv = currentSv;
			this._candidateCapturedAt = Date.now();
			this._serverAppliedLocalState = false;
			this.trace?.("receipt", "receipt-startup-candidate-validation", {
				outcome: "doc-ahead-replaced",
				candidateBytes: currentSv.byteLength,
			});
			this._persistAsync();
			return;
		}

		// candidateAheadOfDoc or incomparable — discard, fail closed.
		this.trace?.("receipt", "receipt-startup-candidate-validation", {
			outcome: "discarded",
			candidateAheadOfDoc: candidateDominatesDoc && !docDominatesCandidate,
		});
		this._lastUnconfirmedCandidateSv = null;
		this._candidateCapturedAt = null;
		this._serverAppliedLocalState = null;
		this._persistAsync();
	}

	private _persistChain: Promise<void> = Promise.resolve();

	/**
	 * Enqueue a persistence operation through the shared chain.
	 * ALL persistence mutations (saves AND clears) MUST go through this
	 * helper to prevent out-of-order completions. The operation is wrapped
	 * in try/catch so the chain promise never rejects — preventing a single
	 * IndexedDB failure from permanently poisoning all subsequent writes.
	 */
	private _enqueuePersistence(op: () => Promise<void>): Promise<void> {
		this._persistChain = this._persistChain.then(async () => {
			try {
				await op();
				if (!this._candidatePersistenceHealthy) {
					this._candidatePersistenceHealthy = true;
				}
			} catch {
				this._candidatePersistenceFailureCount++;
				this._candidatePersistenceHealthy = false;
			}
		});
		return this._persistChain;
	}

	/** Wait for all queued persistence writes to complete. */
	async flushReceiptPersistence(): Promise<void> {
		await this._persistChain;
	}

	/** Exposed for tests: wait for all queued persistence writes to complete. */
	async _flushPersistence(): Promise<void> {
		await this.flushReceiptPersistence();
	}

	private _persistAsync(): void {
		if (!this._store || !this._scope) return;
		// Serialize persistence writes through a promise chain to prevent
		// out-of-order completions from clobbering newer state with older state.
		const state: PersistedCandidateState = {
			schema: 1,
			...this._scope,
			candidateSvBase64: this._lastUnconfirmedCandidateSv
				? encodeBytesBase64(this._lastUnconfirmedCandidateSv)
				: null,
			candidateCapturedAt: this._candidateCapturedAt,
			lastKnownServerReceiptEchoAt: this._lastKnownServerReceiptEchoAt,
		};
		void this._enqueuePersistence(async () => {
			await this._store!.save(state);
		});
	}
}
