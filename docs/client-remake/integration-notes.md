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
| Typecheck | `npm run typecheck:client` | clean (5735ad5) |
| Dependency rules | `node scripts/check-deps.mjs` | 0 errors, 0 warnings (5735ad5) |
| Unit + sim (200 seeds) | `npm run test:client` | 743 tests pass (5735ad5) |
| Sim, 1000 seeds | `YAOS_SIM_SEEDS=1000 npm run test:client`, run as the parallel sweep in §6 | 0 bad in every config (5735ad5, §6) |
| Full-client e2e, local relay | §7 | full 53/53, smoke 56/56, engines 27/27 (5735ad5) |
| Full-client e2e, deployed relay | §7 | 50/50, scenario 7 skipped as remote (5735ad5 + harness 5b1803e) |
| Production build | `node esbuild.config.mjs production` | OK, plugin smoke passes (5b1803e, §8) |

The last code change is 5735ad5; 5b1803e touches only the e2e harness
(onboarding sends an `Origin` header, §7). The commit after it holds only
these notes.

Latency pass, branch `client-remake-latency`, code as of a5ab167 (§7.1):

| Gate | Result |
|---|---|
| `npm run typecheck:client` | clean |
| `node scripts/check-deps.mjs` | 303 files, 0 errors, 0 warnings |
| `npm run test:client` | 758 pass, exit 0 |
| Full-client e2e, local relay (port 8791) | 53/53 |
| Full-client e2e, deployed `yaos-relay2-client-e2e` | 50/50, twice (scenario 7 skipped as remote) |
| `npm run build` | OK, plugin smoke passes; `main.js` 987.0 KiB (worker 438.4 KiB), zip 342,009 B |

### 1.1 Real-device relay

