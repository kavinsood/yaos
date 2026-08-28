import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep } from "../harness.ts";
import type { LiveIdentity, LiveIdentityContext } from "./liveIdentity.ts";

const HOST = "http://127.0.0.1:8787";
const WRANGLER_BIN = resolve("server/node_modules/.bin/wrangler");
const SETTINGS_CONFIG_KEY = ".obsidian-live";
const NODE_TS = ["tests/run-typescript.mjs"];

interface LiveCommand {
	readonly file: string;
	readonly extraEnv?: Readonly<Record<string, string>>;
}

const LIVE_COMMANDS: readonly LiveCommand[] = [
	{ file: "membership.ts" },
	{ file: "schema-guard.ts" },
	{ file: "provider-manual-connect.ts" },
	{ file: "sync-client.ts" },
	{ file: "live-seed-check.ts", extraEnv: { YAOS_TEST_MODE: "seed" } },
	{ file: "snapshots.ts" },
	{ file: "hardening-worker.ts" },
	{ file: "ws-ticket-reconnect.ts" },
	{ file: "ws-admission-protocol.ts" },
	{ file: "settings-sync.ts" },
	{ file: "operator-destroy.ts" },
];
const LIVE_NON_SUITES = ["fatalFrame.ts", "liveIdentity.ts", "run-live.ts", "schema4Live.ts"] as const;

function assertLiveAccountability(): void {
	const actual = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".ts")).sort();
	const accounted = [...LIVE_COMMANDS.map(({ file }) => file), ...LIVE_NON_SUITES]
		.filter((name, index, names) => names.indexOf(name) === index)
		.sort();
	if (actual.length !== accounted.length || actual.some((name, index) => name !== accounted[index])) {
		const unaccounted = actual.filter((name) => !accounted.includes(name));
		const missing = accounted.filter((name) => !actual.includes(name));
		throw new Error(`tests/live accountability mismatch; unaccounted=[${unaccounted.join(", ")}], missing=[${missing.join(", ")}]`);
	}
}

function inheritedEnvWithoutSharedCredential(): NodeJS.ProcessEnv {
	const retiredCredentialName = ["SYNC", "TOKEN"].join("_");
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== retiredCredentialName));
}

async function waitForWorker(): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${HOST}/api/capabilities`)).status > 0) return;
		} catch {
			// Wrangler has not opened its listener yet.
		}
		await sleep(250);
	}
	throw new Error("Timed out waiting for wrangler dev to accept requests");
}

function runCommand(command: LiveCommand, context: LiveIdentityContext): Promise<void> {
	return new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn("node", [...NODE_TS, `tests/live/${command.file}`], {
			cwd: resolve("."),
			stdio: "inherit",
			env: {
				...inheritedEnvWithoutSharedCredential(),
				YAOS_TEST_HOST: context.deviceA.host,
				YAOS_TEST_VAULT_ID: context.deviceA.vaultId,
				YAOS_TEST_DEVICE_A_TOKEN: context.deviceA.deviceToken,
				YAOS_TEST_DEVICE_A_ID: context.deviceA.deviceId,
				YAOS_TEST_DEVICE_B_TOKEN: context.deviceB.deviceToken,
				YAOS_TEST_DEVICE_B_ID: context.deviceB.deviceId,
				YAOS_TEST_OPERATOR_RECOVERY_KEY: context.operatorRecoveryKey,
				YAOS_TEST_OPERATOR_COOKIE: context.operatorCookie,
				YAOS_TEST_SETTINGS_CONFIG_KEY: context.settingsConfigKey,
				...command.extraEnv,
			},
		});
		child.on("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else rejectPromise(new Error(`tests/live/${command.file} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
		});
		child.on("error", rejectPromise);
	});
}

interface ClaimResponse {
	readonly vaultId?: unknown;
	readonly pairingCode?: unknown;
}

interface EnrollmentResponse {
	readonly host?: unknown;
	readonly deviceToken?: unknown;
	readonly vaultId?: unknown;
	readonly deviceId?: unknown;
	readonly deviceName?: unknown;
	readonly vaultGeneration?: unknown;
	readonly originImport?: unknown;
}

