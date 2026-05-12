import * as Y from "yjs";
import type { CandidateStore, PersistedCandidateState, ScopeKey } from "./candidateStore";
import { decodeBytesBase64, MAX_SV_ECHO_BASE64_BYTES } from "./svEchoMessage";

const DB_NAME = "yaos-server-receipt";
const DB_VERSION = 1;
const CURRENT_ACK_STORE_VERSION = 1;
const CANDIDATE_STORE = "candidateStates";
const METADATA_STORE = "metadata";
const LOCAL_DEVICE_ID_KEY = "localDeviceId";
const HASH_RE = /^[0-9a-f]{64}$/;

type IndexedDbFactoryLike = Pick<IDBFactory, "open">;

export class IndexedDbCandidateStore implements CandidateStore {
	private readonly _dbPromise: Promise<IDBDatabase>;
	private readonly _key: string;
	private readonly _scope: ScopeKey;

	constructor(
		scope: ScopeKey,
		indexedDbFactory: IndexedDbFactoryLike = defaultIndexedDbFactory(),
		dbName = DB_NAME,
	) {
		this._scope = scope;
		this._key = buildCandidateStoreKey(scope);
		this._dbPromise = openAckDatabase(indexedDbFactory, dbName);
	}

	async load(scope: ScopeKey): Promise<PersistedCandidateState | null> {
		try {
			const db = await this._dbPromise;
			const raw = await getValue(db, CANDIDATE_STORE, this._key);
			const state = validatePersistedCandidateState(raw);
			if (!state || !scopeKeyMatches(state, scope)) return null;
			return state;
		} catch {
			return null;
		}
	}

	async save(state: PersistedCandidateState): Promise<void> {
		if (!scopeKeyMatches(state, this._scope)) {
			throw new Error("Candidate state scope mismatch");
		}
		if (!validatePersistedCandidateState(state)) {
			throw new Error("Invalid candidate state");
		}
		const db = await this._dbPromise;
		await putValue(db, CANDIDATE_STORE, this._key, state);
	}

	async clear(): Promise<void> {
		const db = await this._dbPromise;
		await deleteValue(db, CANDIDATE_STORE, this._key);
	}
}

export async function getOrCreateLocalDeviceId(
	indexedDbFactory: IndexedDbFactoryLike = defaultIndexedDbFactory(),
	randomUuid: () => string = defaultRandomUuid,
	dbName = DB_NAME,
): Promise<string> {
	const db = await openAckDatabase(indexedDbFactory, dbName);
	return getOrCreateMetadataValue(db, LOCAL_DEVICE_ID_KEY, randomUuid);
}

export async function sha256Hex(input: string): Promise<string> {
	const cryptoApi = defaultCrypto();
	if (!cryptoApi.subtle) throw new Error("crypto.subtle is not available");
	const bytes = new TextEncoder().encode(input);
	const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildCandidateStoreKey(scope: ScopeKey): string {
	return `yaos-ack-v1:${scope.serverHostHash}:${scope.vaultIdHash}:${scope.localDeviceId}`;
}

function openAckDatabase(indexedDbFactory: IndexedDbFactoryLike, dbName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDbFactory.open(dbName, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(CANDIDATE_STORE)) db.createObjectStore(CANDIDATE_STORE);
			if (!db.objectStoreNames.contains(METADATA_STORE)) db.createObjectStore(METADATA_STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error(`Failed to open IndexedDB database "${dbName}"`));
	});
}