`https://yaos-relay2-client-e2e.kavinsood.workers.dev`: the streams relay
(`server/wrangler.toml` minus the R2 bucket, plus `YAOS_STREAMS=true`;
nothing beyond the free plan), deployed with
`zsh scripts/relay-dev/deploy.sh` (cf CLI session, no API token) from
93d72ee; later commits are client-only. It is claimed. The operator recovery
key, the host and the harness's vaults are only in
`experiments/logs/client-e2e-context-yaos-relay2-client-e2e.kavinsood.workers.dev.json`
(keys `host`, `operatorRecoveryKey`, `vaults`); never print it (§9.0 copies
it to the clipboard). Pairing steps for desktop, Android and iOS: §9.0.

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
| 20 | After an IDB wipe the author re-read its own doc; every row was its own, so `onBodyChange` never fired and the disk side waited on `caughtUp` forever (the file stayed missing). | sim seed 179 F DEV3; e2e branch (fault-heavy seed 7) | dab7011: a completed catch-up read always notifies the disk side. The e2e branch's 79b4a11 found the same bug; its catch-up test is kept (d2b5156). |
| 21 | Before ns was read, "no remote entry" was taken as "pruned on the relay" and the synced record dropped; a later rename then became a copy and both files ended up on every device. | sim seed 179 F DEV3 | 453496c: no prune verdict before ns is ready. |
| 22 | A local delete raced its own unsequenced body frames: `nsDelete.baseBodySeq` was below them, so the deleter itself held the restore duty, but it had dropped its synced record and restore was only planned through one. The other device (the edit's author) had lost its duty with a store wipe. Edits were lost. | sim seed 9 F DEV2 (rate 0.35), 26 F DEV5 | fcfeeec: the planner waits (`pending-body`) before `nsDelete` while own body records are in the outbox, and the runtime runs a docs pass on `onOwnBodySettled`; logPort adds the fallback duty (D11); a deleted entry with duty and no synced record is restored. |
| 23 | Binding a view posts `bindDelta = encodeStateAsUpdate(replica, engineSV)`. With nothing typed it still carries the delete set, and `applyLocalUpdate` framed it: a plain view open committed a body row, so a peer's concurrent delete read as edit-beats-delete and was undone. | full-client e2e (e2e branch 7cba904) | e3d7ab8: `applyLocalUpdate` drops updates that do not change the replica. The empty frames had masked bug 36: without them DEV5 F seeds 44, 77, 93, 133, 163, 185, 233, 234 failed until a06b66d/76e0e83 were in. |
| 24 | L joins a synced doc at S.pathKey, but the planner excluded every file at any R.pathKey from the fresh set. A file at the target of a remote move of a doc synced elsewhere was nobody's: the local rename became an nsDelete and the move's diskRename failed forever. | sim seed 285 DEV2 | 5811a3a: such a file is fresh (published, folds suffixed, the loser rename frees the path). |
| 25 | A pass cleared `ctx.renames` after its plan, dropping renames the host posted while the ops ran; with a save at rename time hash inference could not pair them, so the move became a copy. | sim seed 723 DEV2 | 74ddee6: the planner gets a snapshot; only those renames are cleared. |
| 26 | A remote move onto a file this device created (or renamed into) and the mover never saw: the file was taken as the mover's, never created (text lost), and the diskRename into the occupied path looped. | sim seeds 22, 143 F DEV5 (the same class was found by four helpers: seeds 711, 672, 906 F DEV3; heavy 79, 97) | ae211f4: the file is created like any other and the remote move waits for the path (`remoteOwns`, `moveBlocked`); an own create that would fold as an identical duplicate of the doc moving in is not submitted. |
| 27 | openDoc and checkBindable took the doc from the remote entry at the path even when the file there is another doc's (the remote moved Y onto it); the bind-time merge put that file's text into Y. | sim seed 100 F DEV3; 32, 92, 100 F DEV5; 539 F DEV3 | 2344da2: both use `bindTarget`, the planner's L lookup (§f.2). |
| 28 | Synced-mirror import set `bodyVersion {bodyRemoteSeq, 0}`; own rows read back never move remoteSeq, so an own edit that reached the relay but not the disk looked synced. | sim seed 30 F DEV5; 608, 690, 782, 903, 930 F DEV3 | 79f97a3: import with `bodyVersion = null` (§i.5 step 3). |
| 29 | A doc live only through this device's pending nsRestore was materialized at the overlay's guessed path; S1 then pointed S at the requested path, another doc's file, and the next pass merged that file in. | sim seed 193 F DEV5 | c53f50e: wait `pending-ns` like every other pendingLocal row. |
| 30 | Own fold events were applied at the start of a pass, but the reconciler awaits hashing and intents before reading the view; an own op folding in that window was planned without its S1 update. | reconcile test (no seed seen) | 5f40c56: `ReconcilerDeps.takeOwnFold`, drained with no await before the view read. |
| 31 | A creator whose store went after its nsCreate was acked but before its first body frames reached the relay left every device waiting `body-empty` forever. | heavy seeds 17, 90, 194, 243; 766 F DEV3 | 5db5c16: the creator pushes its file (disk-only merge) or nsDeletes the empty shell. |
| 32 | A markdown merge recorded the sync point with the frame's localOrder although editor keystrokes rode the same frame; a close before the save left them off disk for good. | heavy seed 119 | 3e49a7c: if the CRDT text after the close differs from the merge result, S gets no CRDT sync point. |
| 33 | After IDB loss, own rows the new store never receipted and frames imported from the outbox mirror did not move the body version, so own unsaved text stayed off disk. | heavy seeds 119, 130, 150 | 34fbf43: both move the version like a remote row / T_edit. |
| 34 | A local rename onto the path of a remote doc never written here merged the file into the remote doc; the moved doc's bound editor refused the write and every pass added a conflict copy. | heavy seed 222 | 88122fa: the renamed doc moves; the remote doc waits for the path. |
| 35 | The app died inside the outbox-mirror debounce: the next run never rewrote the mirror while the synced mirror moved on to sync points resting on those frames. A later IDB loss recovered a hash matching disk but not the CRDT, and the merge overwrote the text. | heavy seed 246 | d471cc6: the start rewrites a lagging outbox mirror; 36a4cff: the synced mirror is written only after the outbox mirror holds the outbox (a failed write stays dirty). |
| 36 | Planner rebinds (merged alias, identical-loser collapse, §c.12 migrated loser) moved the synced record to the winner but did not retarget a bound editor, which kept typing into the loser. | sim seeds 668, 924 F DEV3; with bug 37, the eight DEV5 seeds of bug 23 (epoch reset with notes open) | a06b66d: `ReconcilerDeps.onRebind`; the runtime posts `docRetarget`. |
| 37 | A view bound a create whose initial content was not in the body yet (the re-create after an epoch migration re-opens views at once); the bind-time merge took "" with no base as a conflict, emptied the editor and wrote a conflict copy. | composed test (epoch reset, note open) | 76e0e83: the same gate as the planner's `body-empty` wait. |
| 38 | After an IDB loss S came back at the old path (re-materialized with the peer's edit) while the user's renamed copy, still the create content, sat at the remote path. That file is never created (an own create would fold as a duplicate of the doc moving in) and the remote move waited for the path forever. | heavy seed 79 | 324152e: a remote move blocked by an untracked copy of the doc's own bytes (its current file or its create content) trashes the copy; the move follows on the next pass. |
| 39 | S1 set `synced.path = requestedPath` for a suffixed own rename (§c.13) after a later own rename (same batch or pending), or a pass between the fold and the S1 batch, had already moved S and the file. Two synced records sat on one path and a diskRename of the other doc's file was retried forever. | sim seeds 351, 386, 481 F DEV3 | 2d17824: S1 leaves the path alone once S has moved on; restore gets the same guard. |
| 40 | After IDB loss the synced mirror could predate an own rename job; the replayed own fold only bumped `nsTouchSeq`, so S stayed at the old path, the planner retried the remote move onto the doc's own file and pushed that file as a new doc that merged back, forever. | sim seed 405 F DEV3 | be0f957: S1 moves S to an applied own rename's path while S is still behind the op. |
| 41 | The suffixed-restore moved-on check compared S with the requested path only; a pass that had already projected the revived entry at its suffixed path got the requested path (another doc's file) written back, and the same push-and-merge-back loop followed. | sim seed 193 F DEV3 | d480b1a: S1 also leaves S alone when it already sits at the final path. |
| 42 | The user renamed n2 -> r5 and created a new n2.md before ns was ready while a peer moved the doc n2 -> r1. The re-occupied-source inference (bug 19) only looked at docs whose remote path was still the synced path, so the new n2.md was carried to r1.md as the doc's file and r5.md became a new doc. | sim seed 21 F DEV3 | b6e2686: the observed rename wins over a concurrent remote move as well (nsRename to r5); the file at the old path is planned as new once S has left it. |
| 43 | A local delete that waited (`pending-body` or ns not ready, D12) left S in place, so a new file the user then created at the path merged into the old doc as a save. The diff kept fragments of the old text, the peer's concurrent delete of that text took them, and a token of the new note was lost. | heavy seed 92 (fix sweep: heavy 22, DEV5 F 140) | e3982bc: the waiting delete is decided (`SyncedEntry.fileGone`): the file at S's path is a new file from then on, and is created once the delete has gone out (a productive pass's follow-up covers the paths it vacated). A file at the doc's remote path is still its own (heavy 22: an own rename marked offline). See D17. |
| 44 | A renamed the open note n6 -> r4 before ns was ready (a waiting delete, D17) and another note n4 -> r2, while a peer moved the doc n6 -> r2. The first ns-ready pass took the file at r2, the doc's remote path, as the doc's own: the other note merged into the doc as a conflict, r4 became a duplicate doc, and the views on r4 stayed bound to the old doc. That doc's merge never wrote r2 (a bound doc waits for the editor's save, and that save could only reach r4). | sim seed 452 F DEV3 | 5735ad5: a file that an observed rename brought from another path is not the doc's (`localFor`, `remoteOwns`), so the doc follows its own rename and the other note is a new doc. Engine side: `BoundDocs.path` follows vault renames (the views move with the file), and a pass that creates a doc at a bound view's path retargets those views to it. |

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
| D13 | §c.6, §i.5 | A doc this device created whose create body is gone everywhere (acked nsCreate, no rows on the relay, nothing pending, store lost) is pushed from the file as a disk-only merge, or nsDeleted if the file is gone too (bug 31). | DESIGN has no owner for this state; every device waited `body-empty` forever. |
| D14 | §i.5 | After IDB loss, own body rows the new store never receipted, and frames imported from the outbox mirror, move the body version like remote rows (bug 33). Mirror import sets `bodyVersion = null`, which the planner reads as "remote changed" rather than doing the spec's content comparison (bug 28). | Otherwise own text that reached the relay but not the disk looks synced. The null version is a conservative superset: one extra reconcile per recovered doc. |
| D15 | §f.6 | An observed rename onto the path of a remote doc never materialized here moves the renamed doc; the remote doc waits for the path (bug 34). | The file came from the rename source, so it is the moved doc's; merging it into the remote doc made the bound editor refuse writes and every pass add a conflict copy. |
| D16 | §f.2 | A remote move whose target holds an untracked copy of the doc's own bytes trashes that copy (no sync op, `diskTrash` with a hash precondition, braked like any trash), then moves (bug 38). Other bytes at the target are a new file (created; the move waits). | The copy can never be created (it folds as a duplicate of the doc moving in), so the move would wait forever. Trash keeps the bytes. |
| D17 | §c.7, §f.2 | A local delete that has to wait marks `SyncedEntry.fileGone` (bug 43): the delete is decided at the first pass that sees the file missing, even offline or before ns is ready. A file then at S's path is a new doc (created after the delete goes out), not a save of the old one. The mark is a braked `nsDelete` unit (rejecting the brake re-materializes the doc); the later `nsDelete` is not braked again. Edit beats delete still applies while waiting: with a remote edit the doc re-materializes at its remote path, or, if the new file sits at that same path, the file merges into the doc (the mark is cleared). The mark is not in the synced mirror. | DESIGN treats delete-then-create at one path as a save. Merging an unrelated new note into the old doc lost text (the diff keeps fragments of the old text, which a peer's concurrent delete then removes). Rename inference is off before ns is ready, so a file at the doc's remote path stays its own, unless an observed rename brought it there from another path (bug 44). |

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
- `fileGone` (D17) lives in the store only: after an IDB loss the mirror
  brings S back without it, so a file re-created at the path while the delete
  waited merges into the old doc as a save (the pre-D17 behaviour).
- D17 keeps one merge case: a waiting delete, a remote edit of the doc, and a
  new file at the doc's remote path merge that file into the doc (edit beats
  delete). It is rare enough to accept; no sweep hit it.
- The bind-time merge (openDoc) does not use the §c.12 path-keyed epoch base
  that the merge job uses (`trustedEpochBase`): a note edited offline while
  open across an epoch reset gets two conflict copies where a 3-way merge was
  possible. Nothing is lost.
- A disk write right after an epoch reset, with the note open, is overwritten
  when the reset saves the open views (the sim models it as Obsidian's own
  overwrite and exempts it).

**Latency (§7.1)**
- Bootstrap storage work is not batched: ~3 IDB tx per note (the per-stream
  catch-up apply, `store/repo.ts:471`; the materialize read; the per-note
  synced/localTree commit, `reconcile/store.ts:90`). It bounds the local run
  and the last ~1 s of the deployed run. Batching the commit would break the
  write-file-then-record order that crash recovery relies on, so it was left.
- Blob jobs that run before catch-up has read their `x:` stream still read
  it from the relay (9 of 22 in the deployed run), the same bytes catch-up
  reads again. These reads (`readBlobChunks`) do not go through the catch-up
  lanes, hence the 5th request on the wire. The rare `checkpoint-disputed`
  retry read also runs outside the lane chain.
- Session start reads ns (+ cfg) in its own request before catch-up starts:
  one round trip by design (ns is folded before live).
- Each leading-edge commit costs 2 extra rows per stream it touches (free
  plan row budget); at most one per `gcQuietMs` (1.5 s) per vault. Edits
  closer together than that keep the 300 ms idle grouping (full e2e
  `edit_to_peer` ~480 ms deployed).
- The bench and e2e run the inline carrier with the tablet budget (4 lanes,
  2 blob jobs); desktop numbers with the worker budget are not measured.
- The deployed per-request cost (~220 ms against a ~24 ms edge round trip)
  is three sequential DO hops per request (`server/src/index.ts:275`),
  outside `server/src/streams/*`; not touched.

**Pairing and packaging (found while writing §9)**
- The pair modal says codes come from a paired device "or in your server's
  console" (`pairModal.ts:61`). The console only issues owner setup and
  recovery codes; a generic device code is refused with 409
  `collaboration_authority_required` (`server/src/routes/operator.ts:146-153`).
- The mobile setup page and the claim page tell the user to install YAOS
  from Community plugins (`server/src/setupPage.ts:46,569,611`); this client
  is not published, so it has to be side-loaded (§9.0).
- `package.json` says 2.1.0, `manifest.json` 3.0.0. `styles.css` is legacy:
  none of its classes are used by `src/host/ui`, and the zip does not ship it
  (the modals render unstyled, which works).
- Unpairing leaves the device listed on the server (the confirm dialog
  says so, `settingsTab.ts:347`); there is no in-app way to create a vault
  on a claimed server (operator console only).
- The relay has no R2 binding, so attachments travel inline as `x:` chunks
  (cap 8 MiB per blob on this config).

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
- Bug 44's engine half (views retargeted to a doc created under them,
  `retargetCreatedUnderViews`) is reached only by sim seed 452 (DEV=3 F). The
  composed test for that scenario passes without it too, because its engine
  restart re-binds the views on its own; it guards the scenario, not the
  method. The planner half has a unit test that fails without the fix.
