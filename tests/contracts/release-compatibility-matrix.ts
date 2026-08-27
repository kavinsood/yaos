import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
	CapabilityUpdateService,
	serverCapabilityProtocolError,
} from "../../src/runtime/capabilityUpdateService";
import type { ServerCapabilities } from "../../src/sync/serverCapabilities";
import type { UpdateManifest } from "../../src/update/updateManifest";
import { SCHEMA_VERSION } from "../../src/sync/schema";
import {
	SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER,
	SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN,
	SERVER_RECOMMENDED_PLUGIN_VERSION,
	SERVER_SCHEMA_VERSION,
	SERVER_VERSION,
} from "../../server/src/version";
import { readSource, repoRoot, suite } from "../harness.ts";

const root = repoRoot();
const packageJson = JSON.parse(readSource("package.json")) as { version: string };
const manifest = JSON.parse(readSource("manifest.json")) as {
	version: string;
	minAppVersion: string;
};
const versions = JSON.parse(readSource("versions.json")) as Record<string, string>;

const s = suite("release-compatibility-matrix");

function parseVersion(value: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, minimum: string): boolean {
	const actualParts = parseVersion(actual);
	const minimumParts = parseVersion(minimum);
	if (!actualParts || !minimumParts) return false;
	for (let i = 0; i < actualParts.length; i++) {
		if (actualParts[i]! > minimumParts[i]!) return true;
		if (actualParts[i]! < minimumParts[i]!) return false;
	}
	return true;
}

s.section("Release compatibility matrix");

s.check(packageJson.version === manifest.version, "package.json and manifest.json publish the same plugin version");
s.check(versions[manifest.version] === manifest.minAppVersion, "versions.json contains the release plugin version and minimum Obsidian version");
s.check(parseVersion(SERVER_VERSION) !== null, "server version is numeric semver");
s.check(atLeast(SERVER_VERSION, SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN), "current server satisfies the plugin's advertised server floor");
s.check(atLeast(packageJson.version, SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER), "current plugin satisfies the server's advertised plugin floor");
s.check(atLeast(packageJson.version, SERVER_RECOMMENDED_PLUGIN_VERSION), "current plugin meets the server recommendation");
s.check(SERVER_SCHEMA_VERSION === SCHEMA_VERSION, "the pinned server schema equals the current plugin schema");
for (const version of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
	s.check(
		version !== SERVER_SCHEMA_VERSION,
		`schema v${version} is not admitted by the pinned server`,
	);
}

s.section("Emitted release artifact contract");
{
	execFileSync(process.execPath, ["build-server-release.mjs"], {
		cwd: root,
		stdio: "pipe",
	});

	const emittedManifest = JSON.parse(
		readSource("dist/release-assets/update-manifest.json"),
	) as UpdateManifest;
	s.check(emittedManifest.latestServerVersion === SERVER_VERSION, "emitted manifest has the current server version");
	s.check(emittedManifest.latestPluginVersion === manifest.version, "emitted manifest has the published plugin version");
	s.check(
		emittedManifest.minCompatibleServerVersionForPlugin === SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN,
		"emitted manifest has the plugin's server floor",
	);
	s.check(
		emittedManifest.minCompatiblePluginVersionForServer === SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER,
		"emitted manifest has the server's plugin floor",
	);
	s.check(emittedManifest.releaseType === "compatible", "emitted manifest reflects the non-migration release type");
	s.check(emittedManifest.autoUpdateEligible === false, "emitted manifest disables unattended updates");
	s.check(emittedManifest.upgradeOrder === "either", "emitted manifest declares either upgrade order");
	s.check(
		emittedManifest.releaseNotesUrl.endsWith(`/tag/${packageJson.version}`),
		"emitted manifest release notes target the plugin release tag",
	);
	s.check(
		emittedManifest.upgradeGuideUrl === "https://github.com/kavinsood/yaos#updating-your-server",
		"emitted manifest has the canonical upgrade guide URL",
	);

	const archivePath = resolve(root, "dist/release-assets/yaos-server.zip");
	const embeddedManifest = JSON.parse(
		execFileSync("unzip", ["-p", archivePath, "yaos-server-manifest.json"], {
			encoding: "utf8",
		}),
	) as {
		serverVersion: string;
		pluginVersion: string;
		updateOwnedPaths: string[];
	};
	const archiveEntries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
		.trim()
		.split("\n");
	s.check(embeddedManifest.serverVersion === SERVER_VERSION, "server archive manifest has the current server version");
	s.check(embeddedManifest.pluginVersion === manifest.version, "server archive manifest has the current plugin version");
	const expectedOwnedPaths = [".gitlab-ci.yml", "package.json", "package-lock.json", "scripts", "tsconfig.json", "src"];
	s.check(
		JSON.stringify(embeddedManifest.updateOwnedPaths) === JSON.stringify(expectedOwnedPaths),
		"server archive declares the exact update-owned path set",
	);
	for (const ownedPath of embeddedManifest.updateOwnedPaths) {
		s.check(
			archiveEntries.some((entry) => entry === ownedPath || entry.startsWith(`${ownedPath}/`)),
			`server archive contains update-owned path ${ownedPath}`,
		);
	}
	s.check(archiveEntries.includes("wrangler.toml"), "server archive contains the protected wrangler.toml template");
}

