/**
 * Vault keys in Obsidian SecretStorage (e2ee-design §6.1): one secret per vault, namespaced by a hash of the vault
 * id, read and written only on main. Nothing here logs, caches or echoes key bytes: `load()` decodes fresh buffers
 * for each engine start and the caller hands them to the engine as transferred buffers (§6.3).
 *
 * API (node_modules/obsidian/obsidian.d.ts, obsidian 1.13.1; manifest minAppVersion 1.13.0):
 *  - `App.secretStorage: SecretStorage` (:458, @since 1.11.4);
 *  - `class SecretStorage extends Events` (:5635): `setSecret(id, secret): void` (:5645, throws on an invalid id:
 *    "Lowercase alphanumeric ID with optional dashes"), `getSecret(id): string | null` (:5654),
 *    `listSecrets(): string[]` (:5661);
 *  - `Events.on(name, callback, ctx?): EventRef` / `offref(ref)` (:2808-2835).
 * Runtime only, not in the d.ts (asar 1.13.7 and 1.14.4, read-only): the store loads at app start and then fires
 * `changed`; `setSecret` also fires `changed`; `isEncryptionAvailable()` is false only on desktop without an OS
 * keyring (the value is then stored in plaintext). There is no delete in the d.ts, so forget writes "" (§6.1).
 *
 * The secret id is `"yaos-" + hex(sha256(utf8(vaultId)))[0..32]`. That is the one hash main computes: a fixed,
 * tiny identifier (no content, no fingerprint), needed before any engine exists (DESIGN §d.2 keeps every content
 * hash in the worker).
 */

import { KEY_STORE_WAIT_MS } from "../../core/limits";
import { base64urlDecode, base64urlEncode } from "../../core/codec/ids";
import { sha256Hex } from "../../core/hash/sha256";
import { utf8Encode } from "../../core/hash/utf8";
import type { ClockPort } from "../../ports/clock";

/** The parts of Obsidian's SecretStorage YAOS uses (structural, so tests and the sim can supply a fake). */
export interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
	listSecrets(): string[];
	/** Events.on (d.ts :2808). Absent: no load event to wait for. */
	on?(name: "changed", callback: (...data: unknown[]) => unknown): unknown;
	offref?(ref: never): void;
	/** Runtime only (not in obsidian.d.ts 1.13.1): false = secrets are stored in plaintext on this device. */
	isEncryptionAvailable?(): boolean;
}

/** One epoch key. SECRET. */
export interface EpochKey {
	readonly e: number;
	readonly k: Uint8Array;
}

/** What the store holds for one vault: keys (SECRET) and the winning k records (public, §11.5). */
export interface StoredKeys {
	readonly keys: readonly EpochKey[];
	readonly records: readonly Uint8Array[];
}

/** keyringChanged as main receives it (§18.4). */
export interface KeyringChange extends StoredKeys {
	readonly pending: number | null;
}

/** A store failure. The message is fixed text: never a key, a value or the SecretStorage error text. */
export class KeyStoreError extends Error {
	constructor(readonly reason: "unavailable" | "write-failed" | "other-vault") {
		super(reason === "unavailable" ? "secure key storage is not available on this device"
			: reason === "other-vault" ? "the stored keys belong to another vault"
			: "could not write the vault key to secure storage");
		this.name = "KeyStoreError";
	}
}

const SECRET_ID_PREFIX = "yaos-";
/** Epoch keys are 32 bytes (§4); anything else in the store is treated as absent. */
const KEY_BYTES = 32;
const MAX_RECORD_BYTES = 1024;
const MAX_ENTRIES = 1024;

/** §6.1: the SecretStorage id for `vaultId` (lowercase hex, 37 chars, valid for setSecret's /^[a-z0-9-]+$/). */
export function secretIdFor(vaultId: string): string {
	return SECRET_ID_PREFIX + sha256Hex(utf8Encode(vaultId)).slice(0, 32);
}

interface StoredValueV1 {
	readonly v: 1;
	readonly vaultId: string;
	readonly suite: 1;
	readonly keys: readonly { readonly e: number; readonly k: string }[];
	readonly records: readonly string[];
}

function isEpoch(e: unknown): e is number {
	return typeof e === "number" && Number.isSafeInteger(e) && e >= 1;
}

/** Defensive decode: anything unexpected is "no value" (fail closed: the device is key-missing, never guesses). */
function decodeValue(raw: string | null, vaultId: string): StoredKeys | "other-vault" | null {
	if (raw === null || raw === "") return null;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!v || typeof v !== "object") return null;
	const o = v as Partial<Record<keyof StoredValueV1, unknown>>;
	if (o.v !== 1 || o.suite !== 1 || typeof o.vaultId !== "string" || !Array.isArray(o.keys) || !Array.isArray(o.records)) return null;
	if (o.vaultId !== vaultId) return "other-vault";
	if (o.keys.length > MAX_ENTRIES || o.records.length > MAX_ENTRIES) return null;
	const keys: EpochKey[] = [];
	const seen = new Set<number>();
	for (const entry of o.keys as unknown[]) {
		if (!entry || typeof entry !== "object") return null;
		const { e, k } = entry as { e?: unknown; k?: unknown };
		if (!isEpoch(e) || typeof k !== "string" || seen.has(e)) return null;
		let bytes: Uint8Array;
		try {
			bytes = base64urlDecode(k).slice();
		} catch {
			return null;
		}
		if (bytes.length !== KEY_BYTES) return null;
		seen.add(e);
		keys.push({ e, k: bytes });
	}
	const records: Uint8Array[] = [];
	for (const r of o.records as unknown[]) {
		if (typeof r !== "string") return null;
		let bytes: Uint8Array;
		try {
			bytes = base64urlDecode(r).slice();
		} catch {
			return null;
		}
		if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) return null;
		records.push(bytes);
	}
	keys.sort((a, b) => a.e - b.e);
	return { keys, records };
}

