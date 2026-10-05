import {
	MARKDOWN_CANONICAL_VERSION,
	canonicalizeMarkdown,
	type MarkdownCanonicalVersion,
} from "@shared/markdownCodec";
import {
	FRONTMATTER_BOUNDARY_VERSION,
	splitMarkdownComponents,
	type FrontmatterBoundaryVersion,
} from "./frontmatterBoundary";

export const BODY_SETTLEMENT_FORMAT = 2;

export interface DiskSettlementFingerprint {
	bytes: number;
	hash: string;
}

export interface SettlementComponentBase {
	kind: "available";
	content: string;
	contentHash: string;
	advancedAtGeneration: number;
}

export interface MissingSettlementComponentBase {
	kind: "missing";
}

interface StoredBodySettlementCommon {
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

/** Read-only compatibility with format-1 records during the schema cutover. */
export interface StoredBodySettlementV1 extends StoredBodySettlementCommon {
	format: 1;
}

export interface StoredBodySettlementV2 extends StoredBodySettlementCommon {
	format: typeof BODY_SETTLEMENT_FORMAT;
	boundaryVersion: FrontmatterBoundaryVersion;
	agreement: "whole" | "body-only";
	diskContentHash: string;
	bodyBase: SettlementComponentBase;
	propertiesBase: SettlementComponentBase | MissingSettlementComponentBase;
	observation: {
		serverBodyHash: string;
		serverPropertiesHash: string;
		diskBodyHash: string;
		diskPropertiesHash: string;
	};
}

export type StoredBodySettlement = StoredBodySettlementV1 | StoredBodySettlementV2;

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
	| "boundary-version"
	| "content-not-canonical"
	| "content-hash"
	| "server-content-hash"
	| "disk-content-hash"
	| "disk-fingerprint"
	| "path"
	| "durable-generation"
	| "local-revision"
	| "timestamp"
	| "component-base"
	| "component-observation"
	| "content-boundary"
	| "content-corrupt";

export type BodySettlementRead =
	| { kind: "available"; settlement: StoredBodySettlement }
	| { kind: "missing" }
	| { kind: "invalid"; reason: InvalidBodySettlementReason };

export type BodySettlementWrite =
	| { kind: "stored"; settlement: StoredBodySettlementV2 }
	| { kind: "superseded"; current: BodySettlementRead };

function hashIsValid(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

export function validateBodySettlement(
	value: StoredBodySettlement,
	bodyId: string,
	scope: BodySettlementScope,
): InvalidBodySettlementReason | null {
	if (value.format !== 1 && value.format !== BODY_SETTLEMENT_FORMAT) return "format";
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
	if (value.format === 1) return null;
	if (value.boundaryVersion !== FRONTMATTER_BOUNDARY_VERSION) return "boundary-version";
	if (value.agreement !== "whole" && value.agreement !== "body-only") return "component-observation";
	if (!hashIsValid(value.diskContentHash)) return "disk-content-hash";
	if (value.serverContentHash !== value.contentHash) return "server-content-hash";
	const content = splitMarkdownComponents(value.content);
	if (content.kind === "ambiguous") return "content-boundary";
	if (!validComponentBase(value.bodyBase, false, false)
		|| !validComponentBase(value.propertiesBase, true, true)) {
		return "component-base";
	}
	if (!Object.values(value.observation).every(hashIsValid)) return "component-observation";
	if (value.bodyBase.content !== content.body
		|| value.observation.serverBodyHash !== value.observation.diskBodyHash
		|| value.bodyBase.contentHash !== value.observation.serverBodyHash
		|| (value.agreement === "whole"
			&& (value.propertiesBase.kind !== "available"
				|| value.propertiesBase.content !== content.propertiesRegion
				|| value.propertiesBase.contentHash !== value.observation.serverPropertiesHash
				|| value.observation.serverPropertiesHash !== value.observation.diskPropertiesHash
				|| value.diskContentHash !== value.contentHash))) {
		return "component-observation";
	}
	return null;
}

/** Durable component ancestry; uncertainty remains typed and never becomes authority. */
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
		if (stored.format === BODY_SETTLEMENT_FORMAT) {
			const checks = await Promise.all([
				this.hash(stored.bodyBase.content),
				stored.propertiesBase.kind === "available"
					? this.hash(stored.propertiesBase.content)
					: Promise.resolve(null),
			]);
			if (checks[0] !== stored.bodyBase.contentHash
				|| (stored.propertiesBase.kind === "available" && checks[1] !== stored.propertiesBase.contentHash)) {
				return { kind: "invalid", reason: "content-corrupt" };
			}
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
		return this.settleComponents({
			bodyId: input.bodyId,
			serverContent: input.content,
			diskContent: input.content,
			serverContentHash: input.serverContentHash,
			durableGeneration: input.durableGeneration,
			diskFingerprint: input.diskFingerprint,
			pathAtSettlement: input.pathAtSettlement,
			expectedLocalSettlementRevision: input.expectedLocalSettlementRevision,
			settledAt: input.settledAt,
			expectedContentHash: input.contentHash,
		});
	}

	async settleComponents(input: {
		bodyId: string;
		serverContent: string;
		diskContent: string;
		serverContentHash: string;
		durableGeneration: number;
		diskFingerprint: DiskSettlementFingerprint;
		pathAtSettlement: string;
		expectedLocalSettlementRevision: number | null;
		settledAt: number;
		expectedContentHash?: string;
	}): Promise<BodySettlementWrite> {
		const serverContent = canonicalizeMarkdown(input.serverContent);
		const diskContent = canonicalizeMarkdown(input.diskContent);
		const server = splitMarkdownComponents(serverContent);
		const disk = splitMarkdownComponents(diskContent);
		if (server.kind === "ambiguous" || disk.kind === "ambiguous") {
			throw new Error("body settlement content has an ambiguous frontmatter boundary");
		}
		const [contentHash, diskContentHash, serverBodyHash, serverPropertiesHash, diskBodyHash, diskPropertiesHash] =
			await Promise.all([
				this.hash(serverContent),
				this.hash(diskContent),
				this.hash(server.body),
				this.hash(server.propertiesRegion),
				this.hash(disk.body),
				this.hash(disk.propertiesRegion),
			]);
		if (input.expectedContentHash !== undefined && contentHash !== input.expectedContentHash) {
			throw new Error("body settlement content hash does not match canonical content");
		}
		if (input.serverContentHash !== contentHash) throw new Error("server head does not match settlement content");
		if (server.body !== disk.body) throw new Error("partial settlement requires identical body content");

		const current = await this.read(input.bodyId);
		if (current.kind === "available" && input.durableGeneration < current.settlement.durableGeneration) {
			throw new Error("body settlement durable generation cannot regress");
		}
		const observedRevision = current.kind === "available" ? current.settlement.localSettlementRevision : null;
		if (observedRevision !== input.expectedLocalSettlementRevision) return { kind: "superseded", current };
		const agreement = server.propertiesRegion === disk.propertiesRegion ? "whole" : "body-only";
		let propertiesBase: SettlementComponentBase | MissingSettlementComponentBase;
		if (agreement === "whole") {
			propertiesBase = availableBase(server.propertiesRegion, serverPropertiesHash, input.durableGeneration);
		} else if (current.kind !== "available") {
			propertiesBase = { kind: "missing" };
		} else if (current.settlement.format === BODY_SETTLEMENT_FORMAT) {
			propertiesBase = structuredClone(current.settlement.propertiesBase);
		} else {
			const prior = splitMarkdownComponents(current.settlement.content);
			propertiesBase = prior.kind === "ambiguous"
				? { kind: "missing" }
				: availableBase(
					prior.propertiesRegion,
					await this.hash(prior.propertiesRegion),
					current.settlement.durableGeneration,
				);
		}
		const settlement: StoredBodySettlementV2 = {
			format: BODY_SETTLEMENT_FORMAT,
			bodyId: input.bodyId,
			vaultGeneration: this.scope.vaultGeneration,
			canonicalVersion: this.scope.canonicalVersion,
			boundaryVersion: FRONTMATTER_BOUNDARY_VERSION,
			agreement,
			content: serverContent,
			contentHash,
			diskContentHash,
			durableGeneration: input.durableGeneration,
			serverContentHash: input.serverContentHash,
			diskFingerprint: input.diskFingerprint,
			pathAtSettlement: input.pathAtSettlement,
			localSettlementRevision: (input.expectedLocalSettlementRevision ?? 0) + 1,
			settledAt: input.settledAt,
			bodyBase: availableBase(server.body, serverBodyHash, input.durableGeneration),
			propertiesBase,
			observation: { serverBodyHash, serverPropertiesHash, diskBodyHash, diskPropertiesHash },
		};
		const invalid = validateBodySettlement(settlement, input.bodyId, this.scope);
		if (invalid) throw new Error(`body settlement is invalid: ${invalid}`);
		if (!await this.store.compareAndSwapBodySettlement(settlement, input.expectedLocalSettlementRevision)) {
			return { kind: "superseded", current: await this.read(input.bodyId) };
		}
		return { kind: "stored", settlement };
	}

	async retire(bodyId: string): Promise<void> {
		await this.store.deleteBodySettlement(bodyId);
	}
}

function availableBase(content: string, contentHash: string, generation: number): SettlementComponentBase {
	return { kind: "available", content, contentHash, advancedAtGeneration: generation };
}

function validComponentBase(
	base: SettlementComponentBase | MissingSettlementComponentBase,
	allowMissing: boolean,
	propertiesRegion: boolean,
): boolean {
	if (base.kind === "missing") return allowMissing;
	if (propertiesRegion && base.content !== "") {
		const split = splitMarkdownComponents(base.content);
		if (split.kind !== "present" || split.body !== "" || split.propertiesRegion !== base.content) return false;
	}
	return canonicalizeMarkdown(base.content) === base.content
		&& hashIsValid(base.contentHash)
		&& Number.isSafeInteger(base.advancedAtGeneration)
		&& base.advancedAtGeneration >= 0;
}
