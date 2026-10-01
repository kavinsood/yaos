# Ordinary-text process recovery evidence

The native certification below records the earlier October 1 component freeze.
Subsequent queue/deadline, digest-snapshot, artifact-relocation and Node-helper
hardening changes require their own verification; those results are recorded in
`/Users/kavin/personal/obsidiansync/experiments/results/reconciliation-hardening-20261001/REPORT.md`.
The earlier native pass must not be treated as certification of changed artifacts.

Run through the existing harness; both suites are automatically discovered:

```sh
node tests/run-typescript.mjs --test-aliases tests/client/reconciliation-text-recovery.ts
node tests/run-typescript.mjs --test-aliases tests/client/reconciliation-text-process-recovery.ts
node tests/run-typescript.mjs --test-aliases tests/client/disk-worker-replacement.ts
npm run typecheck:tests
```

## Verified on October 1, 2026

In-process: **11 passed**. Fresh-process: **36 passed**. Disk-worker review/deletion:
**53 passed**. All three suites were revalidated after the review projection fix.
The refreshed freeze log `/tmp/yaos-worker-review-freeze-certified.log` confirms build,
test/QA/CLI typechecks, and all six selected regression suites pass. Lint reports four
warnings and zero errors. The integration owner reports exit 0 and refreshed plugin
fingerprint prefix `c2e6b7b8`. Earlier CLI fixture type blockers are resolved; server-node
typechecking was separately reported passing by the integration owner.
The final full **215-suite** regression run passes with zero failures, recorded in
`/tmp/yaos-worker-regressions-final-integration.log`. Final builds, all product/test/QA/CLI/
server-node typechecks, production bundle guards, and whitespace checks also pass.
The strict A→B→C regressions pass through settlement, controller, and restart: B is
materialized and durably agreed before an external editor saves C based on retained A.
B's remote-only paragraph and C's unique disk text must both survive. This is not merely
a concurrent-write CAS test.

Production modules exercised: `VaultSync`, `BodyManager`, `BodySettlementRepository`,
`DiskMirror`, `ReconciliationController`, `ConflictEpisodes`, and shared volatile
`ReconciliationWorker.run(callback)`. No generic per-edit text journal is introduced.

| Restart evidence | Assertions |
| --- | --- |
| Disk equals durable remote | Agreement bookkeeping; zero `Vault.process` calls; no new candidate. |
| Disk equals retained expected | Conditional remote projection through `Vault.process`, never `Vault.modify`. |
| Neither | Preserve unique disk/body inputs; do not replay the unresolved replacement into CRDT. |

The parent sends `SIGKILL` at a signalled boundary, waits for exit, edits actual temporary
vault files while the child is dead, and starts another process over the same saved state.
Killed children never run destroy. Boundaries surround candidate/body persistence, remote
effects, candidate removal, disk effects, agreement persistence, artifact effects, and
episode persistence. Before candidate persistence is not durable acceptance.

**Candidate-first/concurrent editor findings resolved:** tests replay into a stale cached
body and cover editor updates through
the production observer. A second update during older capture is retained by a full CRDT
update associated with the verified existing authority; another kill proves that update
is saved before receipt replay. Changed authority forbids recapture/replay. Local
`waitForReceipt:false` acceptance survives a withheld ACK and uses an already resident body.

**Artifact restart finding resolved:** artifact-specific `pendingAppend` lives in the existing
bodyId episode, not a new side
store. First creation and subsequent appends must retain the same episode and exactly one
bounded part. Intended output finishes indexing; expected prior bytes permit completion;
neither retains the pending intent and actionable error without overwriting foreign bytes.
Tests verify durable body association, exact version offsets, disk-version-first ordering,
deduplication, and artifact edits while dead. No orphan/duplicate allowance remains.

## Audit scope and resolved findings

- Bootstrap `materializeEntryFenced()` persists/adopts the body before disk settlement,
  rechecks the head, then establishes agreement. Fresh import `commitFreshBody()` retains
  content in a lifecycle record and stores the candidate fence before server effects.
  These orchestration paths were source-audited, not fully driven by these process fixtures.
