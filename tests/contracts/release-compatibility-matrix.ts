import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
	CURRENT_PRODUCT_VERSIONS,
	negotiateSnapshotVersion,
	negotiateStorageVersion,
	negotiateSyncVersions,
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
	SNAPSHOT_FORMAT_VERSION,
	STORAGE_FORMAT_VERSION,
	type ProductVersions,
} from "../../server/src/shared/productVersions";
import { SERVER_VERSION } from "../../server/src/version";
import { readSource, repoRoot, suite } from "../harness.ts";

const root = repoRoot();
const packageJson = JSON.parse(readSource("package.json")) as { version: string };
const manifest = JSON.parse(readSource("manifest.json")) as { version: string; minAppVersion: string };
const versions = JSON.parse(readSource("versions.json")) as Record<string, string>;
const s = suite("release-compatibility-matrix");

/** The shape build-server-release.mjs emits as dist/release-assets/update-manifest.json. */
interface UpdateManifest {
	latestServerVersion: string;
	latestPluginVersion: string;
	schemaVersion: number;
	storageFormatVersion: number;
	protocolVersion: number;
	snapshotFormatVersion: number;
	deploymentBoundary: "fresh" | "in-place";
	releaseNotesUrl: string;
}

function isUpdateManifest(value: unknown): value is UpdateManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const c = value as Partial<UpdateManifest>;
	return typeof c.latestServerVersion === "string"
		&& typeof c.latestPluginVersion === "string"
		&& Number.isSafeInteger(c.schemaVersion)
		&& Number.isSafeInteger(c.storageFormatVersion)
		&& Number.isSafeInteger(c.protocolVersion)
		&& Number.isSafeInteger(c.snapshotFormatVersion)
		&& (c.deploymentBoundary === "fresh" || c.deploymentBoundary === "in-place")
		&& typeof c.releaseNotesUrl === "string";
}

function admitted(remote: ProductVersions): boolean {
	const local = CURRENT_PRODUCT_VERSIONS;
	return negotiateSyncVersions(local, remote).compatible
		&& negotiateSnapshotVersion(local, remote).compatible
		&& negotiateStorageVersion(local, remote).compatible;
}

s.section("Exact product boundary");
s.check(packageJson.version === manifest.version, "package and plugin manifest versions agree");
s.check(versions[manifest.version] === manifest.minAppVersion, "Obsidian version map contains this plugin release");
s.check(SCHEMA_VERSION === 8, "document schema is 8");
s.check(STORAGE_FORMAT_VERSION === 4, "storage format is 4");
s.check(PROTOCOL_VERSION === 5, "socket protocol is 5");
s.check(SNAPSHOT_FORMAT_VERSION === 4, "snapshot format is 4");
s.check(admitted({ ...CURRENT_PRODUCT_VERSIONS }), "exact product pins are admitted");
for (const field of ["schemaVersion", "storageFormatVersion", "protocolVersion", "snapshotFormatVersion"] as const) {
	const remote = { ...CURRENT_PRODUCT_VERSIONS, [field]: CURRENT_PRODUCT_VERSIONS[field] + 1 };
	s.check(!admitted(remote), `${field} mismatch fails closed`);
}

s.section("Fresh-deployment release artifact");
execFileSync(process.execPath, ["build-server-release.mjs"], { cwd: root, stdio: "pipe" });
const emitted = JSON.parse(readSource("dist/release-assets/update-manifest.json")) as UpdateManifest;
s.check(isUpdateManifest(emitted), "emitted update manifest has the exact current shape");
s.check(emitted.deploymentBoundary === "fresh", "breaking storage release requires a fresh deployment");
s.check(emitted.latestServerVersion === SERVER_VERSION, "manifest publishes the current server version");
s.check(emitted.latestPluginVersion === manifest.version, "manifest publishes the current plugin version");
s.check(emitted.schemaVersion === 8 && emitted.storageFormatVersion === 4
	&& emitted.protocolVersion === 5 && emitted.snapshotFormatVersion === 4,
"manifest publishes all independent product pins");
s.check(!("upgradeOrder" in emitted) && !("autoUpdateEligible" in emitted)
	&& !("minCompatibleServerVersionForPlugin" in emitted),
"range and in-place update metadata is absent");

const archivePath = resolve(root, "dist/release-assets/yaos-server.zip");
const embedded = JSON.parse(execFileSync("unzip", ["-p", archivePath, "yaos-server-manifest.json"], { encoding: "utf8" })) as Record<string, unknown>;
s.check(embedded.serverVersion === SERVER_VERSION, "server archive publishes its version");
s.check(embedded.schemaVersion === 8 && embedded.storageFormatVersion === 4
	&& embedded.protocolVersion === 5 && embedded.snapshotFormatVersion === 4,
"server archive publishes all product pins");
s.check(!("pluginVersion" in embedded) && !("protectedFiles" in embedded), "obsolete compatibility metadata is absent");
const crdtEngine = embedded.crdtEngine as Record<string, unknown> | undefined;
s.check(crdtEngine?.name === "ywasm"
	&& typeof crdtEngine.sourceCommit === "string" && crdtEngine.sourceCommit.length === 40
	&& typeof crdtEngine.artifactSha256 === "string" && crdtEngine.artifactSha256.length === 64,
"server archive identifies its pinned CRDT source and artifact");
const archiveEntries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" }).split("\n");
for (const required of [
	"scripts/build-ywasm.mjs",
	"vendor/ywasm/SOURCE.json",
	"vendor/ywasm/rust-toolchain.toml",
	"vendor/ywasm/patches/0001-document-stats.patch",
]) {
	s.check(archiveEntries.includes(required), `server archive carries hermetic ywasm input ${required}`);
}

await s.done();
