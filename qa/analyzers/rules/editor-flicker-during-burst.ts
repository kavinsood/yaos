/**
 * Analyzer rule: editor-flicker-during-burst (Requirement 17)
 *
 * Hard finding when one device emits settled→diverged→settled within a tight
 * window (default 5 seconds) for one (deviceId, pathId) pair.
 *
 * "Before/after" is established by per-device local seq order (never wall-clock).
 * "Within 5 seconds" is evaluated using same-device monotonicMs deltas (Req 3.7).
 *
 * Pure function — no side effects, no Obsidian API.
 */

import type { FlightEvent } from "../flight-event";
import type { AnalyzerResult, Evidence } from "../../obsidian-harness/witness-primitives";

export interface EditorStabilitySpec {
	deviceId: string;
	pathId: string;
	/** Tight window in milliseconds. Default: 5000. */
	tightWindowMs?: number;
}

/**
 * analyzeEditorStability — pure function.
 *
 * Detects settled→diverged→settled within tightWindowMs using same-device
 * monotonicMs deltas (Requirement 3.7). Never uses wall-clock timestamps.
 *
 * If monotonicMs is absent on events, the duration check cannot be performed
 * and the rule emits a diagnostics finding rather than using wall-clock (B7).
 */
export function analyzeEditorStability(
	events: FlightEvent[],
	spec: EditorStabilitySpec,
): AnalyzerResult {
	const tightWindowMs = spec.tightWindowMs ?? 5000;

	// Filter to this device and pathId, sorted by local seq (before/after ordering)
	const relevant = events
		.filter(
			(e) =>
				e.deviceId === spec.deviceId &&
				e.pathId === spec.pathId &&
				(e.kind === "device.witness.settled" || e.kind === "device.witness.diverged"),
		)
		.sort((a, b) => a.seq - b.seq); // local seq ordering — never cross-device

	// Scan for settled → diverged → settled pattern
	for (let i = 0; i < relevant.length - 2; i++) {
		const e1 = relevant[i]!;
		const e2 = relevant[i + 1]!;
		const e3 = relevant[i + 2]!;

		if (
			e1.kind === "device.witness.settled" &&
			e2.kind === "device.witness.diverged" &&
			e3.kind === "device.witness.settled"
		) {
			// Duration check: use same-device monotonicMs ONLY (Requirement 3.7, B7).
			// Wall-clock (ts) is forbidden for correctness decisions.
			const mono1 = (e1 as unknown as { mono?: number }).mono ?? (e1.data as Record<string, unknown> | undefined)?.monotonicMs as number | undefined;
			const mono3 = (e3 as unknown as { mono?: number }).mono ?? (e3.data as Record<string, unknown> | undefined)?.monotonicMs as number | undefined;

			if (mono1 !== undefined && mono3 !== undefined) {
				// Same-device monotonic delta — correct per Requirement 3.7
				const durationMs = mono3 - mono1;
				if (durationMs > tightWindowMs) continue; // outside tight window
			} else {
				// monotonicMs absent — cannot determine duration; emit diagnostics finding
				// rather than using wall-clock (B7: wall-clock fallback is forbidden)
				return {
					ok: false,
					reason: "missing_monotonic_time",
					offendingDeviceId: spec.deviceId,
					offendingEventSeq: e2.seq,
					evidence: [
						{ kind: "settled", deviceId: spec.deviceId, pathId: spec.pathId, seq: e1.seq },
						{ kind: "diverged", deviceId: spec.deviceId, pathId: spec.pathId, seq: e2.seq, severity: "diagnostics" },
						{ kind: "settled", deviceId: spec.deviceId, pathId: spec.pathId, seq: e3.seq },
					],
					summary: `Editor flicker pattern detected on ${spec.deviceId} for pathId=${spec.pathId} but monotonicMs absent — cannot verify tight window without wall-clock`,
				};
			}

			const divergeReason = String((e2.data as Record<string, unknown> | undefined)?.reason ?? "unknown");
			const evidence: Evidence[] = [
				{ kind: "settled", deviceId: spec.deviceId, pathId: spec.pathId, seq: e1.seq },
				{ kind: "diverged", deviceId: spec.deviceId, pathId: spec.pathId, seq: e2.seq, data: e2.data as Record<string, unknown>, severity: "sync-correctness" },
				{ kind: "settled", deviceId: spec.deviceId, pathId: spec.pathId, seq: e3.seq },
			];

			return {
				ok: false,
				reason: "editor_flicker_during_burst",
				offendingDeviceId: spec.deviceId,
				offendingEventSeq: e2.seq,
				evidence,
				summary: `Editor flicker on ${spec.deviceId} for pathId=${spec.pathId}: settled→${divergeReason}→settled within tight window`,
			};
		}
	}

	return {
		ok: true,
		evidence: [],
		summary: `No editor flicker detected for ${spec.deviceId} pathId=${spec.pathId}`,
	};
}
