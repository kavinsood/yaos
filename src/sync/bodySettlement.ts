import {
	MARKDOWN_CANONICAL_VERSION,
	canonicalizeMarkdown,
	type MarkdownCanonicalVersion,
} from "@shared/markdownCodec";

export const BODY_SETTLEMENT_FORMAT = 1;

export interface DiskSettlementFingerprint {
	bytes: number;
	hash: string;
}

export interface StoredBodySettlement {
	format: typeof BODY_SETTLEMENT_FORMAT;
	bodyId: string;
	vaultGeneration: string;
	canonicalVersion: MarkdownCanonicalVersion;
	content: string;
	contentHash: string;
	durableGeneration: number;
	serverContentHash: string;
	diskFingerprint: DiskSettlementFingerprint;
	pathAtSettlement: string;
	localSettlementRevision: number;
	settledAt: number;
}

export interface BodySettlementStore {
	getBodySettlement(bodyId: string): Promise<StoredBodySettlement | null>;
	compareAndSwapBodySettlement(
		settlement: StoredBodySettlement,
		expectedLocalSettlementRevision: number | null,
	): Promise<boolean>;
	deleteBodySettlement(bodyId: string): Promise<void>;
}

export interface BodySettlementScope {
	vaultGeneration: string;
	canonicalVersion: MarkdownCanonicalVersion;
}

export type InvalidBodySettlementReason =
	| "format"
	| "identity"
	| "vault-generation"
	| "canonical-version"
	| "content-not-canonical"
	| "content-hash"
	| "server-content-hash"
	| "disk-fingerprint"
	| "path"
	| "durable-generation"
	| "local-revision"
	| "timestamp"
	| "content-corrupt";

export type BodySettlementRead =
	| { kind: "available"; settlement: StoredBodySettlement }
	| { kind: "missing" }
	| { kind: "invalid"; reason: InvalidBodySettlementReason };

export type BodySettlementWrite =
	| { kind: "stored"; settlement: StoredBodySettlement }
	| { kind: "superseded"; current: BodySettlementRead };

function hashIsValid(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

export function validateBodySettlement(
	value: StoredBodySettlement,
	bodyId: string,
	scope: BodySettlementScope,
): InvalidBodySettlementReason | null {
	if (value.format !== BODY_SETTLEMENT_FORMAT) return "format";
	if (value.bodyId !== bodyId) return "identity";
	if (value.vaultGeneration !== scope.vaultGeneration) return "vault-generation";
	if (value.canonicalVersion !== scope.canonicalVersion) return "canonical-version";
	if (canonicalizeMarkdown(value.content) !== value.content) return "content-not-canonical";
	if (!hashIsValid(value.contentHash)) return "content-hash";
	if (!hashIsValid(value.serverContentHash)) return "server-content-hash";
	if (!Number.isSafeInteger(value.diskFingerprint?.bytes) || value.diskFingerprint.bytes < 0
		|| !hashIsValid(value.diskFingerprint?.hash)) return "disk-fingerprint";
	if (!value.pathAtSettlement) return "path";
	if (!Number.isSafeInteger(value.durableGeneration) || value.durableGeneration < 0) return "durable-generation";
	if (!Number.isSafeInteger(value.localSettlementRevision) || value.localSettlementRevision < 1) return "local-revision";
	if (!Number.isFinite(value.settledAt) || value.settledAt < 0) return "timestamp";
	return null;
}

/** Durable common ancestry; uncertainty remains typed and never becomes authority. */
export class BodySettlementRepository {
	constructor(
		private readonly store: BodySettlementStore,
		private readonly scope: BodySettlementScope,
		private readonly hash: (content: string) => Promise<string>,
	) {}

	static markdownScope(vaultGeneration: string): BodySettlementScope {
		return { vaultGeneration, canonicalVersion: MARKDOWN_CANONICAL_VERSION };
	}

	async read(bodyId: string): Promise<BodySettlementRead> {
		const stored = await this.store.getBodySettlement(bodyId);
		if (!stored) return { kind: "missing" };
		const invalid = validateBodySettlement(stored, bodyId, this.scope);
		if (invalid) return { kind: "invalid", reason: invalid };
		if (await this.hash(stored.content) !== stored.contentHash) {
			return { kind: "invalid", reason: "content-corrupt" };
		}
		return { kind: "available", settlement: stored };
	}

	async get(bodyId: string): Promise<StoredBodySettlement | null> {
		const result = await this.read(bodyId);
		return result.kind === "available" ? result.settlement : null;
	}

	async settle(input: {
		bodyId: string;
		content: string;
		contentHash: string;
		durableGeneration: number;
		serverContentHash: string;
		diskFingerprint: DiskSettlementFingerprint;
		pathAtSettlement: string;
		expectedLocalSettlementRevision: number | null;
		settledAt: number;
	}): Promise<BodySettlementWrite> {
		const content = canonicalizeMarkdown(input.content);
		const contentHash = await this.hash(content);
		if (contentHash !== input.contentHash) throw new Error("body settlement content hash does not match canonical content");
		if (input.serverContentHash !== contentHash) throw new Error("server head does not match settlement content");
		const current = await this.read(input.bodyId);
		if (current.kind === "available" && input.durableGeneration < current.settlement.durableGeneration) {
			throw new Error("body settlement durable generation cannot regress");
		}
		const expected = input.expectedLocalSettlementRevision;
		const observedRevision = current.kind === "available" ? current.settlement.localSettlementRevision : null;
		if (observedRevision !== expected) return { kind: "superseded", current };
		const settlement: StoredBodySettlement = {
			format: BODY_SETTLEMENT_FORMAT,
			bodyId: input.bodyId,
			vaultGeneration: this.scope.vaultGeneration,
			canonicalVersion: this.scope.canonicalVersion,
			content,
			contentHash,
			durableGeneration: input.durableGeneration,
			serverContentHash: input.serverContentHash,
			diskFingerprint: input.diskFingerprint,
			pathAtSettlement: input.pathAtSettlement,
			localSettlementRevision: (expected ?? 0) + 1,
			settledAt: input.settledAt,
		};
		const invalid = validateBodySettlement(settlement, input.bodyId, this.scope);
		if (invalid) throw new Error(`body settlement is invalid: ${invalid}`);
		if (!await this.store.compareAndSwapBodySettlement(settlement, expected)) {
			return { kind: "superseded", current: await this.read(input.bodyId) };
		}
		return { kind: "stored", settlement };
	}

	async retire(bodyId: string): Promise<void> {
		await this.store.deleteBodySettlement(bodyId);
	}
}
