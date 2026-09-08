import * as Y from "yjs";
import type { StoredBodyCandidate, StoredDocument, StoredSemanticEpochReplacement } from "./vaultIndexedDb";
import {
	BodyCoordinator,
	type BodyLease,
	type BodyRevisionToken,
} from "./bodyCoordinator";
import { RuntimeScope } from "../runtime/operationLifecycle";
import { INITIAL_SEMANTIC_EPOCH, parseSemanticEpoch, type SemanticEpoch } from "@shared/semanticEpoch";
import type { ReadySemanticEpochTransition } from "./semanticEpochTransition";
import {
	BODY_RESIDENCY_ESTIMATOR_VERSION,
	EMPTY_BODY_EXTERNAL_RESOURCE_SIGNALS,
	EMPTY_SHARED_RESIDENCY_RESOURCE_SIGNALS,
	estimateColdLoadAdmission,
	estimateSharedResidencyBytes,
	estimateReconstructionReservation,
	measureBodyResidency,
	normalizeBodyExternalResourceSignals,
	normalizeSharedResidencyResourceSignals,
	numericDistribution,
	type BodyEvictionBlocker,
	type BodyExternalResourceSignals,
	type BodyResidencyMeasurement,
	type BodyResidencySnapshot,
	type ColdLoadAdmissionEstimate,
	type SharedResidencyResourceSignals,
	type TemporaryResidencyKind,
	type TemporaryResidencyReservation,
} from "./bodyResidencyAccounting";
export const DEFAULT_BODY_ESTIMATED_COST_BUDGET = 48 * 1024 * 1024;

export interface DocumentStore {
	getDocument(documentId: string): Promise<StoredDocument | null>;
	putDocument(document: StoredDocument): Promise<void>;
	replaceBodySemanticEpoch?(replacement: StoredSemanticEpochReplacement): Promise<void>;
}

export interface BodyCostInput {
	bodyId: string;
	doc: Y.Doc;
	encodedBytes: number;
	measurement: BodyResidencyMeasurement;
}

export interface BodyCostChange {
	bodyId: string;
	previousCost: number;
	currentCost: number;
}

export interface BodyCostAccountingHooks {
	measure?: (input: BodyCostInput) => number;
	onChange?: (change: BodyCostChange) => void;
}

export interface BodyManagerLimits {
	estimatedCost: number;
}

export interface BodyTemporaryReservationLease {
	readonly reservation: TemporaryResidencyReservation;
	readonly released: boolean;
	release(): void;
}

const DEFAULT_BODY_MANAGER_LIMITS: BodyManagerLimits = {
	estimatedCost: DEFAULT_BODY_ESTIMATED_COST_BUDGET,
};

export interface LoadedBody {
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	durableBaseline: string;
	doc: Y.Doc;
	generation: number;
	dirty: boolean;
	unsettled: number;
	pendingLocalUpdates: number;
	pins: number;
	lastUsedAt: number;
	estimatedCost: number;
	residencyMeasurement: BodyResidencyMeasurement;
}

/** Explicit body lifecycle and clean-only eviction for the canonical vault. */
export class BodyManager {
	private readonly loaded = new Map<string, LoadedBody>();
	private readonly loading = new Map<string, Promise<LoadedBody>>();
	private readonly updateObservers = new Map<string, (update: Uint8Array, origin: unknown) => void>();
	private readonly externalResourceSignals = new Map<string, BodyExternalResourceSignals>();
	private readonly temporaryReservations = new Map<string, TemporaryResidencyReservation>();
	private admissionTail: Promise<void> = Promise.resolve();
	private nextReservationId = 0;
	private sharedResourceSignals = EMPTY_SHARED_RESIDENCY_RESOURCE_SIGNALS;
	private loadRequests = 0;
	private loadCacheHits = 0;
	private loadJoinedInFlight = 0;
	private coldLoads = 0;
	private loadFailures = 0;
	private readonly loadLatenciesMs: number[] = [];
	private completedEvictions = 0;
	private blockedEvictionAttempts = 0;
	private readonly blockerObservations = new Map<BodyEvictionBlocker, number>();
	private highWaterResidentBytes = 0;
	private highWaterAccountedBytes = 0;
	private highWaterLoadedBodies = 0;

	constructor(
		private readonly database: DocumentStore,
		private readonly now: () => number = Date.now,
		private readonly costHooks: BodyCostAccountingHooks = {},
		private readonly limits: BodyManagerLimits = DEFAULT_BODY_MANAGER_LIMITS,
		readonly coordinator: BodyCoordinator = new BodyCoordinator(new RuntimeScope()),
	) {
		if (!Number.isSafeInteger(limits.estimatedCost) || limits.estimatedCost < 0) {
			throw new Error("body estimated-cost limit must be a non-negative safe integer");
		}
	}

