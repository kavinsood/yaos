/**
 * Source-level guard for the VaultSyncServer post-apply echo wire.
 *
 * Full y-partyserver/Cloudflare method dispatch is exercised by worker smoke
 * tests. This test keeps the critical wiring shape honest: classify before the
 * parent handler, send only after successful parent handling, and never use a
 * finally block that would echo after failure.
 */

import { readFileSync } from "node:fs";

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

const source = readFileSync("server/src/server.ts", "utf8");
const methodMatch = source.match(/handleMessage\(connection: Connection, message: WSMessage\): void \{([\s\S]*?)\n\t\}/);
const body = methodMatch?.[1] ?? "";

console.log("\n--- Test 1: post-apply echo wiring shape ---");
assert(source.includes("import { isUpdateBearingSyncMessage }"), "server imports pure classifier");
assert(methodMatch !== null, "server defines handleMessage override");
assert(body.includes("const shouldEcho = isUpdateBearingSyncMessage(message);"), "classifier result is computed");
assert(body.includes("super.handleMessage(connection, message);"), "parent handleMessage is called");
assert(body.includes("if (shouldEcho)"), "postApply echo is gated on classifier result");
assert(body.includes("\"postApply\""), "postApply kind is used");
assert(!body.includes("finally"), "handleMessage does not echo from a finally block");

const classifierIndex = body.indexOf("isUpdateBearingSyncMessage(message)");
const parentIndex = body.indexOf("super.handleMessage(connection, message)");
const postApplyIndex = body.indexOf("\"postApply\"");
assert(classifierIndex >= 0 && parentIndex > classifierIndex, "classifier runs before parent handler");
assert(parentIndex >= 0 && postApplyIndex > parentIndex, "postApply echo occurs after parent handler succeeds");

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
