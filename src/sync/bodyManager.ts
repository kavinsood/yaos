import * as Y from "yjs";
import type { StoredDocument } from "./vaultIndexedDb";
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
	/** Returns one body-local cost unit; aggregate policy is owned by the runtime. */
	measure?: (input: BodyCostInput) => number;
	onChange?: (change: BodyCostChange) => void;
}

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

	constructor(
		private readonly database: DocumentStore,
		private readonly now: () => number = Date.now,
		private readonly costHooks: BodyCostAccountingHooks = {},
	) {}

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
		if (encodedState.byteLength > 0) {
			Y.applyUpdate(body.doc, encodedState, "server-catch-up");
		}
		body.generation = Math.max(body.generation, generation);
		body.lastUsedAt = this.now();
		await this.persist(body);
		return body;
	}

	async replaceFromServer(bodyId: string, encodedState: Uint8Array, generation: number): Promise<LoadedBody> {
		const prior = this.loaded.get(bodyId);
		if (
			prior?.dirty
			|| (prior?.unsettled ?? 0) > 0
			|| (prior?.pendingLocalUpdates ?? 0) > 0
			|| (prior?.pins ?? 0) > 0
		) {
			throw new Error(`cannot replace dirty, unsettled, pending, or pinned body ${bodyId}`);
		}
		prior?.doc.destroy();
		const doc = new Y.Doc({ guid: bodyId });
		if (encodedState.byteLength > 0) Y.applyUpdate(doc, encodedState, "server-bootstrap");
		const body: LoadedBody = {
			bodyId,
			doc,
			generation,
			dirty: false,
			unsettled: 0,
			pendingLocalUpdates: 0,
			pins: prior?.pins ?? 0,
			lastUsedAt: this.now(),
			estimatedCost: 0,
		};
		this.loaded.set(bodyId, body);
		await this.persist(body);
		return body;
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
		const winner = this.loaded.get(bodyId);
		if (winner) {
			winner.lastUsedAt = this.now();
			return winner;
		}
		const doc = new Y.Doc({ guid: bodyId });
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
		this.loaded.set(bodyId, body);
		this.updateCost(
			body,
			this.measureCost(bodyId, doc, stored?.encodedState.byteLength ?? 0),
		);
		return body;
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
