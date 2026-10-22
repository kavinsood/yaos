# Backlog

Status: the open work as of 2026-10-21, on `sim-port` (identity-per-store through phase 4 on `client-remake-next`, phase 5 on `identity/phase5-hygiene`). The list is the project owner's (2026-10-21); the context
under each item is checked against the code and the notes it names. Done work is not kept here once merged (the last
section lists what landed on `sim-port` since 33bdf49b): it is in git history and in the notes
([integration-notes.md](client-remake/integration-notes.md) §3, the sim regression plans). Smaller known gaps that
nobody is working on are in [sync-contract.md](sync-contract.md) §13, integration-notes §5 and [wp-d-notes.md](client-remake/wp-d-notes.md) "Gaps and known issues".

Section letters (§x.y) refer to [DESIGN](client-remake/DESIGN.md).

---

## 1. Being fixed now

### PERF-BOOT: fresh-device bootstrap takes ~32 s on a phone

**A fresh Android phone needs ~32 s (median, n = 7) to bootstrap a 1022-file vault; ~41 s before `perf-boot`.** The
Node harness does the same vault in ~2.7 s ([integration-notes](client-remake/integration-notes.md) §7.3, §7.4;
`e2e/client/phoneBench.ts`, which now pairs on its own).

**Landed (`perf-boot`, 1cc63f58), -9 s (-22%), measured A/B on the phone:**
- independent files written concurrently (`Budgets.diskOpConcurrency`, 4; constrained 2), in the host's DiskExecutor
  and the plan runner's materialize window;
- YAOS's `exists` before each create removed: `vault.create` checks the disk itself;
- the startup ping retries 5 + 10 + 20 + 40 s before the fatal (was fatal after 5 s); worker errors still end it at
  once.

**Where the ~32 s goes now (§7.4):**
- **~29 s: Obsidian's native file bridge, saturated.** A call is in flight all of it, ~6 deep; 4 calls per file, all
  Obsidian's: `create` (`exists` + `write`), its metadata cache's `readBinary`, its File recovery plugin's `read`.
  More concurrency only raises per-call latency (~139 calls/s against ~125 serial). Not CPU: main 7 s busy, the
  engine 6 s.
- **~3 s pair -> first file** (was ~3.8 s, of which ~1-2 s was the `suite=0` pin's fixed 1 s retry and the engine
  restart after it; landed below).

**Landed after (fe457402): the `suite=0` pin without the retry and the restart.** One engine per pairing; pair ->
first file median 3.8 -> 2.9 s (integration-notes §7.4).

**Next:**
1. **The feed apply before the first file:** two `streams,meta` write transactions, ~0.8-1.1 s on the phone.
2. **Fewer bridge calls per file needs Obsidian's side:** writing through the adapter would skip `create`'s `exists`
   (a quarter of the calls) but bypasses the vault's own bookkeeping; not without a design. File recovery's `read` is
   the user's plugin.
3. **One transaction per catch-up batch** instead of three per file: hygiene; IndexedDB is not on the critical path.

(The "second engine at the last file" of earlier profile runs was this pin restart, recorded late by a blocked bench
loop: integration-notes §7.4.)

## 2. Smaller open items

### DATAJSON-REFETCH: rewrite a lost data.json from the store (declined for now)

identity-per-store §4 "data.json lost, store intact" optionally has the store re-fetch its grant with its device token
and rewrite data.json. Not built with phase 5: data.json is the only place the pairing's host and vaultId live (the
install record and the store DB name hold the vaultId but not the host), so a store has nothing to call. The
install pairs again, as before. The route it would use exists (`GET /vault/:id/auth/grant`, phase 5) but returns a
secret only after a rotation.

### QUARANTINE-UI: quarantine release control in the UI

§d.6 describes `releaseQuarantine{stream}` as a user action: re-gate a frozen doc's quarantined rows, apply what
passes, unfreeze. The command is in the protocol (`UserCommand`, `src/protocol/messages.ts`) and the engine handles
it (`src/engine/compose/runtimeOps.ts`, `src/engine/runtime/quarantineRelease.ts`), but nothing in `src/host` sends
it; only the sim does (`src/sim/e2eeFaults.ts`). A doc frozen by quarantine (malformed or disallowed peer rows,
`blob-corrupt`) is released only by the automatic retry at session start, which covers reader-dependent rows only,
or by **Rebuild local cache**. Needs a command or a button on the frozen-doc notice. (Causal-hole freezes no longer
need it: they thaw on their own, 3a569113.)

## 3. Bigger work

### SIM-COVERAGE: generators for coverage keys that never fire

