import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import type { VaultRuntimeStoragePort } from "../../server/src/platformPorts";
import { VaultRuntime } from "../../server/src/server";
import { bootstrapRoutesContract } from "../fixtures/G7-bootstrap-routes-contract";
import { suite } from "../harness";

const tests = suite("G7-bootstrap-routes-node");
tests.test("production VaultRuntime produces typed authenticated Node HTTP responses", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-g7-routes-"));
	const storage = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	try {
		for (const result of await bootstrapRoutesContract(storage as unknown as VaultRuntimeStoragePort, VaultRuntime)) console.log(`PASS ${result}`);
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});
await tests.done();
