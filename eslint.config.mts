import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";
// The sentence-case rule's `brands` / `acronyms` options replace its defaults rather than extend them, so extending
// them means starting from the defaults. The package has no `exports` map and is pinned (0.4.1), so these deep
// imports are stable until a deliberate upgrade.
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";

/**
 * Product vocabulary for obsidianmd/ui/sentence-case. "YAOS" is the product name, always written in capitals
 * (brand matching is case-insensitive, so a lowercase "yaos" in UI text is corrected to "YAOS"). "iCloud" is Apple's
 * spelling (the defaults only carry "iCloud Drive"). "QR" (QR code) and "E2EE" are acronyms the UI uses.
 */
const YAOS_BRANDS = [...DEFAULT_BRANDS, "YAOS", "iCloud"];
const YAOS_ACRONYMS = [...DEFAULT_ACRONYMS, "QR", "E2EE"];

/**
 * Files that run in Node only: unit tests, test support (testkit/ dirs, testkit.ts files, the runtime test harness;
 * the same set scripts/check-deps.mjs treats as tests) and the deterministic simulator (src/sim/**, which only tests
 * may import). None of them is in the plugin bundle.
 */
const NODE_ONLY_FILES = [
	"src/**/*.test.ts",
	"src/**/testkit/**/*.ts",
	"src/**/testkit.ts",
	"src/engine/runtime/testHarness.ts",
	"src/sim/**/*.ts",
];

/**
 * Files that run in a dedicated Worker, or are shared between the worker and the main thread. main.js is also the
 * worker script (src/host/entry.ts): src/engine/** only ever runs there, src/core, src/ports and src/protocol are
 * shared by both sides. The spike plugin's worker (spikeWorker.ts) pulls in spikeWorkerHandler, cryptoProbe, idbProbe
 * and report.
 */
const WORKER_FILES = [
	"src/engine/**/*.ts",
	"src/core/**/*.ts",
	"src/ports/**/*.ts",
	"src/protocol/**/*.ts",
	"src/host/spike/spikeWorker.ts",
	"src/host/spike/spikeWorkerHandler.ts",
	"src/host/spike/cryptoProbe.ts",
	"src/host/spike/idbProbe.ts",
	"src/host/spike/report.ts",
];

/** obsidianmd's no-restricted-globals list (eslint-plugin-obsidianmd ruleOptions.js) without `fetch`. */
const RESTRICTED_GLOBALS_WITHOUT_FETCH = [
	{ name: "app", message: "Avoid using the global app object. Instead use the reference provided by your plugin instance." },
	{ name: "localStorage", message: "Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that's unique to a vault." },
];

