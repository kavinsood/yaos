# WITNESS-PHASE-2-VERIFICATION

Layer 4 Phase 2 — In-Memory Witness Aggregation Scaffold

**Merge label:** Layer 4 Phase 2 live QA scaffold (internal merge)

## Status

| Capability | Status |
|-----------|--------|
| In-memory witness segment buffer | operational |
| QA API read/export path | operational |
| Offline segment → FlightEvent[] → analyzer path | tested |
| Trace identity check (full SHA-256 qaTraceSecretHash) | operational |
| Recovery causality (real seq via reserveAndRecordPath) | operational |
| pathId in segments (resolved before write) | operational |
| `witnessQuorum` (strict mode) | operational |
| `witnessQuorumEventually` (eventual convergence mode) | operational |
| **s11a live CDP run** | **PASSED** |
| **s11b live CDP run** | **PASSED with semantic content verification** |

## D1 — Implementation Summary

| Feature | Status |
|---------|--------|
| cross-device assertion primitives | yes |
| `witnessQuorum` (strict) | yes |
| `witnessQuorumEventually` (eventual, records intermediate hashes) | yes |
| in-memory witness segment buffer | yes |
| segment export via QA API | yes |
| Device B live-buffer embedded in report when segments empty | yes |
| segment reader returns FlightEvent[] | yes |
| offline segment → analyzer path | yes — tested |
| analyzer rules | yes |
| recoveryStateHash precision path | yes |
| causedByEvents | yes |
| mobile-background guard | yes |
| getActiveTraceInfo with full SHA-256 qaTraceSecretHash | yes |
| s11a three-phase wired with live CDP | yes |
| **s11a live run** | **PASSED** |
| **s11b live run with semantic content verification** | **PASSED** |

Out of scope per spec:

| Feature | Status |
|---------|--------|
| relay through server / main CRDT | out of scope per spec |
| user UI | out of scope per spec |
| production device dashboard | out of scope per spec |
| filesystem checkpoint export | not implemented — in-memory only |

## D2 — Test Pass/Fail

| Test Suite | Exit Status | Pass/Fail Count |
|-----------|-------------|-----------------|
| `tests/device-witness-tracker.ts` (Phase 1) | 0 | 17 passed, 0 failed |
| `tests/device-witness-tracker-lifecycle.ts` (Phase 1) | 0 | 8 passed, 0 failed |
| `tests/device-witness-qa-api.ts` (Phase 1) | 0 | 8 passed, 0 failed |
| `tests/witness-schema.ts` (Gate 1) | 0 | 15 passed, 0 failed |
| `tests/witness-hash-normalization.ts` (Gate 2) | 0 | 18 passed, 0 failed |
| `tests/witness-checkpoint-isolation.ts` (Gate 3) | 0 | 7 passed, 0 failed |
| `tests/witness-checkpoint-rotation.ts` (Gate 3) | 0 | 9 passed, 0 failed |
| `tests/witness-checkpoint-offline.ts` (offline path) | 0 | 5 passed, 0 failed |
| `tests/witness-analyzer-purity.ts` (Gate 4) | 0 | 17 passed, 0 failed |
| `tests/witness-readonly-spy.ts` (Req 21.3) | 0 | 6 passed, 0 failed |
| `tests/witness-mobile-background.ts` (Req 19, 20) | 0 | 8 passed, 0 failed |
| `tests/witness-quorum-eventually.ts` (eventual quorum) | 0 | 6 passed, 0 failed |
| `tests/witness-s11b-semantics.ts` (s11b semantic contract) | 0 | 6 passed, 0 failed |
| **`s11a-passive-stale-echo-witness` (CDP)** | **PASSED** — 2026-05-16 |
| **`s11b-disable-reenable-witness` (CDP)** | **PASSED** — 2026-05-17 |
| `npm run test:regressions` | 0 | 52 passed, 7 failed (all pre-existing) |
| `npm run build` | 0 | clean |

## D3 — Pre-Existing Failure Baseline

Same 7 baseline failures, no new failures. These are pre-existing and not caused by Phase 2.

## D4 — Evidence Artifact Paths

