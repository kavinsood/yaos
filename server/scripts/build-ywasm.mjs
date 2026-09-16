import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(serverDir, "vendor/ywasm");
const outputDir = join(serverDir, "src/crdt/vendor/ywasm");
const nodeOutputDir = resolve(serverDir, "../packages/server-node/vendor/ywasm");
const metadata = JSON.parse(readFileSync(join(vendorDir, "SOURCE.json"), "utf8"));
const refreshArtifact = process.argv.includes("--refresh-artifact");
const sourceOverrideIndex = process.argv.indexOf("--source");
const sourceOverride = sourceOverrideIndex >= 0 ? resolve(process.argv[sourceOverrideIndex + 1]) : null;
const temporary = mkdtempSync(join(tmpdir(), "yaos-ywasm-build-"));

function output(command, args, options = {}) {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireVersion(actual, expected, name) {
	if (!actual.includes(expected)) throw new Error(`${name} version mismatch: expected ${expected}, received ${actual}`);
}

function transformWorkerWrapper(source) {
	const marker = "let wasmModule, wasmInstance, wasm;";
	const markerIndex = source.indexOf(marker);
	if (markerIndex < 0) throw new Error("wasm-bindgen web wrapper shape changed");
	return `import wasmModule from "./ywasm_bg.wasm";\n\n${source.slice(0, markerIndex)}`
		+ "let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());\n"
		+ "let wasm = wasmInstance.exports;\nwasm.__wbindgen_start();\n\n"
		+ "/** Current high-water size of the shared Wasm linear memory. */\n"
		+ "export function wasmMemoryByteLength() {\n    return wasm.memory.buffer.byteLength;\n}\n";
}

try {
	requireVersion(output("rustc", ["--version"]), metadata.rustToolchain, "rustc");
	requireVersion(output("wasm-pack", ["--version"]), metadata.wasmPack, "wasm-pack");
	const sourceDir = sourceOverride ?? join(temporary, "source");
	if (!sourceOverride) {
		output("git", ["clone", "--filter=blob:none", "--no-checkout", metadata.repository, sourceDir]);
		output("git", ["checkout", "--detach", metadata.commit], { cwd: sourceDir });
	}
	if (output("git", ["rev-parse", "HEAD"], { cwd: sourceDir }) !== metadata.commit) throw new Error("source commit mismatch");
	if (sha256(join(sourceDir, "Cargo.lock")) !== metadata.cargoLockSha256) throw new Error("Cargo.lock checksum mismatch");
	if (sha256(join(sourceDir, "LICENSE")) !== metadata.licenseSha256
		|| sha256(join(vendorDir, "LICENSE")) !== metadata.licenseSha256
		|| statSync(join(vendorDir, "LICENSE")).size !== metadata.licenseBytes) {
		throw new Error("upstream license checksum mismatch");
	}
	const patches = [
		join(vendorDir, "patches/0001-document-stats.patch"),
		join(vendorDir, "patches/0002-apply-update-change-detection.patch"),
	];
	for (const patch of patches) {
		// The change-detection patch is generated with zero diff context so the
		// vendored patch itself contains no whitespace-only context lines.
		// Cargo.lock and the exact source commit are verified before this point.
		output("git", ["apply", "--unidiff-zero", "--check", patch], { cwd: sourceDir });
		output("git", ["apply", "--unidiff-zero", patch], { cwd: sourceDir });
	}
	output("cargo", ["test", "-p", "yrs", "--lib", "document_stats_counts_deleted_integrated_structs", "--locked"], { cwd: sourceDir });
	output("cargo", ["test", "-p", "yrs", "--lib", "update_change_detection_covers_duplicate_and_delete_only_updates", "--locked"], { cwd: sourceDir });

	const rustflags = `-C link-arg=--max-memory=${metadata.maximumLinearMemoryBytes} -C link-arg=--export-memory`;
	const build = (target, outDir) => output("wasm-pack", [
		"build", "./ywasm", "--release", "--target", target, "--out-dir", outDir,
		"--locked", "--no-default-features",
	], { cwd: sourceDir, env: { ...process.env, RUSTFLAGS: rustflags } });
	build("web", "pkg-yaos-a");
	build("web", "pkg-yaos-b");
	const webA = join(sourceDir, "ywasm/pkg-yaos-a");
	const webB = join(sourceDir, "ywasm/pkg-yaos-b");
	if (sha256(join(webA, "ywasm_bg.wasm")) !== sha256(join(webB, "ywasm_bg.wasm"))) {
		throw new Error("two clean ywasm builds produced different Wasm checksums");
	}
	const wrapperA = transformWorkerWrapper(readFileSync(join(webA, "ywasm.js"), "utf8"));
	const wrapperB = transformWorkerWrapper(readFileSync(join(webB, "ywasm.js"), "utf8"));
	if (wrapperA !== wrapperB) throw new Error("two clean ywasm builds produced different wrappers");
	const generatedWrapper = join(temporary, "ywasm.mjs");
	writeFileSync(generatedWrapper, wrapperA);
	const wasmPath = join(webA, "ywasm_bg.wasm");
	const expected = metadata.artifact;
	if (!refreshArtifact && (sha256(wasmPath) !== expected.wasmSha256 || statSync(wasmPath).size !== expected.wasmBytes)) {
		throw new Error("Wasm artifact differs from SOURCE.json");
	}
	if (!refreshArtifact && (sha256(generatedWrapper) !== expected.wrapperSha256 || statSync(generatedWrapper).size !== expected.wrapperBytes)) {
		throw new Error("Worker wrapper differs from SOURCE.json");
	}

	build("nodejs", "pkg-yaos-node");
	const nodeEntry = join(sourceDir, "ywasm/pkg-yaos-node/ywasm.js");
	const nodeWasm = join(sourceDir, "ywasm/pkg-yaos-node/ywasm_bg.wasm");
	const nodeTypes = join(sourceDir, "ywasm/pkg-yaos-node/ywasm.d.ts");
	appendFileSync(nodeEntry, "\nexports.wasmMemoryByteLength = () => wasm.memory.buffer.byteLength;\n");
	if (!refreshArtifact && (sha256(nodeEntry) !== expected.nodeWrapperSha256 || statSync(nodeEntry).size !== expected.nodeWrapperBytes
		|| sha256(nodeTypes) !== expected.nodeTypesSha256 || statSync(nodeTypes).size !== expected.nodeTypesBytes
		|| sha256(nodeWasm) !== expected.wasmSha256)) throw new Error("Node artifact differs from SOURCE.json");
	const nodeVerificationDir = join(temporary, "node-verification");
	mkdirSync(nodeVerificationDir);
	cpSync(nodeEntry, join(nodeVerificationDir, "ywasm.js"));
	cpSync(nodeWasm, join(nodeVerificationDir, "ywasm_bg.wasm"));
	const nodeVerificationEntry = join(nodeVerificationDir, "ywasm.js");
	appendFileSync(nodeVerificationEntry, "exports.wasmMemoryGrow = (pages) => wasm.memory.grow(pages);\n");
	const nodeVerification = output(process.execPath, [join(vendorDir, "verify-node-artifact.cjs"), nodeVerificationEntry]);
	console.log(nodeVerification);
	mkdirSync(outputDir, { recursive: true });
	cpSync(wasmPath, join(outputDir, "ywasm_bg.wasm"));
	cpSync(generatedWrapper, join(outputDir, "ywasm.mjs"));
	mkdirSync(nodeOutputDir, { recursive: true });
	cpSync(nodeEntry, join(nodeOutputDir, "ywasm.js"));
	cpSync(nodeWasm, join(nodeOutputDir, "ywasm_bg.wasm"));
	cpSync(nodeTypes, join(nodeOutputDir, "ywasm.d.ts"));
	cpSync(join(vendorDir, "LICENSE"), join(nodeOutputDir, "LICENSE"));
	if (refreshArtifact) {
		metadata.artifact = {
			wasmSha256: sha256(wasmPath),
			wasmBytes: statSync(wasmPath).size,
			wrapperSha256: sha256(generatedWrapper),
			wrapperBytes: statSync(generatedWrapper).size,
			nodeWrapperSha256: sha256(nodeEntry),
			nodeWrapperBytes: statSync(nodeEntry).size,
			nodeTypesSha256: sha256(nodeTypes),
			nodeTypesBytes: statSync(nodeTypes).size,
		};
		writeFileSync(join(vendorDir, "SOURCE.json"), `${JSON.stringify(metadata, null, "\t")}\n`);
	}
	console.log(JSON.stringify({ wasm: sha256(wasmPath), wrapper: sha256(generatedWrapper) }));
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
