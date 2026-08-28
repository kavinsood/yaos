import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { basename, join } from "node:path";
import { launchNode, launchWrangler, type LaunchedRuntime } from "./launch/index.ts";
import { REPO_ROOT, terminateTree } from "./launch/runtime.ts";
import {
	ALL_CAPABILITIES,
	TARGET_ENV,
	type Capability,
	type ConformanceTarget,
	type DeviceIdentity,
	type EnrollmentReplay,
	type RuntimeName,
} from "./target.ts";

const FIXTURE_DIR = join(REPO_ROOT, "tests/conformance/fixtures");
const SILENCE_TIMEOUT_MS = 180_000;
const HARD_TIMEOUT_MS = 600_000;

/** Exact and shrink-only. Adding an entry accepts a regression and requires explicit review. */
const KNOWN_GAPS: Record<RuntimeName, readonly Capability[]> = {
	wrangler: ["recovery-crash-resume"],
	node: [],
};

interface Fixture { readonly name: string; readonly path: string }
interface FixtureResult { readonly status: "PASS" | "FAIL"; readonly detail: string }
interface RunResult { readonly runtime: RuntimeName; readonly fixture: string; readonly result: FixtureResult }

const children = new Set<ChildProcess>();
const runtimes = new Set<LaunchedRuntime>();

async function shutdownEverything(): Promise<void> {
	await Promise.all([...children].map((child) => terminateTree(child, 1_000).catch(() => undefined)));
	children.clear();
	await Promise.all([...runtimes].map((runtime) => runtime.stop().catch(() => undefined)));
	runtimes.clear();
}

function fixtures(only: string | null): Fixture[] {
	return readdirSync(FIXTURE_DIR)
		.filter((entry) => entry.endsWith(".ts") && !entry.startsWith("."))
		.map((entry) => ({ name: basename(entry, ".ts"), path: join(FIXTURE_DIR, entry) }))
		.filter((fixture) => only === null || fixture.name.includes(only))
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
	const parsed: unknown = await response.clone().json().catch(() => null);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}
async function requestObject(request: IncomingMessage): Promise<Record<string, unknown>> {
	let raw = "";
	for await (const chunk of request) {
		raw += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
		if (raw.length > 16_384) throw new Error("control request body is too large");
	}
	let value: unknown;
	try { value = JSON.parse(raw); }
	catch { throw new Error("control request body is not JSON"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("control request body is not an object");
	return value as Record<string, unknown>;
}

async function recoveryCaptureCrashBarrier(
	runtime: LaunchedRuntime,
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (typeof input.path !== "string" || !/^\/vault\/[^/]+\/recovery\/captures$/.test(input.path)) {
		throw new Error("recovery crash barrier requires a capture collection path");
	}
	if (typeof input.authorization !== "string" || !input.authorization.startsWith("Bearer ")) {
		throw new Error("recovery crash barrier requires bearer authorization");
	}
	const captureRequest = input.capture;
	if (!captureRequest || typeof captureRequest !== "object" || Array.isArray(captureRequest)) {
		throw new Error("recovery crash barrier requires a capture request");
	}
	const started = await fetch(`${runtime.baseUrl}${input.path}`, {
		method: "POST",
		headers: { authorization: input.authorization, "content-type": "application/json" },
		body: JSON.stringify(captureRequest),
	});
	const startedBody = await responseJson(started);
	if (started.status !== 202 || typeof startedBody?.captureId !== "string") {
		throw new Error(`recovery crash barrier could not start capture (${started.status}): ${JSON.stringify(startedBody)}`);
	}
	const captureId = startedBody.captureId;
	const crash = await runtime.crashAtDispatchBarrier(captureId);
	return {
		captureId,
		observedState: crash.dispatchState,
		dispatchId: crash.dispatchId,
		crashPid: crash.pid,
		crashSignal: crash.signal,
	};
}


async function enroll(baseUrl: string, pairingCode: string, deviceName: string, replay?: EnrollmentReplay): Promise<{ identity: DeviceIdentity; replay: EnrollmentReplay }> {
	const request: EnrollmentReplay = replay ?? {
		pairingCode,
		enrollmentRequestId: randomBytes(16).toString("base64url"),
		deviceId: randomBytes(16).toString("base64url"),
		deviceToken: randomBytes(32).toString("base64url"),
		deviceName,
	};
	const response = await fetch(`${baseUrl}/enroll`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
	});
	const body = await responseJson(response);
	if (!response.ok || body?.deviceId !== request.deviceId || body.deviceToken !== request.deviceToken
		|| typeof body.vaultId !== "string" || typeof body.vaultGeneration !== "string") {
		throw new Error(`enrollment failed (${response.status}): ${JSON.stringify(body)}`);
	}
	return {
		identity: { host: baseUrl, vaultId: body.vaultId, vaultGeneration: body.vaultGeneration, deviceId: request.deviceId, deviceToken: request.deviceToken },
		replay: request,
	};
}

async function provision(runtime: LaunchedRuntime, controlUrl: string): Promise<ConformanceTarget> {
	const operatorRecoveryKey = randomBytes(32).toString("base64url");
	const claimResponse = await fetch(`${runtime.baseUrl}/claim`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operatorRecoveryKey }),
	});
	const claim = await responseJson(claimResponse);
	if (!claimResponse.ok || typeof claim?.vaultId !== "string" || typeof claim.pairingCode !== "string") {
		throw new Error(`claim/provision failed (${claimResponse.status}): ${JSON.stringify(claim)}`);
	}
	let operatorCookie = claimResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
	if (!operatorCookie) {
		const login = await fetch(`${runtime.baseUrl}/operator/login`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operatorRecoveryKey }),
		});
		operatorCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		if (!login.ok || !operatorCookie) throw new Error(`operator login failed (${login.status})`);
	}
	const origin = await enroll(runtime.baseUrl, claim.pairingCode, "conformance-origin");
	if (origin.identity.vaultId !== claim.vaultId) throw new Error("origin enrollment returned the wrong vault");
	const pairingResponse = await fetch(`${runtime.baseUrl}/vault/${encodeURIComponent(origin.identity.vaultId)}/auth/pairing-code`, {
		method: "POST", headers: { authorization: `Bearer ${origin.identity.deviceToken}`, "content-type": "application/json" }, body: JSON.stringify({ purpose: "device" }),
	});
	const pairing = await responseJson(pairingResponse);
	if (!pairingResponse.ok || typeof pairing?.pairingCode !== "string") throw new Error(`second-device pairing failed (${pairingResponse.status})`);
	const second = await enroll(runtime.baseUrl, pairing.pairingCode, "conformance-peer");
	if (second.identity.vaultId !== origin.identity.vaultId || second.identity.deviceId === origin.identity.deviceId) {
		throw new Error("second enrollment did not produce an isolated device on the fixture vault");
	}
	return {
		runtime: runtime.runtime,
		baseUrl: runtime.baseUrl,
		controlUrl,
		capabilities: new Set(runtime.capabilities),
		deviceA: origin.identity,
		deviceB: second.identity,
		operatorRecoveryKey,
		operatorCookie,
		originEnrollment: origin.replay,
	};
}

