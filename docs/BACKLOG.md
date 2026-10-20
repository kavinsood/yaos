# Backlog

Status: the open work as of 2026-10-21, on `sim-port`. The list is the project owner's (2026-10-21); the context
under each item is checked against the code and the notes it names. Done work is not kept here once merged (the last
section lists what landed on `sim-port` since 33bdf49b): it is in git history and in the notes
([integration-notes.md](client-remake/integration-notes.md) §3, the sim regression plans). Smaller known gaps that
nobody is working on are in [sync-contract.md](sync-contract.md) §13, integration-notes §5 and [wp-d-notes.md](client-remake/wp-d-notes.md) "Gaps and known issues".

Section letters (§x.y) refer to [DESIGN](client-remake/DESIGN.md).

---

## 1. Being fixed now

### CLONED-ID: a cloned vault folder shares one device identity

The device identity (`vaultId`, `deviceId`, device token) is plugin data, so it lives in the vault's
`<configDir>/plugins/yaos/data.json` (`src/host/pluginController.ts`). A vault folder copied to a second machine, or
synced there by iCloud, Syncthing or Dropbox, carries that file: both machines then run as the same device. Nothing
detects it. Each takes the other's ns frames for its own (`deviceId === self`, `src/engine/sync/ingestRow.ts`,
`src/engine/sync/foldRuntime.ts`), as confirmations of local work rather than remote changes: renames revert, files
are trashed, and creates and settings changes are dropped. The fix is being designed:

- an install marker that tells a cloned `data.json` from the install that wrote it, then a re-pair or a rotated
  device identity on the clone;
- a per-store writer tag, so two stores under one deviceId never take each other's frames for their own.

Proposed design: [identity-per-store](client-remake/identity-per-store.md) (an identity per IndexedDB store, a pairing
grant in data.json).

### FRAMENO-IDB: frameNo collision after IndexedDB loss

ns/cfg replay protection (e2ee-design §8.2) needs every frame number of a device to be new. A store lost with an
uncommitted frame in flight, and no outbox mirror, restarts numbering from the committed edge, so the lost runtime's
frame and the new one can share a number: whichever commits second folds as `replay-duplicate` (sim seed 222). The
planner no longer trashes the file when that happens (d1f8a750: an own create that folded as ignored is re-created),
but the collision itself stands. The current guard is a stopgap: a runtime's first number is at least the wall clock
in ms (44748cb2), ignored when the clock reads past 2^45 ms (f47950cb) (`FoldRuntime.skip`,
`src/engine/sync/foldRuntime.ts`). It depends on the wall clock moving forward across the loss. It stays until the
CLONED-ID design lands: a fresh store under a new writer identity (rotated device id or writer tag) never shares a
replay window with the lost one.

Proposed design: [identity-per-store](client-remake/identity-per-store.md).

## 2. Smaller open items

### QUARANTINE-UI: quarantine release control in the UI

§d.6 describes `releaseQuarantine{stream}` as a user action: re-gate a frozen doc's quarantined rows, apply what
passes, unfreeze. The command is in the protocol (`UserCommand`, `src/protocol/messages.ts`) and the engine handles
it (`src/engine/compose/runtimeOps.ts`, `src/engine/runtime/quarantineRelease.ts`), but nothing in `src/host` sends
it; only the sim does (`src/sim/e2eeFaults.ts`). A doc frozen by quarantine (malformed or disallowed peer rows,
`blob-corrupt`) is released only by the automatic retry at session start, which covers reader-dependent rows only,
or by **Rebuild local cache**. Needs a command or a button on the frozen-doc notice. (Causal-hole freezes no longer
need it: they thaw on their own, 3a569113.)

### LINT: the remaining error and the warnings

`npm run lint` runs (0ef758fa cleared the `src/` errors, 465 → 1). Left: one `obsidianmd/platform` error in
`src/host/spike/main.ts:214`, where the throwaway spike plugin records `navigator.userAgent` on purpose (the rule may
not be disabled), and about 590 warnings. CI does not run ESLint (`.github/workflows/ci.yml`).

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

## Landed on `sim-port` since 33bdf49b

Kept here until `sim-port` merges; then git history holds them.

- **BLOB-RETRY** (473cd500, after 31987119): a downloaded attachment whose disk write keeps failing backs its
  re-downloads off per (doc, hash), 1 min doubling to a cap scaled by size (10–60 min), and is listed
  `write-failed` with one notice (§j.1).
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
- **LINT** (0ef758fa): the `src/` error backlog cleared and `npm run lint` runs; what is left is under LINT above.
- **DEPS** (d26e533c): `y-partyserver` removed.
