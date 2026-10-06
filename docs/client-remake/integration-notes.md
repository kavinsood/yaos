# YAOS client remake: integration notes

Branch `client-remake`. These notes cover the integration pass that merged
WP-A..WP-D into one client: the host (Obsidian main thread) talks to the
engine (Web Worker, inline fallback) over the protocol, runs in the
simulation on the composed engine, and syncs through the real relay. Every
stand-in is gone (922d7d7).

Read with DESIGN.md (the spec), relay-wire.md (the wire), and the per-package
notes (wp-a..wp-d-notes.md). Section letters (§x.y) refer to DESIGN.md.

## 1. Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck:client` | clean |
| Dependency rules | `node scripts/check-deps.mjs` | 0 errors, 0 warnings |
| Unit + sim (200 seeds) | `npm run test:client` | see §6 |
| Sim, 1000 seeds | `YAOS_SIM_SEEDS=1000 npm run test:client` | see §6 |
| Full-client e2e, local relay | see §7 | see §7 |
| Full-client e2e, deployed relay | see §7 | see §7 |
| Production build | `node esbuild.config.mjs production` | see §8 |

## 2. Architecture

```
 Obsidian main thread (src/host)                       Engine (src/engine), Web Worker or inline
 ------------------------------------                  -------------------------------------------
 plugin.ts            Obsidian Plugin shell             workerMain.ts      worker entry (IIFE string)
 PluginController     plugin data, lifecycle, UI host   adapters/webEngine createEngine over web ports
 HostRuntime          wires one paired vault            compose/ProtocolEngine   init/ping/route
   EngineHost         carrier: probe, ping, restart,      VaultRuntime (one per vault epoch)
                      worker -> inline fallback             LogEngine      (runtime/) log side
   BindingManager     main Y.Doc per open note,             Reconciler     (reconcile/) disk side
                      CM6 binding, docDelta/docUpdate        BlobQueue      (blobs/)
   DiskExecutor       engine disk ops: lanes, slices,        CfgSync        (settings/)
                      write preconditions                    SnapshotJob    (snapshots/)
   vault feed         scan + create/modify/rename/delete     SyncedMirror   A/B side file
   side files,        .yaos/ mirrors, config dir             PassScheduler  drives passes
   config dir                                                HostLink       disk/config/side-file
 host/ui              status bar, settings tab, modals                      requests back to main
            \______________ src/protocol (messages, transports, ids) ______________/
```

The host never touches the network, Yjs merging, hashing of synced state or
compaction. The engine never touches a file: every disk read and write is a
rid-correlated request to the host's DiskExecutor (HostLink, §g.2).

### 2.1 Flows

