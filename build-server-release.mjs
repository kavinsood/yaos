import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = resolve(".");
const outputDir = resolve(rootDir, "dist/release-assets");
const tempDir = mkdtempSync(join(tmpdir(), "yaos-server-release-"));
const serverTempDir = join(tempDir, "server");

const rootPackage = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const pluginManifest = JSON.parse(readFileSync(resolve(rootDir, "manifest.json"), "utf8"));
const serverPackage = JSON.parse(readFileSync(resolve(rootDir, "server/package.json"), "utf8"));
const serverVersionSource = readFileSync(resolve(rootDir, "server/src/version.ts"), "utf8");
const productVersionsSource = readFileSync(
	resolve(rootDir, "server/src/shared/productVersions.ts"),
	"utf8",
);
const wranglerSource = readFileSync(resolve(rootDir, "server/wrangler.toml"), "utf8");
const ywasmSource = JSON.parse(readFileSync(resolve(rootDir, "server/vendor/ywasm/SOURCE.json"), "utf8"));

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requirePinnedArtifact(path, expectedHash, expectedBytes, label) {
	if (sha256(path) !== expectedHash || statSync(path).size !== expectedBytes) {
		throw new Error(`${label} does not match server/vendor/ywasm/SOURCE.json`);
	}
}

function requireRecoveryDeploymentContract(source) {
	const binding = /\[\[durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"YAOS_RECOVERY_JOBS"[\s\S]*?class_name\s*=\s*"RecoveryJob"/.test(source);
	const sqliteClass = /\[\[migrations\]\][\s\S]*?new_sqlite_classes\s*=\s*\[[^\]]*"RecoveryJob"[^\]]*\]/.test(source);
	if (!binding || !sqliteClass) {
		throw new Error("server/wrangler.toml must bind YAOS_RECOVERY_JOBS to the SQLite RecoveryJob class");
	}
}

requireRecoveryDeploymentContract(wranglerSource);

function readStringConst(source, name) {
	const match = source.match(new RegExp(`export const ${name} = "([^"]*)";`));
	if (!match) {
		throw new Error(`Unable to read string constant ${name} from server/src/version.ts`);
	}
	return match[1];
}
function readNumberConst(source, name) {
	const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
	if (!match) {
		throw new Error(`Unable to read numeric constant ${name} from shared product versions`);
	}
	return Number(match[1]);
}

const serverVersion = readStringConst(serverVersionSource, "SERVER_VERSION");
const schemaVersion = readNumberConst(productVersionsSource, "SCHEMA_VERSION");
const storageFormatVersion = readNumberConst(productVersionsSource, "STORAGE_FORMAT_VERSION");
const protocolVersion = readNumberConst(productVersionsSource, "PROTOCOL_VERSION");
const snapshotFormatVersion = readNumberConst(productVersionsSource, "SNAPSHOT_FORMAT_VERSION");
if (schemaVersion !== 8 || storageFormatVersion !== 4 || protocolVersion !== 5 || snapshotFormatVersion !== 3) {
	throw new Error("server product versions must remain schema 8 / storage 4 / protocol 5 / snapshot 3");
}

if (serverPackage.version !== serverVersion) {
	throw new Error(
		`server/package.json version (${serverPackage.version}) does not match SERVER_VERSION (${serverVersion})`,
	);
}
const serverReleaseOwnedPaths = [
	".gitlab-ci.yml",
	"package.json",
	"package-lock.json",
	"scripts",
	"tsconfig.json",
	"src",
	"vendor",
];
const serverReleaseCopyPaths = [...serverReleaseOwnedPaths, "wrangler.toml"];

const updateManifest = {
	latestServerVersion: serverVersion,
	latestPluginVersion: pluginManifest.version,
	schemaVersion,
	storageFormatVersion,
	protocolVersion,
	snapshotFormatVersion,
	deploymentBoundary: "fresh",
	releaseNotesUrl: `https://github.com/kavinsood/yaos/releases/tag/${rootPackage.version}`,
};

const serverZipManifest = {
	deploymentBoundary: "fresh",
	serverVersion,
	schemaVersion,
	storageFormatVersion,
	protocolVersion,
	snapshotFormatVersion,
	updateOwnedPaths: serverReleaseOwnedPaths,
	crdtEngine: {
		name: "ywasm",
		sourceCommit: ywasmSource.commit,
		rustToolchain: ywasmSource.rustToolchain,
		wasmPack: ywasmSource.wasmPack,
		maximumLinearMemoryBytes: ywasmSource.maximumLinearMemoryBytes,
		artifactSha256: ywasmSource.artifact.wasmSha256,
	},
};

requirePinnedArtifact(resolve(rootDir, "server/src/crdt/vendor/ywasm/ywasm_bg.wasm"),
	ywasmSource.artifact.wasmSha256, ywasmSource.artifact.wasmBytes, "Worker Wasm artifact");
requirePinnedArtifact(resolve(rootDir, "server/src/crdt/vendor/ywasm/ywasm.mjs"),
	ywasmSource.artifact.wrapperSha256, ywasmSource.artifact.wrapperBytes, "Worker ywasm wrapper");

mkdirSync(outputDir, { recursive: true });
mkdirSync(serverTempDir, { recursive: true });

for (const relativePath of serverReleaseCopyPaths) {
	cpSync(resolve(rootDir, "server", relativePath), join(serverTempDir, relativePath), {
		recursive: true,
	});
}

writeFileSync(
	join(serverTempDir, "yaos-server-manifest.json"),
	`${JSON.stringify(serverZipManifest, null, 2)}\n`,
);
writeFileSync(
	resolve(outputDir, "update-manifest.json"),
	`${JSON.stringify(updateManifest, null, 2)}\n`,
);

const zipPath = resolve(outputDir, "yaos-server.zip");
rmSync(zipPath, { force: true });
execFileSync("zip", ["-qr", zipPath, "."], {
	cwd: serverTempDir,
	stdio: "inherit",
});

rmSync(tempDir, { recursive: true, force: true });
