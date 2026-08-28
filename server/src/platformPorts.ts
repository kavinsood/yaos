import type { SettingsDurableStorage } from "./settingsSyncStore";
import type { VaultStoragePort } from "./vaultDocumentStore";
import type { RecoveryJobStoragePort } from "./recoveryJobState";

export interface AlarmPort {
	setAlarm(scheduledTime: number): Promise<void>;
	deleteAlarm(): Promise<void>;
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
}

/** Calls one stable named actor without exposing a platform namespace or actor identifier type. */
export interface ActorCallPort {
	call(actorName: string, request: Request): Promise<Response>;
}

/** Produces the host-specific upgrade result for a socket rejected after the HTTP upgrade request. */
export interface SocketUpgradePort {
	reject(frame: string, closeCode: number, reason: string): Response;
}
