# Bug / RCA Ledger

Repo-validated bug / incident ledger as of 2026-05-27.

## Closed or largely closed

### Issue `#22` family

#### `#22-B` — disable/re-enable edit loss

- Status: fixed
- Failure shape: a device-local edit made while YAOS was disabled could be lost after re-enable
- Representative failing evidence:
  - `qa-runs/2026-05-15T22-18-56-issue-22-disable-reenable-disk-wins-A/result.json`
  - error: `DATA LOSS: B's edit made while YAOS was disabled was LOST after re-enable`
- Representative passing evidence:
  - `qa-runs/2026-05-15T22-41-29-issue-22-disable-reenable-disk-wins-A/result.json`
  - `qa-runs/2026-05-15T23-23-02-issue-22-disable-reenable-local-only-A/run.log`
  - `qa-runs/2026-05-15T23-20-55-issue-22-disable-reenable-concurrent-A/run.log`
- Current understanding:
  - disk-wins main-file behavior now preserves the offline disk edit
  - conflicting CRDT content is redirected into an artifact instead of overwriting the main file
  - local-only and concurrent variants also have passing representative runs

#### `#22-B` cold-relaunch / process-kill variant — missing-baseline path

- Status: fixed 2026-05-27
- Failure shape: when Obsidian was killed or suspended before YAOS persisted the disk-index
  baseline for a file, re-enable triggered `missing-baseline → winner: crdt`, silently
  demoting the user's local disk edit to a conflict artifact while the remote CRDT content
  became the main file. For note-taking users this felt like "turning YAOS back on lost my
  edits," even though the edit was technically preserved in the artifact.
- This is a different code path from the clean-disable case above. The clean-disable path
  persists the baseline via `teardownSync → flushAllPendingWrites → saveDiskIndex` before
  any kill. The cold-kill path bypasses `teardownSync` entirely, leaving `baselineHash` null.
- Desktop repro: `qa/scripts/repro-missing-baseline-kill.ts`
  - Before fix: `preserve-conflict / missing-baseline / winner: crdt` (user edit demoted)
  - After fix: `preserve-conflict / missing-baseline / winner: disk` (user edit wins main file)
- Fix: `src/sync/closedFileConflict.ts` — missing-baseline now uses mtime evidence:
  - If `diskMtime > lastDiskIndexPersistedAt` (file was modified after YAOS last persisted
    clean state), treat as "edited while inactive" and give disk the main file;
    CRDT remote content is preserved as a conflict artifact.
  - Otherwise fall back to the existing `winner: crdt` safe distributed default.
- New persisted field: `_lastDiskIndexPersistedAt` written to `data.json` on every
  `saveDiskIndex()`. Loaded on startup before the first reconcile.
- Known limits of the heuristic (by design, documented in `closedFileConflict.ts`):
  - Global timestamp, not per-file: an unrelated file triggering a save AFTER the target
    file's mtime can cause CRDT to win even when the user made a local edit.
  - mtime coarseness: filesystems with 1-second precision, external editors that preserve
    mtime, or iCloud/Android document providers may produce unexpected values.
  - When either input is absent, falls back to `winner: crdt` (safe default preserved).
- Diagnostic fields added to `reconcile.file.decision.data` when `reason: "missing-baseline"`:
  `missingBaselinePolicy`, `diskMtime`, `lastDiskIndexPersistedAt`, `mtimeEvidence`.
- iPad proof: still pending. Desktop CDP proves the policy branch. Real-device validation
  required before closing Issue #22-B fully for mobile.

#### `#22-A` — passive reconnect stale state

- Status: fixed in current repo evidence
- Failure shape: passive device could reconnect and keep an older sentinel after sync
- Representative failing evidence:
  - `qa-runs/2026-05-15T22-13-48-issue-22-passive-reconnect-A/result.json`
  - error: `Cycle 2: B still has sentinel after reconnect+sync — stale state`
- Representative passing evidence:
  - `qa-runs/2026-05-15T22-15-26-issue-22-passive-reconnect-A/result.json`
  - `qa-runs/2026-05-16T16-35-50-s11a-passive-stale-echo-witness-B/summary.md`
- Current understanding:
  - the stale resurrection / stale echo class that motivated this thread is covered by later witness runs
  - current repo evidence supports convergence without old-state resurrection

#### `#22-A` — passive open / reporter-shaped roundtrip

- Status: not reproduced as a current failing repo state
- Representative passing evidence:
  - `qa-runs/2026-05-15T21-01-44-issue-22-passive-open-roundtrip-A/result.json`
  - `qa-runs/2026-05-15T21-41-50-issue-22-passive-open-roundtrip-A/result.json`
- Remaining caveat:
  - original reporter validation is still not evidenced in-repo, so this is covered by harness evidence rather than direct reporter confirmation

### Issue `#24` — sequential device handoff failure

- Status: fixed at the server persistence / pathology level
- Failure shape: the server behaved like a live relay when both devices were online but did not durably persist state for later cold-start handoff
- Root cause summary:
  - save failures in the old persistence chain could be swallowed, leaving the server apparently healthy but durably stale
- Fix class:
  - `PersistenceCoordinator`
  - immediate checkpoint fallback after append failures
  - pending-persistence health semantics
  - legacy document migration
  - better debug surface for deployment validation
