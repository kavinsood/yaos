const policyModule = await import("../src/sync/externalEditPolicy.ts");
const policy = policyModule.default ?? policyModule;
const { decideExternalEditImport } = policy;

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

console.log("\n--- Test 1: always policy imports both open and closed files ---");
{
	const closed = decideExternalEditImport("always", false);
	const open = decideExternalEditImport("always", true);
	assert(closed.allowImport, "always+closed allows import");
	assert(open.allowImport, "always+open allows import");
	assert(closed.reason === "allowed", "always+closed reason is allowed");
	assert(open.reason === "allowed", "always+open reason is allowed");
}

console.log("\n--- Test 2: closed-only policy imports only closed files ---");
{
	const closed = decideExternalEditImport("closed-only", false);
	const open = decideExternalEditImport("closed-only", true);
	assert(closed.allowImport, "closed-only+closed allows import");
	assert(!open.allowImport, "closed-only+open blocks import");
	assert(
		open.reason === "policy-closed-only-open-file",
		"closed-only+open reason is policy-closed-only-open-file",
	);
}

console.log("\n--- Test 3: never policy blocks imports regardless of openness ---");
{
	const closed = decideExternalEditImport("never", false);
	const open = decideExternalEditImport("never", true);
	assert(!closed.allowImport, "never+closed blocks import");
	assert(!open.allowImport, "never+open blocks import");
	assert(closed.reason === "policy-never", "never+closed reason is policy-never");
	assert(open.reason === "policy-never", "never+open reason is policy-never");
}

console.log(`\n${"-".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"-".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