- `idbStorage.test.ts` "even a zero-delay timer is enough to lose the tx" is
  timing-sensitive and failed once under heavy machine load (passes alone).

## 6. Simulation results

`src/sim/run.test.ts` runs the composed engine (one per device, real
planner, reconciler, LogEngine, MemStoragePort) against SimRelay on one
VirtualClock and checks the DESIGN §l invariants after every seed:
convergence (byte-identical vaults and synced `.obsidian` files; an open view
that never bound is reported here too), quiet (no pending work after the
settle), clean (engine/host state), tokens (every acknowledged typed token is
in some vault, trash or conflict copy) and destroyed (no acknowledged content
lost). `npm run test:client` runs 200 seeds. The 1000-seed gate ran as a
parallel sweep over the same `runSim` (11 shards of
`runSim({ seed, devices, faults, faultRate })`) in four configurations:

| Config | Seeds | Before the fix round (after 23dda34) | 42bf734 | 8446af3 | 5735ad5 (final) |
|---|---|---|---|---|---|
| 2 devices, no faults | 1-1000 | 2 bad (285, 723) | 0 | 0 | 0 |
| 3 devices, default faults | 1-1000 | 38 bad, 15 token/destroyed | 3 bad (21, 405, 452), 1 token | 1 bad (452) | 0 |
| 5 devices, default faults | 1-250 | 9 bad, 4 token/destroyed | 0 | 0 | 0 |
| 2 devices, faults at rate 0.35 (heavy) | 1-250 | 13 bad, 9 token/destroyed | 2 bad (79, 92), 1 token | 0 | 0 |

