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
	},
	{
		files: ["server/tests/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.serviceworker,
			},
			parserOptions: {
				project: "./server/tsconfig.eslint.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// Benches sit beside the worker rather than under tests/ because they
		// import server/src and must resolve yjs from server/node_modules — two
		// copies of Yjs break its constructor checks.  They need the same typed
		// project as the tests, or typed rules throw on rule load.
		files: ["server/bench-*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.serviceworker,
			},
			parserOptions: {
				project: "./server/tsconfig.eslint.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// A bench is a Node program that reports numbers.  The worker rules it
			// would otherwise inherit — no Node builtins, no console — exist because
			// server/src runs in Workers, where neither is available.  Neither
			// constraint applies to something invoked with `node`, and honouring
			// them would mean a bench that can read no fixture and print no result.
			"import/no-nodejs-modules": "off",
			"no-console": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"server/dist",
		"server/.wrangler",
		"server/.partykit",
		"tests",
		// The Obsidian preset targets plugin runtime code. Build tooling,
		// Worker maintenance scripts, benches, and server-only tests execute in
		// Node or workerd and must not inherit browser/mobile plugin rules.
		"build-server-release.mjs",
		"scripts",
		"server/scripts",
		"server/bench-*.ts",
		"server/tests",
		// QA harness, analyzers, and run artifacts.
		// `qa/` contains both .ts sources and emitted .js artifacts (e.g.
		// qa/analyzers/analyzer.js sits next to qa/analyzers/analyzer.ts).
		// The emitted .js files have no parserOptions.project entry in
		// tsconfig.eslint.json, which causes typed lint rules
		// (@typescript-eslint/no-deprecated and friends) to throw on rule
		// load and abort the entire eslint run. The QA harness is a
		// separate workspace: the .ts sources are linted there if needed,
		// and the emitted .js artifacts are not source we lint. Same for
		// qa-runs/ which holds run output bundles and reports.
		"qa",
		"qa-runs",
		"manifest.json",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"version-bump.mjs",
		"versions.json",
		// esbuild outfiles. These are gitignored build artifacts, but eslint's
		// flat config does not read .gitignore, so each one has to be listed or
		// it aborts the whole run: a bundle has no entry in
		// tsconfig.eslint.json, and typed rules throw on rule load rather than
		// skipping the file (see the `qa` note above). Keep this in sync with
		// the outfiles in esbuild.config.mjs.
		"main.js",
	]),
);
