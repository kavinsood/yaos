# RFC: Replace Opaque CRDT Snapshots with File-Level Recovery Manifests and Separate Bootstrap Checkpoints

**Status:** In Progress
**Target repository:** YAOS / Obsidian CRDT sync
**Date:** 2026-05-27
**Owner:** TBD
**Reviewers:** TBD

## Implementation Progress

| Stage | Description | Status | PR |
|-------|-------------|--------|-----|
| Phase 1 | Tourniquet: semantic dedup, retention, bounded listing | Merged | #50 |
| Phase 2 | CAS manifest writer + catalog (feature-flagged) | Pending | — |
| Phase 3 | File-level browse + restore (feature-flagged) | Pending | — |
| Phase 4 | Retention + GC (separate flags) | Pending | — |
| Phase 5 | Default-on recovery-v1 | Pending | — |
| Phase 6 | Legacy snapshot deprecation | Pending | — |

---

## 1. Summary

The current YAOS snapshot system stores one full compressed Yjs document update per snapshot. Automatic snapshots are deduplicated only by UTC calendar day, manual snapshots bypass deduplication entirely, listing snapshots scans all snapshot keys, and there is no retention or garbage collection policy. This is not a sustainable backup architecture. It conflates three separate concerns:

1. **Live sync state:** the current CRDT document and update journal used for real-time convergence.
2. **Bootstrap checkpoints:** compact CRDT state used to initialize a new device quickly.
3. **Human recovery snapshots:** point-in-time, file-level recovery records used to inspect, diff, undelete, and selectively restore user content.

This RFC proposes replacing opaque CRDT backup snapshots with a file-level, content-addressed recovery system while keeping compact CRDT checkpoints as a separate machine-facing artifact.

The desired end state is boring and explicit:

* Automatic snapshots are skipped when the semantic vault state has not changed.
* Snapshot history is bounded by a default retention policy.
* Snapshot listing is paginated and catalog-based, not a full bucket scan.
* Users can inspect and restore individual files without downloading and instantiating an entire Y.Doc.
* Blobs are retained while referenced by live state or retained snapshots, and eventually garbage-collected when unreferenced.
* New devices bootstrap from compact server checkpoints, not retained human backup snapshots.

## 2. Problem Statement

The existing snapshot implementation is operationally unsafe for a long-lived sync product.

Current behavior:

* Daily snapshots check only whether any snapshot exists for the current UTC date.
* Snapshot payloads are full compressed `Y.encodeStateAsUpdate(ydoc)` dumps.
* Manual snapshot creation can create duplicate snapshots back-to-back.
* Snapshot history is never pruned.
* Snapshot listing calls bucket list over all snapshot objects, filters index files, then fetches all indexes.
* Snapshot restore requires downloading and decoding a full CRDT document into a temporary Y.Doc.

This creates five classes of failure:

1. **Storage leak:** daily full-state snapshots accumulate forever.
2. **Redundant writes:** unchanged vaults still produce new snapshots on new UTC days.
3. **Expensive listing:** browsing snapshot history gets slower and more expensive as history grows.
4. **Bad recovery primitive:** users need file-level historical content, but the stored object is a whole-vault CRDT state blob.
5. **Conflated responsibilities:** snapshots are being used as both backup artifacts and potential bootstrap artifacts.

A CRDT is not a backup system. It faithfully propagates both good edits and catastrophic mistakes. The backup system must protect against semantic data loss, not merely serialize sync state.

## 3. Goals

### 3.1 Product Goals

* Allow users to recover from accidental deletion, rogue plugins, bad migrations, corrupted frontmatter, semantic merge damage, and mistaken bulk operations.
* Allow users to inspect historical plaintext for a single note without loading a full vault snapshot.
* Allow users to selectively restore files, folders, or change windows.
* Allow users to understand storage usage and retention behavior.
* Allow a new device to bootstrap quickly from compact current-state server checkpoints.

### 3.2 Engineering Goals

* Separate human recovery snapshots from machine bootstrap checkpoints.
* Store recovery snapshots as manifests over content-addressed file objects.
* Avoid storing duplicate content across snapshots.
* Skip automatic snapshot creation when semantic vault state is unchanged.
* Implement retention and garbage collection.
* Make listing snapshots paginated and bounded.
* Preserve compatibility with existing full-CRDT snapshots during migration.
* Design restore flows with concurrency safety.

### 3.3 Operational Goals

* Bound R2 storage growth by default.
* Bound R2 list/read operations for common UI paths.
* Avoid long-running Worker requests that instantiate large Y.Doc objects unnecessarily.
* Make corruption detectable through hashes and manifest validation.
* Make recovery state observable through diagnostics.

## 4. Non-Goals

* This RFC does not redesign the live CRDT sync protocol.
* This RFC does not require block-level chunking of Markdown content.
* This RFC does not require full Git-like history or arbitrary commit graph traversal.
* This RFC does not require server-side semantic diffing of Markdown.
* This RFC does not require immediate deletion of all legacy full-CRDT snapshots.
* This RFC does not make snapshots a replacement for user-owned external backups.