| Artifact | Path |
|---------|------|
| **s11a Layer 4 report (PASS)** | `qa-runs/s11a-pass/layer4-report.json` |
| **s11a Device A witness segments** | `qa-runs/s11a-pass/witness-device-a.ndjson` |
| **s11b Layer 4 report (PASS, semantic)** | `qa-runs/s11b-pass/layer4-report.json` |
| **s11b Device A witness segments** | `qa-runs/s11b-pass/witness-device-a.ndjson` |
| **s11a failing run fixture** | `qa-runs/s11a-failing-fixture/layer4-report.json` |
| **s11b failing: no artifact** | `qa-runs/s11b-failing-no-artifact/layer4-report.json` |
| **s11b failing: artifact not on A** | `qa-runs/s11b-failing-artifact-not-on-a/layer4-report.json` |
| Sample `witnessQuorum` failure | `tests/fixtures/witness-evidence/witnessQuorum-failure.json` |
| Sample `stale_hash_after_newer_witness` failure | `tests/fixtures/witness-evidence/stale-hash-failure.json` |
| Sample `recovery_emitted_old_hash` failure | `tests/fixtures/witness-evidence/recovery-stale-failure.json` |
| Sample `cross_device_hash_mismatch` failure | `tests/fixtures/witness-evidence/cross-device-hash-mismatch.json` |

## D5 — Static Guard Output (smoke checks)

```
npm run guard:witness-readonly  → PASS
npm run guard:checkpoint-path   → PASS
npm run guard:no-vault-doc-diagnostics → PASS
```

## D6 — Acceptance Proof

### s11a-passive-stale-echo-witness — PASSED (2026-05-16)

**acceptanceVersion:** s11a-three-phase-v1

**Phase A — Pre-burst baseline:** PASSED — both devices settled with initial hash
**Phase B — Active burst (28s):** PASSED — no stale/recovery/editor divergences
**Phase C — Post-burst convergence:** PASSED
- Device A locally witnessed final hash `h:8cb7cd4f719a7e8cac2bcdf5f2947a47`
- Device B eventually converged to the same hash
- Device B evidence: embedded in Layer 4 report (source=live_buffer, 1 event, role=final)

**Acceptance statement:**
"A produced final hash H. A's tracker witnessed H with CRDT/disk/editor agreement. B witnessed H. No stale resurrection. No recovery emitted old state. B's convergence was legitimate lag, not stale resurrection."

### s11b-disable-reenable-witness — PASSED (2026-05-17)

**acceptanceVersion:** s11b-local-artifact-v2

**YAOS conflict policy (both-changed/winner=disk):**
- Disk wins main file → original path has B's local edit (`S11B-LOCAL`)
- CRDT edit goes to local conflict artifact on B → artifact has A's remote edit (`S11B-REMOTE`)
- Conflict artifact is LOCAL-ONLY on B (not synced to A)

**Phase 1 — Pre-disable baseline:** PASSED
**Phase 2 — Disable/edit/re-enable:** YAOS unloaded and re-initialized on B
**Phase 3 — Conflict artifact:** Created and semantically verified
- `artifact contains S11B-REMOTE ✓` — A's displaced CRDT edit preserved
- `survivor contains S11B-LOCAL ✓` — B's local edit wins main file
**Phase 4+5 — Quorum + negative-window:** PASSED
- Conflict artifact content verified on B (disk hash match)
- Original path survivor hash converges on both devices
- No stale/recovery divergences

**Acceptance statement:**
"B had base B0. B disabled YAOS and edited local state L (S11B-LOCAL). A produced remote state R (S11B-REMOTE). B re-enabled. YAOS preserved both edits: B's local edit wins the main file (disk wins), A's remote edit is preserved in a local conflict artifact on B. No exact old state resurrection. No recovery emitted old state."

**NOTE:** Legacy trace analyzer PASS ≠ Layer 4 PASS. The old analyzer passed on both devices while the Layer 4 quorum was running. The Layer 4 reports are authoritative.

---

## Architecture Notes

### `witnessQuorum` vs `witnessQuorumEventually`

- `witnessQuorum`: **STRICT** — fails immediately on any unexpected settled hash. Use for pre-burst baseline.
- `witnessQuorumEventually`: **EVENTUAL** — records unexpected settled hashes as intermediate evidence, waits for correct hash. Use for post-burst convergence.

### s11b conflict artifact semantics

The conflict artifact is a local-only file on Device B. It is NOT synced to Device A via CRDT. The `conflictArtifactLocalCheck` (not "quorum") verifies the artifact content on B only. The original path convergence is verified on both devices via `witnessQuorumEventually`.

### Historical failure fixtures

Three historical failure fixtures are preserved:
- `qa-runs/s11a-failing-fixture/` — strict quorum failed on intermediate hash (pre-`witnessQuorumEventually`)
- `qa-runs/s11b-failing-no-artifact/` — remote edit via `__qaOnlyForceCrdtContentUnsafe` didn't create conflict artifact
- `qa-runs/s11b-failing-artifact-not-on-a/` — wrong assumption that artifact syncs to A

These document the diagnostic progression and protect against regression.
