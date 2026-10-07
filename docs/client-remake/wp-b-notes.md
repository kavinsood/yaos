# WP-B notes: planner, merge, disk side

Branch `client-remake-wp-b`. WP-B owns `src/core/{hash,merge,plan}/**` and
`src/engine/{reconcile,blobs,settings,snapshots}/**`. WP-C and WP-D code is not on this
branch, so everything runs against the frozen types plus local fakes
(`src/engine/reconcile/testkit/`, `src/engine/settings/testkit.ts`).

`npm run test:client` and `npm run typecheck:client` are both green.

## What is built

| Area | Files | Tests |
|---|---|---|
| Hashing (pure) | `core/hash`: sha256, utf8, markdown-lf-v1, canvas canonical form / disk format / merge text, canvas ranks | `hash.test.ts` 6 |
| Merge (pure) | `core/merge`: bounded Myers, line diff3 (ported), `MergeFn` with an anchored (patience) fallback when over budget, code-point-safe `minimalDiff` | `merge.test.ts` 8, `myers.test.ts` 3 |
| Planner (pure) | `core/plan`: `planWith` (every §f.2 row, the §c.13 duties), brake units, approval id, rename inference, conflict names, path rules, op order (temp names for cycles) | `planner.test.ts` 29, `planHelpers.test.ts` 8 |
| Reconcile job | `engine/reconcile`: scan / hash / dirty marks, echo table, plan runner, disk jobs, blob jobs, markdown merge job, intents resume, S1 own-fold, temp-name recovery, `Reconciler` facade | basic 9, safety 10, brakes 8, crash 8 scenarios = 134 crash points |
| Blob queue (§j.1) | `engine/blobs`: `BlobQueue implements BlobTransfer`. Store carrier: `has`, then `put(sealBlob)`; download uses `openBlob` and verifies the hash. Log carrier: `x:` chunks of 768 KiB, at most 8 MiB (later deleted: blobs travel only via the blob store). Persisted backoff (2 s doubling, cap 10 min) and in-flight dedupe | `blobQueue.test.ts` 9 |
| Settings (§j.3) | `engine/settings`: allowlist (ported), pure `planCfg`, `CfgSync` driver (detection plus projection) | `cfgSync.test.ts` 9 |
| Snapshots (§j.4) | `engine/snapshots/snapshotJob.ts`: fflate zip plus manifest, 256 MiB cap, retention, restore through a conflict copy, optional sealed upload | `snapshotJob.test.ts` 6 |

There are **113 tests in 12 files**. They run in about 1.2 s.

## Acceptance (§k.3 WP-B)

1. **MergeFn properties** (`merge.test.ts`):
   - 3000 seeded rounds: no line added by disk or crdt is lost (each appears in `text` or in `conflictCopy`);
   - identical and one-sided cases are exact;
   - bounded on 2M-char inputs.
2. **minimalDiff** (`merge.test.ts`): 4000 seeded rounds. The diff applied to crdt0 gives the target, it is surrogate-safe, and its size is ≤ the line diff.
3. **Planner** (`planner.test.ts`): one test per table row, plus brake thresholds and approval-id stability.
4. **Rename inference** (`planHelpers.test.ts`): deterministic and shuffle-invariant.
5. **Conflict names** (`planHelpers.test.ts`): always valid, including overlong stems and folders.
6. **Reconcile job** against the testkit vault, storage, gateway and stub log:
   - CAS miss once and persistently (`safety`);
   - echo for writes, renames and trash (`safety`);
   - intents resume at every crash point (`crash`): for each scenario a dry run counts the disk mutations and storage commits, then the scenario is re-run crashing before or after each one, rebooted, synced, and checked for convergence and quiescence;
   - remote moves use a plain rename;
   - deletes go to trash only.
7. **Settings projection gates** (`cfgSync.test.ts`):
   - the yaos dir is never emitted or projected, even when a rogue register names `plugins/yaos/data.json` or `pluginSet yaos=false`;
   - data.json is applied only when the installed manifest version is equal, and is never deleted.
8. **Blob queue and snapshot job**: unit tests as listed in the table above.

## Merge performance

Measured on an Apple M4 Pro with Node 26.5 (`merge.test.ts` diagnostics). Inputs are about 2M chars (`maxInputChars - 1000`).