s.section("Runtime compatibility decision matrix");
{
	const host = "https://release-matrix.test";
	const baseCapabilities: ServerCapabilities = {
		claimed: true,
		attachments: true,
		snapshots: true,
		serverVersion: SERVER_VERSION,
		minPluginVersion: null,
		recommendedPluginVersion: SERVER_RECOMMENDED_PLUGIN_VERSION,
		schemaVersion: SERVER_SCHEMA_VERSION,
		updateProvider: null,
		updateRepoUrl: null,
	};
	const baseManifest: UpdateManifest = {
		latestServerVersion: SERVER_VERSION,
		latestPluginVersion: manifest.version,
		releaseType: "compatible",
		autoUpdateEligible: false,
		minCompatibleServerVersionForPlugin: SERVER_MIN_COMPATIBLE_SERVER_VERSION_FOR_PLUGIN,
		minCompatiblePluginVersionForServer: SERVER_MIN_COMPATIBLE_PLUGIN_VERSION_FOR_SERVER,
		upgradeOrder: "either",
		releaseNotesUrl: "https://release-matrix.test/notes",
		upgradeGuideUrl: "https://release-matrix.test/guide",
	};

	function evaluateCompatibility(args: {
		pluginVersion: string;
		schemaVersion: number;
		capabilities?: Partial<ServerCapabilities>;
		updateManifest?: Partial<UpdateManifest>;
	}): { blocked: boolean; stopped: number; statusErrors: number } {
		let stopped = 0;
		let statusErrors = 0;
		const service = new CapabilityUpdateService({
			getSettings: () => ({
				host,
				deviceToken: "release-matrix-device-bearer",
				vaultId: "release-matrix-vault",
				deviceId: "release-matrix-device",
			} as never),
			pluginVersion: args.pluginVersion,
			schemaVersion: args.schemaVersion,
			trace: () => {},
			log: () => {},
			persistPluginState: async () => {},
			hasSyncRuntime: () => true,
			isSyncConnectedAndProviderSynced: () => true,
			refreshAttachmentSyncRuntime: async () => {},
			triggerDailySnapshot: () => {},
			stopSyncRuntimeForCompatibility: () => { stopped++; },
			setStatusError: () => { statusErrors++; },
			scheduleTraceStateSnapshot: () => {},
			updateSettings: async () => {},
		});
		service.hydratePersistedCaches(
			{ host, capabilities: { ...baseCapabilities, ...args.capabilities } },
			{ fetchedAt: Date.now(), manifest: { ...baseManifest, ...args.updateManifest } },
		);
		return {
			blocked: service.enforceCompatibilityGuard("release-matrix"),
			stopped,
			statusErrors,
		};
	}

	const currentPair = evaluateCompatibility({ pluginVersion: manifest.version, schemaVersion: SCHEMA_VERSION });
	s.check(!currentPair.blocked && currentPair.stopped === 0 && currentPair.statusErrors === 0, "current plugin/server pair remains sync-compatible at runtime");

	const stagedPair = evaluateCompatibility({
		pluginVersion: "1.6.0",
		schemaVersion: SCHEMA_VERSION,
		capabilities: { serverVersion: "0.1.9" },
	});
	s.check(!stagedPair.blocked, "older-than-latest plugin is not blocked by the latest release's server floor");

	const blockedServerPair = evaluateCompatibility({
		pluginVersion: manifest.version,
		schemaVersion: SCHEMA_VERSION,
		capabilities: { serverVersion: "0.1.9" },
	});
	s.check(
		blockedServerPair.blocked && blockedServerPair.stopped === 1 && blockedServerPair.statusErrors === 1,
		"latest plugin blocks and tears down sync against a server below its declared floor",
	);

	const blockedPluginPair = evaluateCompatibility({
		pluginVersion: "1.3.2",
		schemaVersion: SCHEMA_VERSION,
		capabilities: { minPluginVersion: "1.3.3" },
	});
	s.check(
		blockedPluginPair.blocked && blockedPluginPair.stopped === 1 && blockedPluginPair.statusErrors === 1,
		"live server plugin floor blocks an outdated plugin before sync",
	);

	const blockedBelowPin = evaluateCompatibility({
		pluginVersion: manifest.version,
		schemaVersion: SERVER_SCHEMA_VERSION - 1,
	});
	s.check(blockedBelowPin.blocked, "local schema one below the pinned server schema is blocked at runtime");

	const blockedAbovePin = evaluateCompatibility({
		pluginVersion: manifest.version,
		schemaVersion: SERVER_SCHEMA_VERSION + 1,
	});
	s.check(blockedAbovePin.blocked, "local schema one above the pinned server schema is blocked at runtime");

	const manifestPluginFloorOnly = evaluateCompatibility({
		pluginVersion: "1.0.0",
		schemaVersion: SCHEMA_VERSION,
		updateManifest: { minCompatiblePluginVersionForServer: "99.0.0" },
	});
	s.check(
		!manifestPluginFloorOnly.blocked,
		"server-side plugin floor comes from live capabilities, not unused update-manifest metadata",
	);
}

s.section("Mandatory capability protocol");
{
	s.check(
		serverCapabilityProtocolError({ serverVersion: "" }) !== null,
		"a 200 response without a server version is a hard incompatibility",
	);
	s.check(
		serverCapabilityProtocolError(null, "capabilities request failed (404)") !== null,
		"a server without the capabilities endpoint is a hard incompatibility",
	);
	s.check(
		serverCapabilityProtocolError({ serverVersion: SERVER_VERSION }) === null,
		"the current capability protocol is accepted",
	);
	s.check(
		serverCapabilityProtocolError(null, "network unavailable") === null,
		"a transient network failure is not mislabeled as protocol incompatibility",
	);
}
await s.done();
