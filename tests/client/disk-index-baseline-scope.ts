/**
 * Disk-index baselines are bound to the local database incarnation (S3).
 *
 * data.json (and with it the disk index) outlives IndexedDB loss, reset and
 * re-enrollment. A baseline written under another incarnation may name an
 * offline edit that was never committed through the current one; trusting
 * it would make that edit look like "disk unchanged" and let the body
 * overwrite it.
 */
import { strict as assert } from "node:assert";
import {
	adoptUnscopedBaselines,
	contentBaselineHash,
	discardContentBaselines,
	readDiskIndex,
	setCurrentContentHash,
	setPartialContentHashes,
	trustedContentHash,
	type DiskIndex,
	type DiskIndexEntry,
} from "../../src/sync/diskIndex";
import { VaultIndexedDb } from "../../src/sync/vaultIndexedDb";
import { FakeIndexedDb } from "../mocks/indexedDb";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { suite } from "../harness.ts";

installDomCrypto();
const s = suite("disk-index-baseline-scope");

s.test("a baseline proves nothing outside the local identity it was written under", async () => {
	const hash = await contentBaselineHash("content\n");
	const scoped: DiskIndexEntry = { mtime: 1, size: 1 };
	setCurrentContentHash(scoped, hash, "db-1");
	const legacy: DiskIndexEntry = { mtime: 1, size: 1 };
	setCurrentContentHash(legacy, hash);
	assert.equal(trustedContentHash(scoped, "db-1"), hash);
	assert.equal(trustedContentHash(scoped, "db-2"), undefined, "another incarnation");
	assert.equal(trustedContentHash(scoped, null), undefined, "identity not known yet");
	assert.equal(trustedContentHash(legacy, "db-1"), undefined, "legacy entries are untrusted");
	assert.equal(trustedContentHash(legacy, undefined), hash, "hosts that do not scope baselines (CLI)");
});

s.test("the scope survives persistence and is dropped with its hash", async () => {
	const hash = await contentBaselineHash("content\n");
	const whole: DiskIndexEntry = { mtime: 1, size: 1 };
	setCurrentContentHash(whole, hash, "db-1");
	const partial: DiskIndexEntry = { mtime: 1, size: 1 };
	setPartialContentHashes(partial, hash, hash, "db-1");
	const parsed = readDiskIndex(JSON.parse(JSON.stringify({
		"a.md": whole,
		"b.md": partial,
		"c.md": { mtime: 1, size: 1, baselineScope: "db-1" },
	})));
	assert.equal(parsed["a.md"]?.baselineScope, "db-1");
	assert.equal(parsed["b.md"]?.baselineScope, "db-1");
	assert.equal(parsed["c.md"]?.baselineScope, undefined, "a scope without a baseline is meaningless");
	setCurrentContentHash(parsed["a.md"]!, hash);
	assert.equal(parsed["a.md"]?.baselineScope, undefined, "re-establishing without a scope drops it");
});

s.test("discarding baselines keeps scan stats", async () => {
	const index: DiskIndex = { "a.md": { mtime: 5, size: 7 } };
	setCurrentContentHash(index["a.md"]!, await contentBaselineHash("x"), "db-1");
	assert.equal(discardContentBaselines(index), 1);
	assert.deepEqual(index, { "a.md": { mtime: 5, size: 7 } });
});

s.test("the local identity is stable per database and renewed when the database is lost", async () => {
	const indexedDb = new FakeIndexedDb();
	const first = new VaultIndexedDb("vault-a", "generation-a", "folder-a", indexedDb);
	const identity = await first.getOrCreateLocalIdentity();
	assert.equal(await first.getOrCreateLocalIdentity(), identity);
	const reopened = new VaultIndexedDb("vault-a", "generation-a", "folder-a", indexedDb);
	assert.equal(await reopened.getOrCreateLocalIdentity(), identity, "survives a restart");
	const lost = new VaultIndexedDb("vault-a", "generation-a", "folder-a", new FakeIndexedDb());
	assert.notEqual(await lost.getOrCreateLocalIdentity(), identity, "a lost/recreated database is a new incarnation");
	const otherGeneration = new VaultIndexedDb("vault-a", "generation-b", "folder-a", indexedDb);
	assert.notEqual(await otherGeneration.getOrCreateLocalIdentity(), identity, "re-enrollment is a new incarnation");
});

s.test("REVIEW N2: a new identity reports whether the database already held synced state", async () => {
	const empty = new VaultIndexedDb("vault-a", "generation-a", "folder-a", new FakeIndexedDb());
	const fresh = await empty.getOrCreateLocalIdentityWithOrigin();
	assert.equal(fresh.created, true);
	assert.equal(fresh.priorState, false, "a new database: legacy baselines are discarded");
	const again = await empty.getOrCreateLocalIdentityWithOrigin();
	assert.deepEqual([again.identity, again.created], [fresh.identity, false]);

	const upgraded = new VaultIndexedDb("vault-a", "generation-a", "folder-a", new FakeIndexedDb());
	await upgraded.putBootstrapProgress({ stage: "complete" } as never);
	const origin = await upgraded.getOrCreateLocalIdentityWithOrigin();
	assert.equal(origin.created, true);
	assert.equal(origin.priorState, true, "a pre-identity database of this vault: legacy baselines are adopted");
});

s.test("REVIEW N2: adoption scopes only legacy baselines", async () => {
	const hash = await contentBaselineHash("x");
	const index: DiskIndex = {
		"legacy.md": { mtime: 1, size: 1 },
		"other.md": { mtime: 1, size: 1 },
		"stat-only.md": { mtime: 1, size: 1 },
	};
	setCurrentContentHash(index["legacy.md"]!, hash);
	setCurrentContentHash(index["other.md"]!, hash, "db-old");
	assert.equal(adoptUnscopedBaselines(index, "db-new"), 1);
	assert.equal(trustedContentHash(index["legacy.md"], "db-new"), hash);
	assert.equal(trustedContentHash(index["other.md"], "db-new"), undefined, "another incarnation stays untrusted");
	assert.equal(index["stat-only.md"]?.baselineScope, undefined);
});

await s.done();