export default tseslint.config(
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				project: "./tsconfig.eslint.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ["**/*.mjs"],
		languageOptions: {
			globals: {
				...globals.node,
				fetch: "readonly",
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"no-undef": "off",
		},
	},
	{
		// node:test's describe/it/test/suite return promises the runner owns: awaiting them at top level is not needed.
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-floating-promises": ["error", {
				allowForKnownSafeCalls: [
					{ from: "package", package: "node:test", name: ["test", "it", "only", "skip", "todo"] },
					// describe/suite sit in a namespace inside `declare module "node:test"`, which the package matcher does not
					// walk through; match them by their declaration file instead.
					{ from: "file", path: "node_modules/@types/node/test.d.ts", name: ["describe", "suite"] },
				],
			}],
		},
	},
	{
		// obsidianmd's own options plus `_` as the "deliberately unused" name: a for-of that only counts or drains an
		// iterator (`for (const _ of src.matchAll(re))`) has to bind something, and there is no way to omit the binding.
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": ["warn", { args: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_$" }],
		},
	},
	{
		// Rejecting with an `unknown` is propagating a value that was caught or handed over (a body's rejection, an
		// AbortSignal's reason), not minting a non-Error: forcing a wrap there would change what callers catch.
		// Rejections with a known non-Error type stay errors.
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/prefer-promise-reject-errors": ["error", { allowThrowingUnknown: true }],
		},
	},
	{
		// Test files print their own reports (bench timings, fuzz seed counts) to the runner. Obsidian's console rule is
		// about a shipped plugin's logging; keep its no-new-func half, drop no-console here.
		files: ["src/**/*.test.ts"],
		rules: {
			"obsidianmd/rule-custom-message": ["error", {
				"no-new-func": {
					messages: {
						"The Function constructor is eval": "Using the `Function` constructor is dangerous because it executes arbitrary code, similar to `eval()`",
					},
				},
			}],
		},
	},
	{
		files: ["src/**/*.ts"],
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", { enforceCamelCaseLower: true, brands: YAOS_BRANDS, acronyms: YAOS_ACRONYMS }],
		},
	},
	{
		// The day-1 spike plugin's commands and notices name the probes and the web APIs they exercise (OR-1, OR-2,
		// IndexedDB, WebCrypto, setViewData). Spike-only, so they stay out of the product vocabulary above.
		files: ["src/host/spike/**/*.ts"],
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", {
				enforceCamelCaseLower: true,
				brands: [...YAOS_BRANDS, "OR-1", "OR-2", "IndexedDB", "WebCrypto", "setViewData", "Blob-URL"],
				acronyms: YAOS_ACRONYMS,
			}],
		},
	},
	{
		// The spike records the device it ran on: the raw userAgent string next to the Platform flags it already
		// records, because Platform has no OS or WebKit version, and those are what its worker / IndexedDB /
		// WebCrypto results depend on. It is kept as report data, never used to pick a code path (what this rule
		// guards against). The main-thread copy is the only one when OR-1's worker fails to start. Spike only
		// (scripts/build-spike.mjs, its own bundle); obsidianmd/* rules may not be disabled inline.
		files: ["src/host/spike/main.ts"],
		rules: {
			"obsidianmd/platform": "off",
		},
	},
	{
		// The spike's copy fallback: when navigator.clipboard refuses (iOS), select the report textarea and
		// execCommand("copy"), which is deprecated but still the only synchronous copy WebKit offers. Spike only;
		// @typescript-eslint/no-deprecated may not be disabled inline.
		files: ["src/host/spike/resultsModal.ts"],
		rules: {
			"@typescript-eslint/no-deprecated": "off",
		},
	},
	{
		// Node-only code. no-nodejs-modules guards the mobile plugin bundle these files are never part of;
		// node:test / node:assert are how they run. There is no `window` in Node, so prefer-window-timers and
		// no-global-this would point them at an undefined global. hardcoded-config-path: tests and the sim's fake
		// vaults use ".obsidian" as fixture data (and to test configDir handling), not to find the user's config
		// folder. fetch: tests stub and exercise the worker's fetch-based adapters; requestUrl is not reachable
		// there.
		files: NODE_ONLY_FILES,
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/prefer-window-timers": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"no-restricted-globals": ["warn", ...RESTRICTED_GLOBALS_WITHOUT_FETCH],
		},
	},
	{
		// Worker and worker-shared code. A dedicated Worker has no `window` (window.setTimeout would throw there)
		// and no `activeWindow`; its global object is `globalThis` / `self`. Obsidian's requestUrl is a main-thread
		// API (the worker cannot import "obsidian"), so the worker's relay and blob adapters use fetch.
		files: WORKER_FILES,
		rules: {
			"obsidianmd/prefer-window-timers": "off",
			"obsidianmd/no-global-this": "off",
			"no-restricted-globals": ["warn", ...RESTRICTED_GLOBALS_WITHOUT_FETCH],
		},
	},
	{
		// browserClock is the main thread's ClockPort and the default clock of the pairing and vault-creation flows
		// (pairing.ts, pairFlow.ts, createVault.ts), whose unit tests run those flows under Node, where there is no
		// `window`. In Obsidian the global timers are the main window's own, so `window.` would change nothing there.
		files: ["src/host/platform.ts"],
		rules: {
			"obsidianmd/prefer-window-timers": "off",
		},
	},
	{
		files: ["package.json"],
		rules: {
			"depend/ban-dependencies": "off",
		},
	},
	{
		files: ["server/src/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.serviceworker,
			},
			parserOptions: {
				project: "./server/tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Server code runs in Cloudflare Workers, not Obsidian renderer windows.
			"obsidianmd/prefer-window-timers": "off",
			"obsidianmd/no-global-this": "off",
			// Obsidian's "avoid unnecessary logging" guideline is about a plugin writing to the user's devtools
			// console. A Worker's console is its operator log (wrangler tail, Workers Logs). Keep the no-new-func half.
			"obsidianmd/rule-custom-message": ["error", {
				"no-new-func": {
					messages: {
						"The Function constructor is eval": "Using the `Function` constructor is dangerous because it executes arbitrary code, similar to `eval()`",
					},
				},
			}],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"server/dist",
		"server/.wrangler",
		// Generated deploy configs (e2e relays), gitignored; not in a typed-lint project.
		"server/.cf-deploy",
		"tests",
		// Node-run end-to-end harnesses, like tests/: typechecked by typecheck:client (e2e/client) and typecheck:tests
		// (e2e/conformance), but in no typed-lint project, so typed rules would abort the whole run on them.
		"e2e",
		// The Obsidian preset targets plugin runtime code. Build tooling and
		// Worker maintenance scripts execute in Node and must not inherit
		// browser/mobile plugin rules.
		"build-server-release.mjs",
		"scripts",
		"server/scripts",
		"manifest.json",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"version-bump.mjs",
		"versions.json",
		// esbuild outfiles. These are gitignored build artifacts, but eslint's
		// flat config does not read .gitignore, so each one has to be listed or
		// it aborts the whole run: a bundle has no entry in
		// tsconfig.eslint.json, and typed rules throw on rule load rather than
		// skipping the file. Keep this in sync with
		// the outfiles in esbuild.config.mjs.
		"main.js",
	]),
);
