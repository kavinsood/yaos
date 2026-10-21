# Backlog

Status: the open work as of 2026-10-21, on `sim-port` (identity-per-store through phase 4 on `client-remake-next`, phase 5 on `identity/phase5-hygiene`). The list is the project owner's (2026-10-21); the context
under each item is checked against the code and the notes it names. Done work is not kept here once merged (the last
section lists what landed on `sim-port` since 33bdf49b): it is in git history and in the notes
([integration-notes.md](client-remake/integration-notes.md) §3, the sim regression plans). Smaller known gaps that
nobody is working on are in [sync-contract.md](sync-contract.md) §13, integration-notes §5 and [wp-d-notes.md](client-remake/wp-d-notes.md) "Gaps and known issues".

Section letters (§x.y) refer to [DESIGN](client-remake/DESIGN.md).

---

## 1. Being fixed now

### PERF-BOOT: fresh-device bootstrap takes ~50 s on a phone

**A fresh Android phone needs ~50 s (median 49.6 s, n = 3) to bootstrap a 1022-file vault.** The Node harness does
the same vault in ~2.7 s ([integration-notes](client-remake/integration-notes.md) §7.3, `e2e/client/phoneBench.ts`).

**Where the time goes, profiled on the device:**
- **The ~43 s steady phase is Obsidian's native file bridge.** A DataAdapter call is in flight 94% of the time,
  back to back and mostly one at a time.
  - About 5.4 bridge calls per file: Obsidian's `create` (`exists` + `write`), Obsidian's metadata `read`, and two
    of YAOS's own: the `absent` precondition's `exists` (`src/host/obsidianVault.ts` `check`) and the engine reading
    each file back after writing it (`src/host/diskExecutor.ts` `readVault`, `readBinary`).
  - IndexedDB can account for at most ~6% of this phase.
- **~7.2 s before the first file are spent in the worker and on the network, not yet attributed.**

**Next, measured on the phone after each step:**
1. **Write independent files concurrently.**
   - The bridge serves 4 calls in flight 2-3x faster than one at a time.
   - The plan runner materializes in order today (§f.2).
2. **Drop YAOS's two bridge calls per created file:**
   - the pre-create `exists`: `vault.create` already throws when the path exists, and the catch re-checks;
   - the read-back after our own write: the engine knows the bytes it wrote.

   Together these are ~21 s of the 55 s of summed bridge time.
3. **Attribute the 7.2 s.**
   - Export the engine's diagnostics phase timeline over DevTools at the end of a run.
   - Get the worker hooks working (they recorded nothing in the profile run).
4. **One transaction per catch-up batch** instead of three per file: hygiene, worth ≤ ~2.6 s here.

**Found on the way:** `STARTUP_PING_TIMEOUT_MS` (5 s, `src/host/engineHost.ts`) is fatal and not retried. A phone
that takes longer than 5 s to start the worker stops syncing until "Restart sync engine".

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

### PRUNE-RESTORE: a delete pruned before the editor's restore commits trashes the edit

