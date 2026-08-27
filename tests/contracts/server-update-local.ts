import { type ExecFileSyncOptions, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = resolve(".");
const artifactPath = resolve(rootDir, "dist/release-assets/yaos-server.zip");
const tempDir = mkdtempSync(join(tmpdir(), "yaos-server-update-test-"));
const repoDir = join(tempDir, "repo");

function run(command: string, args: string[], options: ExecFileSyncOptions = {}) {
	return execFileSync(command, args, {
		cwd: repoDir,
		stdio: "inherit",
		...options,
	});
}

function read(relativePath: string): string {
	return readFileSync(join(repoDir, relativePath), "utf8");
}

try {
	cpSync(resolve(rootDir, "server"), repoDir, { recursive: true });

	run("git", ["init", "-q"]);
	run("git", ["config", "user.name", "YAOS Local Test"]);
	run("git", ["config", "user.email", "local-test@yaos"]);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "baseline"]);

	const baselineVersion = read("src/version.ts");
	const baselineWrangler = read("wrangler.toml");
	const currentServerVersionMatch = baselineVersion.match(/SERVER_VERSION = "([^"]+)"/);
	if (!currentServerVersionMatch) {
		throw new Error("Unable to read current server version from src/version.ts");
	}
	const currentServerVersion = currentServerVersionMatch[1];

	writeFileSync(
		join(repoDir, "src/version.ts"),
		baselineVersion.replace(
			`SERVER_VERSION = "${currentServerVersion}"`,
			'SERVER_VERSION = "0.1.9"',
		),
	);
	writeFileSync(join(repoDir, "wrangler.toml"), `${baselineWrangler}\n# local-test-preserved\n`);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "simulate older deployed server"]);

	let rejected = false;
	try {
		run("node", ["scripts/update-from-release.mjs"], {
			env: { ...process.env, YAOS_RELEASE_FILE: artifactPath },
			stdio: "pipe",
		});
	} catch (error) {
		const output = error && typeof error === "object" && "stderr" in error
			? String(error.stderr)
			: String(error);
		rejected = output.includes("requires a fresh deployment");
	}
	if (!rejected) {
		throw new Error("Fresh-deployment artifact was accepted by the in-place updater");
	}
	if (!read("src/version.ts").includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Rejected fresh deployment modified update-owned files");
	}
	if (!read("wrangler.toml").includes("# local-test-preserved")) {
		throw new Error("Rejected fresh deployment modified wrangler.toml");
	}
	console.log("Fresh schema-4 server artifact is rejected by the in-place updater.");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
