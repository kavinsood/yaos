import { EXCALIDRAW_PROTOCOL_VERSION, MAX_EXCALIDRAW_BATCH_BYTES, MAX_EXCALIDRAW_BATCH_ELEMENTS,
	MAX_EXCALIDRAW_SCENE_ELEMENTS, canonicalExcalidrawJson, validateExcalidrawManifest } from "@shared/excalidrawProtocol";
import type { ExcalidrawHostSnapshot, ExcalidrawResourcesPort, ExcalidrawViewBinding } from "./host";
import { randomId } from "../../utils/randomId";
import { operationHash, revisionKey, revisionOf, validateExcalidrawElement } from "./canonical";
import type { ExcalidrawPersistencePort } from "./persistence";
import { expandExcalidrawDependencyClosure, reconcileExcalidrawElements, selectExcalidrawWinner } from "./reconcile";
import type { ExcalidrawTransportPort, ExcalidrawRoomSubscription } from "./transport";
import type { ExcalidrawBatchRequest, ExcalidrawResourceManifest, ExcalidrawRoomEvent,
	ExcalidrawSnapshot, StoredExcalidrawProjection } from "./types";
import type { PresenceClientUpdate, PresenceServerFrame } from "@shared/presenceProtocol";

const EMPTY_MANIFEST: ExcalidrawResourceManifest = { version: 1, entries: [] };

export interface ExcalidrawEngineStatus {
	phase: "stopped" | "recovering" | "live" | "degraded";
	pendingOperations: number;
	drawingEpoch: number;
	sequence: number;
	unavailableResources: number;
	reason: string | null;
}

export interface ExcalidrawEngineOptions {
	drawingId: string;
	drawingEpoch: number;
	path: string;
	persistence: ExcalidrawPersistencePort;
	transport: ExcalidrawTransportPort;
	host: ExcalidrawViewBinding;
	resources: ExcalidrawResourcesPort;
	presence?: {
		acceptFrame(frame: PresenceServerFrame): void;
		bindPublisher(publisher: { publishPresence(update: PresenceClientUpdate): void } | null): void;
	};
	now?: () => number;
	onStatus?: (status: ExcalidrawEngineStatus) => void;
	retryBaseMs?: number;
}

export class ExcalidrawSameVaultEngine {
	private projection: StoredExcalidrawProjection;
	private observed = new Map<string, string>();
	private work = Promise.resolve();
	private submission: Promise<void> | null = null;
	private subscription: ExcalidrawRoomSubscription | null = null;
	private pendingOperations = 0;
	private unavailableResources = 0;
	private phase: ExcalidrawEngineStatus["phase"] = "stopped";
	private reason: string | null = null;
	private stopped = true;
	private hasPreservedAlternatives = false;
	private retryTimer: number | null = null;

	constructor(private readonly options: ExcalidrawEngineOptions) {
		this.projection = { format: 1, drawingId: options.drawingId, drawingEpoch: options.drawingEpoch,
			sequence: 0, elements: [], metadata: { resourceManifest: EMPTY_MANIFEST }, updatedAt: (options.now ?? Date.now)() };
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		this.setStatus("recovering", null);
		const stored = await this.options.persistence.getProjection(this.options.drawingId);
		if (this.stopped) return;
		if (stored) this.projection = stored;
		this.pendingOperations = (await this.options.persistence.listOutbox(this.options.drawingId)).length;
		this.emitStatus();
		const initial = await this.options.host.read();
		if (this.stopped) return;
		await this.recover();
		if (this.stopped) return;
		if (initial) await this.preserveInitialLocalWinners(initial);
		await this.applyProjection();
		if (this.stopped) return;
		await this.observeCurrentHost();
		this.subscription = await this.options.transport.subscribe(this.options.drawingId,
			this.projection.drawingEpoch, this.projection.sequence, {
				onEvent: (event) => { void this.enqueue(() => this.acceptEvent(event)); },
				onGap: () => { void this.enqueue(() => this.recoverAndReapply()); },
				onClose: () => { void this.enqueue(() => this.recoverAndReconnect()); },
				onPresence: (frame) => this.options.presence?.acceptFrame(frame),
			});
		this.bindPresencePublisher();
		this.restoreLiveStatus();
		await this.flushOutbox();
	}

