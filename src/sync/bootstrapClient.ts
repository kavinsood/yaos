import * as Y from "yjs";
import { BodyManager } from "./bodyManager";
import {
	VaultIndexedDb,
	type StoredBootstrapProgress,
} from "./vaultIndexedDb";
import { safeMarkdownPath } from "./pathPolicy";
import { sha256BytesHex } from "../utils/sha256";

export interface BootstrapHttpRequest {
	url: string;
	method: "GET" | "POST";
	headers: Record<string, string>;
	contentType?: "application/json";
	body?: string;
}

export interface BootstrapHttpResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
}

export type BootstrapHttpRequester = (
	request: BootstrapHttpRequest,
) => Promise<BootstrapHttpResponse>;

export interface ClientBootstrapDescriptor {
	bootstrapId: string;
	createdAt: string;
	expiresAt: string;
	serverCompleted: boolean;
	capture: {
		vaultSequence: number;
		rootGeneration: number;
		rootCheckpointHash: string;
	};
	catalog: {
		activeBodyCount: number;
		pageSize: number;
		firstCursor: string | null;
		feedFloor: number;
		highWater: number;
	};
}

export interface ClientCatalogEntry {
	bodyId: string;
	fileId: string;
	path: string;
	generation: number;
	contentHash: string | null;
	size: number | null;
	previousPath?: string | null;
}

export interface ClientCatalogPage {
	entries: ClientCatalogEntry[];
	nextCursor: string | null;
}

export interface ClientBodyState {
	bodyId: string;
	generation: number;
	encodedState: Uint8Array;
}

export interface ClientFeedEntry {
	sequence: number;
	documentId: string;
	generation: number;
	kind: string;
	catalogs?: Array<ClientCatalogEntry & { lifecycle: "active" | "tombstoned" | "reaped" }>;
}
export interface BootstrapServerPort {
	start(attemptId?: string): Promise<ClientBootstrapDescriptor>;
	root(bootstrapId: string): Promise<Uint8Array>;
	catalog(bootstrapId: string, cursor: string | null, limit: number): Promise<ClientCatalogPage>;
	body(bootstrapId: string, bodyId: string): Promise<ClientBodyState>;
	renew(bootstrapId: string, settledBodies: number): Promise<void>;
	bodies(bootstrapId: string, bodyIds: string[]): Promise<Map<string, ClientBodyState>>;
	complete(bootstrapId: string): Promise<{ currentHighWater: number }>;
	changesAfter(sequence: number, limit: number): Promise<{
		entries: ClientFeedEntry[];
		currentHighWater: number;
		resetRequired: boolean;
	}>;
	currentHeads(cursor: string | null, limit: number): Promise<ClientCatalogPage>;
	currentHead(bodyId: string): Promise<ClientCatalogEntry | null>;
	currentBody(bodyId: string): Promise<ClientBodyState>;
	settleRootThrough(sequence: number): Promise<void>;
}
export interface BootstrapDiskPort {
	settleBody(input: {
		path: string;
		bodyId: string;
		generation: number;
		content: string;
	}): Promise<"settled" | "preserved-unresolved">;
	moveBodies(moves: Array<{ from: string; to: string; bodyId: string }>): Promise<void>;
	settleRename?(input: {
		from: string;
		to: string;
		bodyId: string;
		currentContent: string;
	}): Promise<"moved" | "source-absent" | "source-deleted" | "preserved-unresolved">;
	deleteBody(input: {
		path: string;
		bodyId: string;
		generation: number;
		baselineContent?: string | null;
	}): Promise<"deleted" | "revived" | "preserved-unresolved" | void>;
	discardStaleBody?(input: {
		path: string;
		bodyId: string;
		expectedContent: string;
	}): Promise<boolean>;
	markPendingPath?(path: string, bodyId: string): void;
	clearPendingPath?(path: string, bodyId: string): void;
}
export interface BootstrapProgressEvent {
	stage: StoredBootstrapProgress["stage"];
	settledBodies: number;
	totalBodies: number;
	outstandingBodies: number;
}

const PAGE_SIZE = 1000;


async function runBounded<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

export interface CoalescedFeedPage {
	throughSequence: number;
	catalogs: Array<ClientCatalogEntry & { lifecycle: "active" | "tombstoned" | "reaped" }>;
	bodyGenerations: Map<string, { generation: number; kind: string }>;
}