## 5. Definitions

### Live State

The active Y.Doc representing the current synchronized vault state.

### Server Checkpoint

A compact CRDT update representing current live state, used for fast bootstrap and persistence compaction. This is machine-facing and not the primary human recovery format.

### Recovery Snapshot

A point-in-time manifest mapping vault paths to content-addressed objects and metadata. This is user-facing and optimized for inspection, diffing, selective restore, and retention.

### Snapshot Manifest

A JSON object describing the semantic file state of the vault at a point in time.

### Content Object

A compressed immutable object keyed by content hash. Markdown content objects store plaintext Markdown. Blob objects store binary attachment content or refer to existing blob storage.

### Catalog

A compact paginated index of retained snapshots used for listing and UI browsing.

### Pinned Snapshot

A snapshot exempt from automatic retention pruning until explicitly unpinned or deleted.

## 6. User Failure Domains

The design must serve these concrete user failures.

### 6.1 Rogue Plugin / Mass Corruption

A plugin rewrites hundreds of files incorrectly. The user notices later.

Required capabilities:

* Identify files changed between a snapshot and live state.
* Filter large change sets.
* Restore selected files or all files changed in a window.
* Avoid overwriting files that changed after the restore UI was opened without warning.

### 6.2 Accidental Delete / Folder Loss

A user deletes a folder or a device propagates tombstones.

Required capabilities:

* Browse deleted-since-snapshot files.
* Restore selected deleted files or a deleted folder subtree.
* Preserve path identity and clear relevant tombstones safely.

### 6.3 Semantic Merge Damage

Concurrent edits converge but produce bad prose or bad structure.

Required capabilities:

* Fetch historical plaintext for a single file.
* Show side-by-side current vs historical content.
* Allow manual copy/paste or selective file restore.

### 6.4 Bad YAOS Migration / Client Bug

A migration, path model bug, tombstone bug, or restore bug damages live state.

Required capabilities:

* Record producer metadata: plugin version, server version, schema version, device, trigger reason.
* Allow investigation of when a file became wrong.
* Allow restoring from a known-good manifest without depending on current broken metadata.

### 6.5 Ransomware / Hostile Bulk Rewrite

A compromised plugin, script, or external editor rewrites or encrypts notes.

Required capabilities:

* Restore by time window.
* Detect unusually large snapshot diffs.
* Keep enough history to notice damage after days or weeks.
* Avoid pruning all pre-attack recovery points too quickly.

### 6.6 Device Replacement / Cold Bootstrap

A user gets a new device and needs current state quickly.

Required capabilities:

* Download a compact current-state CRDT checkpoint.
* Apply recent journal updates after checkpoint.
* Avoid replaying ancient update history.

This is not a human snapshot requirement. It belongs to the checkpoint layer.

### 6.7 User-Initiated Risky Operation

The user wants to do a bulk rename, import, frontmatter migration, plugin install, or schema upgrade.

Required capabilities:

* Create a named checkpoint marker before the operation.
* Pin important manual snapshots.
* If semantic content is unchanged, store a marker referencing the existing manifest rather than duplicating content.

## 7. Design Principles

1. **Do not confuse CRDT convergence with data recovery.** A CRDT syncs mistakes perfectly.
2. **Human recovery is file-level.** Users restore notes and attachments, not opaque CRDT graphs.
3. **Machine bootstrap is CRDT-level.** New devices need compact CRDT state, not a historical backup artifact.
4. **Content-address everything immutable.** Duplicate content should be stored once.
5. **Manifests are the unit of history.** File content objects are shared across manifests.
6. **Retention must be built in.** A backup system without pruning is a storage leak.
7. **Listing must be bounded.** UI operations cannot scan all history forever.
8. **Restore must be safe under concurrency.** Selection time and application time are different moments.
9. **Integrity metadata is mandatory.** If you cannot verify what you restore, you do not have backups.
10. **Start boring.** Avoid clever delta chains until content-addressed manifests prove insufficient.

## 8. Proposed Architecture

YAOS should maintain three independent storage tracks.

### 8.1 Track A: Live Sync Persistence

Existing server checkpoint/journal persistence remains responsible for current live state durability.

Responsibilities:

* Persist current Y.Doc state.
* Append updates durably.
* Compact journal into current checkpoint.
* Serve live WebSocket synchronization.

Out of scope for human snapshot browsing.

### 8.2 Track B: Bootstrap Checkpoints

A compact current-state CRDT artifact used by new clients.

Responsibilities:

* Store latest compact Y.Doc update.
* Optionally store one or two previous checkpoints for rollback safety.
* Expose an API for cold bootstrap.
* Not exposed as the primary human backup UI.

Retention:

* Keep latest 2 or 3 bootstrap checkpoints.
* Delete older bootstrap checkpoints after newer checkpoint is verified.

### 8.3 Track C: Recovery Snapshots

A content-addressed file-level backup system.

Responsibilities:

