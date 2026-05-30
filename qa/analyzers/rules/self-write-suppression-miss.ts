import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

const WINDOW_MS = 5_000;

/**
 * Rule: self-write suppression miss
 *
 * Flag when:
 *   disk.write.ok → disk.modify.observed → disk.event.not_suppressed
 *   for the same pathId within 5 seconds.
 *
 * This is a loop seed: YAOS wrote to disk, the write event was not suppressed,
 * so YAOS will re-ingest its own write back into the CRDT.
 */
const RELEVANT_KINDS = new Set(["disk.write.ok", "disk.event.not_suppressed"]);

export function checkSelfWriteSuppressionMiss(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	const hasDiskWriteOk = events.some((e) => e.kind === "disk.write.ok");
	if (!hasDiskWriteOk) {
		findings.push({
			rule: "self-write-suppression-miss",
			severity: "warning",
			eventSeqs: [],
			description:
				"COVERAGE: no disk.write.ok events seen — " +
				"self-write-suppression-miss rule could not fire (no CRDT→disk writes in this trace)",
		});
		return findings;
	}

	const byPathId = new Map<string, FlightEvent[]>();
	for (const e of events) {
		if (!e.pathId) continue;
		const list = byPathId.get(e.pathId) ?? [];
		list.push(e);
		byPathId.set(e.pathId, list);
	}

	for (const [pathId, evts] of byPathId) {
		const sorted = [...evts].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
		for (let i = 0; i < sorted.length; i++) {
			const e = sorted[i]!;
			if (e.kind !== "disk.write.ok") continue;

			const writeTs = e.ts;
			let sawModify = false;
			for (let j = i + 1; j < sorted.length; j++) {
				const next = sorted[j]!;
				if (next.ts - writeTs > WINDOW_MS) break;
				if (next.kind === "disk.modify.observed") {
					sawModify = true;
					continue;
				}
				if (sawModify && next.kind === "disk.event.not_suppressed") {
					findings.push({
						rule: "self-write-suppression-miss",
						severity: "hard",
						pathId,
						eventSeqs: [e.seq, next.seq],
						description:
							`disk.write.ok → disk.modify.observed → disk.event.not_suppressed ` +
							`within ${WINDOW_MS}ms for pathId=${pathId} — loop seed`,
					});
					break;
				}
			}
		}
	}

	return findings;
}