	async load(bodyId: string): Promise<LoadedBody> {
		this.loadRequests++;
		const existing = this.loaded.get(bodyId);
		if (existing) {
			this.loadCacheHits++;
			existing.lastUsedAt = this.now();
			return existing;
		}
		const inFlight = this.loading.get(bodyId);
		if (inFlight) {
			this.loadJoinedInFlight++;
			return inFlight;
		}
		this.coldLoads++;
		const startedAt = this.now();
		this.coordinator.setResidency(bodyId, "loading");
		const run = this.loadFresh(bodyId);
		this.loading.set(bodyId, run);
		try {
			return await run;
		} catch (error) {
			this.loadFailures++;
			if (!this.loaded.has(bodyId) && this.coordinator.snapshot(bodyId)?.lifetime === "accepting") {
				this.coordinator.setResidency(bodyId, "absent");
			}
			throw error;
		} finally {
			this.recordLoadLatency(Math.max(0, this.now() - startedAt));
			this.loading.delete(bodyId);
		}
	}

	pin(bodyId: string): void {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		body.pins++;
		body.lastUsedAt = this.now();
	}

	unpin(bodyId: string): void {
		const body = this.loaded.get(bodyId);
		if (!body) return;
		body.pins = Math.max(0, body.pins - 1);
		body.lastUsedAt = this.now();
	}

	async markLocalUpdate(bodyId: string): Promise<void> {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		body.pendingLocalUpdates++;
		body.dirty = true;
		this.coordinator.setSynchronization(bodyId, "locally-pending");
		body.lastUsedAt = this.now();
		await this.persist(body);
	}

	async markDirty(bodyId: string): Promise<void> {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		body.dirty = true;
		this.coordinator.setSynchronization(bodyId, "locally-pending");
		body.lastUsedAt = this.now();
		await this.persist(body);
	}

	markUnsettled(bodyId: string): void {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		body.unsettled++;
		body.dirty = true;
		this.coordinator.setSynchronization(bodyId, "durably-pending");
		body.lastUsedAt = this.now();
	}

	async markCandidateSettled(
		bodyId: string,
		bodyEpoch: SemanticEpoch,
		generation: number,
		capturedLocalUpdates = 0,
	): Promise<void> {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		if (body.bodyEpoch !== parseSemanticEpoch(bodyEpoch, "receipt body epoch")) {
			throw new Error(`candidate receipt crossed the semantic epoch for ${bodyId}`);
		}
		body.generation = Math.max(body.generation, generation);
		body.unsettled = Math.max(0, body.unsettled - 1);
		body.pendingLocalUpdates = Math.max(
			0,
			body.pendingLocalUpdates - capturedLocalUpdates,
		);
		body.dirty = body.unsettled > 0 || body.pendingLocalUpdates > 0;
		if (!body.dirty) body.durableBaseline = body.doc.getText("body").toJSON();
		this.coordinator.setSynchronization(
			bodyId,
			body.dirty ? "durably-pending" : "clean",
		);
		body.lastUsedAt = this.now();
		await this.persist(body);
	}

