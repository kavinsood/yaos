import { strict as assert } from "node:assert";
import { decideClosedFileConflict } from "../src/sync/closedFileConflict";

console.log("\n--- Test 1: closed-file conflict decision table ---");

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "A" }),
	{ kind: "no-op" },
	"disk=crdt is no-op",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "B" }),
	{ kind: "apply-remote-to-disk", reason: "disk-at-baseline" },
	"baseline=A disk=A crdt=B applies remote",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "A" }),
	{ kind: "import-disk-to-crdt", reason: "crdt-at-baseline" },
	"baseline=A disk=B crdt=A imports disk",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "C" }),
	{
		kind: "preserve-conflict",
		reason: "both-changed",
		winner: "disk",
		preserveCrdt: true,
	},
	"baseline=A disk=B crdt=C preserves conflict",
);

assert.deepEqual(
	decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C" }),
	{
		kind: "preserve-conflict",
		reason: "missing-baseline",
		winner: "disk",
		preserveCrdt: true,
	},
	"missing baseline preserves conflict",
);

console.log("\n──────────────────────────────────────────────────");
console.log("Results: 5 passed, 0 failed");
console.log("──────────────────────────────────────────────────");