/**
 * Feed order is preserved by the durable sequence cursor, but settlement only
 * needs the latest catalog event and durable body generation in a fetched page.
 * The current head is fenced again before disk mutation.
 */
export function coalesceFeedPage(
	entries: readonly ClientFeedEntry[],
): CoalescedFeedPage {
	let throughSequence = 0;
	const catalogs = new Map<
		string,
		ClientCatalogEntry & { lifecycle: "active" | "tombstoned" | "reaped" }
	>();
	const bodyGenerations = new Map<string, { generation: number; kind: string }>();
	for (const entry of entries) {
		throughSequence = Math.max(throughSequence, entry.sequence);
		for (const catalog of entry.catalogs ?? []) {
			catalogs.set(catalog.bodyId, catalog);
			bodyGenerations.delete(catalog.bodyId);
		}
		if (
			entry.documentId !== "root"
			&& (entry.catalogs?.length ?? 0) === 0
			&& !catalogs.has(entry.documentId)
		) {
			const prior = bodyGenerations.get(entry.documentId);
			if (!prior || entry.generation >= prior.generation) {
				bodyGenerations.set(entry.documentId, {
					generation: entry.generation,
					kind: entry.kind,
				});
			}
		}
	}
	return {
		throughSequence,
		catalogs: [...catalogs.values()],
		bodyGenerations,
	};
}

export async function decodeVerifiedBodyContent(
	entry: ClientCatalogEntry,
	state: ClientBodyState,
): Promise<string> {
	if (state.bodyId !== entry.bodyId) {
		throw new Error(`body response identity mismatch for ${entry.bodyId}`);
	}
	if (!Number.isSafeInteger(state.generation) || state.generation < entry.generation) {
		throw new Error(`stale body generation for ${entry.bodyId}`);
	}
	const candidate = new Y.Doc({ guid: entry.bodyId });
	let content: string;
	try {
		Y.applyUpdate(candidate, state.encodedState, "v4-body-validation");
		content = candidate.getText("body").toJSON();
	} finally {
		candidate.destroy();
	}
	const contentBytes = new TextEncoder().encode(content);
	if (entry.size !== null && entry.size !== contentBytes.byteLength) {
		throw new Error(`body size mismatch for ${entry.bodyId}`);
	}
	if (
		entry.contentHash !== null
		&& await sha256BytesHex(contentBytes) !== entry.contentHash
	) {
		throw new Error(`body content hash mismatch for ${entry.bodyId}`);
	}
	return content;
}

function decodeBytesBase64(value: string): Uint8Array | null {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return null;
	}
}

function decodeBase64UrlBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const decoded = decodeBytesBase64(base64);
	if (!decoded) throw new Error("invalid base64url body state");
	return decoded;
}

/** Authenticated bounded HTTP adapter for bootstrap and closed-body catch-up. */
export class BootstrapHttpPort implements BootstrapServerPort {
	private readonly base: string;

	constructor(
		host: string,
		private readonly vaultId: string,
		private readonly token: string,
		private readonly database: VaultIndexedDb,
		private readonly request: BootstrapHttpRequester,
		private readonly now: () => number = Date.now,
	) {
		this.base = host.replace(/\/$/, "");
	}

	async start(attemptId?: string): Promise<ClientBootstrapDescriptor> {
		return this.json<ClientBootstrapDescriptor>("bootstrap/start", "POST", { attemptId });
	}

	async root(bootstrapId: string): Promise<Uint8Array> {
		return this.bytes(`bootstrap/${encodeURIComponent(bootstrapId)}/root`);
	}

	async catalog(bootstrapId: string, cursor: string | null, limit: number): Promise<ClientCatalogPage> {
		const query = new URLSearchParams({ limit: String(limit) });
		if (cursor !== null) query.set("cursor", cursor);
		return this.json<ClientCatalogPage>(
			`bootstrap/${encodeURIComponent(bootstrapId)}/catalog?${query}`,
		);
	}

	async body(bootstrapId: string, bodyId: string): Promise<ClientBodyState> {
		const response = await this.raw(
			`bootstrap/${encodeURIComponent(bootstrapId)}/body/${encodeURIComponent(bodyId)}`,
		);
		return {
			bodyId,
			generation: this.generationHeader(response.headers),
			encodedState: new Uint8Array(response.arrayBuffer),
		};
	}

	async renew(bootstrapId: string, settledBodies: number): Promise<void> {
		await this.json(
			`bootstrap/${encodeURIComponent(bootstrapId)}/renew`,
			"POST",
			{ settledBodies },
		);
	}

