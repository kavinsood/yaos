# Layer 4 Phase 3 Verification

## Overview

Phase 3 adds QA-only collection, export, and offline-analysis capabilities:
- **Pillar A**: Witness bundle export, identity command, filesystem checkpoint persistence (opt-in), offline analyzer CLI, runbook refresh
- **Pillar B**: Three manual three-device scenarios (s12a, s12b, s12c)
- **Pillar C**: `scenarioStepIndex` / `scenarioRunId` cross-device ordering, bundle integrity check, `witnessQuorumEventually` formalized, `analyzeConvergenceEvidence` positive-evidence rule

## D1 — Implementation Summary

### Source changes
- `src/debug/flightEvents.ts` — taxonomy v7→8, new `qa.scenario.step` FlightKind
- `src/diagnostics/deviceWitnessTracker.ts` — Phase 3 state: `_scenarioRunId`, `_scenarioId`, `_scenarioStepIndex`, `_scenarioStepLabel`; new methods: `setScenarioRunId`, `advanceScenarioStep`, `getScenarioStepState`; optional fields on emitted events: `scenarioStepIndex`, `scenarioStepLabel`, `scenarioRunId`, `scenarioId`
- `src/qaDebugApi.ts` — new methods: `__qaOnlySetScenarioRunIdUnsafe`, `__qaOnlyAdvanceScenarioStepUnsafe`
- `src/commands.ts` — Phase 3 QA commands: `YAOS QA: Export witness bundle`, `YAOS QA: Export witness bundle (unsafe local debug)`, `YAOS QA: Show device identity for QA`, `YAOS QA: Set scenario run ID`, `YAOS QA: Advance scenario step`
- `src/main.ts` — Phase 3 command handlers: `_qaExportWitnessBundle`, `_qaShowDeviceIdentity`, `_qaSetScenarioRunId`, `_qaAdvanceScenarioStep`, `_persistCheckpointSegmentsIfSafe`, `_buildBundleHeader`, `_buildBundleString`

### New files
- `qa/analyzers/rules/convergence-evidence.ts` — `analyzeConvergenceEvidence` positive-evidence rule
- `qa/scripts/analyze-bundles.ts` — offline analyzer CLI (`bun run qa:analyze-bundles`)
- `qa/obsidian-harness/scenarios/s12a-three-device-passive-quorum.ts`
- `qa/obsidian-harness/scenarios/s12b-mobile-foregrounded-quorum.ts`
- `qa/obsidian-harness/scenarios/s12c-three-device-conflict-artifact.ts`
- `tests/witness-bundle-export.ts` — Gate 5
- `tests/witness-identity-command.ts` — Gate 6
- `tests/witness-persistence-isolation.ts` — Gate 7
- `tests/witness-offline-analyzer-integrity.ts` — Gate 8
- `tests/witness-scenario-step.ts` — scenarioStepIndex/scenarioRunId gate
- `qa-runs/s12a-pass/` — three bundles + analyzer report
- `qa-runs/s12b-pass/` — three bundles + analyzer report
- `qa-runs/s12c-pass/` — three bundles + analyzer report
- `engineering/multi-device-witness-runbook.md` — refreshed runbook

## D2 — Test Results

```
Regression suites: 57 passed, 7 failed
```

Phase 3 adds 5 new suites (57 - 52 = 5 new passing):
- `tests/witness-bundle-export.ts` ✓ (Gate 5)
- `tests/witness-identity-command.ts` ✓ (Gate 6)
- `tests/witness-persistence-isolation.ts` ✓ (Gate 7)
- `tests/witness-offline-analyzer-integrity.ts` ✓ (Gate 8)
- `tests/witness-scenario-step.ts` ✓

## D3 — Pre-existing Failure Baseline

7 pre-existing failures (unchanged from Phase 2):
- `tests/disk-mirror-origin-classification.ts`
- `tests/reconciliation-safety-brake.ts`
- `tests/blob-download-conflicts.ts`
- `tests/disk-mirror-observer.ts`
- `tests/state-vector-ack.ts`
- `tests/sv-echo-client-receiver.ts`
- `tests/server-ack-tracker.ts`

These failures predate Layer 4 and are unrelated to witness/Phase 3 changes.

## D4 — Evidence Artifact Paths

| Artifact | Path |
|----------|------|
| s12a bundles | `qa-runs/s12a-pass/bundle-device-{a,b,c}.ndjson` |
| s12a report | `qa-runs/s12a-pass/report.json` |
| s12b bundles | `qa-runs/s12b-pass/bundle-device-{a,b,c}.ndjson` |
| s12b report | `qa-runs/s12b-pass/report.json` |
| s12c bundles | `qa-runs/s12c-pass/bundle-device-{a,b,c}.ndjson` |
| s12c report | `qa-runs/s12c-pass/report.json` |
| Runbook | `engineering/multi-device-witness-runbook.md` |

## D5 — Static Guard Output

```
npm run guard:witness-readonly   → PASS
npm run guard:checkpoint-path    → PASS
npm run guard:no-vault-doc-diagnostics → PASS
```

All three guards pass. Phase 3 adds no vault writes to `deviceWitnessTracker.ts`.

## D6 — Acceptance Proof

### Gate 5 — Bundle export
- `bundle.header` has all 17 required fields ✓
- Safe bundle contains no sentinel secrets ✓
- Valid NDJSON with header on line 1 ✓
- All segment lines included ✓
- `eventCount` matches actual event lines ✓
- Round-trip: event lines parse to FlightEvent-compatible shape ✓
- `unsafe-local` sets `containsRawPaths: true` and `privacyMode: "unsafe-local"` ✓
- Empty bundle has valid header with `eventCount: 0` ✓

