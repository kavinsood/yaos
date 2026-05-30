import type { FlightEvent } from "./flight-event";
import type { AnalyzerFinding } from "./report";

type Expectation = {
	name: string;
	scenarioIds: string[];
	requiredKinds: string[];
	forbiddenKinds?: string[];
	allowedReasons?: string[];
	pathFilter?: (event: FlightEvent) => boolean;
};

const ISSUE_25_FORCED_IDS = [
	"issue-25-editor-bound-loop-forced-recovery-local-only",
	"issue-25-editor-bound-loop-forced-recovery-crdt-only",
];

const S07G_IDS = [
	"s07g-rename-after-create",
	"s07g-rename-to-tombstoned-path",
	"s07g-rename-chain",
];

const EXPECTATIONS: Expectation[] = [
	{
		name: "issue-25-forced-recovery-local-only",
		scenarioIds: ["issue-25-editor-bound-loop-forced-recovery-local-only"],
		requiredKinds: [
			"recovery.decision",
			"recovery.apply.start",
			"recovery.apply.done",
		],
		forbiddenKinds: ["recovery.postcondition.failed", "recovery.quarantined"],
		// Strict branch-contract assertion.
		allowedReasons: ["bound-file-local-only-divergence"],
	},
	{
		name: "issue-25-forced-recovery-crdt-only",
		scenarioIds: ["issue-25-editor-bound-loop-forced-recovery-crdt-only"],
		requiredKinds: [
			"disk.modify.observed",
			"recovery.decision",
			"recovery.apply.start",
			"recovery.apply.done",
		],
		forbiddenKinds: ["recovery.postcondition.failed", "recovery.quarantined"],
		allowedReasons: [
			"bound-file-open-idle-disk-recovery",
			"bound-file-local-only-divergence",
		],
	},
	{
		// S07g scenarios must see disk.rename.observed and crdt.file.renamed.
		// No tombstone for the new path after rename (orphan-after-rename analyzer rule enforces this too).
		name: "s07g-rename",
		scenarioIds: S07G_IDS,
		requiredKinds: [
			"disk.rename.observed",
			"crdt.file.renamed",
		],
		forbiddenKinds: [],
	},
];

export function checkScenarioExpectations(
	events: FlightEvent[],
	scenarioId?: string,
): AnalyzerFinding[] {
	if (!scenarioId) return [];
	const expectations = EXPECTATIONS.filter((e) => e.scenarioIds.includes(scenarioId));
	if (expectations.length === 0) return [];

	const findings: AnalyzerFinding[] = [];
	for (const expectation of expectations) {
		for (const kind of expectation.requiredKinds) {
			const matches = events.filter((event) => {
				if (event.kind !== kind) return false;
				// Only apply reason filtering to recovery/reconcile kinds.
				if (expectation.allowedReasons?.length && event.kind.startsWith("recovery.")) {
					const reason = String((event.data as Record<string, unknown> | undefined)?.reason ?? event.reason ?? "");
					if (!expectation.allowedReasons.includes(reason)) return false;
				}
				if (expectation.pathFilter && !expectation.pathFilter(event)) return false;
				return true;
			});

			if (matches.length === 0) {
				findings.push({
					rule: "scenario-expectation-missing",
					severity: "hard",
					eventSeqs: [],
					description:
						`Scenario ${scenarioId} expected ${kind} for reasons ` +
						`${expectation.allowedReasons?.join(", ") ?? "(any)"} ` +
						"but none were observed in the trace.",
				});
			}
		}

		for (const kind of expectation.forbiddenKinds ?? []) {
			const matches = events.filter((event) => {
				if (event.kind !== kind) return false;
				if (expectation.allowedReasons?.length) {
					const reason = String((event.data as Record<string, unknown> | undefined)?.reason ?? event.reason ?? "");
					if (!expectation.allowedReasons.includes(reason)) return false;
				}
				if (expectation.pathFilter && !expectation.pathFilter(event)) return false;
				return true;
			});

			if (matches.length > 0) {
				findings.push({
					rule: "scenario-expectation-missing",
					severity: "hard",
					eventSeqs: matches.map((event) => event.seq).slice(0, 5),
					description:
						`Scenario ${scenarioId} forbids ${kind} for reasons ` +
						`${expectation.allowedReasons?.join(", ") ?? "(any)"} ` +
						"but the trace contains one.",
				});
			}
		}
	}

	return findings;
}
