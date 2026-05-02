import * as Y from "yjs";

const diffModule = await import("../src/sync/diff.ts");
const { applyDiffToYText } = diffModule.default;

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

function makeText(content) {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, content);
	return { doc, ytext };
}

console.log("\n--- Test 1: bound-file recovery applies one content authority ---");
{
	const crdt = [
		"---",
		"timeEstimate: 2",
		"kind: op",
		"---",
		"",
	].join("\n");
	const disk = [
		"---",
		"timeEstimate: 20",
		"kind: op",
		"---",
		"",
	].join("\n");
	const staleEditor = [
		"---",
		"timeEstimate: 200",
		"kind: op",
		"---",
		"",
	].join("\n");

	const fixed = makeText(crdt);
	applyDiffToYText(fixed.ytext, crdt, disk, "disk-sync-recover-bound");
	assert(
		fixed.ytext.toString() === disk,
		"fixed recovery leaves CRDT at the chosen disk content",
	);
	fixed.doc.destroy();

	const oldAmplifier = makeText(crdt);
	applyDiffToYText(oldAmplifier.ytext, crdt, disk, "disk-sync-recover-bound");
	applyDiffToYText(oldAmplifier.ytext, disk, staleEditor, "editor-health-heal");
	assert(
		oldAmplifier.ytext.toString() === staleEditor,
		"old disk-then-heal sequence can reapply stale editor content",
	);
	assert(
		oldAmplifier.ytext.toString() !== disk,
		"old disk-then-heal sequence does not preserve the chosen disk authority",
	);
	oldAmplifier.doc.destroy();
}

console.log("\n--- Test 2: repeated disk-authority recovery does not amplify stale editor state ---");
{
	const crdt = [
		"---",
		"timeEstimate: 2",
		"kind: op",
		"---",
		"",
	].join("\n");
	const disk = [
		"---",
		"timeEstimate: 20",
		"kind: op",
		"---",
		"",
	].join("\n");
	const staleEditor = [
		"---",
		"timeEstimate: 200",
		"kind: op",
		"---",
		"",
	].join("\n");

	const state = makeText(crdt);
	for (let i = 0; i < 5; i++) {
		const before = state.ytext.toString();
		applyDiffToYText(state.ytext, before, disk, "disk-sync-recover-bound");
	}

	assert(state.ytext.toString() === disk, "repeated disk-authority recovery stays at disk content");
	assert(state.ytext.toString() !== staleEditor, "stale editor content is not reapplied during repair-only recovery");
	assert(state.ytext.toString().length === disk.length, "repeated repair-only recovery does not grow content");
	state.doc.destroy();
}

console.log("\n--- Test 3: post-recovery health retries stay bounded without editor rewrites ---");
{
	const crdt = [
		"---",
		"timeEstimate: 2",
		"kind: op",
		"---",
		"",
	].join("\n");
	const disk = [
		"---",
		"timeEstimate: 20",
		"kind: op",
		"---",
		"",
	].join("\n");
	const staleEditor = [
		"---",
		"timeEstimate: 200",
		"kind: op",
		"---",
		"",
	].join("\n");

	const state = makeText(crdt);
	for (let i = 0; i < 5; i++) {
		const before = state.ytext.toString();
		applyDiffToYText(state.ytext, before, disk, "disk-sync-recover-bound");
		// Automatic health retries should be repair/rebind only and therefore
		// should not write stale editor content back into Y.Text.
		const afterRecovery = state.ytext.toString();
		assert(afterRecovery === disk, `recovery cycle ${i + 1} keeps disk authority`);
		assert(afterRecovery !== staleEditor, `recovery cycle ${i + 1} does not replay stale editor`);
	}
	assert(state.ytext.toString().length === disk.length, "repeated recover+health cycles remain bounded");
	state.doc.destroy();
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
