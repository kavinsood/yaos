import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
if (schemaVersion !== 4 || storageFormatVersion !== 1 || protocolVersion !== 1 || snapshotFormatVersion !== 2) {
	throw new Error("server product versions must remain schema 4 / storage 1 / protocol 1 / snapshot 2");
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
};

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