"Bad" is a seed with any violation; "token/destroyed" counts the seeds whose
violations include a lost acknowledged token or destroyed content, the ones
that would lose user text. Each failing seed was replayed with an observer
(`obs.ts`: files, views, bindings, S/remote rows and the plan per pass) and
fixed at the cause; bugs 23-44 in §3 cite their seeds. The heavy config is
the one most likely to regress: it found the IDB-loss and outbox-mirror
ordering bugs (heavy 119, 246) and the waiting-delete case behind D17
(heavy 92).

Final run on 5735ad5: 3000 + 250 + 250 seeds, 0 bad, 0 token failures;
`npm run test:client` (743 tests including the 200-seed sim) passes.


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
| full-client, local relay (`--fresh`) | 5735ad5 | 53/53 |
| smoke (adapters), local | 5735ad5 | 56/56 |
| engines (`--relay-restart`), local | 5735ad5 | 27/27 |
| full-client, deployed `yaos-relay2-scratch-3` (operator context) | 5735ad5 + 5b1803e harness | 50/50 (scenario 7 skipped: remote) |

Earlier runs: local d2b5156 (53/56/27, all pass) and deployed 8939943
(50/50), recorded when the full-client e2e branch was merged. Run logs are in
`experiments/logs/client-e2e-full-{local-20261006T113823Z,deployed-20261006T114251Z}.json`.

