/**
 * s11b semantic content assertions (Fix 4)
 *
 * Proves the s11b acceptance contract without live CDP:
 *   - artifact contains S11B-REMOTE (A's displaced CRDT edit) → pass
 *   - artifact missing S11B-REMOTE → fail
 *   - original path missing S11B-LOCAL → fail
 *   - both markers present → pass
 *
 * YAOS conflict policy for s11b (both-changed/winner=disk):
 *   - Disk wins main file → original path has S11B-LOCAL (B's local edit)
 *   - CRDT edit goes to artifact → artifact has S11B-REMOTE (A's remote edit)
 */

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

const tests: Array<[string, () => void]> = [];
function test(name: string, fn: () => void): void { tests.push([name, fn]); }

const LOCAL_MARKER = "S11B-LOCAL";
const REMOTE_MARKER = "S11B-REMOTE";

function checkS11bSemantics(artifactContent: string | null, survivorContent: string | null): {
	ok: boolean;
	artifactHasRemote: boolean;
	survivorHasLocal: boolean;
	errors: string[];
} {
	const errors: string[] = [];
	// Artifact has A's remote edit (displaced CRDT state)
	const artifactHasRemote = artifactContent?.includes(REMOTE_MARKER) ?? false;
	// Survivor (original path) has B's local edit (disk wins)
	const survivorHasLocal = survivorContent?.includes(LOCAL_MARKER) ?? false;
	if (!artifactHasRemote) errors.push(`artifact missing ${REMOTE_MARKER} (A's displaced CRDT edit)`);
	if (!survivorHasLocal) errors.push(`survivor missing ${LOCAL_MARKER} (B's local edit should win)`);
	return { ok: errors.length === 0, artifactHasRemote, survivorHasLocal, errors };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("artifact has S11B-REMOTE, survivor has S11B-LOCAL → pass", () => {
	const artifact = `# S11b Witness\n\nEDITED REMOTELY ON A WHILE B DISABLED. Marker ${REMOTE_MARKER}.\n`;
	const survivor = `# S11b Witness\n\nEDITED LOCALLY ON B WHILE DISABLED. Marker ${LOCAL_MARKER}.\n`;
	const result = checkS11bSemantics(artifact, survivor);
	assert.ok(result.ok, `Expected pass, got errors: ${result.errors.join(", ")}`);
	assert.ok(result.artifactHasRemote);
	assert.ok(result.survivorHasLocal);
});

test("artifact missing S11B-REMOTE → fail (A's edit not preserved)", () => {
	const artifact = `# S11b Witness\n\nSome content without the remote marker.\n`;
	const survivor = `# S11b Witness\n\nEDITED LOCALLY. Marker ${LOCAL_MARKER}.\n`;
	const result = checkS11bSemantics(artifact, survivor);
	assert.ok(!result.ok, "Should fail when artifact missing REMOTE marker");
	assert.ok(result.errors.some((e) => e.includes(REMOTE_MARKER)));
});

test("survivor missing S11B-LOCAL → fail (B's edit not preserved)", () => {
	const artifact = `# S11b Witness\n\nEDITED REMOTELY. Marker ${REMOTE_MARKER}.\n`;
	const survivor = `# S11b Witness\n\nOriginal content only, no local marker.\n`;
	const result = checkS11bSemantics(artifact, survivor);
	assert.ok(!result.ok, "Should fail when survivor missing LOCAL marker");
	assert.ok(result.errors.some((e) => e.includes(LOCAL_MARKER)));
});

test("both markers missing → fail with two errors", () => {
	const result = checkS11bSemantics("no markers here", "also no markers");
	assert.ok(!result.ok);
	assert.equal(result.errors.length, 2);
});

test("null artifact → fail (no conflict artifact created)", () => {
	const survivor = `# S11b Witness\n\nEDITED LOCALLY. Marker ${LOCAL_MARKER}.\n`;
	const result = checkS11bSemantics(null, survivor);
	assert.ok(!result.ok, "Should fail when artifact is null");
	assert.ok(!result.artifactHasRemote);
});

test("null survivor → fail", () => {
	const artifact = `# S11b Witness\n\nEDITED REMOTELY. Marker ${REMOTE_MARKER}.\n`;
	const result = checkS11bSemantics(artifact, null);
	assert.ok(!result.ok, "Should fail when survivor is null");
	assert.ok(!result.survivorHasLocal);
});

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

for (const [name, fn] of tests) {
	try {
		fn();
		console.log(`  PASS  ${name}`);
		passed++;
	} catch (err: unknown) {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${err instanceof Error ? err.message : String(err)}`);
		failed++;
	}
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

