import { canonicalizeVaultPath } from "../paths/canonicalPath";
import { validateFrontmatterTransition } from "../sync/frontmatterGuard";
import { safeMarkdownPath } from "../sync/pathPolicy";
import { isExcluded } from "../sync/exclude";
import { sha256TextHex } from "../utils/sha256";

export const LOCAL_VAULT_IMPORT_FORMAT = 1 as const;

export interface LocalFileRevision {
	mtime: number;
	size: number;
}

export interface LocalInventoryEntry extends LocalFileRevision {
	path: string;
}

export interface LocalVaultImportSource {
	/** Captures one finite boundary. Files created after this resolves are not part of this import. */
	captureInventory(): Promise<readonly LocalInventoryEntry[]>;
	read(path: string): Promise<string>;
	stat(path: string): Promise<LocalFileRevision | null>;
}

export interface LocalVaultImportSinkInput {
	path: string;
	content: string;
	bodyId: string;
	candidateId: string;
	contentHash: string;
}

export interface LocalVaultImportSink {
	/** Must be idempotent for the same bodyId, candidateId, and contentHash. */
	importFile(input: LocalVaultImportSinkInput): Promise<{ bodyId: string }>;
	/**
	 * Optional bounded bulk path. Results are positional and the whole call is
	 * retryable with the same candidate identities.
	 */
	importFiles?(
		inputs: readonly LocalVaultImportSinkInput[],
	): Promise<Array<{ bodyId: string }>>;
}

export type LocalImportItemStatus =
	| "pending"
	| "importing"
	| "imported"
	| "excluded"
	| "collision"
	| "oversized"
	| "invalid-frontmatter"
	| "missing"
	| "failed";

export interface LocalImportItem {
	path: string;
	captured: LocalFileRevision;
	bodyId: string;
	candidateId: string;
	status: LocalImportItemStatus;
	attempts: number;
	lastError: string | null;
	lastContentHash: string | null;
	importedRevision: LocalFileRevision | null;
}

export type LocalVaultImportStage =
	| "captured"
	| "importing"
	| "attention-required"
	| "complete";

export interface LocalVaultImportState {
	format: typeof LOCAL_VAULT_IMPORT_FORMAT;
	importId: string;
	vaultId: string;
	capturedAt: number;
	updatedAt: number;
	stage: LocalVaultImportStage;
	items: LocalImportItem[];
}

export interface LocalVaultImportStateStore {
	load(vaultId: string): Promise<LocalVaultImportState | null>;
	save(state: LocalVaultImportState): Promise<void>;
	clear(vaultId: string): Promise<void>;
}

export interface LocalVaultImportOptions {
	vaultId: string;
	maxFileSizeBytes: number;
	excludePatterns: readonly string[];
	configDir: string;
	concurrency?: number;
	pageSize?: number;
	maxEditRetries?: number;
	now?: () => number;
	makeId?: () => string;
	onProgress?: (summary: LocalVaultImportSummary) => void;
}

export interface LocalVaultImportSummary {
	stage: LocalVaultImportStage;
	total: number;
	imported: number;
	excluded: number;
	outstanding: number;
	failed: number;
	collisions: number;
	problems: Array<{
		path: string;
		status: LocalImportItemStatus;
		error: string | null;
	}>;
}

const TERMINAL_SUCCESS = new Set<LocalImportItemStatus>(["imported", "excluded", "missing"]);
const RETRYABLE = new Set<LocalImportItemStatus>([
	"pending",
	"importing",
	"failed",
	"oversized",
	"invalid-frontmatter",
]);
const FRONTMATTER_PARSE_LIMIT_CHARS = 256 * 1024;

interface PreparedLocalImport {
	item: LocalImportItem;
	content: string;
	revision: LocalFileRevision;
	contentHash: string;
}

/**
 * Frontmatter is checked before upload-size classification so malformed notes
 * are actionable, but parsing is capped to prevent oversized YAML from turning
 * onboarding into unbounded CPU work.
 */
function validateBoundedImportFrontmatter(content: string): string[] {
	const firstLineEnd = content.search(/\r?\n/);
	const firstLine = content.slice(0, firstLineEnd < 0 ? content.length : firstLineEnd).trim();
	if (firstLine !== "---") return [];
	const bounded = content.length > FRONTMATTER_PARSE_LIMIT_CHARS
		? content.slice(0, FRONTMATTER_PARSE_LIMIT_CHARS)
		: content;
	const result = validateFrontmatterTransition(null, bounded);
	if (result.risk !== "block") return [];
	if (
		content.length > FRONTMATTER_PARSE_LIMIT_CHARS
		&& result.reasons.includes("malformed-frontmatter:missing-closing-fence")
	) {
		return ["frontmatter-exceeds-validation-limit"];
	}
	return result.reasons.length > 0 ? result.reasons : ["invalid-frontmatter"];
}

