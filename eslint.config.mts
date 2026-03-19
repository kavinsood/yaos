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
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			"no-undef": "off",
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
	globalIgnores([
		"node_modules",
		"dist",
		"server/dist",
		"server/.wrangler",
		"server/.partykit",
		"tests",
		"manifest.json",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
