/**
 * Tests for baseline advancement policy.
 *
 * Proves:
 * - Every reconciliation action selects the correct settled hash
 * - Null hash throws for actions that require it
 * - Reason strings remain descriptive
 */

import { planBaselineAdvancement } from "../../src/runtime/reconcile/baselineAdvancementPolicy";
import { suite } from "../harness.ts";

const s = suite("baseline-advancement-policy");

function assertThrows(fn: () => void, expectedMessage: string, msg: string) {
	try {
		fn();
		s.check(false, `${msg} (did not throw)`);
	} catch (err) {
		const actual = err instanceof Error ? err.message : String(err);
		s.check(actual.includes(expectedMessage), actual.includes(expectedMessage) ? msg : `${msg} (wrong error: ${actual})`);
	}
}

const DISK_HASH = "sha256-disk-content-abc123";
const CRDT_HASH = "sha256-crdt-content-def456";

s.section("Test 1: crdt-created-on-disk advances with crdtHash");
{
	const result = planBaselineAdvancement({
		actionKind: "crdt-created-on-disk",
		diskHash: null,
		crdtHash: CRDT_HASH,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash");
	s.check(result.kind === "advance" && result.reason.includes("crdt"), "reason mentions crdt");
}

s.section("Test 2: disk-seeded-to-crdt advances with diskHash");
{
	const result = planBaselineAdvancement({
		actionKind: "disk-seeded-to-crdt",
		diskHash: DISK_HASH,
		crdtHash: null,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === DISK_HASH, "hash is diskHash");
	s.check(result.kind === "advance" && result.reason.includes("disk"), "reason mentions disk");
}

s.section("Test 3: import-disk-to-crdt advances with diskHash");
{
	const result = planBaselineAdvancement({
		actionKind: "import-disk-to-crdt",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === DISK_HASH, "hash is diskHash (disk wins)");
	s.check(result.kind === "advance" && result.reason === "disk-wins-clean", "reason is disk-wins-clean");
}

s.section("Test 4: conflict-disk-wins advances with diskHash");
{
	const result = planBaselineAdvancement({
		actionKind: "conflict-disk-wins",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === DISK_HASH, "hash is diskHash");
	s.check(result.kind === "advance" && result.reason.includes("conflict"), "reason mentions conflict");
}

s.section("Test 5: conflict-crdt-wins advances with crdtHash");
{
	const result = planBaselineAdvancement({
		actionKind: "conflict-crdt-wins",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash");
	s.check(result.kind === "advance" && result.reason.includes("crdt-wins"), "reason mentions crdt-wins");
}

s.section("Test 6: apply-remote-to-disk advances with crdtHash");
{
	const result = planBaselineAdvancement({
		actionKind: "apply-remote-to-disk",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash (remote wins)");
	s.check(result.kind === "advance" && result.reason === "remote-applied-to-disk", "reason correct");
}

s.section("Test 7: no-op advances with crdtHash (same as diskHash)");
{
	const SAME_HASH = "sha256-identical-content";
	const result = planBaselineAdvancement({
		actionKind: "no-op",
		diskHash: SAME_HASH,
		crdtHash: SAME_HASH,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === SAME_HASH, "hash is the common content hash");
	s.check(result.kind === "advance" && result.reason === "content-identical", "reason is content-identical");
}

s.section("Test 8: defer-to-crdt-flush advances with crdtHash");
{
	const result = planBaselineAdvancement({
		actionKind: "defer-to-crdt-flush",
		diskHash: DISK_HASH,
		crdtHash: CRDT_HASH,
	});
	s.check(result.kind === "advance", "kind is advance");
	s.check(result.kind === "advance" && result.hash === CRDT_HASH, "hash is crdtHash");
	s.check(result.kind === "advance" && result.reason === "flush-completed", "reason is flush-completed");
}

s.section("Test 9: null crdtHash throws for crdt-authority actions");
{
	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "crdt-created-on-disk",
			diskHash: DISK_HASH,
			crdtHash: null,
		}),
		"requires crdtHash",
		"crdt-created-on-disk throws on null crdtHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "apply-remote-to-disk",
			diskHash: DISK_HASH,
			crdtHash: null,
		}),
		"requires crdtHash",
		"apply-remote-to-disk throws on null crdtHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "no-op",
			diskHash: DISK_HASH,
			crdtHash: null,
		}),
		"requires crdtHash",
		"no-op throws on null crdtHash",
	);
}

s.section("Test 10: null diskHash throws for disk-authority actions");
{
	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "disk-seeded-to-crdt",
			diskHash: null,
			crdtHash: CRDT_HASH,
		}),
		"requires diskHash",
		"disk-seeded-to-crdt throws on null diskHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "import-disk-to-crdt",
			diskHash: null,
			crdtHash: CRDT_HASH,
		}),
		"requires diskHash",
		"import-disk-to-crdt throws on null diskHash",
	);

	assertThrows(
		() => planBaselineAdvancement({
			actionKind: "conflict-disk-wins",
			diskHash: null,
			crdtHash: CRDT_HASH,
		}),
		"requires diskHash",
		"conflict-disk-wins throws on null diskHash",
	);
}

await s.done();