	async capture(snapshot: ExcalidrawHostSnapshot): Promise<void> {
		await this.enqueue(async () => {
			if (this.stopped || snapshot.proof.path !== this.options.path) return;
			const changed: import("./types").ExcalidrawElementRecord[] = [];
			const nextObserved = new Map<string, string>();
			for (const unknownElement of snapshot.elements) {
				const element = validateExcalidrawElement(unknownElement);
				const key = revisionKey(await revisionOf(element));
				nextObserved.set(element.id, key);
				if (this.observed.get(element.id) === key || snapshot.suppressedRevisionKeys.has(key)) continue;
				changed.push(element);
			}
			if (changed.length === 0) return;
			await this.queueOperation(expandExcalidrawDependencyClosure(snapshot.elements, changed),
				await this.options.resources.publish(snapshot.files));
			this.observed = nextObserved;
		});
		await this.flushOutbox();
	}

	async flushOutbox(): Promise<void> {
		if (this.stopped || this.submission) return this.submission ?? Promise.resolve();
		this.submission = this.submitPending().finally(() => { this.submission = null; });
		return this.submission;
	}

	async refreshHost(): Promise<void> {
		await this.enqueue(async () => {
			if (!this.stopped) await this.applyProjection();
		});
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.options.presence?.bindPublisher(null);
		this.subscription?.close();
		this.subscription = null;
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.setStatus("stopped", null);
	}

	status(): ExcalidrawEngineStatus {
		return { phase: this.phase, pendingOperations: this.pendingOperations,
			drawingEpoch: this.projection.drawingEpoch, sequence: this.projection.sequence,
			unavailableResources: this.unavailableResources, reason: this.reason };
	}

	private async recover(): Promise<void> {
		for (;;) {
			const result = await this.options.transport.recover(this.options.drawingId,
				this.projection.sequence === 0 ? null : this.projection.drawingEpoch, this.projection.sequence);
			if (result.kind === "current") {
				if (result.drawingEpoch !== this.projection.drawingEpoch || result.sequence !== this.projection.sequence) {
					throw new Error("Excalidraw recovery proof does not match local projection");
				}
				return;
			}
			if (result.kind === "snapshot") { await this.installSnapshot(result.snapshot); return; }
			const page = result.page;
			if (page.drawingId !== this.options.drawingId || page.drawingEpoch !== this.projection.drawingEpoch
				|| page.after !== this.projection.sequence) throw new Error("Excalidraw replay proof mismatch");
			if (page.snapshotRequired) throw new Error("Excalidraw transport did not supply the required snapshot");
			for (const event of page.events) await this.acceptEvent(event, false);
			if (page.through !== this.projection.sequence) throw new Error("Excalidraw replay high-water mismatch");
			if (page.nextCursor === null) return;
		}
	}

	private async recoverAndReapply(): Promise<void> {
		if (this.stopped) return;
		this.setStatus("recovering", null);
		await this.recover();
		await this.applyProjection();
		this.restoreLiveStatus();
	}

	private async recoverAndReconnect(): Promise<void> {
		if (this.stopped) return;
		this.subscription?.close();
		this.subscription = null;
		this.options.presence?.bindPublisher(null);
		await this.recoverAndReapply();
		if (this.stopped) return;
		this.subscription = await this.options.transport.subscribe(this.options.drawingId,
			this.projection.drawingEpoch, this.projection.sequence, {
				onEvent: (event) => { void this.enqueue(() => this.acceptEvent(event)); },
				onGap: () => { void this.enqueue(() => this.recoverAndReapply()); },
				onClose: () => { void this.enqueue(() => this.recoverAndReconnect()); },
				onPresence: (frame) => this.options.presence?.acceptFrame(frame),
			});
		this.bindPresencePublisher();
	}

	private bindPresencePublisher(): void {
		const subscription = this.subscription;
		this.options.presence?.bindPublisher(subscription?.publishPresence
			? { publishPresence: (update) => subscription.publishPresence!(update) } : null);
	}

