import { readFileSync } from "node:fs";

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

function sliceBetween(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	return source.slice(start, end);
}

const workspaceSource = readFileSync(new URL("../src/runtime/editorWorkspaceOrchestrator.ts", import.meta.url), "utf8");
const bindingSource = readFileSync(new URL("../src/sync/editorBinding.ts", import.meta.url), "utf8");

console.log("\n--- Test 1: validateOpenBindings uses repair-only flow ---");
{
	const section = sliceBetween(
		workspaceSource,
		"validateOpenBindings(reason: string): void {",
		"auditBindings(reason: string): number {",
	);
	assert(section !== null, "validateOpenBindings section found");
	assert(section?.includes("editorBindings.repair("), "validateOpenBindings calls repair");
	assert(!section?.includes("editorBindings.heal("), "validateOpenBindings does not call heal");
}

console.log("\n--- Test 2: bind unhealthy path uses repair, not heal ---");
{
	const section = sliceBetween(
		bindingSource,
		"bind(view: MarkdownView, deviceName: string): void {",
		"repair(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	assert(section !== null, "bind section found");
	assert(section?.includes("if (this.repair(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path calls repair");
	assert(!section?.includes("if (this.heal(view, deviceName, `bind-health:${reason}`))"), "bind unhealthy path does not call heal");
}

console.log("\n--- Test 3: maybeHealBinding uses repair/rebind and traces repair-only ---");
{
	const section = sliceBetween(
		bindingSource,
		"private maybeHealBinding(",
		"private scheduleCmResolveRetry(",
	);
	assert(section !== null, "maybeHealBinding section found");
	assert(section?.includes("const repaired = this.repair("), "maybeHealBinding calls repair");
	assert(!section?.includes("const healed = this.heal("), "maybeHealBinding does not call heal");
	assert(section?.includes('? "repair-only"'), "health-restored action reports repair-only");
}

console.log("\n--- Test 4: editor-health-heal origin remains manual-only ---");
{
	const healSection = sliceBetween(
		bindingSource,
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
		"rebind(view: MarkdownView, deviceName: string, reason: string): void {",
	);
	assert(healSection !== null, "heal section found");
	// After the origin-constants refactor the call site uses ORIGIN_EDITOR_HEALTH_HEAL
	// (imported from src/sync/origins.ts) instead of the raw string. Check for the
	// constant name rather than the literal.
	assert(
		healSection?.includes("ORIGIN_EDITOR_HEALTH_HEAL"),
		"editor-health-heal origin used via named constant in heal() implementation",
	);
	// Strip the heal section then check that applyDiffToYText is NOT called
	// with ORIGIN_EDITOR_HEALTH_HEAL outside it. The import declaration
	// is allowed to remain (it's not a call site). Use [^\n)]* to stay
	// on the same line and avoid spurious cross-line matches.
	const strippedSource = bindingSource.replace(healSection ?? "", "");
	assert(
		!strippedSource.match(/applyDiffToYText[^\n)]*ORIGIN_EDITOR_HEALTH_HEAL/),
		"ORIGIN_EDITOR_HEALTH_HEAL not passed to applyDiffToYText outside heal()",
	);
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
