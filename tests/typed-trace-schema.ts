import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function file(path: string): string {
	return readFileSync(path, "utf8");
}

console.log("\n--- Test 1: dangerous transitions have typed trace events ---");
{
	const reconciliation = file("src/runtime/reconciliationController.ts");
	const blobSync = file("src/sync/blobSync.ts");
	const diskMirror = file("src/sync/diskMirror.ts");
	const serverAck = file("src/sync/serverAckTracker.ts");
	const main = file("src/main.ts");
	const fmCoordinator = file("src/sync/frontmatterGuardCoordinator.ts");

	assert(reconciliation.includes('"recovery-postcondition-observed"'), "recovery postcondition observations are traced");
	assert(reconciliation.includes('"recovery-force-replace-applied"'), "recovery force-replace fallback is traced");
	assert(reconciliation.includes('"recovery-postcondition-failed"'), "recovery postcondition failure is traced");
	assert(reconciliation.includes('"recovery-postcondition-skipped"'), "recovery lock skips are traced");
	assert(reconciliation.includes('"conflict-artifact-needed"'), "ambiguous divergence conflict need is traced");
	assert(fmCoordinator.includes('"frontmatter-quarantined"'), "frontmatter quarantine uses quarantine trace source");
	assert(fmCoordinator.includes('"frontmatter-quarantine-cleared"'), "frontmatter quarantine clear uses quarantine trace source");
	assert(blobSync.includes('"download-overwrite-decision"'), "attachment download overwrite decisions are traced");
	assert(blobSync.includes('"download-conflict-quarantined"'), "attachment download conflicts are quarantined and traced");
	assert(serverAck.includes('"receipt-candidate-captured"'), "receipt candidate capture is traced");
	assert(serverAck.includes('"receipt-server-echo"'), "server receipt echo transitions are traced");
	assert(diskMirror.includes('"suppression-acknowledged"'), "suppression acknowledgements are traced");
	assert(diskMirror.includes('"suppression-mismatch"'), "suppression mismatches are traced");
	assert(diskMirror.includes('"remote-delete-applied"'), "remote delete completions are traced in diskMirror");
	assert(blobSync.includes('"remote-delete-applied"'), "remote delete completions are traced in blobSync");
	assert(reconciliation.includes('"recovery-quarantined"'), "recovery loop quarantine is traced");
	assert(reconciliation.includes('"conflict-artifact-created"'), "conflict artifact creation is traced");
	assert(reconciliation.includes('convergenceApplied'), "conflict convergence decision is traced");
}

console.log("\n--- Test 2: reconciliation traces safety and authority summaries ---");
{
	const reconciliation = file("src/runtime/reconciliationController.ts");
	assert(reconciliation.includes('"reconcile-scan-complete"'), "reconcile scan summary is traced");
	assert(reconciliation.includes('"reconcile-safety-brake-blocked"'), "safety-brake block is traced");
	assert(reconciliation.includes('"reconcile-authority-summary"'), "reconcile authority summary is traced");
	assert(reconciliation.includes('tracePathList("blockedUpdate"'), "blocked update path samples are included in trace details");
}

