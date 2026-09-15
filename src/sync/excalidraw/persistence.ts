import type { StoredExcalidrawOutboxOperation, StoredExcalidrawProjection,
	StoredExcalidrawPromotionIntent, StoredExcalidrawProjectionPlan, StoredExcalidrawAlternative,
	StoredExcalidrawLifecycleIntent } from "./types";

export interface ExcalidrawPersistencePort {
	getProjection(drawingId: string): Promise<StoredExcalidrawProjection | null>;
	putProjection(projection: StoredExcalidrawProjection): Promise<void>;
	putOutbox(record: StoredExcalidrawOutboxOperation): Promise<void>;
	listOutbox(drawingId: string): Promise<StoredExcalidrawOutboxOperation[]>;
	markOutboxAttempt(operationId: string, attempts: number, lastAttemptAt: number): Promise<void>;
	deleteOutbox(operationId: string): Promise<void>;
	putPromotionIntent(intent: StoredExcalidrawPromotionIntent): Promise<void>;
	listPromotionIntents(): Promise<StoredExcalidrawPromotionIntent[]>;
	deletePromotionIntent(drawingId: string): Promise<void>;
	putProjectionPlan(plan: StoredExcalidrawProjectionPlan): Promise<void>;
	listProjectionPlans(): Promise<StoredExcalidrawProjectionPlan[]>;
	deleteProjectionPlan(operationId: string): Promise<void>;
	putAlternative(alternative: StoredExcalidrawAlternative): Promise<void>;
	listAlternatives(drawingId: string): Promise<StoredExcalidrawAlternative[]>;
	putLifecycleIntent(intent: StoredExcalidrawLifecycleIntent): Promise<void>;
	listLifecycleIntents(): Promise<StoredExcalidrawLifecycleIntent[]>;
	deleteLifecycleIntent(operationId: string): Promise<void>;
}

const PROJECTIONS = "projections";
const OUTBOX = "outbox";
const PROMOTIONS = "promotions";
const PROJECTION_PLANS = "projectionPlans";
const ALTERNATIVES = "alternatives";
const LIFECYCLE = "lifecycle";

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("Excalidraw IndexedDB request failed"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("Excalidraw IndexedDB transaction failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("Excalidraw IndexedDB transaction aborted"));
	});
}

function clone<T>(value: T): T { return structuredClone(value); }

/** Dedicated durable client cache; namespace it with the vault generation and local folder. */
export class ExcalidrawIndexedDbPersistence implements ExcalidrawPersistencePort {
	private readonly database: Promise<IDBDatabase>;

	constructor(databaseNamespace: string, indexedDb: IDBFactory = window.indexedDB) {
		if (!databaseNamespace.trim()) throw new Error("Excalidraw database namespace is required");
		this.database = new Promise((resolve, reject) => {
			const request = indexedDb.open(`${databaseNamespace}:excalidraw-rfc13`, 5);
			request.onupgradeneeded = (event) => {
				const database = request.result;
				if (event.oldVersion < 1) {
					database.createObjectStore(PROJECTIONS, { keyPath: "drawingId" });
					database.createObjectStore(OUTBOX, { keyPath: "operation.operationId" });
				}
				if (event.oldVersion < 2) database.createObjectStore(PROMOTIONS, { keyPath: "drawingId" });
				if (event.oldVersion < 3) database.createObjectStore(PROJECTION_PLANS, { keyPath: "operationId" });
				if (event.oldVersion < 4) database.createObjectStore(ALTERNATIVES, { keyPath: "alternativeId" });
				if (event.oldVersion < 5) database.createObjectStore(LIFECYCLE, { keyPath: "request.operationId" });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("Failed to open Excalidraw client cache"));
		});
	}

	async getProjection(drawingId: string): Promise<StoredExcalidrawProjection | null> {
		const database = await this.database;
		const transaction = database.transaction(PROJECTIONS, "readonly");
		const value = await requestValue(transaction.objectStore(PROJECTIONS).get(drawingId)) as StoredExcalidrawProjection | undefined;
		await transactionDone(transaction);
		return value ? clone(value) : null;
	}