function encodeValue(vaultId: string, v: StoredKeys): string {
	const value: StoredValueV1 = {
		v: 1, vaultId, suite: 1,
		keys: v.keys.map((key) => ({ e: key.e, k: base64urlEncode(key.k) })),
		records: v.records.map((r) => base64urlEncode(r)),
	};
	return JSON.stringify(value);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** The secret of one vault. Construct per vault id; holds no key bytes between calls. */
export class VaultKeyStore {
	readonly id: string;
	private readyP: Promise<boolean> | null = null;

	constructor(
		private readonly store: SecretStorageLike,
		readonly vaultId: string,
		private readonly clock: ClockPort,
		private readonly waitMs = KEY_STORE_WAIT_MS,
	) {
		this.id = secretIdFor(vaultId);
	}

	/**
	 * §6.1 Startup: resolves true once the store has loaded (our secret or any secret is visible, or `changed`
	 * fired), false after `waitMs` without that. Called before a pinned (suite 1) start; the answer is kept.
	 */
	ready(): Promise<boolean> {
		this.readyP ??= this.waitLoaded();
		return this.readyP;
	}

	private waitLoaded(): Promise<boolean> {
		if (this.loadedNow()) return Promise.resolve(true);
		const on = this.store.on;
		if (typeof on !== "function") return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			let done = false;
			let ref: unknown = null;
			const finish = (loaded: boolean): void => {
				if (done) return;
				done = true;
				this.clock.clearTimer(timer);
				try {
					if (ref !== null) this.store.offref?.(ref as never);
				} catch {
					// ignore
				}
				resolve(loaded);
			};
			const timer = this.clock.setTimer(this.waitMs, () => finish(this.loadedNow()));
			ref = on.call(this.store, "changed", () => finish(true));
		});
	}

	private loadedNow(): boolean {
		try {
			return this.store.getSecret(this.id) !== null || this.store.listSecrets().length > 0;
		} catch {
			return false;
		}
	}

	/** The stored keys and records as fresh buffers (the caller transfers them), or null when there are none. */
	load(): StoredKeys | null {
		let raw: string | null;
		try {
			raw = this.store.getSecret(this.id);
		} catch {
			return null;
		}
		const v = decodeValue(raw, this.vaultId);
		return v === "other-vault" ? null : v;
	}

	/** Whether any key is stored for this vault (no bytes leave this call). */
	holdsKeys(): boolean {
		const v = this.load();
		if (!v) return false;
		for (const key of v.keys) key.k.fill(0);
		return v.keys.length > 0;
	}

	/**
	 * Persist a keyringChanged (§18.4, before main acks it): new epochs are added, a held epoch is never replaced
	 * (§6.1; the engine never exports two keys for one epoch), and the records become the engine's winning set.
	 * Returns how many keys and records the store holds afterwards. Throws KeyStoreError (fixed text).
	 */
	merge(change: StoredKeys): { readonly keys: number; readonly records: number } {
		let raw: string | null;
		try {
			raw = this.store.getSecret(this.id);
		} catch {
			throw new KeyStoreError("unavailable");
		}
		const cur = decodeValue(raw, this.vaultId);
		if (cur === "other-vault") throw new KeyStoreError("other-vault");
		const keys: EpochKey[] = cur ? [...cur.keys] : [];
		for (const nk of change.keys) {
			if (!isEpoch(nk.e) || nk.k.length !== KEY_BYTES) throw new KeyStoreError("write-failed");
			const held = keys.find((x) => x.e === nk.e);
			if (held) continue; // never replaced; equal bytes are the common case (a re-export)
			keys.push({ e: nk.e, k: nk.k.slice() });
		}
		keys.sort((a, b) => a.e - b.e);
		const records = change.records.length > 0 ? change.records.map((r) => r.slice()) : cur ? [...cur.records] : [];
		const value = encodeValue(this.vaultId, { keys, records });
		for (const key of keys) key.k.fill(0);
		try {
			this.store.setSecret(this.id, value);
		} catch {
			throw new KeyStoreError("unavailable");
		}
		// Read back: SecretStorage may refuse silently (no adapter) or truncate (size limits are [U], §23.3).
		let back: string | null;
		try {
			back = this.store.getSecret(this.id);
		} catch {
			back = null;
		}
		if (back !== value) throw new KeyStoreError("write-failed");
		return { keys: keys.length, records: records.length };
	}

	/** §6.1 Forget keys (leave the vault): there is no delete API, so the secret becomes "". */
	forget(): void {
		try {
			if (this.store.getSecret(this.id) === null) return;
			this.store.setSecret(this.id, "");
		} catch {
			// Best effort: a store that cannot write also holds nothing new.
		}
	}

	/** Runtime-only isEncryptionAvailable(): false means this device stores secrets in plaintext. */
	plaintext(): boolean {
		try {
			return this.store.isEncryptionAvailable?.() === false;
		} catch {
			return false;
		}
	}
}

/** True when `a` and `b` hold the same epoch keys (tests). */
export function sameKeys(a: readonly EpochKey[], b: readonly EpochKey[]): boolean {
	return a.length === b.length && a.every((x, i) => x.e === b[i]!.e && sameBytes(x.k, b[i]!.k));
}
