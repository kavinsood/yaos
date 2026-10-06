import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		files: ["src/**/*.ts", "yaos-plugin-api.d.ts"],
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
		// The Obsidian preset targets plugin runtime code. Build tooling and
		// Worker maintenance scripts execute in Node and must not inherit
		// browser/mobile plugin rules.
		"build-server-release.mjs",
		"scripts",
		"server/scripts",
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