	async putProjection(projection: StoredExcalidrawProjection): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(PROJECTIONS, "readwrite");
		transaction.objectStore(PROJECTIONS).put(clone(projection));
		await transactionDone(transaction);
	}

	async putOutbox(record: StoredExcalidrawOutboxOperation): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(OUTBOX, "readwrite");
		transaction.objectStore(OUTBOX).put(clone(record));
		await transactionDone(transaction);
	}

	async listOutbox(drawingId: string): Promise<StoredExcalidrawOutboxOperation[]> {
		const database = await this.database;
		const transaction = database.transaction(OUTBOX, "readonly");
		const values = await requestValue(transaction.objectStore(OUTBOX).getAll()) as StoredExcalidrawOutboxOperation[];
		await transactionDone(transaction);
		return values.filter((value) => value.drawingId === drawingId).map(clone).sort((left, right) => left.createdAt - right.createdAt
			|| left.operation.operationId.localeCompare(right.operation.operationId));
	}

	async markOutboxAttempt(operationId: string, attempts: number, lastAttemptAt: number): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(OUTBOX, "readwrite");
		const store = transaction.objectStore(OUTBOX);
		const value = await requestValue(store.get(operationId)) as StoredExcalidrawOutboxOperation | undefined;
		if (value) store.put({ ...value, attempts, lastAttemptAt });
		await transactionDone(transaction);
	}

	async deleteOutbox(operationId: string): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(OUTBOX, "readwrite");
		transaction.objectStore(OUTBOX).delete(operationId);
		await transactionDone(transaction);
	}

	async putPromotionIntent(intent: StoredExcalidrawPromotionIntent): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(PROMOTIONS, "readwrite");
		transaction.objectStore(PROMOTIONS).put(clone(intent));
		await transactionDone(transaction);
	}

	async listPromotionIntents(): Promise<StoredExcalidrawPromotionIntent[]> {
		const database = await this.database;
		const transaction = database.transaction(PROMOTIONS, "readonly");
		const values = await requestValue(transaction.objectStore(PROMOTIONS).getAll()) as StoredExcalidrawPromotionIntent[];
		await transactionDone(transaction);
		return values.map(clone).sort((left, right) => left.createdAt - right.createdAt);
	}

	async deletePromotionIntent(drawingId: string): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(PROMOTIONS, "readwrite");
		transaction.objectStore(PROMOTIONS).delete(drawingId);
		await transactionDone(transaction);
	}

	async putProjectionPlan(plan: StoredExcalidrawProjectionPlan): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(PROJECTION_PLANS, "readwrite");
		transaction.objectStore(PROJECTION_PLANS).put(clone(plan));
		await transactionDone(transaction);
	}

	async listProjectionPlans(): Promise<StoredExcalidrawProjectionPlan[]> {
		const database = await this.database;
		const transaction = database.transaction(PROJECTION_PLANS, "readonly");
		const values = await requestValue(transaction.objectStore(PROJECTION_PLANS).getAll()) as StoredExcalidrawProjectionPlan[];
		await transactionDone(transaction);
		return values.map(clone).sort((left, right) => left.createdAt - right.createdAt);
	}

	async deleteProjectionPlan(operationId: string): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(PROJECTION_PLANS, "readwrite");
		transaction.objectStore(PROJECTION_PLANS).delete(operationId);
		await transactionDone(transaction);
	}

	async putAlternative(alternative: StoredExcalidrawAlternative): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(ALTERNATIVES, "readwrite");
		transaction.objectStore(ALTERNATIVES).put(clone(alternative));
		await transactionDone(transaction);
	}

	async listAlternatives(drawingId: string): Promise<StoredExcalidrawAlternative[]> {
		const database = await this.database;
		const transaction = database.transaction(ALTERNATIVES, "readonly");
		const values = await requestValue(transaction.objectStore(ALTERNATIVES).getAll()) as StoredExcalidrawAlternative[];
		await transactionDone(transaction);
		return values.filter((value) => value.drawingId === drawingId).map(clone)
			.sort((left, right) => left.preservedAt - right.preservedAt);
	}

	async putLifecycleIntent(intent: StoredExcalidrawLifecycleIntent): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(LIFECYCLE, "readwrite");
		transaction.objectStore(LIFECYCLE).put(clone(intent));
		await transactionDone(transaction);
	}

	async listLifecycleIntents(): Promise<StoredExcalidrawLifecycleIntent[]> {
		const database = await this.database;
		const transaction = database.transaction(LIFECYCLE, "readonly");
		const values = await requestValue(transaction.objectStore(LIFECYCLE).getAll()) as StoredExcalidrawLifecycleIntent[];
		await transactionDone(transaction);
		return values.map(clone).sort((left, right) => left.createdAt - right.createdAt);
	}

	async deleteLifecycleIntent(operationId: string): Promise<void> {
		const database = await this.database;
		const transaction = database.transaction(LIFECYCLE, "readwrite");
		transaction.objectStore(LIFECYCLE).delete(operationId);
		await transactionDone(transaction);
	}
}