| Scenario | merge | minimalDiff crdt→merged | minimalDiff crdt→disk |
|---|---|---|---|
| 500 disjoint edits per side | clean, 21 ms, +18 MB heap | 1323 edits, 39 ms | 2623 edits, 54 ms |
| 200 random edits per side | clean, 15 ms | 534 edits, 33 ms | 1043 edits, 32 ms |
| 3000 random edits per side (anchored fallback) | conflict (both-edited), 50 ms | 7572 edits, 83 ms | 12722 edits, 113 ms |
| Both sides rewritten | conflict (both-edited), 78 ms, +25 MB | 257 edits, 30 ms | 16155 edits, 111 ms |
| Over the size limit | rejected in 0.4 ms | — | — |

## Deviations and decisions

### Core
- **Hashing is pure JS** (`core/hash`), not `HashPort`. The engine runs in a worker, and `core/hash` is the single implementation of markdown-lf-v1 and the canonical canvas hash.
- **Canvas disk format** is `JSON.stringify(_, null, "\t")` (§j.2). Legacy used 2 spaces plus "\n".
- **Planner decisions** are listed in the `core/plan/planner.ts` header. In short:
  - `createSize = 0` is tested as `createHash == hash("")`;
  - md/canvas adoption always goes through `reconcileContent`, so a base is stored;
  - content jobs write their own S;
  - `nsDelete` is bundled with `syncedDrop`;
  - a local rename emits `nsRename` plus `syncedPut`;
  - folder-casing-only remote moves are tolerated;
  - `nsDelete` waits while local files are unhashed;
  - conflict-flood counting rules.
- **Brake** (`brake.ts`):
  - the approval id hashes the brake keys, not the raw ops (keep-both ops carry fresh ids and minute stamps);
  - listing-shrank needs at least `LISTING_SHRANK_MIN_MISSING` missing files (the bare ratio braked "delete 1 of 1").
- **Op order**: rebind runs first (before ns ops), so the rest of the plan already sees the winner's S. `removeEmptyFolder` is not a `PlannerOp`; the runner removes emptied folders after the run, deepest first.
- **Conflict names** take `tzOffsetMinutes` from the caller, because core may not read Date. The result is always a valid path (truncation, then a vault-root fallback).

### Reconcile job (`engine/reconcile`)
- **Exclude globs**: one small glob dialect (`folder/`, `**`, `*`, `?`), case-sensitive.
- **`DiskSchema`** is a mapped alias of `YaosSchema`, because the frozen interface lacks an index signature for `StorageDb<S>`.
- **Execution is per op**: one gateway `exec` per disk op, no batching.
- **Echo expectations** are registered after the op completes. The host must deliver the vault event after the op result; the testkit does that.
- **Bound docs** (open in an editor): the replica is merged and the file is never written. S records the disk side; the editor's save brings the file to the CRDT text.
- **Rebind** commits without an intent. It is a single T_synced.
- **Job-level md mass-overwrite brake**: the planner cannot know the merged size M, so `mergeJob` holds shrinking overwrites above the threshold. `approveBrake(id)` covers both brakes.
- **S1 own-fold**: a blob create that is applied without an S yet gets S from L.
- **Blob `conflictCopy`** writes a copy (keep-both under a `keep-both-blob` intent); it does not rename the original.
- **Blob `nsCreate` / `nsSetBlob`** are deferred until `pushBlob`'s upload succeeds. A failed upload sends no ns op.
- **Failed merge write** (the user typed again): S is rebased on the disk side D (hash, fingerprint, stat, base D), but `S.bodyVersion` is kept. Keeping B lost user text.
- **Born-empty S before a markdown `nsCreate` with content**: hash(""), body version 0/0, no base. The initial content becomes an ordinary disk-only merge, and a crash between the create and the frames re-merges instead of waiting forever on `body-empty`.
- **S follows `diskRename`** in the same tx as L (when `S.pathKey === from`). There are never two S records at one path after a crash mid-cycle.
- **Temp-name recovery** (`tempRecovery.ts`): an untracked file at a temp path whose id8 names exactly one doc is renamed back to `S.path`, if that doc's file is missing and the hashes are equal (crash after the temp rename).

### Blobs
- `BlobChunkLog` (`appendChunks` / `readChunks` over `x:<hash>`) is defined locally in `engine/blobs/chunks.ts`. WP-C implements it. (Later deleted with the `x:` carrier.)

### Settings
- **Allowlist**: exactly the DESIGN set. Legacy also synced `graph.json`, `daily-notes.json`, `templates.json`, `bookmarks.json` and others; these are not included.
- **Device-local keys**: `appearance.json` `nativeMenus` and `translucency`.
- **Rules per register** (json key, plugin id, file):
  - local == view: in sync;
  - local == base: take the view;
  - otherwise: emit the local op first, so the later seq wins.
