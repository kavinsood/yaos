/**
 * Main's side of the engine's keys (e2ee-design §6.3, §18.4): the `crypto` part of each init config, built from the
 * pin in data.json and the vault's SecretStorage secret, and the keyringChanged handler, which stores before main
 * acks (persist-before-use) and then lets main decide the pin. Key buffers leave here transferred (init) or
 * zero-filled (keyringChanged, once stored): main keeps no copy beyond SecretStorage itself.
 */

import type { EngineInitConfig } from "../../protocol/messages";
import type { E2eePin } from "./pin";
import { KeyStoreError, type KeyringChange, type VaultKeyStore } from "./secretStore";

export interface HostKeys {
	/** EngineInitConfig.crypto for the next engine start. SECRET: the caller transfers it and keeps no copy. */
	crypto(): Promise<EngineInitConfig["crypto"]>;
	/** keyringChanged: resolves once the change is stored and main's pin decision is saved; throws KeyRefused / KeyStoreError. */
	persist(change: KeyringChange): Promise<void>;
}

/** A keyringChanged this device must not store (a suite-0 pin). Fixed text. */
export class KeyRefused extends Error {
	constructor() {
		super("this device is pinned to an unencrypted vault and stores no vault key");
		this.name = "KeyRefused";
	}
}

export interface HostKeysDeps {
	/** null: this Obsidian has no SecretStorage, so nothing can be stored or loaded. */
	readonly store: VaultKeyStore | null;
	/** The pin as data.json holds it now. */
	pin(): E2eePin | undefined;
	/** On the creation path for this vault (§15.1 `creating` marker). */
	creating(): boolean;
	/** After a change was stored, before the ack: main's pin decision (awaited, so the pin is saved first). */
	stored?(info: { readonly pending: number | null; readonly keys: number; readonly records: number }): Promise<void>;
	/** The store is plaintext on this device and holds keys (the one-time notice). */
	plaintext?(): void;
}

function zero(change: KeyringChange): void {
	for (const key of change.keys) key.k.fill(0);
}

export function createHostKeys(deps: HostKeysDeps): HostKeys {
	return {
		async crypto() {
			const pin = deps.pin();
			if (pin === undefined || pin.suite === null) return { suite: null, creating: deps.creating() };
			if (pin.suite === 0) return { suite: 0 };
			const store = deps.store;
			if (!store) return { suite: 1, keys: [], records: [] };
			await store.ready();
			const v = store.load();
			if (v && v.keys.length > 0 && store.plaintext()) deps.plaintext?.();
			return { suite: 1, keys: v?.keys ?? [], records: v?.records ?? [] };
		},
		async persist(change) {
			let counts: { keys: number; records: number };
			try {
				if (deps.pin()?.suite === 0) throw new KeyRefused();
				if (!deps.store) throw new KeyStoreError("unavailable");
				counts = deps.store.merge(change);
			} finally {
				zero(change);
			}
			if (counts.keys > 0 && deps.store.plaintext()) deps.plaintext?.();
			await deps.stored?.({ pending: change.pending, ...counts });
		},
	};
}
