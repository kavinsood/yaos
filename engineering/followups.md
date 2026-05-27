# Followups

Living follow-up ledger for open engineering work, validation gaps, and lower-level
quality debt that should not get lost.

This replaces the older phase-numbered follow-up notes and absorbs the still-relevant
parts of the old QA / RCA open-work queues.

For current priority framing, cross-check:
- `engineering/active-threads.md`
- `engineering/bug-rca-ledger.md`
- `engineering/layer4-harness-status.md`

## Validation gaps

### Reporter validation for the original field report

- Repo evidence shows harness reproduction coverage and later passes.
- Repo does not show the original reporter validating a fixed build.

### Real-device three-device active-edit proof

- Current three-device evidence is passive quorum, not a fresh edit propagating
  through all three devices.

### Real-device `s12c` conflict-artifact proof

- Desktop `s12c` exists.
- Real-device mobile / tablet conflict-artifact proof is still not in hand.

### Live provider/client offline handoff integration test

The storage-level proof exists (`tests/offline-handoff.ts`), but the full product
claim still wants one layer above it:
1. Device A edits and disconnects.
2. Server persists state.
3. Device B connects cold and syncs.
4. Assert CRDT content and Obsidian-visible vault state both match A's edits.

### No-event reconcile admission

CLOSED 2026-05. Spec: `.kiro/specs/no-event-reconcile-admission/requirements.md`. Regression test: `tests/no-event-reconcile-admission.ts` (Scenarios A–F, runs in `npm run test:regressions`). The test drives a markdown file onto disk with no CRDT entry and asserts the full admission timeline from flight events alone in both authoritative and conservative lanes, plus the preserved-unresolved guard, the clear-and-readmit cycle, and the callback failure semantics. `FLIGHT_TAXONOMY_VERSION` was not bumped; no new flight kinds were added.

Open follow-up from the closure: see "Retire `mintAdmissionOpId` callback in favor of split planner/mutation" under "Recovery / controller confidence" below.

### NFC / NFD path normalization

We still want an explicit scenario proving how YAOS behaves when filesystems normalize
Unicode path forms differently.

## Status / semantics / diagnostics

### Server receipt product semantics

Level 3-style server receipt / state-vector echo support exists. The remaining work is:
- decide how much receipt state should surface in product status
- keep wording precise (`server applied in memory`, not `durable`, not `another device saw it`)
- avoid inventing a fake pending-count claim

`lastLocalUpdateWhileConnectedAt` must not be labeled "sent" in UI.

### `recordTrace()` recursion behavioral test

`server/src/server.ts` has an `isThrottleSummary` guard to prevent
`trace-throttled` from recursively spawning itself. The current tests do not
drive `recordTrace()` directly.

### Path-bearing diagnostic logs should use structured fields

The safe-mode redactor is more robust when paths live in structured fields instead of
interpolated strings such as:

```ts
log(`scheduled write for "${path}"`)
```

Long-term direction:

```ts
trace("disk.write_scheduled", { path, reason })
```

### Safe/local-only classification for debug info

`buildDebugInfo()` still wants a cleaner contract so support-facing exports cannot
accidentally include raw host / vault / device values under a "safe" mental model.

### Distinguish user edits from maintenance CRDT updates

`lastLocalUpdateAt` currently includes user edits, disk syncs, restores, repairs,
and maintenance writes. A separate user-edit timestamp would make status copy more
honest.

### Duplicate Yjs warning re-check

The old duplicate-import problem was addressed, but one live regression run still
emitted at least one duplicate-Yjs warning. Re-check before treating that thread as
fully closed.

## Recovery / controller confidence

### Full controller-level recovery orchestration coverage

Still open at the full orchestration level:
1. `ReconciliationController` chooses disk as the only authority when disk/CRDT/editor diverge.
2. `EditorBinding.repair()` is selected instead of `heal()`.
3. Second reconciliation pass is a no-op.
4. Suppression fingerprint behavior is correct.
5. `flushWriteUnlocked` disk I/O behavior is correct.

### Narrow invariant proof: local repairs do not round-trip as remote writebacks

The `#22` family now has representative pass evidence, but we still lack a direct,
targeted proof of the exact local-repair round-trip suppression invariant.

### Retire `mintAdmissionOpId` callback in favor of split planner/mutation