The deployed relay changed between the two deployed runs: `scratch-3` was
redeployed (around 17:04 IST, not by this pass) with the
`experiments/yaos-server` build. That build enforces its D5 rule: operator
JSON routes and `/claim` need a same-origin `Origin` header, which a browser
sends and the Node harness did not, so the first attempt failed at operator
login with 403 `forbidden_origin` (no client code involved). 5b1803e makes
the harness onboarding send `Origin: <relay origin>` on those routes; the
rerun passed. The new build also serves blobs over HTTP (`blobPath` = `http`
on every client; the local relay and the earlier deployed build used `log`).

Latencies (ms) from the 5735ad5 full-client runs, p50 / p95 (n). The host
watcher delay is 100 ms, the editor coalesce 16 ms; the clients and the local
relay share one laptop. Single-sample rows (n = 1) are noisy: the local relay
restart rows include the reconnect backoff, which moved them from 252 / 2847
ms in the d2b5156 run to 2960 / 5949 ms here. The deployed column is a
different relay build from the earlier run (above); its text-to-peer p50s are
0.4-1.1 s slower than that run's, and its attachments (HTTP blobs) are faster
for 2 MB and slower for small files.

| Metric | Local | Deployed |
|---|---|---|
| start_to_clean | 1144 (1) | 2704 (1) |
| create_to_peer | 738 / 754 (18) | 1995 / 2191 (18) |
| burst20_create_converge | 1141 (1) | 2420 (1) |
| disk_edit_to_peer | 531 / 536 (10) | 994 / 1375 (10) |
| edit_to_peer | 432 / 435 (10) | 1008 / 1275 (10) |
| typing_to_peer_view | 124 / 129 (10) | 176 / 240 (10) |
| typing_to_peer_disk | 464 / 466 (10) | 997 / 1316 (10) |
| rename_to_peer | 430 / 430 (4) | 982 / 982 (4) |
| folder_rename_to_peer | 432 (1) | 1002 (1) |
| delete_to_peer | 430 / 507 (10) | 994 / 1005 (10) |
| attachment_to_peer | 908 / 6987 (14) | 2414 / 2966 (14) |
| attachment_300k_to_peer | 648 / 648 (2) | 2674 / 2674 (2) |
| attachment_2m_to_peer | 7025 / 7025 (2) | 2966 / 2966 (2) |
| attachment_40k_to_peer | 912 / 913 (8) | 2363 / 2556 (8) |
| attachment_modify_to_peer | 639 / 639 (2) | 2414 / 2414 (2) |
| settings_to_peer | 340 / 343 (8) | 1000 / 1154 (8) |
| reconnect_converge | 2293 (1) | 3191 (1) |
| relay_outage | 3990 (1) | - |
| relay_restart_reconnect | 2960 (1) | - |
| relay_restart_converge | 5949 (1) | - |
| fresh_bootstrap | 789 (1) | 5068 (1) |
| restart_from_idb_converge | 1410 (1) | 2534 (1) |
| offline_start_reconnect_converge | 1397 (1) | 2477 (1) |

