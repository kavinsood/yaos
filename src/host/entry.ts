/**
 * Bundle entry (esbuild.config.mjs, integration-notes D2). main.js is one bundle
 * with two roles, so the engine is in it once:
 *  - main thread: Obsidian evaluates main.js as a CommonJS module and takes
 *    `module.exports.default`: the plugin (host/plugin.ts), whose inline
 *    carrier runs the engine from this same code;
 *  - worker: the host starts a Blob-URL worker from the bundle's own source
 *    (host/bundleSource.ts) with `__yaosWorkerScope` set; the entry starts the
 *    engine (engine/workerMain.ts) and never evaluates the host modules, which
 *    need `obsidian` / `@codemirror/*` (main thread only).
 * Both branches are `require()`s, so esbuild initializes each module graph
 * lazily, on its first require.
 */

import type { WorkerScopeLike } from "../protocol/workerTransport";

// Module-scoped (shadows any global typing): esbuild resolves these require()s at build time.
declare const require: (id: string) => unknown;
/** 4th parameter of the bundle wrapper (esbuild.config.mjs): the worker's global scope; undefined on the main thread. */
declare const __yaosWorkerScope: WorkerScopeLike | undefined;

function start(): unknown {
	if (typeof __yaosWorkerScope === "object" && __yaosWorkerScope !== null) {
		const worker = require("../engine/workerMain") as { startWorkerEngine(scope: WorkerScopeLike): unknown };
		worker.startWorkerEngine(__yaosWorkerScope);
		return undefined;
	}
	return (require("./plugin") as { default: unknown }).default;
}

export default start();
