/**
 * K2 duty-cycle governor (runs in a worker_thread of the orchestrator so its
 * Atomics.wait sleeps don't block the orchestrator's event loop).
 *
 * Throttles a whole child process with SIGSTOP/SIGCONT — the same mechanism
 * `cpulimit` uses on Linux/macOS. Period P, run window P·duty, stop window
 * P·(1−duty). Records the achieved duty (actual CONT→STOP windows over total).
 * On stop request (Int32 flag at index 0 set to 1) it always leaves the child
 * CONTinued.
 */
import { parentPort, workerData } from "node:worker_threads";

const { pid, duty, periodMs, flag } = workerData;
const control = new Int32Array(flag);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => { if (ms > 0) Atomics.wait(sleeper, 0, 0, ms); };
const runMs = periodMs * duty;
const stopMs = periodMs - runMs;
let running = 0;
let stopped = 0;
let cycles = 0;
const started = performance.now();
try {
	while (Atomics.load(control, 0) === 0) {
		const a = performance.now();
		process.kill(pid, "SIGCONT");
		sleep(runMs);
		const b = performance.now();
		process.kill(pid, "SIGSTOP");
		sleep(stopMs);
		const c = performance.now();
		running += b - a;
		stopped += c - b;
		cycles++;
	}
} catch {
	// child exited (ESRCH) — fine
} finally {
	try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
}
parentPort.postMessage({
	cycles, runningMs: running, stoppedMs: stopped, elapsedMs: performance.now() - started,
	achievedDuty: running / Math.max(1e-9, running + stopped), targetDuty: duty, periodMs,
});
