# Multi-Device Witness Runbook (Phase 3)

This runbook covers manual multi-device QA runs for Layer 4 witness scenarios. It supersedes the Phase 2 runbook.

## Prerequisites

- YAOS plugin installed on all participating devices (same `pluginVersion`)
- All devices connected to the same vault via the same Cloudflare Worker
- `qaDebugMode: true` in YAOS settings on all devices
- A shared `qaTraceSecret` configured in YAOS settings on all devices (same value)
- `window.__YAOS_DEBUG__` available in Obsidian DevTools (desktop) or via command palette (mobile)

## Clock Discipline

- **Never** use wall-clock timestamps for correctness decisions
- **Never** compare `seq` values across devices (per-device local counter only)
- Same-device durations: use `monotonicMs` deltas from the same device
- Controller wait timeouts: use `performance.now()` (monotonic)
- `bundle.header.createdAt` and `qa.scenario.step.enteredAt` are display-only

## Device Identity

- All cross-device primitives key on `deviceId` (stable local UUID), **never** `deviceName`
- `deviceName` is display-only and must never be used as a cross-device key
- `scenarioRunId` is the explicit cross-device run identity (not `localTraceId`)
- Per-device `localTraceId` values legitimately differ across devices in the same run

---

## Standard Pre-Run Checklist

### Step 1 — Identity check (all devices)

On each device, invoke:
```
YAOS QA: Show device identity for QA
```

Verify:
- `qaTraceSecretHash` prefix matches across all devices (first 12 hex chars)
- `pluginVersion` matches across all devices
- `runtimeState: foreground` on all devices (except intentionally backgrounded ones)
- `filesystemPersistenceStatus` — note whether filesystem persistence is available

Copy the full identity block to a shared document for the run record.

### Step 2 — Set scenario run ID (all devices)

On each device, invoke:
```
YAOS QA: Set scenario run ID
```

Enter:
- `scenarioRunId`: a shared UUID or kebab-case label (e.g. `s12a-run-2026-05-17`) — **same value on all devices**
- `scenarioId`: the scenario identifier (e.g. `s12a-three-device-passive-quorum`)

This must be done **before** starting the flight trace and before any scenario step advance.

### Step 3 — Start flight trace (all devices)

On each device:
```
Start QA flight trace
```
Mode: `qa-safe` (recommended for cross-device runs — uses shared `qaTraceSecret` for comparable hashes).

---

## Bundle Export

### Primary export channel

On each device, invoke:
```
YAOS QA: Export witness bundle
```

- **Desktop**: bundle is copied to clipboard. A Notice confirms "witness bundle copied to clipboard".
- **Mobile**: bundle is delivered via platform share sheet (AirDrop, Files, etc.).
- **Filesystem write** (optional): only when the resolved path `<configDir>/plugins/yaos/witness-bundles/` is **outside** the vault root. On typical Obsidian desktop configurations, `.obsidian` is inside the vault root, so filesystem write is unavailable — clipboard is the primary channel.

When filesystem write is unavailable, the Notice reads:
> "witness bundle delivered via clipboard/share-sheet; filesystem write unavailable: path inside vault root"

This is expected behavior. The clipboard path always works.

### Unsafe-local bundle (full/local-private mode only)

For debugging with raw paths and content:
```
YAOS QA: Export witness bundle (unsafe local debug)
```

⚠️ **Warning**: Bundles in `unsafe-local` mode contain raw vault paths and/or raw note content. **Do not share outside the development team.**

### Filesystem persistence (opt-in, best-effort)

When the resolved checkpoint directory is outside the vault root, checkpoint segments are automatically serialized to disk when the flight trace stops. This is opt-in convenience — Phase 3 acceptance does not depend on it succeeding.

When the path is inside the vault root:
- No segment files are written
- A single `device.witness.diverged` with `reason: "checkpoint_path_inside_vault"` is emitted (once per session)
- The identity modal shows `filesystemPersistenceStatus: "unavailable_inside_vault"`

---

## Offline Analysis

### Invocation

```
bun run qa:analyze-bundles -- <bundle-file-a> <bundle-file-b> <bundle-file-c> [--out <report-path>]
```

