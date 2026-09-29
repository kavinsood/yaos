import { strict as assert } from "node:assert";
import { EMPTY_PENDING_RECOVERY_STATE, getRecoveryReadiness } from "../../src/snapshots/recoveryState";
import type { RecoveryStatus } from "../../src/snapshots/recoveryClient";
import { suite } from "../harness.ts";

const checks = suite("G6-recovery-readiness");
checks.test("a known unavailable recovery capability overrides an empty status cache", () => {
	assert.equal(getRecoveryReadiness({ ...EMPTY_PENDING_RECOVERY_STATE }, false), "unavailable");
});

checks.test("unknown capabilities do not falsely claim recovery is unavailable", () => {
	assert.equal(getRecoveryReadiness({ ...EMPTY_PENDING_RECOVERY_STATE }, null), "preparing");
	assert.equal(getRecoveryReadiness({ ...EMPTY_PENDING_RECOVERY_STATE }, true), "preparing");
});

const recovery: RecoveryStatus = {
	syncReady: true,
	recoveryReady: true,
	storageAvailable: true,
	projectionState: "ready",
	projectionProcessed: 1,
	projectionTotal: 1,
	projectionLag: 0,
	oldestPinAgeMs: null,
	lastSuccessfulSnapshot: null,
	activeCapture: null,
	activeRestore: null,
};

checks.test("capability loss overrides a previously ready persisted status", () => {
	const state = { ...EMPTY_PENDING_RECOVERY_STATE, lastRecoveryStatus: recovery };
	assert.equal(getRecoveryReadiness(state, true), "ready");
	assert.equal(getRecoveryReadiness(state, false), "unavailable");
});

checks.test("a status response explicitly lacking storage remains unavailable", () => {
	assert.equal(getRecoveryReadiness({
		...EMPTY_PENDING_RECOVERY_STATE,
		lastRecoveryStatus: { ...recovery, storageAvailable: false },
	}, true), "unavailable");
});

checks.test("real retrying and preparation states stay distinct from unavailable", () => {
	assert.equal(getRecoveryReadiness({
		...EMPTY_PENDING_RECOVERY_STATE,
		lastRecoveryStatus: { ...recovery, recoveryReady: false, projectionState: "retrying" },
	}, true), "retrying");
	assert.equal(getRecoveryReadiness({
		...EMPTY_PENDING_RECOVERY_STATE,
		lastRecoveryStatus: { ...recovery, recoveryReady: false, projectionState: "building" },
	}, true), "preparing");
});

await checks.done();
