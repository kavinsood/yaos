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
	globalIgnores([
		"node_modules",
		"dist",
		"server/dist",
		"server/.wrangler",
		"server/.partykit",
		"tests",
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
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
