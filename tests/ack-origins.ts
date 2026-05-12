/**
 * Unit tests for server-ack origin classification.
 */

import { isAckTrackedLocalOrigin } from "../src/sync/ackOrigins";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

console.log("\n--- Test 1: null/undefined provider and persistence do not suppress local origin=null ---");
{
	assert(isAckTrackedLocalOrigin(null, null, null), "provider=null, persistence=null, origin=null => tracked");
	assert(isAckTrackedLocalOrigin(null, undefined, undefined), "provider=undefined, persistence=undefined, origin=null => tracked");
}

console.log("\n--- Test 2: concrete provider/persistence origins are suppressed ---");
{
	const provider = { kind: "provider" };
	const persistence = { kind: "persistence" };
	assert(!isAckTrackedLocalOrigin(provider, provider, persistence), "origin=provider => not tracked");
	assert(!isAckTrackedLocalOrigin(persistence, provider, persistence), "origin=persistence => not tracked");
	assert(isAckTrackedLocalOrigin(null, provider, persistence), "origin=null with concrete provider/persistence => tracked");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
