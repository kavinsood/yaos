/**
 * Relay v2 spike probe: the server's own ywasm `prepareSemanticReset` on a K2
 * fixture, alone in a fresh process, with wasm memory reported. Usage:
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/reset/probe-5m.ts sized-5m
 */
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { prepareSemanticReset } from "../../../server/src/semanticCompaction";
import { loadFixture } from "./fixtures";

const name = process.argv[2] ?? "sized-5m";
const { state, meta } = loadFixture(name);
const doc = crdtEngine.openDocument(`probe-${name}`, state);
const mem = () => (crdtEngine as unknown as { memoryDiagnostics?: () => { linearMemoryBytes?: number } | null }).memoryDiagnostics?.()?.linearMemoryBytes ?? null;
const memAfterOpen = mem();
const started = performance.now();
try {
	const out = prepareSemanticReset(doc, "body");
	console.log(JSON.stringify({ name, encodedBefore: state.byteLength, live: meta.liveUtf8Bytes, memAfterOpen, memAfter: mem(), ok: true, freshBytes: out.fresh.encodedStateBytes, ms: performance.now() - started }));
} catch (error) {
	console.log(JSON.stringify({ name, encodedBefore: state.byteLength, live: meta.liveUtf8Bytes, memAfterOpen, memAfter: mem(), ok: false, error: String(error).slice(0, 120), ms: performance.now() - started }));
}