- Editor tests exercise Y.Text changes and the production persistence observer, not actual
  CodeMirror attachment/autosave.
- **Review close-before-projection finding resolved:** explicit synchronized-version
  selection can accept a no-op candidate while disk projection is still pending. Review now
  calls `DiskMirror.projectReviewedContent()` inside the shared worker, uses exact disk CAS,
  and verifies the selected output and episode/body identities before closing the episode.
  The passing disk-worker regression uses production no-op candidate acceptance and proves
  queued settlement cannot reopen the episode. Boundary changes, missing `Vault.process`,
  pending durable work, partial frontmatter writes, and full host-output verification also
  pass. Main's closed-note synchronized-version selection is additionally verified through
  actual Obsidian UI without editor autosave rescue, with no episode recurrence.
- Status-triggered deleted-body episode close also runs through the shared worker because
  close can finish a pending artifact append. Current runtime/repository identity and body
  absence are rechecked inside that worker callback; this routing is source-audited.
- **Planning concern resolved:** the earlier manually queued network probe was not a
  production ingestion test and was replaced. Cold-body ingestion evicts a clean body,
  makes an insert-only disk edit, then holds `currentHead` during `fixture.ingest()`.
  A following filesystem job runs on
  the shared worker before the head gate is released; ingestion then completes. Planning
  does not hold the worker in this path. Resident acceptance also passes a no-head-fetch test.
- **Refused-delete concern resolved:** `deleteBodyUnqueued()` now closes the episode only
  after confirmed absence or successful disk deletion. Open, missing-baseline, and divergent
  refusals retain the review index; the disk agent's `disk-worker-replacement` policy tests
  cover those branches. `close()` also completes a pending append before retiring the index.
  Trash itself is not an exact text-CAS operation.

## Native and CLI verification

Native process cuts pass against the refreshed frozen component: actual artifact
write-before-index recovery, seeded structural rename completion, and unexpected-target
preservation. Seeded structural tests do not claim normal native writer emission. The
25-minute production-timer soak passes against the final frozen artifact: 1,506,327 ms,
real midpoint editor edits from both peers, and all 24 unique markers retained on both
clients and server with no generation reversions. Evidence:
`/Users/kavin/personal/obsidiansync/experiments/results/reconciliation-worker-20261001/run-production-client-2026-10-01T13-32-30-603Z/result.json`.
CLI runtime validation passes:
112 headless checks, 19 host checks, and 17 SQLite structural-intent checks. Structural
recovery is configured before bootstrap on both hosts; pending paths remain fenced.
No failing case remains in the ordinary-text recovery suites.

Actual redeployment of the disposable production Worker also passes with unchanged
certified source: runtime epoch changes, accepted fresh edits from each peer converge,
and all prior note/artifact bytes and 24 soak markers remain intact. The same profiles
were restarted before deployment, and both clients stayed running during deployment.
Evidence:
`/Users/kavin/personal/obsidiansync/experiments/results/reconciliation-worker-20261001/actual-redeploy-2026-10-01T14-02-33-801Z/result.json`.
This certifies actual-redeploy/cold-runtime recovery, not autonomous idle hibernation.

The process-fixture Obsidian-shaped adapter runs production's exact comparison inside
`Vault.process`, including LF→CRLF movement. Those fixtures are not the actual Obsidian
host. Separate native tests cover selected actual editor, review and restart behavior;
they do not establish global cross-process locking or comprehensive host/trash coverage.

Database/remote ports use binary snapshots with write/fsync/rename/directory-fsync; the
remote double applies real Yjs updates with exact candidate-ID/digest deduplication. They
are not browser IndexedDB or the deployed server. Candidate removal exercises the existing
fallback, not IndexedDB's atomic `confirmPendingCandidate()` transaction. No claim covers
IDB interruption/eviction, corruption, power loss, or full deployed receipt transport.