The generators (`generators`: targeted relay faults, delete / restore races, a hostile member device, conflict shapes,
attachment clean-ups, the upgrade halt) and the soak's small tombstone cap reach every key but three, which the nightly
soak still exempts (`scripts/sim-soak.mjs` COVERAGE_OPTIONAL): `conflict.path-taken` (needs a third-party writer racing
a name with the device's label and minute), `diag.frame-poisoned` (own frames the relay refuses for good) and
`diag.upgrade-required` (stops quiescence by design; `upgradeHalt.test.ts`). Pruning at the production cap (> 20k
tombstones) and residency pressure stay out of reach at sim scale. wp-d-notes "Sim coverage" has the list.

### IOS-SPIKE: real-device runs

The platform facts the product depends on are verified on desktop engines and fakes only. Outstanding on Obsidian
iOS (and the rest of e2ee-design §23.3: Android, desktop, Linux keyring): the Blob-URL worker and IndexedDB inside it
(OR-1), `setViewData` interception (OR-2, wp-d-notes "Day-1 spike"), `Function.prototype.toString` returning the
bundle source (integration-notes D2), WebCrypto throughput, SecretStorage while locked and across updates, QR deep
links, `requestUrl` headers on the create-vault path, and whether the `pagehide` / `freeze` flush finishes before the
OS suspends the app (§i.4, timer-audit F5). Then the manual test plan (integration-notes §9) on each platform.

### GOVERNANCE: decide whether governance belongs in the plugin

The plugin pairs devices and makes pairing codes; device roster, revoke, vault rename and deletion live only in the
operator console (legacy-parity §18). Whether to bring any of that into Obsidian is undecided; legacy-parity lists
it as the one large missing area if it is wanted.

## 4. Server open items

From [DECISIONS](server-rewrite/DECISIONS.md) §8, still open:

- **O14.** Two smoke receipts took 1.5–1.7 s with the delay at both peers, so the commit itself was late.
  Unexplained.
- **O16** (accepted risk). A permanent but unclassified PITR error in restore step 1 keeps the journal row: the vault
  answers `503 restore_incomplete` and its revoke, owner-code and reset stay frozen until it is deleted. There is no
  cancel.
- **O13.** A refused WebSocket upgrade logs a `scriptThrewException` in the Vault DO. Noise only.
- **O10, Free-plan CPU** (accepted risk, "still open until a Free account is measured"). Timer-driven dedupe-index
  build steps share one CPU window, about 13 ms on a worst-case stream against Free's 10 ms. The deployed runs were on
  a Workers Enterprise account, where that limit is not enforced.
- **PITR after delete** (e2ee-design §15.2, §23.3). Whether Cloudflare can restore a vault's rows after `deleteAll()`
  is unknown, so deleted plaintext may linger up to 30 days.

## 5. Open sim failures

An open failure gets a minimized plan in `src/sim/open-repros/` (README there: replay with `npm run sim:replay --
<file>`; not replayed by the regressions test) and an item here.

No sim failure open on `integrate-3` (2026-10-22): no data loss and no other; `src/sim/open-repros/` holds no plan.

## Landed on `sim-port` since 33bdf49b

Kept here until `sim-port` merges; then git history holds them.

- **MERGE-RESIDENT-LOAD-LIVELOCK** (integrate-3 merge of `client-remake-next`, sim regression
  `canvas-reorder-rerank-lost-in-record-conflict.json` ran out of memory): the runner's parallel diskMaterialize jobs
  (perf-boot) met the eviction at every load (`fix-resident`); with more concurrent acquires than `maxResidentDocs`,
  each load evicted another's clean handle before its caller resumed and `withResident` reloaded it, forever. A
  handle a `withResident` caller waits on is now not clean (`HandleManager.isClean`), so budget evictions skip it;
  an explicit drop still forces the reload. Test in `src/engine/runtime/residency.test.ts` (concurrent acquires).
- **SOAK-BOUND-RESIDENT-BYTES** (`fix-resident`, soak 944223017 #218, invariant 6 "B: 3561321 resident bytes,
  budget 264275"): a check mistake, not an engine one. Two big notes open in editors went past a 264 KB budget; bound
  replicas are pinned and never evicted (DESIGN §d.1), but invariant 6 held them to the budget plus one doc. Owner
  decision: correct the check. Invariant 6 now holds only unpinned replicas to the budget (+1 doc) and adds the check
  that matters, that evictions happen: no clean replica resident while the device is over budget, pinned ones
  included. That check found two real gaps, fixed: the room a load made did not know its bytes (a bind loading a big
  note left clean replicas resident past the budget), and rows grew clean replicas past it; either waited for the next
  maintenance tick, which backs off when idle. A load now evicts again once loaded (not the doc itself), and applied
  rows evict after the apply. Since eviction then runs at more awaits, every handle holder across an await was
  audited: each pins it or re-checks residency (DESIGN §d.1), and a sim / test guard throws on an evicted handle's
  use (reported by the sim even when caught). Plan `src/sim/regressions/bound-big-notes-past-resident-byte-budget.json`, tests in
  `src/engine/runtime/residency.test.ts` and `src/sim/coverage.test.ts` (eviction disabled is reported).
- **SOAK-FLOOD-RETIRE-BACKLOG** (`fix-retire-refresh`, soak 979386157 #245, FLOOD_FAULTS small-cap, 5 devices: 1,400
  to 2,400 dead streams per device still to retire / drop when the 600 s heal ended). Not data loss, a liveness
  bound. Relay checkpoints are not broadcast, so a non-duty device learnt of a retirement only through its own
  put's refresh read or CAS conflict, 4 a tick, and dropped 16 a tick. Now (DESIGN §d.9 "retired"): every device
  batch-reads the checkpoint seqs of its dead streams with rows to retire (one 128-wide `readBatch` a tick, every
  max(grace / 4, 1 s)) and drops those found retired at once; the drops of a tick go in one bounded transaction
  (`Repo.tDropStreams`: 128 streams / 4,096 tail rows, I5); a non-duty device puts the retired checkpoint itself
  after a short grace, min(fallbackMs, 60 s) + jitter, not the 10–20 min checkpoint fallback, which also covers
  duty lost to a restart (the ns reload refolds an uncompacted pruning frame; compacted, the grace covers it). Due
  body checkpoint and retire puts now go in order of due time (duty, then their own jitter), so fallback devices
  no longer sweep a backlog in the same store order and put each stream once per device. The repro quiesces at
  453 s with no violation (was: no quiescence, 1,394 violations); body put conflicts 4,206 → 483, relay read
  requests 8,552 → 5,737. Plan `src/sim/regressions/slow/flood-retire-backlog-past-heal-horizon.json` (slow: `npm run test:sim`), tests in
  `src/engine/runtime/retire.test.ts` (batched learning and one-tick drop, duty lost to a restart) and
  `settleCheckpoint.test.ts` (due order).
- **SIM-S1-HELD-EDIT-UNOBSERVED-RENAME** (`fix-held-text`, suite-1 wipe/revoke/roll seed 112): B, key-missing after a
  revoke, deleted a canvas record (merge refused, only its hash kept); its store was wiped (mirrors kept); the canvas
  was renamed and edited again unobserved; c5 paired with nothing and a peer's edit restored c0 with the record B
  deleted. The refused edit's text and base are now kept in IndexedDB (`heldText` store, the record keeping
  `SyncedEntry.held` hash + size) and in one held-text side file per held edit, written once (synced mirror format 3
  carries hash + size only; DB schema 3; ≤ 8 Mi chars a text, 32 MiB over all, past it the hash alone), and a
  doc whose file is gone publishes it (`reconcileContent(held)`) before its absence is decided (DESIGN §f.6 "Held
  edits"). Plan `src/sim/regressions/gated-edit-renamed-and-edited-unobserved.json`, tests in
  `src/engine/reconcile/reconciler.safety.test.ts` and `src/core/plan/planner.test.ts`.
- **SIM-GATED-RESIDENCY** (`fix-refold`, soak seed 2006566456, invariant 6 "5 resident docs, budget 3"): an engine
  bound violation, not a tolerance issue. While C waited revoked-epoch for its QR, each pass's merge jobs applied the
  disk diff to the replica and then failed in `commitEdits` on the write gate; the edit stayed in the frame builder,
  the replica was no longer clean and could not be evicted (DESIGN §d.1), so every file merged while key-missing
  stayed resident (a phone left key-missing under a sync tool would hold one Y.Doc per changed file). Merge jobs
  (markdown, canvas, the epoch's old deletes) now call `BodyHandle.assertWritable` before their first edit. Plan
  `src/sim/regressions/gated-merge-pins-replicas.json`, test in `src/engine/reconcile/reconciler.safety.test.ts`.
- **SIM-LOST-SEND-IDLE** (`fix-refold`, soak seed 935329097, relay faults: D behind the relay at quiescence): the
  relay lost D's last live rows before a quiet period (lostSend) and nothing later showed the gap. Two halves. (1) Sim
  fidelity: the sim session (the wsRelay role) ran no idle liveness, so no VAULT_PING ever brought the head; it now
  runs wsRelay's probes against the production descriptor (60 s, keepalive mode, 15 s timeout; the relay answers
  VAULT_KEEPALIVE with VAULT_ALIVE uncharged), and the heal waits while a device behind the head still has an idle
  head check to come. (2) Client: in keepalive mode only every 10th idle probe was a VAULT_PING, so such a device
  stayed behind ~10 min; the first idle probe after stream data no pong has covered is now a VAULT_PING
  (`IdleProbes`, relay-wire §4), bounding it to ~idleMs at one extra ping per quiet period after traffic (a vault
  with no traffic still pings every 10th probe). Residual, by design: a relay that loses every message of a burst
  while still answering keepalives leaves the device behind until the 10th probe; production sends cannot be lost
  selectively on a healthy socket (a failed send means a closed one, which the liveness timeout catches). Plan
  `src/sim/regressions/lost-send-idle-head-check.json`, tests in `src/engine/adapters/wsRelay.test.ts`,
  `src/sim/relay-faults.test.ts`, `src/sim/composed.test.ts`.
- **SIM-CKPT-EPOCH** (`fix-refold`, soak seed 1221634030, invariant 4 "ns refold mismatch"): a real fork, not an
  oracle bug. An ns checkpoint built in a reset epoch was still in flight (HTTP) when the relay was restored to a
  pre-reset snapshot; `PUT /streams/checkpoint` named no epoch, so the restored epoch took it, and both devices adopted
  a fold of rows that epoch never had (deleted / merged entries of the dead log) while a refold of its rows differs. The
  put now carries `vaultEpoch` (relayHttp, from the session's VAULT_READY) and the server refuses another epoch
  `409 epoch_mismatch` in the writing turn (relay-wire §8); the sim relay does the same; the engine records nothing
  and backs off. `vaultEpoch` is required (integrate-3: a put without it is `400 invalid_vault_epoch`, no
  unchecked path for older clients). Plan `src/sim/regressions/checkpoint-put-across-epoch-restore.json`, tests in
  `src/sim/relay-http.test.ts`, `src/engine/adapters/relayHttp.test.ts`, `tests/server/streams-relay.ts`. The same
  hole on the read side: a feed / read reply computed after a reset or restore was applied to the old epoch's store
  (relayHttp never compared the reply's `vaultEpoch`); it now rejects `epoch_mismatch` (the read ends "aborted").
- **SIM-EPOCH-COMMIT-CRASH** (`fix-epoch`): two losses of an edit typed into an open note whose editor died
  unsaved, so the store held its only copy. (1) The note renamed first (relay seed 134): the restart's first pass
  (ns not ready) marked the doc's file gone, and the epoch migration's stranded-edit merge (§c.12 step 5) looked at
  the synced path only before dropping the old outbox; it now finds the file by rename inference as the planner does.
  (2) The doc an own create still held after an epoch reset (suite-1 "4 devices, E2EE faults" seed 1): the create
  folded merged and `reconcileHeld` deleted the merged doc's frames (I1); they now stay until the loser's stream drops
  (`T_drop_stream`, after the rebind), and the planner writes a loser's replica to its file before rebinding (§c.5).
  Plans `src/sim/regressions/epoch-rename-crash-stranded-edit.json`, `merged-create-held-edit-lost.json`.
- **SIM-E2EE-LOG-BUSY** (`fix-epoch`): two kept devices re-keyed after a revoke at once, each under a new RK of its
  own; the second could not open the first's record (another RK), passed over it as garbage and adopted its own: the
  vault forked on K_2 (rows failing auth across the fork, A's ns frozen checkpoint-disputed, its log never idle,
  devices sealing under different epochs, edits lost). A pending revoke in `k` now holds back its epoch's later
  records as a pending genesis did (e2ee-design §11.3): the device waits revoked-epoch for a QR. Plan
  `src/sim/regressions/concurrent-revoke-keyring-fork.json`, test `src/engine/keyring/concurrentRevoke.test.ts`.
- **SIM-REBIND-COLLAPSE** (`fix-epoch`, found by an epoch-reset / crash weighted soak, suite 1 seed 1394654959): an
  own create merged before it folded has `nsTouchSeq` 0, and the merged-row rebind kept that on the winner's synced
  record. After an epoch reset, B renamed the winner and an identical re-create folded live at the old path. A read its
  record (the winner, `nsTouchSeq` 0, still at the old path) as an own create the fold had suffixed, and the
  identical-loser collapse rebound it onto the new doc and deleted the winner, so the attachment was trashed on every
  device. The rebind (planner and job) now records the winner's `lastTouchSeq`. Plan
  `src/sim/regressions/merged-rebind-renamed-winner-collapsed.json`.
- **SIM-S1-REKEY-WIPE** (`fix-s1edit`, fdce877c): an outside edit absorbed into the replica, whose frame then came
  back stale after a revoke (an unsealed copy, never mirrored), was written over after an IndexedDB + mirror wipe: the
  synced mirror still called the disk synced, so the merge took it as the base. The outbox mirror (format 3) lists
  the docs whose own records it leaves out (unsealed copies, the size limit) and recovery imports their synced
  records with no trusted content hash: no-base merge, the disk text kept as a conflict copy (DESIGN §e.4, §i.5).
  Regressions `s1-revoke-wipe-outside-edit{,-hostile}.json`.
- **SIM-S1-FREEZE-UNSAVED** (`fix-s1edit`, 56cc7a4e; was filed under SIM-S1-REKEY-WIPE as `1482901505-47-min.json`, a
  different cause): a doc frozen right after a keystroke dropped the coalesced push (the engine had already dropped
  the binding), leaving the keystroke only in the unbound editor; an outside write inside Obsidian's 2 s save window
  reloaded over it. A freeze now saves the dirty view at once. Regression `s1-freeze-unsaved-keystrokes-reload.json`.
- **SIM-S1-MUTUAL-REVOKE** (`fix-s1edit`, c6f9f382, b186fd7f; found in the wipe/revoke/roll sweep, suite 1 seed
  264): two devices revoking each other at once forked the vault (the second adopted its own K_r past the first
  revoke, which it could not judge), and a sent ns create re-sealed under its old clientFrameId was refused
  frame-id-conflict and poisoned, its canvas body committed first and was dropped as pruned: a canvas created on B
  lost. Converged on integrate-3 with SIM-E2EE-LOG-BUSY's rule: any pending genesis / revoke in `k` holds back every
  later record of its epoch, the own one included (e2ee-design §11.3); re-sealed ns / cfg
  records take a fresh id, and own receipts are judged by the committed bytes' keyEpoch (§14.2 step 4). Regression
  `s1-mutual-revoke-canvas-create.json`.
- **SIM-S1-FROZEN-RENAME** (integrate-3, 44a9c511; wipe/revoke/roll sweep, suite 1 seed 40, minimized): a canvas
  frozen key-missing, edited and renamed, became a new doc at the new path and came back at the old one with a record
  the user had deleted. The planner's frozen branch now claims the doc's inferred rename target and records a file
  gone from a complete listing as liveMissing does (fileGone, renamedTo), so the pass that drops the observed renames
  keeps this one; runPlan asks the write gate before it commits a create's born-empty S. Tests in
  `planner.test.ts` and `reconciler.safety.test.ts`; plan `frozen-renamed-canvas-split-and-resurrected.json`.
- **SIM-S1-K-DAILY-IDLE** (integrate-3, c37b6c32; suite 1 seed 102): an own `k` append refused `cf_daily_limit` was
  resent by the keyring runtime 45 s later, after the engine had reported idle (isIdle counted only the outbox).
  `KeyringRuntime.busy()` covers own `k` appends on the wire and a pending daily-limit resend. Test in
  `suite1Engine.test.ts`; plan `keyring-daily-limit-resend-after-quiescence.json`.
- **SIM-S1-UNFRAMED-MATERIALIZE** (integrate-3, 4c1819ae; suite 1 seed 6, non-convergence): a revoked device's typing
  (frames refused at the gate) was in the replica when the doc materialized; S recorded that text at the version
  without it, the restart dropped it from the replica and the file kept it as synced. `framedVersion` frames open
  edits before a materialize records S, and the job writes nothing while the gate is shut. Test in
  `reconciler.safety.test.ts`; plan `revoked-typing-materialized-as-synced.json`.
- **SIM-S1-UNTRACKED-RENAME** (integrate-3, cb98904a + fc56bf53; suite 1 seed 40 after an epoch restore): an
  untracked file of a remote doc (no S: the restore dropped it) renamed before its first merge became a new doc, and
  the doc came back at the old path. The planner pairs the rename with the remote doc (`movedUntracked`: nsRename,
  then a no-base merge against the epoch's path base) and keeps the observed rename while the doc waits
  (`Plan.keepRenames`). Tests in `planner.test.ts`, `reconciler.epoch.test.ts`; plans
  `epoch-restore-untracked-canvas-renamed.json`, `epoch-restore-untracked-rename-dropped-while-waiting.json`.
- **SIM-SUSPEND-KILL-SKIPPED** (integrate-3, a9b8a8a2; soak 2021329329 #253, harness): a suspend-kill skipped because
  the app was already down left the workspace's saves blocked, so a later edit never reached disk. The fault now
  unblocks saves when it does not kill. Plan `suspend-kill-skipped-saves-blocked.json`.
- **SIM-S1-GATED-RENAME** (integrate-3, 8ebbf5fb; suite 1 seed 112): an observed rename whose nsRename the write gate
  refused lived in memory only; an engine crash lost it and the renamed file became a new doc. The runner keeps it on
  the synced record (fileGone, renamedTo) before it rethrows. Test in `reconciler.safety.test.ts`; plan
  `gated-rename-lost-on-engine-crash.json`.
- **SIM-S1-MIRROR-MARKS** (integrate-3; suite 1 seeds 40 and 112): the marks a record keeps of a file this device
  could not publish (fileGone, renamedTo) were not in the synced mirror, and the mirror was a 2 s debounce behind:
  an IDB loss read the moved file as a new doc and put the old one back. Synced mirror format 2 carries fileGone,
  renamedTo and heldHash; `runPass` writes the mirror at once when a pass (gated or not) changes a record's marks, and
  the outbox mirror's writer asks for it when a doc's own records leave it (`MirrorWriter.onUnmirrored`: a stale
  commit's unsealed copy, with no synced record of the doc yet). A pass the gate stops at another doc's ns op still
  commits the plan's marks (`keepObservedRenames`). Tests in `mirrors.test.ts`, `mirrorIo.test.ts`,
  `syncedMirrorOrder.test.ts`, `reconciler.safety.test.ts`; plans `unsealed-copy-leaves-outbox-mirror-before-synced-record.json`,
  `frozen-rename-mark-lost-in-synced-mirror-debounce.json`, `gate-stops-pass-before-gone-mark.json`.
- **SIM-S1-HELD-EDIT** (integrate-3; suite 1 seed 112): a canvas edit the write gate refused, then a rename while the
  app was down after an IDB loss: by S's content the renamed file was new, and a peer's edit restored the doc at its
  old path with the record deleted. The runner keeps the refused content's hash on S (`heldHash`, dropped with the
  next sync point), mirrored, and rename inference pairs by it. Tests in `planner.test.ts`,
  `reconciler.safety.test.ts`; plan `gated-edit-renamed-while-down-after-wipe.json`.
- **SIM-S1-REVOKER-STALE-ROW** (integrate-3; suite 1 seed 40, non-convergence): a revoked device's frame sealed
  under the old epoch, committed past the revoke, reached the revoker before its own revoke's receipt; judged with no
  revoke known it was applied, while every other reader ignored it as stale (the revoker's replica and checkpoints
  kept the edit). The revoker now holds other devices' rows sealed below its revoke until the record shows in `k`
  (e2ee-design §14.3). Test in `staleEpoch.test.ts`; plan `revoker-applies-stale-row-before-own-receipt.json`.
- **SOAK-RENAMED-AWAY-TAKES-NEW-FILE** (integrate-3; soak 1307815726 #30, data loss): offline, C renamed a canvas
  away while a peer moved its doc to c0, then created a new c0. The file at the doc's remote path was read as the
  doc's own: the new canvas merged into the doc over D's edge and resize (lost), and the renamed canvas became a new
  doc. The planner takes a file at the remote path only when no known rename took S's file elsewhere. Test in
  `planner.test.ts`; plan `renamed-away-doc-takes-new-file-at-moved-path.json`.
- **SIM-UNTRACKED-RENAME-UNFILLED-BODY** (integrate-3; sweep "3 devices, seeded faults" seed 133, data loss,
  introduced by cb98904a): after an epoch reset A renamed its canvas, still untracked, while the new doc's body
  (B's create) had not arrived. `movedUntracked` merged the file into the empty replica, so A's records were created
  again beside B's, and B's older fields won (A's resize lost). The moved doc now waits `body-empty` as a file at
  the path does, and a lost create body drops the empty doc. Test in `planner.test.ts`; plan
  `renamed-untracked-merged-into-unfilled-body.json`.
- **SIM-S1-MIGRATION-RENAME** (integrate-3; suite 1 wipe/revoke/roll seed 40, full plan): A, revoked, deleted an
  edge and renamed the canvas; the record kept the rename (renamedTo). An epoch restore then migrated A, and A's
  store was lost (mirrors kept). The migration carried bases and deletes but not the rename, and in the new epoch a
  rename observed while ns was not ready lived in memory only. Either way the renamed file became a new doc, and the
  doc came back at the old path with the edge. Unpublished renames are now `pathMove:` meta records: the migration
  stores them, a rename with no synced record to stay on is stored as it is observed, the synced mirror carries
  them (v2 `moves`), and recovery and inherit (also from an old epoch's mirror) read them back. The planner reads
  them as observed renames until their source path is settled. Tests in `reconciler.epoch.test.ts`,
  `epochBases.test.ts`, `syncedMirrorOrder.test.ts`, `mirrors.test.ts`; plans
  `epoch-migration-drops-unpublished-rename.json`, `unrecorded-rename-lost-with-store-after-migration.json`.
- **SOAK-EPOCH-BASE-SCATTERED-TRUST** (integrate-3; soak 979386157 #156, data loss, also at ac7aff61): B's new
  one-line note was synced just before an epoch reset, and A re-created its own 60-line note at the path. B's old
  base was a character subsequence of A's text, scattered over it, so it was trusted. The merge read B's line as
  kept by A and wrote A's text over the note. A markdown epoch base now needs its words in order in the new text
  too. Tests in `reconciler.epoch.test.ts`; plan `epoch-base-trusted-by-scattered-characters.json`.
- **Canvas concurrent record create** (`fix-integrity`, fix-epoch soak `971197958-35`): after an epoch reset C
  re-created a canvas empty, and A and D each merged their file into it before seeing the other's rows. A record
  new to a replica is a new Y.Map, so the two maps competed and A's survived whole; D's synced base kept D's colour
  (an unsent old-epoch edit), and D's next merge read its absence as A removing it. A merge now drops base fields
  the record's live map never had (`baseSeenBy`, DESIGN §j.2). Regression `canvas-concurrent-record-create-loses-field.json`.
- **Canvas broken, renamed, deleted** (`fix-integrity`, fix-epoch soak `1542948623-23`): sim oracle. A file deleted
  while a broken save is pending deletes what the app shows, but the oracle matched the pending save by its old
  path, so after a rename it counted the canvas's records as lost. It now follows the broken bytes, as the save
  does. Regression `canvas-broken-renamed-deleted-records-go.json`.
- **Hot canvas seeds 89, 211** (`fix-integrity`, sim oracle): a deleted canvas file's root removals go with it like
  its root values; a deleted conflict copy takes its maker's superseded removals too. Regressions
  `canvas-deleted-vault-root-removal-revived-lineage.json`, `canvas-deleted-copy-takes-superseded-removal.json`.
- **SIM-FLOOD-FLAP** (`fix-integrity`): not a flap. After a wave of writes to thousands of streams (a mass restore
  at heal) every non-duty device re-read each stream's remote checkpoint seq before standing in (relay checkpoints
  are not broadcast), one `read` per stream and two per maintenance tick: the relay kept serving those reads for
  longer than the 600 s heal horizon, so the run never had 5 quiet seconds. Fallback refreshes now share one
  `readBatch` per tick from `fallbackMs` on (DESIGN §d.9). The flood plan settles at heal + ~90 s. Focused test in
  `settleCheckpoint.test.ts`; the 256-step plan (5 min a replay) is not promoted.
- **SIM-SOAK-OOM** (`fix-integrity`): no leak. Run #20 of master seed 4 is the conflict-flood profile (seed
  1623917393, 5 devices): ~28k files per device by the end, ~200k vault versions kept. Three costs per size made it
  blow up. Engine: every synced write read its doc's ns touch seq through `view()`, which `commitEdits`
  invalidates, so each write refolded every own pending ns frame and built bodyInfo for every entry: O(N x entries)
  per pass, >50% of CPU and most of the garbage. The ns overlay is memoized and jobs read one entry
  (`peekRemote`). Sim: the heal loop printed every file's text on every device each virtual second (two ~150 MB
  strings live), and path listings decoded every file; it now uses a vault content generation and
  `visiblePaths()`. The run now completes in ~12 min wall with no violation, heap peak 2.8 GB (RSS 5.7 GB), under
  Node's default heap; between runs the soak's heap returns to ~30-90 MB. Residual, by world size: the sim's
  MemStorage copies every touched store's record array per write transaction (the main remaining churn), and the
  vault keeps every version's bytes for the invariants.
- **SIM-CANVAS-REORDER** (`fix-integrity`): a reorder re-ranks whichever records the order reconciliation moves
  (the longest ordered run keeps its ranks), often not the one the user moved; a concurrent edit of such a record made
  its line differ on both sides, and the record conflict kept the CRDT's line with its old rank. `mergeRecordLines`
  merges a record's rank apart from its fields (DESIGN §j.2 updated). Regression
  `canvas-reorder-rerank-lost-in-record-conflict.json`.
- **SIM-CLONE-BODYLESS-WAIT** (`fix-integrity`): a view() while a creator-status request was in flight queued the
  same creator again; its second "live" answer counted as a recheck and doubled the backoff (10 min instead of 5), so
  docs of a creator removed meanwhile waited past the heal horizon. A creator being asked is neither queued again nor
  timed (`creatorStatus.ts`). Nothing was at risk while waiting: the files stay on disk and abandonment re-creates
  them. Regression `creator-asked-twice-doubles-recheck.json`.
- **SIM-BLOB-STALE-DISK** (`fix-integrity`): observed renames were ordered by wall-clock stamps; a clock set back
  between seed1 -> r1 -> r5 and n5 -> r1 chained n5 into r5 (both docs claimed r5.md, the editor bound to n5's doc
  sat at r1.md, its content job deferred for good, A's disk stale). Rename stamps are now strictly increasing in event
  order, floored by the `renamedTo` stamps kept across restarts. Regression `clock-set-back-misorders-rename-chain.json`.
- **SIM-CANVAS-FOLDER-REVIVE** (`fix-integrity`): a save, then a rename before the pass that hashes the save reads
  the file. The host held the rename's event in its 50 ms batch (§g.3) while the read of the source came back
  "missing", and an observed rename was dropped after a pass that could only ask for the target's hash, so the doc
  was deleted and a new one created at the target; a peer's concurrent edit then restored the old doc with records
  the user had deleted (canvas edges back). The host now flushes its batch before it answers reads and disk ops, the
  scanner drops a read result for a path hinted while the read was in flight, and an observed rename whose target is
  not hashed yet survives the pass. Regression `rename-before-read-revives-canvas-deletes.json`.
- **CLONED-ID, FRAMENO-IDB** (identity-per-store phases 1–4, `client-remake-next`): a deviceId is used by exactly one
  store, ever. The identity lives in the store (`meta.identity`), data.json holds a pairing grant, a clone or a new
  IndexedDB registers a new device, an IndexedDB loss fences its predecessor and re-issues its mirrored frames, a
  vaultEpoch change mints too (the old epoch's store retires itself once the new one is live), and the per-install
  data.json fields moved to `App.saveLocalStorage` (§8; a one-time notice when another tool syncs the folder). With
  that, frameNo allocation is exact (e2ee-design §8.2): the wall-clock floor (44748cb2, f47950cb), the 64 skip,
  `renumberBlind` and the epoch `frameNoFloor` are gone. Residual: a duplicated app profile (Migration Assistant, a
  Time Machine restore onto a second Mac) still runs two installs as one store (decision 7, accepted).
- **IDENTITY-HYGIENE** (identity-per-store phase 5, `identity/phase5-hygiene`): stores not seen for 90 days are
  retired lazily by the server (so an abandoned store's body-less creates resolve without a console action); the
  operator can rotate a pairing's secret and live stores fetch the new one with their token; at live, a device deletes
  the store DBs of this vault under a lost install key once the server reads them retired; **Rebuild local cache** is
  a store reset (a new identity that fences and inherits from the old store). Declined: replay-ring compaction
  (decision 6: rings are kept, ~1.5 KB per device and stream) and DATAJSON-REFETCH above.

- **BLOB-RETRY** (473cd500, after 31987119): a downloaded attachment whose disk write keeps failing backs its
  re-downloads off per (doc, hash), 1 min doubling to a cap scaled by size (10–60 min), and is listed
  `write-failed` with one notice (§j.1).
- **RETIRE** (`reclaim`): dead docs' streams (pruned, merged aliases) get a `retired` checkpoint at lastSeq, so the
  relay drops their rows (H7), and every device then drops their local records in one transaction (§b.5, §d.9,
  `src/engine/body/retire.ts`). A bound doc the fold pruned re-binds its views by path. The prune cap is a fold rule the
  sim can set (`EngineTuning.nsPrune`, matrix "small tombstone cap", invariant `retired`). Found on the way: the
  planner's pruned row trashed a file whose own edits were still in the outbox (now re-created).
- **PRUNE-RESTORE, PRUNE-STORM** (`fix-prune`): a delete pruned before its edit-beats-delete restore committed
  trashed the editor's sent edits (the restore names a docId the fold no longer has). Pruned docs keep their restore
  duty on the device (§c.9 "Pruned docs"): the `pruned` event carries the removed entries, the delete's base goes onto
  the doc's stream record (also for an ns checkpoint adopted past the prune), and the pruned row re-creates a file
  with own rows past that base instead of trashing it. Each pruned delete also leaves a ~21-byte stub (docId, delete
  base) in the fold state, so a reader that adopts an ns checkpoint past the delete and its prune still knows the base
  (newest `PRUNED_STUB_CAP` = 20000, <= 448 KiB of a checkpoint; past it a device that knows nothing of the doc
  re-creates its file). The soak's storm failures were the same: a mass delete, or an
  epoch reset's migrated-loser collapse, pruned in the frame that made it. The sim's small cap now draws 0..8, pruned
  to 0..cap (goal 0: every delete pruned at once); plans in `src/sim/regressions/prune-*.json`. Found by the
  small-cap sweeps and fixed on the same branch: the re-create merges a replica ahead of the file (an unsaved bound
  edit) into it first; a reload (adopted ns checkpoint) retargets bound docs the new state lacks (a view pinned a
  dead stream); and `bindTarget` follows observed renames (a view bound a live doc to another doc's renamed file and
  the bind-time merge destroyed its content: storm seed 86, not prune-related,
  `src/sim/regressions/bind-renamed-file-onto-moved-doc-path.json`).
- **PLAN-PRUNED** (d1f8a750): the planner's "absent (pruned)" row tells a prune from an own create that folded as
  ignored; such a file is re-created, never trashed, and a file owned by a live doc at the path is never touched
  (§f.2).
- **CAUSAL-FREEZE** (3a569113, 0c151628): a `causal-hole` freeze with no quarantined rows thaws once an apply leaves
  the doc without pending structs; triggered by new rows, the reconnect's catch-up and re-reads on session starts
  1, 2, 4, 8, … (§d.6; diag `doc-thawed`).
- **ADOPT-CKPT** (00cf3441): a read page that adopts a body/canvas checkpoint settles every adoptable whose content
  the checkpoint already holds (§d.5).
- **SIM-TUNING** (49ef12a5, 8037e333, f273232b): `FAST_TUNING` meets §d.6 (100 × 60 ms re-read window against the
  3 s adoption timer) and `startTestEngine` refuses tuning that does not.
- **LINT** (0ef758fa, chore/lint-warnings): `npm run lint` is clean (0 errors, `--max-warnings 0`) and gates CI's
  `client` job and `check:client`. Rule scoping by runtime (Node-only, worker, server) is in `eslint.config.mts`.
- **DEPS** (d26e533c): `y-partyserver` removed.