	private async installSnapshot(snapshot: ExcalidrawSnapshot): Promise<void> {
		if (snapshot.drawingId !== this.options.drawingId) throw new Error("Excalidraw snapshot drawing mismatch");
		if (!Number.isSafeInteger(snapshot.drawingEpoch) || snapshot.drawingEpoch < 1
			|| !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) throw new Error("Excalidraw snapshot cursor is invalid");
		validateExcalidrawManifest(snapshot.metadata.resourceManifest);
		if (snapshot.elements.length > MAX_EXCALIDRAW_SCENE_ELEMENTS
			|| new Set(snapshot.elements.map((element) => element.id)).size !== snapshot.elements.length) {
			throw new Error("Excalidraw snapshot element set is invalid");
		}
		this.projection = { format: 1, drawingId: snapshot.drawingId, drawingEpoch: snapshot.drawingEpoch,
			sequence: snapshot.sequence, elements: snapshot.elements.map(validateExcalidrawElement),
			metadata: snapshot.metadata, updatedAt: this.now() };
		await this.options.persistence.putProjection(this.projection);
		await this.rebaseOldEpochOutbox();
	}

	private async acceptEvent(event: ExcalidrawRoomEvent, apply = true): Promise<void> {
		if (event.drawingEpoch !== this.projection.drawingEpoch) { await this.recoverAndReapply(); return; }
		if (event.sequence <= this.projection.sequence) return;
		if (event.sequence !== this.projection.sequence + 1) { await this.recoverAndReapply(); return; }
		if (event.metadata) validateExcalidrawManifest(event.metadata.resourceManifest);
		this.projection = { ...this.projection, sequence: event.sequence,
			elements: reconcileExcalidrawElements(this.projection.elements, event.elements),
			metadata: event.metadata ?? this.projection.metadata, updatedAt: this.now() };
		await this.options.persistence.putProjection(this.projection);
		if (apply) await this.applyProjection();
	}

	private async applyProjection(): Promise<void> {
		const current = await this.options.host.read();
		const elements = current ? reconcileExcalidrawElements(this.projection.elements, current.elements) : this.projection.elements;
		const resolution = await this.options.resources.resolve(this.projection.metadata.resourceManifest);
		this.unavailableResources = resolution.unavailable.length;
		const applied = await this.options.host.apply(elements, resolution.files, this.options.path);
		if (!applied) {
			this.setStatus("degraded", "open Excalidraw view ownership or capabilities changed during remote apply");
			return;
		}
		if (resolution.unavailable.length > 0) {
			this.setStatus("degraded", "scene applied with unavailable attachments");
		}
	}

	private async preserveInitialLocalWinners(snapshot: ExcalidrawHostSnapshot): Promise<void> {
		const durable = new Map(this.projection.elements.map((element) => [element.id, element] as const));
		const winners = snapshot.elements.map(validateExcalidrawElement).filter((element) => {
			const existing = durable.get(element.id);
			return !existing || selectExcalidrawWinner(existing, element) === "candidate";
		});
		if (winners.length > 0) await this.queueOperation(winners, await this.options.resources.publish(snapshot.files));
	}

	private async observeCurrentHost(): Promise<void> {
		const snapshot = await this.options.host.read();
		if (!snapshot) return;
		this.observed.clear();
		for (const element of snapshot.elements) this.observed.set(element.id, revisionKey(await revisionOf(element)));
	}

	private async queueOperation(elements: import("./types").ExcalidrawElementRecord[],
		resourceManifest: ExcalidrawResourceManifest): Promise<void> {
		validateExcalidrawManifest(resourceManifest);
		if (elements.length > MAX_EXCALIDRAW_BATCH_ELEMENTS) {
			throw new Error("Atomic Excalidraw change exceeds the supported batch bound");
		}
		if (new Set(elements.map((element) => element.id)).size !== elements.length) {
			throw new Error("Atomic Excalidraw change contains duplicate element IDs");
		}
		const unsigned: Omit<ExcalidrawBatchRequest, "requestDigest"> = {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: randomId(32),
			drawingEpoch: this.projection.drawingEpoch, elements,
			metadata: { ...this.projection.metadata, resourceManifest },
		};
		const operation: ExcalidrawBatchRequest = { ...unsigned, requestDigest: await operationHash(unsigned) };
		if (new TextEncoder().encode(canonicalExcalidrawJson(operation)).byteLength > MAX_EXCALIDRAW_BATCH_BYTES) {
			throw new Error("Atomic Excalidraw change exceeds the supported byte bound");
		}
		await this.options.persistence.putOutbox({ drawingId: this.options.drawingId, operation,
			createdAt: this.now(), attempts: 0, lastAttemptAt: null });
		this.pendingOperations++;
		this.emitStatus();
	}