Example:
```
bun run qa:analyze-bundles -- \
  qa-runs/s12a-pass/bundle-device-a.ndjson \
  qa-runs/s12a-pass/bundle-device-b.ndjson \
  qa-runs/s12a-pass/bundle-device-c.ndjson \
  --out qa-runs/s12a-pass/report.json
```

### Bundle integrity check

The CLI runs a bundle integrity check **before** any analyzer rule. It rejects the run if:
- `qaTraceSecretHash` differs across bundles → `bundle_secret_hash_mismatch`
- `scenarioRunId` differs → `bundle_scenario_run_id_mismatch`
- `scenarioId` differs → `bundle_scenario_id_mismatch`
- `bundleSchemaVersion` ≠ 1 → `bundle_schema_version_unsupported`

Per-device `localTraceId` mismatch is **allowed** and does not trigger rejection.

### Analyzer rules

The CLI runs all Phase 2 rules plus the new Phase 3 rule:
1. `analyzeWitnessQuorum` — no sync-correctness divergences
2. `analyzeStaleHashAfterNewerWitness` — no stale hash regressions
3. `analyzeRecoveryEmittedOldHash` — no recovery-old-hash regressions
4. `analyzeEditorStability` — no editor stability issues
5. `analyzeCrossDeviceHashesEqual` — all devices agree on last settled hash
6. `analyzeConvergenceEvidence` — **positive proof**: all devices settled with expected hash

### `analyzeConvergenceEvidence` (positive-evidence rule)

This rule produces a positive proof artifact when all consuming devices settled with the expected hash:

> "Device A produced hash H at step N. Device B settled with H at step N+k. Device C settled with H at step N+k+m. No stale rewinds detected. No recovery emitted old hash."

A passing three-device run **must** invoke this rule. It is the reviewer's "proof of materialization" requirement.

---

## Scenario Step Marking

Every manual step in a three-device scenario must be marked by invoking:
```
YAOS QA: Advance scenario step
```

Enter:
- `scenarioStepIndex`: a non-negative integer, strictly greater than the previous step on this device
- `stepLabel` (optional): human-readable label for the step

The `scenarioStepIndex` is comparable across devices because it is set from a single shared scenario script driven in lock-step. It is **not** a per-device `seq` value.

Validation:
- Backwards step index → rejected with Notice
- Step advance without `scenarioRunId` set → rejected with Notice "set scenarioRunId via 'YAOS QA: Set scenario run ID' first"

---

## `witnessQuorum` vs `witnessQuorumEventually`

| Primitive | When to use | Behavior on wrong hash |
|-----------|-------------|------------------------|
| `witnessQuorum` (strict) | Pre-action baselines — no intermediate states expected | Fails immediately |
| `witnessQuorumEventually` (eventual) | Post-action convergence after burst, re-sync, or re-enable | Records as intermediate evidence, waits for correct hash |

**Rule**: pre-burst baselines use strict `witnessQuorum`; post-burst convergence uses `witnessQuorumEventually`.

`witnessQuorumEventually` success result includes `intermediateHashes: Record<DeviceId, Array<{ seq, stateHash }>>` — the intermediate wrong-hash settled events observed per device before final convergence. These prove the device legitimately lagged rather than experiencing a stale resurrection.

---

## Scenario s12a — Three-Device Passive Quorum

**Devices**: Linux (A), iPad foreground (B), Android foreground (C)
**Policy**: `QuorumPolicy.kind = "all"` — all three devices must settle

### Steps

1. Pre-trace identity check (all devices)
2. Set scenario run ID: `s12a-three-device-passive-quorum` (all devices)
3. Start flight trace, qa-safe mode (all devices)
4. Open `QA-scratch/s12a-witness.md` on all devices
5. Advance to step 1, label: `pre-action-baseline` (all devices)
6. Clear suppression + trigger dirty on all devices; wait 5s
7. Verify all three devices settled with same hash
8. Device A: edit note, add `S12A-EDIT-1`; wait 5s for propagation
9. Advance to step 3, label: `post-edit-convergence` (all devices)
10. Clear suppression + trigger dirty on all devices; wait 5s
11. Export bundles (all devices)
12. `bun run qa:analyze-bundles -- <bundle-a> <bundle-b> <bundle-c>`

