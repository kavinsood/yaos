import { strict as assert } from "node:assert";
import {
	type ClosedFileConflictDecision,
	decideClosedFileConflict,
	type MissingBaselineWinnerPolicy,
} from "../../legacy-src/sync/closedFileConflict";
import { suite } from "../harness.ts";

// The assertions are node:assert's structural comparisons, unchanged: they
// compare whole decision objects, which s.check()'s boolean form cannot express
// without rewriting what each one asserts. The harness contributes the two
// things this suite lacked — a reported count (it used to assert ~30 times and
// report nothing at all) and scenario isolation, since a top-level
// assert.deepEqual failure used to abort the process and hide every case after
// it. Section headers became test names for the same reason: queued bodies run
// inside done(), so a header printed during module evaluation would no longer
// sit above the results it labels.

const s = suite("closed-file-conflict");

// Shorthand helpers
const diskWinsPreserveCrdt = { kind: "preserve-conflict", reason: "missing-baseline", winner: "disk", preserveCrdt: true } as const;
const crdtWinsPreserveDisk = { kind: "preserve-conflict", reason: "missing-baseline", winner: "crdt", preserveDisk: true } as const;

/** What decideClosedFileConflict returns: the decision plus its private policy tag. */
type Decision = ClosedFileConflictDecision & { _missingBaselinePolicy?: MissingBaselineWinnerPolicy };

function assertPolicy(
	result: Decision,
	expectedPolicy: string,
	msg: string,
): void {
	const actual = (result as Record<string, unknown>)._missingBaselinePolicy;
	assert.equal(actual, expectedPolicy, `${msg} — missingBaselinePolicy`);
}

// Strip the private _missingBaselinePolicy field for deepEqual comparisons
// (it is internal diagnostic data, not part of the decision contract).
function stripPolicy(r: Decision): object {
	const { _missingBaselinePolicy: _, ...rest } = r as Record<string, unknown>;
	return rest;
}

s.test("decision table: a known baseline decides disk-vs-crdt outright", () => {
	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "A" })),
		{ kind: "no-op" },
		"disk=crdt is no-op",
	);

	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({ baselineHash: "A", diskHash: "A", crdtHash: "B" })),
		{ kind: "apply-remote-to-disk", reason: "disk-at-baseline" },
		"baseline=A disk=A crdt=B applies remote",
	);

	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "A" })),
		{ kind: "import-disk-to-crdt", reason: "crdt-at-baseline" },
		"baseline=A disk=B crdt=A imports disk",
	);

	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({ baselineHash: "A", diskHash: "B", crdtHash: "C" })),
		{ kind: "preserve-conflict", reason: "both-changed", winner: "disk", preserveCrdt: true },
		"baseline=A disk=B crdt=C preserves conflict",
	);
});

// --- missing-baseline: no mtime evidence → CRDT wins (safe distributed default) ---

s.test("missing baseline, no mtime evidence → CRDT wins", () => {
	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C" })),
		{ ...crdtWinsPreserveDisk },
		"missing-baseline, no mtime inputs → CRDT wins",
	);
	assertPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C" }), "crdt-default-no-evidence",
		"missing-baseline, no mtime inputs");
});

// --- missing-baseline: only one of the two mtime inputs → CRDT wins (not enough evidence) ---

s.test("missing baseline, only one mtime input → CRDT wins", () => {
	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", diskMtime: 2000 })),
		{ ...crdtWinsPreserveDisk },
		"missing-baseline, only diskMtime (no lastDiskIndexPersistedAt) → CRDT wins",
	);
	assertPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", diskMtime: 2000 }),
		"crdt-default-no-evidence", "only diskMtime");

	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", lastDiskIndexPersistedAt: 1000 })),
		{ ...crdtWinsPreserveDisk },
		"missing-baseline, only lastDiskIndexPersistedAt (no diskMtime) → CRDT wins",
	);
	assertPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", lastDiskIndexPersistedAt: 1000 }),
		"crdt-default-no-evidence", "only lastDiskIndexPersistedAt");
});

// --- missing-baseline: diskMtime AFTER last save → disk edited while YAOS inactive → disk wins ---

s.test("missing baseline, diskMtime after the last index save → disk wins", () => {
	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({
			baselineHash: null,
			diskHash: "B",
			crdtHash: "C",
			diskMtime: 2000,
			lastDiskIndexPersistedAt: 1000,
		})),
		{ ...diskWinsPreserveCrdt },
		"missing-baseline, diskMtime > lastDiskIndexPersistedAt → disk edited while YAOS inactive → disk wins",
	);
	assertPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", diskMtime: 2000, lastDiskIndexPersistedAt: 1000 }),
		"disk-mtime-after-last-index-save", "disk newer than last save");
});

// --- missing-baseline: diskMtime BEFORE last save → disk is stale → CRDT wins ---

s.test("missing baseline, diskMtime before the last index save → CRDT wins", () => {
	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({
			baselineHash: null,
			diskHash: "B",
			crdtHash: "C",
			diskMtime: 1000,
			lastDiskIndexPersistedAt: 2000,
		})),
		{ ...crdtWinsPreserveDisk },
		"missing-baseline, diskMtime < lastDiskIndexPersistedAt → disk stale → CRDT wins",
	);
	assertPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", diskMtime: 1000, lastDiskIndexPersistedAt: 2000 }),
		"crdt-default-disk-not-newer", "disk not newer than last save");
});

