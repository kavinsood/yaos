/** Durable, exact-membership settings apply queue. */
const DB_NAME = "yaos-settings-sync";
const DB_VERSION = 2;
const STORE = "applyQueue";
const ACCEPTANCE_STORE = "environmentAcceptance";
const RECORD_VERSION = 2;
const ACCEPTANCE_RECORD_VERSION = 2;

export const SETTINGS_SYNC_DB_NAME = DB_NAME;
export const APPLY_QUEUE_STORE = STORE;
export const SETTINGS_SYNC_ACCEPTANCE_STORE = ACCEPTANCE_STORE;

export type ApplyQueueIdentity = {
	hostHash: string;
	vaultId: string;
	vaultGeneration: string;
	folderKey: string;
	deviceId: string;
	principalId?: string;
	membershipRevision?: number;
	deviceCredentialRevision?: number;
	configDirKey: string;
};

export type ApplyQueueScope = ApplyQueueIdentity & {
	indexedDb?: Pick<IDBFactory, "open">;
};

export type PersistedApplyQueue = {
	version: 1 | 2;
	identity: ApplyQueueIdentity;
	steps: unknown[];
	nextIndex: number;
};
type PersistedEnvironmentAcceptance = {
	version: 1 | 2;
	accepted: true;
	identity: ApplyQueueIdentity;
};

export function buildApplyQueueKey(identity: ApplyQueueIdentity): string {
	assertIdentity(identity);
	return [
		identity.hostHash,
		identity.vaultId,
		identity.vaultGeneration,
		identity.folderKey,
		identity.deviceId,
		identity.principalId ?? "",
		String(identity.membershipRevision ?? 0),
		String(identity.deviceCredentialRevision ?? 0),
		identity.configDirKey,
	].map((part) => `${part.length}:${part}`).join("|");
}

export async function persistApplyQueue(
	scope: ApplyQueueScope,
	record: PersistedApplyQueue,
): Promise<void> {
	assertIdentity(scope);
	if (!sameIdentity(scope, record.identity)) {
		throw new Error("settings apply queue identity mismatch");
	}
	const parsed = parsePersisted(record, scope);
	if (!parsed) throw new Error("invalid settings apply queue record");
	const db = await openSettingsSyncDb(factoryOf(scope));
	await putValue(db, STORE, buildApplyQueueKey(scope), parsed);
}

export async function loadApplyQueue(scope: ApplyQueueScope): Promise<PersistedApplyQueue | null> {
	try {
		assertIdentity(scope);
		const db = await openSettingsSyncDb(factoryOf(scope));
		const raw = await getValue(db, STORE, buildApplyQueueKey(scope));
		return parsePersisted(raw, scope);
	} catch {
		return null;
	}
}

export async function checkpointApplyQueue(
	scope: ApplyQueueScope,
	record: PersistedApplyQueue,
): Promise<void> {
	await persistApplyQueue(scope, record);
}

/** Clear only this exact enrollment/folder/config identity. */
export async function clearApplyQueue(scope: ApplyQueueScope): Promise<void> {
	assertIdentity(scope);
	const db = await openSettingsSyncDb(factoryOf(scope));
	await deleteValue(db, STORE, buildApplyQueueKey(scope));
}

export async function loadEnvironmentAcceptance(scope: ApplyQueueScope): Promise<boolean> {
	try {
		assertIdentity(scope);
		const db = await openSettingsSyncDb(factoryOf(scope));
		const raw = await getValue(db, ACCEPTANCE_STORE, buildApplyQueueKey(scope));
		return parseAcceptance(raw, scope) !== null;
	} catch {
		return false;
	}
}

export async function markEnvironmentAccepted(scope: ApplyQueueScope): Promise<void> {
	assertIdentity(scope);
	const record: PersistedEnvironmentAcceptance = {
		version: identityVersion(scope),
		accepted: true,
		identity: copyIdentity(scope),
	};
	const db = await openSettingsSyncDb(factoryOf(scope));
	await putValue(db, ACCEPTANCE_STORE, buildApplyQueueKey(scope), record);
}

export async function clearEnvironmentAcceptance(scope: ApplyQueueScope): Promise<void> {
	assertIdentity(scope);
	const db = await openSettingsSyncDb(factoryOf(scope));
	await deleteValue(db, ACCEPTANCE_STORE, buildApplyQueueKey(scope));
}

/** Membership retirement clears queue and consent only for this exact identity. */
export async function retireApplyQueue(scope: ApplyQueueScope): Promise<void> {
	await clearApplyQueue(scope);
	await clearEnvironmentAcceptance(scope);
}

function parsePersisted(raw: unknown, expected: ApplyQueueIdentity): PersistedApplyQueue | null {
	if (!isRecord(raw)) return null;
	const keys = Object.keys(raw);
	if (
		keys.length !== 4
		|| keys.some((key) => !["version", "identity", "steps", "nextIndex"].includes(key))
	) return null;
	if ((raw.version !== 1 && raw.version !== RECORD_VERSION) || !isIdentity(raw.identity)) return null;
	if (raw.version !== identityVersion(raw.identity)) return null;
	if (!sameIdentity(raw.identity, expected)) return null;
	if (!Array.isArray(raw.steps)) return null;
	if (!Number.isSafeInteger(raw.nextIndex) || (raw.nextIndex as number) < 0) return null;
	if ((raw.nextIndex as number) > raw.steps.length) return null;
	return {
		version: raw.version,
		identity: copyIdentity(raw.identity),
		steps: raw.steps,
		nextIndex: raw.nextIndex as number,
	};
}

