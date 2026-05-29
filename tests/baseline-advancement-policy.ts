/**
 * Tests for baseline advancement policy.
 *
 * Proves:
 * - All 12 action kinds return correct advance/defer/clear decisions
 * - Hash selection matches the decision matrix
 * - Null hash throws for actions that require it
 * - Reason strings are descriptive
 */

import {
	planBaselineAdvancement,
	type BaselineAdvancementInput,
	type BaselineAdvanceAction,
} from "../src/runtime/reconcile/baselineAdvancementPolicy";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function assertThrows(fn: () => void, expectedMessage: string, msg: string) {
	try {
		fn();
		console.error(`  FAIL  ${msg} (did not throw)`);
		failed++;
	} catch (err) {
		const actual = err instanceof Error ? err.message : String(err);
		if (actual.includes(expectedMessage)) {
			console.log(`  PASS  ${msg}`);
			passed++;
		} else {
			console.error(`  FAIL  ${msg} (wrong error: ${actual})`);
			failed++;
		}
	}
}

const DISK_HASH = "sha256-disk-content-abc123";
const CRDT_HASH = "sha256-crdt-content-def456";
const BASELINE_HASH = "sha256-baseline-xyz789";

console.log("\n--- Test 1: crdt-created-on-disk advances with crdtHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "crdt-created-on-disk",
		diskHash: null,
		crdtHash: CRDT_HASH,
		previousBaselineHash: null,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash");
	assert(result.kind === "advance" && result.reason.includes("crdt"), "reason mentions crdt");
}

console.log("\n--- Test 2: disk-seeded-to-crdt advances with diskHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "disk-seeded-to-crdt",
		diskHash: DISK_HASH,
		crdtHash: null,
		previousBaselineHash: null,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === DISK_HASH, "hash is diskHash");
	assert(result.kind === "advance" && result.reason.includes("disk"), "reason mentions disk");
}

console.log("\n--- Test 3: import-disk-to-crdt advances with diskHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "import-disk-to-crdt",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === DISK_HASH, "hash is diskHash (disk wins)");
	assert(result.kind === "advance" && result.reason === "disk-wins-clean", "reason is disk-wins-clean");
}

console.log("\n--- Test 4: conflict-disk-wins advances with diskHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "conflict-disk-wins",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === DISK_HASH, "hash is diskHash");
	assert(result.kind === "advance" && result.reason.includes("conflict"), "reason mentions conflict");
}

console.log("\n--- Test 5: conflict-crdt-wins advances with crdtHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "conflict-crdt-wins",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash");
	assert(result.kind === "advance" && result.reason.includes("crdt-wins"), "reason mentions crdt-wins");
}

console.log("\n--- Test 6: apply-remote-to-disk advances with crdtHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "apply-remote-to-disk",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash (remote wins)");
	assert(result.kind === "advance" && result.reason === "remote-applied-to-disk", "reason correct");
}

console.log("\n--- Test 7: no-op advances with crdtHash (same as diskHash) ---");
{
	const SAME_HASH = "sha256-identical-content";
	const result = planBaselineAdvancement({
		actionKind: "no-op",
		diskHash: SAME_HASH,
		crdtHash: SAME_HASH,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === SAME_HASH, "hash is the common content hash");
	assert(result.kind === "advance" && result.reason === "content-identical", "reason is content-identical");
}

console.log("\n--- Test 8: defer-to-crdt-flush advances with crdtHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "defer-to-crdt-flush",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
		previousBaselineHash: null,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash");
	assert(result.kind === "advance" && result.reason === "flush-completed", "reason is flush-completed");
}

console.log("\n--- Test 9: live-disk-to-crdt advances with diskHash ---");
{
	const result = planBaselineAdvancement({
		actionKind: "live-disk-to-crdt",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "advance", "kind is advance");
	assert(result.kind === "advance" && result.hash === DISK_HASH, "hash is diskHash");
	assert(result.kind === "advance" && result.reason === "external-edit-imported", "reason correct");
}

console.log("\n--- Test 10: live-stat-only defers ---");
{
	const result = planBaselineAdvancement({
		actionKind: "live-stat-only",
		diskHash: null,
		crdtHash: null,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "defer", "kind is defer");
	assert(result.reason === "stat-only-no-content", "reason correct");
}

console.log("\n--- Test 11: conflict-artifact-failed defers ---");
{
	const result = planBaselineAdvancement({
		actionKind: "conflict-artifact-failed",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
		previousBaselineHash: BASELINE_HASH,
	});
	assert(result.kind === "defer", "kind is defer");
	assert(result.reason === "artifact-creation-failed", "reason correct");
}

console.log("\n--- Test 12: safety-brake defers ---");
{
	const result = planBaselineAdvancement({
		actionKind: "safety-brake",
		diskHash: null,
		crdtHash: null,
		previousBaselineHash: null,
	});
	assert(result.kind === "defer", "kind is defer");
	assert(result.reason === "safety-brake-blocked", "reason correct");
}

console.log("\n--- Test 13: null crdtHash throws for crdt-authority actions ---");
{
	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "crdt-created-on-disk",
			diskHash: DISK_HASH,
			crdtHash: null,
			previousBaselineHash: null,
		}),
		"requires crdtHash",
		"crdt-created-on-disk throws on null crdtHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "apply-remote-to-disk",
			diskHash: DISK_HASH,
			crdtHash: null,
			previousBaselineHash: BASELINE_HASH,
		}),
		"requires crdtHash",
		"apply-remote-to-disk throws on null crdtHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "no-op",
			diskHash: DISK_HASH,
			crdtHash: null,
			previousBaselineHash: BASELINE_HASH,
		}),
		"requires crdtHash",
		"no-op throws on null crdtHash",
	);
}

console.log("\n--- Test 14: null diskHash throws for disk-authority actions ---");
{
	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "disk-seeded-to-crdt",
			diskHash: null,
			crdtHash: CRDT_HASH,
			previousBaselineHash: null,
		}),
		"requires diskHash",
		"disk-seeded-to-crdt throws on null diskHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "import-disk-to-crdt",
			diskHash: null,
			crdtHash: CRDT_HASH,
			previousBaselineHash: BASELINE_HASH,
		}),
		"requires diskHash",
		"import-disk-to-crdt throws on null diskHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "conflict-disk-wins",
			diskHash: null,
			crdtHash: CRDT_HASH,
			previousBaselineHash: BASELINE_HASH,
		}),
		"requires diskHash",
		"conflict-disk-wins throws on null diskHash",
	);
}

console.log("\n--- Test 15: previousBaselineHash is not required ---");
{
	// All actions should work with null previousBaselineHash
	const result1 = planBaselineAdvancement({
		actionKind: "crdt-created-on-disk",
		diskHash: null,
		crdtHash: CRDT_HASH,
		previousBaselineHash: null,
	});
	assert(result1.kind === "advance", "works with null baseline (crdt-created-on-disk)");

	const result2 = planBaselineAdvancement({
		actionKind: "conflict-artifact-failed",
		diskHash: null,
		crdtHash: null,
		previousBaselineHash: null,
	});
	assert(result2.kind === "defer", "works with null baseline (conflict-artifact-failed)");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
