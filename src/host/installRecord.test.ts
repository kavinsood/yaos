/** installRecord.ts (identity-per-store §2.4): the install key and the store lineage in App.saveLocalStorage. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installRecordKey, lineageOf, loadInstallRecord, MAX_PREDECESSORS, sanitizeInstallRecord, saveStoreIdentity, withStoreIdentity, type InstallStorage } from "./installRecord";

const RK = "r".repeat(43);
const id = (n: number) => `dev-${String(n).padStart(16, "0")}`;

function memStorage(): InstallStorage & { m: Map<string, unknown> } {
	const m = new Map<string, unknown>();
	return { m, load: (k) => m.get(k), save: (k, v) => void m.set(k, structuredClone(v)) };
}

let n = 0;
const bytes = (len: number) => new Uint8Array(len).map(() => ++n & 0xff);

test("key: yaos-install-<hex of the vaultId's bytes>", () => {
	assert.equal(installRecordKey("AAECAwQFBgcICQoLDA0ODw"), "yaos-install-000102030405060708090a0b0c0d0e0f");
});

test("load: none or unreadable -> a new record with a fresh install key, saved; a good one is kept", () => {
	const s = memStorage();
	const a = loadInstallRecord(s, "AAECAwQFBgcICQoLDA0ODw", bytes);
	assert.match(a.installKey, /^[A-Za-z0-9_-]{22}$/);
	assert.equal(a.current, null);
	assert.deepEqual(loadInstallRecord(s, "AAECAwQFBgcICQoLDA0ODw", bytes), a, "found again");
	s.m.set(installRecordKey("AAECAwQFBgcICQoLDA0ODw"), { v: 2, installKey: a.installKey });
	assert.notEqual(loadInstallRecord(s, "AAECAwQFBgcICQoLDA0ODw", bytes).installKey, a.installKey, "unreadable: start over");
});

test("sanitize: bad fields dropped, predecessors deduplicated, capped, never the current store", () => {
	assert.equal(sanitizeInstallRecord(null), null);
	assert.equal(sanitizeInstallRecord({ v: 1, installKey: "short" }), null);
	const r = sanitizeInstallRecord({
		v: 1, installKey: "k".repeat(22), current: { deviceId: id(0), retireKey: RK },
		predecessors: [id(0), id(1), id(1), 7, "bad id!", ...Array.from({ length: 12 }, (_, i) => id(i + 2))],
	});
	assert.ok(r);
	assert.equal(r.current?.deviceId, id(0));
	assert.equal(r.predecessors.length, MAX_PREDECESSORS);
	assert.equal(r.predecessors[0], id(1));
	assert.ok(!r.predecessors.includes(id(0)));
	assert.equal(sanitizeInstallRecord({ v: 1, installKey: "k".repeat(22), current: { deviceId: id(0), retireKey: "short" } })?.current, null);
});

test("withStoreIdentity: a new store moves the old to the front of the lineage; the same store changes nothing", () => {
	const r0 = { v: 1 as const, installKey: "k".repeat(22), current: null, predecessors: [] };
	const r1 = withStoreIdentity(r0, id(1), RK);
	assert.deepEqual(r1.current, { deviceId: id(1), retireKey: RK });
	assert.deepEqual(r1.predecessors, []);
	assert.equal(withStoreIdentity(r1, id(1), RK), r1);
	const r2 = withStoreIdentity(r1, id(2), RK);
	assert.deepEqual(r2.predecessors, [id(1)]);
	assert.deepEqual(lineageOf(r2), [id(2), id(1)]);
	assert.equal(withStoreIdentity(r2, "bad id", RK), r2, "malformed: ignored");
});

test("saveStoreIdentity: written for its own install key only (a recreated record belongs to another store)", () => {
	const s = memStorage();
	const vault = "AAECAwQFBgcICQoLDA0ODw";
	const rec = loadInstallRecord(s, vault, bytes);
	saveStoreIdentity(s, vault, rec.installKey, id(1), RK);
	assert.equal(sanitizeInstallRecord(s.m.get(installRecordKey(vault)))?.current?.deviceId, id(1));
	saveStoreIdentity(s, vault, "another-install-key-00", id(2), RK);
	assert.equal(sanitizeInstallRecord(s.m.get(installRecordKey(vault)))?.current?.deviceId, id(1), "not this install's store");
});