- **Typing in an open note.** CM6 edits the main replica (BindingManager,
  §d.2). Local updates go to the engine as `docDelta`; the engine applies them
  to its worker replica and batches them into outbox frames (§d.4). Remote
  body frames pass the ingest gate (§d.6), apply to the worker replica, and
  go to the host as `docUpdate` (flow-controlled per doc, resync past 4x the
  credit window; compose/boundDocs.ts). The host writes the file itself
  (Obsidian's own save), so a bound doc is never written by the engine.
- **A file changed on disk** (external edit, unopened note, create, rename,
  delete). The vault feed sends observations; the Reconciler scans, the
  planner compares disk, synced and remote trees (§f), and the jobs author ns
  ops (`nsCreate`, rename, delete, setBlob) and body updates (minimal diff of
  the merged text).
- **A remote namespace change.** The ns fold (core/ns) folds ns frames; the
  fold bridge turns own frames into S1 own-fold events and puts every touched
  doc into the next pass scope; the planner projects the change as disk ops:
  plain `vault.rename` for moves, trash for deletes (§f.2).
- **Attachments** (§j.1). The planner emits `pushBlob` / `fetchBlob`; the
  BlobQueue moves bytes over the HTTP blob store, or over `x:<hash>` log
  chunk frames when the relay has no blob store. `nsCreate(kind=blob)` and
  `setBlob` are deferred until the upload is durable.
- **Settings** (§j.3). Allow-listed config-dir files sync through the `cfg`
  stream: JSON files as per-key registers, other files whole. Changes are
  picked up by full passes.
- **Recovery.** IDB loss re-imports the outbox and synced mirrors (§i.5);
  an epoch change migrates to the new epoch's DB (§c.12); quarantined rows
  retry after every session start.

### 2.2 Module map

Source under `src/` (excluding tests): 214 files, ~38.9k lines. Tests: 82
files, ~15.4k lines.

| Module | Files / lines | Role |
|---|---|---|
| `core/codec` | 9 / 1334 | lib0 codecs: envelope, nsOps, cfgOps, checkpoints, blob chunks, side-file mirrors |
| `core/ns` | 6 / 834 | ns fold (§c), overlay of own pending frames |
| `core/cfg` | 4 / 659 | settings fold (§c.11) |
| `core/paths` | 5 / 777 | pathKey (frozen case-fold tables), path validation (§c.2) |
| `core/plan` | 7 / 1155 | three-tree planner (§f.2) |
| `core/merge` | 5 / 1164 | merge engine, minimal token diff, applyEditsTo (§f.3) |
| `core/hash` | 5 / 910 | content hashes (markdown, canvas logical hash, blobs) |
| `engine/runtime` | 16 / 3070 | LogEngine: session loop, outbox, live ingest, catch-up, compaction, checkpoints, mirrors, quarantine, relay policy, blob chunks |
| `engine/store` | 2 / 1213 | IDB schema and transactions (§e) |
| `engine/body` | 8 / 1245 | body handles, residency, frame builder, counted Yjs calls |
| `engine/sync` | 6 / 717 | streams, frames, receipts, refs |
| `engine/ingest` | 3 / 285 | ingest gate (§d.6) |
| `engine/reconcile` | 18 / 2566 | Reconciler: scan, rename inference, jobs, intents, brakes, S1 own fold |
| `engine/blobs` | 2 / 284 | BlobQueue (persisted transfers, monotonic backoff) |
| `engine/settings` | 4 / 638 | CfgSync, per-key JSON plan |
| `engine/snapshots` | 1 / 230 | client snapshots (§j.4) |
| `engine/compose` | 11 / 2071 | ProtocolEngine, VaultRuntime, fold bridge, bound docs, HostLink, synced mirror, pass scheduler |
| `engine/adapters` | 11 / 2210 | web ports: IDB, WebSocket relay, HTTP blob, WebCrypto hash, clock, random |
| `host` | 16 / 3075 | EngineHost, HostRuntime, binding, DiskExecutor, Obsidian vault/workspace ports, plugin |
| `host/ui` | 16 / 2591 | status, settings tab, modals, notices |
| `ports` | 11 / 610 | port interfaces (§h) |
| `protocol` | 7 / 749 | main <-> engine messages, transports, ids (§g) |
| `sim` | 22 / 6111 | SimRelay, MemStoragePort, VirtualClock, SimNet, devices, actors, faults, invariants, runner |

Dependency rules (§k.2) are enforced by `scripts/check-deps.mjs` (and
`host/checkDeps.test.ts`): only tests import `sim/**`; the host imports only
`engine/adapters/webEngine` from the engine (deviation D1); engine core imports
only the pure adapters (`noopCrypto`, `webHash`, `webClock`, `webRandom`,
`webEngine`).

### 2.3 Composition details worth knowing

- **Protocol-ready is not vault-ready.** `init` answers `ready` as soon as the
  ports exist, even offline on a fresh device; the runtime keeps retrying in
  the background. Only an unusable store fails init (`storage-lost`), which
  makes the host fall back from the worker to inline (OR-1).
- **One engine, two carriers.** `workerMain.ts` and the inline carrier both run
  `createWebEngine`. The worker build is an IIFE string imported as
  `virtual:yaos-engine-worker` and started from a Blob URL.
- **Pass scheduling.** PassScheduler runs scoped passes on fold/observation
  events and full passes on a 5-15 min cadence (full passes also re-read
  settings). Unproductive passes back off; a blob retry timer is armed at the
  earliest due transfer (+5 ms).
- **S1 own fold.** Own ns frames move the synced tree forward only when they
  commit (`ownFold.ts`); the blob rev is the frame's own seq (bug 13).
- **Blob keep-both.** conflictCopy -> fetchBlob -> nsCreate(copy) ->
  pushBlob(copy), with the ns ops deferred until the upload returns true.
- **Bound-view retargets.** Fold events retarget bound docs when an entry
  becomes an alias (`merged`); renames re-open waiting views at the new path
  (bug 11).

## 3. Bugs found and fixed

Earlier integration fixes (bound-view reload base, token-aligned diff, sim
workspace fidelity) are in wp-d-notes.md, "Integration fixes". The list below
starts after the engine was composed (599117e). Each fix has a test that failed
before it; the sim seed that found it is noted (F = with faults, DEVn = n
devices).

| # | Bug | Found by | Fix |
|---|---|---|---|
| 1 | The conflict copy hashed and the merge job size-checked a read buffer after `exec` had transferred (detached) it. | composed tests | d6aeba5: hash first, send a copy; the fake gateway detaches like the real carriers; HostLink sends owned copies of shared views. |
| 2 | Fractional clock readings: the mirror `writtenAtMs` varuint threw and snapshot ids did not parse. | sim (VirtualClock is fractional) | f36602c: floor clock readings at the boundary. |
| 3 | The daily-limit wait used the relay's next 00:00 UTC against a skewed local clock; a device days slow held its outbox for days. | sim clockSkew | f13e8df: cap the wait at one day; a clock already past `resetAt` uses the default backoff. |
| 4 | `onBodyChange` did not exist, so bound views and the planner's body info missed remote body rows, adopted checkpoints and provisionals. | composition | ff4cffd: LogEngine fires `onBodyChange` for all three. |
| 5 | A file whose read failed transiently stayed unread: the pass reported nothing actionable, so nothing retried. | sim seed 16 | 95dc20c: passes report `unread`; the scheduler schedules a backed-off full retry pass while any file stays unread. |
| 6 | The host hashed canvas files as raw bytes, the engine with the canonical canvas hash, so preconditions never matched. | composed tests | eb218a6: the host uses the canonical canvas hash. |
| 7 | The worker entry test and the plugin smoke hung or failed in Node (no IndexedDB). | test:client | 7c9a390, 773be68: both run the real engine on fake-indexeddb and clean up; failures print run state and the engine log. |
| 8 | Quarantined rows whose release depends on a reader (ns/cfg) were never retried. | WP-C gap | e722138: retry reader-dependent quarantine after every session start. |
| 9 | Mirror recovery made no-base conflict copies: after IDB loss there is no stored base text, and the merge treated that as a two-sided conflict. | composed test (IDB loss) | 86c2a8b: with no stored base, merge against the synced side (the disk text the mirror says was in sync). |
| 10 | Epoch migration: a file re-created on two devices with different text kept only the winner; the loser became a conflict copy with no merge. | composed test (epoch reset) | 6cdac8e: the planner merges a differing re-create loser into the winner, 3-way on the path base captured before migration. |
| 11 | An open view waiting for `bindable{path}` stayed unbound forever when a remote rename moved it: the new path was live all along, so no bindable came. | sim seeds 18, 22, 39, 47 | c826375: the binding retries unbound slots at the new path on every vault rename. |
| 12 | Blob retry backoff ran on the wall clock: a -12.5 h clock skew parked an upload for 12.5 h. | sim seed 29 F DEV2 | a2f9889: the due time is monotonic; on reopen the persisted wall time is clamped to the backoff. |
| 13 | S1 own fold took the blob rev from the batch-end committed entry. An own setBlob and a later remote setBlob in one catch-up batch gave S = (own hash, remote rev), which reads as in sync, so the remote bytes never landed. | sim seed 35 F DEV2 | 19e075f: the rev is the own frame's seq. |
| 14 | Blob queue records whose hash was no longer planned stayed due forever and re-armed a 5 ms retry; the sim also declared quiescence while an upload was in backoff. | sim seeds 7, 54 F DEV2 | 05bf64c: after a full unbraked pass, drop transfers the plan no longer wants (settings blobs and intent docs are kept); the sim treats queued transfers as activity and checks the queue is empty at the end. |
| 15 | After an epoch migration a doc with no synced record merged 3-way against the old epoch's path base. That base can be ahead of the new epoch (offline imports, pending creates, acked edits the migrating peer never saw), so the peer's missing text read as deletions. | sim seeds 24, 34, 36, 41, 55 F DEV2; 34, 55 F DEV3 | 54cb43a: trust the path base only when it is a subsequence of the new epoch's text; otherwise merge with no base (the disk side survives as a conflict copy). |
| 16 | An identical duplicate create folded as merged; the rebind moved the loser's synced record and base, which held an edit only present in the loser's dropped frames, and merged before the winner's body arrived (empty text). | sim seed 46 F DEV2; 2 F DEV3 | d727691: the moved record restarts at the winner's create hash with no version (`restartAtCreate`); the planner waits `body-empty` while a create body is in flight; a CRDT text matching the synced hash serves as the base. |
| 17 | A remote delete of an open note trashed it while the editor still held edits in the 16 ms coalesce buffer. The unbind flush then authored them after the synced record was dropped, and nothing restored the doc (restore duty is acted on only through a synced record). | sim seed 30 DEV3 | 1e13b6f: trash of a bound path first posts the coalesce buffer; if there was anything, the trash fails as a precondition and the replan sees the pending body, so it restores instead (edit beats delete). |
| 18 | A bound doc whose merge result M differed from the disk D recorded the synced state with the current CRDT version, trusting the editor to save. A view closed (or an app crash) before that save left L = S with an equal version, so the file stayed at D for good. | sim seeds 56 F DEV2; 28, 21 F DEV3 | 260886e: such a merge records no body version (Rc stays true, the next unbound pass writes M) and reports a `deferred` job outcome that the scheduler does not chain or retry. Same in the conflict-copy intent resume. |
| 19 | A local rename made before ns was ready: edit-beats-delete re-created the old path (undoing the rename), the observed rename was forgotten after one pass, and a new file at the old path made the planner ignore it, so the open editor wrote into the wrong file. | sim seed 21 F DEV3 | 082e50c: the observed rename is kept until ns is ready and wins (§f.6). |
| 20 | After an IDB wipe the author re-read its own doc; every row was its own, so `onBodyChange` never fired and the disk side waited on `caughtUp` forever (the file stayed missing). | sim seed 179 F DEV3 | dab7011: a completed catch-up read always notifies the disk side. |
| 21 | Before ns was read, "no remote entry" was taken as "pruned on the relay" and the synced record dropped; a later rename then became a copy and both files ended up on every device. | sim seed 179 F DEV3 | 453496c: no prune verdict before ns is ready. |
| 22 | A local delete raced its own unsequenced body frames: `nsDelete.baseBodySeq` was below them, so the deleter itself held the restore duty, but it had dropped its synced record and restore was only planned through one. The other device (the edit's author) had lost its duty with a store wipe. Edits were lost. | sim seed 9 F DEV2 (rate 0.35), 26 F DEV5 | fcfeeec: the planner waits (`pending-body`) before `nsDelete` while own body records are in the outbox, and the runtime runs a docs pass on `onOwnBodySettled`; logPort adds the fallback duty (D11); a deleted entry with duty and no synced record is restored. |

Sim-only fixes found on the way (no client change): epoch names reused across
resets, one global clock skew instead of per-device, ledger coverage of
deletes, JSON settings `{}` equal to a missing file (D6), the heal loop
waiting on the blob queue.

## 4. Deviations from DESIGN

| # | Where | Deviation | Why |
|---|---|---|---|
| D1 | §k.2 | The host imports `engine/adapters/webEngine` (the inline carrier's entry), not `engine/runtime/engine.ts`. | The host may not import web adapters, and `engine/runtime/engine.ts` is now only the log side. `webEngine` is the one engine module the host may import; check-deps enforces it. |
| D2 | §g.5, §k.1 | The engine is bundled twice in `main.js`: as the worker IIFE string and as the inline fallback. | The fallback must not depend on `eval` / `new Function` (CSP). It costs about 420 KiB raw (see §8). |
| D3 | §g.2 | `init` answers `ready` when the ports exist, before the vault runtime has started; the runtime retries in the background. Only an unusable store fails init (`storage-lost`). | A fresh device offline must still get a protocol-ready engine; only storage failure should push the host to the inline carrier (OR-1). |
| D4 | §j.1 | When the relay's capabilities can't be read at startup (offline), the engine assumes the HTTP blob store exists and lets the blob queue retry. | Refs must not depend on whether a device happened to be online at startup (otherwise one attachment could be sent as a blob ref by one device and as `x:` chunks by another). |
| D5 | §c.12 | `intent{epoch-migration}` is not written. A crash in the middle of a migration restarts on the newest DB (the new epoch): the path bases are gone (no-base handling) and the old DB is not deleted. | Epoch resets are rare operator actions; the snapshot taken before migration (step 1) keeps every file version. |
| D6 | §j.3 | A JSON settings file whose fold has no keys is not created on peers (a local `{}` and a missing file are the same state). | JSON files are per-key registers; an empty register set has no file identity to project. The sim's settings invariant compares them as equal. |
| D7 | §l.3 | Sim invariants #4 (fold determinism, V3 digests) and #6 (resource bounds) are not checked by the sim runner. | #4 is covered by WP-A's 10k-op fold fuzz, #6 by WP-C's runtime tests and benchmarks. V3 digests are not implemented (see gaps). |
| D8 | §f.2 / §j.1 | The blob queue drops transfers the plan no longer wants after every full unbraked pass (keeps settings blobs and docs with open intents). | Not in DESIGN; without it a superseded transfer stayed due forever (bug 14). |
| D9 | §i | Blob retry backoff is monotonic in memory; the persisted wall time is only clamped to the backoff on reopen. | A wall clock jump must not park uploads (bug 12). |
| D10 | §i.4 | A settings change that touches reconcile or cfg options restarts the vault runtime (with the listing replayed). | Simpler than hot-swapping options in the planner and CfgSync; settings changes are rare. |
| D11 | §c.7 | Fallback restore duty: any device whose body stream holds a row past `deleteBaseBodySeq` restores at once (no 30 s grace, no hash timer, no upper bound at `deletedSeq`). | The primary duty is lost with the author's store (IDB wipe), and the deleter drops its synced record. The stream record keeps only the max row seq, not per-row `authorNsSeq`; the primary duty already counts rows after `deletedSeq`, so the fallback matches it. Double restores fold as `not-deleted`. Checkpoints carry no seq, so they can't trigger it. |
| D12 | §c.7 | A local delete (`nsDelete`) waits while the doc has own body / canvas records in the outbox. | Otherwise the delete base misses the device's own edits and the deleter gets a restore duty for its own delete. |

## 5. Honest gaps

Things that are not done, or done more narrowly than DESIGN, as of this commit.

**Engine**
- `textHash` duty is checked only for resident docs. The merge job handles
  identical content without a copy anyway, so the cost is an extra merge.
- The fallback restore duty has no 30 s grace and no hash timer (D11); a
  delete waits while the deleter's own body frames are unsequenced, so a body
  record stuck in the outbox (poisoned) holds that delete until it is resolved.
- Divergence (V3 digest) is not implemented; `divergence` is always false.
- `conflictCopiesToday` is always 0 and bootstrap progress is null in status.
- A job-level overwrite rejected through `rejectBrake` is not persisted; the
  brake comes back on the next pass. Planner-held ops are handled.
- Collapse noise: a third device can materialize a suffixed loser
  (`x (2).md`) before the winner device collapses it, so that device's trash
  gets a copy of the loser. Nothing is lost; the trash holds extra entries.
- The epoch-migration merge (bug 10) is markdown only; a differing canvas or
  attachment re-create still becomes a suffixed loser. Path bases live in
  memory only (D5).
- With neither a stored base nor synced-side text (rare after mirror
  recovery), the merge is still a no-base conflict copy.
- The ns/cfg reader halt is not retried on its own; quarantine release runs
  only at session start (bug 8).
- A file that stays unreadable is retried by a backed-off full pass (at most
  every 60 s), forever.
- Settings changes are seen on full passes (5-15 min by device class) and on
  `visible` / `resume`, not on config-dir file events.
- The client trusts the relay's `retryAfter` (capped at one day).

- One deployed full-client run took 15.5 s for a fresh device bootstrap of
  the small e2e vault (0.9 s locally); not investigated (one sample).

**Host**
- With IndexedDB missing in both carriers, the host stays in `starting` and
  retries with backoff; the UI shows the reason but there is no degraded mode.
- The host hashes canvas files only for write preconditions (the engine owns
  every other hash).
- The engine is duplicated in the main bundle (D2).

**Tests and sim**
- Token survival (`vaultTokens`) is checked against device A's vault only
  (after convergence every vault is equal, so this only matters when
  convergence already failed).
- The relay oracle is a fresh observer LogEngine that bootstraps from the
  relay; it sees relay state, not each device's store.
- App-crash token accounting is lenient: a token typed before the crash
  counts as unacknowledged unless it is on some disk, in trash, or in another
  device's resident doc. A store fork plus an offline inspector would make it
  strict.
- An app crash is `dispose(true)`: the runtime disconnects before anything
  can flush and MemStoragePort cuts open transactions. OS-buffered side-file
  writes are not modelled.
- The sim's client session computes the daily-limit `retryAfterMs` from the
  relay clock (both run on one VirtualClock); clock skew is applied per device
  elsewhere.
- The worker entry test can't reach a read without a relay; reads are
  covered by the e2e.
- `idbStorage.test.ts` "even a zero-delay timer is enough to lose the tx" is
  timing-sensitive and failed once under heavy machine load (passes alone).

## 6. Simulation results

_Filled in after the helper branches are merged; see the run log at the end._

## 7. End-to-end results

Harness: `e2e/client/fullClients.ts` (from the full-client e2e branch,
f0b7c63 / 8939943). Each client is a complete `HostRuntime` over the
simulated Obsidian vault/workspace/config dir/side files, with the real
composed engine on the production ports (wsRelay, relayHttp, idbStorage on
fake-indexeddb, suite-0 crypto), the inline carrier and real timers; 3 clients
plus a 4th device for bootstrap. Every scenario ends with a byte-identical
check of every file and every synced `.obsidian` file on every client, and
clean engine/host state. `smoke.ts` (RelayPort adapters) and `engines.ts`
(three headless LogEngines) are the WP-C e2e suites, still run.

```sh
URL=$(zsh scripts/relay-dev/start-local.sh --fresh | tail -1)
node --import jiti/register e2e/client/fullClients.ts --host "$URL" --label local
node --import jiti/register e2e/client/smoke.ts --host "$URL" --label local
node --import jiti/register e2e/client/engines.ts --host "$URL" --label local --relay-restart
zsh scripts/relay-dev/stop-local.sh
```

Scenarios: 1 fresh-vault creates; 2 disk / API / editor edits and concurrent
merges; 3 file and folder renames and deletes, including open views across a
remote rename and delete; 4 binary attachments (40 KB, 300 KB, 2 MB, modify);
5 `.obsidian` settings; 6 offline edits, offline typing in a bound editor and
reconnect; 7 relay process restart (local only); 8 fresh device bootstrap,
restart from IndexedDB and offline start.

| Run | Tree | Result |
|---|---|---|
| full-client, local relay (`--fresh`) | d2b5156 | 53/53 |
| smoke (adapters), local | d2b5156 | 56/56 |
| engines (`--relay-restart`), local | d2b5156 | 27/27 |
| full-client, deployed `yaos-relay2-scratch-3` (operator context) | 8939943 | 50/50 (scenario 7 skipped: remote) |

Latencies (ms) from the full-client runs, p50 / p95 (n). The host watcher
delay is 100 ms, the editor coalesce 16 ms; the clients and the local relay
share one laptop, which also ran the sim sweeps during the local run.

| Metric | Local | Deployed |
|---|---|---|
| start_to_clean | 1146 (1) | 1985 (1) |
| create_to_peer | 730 / 734 (18) | 889 / 1203 (18) |
| burst20_create_converge | 1124 (1) | 1322 (1) |
| disk_edit_to_peer | 525 / 526 (10) | 573 / 801 (10) |
| edit_to_peer | 423 / 425 (10) | 512 / 817 (10) |
| typing_to_peer_view | 122 / 124 (10) | 171 / 183 (10) |
| typing_to_peer_disk | 458 / 466 (10) | 514 / 827 (10) |
| rename_to_peer | 426 / 426 (4) | 502 / 502 (4) |
| folder_rename_to_peer | 430 (1) | 518 (1) |
| delete_to_peer | 426 / 463 (10) | 558 / 698 (10) |
| attachment_to_peer | 886 / 7013 (14) | 1613 / 8037 (14) |
| attachment_300k_to_peer | 676 / 676 (2) | 1914 / 1914 (2) |
| attachment_2m_to_peer | 7054 / 7054 (2) | 8366 / 8366 (2) |
| attachment_40k_to_peer | 886 / 900 (8) | 1608 / 1687 (8) |
| attachment_modify_to_peer | 623 / 623 (2) | 1543 / 1543 (2) |
| settings_to_peer | 318 / 327 (8) | 380 / 383 (8) |
| reconnect_converge | 2222 (1) | 3687 (1) |
| relay_outage | 2895 (1) | - |
| relay_restart_reconnect | 252 (1) | - |
| relay_restart_converge | 2847 (1) | - |
| fresh_bootstrap | 917 (1) | 15450 (1) |
| restart_from_idb_converge | 1419 (1) | 2582 (1) |
| offline_start_reconnect_converge | 1404 (1) | 2079 (1) |

`attachment_2m` is dominated by chunked upload through the log (no R2 in
these relay configs, so blobs travel as `x:` chunks; `blobPath` = `log`).
The deployed fresh bootstrap (15.5 s, one sample, against 0.9 s locally) was
not investigated; it is listed under gaps.

## 8. Bundle

_Filled in after the final build._

## 9. Manual test plan

Install `dist/yaos-client/yaos.zip` (unzip into `<vault>/.obsidian/plugins/yaos/`)
on every device, enable the plugin, pair each device to the same vault on a
scratch relay. Use throwaway vaults; keep the relay's operator view open to
watch heads. "Converged" means: open the same files on every device and
compare (or run `sha256sum` over the vault folder on desktop).

### 9.1 Desktop (macOS / Windows / Linux), two desktops A and B

1. **Pair and bootstrap.** Pair A with a vault of ~200 notes, 10 attachments
   (images, a PDF), 2 canvases, a `snippets/x.css`. Pair B with an empty vault.
   Expect: status goes `starting` -> `catching up` -> `live`; B ends with the
   same files; attachment bytes identical; no conflict copies.
2. **Carrier.** Settings tab, engine section: Transport is "Background
   worker". (There is no user toggle for the inline carrier; the fallback is
   covered by `engineHost.test.ts` and by 9.3-1.)
3. **Live typing.** Open the same note on A and B; type on both at once,
   including in the same paragraph. Expect characters on the other side within
   ~1 s, no lost characters, no conflict copies, cursor not jumping.
4. **External edits.** Edit an open note with another editor while it is
   open in Obsidian on A. Expect the change merges into the open view, no
   data loss, and B sees it.
5. **Rename and move.** Rename a note and move a folder on A (with links
   updated by Obsidian). Expect B renames the same files (no delete +
   re-create, no duplicate), open views on B follow the file.
6. **Delete.** Delete a note on A. Expect B moves it to Obsidian's trash
   (`.trash` or system trash per setting), never a hard delete.
7. **Delete vs edit.** Take B offline (disable network), edit note N on B,
   delete N on A, reconnect B. Expect N restored with B's edit (edit beats
   delete).
8. **Concurrent offline edits.** Both offline; edit the same line of one note
   differently on each; reconnect. Expect a merged note and, where lines
   conflict, a conflict copy named with the device and local time.
9. **Attachments.** Drop a 5 MB image on A; replace it with a different
   image of the same name; rename it; delete it. Expect each step on B.
   Add the same new image name on both while offline: one keeps the name,
   the other becomes a suffixed copy.
10. **Settings.** Change a hotkey, toggle a core plugin, edit
    `snippets/x.css` on A; focus B (or wait 5 min). Expect the same settings
    on B and a reload notice where Obsidian needs one. `plugins/yaos/` and
    `workspace.json` must never sync.
11. **Restart.** Quit Obsidian on A during a burst of typing; restart. Expect
    no lost characters that were visible for more than ~1 s, and catch-up of
    anything B did meanwhile.
12. **IDB loss.** In devtools on A, delete the `yaos-*` IndexedDB databases
    and reload the plugin. Expect recovery from the `.yaos` mirrors with no
    mass conflict copies and no re-upload of the whole vault.
13. **Relay restart / outage.** Restart the relay (or block it for a few
    minutes) while both type. Expect status `offline` -> reconnect with
    backoff -> all edits converge.
14. **Safety brake.** With Obsidian closed on A, delete more than 20% (and
    at least 50) of the notes from the OS file manager, then open Obsidian.
    Expect the brake notice on A ("Review held changes") and no deletes on B;
    approving sends the deletes, rejecting restores the files on A.

### 9.2 Android (Obsidian mobile), A = desktop, P = phone

1. Pair P to the vault from 9.1 over mobile data. Expect bootstrap to finish
   with the screen on; carrier `worker` (spike OR-1 showed worker + IDB work
   on Android).
2. Type on P with the soft keyboard (autocorrect, swipe typing, emoji, IME
   composition). Expect A sees the text without duplicated or dropped
   characters.
3. Background P (home button) mid-typing, wait 2 min, resume. Expect the
   text was flushed on `hidden`, P reconnects and catches up.
4. Kill Obsidian from the task switcher right after typing. Reopen. Expect
   the typed text present (saved or replayed from IDB) and on A.
5. Airplane mode: edit 5 notes, rename one, delete one, add a camera photo
   as an attachment; turn the network back on. Expect all of it on A.
6. Large vault (10k notes) bootstrap: expect status progress, no OOM, UI
   stays responsive (residency budget for the mobile class).
7. Check battery/data in Android settings after a day idle: no constant
   wakeups (the engine should be idle with the app in the background).

### 9.3 iOS / iPadOS, A = desktop, I = iPhone or iPad

1. Same as 9.2 steps 1-5. Watch the carrier: if WKWebView refuses IDB in
   the worker, the host must fall back to `inline` (status shows the
   fallback reason) and still sync.
2. Lock the phone mid-sync and unlock after 5 min. Expect `freeze`/`resume`
   handled: reconnect, catch-up, nothing lost.
3. iCloud-backed vault: let iCloud rewrite a file in the background. Expect
   an external edit merged (step 9.1-4), not a conflict loop.
4. Low storage warning: fill the device to < 500 MB free and edit. Expect a
   clear storage notice if IDB writes fail, no silent loss.
5. Split view on iPad with the same note open twice: both views stay in sync
   and saving one does not revert the other.

For every failure, collect: the "Export diagnostics" command output, the
relay head for the vault, and the conflict copies / trash entries made.
