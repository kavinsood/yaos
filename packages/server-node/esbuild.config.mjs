import { builtinModules } from "node:module";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outdir = path.join(packageRoot, "dist");

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
	minify: false,
	sourcemap: false,
	treeShaking: true,
	logLevel: "info",
});

process.stdout.write(`[server-node:build] ${path.relative(repoRoot, path.join(outdir, "server.mjs"))}\n`);