	/** Atomically adopts a fresh epoch document prepared without old Yjs identities. */
	async installSemanticEpochTransition(
		transition: ReadySemanticEpochTransition,
		generation: number,
		candidate: StoredBodyCandidate | null,
	): Promise<LoadedBody> {
		return this.withAdmission(async () => {
			const prior = this.loaded.get(transition.bodyId);
			if (!prior) throw new Error(`body ${transition.bodyId} is not loaded`);
			if (transition.bodyEpoch <= prior.bodyEpoch) throw new Error(`stale semantic epoch for body ${transition.bodyId}`);
			const coordination = this.coordinator.snapshot(transition.bodyId);
			if ((coordination?.leaseCount ?? 0) > 0 || prior.pins > 0) {
				throw new Error(`cannot replace leased or pinned body ${transition.bodyId} across semantic epoch`);
			}
			const encoded = Y.encodeStateAsUpdate(transition.document);
			const next = this.measureCost(transition.bodyId, transition.document, encoded.byteLength);
			if (!await this.ensureEstimatedCostCapacity(transition.bodyId, next.cost)) {
				throw new Error("body_estimated_cost_budget");
			}
			const hasPendingRebase = candidate !== null;
			if (hasPendingRebase !== (transition.rebasedUpdate !== null)
				|| (candidate && (candidate.bodyId !== transition.bodyId || candidate.bodyEpoch !== transition.bodyEpoch))) {
				throw new Error("semantic epoch candidate does not match prepared transition");
			}
			const replacement: LoadedBody = {
				bodyId: transition.bodyId,
				bodyEpoch: transition.bodyEpoch,
				durableBaseline: transition.authoritativeContent,
				doc: transition.document,
				generation,
				dirty: hasPendingRebase,
				unsettled: hasPendingRebase ? 1 : 0,
				pendingLocalUpdates: candidate?.capturedLocalUpdates ?? 0,
				pins: 0,
				lastUsedAt: this.now(),
				estimatedCost: next.cost,
				residencyMeasurement: next.measurement,
			};
			const storedDocument: Extract<StoredDocument, { kind: "body" }> = {
				kind: "body",
				documentId: replacement.bodyId,
				bodyEpoch: replacement.bodyEpoch,
				durableBaseline: replacement.durableBaseline,
				generation: replacement.generation,
				encodedState: encoded.slice().buffer,
				dirty: replacement.dirty,
				pendingLocalUpdates: replacement.pendingLocalUpdates,
				updatedAt: this.now(),
			};
			if (!this.database.replaceBodySemanticEpoch) {
				throw new Error("atomic semantic epoch persistence is unavailable");
			}
			await this.database.replaceBodySemanticEpoch({ document: storedDocument, candidate });
			this.detachUpdateObserver(prior);
			this.loaded.set(replacement.bodyId, replacement);
			this.coordinator.installSemanticEpoch(replacement.bodyId, replacement.bodyEpoch);
			this.attachUpdateObserver(replacement);
			this.coordinator.setSynchronization(replacement.bodyId, hasPendingRebase ? "locally-pending" : "clean");
			this.coordinator.setResidency(replacement.bodyId, "warm");
			prior.doc.destroy();
			if (prior.estimatedCost !== replacement.estimatedCost) {
				this.costHooks.onChange?.({
					bodyId: replacement.bodyId,
					previousCost: prior.estimatedCost,
					currentCost: replacement.estimatedCost,
				});
			}
			this.updateHighWater();
			return replacement;
		});
	}


	async mergeFromServer(
		bodyId: string,
		encodedState: Uint8Array,
		bodyEpoch: SemanticEpoch,
		generation: number,
	): Promise<LoadedBody> {
		const body = await this.load(bodyId);
		if (body.bodyEpoch !== parseSemanticEpoch(bodyEpoch, "server body epoch")) {
			throw new Error(`cannot merge a different semantic epoch into body ${bodyId}`);
		}
		return this.withAdmission(async () => {
			const current = this.loaded.get(bodyId);
			if (!current || current !== body) throw new Error(`body ${bodyId} changed while merging server state`);
			const scratch = this.reserveTemporary(
				"server-reconstruction",
				bodyId,
				estimateReconstructionReservation(encodedState.byteLength, body.residencyMeasurement),
			);
			const candidate = new Y.Doc({ guid: bodyId });
			try {
				Y.applyUpdate(candidate, Y.encodeStateAsUpdate(body.doc), "budget-baseline");
				if (encodedState.byteLength > 0) Y.applyUpdate(candidate, encodedState, "server-catch-up");
				const candidateState = Y.encodeStateAsUpdate(candidate);
				const next = this.measureCost(bodyId, candidate, candidateState.byteLength);
				if (!await this.ensureEstimatedCostCapacity(bodyId, next.cost)) {
					throw new Error("body_estimated_cost_budget");
				}
				if (encodedState.byteLength > 0) Y.applyUpdate(body.doc, encodedState, "server-catch-up");
				body.generation = Math.max(body.generation, generation);
				body.lastUsedAt = this.now();
				await this.persist(body);
				return body;
			} finally {
				candidate.destroy();
				scratch.release();
			}
		});
	}