Locally `attachment_2m` is dominated by chunked upload through the log (no
R2 in the local relay, so blobs travel as `x:` chunks; `blobPath` = `log`).
The deployed fresh bootstrap (5.1 s here, 15.5 s in the earlier deployed run)
is explained and fixed in §7.1.

### 7.1 Latency pass (branch `client-remake-latency`)

Probes, both on the production ports of FullClients, logs without secrets in
`experiments/logs/client-e2e-{boot,edit}-<label>-<stamp>.json`:
- `e2e/client/bootBench.ts`: a writer seeds N notes + attachments, then fresh
  devices boot one after another with a BootTrace (`bootTrace.ts`): every
  relay HTTP call by route, the socket, every storage tx, engine and disk
  samples every 5 ms, and a read timeline. Spans are also given in relay
  round trips (median of a timed authenticated feed request).
- `e2e/client/editTrace.ts`: per edit, the socket frames of writer A and
  reader C (APPEND out, COMMIT_NOTICE in, receipt) and C's disk.

```sh
node --import jiti/register e2e/client/bootBench.ts --host URL --label L --notes 1000 --attachments 20 --big 2 --repeat 2
node --import jiti/register e2e/client/editTrace.ts --host URL --label L
```

Deployed means `yaos-relay2-client-e2e` (§1.1; Worker built from 93d72ee;
every later commit is client-only). One authenticated deployed request takes ~220 ms from this laptop against a ~24 ms edge round
trip: the Worker resolves auth state, then the vault DO, then authorizes,
three sequential DO hops per request (`server/src/index.ts:275`). The
harness runs the inline carrier (`fullKit.ts:166`), so `deviceClassFor`
(`runtimeSupport.ts:20-29`) gives the tablet budget: 4 catch-up lanes, 2 blob
jobs, 4 MiB disk I/O in flight (a desktop with the worker gets 8 / 4 / 8 MiB).

**Bootstrap root causes and fixes**

1. *One HTTP read per stream.* Catch-up sent one `GET /streams/read` per
   stale stream, `catchUpConcurrency` at a time: 1045 requests for 1022
   files, ~261 rounds of 4 lanes at ~230 ms each (61 s deployed). Fix: the relay
   serves many streams per request (`GET /streams/read?maxBytes=B&r=<after>.<0|1>.<stream>`,
   up to 128 entries under one 1 MiB budget, advertised as
   `readBatchMaxStreams`; `server/src/streams/*`, 18ea6fd) and each catch-up
   lane sends one batch (`RelaySession.readBatch`, `sessionLoop.ts`
   scheduleCatchUp/runBatch; ns + cfg in one request before live; 26e2cf9).
   Members a response did not serve are read on one at a time on the same
   lane, so a lane never has two requests on the wire (ba01198).
