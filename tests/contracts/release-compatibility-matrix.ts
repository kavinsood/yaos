import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
	CapabilityUpdateService,
	serverCapabilityProtocolError,
} from "../../legacy-src/runtime/capabilityUpdateService";
import {
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
	SNAPSHOT_FORMAT_VERSION,
	STORAGE_FORMAT_VERSION,
} from "../../legacy-src/sync/schema";
import type { ServerCapabilities } from "../../legacy-src/sync/serverCapabilities";
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
	settingsSync: true,
	settingsFormatVersion: 2,
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
s.check(SCHEMA_VERSION === 8, "document schema is 8");
s.check(STORAGE_FORMAT_VERSION === 4, "storage format is 4");
s.check(PROTOCOL_VERSION === 5, "socket protocol is 5");
s.check(SNAPSHOT_FORMAT_VERSION === 4, "snapshot format is 4");
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
// DECISIONS §1 removes update-metadata: the release emits the server archive only, and the archive carries no
// legacy product pins or CRDT engine (the P1 server is the opaque streams relay).
const updateManifestPath = resolve(root, "dist/release-assets/update-manifest.json");
rmSync(updateManifestPath, { force: true });
execFileSync(process.execPath, ["build-server-release.mjs"], { cwd: root, stdio: "pipe" });
s.check(!existsSync(updateManifestPath), "release no longer emits update-manifest.json");

const archivePath = resolve(root, "dist/release-assets/yaos-server.zip");
const embedded = JSON.parse(execFileSync("unzip", ["-p", archivePath, "yaos-server-manifest.json"], { encoding: "utf8" })) as Record<string, unknown>;
s.check(embedded.serverVersion === SERVER_VERSION, "server archive publishes its version");
s.check(embedded.deploymentBoundary === "fresh", "server archive requires a fresh deployment");
for (const field of ["schemaVersion", "storageFormatVersion", "protocolVersion", "snapshotFormatVersion", "crdtEngine",
	"pluginVersion", "protectedFiles"]) {
	s.check(!(field in embedded), `server archive manifest has no ${field}`);
}
const archiveEntries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" }).split("\n");
for (const required of ["src/worker.ts", "wrangler.toml", "package.json", "package-lock.json"]) {
	s.check(archiveEntries.includes(required), `server archive carries ${required}`);
}
s.check(!archiveEntries.some((entry) => entry.startsWith("vendor/") || entry.startsWith("src/crdt/")
	|| entry === "scripts/build-ywasm.mjs"), "server archive carries no CRDT engine or ywasm build inputs");

await s.done();
