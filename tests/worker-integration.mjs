import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOST = "http://127.0.0.1:8787";
const VAULT_ID = `yaos-integration-${Date.now().toString(36)}`;
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");

function wait(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitForWorker() {
	const deadline = Date.now() + 15_000;
	const probeUrl = `${HOST}/api/capabilities`;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(probeUrl, { method: "GET" });
			if (res.status > 0) return;
		} catch {
			// Worker not accepting connections yet.
		}
		await wait(250);
	}

	throw new Error("Timed out waiting for wrangler dev to accept requests");
}

function runCommand(cmd, args, token, extraEnv = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(cmd, args, {
			cwd: resolve("."),
			stdio: "inherit",
			env: {
				...process.env,
				YAOS_TEST_HOST: HOST,
				SYNC_TOKEN: token,
				YAOS_TEST_VAULT_ID: VAULT_ID,
				...extraEnv,
			},
		});

		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			rejectPromise(
				new Error(
					`${cmd} ${args.join(" ")} exited with ` +
					(signal ? `signal ${signal}` : `code ${code}`),
				),
			);
		});
		child.on("error", rejectPromise);
	});
}

async function claimServer() {
	const token = randomBytes(32).toString("hex");
	const res = await fetch(`${HOST}/claim`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ token }),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`claim failed (${res.status}): ${text}`);
	}

	const payload = await res.json();
	if (typeof payload?.obsidianUrl !== "string" || !payload.obsidianUrl.startsWith("obsidian://yaos?")) {
		throw new Error("claim response missing Obsidian setup URL");
	}

	const capabilities = await fetch(`${HOST}/api/capabilities`).then((result) => result.json());
	if (capabilities?.claimed !== true || capabilities?.authMode !== "claim") {
		throw new Error("server did not enter claimed mode");
	}

	return token;
}

async function resolveAuthToken(defaultEnvToken) {
	const capabilitiesRes = await fetch(`${HOST}/api/capabilities`);
	if (!capabilitiesRes.ok) {
		throw new Error(`capabilities probe failed (${capabilitiesRes.status})`);
	}
	const capabilities = await capabilitiesRes.json();
	if (capabilities?.claimed === true && capabilities?.authMode === "env") {
		return defaultEnvToken;
	}
	return await claimServer();
}

async function main() {
	const persistDir = mkdtempSync(join(tmpdir(), "yaos-wrangler-"));
	const envToken = randomBytes(32).toString("hex");
	const wrangler = spawn(
		WRANGLER_BIN,
		[
			"dev",
			"--ip",
			"127.0.0.1",
			"--port",
			"8787",
			"--local-protocol",
			"http",
			"--persist-to",
			persistDir,
			"--log-level",
			"error",
		],
		{
			cwd: resolve("server"),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
				CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
				SYNC_TOKEN: envToken,
			},
		},
	);
	const wranglerExit = new Promise((resolvePromise) => {
		wrangler.once("exit", resolvePromise);
	});

	let output = "";
	const capture = (chunk) => {
		output += chunk.toString();
		if (output.length > 8_000) {
			output = output.slice(-8_000);
		}
	};
	wrangler.stdout.on("data", capture);
	wrangler.stderr.on("data", capture);

	try {
		await waitForWorker();
		const token = await resolveAuthToken(envToken);
		await runCommand("node", [
			"tests/schema-guard.mjs",
		], token);
		await runCommand("node", [
			"tests/provider-manual-connect.mjs",
		], token);
		await runCommand("node", [
			"--import",
			"jiti/register",
			"tests/sync-client.ts",
			"smoke.md",
			"\n\nhello from worker integration pass 1",
		], token);
		await runCommand("node", [
			"--import",
			"jiti/register",
			"tests/sync-client.ts",
			"smoke.md",
			"\n\nhello from worker integration pass 2",
		], token);
		await runCommand("node", [
			"--import",
			"jiti/register",
			"tests/snapshots.ts",
		], token);
		await runCommand("node", [
			"tests/hardening-worker.mjs",
		], token);
	} catch (err) {
		if (output.trim()) {
			console.error("\n[wrangler output]");
			console.error(output.trim());
		}
		throw err;
	} finally {
		if (wrangler.exitCode === null) {
			wrangler.kill("SIGTERM");
		}
		await wranglerExit;
		rmSync(persistDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