	async replaceFromServer(
		bodyId: string,
		encodedState: Uint8Array,
		bodyEpoch: SemanticEpoch,
		generation: number,
	): Promise<LoadedBody> {
		return this.withAdmission(async () => {
			const nextBodyEpoch = parseSemanticEpoch(bodyEpoch, "server body epoch");
			const prior = this.loaded.get(bodyId);
			if (prior && nextBodyEpoch < prior.bodyEpoch) throw new Error(`stale semantic epoch for body ${bodyId}`);
			const coordination = this.coordinator.snapshot(bodyId);
			if (
				prior?.dirty
					|| (prior?.unsettled ?? 0) > 0
					|| (prior?.pendingLocalUpdates ?? 0) > 0
					|| (prior?.pins ?? 0) > 0
					|| (coordination?.leaseCount ?? 0) > 0
			) {
				throw new Error(`cannot replace dirty, unsettled, pending, or pinned body ${bodyId}`);
			}
			const priorRevision = prior ? this.coordinator.setResidency(bodyId, "evicting") : null;
			const scratch = this.reserveTemporary(
				"server-replacement",
				bodyId,
				estimateReconstructionReservation(encodedState.byteLength),
			);
			const doc = new Y.Doc({ guid: bodyId });
			try {
				if (encodedState.byteLength > 0) Y.applyUpdate(doc, encodedState, "server-bootstrap");
				const canonicalState = Y.encodeStateAsUpdate(doc);
				const next = this.measureCost(bodyId, doc, canonicalState.byteLength);
				if (!await this.ensureEstimatedCostCapacity(bodyId, next.cost)) {
					throw new Error("body_estimated_cost_budget");
				}
				const current = this.loaded.get(bodyId);
				const currentCoordination = this.coordinator.snapshot(bodyId);
				if (prior && (
					current !== prior
					|| !priorRevision
					|| !this.coordinator.isContentCurrent(priorRevision)
					|| prior.dirty
					|| prior.unsettled > 0
					|| prior.pendingLocalUpdates > 0
					|| prior.pins > 0
					|| (currentCoordination?.leaseCount ?? 0) > 0
				)) throw new Error(`body ${bodyId} changed while preparing replacement`);
				const body: LoadedBody = {
					bodyId,
					bodyEpoch: nextBodyEpoch,
					durableBaseline: doc.getText("body").toJSON(),
					doc,
					generation,
					dirty: false,
					unsettled: 0,
					pendingLocalUpdates: 0,
					pins: 0,
					lastUsedAt: this.now(),
					estimatedCost: next.cost,
					residencyMeasurement: next.measurement,
				};
				await this.database.putDocument({
					kind: "body",
					documentId: bodyId,
					bodyEpoch: nextBodyEpoch,
					durableBaseline: body.durableBaseline,
					generation,
					encodedState: canonicalState.slice().buffer,
					dirty: false,
					pendingLocalUpdates: 0,
					updatedAt: this.now(),
				});
				if (prior) this.detachUpdateObserver(prior);
				this.loaded.set(bodyId, body);
				if (nextBodyEpoch > (prior?.bodyEpoch ?? INITIAL_SEMANTIC_EPOCH)) {
					this.coordinator.installSemanticEpoch(bodyId, nextBodyEpoch);
				} else {
					this.coordinator.installDocument(bodyId);
				}
				this.attachUpdateObserver(body);
				this.coordinator.setResidency(bodyId, "warm");
				prior?.doc.destroy();
				const previousCost = prior?.estimatedCost ?? 0;
				if (previousCost !== next.cost) {
					this.costHooks.onChange?.({ bodyId, previousCost, currentCost: next.cost });
				}
				this.updateHighWater();
				return body;
			} catch (error) {
				if (prior && this.loaded.get(bodyId) === prior
					&& this.coordinator.snapshot(bodyId)?.lifetime === "accepting") {
					this.coordinator.setResidency(bodyId, "warm");
				}
				doc.destroy();
				throw error;
			} finally {
				scratch.release();
			}
		});
	}

	async promoteExactGeneration(
		bodyId: string,
		expectedDoc: Y.Doc,
		expectedRevision: BodyRevisionToken,
		generation: number,
	): Promise<boolean> {
		return this.withAdmission(async () => {
			const body = this.loaded.get(bodyId);
			if (!body || body.doc !== expectedDoc || !this.coordinator.isContentCurrent(expectedRevision)) return false;
			body.generation = Math.max(body.generation, generation);
			body.lastUsedAt = this.now();
			await this.persist(body);
			return this.loaded.get(bodyId) === body
				&& body.doc === expectedDoc
				&& this.coordinator.isContentCurrent(expectedRevision);
		});
	}

	async evict(bodyId: string, expectedRevision?: BodyRevisionToken): Promise<boolean> {
		const body = this.loaded.get(bodyId);
		if (!body) return true;
		if (expectedRevision && !this.isRevisionCurrent(expectedRevision)) return false;
		const blockers = this.evictionBlockers(body);
		if (blockers.length > 0) {
			this.blockedEvictionAttempts++;
			for (const blocker of blockers) {
				this.blockerObservations.set(blocker, (this.blockerObservations.get(blocker) ?? 0) + 1);
			}
			return false;
		}
		this.coordinator.setResidency(bodyId, "evicting");
		await this.persist(body);
		if ((expectedRevision && !this.isRevisionCurrent(expectedRevision))
			|| this.evictionBlockers(body).length > 0) {
			if (this.coordinator.snapshot(bodyId)?.lifetime === "accepting") {
				this.coordinator.setResidency(bodyId, "warm");
			}
			return false;
		}
		this.removeLoaded(body);
		this.completedEvictions++;
		return true;
	}

