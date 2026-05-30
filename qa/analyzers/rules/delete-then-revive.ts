import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

const WINDOW_MS = 10_000;

/**
 * Rule: delete then revive without explicit cause
 *
 * Flag when crdt.file.tombstoned is followed by crdt.file.revived within
 * 10 seconds with NO disk.create.observed in between for the same pathId.
 */
const RELEVANT_KINDS = new Set([
	"crdt.file.tombstoned",
	"crdt.file.revived",
	"delete.remote.observed",
	"delete.disk.applied",
	"delete.preserved",
]);

export function checkDeleteThenRevive(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	const hasTombstone = events.some((e) => e.kind === "crdt.file.tombstoned");
	if (!hasTombstone) {
		findings.push({
			rule: "delete-then-revive",
			severity: "warning",
			eventSeqs: [],
			description:
				"COVERAGE: no crdt.file.tombstoned events seen — " +
				"delete-then-revive rule could not fire (no deletes in this trace)",
		});
		return findings;
	}

	// Warn on any delete.preserved — this is always worth investigating
	for (const e of events) {
		if (e.kind === "delete.preserved") {
			const reason = (e.data as Record<string, unknown> | undefined)?.reason ?? "unknown";
			findings.push({
				rule: "delete-then-revive",
				severity: "warning",
				pathId: e.pathId,
				eventSeqs: [e.seq],
				description:
					`delete.preserved: remote delete not applied for pathId=${e.pathId ?? "unknown"} — reason=${reason}. ` +
					`File stayed on disk; investigate if this is expected.`,
			});
		}
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
			if (e.kind !== "crdt.file.tombstoned") continue;

			// Look ahead within WINDOW_MS
			const tombstoneTs = e.ts;
			for (let j = i + 1; j < sorted.length; j++) {
				const next = sorted[j]!;
				if (next.ts - tombstoneTs > WINDOW_MS) break;
				if (next.kind === "disk.create.observed") break; // explicit local create — OK
				if (next.kind === "crdt.file.revived") {
					findings.push({
						rule: "delete-then-revive",
						severity: "warning",
						pathId,
						eventSeqs: [e.seq, next.seq],
						description:
							`crdt.file.tombstoned followed by crdt.file.revived within ${WINDOW_MS}ms ` +
							`with no disk.create.observed for pathId=${pathId}`,
					});
					break;
				}
			}
		}
	}

	return findings;
}
