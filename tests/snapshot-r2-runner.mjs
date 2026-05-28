#!/usr/bin/env node
/**
 * Wrapper to run the R2 behavioral tests from the server directory
 * where miniflare is available as a dependency.
 *
 * Called by the regression runner as: node tests/snapshot-r2-runner.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = join(__dirname, "..", "server");
const testFile = join(serverDir, "tests", "snapshot-r2.ts");

const result = spawnSync("npx", ["tsx", testFile], {
	cwd: serverDir,
	stdio: "inherit",
	timeout: 120_000,
});

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}