* Store semantic file manifests.
* Store Markdown plaintext content objects by hash.
* Reference blob objects by existing blob hash.
* Maintain a snapshot catalog.
* Support diff, single-file fetch, selective restore, retention, and GC.

This RFC focuses primarily on Track C.

## 9. Recovery Snapshot Data Model

### 9.1 Snapshot Manifest

```ts
type SnapshotManifestV2 = {
  format: "yaos-recovery-manifest-v2";
  vaultIdHash: string;
  snapshotId: string;
  createdAt: string;
  day: string;
  reason: SnapshotReason;
  label?: string;
  pinned: boolean;

  producer: {
    serverVersion: string;
    pluginVersion?: string;
    schemaVersion: number | null;
    deviceName?: string;
  };

  liveState: {
    yjsStateVectorHash: string;
    semanticManifestHash: string;
    markdownFileCount: number;
    blobFileCount: number;
    tombstoneCount: number;
    totalMarkdownBytes: number;
    totalBlobBytesReferenced: number | null;
  };

  parent?: {
    snapshotId: string;
    semanticManifestHash: string;
  };

  files: Record<string, SnapshotMarkdownEntry>;
  blobs: Record<string, SnapshotBlobEntry>;
  tombstones?: Record<string, SnapshotTombstoneEntry>;

  integrity: {
    manifestHash: string;
    hashAlgorithm: "sha256";
  };
};
```

### 9.2 Markdown Entry

```ts
type SnapshotMarkdownEntry = {
  kind: "markdown";
  path: string;
  fileId?: string;
  contentHash: string;
  contentKey: string;
  sizeBytes: number;
  lineCount?: number;
  mtime?: number;
  metadataHash?: string;
};
```

### 9.3 Blob Entry

```ts
type SnapshotBlobEntry = {
  kind: "blob";
  path: string;
  hash: string;
  blobKey: string;
  sizeBytes: number | null;
  mime?: string;
  metadataHash?: string;
};
```

### 9.4 Tombstone Entry

```ts
type SnapshotTombstoneEntry = {
  kind: "tombstone";
  path: string;
  fileId?: string;
  deletedAt?: number;
  device?: string;
};
```

### 9.5 Snapshot Reason

```ts
type SnapshotReason =
  | "daily"
  | "manual"
  | "pre-upgrade"
  | "pre-migration"
  | "pre-bulk-operation"
  | "pre-restore"
  | "r2-enabled"
  | "diagnostic";
```

## 10. Storage Layout

### 10.1 Recovery Snapshot Objects

```text
v2/{vaultId}/recovery/catalog/current.json
v2/{vaultId}/recovery/catalog/pages/{pageId}.json
v2/{vaultId}/recovery/manifests/{snapshotId}.json.gz
v2/{vaultId}/recovery/content/sha256/{hash}.md.gz
v2/{vaultId}/recovery/markers/{markerId}.json
```

### 10.2 Blob Objects

Existing blob storage remains content-addressed:

```text
v1/{vaultId}/blobs/{sha256}
```

Recovery manifests reference these existing blob objects. The blob GC process must consider recovery manifest references.

### 10.3 Bootstrap Checkpoints

```text
v2/{vaultId}/checkpoints/current.json
v2/{vaultId}/checkpoints/{checkpointId}/crdt.bin.gz
v2/{vaultId}/checkpoints/{checkpointId}/meta.json
```

Do not mix these with recovery snapshots.

## 11. Snapshot Creation Algorithm

### 11.1 Inputs

* Current live Y.Doc.
* Trigger reason.
* Device/producer metadata.
* Optional user label.
* Optional pin flag.

### 11.2 Steps

1. Build a semantic manifest candidate from the live Y.Doc:

   * collect active Markdown paths;
   * collect active blob paths;
   * collect relevant tombstones;
   * normalize paths;
   * read each Y.Text as plaintext;
   * hash plaintext content;
   * reference existing blob hashes.

2. Compute `semanticManifestHash` from sorted path entries and hashes.

3. Fetch latest retained manifest metadata from catalog.

4. For automatic snapshots:

   * if latest `semanticManifestHash` matches candidate, return noop;
   * if latest `yjsStateVectorHash` matches candidate, return noop;
   * otherwise proceed.

5. For manual snapshots:

   * if semantic state is unchanged, create a lightweight marker referencing the latest manifest;
   * if semantic state changed, create a new manifest;
   * pinned manual snapshots must be preserved by retention.

6. For each Markdown content hash not already present in R2, write a compressed content object.

7. Write the compressed manifest.

8. Update catalog transactionally as much as R2 permits:

   * write new catalog page or page entry;
   * update current catalog pointer last.

9. Run retention pruning asynchronously or opportunistically.

10. Emit trace and health metadata.

### 11.3 Pseudocode

