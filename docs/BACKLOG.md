# Backlog

Status: the open work as of 2026-10-21, on `sim-port`. The list is the project owner's (2026-10-21); the context
under each item is checked against the code and the notes it names. Done work is not kept here: it is in git history
and in the notes ([integration-notes.md](client-remake/integration-notes.md) §3, the sim regression plans). Smaller
known gaps that nobody is working on are in [sync-contract.md](sync-contract.md) §13, integration-notes §5 and
[wp-d-notes.md](client-remake/wp-d-notes.md) "Gaps and known issues".

Section letters (§x.y) refer to [DESIGN](client-remake/DESIGN.md).

---

## 1. Being fixed now

### BLOB-RETRY: re-download backoff after a failed attachment write

A materialize write that keeps failing after its download (I/O error, disk full, precondition mismatch) used to
re-claim the download on every retry pass: one 5 KB attachment was fetched 601 times in 10 simulated minutes.
31987119 (on this branch) stops `PassScheduler` resetting its failure count on a pass whose only work went in flight,
so the retry grows 1 s → 60 s (13 GETs in the same 10 minutes) and a blob retry is never delayed past its own due
time (`src/engine/compose/passScheduler.ts`). The owner lists the item as still in progress.

### PLAN-PRUNED: a rejected own create must not be trashed as pruned

When an own create folds as ignored (sim seed 222: a `replay-duplicate` after IndexedDB loss), the doc has a synced
record but no ns entry, which the planner reads as row "absent (pruned)" and answers with `diskTrash` (§f.2; braked,
but trashed when under the brake's threshold). The planner needs a safety net that tells "never existed in the
fold" from "pruned" before it trashes a file. Related: FRAMENO-IDB below, which removes the known trigger.

### CAUSAL-FREEZE: a causal-hole freeze never lifts

After `causalRetries` re-reads a doc is frozen `causal-hole` (`src/engine/runtime/docRuntime.ts`, §d.6). Nothing
unfreezes it: the automatic retry at session start (`retryReaderQuarantine`, `src/engine/runtime/quarantineRelease.ts`)
only releases streams whose quarantined rows are all reader-dependent, and a causal-hole freeze has no quarantined
rows; the user action §d.6 describes (`releaseQuarantine`) is in the protocol (`src/protocol/messages.ts`) but no
command or button sends it. The note stays frozen until **Rebuild local cache**.

### ADOPT-CKPT: adoptable provisional frames linger after a checkpoint

An adoptable record (§d.5) is settled when its commit is observed, live or in a read page. Settling matches rows
only (`settleAdoptable`, `src/engine/store/repo.ts`), so a read that answers with a checkpoint covering the commit
settles nothing: the adoptable lingers in the outbox until its `PROVISIONAL_ADOPT_MS` timer turns it pending and
re-appends it, and the outbox is not clean meanwhile (§l.3 5).

### SIM-TUNING: `FAST_TUNING` vs DESIGN §d.6

§d.6 requires the causal re-read window (`causalRetries × causalRetryMs`) to be at least 2 × `provisionalAdoptMs`;
`causalWindowProblem` (`src/engine/runtime/options.ts`) checks it. The test harness's `FAST_TUNING`
(`src/engine/runtime/testHarness.ts`) breaks it: 2 × 60 ms against a 3000 ms adoption timer. The sim overrides it
(`SIM_TUNING`, `src/sim/device.ts`: 3 × 2 s), but other harness users run with the short window and can freeze docs a
real device would not.

### LINT: old lint errors

`npm run lint` has not passed for the new client (integration-notes §1 recorded the state at 9b618d5). CI runs
`typecheck`, `check:deps`, `guard:no-any` and `guard:no-real-time`, not ESLint.

### DEPS: remove the unused `y-partyserver`

`package.json` still lists `y-partyserver` 2.1.2 under dependencies. Nothing in `src/`, `server/src`, `tests/`,
`e2e/` or `scripts/` imports it.

## 2. Pending decision

### FRAMENO-IDB: frameNo collision after IndexedDB loss

ns/cfg replay protection (e2ee-design §8.2) needs every frame number of a device to be new. A store lost with an
uncommitted frame in flight, and no outbox mirror, restarts numbering from the committed edge, so the lost runtime's
frame and the new one can share a number: whichever commits second folds as `replay-duplicate` (sim seed 222, which
then trashed an attachment through PLAN-PRUNED). The current guard is a stopgap: a runtime's first number is at least
the wall clock in ms (44748cb2), ignored when the clock reads past 2^45 ms (f47950cb) (`FoldRuntime.skip`,
`src/engine/sync/foldRuntime.ts`). It depends on the wall clock moving forward across the loss. Being investigated:
a new writer identity (device id) after IndexedDB loss, so a fresh store never shares a replay window with the lost
one.

## 3. Bigger work

### RETIRE: relay row reclamation for deleted and pruned docs

§b.5, §c.9 and §d.9 describe `retired` checkpoints for the `b:`/`c:` streams of pruned docs and merged aliases, so
the relay can garbage-collect their rows. No engine code writes one (only the gate and catch-up know the encoding),
and catch-up does not adopt one it reads (`src/engine/sync/catchUp.ts` "gap: retirement handling"). Local `streams`,
`snapshots` and `tail` records of such docs are never deleted either (§e.1, §e.3). Rows of deleted notes, and junk
rows left by live creates that folded `merged` (integration-notes §5), cost relay storage and fresh-device reads
forever.

### SIM-COVERAGE: generators for coverage keys that never fire

`src/sim/coverage.ts` counts what the engines did; the keys still at 0 over 6 seeds of every matrix (2026-10-20) are
listed in wp-d-notes "Sim coverage". The largest gaps: socket closes at targeted points (before append, after commit
before receipt, between provisional and notice), dedupe-window expiry before a resend, malicious peer frames under
suite 0 (malformed, disallowed Yjs types, oversize, bad checkpoint), long offline past ns pruning (the prune cap is not
tunable), `brake.conflict-flood`, residency pressure, and the rarer fold outcomes and conflict-copy kinds. Each needs
an actor or fault that reaches it, then an assertion in `coverage.sim.test.ts`.

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
