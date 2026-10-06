/**
 * The worker carrier's script is the running bundle itself (integration-notes D2).
 *
 * esbuild.config.mjs wraps all of main.js in one named function:
 *
 *   (function __yaosBundle(require, module, exports, __yaosWorkerScope) { ...bundle... })(require, module, exports);
 *
 * `Function.prototype.toString` returns a function's exact source text
 * (ECMA-262 §20.2.3.5), so the worker script is that text called with the
 * worker's scope as 4th argument; host/entry.ts then starts the engine and
 * never touches the host modules. No eval, no second copy of the engine, no
 * file read: the worker runs exactly the code that is running on main.
 */

/** Bound by the bundle wrapper (a named function expression sees its own name). Undeclared outside the bundle (tests). */
declare const __yaosBundle: unknown;

export const BUNDLE_FUNCTION_NAME = "__yaosBundle";

/** What a worker that reaches a host module gets as `require`: the host never runs there, so fail loudly. */
const WORKER_REQUIRE = 'function (id) { throw new Error("yaos worker: module " + JSON.stringify(id) + " is main-thread only"); }';

/** Builds the worker script from a bundle wrapper's source text; null if the text is not that wrapper. */
export function workerScriptFrom(bundleSource: string): string | null {
	if (!bundleSource.startsWith(`function ${BUNDLE_FUNCTION_NAME}(`) || !bundleSource.endsWith("}")) return null;
	return `(${bundleSource})(${WORKER_REQUIRE}, { exports: {} }, {}, self);\n//# sourceURL=yaos-engine-worker.js\n`;
}

let cached: string | null | undefined;

/** The worker script for the running bundle, or null outside the built bundle (tests, sims) or if the host hides source text. */
export function workerScript(): string | null {
	if (cached !== undefined) return cached;
	cached = typeof __yaosBundle === "function" ? workerScriptFrom(Function.prototype.toString.call(__yaosBundle)) : null;
	return cached;
}
