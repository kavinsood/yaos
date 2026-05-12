// Regression test for INV-SEC-01 / INV-OBS-02 / Phase 1.2 fix.
//
// Pre-authentication request paths must not call recordVaultTrace, because
// that function reaches the per-room Durable Object and persists a storage
// entry per call. Issue #40 (Cloudflare DO request explosion) was traced to
// rejection paths in server/src/index.ts and server/src/routes/syncSocket.ts
// emitting trace writes for every unauthorized/unclaimed/misconfigured
// request. The current contract is that these paths log via console.warn
// only; no DO contact, no storage write, no DO wake-up.
//
// This test enforces the contract by static analysis: it parses the two
// rejection functions and asserts no recordVaultTrace call exists inside
// them. If a future change re-introduces a pre-auth DO trace write, this
// test fails and the regression is caught at CI time, before another
// quota-burning deploy hits production.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, "../server/src/index.ts");
const authPath = resolve(here, "../server/src/routes/auth.ts");
const syncSocketPath = resolve(here, "../server/src/routes/syncSocket.ts");

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

/**
 * Extract the body of a top-level `function name(...) {...}` declaration.
 * Returns the substring between the matching outer braces, or null.
 */
function extractFunctionBody(source, functionName) {
	const declRe = new RegExp(`function\\s+${functionName}\\s*\\(`);
	const declMatch = declRe.exec(source);
	if (!declMatch) return null;

	let i = source.indexOf("{", declMatch.index);
	if (i < 0) return null;

	let depth = 0;
	const start = i;
	for (; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(start + 1, i);
			}
		}
	}
	return null;
}

console.log("\n--- Test 1: rejectUnauthorizedVaultRequest (auth.ts) contains no recordVaultTrace calls ---");
{
	// rejectUnauthorizedVaultRequest was moved to auth.ts (Obsidian-free, no DO deps)
	// so it can be imported and tested directly in runtime tests (FU-4).
	const source = readFileSync(authPath, "utf8");
	const body = extractFunctionBody(source, "rejectUnauthorizedVaultRequest");
	assert(body !== null, "rejectUnauthorizedVaultRequest declaration is parseable in auth.ts");
	assert(
		body !== null && !/recordVaultTrace\s*\(/.test(body),
		"rejectUnauthorizedVaultRequest body does not call recordVaultTrace (INV-SEC-01)",
	);
}

console.log("\n--- Test 1b: rejectAndLogUnauthorizedVaultRequest (index.ts) logs but does not trace ---");
{
	const source = readFileSync(indexPath, "utf8");
	const body = extractFunctionBody(source, "rejectAndLogUnauthorizedVaultRequest");
	assert(body !== null, "rejectAndLogUnauthorizedVaultRequest declaration is parseable in index.ts");
	assert(
		body !== null && !/recordVaultTrace\s*\(/.test(body),
		"rejectAndLogUnauthorizedVaultRequest body does not call recordVaultTrace (INV-SEC-01)",
	);
}

console.log("\n--- Test 2: handleSyncSocketRoute rejects without DO trace writes pre-auth ---");
{
	const source = readFileSync(syncSocketPath, "utf8");
	const body = extractFunctionBody(source, "handleSyncSocketRoute");
	assert(body !== null, "handleSyncSocketRoute declaration is parseable");

	// The function as a whole DOES call recordVaultTrace post-auth (for
	// schema-skew rejection and ws-connected). What must hold is that the
	// three pre-auth rejection branches — !authState.claimed,
	// authState.mode === "env" && !authState.envToken, and
	// !(await isAuthorized(...)) — do not emit recordVaultTrace before
	// returning.
	const preAuthSlice = body?.split(/if\s*\(\s*!\s*clientSchema\s*\)/)[0] ?? "";
	assert(
		preAuthSlice.length > 0,
		"pre-auth slice is non-empty (split landed at the post-auth boundary)",
	);
	assert(
		!/recordVaultTrace\s*\(/.test(preAuthSlice),
		"pre-auth socket rejection branches do not call recordVaultTrace (INV-SEC-01)",
	);
}

console.log("\n--- Test 3: rejection paths still produce log output (telemetry retained) ---");
{
	// Logging lives in rejectAndLogUnauthorizedVaultRequest (index.ts wrapper)
	const indexSource = readFileSync(indexPath, "utf8");
	const indexBody = extractFunctionBody(indexSource, "rejectAndLogUnauthorizedVaultRequest");
	assert(
		indexBody !== null && /logVaultRejection\s*\(/.test(indexBody),
		"rejectAndLogUnauthorizedVaultRequest emits structured log via logVaultRejection",
	);

	const socketSource = readFileSync(syncSocketPath, "utf8");
	const socketBody = extractFunctionBody(socketSource, "handleSyncSocketRoute");
	assert(
		socketBody !== null && /logSocketRejection\s*\(/.test(socketBody),
		"handleSyncSocketRoute emits structured log via logSocketRejection",
	);
}

console.log("\n--- Test 4: log helpers use console.warn (worker logs), not DO storage ---");
{
	const indexSource = readFileSync(indexPath, "utf8");
	const indexHelper = extractFunctionBody(indexSource, "logVaultRejection");
	assert(indexHelper !== null, "logVaultRejection declaration is parseable");
	assert(
		indexHelper !== null && /console\.warn\s*\(/.test(indexHelper),
		"logVaultRejection writes via console.warn",
	);
	assert(
		indexHelper !== null && !/recordVaultTrace|getServerByName|stub\.fetch/.test(indexHelper),
		"logVaultRejection does not contact the Durable Object",
	);

	const socketSource = readFileSync(syncSocketPath, "utf8");
	const socketHelper = extractFunctionBody(socketSource, "logSocketRejection");
	assert(socketHelper !== null, "logSocketRejection declaration is parseable");
	assert(
		socketHelper !== null && /console\.warn\s*\(/.test(socketHelper),
		"logSocketRejection writes via console.warn",
	);
	assert(
		socketHelper !== null && !/recordVaultTrace|getServerByName|stub\.fetch/.test(socketHelper),
		"logSocketRejection does not contact the Durable Object",
	);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