```ts
async function createRecoverySnapshotMaybe(input: SnapshotInput): Promise<SnapshotResult> {
  const candidate = await buildManifestCandidate(input.ydoc, input.producer);
  const latest = await catalog.getLatest();

  if (input.reason === "daily" && latest?.semanticManifestHash === candidate.semanticManifestHash) {
    return { status: "noop", reason: "semantic-state-unchanged" };
  }

  if (input.reason === "manual" && latest?.semanticManifestHash === candidate.semanticManifestHash) {
    const marker = await writeSnapshotMarker(latest.snapshotId, input.label, input.pinned);
    return { status: "marker-created", markerId: marker.markerId, snapshotId: latest.snapshotId };
  }

  await writeMissingMarkdownContentObjects(candidate.files);
  const manifest = finalizeManifest(candidate, latest);
  await writeManifest(manifest);
  await catalog.append(manifest);
  await maybeApplyRetentionPolicy();

  return { status: "created", snapshotId: manifest.snapshotId, manifestSummary: summarize(manifest) };
}
```

## 12. Change Detection

State-vector equality is useful but not sufficient as the only dedup gate.

A Yjs state vector can change because of metadata or CRDT-level operations that may not alter user-visible file content. Conversely, semantic recovery should care about file content, blob references, tombstones, and path metadata.

Use two hashes:

1. **Yjs state vector hash** for cheap causal-state detection.
2. **Semantic manifest hash** for user-visible recovery-state detection.

Automatic snapshot skip rule:

```text
Skip if latest.semanticManifestHash == candidate.semanticManifestHash.
```

Optional optimization:

```text
If latest.yjsStateVectorHash == candidate.yjsStateVectorHash, skip without rebuilding full semantic manifest.
```

But do not rely solely on state vector equality as the product-level definition of "no backup-relevant change."

## 13. Retention Policy

### 13.1 Default Policy

Default retention:

* keep all snapshots from the last 7 days;
* keep one weekly snapshot for the last 4 weeks;
* keep one monthly snapshot for the last 12 months;
* keep all pinned snapshots;
* keep all pre-upgrade/pre-migration snapshots for at least 30 days unless pinned;
* keep the latest successful snapshot always.

This is a sane default, not a law of physics. Make it configurable later.

### 13.2 Retention Selection Rules

Given retained snapshot manifests sorted newest first:

1. Mark pinned snapshots as keep.
2. Mark latest snapshot as keep.
3. Mark snapshots within 7 days as keep.
4. For snapshots older than 7 days and within 35 days, keep the newest per ISO week.
5. For snapshots older than 35 days and within 365 days, keep the newest per month.
6. Mark the rest as prune candidates.

### 13.3 Manual Snapshot Behavior

Manual snapshots default to pinned for now. Later, expose a checkbox:

* "Pin this snapshot" default on.
* "Let retention clean this up" optional.

If a manual snapshot is only a marker over an unchanged manifest, pruning the marker should not prune the referenced manifest unless no retained policy still needs it.

## 14. Garbage Collection

### 14.1 GC Responsibilities

GC must delete:

* pruned manifest objects;
* unreferenced Markdown content objects;
* unreferenced blob objects if not referenced by live state or retained snapshots;
* stale catalog pages if superseded.

GC must never delete:

* content referenced by any retained manifest;
* blobs referenced by live CRDT state;
* blobs referenced by any retained manifest;
* pinned snapshot manifests;
* latest bootstrap checkpoint until replacement is verified.

### 14.2 Mark-and-Sweep Model

1. Load retained snapshot manifests or compact reference summaries.
2. Build referenced Markdown content hash set.
3. Build referenced blob hash set.
4. Add live CRDT blob refs to referenced blob hash set.
5. List content objects and delete those not referenced.
6. List blob objects and delete those not referenced by live or retained recovery state.

### 14.3 Avoid Full Manifest Loads for Every GC

Each catalog entry should include compact reference summaries:

```ts
type SnapshotCatalogEntry = {
  snapshotId: string;
  createdAt: string;
  reason: SnapshotReason;
  label?: string;
  pinned: boolean;
  semanticManifestHash: string;
  manifestKey: string;
  manifestSizeBytes: number;
  markdownFileCount: number;
  blobFileCount: number;
  markdownContentHashesSample?: string[];
  referencedBlobHashesSample?: string[];
  referenceSummaryKey?: string;
};
```

For exact GC, write a separate compact reference summary:

```text
v2/{vaultId}/recovery/ref-summaries/{snapshotId}.json.gz
```

This avoids decompressing full manifests just to compute reachability.

## 15. Snapshot Catalog and Listing

### 15.1 Current Problem

The current listing path scans all snapshot objects and fetches all index files. That gets worse forever.

### 15.2 New Catalog API

```http
GET /vault/{vaultId}/recovery/snapshots?cursor={cursor}&limit={limit}
```

Response:

```ts
type ListRecoverySnapshotsResponse = {
  snapshots: SnapshotCatalogEntry[];
  nextCursor: string | null;
  storageSummary: {
    retainedSnapshotCount: number;
    estimatedManifestBytes: number;
    estimatedMarkdownContentBytes: number;
    estimatedBlobBytesReferenced: number | null;
    lastGcAt: string | null;
  };
};
```

### 15.3 Catalog Storage

Use append-friendly pages rather than rewriting one huge catalog forever.

