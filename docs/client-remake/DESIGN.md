# YAOS client remake: design

Status: normative for the `client-remake` branch. Owner: architect. Builders implement against this document and
the type-only files it names. A change to a shape in `src/core/types.ts`, `src/core/envelope.ts`,
`src/core/limits.ts`, `src/ports/**`, `src/protocol/**` or `src/engine/store/schema.ts` needs a change here first.

- Relay contract: [relay-wire.md](relay-wire.md). The relay is an opaque, ordered, durable mailbox. The client owns
  all meaning: merging, validation, checkpoint contents, and the namespace.
- Client-side relay assumptions R1–R7 are listed in `src/ports/relay.ts`.
- Conventions:
  - MUST / NEVER are hard rules.
  - `seq` is the relay's vault-wide, contiguous commit sequence within one `vaultEpoch`.
  - `(seq, index)` is the total order of ops: `index` is the op's position inside its frame.
  - All byte layouts use lib0 primitives: `u8`, `varuint` (minimal unsigned LEB128, ≤ 2^53−1), `varstring`
    (varuint UTF-8 length + bytes, decoded with a fatal decoder), `varbytes`, and raw fixed-width bytes (`32B`).
  - "Alternative:" lines record a rejected option in one line.

Contents: [a](#a-invariants) invariants · [b](#b-streams-and-envelopes) streams and envelopes ·
[c](#c-namespace-fold) namespace fold · [d](#d-body-engine) body engine · [e](#e-indexeddb-schema-and-transactions)
IDB · [f](#f-three-trees-planner-merge) three trees · [g](#g-main--worker-protocol) protocol · [h](#h-ports) ports ·
[i](#i-runtime) runtime · [j](#j-shorter-specs) shorter specs · [k](#k-module-layout-and-build-plan) layout and
build plan · [l](#l-simulation-test-plan) simulation · [m](#m-ported-utilities-and-dropped-list) ported utilities.

---

## a. Invariants

Each invariant from report.md is enforced by named structures, not by care.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Never lose a local edit: it stays in the durable outbox until the receipt. | `outbox` store (§e.1). `T_edit` commits **before** `append` (§e.2). The record is deleted only by `T_receipt` or a late receipt found by `T_read_page`. The outbox mirror side files survive IDB loss (§e.4). Before `T_edit`, the durable copy is the disk file: Obsidian's save for bound notes, and the merge order "Y apply + `T_edit` → disk write" (§e.2) for merges. Poisoned frames are re-derived from disk, never dropped silently (§d.5). Y.Text is never wholesale-replaced (§f.3). |
| I2 | Never destroy a file on disk without a recoverable copy. | `VaultPort` exposes only `trash`, never a permanent delete. Every destructive `DiskOp` carries a CAS precondition (`WritePrecondition`). `conflictCopy` runs before any conflicting overwrite. `intents` store (§e.1). The safety brake counts deletes, trashes and overwrites that shrink a file by ≥ 50 % (§f.5). Fold losers are renamed, never deleted (§c.13). Recovery snapshots are taken before brake approval, epoch migration and IDB recovery (§j.4). |
| I3 | The same log prefix gives the same state everywhere. | Pure fold `FoldNsFrame` over `(seq, index)` (§c). `FOLD` constants in `limits.ts`. Frozen Unicode case folding (§c.2). Duplicate-frame ring plus send window (§c.3). `upgradeRules` halts instead of guessing (§c.10). Canonical `nsFoldV1` checkpoints are verified by re-encode and digests (§b.5). `cfg` is LWW on `(seq, index)` (§c.11). Bodies are Yjs CRDTs. |
| I4 | One device's bad update can't corrupt others. | One ingest gate: verify → decode in scratch → check → apply, or quarantine (§d.6). `quarantine` store; per-doc `frozen`. Checkpoints are UNIONed into local state, never replace it (§d.7). A malformed ns frame folds as empty, deterministically. Merges run only against a caught-up CRDT (§f.3). The brake holds mass destruction (§f.5). The ns-divergence alarm holds destructive ops (§b.5). |
| I5 | Bounded resources per device class (memory, CPU, battery, rows written). | `BUDGETS[deviceClass]` (§i.2). Clean-only LRU residency (§d.1). Frame builder caps (§d.4). Store bounds (§e.3). Priority lanes and slices (§i.1). Token bucket and daily soft budget (§i.6). Compaction thresholds (§d.8). No O(document) work per keystroke: frames are `Y.mergeUpdates` of small batches, never `encodeStateAsUpdate`, and nothing rewrites a full doc per edit. |
| I6 | Disk events are hints; a periodic full reconcile is the truth check. | `VaultEvent`s only mark paths dirty. The `LocalEntry` stat cache is confirmed by hash (§f.6). A full reconcile runs every `fullReconcileIntervalMs` and on resume. The planner is a pure function of the three trees (§f.2). Echo suppression only drops events; it never decides anything (§f.4). |

---

## b. Streams and envelopes

### b.1 Envelope

Every relay payload, frames and checkpoints alike, is one envelope (`src/core/envelope.ts`).

```
outer (plaintext)
  u8      formatVersion   = 1
  u8      cryptoSuite     0 = none (v1); 1 = reserved XChaCha20-Poly1305
  varuint keyEpoch        0 when suite = 0
  bytes   sealed          rest of payload; suite 0: inner verbatim
inner (CryptoPort.open(suite, keyEpoch, aad, sealed))
  u8      kind            EnvelopeKindCode
  varuint authorNsSeq     author's committed ns coversSeq when the frame was sealed
  varuint flags           initial | adopted | deflate | fromDisk
  bytes   content         rest; deflate-raw (fflate) iff flags & deflate
```

- **AAD** (UTF-8 prefix, then lib0 varstrings):
  - frames: `"yaos/f1" ‖ varstring vaultId ‖ varstring stream ‖ varstring clientFrameId`;
  - checkpoints: `"yaos/c1" ‖ varstring vaultId ‖ varstring stream ‖ varuint coversSeq`.
- **Binding checks** run even with suite 0, where the AAD is unused:
  - the kind must be in `ALLOWED_KINDS[streamClass]`;
  - for a checkpoint, the inner `CheckpointContent.coversSeq` MUST equal the relay's `coversSeq`, else quarantine.
- **Compression.** Deflate the content when it is ≥ 4096 B and deflating saves ≥ 10 %.
- **E2EE later.** Suite 1 swaps the `CryptoPort` only. No layout changes: blob addresses become `HMAC(vaultKey, hash)`.
- **Unknown values.** An unknown `formatVersion`, `cryptoSuite` or `keyEpoch` is *non-deterministic* (it depends on
  the reader's version and keys): see §d.6 for what each stream does with it.

### b.2 Streams

| Stream | Class | Frame kinds (plus `checkpoint` for checkpoint envelopes) | Checkpoint encoding | Broadcast | Writers |
|---|---|---|---|---|---|
| `ns` | ns | `nsOps` | `nsFoldV1` | commit-only | every device (planner) |
| `cfg` | cfg | `cfgOps` | `cfgFoldV1` | commit-only | devices with settings sync on |
| `b:<docId>` | body | `bodyUpdate`, `bodyUpdateRef` | `yjsStateV1` / `retired` | provisional + notice | any editor of the note |
| `c:<docId>` | canvas | `canvasUpdate`, `bodyUpdateRef` | `yjsStateV1` / `retired` | provisional + notice | any editor of the canvas |
| `x:<sha256hex>` | blobchunk | `blobChunk` | `retired` | commit-only | uploader when there is no blob store |

- `docId` and `clientFrameId` are 16 random bytes encoded as base64url without padding (22 chars).
  - A `clientFrameId` is never reused, on any stream, ever. The relay does not detect reuse across streams.
- Streams of any other class are ignored: the cursor still advances and nothing is stored.
- Every socket receives every stream (relay-wire §5.3). The cost of a row for a non-resident doc is bounded at
  gate stage 1–2 plus one tail put (§d.6).

### b.3 `nsOps` content

```
varuint opCount (1..512)
opCount × { u8 tag, varuint bodyLen, body[bodyLen] }
  create(1):       varstring docId, u8 kindCode(1 md, 2 canvas, 3 blob), varstring path, 32B contentHash, varuint size
  rename(2):       varstring docId, varstring path
  delete(3):       varstring docId, varuint baseBodySeq
  restore(4):      varstring docId, varstring path, varuint againstDeleteSeq
  setBlob(5):      varstring docId, 32B hash, varuint size, varuint baseRev
  upgradeRules(6): varuint version
```

- **Malformed frame.** The frame is malformed if any of these hold:
  - truncation, trailing bytes after the last op, or a varuint > 2^53−1;
  - invalid UTF-8;
  - opCount = 0 or > 512;
  - a docId that is not a 22-char base64url string;
  - an unknown tag or kindCode.
  - A malformed frame folds as an **empty frame**: it enters the dedupe ring and changes nothing else.
- **Forward-compatible fields.** Bytes after the known fields *inside* an op body are ignored. They are reserved
  for optional fields that never affect the fold.
- **Op-level problems are not malformation.** An invalid path, for example, makes only that op `ignored`.
- **Op identity.** An op's identity is `(deviceId, clientFrameId, index)`. Frame-level dedupe (§c.3) makes every op
  idempotent, even when the relay re-commits a resend at a new seq.

### b.4 Other contents

- **`bodyUpdate`, `canvasUpdate`.** Yjs update v1 bytes. A frame is `Y.mergeUpdates` of a small batch (§d.4).
- **`cfgOps`.** `varuint opCount (1..512)`, then `{u8 tag, varuint bodyLen, body}` per op:
  - `jsonSet(1)`: `varstring file, varstring key, varstring valueJson`
  - `jsonDel(2)`: `varstring file, varstring key`
  - `filePut(3)`: `varstring file, u8 contentTag`, then `varbytes bytes` (tag 1, inline) or `32B hash, varuint size`
    (tag 2, blob), then `varstring pluginVersion` (`""` = null)
  - `fileDel(4)`: `varstring file`
  - `pluginSet(5)`: `varstring pluginId, u8 enabled`
  - `pluginDel(6)`: `varstring pluginId`
  - Malformation rules are the same as `nsOps`.
- **`blobChunk`.** `32B sha256(whole blob), varuint index, varuint total, varuint totalSize, bytes chunk`.
  - Chunks are `BLOB_CHUNK_BYTES` (768 KiB); only the last may be shorter.
- **`bodyUpdateRef`.** `32B sha256(update bytes), varuint size`.
  - The update bytes live in the `BlobPort` (sealed), or in stream `x:<sha256>` as chunks.
  - The ref is appended only after every chunk is receipted, or after the blob put succeeds (`dependsOn`, §e.1).

### b.5 Checkpoints

Checkpoint envelope content: `u8 encoding, varuint coversSeq, varuint foldRulesVersion, bytes state`, sealed with
the checkpoint AAD and written with `putCheckpoint` (an HTTP CAS, ≤ `maxCheckpointBytes` = 4 MiB). Correctness
never depends on a checkpoint existing: a stream without one just costs more rows to read.

**Body and canvas (`yjsStateV1`).**
- The state is `Y.encodeStateAsUpdate(scratch)`, where `scratch` is a fresh `Y.Doc({gc: true})` loaded with exactly
  the committed rows of the stream with seq ≤ coversSeq: the local snapshot, then tail rows ≤ coversSeq (§d.8).
  Outbox frames and adoptables are never included.
- Verification on receipt: gate stages 1–2 and the coversSeq binding.
- The checkpoint is then **unioned** with local state (§d.7), so it can never remove content a reader already has.
- Alternative: verify body checkpoints by digest. Rejected: the union already protects every caught-up reader, and
  a digest needs the rows the checkpoint exists to replace.

**Namespace (`nsFoldV1`).** The state is the canonical encoding of `NsFoldState`. The envelope deflates it; digests
are computed over the uncompressed bytes.

```
varuint formatVersion (= 1)
varuint foldRulesVersion
varuint coversSeq
varuint entryCount
entryCount × (ascending docId, UTF-16 code-unit order)
  varstring docId
  u8  kindCode            1 markdown, 2 canvas, 3 blob
  u8  state               1 live, 2 deleted, 3 merged
  varstring path
  varuint createdSeq
  varstring createdBy
  varuint lastTouchSeq
  varuint deletedSeq      0 unless deleted
  varuint deleteBaseBodySeq  0 unless deleted
  32B createHash
  varuint createSize
  u8  hasBlob             1 iff kind = blob and state != merged; then 32B hash, varuint size, varuint rev
  u8  hasAlias            1 iff state = merged; then varstring aliasOf
varuint deviceCount
deviceCount × (ascending deviceId)
  varstring deviceId
  varuint n (1..64)
  n × varstring clientFrameId   oldest first
```

`pathKey`, `byPathKey`, `folderRefs` and `tombstones` are derived (`NsFoldIndex`) and never encoded.

A peer **verifies** an ns checkpoint before using it:

1. **V1, canonical form.** Decode, re-encode, and compare byte-for-byte. This rejects non-minimal varints, unsorted
   entries, duplicate docIds and trailing bytes.
2. **V2, structural invariants.** All of these must hold:
   - every docId is valid;
   - live and deleted entries satisfy `kind = kindOfPath(path)`, and every path is valid (§c.2);
   - state-specific fields are consistent;
   - every `aliasOf` exists and is not itself merged;
   - all seqs ≤ coversSeq, and `createdSeq ≤ lastTouchSeq`;
   - live pathKeys are unique, and no live file key equals a live folder prefix key;
   - all live entries under one folder key share its display casing;
   - tombstones ≤ `TOMBSTONE_CAP`, and each ring holds 1–64 unique valid ids;
   - `foldRulesVersion` ≤ `FOLD_RULES_VERSION`, else the ns fold halts as `upgrade-required`;
   - inner coversSeq equals the relay's coversSeq.
3. **V3, digest at candidates** (live devices only).
   - An ns row `s` is a **candidate** iff `floor(s / 1000) > floor(prev / 1000)`, where `prev` is the fold's
     coversSeq before `s`. Every device that folds `s` evaluates this the same way.
   - At each candidate a device records `(s, sha256(nsFoldV1 bytes))` in a 16-entry ring held in memory and in
     `streams["ns"].textHash` for the newest.
   - Checkpoints are written **only** at candidates (§d.9).
   - A device verifies the relay's current ns checkpoint whenever `read("ns")` reports a `checkpointSeq` that it
     holds a digest for and has not verified yet. It fetches the checkpoint with `read("ns", checkpointSeq − 1,
     true)`. The same check runs after losing a CAS and every 6 h.
   - **Mismatch** means the `ns-divergence` alarm:
     - the brake holds every destructive op (`BrakeReport.reason = "ns-divergence"`);
     - a diagnostics event and notice are raised;
     - the device never overwrites the checkpoint or its own fold.
   - A fresh device has no rows to compare (the relay GCs them), so it relies on V1 + V2. Alternative: a fresh
     device re-folds from seq 1. Rejected: the rows are gone.

**Settings (`cfgFoldV1`).** Same shape as `nsFoldV1`:
- header `varuint formatVersion, varuint coversSeq`;
- the device ring section;
- `json` registers sorted by key;
- `files` sorted by path;
- `plugins` sorted by id.

Each register is `value? (u8 present + bytes), varuint seq, varuint index, varstring deviceId`. Verification is
V1 + V2.

**`retired`.** An empty state that tells the relay it may GC every row ≤ coversSeq. It is written only for:
- `b:`/`c:` streams of docIds the fold has pruned, or that are merged aliases with rows;
- `x:` streams no ns entry or cfg file references (§j.1).

A reader that receives `retired` for a stream the fold still references treats it as a checkpoint with no state:
the union adds nothing, and rows > coversSeq still apply.

### b.6 Size rules and splitting

| Item | Limit | Rule |
|---|---|---|
| Sealed envelope | `maxFrameBytes` (1 MiB; larger closes the socket with 1009) | Content ≤ `MAX_FRAME_CONTENT_BYTES` (1 MiB − 4 KiB, leaving room for the header and AEAD). |
| ns frame | ≤ 512 ops, ≤ 256 KiB content | The planner splits; ops for one doc stay in plan order across frames. |
| cfg frame | ≤ 512 ops, ≤ 256 KiB | `filePut` content > 64 KiB goes as a blob ref (§j.3). |
| Body frame | soft 256 updates / 64 KiB | Holds whole updates. A single update may exceed 64 KiB. |
| Initial content of a new note | `INITIAL_INSERT_CHUNK_CHARS` = 192 Ki UTF-16 units | Inserted as consecutive transactions of ≤ 192 Ki units: one update, one frame (flag `initial`) each, so ≤ 576 KiB UTF-8. |
| Any single update > content limit after deflate | — | `bodyUpdateRef`: bytes go to `BlobPort`, else `x:<sha256>` chunks (≤ `MAX_LOG_BLOB_BYTES` = 8 MiB). Larger with no blob store: the doc is frozen `oversize-local`, the disk file is left untouched, and a notice is shown. |
| Checkpoint | `maxCheckpointBytes` (4 MiB) | Larger: skip. The stream keeps its rows. An ns state > 4 MiB (roughly 40k entries) is open risk OR-3. |
| Attachment | `BlobPort.maxBlobBytes` (10 MiB), else 8 MiB on the log | Larger: not synced, never deleted, notice (§j.1). |

---

## c. Namespace fold

The namespace is a replicated state machine: `NsFoldState` is the fold of every committed `ns` row in `(seq,
index)` order. A writer is never rejected. Conflicts resolve deterministically inside the fold, and each device's
planner reacts to the outcome for its own ops (§c.13). WP-A implements `FoldNsFrame` in `src/core/ns/fold.ts`. It
is pure and total: it never throws on a decoded `NsFrame` and never reads clocks, randomness or Map insertion order.

### c.1 State

- `NsFoldState`: `formatVersion`, `foldRulesVersion`, `coversSeq`, `entries: Map<DocId, NsEntry>`, `recentFrames:
  Map<DeviceId, ClientFrameId[]>`.
- `coversSeq` is the seq of the last folded ns row, or of the checkpoint the state came from. It is never advanced by
  feed pages or by rows of other streams.
- **Entry states.**
  - `live`: occupies its pathKey.
  - `deleted`: keeps its last path, `deletedSeq` and `deleteBaseBodySeq`, and is restorable.
  - `merged`: an alias of `aliasOf` (an identical duplicate create, §c.5). Ops on it are redirected.
- `lastTouchSeq` is the seq of the last effective op on the entry (create, rename, restore/revive, setBlob or delete).
  Precondition ops compare it with their `authorNsSeq`.
- **`NsFoldIndex`** is rebuilt from `entries`:
  - `byPathKey`: live entries only;
  - `folderRefs`: for every folder prefix of a live path, the shared display casing and the count of live entries
    beneath it;
  - `tombstones`: count of deleted + merged entries.
- **Determinism rule.** Any iteration over entries that can affect the result MUST be in ascending docId order.

### c.2 Paths

A path in an op is **valid** iff all of these hold:

- `path === path.normalize("NFC")`;
- every code point is assigned in Unicode 15.1 (a frozen range table), which makes NFC and case folding stable
  across JS engines;
- it has 1..n segments separated by `/`, with no leading or trailing `/`;
- no segment is empty, `.` or `..`, and no segment starts with `.` (dot-folders and the config dir are not
  indexed by Obsidian; settings ride `cfg`);
- no character from `FORBIDDEN_PATH_CHARS` (`\ * " < > : | ?`), no C0 control and no DEL;
- every segment is ≤ 255 UTF-8 bytes and the whole path is ≤ 1024 bytes;
- no segment's stem (the text before the first dot) case-insensitively equals a `RESERVED_STEMS` entry;
- no segment ends with `.` or a space.

`pathKey(p) = NFC(caseFold15_1(NFC(p)))`, using the full case folding of Unicode 15.1 CaseFolding.txt (status C+F),
frozen as a generated table in `src/core/paths/pathKey.ts`. It is always case-folded, even on case-sensitive
filesystems, so a vault stays portable.
- Alternative: per-device case sensitivity. Rejected: the fold must be identical everywhere.
- Alternative: `String.prototype.toLowerCase`. Rejected: its results vary with the engine's Unicode version.

`kindOfPath(p)`: `.md` → markdown, `.canvas` → canvas, anything else → blob, matching the extension
ASCII-case-insensitively. Changing a file's extension in a way that changes its kind is planned as delete + create.

### c.3 Frame-level rules

For each committed ns row, in seq order:

1. **Open and decode.**
   - Envelope failures that depend on the reader (unknown suite/keyEpoch, auth failure, unsupported
     `formatVersion`) **halt** the ns fold at this row: phase `upgrade-required` or `key-missing`, with the rows
     kept in `tail`.
   - Deterministic decode failures make the frame malformed (§b.3), which folds as an empty frame.
2. **Dedupe.** If `clientFrameId ∈ recentFrames[deviceId]`, emit one frame-level event `ignored/duplicate-frame`
   and stop. Otherwise append the id and trim the ring to `NS_DEDUPE_RING` (64), oldest out.
3. **Fold.** Fold each op in index order (§c.5–§c.10). Each op emits one `NsFoldEvent`.
4. **Prune** if needed (§c.9).
5. Set `coversSeq = seq`.

**Why the ring is exact.** The relay dedupes resends only within a recent window (relay-wire §5.4, §12). The
writer-side **send window** closes the gap:
- own ns frame `k` may be sent only when every own ns frame ≤ `k − NS_SEND_WINDOW` (32) is receipted;
- so a resend of `k` can only happen while fewer than 32 later own frames exist, and `k` is still among the device's
  newest 64 ids;
- after a receipt a frame is never resent.

The same ring and window apply to `cfg`. On reconnect the engine first catches up `ns` and `cfg`; own frames found
there are late receipts. Only then does it resend what remains (§d.7), so duplicates are rare even before the ring.

### c.4 Placement (create, rename, restore, revive)

`place(requested, entry, mode)` computes the final path for an entry that has already been removed from the
index. `mode` is one of `create`, `rename`, `caseOnlyRename` or `revive`. Steps:

1. **Ancestors**, left to right. For segment `i` (excluding the leaf), let `k = pathKey(out[0..i])`:
   1. **Ancestor is a live file** (`byPathKey.has(k)`): replace `out[i]` with `${seg} (${n})` for the smallest
      n ≥ 2 whose prefix key is not a live file. Folders get no extension split.
   2. **Folder exists with different casing** (`folderRefs.get(k)` has a display whose last segment ≠ `out[i]`):
      - `caseOnlyRename` → **recase**: rewrite the display prefix of every live entry under `k` (in docId order;
        `lastTouchSeq` is unchanged) and update `folderRefs`;
      - any other mode → set `out[i]` to the existing casing.
      - This is the casing rule: all live entries under one folder key share one display casing; the newest
        case-only rename sets it.
      - Alternative: never recase. Rejected: Obsidian folder case renames would revert on every device.
2. **Leaf.** Let `k = pathKey(out)`. There is a collision if `byPathKey` holds another doc at `k`, or `folderRefs`
   holds `k` (a folder with live children).
   - **create only, identical duplicate.** If `byPathKey.get(k) = W` with `W.kind = kind` and `contentHash ∈
     {W.createHash, W.blob?.hash}`, return `merged(W)`.
   - **Otherwise suffix the leaf.** Let `ext` be the leaf's last `.xxx` (when the dot is not at position 0), and
     `stem` the rest. Try, in order:
     - `${stem} (${n})${ext}` for n = 2..`MAX_SUFFIX_N` (10000);
     - `${stem} (${docId.slice(0, 8)})${ext}`;
     - `${stem} (${docId})${ext}`.
     - The first candidate whose key is neither a live entry nor a live folder wins.
     - If the segment or the path is over its byte limit, drop code points from the end of `stem`, then strip
       trailing dots and spaces. If the stem becomes empty, move to the next candidate form.
   - If every candidate fails, the op is `ignored/invalid-path`.
3. **Outcome.**
   - `applied` if `out = requested`;
   - `suffixed{requestedPath, finalPath}` otherwise, including casing-only adjustments;
   - `revived{finalPath}` for revive and restore;
   - `merged{into}` for an identical duplicate.

First-in-seq wins: whoever occupies a key first keeps it, and later ops get suffixed. No op ever displaces a live
entry.

### c.5 create

Checks, in order:
1. The docId already exists, in any state → `ignored/duplicate-docid`.
2. The path is invalid → `invalid-path`. `kind ≠ kindOfPath(path)` → `kind-mismatch`.
3. Call `place(path, mode=create)`.

Results:
- **New entry** (applied or suffixed): `{state: live, createdSeq: seq, createdBy: deviceId, lastTouchSeq: seq,
  createHash, createSize, blob: kind = blob ? {hash, size, rev: seq} : null}`.
- **Merged into W**: a new entry `{state: merged, aliasOf: W.docId, path: W.path, lastTouchSeq: seq, blob: null}`.
  W is unchanged.

**Identical duplicate creates** are the onboarding case: two devices import the same vault concurrently. Each
identical file merges, so there are no conflict copies, no extra body rows (held initial body frames of merged docs
are dropped, §e.2) and no disk ops. Only files that really differ are suffixed. When W was edited after its create,
the loser may still match W's *current* body; the planner's identical-loser collapse handles that (§c.13).

### c.6 rename

1. Redirect if the entry is merged (target = `aliasOf`).
2. The docId is unknown → `unknown-docid`.
3. The path is invalid → `invalid-path`. `kind ≠ kindOfPath(path)` → `kind-mismatch`.
4. **Target is deleted.**
   - If `authorNsSeq < deletedSeq`, the author had not seen the delete, so the rename wins: **revive** with `place(path,
     revive)`. Set `state = live`, `deletedSeq = deleteBaseBodySeq = 0`, `lastTouchSeq = seq`. Outcome `revived`.
   - Otherwise → `stale-revive`.
5. `path === entry.path` → `noop`.
6. Otherwise remove the entry from the index and call `place(path, pathKey(path) = entry.pathKey ? caseOnlyRename :
   rename)`. Set `lastTouchSeq = seq`.

Concurrent renames of one doc are LWW in seq order. Renames are never merged with other entries; collisions suffix.

### c.7 delete, restore, edit-beats-delete

**delete.**
1. Redirect.
2. Unknown → `unknown-docid`.
3. Already deleted → `already-deleted`.
4. `authorNsSeq < lastTouchSeq` → `stale-delete`: the author did not see the latest create, rename, restore or
   setBlob, so the rename wins.
5. Otherwise set `state = deleted`, `deletedSeq = seq`, `deleteBaseBodySeq = op.baseBodySeq`, `lastTouchSeq = seq`,
   and remove the entry from the index. Outcome `deleted`.

**restore.**
1. Redirect.
2. Unknown → `unknown-docid`.
3. Not deleted → `not-deleted`.
4. `deletedSeq ≠ againstDeleteSeq` → `restore-not-current`.
5. Otherwise revive with `place(op.path, revive)` and set `lastTouchSeq = seq`.

The first valid restore wins; later restores are no-ops by rule 3.

**Edit beats delete.**
- Every body and canvas frame carries `authorNsSeq`. Body rows of a deleted doc are still ingested, so a restore
  brings back the latest content.
- The **restore condition** for a deleted doc D holds when some body row of D has `seq > D.deleteBaseBodySeq` and
  `authorNsSeq < D.deletedSeq`: an edit the deleter had not seen.
- **Primary duty.** The author of such a row emits `restore{D, D.path, againstDeleteSeq: D.deletedSeq}` as soon as it
  folds the delete, provided its `streams[b:D].lastOwnSeq > deleteBaseBodySeq` or it has pending body frames for D.
- **Fallback duty.** Any other device that sees the condition, at fold time or at row ingest, schedules a check after
  30 s plus `hash(deviceId, D) mod 30 s`. If D is still deleted with the same `deletedSeq`, it emits the restore.
- Detection is cheap: the feed's per-stream `lastSeq` is compared with `deleteBaseBodySeq`.
- Locally, the planner also rematerializes when the remote content changed since the sync point and the local file is
  missing (§f.2).

### c.8 setBlob

1. Redirect.
2. Unknown → `unknown-docid`.
3. `kind ≠ blob` → `not-blob`.
4. **Deleted.** If `authorNsSeq < deletedSeq`, revive at `entry.path` via `place(revive)`, set the blob
   unconditionally to `{hash, size, rev: seq}` and the outcome to `revived`. Otherwise → `stale-revive`.
5. **Live.**
   - `hash = blob.hash` → `noop`;
   - `baseRev ≠ blob.rev` → `rev-mismatch`;
   - otherwise set `blob = {hash, size, rev: seq}` and `lastTouchSeq = seq`.

Concurrent attachment changes **keep both**. The loser sees `rev-mismatch` on its own op. Its planner then
conflict-copies its local bytes to a new name and creates that doc, and fetches the winner's bytes into the original
path (example E8).

### c.9 Tombstones and pruning

- After each frame, if `tombstones > TOMBSTONE_CAP` (20000), remove deleted and merged entries in ascending
  `(lastTouchSeq, docId)` order until `tombstones = TOMBSTONE_CAP − TOMBSTONE_PRUNE_HYSTERESIS` (19000).
- Before removing a deleted entry, every merged alias pointing at it is pruned first, in the same pass, so aliases
  never dangle.
- One frame-level event `pruned{docIds}` is emitted.
- Later ops on pruned docIds are `unknown-docid`.
- Devices with checkpoint duty put `retired` checkpoints for the pruned docs' `b:`/`c:` streams (§d.9).
- A long-offline device that still holds a pruned doc is handled by the planner row "absent/pruned" (§f.2).
- Alternative: age-based pruning. Rejected: it needs wall clocks, which the fold never reads.

### c.10 Rules versioning (`upgradeRules`)

- Every constant marked `FOLD` in `limits.ts`, the placement algorithm and the case-fold table are fold rules
  version 1.
- `upgradeRules{version}`:
  - `version ≤ foldRulesVersion` → `noop`;
  - `version > FOLD_RULES_VERSION` (the reader does not know the rules) → **halt** the ns fold *before this frame*:
    - the fold pre-scans each frame for such an op, so the frame is either folded whole or not at all. One event
      `ignored/rules-version` is emitted, the state is unchanged, and `coversSeq` stays at the previous row;
    - phase `upgrade-required`;
    - body streams keep syncing;
    - the planner emits no ns ops and no ns-derived destructive disk ops (remote deletes, moves, loser renames).
  - Otherwise set `foldRulesVersion = version`; it governs every later `(seq, index)`.
- v1 clients never emit `upgradeRules`. The rollout policy for v2 is out of scope.

### c.11 Settings fold (`cfg`)

- `CfgFoldState` is LWW registers ordered by `(seq, index)`, with the same duplicate-frame ring and send window as
  ns (§c.3).
- **Registers:**
  - `json[file ⧺ "\0" ⧺ topLevelKey]` for allowlisted JSON files (`jsonSet` / `jsonDel`);
  - `files[file]` for whole files under the allowlist (`filePut` / `fileDel`). Binary or > 64 KiB content is a
    blob ref;
  - `plugins[pluginId]` for `community-plugins.json` membership (`pluginSet` / `pluginDel`). The file itself is
    projected from this map in sorted id order.
- A deletion keeps a tombstone (`value: null`). The key space is bounded by the allowlist.
- The fold has **no gates**. Application gates run at projection (§j.3):
  - `plugins/yaos/**` is never synced or applied;
  - `plugins/<id>/data.json` applies only when the local plugin version equals the op's `pluginVersion`
    (`canApplyPluginData`);
  - a per-file denylist of device-local top-level keys is never emitted.

### c.12 vaultEpoch change

The epoch is `VAULT_READY.vaultEpoch` (the relay's `vaultGeneration` string). Seqs are not comparable across epochs.
4409 is never sent on streams sockets.

The engine detects a change when `session.vaultEpoch ≠ identity.vaultEpoch`, or when the relay answers HTTP 409
`vault_generation_mismatch`. It then:

1. Enters phase `epoch-migrating`, saves bound views (`saveViews`) and takes a local snapshot (§j.4).
2. Writes `intent{epoch-migration}`.
3. Reads the old DB's `synced` and `baseText` into memory as **path-keyed bases**. Old docIds are meaningless in the
   new epoch.
4. Creates the new DB `yaos2:<vaultId>:<newEpoch>:<deviceId>` and onboards against the new epoch as in §j.5. Path-keyed
   bases turn the "no-base" merges into 3-way merges where the paths match.
5. Drops the old outbox. Its edits are on disk, so the scan re-derives them.
6. Deletes the old DB once the new one reaches `live`.

### c.13 Fold outcomes → planner duties

The planner consumes `NsFoldEvent`s for its own frames (matched on `deviceId`) and the resulting `RemoteEntry`
changes.

- **S1, synced update.** When an own op folds as `applied`, `suffixed` or `revived`, the `synced` record is updated
  to what the disk reflects. For `suffixed`, `synced.path = requestedPath`, and `nsTouchSeq` keeps its previous value
  (0 for a create). The planner then sees "remote moved" and performs the **loser rename** with a plain
  `vault.rename`. Links are not rewritten. A notice lists the renamed losers.
- **Identical-loser collapse.** Before a loser rename of an own *create*, if the loser's disk hash equals the
  winner's caught-up content hash, the planner instead:
  - rebinds `synced` to the winner;
  - emits `nsDelete(loser, baseBodySeq)`;
  - performs no disk op.
  - This removes the residual conflict copies of concurrent onboarding.
- **Merged.** A `rebind(loser → winner)` follows. Held initial body frames of the loser are dropped (§e.2).
- **Ignored precondition ops** (`stale-delete`, `rev-mismatch`, `stale-revive`): the planner re-evaluates from the
  three trees, and nothing destructive follows from the ignored op. A `rev-mismatch` keeps both (§c.8).
- **Precondition ops** (delete, restore, setBlob) are emitted only when the doc has no pending own ns op, so a device
  never makes its own delete stale. Creates and renames pipeline freely.
- **Pruned**: the doc's streams are retired. **Restore duty**: see §c.7.

### c.14 Worked examples

`h*` are content hashes. "A@19" means device A with `authorNsSeq` 19. Paths are shown as display paths.

- **E1, simple create.** A@4 seq 5 `create d1 md "Notes/a.md" h1`.
  - Result: `applied`; `d1 {live, "Notes/a.md", createdSeq 5, lastTouch 5}`; `folderRefs[notes] = {"Notes", 1}`.
  - A then releases its held initial body frames for d1, and S1 sets `synced[d1].nsTouchSeq = 5`.
- **E2, collision suffix and casing.** B@4 seq 7 `create d2 md "notes/A.md" h2`.
  - The ancestor `notes` exists as `"Notes"`, so it is recased to `"Notes"`.
  - The leaf key `notes/a.md` is held by d1 and `h2 ∉ {h1}`, so the leaf is suffixed.
  - Result: `suffixed{"notes/A.md" → "Notes/A (2).md"}`.
  - B's planner (S1: `synced[d2].path = "notes/A.md"`):
    1. `diskRename("notes/A.md" → "Notes/A (2).md")`;
    2. then `diskMaterialize(d1, "Notes/a.md", expect absent)`.
    - Renames run before materializes, so a case-insensitive disk never collides.
- **E3, identical onboarding.** A seq 10 `create d3 md "Inbox/x.md" hX`; B seq 11 `create d4 md "Inbox/x.md" hX`.
  - Result: d4 is `merged{into d3}`; `d4 {merged, aliasOf d3}`.
  - B drops d4's held body frame, rebinds `synced` d4 → d3, and runs `syncedPut(d3)` once d3's body is caught up and
    hashes to hX.
  - Zero disk ops and zero conflict copies.
  - With 5000 identical files there are 5000 merges, still zero copies.
  - If B's file had `hY ≠ hX`: `suffixed "Inbox/x (2).md"`, B renames its file, and A materializes `x (2).md`.
- **E4, ancestor is a file.** `d5 {live, blob, "Projects"}` exists. C seq 20 `create d6 md "Projects/plan.md"`.
  - Ancestor key `projects` is a live file, so the segment becomes `"Projects (2)"`.
  - Result: `suffixed "Projects (2)/plan.md"`.
  - C's planner:
    1. `diskRename("Projects/plan.md" → "Projects (2)/plan.md")`;
    2. `removeEmptyFolder("Projects")`;
    3. `diskMaterialize(d5, "Projects")`.
- **E5, rename vs rename.** d1 at `"a.md"`, `lastTouch 19`. A@19 seq 20 `rename d1 "b.md"`; B@19 seq 21 `rename d1
  "c.md"`.
  - Both are `applied`: LWW gives `"c.md"`. A's planner moves `b.md → c.md`.
  - Different docs to one target: seq 22 `rename d1 "z.md"` is `applied`; seq 23 `rename d2 "Z.md"` is
    `suffixed "Z (2).md"`.
- **E6, rename vs delete, both orders.** `d7 {live, "r.md", lastTouch 30}`, last body row seq 28.
  - Rename first: A@30 seq 31 `rename d7 "s.md"` is `applied` (lastTouch 31). Then B@30 seq 32 `delete d7
    baseBodySeq 28`: 30 < 31, so `stale-delete`. B's planner (R moved, L missing) rematerializes at `"s.md"`.
  - Delete first: B@30 seq 31 `delete d7` gives `deleted, deletedSeq 31`. Then A@30 seq 32 `rename d7 "s.md"`: 30 <
    31, so `revived "s.md"`. B rematerializes.
  - The rename wins in both orders, and nothing is lost.
- **E7, edit vs delete.**
  - d8's body rows go up to seq 40. B@40 seq 41 `delete d8 baseBodySeq 40`. A, which had not seen the delete, appends
    a body frame at seq 42 with `authorNsSeq 39`.
  - A folds seq 41 and finds `lastOwnSeq 42 > 40`, so it emits seq 43 `restore{d8, path, againstDeleteSeq 41}`:
    `revived`.
  - B's planner (R live, S dropped, L absent) materializes the content, including A's edit.
  - C saw the condition at row 42 and scheduled a fallback check. At 30 s+ d8 is live, so C emits nothing.
  - Variant: if A's frame was sealed after A folded 41 (`authorNsSeq ≥ 41`), others have no duty. A's planner sees
    "deleted + L changed" and emits `nsRestore` + `reconcileContent`.
- **E8, setBlob keep-both.** `d9 {blob, "img.png", blob h0 rev 50}`.
  - A@50 seq 51 `setBlob h1 baseRev 50` is `applied` (rev 51). B@50 seq 52 `setBlob h2 baseRev 50` is `rev-mismatch`.
  - B's planner:
    1. `conflictCopy("img.png" → "img (conflict B 2026-10-05 1412).png")`;
    2. `fetchBlob(d9, h1)` into `"img.png"`, expecting h2;
    3. `pushBlob` + `nsCreate` for the copy.
  - Both versions survive.
- **E9, dedupe ring.**
  - A's frame `f1` commits at seq 60. A's socket closes before the receipt, and A reconnects after the relay's dedupe
    window has passed.
  - A catches up ns first and finds row 60 from (A, f1), a late receipt, so normally nothing is resent.
  - If the resend raced and committed again at seq 75, the fold sees `f1 ∈ recentFrames[A]` and records
    `duplicate-frame`, with no state change.
- **E10, case-only renames.**
  - Leaf: A seq 80 `rename d10 "Notes/TODO.md"` (was `"Notes/todo.md"`): same key, caseOnly, the self entry has been
    removed, so it is `applied`. Others `diskRename` (`VaultPort` uses a temp name on case-insensitive FS).
  - Folder: A renames folder `Notes → notes`, producing one frame at seq 81: `rename d10 "notes/TODO.md"`, `rename
    d11 "notes/x.md"`.
    - Op 0 recases `folderRefs[notes]` to `"notes"` and rewrites d11 to `"notes/x.md"`.
    - Op 1 is a `noop`.
    - B's concurrent seq 82 `create d12 "Notes/new.md"` becomes `suffixed "notes/new.md"` (casing).
- **E11, prune.**
  - After seq 9000, tombstones = 20001. The 1001 oldest by `(lastTouchSeq, docId)` are pruned, leaving 19000, and
    event `pruned{…}` is emitted.
  - A later `rename` of a pruned id is `unknown-docid`.
  - An offline device with `synced` for a pruned doc: L unchanged → `diskTrash` (braked); L changed → `nsCreate` of a
    fresh doc and `syncedDrop` of the old.
- **E12, upgradeRules halt.** A v1 device folds seq 9100 `upgradeRules{2}`.
  - The ns fold halts with `coversSeq 9099` and phase `upgrade-required`. Rows ≥ 9100 stay in `tail` until the
    client is upgraded.
  - Bodies keep syncing. No ns ops are emitted and no remote moves or deletes are applied locally.
