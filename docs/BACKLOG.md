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
