import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import source from "../../../server/vendor/ywasm/SOURCE.json";
import { createYwasmCrdtEngine, type YwasmBindings } from "../../../server/src/crdt/ywasmCrdtEngine";

interface NodeYwasmBindings extends YwasmBindings {
	wasmMemoryByteLength(): number;
}

// esbuild leaves this dynamic CommonJS load in the ESM host bundle. The build
// copies the pinned wrapper and Wasm beside server.mjs under dist/ywasm.
const require = createRequire(import.meta.url);
const bundledWrapper = fileURLToPath(new URL("./ywasm/ywasm.cjs", import.meta.url));
const sourceWrapper = fileURLToPath(new URL("../vendor/ywasm/ywasm.js", import.meta.url));
const bindings = require(existsSync(bundledWrapper) ? bundledWrapper : sourceWrapper) as unknown as NodeYwasmBindings;

if (typeof bindings.wasmMemoryByteLength !== "function") {
	throw new Error("pinned Node ywasm artifact is missing linear-memory telemetry");
}

/** Production Node engine using the same patched Wasm bytes as Workers. */
export const ywasmCrdtEngine = createYwasmCrdtEngine(bindings, {
	maximumLinearMemoryBytes: source.maximumLinearMemoryBytes,
	artifactSha256: source.artifact.wasmSha256,
	memoryByteLength: () => bindings.wasmMemoryByteLength(),
});