- Current caveat:
  - storage-level and pathology validation are strong, but full live provider/client handoff proof is still tracked separately in `engineering/followups.md`

### Issue `#25` — editor-bound recovery loop

- Status: resolved on current main
- Failure shape: editor-bound recovery repeatedly appended content every few seconds instead of converging
- Fix class:
  - recovery postconditions
  - recovery fingerprinting / quarantine
  - better recovery flight events
- Current understanding:
  - forced local-only and open-idle recovery branches converge
  - the natural repeated-anchor symptom test no longer reproduces the growth loop

#### `#25` typing-cadence localOnly amplifier variant — fingerprint-changing growth

- Status: fixed 2026-05-28
- Failure shape: while a Markdown file was open in the editor and the user
  was typing, the controller's `bound-file-local-only-divergence` branch ran
  every ~2.36s. CRDT length and disk length each grew by exactly +5 chars per
  cycle. Each cycle satisfied its postcondition (`matchesExpected: true`),
  applied an apply-diff under `ORIGIN_DISK_SYNC_RECOVER_BOUND`, and called
  `editorBindings.repair()`. The witness fired `device.witness.diverged`
  ~2 seconds after each `recovery.apply.done` because the next typing burst
  had landed disk in the meantime. Loops at ~2.36s cadence forever while
  typing continues.
- Existing protections did not catch it:
  - `BOUND_RECOVERY_LOCK_MS` (1500ms) lock expires before the next 2.36s cycle.
  - `shouldQuarantineRepeatedRecovery` is fingerprint-keyed; each cycle's
    `(prev, next)` lengths are unique and prefixes change, so `count` never
    reaches the threshold of 3.
  - `OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS` (1200ms) idle guard exists in
    the `crdtOnly` branch but not in `localOnly`.
- Real-device evidence:
  - `~/temenos/.obsidian/plugins/yaos/flight-logs/2026-05-27/boot-wL7i012vR4mGXA-1.ndjson`
  - pathId `p:476818d2ecba90d4e95e2a0c4f3ad1eb`
  - timeline reproducible via `qa/scripts/issue22b-loop-summary.mjs`
  - full RCA at `engineering/issue-25-localonly-amplifier-timeline.md`
- Fix:
  - `OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS = 3000ms`. New idle guard added to
    the localOnly branch, symmetric to the crdtOnly branch's existing 1200ms
    guard. Threshold is intentionally longer because localOnly is the
    typing-cadence amplifier shape; quenching it requires a window longer
    than a typical human typing burst. Emits `recovery.skipped` with reason
    `recent-editor-activity-local-only`.
  - Monotonic-growth amplification quarantine. New per-path detector
    independent of fingerprint identity. Trips when 3 consecutive
    `bound-file-local-only-divergence` recoveries within 15s exhibit
    non-decreasing prevLen and nextLen with strictly positive deltas AND
    end values strictly larger than start values. Emits new flight kind
    `recovery.amplification.quarantined` (taxonomy bumped to 10) plus the
    existing `recovery.loop.detected`.
  - Pauses (idle-guard skip, crdt-current no-op, recovery-lock skip) reset
    the amplification history. Legitimate one-shot recoveries do not count
    toward future quarantines.
- Spec: `.kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md`
- Regression: `tests/controller-recovery-orchestration-amplifier.ts`
  (4 deterministic Node scenarios in `npm run test:regressions`).
- iPad proof: still pending. Desktop coverage proves the predicate, the
  flight kind, and the timing. Real-device validation required before
  closing this variant fully for mobile.

### Stale compiled `src/*.js` artifacts causing false regression failures

- Status: fixed and guarded
- Failure shape: stale compiled `.js` files under `src/` caused jiti to load a second Yjs instance, creating misleading failures in seven suites
- Representative evidence:
  - `scripts/guard-no-src-js-artifacts.mjs`
  - `package.json`
- Current understanding:
  - this was tooling pollution, not a semantic product regression
  - regression entrypoint now hard-fails if these artifacts reappear

## Open validation gaps

### Reporter validation for the original field report

- Status: open
- Why still open:
  - repo evidence shows harness reproduction coverage and later passes
  - repo does not show the original reporter validating a build

### Three-device active-edit proof

- Status: open
- Why still open:
  - `qa-runs/s12a-three-device-pass/summary.md` proves passive quorum on a pre-existing hash
  - it does not prove three devices converging after a new edit during the run

### Real-device `s12c` conflict-artifact proof

- Status: open
- Why still open:
  - desktop `s12c` exists
  - `engineering/layer4-harness-status.md` still lists real-device `s12c` as not proven

## Engineering debt, not active product incidents

### Server receipt semantics beyond "transport was open"

- Status: open design / follow-up work
- Primary source:
  - `engineering/followups.md`
- Note:
  - this is real design debt, but it is not the same thing as the stale seven-suite failure story that was once mistaken for a product regression cluster

### Duplicate Yjs warning claim may be overstated

- Status: re-check needed
- Caveat:
  - a live `npm run test:regressions` run still emitted at least one duplicate-Yjs warning, so the thread may be reduced rather than fully gone