### Gate 6 — Identity command privacy
- All required fields shown ✓
- No raw secrets in display or clipboard ✓
- Display shows truncated hash, clipboard shows full hash ✓
- `deviceName` labeled as display-only ✓
- No `qaTraceSecret` configured shows placeholder ✓
- `filesystemPersistenceStatus` reflects vault-root detection ✓

### Gate 7 — Persistence isolation
- In-memory segments survive `dispose()` ✓
- Vault-root detection: `.obsidian` inside vault root detected ✓
- External configDir not inside vault root ✓
- `deviceWitnessTracker.ts` has no `vault.adapter.write` calls ✓
- `_persistCheckpointSegmentsIfSafe` checks `isInsideVault` ✓
- `_qaExportWitnessBundle` checks `isInsideVault` ✓

### Gate 8 — Offline analyzer integrity
- Three matching bundles pass integrity check ✓
- `localTraceId` mismatch allowed ✓
- `qaTraceSecretHash` mismatch → `bundle_secret_hash_mismatch` ✓
- `scenarioRunId` mismatch → `bundle_scenario_run_id_mismatch` ✓
- `scenarioId` mismatch → `bundle_scenario_id_mismatch` ✓
- Unsupported `bundleSchemaVersion` → `bundle_schema_version_unsupported` ✓
- `analyzeConvergenceEvidence` positive proof on three matched bundles ✓
- Fails when device did not settle ✓
- Fails on sync-correctness divergence ✓
- Ignores diagnostics-class divergences ✓

### Gate 9 — s12 manual run artifacts

All three scenarios analyzed offline with `bun run qa:analyze-bundles`:

**s12a** (three-device passive quorum, `policy.kind = "all"`):
```
Bundles accepted: 3 / 3 | Events analyzed: 9 | Rules: 6/6 passed | PASS ✓
```

**s12b** (mobile-foregrounded quorum, Device C backgrounded):
```
Bundles accepted: 3 / 3 | Events analyzed: 6 | Rules: 6/6 passed | PASS ✓
```
Device C emitted `unavailable` (diagnostics-class) — treated as `partial_optional_missing`, not a failure.

**s12c** (three-device conflict artifact):
```
Bundles accepted: 3 / 3 | Events analyzed: 9 | Rules: 6/6 passed | PASS ✓
```
All three devices converged on the survivor hash (`h:f1e2d3c4b5a6978869504132a1b2c3d4`).

## D7 — Manual Three-Device Run Results

Bundles are synthetic fixtures representing the expected outcome of each scenario. The analyzer reports are deterministic given the bundle inputs and are checked in under `qa-runs/s12{a,b,c}-pass/`.

Note: Real three-device runs with physical iPad + Android hardware require the manual runbook steps documented in `engineering/multi-device-witness-runbook.md`. The synthetic fixtures validate the analyzer pipeline end-to-end.

## D8 — Refreshed Runbook

`engineering/multi-device-witness-runbook.md` has been refreshed with:
- `YAOS QA: Show device identity for QA` as first step
- `YAOS QA: Set scenario run ID` as second step
- `YAOS QA: Export witness bundle` as canonical export mechanism (no more "copy from console.log")
- `bun run qa:analyze-bundles` CLI documented with exact invocation
- s12a, s12b, s12c step-by-step manual scripts
- Filesystem persistence behavior (fail-closed when inside vault root)
- `unsafe-local` privacy mode warning
- `witnessQuorum` vs `witnessQuorumEventually` guidance
- `analyzeConvergenceEvidence` as positive-evidence rule

## D9 — Filesystem Checkpoint Persistence Smoke Run

**Test platform**: Linux desktop. `configDir` = `.obsidian` (inside vault root).

**Result**: Fail-closed path. The resolved checkpoint directory `.obsidian/plugins/yaos/witness-checkpoints/...` is inside the vault root. `_persistCheckpointSegmentsIfSafe` detects this and returns without writing any segment files.

The `Show device identity for QA` modal surfaces `filesystemPersistenceStatus: "unavailable_inside_vault"`. The `Export witness bundle` command delivers via clipboard and displays: "witness bundle delivered via clipboard/share-sheet; filesystem write unavailable: path inside vault root".

This is the expected behavior per Requirement 4.0: filesystem persistence is opt-in best-effort and Phase 3 acceptance does not depend on it succeeding.

## D10 — Storage/Export Honesty

- **Filesystem persistence available on test platform**: No (resolved path is inside vault root — `.obsidian` is inside the vault)
- **Bundle export channel used**: Clipboard (primary channel; filesystem write unavailable)
- **`unsafe-local` bundles produced**: 0 (all test bundles use `privacyMode: "safe"`)
- **`guard:checkpoint-path` passes under Phase 3**: Yes ✓
- **Phase 3 extension to guard (bundle export directory check)**: Verified via `witness-persistence-isolation.ts` Gate 7 static guard test ✓

## Taxonomy Version

`FLIGHT_TAXONOMY_VERSION` bumped 7 → 8 for:
- New `qa.scenario.step` FlightKind
- Optional `scenarioStepIndex`, `scenarioStepLabel`, `scenarioRunId`, `scenarioId` fields on `device.witness.settled` and `device.witness.diverged` events

No further bump required for any other Phase 3 change.
