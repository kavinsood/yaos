// Regression test for INV-SAFETY-02 / Phase 1.1 finding (+ FU-3 raw-origin guard).
//
// The diskMirror text observer treats any Yjs transaction whose origin is not
// classified as local as a remote update, scheduling a writeback. Local
// repair paths (disk-to-CRDT recovery, editor-bound heal) emit string origins
// and must be classified as local — otherwise the recovery transaction
// schedules a redundant disk write, with two real consequences:
//
//   1. Race window between recovery and flush: if disk content changes
//      between the recovery write and the deferred flush, the equality
//      short-circuit in flushWriteUnlocked fails and CRDT content (matching
//      the recovery-time disk state) overwrites the newer external edit.
//   2. Wasted work and misleading "remote change" trace lines for every
//      recovery transaction.
//
// Both safety nets (content-equality check at flush, fingerprint-based
// suppression on the modify event) mask the visible damage in the steady
// state, but the masking is incidental. The contract is that local repair
// origins are classified as local at the predicate level.

import {
	isLocalOrigin,
	isLocalStringOrigin,
	LOCAL_REPAIR_ORIGINS,
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_SEED,
	ORIGIN_RESTORE,
} from "../../src/sync/origins";
import { suite } from "../harness.ts";

const s = suite("disk-mirror-origin-classification");

const REQUIRED_LOCAL_ORIGINS = [
	ORIGIN_SEED,
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_RESTORE,
] as const;

s.section("Test 1: LOCAL_REPAIR_ORIGINS contains every required repair origin");
for (const origin of REQUIRED_LOCAL_ORIGINS) {
	s.check(
		isLocalStringOrigin(origin),
		`isLocalStringOrigin("${origin}") is true`,
	);
}
s.check(LOCAL_REPAIR_ORIGINS.length >= REQUIRED_LOCAL_ORIGINS.length, "at least the required count of repair origins");

s.section("Test 2: exported origin constants have the expected string values");
s.check(ORIGIN_DISK_SYNC === "disk-sync", "ORIGIN_DISK_SYNC === 'disk-sync'");
s.check(ORIGIN_DISK_SYNC_RECOVER_BOUND === "disk-sync-recover-bound", "ORIGIN_DISK_SYNC_RECOVER_BOUND");
s.check(ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER === "disk-sync-open-idle-recover", "ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER");
s.check(ORIGIN_EDITOR_HEALTH_HEAL === "editor-health-heal", "ORIGIN_EDITOR_HEALTH_HEAL");
s.check(ORIGIN_SEED === "vault-crdt-seed", "ORIGIN_SEED === 'vault-crdt-seed'");
s.check(ORIGIN_RESTORE === "snapshot-restore", "ORIGIN_RESTORE === 'snapshot-restore'");

s.section("Test 3: behavioral dispatch — local repair origins do NOT schedule a disk write");
// The diskMirror text observer calls isLocalOrigin() as a gate. If it returns
// true, the observer returns early and no write is scheduled. This test
// exercises isLocalOrigin() directly from the authoritative module to prove
// the correct dispatch decision for every registered repair origin.
const provider = { __sentinel: "provider" };

for (const origin of REQUIRED_LOCAL_ORIGINS) {
	s.check(
		isLocalOrigin(origin, provider) === true,
		`isLocalOrigin("${origin}") → local (no write scheduled)`,
	);
}

s.section("Test 4: behavioral dispatch — remote and unknown origins DO schedule a write");
s.check(
	isLocalOrigin(provider, provider) === false,
	"provider-origin transaction is remote (write allowed)",
);
s.check(
	isLocalOrigin("not-a-known-origin", provider) === false,
	"unknown string origins are NOT silently classified as local (write allowed)",
);
s.check(
	isLocalOrigin(null, provider) === true,
	"null origin (transact() without explicit origin) is local",
);
s.check(
	isLocalOrigin({ constructor: { name: "YSyncConfig" } }, provider) === true,
	"non-null object origins (e.g. y-codemirror's YSyncConfig) are local",
);

s.section("Test 5: call-site constants match registry (no raw string divergence)");
// Verify that the named export constants are the same values as what the
// internal set was built from. If someone changes a constant value without
// updating the set, this catches it.
const callSiteOrigins: ReadonlyArray<string> = [
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
	ORIGIN_EDITOR_HEALTH_HEAL,
	ORIGIN_SEED,
	ORIGIN_RESTORE,
];
for (const origin of callSiteOrigins) {
	s.check(
		isLocalStringOrigin(origin),
		`constant "${origin}" is registered in LOCAL_REPAIR_ORIGINS`,
	);
}

await s.done();