```text
v2/{vaultId}/recovery/catalog/current.json
v2/{vaultId}/recovery/catalog/pages/{pageId}.json
```

`current.json` points to recent pages and retention summary:

```ts
type RecoveryCatalogCurrent = {
  format: "yaos-recovery-catalog-v1";
  updatedAt: string;
  latestSnapshotId: string | null;
  pages: Array<{
    pageId: string;
    key: string;
    minCreatedAt: string;
    maxCreatedAt: string;
    entryCount: number;
  }>;
  retention: {
    policy: RetentionPolicy;
    lastAppliedAt: string | null;
  };
  storageSummary: StorageSummary;
};
```

For the initial version, a single compact `catalog/current.json` with bounded retained entries may be acceptable. Do not over-engineer pages until retention is implemented.

## 16. APIs

### 16.1 Create Daily Recovery Snapshot

```http
POST /vault/{vaultId}/recovery/snapshots/maybe
```

Request:

```ts
type CreateMaybeRequest = {
  device?: string;
  pluginVersion?: string;
};
```

Response:

```ts
type CreateMaybeResponse =
  | { status: "created"; snapshotId: string; summary: SnapshotSummary }
  | { status: "noop"; reason: "semantic-state-unchanged" | "already-running" | "unavailable" }
  | { status: "failed"; error: string };
```

### 16.2 Create Manual Snapshot

```http
POST /vault/{vaultId}/recovery/snapshots
```

Request:

```ts
type CreateManualRequest = {
  device?: string;
  pluginVersion?: string;
  label?: string;
  pinned?: boolean;
  reason?: "manual" | "pre-upgrade" | "pre-migration" | "pre-bulk-operation";
};
```

Response:

```ts
type CreateManualResponse =
  | { status: "created"; snapshotId: string; summary: SnapshotSummary }
  | { status: "marker-created"; markerId: string; snapshotId: string; reason: "semantic-state-unchanged" }
  | { status: "failed"; error: string };
```

### 16.3 List Snapshots

```http
GET /vault/{vaultId}/recovery/snapshots?cursor=&limit=50
```

### 16.4 Get Snapshot Manifest Summary

```http
GET /vault/{vaultId}/recovery/snapshots/{snapshotId}
```

Returns catalog entry and optionally manifest summary, not full content.

### 16.5 Fetch Historical File Content

```http
GET /vault/{vaultId}/recovery/snapshots/{snapshotId}/files/{encodedPath}
```

Returns plaintext Markdown content for that path at that snapshot.

This must not instantiate a full Y.Doc.

### 16.6 Diff Snapshot Against Live

Two possible models:

#### Client-side diff

Client downloads manifest summary and compares with local live state.

Pros:

* Less server CPU.
* Avoids server-side Y.Doc traversal except creation.

Cons:

* Requires client to compute live semantic manifest.

#### Server-side diff

```http
GET /vault/{vaultId}/recovery/snapshots/{snapshotId}/diff-live
```

Server compares manifest to current live state.

Pros:

* Simpler client.

Cons:

* Server may need live Y.Doc traversal.

Recommendation: start with client-side diff where possible. Add server-side diff only if UX needs it.

### 16.7 Restore Selected Paths

Preferred model: client applies restore to live Y.Doc after fetching required file content.

```http
POST /vault/{vaultId}/recovery/snapshots/{snapshotId}/restore-plan
```

Request:

```ts
type RestorePlanRequest = {
  markdownPaths: string[];
  blobPaths: string[];
};
```

Response:

```ts
type RestorePlanResponse = {
  snapshotId: string;
  files: Array<{
    path: string;
    contentHash: string;
    contentKey: string;
    sizeBytes: number;
  }>;
  blobs: Array<{
    path: string;
    hash: string;
    sizeBytes: number | null;
  }>;
};
```

The client then fetches content objects and applies restore with concurrency checks.

## 17. Restore Safety Protocol

### 17.1 Problem

A user may open a restore modal, inspect diffs, select files, and apply restore minutes later. During that time, another device may edit a selected file.

### 17.2 Required Three-Way Check

At diff UI open, capture for each candidate path:

```ts
type RestoreCandidate = {
  path: string;
  snapshotHash: string;
  liveHashAtDiffOpen: string | null;
};
```

At restore apply time, compute current live hash again.

If:

```text
liveHashNow !== liveHashAtDiffOpen
```

then the file changed during restore review. The UI must either:

* skip that file and report it;
* ask for confirmation;
* create a conflict artifact before applying.

Default behavior should be conservative: skip changed-during-review files unless user explicitly confirms.

### 17.3 Pre-Restore Backup

Keep the current local backup behavior, but make it explicit:

* Before replacing any disk-backed Markdown file, write current content to `.obsidian/plugins/yaos/restore-backups/{timestamp}/{path}`.
* Do not let backup failure silently proceed for destructive overwrites unless the file is missing and this is an undelete.

### 17.4 Restore Origin

Use a distinct restore origin for CRDT transactions so disk mirror, diagnostics, and flight traces can classify restore writes.