export class MemoryExcalidrawPersistence implements ExcalidrawPersistencePort {
	private readonly projections = new Map<string, StoredExcalidrawProjection>();
	private readonly outbox = new Map<string, StoredExcalidrawOutboxOperation>();
	private readonly promotions = new Map<string, StoredExcalidrawPromotionIntent>();
	private readonly projectionPlans = new Map<string, StoredExcalidrawProjectionPlan>();
	private readonly alternatives = new Map<string, StoredExcalidrawAlternative>();
	private readonly lifecycle = new Map<string, StoredExcalidrawLifecycleIntent>();
	async getProjection(drawingId: string): Promise<StoredExcalidrawProjection | null> {
		const value = this.projections.get(drawingId); return value ? clone(value) : null;
	}
	async putProjection(projection: StoredExcalidrawProjection): Promise<void> {
		this.projections.set(projection.drawingId, clone(projection));
	}
	async putOutbox(record: StoredExcalidrawOutboxOperation): Promise<void> {
		this.outbox.set(record.operation.operationId, clone(record));
	}
	async listOutbox(drawingId: string): Promise<StoredExcalidrawOutboxOperation[]> {
		return [...this.outbox.values()].filter((value) => value.drawingId === drawingId).map(clone)
			.sort((left, right) => left.createdAt - right.createdAt);
	}
	async markOutboxAttempt(operationId: string, attempts: number, lastAttemptAt: number): Promise<void> {
		const value = this.outbox.get(operationId);
		if (value) this.outbox.set(operationId, { ...value, attempts, lastAttemptAt });
	}
	async deleteOutbox(operationId: string): Promise<void> { this.outbox.delete(operationId); }
	async putPromotionIntent(intent: StoredExcalidrawPromotionIntent): Promise<void> {
		this.promotions.set(intent.drawingId, clone(intent));
	}
	async listPromotionIntents(): Promise<StoredExcalidrawPromotionIntent[]> {
		return [...this.promotions.values()].map(clone).sort((left, right) => left.createdAt - right.createdAt);
	}
	async deletePromotionIntent(drawingId: string): Promise<void> { this.promotions.delete(drawingId); }
	async putProjectionPlan(plan: StoredExcalidrawProjectionPlan): Promise<void> {
		this.projectionPlans.set(plan.operationId, clone(plan));
	}
	async listProjectionPlans(): Promise<StoredExcalidrawProjectionPlan[]> {
		return [...this.projectionPlans.values()].map(clone).sort((left, right) => left.createdAt - right.createdAt);
	}
	async deleteProjectionPlan(operationId: string): Promise<void> { this.projectionPlans.delete(operationId); }
	async putAlternative(alternative: StoredExcalidrawAlternative): Promise<void> {
		this.alternatives.set(alternative.alternativeId, clone(alternative));
	}
	async listAlternatives(drawingId: string): Promise<StoredExcalidrawAlternative[]> {
		return [...this.alternatives.values()].filter((value) => value.drawingId === drawingId).map(clone)
			.sort((left, right) => left.preservedAt - right.preservedAt);
	}
	async putLifecycleIntent(intent: StoredExcalidrawLifecycleIntent): Promise<void> {
		this.lifecycle.set(intent.request.operationId, clone(intent));
	}
	async listLifecycleIntents(): Promise<StoredExcalidrawLifecycleIntent[]> {
		return [...this.lifecycle.values()].map(clone).sort((left, right) => left.createdAt - right.createdAt);
	}
	async deleteLifecycleIntent(operationId: string): Promise<void> { this.lifecycle.delete(operationId); }
}
