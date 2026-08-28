import assert from "node:assert/strict";
import { mkdtemp, open, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	FilesystemObjectStore,
	type FilesystemObjectStoreOperations,
	ImmutableObjectConflictError,
} from "../../packages/server-node/src/objectStore";
import { suite } from "../harness.ts";

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

await s.done();
