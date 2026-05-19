# s12a-linux-android — REAL DEVICE PASS

**Label**: s12a Linux desktop + Android phone (real device validation)
**Date**: 2026-05-19T06:44:00Z
**scenarioRunId**: s12a-linux-android-2026-05-19
**qaTraceSecretHash**: sha256:9eaa2ab7e85695a5d8c4fc7c12f78239dcb6c3e73f308a79e69ba25f873bd894

| Device | ID | Platform | Hash at step 1 |
|--------|-----|----------|----------------|
| Linux desktop | 1ad8cf31 | desktop | h:30bb49cb... |
| Android (device-mn04msol) | 0e2465b7 | android | h:30bb49cb... |

**Result**: PASS — 6/6 analyzer rules

**Convergence proof**: Both devices settled with h:30bb49cbf404caf1dad447eac9310e34 at step 1.
Android editorSampleKind: healthy_sampled (editor open, hash matches CRDT and disk).
No stale rewinds. No recovery issues.

**What this proves**:
- Android command palette workflow works (Set scenario run ID, Advance scenario step, Refresh witness, Export witness bundle)
- Android Modal input works for QA commands
- Android clipboard bundle export works
- Safe bundle contains no raw paths (containsRawPaths: false)
- qaTraceSecretHash matches across Linux and Android
- Offline analyzer accepts real cross-platform bundles
- analyzeConvergenceEvidence produces real positive proof from real devices