async function controlServer(runtime: LaunchedRuntime): Promise<{ url: string; close(): Promise<void> }> {
	let lifecycle: Promise<void> = Promise.resolve();
	const server = createServer((request, response) => {
		void (async () => {
			const operation = request.method === "POST"
				&& (request.url === "/restart" || request.url === "/hard-restart" || request.url === "/recovery-capture-crash")
				? request.url
				: null;
			if (!operation) {
				request.resume();
				response.writeHead(404).end();
				return;
			}
			let input: Record<string, unknown> | null = null;
			if (operation === "/recovery-capture-crash") input = await requestObject(request);
			else request.resume();
			let result: Record<string, unknown> = { ok: true };
			const execute = async (): Promise<void> => {
				if (operation === "/restart") await runtime.restart();
				else if (operation === "/hard-restart") await runtime.hardRestart();
				else {
					if (!input) throw new Error("recovery crash barrier input is missing");
					result = { ok: true, ...(await recoveryCaptureCrashBarrier(runtime, input)) };
				}
			};
			const queued = lifecycle.then(execute, execute);
			lifecycle = queued.then(() => undefined, () => undefined);
			await queued;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
		})().catch((error: unknown) => {
			if (response.headersSent) return;
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: String(error) }));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("control server did not bind");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close() {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

function runFixture(fixture: Fixture, target: ConformanceTarget): Promise<FixtureResult> {
	const settled = Promise.withResolvers<FixtureResult>();
	const child = spawn(process.execPath, ["--import", "jiti/register", fixture.path], {
		cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, [TARGET_ENV]: JSON.stringify({ ...target, capabilities: [...target.capabilities] }) },
	});
	children.add(child);
	let lastActivity = Date.now();
	const started = lastActivity;
	let timeout: string | null = null;
	for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
		let pending = "";
		stream?.on("data", (chunk: Buffer) => {
			lastActivity = Date.now();
			pending += chunk.toString();
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) sink.write(`  [${fixture.name}] ${line}\n`);
		});
		stream?.on("end", () => { if (pending) sink.write(`  [${fixture.name}] ${pending}\n`); });
	}
	const watchdog = setInterval(() => {
		const now = Date.now();
		if (now - lastActivity > SILENCE_TIMEOUT_MS) timeout = `silent for ${SILENCE_TIMEOUT_MS / 1000}s`;
		else if (now - started > HARD_TIMEOUT_MS) timeout = `exceeded ${HARD_TIMEOUT_MS / 1000}s hard limit`;
		else return;
		void terminateTree(child, 1_000);
	}, 500);
	let done = false;
	const finish = (result: FixtureResult): void => {
		if (done) return;
		done = true;
		clearInterval(watchdog);
		children.delete(child);
		settled.resolve(result);
	};
	child.once("error", (error) => finish({ status: "FAIL", detail: `spawn failed: ${error.message}` }));
	child.once("exit", (code, signal) => {
		if (timeout) finish({ status: "FAIL", detail: timeout });
		else if (code === 0) finish({ status: "PASS", detail: "" });
		else finish({ status: "FAIL", detail: signal ? `signal ${signal}` : `exit ${String(code)}` });
	});
	return settled.promise;
}