console.log("\n--- Test 3: source-grep static guard for recovery.skipped frontmatter-ingest-blocked wiring ---");
//
// This is a static-text guard, not a runtime schema validator. It catches
// accidental drift in the controller's frontmatter-ingest-blocked
// instrumentation by checking that the typed exports exist in the
// taxonomy module, the helper exists in the controller, and the helper
// is invoked exactly six times. Real type-level enforcement comes from
// `RecoverySkippedFrontmatterData` and `FrontmatterIngestBlockBranch` in
// src/telemetry/debug/flightEvents.ts; the runtime invariants are asserted by
// tests/frontmatter-guard-orchestration.ts.
{
	const reconciliation = file("src/runtime/reconciliationController.ts");
	const flight = file("src/telemetry/debug/flightEvents.ts");

	// Typed taxonomy exports live in src/telemetry/debug/flightEvents.ts (the helper
	// imports them; the test asserts they exist there, not in the
	// controller, so accidental local copies in the controller are caught).
	assert(
		flight.includes("export type RecoverySkippedReason ="),
		"flightEvents.ts exports RecoverySkippedReason union",
	);
	assert(
		flight.includes("export type FrontmatterIngestBlockBranch ="),
		"flightEvents.ts exports FrontmatterIngestBlockBranch union",
	);
	assert(
		flight.includes("export type RecoverySkippedFrontmatterData ="),
		"flightEvents.ts exports RecoverySkippedFrontmatterData payload type",
	);

	// Closed-enum branch type covers exactly the six block sites.
	const branchTypeMatch = flight.match(
		/export type FrontmatterIngestBlockBranch =\s*([\s\S]*?);/,
	);
	assert(branchTypeMatch !== null, "FrontmatterIngestBlockBranch declaration parses");
	const branchSrc = branchTypeMatch?.[1] ?? "";
	for (const literal of [
		"disk-to-crdt-existing",
		"disk-to-crdt-seed",
		"bound-file-local-only-divergence",
		"bound-file-local-only-seed",
		"bound-file-open-idle-disk-recovery",
		"bound-file-open-idle-seed",
	]) {
		assert(
			branchSrc.includes(`"${literal}"`),
			`FrontmatterIngestBlockBranch includes "${literal}"`,
		);
	}

	// RecoverySkippedReason carries every reason the controller emits today.
	const reasonTypeMatch = flight.match(
		/export type RecoverySkippedReason =\s*([\s\S]*?);/,
	);
	assert(reasonTypeMatch !== null, "RecoverySkippedReason declaration parses");
	const reasonSrc = reasonTypeMatch?.[1] ?? "";
	for (const literal of [
		"crdt-current-no-op",
		"recovery-lock-active",
		"recent-editor-activity",
		"frontmatter-ingest-blocked",
	]) {
		assert(
			reasonSrc.includes(`"${literal}"`),
			`RecoverySkippedReason includes "${literal}"`,
		);
	}

	// Controller imports the typed exports from the taxonomy module
	// (production code does NOT redeclare a local copy of the branch type).
	assert(
		reconciliation.includes("FrontmatterIngestBlockBranch"),
		"controller references FrontmatterIngestBlockBranch",
	);
	assert(
		reconciliation.includes("RecoverySkippedFrontmatterData"),
		"controller uses the typed RecoverySkippedFrontmatterData payload",
	);
	assert(
		!reconciliation.includes("type FrontmatterIngestBlockBranch ="),
		"controller does NOT redeclare FrontmatterIngestBlockBranch locally",
	);

	// Helper exists and the helper is the only emitter of the new reason
	// value (one declaration of the literal in the helper plus the typed
	// payload above brings the count to two; six call sites do not contain
	// the literal directly).
	assert(
		reconciliation.includes("private recordFrontmatterIngestBlocked("),
		"ReconciliationController defines recordFrontmatterIngestBlocked helper",
	);
	assert(
		reconciliation.includes('reason: "frontmatter-ingest-blocked"'),
		"helper builds payload with reason: \"frontmatter-ingest-blocked\"",
	);

	// Helper is invoked exactly six times (once per block site).
	const helperInvocations = reconciliation.match(/this\.recordFrontmatterIngestBlocked\(/g) ?? [];
	assert(
		helperInvocations.length === 6,
		`recordFrontmatterIngestBlocked invoked exactly six times in controller (got ${helperInvocations.length})`,
	);

	// FLIGHT_TAXONOMY_VERSION is at 10 (bumped by editor-bound localOnly
	// amplifier guard for recovery.amplification.quarantined).
	assert(
		flight.includes("export const FLIGHT_TAXONOMY_VERSION = 10"),
		"FLIGHT_TAXONOMY_VERSION at 10",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
