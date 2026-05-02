import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as nodePath from "node:path";
import * as Y from "yjs";
import { writeFileAtomic } from "./fs";

export const STATE_UPDATE_FILENAME = ".yaos-state.bin";
export const STATE_METADATA_FILENAME = ".yaos-state.json";

export interface StatePersistencePaths {
	updatePath: string;
	metadataPath: string;
}

export interface LoadedStateUpdate {
	loaded: boolean;
	update: Uint8Array | null;
	updatePath: string;
	byteLength: number;
	stateVectorHash: string | null;
}

export interface StatePersistenceMetadata {
	host: string;
	vaultId: string;
	schemaVersion: number | null;
	activePathCount: number;
	syncedAt: string;
	stateUpdateBytes: number;
	stateVectorHash: string;
}

export interface StatePersistenceIdentity {
	host: string;
	vaultId: string;
}

export function getStatePersistencePaths(rootDir: string): StatePersistencePaths {
	return {
		updatePath: nodePath.join(rootDir, STATE_UPDATE_FILENAME),
		metadataPath: nodePath.join(rootDir, STATE_METADATA_FILENAME),
	};
}

export function loadStateUpdate(rootDir: string, expectedIdentity?: StatePersistenceIdentity): LoadedStateUpdate {
	const { updatePath, metadataPath } = getStatePersistencePaths(rootDir);
	let bytes: Buffer;
	try {
		bytes = readFileSync(updatePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				loaded: false,
				update: null,
				updatePath,
				byteLength: 0,
				stateVectorHash: null,
			};
		}
		throw error;
	}

	if (bytes.byteLength === 0) {
		throw new Error(`YAOS state file is empty: ${updatePath}. Delete it to force a full resync.`);
	}

	if (expectedIdentity) {
		const metadata = loadStateMetadata(metadataPath);
		if (metadata.host !== expectedIdentity.host || metadata.vaultId !== expectedIdentity.vaultId) {
			throw new Error(
				`YAOS state cache identity mismatch for ${updatePath}. ` +
				`Expected host=${expectedIdentity.host} vaultId=${expectedIdentity.vaultId}, ` +
				`found host=${metadata.host} vaultId=${metadata.vaultId}. ` +
				"Delete the state files to force a full resync.",
			);
		}
	}

	const validationDoc = new Y.Doc();
	try {
		Y.applyUpdate(validationDoc, bytes);
	} catch (error) {
		throw new Error(
			`Failed to load YAOS state file ${updatePath}: ${(error as Error).message}. ` +
			"Delete it to force a full resync.",
		);
	}

	return {
		loaded: true,
		update: new Uint8Array(bytes),
		updatePath,
		byteLength: bytes.byteLength,
		stateVectorHash: hashStateVector(validationDoc),
	};
}

export async function persistStateUpdate(
	rootDir: string,
	doc: Y.Doc,
	metadata: Omit<StatePersistenceMetadata, "stateUpdateBytes" | "stateVectorHash" | "syncedAt"> & {
		syncedAt?: string;
	},
): Promise<StatePersistenceMetadata> {
	const { updatePath, metadataPath } = getStatePersistencePaths(rootDir);
	const update = Y.encodeStateAsUpdate(doc);
	const persistedMetadata: StatePersistenceMetadata = {
		...metadata,
		syncedAt: metadata.syncedAt ?? new Date().toISOString(),
		stateUpdateBytes: update.byteLength,
		stateVectorHash: hashStateVector(doc),
	};

	await writeFileAtomic(updatePath, update, { mode: 0o600 });
	await writeFileAtomic(
		metadataPath,
		JSON.stringify(persistedMetadata, null, 2) + "\n",
		{ mode: 0o600 },
	);

	return persistedMetadata;
}

function loadStateMetadata(metadataPath: string): StatePersistenceMetadata {
	let raw: string;
	try {
		raw = readFileSync(metadataPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`YAOS state metadata is missing: ${metadataPath}. ` +
				"Delete the state files to force a full resync.",
			);
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Failed to parse YAOS state metadata ${metadataPath}: ${(error as Error).message}. ` +
			"Delete the state files to force a full resync.",
		);
	}

	if (!isStatePersistenceMetadata(parsed)) {
		throw new Error(
			`Invalid YAOS state metadata: ${metadataPath}. ` +
			"Delete the state files to force a full resync.",
		);
	}

	return parsed;
}

function isStatePersistenceMetadata(value: unknown): value is StatePersistenceMetadata {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.host === "string"
		&& typeof record.vaultId === "string"
		&& (record.schemaVersion === null || typeof record.schemaVersion === "number")
		&& typeof record.activePathCount === "number"
		&& typeof record.syncedAt === "string"
		&& typeof record.stateUpdateBytes === "number"
		&& typeof record.stateVectorHash === "string"
	);
}

export function hashStateVector(doc: Y.Doc): string {
	return createHash("sha256").update(Y.encodeStateVector(doc)).digest("hex");
}