function getValue(db: IDBDatabase, storeName: string, key: string): Promise<unknown> {
	return requestPromise(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
}

function putValue(db: IDBDatabase, storeName: string, key: string, value: unknown): Promise<void> {
	return writeTransaction(db, storeName, (store) => {
		store.put(value, key);
	});
}

function deleteValue(db: IDBDatabase, storeName: string, key: string): Promise<void> {
	return writeTransaction(db, storeName, (store) => {
		store.delete(key);
	});
}

function getOrCreateMetadataValue(
	db: IDBDatabase,
	key: string,
	createValue: () => string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(METADATA_STORE, "readwrite");
		tx.oncomplete = () => {
			if (createdOrExisting !== null) resolve(createdOrExisting);
			else reject(new Error("IndexedDB transaction completed without local device ID"));
		};
		tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
		tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));

		let createdOrExisting: string | null = null;
		const store = tx.objectStore(METADATA_STORE);
		const getReq = store.get(key);
		getReq.onsuccess = () => {
			if (typeof getReq.result === "string" && getReq.result.length > 0) {
				createdOrExisting = getReq.result;
				return;
			}
			createdOrExisting = createValue();
			store.put(createdOrExisting, key);
		};
		getReq.onerror = () => reject(getReq.error ?? new Error("IndexedDB local device ID read failed"));
	});
}

function writeTransaction(
	db: IDBDatabase,
	storeName: string,
	write: (store: IDBObjectStore) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
		tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
		write(tx.objectStore(storeName));
	});
}

function requestPromise<T = unknown>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function validatePersistedCandidateState(raw: unknown): PersistedCandidateState | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (r.schema !== 1) return null;
	if (typeof r.vaultIdHash !== "string" || !HASH_RE.test(r.vaultIdHash)) return null;
	if (typeof r.serverHostHash !== "string" || !HASH_RE.test(r.serverHostHash)) return null;
	if (typeof r.localDeviceId !== "string" || r.localDeviceId.length === 0) return null;
	if (typeof r.roomName !== "string") return null;
	if (typeof r.docSchemaVersion !== "number" || !Number.isInteger(r.docSchemaVersion) || r.docSchemaVersion < 0) return null;
	if (typeof r.pluginVersion !== "string") return null;
	if (r.ackStoreVersion !== CURRENT_ACK_STORE_VERSION) return null;
	if (r.candidateSvBase64 !== null && typeof r.candidateSvBase64 !== "string") return null;
	if (r.candidateSvBase64 === null && r.candidateCapturedAt !== null) return null;
	if (typeof r.candidateSvBase64 === "string" && r.candidateCapturedAt === null) return null;
	if (
		r.candidateCapturedAt !== null &&
		(typeof r.candidateCapturedAt !== "number" || !Number.isFinite(r.candidateCapturedAt) || r.candidateCapturedAt < 0)
	) return null;
	if (
		r.lastKnownServerReceiptEchoAt !== null &&
		(typeof r.lastKnownServerReceiptEchoAt !== "number" || !Number.isFinite(r.lastKnownServerReceiptEchoAt) || r.lastKnownServerReceiptEchoAt < 0)
	) return null;
	if (typeof r.candidateSvBase64 === "string") {
		if (r.candidateSvBase64.length > MAX_SV_ECHO_BASE64_BYTES) return null;
		const sv = decodeBytesBase64(r.candidateSvBase64);
		if (!sv) return null;
		try {
			Y.decodeStateVector(sv);
		} catch {
			return null;
		}
	}
	return r as PersistedCandidateState;
}

function scopeKeyMatches(stored: PersistedCandidateState, scope: ScopeKey): boolean {
	return (
		stored.vaultIdHash === scope.vaultIdHash &&
		stored.serverHostHash === scope.serverHostHash &&
		stored.localDeviceId === scope.localDeviceId &&
		stored.roomName === scope.roomName &&
		stored.docSchemaVersion === scope.docSchemaVersion
	);
}

function defaultRandomUuid(): string {
	const cryptoApi = defaultCrypto();
	if (typeof cryptoApi.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof cryptoApi.getRandomValues !== "function") {
		throw new Error("crypto.getRandomValues is not available");
	}
	cryptoApi.getRandomValues(bytes);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function defaultIndexedDbFactory(): IDBFactory {
	if (!globalThis.indexedDB) throw new Error("IndexedDB is not available");
	return globalThis.indexedDB;
}

function defaultCrypto(): Crypto {
	if (!globalThis.crypto) throw new Error("crypto is not available");
	return globalThis.crypto;
}
