/**
 * S10a / S10b — Issue #22: two-device passive-open scenarios (STUBS).
 *
 * These scenarios require the two-device QA controller infrastructure.
 * They cannot run as single-device in-Obsidian scenarios.
 *
 * S10a: Passive-device stale echo (the primary #22 bug class).
 * S10b: Repeated deletion soak with passive device (mirrors Video 2).
 *
 * These are defined here as documentation stubs. Implementation requires
 * adding them to qa/controllers/two-device.ts when the two-device QA
 * environment is available.
 *
 * ─── S10a: passive-device-stale-echo ───────────────────────────────────
 *
 * Steps:
 *   1. Both devices connected and synced.
 *   2. Open the same Markdown file on both devices.
 *   3. Device A: type in bursts for 2–3 minutes.
 *   4. Device A: delete a word/line, then continue typing.
 *   5. Device B: remain passive (no typing).
 *   6. Wait 60 seconds after last edit.
 *
 * Pass criteria:
 *   - Device A never sees deleted text reappear (no editor reversion).
 *   - Device B converges to Device A's final state.
 *   - No recovery.decision with reason "bound-file-open-idle-disk-recovery"
 *     on Device B during the active editing window.
 *   - No recovery-loop, unsafe-overwrite, or self-write-suppression-miss.
 *   - Final manifests match.
 *
 * Required trace chain:
 *   Device A editor change → CRDT local transaction → server receipt →
 *   Device B remote CRDT applied → Device B "disk lag" or "crdt-current" skip →
 *   no Device B recovery write back to CRDT → final manifests match.
 *
 * ─── S10b: passive-open-deletion-soak ──────────────────────────────────
 *
 * Steps:
 *   1. Both devices connected and synced.
 *   2. Create a file with repeated-structure content (checklist, 20 items).
 *   3. Open file on both devices.
 *   4. Device A: delete one checklist item every 2 seconds, 10 deletions total.
 *   5. Device B: remain passive.
 *   6. Wait 30 seconds for stabilization.
 *
 * Pass criteria:
 *   - Content length on both devices monotonically decreases (no reversions).
 *   - All 10 deletions are preserved on both devices.
 *   - No recovery events on Device B with reason "bound-file-open-idle-disk-recovery".
 *   - No recovery-loop, no content oscillation.
 *   - Final manifests match.
 *
 * Required trace chain:
 *   Same as S10a. Additionally: Device B file size must never increase
 *   after a deletion is applied.
 *
 * ─── Implementation notes ──────────────────────────────────────────────
 *
 * These must be implemented in qa/controllers/two-device.ts as:
 *   TWO_DEVICE_SCENARIOS["issue-22-passive-stale-echo"]
 *   TWO_DEVICE_SCENARIOS["issue-22-passive-deletion-soak"]
 *
 * They use the ObsidianClient remote debugging protocol to control both
 * instances. The Device B trace must be inspected for recovery events.
 *
 * Priority: HIGH. This is the only way to definitively prove #22 is fixed.
 * Blocked on: two Obsidian instances + shared server QA environment.
 */

// These are two-device scenarios — they cannot be QaScenario objects
// (which run inside a single Obsidian instance). They are registered
// in qa/controllers/two-device.ts instead.
//
// This file exists as documentation and as a findable reference for
// the issue #22 RCA regression plan.

export const S10A_SCENARIO_ID = "issue-22-passive-stale-echo";
export const S10B_SCENARIO_ID = "issue-22-passive-deletion-soak";