**Acceptance**: All three devices settled with same hash at step 3. No forbidden divergences.

---

## Scenario s12b — Mobile-Foregrounded Quorum

**Devices**: Linux (A), iPad foreground (B), Android **backgrounded** (C)
**Policy**: `QuorumPolicy.kind = "required"` — A and B required, C optional

### Steps

1. Pre-trace identity check (all devices)
2. Set scenario run ID: `s12b-mobile-foregrounded-quorum` (all devices)
3. Start flight trace (all devices)
4. **Background Device C** (press Home on Android)
5. Advance to step 1 on A and B only, label: `required-devices-baseline`
6. Clear suppression + trigger dirty on A and B; wait 5s
7. Verify Device C emits `unavailable` (expected — background guard)
8. Advance to step 2 on A and B, label: `quorum-with-optional-missing`
9. Foreground Device C, then export bundles (all devices)
10. `bun run qa:analyze-bundles -- <bundle-a> <bundle-b> <bundle-c>`

**Acceptance**:
- A and B settled with expected hash ✓
- C recorded as `partial_optional_missing` (not a failure) ✓
- C's only divergence is `reason: "unavailable"` (diagnostics-class) ✓
- Any other divergence on C = real bug, scenario fails

---

## Scenario s12c — Three-Device Conflict Artifact

**Devices**: Linux (A), iPad (B), Android (C)
**Validates**: s11b v2 conflict policy under three-device conditions

### Steps

1. Pre-trace identity check (all devices)
2. Set scenario run ID: `s12c-three-device-conflict-artifact` (all devices)
3. Start flight trace (all devices)
4. All devices open `QA-scratch/s12c-witness.md` with content `S12C-BASELINE`
5. Advance to step 1, label: `baseline-quorum` (all devices); trigger dirty; wait for quorum
6. **Disable YAOS on Device B** (iPad)
7. Device A: edit note, add `S12C-REMOTE-A`; Device C: edit note, add `S12C-REMOTE-C`; wait for A+C sync
8. Advance to step 2 on A and C, label: `concurrent-edits-synced`
9. **Device B**: edit note directly (while YAOS disabled), content: `S12C-LOCAL`
10. **Re-enable YAOS on Device B**; wait 30s for re-sync
11. Verify on Device B: original path contains `S12C-LOCAL` (disk wins); conflict artifact exists with `S12C-REMOTE` content
12. Verify on A and C: no conflict artifact file
13. Advance to step 3 (all devices), label: `post-resync-convergence`; trigger dirty; wait for quorum
14. Export bundles (all devices)
15. `bun run qa:analyze-bundles -- <bundle-a> <bundle-b> <bundle-c>`

**Acceptance**:
- A, B, C agree on original-path survivor hash (= hash of `S12C-LOCAL`) ✓
- Conflict artifact exists **only** on Device B ✓
- No `stale_hash_after_newer_witness` or `recovery_emitted_old_hash` on any device ✓

**If actual behavior diverges**: Do NOT modify the scenario. A failing run indicates a real conflict-policy bug. Check in failing artifacts under `qa-runs/s12c-fail/`.

---

## Troubleshooting

**"set scenarioRunId via 'YAOS QA: Set scenario run ID' first"**
→ Invoke `YAOS QA: Set scenario run ID` before advancing scenario steps.

**"scenarioStepIndex must be strictly greater than current"**
→ Step indices must increase. Check the current step index via `window.__YAOS_DEBUG__.getDeviceId()` and the tracker state.

**Bundle integrity check fails with `bundle_secret_hash_mismatch`**
→ Devices have different `qaTraceSecret` values. Verify all devices have the same secret in YAOS settings.

**Bundle integrity check fails with `bundle_scenario_run_id_mismatch`**
→ Devices were given different `scenarioRunId` values. Redo the run with the same ID on all devices.

**`filesystemPersistenceStatus: unavailable_inside_vault`**
→ Expected on typical Obsidian desktop (`.obsidian` is inside vault root). Use clipboard export. This does not affect Phase 3 acceptance.

**Device C shows `unavailable` divergence in s12b**
→ Expected — this is the mobile-background guard working correctly. It is a diagnostics-class divergence, not a sync-correctness failure.