	async evictLeastRecentlyUsed(maxLoaded: number): Promise<string[]> {
		if (maxLoaded < 0) throw new Error("maxLoaded must be non-negative");
		const evicted: string[] = [];
		const candidates = [...this.loaded.values()]
			.filter((body) =>
				!body.dirty
				&& body.unsettled === 0
				&& body.pendingLocalUpdates === 0
				&& body.pins === 0
			)
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
		while (this.loaded.size > maxLoaded && candidates.length > 0) {
			const body = candidates.shift()!;
			if (await this.evict(body.bodyId)) evicted.push(body.bodyId);
		}
		return evicted;
	}

	get(bodyId: string): LoadedBody | null {
		return this.loaded.get(bodyId) ?? null;
	}

	acquireLease(bodyId: string): BodyLease {
		if (!this.loaded.has(bodyId)) throw new Error(`body ${bodyId} is not loaded`);
		return this.coordinator.acquireLease(bodyId);
	}

	captureRevision(bodyId: string): BodyRevisionToken {
		if (!this.loaded.has(bodyId)) throw new Error(`body ${bodyId} is not loaded`);
		return this.coordinator.capture(bodyId);
	}

	isRevisionCurrent(token: BodyRevisionToken): boolean {
		return this.coordinator.isCurrent(token);
	}
	discardTransient(bodyId: string): void {
		const body = this.loaded.get(bodyId);
		if (!body) return;
		if (body.dirty || body.unsettled > 0 || body.pendingLocalUpdates > 0 || body.pins > 0) {
			throw new Error(`cannot discard active transient body ${bodyId}`);
		}
		this.removeLoaded(body);
	}


	stats(): {
		loaded: number;
		dirty: number;
		unsettled: number;
		pendingLocalUpdates: number;
		pinned: number;
		estimatedCost: number;
		estimatedCostLimit: number;
	} {
		let dirty = 0;
		let unsettled = 0;
		let pendingLocalUpdates = 0;
		let pinned = 0;
		let estimatedCost = 0;
		for (const body of this.loaded.values()) {
			if (body.dirty) dirty++;
			unsettled += body.unsettled;
			pendingLocalUpdates += body.pendingLocalUpdates;
			estimatedCost += body.estimatedCost;
			if (body.pins > 0) pinned++;
		}
		return {
			loaded: this.loaded.size,
			dirty,
			unsettled,
			pendingLocalUpdates,
			pinned,
			estimatedCost,
			estimatedCostLimit: this.limits.estimatedCost,
		};
	}

	setExternalResourceSignals(
		bodyId: string,
		input: Partial<BodyExternalResourceSignals>,
	): void {
		const signals = normalizeBodyExternalResourceSignals(input);
		const prior = this.externalResourceSignals.get(bodyId);
		if (prior && Object.keys(signals).every((key) =>
			prior[key as keyof BodyExternalResourceSignals] === signals[key as keyof BodyExternalResourceSignals]
		)) return;
		this.externalResourceSignals.set(bodyId, signals);
		const body = this.loaded.get(bodyId);
		if (!body) return;
		const encodedBytes = Y.encodeStateAsUpdate(body.doc).byteLength;
		const next = this.measureCost(bodyId, body.doc, encodedBytes);
		this.updateCost(body, next.cost, next.measurement);
	}

	clearExternalResourceSignals(bodyId: string): void {
		this.externalResourceSignals.delete(bodyId);
		const body = this.loaded.get(bodyId);
		if (!body) return;
		const encodedBytes = Y.encodeStateAsUpdate(body.doc).byteLength;
		const next = this.measureCost(bodyId, body.doc, encodedBytes);
		this.updateCost(body, next.cost, next.measurement);
	}

	setSharedResourceSignals(input: Partial<SharedResidencyResourceSignals>): void {
		this.sharedResourceSignals = normalizeSharedResidencyResourceSignals(input);
		this.updateHighWater();
	}

