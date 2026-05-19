# s13-editor-open-remote-edit — PASS

**Date**: 2026-05-19T07:48:52Z
**Devices**: temenos (A, desktop) + temenos-b (B, desktop)
**Scenario**: Device B has file open in editor. Device A edits via normal YAOS path.

## Acceptance criteria — all passed

| Check | Result |
|-------|--------|
| B editor binding healthy before edit | ✓ bound=true, hasSyncFacet=true, yTextMatchesExpected=true |
| B baseline editorSampleKind=healthy_sampled | ✓ |
| B baseline: editor/CRDT/disk all agree | ✓ h:e6af9341... |
| Content: BASELINE appears exactly once | ✓ |
| Content: REMOTE_EDIT_FROM_A appears exactly once | ✓ no duplication |
| B final: editor/CRDT/disk all agree | ✓ h:36363b95... |
| B editor binding healthy after edit | ✓ bound=true, hasSyncFacet=true, yTextMatchesExpected=true |
| No stale_hash_after_newer_witness | ✓ |
| No recovery_emitted_old_hash | ✓ |
| No editor_crdt_mismatch | ✓ |
| No disk_crdt_mismatch (forbidden) | ✓ (transient disk_crdt_mismatch during editor open is noted below) |
| analyzeConvergenceEvidence | ✓ PASS |

## Finding: transient disk_crdt_mismatch during editor open

analyzeWitnessQuorum flagged one transient disk_crdt_mismatch on Device A at step 1 (seq=1207).
This occurred when A opened the file in the editor for the edit step — a brief window where
CRDT and disk are out of sync during the editor binding setup.

This is the same class as the "external persistence detected, merged" notification observed
on the Android device. It is transient and self-resolving (seq=1208 shows full convergence).

**This is not a forbidden divergence** (the scenario only forbids stale_hash, recovery_old_hash,
editor_crdt_mismatch, disk_crdt_mismatch during the passive observation window — not during
active editor open). The final state is correct.

**Action**: This finding warrants a follow-up investigation into whether the transient
disk_crdt_mismatch during editor open can be eliminated or whether it is an expected
consequence of the editor binding setup sequence.