### 17.5 Blob Restore

Blob restore should:

* re-point CRDT blob ref to the snapshot hash;
* clear blob tombstone for the path;
* queue prioritized download;
* verify the blob still exists in R2 before declaring success;
* if missing, mark restore as partial failure.

## 18. UI Requirements

### 18.1 Snapshot List UI

Show:

* created time;
* reason / label;
* pinned status;
* markdown file count;
* blob file count;
* changed files since previous snapshot if available;
* estimated unique storage contribution;
* producer version;
* warning if snapshot is legacy full-CRDT format.

Must be paginated.

### 18.2 Snapshot Detail UI

Show:

* deleted since snapshot;
* changed since snapshot;
* created since snapshot;
* blob changes;
* tombstone summary;
* search/filter by path;
* select all in folder;
* preview historical file content.

### 18.3 Restore UI

Show:

* selected files count;
* destructive overwrite count;
* undelete count;
* attachment restore count;
* changed-during-review warnings;
* pre-restore backup destination.

### 18.4 Storage UI

Show:

* retained snapshot count;
* pinned snapshot count;
* estimated recovery storage;
* last GC time;
* retention policy summary;
* manual "run cleanup now" command.

## 19. Legacy Snapshot Migration

### 19.1 Preserve Read Compatibility

Existing `v1/{vaultId}/snapshots/{day}/{snapshotId}/crdt.bin.gz` snapshots must remain readable.

UI should label them:

```text
Legacy full-CRDT snapshot
```

### 19.2 Do Not Auto-Convert Everything Immediately

Converting all legacy snapshots requires downloading and instantiating full Y.Docs. That is exactly the cost we are trying to escape.

Migration strategy:

1. New snapshots use v2 recovery manifests.
2. Legacy snapshots remain listed under a separate compatibility section.
3. When a user opens a legacy snapshot, optionally offer "convert this snapshot to v2 recovery format."
4. Background conversion may be added later with strict limits.

### 19.3 Retention for Legacy Snapshots

Apply retention to legacy snapshots only after user-visible warning and/or after v2 snapshots have existed for enough time.

Initial safe policy:

* keep all legacy snapshots for one release;
* show storage warning;
* add manual delete/prune command;
* later enable retention for legacy snapshots.

## 20. Implementation Plan

### Phase 0: Stop the Bleeding (COMPLETED — PR #50)

Minimal changes before the full redesign.

1. ~~Store `stateVectorHash` in existing snapshot index.~~
2. ~~Store `semanticHash` if cheaply computable.~~
3. ~~Change daily snapshot maybe path to skip if latest snapshot has same hash.~~
4. ~~Add retention pruning for existing snapshots.~~
5. ~~Add paginated listing or at least limit UI listing.~~
6. ~~Add storage usage warning.~~
7. ~~Add manual prune command.~~

### Phase 1: Catalog

1. Add `recovery/catalog/current.json`.
2. Write catalog entries for new snapshots.
3. Change list UI to read catalog instead of scanning all keys.
4. Add pagination.
5. Add catalog rebuild command for diagnostics.

### Phase 2: File-Level Manifest Snapshot

1. Implement manifest builder from live Y.Doc.
2. Implement Markdown content hashing and content object writes.
3. Write v2 manifest objects.
4. Add automatic dedup based on semantic manifest hash.
5. Add manual marker behavior for unchanged manual snapshots.

### Phase 3: File-Level Browse and Restore

1. Add file-content fetch endpoint.
2. Add manifest-based diff UI.
3. Add historical single-file preview.
4. Update restore flow to fetch only selected content.
5. Add changed-during-review protection.

### Phase 4: Retention and GC

1. Implement retention selector.
2. Implement manifest pruning.
3. Implement Markdown content GC.
4. Implement blob reference-aware GC.
5. Expose cleanup status and errors in diagnostics.

### Phase 5: Bootstrap Checkpoints

1. Define checkpoint API separately from recovery snapshots.
2. Store compact current CRDT checkpoint metadata.
3. Use checkpoint for new-device initialization if available.
4. Keep checkpoint retention small and independent.

### Phase 6: Legacy Sunset

1. Add legacy snapshot conversion on demand.
2. Add legacy retention policy.
3. Add user-facing migration notice.
4. Eventually stop creating v1 full-CRDT snapshots entirely.

## 21. Testing Plan

### 21.1 Unit Tests

* semantic manifest hash stable under path ordering changes;
* semantic manifest hash changes when file content changes;
* semantic manifest hash changes when blob ref changes;
* semantic manifest hash changes when active file set changes;
* unchanged daily snapshot returns noop;
* unchanged manual snapshot creates marker, not duplicate content;
* retention selector keeps 7 daily, 4 weekly, 12 monthly, pinned snapshots;
* GC does not delete content referenced by retained manifests;
* GC deletes unreferenced content objects;
* blob GC respects live refs and retained snapshot refs;
* catalog pagination returns bounded entries;
* malformed manifest is rejected;
* content hash mismatch blocks restore.