- **First contact** (no `cfgBase` for the file) adopts the vault's registers and emits only keys the vault lacks. Without this, a fresh device would push its defaults over the vault.
- **Missing local JSON** counts as unchanged, so the file is recreated from the view. Unparseable or non-object JSON is left alone (skipped).
- **data.json**:
  - emitted only when the local manifest version is known;
  - never `fileDel`'d or removed;
  - a version mismatch leaves both sides alone until the versions match.
- **community-plugins.json**:
  - only `pluginSet`; disabling sends `enabled: false`, and `pluginDel` is never emitted;
  - enabling is projected only for installed plugins;
  - YAOS's own id is never touched.
- **Blob refs**: content over 64 KiB or non-UTF-8 goes as a blob ref, uploaded before the op is submitted. A failed upload defers the file. Cfg blobs use doc id `"cfg"` in `BlobQueue`.
- **Re-read before write**: the driver re-reads each file before writing and skips it if it changed since the snapshot. A small race window remains, because `ConfigDirPort` has no precondition.
- **Reload notice** (`settings-reload`): shown for every write except snippets.

### Snapshots
- **Restore precondition** is fingerprint or absent instead of `any`. A file edited between the read and the write is reported failed, not clobbered; its conflict copy already exists.
- **Restore writes** are ordinary local edits (not echo-suppressed). The reconciler syncs them on its next scan.
- **Ids** are `<createdAtMs base36, 9 chars>-<reason>`, so they sort by time.
- **Retention**: `keepDaily` dailies plus 10 event snapshots. A daily is taken when the newest daily is older than 24 h.
- **Zip entries** use mtime 1980-01-01; blob entries are stored without compression.

## Frozen-file changes

None.

## Honest gaps

- **Canvas reconcile** is not implemented in the disk job. The planner supports it, but the job fails the op with a `canvas-unsupported` notice. The `core/hash` canvas canonical-form and merge-text helpers are ready for it.
- **Emptied folders** are removed only after a successful run. Folders emptied before a crash are not remembered, so they stay until the next move or delete through them.
- **`removeEmptyFolder` before materialize** is not done (a file materializing where an emptied folder of the same name sits fails until the next pass).
- **Dirty marks** are not persisted. After a crash the startup scan finds changes anyway, through stats.
- **pathKey** in tests is a stand-in (lowercase plus NFC). The frozen case-fold function comes from WP-A through `deps.pathKey`.
- **No scoped passes.** Every pass plans the whole tree; event hints only mark entries dirty.
- **Temp recovery** is skipped when `S.path` is occupied (double fault). The temp file is then synced as a new doc, so nothing is lost.
- **Born-empty S**: if the user empties the file inside the crash window before the ns submit, the empty file can be trashed (recoverable from trash).
- **Crash test for folders**: the folder check in the "mixed sync" crash scenario runs on the dry run only.
- **Snapshot upload address** is returned, not persisted. There is no side-file or meta slot in the frozen types.
- **Snapshot triggers** (before brake approval, epoch migration and IDB recovery) are not wired; the engine glue must call `take(reason)`.
- **Restore and the brake**: restore writes are not brake-counted on the way out. They are user-initiated, preceded by a snapshot, and every overwritten file gets a conflict copy.
- **Settings tests** cover the LWW fold only through a test stub. The real `CfgFoldState` fold, the send window and the optimistic overlay belong to WP-C.

## Integration needs

- **WP-C**:
  - `LogPort` (`view`, `submitNs` with optimistic overlay, `acquireBody` / `BodyHandle`);
  - `OwnFoldEvent`s into `Reconciler.applyOwnFold` (S1);
  - `BlobChunkLog` over `x:` streams (later deleted);
  - `CfgLogPort` (`view()` = committed cfg fold plus own unfolded ops; `submitCfg` = frame, outbox, overlay).
- **WP-D**:
  - a `DiskGateway` over `readRequest` / `diskOps`; vault events must be delivered after the op result for echo matching;
  - `ConfigDirPort` and `SideFilePort` (snapshots);
  - a `tzOffsetMinutes` provider.
- **Wiring**:
  - `BlobQueue.open({db, clock, crypto, store | null, chunkLog})` as the reconciler's `BlobTransfer`, with a retry timer on `nextDueAtMs()` (`chunkLog` later deleted);
  - `CfgSync.pass()` on full reconcile and focus;
  - `SnapshotJob.maybeDaily()` on a timer, and `take("brake")` before `approveBrake`.
- **Tests**: swap the testkit fakes for SimVault, MemStorage and the real log. The `assertConverged` and crash-point harness (`testkit/crash.ts`) is reusable against them.
