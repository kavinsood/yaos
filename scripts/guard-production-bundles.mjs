#!/usr/bin/env node

/**
 * guard-production-bundles.mjs
 *
 * Verifies that the production bundles (main.js, telemetry.js) do not
 * contain symbols that violate the Observer/Engine/Puppeteer split.
 *
 * Run after build:
 *   node scripts/guard-production-bundles.mjs          # strict (default)
 *   node scripts/guard-production-bundles.mjs --transitional  # warn on transitional seams
 *
 * == Modes ==
 *
 *   strict (default, used in CI):
 *     Fails if any forbidden symbol is found in any bundle, including the
 *     known-transitional seams listed in MAIN_FORBIDDEN_DEFERRED.
 *
 *   transitional (--transitional flag):
 *     Fails on hard-forbidden symbols. Warns on transitional seams.
 *     Use locally when working on changes that should not require fixing
 *     transitional seams first.
 *
 * == Architecture ==
 *
 *   main.js            = Engine only. Production artifact shipped to users.
 *                        Must NOT contain telemetry implementations, Puppeteer
 *                        code, or Engine control capabilities.
 *
 *   telemetry.js       = passive Observer only.
 *                        May contain FlightRecorder, DeviceWitnessTracker, etc.
 *                        Must NOT contain mutation harness code (Puppeteer).
 *
 *   qa/obsidian-harness/product-main.js
 *                      = QA-enabled product build. NOT a release artifact.
 *                        Built with __YAOS_QA_HARNESS_ENABLED__=true.
 *                        May contain Engine control capabilities.
 *
 *   qa/                = Puppeteer harness only. Not shipped.
 *                        May contain dangerous names.
 *
 * == P2 complete: __qaOnly / Unsafe / ForceSync seams removed ==
 *
 * All six __qaOnly*Unsafe methods were removed from src/ in P2 and replaced
 * with injected ports (DiskIngestPort, BindingPropagationGate).
 * MAIN_FORBIDDEN_DEFERRED retains these strings as a permanent regression guard
 * so they can never be re-introduced.
 *
 * == P3 complete: Engine control capabilities removed from production bundle ==
 *
 * getEngineControlPort and the four Engine control capability methods are now
 * gated behind __YAOS_QA_HARNESS_ENABLED__ (esbuild define, false in production).
 * Dead-code elimination removes them entirely from main.js.
 * MAIN_FORBIDDEN bans them permanently so they cannot re-enter the product bundle.
 *
 * Do NOT add new entries to MAIN_FORBIDDEN_DEFERRED without explicit sign-off.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TRANSITIONAL = process.argv.includes("--transitional");

// ---------------------------------------------------------------------------
// main.js — must not contain telemetry implementations or Puppeteer code
// ---------------------------------------------------------------------------

const MAIN_FORBIDDEN = [
	// Telemetry implementations (must stay out of product bundle)
	"DeviceWitnessTracker",
	"FlightRecorder",
	"FlightTraceController",
	"FlightTraceSink",
	"PersistentTraceLogger",
	// Puppeteer command names
	"qaExportWitnessBundle",
	"startQaFlightTrace",
	"stopQaFlightTrace",
	"exportSafeFlightTrace",
	"exportFullFlightTrace",
	// Puppeteer scenario controls
	"setScenarioRunId",
	"advanceScenarioStep",
	"witnessDeviceSettled",
	// VFS torture
	"VfsTorture",
	"vfsTorture",
	// Force operations
	"ForceCrdt",
	"forceCrdt",
	// Engine control capabilities — must never ship in production bundle.
	// Production builds use __YAOS_QA_HARNESS_ENABLED__=false (esbuild define),
	// which dead-code-eliminates these. QA builds use product-main.js instead.
	//
	// NOTE: `ingestDiskFileNow` is intentionally NOT listed here — it is a method
	// name on DiskIngestPort, an internal interface legitimately present inside
	// ReconciliationController.  The dangerous public accessor was `getEngineControlPort`,
	// which IS banned below.  Without getEngineControlPort, the internal
	// DiskIngestPort is unreachable from outside.
	"getEngineControlPort",
	"pauseEditorPropagation",
	"resumeEditorPropagation",
	"setExternalEditPolicyOverride",
];

// P2 regression guard — these seams were removed in P2 and must never return.
// In strict mode these FAIL. In transitional mode these WARN.
const MAIN_FORBIDDEN_DEFERRED = [
	"ForceSync",   // was: __qaOnlyForceSyncFileFromDiskUnsafe
	"Unsafe",      // was: all __qaOnly*Unsafe methods
	"__qaOnly",    // was: all __qaOnly methods
];

// ---------------------------------------------------------------------------
// telemetry.js — must not contain Puppeteer/mutation harness code
// (no deferred exceptions — telemetry.js must be fully clean)
// ---------------------------------------------------------------------------

const TELEMETRY_FORBIDDEN = [
	"VfsTorture", "vfsTorture",
	"ForceCrdt", "forceCrdt",
	"ForceSync", "forceSync",
	"setScenarioRunId",
	"advanceScenarioStep",
	"networkHold", "setQaNetworkHold",
	"PauseEditorBinding", "pauseEditorBinding",
	"Unsafe", "unsafe-local", "__qaOnly",
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function checkBundle(bundlePath, forbidden, deferred, bundleName) {
	if (!existsSync(bundlePath)) {
		console.error(`FAIL [${bundleName}]: bundle not found at ${bundlePath}`);
		console.error("  Run 'npm run build' first.");
		return 1;
	}
	const content = readFileSync(bundlePath, "utf8");
	const violations = forbidden.filter((s) => content.includes(s));
	const deferredHits = deferred.filter((s) => content.includes(s));

	if (violations.length > 0) {
		console.error(`FAIL [${bundleName}]: forbidden symbols found:`);
		violations.forEach((v) => console.error(`  - ${v}`));
	}

	if (deferredHits.length > 0) {
		if (TRANSITIONAL) {
			console.warn(`WARN [${bundleName}]: transitional symbols present (P2 regression guard):`);
			deferredHits.forEach((v) => console.warn(`  - ${v}`));
		} else {
			console.error(`FAIL [${bundleName}]: P2 regression guard — symbols must not re-enter bundle:`);
			deferredHits.forEach((v) => console.error(`  - ${v}  (P2 regression guard — see guard script header)`));
		}
	}

	const totalFail = violations.length + (TRANSITIONAL ? 0 : deferredHits.length);
	if (totalFail > 0) return totalFail;

	const sizeKb = (content.length / 1024).toFixed(1);
	const note = deferredHits.length > 0 ? ` [${deferredHits.length} transitional symbol(s) present]` : "";
	console.log(`PASS [${bundleName}] (${sizeKb} KB)${note}`);
	return 0;
}

// ---------------------------------------------------------------------------
// src/ → qa/ isolation
// ---------------------------------------------------------------------------

const SRC_QA_IMPORT_PATTERNS = [
	/from\s+["'][^"']*\/qa\//,
	/from\s+["']\.\.\/qa\//,
	/from\s+["']\.\.\/\.\.\/qa\//,
];

function scanSrcForQaImports(dir) {
	let count = 0;
	let entries;
	try { entries = readdirSync(dir); } catch { return 0; }
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		let st;
		try { st = statSync(fullPath); } catch { continue; }
		if (st.isDirectory()) {
			count += scanSrcForQaImports(fullPath);
		} else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
			const rel = relative(".", fullPath);
			let src;
			try { src = readFileSync(fullPath, "utf8"); } catch { continue; }
			for (const pat of SRC_QA_IMPORT_PATTERNS) {
				const m = src.match(pat);
				if (m) {
					console.error(`FAIL [src->qa import]: ${rel}: ${m[0]}`);
					count++;
				}
			}
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let failures = 0;

if (TRANSITIONAL) {
	console.log("Mode: transitional (P2 regression seams warn, not fail)\n");
}

failures += checkBundle("main.js", MAIN_FORBIDDEN, MAIN_FORBIDDEN_DEFERRED, "main.js");
failures += checkBundle("telemetry.js", TELEMETRY_FORBIDDEN, [], "telemetry.js");

const srcQaViolations = scanSrcForQaImports("src");
if (srcQaViolations > 0) {
	console.error(`FAIL: ${srcQaViolations} src/ → qa/ import violation(s). src/ must not import from qa/.`);
	failures += srcQaViolations;
} else {
	console.log("PASS [src->qa isolation]: src/ does not import from qa/.");
}

if (failures > 0) {
	console.error(`\nFAIL: ${failures} production bundle violation(s).`);
	process.exit(1);
} else if (TRANSITIONAL) {
	console.log("\nPARTIAL PASS (transitional): Observer bundle clean; P2 regression symbols flagged as warnings.\nRun without --transitional to see full failure list.");
	process.exit(0);
} else {
	console.log("\nPASS: all production bundle guards passed.");
	process.exit(0);
}