	reserveTemporary(
		kind: TemporaryResidencyKind,
		ownerId: string,
		estimatedBytes: number,
	): BodyTemporaryReservationLease {
		if (!ownerId) throw new Error("temporary residency reservation owner is required");
		if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) {
			throw new Error("temporary residency reservation must be a non-negative safe integer");
		}
		const reservationId = `residency-${++this.nextReservationId}`;
		const reservation: TemporaryResidencyReservation = {
			reservationId,
			kind,
			ownerId,
			estimatedBytes,
			createdAt: this.now(),
		};
		this.temporaryReservations.set(reservationId, reservation);
		this.updateHighWater();
		let released = false;
		return {
			reservation,
			get released() { return released; },
			release: () => {
				if (released) return;
				released = true;
				this.temporaryReservations.delete(reservationId);
			},
		};
	}

	residencySnapshot(): BodyResidencySnapshot {
		const bodies = [...this.loaded.values()].map((body) => {
			const measurement = body.residencyMeasurement;
			return {
				bodyId: body.bodyId,
				estimatedResidentBytes: body.estimatedCost,
				encodedDocumentBytes: measurement.encodedDocumentBytes,
				materializedTextCodeUnits: measurement.materializedTextCodeUnits,
				yjsStructCount: measurement.yjsStructCount,
				yjsDeletedStructCount: measurement.yjsDeletedStructCount,
				fragmentation: measurement.fragmentation,
				providerCount: measurement.external.providerCount,
				socketCount: measurement.external.socketCount,
				awarenessPeerCount: measurement.external.awarenessPeerCount,
				localPendingBufferBytes: measurement.external.localPendingBufferBytes,
				remotePendingBufferBytes: measurement.external.remotePendingBufferBytes,
				blockers: this.evictionBlockers(body),
			};
		});
		const residentBytes = this.estimatedCostTotal();
		const temporaryBytes = this.temporaryReservedTotal();
		const sharedReportedBytes = estimateSharedResidencyBytes(this.sharedResourceSignals);
		const accountedBytes = residentBytes + temporaryBytes + sharedReportedBytes;
		const blockedBodies = bodies.filter((body) => body.blockers.length > 0).length;
		return {
			formatVersion: 1,
			estimatorVersion: BODY_RESIDENCY_ESTIMATOR_VERSION,
			claim: "heuristic-resident-estimate-not-heap-measurement",
			capturedAt: this.now(),
			residentBudget: {
				bytes: this.limits.estimatedCost,
				scope: "body-resident-estimates-only",
				includesTemporaryReservations: false,
				includesSharedRootAndCatalog: false,
			},
			totals: {
				loadedBodies: bodies.length,
				loadingBodies: this.loading.size,
				estimatedResidentBytes: residentBytes,
				temporaryReservedBytes: temporaryBytes,
				sharedReportedBytes,
				accountedEstimatedBytes: accountedBytes,
				evictableBodies: bodies.length - blockedBodies,
				blockedBodies,
			},
			shared: { ...this.sharedResourceSignals, estimatedBytes: sharedReportedBytes },
			highWater: {
				estimatedResidentBytes: this.highWaterResidentBytes,
				accountedEstimatedBytes: this.highWaterAccountedBytes,
				loadedBodies: this.highWaterLoadedBodies,
			},
			loads: {
				requests: this.loadRequests,
				cacheHits: this.loadCacheHits,
				joinedInFlight: this.loadJoinedInFlight,
				coldLoads: this.coldLoads,
				failures: this.loadFailures,
				cacheHitRate: this.loadRequests === 0 ? null : this.loadCacheHits / this.loadRequests,
				latencyMs: numericDistribution(this.loadLatenciesMs),
			},
			evictions: {
				completed: this.completedEvictions,
				blockedAttempts: this.blockedEvictionAttempts,
				blockerObservations: Object.fromEntries(this.blockerObservations),
			},
			distributions: {
				estimatedResidentBytes: numericDistribution(bodies.map((body) => body.estimatedResidentBytes)),
				encodedDocumentBytes: numericDistribution(bodies.map((body) => body.encodedDocumentBytes)),
				yjsStructCount: numericDistribution(bodies.map((body) => body.yjsStructCount)),
				structsPerThousandTextCodeUnits: numericDistribution(
					bodies.map((body) => body.fragmentation.structsPerThousandTextCodeUnits),
				),
			},
			temporaryReservations: [...this.temporaryReservations.values()].map((reservation) => ({ ...reservation })),
			bodies,
			caveats: [
				"Estimated bytes are a versioned heuristic and are not process or JavaScript heap measurements.",
				"Encoded document bytes are a serialization-size proxy; a Y.Doc does not necessarily retain that encoding.",
				"Provider, socket, awareness, root/catalog, and candidate-buffer values are present only when their owner reports them.",
			],
		};
	}

	estimateColdLoadAdmission(encodedInputBytes: number): ColdLoadAdmissionEstimate {
		return estimateColdLoadAdmission(encodedInputBytes);
	}

	async estimateColdLoadForBody(bodyId: string): Promise<ColdLoadAdmissionEstimate> {
		const stored = await this.database.getDocument(bodyId);
		return estimateColdLoadAdmission(stored?.encodedState.byteLength ?? 0);
	}

	loadedBodyIds(): string[] {
		return [...this.loaded.keys()];
	}

	bodyResidencyObservation(bodyId: string): BodyResidencySnapshot["bodies"][number] | null {
		const body = this.residencySnapshot().bodies.find((entry) => entry.bodyId === bodyId);
		return body ? {
			...body,
			fragmentation: { ...body.fragmentation },
			blockers: [...body.blockers],
		} : null;
	}

	async destroy(): Promise<void> {
		this.coordinator.quiesce();
		for (const body of [...this.loaded.values()]) {
			await this.persist(body);
			this.removeLoaded(body);
		}
		this.loading.clear();
		this.temporaryReservations.clear();
		this.externalResourceSignals.clear();
		this.sharedResourceSignals = EMPTY_SHARED_RESIDENCY_RESOURCE_SIGNALS;
		this.coordinator.dispose();
	}

	private async loadFresh(bodyId: string): Promise<LoadedBody> {
		const stored = await this.database.getDocument(bodyId);
		if (stored && stored.kind !== "body") throw new Error(`non-body document cannot be loaded as body ${bodyId}`);
		return this.withAdmission(async () => {
			const winner = this.loaded.get(bodyId);
			if (winner) {
				winner.lastUsedAt = this.now();
				return winner;
			}
			const storedBytes = stored?.encodedState.byteLength ?? 0;
			const scratch = this.reserveTemporary(
				"load-decode",
				bodyId,
				estimateReconstructionReservation(storedBytes),
			);
			const doc = new Y.Doc({ guid: bodyId });
			try {
				if (stored?.encodedState.byteLength) {
					Y.applyUpdate(doc, new Uint8Array(stored.encodedState), "indexeddb-bootstrap");
				}
				const body: LoadedBody = {
					bodyId,
					bodyEpoch: stored?.bodyEpoch ?? INITIAL_SEMANTIC_EPOCH,
					durableBaseline: stored?.durableBaseline ?? "",
					doc,
					generation: stored?.generation ?? 0,
					dirty: stored?.dirty ?? false,
					unsettled: 0,
					pendingLocalUpdates: stored?.pendingLocalUpdates ?? 0,
					pins: 0,
					lastUsedAt: this.now(),
					estimatedCost: 0,
					residencyMeasurement: measureBodyResidency(doc, 0),
				};
				const encodedBytes = Y.encodeStateAsUpdate(doc).byteLength;
				const next = this.measureCost(bodyId, doc, encodedBytes);
				if (!await this.ensureEstimatedCostCapacity(bodyId, next.cost)) {
					throw new Error("body_estimated_cost_budget");
				}
				this.loaded.set(bodyId, body);
				if (body.bodyEpoch > INITIAL_SEMANTIC_EPOCH) {
					this.coordinator.installSemanticEpoch(bodyId, body.bodyEpoch);
				} else {
					this.coordinator.installDocument(bodyId);
				}
				this.attachUpdateObserver(body);
				this.coordinator.setResidency(bodyId, "warm");
				this.updateCost(body, next.cost, next.measurement);
				return body;
			} catch (error) {
				doc.destroy();
				throw error;
			} finally {
				scratch.release();
			}
		});
	}

	private async persist(body: LoadedBody): Promise<void> {
		const scratch = this.reserveTemporary(
			"persistence-encode",
			body.bodyId,
			Math.max(1024, body.residencyMeasurement.encodedDocumentBytes),
		);
		try {
			const encoded = Y.encodeStateAsUpdate(body.doc);
			const next = this.measureCost(body.bodyId, body.doc, encoded.byteLength);
			await this.database.putDocument({
				kind: "body",
				documentId: body.bodyId,
				bodyEpoch: body.bodyEpoch,
				durableBaseline: body.durableBaseline,
				generation: body.generation,
				encodedState: encoded.slice().buffer,
				dirty: body.dirty,
				pendingLocalUpdates: body.pendingLocalUpdates,
				updatedAt: this.now(),
			});
			this.updateCost(body, next.cost, next.measurement);
		} finally {
			scratch.release();
		}
	}

	private measureCost(
		bodyId: string,
		doc: Y.Doc,
		encodedBytes: number,
	): { measurement: BodyResidencyMeasurement; cost: number } {
		const measurement = measureBodyResidency(
			doc,
			encodedBytes,
			this.externalResourceSignals.get(bodyId) ?? EMPTY_BODY_EXTERNAL_RESOURCE_SIGNALS,
		);
		const measured = this.costHooks.measure?.({ bodyId, doc, encodedBytes, measurement })
			?? measurement.estimatedResidentBytes;
		if (!Number.isFinite(measured) || measured < 0) {
			throw new Error(`body ${bodyId} cost must be a non-negative finite number`);
		}
		return { measurement, cost: measured };
	}

	private async ensureEstimatedCostCapacity(bodyId: string, incomingCost: number): Promise<boolean> {
		if (incomingCost > this.limits.estimatedCost) return false;
		const replacingCost = this.loaded.get(bodyId)?.estimatedCost ?? 0;
		const candidates = [...this.loaded.values()]
			.filter((body) => body.bodyId !== bodyId
				&& !body.dirty
				&& body.unsettled === 0
				&& body.pendingLocalUpdates === 0
				&& body.pins === 0)
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
		while (this.estimatedCostTotal() - replacingCost + incomingCost > this.limits.estimatedCost
			&& candidates.length > 0) {
			const candidate = candidates.shift()!;
			await this.persist(candidate);
			this.removeLoaded(candidate);
		}
		return this.estimatedCostTotal() - replacingCost + incomingCost <= this.limits.estimatedCost;
	}

	private estimatedCostTotal(): number {
		let total = 0;
		for (const body of this.loaded.values()) total += body.estimatedCost;
		return total;
	}

	private async withAdmission<T>(operation: () => Promise<T>): Promise<T> {
		const prior = this.admissionTail;
		let release!: () => void;
		this.admissionTail = new Promise<void>((resolve) => { release = resolve; });
		await prior;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private updateCost(
		body: LoadedBody,
		currentCost: number,
		measurement: BodyResidencyMeasurement,
	): void {
		const previousCost = body.estimatedCost;
		body.estimatedCost = currentCost;
		body.residencyMeasurement = measurement;
		if (previousCost !== currentCost) {
			this.costHooks.onChange?.({ bodyId: body.bodyId, previousCost, currentCost });
		}
		this.updateHighWater();
	}

	private removeLoaded(body: LoadedBody): void {
		this.loaded.delete(body.bodyId);
		this.externalResourceSignals.delete(body.bodyId);
		this.detachUpdateObserver(body);
		body.doc.destroy();
		if (this.coordinator.snapshot(body.bodyId)?.lifetime === "accepting") {
			this.coordinator.setResidency(body.bodyId, "absent");
		}
		if (body.estimatedCost !== 0) {
			this.costHooks.onChange?.({
				bodyId: body.bodyId,
				previousCost: body.estimatedCost,
				currentCost: 0,
			});
			body.estimatedCost = 0;
		}
		this.updateHighWater();
	}

	private temporaryReservedTotal(): number {
		let total = 0;
		for (const reservation of this.temporaryReservations.values()) total += reservation.estimatedBytes;
		return total;
	}

	private evictionBlockers(body: LoadedBody): BodyEvictionBlocker[] {
		const blockers: BodyEvictionBlocker[] = [];
		if (body.dirty) blockers.push("dirty");
		if (body.unsettled > 0) blockers.push("unsettled-candidate");
		if (body.pendingLocalUpdates > 0) blockers.push("pending-local-update");
		if (body.pins > 0) blockers.push("pin");
		const coordinator = this.coordinator.snapshot(body.bodyId);
		if ((coordinator?.leaseCount ?? 0) > 0) blockers.push("lease");
		if (coordinator?.projectionOwner != null) blockers.push("projection-owner");
		if (coordinator && coordinator.synchronization !== "clean") blockers.push("synchronization");
		if (coordinator && coordinator.lifetime !== "accepting") blockers.push("runtime-lifetime");
		return blockers;
	}

	private recordLoadLatency(latencyMs: number): void {
		this.loadLatenciesMs.push(latencyMs);
		if (this.loadLatenciesMs.length > 256) this.loadLatenciesMs.shift();
	}

	private updateHighWater(): void {
		const resident = this.estimatedCostTotal();
		const accounted = resident
			+ this.temporaryReservedTotal()
			+ estimateSharedResidencyBytes(this.sharedResourceSignals);
		this.highWaterResidentBytes = Math.max(this.highWaterResidentBytes, resident);
		this.highWaterAccountedBytes = Math.max(this.highWaterAccountedBytes, accounted);
		this.highWaterLoadedBodies = Math.max(this.highWaterLoadedBodies, this.loaded.size);
	}

	private attachUpdateObserver(body: LoadedBody): void {
		const observer = () => {
			this.coordinator.advanceContent(body.bodyId);
		};
		body.doc.on("update", observer);
		this.updateObservers.set(body.bodyId, observer);
	}

	private detachUpdateObserver(body: LoadedBody): void {
		const observer = this.updateObservers.get(body.bodyId);
		if (!observer) return;
		body.doc.off("update", observer);
		this.updateObservers.delete(body.bodyId);
	}
}
