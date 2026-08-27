import { vaultIdbName } from "../sync/vaultPersistence";

import type {
	LocalVaultImportState,
	LocalVaultImportStateStore,
} from "./localVaultImport";

const DATABASE_VERSION = 1;
const STATE = "state";
const STATE_KEY = "initial-import";
const DATABASE_SUFFIX = ":schema-4:local-import";

export function localVaultImportIdbName(vaultId: string, folderKey: string): string {
	if (!vaultId.trim() || !folderKey.trim()) {
		throw new Error("vault ID and folder key are required for local import storage");
	}
	return `${vaultIdbName(vaultId, folderKey)}${DATABASE_SUFFIX}`;
}


function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
	});
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

/** Independent durable checkpoint store for the first local-vault import. */
export class IndexedDbLocalVaultImportStateStore implements LocalVaultImportStateStore {
	private readonly database: Promise<IDBDatabase>;

	constructor(
		private readonly vaultId: string,
		folderKey: string,
		indexedDb: IDBFactory = window.indexedDB,
	) {
		const databaseName = localVaultImportIdbName(this.vaultId, folderKey);
		this.database = new Promise((resolve, reject) => {
			const request = indexedDb.open(databaseName, DATABASE_VERSION);
			request.onupgradeneeded = (event) => {
				if (event.oldVersion !== 0) {
					request.transaction?.abort();
					return;
				}
				request.result.createObjectStore(STATE);
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error(`Failed to open ${databaseName}`));
		});
	}

	async load(vaultId: string): Promise<LocalVaultImportState | null> {
		if (vaultId !== this.vaultId) throw new Error("local import store vault identity mismatch");
		const database = await this.database;
		const transaction = database.transaction(STATE, "readonly");
		const value = await requestValue(transaction.objectStore(STATE).get(STATE_KEY)) as
			| LocalVaultImportState
			| undefined;
		await transactionDone(transaction);
		if (!value) return null;
		if (value.vaultId !== this.vaultId) throw new Error("local import store vault identity mismatch");
		return value;
	}

	async save(state: LocalVaultImportState): Promise<void> {
		if (state.vaultId !== this.vaultId) throw new Error("local import store vault identity mismatch");
		const database = await this.database;
		const transaction = database.transaction(STATE, "readwrite");
		transaction.objectStore(STATE).put(state, STATE_KEY);
		await transactionDone(transaction);
	}

	async clear(vaultId: string): Promise<void> {
		const existing = await this.load(vaultId);
		if (!existing) return;
		const database = await this.database;
		const transaction = database.transaction(STATE, "readwrite");
		transaction.objectStore(STATE).delete(STATE_KEY);
		await transactionDone(transaction);
	}
}

export class MemoryLocalVaultImportStateStore implements LocalVaultImportStateStore {
	private states = new Map<string, LocalVaultImportState>();

	async load(vaultId: string): Promise<LocalVaultImportState | null> {
		const state = this.states.get(vaultId);
		return state ? structuredClone(state) : null;
	}

	async save(state: LocalVaultImportState): Promise<void> {
		this.states.set(state.vaultId, structuredClone(state));
	}

	async clear(vaultId: string): Promise<void> {
		this.states.delete(vaultId);
	}
}
