/**
 * Runtime regression test for issue #40: DO subrequest amplification.
 *
 * Verifies at runtime that unknown/junk request paths return 404 without
 * touching any Durable Object namespace.  A trap env is used — any access to
 * YAOS_CONFIG or YAOS_SYNC throws with a clear error message so the test fails
 * loudly rather than silently passing if the DO access is swallowed.
 *
 * Also verifies that the /api/capabilities endpoint in claim mode only calls
 * YAOS_CONFIG once (auth + capabilities reuse the same fetched config).
 */

import worker from "../../server/src/index";
import type { Env } from "../../server/src/routes/types";
import {
	getStoredServerConfigCached,
	invalidateStoredServerConfigCache,
} from "../../server/src/routes/auth";
import { makeConfigNamespace, makeEnv, makeStoredConfigNamespace, makeTrapNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("server-route-classification-runtime");

// ── Trap env — any DO access throws ──────────────────────────────────────────

const DO_TOUCHED = "Durable Object namespace accessed for unknown route (issue #40 regression — INV-ROUTE-01)";

const trapEnv: Env = makeEnv({
	YAOS_SYNC: makeTrapNamespace(DO_TOUCHED),
	YAOS_CONFIG: makeTrapNamespace(DO_TOUCHED),
	SYNC_TOKEN: undefined,
});

// ── Test 1: junk paths return 404 without touching any DO ─────────────────────
s.section("Test 1: junk paths return 404 without touching YAOS_CONFIG or YAOS_SYNC");
{
	const junkPaths = [
		"/wp-login.php",
		"/favicon.ico",
		"/random-garbage",
		"/foo/bar",
		"/.env",
		"/admin",
		"/phpmyadmin",
		"/xmlrpc.php",
		"/.git/config",
	];

	for (const path of junkPaths) {
		let threw = false;
		let status = 0;
		try {
			const resp = await worker.fetch(
				new Request(`https://example.com${path}`),
				trapEnv,
			);
			status = resp.status;
		} catch (err) {
			threw = true;
			console.error(`  ERROR ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		s.check(!threw, `${path}: did not throw (DO namespace not touched)`);
		s.check(status === 404, `${path}: status is 404`);
	}
}

// ── Test 2: /vault/:id with no resource 404s without DO access ────────────────
s.section("Test 2: vault-shaped garbage paths return 404 without DO access");
{
	// These are the paths the reviewer explicitly flagged as still potentially
	// hitting YAOS_CONFIG after the first pass of the fix:
	//   /vault/foo              — no resource
	//   /vault/foo/random       — unknown resource
	//   /vault/foo/wp-login.php — garbage resource with plausible vault prefix
	// The vault resource whitelist (VALID_VAULT_RESOURCES) must catch these.
	const vaultJunkPaths = [
		"/vault/my-vault",               // no resource at all
		"/vault/foo/random",             // unknown resource
		"/vault/foo/wp-login.php",       // garbage resource
		"/vault/foo/probe",              // scanner probe
		"/vault/some-vault/not-a-resource",
		"/vault/abc123/admin",
		"/vault/abc123/config",
		"/vault/abc123/.env",
	];

	for (const path of vaultJunkPaths) {
		let threw = false;
		let status = 0;
		try {
			const resp = await worker.fetch(
				new Request(`https://example.com${path}`),
				trapEnv,
			);
			status = resp.status;
		} catch (err) {
			threw = true;
			console.error(`  ERROR ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		s.check(!threw, `${path}: did not throw (DO namespace not touched)`);
		s.check(status === 404, `${path}: status is 404`);
	}
}

// ── Test 3: Two claim-mode requests within TTL share one YAOS_CONFIG fetch ────
//
// This is the core issue #40 TTL cache runtime proof.  In claim mode, the
// first request populates the cache; the second request within the TTL window
// reuses the cached config and makes zero additional DO fetches.
//
// Both requests go through getAuthStateCached (one fetch) AND
// handleCapabilities which reuses authState.config (zero extra fetch).
// Total fetches for two requests: 1.  Before the fix it was 4 (2×2).
s.section("Test 3: two claim-mode requests within TTL share one YAOS_CONFIG fetch");
{
	invalidateStoredServerConfigCache();

	let fetchCount = 0;
	const claimConfig = {
		claimed: true,
		tokenHash: "abc123",
		updateProvider: null,
		updateRepoUrl: null,
		updateRepoBranch: null,
	};

	const countingEnv: Env = makeEnv({
		YAOS_SYNC: makeTrapNamespace(DO_TOUCHED),
		YAOS_CONFIG: makeConfigNamespace(async () => {
			fetchCount++;
			return new Response(JSON.stringify(claimConfig), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
		SYNC_TOKEN: undefined,
	});

	const resp = await worker.fetch(
		new Request("https://example.com/api/capabilities"),
		countingEnv,
	);
	s.check(resp.status === 200, "/api/capabilities in claim mode returns 200");
	s.check(fetchCount === 1, `/api/capabilities in claim mode called YAOS_CONFIG exactly once (got ${fetchCount})`);

	// Second request uses the TTL cache — zero additional DO calls.
	fetchCount = 0;
	const resp2 = await worker.fetch(
		new Request("https://example.com/api/capabilities"),
		countingEnv,
	);
	s.check(resp2.status === 200, "/api/capabilities second request returns 200");
	s.check(fetchCount === 0, `second /api/capabilities within TTL uses cache (YAOS_CONFIG called ${fetchCount} times, expected 0)`);

	invalidateStoredServerConfigCache();
}

// ── Test 4: claimed routes in unclaimed mode return expected error ─────────────
//
// In unclaimed mode, getAuthStateCached must NOT call YAOS_SYNC.  Auth
// decisions happen entirely on YAOS_CONFIG config, before any vault routing.
s.section("Test 4: unclaimed mode — vault routes rejected without YAOS_SYNC access");
{
	invalidateStoredServerConfigCache();

	// The trap records every member reached, so "was not touched" is a positive
	// observable rather than the mere absence of a thrown error.
	const syncTrap = makeTrapNamespace("YAOS_SYNC accessed before auth succeeded");
	const trapSyncEnv: Env = makeEnv({
		YAOS_SYNC: syncTrap,
		YAOS_CONFIG: makeStoredConfigNamespace({
			claimed: false,
			tokenHash: null,
			updateProvider: null,
			updateRepoUrl: null,
			updateRepoBranch: null,
		}),
		SYNC_TOKEN: undefined,
	});

	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...values: unknown[]) => {
		warnings.push(values.map(String).join(" "));
	};
	let resp: Response | null = null;
	try {
		resp = await worker.fetch(
			new Request("https://example.com/vault/some-vault/debug/recent"),
			trapSyncEnv,
		);
	} finally {
		console.warn = originalWarn;
	}
	s.check(resp?.status === 503, "unclaimed mode: vault route returns 503");
	s.check(syncTrap.touched.length === 0, "unclaimed mode: YAOS_SYNC was not touched");
	s.check(
		warnings.some((warning) =>
			warning.includes("vault rejected pre-auth")
			&& warning.includes('"reason":"unclaimed"')
		),
		"unclaimed rejection emits a structured Worker warning",
	);

	invalidateStoredServerConfigCache();
}

// ── Test 5: valid resource + invalid method/subpath → 404 before DO ───────────
//
// The four paths the reviewer explicitly flagged as the remaining hole after
// resource-only whitelisting.  These have a valid resource segment but an
// invalid method or subpath combination that the server never handles.
// They must be rejected by isKnownVaultRouteShape() before auth.
s.section("Test 5: valid resource + invalid shape returns 404 without YAOS_CONFIG");
{
	const invalidShapePaths: Array<[string, string]> = [
		// method, path
		["POST", "/vault/foo/debug/recent"],       // debug is GET-only
		["GET",  "/vault/foo/debug/evil"],          // debug only handles /recent
		["GET",  "/vault/foo/auth/random"],         // auth only handles POST /ticket
		["POST", "/vault/foo/blobs/not-real"],      // blobs POST only handles /exists
		["DELETE", "/vault/foo/blobs/somehash"],    // blobs doesn't handle DELETE
		["POST", "/vault/foo/auth/ticket/extra"],   // extra path segments
		["GET",  "/api/not-real"],                  // API-shaped but unknown endpoint
	];

	for (const [method, path] of invalidShapePaths) {
		let threw = false;
		let status = 0;
		try {
			const resp = await worker.fetch(
				new Request(`https://example.com${path}`, { method }),
				trapEnv,
			);
			status = resp.status;
		} catch (err) {
			threw = true;
			console.error(`  ERROR ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		s.check(!threw, `${method} ${path}: did not throw (DO namespace not touched)`);
		s.check(status === 404, `${method} ${path}: status is 404`);
	}
}

// ── Test 6: parseSyncPath ordering — /vault/sync/:id is not misread ───────────
//
// Regression guard: parseSyncPath must run before parseVaultPath.
// If the order were reversed, /vault/sync/my-vault would be parsed as
// vaultId="sync", resource="my-vault" and rejected as not-found by the
// resource whitelist — a silent breakage of sync connectivity.
s.section("Test 6: /vault/sync/:vaultId is classified as sync-socket, not vault");
{
	// The trap env throws on DO access.  A sync-socket route calls
	// getServerByName(env.YAOS_SYNC) so it WOULD throw.  But the classifier
	// result itself (before dispatch) is what we want to verify.
	// We test the side-effect: a WS-upgrade request to the sync path must not
	// return 404 (which would happen if parseSyncPath were skipped).
	//
	// Both namespaces are traps: this request never reaches a Durable Object.
	// It carries no token, so the sync handler's auth gate rejects it with 401 —
	// already enough to distinguish "classified as sync" (401, from the sync
	// handler) from "classified as not-found" (404, from the resource
	// whitelist) — and the traps prove no DO was woken on the way.
	//
	// An earlier version of this block wired a YAOS_SYNC stub whose fetch
	// returned 426.  That stub was unreachable twice over: auth rejects before
	// routing, and the sync handler obtains its stub via getServerByName(),
	// which tests/mocks/partyserver.ts replaces with a thrower.  The 426 branch
	// below is kept in the accepted set because it is the status a real
	// deployment returns here.
	const syncTestEnv: Env = makeEnv({
		SYNC_TOKEN: "test-token-for-sync-ordering-check",
		YAOS_SYNC: makeTrapNamespace(DO_TOUCHED),
		YAOS_CONFIG: makeTrapNamespace(DO_TOUCHED),
	});

	// Non-WS request to the sync path — classified as sync-socket, then refused
	// by the sync handler's auth gate rather than by the not-found path.
	const resp = await worker.fetch(
		new Request("https://example.com/vault/sync/my-vault"),
		syncTestEnv,
	);
	// 426 means it reached the sync handler, not the 404 not-found path.
	// 401 would mean it reached auth but was rejected (SYNC_TOKEN mismatch).
	// 404 would mean parseSyncPath was skipped and it hit the resource whitelist.
	s.check(
		resp.status !== 404,
		"/vault/sync/:vaultId is NOT classified as not-found (parseSyncPath runs first)",
	);
	s.check(
		resp.status === 426 || resp.status === 401 || resp.status === 503,
		`/vault/sync/:vaultId reaches the sync handler (status ${resp.status}, not 404)`,
	);
}
await s.done();
