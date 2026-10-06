/**
 * HashOracle: how main gets a hash without hashing (DESIGN §d.2: the main thread is for CodeMirror and
 * raw disk I/O; hashing lives in the engine worker).
 *
 * Main reads raw bytes (write preconditions, config writes) and transfers them to the engine in a
 * `hashRequest`; the engine (engine/compose/hashService.ts) answers per item the hash asked for and
 * `textLength` (UTF-16 length of the bytes decoded as UTF-8, BOM kept), which the text-write guard in
 * host/obsidianVault.ts compares instead of decoding on main.
 *
 * Ownership: item bytes are TRANSFERRED (detached once sent). Callers must not touch them afterwards;
 * a view that does not own its whole buffer is copied first (owned()), never hashed here.
 * Batches are bounded (count and bytes) and sent one after another, so a scan never puts more than
 * MAX_BATCH_BYTES in flight (one larger item goes alone).
 */

import type { EngineResultValue, HashWant, MainToEngine } from "../protocol/messages";
import { owned } from "../protocol/workerTransport";

export interface HashItem {
	readonly path: string;
	readonly want: HashWant;
	/** Transferred: detached after hash() is called. */
	readonly bytes: Uint8Array;
}

export interface HashValue {
	readonly hash: string;
	/** UTF-16 length of the bytes decoded as UTF-8 with any BOM kept (invalid sequences -> U+FFFD). */
	readonly textLength: number;
}

export interface HashOracle {
	/** One value per item, in order. Rejects when the engine is not running (callers fail their op, never guess). */
	hash(items: readonly HashItem[]): Promise<readonly HashValue[]>;
}

export type HashRequestBody = Omit<Extract<MainToEngine, { t: "hashRequest" }>, "rid">;

export const MAX_BATCH_ITEMS = 64;
export const MAX_BATCH_BYTES = 8 << 20;

/** Oracle over the engine link: `request` = EngineHost.request of the running engine. */
export function engineHashOracle(request: (body: HashRequestBody) => Promise<EngineResultValue>): HashOracle {
	return {
		async hash(items) {
			const out: HashValue[] = [];
			let i = 0;
			while (i < items.length) {
				const batch: HashItem[] = [];
				let bytes = 0;
				while (i < items.length && batch.length < MAX_BATCH_ITEMS) {
					const it = items[i]!;
					if (batch.length > 0 && bytes + it.bytes.byteLength > MAX_BATCH_BYTES) break;
					batch.push({ path: it.path, want: it.want, bytes: owned(it.bytes) });
					bytes += it.bytes.byteLength;
					i++;
				}
				const r = await request({ t: "hashRequest", items: batch });
				if (r.t !== "hashes" || r.values.length !== batch.length) throw new Error(`unexpected hashRequest answer ${r.t}`);
				out.push(...r.values);
			}
			return out;
		},
	};
}
