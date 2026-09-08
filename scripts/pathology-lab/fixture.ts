import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { canonicalMarkdownBytes, canonicalizeMarkdown } from "../../server/src/shared/markdownCodec";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { readFrozenFrames, readTraceManifest, sha256 } from "./trace";

export const VAULT_ID = "pathology-vault-0001";
export const VAULT_GENERATION = "pathology-generation-0001";
export const BODY_PATH = "pathology.md";
export const ACTOR = {
	vaultId: VAULT_ID,
	vaultGeneration: VAULT_GENERATION,
	principalId: "pathology-principal-0001",
	membershipRevision: 1,
	deviceId: "pathology-device-0001",
	deviceCredentialRevision: 1,
	role: "owner",
	policyVersion: 1,
	capabilityDigest: "pathology-capability-0001",
} as const;

export interface StoreFixture {
	readonly directory: string;
	readonly ownsDirectory: boolean;
	readonly sqlite: NodeSqliteStorage;
	readonly store: VaultStore;
	readonly queries: { count: number };
}

export function openStore(databasePath?: string): StoreFixture {
	const ownsDirectory = databasePath === undefined;
	const directory = databasePath ? dirname(databasePath) : mkdtempSync(join(tmpdir(), "yaos-pathology-store-"));
	const sqlite = NodeSqliteStorage.open(databasePath ?? join(directory, "vault.sqlite"));
	const queries = { count: 0 };
	const storage = {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				queries.count++;
				return sqlite.sql.exec(query, ...bindings);
			},
		},
		transactionSync<T>(closure: () => T): T {
			return sqlite.transactionSync(closure);
		},
	} as unknown as VaultStoragePort;
	return { directory, ownsDirectory, sqlite, store: new VaultStore(storage), queries };
}

export function closeStore(fixture: StoreFixture): void {
	fixture.sqlite.close();
	if (fixture.ownsDirectory) rmSync(fixture.directory, { recursive: true, force: true });
}

export function seedStore(traceDirectory: string, fixture: StoreFixture): void {
	const manifest = readTraceManifest(traceDirectory);
	const root = new Y.Doc({ guid: "root" });
	root.clientID = 0x1a05_2001;
	root.getMap<string>("pathToId").set(BODY_PATH, manifest.bodyId);
	fixture.store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root));
	root.destroy();
	fixture.store.installAuthorityFence({
		changeId: "pathology-authority-0001",
		vaultId: VAULT_ID,
		vaultGeneration: VAULT_GENERATION,
		subjectDigest: "a".repeat(64),
		subjects: [
			{ principalId: ACTOR.principalId, role: ACTOR.role, state: "active",
				membershipRevision: ACTOR.membershipRevision, policyVersion: ACTOR.policyVersion,
				capabilityDigest: ACTOR.capabilityDigest, displayName: "Pathology actor", colorSeed: ACTOR.principalId },
			{ deviceId: ACTOR.deviceId, principalId: ACTOR.principalId, state: "active",
				credentialRevision: ACTOR.deviceCredentialRevision },
		],
	});
	const base = new Uint8Array(readFileSync(join(traceDirectory, "base.update")));
	const baseDocument = new Y.Doc({ guid: manifest.bodyId });
	Y.applyUpdate(baseDocument, base);
	const baseContent = canonicalMarkdownBytes(canonicalizeMarkdown(baseDocument.getText("body").toString()));
	baseDocument.destroy();
	fixture.store.commitUpdate({
		documentId: manifest.bodyId,
		update: base,
		kind: "body",
		catalog: {
			bodyId: manifest.bodyId,
			fileId: manifest.bodyId,
			path: BODY_PATH,
			previousPath: null,
			lifecycle: "active",
			bodyGeneration: 1,
			contentHash: sha256(baseContent),
			size: baseContent.byteLength,
		},
	});
}

export function populateStoreFromCandidates(traceDirectory: string, fixture: StoreFixture): number {
	seedStore(traceDirectory, fixture);
	const manifest = readTraceManifest(traceDirectory);
	let commits = 0;
	for (const update of readFrozenFrames(join(traceDirectory, "candidates.bin"))) {
		fixture.store.commitUpdate({ documentId: manifest.bodyId, update, kind: "body" });
		commits++;
	}
	return commits;
}
