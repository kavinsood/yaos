import { type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
	PROTOCOL_VERSION,
	SCHEMA_VERSION,
	STORAGE_FORMAT_VERSION,
	type Capability,
	type RuntimeName,
} from "../target.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const START_TIMEOUT_MS = 120_000;
const PORT_FREE_TIMEOUT_MS = 30_000;
const CAPABILITIES_PATH = "/api/capabilities";

export interface CrashEvidence {
	readonly pid: number;
	readonly signal: "SIGKILL";
	readonly dispatchId: string;
	readonly dispatchState: string;
}
export interface LaunchedRuntime {
	readonly runtime: RuntimeName;
	readonly capabilities: readonly Capability[];
	readonly baseUrl: string;
	restart(): Promise<void>;
	hardRestart(): Promise<void>;
	crashAtDispatchBarrier(captureId: string): Promise<CrashEvidence>;
	stop(): Promise<void>;
}

export interface RuntimeSpec {
	readonly runtime: RuntimeName;
	readonly capabilities: readonly Capability[];
	readonly port: number;
	spawn(): ChildProcess;
	waitForDispatchBarrier?(
		captureId: string,
		pause: () => void,
		resume: () => void,
	): Promise<{ readonly dispatchId: string; readonly state: string }>;
	cleanup(): void;
}

class OutputLog {
	#text = "";
	attach(child: ChildProcess): void {
		const append = (chunk: Buffer): void => {
			const text = chunk.toString();
			if (process.env.YAOS_CONF_VERBOSE === "1") process.stderr.write(`[${child.pid ?? "?"}] ${text}`);
			this.#text = (this.#text + text).slice(-24_000);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
	}
	dump(): string { return this.#text.trim() || "(no runtime output)"; }
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try { process.kill(-child.pid, signal); }
	catch { try { child.kill(signal); } catch { /* already gone */ } }
}

async function stopTree(child: ChildProcess, signal: NodeJS.Signals, graceMs: number | null): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	signalTree(child, signal);
	let timer: NodeJS.Timeout | undefined;
	if (graceMs !== null) {
		timer = setTimeout(() => signalTree(child, "SIGKILL"), graceMs);
		timer.unref();
	}
	await exited.promise;
	clearTimeout(timer);
}

export function terminateTree(child: ChildProcess, graceMs = 5_000): Promise<void> {
	return stopTree(child, "SIGTERM", graceMs);
}
function delay(ms: number): Promise<void> {
	const delayed = Promise.withResolvers<void>();
	setTimeout(delayed.resolve, ms);
	return delayed.promise;
}


async function waitForPortFree(port: number): Promise<void> {
	const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const available = Promise.withResolvers<boolean>();
		const probe = createServer();
		probe.once("error", () => available.resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => available.resolve(true)));
		if (await available.promise) return;
		await delay(50);
	}
	throw new Error(`port ${port} remained held after process-tree teardown`);
}


function capabilityDocumentError(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "response was not a JSON object";
	const document = value as Record<string, unknown>;
	if (document.schemaVersion !== SCHEMA_VERSION) return `schemaVersion was ${JSON.stringify(document.schemaVersion)}`;
	if (document.storageFormatVersion !== STORAGE_FORMAT_VERSION) {
		return `storageFormatVersion was ${JSON.stringify(document.storageFormatVersion)}`;
	}
	if (document.protocolVersion !== PROTOCOL_VERSION) return `protocolVersion was ${JSON.stringify(document.protocolVersion)}`;
	if (typeof document.claimed !== "boolean") return "claimed was not boolean";
	return null;
}

async function waitForCapabilities(child: ChildProcess, url: string): Promise<void> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	let last = "no response";
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("runtime exited before readiness");
		let response: Response;
		try {
			response = await fetch(url);
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
			await delay(100);
			continue;
		}
		if (!response.ok) throw new Error(`capabilities readiness returned HTTP ${response.status}`);
		const value: unknown = await response.json().catch(() => null);
		const invalid = capabilityDocumentError(value);
		if (invalid !== null) throw new Error(`invalid schema-${SCHEMA_VERSION} capabilities document: ${invalid}`);
		return;
	}
	throw new Error(`timed out waiting for ${url}: ${last}`);
}

async function crashPausedTree(child: ChildProcess): Promise<Omit<CrashEvidence, "dispatchId" | "dispatchState">> {
	if (child.pid === undefined) throw new Error("runtime has no process id at crash barrier");
	const pid = child.pid;
	await stopTree(child, "SIGKILL", null);
	if (child.signalCode !== "SIGKILL") {
		throw new Error(`runtime did not exit under SIGKILL at crash barrier (code=${String(child.exitCode)}, signal=${String(child.signalCode)})`);
	}
	return { pid, signal: "SIGKILL" };
}

async function boot(spec: RuntimeSpec, log: OutputLog): Promise<ChildProcess> {
	const child = spec.spawn();
	log.attach(child);
	try {
		await waitForCapabilities(child, `http://127.0.0.1:${spec.port}${CAPABILITIES_PATH}`);
		return child;
	} catch (error) {
		await terminateTree(child, 1_000).catch(() => undefined);
		throw error;
	}
}

export async function launchProcessRuntime(spec: RuntimeSpec): Promise<LaunchedRuntime> {
	const log = new OutputLog();
	let child: ChildProcess;
	try { child = await boot(spec, log); }
	catch (error) {
		spec.cleanup();
		throw new Error(`${spec.runtime} failed to start: ${String(error)}\n${log.dump()}`);
	}
	let stopped = false;
	const baseUrl = `http://127.0.0.1:${spec.port}`;
	async function reboot(): Promise<void> {
		await waitForPortFree(spec.port);
		try { child = await boot(spec, log); }
		catch (error) { throw new Error(`${spec.runtime} failed to restart: ${String(error)}\n${log.dump()}`); }
	}
	return {
		runtime: spec.runtime,
		capabilities: spec.capabilities,
		baseUrl,
		async restart() {
			if (stopped) throw new Error("runtime is stopped");
			await terminateTree(child);
			await reboot();
		},
		async hardRestart() {
			if (stopped) throw new Error("runtime is stopped");
			await stopTree(child, "SIGKILL", null);
			await reboot();
		},
		async crashAtDispatchBarrier(captureId) {
			if (stopped) throw new Error("runtime is stopped");
			if (!spec.waitForDispatchBarrier) throw new Error(`${spec.runtime} does not expose a recovery dispatch barrier`);
			let paused = false;
			const pause = (): void => {
				if (paused) return;
				signalTree(child, "SIGSTOP");
				paused = true;
			};
			const resume = (): void => {
				if (!paused) return;
				signalTree(child, "SIGCONT");
				paused = false;
			};
			let dispatch: { readonly dispatchId: string; readonly state: string };
			try { dispatch = await spec.waitForDispatchBarrier(captureId, pause, resume); }
			catch (error) {
				resume();
				throw error;
			}
			if (!paused) throw new Error("dispatch barrier returned without pausing the runtime");
			const crash = await crashPausedTree(child);
			await reboot();
			return { ...crash, dispatchId: dispatch.dispatchId, dispatchState: dispatch.state };
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			await terminateTree(child).catch(() => undefined);
			spec.cleanup();
		},
	};
}

export async function freePort(): Promise<number> {
	const result = Promise.withResolvers<number>();
	const server = createServer();
	server.once("error", result.reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		server.close(() => port > 0 ? result.resolve(port) : result.reject(new Error("no ephemeral port")));
	});
	return result.promise;
}
