#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const [wasmInput, jsInput, metadataInput] = process.argv.slice(2);
if (!wasmInput) {
	throw new Error("usage: inspect-artifact.mjs <artifact.wasm> [wrapper.js]");
}

const wasmPath = resolve(wasmInput);
const bytes = new Uint8Array(readFileSync(wasmPath));
const metadataPath = resolve(metadataInput ?? process.env.YAOS_YWASM_SOURCE_METADATA
	?? "server/vendor/ywasm/SOURCE.json");
const maximumWasmBytes = Number(process.env.YAOS_YWASM_MAX_ARTIFACT_BYTES ?? 1_100_000);
const maximumJsBytes = Number(process.env.YAOS_YWASM_MAX_WRAPPER_BYTES ?? 200_000);

assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], "valid WebAssembly header");
assert.ok(bytes.byteLength <= maximumWasmBytes,
	`Wasm artifact ${bytes.byteLength} bytes exceeds ${maximumWasmBytes}-byte gate`);

let offset = 8;
function u32() {
	let result = 0;
	let shift = 0;
	for (;;) {
		if (offset >= bytes.byteLength || shift > 28) throw new Error("invalid unsigned LEB128");
		const value = bytes[offset++];
		result |= (value & 0x7f) << shift;
		if ((value & 0x80) === 0) return result >>> 0;
		shift += 7;
	}
}
function name() {
	const length = u32();
	const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length));
	offset += length;
	return value;
}
function limits() {
	const flags = u32();
	const minimum = u32();
	const maximum = (flags & 1) !== 0 ? u32() : null;
	return { minimum, maximum, shared: (flags & 2) !== 0, memory64: (flags & 4) !== 0 };
}
function skipTableType() {
	offset++;
	limits();
}

const imports = [];
const exports = [];
const memories = [];
while (offset < bytes.byteLength) {
	const sectionId = bytes[offset++];
	const sectionSize = u32();
	const sectionEnd = offset + sectionSize;
	if (sectionEnd > bytes.byteLength) throw new Error("truncated WebAssembly section");
	if (sectionId === 2) {
		const count = u32();
		for (let index = 0; index < count; index++) {
			const module = name();
			const field = name();
			const kind = bytes[offset++];
			if (kind === 0) u32();
			else if (kind === 1) skipTableType();
			else if (kind === 2) memories.push({ source: "import", module, field, ...limits() });
			else if (kind === 3) offset += 2;
			else if (kind === 4) { u32(); u32(); }
			else throw new Error(`unknown import kind ${kind}`);
			imports.push({ module, field, kind });
		}
	} else if (sectionId === 5) {
		const count = u32();
		for (let index = 0; index < count; index++) memories.push({ source: "defined", ...limits() });
	} else if (sectionId === 7) {
		const count = u32();
		for (let index = 0; index < count; index++) {
			exports.push({ name: name(), kind: bytes[offset++], index: u32() });
		}
	}
	offset = sectionEnd;
}

assert.equal(memories.length, 1, "artifact has exactly one linear memory");
assert.ok(memories[0].maximum !== null, "linear memory has a build-time maximum");
assert.ok(exports.some((entry) => entry.name === "memory" && entry.kind === 2),
	"linear memory is exported for admission telemetry");
assert.ok(imports.every((entry) => /(?:wbg|ywasm_bg)/.test(entry.module)),
	"artifact imports only wasm-bindgen host functions");

let jsBytes = null;
let jsSha256 = null;
if (jsInput) {
	const jsPath = resolve(jsInput);
	jsBytes = statSync(jsPath).size;
	jsSha256 = createHash("sha256").update(readFileSync(jsPath)).digest("hex");
	assert.ok(jsBytes <= maximumJsBytes,
		`JavaScript wrapper ${jsBytes} bytes exceeds ${maximumJsBytes}-byte gate`);
}

const wasmSha256 = createHash("sha256").update(bytes).digest("hex");
if (existsSync(metadataPath)) {
	const source = JSON.parse(readFileSync(metadataPath, "utf8"));
	assert.equal(bytes.byteLength, source.artifact.wasmBytes, "Wasm size matches pinned metadata");
	assert.equal(wasmSha256, source.artifact.wasmSha256, "Wasm checksum matches pinned metadata");
	assert.equal(memories[0].maximum * 65_536, source.maximumLinearMemoryBytes,
		"binary memory maximum matches pinned metadata");
	if (jsInput) {
		assert.equal(jsBytes, source.artifact.wrapperBytes, "wrapper size matches pinned metadata");
		assert.equal(jsSha256, source.artifact.wrapperSha256, "wrapper checksum matches pinned metadata");
	}
}

console.log(JSON.stringify({
	passed: true,
	artifact: basename(wasmPath),
	wasmBytes: bytes.byteLength,
	wasmSha256,
	jsBytes,
	jsSha256,
	memory: memories[0],
	imports: imports.length,
	exports: exports.map((entry) => entry.name).sort(),
}, null, 2));