`VaultSync.reconcileVault()` carries an optional `mintAdmissionOpId` callback (added
by the no-event-reconcile-admission spec, Option (b)) so the controller can emit
`reconcile.file.decision` BEFORE the CRDT mutation with a shared `opId`. The
callback works AND has documented contract + failure semantics + a regression test
(Scenario F in `tests/no-event-reconcile-admission.ts`), but it is a controller-shaped
wart inside a lower-level sync method.

The cleaner architecture is Option (a) from the spec: `reconcileVault` returns a
seed plan (no `ensureFile` calls), the controller iterates the plan, mints opIds,
emits decisions, AND calls `ensureFile`. That refactor touches every caller of
`reconcileVault` AND was deferred at implementation time.

Trigger to act: the next time `reconcileVault` or its surrounding code is touched
for unrelated reasons. Until then, the callback contract is load-bearing — see the
JSDoc on `mintAdmissionOpId` in `src/sync/vaultSync.ts` AND the "Implementation
outcome" section of the spec.

## Manual / operational followups

### WebSocket upgrade runtime path remains only partially covered

The pre-auth runtime tests cover the non-WebSocket path well. The Cloudflare-only
WebSocket upgrade path is still not fully runtime-tested in Node.

### Library-origin assumption re-verification on upgrade

`UpdateTracker` origin assumptions were source-audited for current library versions.
If `y-partyserver` or `y-indexeddb` are upgraded, re-check the origin contract.

## Historical note

Older phase-specific followup ledgers also contained many addressed items. Those were
not copied here verbatim; this file is intentionally for live followups.

### Bound-path conflict-artifact gap on re-enable while file is open

`handleBoundFileSyncGap` does not have a `both-changed` analog. When YAOS is
disabled cleanly, the user types into the open file (Obsidian autosave lands
the change on disk while YAOS is off), and YAOS is re-enabled, the file
re-binds and the bound path runs — not the closed-file path. So
`decideClosedFileConflict` is never consulted.

The bound branches today:

- `crdtContent === content` → no-op
- `localOnly` (editor matches disk, editor != crdt) → recover disk into CRDT
- `crdtOnly` (editor matches crdt, editor != disk) and idle ≥ 1.2s → recover
  disk into CRDT
- ambiguous (multiple editor authorities or all three disagree) → conflict
  artifact

None of these create a conflict artifact when editor matches one side and
the OTHER side carries a real divergent change. The bound path silently picks
a winner. For one common ordering on iPad re-enable, that winner is the
remote CRDT and the user's local edit disappears without an artifact.

Concrete iPad case from the 2026-05-27 trace: user types `LOCAL_ON_IPAD`
while YAOS is disabled; provider streams `REMOTE_FROM_DESKTOP` into CRDT
on re-enable; the file is open so the bound path runs; the user-visible
end state is `BASELINE_PROOF\n\nREMOTE_FROM_DESKTOP\n` with no conflict
artifact preserving `LOCAL_ON_IPAD`. The Issue #22-B ledger entry in
`engineering/bug-rca-ledger.md` carries the durable record.

The closed-file `_lastDiskIndexPersistedAt` mtime tie-break (commits 7cb4cc2
+ 17864ce) does NOT cover this case, because `baselineHash` is non-null on
the clean-disable path — the disable flow runs `teardownSync →
flushAllPendingWrites → saveDiskIndex` before the user types.

Proposed fix shape:
- The bound path computes `baselineHash`, `diskHash`, `crdtHash` (same
  inputs as `decideClosedFileConflict`) and runs the same classifier.
- When the classifier returns `preserve-conflict`, the bound path
  preserves the loser as an artifact and applies the winner. This must
  override the existing `localOnly` / `crdtOnly` heuristics; do not let
  the editor-equals-disk shortcut silently demote the other side.
- Bound `crdt-current-no-op` and `recovery-lock-active` skips remain
  unchanged. The classifier replaces only the localOnly / crdtOnly arms
  for the case where `baselineHash` is present and both diskHash and
  crdtHash differ from it.

Real-device validation (iPad re-enable while file is open) is required
before the fix can be claimed closed. Desktop CDP is not sufficient on
its own because the timing race depends on provider-sync-vs-reconcile
ordering, which is platform-specific.

This is its own spec; it is not Issue #25 and is not the
`_lastDiskIndexPersistedAt` cold-kill fix.
