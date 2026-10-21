/**
 * Offline inspector: what a device's committed IndexedDB state holds.
 *
 * Opens a crash copy of a device's MemStoragePort with a real LogEngine that
 * can never connect (offline start from the epoch in each database's name) and reads the text of
 * every live or pending markdown doc, plus every string stored by the disk
 * side (intents, bases). The token invariants use it to decide which tokens an
 * app crash may legitimately lose: a token in the committed state must survive.
 */

import type { DeviceId } from "../core/types";
import { parseDbName } from "../engine/compose/knownEpoch";
import type { RelayPort } from "../ports/relay";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { LogEngine } from "../engine/runtime/engine";
import { docText } from "../engine/runtime/testHarness";
import { readBase } from "../engine/reconcile/store";
import { STORE, type BaseTextRecord } from "../engine/store/schema";
import type { VirtualClock } from "./clock";
import { simHashPort } from "./hash";
import { SIM_VAULT_ID } from "./net";
import { hashLabel, SeededRandom } from "./random";
import type { MemStoragePort } from "./storage";

const OFFLINE: RelayPort = { connect: async () => ({ ok: false, reason: "unavailable", retryAfterMs: null }) };

/** Strings anywhere in a structured value (depth-limited). */
function strings(v: unknown, out: string[], depth = 0): void {
	if (depth > 6 || v === null || v === undefined) return;
	if (typeof v === "string") {
		if (v.includes("[")) out.push(v);
	} else if (Array.isArray(v)) {
		for (const x of v) strings(x, out, depth + 1);
	} else if (typeof v === "object" && !(v instanceof Uint8Array)) {
		for (const x of Object.values(v as Record<string, unknown>)) strings(x, out, depth + 1);
	}
}

/** The deviceId in the meta.identity of store `name` (null: none). */
function storeDeviceId(storage: MemStoragePort, name: string): DeviceId | null {
	const rows = storage.dump(name)?.[STORE.meta] ?? [];
	for (const r of rows) {
		const m = r as { key?: unknown; deviceId?: unknown };
		if (m.key === "identity" && typeof m.deviceId === "string") return m.deviceId as DeviceId;
	}
	return null;
}

/**
 * Texts recoverable from `storage` (a crash copy nobody else uses). Resolves as
 * the run's clock advances; never throws (an unopenable store holds nothing).
 */
export async function inspectStore(clock: VirtualClock, storage: MemStoragePort): Promise<string[]> {
	const out: string[] = [];
	const hash = simHashPort();
	let names: readonly string[] = [];
	try {
		names = await storage.listDatabases();
	} catch {
		return out;
	}
	for (const name of names) {
		const dump = storage.dump(name);
		if (!dump) continue;
		for (const [store, rows] of Object.entries(dump)) {
			if (store === STORE.baseText) {
				for (const r of rows) {
					const t = await readBase(r as BaseTextRecord, hash);
					if (t !== null) out.push(t);
				}
			} else if (store === STORE.intents || store === STORE.synced || store === STORE.localTree) strings(rows, out);
		}
	}
	// One offline engine per store of this device, opened at the epoch in its name (knownEpoch.ts) as the identity in
	// its meta (identity-per-store §2): without vaultEpoch LogEngine.start connects first, which OFFLINE refuses, and
	// nothing in the doc logs was read; with another deviceId it would refuse the store.
	for (const name of names) {
		const id = parseDbName(name);
		if (!id || id.vaultId !== SIM_VAULT_ID || id.vaultEpoch.length === 0) continue;
		const deviceId = storeDeviceId(storage, name);
		if (deviceId === null) continue;
		let eng: LogEngine;
		try {
			eng = await LogEngine.start({
				ports: { relay: OFFLINE, storage, clock, random: new SeededRandom(hashLabel(`inspect:${deviceId}`)), crypto: createNoopCrypto(hash), hash, blob: null },
				vaultId: SIM_VAULT_ID, vaultEpoch: id.vaultEpoch, deviceId, store: { installKey: id.storeKey, deviceToken: "", retireKey: "" }, clientVersion: "sim-inspect", sideFiles: null, autoReconnect: false, e2ee: { suite: 0 },
			});
		} catch {
			continue;
		}
		try {
			for (const d of eng.listDocs()) {
				if (d.kind !== "markdown" || (d.state !== "live" && d.state !== "pending")) continue;
				try {
					out.push(await docText(eng, d.docId));
				} catch {
					// unreadable doc: holds nothing recoverable
				}
			}
		} finally {
			await eng.stop().catch(() => undefined);
		}
	}
	return out;
}
