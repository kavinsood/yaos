import * as bindings from "./vendor/ywasm/ywasm.mjs";
import { createYwasmCrdtEngine } from "./ywasmCrdtEngine";

/** Maximum encoded into the Wasm memory type by the pinned linker invocation. */
export const YWASM_MAXIMUM_LINEAR_MEMORY_BYTES = 100_663_296;
export const YWASM_ARTIFACT_SHA256 = "e66c0a21ddf9852b383c9b76e6f6ef29123d0760ffe7fb6a4358524a4f3cbf3b";

/** The production server engine, backed by the checked-in Worker Wasm module. */
export const ywasmCrdtEngine = createYwasmCrdtEngine(bindings, {
	maximumLinearMemoryBytes: YWASM_MAXIMUM_LINEAR_MEMORY_BYTES,
	artifactSha256: YWASM_ARTIFACT_SHA256,
	memoryByteLength: bindings.wasmMemoryByteLength,
});