2. *Attachments, one round trip each, read twice.* The plan runner runs ops
   in order (§f.2; `reconcile/runner.ts:138-157` at ba01198). Each blob
   materialize awaited `blobs.download` (`diskJobs.ts:158`) -> `BlobQueue` ->
   `readBlobChunks` -> one relay read per blob (`runtime/blobChunks.ts:53` at
   ba01198).
   22 attachments were ~22 serial requests (~5 s deployed), and the 1000
   notes waited behind them in the same pass (`att/` sorts first). The read
   timeline showed it: single ~55 KB reads back to back from 1.7 s to 6.5 s,
   after catch-up had already put every `x:` stream in the local tail
   (rank 4, `engine.ts:59`) at 3.4 s. Fixes: blob jobs prefetch the next
   downloads while the current op runs (`BlobQueue.prefetch`, window
   `blobConcurrency - 1`, held bytes <= `maxDiskIoBytesInFlight`, leftovers
   dropped after the pass; 9a76b06), and `readBlobChunks` assembles from the
   local tail when the tail holds the whole blob, else reads the relay
   (61db34d).

Fresh device, 1000 notes + 20 x 40 KB + 2 x 300 KB attachments (1022 files,
vaultSeq 1047), two fresh devices per run. ms until every file is on disk /
until clean convergence; reads = `/streams/read` requests.

| Run | Tree | Files on disk | Clean | Reads |
|---|---|---|---|---|
| local, before | 41e2950 | 5712 / 5378 | 5889 / 5553 | 1045 |
| local, batched reads | 93d72ee | 4398 / 4208 | 4579 / 4388 | 32 |
| local, + blob prefetch / tail | a5ab167 | 4066 / 3649 | 4245 / 3828 | 32 |
| deployed, before | 41e2950 | 61485 / 60346 | 63060 / 62180 | 1045 |
| deployed, batched reads | 93d72ee | 7901 / 7516 | 8083 / 7695 | 35 |
| deployed, one request per lane | ba01198 | 7762 / 7479 | 7942 / 7662 | 35 |
| deployed, + blob prefetch / tail | a5ab167 | 4036 / 4306 | 4217 / 4488 | 19 / 20 |

150 notes, no attachments, one fresh device: local 295 -> 132 ms, deployed
9307 -> 1359 ms (151 -> 3 read requests). The full e2e's own
`fresh_bootstrap` (scenario 8, ~40 files including a 2 MB attachment), on
this deployed relay: 13369 ms (41e2950) -> 3012 / 2865 ms (a5ab167, two
runs); local 783 -> 820 ms (n = 1, noise).

Where the deployed 4.0 s goes now (a5ab167, boot 1, 224 ms per request):
socket ready at 0.39 s (ticket + upgrade), two feed pages to 0.93 s, the ns
read (folded before live) to 1.21 s, then 9 catch-up batches on 4 lanes and
9 blob reads (jobs that ran before catch-up reached their `x:` stream) until
3.05 s, at most 5 requests on the wire (reads span 9.5 round trips). Disk
writes run 1.50-4.02 s, and all but 6 of the 1022 land after 2.9 s. The
tail end is local work: ~3 storage tx per note (catch-up apply, reconcile read, synced/
localTree commit; 3083 tx, 1.8 s of tx time on fake-indexeddb), the same
cost that bounds the local run. Deployed is now within ~0.3 s of local.

**Edit to peer.** The relay commits a group after 300 ms idle (1500 ms max),
and a peer projects an edit of a note it does not have open to disk only on
COMMIT_NOTICE, so every isolated edit waited the idle window. Fix: a frame
that opens an empty buffer after 1500 ms without a commit commits after
20 ms (`gcLeadMs` / `gcQuietMs`, `server/src/streams/relay.ts:58-77`,
2c3afd1). A burst pays at most one extra commit at its start (2 rows per
stream it touches) and then groups as before. Medians of 8 isolated edits
(1.5 s apart), C's disk, ms:

| Edit | Local before | Local after | Deployed before | Deployed after |
|---|---|---|---|---|
| API write | 417 | 138 | 468 | 197 |
| External disk write | 517 | 238 | 568 | 306 |
| Typing in a bound view (C not open) | 450 | 172 | 503 | 232 |

Deployed after, API write: APPEND out at 85 ms, COMMIT_NOTICE on C at 160 ms,
disk at 197 ms. The 85 ms before the frame leaves are client side: the host's
50 ms vault-event batch (`VAULT_EVENT_BATCH_MS`, `runtimeSupport.ts:16`) plus
engine work; the disk write adds the harness's 100 ms watcher delay. Edits
that follow another commit within 1500 ms keep the old grouping: the full
e2e writes edits back to back, so its `edit_to_peer` stays ~430 ms local /
~480 ms deployed (a5ab167, two deployed runs: edit 477 / 481, disk edit
572, create 942 / 837, typing to view 174).

## 8. Bundle