### 21.2 Integration Tests

* create v2 snapshot from live Y.Doc;
* list snapshot catalog without bucket-wide scan;
* fetch single file from snapshot without applying Y.Doc;
* restore deleted file;
* restore changed file;
* skip restore when file changed during review;
* restore blob ref and queue download;
* retention prunes old unpinned snapshots;
* pinned snapshots survive pruning;
* legacy snapshot still downloads and restores.

### 21.3 Property / Fuzz Tests

* randomized vault states produce deterministic manifests;
* path normalization collisions are detected;
* manifest builder rejects duplicate active paths;
* retention policy never prunes latest snapshot;
* GC never deletes a referenced object.

### 21.4 Failure Injection Tests

* content object write fails after manifest candidate built;
* manifest write fails after content writes;
* catalog update fails after manifest write;
* GC delete partially fails;
* R2 list pagination truncates;
* corrupt content object hash;
* corrupt manifest JSON;
* missing blob object during restore.

## 22. Observability and Diagnostics

Add trace events:

* `recovery.snapshot.create.started`
* `recovery.snapshot.create.noop`
* `recovery.snapshot.create.content_written`
* `recovery.snapshot.create.manifest_written`
* `recovery.snapshot.create.catalog_updated`
* `recovery.snapshot.retention.started`
* `recovery.snapshot.retention.completed`
* `recovery.snapshot.gc.started`
* `recovery.snapshot.gc.completed`
* `recovery.snapshot.gc.failed`
* `recovery.restore.started`
* `recovery.restore.skipped_changed_during_review`
* `recovery.restore.completed`
* `recovery.restore.partial_failed`

Diagnostics bundle should include:

* snapshot format versions present;
* latest successful snapshot time;
* latest failed snapshot error;
* retained snapshot count;
* pinned snapshot count;
* estimated recovery storage;
* last retention run;
* last GC run;
* catalog health;
* legacy snapshot count.

Do not include raw file paths in safe diagnostics unless already covered by existing path redaction policy.

## 23. Security and Privacy

* Do not log raw file paths in Worker logs by default.
* Do not expose raw vault IDs in catalog metadata intended for diagnostics; use hashes where possible.
* Verify content hashes before restore.
* Validate snapshot IDs and paths strictly.
* Prevent path traversal in file-content endpoints.
* Authorization remains required for all snapshot APIs.
* Consider per-object encryption later, but do not block this redesign on encryption.

## 24. Compatibility

Existing clients:

* can continue using v1 snapshot APIs during transition;
* should prefer v2 endpoints when server capabilities advertise support.

Server capabilities should add:

```ts
type SnapshotCapabilities = {
  snapshots: boolean;
  snapshotFormats: Array<"v1-crdt-full" | "v2-file-manifest">;
  recoveryCatalog: boolean;
  retention: boolean;
  blobGc: boolean;
  bootstrapCheckpoint: boolean;
};
```

## 25. Open Questions

1. Should automatic snapshots be built server-side from Y.Doc or client-side from local vault content?

   * Server-side is authoritative for sync state.
   * Client-side may better represent disk state, but creates trust and upload complexity.
   * Recommendation: server-side for now.

2. Should Markdown content objects be encrypted independently?

   * Not required for this RFC, but storage format should leave room for encryption metadata.

3. Should retention policy be user-configurable in v1?

   * Recommendation: ship one sane default first. Add advanced settings later.

4. Should daily snapshot timing use UTC or user local day?

   * UTC is simpler and deterministic server-side.
   * User-facing display should localize.

5. Should v2 manifests include deleted file content or only active files?

   * A point-in-time manifest should include active files. Deleted files are recoverable from earlier manifests.
   * Tombstone summaries are useful for diffing and diagnostics.

6. How much metadata should be included for Obsidian-specific state?

   * Start with Markdown content, blob refs, file IDs, path metadata, tombstones.
   * Avoid capturing plugin-private metadata unless explicitly needed.

## 26. Acceptance Criteria

This project is not done until all of the following are true:

1. Leaving Obsidian open for two weeks with no semantic vault changes creates zero duplicate automatic recovery snapshots.
2. Taking two manual snapshots with unchanged content does not duplicate payload bytes.
3. Snapshot listing reads a bounded catalog page, not all snapshot objects.
4. Default retention prevents unbounded growth.
5. A user can fetch historical content for one Markdown file without downloading a full Y.Doc snapshot.
6. A user can restore selected deleted Markdown files from a snapshot.
7. A user can restore selected changed Markdown files from a snapshot.
8. Restore refuses or warns when a selected file changed after the diff UI opened.
9. Blob objects referenced by retained snapshots are not garbage-collected.
10. Blob objects no longer referenced by live state or retained snapshots are eventually eligible for deletion.
11. Legacy snapshots remain readable during migration.
12. Diagnostics expose snapshot count, storage estimate, retention status, and GC status.
13. Tests prove GC cannot delete referenced content.

## 27. Known Limits of the Proposed CAS Recovery Architecture