async function enroll(pairingCode: string, deviceName: string, expectedVaultId: string, expectedOrigin: boolean): Promise<LiveIdentity> {
	const enrollmentRequestId = randomBytes(16).toString("base64url");
	const deviceId = randomBytes(16).toString("base64url");
	const deviceToken = randomBytes(32).toString("base64url");
	const response = await fetch(`${HOST}/enroll`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingCode, enrollmentRequestId, deviceId, deviceToken, deviceName }),
	});
	const enrolled = await response.json().catch(() => null) as EnrollmentResponse | null;
	if (!response.ok
		|| enrolled?.host !== HOST
		|| enrolled.vaultId !== expectedVaultId
		|| enrolled.deviceToken !== deviceToken
		|| enrolled.deviceId !== deviceId
		|| typeof enrolled.vaultGeneration !== "string" || !enrolled.vaultGeneration
		|| enrolled.originImport !== expectedOrigin
		|| enrolled.deviceName !== deviceName) {
		throw new Error(`enrollment ${deviceName} failed (${response.status}): ${JSON.stringify(enrolled)}`);
	}
	return { host: HOST, vaultId: expectedVaultId, deviceToken: enrolled.deviceToken, deviceId: enrolled.deviceId };
}

async function claimEnrollAndProvision(): Promise<LiveIdentityContext> {
	const before = await fetch(`${HOST}/api/capabilities`).then((response) => response.json()) as { claimed?: unknown };
	if (before.claimed !== false) throw new Error("fresh live Worker must start unclaimed");
	const operatorRecoveryKey = randomBytes(32).toString("base64url");
	const claimResponse = await fetch(`${HOST}/claim`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	const claim = await claimResponse.json().catch(() => null) as ClaimResponse | null;
	if (!claimResponse.ok || typeof claim?.vaultId !== "string" || typeof claim.pairingCode !== "string") {
		throw new Error(`claim failed (${claimResponse.status}): ${JSON.stringify(claim)}`);
	}
	const deviceA = await enroll(claim.pairingCode, "live-device-a", claim.vaultId, true);
	const pairingResponse = await fetch(`${HOST}/vault/${encodeURIComponent(claim.vaultId)}/auth/pairing-code`, {
		method: "POST",
		headers: { Authorization: `Bearer ${deviceA.deviceToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ purpose: "device" }),
	});
	const pairing = await pairingResponse.json().catch(() => null) as { pairingCode?: unknown } | null;
	if (!pairingResponse.ok || typeof pairing?.pairingCode !== "string") {
		throw new Error(`device B pairing failed (${pairingResponse.status}): ${JSON.stringify(pairing)}`);
	}
	const deviceB = await enroll(pairing.pairingCode, "live-device-b", claim.vaultId, false);
	if (deviceA.deviceId === deviceB.deviceId) throw new Error("A and B enrollment returned the same device identity");

	const statusResponse = await fetch(`${HOST}/vault/${encodeURIComponent(claim.vaultId)}/status`, {
		headers: { Authorization: `Bearer ${deviceA.deviceToken}` },
	});
	const status = await statusResponse.json().catch(() => null) as Record<string, unknown> | null;
	if (!statusResponse.ok || status?.vaultId !== claim.vaultId || status.schemaVersion !== 4 || status.protocolVersion !== 1
		|| typeof status.vaultGeneration !== "string" || typeof status.runtimeEpoch !== "string") {
		throw new Error(`claimed vault was not active and provisioned: ${JSON.stringify(status)}`);
	}

	const login = await fetch(`${HOST}/operator/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryKey }),
	});
	const setCookie = login.headers.get("set-cookie");
	if (!login.ok || !setCookie) throw new Error(`operator login failed (${login.status})`);
	const operatorCookie = setCookie.split(";", 1)[0]!;
	console.log("Live driver claimed and provisioned schema 4, then enrolled distinct A/B devices.");
	return { deviceA, deviceB, operatorRecoveryKey, operatorCookie, settingsConfigKey: SETTINGS_CONFIG_KEY };
}

async function main(): Promise<void> {
	assertLiveAccountability();
	const persistDir = mkdtempSync(join(tmpdir(), "yaos-wrangler-"));
	const wrangler = spawn(WRANGLER_BIN, [
		"dev", "--ip", "127.0.0.1", "--port", "8787", "--local-protocol", "http",
		"--persist-to", persistDir, "--log-level", "error",
	], {
		cwd: resolve("server"),
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...inheritedEnvWithoutSharedCredential(), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
	});
	const wranglerExit = new Promise<void>((resolvePromise) => { wrangler.once("exit", () => resolvePromise()); });
	let output = "";
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 8_000) output = output.slice(-8_000);
	};
	if (!wrangler.stdout || !wrangler.stderr) throw new Error("wrangler dev did not expose piped output");
	wrangler.stdout.on("data", capture);
	wrangler.stderr.on("data", capture);
	try {
		await waitForWorker();
		const context = await claimEnrollAndProvision();
		for (const command of LIVE_COMMANDS) await runCommand(command, context);
	} catch (error) {
		if (output.trim()) console.error(`\n[wrangler output]\n${output.trim()}`);
		throw error;
	} finally {
		if (wrangler.exitCode === null) wrangler.kill("SIGTERM");
		await wranglerExit;
		rmSync(persistDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
