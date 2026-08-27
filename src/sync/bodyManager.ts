import * as Y from "yjs";
import type { StoredDocument } from "./vaultIndexedDb";
export const DEFAULT_BODY_ESTIMATED_COST_BUDGET = 48 * 1024 * 1024;

export interface DocumentStore {
	getDocument(documentId: string): Promise<StoredDocument | null>;
	putDocument(document: StoredDocument): Promise<void>;
}

export interface BodyCostInput {
	bodyId: string;
	doc: Y.Doc;
	encodedBytes: number;
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

const DEFAULT_BODY_MANAGER_LIMITS: BodyManagerLimits = {
	estimatedCost: DEFAULT_BODY_ESTIMATED_COST_BUDGET,
};

export interface LoadedBody {
	bodyId: string;
	doc: Y.Doc;
	generation: number;
	dirty: boolean;
	unsettled: number;
	pendingLocalUpdates: number;
	pins: number;
	lastUsedAt: number;
	estimatedCost: number;
}

/** Explicit body lifecycle and clean-only eviction for the canonical vault. */
export class BodyManager {
	private readonly loaded = new Map<string, LoadedBody>();
	private readonly loading = new Map<string, Promise<LoadedBody>>();
	private admissionTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly database: DocumentStore,
		private readonly now: () => number = Date.now,
		private readonly costHooks: BodyCostAccountingHooks = {},
		private readonly limits: BodyManagerLimits = DEFAULT_BODY_MANAGER_LIMITS,
	) {
		if (!Number.isSafeInteger(limits.estimatedCost) || limits.estimatedCost < 0) {
			throw new Error("body estimated-cost limit must be a non-negative safe integer");
		}
	}

