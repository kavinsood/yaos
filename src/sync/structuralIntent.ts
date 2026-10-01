import { exactMarkdownDiskFingerprint } from "@shared/markdownCodec";
import type { DiskSettlementFingerprint } from "./bodySettlement";
import type { VaultIndexedDb } from "./vaultIndexedDb";

export interface StructuralIntentScope {
	vaultId: string;
	vaultGeneration: string;
	accountId: string;
	folderKey: string;
}

export interface StructuralRenameMove {
	bodyId: string;
	from: string;
	staging: string;
	to: string;
	expectedContent: string;
	fingerprint: DiskSettlementFingerprint;
}

export interface StructuralRenamePlan {
	operationId: string;
	scope: StructuralIntentScope;
	createdAt: number;
	moves: StructuralRenameMove[];
}

export interface StoredStructuralIntent extends StructuralRenamePlan {
	format: 1;
	kind: "rename-batch";
	phase: "staging" | "placing";
}

export interface StructuralIntentStore {
	get(operationId: string): Promise<StoredStructuralIntent | null>;
	list(): Promise<StoredStructuralIntent[]>;
	put(intent: StoredStructuralIntent): Promise<void>;
	delete(operationId: string): Promise<void>;
}

export type StructuralLocation =
	| { kind: "missing" }
	| { kind: "file"; content: string }
	| { kind: "other" };

export interface StructuralMoveInput {
	operationId: string;
	bodyId: string;
	from: string;
	to: string;
	expectedContent: string;
	fingerprint: DiskSettlementFingerprint;
}

export interface StructuralIntentDiskHost {
	inspect(path: string): Promise<StructuralLocation>;
	moveIfMatches(input: StructuralMoveInput): Promise<boolean>;
	completeBookkeeping(intent: StoredStructuralIntent): Promise<void>;
}

export type StructuralRecoveryResult =
	| { status: "absent" | "completed"; operationId: string }
	| { status: "blocked"; operationId: string; path: string; reason: string };

export function sameStructuralScope(left: StructuralIntentScope, right: StructuralIntentScope): boolean {
	return left.vaultId === right.vaultId && left.vaultGeneration === right.vaultGeneration
		&& left.accountId === right.accountId && left.folderKey === right.folderKey;
}

export function sameStructuralPlan(left: StructuralRenamePlan, right: StructuralRenamePlan): boolean {
	return left.operationId === right.operationId && sameStructuralScope(left.scope, right.scope)
		&& left.createdAt === right.createdAt && left.moves.length === right.moves.length
		&& left.moves.every((move, index) => {
			const other = right.moves[index];
			return other !== undefined && move.bodyId === other.bodyId && move.from === other.from
				&& move.staging === other.staging && move.to === other.to
				&& move.expectedContent === other.expectedContent
				&& move.fingerprint.bytes === other.fingerprint.bytes && move.fingerprint.hash === other.fingerprint.hash;
		});
}

export function cloneStructuralIntent(intent: StoredStructuralIntent): StoredStructuralIntent {
	return { ...intent, scope: { ...intent.scope }, moves: intent.moves.map((move) => ({
		...move, fingerprint: { ...move.fingerprint },
	})) };
}

