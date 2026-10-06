// Node stand-in for the Worker's compiled `./ywasm_bg.wasm` module import. The test runner
// (tests/run-typescript.mjs --test-aliases) aliases that import here so the real Worker CRDT
// engine (server/src/crdt/ywasmWorkerCrdtEngine.ts) runs unchanged under Node.
import { readFileSync } from "node:fs";

const bytes = readFileSync(new URL("../../../server/src/crdt/vendor/ywasm/ywasm_bg.wasm", import.meta.url));

export default new WebAssembly.Module(bytes);
