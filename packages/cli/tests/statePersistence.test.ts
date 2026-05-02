import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import test from "node:test";
import * as Y from "yjs";
import {
	getStatePersistencePaths,
	loadStateUpdate,
	persistStateUpdate,
} from "../src/statePersistence";

test("persistStateUpdate stores a Yjs update that can seed a fresh doc", async () => {
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-state-"));
	try {
		const source = new Y.Doc();
		source.getMap<string>("pathToId").set("cafe.md", "file-1");

		const metadata = await persistStateUpdate(tempRoot, source, {
			host: "https://sync.example",
			vaultId: "vault-1",
			schemaVersion: 2,
			activePathCount: 1,
			syncedAt: "2026-05-02T00:00:00.000Z",
		});

		const loaded = loadStateUpdate(tempRoot, { host: "https://sync.example", vaultId: "vault-1" });
		assert.equal(loaded.loaded, true);
		assert.equal(loaded.byteLength, metadata.stateUpdateBytes);
		assert.equal(loaded.stateVectorHash, metadata.stateVectorHash);
		assert.ok(loaded.update);

		const restored = new Y.Doc();
		Y.applyUpdate(restored, loaded.update!);
		assert.equal(restored.getMap<string>("pathToId").get("cafe.md"), "file-1");

		const { metadataPath } = getStatePersistencePaths(tempRoot);
		const rawMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as typeof metadata;
		assert.equal(rawMetadata.host, "https://sync.example");
		assert.equal(rawMetadata.vaultId, "vault-1");
		assert.equal(rawMetadata.stateVectorHash, metadata.stateVectorHash);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("loadStateUpdate reports a missing cache without pretending local state loaded", async () => {
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-state-"));
	try {
		const loaded = loadStateUpdate(tempRoot);
		assert.equal(loaded.loaded, false);
		assert.equal(loaded.update, null);
		assert.equal(loaded.byteLength, 0);
		assert.equal(loaded.stateVectorHash, null);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("loadStateUpdate rejects corrupt state instead of silently full-syncing", async () => {
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-state-"));
	try {
		const { updatePath } = getStatePersistencePaths(tempRoot);
		await writeFile(updatePath, "not a yjs update", "utf8");
		assert.throws(
			() => loadStateUpdate(tempRoot),
			/Delete it to force a full resync/,
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});


test("loadStateUpdate rejects state from a different room identity", async () => {
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-state-"));
	try {
		const source = new Y.Doc();
		source.getMap<string>("pathToId").set("private.md", "file-1");
		await persistStateUpdate(tempRoot, source, {
			host: "https://sync.example",
			vaultId: "vault-1",
			schemaVersion: 2,
			activePathCount: 1,
		});

		assert.throws(
			() => loadStateUpdate(tempRoot, { host: "https://sync.example", vaultId: "vault-2" }),
			/state cache identity mismatch/,
		);
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
});