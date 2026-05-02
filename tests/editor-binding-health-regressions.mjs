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

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const bindingSource = readFileSync(new URL("../src/sync/editorBinding.ts", import.meta.url), "utf8");

console.log("\n--- Test 1: validateAllOpenBindings uses repair-only flow ---");
{
	const section = sliceBetween(
		mainSource,
		"private validateAllOpenBindings(reason: string): void {",
		"private trackOpenFile(path: string): void {",
	);
	assert(section !== null, "validateAllOpenBindings section found");
	assert(section?.includes("this.editorBindings?.repair("), "validateAllOpenBindings calls repair");
	assert(!section?.includes("this.editorBindings?.heal("), "validateAllOpenBindings does not call heal");
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
	assert(
		healSection?.includes('"editor-health-heal"'),
		"editor-health-heal origin exists only in heal() implementation",
	);
	const strippedSource = bindingSource.replace(healSection ?? "", "");
	assert(
		!strippedSource.includes('"editor-health-heal"'),
		"editor-health-heal origin not used outside heal()",
	);
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
