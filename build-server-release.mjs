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

function readStringConst(source, name) {
	const match = source.match(new RegExp(`export const ${name} = "([^"]*)";`));
	if (!match) {
		throw new Error(`Unable to read string constant ${name} from server/src/version.ts`);
	}
	return match[1];
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
	releaseType: "compatible",
	autoUpdateEligible: false,
	minCompatibleServerVersionForPlugin,
	minCompatiblePluginVersionForServer,
	upgradeOrder: "either",
	releaseNotesUrl: `https://github.com/kavinsood/yaos/releases/tag/${rootPackage.version}`,
	upgradeGuideUrl: "https://github.com/kavinsood/yaos#updating-your-server",
};

const serverZipManifest = {
	serverVersion,
	pluginVersion: pluginManifest.version,
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