function validPath(path: string): boolean {
	return typeof path === "string" && path.length > 0 && !path.includes("\\") && !path.includes("\0")
		&& !path.includes(":") && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function validateStructuralIntent(intent: StoredStructuralIntent): void {
	if (intent.format !== 1 || intent.kind !== "rename-batch"
		|| (intent.phase !== "staging" && intent.phase !== "placing")
		|| typeof intent.operationId !== "string" || !intent.operationId.trim()
		|| !Number.isFinite(intent.createdAt) || !intent.scope
		|| [intent.scope.vaultId, intent.scope.vaultGeneration, intent.scope.accountId, intent.scope.folderKey]
			.some((value) => typeof value !== "string" || !value.trim())
		|| !Array.isArray(intent.moves) || intent.moves.length === 0) {
		throw new Error("Invalid structural rename intent identity or format");
	}
	const bodies = new Set<string>();
	const sources = new Set<string>();
	const destinations = new Set<string>();
	const stages = new Set<string>();
	for (const move of intent.moves) {
		if (!move || typeof move.bodyId !== "string" || !move.bodyId.trim() || bodies.has(move.bodyId)
			|| !validPath(move.from) || !validPath(move.staging) || !validPath(move.to) || move.from === move.to
			|| sources.has(move.from) || destinations.has(move.to) || stages.has(move.staging)
			|| typeof move.expectedContent !== "string" || !move.fingerprint
			|| !Number.isSafeInteger(move.fingerprint.bytes) || move.fingerprint.bytes < 0
			|| !/^[a-f0-9]{64}$/.test(move.fingerprint.hash)) {
			throw new Error("Invalid structural rename move or duplicate identity/path");
		}
		bodies.add(move.bodyId);
		sources.add(move.from);
		destinations.add(move.to);
		stages.add(move.staging);
	}
	if ([...stages].some((stage) => sources.has(stage) || destinations.has(stage))) {
		throw new Error("Structural staging paths must be disjoint from all source and destination paths");
	}
}

export class VaultIndexedDbStructuralIntentStore implements StructuralIntentStore {
	constructor(private readonly database: VaultIndexedDb, private readonly scope: StructuralIntentScope) {}
	get(operationId: string): Promise<StoredStructuralIntent | null> {
		return this.database.getStructuralIntent(this.scope, operationId);
	}
	list(): Promise<StoredStructuralIntent[]> {
		return this.database.listStructuralIntents(this.scope);
	}
	put(intent: StoredStructuralIntent): Promise<void> {
		if (!sameStructuralScope(intent.scope, this.scope)) throw new Error("Structural intent scope mismatch");
		return this.database.putStructuralIntent(intent);
	}
	delete(operationId: string): Promise<void> {
		return this.database.deleteStructuralIntent(this.scope, operationId);
	}
}

export class StructuralIntentRecovery {
	constructor(
		private readonly scope: StructuralIntentScope,
		private readonly store: StructuralIntentStore,
		private readonly host: StructuralIntentDiskHost,
	) {}

	async prepare(plan: StructuralRenamePlan): Promise<StoredStructuralIntent> {
		const intent = cloneStructuralIntent({ ...plan, format: 1, kind: "rename-batch", phase: "staging" });
		await this.validate(intent);
		const existing = await this.store.get(intent.operationId);
		if (existing) {
			await this.validate(existing);
			if (!sameStructuralPlan(existing, intent)) throw new Error("Structural operation ID already has a different plan");
			return existing;
		}
		await this.store.put(intent);
		return intent;
	}

	async recoverAll(): Promise<StructuralRecoveryResult[]> {
		const results: StructuralRecoveryResult[] = [];
		for (const intent of await this.store.list()) results.push(await this.recover(intent.operationId));
		return results;
	}

	async recover(operationId: string): Promise<StructuralRecoveryResult> {
		const stored = await this.store.get(operationId);
		if (!stored) return { status: "absent", operationId };
		let intent = cloneStructuralIntent(stored);
		await this.validate(intent);
		let inspection = await this.inspect(intent);
		if (inspection.blocked) return inspection.blocked;
		if (intent.phase === "staging") {
			for (const move of intent.moves) {
				if (inspection.locations.get(move.bodyId) === move.staging) continue;
				if (!await this.move(intent, move, move.from, move.staging)) {
					return this.blocked(intent, move.from, "Source changed or staging became occupied; preserve files and retry after inspection");
				}
			}
			inspection = await this.inspect(intent);
			if (inspection.blocked) return inspection.blocked;
			if (intent.moves.some((move) => inspection.locations.get(move.bodyId) !== move.staging)) {
				return this.blocked(intent, intent.moves[0]!.from, "Staging did not complete; preserve files and inspect the rename host");
			}
			intent = { ...intent, phase: "placing" };
			await this.store.put(intent);
			inspection = await this.inspect(intent);
			if (inspection.blocked) return inspection.blocked;
		}
		for (const move of intent.moves) {
			if (inspection.locations.get(move.bodyId) === move.to) continue;
			if (!await this.move(intent, move, move.staging, move.to)) {
				return this.blocked(intent, move.to, "Staged content changed or destination became occupied; preserve files and retry after inspection");
			}
		}
		inspection = await this.inspect(intent);
		if (inspection.blocked) return inspection.blocked;
		if (intent.moves.some((move) => inspection.locations.get(move.bodyId) !== move.to)) {
			return this.blocked(intent, intent.moves[0]!.to, "Placement did not complete; preserve files and inspect the rename host");
		}
		await this.host.completeBookkeeping(cloneStructuralIntent(intent));
		await this.store.delete(operationId);
		return { status: "completed", operationId };
	}

	private async validate(intent: StoredStructuralIntent): Promise<void> {
		validateStructuralIntent(intent);
		if (!sameStructuralScope(intent.scope, this.scope)) throw new Error("Structural intent scope mismatch");
		for (const move of intent.moves) {
			const fingerprint = await exactMarkdownDiskFingerprint(move.expectedContent);
			if (fingerprint.bytes !== move.fingerprint.bytes || fingerprint.hash !== move.fingerprint.hash) {
				throw new Error(`Structural expected-content fingerprint mismatch: ${move.from}`);
			}
		}
	}

	private async inspect(intent: StoredStructuralIntent): Promise<{
		locations: Map<string, string>;
		blocked?: Extract<StructuralRecoveryResult, { status: "blocked" }>;
	}> {
		const paths = new Set(intent.moves.flatMap((move) => [move.from, move.staging, move.to]));
		const disk = new Map<string, StructuralLocation>();
		for (const path of paths) disk.set(path, await this.host.inspect(path));
		const locations = new Map<string, string>();
		const expected = new Map<string, string>();
		for (const move of intent.moves) {
			const first = intent.phase === "staging" ? move.from : move.staging;
			const second = intent.phase === "staging" ? move.staging : move.to;
			const firstEntry = disk.get(first)!;
			const secondEntry = disk.get(second)!;
			const firstMatches = firstEntry.kind === "file" && firstEntry.content === move.expectedContent;
			const secondMatches = secondEntry.kind === "file" && secondEntry.content === move.expectedContent;
			const location = firstMatches && secondEntry.kind === "missing" ? first
				: secondMatches && firstEntry.kind === "missing" ? second : null;
			if (!location) {
				const path = firstEntry.kind !== "missing" && !firstMatches ? first : second;
				return { locations, blocked: this.blocked(intent, path,
					"Missing, changed, occupied, or duplicate planned file; preserve all locations and resolve before retry") };
			}
			locations.set(move.bodyId, location);
			expected.set(location, move.expectedContent);
		}
		for (const [path, entry] of disk) {
			if (!expected.has(path) && entry.kind !== "missing") {
				return { locations, blocked: this.blocked(intent, path,
					"Unexpected occupied path; preserve this file and resolve the obstruction before retry") };
			}
		}
		return { locations };
	}

	private move(intent: StoredStructuralIntent, move: StructuralRenameMove, from: string, to: string): Promise<boolean> {
		return this.host.moveIfMatches({ operationId: intent.operationId, bodyId: move.bodyId, from, to,
			expectedContent: move.expectedContent, fingerprint: { ...move.fingerprint } });
	}

	private blocked(intent: StoredStructuralIntent, path: string, reason: string): Extract<StructuralRecoveryResult, { status: "blocked" }> {
		return { status: "blocked", operationId: intent.operationId, path, reason };
	}
}