	async load(bodyId: string): Promise<LoadedBody> {
		const existing = this.loaded.get(bodyId);
		if (existing) {
			existing.lastUsedAt = this.now();
			return existing;
		}
		const inFlight = this.loading.get(bodyId);
		if (inFlight) return inFlight;
		const run = this.loadFresh(bodyId);
		this.loading.set(bodyId, run);
		try {
			return await run;
		} finally {
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
		body.lastUsedAt = this.now();
		await this.persist(body);
	}

	async markDirty(bodyId: string): Promise<void> {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		body.dirty = true;
		body.lastUsedAt = this.now();
		await this.persist(body);
	}

	markUnsettled(bodyId: string): void {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		body.unsettled++;
		body.dirty = true;
		body.lastUsedAt = this.now();
	}

	async markCandidateSettled(
		bodyId: string,
		generation: number,
		capturedLocalUpdates = 0,
	): Promise<void> {
		const body = this.loaded.get(bodyId);
		if (!body) throw new Error(`body ${bodyId} is not loaded`);
		body.generation = Math.max(body.generation, generation);
		body.unsettled = Math.max(0, body.unsettled - 1);
		body.pendingLocalUpdates = Math.max(
			0,
			body.pendingLocalUpdates - capturedLocalUpdates,
		);
		body.dirty = body.unsettled > 0 || body.pendingLocalUpdates > 0;
		body.lastUsedAt = this.now();
		await this.persist(body);
	}


	async mergeFromServer(
		bodyId: string,
		encodedState: Uint8Array,
		generation: number,
	): Promise<LoadedBody> {
		const body = await this.load(bodyId);
		return this.withAdmission(async () => {
			const current = this.loaded.get(bodyId);
			if (!current || current !== body) throw new Error(`body ${bodyId} changed while merging server state`);
			const candidate = new Y.Doc({ guid: bodyId });
			try {
				Y.applyUpdate(candidate, Y.encodeStateAsUpdate(body.doc), "budget-baseline");
				if (encodedState.byteLength > 0) Y.applyUpdate(candidate, encodedState, "server-catch-up");
				const candidateState = Y.encodeStateAsUpdate(candidate);
				const nextCost = this.measureCost(bodyId, candidate, candidateState.byteLength);
				if (!await this.ensureEstimatedCostCapacity(bodyId, nextCost)) {
					throw new Error("body_estimated_cost_budget");
				}
				if (encodedState.byteLength > 0) Y.applyUpdate(body.doc, encodedState, "server-catch-up");
				body.generation = Math.max(body.generation, generation);
				body.lastUsedAt = this.now();
				await this.persist(body);
				return body;
			} finally {
				candidate.destroy();
			}
		});
	}

	async replaceFromServer(bodyId: string, encodedState: Uint8Array, generation: number): Promise<LoadedBody> {
		return this.withAdmission(async () => {
			const prior = this.loaded.get(bodyId);
			if (
				prior?.dirty
				|| (prior?.unsettled ?? 0) > 0
				|| (prior?.pendingLocalUpdates ?? 0) > 0
				|| (prior?.pins ?? 0) > 0
			) {
				throw new Error(`cannot replace dirty, unsettled, pending, or pinned body ${bodyId}`);
			}
			const doc = new Y.Doc({ guid: bodyId });
			try {
				if (encodedState.byteLength > 0) Y.applyUpdate(doc, encodedState, "server-bootstrap");
				const canonicalState = Y.encodeStateAsUpdate(doc);
				const nextCost = this.measureCost(bodyId, doc, canonicalState.byteLength);
				if (!await this.ensureEstimatedCostCapacity(bodyId, nextCost)) {
					throw new Error("body_estimated_cost_budget");
				}
				const body: LoadedBody = {
					bodyId,
					doc,
					generation,
					dirty: false,
					unsettled: 0,
					pendingLocalUpdates: 0,
					pins: 0,
					lastUsedAt: this.now(),
					estimatedCost: nextCost,
				};
				await this.database.putDocument({
					documentId: bodyId,
					generation,
					encodedState: canonicalState.slice().buffer,
					dirty: false,
					pendingLocalUpdates: 0,
					updatedAt: this.now(),
				});
				this.loaded.set(bodyId, body);
				prior?.doc.destroy();
				const previousCost = prior?.estimatedCost ?? 0;
				if (previousCost !== nextCost) {
					this.costHooks.onChange?.({ bodyId, previousCost, currentCost: nextCost });
				}
				return body;
			} catch (error) {
				doc.destroy();
				throw error;
			}
		});
	}

	async evict(bodyId: string): Promise<boolean> {
		const body = this.loaded.get(bodyId);
		if (!body) return true;
		if (
			body.dirty
			|| body.unsettled > 0
			|| body.pendingLocalUpdates > 0
			|| body.pins > 0
		) return false;
		await this.persist(body);
		this.removeLoaded(body);
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

	async destroy(): Promise<void> {
		for (const body of [...this.loaded.values()]) {
			await this.persist(body);
			this.removeLoaded(body);
		}
		this.loading.clear();
	}

	private async loadFresh(bodyId: string): Promise<LoadedBody> {
		const stored = await this.database.getDocument(bodyId);
		return this.withAdmission(async () => {
			const winner = this.loaded.get(bodyId);
			if (winner) {
				winner.lastUsedAt = this.now();
				return winner;
			}
			const doc = new Y.Doc({ guid: bodyId });
			try {
				if (stored?.encodedState.byteLength) {
					Y.applyUpdate(doc, new Uint8Array(stored.encodedState), "indexeddb-bootstrap");
				}
				const body: LoadedBody = {
					bodyId,
					doc,
					generation: stored?.generation ?? 0,
					dirty: stored?.dirty ?? false,
					unsettled: 0,
					pendingLocalUpdates: stored?.pendingLocalUpdates ?? 0,
					pins: 0,
					lastUsedAt: this.now(),
					estimatedCost: 0,
				};
				const encodedBytes = Y.encodeStateAsUpdate(doc).byteLength;
				const nextCost = this.measureCost(bodyId, doc, encodedBytes);
				if (!await this.ensureEstimatedCostCapacity(bodyId, nextCost)) {
					throw new Error("body_estimated_cost_budget");
				}
				this.loaded.set(bodyId, body);
				this.updateCost(body, nextCost);
				return body;
			} catch (error) {
				doc.destroy();
				throw error;
			}
		});
	}

	private async persist(body: LoadedBody): Promise<void> {
		const encoded = Y.encodeStateAsUpdate(body.doc);
		const nextCost = this.measureCost(body.bodyId, body.doc, encoded.byteLength);
		await this.database.putDocument({
			documentId: body.bodyId,
			generation: body.generation,
			encodedState: encoded.slice().buffer,
			dirty: body.dirty,
			pendingLocalUpdates: body.pendingLocalUpdates,
			updatedAt: this.now(),
		});
		this.updateCost(body, nextCost);
	}

	private measureCost(bodyId: string, doc: Y.Doc, encodedBytes: number): number {
		const measured = this.costHooks.measure?.({ bodyId, doc, encodedBytes }) ?? encodedBytes;
		if (!Number.isFinite(measured) || measured < 0) {
			throw new Error(`body ${bodyId} cost must be a non-negative finite number`);
		}
		return measured;
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

	private updateCost(body: LoadedBody, currentCost: number): void {
		const previousCost = body.estimatedCost;
		body.estimatedCost = currentCost;
		if (previousCost !== currentCost) {
			this.costHooks.onChange?.({ bodyId: body.bodyId, previousCost, currentCost });
		}
	}

	private removeLoaded(body: LoadedBody): void {
		this.loaded.delete(body.bodyId);
		body.doc.destroy();
		if (body.estimatedCost !== 0) {
			this.costHooks.onChange?.({
				bodyId: body.bodyId,
				previousCost: body.estimatedCost,
				currentCost: 0,
			});
			body.estimatedCost = 0;
		}
	}
}
