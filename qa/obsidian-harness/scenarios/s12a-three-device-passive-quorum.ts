/**
 * s12a-three-device-passive-quorum — Manual three-device scenario
 *
 * Validates QuorumPolicy.kind = "all" across Linux + iPad foreground + Android foreground.
 * Manual-only: no CDP automation. Run via the runbook.
 *
 * See engineering/multi-device-witness-runbook.md for step-by-step instructions.
 */

export const SCENARIO_ID = "s12a-three-device-passive-quorum";
export const SCENARIO_VERSION = 1;

/**
 * Manual script steps (executed by QA author on each device via command palette):
 *
 * STEP 0 — Pre-trace identity check (all devices)
 *   Each device: "YAOS QA: Show device identity for QA"
 *   Verify: same qaTraceSecretHash prefix on all devices.
 *
 * STEP 1 — Set scenario run ID (all devices)
 *   Each device: "YAOS QA: Set scenario run ID"
 *   scenarioRunId: <shared UUID, e.g. "s12a-run-2026-05-17">
 *   scenarioId: "s12a-three-device-passive-quorum"
 *
 * STEP 2 — Start flight trace (all devices)
 *   Each device: "Start QA flight trace" (mode: qa-safe)
 *
 * STEP 3 — Advance to step 1 (all devices)
 *   Each device: "YAOS QA: Advance scenario step" → stepIndex: 1, label: "pre-action-baseline"
 *
 * STEP 4 — Open target note (all devices)
 *   Open "QA-scratch/s12a-witness.md" on all three devices.
 *   Wait for all devices to show the note loaded.
 *
 * STEP 5 — Trigger witness dirty (all devices)
 *   Each device: window.__YAOS_DEBUG__.__qaOnlyClearWitnessSuppressionUnsafe("QA-scratch/s12a-witness.md")
 *   Each device: window.__YAOS_DEBUG__.__qaOnlyTriggerWitnessDirtyUnsafe("QA-scratch/s12a-witness.md")
 *   Wait 5 seconds for stability window.
 *
 * STEP 6 — Advance to step 2 (all devices)
 *   Each device: "YAOS QA: Advance scenario step" → stepIndex: 2, label: "post-baseline-quorum"
 *
 * STEP 7 — Make an edit (Device A only)
 *   Device A: edit "QA-scratch/s12a-witness.md", add line "S12A-EDIT-1"
 *   Wait 5 seconds for sync propagation.
 *
 * STEP 8 — Advance to step 3 (all devices)
 *   Each device: "YAOS QA: Advance scenario step" → stepIndex: 3, label: "post-edit-convergence"
 *
 * STEP 9 — Trigger witness dirty (all devices)
 *   Each device: clear suppression + trigger dirty for "QA-scratch/s12a-witness.md"
 *   Wait 5 seconds.
 *
 * STEP 10 — Export bundles (all devices)
 *   Each device: "YAOS QA: Export witness bundle"
 *   Collect three bundle files.
 *
 * STEP 11 — Analyze offline
 *   bun run qa:analyze-bundles -- <bundle-a> <bundle-b> <bundle-c> --out qa-runs/s12a-pass/report.json
 *
 * ACCEPTANCE CRITERIA:
 *   - All three devices emitted device.witness.settled for the same stateHash at step 3.
 *   - No stale_hash_after_newer_witness or recovery_emitted_old_hash on any device.
 *   - analyzeConvergenceEvidence returns ok: true.
 */

export const MANUAL_SCRIPT = {
	steps: [
		{ index: 0, label: "pre-trace-identity-check", description: "Show device identity on all devices, verify matching qaTraceSecretHash" },
		{ index: 1, label: "set-scenario-run-id", description: "Set scenarioRunId and scenarioId on all devices" },
		{ index: 2, label: "start-flight-trace", description: "Start QA flight trace (qa-safe mode) on all devices" },
		{ index: 3, label: "pre-action-baseline", description: "Advance to step 1, open target note, trigger dirty, wait for quorum" },
		{ index: 4, label: "device-a-edit", description: "Device A edits note, wait for propagation" },
		{ index: 5, label: "post-edit-convergence", description: "Advance to step 3, trigger dirty on all devices, wait for quorum" },
		{ index: 6, label: "export-bundles", description: "Export witness bundle on all devices" },
		{ index: 7, label: "offline-analysis", description: "Run bun run qa:analyze-bundles over three bundles" },
	],
	targetPath: "QA-scratch/s12a-witness.md",
	policy: { kind: "all" as const },
	forbiddenDivergenceReasons: ["stale_hash_after_newer_witness", "recovery_emitted_old_hash"],
};
