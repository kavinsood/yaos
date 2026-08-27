import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
	CapabilityUpdateService,
	serverCapabilityProtocolError,
} from "../../src/runtime/capabilityUpdateService";
import {
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
	SNAPSHOT_FORMAT_VERSION,
	STORAGE_FORMAT_VERSION,
} from "../../src/sync/schema";
import type { ServerCapabilities } from "../../src/sync/serverCapabilities";
import { isUpdateManifest, type UpdateManifest } from "../../src/update/updateManifest";
import { SERVER_VERSION } from "../../server/src/version";
import { readSource, repoRoot, suite } from "../harness.ts";

const root = repoRoot();
const packageJson = JSON.parse(readSource("package.json")) as { version: string };
const manifest = JSON.parse(readSource("manifest.json")) as { version: string; minAppVersion: string };
const versions = JSON.parse(readSource("versions.json")) as Record<string, string>;
const s = suite("release-compatibility-matrix");

const baseCapabilities: ServerCapabilities = {
	claimed: true,
	attachments: true,
	snapshots: true,
	recoveryJobs: true,
	serverVersion: SERVER_VERSION,
	schemaVersion: SCHEMA_VERSION,
	storageFormatVersion: STORAGE_FORMAT_VERSION,
	protocolVersion: PROTOCOL_VERSION,
	snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
	updateProvider: null,
	updateRepoUrl: null,
};

function service(capabilities: ServerCapabilities): { blocked: boolean; errors: number } {
	let stopped = 0;
	let errors = 0;
	const runtime = new CapabilityUpdateService({
		getSettings: () => ({ host: "https://release.test", deviceToken: "token", vaultId: "vault", deviceId: "device" }) as never,
		pluginVersion: packageJson.version,
		schemaVersion: SCHEMA_VERSION,
		trace: () => {},
		log: () => {},
		persistPluginState: async () => {},
		hasSyncRuntime: () => true,
		isSyncConnectedAndProviderSynced: () => true,
		refreshAttachmentSyncRuntime: async () => {},
		triggerDailySnapshot: () => {},
		stopSyncRuntimeForCompatibility: () => { stopped++; },
		setStatusError: () => { errors++; },
		scheduleTraceStateSnapshot: () => {},
		updateSettings: async () => {},
	});
	runtime.hydratePersistedCaches({ host: "https://release.test", capabilities }, null);
	return { blocked: runtime.enforceCompatibilityGuard("test") || stopped > 0, errors };
}

s.section("Exact product boundary");
s.check(packageJson.version === manifest.version, "package and plugin manifest versions agree");
s.check(versions[manifest.version] === manifest.minAppVersion, "Obsidian version map contains this plugin release");
s.check(SCHEMA_VERSION === 4, "document schema is 4");
s.check(STORAGE_FORMAT_VERSION === 1, "storage format is 1");
s.check(PROTOCOL_VERSION === 1, "socket protocol is 1");
s.check(SNAPSHOT_FORMAT_VERSION === 2, "snapshot format is 2");
s.check(serverCapabilityProtocolError(baseCapabilities) === null, "current capability envelope is recognized");
s.check(!service(baseCapabilities).blocked, "exact product pins are admitted");
for (const [field, value] of [
	["schemaVersion", SCHEMA_VERSION + 1],
	["storageFormatVersion", STORAGE_FORMAT_VERSION + 1],
	["protocolVersion", PROTOCOL_VERSION + 1],
	["snapshotFormatVersion", SNAPSHOT_FORMAT_VERSION + 1],
] as const) {
	const result = service({ ...baseCapabilities, [field]: value });
	s.check(result.blocked && result.errors === 1, `${field} mismatch fails closed`);
}

s.section("Fresh-deployment release artifact");
execFileSync(process.execPath, ["build-server-release.mjs"], { cwd: root, stdio: "pipe" });
const emitted = JSON.parse(readSource("dist/release-assets/update-manifest.json")) as UpdateManifest;
s.check(isUpdateManifest(emitted), "emitted update manifest has the exact current shape");
s.check(emitted.deploymentBoundary === "fresh", "schema-4 release requires a fresh deployment");
s.check(emitted.latestServerVersion === SERVER_VERSION, "manifest publishes the current server version");
s.check(emitted.latestPluginVersion === manifest.version, "manifest publishes the current plugin version");
s.check(emitted.schemaVersion === 4 && emitted.storageFormatVersion === 1
	&& emitted.protocolVersion === 1 && emitted.snapshotFormatVersion === 2,
"manifest publishes all independent product pins");
s.check(!("upgradeOrder" in emitted) && !("autoUpdateEligible" in emitted)
	&& !("minCompatibleServerVersionForPlugin" in emitted),
"range and in-place update metadata is absent");

const archivePath = resolve(root, "dist/release-assets/yaos-server.zip");
const embedded = JSON.parse(execFileSync("unzip", ["-p", archivePath, "yaos-server-manifest.json"], { encoding: "utf8" })) as Record<string, unknown>;
s.check(embedded.serverVersion === SERVER_VERSION, "server archive publishes its version");
s.check(embedded.schemaVersion === 4 && embedded.storageFormatVersion === 1
	&& embedded.protocolVersion === 1 && embedded.snapshotFormatVersion === 2,
"server archive publishes all product pins");
s.check(!("pluginVersion" in embedded) && !("protectedFiles" in embedded), "obsolete compatibility metadata is absent");

await s.done();
