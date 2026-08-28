import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ALL_CAPABILITIES } from "../target.ts";
import { freePort, launchProcessRuntime, type LaunchedRuntime, REPO_ROOT } from "./runtime.ts";
const DISPATCH_BARRIER_TIMEOUT_MS = 10_000;

interface DispatchObservation {
	readonly state: string;
	readonly dispatchId: string | null;
	readonly inFlight: boolean;
}

function inspectRecoveryDispatch(dataDir: string, captureId: string): DispatchObservation | null {
	let entries: Dirent[];
	try { entries = readdirSync(join(dataDir, "jobs"), { withFileTypes: true }); }
	catch { return null; }
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
		let database: DatabaseSync | null = null;
		try {
			database = new DatabaseSync(join(dataDir, "jobs", entry.name), { readOnly: true });
			const job = database.prepare("SELECT job_id, state FROM job_state WHERE id = 1").get() as
				| { job_id?: unknown; state?: unknown }
				| undefined;
			if (typeof job?.job_id !== "string" || !job.job_id.endsWith(`:${captureId}`)
				|| typeof job.state !== "string") continue;
			const row = database.prepare("SELECT value_json FROM job_metadata WHERE key = 'dispatch-identity'").get() as
				| { value_json?: unknown }
				| undefined;
			let dispatchId: string | null = null;
			let inFlight = false;
			if (typeof row?.value_json === "string") {
				const value: unknown = JSON.parse(row.value_json);
				if (value && typeof value === "object" && !Array.isArray(value)) {
					const metadata = value as Record<string, unknown>;
					if (typeof metadata.dispatchId === "string") dispatchId = metadata.dispatchId;
					inFlight = dispatchId !== null && metadata.completedAt === null;
				}
			}
			return { state: job.state, dispatchId, inFlight };
		} catch {
			// The database or schema may not exist until capture initialization commits.
		} finally {
			database?.close();
		}
	}
	return null;
}

async function waitForRecoveryDispatch(
	dataDir: string,
	captureId: string,
	pause: () => void,
	resume: () => void,
): Promise<{ readonly dispatchId: string; readonly state: string }> {
	const deadline = Date.now() + DISPATCH_BARRIER_TIMEOUT_MS;
	let lastState = "unobserved";
	while (Date.now() < deadline) {
		pause();
		const stopped = Promise.withResolvers<void>();
		setTimeout(stopped.resolve, 1);
		await stopped.promise;
		let keepPaused = false;
		try {
			const observation = inspectRecoveryDispatch(dataDir, captureId);
			if (observation) {
				lastState = observation.state;
				if (observation.state === "complete" || observation.state === "complete_with_gaps"
					|| observation.state === "failed" || observation.state === "cancelled") {
					throw new Error(`recovery dispatch barrier was not exercised: capture reached ${observation.state} before an in-flight dispatch was observed`);
				}
				if (observation.inFlight && observation.dispatchId !== null
					&& (observation.state === "planning" || observation.state === "materializing"
						|| observation.state === "building" || observation.state === "publishing")) {
					keepPaused = true;
					return { dispatchId: observation.dispatchId, state: observation.state };
				}
			}
		} finally {
			if (!keepPaused) resume();
		}
		const running = Promise.withResolvers<void>();
		setTimeout(running.resolve, 1);
		await running.promise;
	}
	throw new Error(`recovery dispatch barrier was not exercised within ${DISPATCH_BARRIER_TIMEOUT_MS}ms (last state ${lastState})`);
}


export async function launchNode(): Promise<LaunchedRuntime> {
	const port = await freePort();
	const dataDir = mkdtempSync(join(tmpdir(), "yaos-conformance-node-"));
	return launchProcessRuntime({
		runtime: "node",
		capabilities: ALL_CAPABILITIES,
		port,
		spawn() {
			return spawn(process.execPath, ["--import", "jiti/register", "packages/server-node/src/index.ts"], {
				cwd: REPO_ROOT,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					YAOS_NODE_HOST: "127.0.0.1",
					YAOS_NODE_PORT: String(port),
					YAOS_NODE_DATA_DIR: dataDir,
				},
			});
		},
		waitForDispatchBarrier(captureId, pause, resume) {
			return waitForRecoveryDispatch(dataDir, captureId, pause, resume);
		},
		cleanup() { rmSync(dataDir, { recursive: true, force: true }); },
	});
}