function randomBase64UrlId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validRevision(value: LocalFileRevision): boolean {
	return Number.isFinite(value.mtime)
		&& value.mtime >= 0
		&& Number.isSafeInteger(value.size)
		&& value.size >= 0;
}

function sameRevision(left: LocalFileRevision, right: LocalFileRevision): boolean {
	return left.mtime === right.mtime && left.size === right.size;
}

async function candidateIdFor(bodyId: string, contentHash: string): Promise<string> {
	return (await sha256TextHex(`${bodyId}\u0000${contentHash}`)).slice(0, 22);
}

function foldedPathKey(path: string): string {
	return canonicalizeVaultPath(path).canonicalKey.toLowerCase();
}

function collisionPaths(items: readonly LocalImportItem[]): Set<string> {
	const grouped = new Map<string, Set<string>>();
	for (const item of items) {
		if (item.status === "excluded" && item.lastError === "excluded-by-settings") continue;
		const key = foldedPathKey(item.path);
		const paths = grouped.get(key) ?? new Set<string>();
		paths.add(item.path);
		grouped.set(key, paths);
	}
	const result = new Set<string>();
	for (const paths of grouped.values()) {
		if (paths.size < 2) continue;
		for (const path of paths) result.add(path);
	}
	return result;
}

export function summarizeLocalVaultImport(state: LocalVaultImportState): LocalVaultImportSummary {
	let imported = 0;
	let excluded = 0;
	let failed = 0;
	let collisions = 0;
	for (const item of state.items) {
		if (item.status === "imported") imported++;
		else if (item.status === "excluded" || item.status === "missing") excluded++;
		else if (item.status === "failed") failed++;
		else if (item.status === "collision") collisions++;
	}
	const problemItems = state.items.filter((item) => !TERMINAL_SUCCESS.has(item.status));
	return {
		stage: state.stage,
		total: state.items.length,
		imported,
		excluded,
		outstanding: problemItems.length,
		failed,
		collisions,
		problems: problemItems.slice(0, 20).map((item) => ({
			path: item.path,
			status: item.status,
			error: item.lastError,
		})),
	};
}

/** Durable, resumable initial local-vault importer. */
export class LocalVaultImporter {
	private readonly now: () => number;
	private readonly makeId: () => string;
	private readonly concurrency: number;
	private readonly pageSize: number;
	private readonly maxEditRetries: number;

