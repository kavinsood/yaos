import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(packageRoot, "../..");
const work = mkdtempSync(path.join(tmpdir(), "yaos-cli-pack-"));

function run(program: string, args: string[], cwd: string): string {
	const result = spawnSync(program, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${program} ${args.join(" ")} failed (${String(result.status)})\n${result.stdout}${result.stderr}`);
	}
	return result.stdout ?? "";
}

try {
	run(process.execPath, [path.join(packageRoot, "esbuild.config.mjs")], repositoryRoot);
	const packDirectory = path.join(work, "pack");
	mkdirSync(packDirectory);
	run("npm", ["pack", "--silent", "--pack-destination", packDirectory], packageRoot);
	const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
	if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${String(tarballs.length)}`);

	const consumer = path.join(work, "consumer");
	mkdirSync(consumer);
	writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
		name: "yaos-cli-smoke-consumer",
		private: true,
		version: "1.0.0",
	}));
	run("npm", ["install", "--silent", "--ignore-scripts", path.join(packDirectory, tarballs[0]!)], consumer);
	const binary = path.join(consumer, "node_modules", ".bin", "yaos");
	const help = spawnSync(binary, ["--help"], {
		cwd: consumer,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "", HOME: work, XDG_STATE_HOME: path.join(work, "state") },
	});
	if (help.status !== 1 || !`${help.stdout}${help.stderr}`.includes("Exit codes:")) {
		throw new Error(`installed bin help contract failed\n${help.stdout}${help.stderr}`);
	}
	process.stdout.write("[cli:pack-smoke] PASS — tarball installs and linked bin starts under plain Node\n");
} finally {
	rmSync(work, { recursive: true, force: true });
}
