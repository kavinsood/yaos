import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ALL_CAPABILITIES } from "../target.ts";
import { freePort, launchProcessRuntime, type LaunchedRuntime, REPO_ROOT } from "./runtime.ts";
const WRANGLER_CAPABILITIES = ALL_CAPABILITIES.filter(
	(capability) => capability !== "recovery-crash-resume",
);


export async function launchWrangler(): Promise<LaunchedRuntime> {
	const port = await freePort();
	const persistDir = mkdtempSync(join(tmpdir(), "yaos-conformance-wrangler-"));
	return launchProcessRuntime({
		runtime: "wrangler",
		capabilities: WRANGLER_CAPABILITIES,
		port,
		spawn() {
			const env = { ...process.env };
			delete env.SYNC_TOKEN;
			return spawn(resolve(REPO_ROOT, "server/node_modules/.bin/wrangler"), [
				"dev", "--ip", "127.0.0.1", "--port", String(port), "--local-protocol", "http",
				"--persist-to", persistDir, "--log-level", "error",
			], {
				cwd: resolve(REPO_ROOT, "server"), detached: true, stdio: ["ignore", "pipe", "pipe"],
				env: { ...env, CLOUDFLARE_INCLUDE_PROCESS_ENV: "false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
			});
		},
		cleanup() { rmSync(persistDir, { recursive: true, force: true }); },
	});
}
