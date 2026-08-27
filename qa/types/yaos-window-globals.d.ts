/**
 * Ambient declarations for the two QA globals the harness mounts on `window`.
 *
 * Neither is part of the product's public surface: the harness plugin creates
 * both in onload() and deletes both in onunload(), and the raw CDP controllers
 * in qa/controllers/ are the only other readers. Declaring them
 * here is what lets every one of those readers be an ordinary property access
 * instead of a cast, and it makes a signature drift between the harness API and
 * a controller's use of it a compile error under tsconfig.qa.json.
 *
 * Optional on purpose — they are absent until the harness plugin loads, and
 * `delete` requires it. Follows the qa/types/bun.d.ts convention: a script (not
 * module) declaration file, so the global augmentation needs no `declare global`
 * wrapper, with types pulled in by inline `import(...)` rather than top-level
 * imports (which would make this a module and take the augmentation with it).
 *
 * Note for src/: this file is included by tsconfig.qa.json only. Product code
 * must not depend on these declarations — the root tsconfig.json does not see
 * them, and src/ may not import from qa/ (scripts/guard-qa-isolation.mjs).
 */

interface Window {
	/**
	 * The product QA debug API. Assembled by the harness from the product
	 * plugin's internals — the product never mounts it itself.
	 */
	__YAOS_DEBUG__?: import("../harness/qaDebugApi").YaosQaDebugApi;
	/** The harness's own console/scenario API. */
	__YAOS_QA__?: import("../obsidian-harness/types").QaConsoleApi;
}
