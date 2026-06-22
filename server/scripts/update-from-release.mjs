import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const defaultReleaseRepo = "kavinsood/yaos";
const releaseRepo = process.env.YAOS_RELEASE_REPO?.trim() || defaultReleaseRepo;
const releaseVersion = process.env.YAOS_RELEASE_VERSION?.trim() ?? "";
const explicitArtifactInput =
	process.env.YAOS_RELEASE_FILE?.trim() ?? process.env.YAOS_RELEASE_URL?.trim() ?? "";
const artifactSource = explicitArtifactInput
	? resolveArtifactSource(explicitArtifactInput)
	: releaseVersion
		? {
				type: "remote",
				label: `GitHub release ${releaseRepo}@${releaseVersion}`,
				value: `https://github.com/${releaseRepo}/releases/download/${releaseVersion}/yaos-server.zip`,
			}
		: {
				type: "remote",
				label: `latest GitHub release from ${releaseRepo}`,
				value: `https://github.com/${releaseRepo}/releases/latest/download/yaos-server.zip`,
			};

const repoRoot = resolve(".");
const tempDir = mkdtempSync(join(tmpdir(), "yaos-server-update-"));
const zipPath = join(tempDir, "yaos-server.zip");
const extractDir = join(tempDir, "extract");
const protectedPrefixes = [".github", ".github/"];
const allowMigrationUpdate = process.env.YAOS_ALLOW_MIGRATION_UPDATE?.trim().toLowerCase() === "true";
const allowSchemaRangeUpdate = process.env.YAOS_ALLOW_SCHEMA_RANGE_UPDATE?.trim().toLowerCase() === "true";

function collectTomlArrayBindingValues(source, sectionName, keyName) {
	const values = new Set();
	const escapedSection = sectionName.replaceAll(".", "\\.");
	const blockRegex = new RegExp(`\\[\\[${escapedSection}\\]\\]([\\s\\S]*?)(?=\\n\\[\\[|\\n\\[|$)`, "g");
	let blockMatch;
	while ((blockMatch = blockRegex.exec(source)) !== null) {
		const block = blockMatch[1];
		const keyRegex = new RegExp(`^\\s*${keyName}\\s*=\\s*"([^"]+)"`, "m");
		const keyMatch = block.match(keyRegex);
		if (keyMatch?.[1]) {
			values.add(keyMatch[1].trim());
		}
	}
	return values;
}

function collectTomlVarsKeys(source) {
	const keys = new Set();
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "[vars]");
	if (start < 0) return keys;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (trimmed.startsWith("[")) break;
		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (match?.[1]) {
			keys.add(match[1].trim());
		}
	}
	return keys;
}

function missingItems(requiredSet, existingSet) {
	const missing = [];
	for (const value of requiredSet) {
		if (!existingSet.has(value)) {
			missing.push(value);
		}
	}
	return missing.sort();
}

function readNumberConst(source, name) {
	const match = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
	return match ? Number(match[1]) : null;
}

function readLocalSchemaRange() {
	const localVersionPath = join(repoRoot, "src/version.ts");
	if (!existsSync(localVersionPath)) {
		return null;
	}
	const source = readFileSync(localVersionPath, "utf8");
	const min = readNumberConst(source, "SERVER_MIN_SCHEMA_VERSION");
	const max = readNumberConst(source, "SERVER_MAX_SCHEMA_VERSION");
	if (min === null || max === null) {
		return null;
	}
	return { min, max };
}

function readArtifactSchemaRange(rawManifest) {
	const min = rawManifest.serverMinSchemaVersion;
	const max = rawManifest.serverMaxSchemaVersion;
	if (min === undefined && max === undefined) {
		return null;
	}
	if (!Number.isInteger(min) || min < 0 || !Number.isInteger(max) || max < 0 || min > max) {
		throw new Error(
			`Artifact manifest has invalid server schema range: min=${String(min)} max=${String(max)}`,
		);
	}
	return { min, max };
}

function formatSchemaRange(range) {
	return `v${range.min}-v${range.max}`;
}

function schemaRangesOverlap(a, b) {
	return a.min <= b.max && b.min <= a.max;
}

function enforceSchemaRangeUpdateGate(rawManifest) {
	const artifactRange = readArtifactSchemaRange(rawManifest);
	if (!artifactRange) {
		console.warn("WARNING: artifact manifest has no server schema range; cannot preflight schema compatibility.");
		return;
	}

	const localRange = readLocalSchemaRange();
	if (!localRange) {
		console.warn("WARNING: local server schema range not found; cannot preflight schema compatibility.");
		return;
	}

	if (schemaRangesOverlap(localRange, artifactRange)) {
		console.log(
			`Schema compatibility preflight passed: local ${formatSchemaRange(localRange)} -> release ${formatSchemaRange(artifactRange)}`,
		);
		return;
	}

	if (rawManifest.migrationRequired === true || allowSchemaRangeUpdate) {
		console.warn(
			`WARNING: schema compatibility gap accepted: local ${formatSchemaRange(localRange)} -> release ${formatSchemaRange(artifactRange)}`,
		);
		return;
	}

	throw new Error(
		[
			"STOP: this YAOS server release has a schema compatibility gap.",
			`Local server supports ${formatSchemaRange(localRange)}; release supports ${formatSchemaRange(artifactRange)}.`,
			"Automatic update is disabled unless the release is marked migration-required.",
			"If you intentionally want to bypass this guard, set YAOS_ALLOW_SCHEMA_RANGE_UPDATE=true.",
		].join(" "),
	);
}

