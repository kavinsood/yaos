# YAOS Conflict Semantics

Last updated: 2026-05-11

## Overview

YAOS has four conflict classes, each with a defined policy. This document
is the single source of truth for conflict resolution behavior.

---

## 1. Markdown ambiguous divergence

**Trigger:** Open file in editor where disk, CRDT, and editor all disagree
and no single authority can be chosen (the "ambiguous divergence" path in
`ReconciliationController.handleBoundFileSyncGap`).

**Policy:**

1. Preserve the CRDT version as a sibling conflict note:
   `<base> (YAOS conflict from <device> <timestamp>).md`
2. Force-replace the original path's CRDT to match the disk/editor content
   using `ORIGIN_DISK_SYNC_RECOVER_BOUND`.
3. Trace `conflict-artifact-needed` with `convergenceApplied: true/false`.

**Who wins:** The version currently visible in the local editor/disk wins
the original path. The remote/CRDT version is preserved as a separate file.

**Deduplication:** `lastConflictFingerprints` tracks
`(crdtHash, diskHash, editorHash)` per path. Same fingerprint skips
artifact creation. Fingerprint cleared after successful convergence so
genuinely new divergences create fresh artifacts.

**Failure paths:**
- Artifact creation fails (disk full, permissions): convergence does NOT
  proceed. CRDT remains untouched. Retried on next reconcile.
- Artifact succeeds, convergence fails (getTextForPath returns null):
  dedupe prevents infinite artifacts. Convergence retried on subsequent
  passes.

**Sync behavior:** Markdown conflict artifacts sync normally via
`vault.create()`. Other devices receive them.

---

## 2. Blob download conflict

**Trigger:** During blob download, either:
- The target file was modified locally between download start and write
  (`existing-changed-during-download`)
- A create race: file was created locally while download was in flight
  and content differs (`create-race-mismatch`)

**Policy:**

1. Write the remote bytes as a local-only conflict artifact:
   `<base> (YAOS remote conflict <timestamp>).<ext>`
2. Preserve the local version at the original path.
3. Mark the conflict artifact as local-only and suppress the immediate
   vault event from upload.
4. Show a Notice to the user.
5. Increment `_blobConflictArtifacts` counter (visible in debug snapshot).

**Who wins:** Local version stays at the original path. Remote version is
preserved as a local-only artifact.

**Sync behavior:** Blob conflict artifacts are **local-only**. They are
skipped by upload/reconcile paths using both the session-local guard and
the `"(YAOS remote conflict "` filename marker, so the local-only policy
survives plugin restart. This differs from Markdown artifacts which sync
normally.

**Rationale:** Binary conflict artifacts may be large (images, PDFs) and
uploading them could create confusion on other devices. The local device
that experienced the conflict is responsible for resolving it.

---

## 3. Remote delete conflict (local-dirty preservation)

**Trigger:** A remote tombstone arrives for a file that exists locally.

### Three-way decision model

Remote delete uses a typed three-way decision, NOT a boolean dirty flag.
This prevents conflating "known dirty" with "unknown baseline":

```
apply-delete:        baseline known, local file matches → trash/delete
preserve-revive:     baseline known, local file differs → preserve + revive tombstone
preserve-unresolved: baseline unknown (CRDT/hash unavailable) → preserve, do NOT revive
```

### Markdown (DiskMirror)

**Detection:** Compare disk content against `ytext.toString()`.

| Baseline state | Local state | Decision |
|---------------|-------------|----------|
| Known (CRDT text available) | Disk matches CRDT | `apply-delete` |
| Known (CRDT text available) | Disk differs from CRDT | `preserve-revive` |
| Unknown (CRDT text null) | File exists | `preserve-unresolved` |

**`preserve-revive` policy:**
1. Preserve the local file on disk.
2. Revive the CRDT tombstone via `ensureFile(path, diskContent, device,
   { reviveTombstone: true })`.
3. File re-enters sync normally on the next reconcile.
4. **This is intentional resurrection:** local dirty work wins over
   remote delete. The file will sync back to other devices.

**`preserve-unresolved` policy:**
1. Preserve the local file on disk.
2. **DO NOT revive tombstone.** Tombstone remains in CRDT.
3. Path recorded in `preservedUnresolvedPaths`; ordinary reconcile/import
   passes skip it instead of auto-reviving.
4. Explicit user action or a future remote event is required to resolve the
   limbo state.
5. This prevents phantom resurrection when CRDT state is transiently
   unavailable (startup, reconnect, hydration race).

**Read failure policy:** If `vault.read()` fails (file locked, busy,
permission denied) when a CRDT baseline IS available, the decision is
`preserve-unresolved` — NOT `apply-delete`. Rationale: inability to
verify is not proof of cleanliness.

### Multi-pass resurrection guard (`preservedUnresolvedPaths`)

The immediate `handleRemoteDelete` handler is not the only code path that
could resurrect a tombstoned file. Later scan/import passes also see
"local file exists + CRDT tombstoned" and might auto-revive.

