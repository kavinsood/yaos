import assert from "node:assert/strict";
import { mkdtemp, open, opendir, readdir, rm, unlink, link, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	FilesystemObjectStore,
	type FilesystemObjectStoreOperations,
	ImmutableObjectConflictError,
} from "../../packages/server-node/src/objectStore";
import { suite } from "../harness.ts";
import { ObjectStreamValidationError } from "../../server/src/verifiedObjectStream";

const s = suite("node-runtime-object-store");

async function assertNoTemporaryFiles(root: string): Promise<void> {
	const entries = await readdir(root, { recursive: true });
	assert.deepEqual(
		entries.filter((entry) => basename(entry).startsWith(".yaos-tmp-")),
		[],
		"publication left a temporary object behind",
	);
}

function failTemporaryFileOperation(
	method: "write" | "sync",
	onFailure: () => void,
): FilesystemObjectStoreOperations["open"] {
	return async (path, flags, mode) => {
		const file = await open(path, flags, mode);
		if (flags !== "wx") return file;
		return new Proxy(file, {
			get(target, property) {
				if (property === method) {
					return async () => {
						onFailure();
						throw new Error(`injected ${method} failure`);
					};
				}
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
}

s.test("create-only publication validates an EEXIST winner without overwriting it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-objects-"));
	const store = new FilesystemObjectStore(join(directory, "objects"));
	await store.initialize();
	try {
		const key = "vaults/generation/recovery/root.json";
		const bytes = new TextEncoder().encode("immutable root");
		const options = { contentType: "application/json", customMetadata: { format: "recovery-v2" } };
		assert.equal(await store.createOnly(key, bytes, options), "created");
		assert.equal(await store.createOnly(key, bytes, options), "exists");
		await assert.rejects(
			store.createOnly(key, new TextEncoder().encode("different root"), options),
			(error: unknown) => error instanceof ImmutableObjectConflictError,
		);
		const object = await store.get(key);
		assert.ok(object);
		assert.equal(new TextDecoder().decode(object.bytes), "immutable root");
		assert.equal(object.contentType, "application/json");
		assert.deepEqual(object.customMetadata, { format: "recovery-v2" });
		await assertNoTemporaryFiles(store.root);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("get treats deletion between header and body opens as missing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-object-race-"));
	const root = join(directory, "objects");
	const key = "concurrent-delete";
	const location = join(root, key);
	let objectReads = 0;
	const store = new FilesystemObjectStore(root, {
		open: async (path, flags, mode) => {
			if (path === location && flags === "r" && ++objectReads === 2) await unlink(location);
			return await open(path, flags, mode);
		},
	});
	await store.initialize();
	try {
		await store.put(key, new TextEncoder().encode("delete during get"));
		assert.equal(await store.get(key), null);
		assert.equal(objectReads, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("publication failures remove every partial temporary object", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-object-failure-"));
	const root = join(directory, "objects");
	const bytes = new TextEncoder().encode("never publish partially");
	await new FilesystemObjectStore(root).initialize();
	try {
		for (const method of ["write", "sync"] as const) {
			let failureReached = false;
			const key = `failed-${method}`;
			const store = new FilesystemObjectStore(root, {
				open: failTemporaryFileOperation(method, () => {
					failureReached = true;
				}),
			});
			await assert.rejects(store.put(key, bytes), new RegExp(`injected ${method} failure`));
			assert.equal(failureReached, true);
			assert.equal(await store.head(key), null);
			await assertNoTemporaryFiles(root);
		}

		let linkReached = false;
		const linkFailure = new FilesystemObjectStore(root, {
			link: async () => {
				linkReached = true;
				throw new Error("injected link failure");
			},
		});
		await assert.rejects(linkFailure.put("failed-link", bytes), /injected link failure/);
		assert.equal(linkReached, true);
		assert.equal(await linkFailure.head("failed-link"), null);
		await assertNoTemporaryFiles(root);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("prefix listing and deletion expose only durably published objects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-object-list-"));
	const store = new FilesystemObjectStore(join(directory, "objects"));
	await store.initialize();
	try {
		await store.put("vault-a/generation-1/a", new Uint8Array([1]));
		await store.put("vault-a/generation-1/b", new Uint8Array([2]));
		await store.put("vault-b/generation-1/c", new Uint8Array([3]));
		const first = await store.list({ prefix: "vault-a/", limit: 1 });
		assert.equal(first.truncated, true);
		assert.equal(first.objects.length, 1);
		assert.ok(first.cursor);
		const second = await store.list({ prefix: "vault-a/", cursor: first.cursor ?? undefined, limit: 1 });
		assert.equal(second.truncated, false);
		assert.equal(second.objects.length, 1);
		await store.delete(first.objects[0]!.key);
		assert.equal(await store.head(first.objects[0]!.key), null);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("cursor pages use the startup index instead of rescanning the object tree", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-object-index-"));
	const root = join(directory, "objects");
	const writer = new FilesystemObjectStore(root);
	await writer.initialize();
	try {
		const objectCount = 64;
		for (let index = 0; index < objectCount; index++) {
			const bucket = String(index % 8).padStart(2, "0");
			const name = String(index).padStart(4, "0");
			await writer.put(`bench/${bucket}/${name}`, new Uint8Array([index]));
		}

		let directoryOpens = 0;
		let fileOpens = 0;
		const reader = new FilesystemObjectStore(root, {
			open: async (path, flags, mode) => {
				fileOpens++;
				return await open(path, flags, mode);
			},
			openDirectory: async (path) => {
				directoryOpens++;
				return await opendir(path);
			},
		});
		await reader.initialize();
		assert.ok(directoryOpens >= 10, "the startup index probe did not encounter the seeded directory tree");
		directoryOpens = 0;
		fileOpens = 0;

		const listedKeys: string[] = [];
		let cursor: string | undefined;
		let pageCount = 0;
		do {
			const page = await reader.list({ prefix: "bench/", cursor, limit: 7 });
			listedKeys.push(...page.objects.map((object) => object.key));
			pageCount++;
			assert.equal(directoryOpens, 0, `page ${pageCount} rescanned the filesystem tree`);
			cursor = page.cursor ?? undefined;
			if (!page.truncated) break;
		} while (true);

		assert.ok(pageCount > 2, "the fixture did not exercise subsequent cursor pages");
		assert.equal(listedKeys.length, objectCount);
		assert.equal(new Set(listedKeys).size, objectCount);
		assert.equal(fileOpens, objectCount, "listing work must be one header read per returned object");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("heavy create/delete churn compacts index tombstones without rescanning", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-object-index-churn-"));
	const root = join(directory, "objects");
	let directoryOpens = 0;
	const store = new FilesystemObjectStore(root, {
		openDirectory: async (path) => {
			directoryOpens++;
			return await opendir(path);
		},
	});
	await store.initialize();
	directoryOpens = 0;
	try {
		const retainedKeys = Array.from({ length: 16 }, (_, index) =>
			`churn/retained/${String(index).padStart(3, "0")}`);
		for (const key of retainedKeys) await store.put(key, new Uint8Array([1]));

		for (let round = 0; round < 6; round++) {
			const churnKeys = Array.from({ length: 300 }, (_, index) =>
				`churn/transient-${round}/${String(index).padStart(3, "0")}`);
			for (const key of churnKeys) await store.put(key, new Uint8Array([round]));

			const beforeDelete = await store.list({ prefix: "churn/", limit: 1_000 });
			assert.equal(beforeDelete.truncated, false);
			assert.equal(beforeDelete.objects.length, retainedKeys.length + churnKeys.length);
			for (const key of churnKeys) await store.delete(key);

			const afterDelete = await store.list({ prefix: "churn/", limit: 1_000 });
			assert.equal(afterDelete.truncated, false);
			assert.deepEqual(afterDelete.objects.map((object) => object.key), retainedKeys);
			assert.equal(directoryOpens, 0, `round ${round} rescanned the filesystem tree`);
		}

		const internal = store as unknown as { sortedKeys: unknown };
		assert.ok(Array.isArray(internal.sortedKeys));
		assert.ok(internal.sortedKeys.length <= retainedKeys.length + 255,
			`index retained ${internal.sortedKeys.length} entries for ${retainedKeys.length} live keys`);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("listing tolerates an indexed object being concurrently deleted", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-node-object-list-delete-"));
	const root = join(directory, "objects");
	const writer = new FilesystemObjectStore(root);
	await writer.initialize();
	try {
		await writer.put("capture/a", new Uint8Array([1]));
		await writer.put("capture/b", new Uint8Array([2]));
		await writer.put("capture/c", new Uint8Array([3]));
		const deletedLocation = join(root, "capture/b");
		let deleted = false;
		const reader = new FilesystemObjectStore(root, {
			open: async (path, flags, mode) => {
				if (!deleted && path === deletedLocation && flags === "r") {
					deleted = true;
					await unlink(deletedLocation);
				}
				return await open(path, flags, mode);
			},
		});
		await reader.initialize();

		const page = await reader.list({ prefix: "capture/", limit: 3 });
		assert.equal(deleted, true);
		assert.deepEqual(page.objects.map((object) => object.key), ["capture/a", "capture/c"]);
		assert.equal(page.truncated, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

function streamedBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset === bytes.byteLength) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + 1024));
			offset = Math.min(offset + 1024, bytes.byteLength);
		},
	});
}

s.test("R4 verifies existing bytes, preserves mtime and publishes a race exactly once", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-r4-race-"));
	try {
		let publications = 0;
		const store = new FilesystemObjectStore(directory, {
			link: async (temporary, final) => { await link(temporary, final); publications++; },
		});
		const bytes = new TextEncoder().encode("verified immutable blob");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const options = { length: bytes.byteLength, sha256, contentType: "text/plain" };
		const key = `blobs/${sha256}`;
		const results = await Promise.all(Array.from({ length: 8 }, () => store.createOnlyVerifiedStream(key, streamedBytes(bytes), options)));
		assert.deepEqual(results.sort(), ["created", ...Array<string>(7).fill("exists")]);
		assert.equal(publications, 1);
		const before = await stat(join(directory, key));
		assert.equal(await store.createOnlyVerifiedStream(key, streamedBytes(bytes), { ...options, contentType: "image/png" }), "exists");
		const wrong = bytes.slice();
		wrong[0] = wrong[0]! ^ 1;
		await assert.rejects(store.createOnlyVerifiedStream(key, streamedBytes(wrong), options),
			(error: unknown) => error instanceof ObjectStreamValidationError && error.kind === "hash_mismatch");
		assert.equal((await stat(join(directory, key))).mtimeMs, before.mtimeMs);
		assert.equal((await store.head(key))?.contentType, "text/plain");
		assert.equal(publications, 1);
		await assertNoTemporaryFiles(directory);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

s.test("R4 hash, length and disconnect failures never publish or leak temp files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-r4-invalid-"));
	try {
		const store = new FilesystemObjectStore(directory);
		const bytes = new TextEncoder().encode("streamed blob");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		for (const [name, options] of [
			["hash", { length: bytes.byteLength, sha256: "0".repeat(64) }],
			["short", { length: bytes.byteLength + 1, sha256 }],
			["long", { length: bytes.byteLength - 1, sha256 }],
		] as const) {
			await assert.rejects(store.createOnlyVerifiedStream(name, streamedBytes(bytes), options), ObjectStreamValidationError);
			assert.equal(await store.head(name), null);
			await assertNoTemporaryFiles(directory);
		}
		let first = true;
		const disconnected = new ReadableStream<Uint8Array>({ pull(controller) {
			if (first) { first = false; controller.enqueue(bytes.subarray(0, 2)); }
			else controller.error(new Error("disconnected"));
		} });
		await assert.rejects(store.createOnlyVerifiedStream("disconnect", disconnected, { length: bytes.byteLength, sha256 }), ObjectStreamValidationError);
		assert.equal(await store.head("disconnect"), null);
		await assertNoTemporaryFiles(directory);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

s.test("R4 10 MiB upload uses chunk-sized writes and no full-body allocation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-r4-memory-"));
	try {
		const chunkSize = 64 * 1024;
		const chunk = new Uint8Array(chunkSize).fill(42);
		const length = 10 * 1024 * 1024;
		const hash = createHash("sha256");
		for (let offset = 0; offset < length; offset += chunkSize) hash.update(chunk);
		let written = 0;
		let produced = 0;
		const store = new FilesystemObjectStore(directory, { open: async (path, flags, mode) => {
			const file = await open(path, flags, mode);
			if (!basename(path).startsWith(".yaos-tmp-")) return file;
			return new Proxy(file, { get(target, property) {
				if (property === "write") return async (bytes: Uint8Array, offset: number, count: number, position: number) => {
					assert.ok(bytes.byteLength <= chunkSize, "write retained a whole body");
					assert.ok(produced - written <= chunkSize * 2, "producer outran disk backpressure");
					const result = await target.write(bytes, offset, count, position);
					if (bytes.byteLength === chunkSize) written += result.bytesWritten;
					return result;
				};
				const value: unknown = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			} });
		} });
		const body = new ReadableStream<Uint8Array>({ pull(controller) {
			if (produced === length) return controller.close();
			produced += chunkSize;
			controller.enqueue(chunk.slice());
		} });
		assert.equal(await store.createOnlyVerifiedStream("large", body, { length, sha256: hash.digest("hex") }), "created");
		assert.equal(written, length);
		assert.equal((await store.head("large"))?.size, length);
		await assertNoTemporaryFiles(directory);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

s.test("R4 temp write/fsync failures never hard-link an unverified or unsynced object", async () => {
	for (const method of ["write", "sync"] as const) {
		const directory = await mkdtemp(join(tmpdir(), "yaos-r4-io-"));
		try {
			let failures = 0;
			let links = 0;
			const store = new FilesystemObjectStore(directory, {
				open: failTemporaryFileOperation(method, () => failures++),
				link: async (temporary, final) => { links++; await link(temporary, final); },
			});
			const bytes = new TextEncoder().encode("R4 io failure");
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			await assert.rejects(store.createOnlyVerifiedStream("blob", streamedBytes(bytes), { length: bytes.length, sha256 }), new RegExp(`injected ${method} failure`));
			assert.equal(failures, 1);
			assert.equal(links, 0);
			assert.equal(await store.head("blob"), null);
			await assertNoTemporaryFiles(directory);
		} finally { await rm(directory, { recursive: true, force: true }); }
	}
});

await s.done();