	constructor(
		private readonly source: LocalVaultImportSource,
		private readonly sink: LocalVaultImportSink,
		private readonly store: LocalVaultImportStateStore,
		private readonly options: LocalVaultImportOptions,
	) {
		this.now = options.now ?? Date.now;
		this.makeId = options.makeId ?? randomBase64UrlId;
		this.concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? 4)));
		this.pageSize = Math.max(1, Math.min(1000, Math.floor(options.pageSize ?? 250)));
		this.maxEditRetries = Math.max(1, Math.min(20, Math.floor(options.maxEditRetries ?? 4)));
	}
	async loadState(): Promise<LocalVaultImportState | null> {
		const state = await this.store.load(this.options.vaultId);
		return state ? this.normalizeResumedState(state) : null;
	}


	async capture(): Promise<LocalVaultImportState> {
		const existing = await this.store.load(this.options.vaultId);
		if (existing) return this.normalizeResumedState(existing);

		const inventory = [...await this.source.captureInventory()]
			.filter((entry) => entry.path.length > 0 && validRevision(entry))
			.sort((left, right) => left.path.localeCompare(right.path));
		const seenExact = new Set<string>();
		const items: LocalImportItem[] = [];
		for (const entry of inventory) {
			if (seenExact.has(entry.path)) continue;
			seenExact.add(entry.path);
			const intentionallyExcluded = isExcluded(
				entry.path,
				[...this.options.excludePatterns],
				this.options.configDir,
			);
			const normalized = safeMarkdownPath(
				entry.path,
				this.options.excludePatterns,
				this.options.configDir,
			);
			items.push({
				path: entry.path,
				captured: { mtime: entry.mtime, size: entry.size },
				bodyId: this.makeId(),
				candidateId: this.makeId(),
				status: normalized === null ? "excluded" : "pending",
				attempts: 0,
				lastError: normalized === null
					? (intentionallyExcluded ? "excluded-by-settings" : "unsafe-path")
					: null,
				lastContentHash: null,
				importedRevision: null,
			});
		}
		const itemsByPath = new Map<string, LocalImportItem>();
		for (const item of items) itemsByPath.set(item.path, item);
		for (const path of collisionPaths(items)) {
			const item = itemsByPath.get(path);
			if (!item) continue;
			item.status = "collision";
			item.lastError = "unicode-or-case-path-collision";
		}
		const capturedAt = this.now();
		const state: LocalVaultImportState = {
			format: LOCAL_VAULT_IMPORT_FORMAT,
			importId: this.makeId(),
			vaultId: this.options.vaultId,
			capturedAt,
			updatedAt: capturedAt,
			stage: "captured",
			items,
		};
		await this.store.save(state);
		this.emit(state);
		return state;
	}

	async run(): Promise<LocalVaultImportState> {
		const state = await this.capture();
		await this.refreshCollisionWork(state);
		state.stage = "importing";
		state.updatedAt = this.now();
		await this.store.save(state);

		for (let offset = 0; offset < state.items.length; offset += this.pageSize) {
			const page = state.items.slice(offset, offset + this.pageSize)
				.filter((item) => RETRYABLE.has(item.status));
			await this.importPage(state, page);
			state.updatedAt = this.now();
			await this.store.save(state);
			this.emit(state);
		}

		state.stage = state.items.every((item) => TERMINAL_SUCCESS.has(item.status))
			? "complete"
			: "attention-required";
		state.updatedAt = this.now();
		await this.store.save(state);
		this.emit(state);
		return state;
	}

	private normalizeResumedState(state: LocalVaultImportState): LocalVaultImportState {
		if (state.format !== LOCAL_VAULT_IMPORT_FORMAT || state.vaultId !== this.options.vaultId) {
			throw new Error("local import state identity mismatch");
		}
		for (const item of state.items) {
			if (item.status === "importing") item.status = "pending";
		}
		return state;
	}
	private async refreshCollisionWork(state: LocalVaultImportState): Promise<void> {
		const collisionItems = state.items.filter((item) => item.status === "collision");
		if (collisionItems.length === 0) return;
		const present: LocalImportItem[] = [];
		for (const item of collisionItems) {
			if (await this.source.stat(item.path)) {
				present.push(item);
			} else {
				item.status = "missing";
				item.lastError = "colliding-file-removed-before-import";
			}
		}
		const stillColliding = collisionPaths(present);
		for (const item of present) {
			if (stillColliding.has(item.path)) continue;
			item.status = "pending";
			item.lastError = null;
		}
	}


	private async importPage(state: LocalVaultImportState, page: LocalImportItem[]): Promise<void> {
		for (const item of page) item.status = "pending";
		for (let round = 0; round < this.maxEditRetries; round++) {
			const pending = page.filter((item) => item.status === "pending");
			if (pending.length === 0) return;
			const prepared = (await this.mapBounded(
				pending,
				(item) => this.prepareItem(state, item),
			)).filter((value): value is PreparedLocalImport => value !== null);
			if (this.sink.importFiles) {
				for (const chunk of this.importBatches(prepared)) {
					await this.commitPreparedBatch(state, chunk);
				}
			} else {
				for (let offset = 0; offset < prepared.length; offset += this.concurrency) {
					const chunk = prepared.slice(offset, offset + this.concurrency);
					await Promise.all(chunk.map((value) => this.commitPrepared(state, value)));
				}
			}
		}
		for (const item of page) {
			if (item.status !== "pending") continue;
			item.status = "failed";
			item.lastError = "file-kept-changing-during-import";
		}
	}

	private async prepareItem(
		state: LocalVaultImportState,
		item: LocalImportItem,
	): Promise<PreparedLocalImport | null> {
		item.status = "importing";
		item.attempts++;
		item.lastError = null;
		state.updatedAt = this.now();
		try {
			const before = await this.source.stat(item.path);
			if (!before) {
				item.status = "missing";
				item.lastError = "file-removed-during-import";
				return null;
			}
			const content = await this.source.read(item.path);
			const afterRead = await this.source.stat(item.path);
			if (!afterRead) {
				item.status = "missing";
				item.lastError = "file-removed-during-import";
				return null;
			}
			if (!sameRevision(before, afterRead)) {
				item.status = "pending";
				item.lastError = "file-edited-while-reading";
				return null;
			}

			const bytes = new TextEncoder().encode(content).byteLength;
			const frontmatterReasons = validateBoundedImportFrontmatter(content);
			if (frontmatterReasons.length > 0) {
				item.status = "invalid-frontmatter";
				item.lastError = frontmatterReasons.join(",");
				return null;
			}
			if (this.options.maxFileSizeBytes > 0 && bytes > this.options.maxFileSizeBytes) {
				item.status = "oversized";
				item.lastError = `file-size-${bytes}-exceeds-${this.options.maxFileSizeBytes}`;
				return null;
			}
			const contentHash = await sha256TextHex(content);
			item.lastContentHash = contentHash;
			item.candidateId = await candidateIdFor(item.bodyId, contentHash);
			return { item, content, revision: afterRead, contentHash };
		} catch (error) {
			item.status = "failed";
			item.lastError = errorMessage(error);
			return null;
		} finally {
			state.updatedAt = this.now();
		}
	}

	private importBatches(
		prepared: readonly PreparedLocalImport[],
	): PreparedLocalImport[][] {
		const batches: PreparedLocalImport[][] = [];
		let current: PreparedLocalImport[] = [];
		let bytes = 0;
		for (const item of prepared) {
			const itemBytes = new TextEncoder().encode(item.content).byteLength;
			if (current.length > 0 && (current.length >= 32 || bytes + itemBytes > 4 * 1024 * 1024)) {
				batches.push(current);
				current = [];
				bytes = 0;
			}
			current.push(item);
			bytes += itemBytes;
		}
		if (current.length > 0) batches.push(current);
		return batches;
	}

	private async commitPreparedBatch(
		state: LocalVaultImportState,
		prepared: readonly PreparedLocalImport[],
	): Promise<void> {
		try {
			const committed = await this.sink.importFiles!(
				prepared.map(({ item, content, contentHash }) => ({
					path: item.path,
					content,
					bodyId: item.bodyId,
					candidateId: item.candidateId,
					contentHash,
				})),
			);
			if (committed.length !== prepared.length) {
				throw new Error("initial import batch result count mismatch");
			}
			for (let index = 0; index < prepared.length; index++) {
				prepared[index]!.item.bodyId = committed[index]!.bodyId;
			}
			await Promise.all(prepared.map(async (value) => {
				const afterCommit = await this.source.stat(value.item.path);
				if (!afterCommit) {
					value.item.status = "missing";
					value.item.lastError = "file-removed-after-import";
				} else if (!sameRevision(value.revision, afterCommit)) {
					value.item.status = "pending";
					value.item.lastError = "file-edited-during-import";
				} else {
					value.item.status = "imported";
					value.item.importedRevision = afterCommit;
					value.item.lastError = null;
				}
			}));
		} catch (error) {
			for (const value of prepared) {
				value.item.status = "failed";
				value.item.lastError = errorMessage(error);
			}
		} finally {
			state.updatedAt = this.now();
		}
	}

	private async commitPrepared(
		state: LocalVaultImportState,
		prepared: PreparedLocalImport,
	): Promise<void> {
		const { item } = prepared;
		try {
			const committed = await this.sink.importFile({
				path: item.path,
				content: prepared.content,
				bodyId: item.bodyId,
				candidateId: item.candidateId,
				contentHash: prepared.contentHash,
			});
			item.bodyId = committed.bodyId;
			const afterCommit = await this.source.stat(item.path);
			if (!afterCommit) {
				item.status = "missing";
				item.lastError = "file-removed-after-import";
				return;
			}
			if (!sameRevision(prepared.revision, afterCommit)) {
				item.status = "pending";
				item.lastError = "file-edited-during-import";
				return;
			}
			item.status = "imported";
			item.importedRevision = afterCommit;
			item.lastError = null;
		} catch (error) {
			item.status = "failed";
			item.lastError = errorMessage(error);
		} finally {
			state.updatedAt = this.now();
		}
	}

	private async mapBounded<T, R>(
		items: readonly T[],
		work: (item: T) => Promise<R>,
	): Promise<R[]> {
		const results = new Array<R>(items.length);
		let next = 0;
		const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				const item = items[index];
				if (item !== undefined) results[index] = await work(item);
			}
		});
		await Promise.all(workers);
		return results;
	}

	private emit(state: LocalVaultImportState): void {
		this.options.onProgress?.(summarizeLocalVaultImport(state));
	}
}
