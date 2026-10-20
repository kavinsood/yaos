import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

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
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"server/dist",
		"server/.wrangler",
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