function parseAcceptance(
	raw: unknown,
	expected: ApplyQueueIdentity,
): PersistedEnvironmentAcceptance | null {
	if (!isRecord(raw)) return null;
	const keys = Object.keys(raw);
	if (
		keys.length !== 3
		|| keys.some((key) => !["version", "accepted", "identity"].includes(key))
	) return null;
	if (
		(raw.version !== 1 && raw.version !== ACCEPTANCE_RECORD_VERSION)
		|| raw.accepted !== true
		|| !isIdentity(raw.identity)
		|| !sameIdentity(raw.identity, expected)
	) {
		return null;
	}
	return {
		version: raw.version,
		accepted: true,
		identity: copyIdentity(raw.identity),
	};
}

function isIdentity(value: unknown): value is ApplyQueueIdentity {
	if (!isRecord(value)) return false;
	const baseKeys = ["hostHash", "vaultId", "vaultGeneration", "folderKey", "deviceId", "configDirKey"];
	const authorityKeys = ["principalId", "membershipRevision", "deviceCredentialRevision"];
	const keys = [...baseKeys, ...authorityKeys];
	if (Object.keys(value).some((key) => !keys.includes(key))) {
		return false;
	}
	const baseValid = baseKeys
		.every((key) => typeof value[key] === "string" && (value[key] as string).length > 0)
	if (!baseValid) return false;
	const authorityPresent = authorityKeys.some((key) => value[key] !== undefined);
	if (!authorityPresent) return Object.keys(value).length === baseKeys.length;
	return Object.keys(value).length === keys.length
		&& typeof value.principalId === "string" && value.principalId.length > 0
		&& Number.isSafeInteger(value.membershipRevision) && (value.membershipRevision as number) > 0
		&& Number.isSafeInteger(value.deviceCredentialRevision) && (value.deviceCredentialRevision as number) > 0;
}

function identityVersion(identity: ApplyQueueIdentity): 1 | 2 {
	return identity.principalId && identity.membershipRevision && identity.deviceCredentialRevision ? 2 : 1;
}

function assertIdentity(value: ApplyQueueIdentity): void {
	if (!isIdentity(copyIdentity(value))) throw new Error("incomplete settings apply queue identity");
}

function sameIdentity(left: ApplyQueueIdentity, right: ApplyQueueIdentity): boolean {
	return left.hostHash === right.hostHash
		&& left.vaultId === right.vaultId
		&& left.vaultGeneration === right.vaultGeneration
		&& left.folderKey === right.folderKey
		&& left.deviceId === right.deviceId
		&& left.principalId === right.principalId
		&& left.membershipRevision === right.membershipRevision
		&& left.deviceCredentialRevision === right.deviceCredentialRevision
		&& left.configDirKey === right.configDirKey;
}

function copyIdentity(value: ApplyQueueIdentity): ApplyQueueIdentity {
	return {
		hostHash: value.hostHash,
		vaultId: value.vaultId,
		vaultGeneration: value.vaultGeneration,
		folderKey: value.folderKey,
		deviceId: value.deviceId,
		...(value.principalId && value.membershipRevision && value.deviceCredentialRevision ? {
			principalId: value.principalId,
			membershipRevision: value.membershipRevision,
			deviceCredentialRevision: value.deviceCredentialRevision,
		} : {}),
		configDirKey: value.configDirKey,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function factoryOf(scope: ApplyQueueScope): Pick<IDBFactory, "open"> {
	return scope.indexedDb ?? defaultIndexedDbFactory();
}

function defaultIndexedDbFactory(): IDBFactory {
	if (!window.indexedDB) throw new Error("IndexedDB is not available");
	return window.indexedDB;
}

function openSettingsSyncDb(indexedDbFactory: Pick<IDBFactory, "open">): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDbFactory.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
			if (!request.result.objectStoreNames.contains(ACCEPTANCE_STORE)) {
				request.result.createObjectStore(ACCEPTANCE_STORE);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error(`Failed to open IndexedDB database "${DB_NAME}"`));
	});
}

function getValue(db: IDBDatabase, storeName: string, key: string): Promise<unknown> {
	return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
}

function putValue(db: IDBDatabase, storeName: string, key: string, value: unknown): Promise<void> {
	return writeTransaction(db, storeName, (store) => { store.put(value, key); });
}

function deleteValue(db: IDBDatabase, storeName: string, key: string): Promise<void> {
	return writeTransaction(db, storeName, (store) => { store.delete(key); });
}

function writeTransaction(
	db: IDBDatabase,
	storeName: string,
	mutate: (store: IDBObjectStore) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(storeName, "readwrite");
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		mutate(transaction.objectStore(storeName));
	});
}

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}
