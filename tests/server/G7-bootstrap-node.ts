import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import type { VaultStoragePort } from "../../server/src/vaultStore";
import { bootstrapContract } from "../fixtures/G7-bootstrap-contract";
import { suite } from "../harness";

const tests = suite("G7-bootstrap-node");
tests.test("concurrent bootstrap contract on real Node SQLite", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-g7-"));
	const storage = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	try {
		for (const result of await bootstrapContract(storage as unknown as VaultStoragePort)) console.log(`PASS ${result}`);
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});
await tests.done();
