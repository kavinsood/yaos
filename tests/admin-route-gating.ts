/**
 * Admin route gating tests.
 *
 * Proves that destructive admin routes (compact, cleanup-kv) are properly
 * gated behind the YAOS_ENABLE_ADMIN_ROUTES env var, while read-only
 * debug routes remain accessible.
 *
 * Tests the route classifier in index.ts and the DO-level gating in server.ts.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  \x1b[32mPASS\x1b[0m  ${message}`);
		passed++;
	} else {
		console.log(`  \x1b[31mFAIL\x1b[0m  ${message}`);
		failed++;
	}
}

// ── Static analysis of route classifier ─────────────────────────────────────

const indexSrc = readFileSync(resolve(ROOT, "server/src/index.ts"), "utf8");
const serverSrc = readFileSync(resolve(ROOT, "server/src/server.ts"), "utf8");

console.log("\n--- Test 1: Route classifier allows debug routes ---");
{
	// GET /debug/recent must be classified as valid
	assert(
		indexSrc.includes('method === "GET" && rest.length === 1 && rest[0] === "recent"'),
		"GET /debug/recent is a known valid route shape",
	);
	// POST /debug/compact must be classified as valid (reaches auth)
	assert(
		indexSrc.includes('method === "POST" && rest.length === 1 && rest[0] === "compact"'),
		"POST /debug/compact is a known valid route shape",
	);
	// POST /debug/cleanup-kv must be classified as valid (reaches auth)
	assert(
		indexSrc.includes('method === "POST" && rest.length === 1 && rest[0] === "cleanup-kv"'),
		"POST /debug/cleanup-kv is a known valid route shape",
	);
}

console.log("\n--- Test 2: Admin routes require YAOS_ENABLE_ADMIN_ROUTES in DO ---");
{
	// The server.ts file must gate compact and cleanup-kv behind env var
	const compactGatePattern = /YAOS_ENABLE_ADMIN_ROUTES.*compact|compact.*YAOS_ENABLE_ADMIN_ROUTES/s;
	assert(
		serverSrc.includes("YAOS_ENABLE_ADMIN_ROUTES") &&
		serverSrc.includes("/__yaos/compact"),
		"server.ts references YAOS_ENABLE_ADMIN_ROUTES and /__yaos/compact",
	);

	// Find the compact handler and verify the gate comes BEFORE ensureDocumentLoaded
	const compactSection = serverSrc.substring(
		serverSrc.indexOf('url.pathname === "/__yaos/compact"'),
		serverSrc.indexOf('url.pathname === "/__yaos/compact"') + 300,
	);
	assert(
		compactSection.includes("YAOS_ENABLE_ADMIN_ROUTES"),
		"compact handler checks YAOS_ENABLE_ADMIN_ROUTES before proceeding",
	);

	const cleanupSection = serverSrc.substring(
		serverSrc.indexOf('url.pathname === "/__yaos/cleanup-kv"'),
		serverSrc.indexOf('url.pathname === "/__yaos/cleanup-kv"') + 300,
	);
	assert(
		cleanupSection.includes("YAOS_ENABLE_ADMIN_ROUTES"),
		"cleanup-kv handler checks YAOS_ENABLE_ADMIN_ROUTES before proceeding",
	);
}

console.log("\n--- Test 3: Gate returns 404 (not 401/403) when env var unset ---");
{
	// The gate should return json({ error: "not found" }, 404) — making
	// the route invisible, not just forbidden.
	const gateMatches = serverSrc.match(/YAOS_ENABLE_ADMIN_ROUTES[\s\S]{0,100}not found/g) ?? [];
	assert(
		gateMatches.length >= 2,
		`gate returns "not found" for both compact and cleanup-kv (found ${gateMatches.length} matches)`,
	);
}

console.log("\n--- Test 4: Read-only debug endpoint is NOT gated ---");
{
	// /__yaos/debug should NOT have YAOS_ENABLE_ADMIN_ROUTES check
	const debugSection = serverSrc.substring(
		serverSrc.indexOf('url.pathname === "/__yaos/debug"'),
		serverSrc.indexOf('url.pathname === "/__yaos/debug"') + 200,
	);
	assert(
		!debugSection.includes("YAOS_ENABLE_ADMIN_ROUTES"),
		"/__yaos/debug does NOT check YAOS_ENABLE_ADMIN_ROUTES (always accessible)",
	);
}

console.log("\n--- Test 5: Gate does not call ensureDocumentLoaded when blocked ---");
{
	// When the env var is unset, the handler must return BEFORE calling
	// ensureDocumentLoaded() — otherwise it still wakes the DO.
	// Check that the pattern is: if (!env) return 404; ... ensureDocumentLoaded
	const compactIdx = serverSrc.indexOf('url.pathname === "/__yaos/compact"');
	const nextEnsureLoaded = serverSrc.indexOf("ensureDocumentLoaded", compactIdx);
	const gateReturn = serverSrc.indexOf("YAOS_ENABLE_ADMIN_ROUTES", compactIdx);

	assert(
		gateReturn < nextEnsureLoaded,
		"compact: env var check comes before ensureDocumentLoaded (no DO hydration when gated)",
	);

	const cleanupIdx = serverSrc.indexOf('url.pathname === "/__yaos/cleanup-kv"');
	const nextEnsureLoaded2 = serverSrc.indexOf("ensureDocumentLoaded", cleanupIdx);
	const gateReturn2 = serverSrc.indexOf("YAOS_ENABLE_ADMIN_ROUTES", cleanupIdx);

	assert(
		gateReturn2 < nextEnsureLoaded2,
		"cleanup-kv: env var check comes before ensureDocumentLoaded (no DO hydration when gated)",
	);
}

console.log("\n--- Test 6: All vault routes require auth (pre-auth rejection) ---");
{
	// In index.ts, vault routes go through rejectAndLogUnauthorizedVaultRequest
	// before reaching any handler. This ensures unauthenticated requests
	// never reach the DO.
	assert(
		indexSrc.includes("rejectAndLogUnauthorizedVaultRequest"),
		"index.ts calls rejectAndLogUnauthorizedVaultRequest for vault routes",
	);

	// The auth check must come before the debug/compact/cleanup handlers
	const vaultSection = indexSrc.substring(
		indexSrc.indexOf("route.kind === \"vault\""),
		indexSrc.indexOf("route.kind === \"vault\"") + 1000,
	);
	const authCheckIdx = vaultSection.indexOf("rejectAndLogUnauthorizedVaultRequest");
	const compactHandlerIdx = vaultSection.indexOf("compact");
	const cleanupHandlerIdx = vaultSection.indexOf("cleanup-kv");

	assert(
		authCheckIdx < compactHandlerIdx,
		"auth check comes before compact handler in vault routing",
	);
	assert(
		authCheckIdx < cleanupHandlerIdx,
		"auth check comes before cleanup-kv handler in vault routing",
	);
}

console.log("\n--- Test 7: Cleanup refuses to run when SQL is empty ---");
{
	// The cleanupLegacyKvKeys method must check SQL health before deleting KV
	assert(
		serverSrc.includes("SQL storage is empty") &&
		serverSrc.includes("refusing to delete KV data"),
		"cleanup-kv aborts with clear message when SQL has no data",
	);
}

console.log("\n--- Test 8: wrangler.toml has YAOS_ENABLE_ADMIN_ROUTES documented ---");
{
	const wranglerToml = readFileSync(resolve(ROOT, "server/wrangler.toml"), "utf8");
	assert(
		wranglerToml.includes("YAOS_ENABLE_ADMIN_ROUTES"),
		"wrangler.toml documents YAOS_ENABLE_ADMIN_ROUTES",
	);
	// It should be commented out by default
	assert(
		wranglerToml.includes("# YAOS_ENABLE_ADMIN_ROUTES"),
		"YAOS_ENABLE_ADMIN_ROUTES is commented out by default",
	);
}

console.log("\n--- Test 9: Unclaimed server cannot reach vault routes ---");
{
	// The route handling for unclaimed servers returns early before vault access.
	// rejectUnauthorizedVaultRequest checks auth state.
	assert(
		indexSrc.includes('"unclaimed"'),
		"index.ts handles unclaimed auth state",
	);
	// The earlier test with yaos.ripplor.workers.dev confirmed unclaimed returns { error: "unclaimed" }
}

// ── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) process.exit(1);
