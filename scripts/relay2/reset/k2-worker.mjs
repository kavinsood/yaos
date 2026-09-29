#!/usr/bin/env node
/**
 * K2 child process. Main thread: spawns ONE worker_thread that runs
 * k2-task.ts runSample() (via jiti, same aliases as tests/run-typescript.mjs
 * for yjs), polls the worker's V8 heap every 2 ms (Worker#getHeapStatistics is
 * serviced by a V8 interrupt, so it works while the worker is busy), and prints
 * one line `K2RESULT <json>` on stdout.
 *
 * Usage (spawned by k2.ts): node --expose-gc k2-worker.mjs '<json K2SampleInput>'
 */
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

if (isMainThread) {
	const input = JSON.parse(process.argv[2] ?? "{}");
	const worker = new Worker(new URL(import.meta.url), { workerData: input });
	let running = true;
	let samples = 0;
	let peakUsed = 0;
	let peakTotal = 0;
	let baseline = null;
	const poll = setInterval(async () => {
		if (!running) return;
		let stats;
		try { stats = await worker.getHeapStatistics(); } catch { return; }
		samples++;
		const total = stats.used_heap_size + stats.external_memory;
		if (baseline === null) baseline = total;
		peakUsed = Math.max(peakUsed, stats.used_heap_size);
		peakTotal = Math.max(peakTotal, total);
	}, 2);
	worker.on("message", (message) => {
		running = false;
		clearInterval(poll);
		if (message.error) {
			console.error(message.error);
			process.exitCode = 1;
		} else {
			process.stdout.write(`K2RESULT ${JSON.stringify({
				...message.result,
				heapSamples: samples,
				peakWorkerHeapUsedBytes: peakUsed,
				peakWorkerHeapPlusExternalBytes: peakTotal,
				firstSampleHeapPlusExternalBytes: baseline,
			})}\n`);
		}
		void worker.terminate();
	});
	worker.on("error", (error) => { running = false; clearInterval(poll); console.error(error); process.exitCode = 1; });
} else {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, {
		alias: { yjs: `${ROOT}node_modules/yjs/dist/yjs.mjs` },
		interopDefault: true,
	});
	try {
		const task = await jiti.import(`${ROOT}scripts/relay2/reset/k2-task.ts`);
		const result = await task.runSample(workerData);
		parentPort.postMessage({ result });
	} catch (error) {
		parentPort.postMessage({ error: String(error?.stack ?? error) });
	}
}