The content-addressed recovery design fixes the current architecture's worst properties: duplicate full-vault dumps, no retention, expensive opaque restore, and poor introspection. It does not make scaling problems disappear. It moves them to different places.

These limits must be acknowledged explicitly so the first implementation stays boring and so future complexity is added only when actual usage demands it.

### 27.1 R2 Operation Cost Under High Edit Churn

The current full-CRDT snapshot writes a small number of R2 objects per snapshot. A content-addressed recovery snapshot may write one new Markdown content object per changed file.

If a user bulk-edits 5,000 notes, a naive CAS snapshot may perform thousands of R2 `PUT` operations.

This is a real cost and latency risk.

Initial mitigation:

* Keep the flat content-object design for the first implementation.
* Track per-snapshot object write counts.
* Expose high-write snapshots in diagnostics.
* Add a soft guardrail: if a snapshot would write more than a configured object count, continue but emit a warning and trace event.
* Batch existence checks where possible.
* Avoid writing content objects already known to exist from the previous manifest or local catalog cache.

Do not implement packfiles in v1. Packfiles are a future optimization, not the starting point.

### 27.2 Manifest Size and Large Vaults

A flat JSON manifest is simple and correct for normal vaults. It may become expensive for very large vaults.

A vault with tens of thousands of files can produce multi-megabyte manifests. Writing, parsing, and diffing those manifests inside a Worker can become expensive.

Initial mitigation:

* Keep flat gzipped JSON manifests for v1.
* Store compact catalog summaries so listing does not parse full manifests.
* Fetch and parse full manifests only for detail, diff, restore, or GC.
* Add manifest size, file count, and parse-time metrics.
* Add explicit warning thresholds for large vaults.

Suggested warning thresholds:

* `markdownFileCount >= 10,000`: warn in diagnostics.
* `markdownFileCount >= 50,000`: mark recovery snapshots as degraded/large-vault mode.
* manifest compressed size over 5 MB: warn.
* manifest uncompressed size over 25 MB: warn and consider refusing automatic snapshots unless user enables large-vault mode.

### 27.3 Yjs-to-CAS Translation Cost

Yjs stores operational CRDT state. The recovery system wants immutable file plaintext and blob references. Translating from one model to the other requires walking the live Y.Doc, resolving active paths, rendering Y.Text content, hashing content, and building a semantic manifest.

That cost is paid at snapshot creation time.

This is the correct trade for human recovery: pay controlled background cost so restore and inspection are cheap. But the cost still exists and must be bounded.

Initial mitigation:

* Build semantic manifests only after provider sync and reconciliation are complete.
* Never block startup on recovery snapshot creation.
* Rate-limit automatic snapshot attempts.
* Skip manifest construction if a cheap live state signal proves no possible change since the latest snapshot.
* Track manifest build time, file count, total bytes rendered, and content objects written.
* Abort or defer snapshot creation if the Worker is approaching CPU or request limits.

### 27.4 Why These Limits Are Acceptable Initially

The old design has fundamental product failures. The proposed CAS design has scaling limits. Scaling limits are acceptable if they are measured, surfaced, and have clear escalation paths. Fundamental product failures are not.

## 28. General Audience Release Strategy

The recovery redesign must not ship to the general YAOS audience as one giant replacement. It should ship in controlled stages with explicit kill switches, compatibility gates, and measurable acceptance criteria.

### 28.1 Release Principle

Do not ask ordinary users to beta-test a backup system.

### 28.2 Stage 1: Immediate Tourniquet Release (COMPLETED — PR #50)

### 28.3 Stage 2: Recovery v1 Behind Feature Gate

Default behavior:

* existing users keep legacy snapshots readable;
* new recovery-v1 snapshots may be enabled for testers or canary users;
* legacy full-CRDT snapshot creation can remain as fallback until recovery-v1 proves itself;
* v1 recovery must be advertised through server capabilities.

### 28.4 Stage 3: Public Beta

Enable recovery-v1 for users who opt in through settings.

### 28.5 Stage 4: General Audience Default

Recovery-v1 can become the default only after beta data shows it is boring.

### 28.6 Stage 5: Deprecate Legacy Full-CRDT Snapshot Creation

### 28.7 Kill Switches

The release must include server and client kill switches:

* disable automatic recovery-v1 snapshot creation;
* disable recovery-v1 GC;
* disable blob GC;
* force legacy snapshot mode;
* disable restore apply while keeping browse/read available.

### 28.8 What Should Be Merged First

Merge order:

1. ~~Existing snapshot harm reduction: dedup, retention, bounded listing, storage warnings.~~
2. Capability schema for recovery-v1 support.
3. Recovery catalog and manifest writer behind a disabled feature flag.
4. Single-file fetch and manifest diff behind a feature flag.
5. Safe restore path behind a feature flag.
6. GC behind a separate feature flag, off until heavily tested.
7. Opt-in beta.
8. Default-on recovery-v1.
9. Legacy creation deprecation.

Do not merge GC at the same time as the first manifest writer. That is how backup systems eat their own backups.