An edit the delete did not cover beats the delete (§c.7): the editor's device restores the doc. If the delete is
pruned (§c.9) before that restore commits, the restore names an unknown docId and the editor's planner takes the
"absent (pruned)" row: an unchanged file (S tracks the edits it already sent) goes to the trash, braked, with the
edit. Own frames still in the outbox are covered (the file is created anew, sim smallPrune seed 104); sent ones are
not. Production needs 19000 newer tombstones inside the restore window (minutes), so the race is theoretical there;
the sim's small-cap matrix keeps the newest 2+ tombstones for that reason (`src/sim/run.ts` `pruneWorld`), and a cap
that prunes down to 0 reproduces it (seeds 10, 20 with cap 1..5, hysteresis 0..cap). A fix would keep, per pruned
doc, what the planner needs to tell an uncovered own edit (the delete's base seq) past the prune, or hold a prune of
a delete younger than some ns-seq horizon.

The soak's small-cap draws reach it under storms too (PRUNE-STORM, §5), where a mass delete outnumbers the newest
tombstones `pruneWorld` keeps, and a related shape with no delete at all: merged aliases pruned after an epoch reset.

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

Each has a minimized plan in `src/sim/open-repros/` (README there: replay with `npm run sim:replay -- <file>`; not
replayed by the regressions test). All checked still failing on `integrate-3` (2026-10-21); "base" = also failing on
`client-remake-next` 6a1fb3e5 before the reclaim / generators / governance merges.

### SIM-S1-REKEY-WIPE: an outside edit lost across revokes and a wipe before the rekey (suite 1)

Key roll, a revoke, an outside (disk) edit on B, a second revoke, then B's IndexedDB and mirrors wiped before B
rekeys: the disk edit is lost (`tokens` + `destroyed`). `s1-197-clean.json` (5 steps, base), `s1-197.json`,
`s1-197-nohostile.json`. `1482901505-47-min.json` (hostile device, suite 1, clean-ups, revokes, 5 devices: a token
typed on D lost) is likely the same.

### SIM-CANVAS-FOLDER-REVIVE: a folder rename revives deleted canvas edges

`20701862-41-min.json` (7 steps, base): A fixes a dangling edge (`cBroken`), then renames the canvas's folder; the
edges A deleted come back with no concurrent edit and no conflict copy.

### SIM-BLOB-STALE-DISK: blob faults leave A's disk stale

`1370759151-13-min.json` (blob faults, 2 devices, delete / restore races): no convergence; A's body replica and the
relay hold the newer text of `notes/r5.md`, A's disk the old one.

### SIM-CLONE-BODYLESS-WAIT: a clone waits on a creator that never sends the body

`532933571-114.json` (clone faults, 4 devices; found on 70c67349, base): no quiescence, D waits on the creator of a
body-less doc whose body never comes.

### PRUNE-STORM: pruning under storms loses edits (soak small-cap draws)

The soak's small tombstone cap met storms (FLOOD_FAULTS) twice in 602 runs, both a token loss that passes without
`smallPrune` and on `generators` alone. `prune-epoch-merged-overwrite.json` (10 steps: an import storm, C's IndexedDB
lost, an epoch reset, two mass overwrites; no file is deleted, so every pruned entry is a merged alias of the
re-creates after the reset): A's overwrite of 10 notes is lost. In production an epoch reset of a large vault makes
(devices − 1) × notes merged aliases at once, enough to pass the 19000 cap. `prune-storm-mass-delete.json` (58 steps,
mass deletes and import storms): imported notes lost, likely PRUNE-RESTORE with more deletes than the 2+ newest
tombstones `pruneWorld` keeps. Until fixed, the nightly soak can fail on these.

### SIM-CANVAS-REORDER: a canvas reorder to the front lost

`canvas-reorder-lost-1025898366.json` (E2EE faults, 2 devices, suite 1, delete / restore races; 251 steps): B's
reorder of a node to the front loses against three nodes. Fails the same on `generators`.

### SIM-FLOOD-FLAP: the conflict-flood profile never settles

`flood-flapping-1557069770.json` (FLOOD_FAULTS, 5 devices, storms, delete / restore races, clean-ups; 256 steps, not
minimized: a run takes minutes): no quiescence, "flapping". Fails the same on `generators`.

### SIM-SOAK-OOM: a soak process ran out of memory

Soak master seed 4 reached ~4 GB and was killed at ~580 s (Node's default heap). Not minimized: find the run (its
config is drawn from the master seed) and whether a run or the soak's coverage / failure bookkeeping grows.

## Landed on `sim-port` since 33bdf49b

Kept here until `sim-port` merges; then git history holds them.

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
  planner's pruned row trashed a file whose own edits were still in the outbox (now re-created; PRUNE-RESTORE).
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