	async bodies(bootstrapId: string, bodyIds: string[]): Promise<Map<string, ClientBodyState>> {
		const value = await this.json<{
			bodies: Array<{ bodyId: string; generation: number; encodedState: string }>;
		}>(
			`bootstrap/${encodeURIComponent(bootstrapId)}/bodies`,
			"POST",
			{ bodyIds },
		);
		if (!Array.isArray(value.bodies) || value.bodies.length !== bodyIds.length) {
			throw new Error("body batch response count mismatch");
		}
		const expected = new Set(bodyIds);
		const states = new Map<string, ClientBodyState>();
		for (const body of value.bodies) {
			if (
				!expected.has(body.bodyId)
				|| states.has(body.bodyId)
				|| !Number.isSafeInteger(body.generation)
				|| body.generation < 0
				|| typeof body.encodedState !== "string"
			) {
				throw new Error("body batch response identity mismatch");
			}
			states.set(body.bodyId, {
				bodyId: body.bodyId,
				generation: body.generation,
				encodedState: decodeBase64UrlBytes(body.encodedState),
			});
		}
		return states;
	}

	async complete(bootstrapId: string): Promise<{ currentHighWater: number }> {
		return this.json(`bootstrap/${encodeURIComponent(bootstrapId)}/complete`, "POST", {});
	}

	async changesAfter(sequence: number, limit: number): Promise<{
		entries: ClientFeedEntry[];
		currentHighWater: number;
		resetRequired: boolean;
	}> {
		return this.json(`changes?after=${sequence}&limit=${limit}`);
	}

	async currentHeads(cursor: string | null, limit: number): Promise<ClientCatalogPage> {
		const query = new URLSearchParams({ limit: String(limit) });
		if (cursor !== null) query.set("cursor", cursor);
		return this.json(`heads?${query}`);
	}

	async currentHead(bodyId: string): Promise<ClientCatalogEntry | null> {
		const response = await this.request({
			url: this.route(`head/${encodeURIComponent(bodyId)}`),
			method: "GET",
			headers: this.headers(),
		});
		if (response.status === 404 || response.json === null) return null;
		if (response.status !== 200) throw new Error(`body head request failed (${response.status})`);
		const head = response.json as Partial<ClientCatalogEntry>;
		if (head.bodyId !== bodyId || head.fileId !== bodyId) {
			throw new Error("body head response identity mismatch");
		}
		return head as ClientCatalogEntry;
	}

	async currentBody(bodyId: string): Promise<ClientBodyState> {
		const response = await this.raw(`body/${encodeURIComponent(bodyId)}`);
		return {
			bodyId,
			generation: this.generationHeader(response.headers),
			encodedState: new Uint8Array(response.arrayBuffer),
		};
	}

	async settleRootThrough(sequence: number): Promise<void> {
		const response = await this.raw(`root?through=${sequence}`);
		await this.database.putDocument({
			documentId: "root",
			generation: this.generationHeader(response.headers),
			encodedState: response.arrayBuffer.slice(0),
			dirty: false,
			updatedAt: this.now(),
		});
	}

	private route(resource: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/${resource}`;
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}` };
	}

	private async raw(resource: string): Promise<BootstrapHttpResponse> {
		const response = await this.request({
			url: this.route(resource),
			method: "GET",
			headers: this.headers(),
		});
		if (response.status !== 200) throw new Error(`vault request failed (${response.status})`);
		return response;
	}

	private async bytes(resource: string): Promise<Uint8Array> {
		const response = await this.raw(resource);
		return new Uint8Array(response.arrayBuffer);
	}

	private async json<T>(
		resource: string,
		method: "GET" | "POST" = "GET",
		body?: Record<string, unknown>,
	): Promise<T> {
		const response = await this.request({
			url: this.route(resource),
			method,
			headers: this.headers(),
			...(body ? { contentType: "application/json" as const, body: JSON.stringify(body) } : {}),
		});
		if (response.status !== 200) throw new Error(`vault request failed (${response.status})`);
		return response.json as T;
	}

	private generationHeader(headers: Record<string, string>): number {
		const value = Number(headers["x-yaos-generation"] ?? headers["X-Yaos-Generation"]);
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error("vault response omitted durable generation");
		}
		return value;
	}
}