function assertExactBaseline(runtime: LaunchedRuntime): void {
	const declared = new Set(runtime.capabilities);
	const gaps = ALL_CAPABILITIES.filter((capability) => !declared.has(capability));
	const baseline = KNOWN_GAPS[runtime.runtime];
	if (gaps.length !== baseline.length || gaps.some((gap) => !baseline.includes(gap))) {
		throw new Error(`${runtime.runtime} capability gaps diverged: expected [${baseline.join(", ")}], got [${gaps.join(", ")}]`);
	}
}

async function runOne(runtimeName: RuntimeName, fixture: Fixture): Promise<RunResult> {
	let runtime: LaunchedRuntime | null = null;
	let control: { url: string; close(): Promise<void> } | null = null;
	try {
		runtime = runtimeName === "wrangler" ? await launchWrangler() : await launchNode();
		runtimes.add(runtime);
		assertExactBaseline(runtime);
		control = await controlServer(runtime);
		const target = await provision(runtime, control.url);
		const result = await runFixture(fixture, target);
		return { runtime: runtimeName, fixture: fixture.name, result };
	} catch (error) {
		return { runtime: runtimeName, fixture: fixture.name, result: { status: "FAIL", detail: error instanceof Error ? error.message : String(error) } };
	} finally {
		await control?.close().catch(() => undefined);
		await runtime?.stop().catch(() => undefined);
		if (runtime) runtimes.delete(runtime);
	}
}

function parseArgs(argv: readonly string[]): { targets: RuntimeName[]; only: string | null; list: boolean } {
	let target = "both";
	let only: string | null = null;
	let list = false;
	for (const argument of argv) {
		if (argument === "--list") list = true;
		else if (argument.startsWith("--target=")) target = argument.slice("--target=".length);
		else if (argument.startsWith("--only=")) only = argument.slice("--only=".length);
		else throw new Error(`unknown argument ${argument}`);
	}
	if (target !== "both" && target !== "wrangler" && target !== "node") {
		throw new Error("--target must be wrangler, node, or both");
	}
	return { targets: target === "both" ? ["wrangler", "node"] : [target as RuntimeName], only, list };
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const selected = fixtures(options.only);
	if (options.list) {
		for (const fixture of selected) console.log(fixture.name);
		return;
	}
	if (selected.length === 0) throw new Error("no conformance fixtures selected");
	const results: RunResult[] = [];
	for (const runtime of options.targets) {
		for (const fixture of selected) {
			console.log(`\n== ${runtime} / ${fixture.name}`);
			const result = await runOne(runtime, fixture);
			results.push(result);
			console.log(`   ${result.result.status}${result.result.detail ? ` — ${result.result.detail}` : ""}`);
		}
	}
	console.log("\nConformance matrix");
	for (const fixture of selected) {
		console.log(`${fixture.name}: ${options.targets.map((runtime) => `${runtime}=${results.find((result) => result.runtime === runtime && result.fixture === fixture.name)?.result.status ?? "-"}`).join(" ")}`);
	}
	console.log("\nCapability matrix");
	for (const capability of ALL_CAPABILITIES) {
		console.log(
			`${capability}: ${options.targets.map((runtime) =>
				`${runtime}=${KNOWN_GAPS[runtime].includes(capability) ? "GAP" : "yes"}`).join(" ")}`,
		);
	}
	process.exitCode = results.some((result) => result.result.status === "FAIL") ? 1 : 0;
}

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
	if (interrupted) return;
	interrupted = true;
	void shutdownEverything().then(() => process.exit(130));
});

void main().catch(async (error: unknown) => {
	console.error(error instanceof Error ? error.stack ?? error.message : error);
	await shutdownEverything();
	process.exitCode = 1;
});
