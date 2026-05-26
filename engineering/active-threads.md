# Active Threads

This is the current engineering reality after reconciling repo state,
`qa-runs/`, and the recent chat/history dumps.

## Active now

### 1. Release-truth and documentation canonicalization

We are no longer blocked on a live reproduced regression cluster. We are blocked on
making the repo tell the truth clearly and with less residue.

Open work:
- keep one canonical bug / incident ledger
- keep one canonical followups ledger
- keep one canonical harness status note
- retire historical snapshots that still read like live status

Primary docs:
- `engineering/bug-rca-ledger.md`
- `engineering/followups.md`
- `engineering/layer4-harness-status.md`
- `engineering/qa-history.md`

### 2. Validation still missing before a confidence-heavy release

These are the remaining externally meaningful gaps:
- original reporter validation is still not evidenced in-repo
- iPad / three-device convergence after an actual edit is still not proven
- real-device `s12c` conflict-artifact behavior is still not proven

Primary evidence:
- `engineering/layer4-harness-status.md`
- `qa-runs/s12a-three-device-pass/summary.md`
- `qa-runs/s12b-linux-android-partial/summary.md`

### 3. Follow-up engineering debt that is real but not a stop-ship emergency

Still-open items are grouped in `engineering/followups.md`.

Highest-signal ones right now:
- live provider/client offline handoff proof
- server receipt/status wording and product semantics
- structured path-bearing diagnostics logs
- controller-level recovery orchestration coverage
- duplicate-Yjs warning re-check

## Parked on purpose

These are not forgotten; they are intentionally not the current move:
- run all remaining multi-device scenarios
- expand the analyzer into a larger QA platform
- build Phase 4 witness relay
- build awareness-channel witness relay
- automate three-device CDP control for iOS/Android
- do soak/stress work before a concrete scary behavior appears

The harness should be used as a scalpel, not a treadmill.

## Recently closed enough to stop thrashing on them

### Stale `src/*.js` regression pollution

Closed by guard + clean baseline:
- `npm run guard:no-src-js-artifacts`
- `npm run test:regressions` now passing at 60/0

### Android open-editor remote edit question

Answered by `s13 Linux+Android`:
- Android baseline was open and healthy
- remote edit arrived with `originClass=remote-apply`
- final `editorHash == crdtHash == diskHash`
- no stale echo / old-hash recovery / persistent mismatch

Primary evidence:
- `qa-runs/s13-linux-android-editor-open-remote-edit/summary.md`

### Ack-cluster "current blocker" framing

No longer accurate as the main repo narrative. Some ack-model follow-up work still
exists, but the earlier emergency framing was based on a stale local failure state
that is now gone.

## Release-facing caveats to keep saying out loud

- Reporter validation still open.
- iPad active-edit proof still open.
- `s12b` is partial, not a full proof of mobile background behavior.
- Real-device `s12c` remains unproven.
- Some older engineering docs still contain historical pending language and should
  not be treated as the current source of truth without cross-checking.

## Decision rule

If a new scary behavior appears, run the narrowest scenario or test that answers
that exact question. Otherwise, bias toward canonical docs, targeted validation,
and a smaller surface area of claims.
