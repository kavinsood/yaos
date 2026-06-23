import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = resolve(".");
const outputDir = resolve(rootDir, "dist/release-assets");
const tempDir = mkdtempSync(join(tmpdir(), "kaos-server-release-"));
const serverTempDir = join(tempDir, "server");

const rootPackage = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const pluginManifest = JSON.parse(readFileSync(resolve(rootDir, "manifest.json"), "utf8"));
const pluginVersions = JSON.parse(readFileSync(resolve(rootDir, "versions.json"), "utf8"));
const serverPackage = JSON.parse(readFileSync(resolve(rootDir, "server/package.json"), "utf8"));
const serverVersionSource = readFileSync(resolve(rootDir, "server/src/version.ts"), "utf8");
const pluginSchemaSource = readFileSync(resolve(rootDir, "src/sync/schema.ts"), "utf8");

function readStringConst(source, name) {
	const match = source.match(new RegExp(`export const ${name} = "([^"]*)";`));
	if (!match) {
		throw new Error(`Unable to read string constant ${name} from server/src/version.ts`);
	}
	return match[1];
}

function readBooleanConst(source, name) {
	const match = source.match(new RegExp(`export const ${name} = (true|false);`));
	if (!match) {
		throw new Error(`Unable to read boolean constant ${name} from server/src/version.ts`);
	}
	return match[1] === "true";
}

function readNumberConst(source, name, sourceLabel) {
	const match = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
	if (!match) {
		throw new Error(`Unable to read number constant ${name} from ${sourceLabel}`);
	}
	return Number(match[1]);
}

const serverVersion = readStringConst(serverVersionSource, "SERVER_VERSION");
const minCompatibleServerVersionForPlugin = readStringConst(
	serverVersionSource,
	"SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN",
);
const minCompatiblePluginVersionForServer = readStringConst(
	serverVersionSource,
	"SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER",
);
const migrationRequired = readBooleanConst(
	serverVersionSource,
	"SERVER_MIGRATION_REQUIRED",
);
const pluginSchemaVersion = readNumberConst(pluginSchemaSource, "SCHEMA_VERSION", "src/sync/schema.ts");
const serverMinSchemaVersion = readNumberConst(
	serverVersionSource,
	"SERVER_MIN_SCHEMA_VERSION",
	"server/src/version.ts",
);
const serverMaxSchemaVersion = readNumberConst(
	serverVersionSource,
	"SERVER_MAX_SCHEMA_VERSION",
	"server/src/version.ts",
);

if (serverMinSchemaVersion > serverMaxSchemaVersion) {
	throw new Error(
		`server schema range is invalid: min ${serverMinSchemaVersion} > max ${serverMaxSchemaVersion}`,
	);
}
if (pluginSchemaVersion > serverMaxSchemaVersion) {
	throw new Error(
		`plugin schema ${pluginSchemaVersion} exceeds server max schema ${serverMaxSchemaVersion}`,
	);
}
if (pluginSchemaVersion < serverMinSchemaVersion) {
	throw new Error(
		`plugin schema ${pluginSchemaVersion} is below server min schema ${serverMinSchemaVersion}`,
	);
}

if (serverPackage.version !== serverVersion) {
	throw new Error(
		`server/package.json version (${serverPackage.version}) does not match SERVER_VERSION (${serverVersion})`,
	);
}
if (rootPackage.version !== pluginManifest.version) {
	throw new Error(
		`package.json version (${rootPackage.version}) does not match manifest.json version (${pluginManifest.version})`,
	);
}
if (pluginVersions[rootPackage.version] !== pluginManifest.minAppVersion) {
	throw new Error(
		`versions.json is missing ${rootPackage.version} -> ${pluginManifest.minAppVersion}. Run npm version so version-bump.mjs registers the plugin version.`,
	);
}

const updateManifest = {
	latestServerVersion: serverVersion,
	latestPluginVersion: pluginManifest.version,
	releaseType: migrationRequired ? "migration-required" : "compatible",
	migrationRequired,
	autoUpdateEligible: false,
	minCompatibleServerVersionForPlugin,
	minCompatiblePluginVersionForServer,
	latestPluginSchemaVersion: pluginSchemaVersion,
	latestServerMinSchemaVersion: serverMinSchemaVersion,
	latestServerMaxSchemaVersion: serverMaxSchemaVersion,
	upgradeOrder: "either",
	releaseNotesUrl: `https://github.com/adtstack/kaos/releases/tag/${rootPackage.version}`,
	upgradeGuideUrl: "https://github.com/adtstack/kaos#updating-your-server",
};

const serverZipManifest = {
	serverVersion,
	pluginVersion: pluginManifest.version,
	pluginSchemaVersion,
	serverMinSchemaVersion,
	serverMaxSchemaVersion,
	protectedFiles: ["wrangler.toml"],
	updateOwnedPaths: [
		".gitlab-ci.yml",
		"package.json",
		"package-lock.json",
		"scripts",
		"tsconfig.json",
		"src",
	],
	migrationRequired,
};

mkdirSync(outputDir, { recursive: true });
mkdirSync(serverTempDir, { recursive: true });

for (const relativePath of [
	"package.json",
	"package-lock.json",
	".gitlab-ci.yml",
	"scripts",
	"tsconfig.json",
	"wrangler.toml",
	"src",
]) {
	cpSync(resolve(rootDir, "server", relativePath), join(serverTempDir, relativePath), {
		recursive: true,
	});
}

writeFileSync(
	join(serverTempDir, "kaos-server-manifest.json"),
	`${JSON.stringify(serverZipManifest, null, 2)}\n`,
);
writeFileSync(
	resolve(outputDir, "update-manifest.json"),
	`${JSON.stringify(updateManifest, null, 2)}\n`,
);

const zipPath = resolve(outputDir, "kaos-server.zip");
rmSync(zipPath, { force: true });
execFileSync("zip", ["-qr", zipPath, "."], {
	cwd: serverTempDir,
	stdio: "inherit",
});

rmSync(tempDir, { recursive: true, force: true });