export async function prepareBootstrapRoot(
	server: BootstrapServerPort,
	database: VaultIndexedDb,
	attemptId?: string,
	now: () => number = Date.now,
): Promise<{
	descriptor: ClientBootstrapDescriptor;
	progress: StoredBootstrapProgress;
}> {
	const existing = await database.getBootstrapProgress();
	const descriptor = await server.start(existing?.bootstrapId ?? attemptId);
	if (existing && existing.bootstrapId === descriptor.bootstrapId) {
		return { descriptor, progress: existing };
	}
	const rootBytes = await server.root(descriptor.bootstrapId);
	const rootHash = await sha256BytesHex(rootBytes);
	if (rootHash !== descriptor.capture.rootCheckpointHash) throw new Error("bootstrap root hash mismatch");
	const validatedRoot = decodeBootstrapRoot(rootBytes);
	validatedRoot.destroy();
	await database.putDocument({
		documentId: "root",
		generation: descriptor.capture.rootGeneration,
		encodedState: rootBytes.slice().buffer,
		dirty: false,
		updatedAt: now(),
	});
	const progress: StoredBootstrapProgress = {
		bootstrapId: descriptor.bootstrapId,
		highWater: descriptor.catalog.highWater,
		nextCatalogCursor: descriptor.catalog.firstCursor,
		stage: "root-loaded",
		settledBodies: 0,
		totalBodies: descriptor.catalog.activeBodyCount,
		feedCursor: descriptor.catalog.highWater,
	};
	await database.putBootstrapProgress(progress);
	return { descriptor, progress };
}

/** Resumable bootstrap that materializes every active ordinary file. */
export class BootstrapClient {
	private readonly bodySettlementWork = new Map<string, Promise<void>>();
	constructor(
		private readonly server: BootstrapServerPort,
		private readonly database: VaultIndexedDb,
		private readonly bodies: BodyManager,
		private readonly disk: BootstrapDiskPort,
		private readonly onProgress?: (event: BootstrapProgressEvent) => void,
		private readonly now: () => number = Date.now,
		private readonly materializeConcurrency = 16,
	) {}

	async run(attemptId?: string): Promise<StoredBootstrapProgress> {
		let progress = await this.database.getBootstrapProgress();
		if (progress?.stage === "complete") {
			progress.stage = "feed-catching-up";
			progress = await this.catchUpFeed(progress);
			await this.retryOutstanding(progress);
			return progress;
		}
		const prepared = await prepareBootstrapRoot(
			this.server,
			this.database,
			attemptId,
			this.now,
		);
		const descriptor = prepared.descriptor;
		progress = prepared.progress;
		if (progress.stage === "root-loaded" || progress.stage === "catalog-paging") {
			progress = await this.materializeCatalog(progress);
		}
		if (progress.stage === "feed-catching-up") {
			if (!descriptor.serverCompleted) await this.server.complete(progress.bootstrapId);
			progress = await this.catchUpFeed(progress);
		}
		if (progress.stage === "complete") await this.retryOutstanding(progress);
		return progress;
	}

	async settleBodyNow(bodyId: string): Promise<void> {
		const progress = await this.database.getBootstrapProgress();
		if (!progress) throw new Error("bootstrap has not prepared root state");
		const head = await this.server.currentHead(bodyId);
		if (!head) {
			const outstanding = await this.database.getOutstanding(bodyId);
			await this.settleMissingHead(bodyId, outstanding?.generation ?? 0);
			return;
		}
		const settled = await this.materializeEntry(progress, head);
		if (!settled) {
			throw new Error(`body ${bodyId} remains unsettled`);
		}
	}

