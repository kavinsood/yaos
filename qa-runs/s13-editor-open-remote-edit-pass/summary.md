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
| No forbidden passive-window disk_crdt_mismatch | ✓ |
| Transient active-editor disk lag observed and resolved | ✓ (seq=1207, resolved at seq=1208) |
| No persistent disk_crdt_mismatch after final settle | ✓ |
| analyzeConvergenceEvidence | ✓ PASS |

## Finding: transient active-editor disk lag (classified, not a correctness failure)

`analyzeWitnessQuorum` observed one `disk_crdt_mismatch` on Device A at step 1 (seq=1207).

**Conditions at time of observation:**
- `fileOpen: true` — A had just opened the file in the editor
- `editorSampleKind: healthy_sampled` — editor binding was healthy
- `editorHash === crdtHash` — editor and CRDT agreed; only disk lagged
- Resolved at seq=1208 (next stability window)

**Classification: `transient_open_editor_disk_lag` (diagnostic severity, not correctness failure)**

Root cause: DiskMirror's `scheduleOpenWrite` defers the disk write by `OPEN_FILE_IDLE_MS = 1500ms` when a file is opened in the editor. The witness stability window (2000ms) can fire during this deferral window. Since `editorHash === crdtHash`, the editor and CRDT are in sync — only the disk write is pending. This is categorically different from a real `disk_crdt_mismatch` where the editor is also wrong.

This is the same class as the "external persistence detected, merged" notification observed on Android. Whether that notification is harmless transient lag or a mobile-specific issue requires the `s13-linux-android` run to determine.

**Not a data-loss bug. Real Layer 4 taxonomy gap. Needs Android s13 to close.**
