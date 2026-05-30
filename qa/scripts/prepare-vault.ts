#!/usr/bin/env bun
/**
 * qa:prepare — copy a fixture vault to a target directory.
 *
 * Usage:
 *   bun run qa:prepare --fixture 001-basic-markdown --dest /path/to/vault [--preset minimal]
 *
 * Options:
 *   --fixture   fixture vault ID (e.g. 001-basic-markdown)
 *   --dest      target vault directory (will be created if missing)
 *   --preset    plugin preset from plugin-lock.json (default: minimal)
 *   --clean     delete dest first if it exists
 *
 * After copying, the script writes a `.obsidian/plugins/yaos-qa-harness/` stub
 * so the harness plugin can be activated manually.
 */

import { cp, mkdir, rm, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FIXTURES_DIR = join(REPO_ROOT, "qa", "fixtures", "vaults");
const HARNESS_BUILD = join(REPO_ROOT, "qa", "obsidian-harness", "main.js");
const HARNESS_MANIFEST = join(REPO_ROOT, "qa", "obsidian-harness", "manifest.json");
// QA scenarios load the QA-enabled product build (includes EngineControlPort).
// Production main.js strips the control port via __YAOS_QA_HARNESS_ENABLED__=false.
// Build with: npm run build:qa-product
const YAOS_BUILD = join(REPO_ROOT, "qa", "obsidian-harness", "product-main.js");
const YAOS_MANIFEST = join(REPO_ROOT, "manifest.json");
const PLUGIN_LOCK = join(REPO_ROOT, "qa", "plugin-lock.json");

interface PluginEntry {
	id: string;
	minVersion: string;
}

interface PluginLock {
	presets: Record<string, PluginEntry[]>;
}

function randomId(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function parseArgs(args: string[]): Record<string, string | boolean> {
	const result: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next && !next.startsWith("--")) {
				result[key] = next;
				i++;
			} else {
				result[key] = true;
			}
		}
	}
	return result;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const fixture = args.fixture as string | undefined;
	const dest = args.dest as string | undefined;
	const preset = (args.preset as string | undefined) ?? "minimal";
	const clean = args.clean === true;

	if (!fixture || !dest) {
		console.error("Usage: bun run qa:prepare --fixture <id> --dest <path> [--preset minimal] [--clean]");
		process.exit(1);
	}

	const fixtureDir = join(FIXTURES_DIR, fixture);
	if (!existsSync(fixtureDir)) {
		console.error(`Fixture not found: ${fixtureDir}`);
		console.error(`Available fixtures: ${(await readdir(FIXTURES_DIR)).join(", ")}`);
		process.exit(1);
	}

	const destAbs = resolve(dest);

	if (clean && existsSync(destAbs)) {
		console.log(`Removing existing vault at ${destAbs}…`);
		await rm(destAbs, { recursive: true });
	}

	await mkdir(destAbs, { recursive: true });

	console.log(`Copying fixture ${fixture} → ${destAbs}…`);
	await cp(fixtureDir, destAbs, { recursive: true });

	// Create .obsidian structure
	const obsidianDir = join(destAbs, ".obsidian");
	await mkdir(obsidianDir, { recursive: true });
	await writeFile(
		join(obsidianDir, "app.json"),
		JSON.stringify({ legacyEditor: false, livePreview: true }, null, 2),
	);
	await writeFile(
		join(obsidianDir, "appearance.json"),
		JSON.stringify({ theme: "obsidian" }, null, 2),
	);

	// Install YAOS plugin
	const yaosPluginDir = join(obsidianDir, "plugins", "do-sync");
	await mkdir(yaosPluginDir, { recursive: true });
	if (existsSync(YAOS_MANIFEST)) {
		await cp(YAOS_MANIFEST, join(yaosPluginDir, "manifest.json"));
	}
	if (existsSync(YAOS_BUILD)) {
		await cp(YAOS_BUILD, join(yaosPluginDir, "main.js"));
		console.log("Installed YAOS plugin (QA-enabled build).");
	} else {
		console.warn("Warning: QA-enabled YAOS build not found. Run: npm run build:qa-product");
		console.warn(`Expected: ${YAOS_BUILD}`);
	}

	// Write YAOS settings with qaDebugMode enabled
	// Use a fresh vaultId so each prepared vault is isolated.
	const vaultId = randomId();
	const yaosSettings = {
		host: "",
		token: "",
		vaultId,
		deviceName: "qa-device-a",
		debug: false,
		frontmatterGuardEnabled: true,
		excludePatterns: "",
		maxFileSizeKB: 2048,
		externalEditPolicy: "always",
		enableAttachmentSync: true,
		attachmentSyncExplicitlyConfigured: false,
		maxAttachmentSizeKB: 10240,
		attachmentConcurrency: 1,
		showRemoteCursors: true,
		qaTraceEnabled: false,
		qaTraceMode: "qa-safe",
		qaTraceSecret: "",
		updateRepoUrl: "",
		updateRepoBranch: "main",
		qaDebugMode: true,
	};
	await writeFile(
		join(yaosPluginDir, "data.json"),
		JSON.stringify(yaosSettings, null, 2),
	);
	console.log("Wrote YAOS data.json with qaDebugMode=true.");
	console.log(`  vaultId: ${vaultId} — set host+token in Obsidian settings before syncing.`);

	// Install harness plugin stub
	const harnessPluginDir = join(obsidianDir, "plugins", "yaos-qa-harness");
	await mkdir(harnessPluginDir, { recursive: true });
	if (existsSync(HARNESS_MANIFEST)) {
		await cp(HARNESS_MANIFEST, join(harnessPluginDir, "manifest.json"));
	}
	if (existsSync(HARNESS_BUILD)) {
		await cp(HARNESS_BUILD, join(harnessPluginDir, "main.js"));
		console.log("Installed yaos-qa-harness plugin (built).");
	} else {
		await writeFile(
			join(harnessPluginDir, "main.js"),
			`// YAOS QA Harness — build first with: bun run build:harness\n` +
			`new obsidian.Plugin().onload = () => console.warn('[YAOS QA] Harness not built yet');\n`,
		);
		console.warn("Warning: harness not built. Run: bun run build:harness");
	}

	// Enable both plugins
	const communityPluginsFile = join(obsidianDir, "community-plugins.json");
	const enabledPlugins: string[] = existsSync(communityPluginsFile)
		? JSON.parse(await readFile(communityPluginsFile, "utf-8")) as string[]
		: [];
	for (const id of ["do-sync", "yaos-qa-harness"]) {
		if (!enabledPlugins.includes(id)) enabledPlugins.push(id);
	}
	await writeFile(communityPluginsFile, JSON.stringify(enabledPlugins, null, 2));

	// Log plugin-lock preset (manual install reminder)
	let lockData: PluginLock | null = null;
	try {
		lockData = JSON.parse(await readFile(PLUGIN_LOCK, "utf-8")) as PluginLock;
	} catch { /* no lock file */ }
	if (lockData) {
		const plugins = lockData.presets[preset] ?? [];
		if (plugins.length > 0) {
			console.log(`\nPreset "${preset}" requires these community plugins:`);
			for (const p of plugins) {
				console.log(`  - ${p.id} >= ${p.minVersion}`);
			}
			console.log("Install them manually via Obsidian Community Plugins browser.");
		}
	}

	console.log(`\nVault ready: ${destAbs}`);
	console.log("Next steps:");
	console.log("  1. Open vault in Obsidian");
	console.log("  2. Enable community plugins (plugins are pre-installed)");
	console.log("  3. Set host + token in YAOS settings (qaDebugMode already enabled)");
	console.log("  4. Launch with remote debugging: Obsidian --remote-debugging-port=9222");
	console.log("  5. Open DevTools and run: __YAOS_QA__.help()");
}

async function readdir(dir: string): Promise<string[]> {
	const { readdir: fsReaddir } = await import("fs/promises");
	return fsReaddir(dir);
}

await main();