	private async materializeCatalog(progress: StoredBootstrapProgress): Promise<StoredBootstrapProgress> {
		let cursor = progress.nextCatalogCursor;
		progress.stage = "catalog-paging";
		await this.database.putBootstrapProgress(progress);
		while (true) {
			const page = await this.server.catalog(progress.bootstrapId, cursor, PAGE_SIZE);
			const validEntries: ClientCatalogEntry[] = [];
			for (const entry of page.entries) {
				try {
					this.validateCatalogEntry(entry);
					validEntries.push(entry);
				} catch (error) {
					if (!entry.bodyId || !entry.path || !Number.isSafeInteger(entry.generation)) throw error;
					await this.recordOutstanding(
						entry,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
			const states = await this.server.bodies(
				progress.bootstrapId,
				validEntries.map((entry) => entry.bodyId),
			);
			const settled = await runBounded(validEntries, this.materializeConcurrency, async (entry) => {
				const state = states.get(entry.bodyId);
				if (!state) {
					await this.recordOutstanding(entry, `bootstrap body ${entry.bodyId} missing from batch`);
					return false;
				}
				return this.materializeEntry(progress, entry, state);
			});
			progress.settledBodies = Math.min(
				progress.totalBodies,
				progress.settledBodies + settled.filter(Boolean).length,
			);
			cursor = page.nextCursor;
			progress.nextCatalogCursor = cursor;
			await this.database.putBootstrapProgress(progress);
			await this.server.renew(progress.bootstrapId, progress.settledBodies);
			this.emitProgress(progress);
			if (cursor === null) break;
		}
		progress.stage = "feed-catching-up";
		progress.feedCursor = progress.highWater;
		await this.database.putBootstrapProgress(progress);
		await this.database.putFeedCursor({ sequence: progress.feedCursor, updatedAt: this.now() });
		return progress;
	}

	private async catchUpFeed(progress: StoredBootstrapProgress): Promise<StoredBootstrapProgress> {
		while (true) {
			const page = await this.server.changesAfter(progress.feedCursor, PAGE_SIZE);
			if (page.resetRequired) {
				await this.server.settleRootThrough(page.currentHighWater);
				await this.resetFromHeads(progress);
				progress.feedCursor = page.currentHighWater;
				await this.persistFeedProgress(progress);
				continue;
			}
			if (page.entries.length === 0) break;

			const coalesced = coalesceFeedPage(page.entries);
			await this.server.settleRootThrough(coalesced.throughSequence);
			try {
				await this.applyCatalogEvents(progress, coalesced.catalogs);
			} catch (error) {
				for (const catalog of coalesced.catalogs) {
					await this.database.putOutstanding({
						bodyId: catalog.bodyId,
						path: catalog.path,
						generation: catalog.generation,
						reason: error instanceof Error ? error.message : String(error),
						updatedAt: this.now(),
					});
				}
			}

			await runBounded(
				[...coalesced.bodyGenerations],
				this.materializeConcurrency,
				async ([bodyId, change]) =>
					this.settleFeedBody(progress, bodyId, change.generation, change.kind),
			);
			progress.feedCursor = coalesced.throughSequence;
			await this.persistFeedProgress(progress);
			if (progress.feedCursor >= page.currentHighWater && page.entries.length < PAGE_SIZE) break;
		}
		progress.stage = "complete";
		await this.database.putBootstrapProgress(progress);
		this.emitProgress(progress);
		return progress;
	}

	private async settleFeedBody(
		progress: StoredBootstrapProgress,
		bodyId: string,
		generation: number,
		kind: string,
	): Promise<void> {
		const [local, outstanding] = await Promise.all([
			this.database.getDocument(bodyId),
			this.database.getOutstanding(bodyId),
		]);
		if (kind === "body" && !outstanding && local && !local.dirty && local.generation >= generation) return;
		const head = await this.server.currentHead(bodyId);
		if (!head) {
			await this.settleMissingHead(bodyId, generation);
			return;
		}
		await this.materializeEntry(progress, head);
	}

	private async persistFeedProgress(progress: StoredBootstrapProgress): Promise<void> {
		await Promise.all([
			this.database.putBootstrapProgress(progress),
			this.database.putFeedCursor({ sequence: progress.feedCursor, updatedAt: this.now() }),
		]);
	}

	private async applyCatalogEvents(
		progress: StoredBootstrapProgress,
		catalogs: Array<ClientCatalogEntry & { lifecycle: "active" | "tombstoned" | "reaped" }>,
	): Promise<void> {
		const active: Array<ClientCatalogEntry & { lifecycle: "active" }> = [];
		const moves: Array<{ from: string; to: string; bodyId: string }> = [];
		for (const catalog of catalogs) {
			this.validateCatalogEntry(catalog);
			const priorPath = await this.database.getMaterializedPath(catalog.bodyId);
			if (catalog.lifecycle !== "active") {
				await this.runBodyWork([catalog.bodyId], async () => {
					const baselineContent = await this.readStoredBodyContent(catalog.bodyId);
					const outcome = await this.disk.deleteBody({
						path: priorPath ?? catalog.path,
						bodyId: catalog.bodyId,
						generation: catalog.generation,
						baselineContent,
					});
					if (outcome === "preserved-unresolved") {
						await this.recordOutstanding(catalog, "remote delete could not safely settle", "delete");
						return;
					}
					if (outcome === "revived") {
						await this.database.setMaterializedPath(catalog.bodyId, catalog.path);
						await this.database.deleteOutstanding(catalog.bodyId);
						return;
					}
					await this.database.deleteDocument(catalog.bodyId);
					await this.database.deleteOutstanding(catalog.bodyId);
					await this.database.deleteMaterializedPath(catalog.bodyId);
				});
				continue;
			}
			active.push({ ...catalog, lifecycle: "active" });
			if (priorPath && priorPath !== catalog.path && catalog.previousPath == null) {
				moves.push({ from: priorPath, to: catalog.path, bodyId: catalog.bodyId });
			}
		}
		if (moves.length > 0) {
			await this.runBodyWork(
				moves.map((move) => move.bodyId),
				async () => {
					await this.disk.moveBodies(moves);
					await this.database.setMaterializedPaths(
						moves.map((move) => ({ bodyId: move.bodyId, path: move.to })),
					);
				},
			);
		}
		await runBounded(active, this.materializeConcurrency, async (catalog) => {
			const head = await this.server.currentHead(catalog.bodyId);
			if (head) await this.materializeEntry(progress, head);
		});
	}

	private async resetFromHeads(progress: StoredBootstrapProgress): Promise<void> {
		let cursor: string | null = null;
		const heads: ClientCatalogEntry[] = [];
		do {
			const page = await this.server.currentHeads(cursor, PAGE_SIZE);
			heads.push(...page.entries);
			cursor = page.nextCursor;
		} while (cursor !== null);
		try {
			await this.applyCatalogEvents(
				progress,
				heads.map((entry) => ({ ...entry, lifecycle: "active" as const })),
			);
		} catch (error) {
			for (const entry of heads) {
				await this.database.putOutstanding({
					bodyId: entry.bodyId,
					path: entry.path,
					generation: entry.generation,
					reason: error instanceof Error ? error.message : String(error),
					updatedAt: this.now(),
				});
			}
		}
		const seen = new Set(heads.map((entry) => entry.bodyId));
		for (const local of await this.database.listMaterializedPaths()) {
			if (seen.has(local.bodyId)) continue;
			const baselineContent = await this.readStoredBodyContent(local.bodyId);
			const outcome = await this.disk.deleteBody({
				path: local.path,
				bodyId: local.bodyId,
				generation: 0,
				baselineContent,
			});
			if (outcome === "preserved-unresolved") {
				await this.database.putOutstanding({
					bodyId: local.bodyId,
					path: local.path,
					generation: 0,
					reason: "head reset could not safely settle remote delete",
					operation: "delete",
					updatedAt: this.now(),
				});
				continue;
			}
			if (outcome === "revived") {
				await this.database.setMaterializedPath(local.bodyId, local.path);
				await this.database.deleteOutstanding(local.bodyId);
				continue;
			}
			await this.database.deleteDocument(local.bodyId);
			await this.database.deleteOutstanding(local.bodyId);
			await this.database.deleteMaterializedPath(local.bodyId);
		}
	}

	private materializeEntry(
		progress: StoredBootstrapProgress,
		entry: ClientCatalogEntry,
		provided?: ClientBodyState,
	): Promise<boolean> {
		return this.runBodyWork(
			[entry.bodyId],
			() => this.materializeEntryFenced(progress, entry, provided),
		);
	}

	private async runBodyWork<T>(
		bodyIds: readonly string[],
		work: () => Promise<T>,
	): Promise<T> {
		const ids = [...new Set(bodyIds)].sort();
		const previous = ids.map((bodyId) =>
			(this.bodySettlementWork.get(bodyId) ?? Promise.resolve()).catch(() => undefined),
		);
		let result!: T;
		const run = Promise.all(previous).then(async () => {
			result = await work();
		});
		for (const bodyId of ids) this.bodySettlementWork.set(bodyId, run);
		try {
			await run;
			return result;
		} finally {
			for (const bodyId of ids) {
				if (this.bodySettlementWork.get(bodyId) === run) this.bodySettlementWork.delete(bodyId);
			}
		}
	}
	private async materializeEntryFenced(
		progress: StoredBootstrapProgress,
		initial: ClientCatalogEntry,
		provided?: ClientBodyState,
	): Promise<boolean> {
		let expected = initial;
		let supplied = provided;
		for (let attempt = 0; attempt < 12; attempt++) {
			const head = await this.server.currentHead(expected.bodyId);
			if (!head) {
				await this.settleMissingHead(expected.bodyId, expected.generation);
				return true;
			}
			this.validateCatalogEntry(head);
			const suppliedForHead = supplied && this.sameCatalogHead(expected, head)
				? supplied
				: undefined;
			supplied = undefined;
			expected = head;
			try {
				const local = await this.database.getDocument(expected.bodyId);
				const outstanding = await this.database.getOutstanding(expected.bodyId);
				const materializedPath = await this.database.getMaterializedPath(expected.bodyId);
				if (
					!outstanding
					&& expected.previousPath == null
					&& materializedPath === expected.path
					&& (local?.generation ?? -1) >= expected.generation
					&& local?.dirty === false
				) return true;
				const state = suppliedForHead ?? await this.server.currentBody(expected.bodyId);
				const content = await decodeVerifiedBodyContent(expected, state);
				const beforeApply = await this.server.currentHead(expected.bodyId);
				if (!beforeApply || !this.sameCatalogHead(expected, beforeApply)) {
					if (!beforeApply) {
						await this.settleMissingHead(expected.bodyId, expected.generation);
						return true;
					}
					expected = beforeApply;
					continue;
				}
				await this.bodies.replaceFromServer(
					expected.bodyId,
					state.encodedState,
					state.generation,
				);
				const renameSources = new Set(
					[expected.previousPath, materializedPath].filter(
						(source): source is string => !!source && source !== expected.path,
					),
				);
				if (this.disk.settleRename) {
					for (const source of renameSources) {
						const renameOutcome = await this.disk.settleRename({
							from: source,
							to: expected.path,
							bodyId: expected.bodyId,
							currentContent: content,
						});
						if (renameOutcome === "preserved-unresolved") {
							await this.recordOutstanding(
								expected,
								`rename source could not safely settle: ${source}`,
								"move",
							);
							return false;
						}
					}
				}
				this.disk.markPendingPath?.(expected.path, expected.bodyId);
				let outcome: "settled" | "preserved-unresolved";
				try {
					outcome = await this.disk.settleBody({
						path: expected.path,
						bodyId: expected.bodyId,
						generation: state.generation,
						content,
					});
				} finally {
					this.disk.clearPendingPath?.(expected.path, expected.bodyId);
				}
				if (outcome === "preserved-unresolved") {
					await this.recordOutstanding(expected, "body could not safely settle to disk");
					return false;
				}
				const afterApply = await this.server.currentHead(expected.bodyId);
				if (!afterApply || !this.sameCatalogHead(expected, afterApply)) {
					const discarded = this.disk.discardStaleBody
						? await this.disk.discardStaleBody({
							path: expected.path,
							bodyId: expected.bodyId,
							expectedContent: content,
						})
						: false;
					if (!discarded) {
						await this.recordOutstanding(expected, "stale body path could not be removed");
						return false;
					}
					if (!afterApply) {
						await this.settleMissingHead(expected.bodyId, expected.generation);
						return true;
					}
					expected = afterApply;
					continue;
				}
				await this.database.setMaterializedPath(expected.bodyId, expected.path);
				await this.database.deleteOutstanding(expected.bodyId);
				await this.bodies.evict(expected.bodyId);
				return true;
			} catch (error) {
				await this.recordOutstanding(
					expected,
					error instanceof Error ? error.message : String(error),
				);
				return false;
			}
		}
		await this.recordOutstanding(expected, "body catalog kept changing during settlement");
		return false;
	}

	private sameCatalogHead(left: ClientCatalogEntry, right: ClientCatalogEntry): boolean {
		return left.bodyId === right.bodyId
			&& left.path === right.path
			&& left.previousPath === right.previousPath
			&& left.generation === right.generation;
	}
	private async retryOutstanding(progress: StoredBootstrapProgress): Promise<void> {
		for (const outstanding of await this.database.listOutstanding()) {
			const head = await this.server.currentHead(outstanding.bodyId);
			if (!head) {
				await this.settleMissingHead(outstanding.bodyId, outstanding.generation);
				continue;
			}
			try {
				await this.applyCatalogEvents(progress, [{ ...head, lifecycle: "active" }]);
			} catch (error) {
				await this.recordOutstanding(
					head,
					error instanceof Error ? error.message : String(error),
					outstanding.operation ?? "settle",
				);
			}
		}
		this.emitProgress(progress);
	}

	private async settleMissingHead(bodyId: string, generation: number): Promise<void> {
		const outstanding = await this.database.getOutstanding(bodyId);
		const materializedPath = await this.database.getMaterializedPath(bodyId);
		const path = materializedPath ?? outstanding?.path ?? null;
		if (!path) {
			await this.database.deleteDocument(bodyId);
			await this.database.deleteOutstanding(bodyId);
			await this.database.deleteMaterializedPath(bodyId);
			return;
		}
		const baselineContent = await this.readStoredBodyContent(bodyId);
		const outcome = await this.disk.deleteBody({
			path,
			bodyId,
			generation,
			baselineContent,
		});
		if (outcome === "preserved-unresolved") {
			await this.recordOutstanding(
				{ bodyId, path, generation },
				"body head disappeared but disk delete could not safely settle",
				"delete",
			);
			return;
		}
		if (outcome === "revived") {
			await this.database.setMaterializedPath(bodyId, path);
			await this.database.deleteOutstanding(bodyId);
			return;
		}
		await this.database.deleteDocument(bodyId);
		await this.database.deleteOutstanding(bodyId);
		await this.database.deleteMaterializedPath(bodyId);
	}
	private validateCatalogEntry(entry: ClientCatalogEntry): void {
		if (entry.fileId !== entry.bodyId) {
			throw new Error(`bodyId must equal fileId for ${entry.path}`);
		}
		if (!entry.bodyId || !entry.path) {
			throw new Error("catalog entry is missing body identity or path");
		}
		if (!Number.isSafeInteger(entry.generation) || entry.generation < 0) {
			throw new Error(`catalog entry has invalid generation for ${entry.bodyId}`);
		}
		if (entry.size !== null && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
			throw new Error(`catalog entry has invalid size for ${entry.bodyId}`);
		}
		if (entry.contentHash !== null && !/^[0-9a-f]{64}$/.test(entry.contentHash)) {
			throw new Error(`catalog entry has invalid content hash for ${entry.bodyId}`);
		}
		if (!safeMarkdownPath(entry.path)) {
			throw new Error(`catalog entry has unsafe markdown path: ${entry.path}`);
		}
		if (
			entry.previousPath !== undefined
			&& entry.previousPath !== null
			&& (
				entry.previousPath === entry.path
				|| safeMarkdownPath(entry.previousPath) !== entry.previousPath
			)
		) {
			throw new Error(`catalog entry has invalid previous path for ${entry.bodyId}`);
		}
	}

	private async readStoredBodyContent(bodyId: string): Promise<string | null> {
		const stored = await this.database.getDocument(bodyId);
		if (!stored) return null;
		const doc = new Y.Doc({ guid: bodyId });
		try {
			Y.applyUpdate(doc, new Uint8Array(stored.encodedState), "v4-delete-baseline");
			return doc.getText("body").toJSON();
		} catch {
			return null;
		} finally {
			doc.destroy();
		}
	}

	private async recordOutstanding(
		entry: Pick<ClientCatalogEntry, "bodyId" | "path" | "generation">,
		reason: string,
		operation: "settle" | "delete" | "move" = "settle",
	): Promise<void> {
		const previous = await this.database.getOutstanding(entry.bodyId);
		await this.database.putOutstanding({
			bodyId: entry.bodyId,
			path: entry.path,
			generation: entry.generation,
			reason,
			operation,
			attempts: (previous?.attempts ?? 0) + 1,
			updatedAt: this.now(),
		});
	}


	private emitProgress(progress: StoredBootstrapProgress): void {
		if (!this.onProgress) return;
		void this.database.listOutstanding().then((outstanding) => {
			this.onProgress?.({
				stage: progress.stage,
				settledBodies: progress.settledBodies,
				totalBodies: progress.totalBodies,
				outstandingBodies: outstanding.length,
			});
		});
	}
}

/** Validate an encoded root checkpoint before exposing any structural state. */
export function decodeBootstrapRoot(encoded: Uint8Array): Y.Doc {
	const doc = new Y.Doc({ guid: "root" });
	try {
		Y.applyUpdate(doc, encoded, "bootstrap-root");
		if (doc.getMap("sys").get("schemaVersion") !== 4) {
			throw new Error("bootstrap root is not schema 4");
		}
		return doc;
	} catch (error) {
		doc.destroy();
		throw error;
	}
}