// --- missing-baseline: diskMtime EQUAL to last save → not strictly newer → CRDT wins ---
// Equal case: diskMtime > lastDiskIndexPersistedAt is strict. Equal means "not after," so CRDT wins.

s.test("missing baseline, diskMtime equal to the last index save → CRDT wins", () => {
	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({
			baselineHash: null,
			diskHash: "B",
			crdtHash: "C",
			diskMtime: 1000,
			lastDiskIndexPersistedAt: 1000,
		})),
		{ ...crdtWinsPreserveDisk },
		"missing-baseline, diskMtime === lastDiskIndexPersistedAt → not strictly newer → CRDT wins",
	);
	assertPolicy(decideClosedFileConflict({ baselineHash: null, diskHash: "B", crdtHash: "C", diskMtime: 1000, lastDiskIndexPersistedAt: 1000 }),
		"crdt-default-disk-not-newer", "equal mtime not newer");
});

// --- disk === crdt is always no-op, even with null baseline and mtime evidence ---

s.test("disk === crdt is a no-op even with a null baseline and strong mtime evidence", () => {
	assert.deepEqual(
		stripPolicy(decideClosedFileConflict({
			baselineHash: null,
			diskHash: "same",
			crdtHash: "same",
			diskMtime: 9999,
			lastDiskIndexPersistedAt: 1,
		})),
		{ kind: "no-op" },
		"disk===crdt is no-op even with null baseline and strong mtime evidence",
	);
});

s.test("stale disk (no mtime evidence) → CRDT canonical", () => {
	const staleDisk = "old local disk";
	const newerRemoteCrdt = "newer remote server state";
	let canonicalCrdt = newerRemoteCrdt;
	let canonicalDisk = staleDisk;
	const conflictArtifacts: Array<{ side: "disk" | "crdt"; content: string }> = [];

	const decision = decideClosedFileConflict({
		baselineHash: null,
		diskHash: "stale-disk-hash",
		crdtHash: "newer-remote-hash",
		// No mtime evidence → CRDT wins (safe default)
	});

	if (decision.kind === "preserve-conflict") {
		const preservedContent = decision.preserveDisk ? canonicalDisk : canonicalCrdt;
		const preservedSide = decision.preserveDisk ? "disk" : "crdt";
		conflictArtifacts.push({ side: preservedSide, content: preservedContent });
		if (decision.winner === "disk") {
			canonicalCrdt = canonicalDisk;
		} else {
			canonicalDisk = canonicalCrdt;
		}
	}

	assert.equal(canonicalCrdt, newerRemoteCrdt, "canonical CRDT remains the newer remote version");
	assert.equal(canonicalDisk, newerRemoteCrdt, "canonical disk is updated from CRDT");
	assert.deepEqual(
		conflictArtifacts,
		[{ side: "disk", content: staleDisk }],
		"stale disk is preserved as the conflict artifact",
	);
});

s.test("user edited while YAOS inactive (mtime evidence) → disk wins", () => {
	const localEdit = "my offline note edits";
	const remoteContent = "newer remote server state";
	let canonicalCrdt = remoteContent;
	let canonicalDisk = localEdit;
	const conflictArtifacts: Array<{ side: "disk" | "crdt"; content: string }> = [];

	// Issue #22-B: diskMtime > lastDiskIndexPersistedAt → disk wins
	const decision = decideClosedFileConflict({
		baselineHash: null,
		diskHash: "local-edit-hash",
		crdtHash: "remote-hash",
		diskMtime: 1_700_000_000_000,          // modified T+1h
		lastDiskIndexPersistedAt: 1_699_996_400_000, // last save T-1h
	});

	if (decision.kind === "preserve-conflict") {
		const preservedContent = decision.preserveDisk ? canonicalDisk : canonicalCrdt;
		const preservedSide = decision.preserveDisk ? "disk" : "crdt";
		conflictArtifacts.push({ side: preservedSide, content: preservedContent });
		if (decision.winner === "disk") {
			canonicalCrdt = canonicalDisk;
		} else {
			canonicalDisk = canonicalCrdt;
		}
	}

	assert.equal(decision.kind, "preserve-conflict", "preserve-conflict decision");
	assert.equal((decision as { reason: string }).reason, "missing-baseline", "reason is missing-baseline");
	assert.equal((decision as { winner: string }).winner, "disk", "disk wins when edited after last save");
	assert.equal(canonicalDisk, localEdit, "canonical disk is the user's local edit");
	assert.equal(canonicalCrdt, localEdit, "canonical CRDT updated from disk");
	assert.deepEqual(
		conflictArtifacts,
		[{ side: "crdt", content: remoteContent }],
		"remote CRDT content is preserved as the conflict artifact",
	);
	assertPolicy(decision, "disk-mtime-after-last-index-save", "disk-wins policy field present");
});

await s.done();
