/**
 * s12b-mobile-foregrounded-quorum — Manual three-device scenario
 *
 * Validates QuorumPolicy.kind = "required" with an explicitly-backgrounded optional device.
 * Proves the mobile-background guard end-to-end on real iPad + Android hardware.
 * Manual-only: no CDP automation.
 *
 * See engineering/multi-device-witness-runbook.md for step-by-step instructions.
 */

export const SCENARIO_ID = "s12b-mobile-foregrounded-quorum";
export const SCENARIO_VERSION = 1;

/**
 * Manual script steps:
 *
 * STEP 0 — Pre-trace identity check (all devices)
 *
 * STEP 1 — Set scenario run ID (all devices)
 *   scenarioRunId: <shared UUID>
 *   scenarioId: "s12b-mobile-foregrounded-quorum"
 *
 * STEP 2 — Start flight trace (all devices, qa-safe mode)
 *
 * STEP 3 — Background Device C (Android)
 *   Press Home on Device C (Android). Obsidian goes to background.
 *   Verify: Device C runtimeState = "background" via identity command.
 *
 * STEP 4 — Advance to step 1 (Device A and B only)
 *   Device A: "YAOS QA: Advance scenario step" → stepIndex: 1, label: "required-devices-baseline"
 *   Device B: same
 *   (Device C is backgrounded — skip step advance)
 *
 * STEP 5 — Trigger dirty on Device A and B
 *   Clear suppression + trigger dirty for "QA-scratch/s12b-witness.md" on A and B.
 *   Wait 5 seconds.
 *
 * STEP 6 — Verify Device C emits unavailable (not a failure)
 *   Device C should emit device.witness.diverged with reason: "unavailable" (background guard).
 *   This is expected and must NOT fail the scenario.
 *
 * STEP 7 — Advance to step 2 (Device A and B)
 *   stepIndex: 2, label: "quorum-with-optional-missing"
 *
 * STEP 8 — Export bundles (all three devices)
 *   Foreground Device C first, then export.
 *
 * STEP 9 — Analyze offline
 *   bun run qa:analyze-bundles -- <bundle-a> <bundle-b> <bundle-c>
 *
 * ACCEPTANCE CRITERIA:
 *   - Device A and B settled with expected hash.
 *   - Device C recorded as partial_optional_missing (not a failure).
 *   - Device C's only divergence is reason: "unavailable" (diagnostics-class, not sync-correctness).
 *   - analyzeConvergenceEvidence returns ok: true for required devices A and B.
 */

export const MANUAL_SCRIPT = {
	steps: [
		{ index: 0, label: "pre-trace-identity-check" },
		{ index: 1, label: "set-scenario-run-id" },
		{ index: 2, label: "start-flight-trace" },
		{ index: 3, label: "background-device-c" },
		{ index: 4, label: "required-devices-baseline" },
		{ index: 5, label: "quorum-with-optional-missing" },
		{ index: 6, label: "export-bundles" },
	],
	targetPath: "QA-scratch/s12b-witness.md",
	policy: {
		kind: "required" as const,
		required: ["device-a", "device-b"],
		optional: ["device-c"],
	},
	forbiddenDivergenceReasonsOnOptional: ["stale_hash_after_newer_witness", "recovery_emitted_old_hash"],
	allowedDivergenceReasonsOnOptional: ["unavailable"],
};