`node esbuild.config.mjs production` on 5b1803e (code as of 5735ad5) writes
`dist/yaos-client/yaos.zip`. The build's own smoke check passed: the zip
layout, no WASM, onload -> running/inline -> unload (7 commands), and a worker
ping/pong.

| Artifact | Size |
|---|---|
| `main.js` | 978.5 KiB raw (1,001,990 B), 318 KiB gzip (325,276 B) |
| of which the worker IIFE string | 434.2 KiB |
| `yaos.zip` (`yaos/main.js`, `yaos/manifest.json`) | 331.2 KiB (339,181 B) |

The engine is in `main.js` twice (D2): once as the worker string, once as the
inline fallback.

## 9. Manual test plan

Install the plugin on every device and pair each one to the same vault on a
scratch relay (§9.0). Use throwaway vaults; keep the relay's operator view open to
watch heads. "Converged" means: open the same files on every device and
compare (or run `sha256sum` over the vault folder on desktop).

### 9.0 Setup: relay, plugin, pairing

**Relay.** `https://yaos-relay2-client-e2e.kavinsood.workers.dev` (§1.1),
already claimed. Its operator recovery key is only in the harness context
file; put it on the clipboard without printing it:

```sh
jq -r .operatorRecoveryKey /Users/kavin/personal/obsidiansync/experiments/logs/client-e2e-context-yaos-relay2-client-e2e.kavinsood.workers.dev.json | pbcopy
```

**Plugin.** `npm run build` (tsc, then `node esbuild.config.mjs production`)
writes `dist/yaos-client/yaos.zip` with `yaos/main.js` and
`yaos/manifest.json` (id `yaos`, minAppVersion 1.13.0) and runs the plugin
smoke check; `dist/yaos-client/yaos/` is the same folder unpacked. The
folder must be named `yaos`:
- Desktop: `unzip dist/yaos-client/yaos.zip -d "<vault>/.obsidian/plugins/"`.
- Android: `adb push dist/yaos-client/yaos "/sdcard/<vault folder>/.obsidian/plugins/"`
  (the vault folder is where Obsidian created it, often
  `/sdcard/Documents/<vault>`), or copy the folder over USB file transfer.
- iOS / iPadOS: the Files app does not show dot-folders, so `.obsidian` can't
  be reached there. Use a vault stored in iCloud Drive and copy from a Mac
  into `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<vault>/.obsidian/plugins/yaos/`,
  then wait for the files to appear on the device. iCloud then also syncs that
  vault (that is what 9.3-3 tests).

In Obsidian: Settings -> Community plugins -> turn community plugins on
(Restricted mode off) -> reload the installed list -> enable YAOS. The status
bar shows `YAOS: not paired`. Obsidian mobile has no status bar; use the YAOS
settings tab (Phase, Unsynced changes) there. Never copy
`.obsidian/plugins/yaos/data.json` between devices or vault copies: it holds
the device credential (`src/host/ui/api.ts:16-21`), and a copy makes two
installs one device.

**First device (vault owner).**
1. Open the relay URL -> "Operator sign-in" -> paste the key -> Open console.
2. Enter a vault name -> Create vault. The console issues an owner setup
   code at once and shows it with "Open in Obsidian" and "Open mobile setup"
   links. It is shown once, works once, and expires after 15 minutes (if it
   lapses, the vault card has "Issue owner setup code" while the vault has
   no owner).
3. On the device, click "Open in Obsidian" (opens the pair modal prefilled),
   or run the command "YAOS: Pair this device" and enter the server URL and
   the code. The device name defaults to the platform. Pair -> notice
   "YAOS: this device is now paired with <host>." -> status `starting…` ->
   `catching up` -> `synced`.

**Every other device.**
4. On a paired device run "YAOS: Pair another device" (also a button in the
   YAOS settings tab). It shows the server URL, a pairing code, a setup link
   (`obsidian://yaos?action=setup&...`) and a mobile setup page
   (`<relay>/mobile-setup#...`), each with Copy, and the expiry countdown. One
   code pairs one device, within 15 minutes.
5. On the new device: open the setup link (desktop), or open the mobile
   setup page in the phone's browser and tap "Connect Obsidian" (ignore its
   "install from Community plugins" text, §5), or run "YAOS: Pair this
   device" and paste the URL and code.
6. Expect `YAOS: synced` and the vault's files. The console's own codes are
   owner codes only; device codes come from step 4 (§5).

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
12. **IDB loss.** In devtools on A, delete the `yaos2:<vaultId>:...`
    IndexedDB databases (`store/schema.ts:22`) and reload the plugin. Expect
    recovery from the `.yaos` mirrors with no
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