	private async submitPending(): Promise<void> {
		while (!this.stopped) {
			const pending = await this.options.persistence.listOutbox(this.options.drawingId);
			this.pendingOperations = pending.length;
			const eligible = pending.filter((record) => record.operation.drawingEpoch === this.projection.drawingEpoch);
			if (eligible.length === 0) return;
		for (const record of eligible) {
			if (this.stopped) return;
			const attempts = record.attempts + 1;
			await this.options.persistence.markOutboxAttempt(record.operation.operationId, attempts, this.now());
			let receipt;
			try { receipt = await this.options.transport.submit(this.options.drawingId, record.operation); }
			catch {
				this.setStatus("degraded", "Excalidraw operation remains durably queued for retry");
				this.scheduleRetry(attempts);
				return;
			}
			if (receipt.operationId !== record.operation.operationId || receipt.requestDigest !== record.operation.requestDigest
				|| receipt.drawingId !== this.options.drawingId || receipt.drawingEpoch !== this.projection.drawingEpoch) {
				throw new Error("Excalidraw receipt proof mismatch");
			}
			const requested = new Set(record.operation.elements.map((element) => element.id));
			const decided = [...receipt.acceptedElementIds, ...receipt.staleElementIds];
			if (new Set(decided).size !== decided.length || decided.length !== requested.size
				|| decided.some((elementId) => !requested.has(elementId))) throw new Error("Excalidraw receipt disposition mismatch");
			await this.settleReceiptSequence(receipt.sequence);
			await this.options.persistence.deleteOutbox(record.operation.operationId);
			this.pendingOperations--;
			this.emitStatus();
		}
		}
	}

	private async rebaseOldEpochOutbox(): Promise<void> {
		const pending = await this.options.persistence.listOutbox(this.options.drawingId);
		for (const record of pending) {
			if (record.operation.drawingEpoch === this.projection.drawingEpoch) continue;
			await this.options.persistence.putAlternative({ alternativeId: record.operation.operationId,
				drawingId: this.options.drawingId, reason: "drawing_epoch_superseded", operation: record.operation,
				fromDrawingEpoch: record.operation.drawingEpoch, currentDrawingEpoch: this.projection.drawingEpoch,
				preservedAt: this.now() });
			await this.options.persistence.deleteOutbox(record.operation.operationId);
		}
		this.pendingOperations = (await this.options.persistence.listOutbox(this.options.drawingId)).length;
		if (pending.some((record) => record.operation.drawingEpoch !== this.projection.drawingEpoch)) {
			this.hasPreservedAlternatives = true;
			this.setStatus("degraded", "Excalidraw work from a superseded drawing epoch is preserved as a local alternative");
		}
	}

	private async settleReceiptSequence(sequence: number): Promise<void> {
		if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Excalidraw receipt sequence is invalid");
		for (let attempt = 0; this.projection.sequence < sequence && attempt < 32; attempt++) {
			const before = this.projection.sequence;
			await this.recover();
			if (this.projection.sequence <= before) break;
		}
		if (this.projection.sequence < sequence) {
			throw new Error("Excalidraw receipt is durable but canonical settlement has not caught up");
		}
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		this.work = this.work.then(action).catch((error: unknown) => {
			this.setStatus("degraded", error instanceof Error ? error.message : "Excalidraw synchronization failed");
		});
		return this.work;
	}

	private scheduleRetry(attempts: number): void {
		if (this.stopped || this.retryTimer !== null) return;
		const base = Math.max(10, this.options.retryBaseMs ?? 1000);
		const delay = Math.min(30_000, base * 2 ** Math.min(attempts - 1, 5));
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			void this.flushOutbox();
		}, delay);
	}

	private now(): number { return (this.options.now ?? Date.now)(); }
	private restoreLiveStatus(): void {
		if (this.hasPreservedAlternatives) {
			this.setStatus("degraded", "Excalidraw work from a superseded drawing epoch is preserved as a local alternative");
		} else this.setStatus("live", null);
	}
	private setStatus(phase: ExcalidrawEngineStatus["phase"], reason: string | null): void {
		this.phase = phase; this.reason = reason; this.emitStatus();
	}
	private emitStatus(): void { this.options.onStatus?.(this.status()); }
}
