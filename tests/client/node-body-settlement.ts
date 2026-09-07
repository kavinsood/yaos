import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeVaultDatabase } from "../../packages/cli/src/nodeVaultDatabase";
import type { StoredBodySettlement } from "../../src/sync/bodySettlement";
import { suite } from "../harness.ts";

const s = suite("node-body-settlement");

function settlement(revision: number, generation: number): StoredBodySettlement {
	return {
		format: 1,
		bodyId: "body",
		vaultGeneration: "generation",
		canonicalVersion: "markdown-lf-v1",
		content: "base",
		contentHash: "a".repeat(64),
		durableGeneration: generation,
		serverContentHash: "a".repeat(64),
		diskFingerprint: { bytes: 4, hash: "b".repeat(64) },
		pathAtSettlement: "note.md",
		localSettlementRevision: revision,
		settledAt: revision,
	};
}

s.test("SQLite settlement CAS survives restart and rejects a late writer", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-body-settlement-"));
	const path = join(directory, "vault.sqlite");
	const first = new NodeVaultDatabase(path);
	const second = new NodeVaultDatabase(path);
	try {
		assert.equal(await first.compareAndSwapBodySettlement(settlement(1, 1), null), true);
		assert.equal((await second.getBodySettlement("body"))?.localSettlementRevision, 1);
		assert.equal(await first.compareAndSwapBodySettlement(settlement(2, 2), 1), true);
		assert.equal(await second.compareAndSwapBodySettlement(settlement(2, 3), 1), false);
		await first.close();
		await second.close();
		const restarted = new NodeVaultDatabase(path);
		assert.equal((await restarted.getBodySettlement("body"))?.durableGeneration, 2);
		await restarted.close();
	} finally {
		await first.close();
		await second.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
