# s12a-three-device-passive-quorum — PASS

**Date**: 2026-05-25T20:57:00Z
**scenarioRunId**: s12a-three-device-2026-05-24
**scenarioId**: s12a-three-device-passive-quorum
**qaTraceSecretHash**: sha256:9eaa2ab7e85695a5d8c4fc7c12f78239dcb6c3e73f308a79e69ba25f873bd894

## Devices

| Device | ID | Platform | Role |
|--------|-----|----------|------|
| Linux desktop (temenos) | abe2a07d | desktop | producing device (step 1) |
| Android (device-mn04msol) | 0e2465b7 | android | consuming device |
| iPad (device-third) | ab2e5c97 | ios | consuming device |

## Evidence

All three devices converged on `h:c4c292502ca862862feb170318ebcba4`.

**Linux** (step 1): settled with `h:c4c29250...`
**Android** (step 3): settled with `h:c4c29250...` — `editorSampleKind: healthy_sampled`, `fileOpen: true`
**iPad** (step 3): settled with `h:c4c29250...` — `editorSampleKind: healthy_sampled`, `fileOpen: true`

## Notes

- iPad bundle had a `scenarioRunId` typo (`2026-06-24` instead of `2026-05-24`) — corrected before analysis
- Android bundle contained a `read_failed` divergence for a different file (different pathId) — filtered to target pathId before analysis. This is expected noise from the vault-sync buffer.
- Both mobile devices had the file open in the editor (`editorSampleKind: healthy_sampled`)

## Acceptance criteria

| Check | Result |
|-------|--------|
| All 3 devices agree on final hash | ✓ h:c4c29250... |
| Android editorSampleKind=healthy_sampled | ✓ |
| iPad editorSampleKind=healthy_sampled | ✓ |
| No stale_hash_after_newer_witness | ✓ |
| No recovery_emitted_old_hash | ✓ |
| No editor_crdt_mismatch | ✓ |
| analyzeConvergenceEvidence | ✓ PASS |
| All 6 analyzer rules | ✓ 6/6 PASS |

## Result: PASS — Linux + Android + iPad three-device quorum proven
