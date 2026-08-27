import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "../harness.ts";

const HOST = "http://127.0.0.1:8787";
const VAULT_ID = `yaos-integration-${Date.now().toString(36)}`;
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");

// Loader flags every spawned suite needs. tests/live/*.ts are TypeScript, so
// bare `node` cannot load them; this is the same loader tests/run-suites.mjs
// uses for the regression buckets, which keeps the two entry points on one
// dialect.
//
// JITI_ALIAS is deliberately NOT mirrored from tests/run-suites.mjs. Live
// suites may import shared test helpers and product constants, but none loads
// Obsidian-dependent product modules or `@shared`; `partyserver` must never be
// replaced by a mock when the suite is talking to a real Worker. "yjs" already
// resolves to the single root copy here.
const NODE_TS = ["--import", "jiti/register"];
interface LiveCommand {
	readonly file: string;
	readonly args?: readonly string[];
	readonly extraEnv?: Readonly<Record<string, string>>;
}

// This is the single accountability list for tests/live. Every suite appears
// here and is executed below; the only non-suites are this driver and the
// fatal-frame helper imported by provider-facing suites.
const LIVE_COMMANDS: readonly LiveCommand[] = [
	{ file: "schema-guard.ts" },
	{ file: "provider-manual-connect.ts" },
	{ file: "sync-client.ts", args: ["smoke.md", "\n\nhello from worker integration pass 1"] },
	{ file: "sync-client.ts", args: ["smoke.md", "\n\nhello from worker integration pass 2"] },
	{ file: "live-seed-check.ts", extraEnv: { YAOS_TEST_MODE: "seed", YAOS_TEST_EXACT_PATH_COUNT: "false" } },
	{ file: "snapshots.ts" },
	{ file: "hardening-worker.ts" },
	{ file: "ws-ticket-reconnect.ts" },
	{ file: "ws-admission-protocol.ts" },
];
const LIVE_NON_SUITES = ["fatalFrame.ts", "run-live.ts"] as const;

function assertLiveAccountability(): void {
	const actual = readdirSync(new URL(".", import.meta.url))
		.filter((name) => name.endsWith(".ts"))
		.sort();
	const accounted = [
		...LIVE_COMMANDS.map(({ file }) => file),
		...LIVE_NON_SUITES,
	].filter((name, index, names) => names.indexOf(name) === index).sort();
	if (actual.length !== accounted.length || actual.some((name, index) => name !== accounted[index])) {
		const unaccounted = actual.filter((name) => !accounted.includes(name));
		const missing = accounted.filter((name) => !actual.includes(name));
		throw new Error(
			`tests/live accountability mismatch; unaccounted=[${unaccounted.join(", ")}], missing=[${missing.join(", ")}]`,
		);
	}
}

async function waitForWorker(): Promise<void> {
	const deadline = Date.now() + 15_000;
	const probeUrl = `${HOST}/api/capabilities`;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(probeUrl, { method: "GET" });
			if (res.status > 0) return;
		} catch {
			// Worker not accepting connections yet.
		}
		await sleep(250);
	}

	throw new Error("Timed out waiting for wrangler dev to accept requests");
}

function runCommand(
	cmd: string,
	args: string[],
	token: string,
	extraEnv: Record<string, string> = {},
): Promise<void> {
	// Executor form, not `Promise.withResolvers`: tsconfig.tests.json pins `lib`
	// to ES2023 because package.json engines.node is ">=20", and withResolvers
	// is an ES2024 API absent from Node 20.
	return new Promise<void>((resolvePromise, rejectPromise) => {
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

/** The subset of `POST /claim`'s body this driver asserts on. */
interface ClaimResponse {
	readonly obsidianUrl?: unknown;
}

/** The subset of `GET /api/capabilities` this driver asserts on. */
interface Capabilities {
	readonly claimed?: unknown;
	readonly authMode?: unknown;
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

	const payload = (await res.json()) as ClaimResponse | null;
	if (typeof payload?.obsidianUrl !== "string" || !payload.obsidianUrl.startsWith("obsidian://yaos?")) {
		throw new Error("claim response missing Obsidian setup URL");
	}

	const capabilities = (await fetch(`${HOST}/api/capabilities`).then((result) => result.json())) as Capabilities | null;
	if (capabilities?.claimed !== true || capabilities?.authMode !== "claim") {
		throw new Error("server did not enter claimed mode");
	}

	return token;
}

async function resolveAuthToken(defaultEnvToken: string): Promise<string> {
	const capabilitiesRes = await fetch(`${HOST}/api/capabilities`);
	if (!capabilitiesRes.ok) {
		throw new Error(`capabilities probe failed (${capabilitiesRes.status})`);
	}
	const capabilities = (await capabilitiesRes.json()) as Capabilities | null;
	if (capabilities?.claimed === true && capabilities?.authMode === "env") {
		return defaultEnvToken;
	}
	return await claimServer();
}

async function main() {
	assertLiveAccountability();
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
			// Short ticket TTL for the ws-ticket-reconnect smoke test — allows
			// post-expiry reconnect to be exercised in seconds, not 5 minutes.
			"--var",
			"YAOS_TICKET_TTL_MS:8000",
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
	const wranglerExit = new Promise<void>((resolvePromise) => {
		wrangler.once("exit", () => resolvePromise());
	});

	let output = "";
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 8_000) {
			output = output.slice(-8_000);
		}
	};
	if (!wrangler.stdout || !wrangler.stderr) {
		throw new Error("wrangler dev did not expose piped stdout/stderr");
	}
	wrangler.stdout.on("data", capture);
	wrangler.stderr.on("data", capture);

	try {
		await waitForWorker();
		const token = await resolveAuthToken(envToken);
		for (const command of LIVE_COMMANDS) {
			await runCommand(
				"node",
				[
					...NODE_TS,
					`tests/live/${command.file}`,
					...(command.args ?? []),
				],
				token,
				command.extraEnv ? { ...command.extraEnv } : {},
			);
		}
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