function collectWranglerDriftWarnings(localWranglerPath, upstreamWranglerPath) {
	if (!existsSync(localWranglerPath) || !existsSync(upstreamWranglerPath)) {
		return [];
	}

	const localSource = readFileSync(localWranglerPath, "utf8");
	const upstreamSource = readFileSync(upstreamWranglerPath, "utf8");
	const checks = [
		{ label: "Durable Object bindings", section: "durable_objects.bindings", key: "name" },
		{ label: "R2 bindings", section: "r2_buckets", key: "binding" },
		{ label: "KV bindings", section: "kv_namespaces", key: "binding" },
		{ label: "D1 bindings", section: "d1_databases", key: "binding" },
		{ label: "Service bindings", section: "services", key: "binding" },
		{ label: "Queue producer bindings", section: "queues.producers", key: "binding" },
		{ label: "Queue consumer names", section: "queues.consumers", key: "queue" },
	];

	const warnings = [];
	for (const check of checks) {
		const upstreamValues = collectTomlArrayBindingValues(upstreamSource, check.section, check.key);
		if (upstreamValues.size === 0) continue;
		const localValues = collectTomlArrayBindingValues(localSource, check.section, check.key);
		const missing = missingItems(upstreamValues, localValues);
		if (missing.length > 0) {
			warnings.push(`${check.label} missing locally: ${missing.join(", ")}`);
		}
	}

	const upstreamVars = collectTomlVarsKeys(upstreamSource);
	if (upstreamVars.size > 0) {
		const localVars = collectTomlVarsKeys(localSource);
		const missingVars = missingItems(upstreamVars, localVars);
		if (missingVars.length > 0) {
			warnings.push(`vars keys missing locally: ${missingVars.join(", ")}`);
		}
	}

	return warnings;
}

function resolveArtifactSource(input) {
	if (/^https?:\/\//i.test(input)) {
		return { type: "remote", label: input, value: input };
	}

	const normalizedPath = input.startsWith("file://") ? new URL(input) : resolve(input);
	const filePath = normalizedPath instanceof URL ? normalizedPath : normalizedPath;
	if (!existsSync(filePath)) {
		throw new Error(`Local YAOS server artifact was not found: ${filePath}`);
	}
	return { type: "local", label: String(filePath), value: String(filePath) };
}

async function stageArtifactZip() {
	if (artifactSource.type === "local") {
		console.log(`Using local YAOS server artifact from ${artifactSource.label}`);
		cpSync(artifactSource.value, zipPath);
		return;
	}

	console.log(`Downloading YAOS server artifact from ${artifactSource.label}`);
	const response = await fetch(artifactSource.value, {
		redirect: "follow",
		headers: {
			"User-Agent": "yaos-server-updater",
		},
	});
	if (!response.ok) {
		const baseMessage = `Download failed (${response.status}) for ${artifactSource.value}`;
		if (response.status === 404) {
			throw new Error(
				[
					baseMessage,
					"Expected release assets were not found.",
					"Make sure the selected release includes BOTH 'yaos-server.zip' and 'update-manifest.json'.",
					`release_repo=${releaseRepo}${releaseVersion ? ` version=${releaseVersion}` : " version=latest"}`,
				].join(" "),
			);
		}
		throw new Error(baseMessage);
	}
	writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
}

async function main() {
	await stageArtifactZip();
	mkdirSync(extractDir, { recursive: true });
	execFileSync("unzip", ["-q", zipPath, "-d", extractDir], { stdio: "inherit" });

	const manifestPath = join(extractDir, "yaos-server-manifest.json");
	const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!Array.isArray(rawManifest.updateOwnedPaths)) {
		throw new Error("Artifact manifest is missing updateOwnedPaths");
	}
	if (rawManifest.migrationRequired === true && !allowMigrationUpdate) {
		throw new Error(
			[
				"STOP: this YAOS release is marked as migration-required.",
				"Automatic updates are disabled for migration-required releases to protect Durable Object/SQLite state.",
				"Read the upgrade guide and apply the migration manually before re-running this updater.",
				"If you intentionally want to bypass this guard, set YAOS_ALLOW_MIGRATION_UPDATE=true.",
			].join(" "),
		);
	}
	enforceSchemaRangeUpdateGate(rawManifest);
	const wranglerWarnings = collectWranglerDriftWarnings(
		join(repoRoot, "wrangler.toml"),
		join(extractDir, "wrangler.toml"),
	);
	if (wranglerWarnings.length > 0) {
		console.warn("WARNING: wrangler.toml drift detected relative to this release:");
		for (const warning of wranglerWarnings) {
			console.warn(`  - ${warning}`);
		}
		console.warn("Update completed, but your Cloudflare bindings may need manual wrangler.toml edits.");
	}

	for (const relativePath of rawManifest.updateOwnedPaths) {
		if (typeof relativePath !== "string" || !relativePath) {
			throw new Error(`Invalid update-owned path in artifact: ${String(relativePath)}`);
		}
		if (protectedPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix))) {
			console.log(`Skipping protected path ${relativePath}`);
			continue;
		}
		const sourcePath = join(extractDir, relativePath);
		const targetPath = join(repoRoot, relativePath);
		rmSync(targetPath, { recursive: true, force: true });
		const sourceStats = statSync(sourcePath);
		if (sourceStats.isDirectory()) {
			cpSync(sourcePath, targetPath, { recursive: true });
		} else {
			mkdirSync(dirname(targetPath), { recursive: true });
			cpSync(sourcePath, targetPath);
		}
		console.log(`Updated ${relativePath}`);
	}

	console.log(
		`Applied YAOS server artifact${rawManifest.serverVersion ? ` ${rawManifest.serverVersion}` : ""}`,
	);
}

await main().finally(() => {
	rmSync(tempDir, { recursive: true, force: true });
});
