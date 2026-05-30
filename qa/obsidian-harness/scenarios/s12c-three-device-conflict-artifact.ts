/**
 * s12c-three-device-conflict-artifact — Manual three-device scenario
 *
 * Validates the s11b v2 conflict policy under three-device conditions:
 *   - Device B (iPad) is disabled during concurrent edits from A and C
 *   - On re-enable, disk wins on Device B's main file (S12C-LOCAL)
 *   - Conflict artifact is local-only on Device B (not synced to A or C)
 *   - A and C agree on the original-path survivor hash
 *
 * Manual-only: no CDP automation.
 * See engineering/multi-device-witness-runbook.md for step-by-step instructions.
 */

export const SCENARIO_ID = "s12c-three-device-conflict-artifact";
export const SCENARIO_VERSION = 1;

/**
 * Manual script steps:
 *
 * STEP 0 — Pre-trace identity check (all devices)
 *
 * STEP 1 — Set scenario run ID (all devices)
 *   scenarioRunId: <shared UUID>
 *   scenarioId: "s12c-three-device-conflict-artifact"
 *
 * STEP 2 — Start flight trace (all devices, qa-safe mode)
 *
 * STEP 3 — Establish baseline (all devices)
 *   All three devices open "QA-scratch/s12c-witness.md" with content "S12C-BASELINE".
 *   Trigger dirty + wait for quorum.
 *   Advance to step 1, label: "baseline-quorum"
 *
 * STEP 4 — Disable YAOS on Device B (iPad)
 *   Device B: disable YAOS plugin (Settings → Community plugins → YAOS → disable).
 *
 * STEP 5 — Concurrent edits (Device A and C)
 *   Device A: edit note, add "S12C-REMOTE-A"
 *   Device C: edit note, add "S12C-REMOTE-C"
 *   Wait for A and C to sync with each other.
 *   Advance to step 2 on A and C, label: "concurrent-edits-synced"
 *
 * STEP 6 — Local edit on Device B (while YAOS disabled)
 *   Device B: edit "QA-scratch/s12c-witness.md" directly (e.g. via Files app or another editor).
 *   Content: "S12C-LOCAL"
 *
 * STEP 7 — Re-enable YAOS on Device B
 *   Device B: enable YAOS plugin.
 *   Wait for re-sync (30 seconds).
 *
 * STEP 8 — Verify conflict artifact on Device B
 *   Device B: check that a conflict artifact file exists at the standard YAOS conflict path.
 *   The artifact should contain "S12C-REMOTE" content (A+C CRDT merge).
 *   The original path "QA-scratch/s12c-witness.md" should contain "S12C-LOCAL" (disk wins).
 *
 * STEP 9 — Verify no conflict artifact on Device A and C
 *   Device A and C: confirm no conflict artifact file exists.
 *
 * STEP 10 — Advance to step 3 (all devices)
 *   stepIndex: 3, label: "post-resync-convergence"
 *   Trigger dirty on all devices for the original path.
 *   Wait for quorum.
 *
 * STEP 11 — Export bundles (all devices)
 *
 * STEP 12 — Analyze offline
 *   bun run qa:analyze-bundles -- <bundle-a> <bundle-b> <bundle-c>
 *
 * ACCEPTANCE CRITERIA:
 *   - Device A and C agree on original-path survivor hash (S12C-LOCAL content hash).
 *   - Device B's original path also contains S12C-LOCAL (disk wins policy).
 *   - Conflict artifact exists ONLY on Device B.
 *   - No stale_hash_after_newer_witness or recovery_emitted_old_hash on any device.
 *   - crossDeviceHashesEqual passes for all three devices on original path.
 *
 * IF ACTUAL BEHAVIOR DIVERGES:
 *   Do NOT modify this scenario to make it pass.
 *   A failing run indicates a real conflict-policy bug.
 *   Check in the failing artifacts under qa-runs/s12c-fail/.
 */

export const MANUAL_SCRIPT = {
	steps: [
		{ index: 0, label: "pre-trace-identity-check" },
		{ index: 1, label: "set-scenario-run-id" },
		{ index: 2, label: "start-flight-trace" },
		{ index: 3, label: "baseline-quorum" },
		{ index: 4, label: "disable-device-b" },
		{ index: 5, label: "concurrent-edits-a-c" },
		{ index: 6, label: "local-edit-device-b" },
		{ index: 7, label: "reenable-device-b" },
		{ index: 8, label: "post-resync-convergence" },
		{ index: 9, label: "export-bundles" },
	],
	targetPath: "QA-scratch/s12c-witness.md",
	expectedSurvivorContent: "S12C-LOCAL",
	expectedArtifactContentMarker: "S12C-REMOTE",
	artifactLocalOnlyDevice: "device-b",
	forbiddenDivergenceReasons: ["stale_hash_after_newer_witness", "recovery_emitted_old_hash"],
};
