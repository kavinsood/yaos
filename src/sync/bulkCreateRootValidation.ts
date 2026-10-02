import * as Y from "yjs";

/**
 * P5: pre-validation of the root delta a bulk-create receipt carries.
 *
 * The delta is applied to a throwaway clone of the live root first. It is
 * accepted only if, on the clone:
 * - every created file maps its path to the body this client created;
 * - every created attachment heads its path with this operation's revision and hash;
 * - no path outside the batch was added, changed, removed or remapped in any
 *   path-keyed root map, and no existing `blobMeta` entry changed.
 *
 * Batch paths whose outcome is not "created" may change (the server maps an
 * existing owner it reports as `exists-*`), but never to this client's
 * identity. The caller applies the delta to the live root only on success.
 *
 * Cost: one full encode + apply of the live root per batch (measured ~10 ms
 * p50 on a 10k-path root, ~1 ms at 1k; see handoff-client.md).
 */

export const BULK_ROOT_PATH_MAPS = ["pathToId", "pathToSemantic", "pathToBlob", "blobTombstones"] as const;

export interface BulkRootExpectation {
	files: ReadonlyArray<{ path: string; bodyId: string; outcome: string }>;
	attachments: ReadonlyArray<{ path: string; operationId: string; hash: string; outcome: string }>;
}

export type BulkRootValidation = { ok: true } | { ok: false; reason: string };

function encodeValue(value: unknown): string | undefined {
	return value === undefined ? undefined : JSON.stringify(value);
}

function mapSnapshot(doc: Y.Doc, name: string): Map<string, string | undefined> {
	const out = new Map<string, string | undefined>();
	doc.getMap<unknown>(name).forEach((value, key) => { out.set(key, encodeValue(value)); });
	return out;
}

export function validateBulkCreateRootUpdate(
	live: Y.Doc,
	update: Uint8Array,
	expect: BulkRootExpectation,
): BulkRootValidation {
	const clone = new Y.Doc({ guid: `${live.guid}-bulk-validation` });
	try {
		try {
			Y.applyUpdate(clone, Y.encodeStateAsUpdate(live));
			Y.applyUpdate(clone, update);
		} catch (error) {
			return { ok: false, reason: `root update does not apply: ${String(error)}` };
		}
		const batchPaths = new Set<string>([
			...expect.files.map((file) => file.path),
			...expect.attachments.map((item) => item.path),
		]);
		for (const name of BULK_ROOT_PATH_MAPS) {
			const before = mapSnapshot(live, name);
			const after = mapSnapshot(clone, name);
			for (const [key, value] of after) {
				if (!batchPaths.has(key) && before.get(key) !== value) {
					return { ok: false, reason: `${name} changed unrelated path ${key}` };
				}
			}
			for (const key of before.keys()) {
				if (!batchPaths.has(key) && !after.has(key)) {
					return { ok: false, reason: `${name} removed unrelated path ${key}` };
				}
			}
		}
		const pathToId = clone.getMap<string>("pathToId");
		const pathToBlob = clone.getMap<{ revision?: string; hash?: string }>("pathToBlob");
		for (const file of expect.files) {
			const mapped = pathToId.get(file.path);
			if (file.outcome === "created") {
				if (mapped !== file.bodyId) {
					return { ok: false, reason: `created ${file.path} maps to ${mapped ?? "nothing"}, expected ${file.bodyId}` };
				}
			} else if (mapped === file.bodyId) {
				return { ok: false, reason: `${file.outcome} ${file.path} maps to this client's body ${file.bodyId}` };
			}
		}
		for (const item of expect.attachments) {
			const head = pathToBlob.get(item.path);
			if (item.outcome === "created") {
				if (!head || head.revision !== item.operationId || head.hash !== item.hash) {
					return { ok: false, reason: `created attachment ${item.path} is not headed by ${item.operationId}` };
				}
			} else if (head?.revision === item.operationId) {
				return { ok: false, reason: `${item.outcome} attachment ${item.path} is headed by this operation` };
			}
		}
		const createdHashes = new Set(expect.attachments.filter((item) => item.outcome === "created").map((item) => item.hash));
		const metaBefore = mapSnapshot(live, "blobMeta");
		const metaAfter = mapSnapshot(clone, "blobMeta");
		for (const [key, value] of metaBefore) {
			if (metaAfter.get(key) !== value) return { ok: false, reason: `blobMeta changed existing ${key}` };
		}
		for (const key of metaAfter.keys()) {
			if (!metaBefore.has(key) && !createdHashes.has(key)) return { ok: false, reason: `blobMeta added unrelated ${key}` };
		}
		return { ok: true };
	} finally {
		clone.destroy();
	}
}
