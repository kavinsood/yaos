import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

const LOOP_THRESHOLD = 3;
const WINDOW_MS = 60_000;

/**
 * Rule: recovery loop
 *
 * Flag when the same pathId has recovery.decision events with the same
 * data.signature repeated >= 3 times within any 60-second window.
 * Also flags recovery.loop.detected events directly.
 */
const RELEVANT_KINDS = new Set(["recovery.loop.detected", "recovery.decision"]);

export function checkRecoveryLoop(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	const relevant = events.filter((e) => RELEVANT_KINDS.has(e.kind));
	if (relevant.length === 0) {
		findings.push({
			rule: "recovery-loop",
			severity: "warning",
			eventSeqs: [],
			description:
				"COVERAGE: no recovery.loop.detected or recovery.decision events seen — " +
				"recovery-loop rule heuristic could not run",
		});
	}

	// Directly emitted loop detection events
	for (const e of events) {
		if (e.kind === "recovery.loop.detected") {
			findings.push({
				rule: "recovery-loop",
				severity: "hard",
				pathId: e.pathId,
				opId: e.opId,
				eventSeqs: [e.seq],
				description: `recovery.loop.detected emitted for pathId=${e.pathId ?? "unknown"}`,
			});
		}
	}

	// Heuristic: same signature repeated >= LOOP_THRESHOLD times in WINDOW_MS
	const byPathId = new Map<string, FlightEvent[]>();
	for (const e of events) {
		if (e.kind !== "recovery.decision" || !e.pathId) continue;
		const list = byPathId.get(e.pathId) ?? [];
		list.push(e);
		byPathId.set(e.pathId, list);
	}

	for (const [pathId, evts] of byPathId) {
		// Group by signature
		const bySig = new Map<string, FlightEvent[]>();
		for (const e of evts) {
			const sig = String((e.data as Record<string, unknown> | undefined)?.signature ?? "unknown");
			const list = bySig.get(sig) ?? [];
			list.push(e);
			bySig.set(sig, list);
		}
		for (const [sig, sigEvts] of bySig) {
			if (sigEvts.length < LOOP_THRESHOLD) continue;
			// Sliding window
			for (let i = 0; i <= sigEvts.length - LOOP_THRESHOLD; i++) {
				const window = sigEvts.slice(i, i + LOOP_THRESHOLD);
				if (window[LOOP_THRESHOLD - 1]!.ts - window[0]!.ts <= WINDOW_MS) {
					findings.push({
						rule: "recovery-loop",
						severity: "hard",
						pathId,
						eventSeqs: window.map((e) => e.seq),
						description:
							`Recovery loop detected: pathId=${pathId} signature=${sig} ` +
							`repeated ${LOOP_THRESHOLD}x within ${WINDOW_MS}ms`,
					});
					break; // one finding per pathId+sig
				}
			}
		}
	}

	return findings;
}
