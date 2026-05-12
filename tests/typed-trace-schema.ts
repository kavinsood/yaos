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

	assert(reconciliation.includes('"recovery-postcondition-observed"'), "recovery postcondition observations are traced");
	assert(reconciliation.includes('"recovery-force-replace-applied"'), "recovery force-replace fallback is traced");
	assert(reconciliation.includes('"recovery-postcondition-failed"'), "recovery postcondition failure is traced");
	assert(reconciliation.includes('"recovery-postcondition-skipped"'), "recovery lock skips are traced");
	assert(reconciliation.includes('"conflict-artifact-needed"'), "ambiguous divergence conflict need is traced");
	assert(main.includes('this.trace("quarantine", "frontmatter-quarantined"'), "frontmatter quarantine uses quarantine trace source");
	assert(main.includes('this.trace("quarantine", "frontmatter-quarantine-cleared"'), "frontmatter quarantine clear uses quarantine trace source");
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

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