To prevent this, both `DiskMirror` and `BlobSyncManager` maintain a
`preservedUnresolvedPaths: Set<string>` that records every path where
`preserve-unresolved` was the decision.

**Unknown-baseline preserved files are NOT automatically revived.**

Guarded code paths:
- `importUntrackedFiles()`: skips paths in `preservedUnresolvedPaths`
- `BlobSyncManager.reconcile()`: skips preserved-unresolved paths
  (same as tombstone check)
- `BlobSyncManager.processUpload()`: aborts upload for preserved-unresolved
  paths (guards against stale queue snapshots)

**Clearing conditions** (user intent established):
- User explicitly modifies the file (vault `modify` event, non-suppressed)
- User creates a new file at that path (vault `create` event)
- User deletes the file locally
- A future remote-delete arrives with a real baseline (handled with
  evidence instead of blindness)

The marker is NOT cleared by:
- Reconcile scans seeing the file
- Queue snapshot restoration
- Plugin restart (set is session-local; tombstone itself persists in CRDT
  and provides the durable guard across sessions)

### Blobs (BlobSyncManager)

**Detection:** Compare local file's cached hash against `knownHash`.

| knownHash state | Local hash | Decision |
|----------------|-----------|----------|
| Known, matching | Same | `apply-delete` |
| Known, mismatching | Different | `preserve-revive` |
| Null (no known baseline) | File exists | `preserve-unresolved` |

**`preserve-revive` policy:**
1. Preserve the local file on disk.
2. Clear the blob tombstone so the file re-enters sync.
3. Next reconcile treats it as a normal disk blob (upload if needed).

**`preserve-unresolved` policy:**
1. Preserve the local file on disk.
2. **DO NOT clear blob tombstone.**
3. Path recorded in `preservedUnresolvedPaths` — blocks `reconcile()`
   upload scan, `handleFileChange()` is not blocked (it represents
   intentional user action and clears the guard instead).
4. This is a conservative limbo state. It is not auto-re-evaluated by
   ordinary reconcile/import passes; explicit user action or a future
   remote event resolves it.

**Stat failure policy:** If `adapter.stat()` fails (file locked, busy)
when a known hash IS available, the decision is `preserve-unresolved` —
NOT `apply-delete`. Same rationale as Markdown: inability to verify is
not proof of cleanliness.

### Important product consequence

> Remote delete does NOT win over locally modified content when the
> baseline is known. YAOS preserves and revives the local version.
> This means deleted files CAN come back if they were locally modified.
> This is intentional and documented behavior.

When baseline is unknown, YAOS preserves locally but does NOT resurrect.
This prevents "deleted folders coming back" from transient CRDT
unavailability.

---

## 4. Safety brake (blocked remote overwrites)

**Trigger:** Reconcile would overwrite >20 local files AND >25% of the
vault. This indicates a possible bulk corruption from a remote device.

**Policy:**
1. Block all remote-to-disk overwrites for this reconcile pass.
2. Allow additive creates (new files from CRDT that don't exist on disk).
3. Blocked paths are **excluded from disk index advancement** so they
   remain dirty and are re-evaluated on the next reconcile.
4. `blockedDivergenceCount`, `lastBlockedDivergenceAt`, and a sample of
   blocked paths are exposed in diagnostics state.
5. A Notice is shown to the user.

**Resolution:** The blocked state resolves when either:
- A subsequent reconcile is below the safety threshold, OR
- The user manually triggers a full reconcile, OR
- The user exports diagnostics and inspects the divergence.

`lastBlockedDivergenceAt` is historical and persists even when count
resets to 0. UI/status must treat count as current and timestamp as
"last time this happened."

---

## Naming conventions

Both Markdown and blob conflict artifacts cap component lengths to prevent
filesystem path length issues (255-byte component limit):
- Device name: max 50 characters
- Base name: max 100 characters (further reduced if suffix is long)
- Illegal filesystem characters are replaced with `-`

---

## Recovery quarantine

Not a conflict policy per se, but related: if the same recovery
fingerprint (reason + content hashes) recurs 3 times within a 10-minute
window, the path is quarantined to prevent infinite recovery loops.

- Same fingerprint within TTL: count increments
- Same fingerprint beyond TTL: count resets to 1
- Different fingerprint: count resets to 1
- Map capped at 200 entries (LRU eviction)
- Session-local only (plugin restart clears)

`contentFingerprint()` is FNV-1a 32-bit + length. It is NOT cryptographic
and NOT a content identity primitive. It is a cheap loop coalescing key.

### Limitations and release-note wording

Recovery quarantine is **session-local only**. Restarting the plugin
clears all fingerprint state. This means:

- A pathological recovery loop that only fires once per plugin session
  will not be quarantined.
- The guard detects tight loops (3x same fingerprint in <10 minutes),
  not slow-motion drift.

**Correct release wording:**
> Repeated identical recovery attempts are detected and suppressed
> within a plugin session.

**Incorrect / overclaiming wording:**
> Recovery loops are fixed forever.
> YAOS guarantees no repeated recovery.

The quarantine is a practical safety net, not a correctness proof.
