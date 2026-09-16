import { builtinModules, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outdir = path.join(packageRoot, "dist");
const nodeYwasmDir = path.join(packageRoot, "vendor/ywasm");
const sourceMetadata = JSON.parse(await readFile(path.join(repoRoot, "server/vendor/ywasm/SOURCE.json"), "utf8"));

async function requirePinnedArtifact(file, expectedHash, expectedBytes, label) {
	const [bytes, details] = await Promise.all([readFile(file), stat(file)]);
	const actualHash = createHash("sha256").update(bytes).digest("hex");
	if (actualHash !== expectedHash || details.size !== expectedBytes) {
		throw new Error(`${label} does not match server/vendor/ywasm/SOURCE.json; run npm --prefix server run build:ywasm`);
	}
}

const nodeWrapper = path.join(nodeYwasmDir, "ywasm.js");
const nodeWasm = path.join(nodeYwasmDir, "ywasm_bg.wasm");
const nodeLicense = path.join(nodeYwasmDir, "LICENSE");
await requirePinnedArtifact(nodeWrapper, sourceMetadata.artifact.nodeWrapperSha256,
	sourceMetadata.artifact.nodeWrapperBytes, "Node ywasm wrapper");
await requirePinnedArtifact(nodeWasm, sourceMetadata.artifact.wasmSha256,
	sourceMetadata.artifact.wasmBytes, "Node ywasm binary");
await requirePinnedArtifact(nodeLicense, sourceMetadata.licenseSha256,
	sourceMetadata.licenseBytes, "y-crdt license");

await rm(outdir, { recursive: true, force: true });
await esbuild.build({
	absWorkingDir: repoRoot,
	entryPoints: [path.join(packageRoot, "src/index.ts")],
	outfile: path.join(outdir, "server.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	external: ["ws", ...builtinModules],
	plugins: [{
		name: "yaos-node-ywasm",
		setup(build) {
			build.onResolve({ filter: /^@yaos\/crdt-engine$/ }, () => ({
				path: path.join(packageRoot, "src/ywasmNodeCrdtEngine.ts"),
			}));
			build.onResolve({ filter: /[/\\]ywasmWorkerCrdtEngine(?:\.[cm]?[jt]s)?$/ }, () => ({
				path: path.join(packageRoot, "src/ywasmNodeCrdtEngine.ts"),
			}));
		},
	}],
	minify: false,
	sourcemap: false,
	treeShaking: true,
	logLevel: "info",
});

const distYwasmDir = path.join(outdir, "ywasm");
await mkdir(distYwasmDir, { recursive: true });
await Promise.all([
	copyFile(nodeWrapper, path.join(distYwasmDir, "ywasm.cjs")),
	copyFile(nodeWasm, path.join(distYwasmDir, "ywasm_bg.wasm")),
	copyFile(nodeLicense, path.join(distYwasmDir, "LICENSE")),
]);

const builtBindings = createRequire(import.meta.url)(path.join(distYwasmDir, "ywasm.cjs"));
const smokeDocument = new builtBindings.YDoc({ guid: "yaos-node-build-smoke" });
const smokeText = smokeDocument.getText("body");
try {
	smokeText.insert(0, "Node 中文 😀", undefined, undefined);
	const stats = smokeDocument.documentStats();
	if (stats.totalStructs < 1 || builtBindings.encodeStateAsUpdate(smokeDocument).byteLength < 1
		|| builtBindings.wasmMemoryByteLength() < 65_536) {
		throw new Error("patched Node ywasm artifact failed its build smoke test");
	}
} finally {
	smokeText.free();
	smokeDocument.destroy(undefined);
	smokeDocument.free();
}

process.stdout.write(`[server-node:build] ${path.relative(repoRoot, path.join(outdir, "server.mjs"))}\n`);
