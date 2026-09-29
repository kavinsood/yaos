/**
 * K2 sample body. Runs INSIDE a worker_thread (see k2-worker.mjs), in a child
 * process which the orchestrator may duty-cycle with SIGSTOP/SIGCONT.
 *
 * One sample = cold process: load the fixture into a Y.Doc (device already
 * has the note loaded — reported, not part of reset cost), gc, CPU
 * calibration loop, phase-1 policy measurement, fresh-doc build (builder.ts),
 * phase-2 confirm. All times are wall-clock performance.now() inside the
 * worker, so SIGSTOP time counts (that is the point of the throttle).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { buildFreshSnapshot } from "./builder";
import { confirmAfterBuild, evaluateClientTrigger } from "./policy";

export interface K2SampleInput {
	fixturePath: string;
	guid: string;
	calibrationIterations: number;
}

export interface K2SampleResult {
	loadMs: number;
	calibrationMs: number;
	policyMs: number;
	buildMs: number;
	resetTotalMs: number;
	timings: Record<string, number>;
	uploadBytes: number;
	base64UploadBytes: number;
	contentBytes: number;
	contentHash: string;
	snapshotSha256: string;
	before: { encodedStateBytes: number; totalStructs: number; deletedStructs: number };
	after: { encodedStateBytes: number; totalStructs: number; deletedStructs: number };
	phase1: { requestLease: boolean; urgency: string; reasons: string[] };
	phase2: { urgency: string; reasons: string[]; recommended: boolean; projectedReduction: number };
	heapBaselineBytes: number;
	heapAfterBytes: number;
}

type GcGlobal = typeof globalThis & { gc?: () => void };

/** Fixed CPU workload (SHA-256 chain) → wall ms; ratio vs desktop = effective slowdown. */
export function calibrate(iterations: number): number {
	const started = performance.now();
	let digest = Buffer.alloc(32, 7);
	const block = Buffer.alloc(64 * 1024, 3);
	for (let index = 0; index < iterations; index++) {
		digest = createHash("sha256").update(block).update(digest).digest();
	}
	if (digest.length !== 32) throw new Error("unreachable");
	return performance.now() - started;
}

function heapBytes(): number {
	const usage = process.memoryUsage();
	return usage.heapUsed + usage.external + usage.arrayBuffers;
}

export async function runSample(input: K2SampleInput): Promise<K2SampleResult> {
	const bytes = new Uint8Array(readFileSync(input.fixturePath));
	const loadStarted = performance.now();
	const doc = new Y.Doc({ guid: input.guid });
	Y.applyUpdate(doc, bytes, "k2-load");
	doc.getText("body");
	const loadMs = performance.now() - loadStarted;
	(globalThis as GcGlobal).gc?.();
	const heapBaselineBytes = heapBytes();
	const calibrationMs = calibrate(input.calibrationIterations);

	const policyStarted = performance.now();
	const state = { lastCompactedAt: null, postCompactionEncodedStateBytes: null };
	const verdict = evaluateClientTrigger(doc, state, Date.now());
	const policyMs = performance.now() - policyStarted;

	const fresh = await buildFreshSnapshot(doc, { before: verdict.measurement.census });
	const decision = confirmAfterBuild(fresh, state, Date.now());
	const heapAfterBytes = heapBytes();
	const result: K2SampleResult = {
		loadMs,
		calibrationMs,
		policyMs,
		buildMs: fresh.timings.totalMs,
		resetTotalMs: policyMs + fresh.timings.totalMs,
		timings: { ...fresh.timings },
		uploadBytes: fresh.snapshot.byteLength,
		base64UploadBytes: Math.ceil(fresh.snapshot.byteLength / 3) * 4,
		contentBytes: fresh.contentBytes,
		contentHash: fresh.contentHash,
		snapshotSha256: createHash("sha256").update(fresh.snapshot).digest("hex"),
		before: fresh.before,
		after: fresh.after,
		phase1: { requestLease: verdict.requestLease, urgency: verdict.decision.urgency, reasons: verdict.decision.reasons },
		phase2: {
			urgency: decision.urgency, reasons: decision.reasons,
			recommended: decision.semanticResetRecommended, projectedReduction: decision.projectedReduction,
		},
		heapBaselineBytes,
		heapAfterBytes,
	};
	doc.destroy();
	return result;
}
