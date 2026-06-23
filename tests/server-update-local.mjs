import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = resolve(".");
const artifactPath = resolve(rootDir, "dist/release-assets/kaos-server.zip");
const tempDir = mkdtempSync(join(tmpdir(), "kaos-server-update-test-"));
const repoDir = join(tempDir, "repo");

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repoDir,
		stdio: "inherit",
		...options,
	});
}

function runExpectFailure(command, args, options = {}) {
	try {
		execFileSync(command, args, {
			cwd: repoDir,
			encoding: "utf8",
			stdio: "pipe",
			...options,
		});
	} catch (err) {
		return `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	throw new Error(`Expected command to fail: ${command} ${args.join(" ")}`);
}

function read(relativePath) {
	return readFileSync(join(repoDir, relativePath), "utf8");
}

function readRequiredNumberConst(source, name) {
	const match = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
	if (!match) {
		throw new Error(`Unable to read ${name} from src/version.ts`);
	}
	return Number(match[1]);
}

function buildBadSchemaArtifact(baselineVersion, schemaVersion) {
	const badReleaseDir = join(tempDir, "bad-schema-release");
	const badArtifactPath = join(tempDir, "bad-schema-server.zip");
	mkdirSync(join(badReleaseDir, "src"), { recursive: true });
	const badVersion = baselineVersion
		.replace(/SERVER_VERSION = "[^"]+"/, 'SERVER_VERSION = "99.0.0"')
		.replace(/SERVER_MIN_SCHEMA_VERSION\s*=\s*\d+/, `SERVER_MIN_SCHEMA_VERSION = ${schemaVersion}`)
		.replace(/SERVER_MAX_SCHEMA_VERSION\s*=\s*\d+/, `SERVER_MAX_SCHEMA_VERSION = ${schemaVersion}`);
	writeFileSync(join(badReleaseDir, "src/version.ts"), badVersion);
	writeFileSync(
		join(badReleaseDir, "kaos-server-manifest.json"),
		`${JSON.stringify({
			serverVersion: "99.0.0",
			pluginVersion: "99.0.0",
			serverMinSchemaVersion: schemaVersion,
			serverMaxSchemaVersion: schemaVersion,
			protectedFiles: ["wrangler.toml"],
			updateOwnedPaths: ["src/version.ts"],
			migrationRequired: false,
		}, null, 2)}\n`,
	);
	execFileSync("zip", ["-qr", badArtifactPath, "."], {
		cwd: badReleaseDir,
		stdio: "inherit",
	});
	return badArtifactPath;
}

try {
	cpSync(resolve(rootDir, "server"), repoDir, { recursive: true });

	run("git", ["init", "-q"]);
	run("git", ["config", "user.name", "KAOS Local Test"]);
	run("git", ["config", "user.email", "local-test@kaos"]);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "baseline"]);

	const baselineVersion = read("src/version.ts");
	const baselineWrangler = read("wrangler.toml");
	const currentServerVersionMatch = baselineVersion.match(/SERVER_VERSION = "([^"]+)"/);
	if (!currentServerVersionMatch) {
		throw new Error("Unable to read current server version from src/version.ts");
	}
	const currentServerVersion = currentServerVersionMatch[1];
	const currentMinSchemaVersion = readRequiredNumberConst(baselineVersion, "SERVER_MIN_SCHEMA_VERSION");
	const currentMaxSchemaVersion = readRequiredNumberConst(baselineVersion, "SERVER_MAX_SCHEMA_VERSION");

	writeFileSync(
		join(repoDir, "src/version.ts"),
		baselineVersion
			.replace(
				`SERVER_VERSION = "${currentServerVersion}"`,
				'SERVER_VERSION = "0.1.9"',
			)
			.replace(
				/SERVER_MAX_SCHEMA_VERSION\s*=\s*\d+/,
				`SERVER_MAX_SCHEMA_VERSION = ${currentMinSchemaVersion}`,
			),
	);
	writeFileSync(join(repoDir, "wrangler.toml"), `${baselineWrangler}\n# local-test-preserved\n`);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "simulate older deployed server"]);

	run("node", ["scripts/update-from-release.mjs"], {
		env: {
			...process.env,
			KAOS_RELEASE_FILE: artifactPath,
		},
	});

	const updatedVersion = read("src/version.ts");
	if (updatedVersion !== baselineVersion) {
		throw new Error("Update test failed: src/version.ts was not restored from the artifact");
	}

	const updatedWrangler = read("wrangler.toml");
	if (!updatedWrangler.includes("# local-test-preserved")) {
		throw new Error("Update test failed: protected wrangler.toml changes were overwritten");
	}

	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", `kaos(server): update to ${currentServerVersion}`]);
	run("node", ["scripts/revert-last-update.mjs"]);

	const revertedVersion = read("src/version.ts");
	if (!revertedVersion.includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Revert test failed: update-owned files were not restored");
	}

	const revertedWrangler = read("wrangler.toml");
	if (!revertedWrangler.includes("# local-test-preserved")) {
		throw new Error("Revert test failed: protected wrangler.toml changes were lost");
	}

	const badArtifactPath = buildBadSchemaArtifact(baselineVersion, currentMaxSchemaVersion + 100);
	const badUpdateOutput = runExpectFailure("node", ["scripts/update-from-release.mjs"], {
		env: {
			...process.env,
			KAOS_RELEASE_FILE: badArtifactPath,
		},
	});
	if (!badUpdateOutput.includes("schema compatibility gap")) {
		throw new Error(`Expected schema gap rejection, got:\n${badUpdateOutput}`);
	}
	const afterBadUpdateVersion = read("src/version.ts");
	if (!afterBadUpdateVersion.includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Schema gap test failed: rejected update still modified src/version.ts");
	}

	console.log("Local KAOS server update/revert smoke test passed.");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
