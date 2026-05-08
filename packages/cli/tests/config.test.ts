import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import test from "node:test";
import { requireRuntimeConfig, resolveCliConfig } from "../src/config";

const ENV_KEYS = [
	"XDG_CONFIG_HOME",
	"YAOS_HOST",
	"YAOS_TOKEN",
	"YAOS_VAULT_ID",
	"YAOS_DIR",
	"YAOS_DEVICE_NAME",
	"YAOS_DEBUG",
	"YAOS_EXCLUDE_PATTERNS",
	"YAOS_MAX_FILE_SIZE_KB",
	"YAOS_EXTERNAL_EDIT_POLICY",
	"YAOS_FRONTMATTER_GUARD",
	"YAOS_CONFIG_DIR",
] as const;

test("resolveCliConfig applies CLI > env > file precedence", async () => {
	const originalEnv = snapshotEnv();
	const tempRoot = await mkdtemp(nodePath.join(os.tmpdir(), "yaos-cli-config-"));
	try {
		process.env.XDG_CONFIG_HOME = tempRoot;
		const configDir = nodePath.join(tempRoot, "yaos");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			nodePath.join(configDir, "cli.json"),
			JSON.stringify({
				host: "https://file.example",
				token: "file-token",
				vaultId: "file-vault",
				dir: "/file/vault",
				deviceName: "file-device",
				debug: false,
				excludePatterns: "from-file/",
				maxFileSizeKB: 111,
				externalEditPolicy: "never",
				frontmatterGuardEnabled: false,
				configDir: ".obsidian-file",
			}),
			"utf8",
		);

		process.env.YAOS_HOST = "https://env.example";
		process.env.YAOS_TOKEN = "env-token";
		process.env.YAOS_VAULT_ID = "env-vault";
		process.env.YAOS_DIR = "/env/vault";
		process.env.YAOS_DEVICE_NAME = "env-device";
		process.env.YAOS_DEBUG = "true";
		process.env.YAOS_EXCLUDE_PATTERNS = "from-env/";
		process.env.YAOS_MAX_FILE_SIZE_KB = "222";
		process.env.YAOS_EXTERNAL_EDIT_POLICY = "closed-only";
		process.env.YAOS_FRONTMATTER_GUARD = "true";
		process.env.YAOS_CONFIG_DIR = ".obsidian-env";

		const resolved = await resolveCliConfig({
			host: "https://flag.example",
			token: "flag-token",
			vaultId: "flag-vault",
			dir: "/flag/vault",
			deviceName: "flag-device",
			debug: false,
			excludePatterns: "from-flag/",
			maxFileSizeKB: 333,
			externalEditPolicy: "always",
			configDir: ".obsidian-flag",
		});

		assert.equal(resolved.host, "https://flag.example");
		assert.equal(resolved.token, "flag-token");
		assert.equal(resolved.vaultId, "flag-vault");
		assert.equal(resolved.dir, "/flag/vault");
		assert.equal(resolved.deviceName, "flag-device");
		assert.equal(resolved.debug, false);
		assert.equal(resolved.excludePatterns, "from-flag/");
		assert.equal(resolved.maxFileSizeKB, 333);
		assert.equal(resolved.externalEditPolicy, "always");
		assert.equal(resolved.frontmatterGuardEnabled, true);
		assert.equal(resolved.configDir, ".obsidian-flag");
	} finally {
		restoreEnv(originalEnv);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("requireRuntimeConfig rejects missing required fields", () => {
	assert.throws(
		() => requireRuntimeConfig({
			deviceName: "device",
			debug: false,
			excludePatterns: "",
			maxFileSizeKB: 2048,
			externalEditPolicy: "always",
			frontmatterGuardEnabled: true,
			configDir: ".obsidian",
			configPath: "/tmp/cli.json",
		}, { requireDir: true }),
		/Missing required configuration: host, token, vaultId, dir/,
	);
});

function snapshotEnv(): Record<string, string | undefined> {
	return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
	for (const key of ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
