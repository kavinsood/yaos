import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "../harness.ts";
import type { LiveIdentity } from "./liveIdentity.ts";

const HOST = "http://127.0.0.1:8787";
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
// here and is executed below; imported helpers and this driver are non-suites.
const LIVE_COMMANDS: readonly LiveCommand[] = [
	{ file: "membership.ts" },
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
const LIVE_NON_SUITES = ["fatalFrame.ts", "liveIdentity.ts", "run-live.ts"] as const;

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

function inheritedEnvWithoutSharedCredential(): NodeJS.ProcessEnv {
	const retiredCredentialName = ["SYNC", "TOKEN"].join("_");
	return Object.fromEntries(
		Object.entries(process.env).filter(([name]) => name !== retiredCredentialName),
	);
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
	identity: LiveIdentity,
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
				...inheritedEnvWithoutSharedCredential(),
				YAOS_TEST_HOST: identity.host,
				YAOS_TEST_DEVICE_TOKEN: identity.deviceToken,
				YAOS_TEST_VAULT_ID: identity.vaultId,
				YAOS_TEST_DEVICE_ID: identity.deviceId,
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

interface Capabilities {
	readonly claimed?: unknown;
}

interface ClaimResponse {
	readonly vaultId?: unknown;
	readonly pairingCode?: unknown;
}

interface EnrollmentResponse {
	readonly deviceToken?: unknown;
	readonly vaultId?: unknown;
	readonly deviceId?: unknown;
	readonly name?: unknown;
}

async function getCapabilities(): Promise<Capabilities> {
	const response = await fetch(`${HOST}/api/capabilities`);
	if (!response.ok) throw new Error(`capabilities probe failed (${response.status})`);
	return (await response.json()) as Capabilities;
}

async function claimAndEnroll(): Promise<LiveIdentity> {
	const before = await getCapabilities();
	if (before.claimed !== false) {
		throw new Error("fresh live Worker must start unclaimed");
	}

	const operatorRecoveryKey = randomBytes(32).toString("base64url");
	const claimResponse = await fetch(`${HOST}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	if (!claimResponse.ok) {
		throw new Error(`claim failed (${claimResponse.status}): ${await claimResponse.text()}`);
	}
	const claimed = (await claimResponse.json()) as ClaimResponse | null;
	if (typeof claimed?.vaultId !== "string" || !claimed.vaultId) {
		throw new Error("claim response missing vaultId");
	}
	if (typeof claimed.pairingCode !== "string" || !claimed.pairingCode) {
		throw new Error("claim response missing initial pairingCode");
	}

	const enrollResponse = await fetch(`${HOST}/enroll`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingCode: claimed.pairingCode, deviceName: "live-primary" }),
	});
	if (!enrollResponse.ok) {
		throw new Error(`initial enrollment failed (${enrollResponse.status}): ${await enrollResponse.text()}`);
	}
	const enrolled = (await enrollResponse.json()) as EnrollmentResponse | null;
	if (
		typeof enrolled?.deviceToken !== "string" || !enrolled.deviceToken
		|| typeof enrolled.vaultId !== "string" || !enrolled.vaultId
		|| typeof enrolled.deviceId !== "string" || !enrolled.deviceId
		|| typeof enrolled.name !== "string" || !enrolled.name
	) {
		throw new Error(`initial enrollment response was incomplete: ${JSON.stringify(enrolled)}`);
	}
	if (enrolled.vaultId !== claimed.vaultId) {
		throw new Error("initial enrollment returned a different vaultId than claim");
	}

	const after = await getCapabilities();
	if (after.claimed !== true) {
		throw new Error("Worker did not remain claimed after initial enrollment");
	}
	return {
		host: HOST,
		deviceToken: enrolled.deviceToken,
		vaultId: enrolled.vaultId,
		deviceId: enrolled.deviceId,
	};
}

async function main() {
	assertLiveAccountability();
	const persistDir = mkdtempSync(join(tmpdir(), "yaos-wrangler-"));
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
			// Short ticket TTL for the reconnect smoke test — allows
			// post-expiry reconnect to be exercised in seconds, not 5 minutes.
			"--var",
			"YAOS_TICKET_TTL_MS:8000",
		],
		{
			cwd: resolve("server"),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...inheritedEnvWithoutSharedCredential(),
				CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
			},
		},
	);
	const wranglerExit = new Promise<void>((resolvePromise) => {
		wrangler.once("exit", () => resolvePromise());
	});

	let output = "";
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 8_000) output = output.slice(-8_000);
	};
	if (!wrangler.stdout || !wrangler.stderr) {
		throw new Error("wrangler dev did not expose piped stdout/stderr");
	}
	wrangler.stdout.on("data", capture);
	wrangler.stderr.on("data", capture);

	try {
		await waitForWorker();
		const identity = await claimAndEnroll();
		for (const command of LIVE_COMMANDS) {
			await runCommand(
				"node",
				[
					...NODE_TS,
					`tests/live/${command.file}`,
					...(command.args ?? []),
				],
				identity,
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
		if (wrangler.exitCode === null) wrangler.kill("SIGTERM");
		await wranglerExit;
		rmSync(persistDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
