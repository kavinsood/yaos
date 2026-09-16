import type { StoredAttachmentPublicationOperation, StoredDocument, StoredLifecycleOperation } from "../../src/sync/vaultIndexedDb.ts";
import {
	VaultSync,
	type CandidateRecord,
	type FreshBodyBatchCommitResult,
	type FreshBodyCommitInput,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
} from "../../src/sync/vaultSync.ts";
import { createFetchRequester, type HttpRequest, type HttpRequester } from "../../src/utils/http.ts";
import type { LiveIdentity } from "./liveIdentity.ts";

export interface ProductionImportRequestMeasurement {
	readonly sequence: number;
	readonly method: string;
	readonly pathname: string;
	readonly requestBytes: number;
	readonly responseBytes: number;
	readonly status: number;
	readonly elapsedMs: number;
}

function rounded(value: number): number {
	return Math.round(value * 100) / 100;
}

function requestBodyBytes(body: HttpRequest["body"]): number {
	if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
	return body?.byteLength ?? 0;
}

function inactiveProvider(): SyncProviderPort {
	const awareness: SyncAwarenessPort = {
		setLocalStateField: () => {},
		destroy: () => {},
		getStates: () => new Map(),
	};
	return {
		awareness,
		ws: null,
		wsconnected: false,
		wsconnecting: false,
		synced: false,
		url: "ws://production-import-profiler/inactive",
		connect: () => {},
		disconnect: () => {},
		destroy: () => awareness.destroy(),
		on: () => {},
	};
}

class MemoryVaultDatabase implements VaultDatabasePort {
	private readonly documents = new Map<string, StoredDocument>();
	private readonly candidates = new Map<string, CandidateRecord>();
	private readonly lifecycle = new Map<string, StoredLifecycleOperation>();
	private readonly attachments = new Map<string, StoredAttachmentPublicationOperation>();

	async getDocument(documentId: string): Promise<StoredDocument | null> {
		return this.documents.get(documentId) ?? null;
	}

	async putDocument(document: StoredDocument): Promise<void> {
		this.documents.set(document.documentId, document);
	}

	async putCandidate(record: CandidateRecord): Promise<void> {
		this.candidates.set(record.candidateId, record);
	}

	async deleteCandidate(_bodyId: string, candidateId: string): Promise<void> {
		this.candidates.delete(candidateId);
	}

	async listCandidates(): Promise<CandidateRecord[]> {
		return [...this.candidates.values()];
	}

	async putLifecycleOperation(operation: StoredLifecycleOperation): Promise<void> {
		this.lifecycle.set(operation.operationId, { ...operation });
	}

	async listLifecycleOperations(): Promise<StoredLifecycleOperation[]> {
		return [...this.lifecycle.values()].map((operation) => ({ ...operation }));
	}

	async deleteLifecycleOperation(operationId: string): Promise<void> {
		this.lifecycle.delete(operationId);
	}

	async deleteLifecycleOperations(operationIds: readonly string[]): Promise<void> {
		for (const operationId of operationIds) this.lifecycle.delete(operationId);
	}

	async putAttachmentOperation(
		operation: StoredAttachmentPublicationOperation,
	): Promise<StoredAttachmentPublicationOperation> {
		this.attachments.set(operation.mutation.operationId, operation);
		return operation;
	}

	async listAttachmentOperations(): Promise<StoredAttachmentPublicationOperation[]> {
		return [...this.attachments.values()];
	}

	async deleteAttachmentOperation(operationId: string): Promise<void> {
		this.attachments.delete(operationId);
	}

	async close(): Promise<void> {}
}

/**
 * Thin live-test harness around the production VaultSync import API. The only
 * substitutions are in-memory local durability and an inactive socket provider;
 * all four mutation requests use VaultSyncHttpPort unchanged.
 */
export class ProductionImportSession {
	readonly requests: ProductionImportRequestMeasurement[] = [];
	private readonly runtime: VaultSync;

	constructor(identity: LiveIdentity, vaultGeneration: string) {
		const fetchRequester = createFetchRequester(globalThis.fetch.bind(globalThis));
		const measuredRequester: HttpRequester = async (request) => {
			const startedAt = performance.now();
			const response = await fetchRequester(request);
			this.requests.push({
				sequence: this.requests.length + 1,
				method: request.method ?? "GET",
				pathname: new URL(request.url).pathname,
				requestBytes: requestBodyBytes(request.body),
				responseBytes: response.arrayBuffer.byteLength,
				status: response.status,
				elapsedMs: rounded(performance.now() - startedAt),
			});
			return response;
		};
		this.runtime = new VaultSync({
			vaultId: identity.vaultId,
			vaultGeneration,
			deviceId: identity.deviceId,
			host: identity.host,
			token: identity.deviceToken,
			database: new MemoryVaultDatabase(),
			request: measuredRequester,
			providerFactory: inactiveProvider,
		});
	}

	async commitFreshBodies(inputs: readonly FreshBodyCommitInput[]): Promise<FreshBodyBatchCommitResult> {
		return this.runtime.commitFreshBodies(inputs);
	}

	async destroy(): Promise<void> {
		await this.runtime.destroy();
	}
}
