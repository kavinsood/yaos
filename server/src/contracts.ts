import { MAX_DURABLE_UPDATE_BYTES } from "./shared/durableLimits";
export { MAX_DURABLE_UPDATE_BYTES } from "./shared/durableLimits";

export const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;

export const MAX_BODY_ID_LENGTH = 256;
export const MAX_CANDIDATE_BYTES = MAX_DURABLE_UPDATE_BYTES;
export const MAX_PENDING_BYTES_PER_DOCUMENT = 3_500_000;
export const MAX_PENDING_BYTES_PER_SOCKET = 3_500_000;
export const MAX_PENDING_BYTES_PER_VAULT = 14_000_000;
export const MAX_CATCH_UP_BYTES = 8 * 1024 * 1024;
export const MAX_CATCH_UP_BODIES = 100;
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_BODY_SOCKETS = 32;
export const MAX_ROOT_SOCKETS = 32;
export const MAX_AWARENESS_BYTES = 64 * 1024;
export const MAX_LOADED_BODY_ESTIMATED_BYTES = 48 * 1024 * 1024;
export const MAX_TRANSIENT_PENDING_BYTES = 16 * 1024 * 1024;

export interface DurableReceipt {
	vaultId: string;
	vaultGeneration: string;
	bodyId: string;
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	runtimeEpoch: string;
}

export interface BodyCommittedNotification {
	type: "BODY_COMMITTED";
	bodyId: string;
	vaultGeneration: string;
	durableGeneration: number;
	runtimeEpoch: string;
}

export type LifecycleKind = "create" | "delete" | "revive" | "rename";

export interface LifecycleRequest {
	operationId: string;
	kind: LifecycleKind;
	fileId: string;
	bodyId: string;
	path?: string;
	fromPath?: string;
	toPath?: string;
	candidateId?: string;
	candidateDigest?: string;
}

export interface LifecycleReceipt {
	vaultId: string;
	vaultGeneration: string;
	bodyId: string;
	fileId: string;
	operationId: string;
	kind: LifecycleKind;
	lifecycle: "active" | "tombstoned";
	path: string;
	durableGeneration: number;
	vaultSequence: number;
	runtimeEpoch: string;
}

export interface RootPublicationReceipt {
	vaultGeneration: string;
	operationIds: string[];
	vaultSequence: number;
	rootGeneration: number;
	runtimeEpoch: string;
}
