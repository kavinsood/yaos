/**
 * Offline inspector: what a device's committed IndexedDB state holds.
 *
 * Opens a crash copy of a device's MemStoragePort with a real LogEngine that
 * can never connect (offline start from the known epoch) and reads the text of
 * every live or pending markdown doc, plus every string stored by the disk
 * side (intents, bases). The token invariants use it to decide which tokens an
 * app crash may legitimately lose: a token in the committed state must survive.
 */

import type { DeviceId } from "../core/types";
import type { RelayPort } from "../ports/relay";
import { createNoopCrypto } from "../engine/adapters/noopCrypto";
import { LogEngine } from "../engine/runtime/engine";
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

/**
 * Texts recoverable from `storage` (a crash copy nobody else uses). Resolves as
 * the run's clock advances; never throws (an unopenable store holds nothing).
 */
export async function inspectStore(clock: VirtualClock, storage: MemStoragePort, deviceId: DeviceId): Promise<string[]> {
	const out: string[] = [];
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
					const t = readBase(r as BaseTextRecord);
					if (t !== null) out.push(t);
				}
			} else if (store === STORE.intents || store === STORE.synced || store === STORE.localTree) strings(rows, out);
		}
	}
	if (names.length === 0) return out;
	const hash = simHashPort();
	let eng: LogEngine;
	try {
		eng = await LogEngine.start({
			ports: { relay: OFFLINE, storage, clock, random: new SeededRandom(hashLabel(`inspect:${deviceId}`)), crypto: createNoopCrypto(hash), hash, blob: null },
			vaultId: SIM_VAULT_ID, deviceId, clientVersion: "sim-inspect", sideFiles: null, autoReconnect: false, e2ee: { suite: 0 },
		});
	} catch {
		return out;
	}
	try {
		for (const d of eng.listDocs()) {
			if (d.kind !== "markdown" || (d.state !== "live" && d.state !== "pending")) continue;
			try {
				out.push(await eng.docText(d.docId));
			} catch {
				// unreadable doc: holds nothing recoverable
			}
		}
	} finally {
		await eng.stop().catch(() => undefined);
	}
	return out;
}
