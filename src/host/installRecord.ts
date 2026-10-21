/**
 * The install record (identity-per-store §2.4 points 2-4): this vault registration's install key and its store
 * lineage, in `App.saveLocalStorage("yaos-install-" + hex(vaultId))`. Obsidian scopes that storage to the vault
 * registration (the appId), so a copied or synced vault folder opened elsewhere has no record: a new install key, a
 * new store, a new device identity (§4 "Clone"). The record is not an identity: it names only the store this install
 * had last (`current`, with its retire key for the successor fence of §5.2, phase 3) and up to 8 before it.
 *
 * Main writes it; the worker owns the store and reports `storeIdentity` after each runtime start. A crash that loses
 * that write leaves the lineage one store behind (§2.4 point 4). Pure: the storage is injected.
 */

import { base64urlDecode, base64urlEncode } from "../core/codec/ids";
import { bytesToHex } from "../core/codec/lib0";

const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const KEY_RE = /^[A-Za-z0-9_-]{32,256}$/;
export const MAX_PREDECESSORS = 8;

export interface InstallRecord {
	readonly v: 1;
	/** 16 random bytes, base64url: the store is `yaos3:<vaultId>:<epoch>:<installKey>`. */
	readonly installKey: string;
	/** The store this install ran on last. SECRET: retireKey (never logged or shown). */
	readonly current: { readonly deviceId: string; readonly retireKey: string } | null;
	/** Earlier stores of this install, newest first (deviceIds only). */
	readonly predecessors: readonly string[];
}

/** Where the record lives: `yaos-install-<hex of the vaultId's 16 bytes>`. */
export function installRecordKey(vaultId: string): string {
	let bytes: Uint8Array;
	try {
		bytes = base64urlDecode(vaultId);
	} catch {
		bytes = new TextEncoder().encode(vaultId);
	}
	return `yaos-install-${bytesToHex(bytes)}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A well-formed record, or null (anything off: the install starts over with a new key, the safe direction). */
export function sanitizeInstallRecord(raw: unknown): InstallRecord | null {
	const r = asRecord(raw);
	if (!r || r.v !== 1 || typeof r.installKey !== "string" || !ID_RE.test(r.installKey)) return null;
	const c = asRecord(r.current);
	const current = c && typeof c.deviceId === "string" && ID_RE.test(c.deviceId) && typeof c.retireKey === "string" && KEY_RE.test(c.retireKey)
		? { deviceId: c.deviceId, retireKey: c.retireKey }
		: null;
	const predecessors: string[] = [];
	if (Array.isArray(r.predecessors)) {
		for (const p of r.predecessors) {
			if (typeof p !== "string" || !ID_RE.test(p) || predecessors.includes(p) || p === current?.deviceId) continue;
			predecessors.push(p);
			if (predecessors.length >= MAX_PREDECESSORS) break;
		}
	}
	return { v: 1, installKey: r.installKey, current, predecessors };
}

export function newInstallRecord(randomBytes: (n: number) => Uint8Array): InstallRecord {
	return { v: 1, installKey: base64urlEncode(randomBytes(16)), current: null, predecessors: [] };
}

/** The lineage after a runtime started on store `deviceId`: the same record when nothing changed. */
export function withStoreIdentity(rec: InstallRecord, deviceId: string, retireKey: string): InstallRecord {
	if (!ID_RE.test(deviceId) || !KEY_RE.test(retireKey)) return rec;
	if (rec.current?.deviceId === deviceId && rec.current.retireKey === retireKey) return rec;
	const prev = rec.current && rec.current.deviceId !== deviceId ? [rec.current.deviceId] : [];
	const predecessors = [...prev, ...rec.predecessors.filter((p) => p !== deviceId && !prev.includes(p))].slice(0, MAX_PREDECESSORS);
	return { v: 1, installKey: rec.installKey, current: { deviceId, retireKey }, predecessors };
}

/** The stores this install ran on (current first, then its predecessors): HostIdentity.lineage. */
export function lineageOf(rec: InstallRecord): string[] {
	return [...(rec.current ? [rec.current.deviceId] : []), ...rec.predecessors];
}

export interface InstallStorage {
	load(key: string): unknown;
	save(key: string, value: unknown): void;
}

/** This vault registration's record, created (and saved) when there is none or it is unreadable. */
export function loadInstallRecord(storage: InstallStorage, vaultId: string, randomBytes: (n: number) => Uint8Array): InstallRecord {
	const key = installRecordKey(vaultId);
	const found = sanitizeInstallRecord(storage.load(key));
	if (found) return found;
	const rec = newInstallRecord(randomBytes);
	storage.save(key, rec);
	return rec;
}

/** Record that a runtime started on store `deviceId` (HostUiSink.onStoreIdentity). */
export function saveStoreIdentity(storage: InstallStorage, vaultId: string, installKey: string, deviceId: string, retireKey: string): void {
	const key = installRecordKey(vaultId);
	const rec = sanitizeInstallRecord(storage.load(key));
	// Another install key took the slot meanwhile (the record was lost and recreated): that store is not this one's.
	if (!rec || rec.installKey !== installKey) return;
	const next = withStoreIdentity(rec, deviceId, retireKey);
	if (next !== rec) storage.save(key, next);
}
