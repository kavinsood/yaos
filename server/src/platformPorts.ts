import type { SettingsDurableStorage } from "./settingsSyncStore";
import type { VaultStoragePort } from "./vaultDocumentStore";
import type { RecoveryJobStoragePort } from "./recoveryJobState";

export interface AlarmPort {
	setAlarm(scheduledTime: number): Promise<void>;
	deleteAlarm(): Promise<void>;
	getAlarm?(): Promise<number | null>;
}

export interface ExecutionPort {
	waitUntil(task: Promise<unknown>): void;
}

export interface DrainPort {
	drain(): Promise<void>;
}

export interface ControlPlaneTransactionPort {
	get<T = unknown>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	readonly records?: ControlPlaneRecordTransactionPort;
}

export interface ControlPlaneRecordTransactionPort {
	get<T = unknown>(collection: string, filter: ControlPlaneRecordFilter): Promise<T | undefined>;
	upsert(collection: string, record: unknown): Promise<void>;
	delete(collection: string, recordKey: string): Promise<boolean>;
	deleteWhere(collection: string, filter: ControlPlaneRecordFilter): Promise<number>;
	count(collection: string, filter?: ControlPlaneRecordFilter): Promise<number>;
	append(collection: string, record: unknown, maximumRecords: number): Promise<void>;
	list<T = unknown>(collection: string, options?: ControlPlaneRecordListOptions): Promise<T[]>;
}

export interface ControlPlaneRecordFilter {
	recordKey?: string;
	vaultId?: string;
	vaultGeneration?: string;
	principalId?: string;
	deviceId?: string;
	tokenHash?: string;
	codeHash?: string;
	pairingCodeHash?: string;
	requestId?: string;
	authorizationChangeId?: string;
	state?: string;
	role?: string;
	purpose?: string;
	consumed?: boolean;
	expiresAfter?: number;
	expiresAtOrBefore?: number;
	createdBefore?: number;
	completedAtOrBefore?: number;
}

export interface ControlPlaneRecordListOptions extends ControlPlaneRecordFilter {
	limit?: number;
	reverse?: boolean;
}

export interface ControlPlaneStoragePort {
	get<T = unknown>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	transaction<T>(closure: (transaction: ControlPlaneTransactionPort) => Promise<T>): Promise<T>;
}

export interface VaultRuntimeStoragePort extends VaultStoragePort {
	readonly sql: VaultStoragePort["sql"] & SettingsDurableStorage["sql"];
	deleteAll(): Promise<void>;
}

export interface RecoveryRuntimeStoragePort extends RecoveryJobStoragePort {
	deleteAll(): Promise<void>;
}

export interface ObjectMetadata {
	key: string;
	size: number;
	uploadedAt: number;
	contentType: string | null;
	customMetadata: Readonly<Record<string, string>>;
}

export interface ObjectBody extends ObjectMetadata {
	bytes: Uint8Array;
}

export interface ObjectWriteOptions {
	contentType?: string;
	customMetadata?: Readonly<Record<string, string>>;
}

export interface ObjectListPage {
	objects: ObjectMetadata[];
	cursor: string | null;
	truncated: boolean;
}

/** Immutable publication is a first-class operation; implementations must never emulate it with a check-then-put. */
export interface ObjectStorePort {
	head(key: string): Promise<ObjectMetadata | null>;
	get(key: string): Promise<ObjectBody | null>;
	put(key: string, bytes: Uint8Array, options?: ObjectWriteOptions): Promise<void>;
	createOnly(key: string, bytes: Uint8Array, options?: ObjectWriteOptions): Promise<"created" | "exists">;
	delete(key: string): Promise<void>;
	list(input: { prefix: string; cursor?: string; limit?: number }): Promise<ObjectListPage>;
	/**
	 * Optional (b3-clientblob): store `length` bytes streamed from `body`, verified
	 * by the store against `sha256` (lowercase hex) before the object becomes
	 * visible. A store that implements it neither buffers nor hashes in the
	 * caller's isolate; `digest_mismatch` means nothing was stored.
	 */
	putVerifiedStream?(
		key: string,
		body: ReadableStream<Uint8Array>,
		length: number,
		sha256: string,
		options?: ObjectWriteOptions,
	): Promise<"stored" | "digest_mismatch">;
}

/** Calls one stable named actor without exposing a platform namespace or actor identifier type. */
export interface ActorCallPort {
	call(actorName: string, request: Request): Promise<Response>;
}

/** Produces the host-specific upgrade result for a socket rejected after the HTTP upgrade request. */
export interface SocketUpgradePort {
	reject(frame: string, closeCode: number, reason: string): Response;
}
