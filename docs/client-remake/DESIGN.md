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
| I3 | The same log prefix gives the same state everywhere. | Pure fold `FoldNsFrame` over `(seq, index)` (§c). `FOLD` constants in `limits.ts`. Frozen Unicode case folding (§c.2). Duplicate-frame ring plus send window (§c.3). `upgradeRules` halts instead of guessing (§c.10). Canonical `nsFoldV1` checkpoints are verified by re-encode and digests (§b.5). `cfg` is LWW on `(seq, index)` (§c.11). `snap` is an order-independent join (§j.4). Bodies are Yjs CRDTs. |
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
| `snap` | snap | `snapOps` | `snapFoldV1` | commit-only | devices that upload or delete snapshots (§j.4) |
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
- **`snapOps`** (`src/core/snap/record.ts`). `varuint opCount (1..16)`, then `{u8 tag, varuint bodyLen, body}` per op:
  - `put(1)`: `u8 recordVersion`; version 1 is `varstring snapshotId, varuint createdAtMs, varstring deviceLabel,
    varstring reason, u8 format, varuint fileCount, varuint totalBytes, 32B bundleDigest, varuint partCount
    (1..512)`, then per part `32B address, varuint size, 32B sha256`. At most 48 KiB per record;
  - `del(2)`: `varstring deviceId, varstring snapshotId`;
  - `floor(3)`: `varuint createdAtMs` (the author's snapshots created before it are deleted).
  - Malformation rules are the same as `nsOps`, plus every bound in §j.4. A put with an unknown `recordVersion` is
    not malformed: the fold ignores it and reports it.
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

**Snapshot index (`snapFoldV1`, encoding 5).** Header `varuint formatVersion, varuint coversSeq`, then floors
sorted by deviceId, dels sorted by key and records sorted by key (key = `deviceId/snapshotId`; a record is
`varstring deviceId, varbytes put body`). Verification: strict decode (every id, record and bound), then the
canonical re-encode must be byte-identical; `foldRulesVersion` ≤ 1, and the inner coversSeq equals the relay's.

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
| snap frame | ≤ 16 ops, records ≤ 48 KiB | One upload is one frame: `put` plus an optional `floor` (§j.4). |
| Body frame | soft 256 updates / 64 KiB | Holds whole updates. A single update may exceed 64 KiB. |
| Initial content of a new note | `INITIAL_INSERT_CHUNK_CHARS` = 192 Ki UTF-16 units | Inserted as consecutive transactions of ≤ 192 Ki units: one update, one frame (flag `initial`) each, so ≤ 576 KiB UTF-8. |
| Any single update > content limit after deflate | — | `bodyUpdateRef`: bytes go to `BlobPort`, else `x:<sha256>` chunks (≤ `MAX_LOG_BLOB_BYTES` = 8 MiB). Larger with no blob store: the doc is frozen `oversize-local`, the disk file is left untouched, and a notice is shown. |
| Checkpoint | `maxCheckpointBytes` (4 MiB) | Larger: skip. The stream keeps its rows. An ns state > 4 MiB (roughly 40k entries) is open risk OR-3. |
| Attachment | `BlobPort.maxBlobBytes` (10 MiB), else 8 MiB on the log | Larger: not synced, never deleted, notice (§j.1). |
| Snapshot part | `min(8 MiB, ⌊maxBlobBytes × 7/8⌋)`; ≤ 512 parts, zip ≤ 320 MiB | Parts go to the `BlobPort` only, never to the log (§j.4). |

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

The same ring and window apply to `cfg`. `snap` needs no ring: its fold is a join, so a duplicate row changes
nothing (§j.4). On reconnect the engine first catches up `ns`, `cfg` and `snap`; own frames found there are late
receipts. Only then does it resend what remains (§d.7), so duplicates are rare even before the ring.

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

---

## d. Body engine

The body engine lives in the engine (the worker, or inline). It owns one **worker replica** `Y.Doc` per resident doc,
and that is the only replica: the main thread holds no CRDT, including for docs bound to an open editor (§d.2). Yjs is
pure JS, and every doc uses `gc: true`.

- **Root types.**
  - Markdown: exactly one `Y.Text` named `"text"`.
  - Canvas: see §j.2.
- **Origins.** Origin tags are module-level symbols:
  - `MAIN`: editor changes pushed by a bound view (`bodyPush`, §d.3);
  - `REMOTE`: committed or provisional rows;
  - `MERGE`: worker-side merge engine output;
  - `LOAD`: building a replica from storage.

### d.1 Handle lifecycle and residency

```
cold ──load──▶ resident ──bind──▶ bound
  ▲               │  ▲              │
  └──evict(clean)─┘  └────unbind────┘
```

- **cold.** Only IDB records exist: `streams`, `snapshots`, `tail`, `outbox`. Rows for cold docs are gated (§d.6
  stages 1–2) and stored without building a `Y.Doc`.
- **load** (lane of the requester), in one `Y.transact(doc, …, LOAD)`:
  1. apply the `snapshot`;
  2. apply every `tail` row of the stream in seq order, resolving `bodyUpdateRef` rows (§d.6);
  3. apply the `content` of every own outbox record of the stream (held, pending, sent, adoptable) in `order`.
  - Poisoned records are skipped.
  - Cost is O(doc) and happens once per residency, never per edit.
- **resident.** The replica is in memory, and the frame builder and merge jobs may use it.
  - Estimated heap: `3 × (snapshot bytes + tail bytes + applied update bytes)`.
- **bound.** Resident, with one or more editor views attached as clients (§d.2). A bound doc is pinned and never evicted.
- **evict.** LRU (`streams.lastAccessMs`) over **clean** handles only. A handle is clean when:
  - its frame builder is empty (flushed through `T_edit`);
  - no merge, projection, catch-up or compaction job holds it;
  - it is not bound.
  - Eviction just drops the `Y.Doc`. Everything it holds is already in IDB.
- **Budgets.** `maxResidentDocs` and `maxResidentBytes` per device class (§i.2).
  - When over budget with no clean handle, new loads wait: lane 3/4 jobs queue, and lane 0/1 loads may exceed the
    budget by one doc.
  - `memory-pressure` evicts every clean handle.

### d.2 Bound views: the worker replica is the only replica

- **No CRDT on main.** A bound note has exactly one `Y.Doc`, and it lives in the worker. Each open editor is a client
  of that replica in the @codemirror/collab model (split views of one file are two clients). Main holds only
  CodeMirror values:
  - the editor's own `Text`;
  - a `DocMirror` per bound doc: the replica's text at the last version main applied (immutable `Text`, O(change ·
    log N) per entry) and the text of the last durable version;
  - per view, its unconfirmed `ChangeSet`s (host/bodyClient.ts).
  - check-deps forbids `yjs`, `y-protocols`, `lib0` and `y-codemirror.next` anywhere under `src/host`. That covers
    direct, type-only, test and transitive imports (through core/ports/protocol), and it guards whole-document
    reads on main (§k.2).
  - The one exception is the inline fallback (§g.5): with no Worker, the engine and its Yjs run on main by design.
- **No hashing or whole-file decoding on main.** The host reads and writes raw bytes. Every fingerprint and content
  hash it needs (write preconditions, config writes) comes from the engine through `HashOracle` (§h, `hashRequest`
  in §g.2). What that costs in the precondition window is in §f.2.
- **Opening a note.**
  - The host sends `openDoc{path, viewId}` and the engine answers `bind{docId, kind, frozen}`. Resolution is as
    before (`remoteByPathKey`, optimistic remote). The engine answers `notBindable` for excluded, untracked and
    non-markdown paths, and a later `bindable{path}` makes the host retry. No answer carries text or CRDT state.
  - Main uploads the editor text as `textChunk{uploadId, bytes, last}`:
    - UTF-16 slices of `TEXT_CHUNK_UNITS` (65 536) units, each buffer transferred;
    - one macrotask per chunk, with a `setTimer(0)` yield between chunks.
  - This is the only whole-editor read on main, and it never runs per keystroke or per workspace event. It happens
    at the first bind and at a re-bind (after a resync or an engine restart).
    - At a re-bind, main also uploads the restart base: the mirror's last durable text.
    - At every bind of a dirty view, it also uploads the text Obsidian last saved (`saved`). The engine has no disk
      text for the doc after a restart; taking the editor's unsaved text for it would turn a sibling view's older
      disk text into an edit that reverts the unsaved one (sim seed 62, sim/device.test.ts).
  - `bodyAttach{docId, viewId, editor, base, saved}` names the uploads. The user keeps typing meanwhile. Edits made
    after the upload stay in the view client as `pre`.
- **Bind-time merge, in the worker** (boundBody.attach). If the upload differs from the replica's text, the worker
  runs `merge(base, disk = upload, crdt = replica)` with the one merge engine (§f.3).
  - `base` is the upload itself when the replica has already absorbed it (its last disk text or a save candidate).
    Otherwise it is the uploaded restart base, the doc's last disk text, or the persisted synced base, in that order.
  - The result enters the replica as one MERGE transaction, which reaches the doc's other views as an entry.
  - The view gets `bound{viewId, attach, version, changes, length}`: the ChangeSet that turns its upload into the
    replica's text at `version`. Main applies it behind `pre` (§d.3).
  - On a conflict, the worker writes the conflict copy itself (boundDisk: precondition `absent`, retried on I/O
    errors, notice `conflict-copy`).
  - **A conflict copy not yet written exists only in worker memory and is lost if the worker dies.** The sim device
    counts these as `crashLost`.
- **While bound:**
  - The editor buffer **is** the Local-tree content of the file. Obsidian's own save writes it (2 s debounce, or
    `saveViews`), and the projection never writes a bound file.
  - When Obsidian reads the editor for a save (`getViewData` with dirty cleared, `onSaveRead`), main pushes what it
    has buffered and posts `bodySaveMark{version, seq}`. The worker keeps that replica text as a save candidate.
  - A vault event on a bound file schedules `checkSaved` in the worker. It reads the file, stats it, and checks the
    file did not change in between.
    - Only text the replica has absorbed (its last disk text, a save candidate, or the replica's current text)
      becomes `boundSaved`, the synced base.
    - The reconcile merge does not count a bound editor's own save as an external edit (`boundSavedText`).
    - Main never hashes or compares texts on this path.
- **Content Obsidian pushes into a bound view** with `setViewData(data, false)`: an external reload, a properties
  edit, or the quick-preview copy from a sibling view. The per-view interceptor, installed from `opening` onward,
  routes it:
  - **Quick preview from a sibling of the same file that is attaching or bound: dropped** (`"handled"`). The sibling's
    edit reaches this view as an entry. "Same file" means the same doc, or the same path while the receiving view is
    still opening.
    - A preview from a sibling that is only opening goes through the reload route below.
    - Views that cannot bind (idle, waiting) get Obsidian's default.
  - **Otherwise, while attaching or bound: a reload.**
    1. Main holds the view's saves: `getViewData` answers `lastSavedData`, so Obsidian's save compares equal and
       skips.
    2. Main uploads the incoming text as it came (chunks) and sends `bodyReload{reload, text}`.
    3. The worker merges it (boundDisk.reload: `base` is the incoming text if the replica absorbed it, else the last
       disk text) and applies the result as MERGE. The entry carries the result to the editor. On a conflict the
       worker writes a conflict copy.
    4. The worker answers `reloaded{viewId, reload, save}`. Main releases the hold, and saves if told to or if a save
       was skipped meanwhile.
  - If interception is unavailable (risk OR-2), the periodic reconcile catches the change: `saveViews`, then
    `reconcileContent` against the replica.
- **Unbind** (`closeDoc{docId, viewId}`, on `file-changed`, view close, or `EditorView.setState` via `onReset`): the
  binding detaches. The worker replica stays resident (clean, LRU).
- **`docRetarget`** (renamed, merged, deleted, frozen, resync) works as before.
  - For `renamed`, `merged` and `frozen`, the host re-opens the doc. `frozen` binds read-only.
  - For `resync`, every view of the doc re-binds: upload, then `bodyAttach` with the mirror's durable text as the
    base.
- **Engine restart:** `suspend` keeps each doc's durable mirror text as its restart base, and `start` re-binds every
  view.

### d.3 Two-way flow without double apply

```
editor ─CM tx─▶ onLocal(ChangeSet) ─▶ view client buffer ─≤16 ms─▶ bodyPush{seq, base|after, changes} ─▶ worker Y.Doc (MAIN)
   ▲                                                                                                        │
   └─ applyRemote(F′) ◀─ rebase over unconfirmed ◀─ DocMirror.apply ◀─ body{entry|bound|reject|durable|reloaded} ◀┘
                                                     (FIFO per doc, docCredit window)          frame builder (MAIN, MERGE)
```

- **Versions and entries.** Every change of a bound replica bumps the doc's version and becomes one `entry{from, to,
  changes, length, origin, author}`.
  - `changes` is CodeMirror ChangeSet JSON over the text at version `from`: a number retains, `[n]` deletes,
    `[n, ...lines]` replaces. The worker computes it from the Y transaction's delta.
  - `author` is `{viewId, seq}` of the push the entry applies, or null for remote, provisional and merge changes.
- **Typing (main → worker).**
  - The collab ViewPlugin reports each local transaction's ChangeSet (O(change)), and the view client composes it
    into its buffer.
  - `MAIN_UPDATE_COALESCE_MS` later, main sends `bodyPush{seq, base, after, changes}`. A push is either against the
    mirror's version (`after = null`) or chained after the view's newest push still in flight (`after = seq`).
  - Only changed ranges and inserted text cross. No message on the typing path carries the document.
- **Worker.**
  - A push fits when `after === null ? base === version : lastAuthor = {viewId, after}`, meaning nothing else came in
    between.
  - A push that fits applies as one MAIN Y transaction (`applyEditorChanges`, O(change)). Its update bytes go to the
    frame builder unchanged. Its entry, with `author` set, goes to every attached view.
  - Otherwise the worker answers `reject{viewId, seq, version}`.
- **Main applies each body event in order:**
  - **entry:** `DocMirror.apply` refuses a version gap or a length mismatch (→ resync).
    - The author view confirms its oldest push in flight. Any other order → resync.
    - Every other bound view rebases the foreign change F over its unconfirmed changes:
      - for each push I in flight: `I′ = I.map(F)`, then `F = F.map(I, true)`;
      - then for the buffer B: `B′ = B.map(F)`, then `F = F.map(B, true)`.
    - The editor applies the final F with `addToHistory = false`, `remote = true` and filters off.
    - On both sides the replica's change goes first at equal positions (the worker applies I′ after F), so every
      editor converges with the replica.
  - **reject:** `version` must equal the mirror's. Main composes everything unconfirmed into the buffer and pushes
    it again at the newer version; the entries before the reject have already rebased it. Rejects of the pushes
    chained behind it are stale and are ignored.
  - **bound:** the editor applies `c.map(pre, true)`, and the buffer becomes `pre.map(c)`.
  - **durable{version}:** the mirror keeps that version's text as the restart and resync base. The worker sends this
    when everything up to `version` is committed.
  - **reloaded:** see §d.2.
- **Liveness.** A push lands only if no foreign entry arrives within its round trip. When foreign entries arrive
  faster than 1/RTT, the client keeps rebasing and re-pushing: nothing is lost, only delayed. The seeded fuzz
  (host/bindingFuzz.test.ts: split views, remote edits, delays up to 300 ms) converges with about 93 % of pushes
  rejected.
- **No double apply.**
  - Editors apply only foreign entries; their own entries are confirmations.
  - The worker applies each push at most once (seq plus the fit rule).
  - Remote changes never go back to the worker, and bind and reload merges run only in the worker.
- **Undo** is CodeMirror's own history (Obsidian's `editor:undo`).
  - Local transactions are recorded. Remote dispatches carry `addToHistory = false`, which the history maps instead
    of recording (obsidian.asar 1.14.4 app.js@1889598; Obsidian's bundled @codemirror/collab `receiveUpdates`,
    app.js@2759543, does the same).
  - An undo is a local transaction and is pushed like typing.
  - Remote cursors stay null (§m.2).
- **Backpressure.** Body events go out within a per-doc credit window (`docUpdateWindowBytes`; weight = event size).
  Main returns `docCredit{bytes}` after applying an event. If a doc's queue exceeds 4× the window, the worker drops
  it and sends `docRetarget{resync}`, and the views re-bind.
- **Main-thread cost on a 1 MB note** (e2e/client/mainThreadBench.ts):
  - **Per keystroke:** one compose, one `toJSON` of the changed ranges, one post. About 11 µs, flat in note size and
    history. Before: 22–90 µs, growing with the Yjs item count.
  - **Per remote update:** `fromJSON`, a `Text` replace, a map over unconfirmed changes, one dispatch. About 7 µs.
    Before: 73–400 µs, because y-codemirror's observer reads `event.delta`, which walks every item (yjs
    src/types/YText.js:655-721).
- **Unbound docs → disk.** A remote change marks the doc `bodyVersion`-dirty. The planner (§f.2) emits
  `reconcileContent`, which writes the CRDT text with a CAS precondition (§f, preconditions hashed by the engine).
  Disk changes flow back the same way. Echo suppression is in §f.4.

### d.4 Batching into outbox frames

- **One frame builder per stream.** It holds raw update buffers: `MAIN` updates from the editor pushes the worker
  applies (`bodyPush` → `applyEditorChanges`, §d.3), and `MERGE` updates from `doc.on("update")` during a merge job.
- **Closing.**
  - **Bound docs:** after `OPEN_FRAME_IDLE_MS` (100 ms) idle or `OPEN_FRAME_MAX_MS` (300 ms) age, or at
    `FRAME_MAX_UPDATES` / `FRAME_MAX_BYTES`.
  - **Merge jobs:** close immediately when the job ends.
  - On `hidden`, `pagehide` or `freeze`: close all builders at once (§i.4).
  - When the daily soft budget is exceeded, the timers stretch up to 10× (§i.6).
- **Building a frame:**
  1. `content = n === 1 ? u[0] : Y.mergeUpdates(u)`. This is O(batch), never O(doc). Large state never goes through
     `mergeUpdates`.
  2. If `content` exceeds `MAX_INLINE_UPDATE_BYTES` after deflate, use `bodyUpdateRef` (§b.6). Sources of such an update:
     a huge paste, or an initial insert with no chunking.
  3. Envelope: `authorNsSeq = ns.coversSeq` (committed fold), flags `initial` / `fromDisk`, deflate per §b.1. Seal
     with a fresh `clientFrameId` (`RandomPort`).
  4. `T_edit`: put the outbox record (`pending`, or `held` with `dependsOn`) and bump `outboxOrder`.
  5. Hand the record to the sender.
- **Durability window.** From keystroke to `T_edit` commit is ≤ 16 + 300 ms plus IDB commit time.
  - During that window the edit is durable only through Obsidian's save of the bound file.
  - After a crash, startup bind or reconcile finds disk ≠ CRDT and merges the disk text in with base = synced (§f.3).
  - Alternative: one `T_edit` per `bodyPush`. Rejected: about 60 IDB transactions per second while typing.
- **Initial content of a new markdown/canvas doc** (planner `nsCreate` + `reconcileContent`, or the first bind):
  - inserted in `INITIAL_INSERT_CHUNK_CHARS` transactions, one frame each, flag `initial`;
  - every initial frame is `held` with `dependsOn` = the ns create frame, and released when that create folds as
    `applied` / `suffixed`;
  - if it folds as `merged`, the held frames are deleted, and the doc is rebound to the winner (§c.13);
  - if it folds as `duplicate-docid`, which cannot happen with fresh random ids, the frames are deleted and the file
    is re-planned.
  - Alternative: send body frames before the create commits. Rejected: wasted rows, and junk streams for merged
    duplicates during onboarding.
- **Sender.**
  - Picks `pending` records by lane (§i.1), then by `order`.
  - Respects all of: the token bucket (`APPEND_BYTES_PER_SEC`, burst ≤ `limits.burstBytes`), `maxInflightAppendBytes`
    of sent-unreceipted bytes, `session.bufferedBytes()`, and the ns/cfg send window (§c.3).
  - Record state `sent` is persisted lazily and only for diagnostics. After any restart, `pending` and `sent` are both
    "maybe sent" and are resent. Correctness relies only on idempotence (R4).

### d.5 Provisional vs committed

- **Provisionals.** `b:`/`c:` frames from other devices arrive first as `provisional`; the adapter joins
  PROVISIONAL + COMMIT_NOTICE into `committed`.
  - A provisional is applied **only to bound docs**, and only when `settings.provisionalBroadcast` is on. All other
    provisionals are ignored, because the committed event brings the payload.
- **Applying one.**
  1. Gate stages 1–3 (§d.6).
  2. Apply with origin `REMOTE` and forward to main.
  3. `T_adopt` puts an **adoptable** outbox record: a fresh own `clientFrameId`, `adoptOf = {deviceId, clientFrameId,
     receivedAtMs}`, the content re-sealed under the own AAD, flag `adopted`.
  - Frames the builder seals for that stream while an adoptable exists are `held` with `dependsOn` = the newest
    adoptable, so own edits built on provisional structs never reach the log before those structs do.
- **Settling an adoptable:**
  - **commit observed** (`committed` with matching `(deviceId, clientFrameId)`, live or in a read page): store the
    row in `tail`, delete the adoptable without re-applying, and release its dependents (same transaction);
  - **`provisionalDropped`, or `PROVISIONAL_ADOPT_MS` (60 s) passes without a commit:** the adoptable becomes
    `pending`, is re-appended, and its receipt settles it like an own frame.
  - A duplicate (the original also commits later) is harmless (CRDT).
- **`resendUnreceipted`:**
  - The adapter has discarded un-noticed provisionals.
  - Adoptables keep their timers, because the author resends its own frames after the same STREAM_RESEND.
  - Every own `pending` / `sent` record is resent in `order`, body frames immediately. For ns/cfg, the late-receipt
    pass runs first (§d.7).
- **Older-seq notices (R7).** A `committed` or receipt with `seq ≤ streams[stream].appliedSeq` is a **settle**: delete
  the matching outbox or adoptable record and put the tail row idempotently. Nothing advances.
- **Never.** Provisionals are never stored in `tail`, never advance a cursor, and never feed a checkpoint.

### d.6 Ingest gate

Everything that changes a replica or the fold passes through one function, `gate(stream, row | checkpoint |
provisional)`: live commits, read rows, checkpoints, provisionals and resolved refs.

1. **Verify the envelope.**
   - Parse the header.
   - `CryptoPort.open` with the binding AAD.
   - Decode the inner envelope.
   - Check the kind against `ALLOWED_KINDS[class]`, and the checkpoint coversSeq binding.
2. **Decode and bound** (no doc needed).
   - **ns / cfg / snap:** the full op decode (§b.3, §b.4). For snap that includes every record bound (§j.4).
   - **body / canvas:** `Y.decodeUpdate` (structural). Then all of:
     - root parent names ⊆ the allowed roots of the class;
     - content types limited to strings, deletes, `ContentType` (`Y.Text`/`Y.Map` per §j.2), `ContentAny` and
       `ContentDeleted`, with no subdocs, embeds, formats or binary;
     - total inserted UTF-16 units ≤ `MAX_DOC_TEXT_CHARS`;
     - content ≤ `MAX_FRAME_CONTENT_BYTES`.
   - **`bodyUpdateRef`:** fetch from `BlobPort` (or read the `x:` stream), check the sha256, open the bytes, then gate
     stage 2 on them.
     - If they are unavailable yet, the ref row is stored and retried with backoff, and the doc shows
       `wait/blob-unavailable`.
     - Once resolved, the tail row is rewritten as `bodyUpdate` (a local cache only).
   - Cold docs stop here: the row is stored in `tail` (§e.2 `T_ingest`), and nothing is loaded.
3. **Check** (resident docs, at apply time):
   - **Causal hole:** after apply, `doc.store.pendingStructs` or `pendingDs` is non-null while the stream is caught up.
     Re-read the stream up to 3 times over ≥ 3 min (≥ 2 × `PROVISIONAL_ADOPT_MS`, because the missing structs may be
     an adoption in flight), then freeze `causal-hole`.
   - **Size:** a post-apply text length > `MAX_DOC_TEXT_CHARS` freezes the doc as `oversize-remote`. This is not
     quarantine: the row is valid and stays in tail. The doc just stops projecting.
   - **Canvas:** the projection validates the JSON canvas (§j.2). Invalid → freeze `canvas-invalid`.
4. **Apply or quarantine.**
   - Apply: `Y.applyUpdate(doc, update, REMOTE)`, or fold the ns/cfg/snap frame.
   - Quarantine: put a `quarantine` record and set `streams.frozen = 1` for the doc.

**Failures by stream class:**

| Failure | ns / cfg / snap | body / canvas / x |
|---|---|---|
| Deterministic malformation (bytes, decode) | Fold as empty frame (§c.3); diagnostics event | Quarantine, freeze doc |
| Reader-dependent (unknown version, suite or key; auth failure) | **Halt** the fold at the row (`upgrade-required` / `key-missing`); rows wait in `tail` | Quarantine, freeze doc (retried on upgrade or new keys) |
| Kind not allowed | Fold as empty | Quarantine, freeze |

- **The cursor always advances.** Quarantined, stored-cold, stale-recorded and halted rows are all *accounted*.
- **Frozen docs:**
  - no projection writes and no frames from disk;
  - a bound view goes read-only with a banner;
  - the disk file is left alone, so its bytes stay recoverable.
- **`releaseQuarantine{stream}`** re-runs the gate on the quarantined rows. Rows that pass are applied. The rest are
  marked dismissed and stay in the store for diagnostics. The doc is unfrozen, and from then on disk edits merge
  normally.
- **Own poisoned frames.**
  - After a close 1008 (malformed APPEND) or 1009 (oversize), the sender **probes**: it resends unreceipted frames one
    at a time. A frame that triggers the close again becomes `poisoned` and is never resent.
  - Its doc is rebuilt without it: `saveViews` first if bound, then `docRetarget{frozen, "rebuilding"}`, reload
    without the poisoned record, then `reconcileContent` from disk (which holds the edit). The doc then re-binds via
    `bindable`.

### d.7 Catch-up and the cursor

**State.**
- `meta.cursor.vaultSeq` (V): every commit ≤ V is accounted. One of: ingested, receipted, stored-cold,
  stale-recorded, quarantined, or own-in-outbox.
- Per stream: `appliedSeq` (watermark: every committed row of the stream ≤ it is in snapshot/tail), `remoteHeadSeq`,
  and `stale`.

**Session start.** `VAULT_READY` gives `head H` and `vaultEpoch`.

1. **Epoch.** `vaultEpoch ≠ identity.vaultEpoch` → §c.12.
2. **Live queue.** Attach the event listener at once. The adapter buffers until then (port contract), so every seq > H
   is captured.
   - Live events go to an in-memory **live queue**.
   - Rows for resident or bound docs are processed at lane priority. The rest are processed after gate stages 1–2.
   - **Overflow** (> 4 MiB or > 1000 queued rows): drop payloads of rows for non-resident docs. Record those streams
     as stale with `remoteHeadSeq = max(…, seq)`. The seq counts as accounted, and the rows are read later.
3. **Feed.** If V < H: run `feed(V)` pages. Each page runs `T_feed_page`:
   - for each `{stream, lastSeq}`: set `remoteHeadSeq` to the max, `stale = appliedSeq < remoteHeadSeq`, and the
     priority (§j.6);
   - unknown stream classes are skipped;
   - set V to `throughSeq`.
   - V reaches H after about `streams / 1000` pages, with no row reads.
4. **Reads.** Catch-up jobs take stale streams by `byStalePriority`, up to `catchUpConcurrency` at once. Open notes
   run in lane 1 and ns/cfg/snap in lane 2, first (in that order).
   - Each job calls `read(stream, appliedSeq, preferCheckpoint = appliedSeq === 0)` and gates each page.
   - **`T_read_page`:** put tail rows. An own row (`deviceId` = self) whose `clientFrameId` is in the outbox is a
     **late receipt**, handled exactly like `T_receipt`. An own row without an outbox record is a plain row.
   - **Checkpoint** `coversSeq > snapshotCoversSeq`:
     - fresh stream: store it as the snapshot after the gate (for ns, V1 + V2);
     - otherwise: **union job**: scratch doc = local snapshot + every local tail row ≤ coversSeq + the checkpoint →
       `T_snapshot`. For ns: verify, then replace the fold state, and own pending ops re-overlay (§f.1).
   - **Caught up:** when a read completes (`more = false`) in the current session, every row of the stream ≤
     `max(H, lastSeq)` is known, because the read started after `VAULT_READY` and everything ≤ H was committed then.
     Every row > H arrives live (R2). So `appliedSeq := remoteHeadSeq` and `stale := 0`.
   - Reads may lag live delivery (relay-wire §12): the group-commit buffer is not flushed. This is harmless, because
     tail puts are idempotent and rows above the read arrive live.
5. **Live rows for a stale stream:**
   - **body/canvas:** stored, and applied at once if resident. Yjs is order-independent, so latency stays low while
     catching up.
   - **ns/cfg/snap:** stored and **not folded** until the stream is caught up. After that, rows arrive live in order (R2)
     and fold immediately.

**Cursor advance.**
- V advances while V+1 is accounted. Accounted seqs above V are tracked in memory.
- V is persisted only inside the transaction that accounts the seq (`T_ingest`, `T_receipt`, `T_feed_page`,
  `T_stale`).
- **Gap:** V+1 is unaccounted for > 5 s while higher seqs are, or a `head` hint is above V. Run `feed(V)`. The page
  marks the affected streams stale.
- **`committed` with `payload: null`:** stale, read.

**Reconnect order:**
1. feed;
2. ns, cfg and snap reads (their late receipts remove outbox records);
3. resend the remaining ns/cfg frames under the send window, then snap frames;
4. body frames are resent right after `VAULT_READY`, because CRDT idempotence makes duplicates harmless.

The planner does no destructive work until ns is caught up (§f.2).

### d.8 Local compaction

- **Trigger:** `tailRows > LOCAL_COMPACT_ROWS` or `tailBytes > LOCAL_COMPACT_BYTES`, run in lane 4 when idle. At
  `tailRows > TAIL_HARD_ROWS` it runs in lane 1.
- **Preconditions:**
  - the stream is not stale;
  - no own outbox record of the stream is `pending`, `sent` or `held`. A late receipt could otherwise land at a seq ≤
    the new snapshot. It would still be loaded, since load applies all tail rows, but the snapshot would no longer be
    exact.
- **Job:**
  1. `C = appliedSeq`.
  2. Scratch `Y.Doc({gc: true})`: apply the snapshot, then every tail row with seq ≤ C (including any below the old
     coversSeq).
  3. `bytes = Y.encodeStateAsUpdate(scratch)`.
  4. `T_compact`: CAS on `snapshotCoversSeq` unchanged; put the snapshot `{coversSeq: C}`; delete exactly the loaded
     tail keys; update the counters.
  - ns, cfg and snap compact the same way. Their "replay" is the fold, and their snapshot is the `nsFoldV1` /
    `cfgFoldV1` / `snapFoldV1` bytes at `coversSeq`.
- **The resident replica is not touched.** Compaction never runs `Y.mergeUpdates` over stored arrays.
- **Cost:** O(doc) per ≥ 200 rows or 256 KiB of tail.
- Alternative: compaction by `Y.mergeUpdates(snapshot, ...tail)`. Rejected: memory spikes and no GC (a fixed
  decision).

### d.9 Remote checkpoints (CAS)

- **Body/canvas duty.**
  - Primary: the author of the stream's newest row (`meta.ckptDuty`), when `rowsSinceRemoteCheckpoint ≥
    REMOTE_CHECKPOINT_ROWS` or `bytesSinceRemoteCheckpoint ≥ REMOTE_CHECKPOINT_BYTES`, and the stream has been idle
    for `REMOTE_CHECKPOINT_IDLE_MS`.
  - Fallback: any device, when the condition has held for 10 min, plus jitter.
- **Preconditions:** the local compaction preconditions, plus a fresh local compaction so that `snapshotCoversSeq =
  appliedSeq = C`, and a sealed size ≤ `limits.maxCheckpointBytes`.
- **Write.** `putCheckpoint(stream, C, remoteCheckpointCoversSeq, sealed)` (checkpoint AAD, §b.1).

| Result | Action |
|---|---|
| `ok` | `remoteCheckpointCoversSeq = C`; reset counters |
| `conflict{current}` | Record `current`. Retry later only if `current < C`. ns: run the V3 check on `current` |
| `refused not-advancing` | Refresh with `read(stream, C, false)` |
| `refused ahead-of-stream` | Bug: diagnostics, skip |
| `refused stream-not-found` | Skip |
| `refused too-large` | Mark the stream `no-checkpoint` until its snapshot shrinks by 25 % |
| `refused daily-limit` | Hold all checkpoints until `retryAfterMs` |
| `refused forbidden` | Treat as `canWrite = false` |

- **ns.**
  - Only candidate seqs (§b.5). The device keeps the `nsFoldV1` bytes of its newest candidate in memory.
  - Duty: the author of the candidate row, when ≥ `NS_CHECKPOINT_ROWS` ns rows or ≥ `NS_CHECKPOINT_BYTES` have
    accumulated since the last checkpoint. Others take over after 10 min.
  - cfg and snap use the same candidate rule.
- **`retired`.**
  - For streams of docIds in a fold `pruned` event, or merged aliases that have rows.
  - Duty: the device whose frame caused the prune or merge. Fallback: 10 min.
  - `coversSeq` = the stream's `lastSeq` from `read(stream, 0, false)`.
  - After `ok`, the local stream records are deleted.
- **Budget.** Checkpoints are at most 1 per 512 rows of a stream (1 per 1000 for ns), so they are a small fraction of
  daily rows written.

---

## e. IndexedDB schema and transactions

One database per `(vaultId, vaultEpoch, deviceId)`: `dbName()` gives `yaos2:<vaultId>:<vaultEpoch>:<deviceId>`.

IDB is a **rebuildable cache**: everything can be rebuilt from relay + disk + side files (§i.5). The engine opens it
through `StoragePort`. The same semantics hold for the in-memory simulation implementation, including "a crash keeps
exactly the committed transactions". Types are in `src/engine/store/schema.ts`.

### e.1 Stores

| Store | Key path | Indexes | Value | Bound |
|---|---|---|---|---|
| `meta` | `key` | — | `identity`, `cursor`, `outboxOrder`, `daily`, `ckptDuty` | 5 records |
| `streams` | `stream` | `byStalePriority [stale, priority]`, `byAccess lastAccessMs` | `StreamRecord` | 1 per live doc / retained tombstone with rows, + ns, cfg, snap, active `x:`; deleted after `retired` |
| `snapshots` | `stream` | — | `SnapshotRecord` (EXACT: committed rows ≤ coversSeq) | 1 per stream; ≤ about 3 × doc text |
| `tail` | `[stream, seq]` | — | `TailRecord` (opened inner content) | Compaction keeps ≤ 200 rows / 256 KiB typical, hard 2000 rows per stream |
| `outbox` | `clientFrameId` | `byOrder order` (unique), `byStreamOrder [stream, order]` (unique), `byStateOrder [state, order]` (unique) | `OutboxRecord` | Soft `OUTBOX_SOFT_BYTES` (16 MiB): builders stretch, notice. **Never dropped** |
| `quarantine` | `[stream, seq]` | `byAt atMs` | `QuarantineRecord` (bytes ≤ 256 KiB + hash) | `QUARANTINE_MAX_RECORDS` / `_BYTES`; oldest evicted (the doc stays frozen) |
| `synced` | `docId` | `byPathKey pathKey` (non-unique: transient during rebind) | `SyncedRecord` | 1 per synced doc |
| `baseText` | `docId` | — | `BaseTextRecord` (deflated, ≤ `MAX_BASE_TEXT_CHARS`) | markdown/canvas synced docs |
| `localTree` | `pathKey` | — | `LocalTreeRecord` | 1 per vault file |
| `intents` | `id` | — | `IntentRecord` | In-flight multi-step disk ops (< 1000); deleted on completion |
| `cfgBase` | `file` | — | `CfgBaseRecord` | Allowlisted config files |
| `blobQueue` | `hash` | `byActiveDue [active, nextAttemptAtMs]` | `BlobQueueRecord` | 1 per pending transfer |

- **`dependsOn` rule.** A `held` record waits for one of three things:
  - the doc's ns create (released when it folds);
  - the newest adoptable of the stream (released when that record is gone);
  - the last `x:` chunk of a `bodyUpdateRef` (released when no own `x:` frame of that stream remains).
  - Releasing a record means `held → pending` in the same transaction that removes the dependency.
- **IDB booleans.** `stale`, `frozen` and `active` are `0 | 1` because IDB cannot index booleans.

### e.2 Transactions

Rules:
- A transaction awaits only its own requests (`StorageTx` contract).
- Rows are gated **before** the transaction. CPU work is never done inside one.
- The cursor advances only in the transaction that makes the seq accounted.
- Replicas are updated optimistically right after the gate. A crash before commit loses only memory: the seq stays
  unaccounted, so it is fetched again, and union is idempotent.

| Tx | Stores | Writes | Crash reasoning |
|---|---|---|---|
| `T_edit` (frame close) | outbox, meta, streams | Outbox record (`pending` / `held`); `outboxOrder.next++`; `bodyVersion.localOrder`, `lastAccessMs` | **Commits before `append`.** Before commit: the edit is on disk via the editor save (§d.4). After commit: resent at startup. |
| `T_sent` (lazy, coalesced) | outbox | `state: sent`, `attempts`, `lastSentAtMs` | Diagnostics only: `pending` / `sent` are both "maybe sent". |
| `T_receipt` (one per `STREAM_RECEIPTS` batch) | outbox, tail, streams, meta | Per receipt: tail put `(stream, seq)` with outbox content; outbox delete; release dependents; `lastOwnSeq`, `remoteHeadSeq`, `appliedSeq` (if not stale), checkpoint counters, `ckptDuty`; cursor | A missing outbox record is a no-op (idempotent). Before commit: re-delivered as a late receipt via read, or resent and then deduped (relay window, fold ring, or CRDT). |
| `T_ingest` (batch ≤ 64 rows / 1 MiB per slice) | tail, quarantine, streams, outbox, meta | Tail or quarantine puts; adoptable deletes and releases; `remoteHeadSeq`, `appliedSeq`, `bodyVersion.remoteSeq`, counters; cursor | Before commit: the rows are unaccounted and re-fetched. Replica already applied: idempotent. |
| `T_stale` | streams, meta | `remoteHeadSeq`, `stale = 1`; cursor | Overflow or null payload: the row is read later. |
| `T_feed_page` | streams, meta | Stream heads, stale, priority; cursor = `throughSeq` | Before commit: the page is re-fetched. |
| `T_read_page` | tail, quarantine, outbox, streams, snapshots | Rows; late receipts; fresh-stream checkpoint snapshot + exact-key deletes of tail ≤ coversSeq; `appliedSeq` / `stale` when complete | Idempotent puts. The page is re-read from `appliedSeq`. |
| `T_snapshot` (checkpoint union) / `T_compact` | snapshots, tail, streams | CAS on `snapshotCoversSeq`; snapshot put; exact-key tail deletes | Old snapshot + tail and new snapshot + less tail reconstruct the same state. |
| `T_adopt` | outbox, meta | Adoptable record | Before commit: the provisional was applied to the bound replica only. The edit reaches disk through the editor and is re-merged. The commit or the author's resend brings it anyway. |
| `T_intent_begin` / `T_intent_end` | intents | Put / delete the intent | §f.7: startup completes or rolls back each intent from disk state. |
| `T_synced` (after a disk-op batch) | synced, baseText, localTree, intents | Synced put/drop, base put, stat cache, intent end | Before commit: the next reconcile sees L = R ≠ S, which is the "identical" path. Only S advances. |
| `T_cfg` | cfgBase, streams, meta | Settings sync base after projection | As `T_synced`. |

- **Compaction and remote checkpoint gate.** They require "no own unreceipted frames of the stream". This is the only
  coupling between outbox and snapshots.
- **ns fold persistence.** The fold state lives in memory. On disk it is the ns `snapshot` (`nsFoldV1`) plus ns
  `tail` rows. Load = decode, then fold the tail. Halted rows stay in tail.

### e.3 Bounds and eviction summary

- Tail is bounded by compaction (§d.8). If compaction is blocked by unreceipted frames for long (offline), the tail
  stays bounded by what this device received.
- Quarantine is bounded with oldest-first eviction.
- The outbox is never evicted; it is bounded only by user activity while offline, and the soft limit triggers a notice
  plus frame stretching.
- `streams` / `snapshots` / `tail` of pruned docs are deleted after their `retired` checkpoint, or locally after the
  prune if this device has no duty.
- **Quota error:**
  1. evict `quarantine` bytes;
  2. compact everything eligible;
  3. drop snapshots/tail of cold docs whose disk file equals `synced`. They are refetched on demand, because the relay
     has them;
  4. as a last resort, phase `error` + notice. The outbox is untouched.

### e.4 Side files

Side files live in `<configDir>/plugins/yaos/state/` (`SideFilePort`). The host reads them at startup and passes them
in `EngineInitConfig.sideState`. The engine asks for writes with `sideFileWrite`.

**Outbox mirror** (`outbox-a.bin` / `outbox-b.bin`, A/B by generation):

```
8B  magic "YAOSOBX1"
u8  formatVersion (1)
varstring vaultId, varstring vaultEpoch, varstring deviceId
varuint generation, varuint writtenAtMs
varuint frameCount
frameCount × {
  varstring clientFrameId, varstring stream, varuint order,
  u8 state (1 held, 2 pending, 3 sent, 4 poisoned, 5 adoptable),
  varuint authorNsSeq,
  u8 hasDep [varstring dependsOn],
  u8 hasAdopt [varstring deviceId, varstring clientFrameId],
  varbytes sealed
}
32B sha256(all preceding bytes)
```

- **Write:**
  - debounce `OUTBOX_MIRROR_DEBOUNCE_MS` after any outbox put, and `OUTBOX_MIRROR_TRIM_DEBOUNCE_MS` after
    receipts;
  - immediately on `hidden` / `pagehide`;
  - the target is the slot with the lower or invalid generation.
- **Size limit.** Over `OUTBOX_MIRROR_MAX_BYTES`, the mirror keeps all ns/cfg/snap frames first, then body frames by
  `order` until full. Unmirrored body edits are still on disk and are re-derived by reconcile.
- **Why it exists.** It preserves **frame identity** (`clientFrameId`) across IDB loss:
  - a resent ns frame is deduped by the relay window or the fold ring instead of creating duplicate docs;
  - body frames would converge anyway.
- **Reader.** Takes the valid file (magic, checksum, identity match) with the highest generation.

**Synced mirror** (`synced-a.bin` / `synced-b.bin`, debounce `SYNCED_MIRROR_DEBOUNCE_MS`):

```
8B magic "YAOSSYN1", u8 version, varstring vaultId, varstring vaultEpoch, varstring deviceId,
varuint generation, varuint writtenAtMs, varuint nsCoversSeq, varuint count,
count × { varstring docId, varstring path, u8 kindCode, 32B contentHash, varuint nsTouchSeq, varuint bodyRemoteSeq, varuint blobRev },
32B sha256
```

- Lets recovery tell "unchanged since sync" (hash equal) from "edited offline", so an IDB loss does not produce
  conflict copies.
- Base texts are not mirrored. Recovered docs merge without a base only when both sides changed.

**Snapshots** (`snapshots/`): each snapshot's parts and its descriptor, plus the download cache for one remote
snapshot (§j.4). A snapshot exists iff its descriptor decodes; parts without one are swept.

---

## f. Three trees, planner, merge

Sync is a pure function of three trees, recomputed for a scope. Events only choose the scope.

- **Remote (R):** what the log says.
- **Local (L):** what the disk says.
- **Synced (S):** the last state known equal on both, i.e. the merge base.

### f.1 Entry shapes

All are in `src/core/types.ts`.

- **`RemoteEntry`** = **OptimisticRemote**(committed `NsFoldState` + own pending ns frames) joined with
  `RemoteBodyInfo`.
  - The overlay re-folds own `pending` / `sent` / `held` ns frames, in outbox order, on a copy-on-write view of the
    committed state, with pseudo-seqs above `coversSeq`.
  - Entries touched by the overlay have `pendingLocal = true`. The planner never moves, deletes or replaces local
    files for them, so local state stays pinned until the fold confirms or rejects.
  - The overlay is a prediction. Only the committed fold decides (§c.13).
  - `body` comes from `streams`: `version = bodyVersion`; `caughtUp = !stale && no causal hole`; `hasContent`;
    `frozen`.
- **`LocalEntry`**: a git-index-style stat cache (`localTree` store) with hash confirmation.
  - `hash = null` means the stat changed since the last hash.
  - **Racy-clean rule:** an entry whose `mtimeMs ≥ hashedAtMs − RACY_WINDOW_MS` is re-hashed on the next pass even
    if the stat is equal.
  - `bound = true` while an editor owns the file.
- **`SyncedEntry`**: per docId, holding `path`, `contentHash` (logical), `fingerprint` (exact bytes), stat,
  `bodyVersion` / `blobRev` / `nsTouchSeq` at the sync point, and `hasBase` (`baseText` stored).
- **Hashes.**
  - `ContentHash` is the logical hash: markdown-lf-v1 canonical bytes for markdown, canonical JSON for canvas, raw
    bytes for blobs.
  - `DiskFingerprint` is the exact-bytes hash, used only for echo suppression and CAS.

### f.2 Planner

`PlanFn(PlannerInput) → Plan` is pure (WP-B, `src/core/plan/planner.ts`).

- **Scope:** `docs` (hint-driven: the docIds and pathKeys touched) or `full` (periodic every
  `fullReconcileIntervalMs`, on resume, after catch-up and after recovery).
- **Gates:**
  - no ns ops until ns has been caught up once in this session, and none while ns is halted;
  - destructive local decisions (local delete, rename inference) need `localComplete`;
  - content decisions need `body.caughtUp`.
- **Join.** By docId for R ⋈ S. L is looked up by `pathKey` (S.pathKey for synced docs, R.pathKey otherwise).
  Leftover L entries are new local files, after rename inference (§f.6).
- **Notation.** `Lc` = L hash ≠ S.contentHash. `Rc` = R.body.version ≠ S.bodyVersion (markdown/canvas) or
  R.blob.rev ≠ S.blobRev (blob). `Rm` = R.path ≠ S.path.

| R | S | L at key | Ops |
|---|---|---|---|
| live | present | present | 1. If `Rm` and not `pendingLocal`: `diskRename(S.path → R.path, expect hash)` (remote move; plain rename; case-only via temp on case-insensitive FS; folder-casing-only differences tolerated there). 2. Content: neither changed → `syncedPut` if the stat moved; `Rc` only → `reconcileContent` (crdt-only write) / blob `fetchBlob`; `Lc` only → `reconcileContent` (disk-only, frames) / blob `pushBlob` + `nsSetBlob(baseRev = R.blob.rev)`; both → `reconcileContent` (3-way) / blob keep-both (`conflictCopy`, `fetchBlob`, `nsCreate` for the copy). |
| live | present | absent | Inferred or observed rename to a leftover L entry → `nsRename` (+ content step at the new path). Else if `Rc` (remote edited since sync) → `diskMaterialize(R.path, expect absent)` (edit beats delete). Else → `nsDelete(baseBodySeq = streams.appliedSeq)` (brake: mass-delete-local). |
| deleted | present | absent | `syncedDrop`. |
| deleted | present | present, ¬`Lc` | If the doc has own pending body frames and the restore condition holds → `nsRestore`. Else → `diskTrash(S.path, expect hash = S.contentHash)` + `syncedDrop` (brake: mass-delete-remote). |
| deleted | present | present, `Lc` | Local edit beats remote delete: `nsRestore(path = S.path, againstDeleteSeq = R.deletedSeq)` + `reconcileContent`. |
| merged → W | present | any | `rebind(S.docId → W)`, then plan as W. |
| absent (pruned) | present | ¬`Lc` / absent | `diskTrash` (braked) + `syncedDrop` / `syncedDrop`. |
| absent (pruned) | present | `Lc` | `nsCreate` (fresh docId) + `reconcileContent`; `syncedDrop(old)`. |
| live | absent | absent | `diskMaterialize(R.path, expect absent)` once `body.caughtUp && (hasContent ∨ createSize = 0)`, else `wait(body-empty / body-not-caught-up)`. Blob: `fetchBlob`. |
| live | absent | present | L hash = remote hash (`streams.textHash` / `blob.hash` / `createHash` at initial version) → `syncedPut` (adopt, no I/O). Else `reconcileContent(hasBase: false)`, which gives a no-base conflict copy unless identical. Path-keyed bases from recovery or epoch migration supply a base when present. |
| absent | absent | present | Portable and not excluded → `nsCreate(freshDocId, path, hash, size)` + initial `reconcileContent` / `pushBlob`. Not portable (§c.2 validity) → notice, skip. |
| frozen body | any | any | `wait(frozen)`. No disk write and no frames from disk. |

- **Precondition ops** (`nsDelete`, `nsRestore`, `nsSetBlob`) are emitted only if the doc has no pending own ns op
  (§c.13). Otherwise the result is `wait(pending-ns)`.
- **Plan order:**
  1. ns ops, in dependency order, split into frames;
  2. `diskRename`, topologically sorted, with cycles broken through temp names;
  3. `removeEmptyFolder`;
  4. `diskMaterialize` and writes;
  5. `conflictCopy` before the overwrite it protects;
  6. `diskTrash`;
  7. content ops;
  8. bookkeeping.
- **Disk ops** become `DiskOp`s with `WritePrecondition`s (`expect hash` → `{t: "hash"}`; for fresh writes, `{t:
  "fingerprint"}` with the fingerprint read by the job). They are sent in `diskOps` batches of ≤ `diskOpsPerBatch`,
  tagged with the lane.
- **Failed precondition:** that doc is re-planned in the next scoped pass. Nothing is retried blindly.
- **Bound docs.** `reconcileContent` merges into the worker replica (origin `MERGE` → body `entry` → editor), and
  Obsidian's save writes the disk. The projection never writes a bound file (§d.2).
- **Precondition checks run without hashing on main** (host/obsidianVault.ts header, host/hashOracle.ts).
  - Obsidian has no compare-and-swap. For a `fingerprint` / `hash` precondition over an existing file, the host
    reads the raw bytes at t0 (`adapter.readBinary`) and transfers them in `hashRequest`. The engine answers the
    hash and the UTF-16 length of the decoded text (BOM kept) at t1. The host writes at t2.
    `absent` goes through `vault.create`, which throws if the file exists, so it is atomic.
  - **Caught:**
    - Any change visible in `TFile.stat` (size or mtime differs from the snapshot taken before the t0 read): the
      host rechecks it right before the write, with no `await` in between.
    - For text, any change of the UTF-16 length up to the write. `vault.process` reads the file inside Obsidian's
      adapter queue, and the host's callback throws (nothing is written) unless `cur.length` equals the engine's
      `textLength` (obsidian.asar 1.14.4: desktop `adapter.process` app.js@552301; `Vault.process`
      app.js@1426847; Capacitor app.js@1350128).
  - **Missed (accepted gap):** a same-length text change, or any binary change, that is not yet in `TFile.stat` at
    the recheck. That covers a change the watcher has not delivered yet, one that kept size and mtime, and one that
    lands between the recheck and the `process` read or `modifyBinary`.
    - Base 6f7129b closed the text part of this gap by decoding and comparing the full text inside `process`, at
      O(N) main-thread cost (obsidianVault.ts:108-109, 157, 173 at base). §d.2 forbids that.
    - The engine fingerprints what it asked to write (`WriteOutcome` carries no fingerprint) and re-reads the
      disk on the next modify event. A change lost this way is the narrow race of any non-atomic writer, never a
      silent loop.
  - **Spurious failures** are in the safe direction: if Obsidian's decode ever disagreed with the engine's WHATWG
    UTF-8 decode on invalid bytes, the length guard fails and the op is re-planned.
  - Config writes (`diskExecutor.writeConfig`) read the bytes and hash them through the same oracle.

### f.3 The merge engine (one)

**Decision: M2 = diff3 over texts + minimal `Y.Text` diff applied with a CAS.** `MergeFn` lives in
`src/core/merge/merge.ts`. It is pure and bounded by `MergeLimits`.

- **Justification.** M1 (branch a `Y.Doc` at the sync point, apply the disk diff to the branch, merge the branches)
  needs Yjs history at the sync point. `gc: true` destroys it. Keeping `gc: false` grows docs without bound, and IDB
  loss loses the branch point anyway. M2 needs only the base text (`baseText`, deflated), the disk text and the CRDT
  text. It behaves the same on main (bind and external reload) and in the worker.
  - Alternative: M1 with gc-off snapshots. Rejected for the reasons above.
- **Algorithm:**
  1. `disk === crdt` → `identical`.
  2. `base === null` → `conflict(no-base)`: the CRDT keeps its text, and the full disk text goes to a conflict copy.
  3. `crdt === base` → `disk-only`. `disk === base` → `crdt-only`.
  4. If either input > `maxInputChars` → `conflict(too-large)`.
  5. Otherwise run a line-level diff3: Myers diff of base→disk and base→crdt, each capped at `maxEditsPerSide`, with
     a common prefix/suffix trim first.
     - Non-overlapping hunks, and identical changes on both sides, merge cleanly → `clean`.
     - Overlapping, differing hunks → `conflict(both-edited)`: `text` = CRDT text plus the disk hunks that do not
       overlap, and `conflictCopy` = the full disk text.
     - Exceeding the edit cap → `too-large`.
- **Canvas** uses the same `MergeFn` over canonical canvas text: one node or edge record per line, with stable key
  order (§j.2). The merged text must parse and validate, else `conflict(both-edited)`.
- **Applying to the CRDT** (worker job, or main for bound reloads):
  1. Read `crdt0 = ytext.toString()`.
  2. Merge.
  3. Within one synchronous section: **CAS** `ytext.toString() === crdt0`, compute the minimal diff `crdt0 → text`
     (prefix/suffix trim, then a bounded char-level Myers, falling back to line granularity), and apply it as
     `delete` / `insert` ops in one transaction (origin `MERGE`).
  - On a CAS miss (a remote update arrived during an async gap), re-run up to 3 times, then re-plan.
  - `Y.Text` is **never** wholesale-replaced. Canvas applies record-level changes (§j.2).
- **Order** in a merge job (the invariant I1 ordering):
  1. read disk (text D, fingerprint F);
  2. `MergeFn(B, D, C) → M`;
  3. apply M to the CRDT, and `T_edit` the frames;
  4. if conflict: `T_intent_begin(conflict-copy)`, then write the copy (precondition `absent`);
  5. write M to the path (precondition `fingerprint F`);
  6. `T_synced` (base = M, hashes, bodyVersion) + `T_intent_end`.
  - If step 5's precondition fails, the user edited again. S stays at B, the next round merges (B, D′, M), and diff3
    treats the already-applied identical hunks as non-conflicting.
- **Bounded time.** Inputs above the caps never run diff (`too-large`). Merge jobs run in lane 3 (or 0/1 for open
  docs) and yield between docs.

### f.4 Echo suppression

- For every completed host write, rename or trash (`DiskOpResult` with the stat; the engine fingerprints the bytes
  it asked to write), record `echo[pathKey] =
  {kind, size, mtimeMs, fingerprint, expiresAt: now + ECHO_TTL_MS}`. Writes also update `localTree` directly with the
  known hash.
- A matching `VaultEvent` is dropped: modify/create with equal size + mtime, or the exact expected rename or delete.
  Each echo entry is consumed once.
- A non-matching event marks the path dirty (`hash = null`), and the scoped plan re-hashes.
- Echo suppression only drops hints. The full reconcile re-checks stats, with racy-clean re-hashing, so a wrongly
  dropped event costs latency, never correctness.
- Saves of bound files are found by the worker's `checkSaved` on the modify event (§d.2) and become `boundSaved`;
  that event otherwise only refreshes the stat cache.

### f.5 Safety brake

`BrakeConfig` defaults come from `limits.ts` (`BRAKE_*`). The brake evaluates every `Plan` before execution:

| Reason | Counts | Holds when |
|---|---|---|
| `listing-shrank` | Live L entries vs synced docs | `|L| < BRAKE_LISTING_FLOOR_RATIO × |S|` (vault not mounted, sync folder moved): **every** destructive op |
| `mass-delete-local` | `nsDelete` | `> max(BRAKE_MIN_COUNT, BRAKE_RATIO × |S|)` |
| `mass-delete-remote` | `diskTrash` | same |
| `mass-overwrite` | Writes over a file ≥ `BRAKE_OVERWRITE_MIN_BYTES` leaving < `BRAKE_OVERWRITE_SHRINK_RATIO` of its size | same |
| `conflict-flood` | `conflictCopy` | `> BRAKE_MAX_CONFLICT_COPIES` |
| `ns-divergence` | All destructive ops | V3 mismatch (§b.5) |

- **Held ops** go to `Plan.held`. The rest of the plan runs.
- **Report.** `BrakeReport.id = sha256(sorted canonical held ops)`, and the engine posts a `brake` event.
- **Approval.** `approveBrake{id}` sets `brakeApproval`. The next plan releases the held set only if it recomputes to
  the same id. A recovery snapshot of the affected files is taken first (§j.4). `rejectBrake` converts held remote
  deletes into nothing (the files stay; `syncedDrop`) and held local deletes into re-creates.
- Counting is per plan **and** per rolling 10-minute window, so slow drips also trip it.

### f.6 Startup scan and rename inference

- **Scan.**
  - The host sends `observations` (the full `list()`) in chunks, flow-controlled by `rid`.
  - The engine diffs them against `localTree`. Entries whose stat is unchanged and not racy keep their hash.
  - Others need a hash: they are batched into `readRequest`s within `maxDiskIoBytesInFlight`, then hashed in the
    engine (`HashPort`; markdown is canonicalized first).
  - `localComplete = true` after the last chunk and its hashes.
  - Excluded and non-portable files are kept with `excluded = true`, so they are never planned.
- **Rename inference** runs only when `localComplete`, and **by hash only**:
  - *Missing* = synced docs whose `S.pathKey` has no L entry. *New* = L entries with no R or S match.
  - Pair by `(kind, contentHash)`. A unique pair is a rename. Several equal hashes are paired by score (same leaf
    name, then same parent folder), with ties broken by path code-unit order. Unpaired ones become delete + create.
  - Observed `rename` events that the scan verified (the target exists) win over inference, and may carry a content
    change (rename + edit).
  - Folder renames arrive as per-child events, and become one `nsRename` per child, packed into frames.
  - Alternative: similarity-based inference. Rejected: non-deterministic and expensive.

### f.7 Conflict copies and intents

- **Name:** `${stem} (conflict ${label} ${YYYY-MM-DD HHmm})${ext}` in the same folder.
  - `label` = `deviceLabel` with forbidden characters removed, ≤ 32 chars. The time is local, from `ClockPort.now()`.
  - If the name is taken, append ` 2`, ` 3`, … inside the parentheses.
  - If the result is not a valid fold path (§c.2), fall back to `${stem} (conflict ${docId8})${ext}`.
  - Blob keep-both uses the same pattern.
- **Intents.** Multi-step ops (`conflict-copy`, `loser-rename`, `rebind`, `keep-both-blob`, `epoch-migration`) write
  an `IntentRecord` (`subjectHash`, from, to, step) before step 1 and delete it after the last step.
  - At startup each intent is resumed by checking disk. Example: the copy exists with `subjectHash` → continue with
    the overwrite under its precondition. Otherwise restart from step 1.
  - A resumed step never runs a destructive op without its precondition.

### f.8 Planner–fold interaction summary

- Loser renames, merged rebinds, identical-loser collapse and restore duty: §c.13.
- Blob `rev-mismatch` keep-both: §c.8.
- Pruned docs: rows "absent (pruned)" above.

---

## g. Main ↔ worker protocol

Types are in `src/protocol/*.ts`. `PROTOCOL_VERSION = 3` (2: the body protocol of §d.3 replaced Yjs updates on the
binding path, and hashing moved to the engine; 3: `init.crypto`, the key commands and `keyringChanged` of
e2ee-design §18.4).

### g.1 Carriers

- **Worker.** The engine bundle is built as a string by esbuild (WP-D) and embedded in `main.js`. The host starts it
  with `new Worker(URL.createObjectURL(new Blob([src], {type: "text/javascript"})))`.
  - `PlatformInfo.workerSupported` is **probed**: construct the worker, `init`, `ping`, and expect a `pong` within 5 s.
  - IDB is opened inside the worker. If it is unavailable there (risk OR-1), fall back to inline.
- **Inline.** The same engine runs on main through `InlineTransport`: structured clone, FIFO, delivery on a macrotask.
  - Used when the worker cannot start, after `MAX_WORKER_RESTARTS`, and always in Node (simulation and tests).
  - Inline uses `mainSliceMs` for engine slices and one device class lower for budgets.
- **No `SharedArrayBuffer`.** Data crosses only as messages and transferables.

### g.2 Messages

`rid` is a per-sender increasing u32. Each request gets exactly one `result` or `error` with `re = rid`. `[T]` marks
transferred buffers.

**Main → engine:**

| Message | rid | Purpose | Answer |
|---|---|---|---|
| `init{config}` | yes | Identity, device class, settings, relay URL + credential (secret), side files `[T]` | `ready{protocolVersion, vaultEpoch, recovered}` / `error(version-mismatch)` |
| `shutdown{reason}` | yes | Flush builders, `T_edit`, mirror, close relay and IDB | `ok` |
| `lifecycle{event}` | — | visible / hidden / pagehide / freeze / resume / online / offline / memory-pressure (§i.4) | — |
| `ping` | yes | Liveness every 10 s | `pong` (no pong within `PING_TIMEOUT_MS` → restart) |
| `observations{scanId, chunk, complete}` | yes | Listing chunks (≤ 2000 stats) | `ok` (the host sends the next chunk after it) |
| `vaultEvents{events}` | — | Hints, batched ≤ 50 ms / 256 | — |
| `openDoc{path, viewId}` | yes | Bind request | `bind{docId, kind, frozen}` / `notBindable{reason}` |
| `closeDoc{docId, viewId}` | — | Unbind | — |
| `textChunk{uploadId, bytes [T], last}` | — | UTF-16 units of a whole-text upload (editor text, restart base, saved text, reload), ≤ 64 Ki units per chunk, one macrotask each. Bind, re-bind and reload only (§d.2) | — |
| `bodyAttach{docId, viewId, editor, base, saved}` | — | Merge the uploaded editor text into the replica; `base` / `saved` name optional uploads | body `bound` |
| `bodyPush{docId, viewId, seq, base, after, changes}` | — | Editor ChangeSet JSON, coalesced ≤ 16 ms: against version `base`, or chained after this view's push `after`. Never dropped | body `entry` (author set) / `reject` |
| `bodyReload{docId, viewId, reload, text}` | — | Obsidian pushed text into a bound view (`setViewData`): merge upload `text` | body `reloaded` |
| `bodySaveMark{docId, viewId, version, seq}` | — | Obsidian read the view for a save at replica `version` (after push `seq`): a save candidate | — |
| `docCredit{bytes}` | — | Body event flow control (returns the event `weight`) | — |
| `hashRequest{items[{path, want, bytes [T]}]}` | yes | Hash bytes the host read (write preconditions, config writes); ≤ 64 items / 8 MiB per batch | `hashes{values[{hash, textLength}]}` |
| `command{UserCommand}` | yes | pause, resume, reconcileNow, approve/rejectBrake, snapshots, diagnostics, rebuildLocalCache, updateSettings, releaseQuarantine | `ok` / `snapshots` / `diagnostics` |
| `result` / `error` `{re}` | — | Answers to engine requests | — |

**Engine → main:**

| Message | rid | Purpose | Answer |
|---|---|---|---|
| `body{docId, event, weight}` | — | Body event of a bound doc (`entry` / `bound` / `reject` / `durable` / `reloaded`, §d.3), FIFO per doc, within credit | `docCredit{weight}` |
| `docRetarget{docId, change}` | — | renamed / merged / deleted / frozen: the host unbinds and re-opens; `resync`: the host re-binds every view of the doc (§d.2) | — |
| `bindable{path}` | — | A path became bindable | Host `openDoc` |
| `readRequest{reads}` | yes | Disk reads (area vault/config, maxBytes) | `reads{DiskReadResult[] [T]}` |
| `diskOps{lane, ops}` | yes | Ordered ops with preconditions. A failed op does not stop independent later ones; dependents report `skipped` | `diskOps{DiskOpResult[]}` |
| `saveViews{docIds}` | yes | Force Obsidian saves (before hidden, before rebuild) | `viewSaved{saved}` |
| `sideFileWrite{name, bytes [T]}` / `sideFileRead{name}` | yes | Mirrors and snapshots | `sideFileWritten` / `sideFile{bytes [T]}` |
| `status{StatusSnapshot}` | — | Throttled to ≤ 4/s and sent on phase change | — |
| `brake{BrakeReport}` | — | User approval needed | Host shows UI → `command` |
| `notice{level, code, message}` | — | User-facing notice | — |
| `fatal{error}` | — | Engine cannot continue | Host stops, shows error |
| `result` / `error` `{re}` | — | Answers to main requests | — |

### g.3 Ids

- **`rid`** is per sender, starts at 1 and increases. Ids are never reused within one transport instance.
- **`opId`** is unique per engine instance across all `diskOps` batches, and is used in diagnostics and intents.
- **`scanId`** increases per listing.
- **`viewId`** is assigned by the host per editor leaf.
- **`docId`** is the fold docId.

### g.4 Transferables, backpressure, errors

- **Transferables.** Every `[T]` buffer must be exclusively owned (`byteOffset 0`, `byteLength = buffer.byteLength`).
  The sender copies with `slice()` otherwise (Yjs encoders usually return owned buffers), and never touches it after
  `post`.
- **Backpressure:**
  - body events use a credit window per doc (§d.3);
  - `hashRequest` batches are ≤ `MAX_BATCH_ITEMS` (64) items and `MAX_BATCH_BYTES` (8 MiB), with the bytes
    transferred (host/hashOracle.ts);
  - `observations` are chunked and acknowledged;
  - `readRequest` is bounded by `maxDiskIoBytesInFlight`;
  - `diskOps` batches are ≤ `diskOpsPerBatch`, and the host runs lane 0 batches before others, within `mainSliceMs`
    slices;
  - `vaultEvents` and `bodyPush` are small and unbounded by design. Main never drops them.
- **Timeouts.** Engine requests time out after `DISK_REQUEST_TIMEOUT_MS` / `SIDE_FILE_TIMEOUT_MS` → `error(timeout)`.
  The engine re-plans the scope, and nothing is assumed done.
- **Errors.** `ProtocolError{code, message, retryable}`. `message` never contains credentials or file contents.
  `TERMINAL_ERROR_CODES` (`version-mismatch`, `revoked`) stop automatic retries. `content_corrupt` (a snapshot
  failed verification, §j.4) is never retryable.
- **Worker failure** (`onFailure`, or missed pongs):
  - The host terminates the worker and starts a new one.
  - Bound views re-run `openDoc` and re-bind (§d.2): main uploads the editor text, with the mirror's last durable
    text as the merge base. Edits the dead worker never persisted are still in the editor, so the bind merge brings
    them back. A crash loses only conflict copies the worker had not written yet (§d.2).
  - After `MAX_WORKER_RESTARTS` within 10 min, the host switches to inline.

### g.5 Inline fallback

- The protocol, messages and ordering are identical. Only the transport changes.
- Long engine jobs yield via `ClockPort.yieldNow()` every `mainSliceMs`.
- The phone/constrained budgets apply, and status shows `transport: "inline"`.

---

## h. Ports

The port files in `src/ports/*.ts` are normative, including their doc comments with semantics. These are their
exact signatures.

```ts
// common.ts
type Unsubscribe = () => void;
interface PortError { readonly code: string; readonly message: string; readonly retryable: boolean }

// clock.ts — virtual in simulation
interface ClockPort {
  now(): number;                 // wall clock: names, diagnostics, daily budget only
  monotonic(): number;           // timers, backoff, racy windows
  setTimer(delayMs: number, fn: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  yieldNow(): Promise<void>;
}

// random.ts — seeded in simulation
interface RandomPort { bytes(length: number): Uint8Array; float(): number }

// crypto.ts — suite 0 = identity
type BlobAddress = Brand<string, "BlobAddress">;
type OpenFailure = "unknown-key" | "auth-failed" | "unsupported-suite";
interface CryptoPort {
  readonly suite: CryptoSuite;
  readonly keyEpoch: number;
  seal(input: { aad: Uint8Array; plaintext: Uint8Array }): Promise<Uint8Array>;
  open(input: { suite: CryptoSuite; keyEpoch: number; aad: Uint8Array; sealed: Uint8Array }):
    Promise<{ ok: true; plaintext: Uint8Array } | { ok: false; reason: OpenFailure }>;
  sealBlob(plaintext: Uint8Array): Promise<Uint8Array>;
  openBlob(sealed: Uint8Array): Promise<Uint8Array | null>;
  blobAddress(hash: ContentHash): Promise<BlobAddress>;
}
interface HashPort { sha256(bytes: Uint8Array): Promise<Uint8Array> }

// blob.ts — engine receives BlobPort | null
interface BlobPort {
  readonly maxBlobBytes: number;
  has(addresses: readonly BlobAddress[]): Promise<ReadonlySet<BlobAddress>>;
  put(address: BlobAddress, bytes: Uint8Array): Promise<void>;
  get(address: BlobAddress): Promise<Uint8Array | null>;
}

// platform.ts
interface PlatformInfo {
  readonly os: PlatformOs; readonly isMobile: boolean; readonly isTablet: boolean;
  readonly hardwareConcurrency: number; readonly deviceMemoryGiB: number | null; readonly workerSupported: boolean;
}
type LifecycleEvent = "visible" | "hidden" | "pagehide" | "freeze" | "resume" | "online" | "offline" | "memory-pressure";
interface PlatformPort {
  readonly info: PlatformInfo;
  isVisible(): boolean;
  isOnline(): boolean;
  onLifecycle(listener: (event: LifecycleEvent) => void): Unsubscribe;
}

// vault.ts — main thread only
type WritePrecondition = { t: "absent" } | { t: "fingerprint"; fingerprint: DiskFingerprint }
  | { t: "hash"; hash: ContentHash } | { t: "any" };
// "follow-obsidian" (default): the host reads trashOption from <configDir>/app.json at each delete. "system" or absent
// → system trash; "local" and "none" (Permanently delete) → the vault's .trash folder, never a permanent delete.
type TrashMode = "follow-obsidian" | "obsidian-trash" | "system-trash";
interface VaultPort {
  readonly configDir: string;
  readonly caseInsensitive: boolean;
  list(): Promise<readonly VaultStat[]>;
  stat(path: string): Promise<VaultStat | null>;
  readBytes(path: string): Promise<Uint8Array>;   // raw bytes, transferred to the engine; main never decodes text
  write(path: VaultPath, data: string | Uint8Array, precondition: WritePrecondition): Promise<WriteOutcome>;
  rename(from: string, to: VaultPath, precondition: WritePrecondition): Promise<RenameOutcome>;   // vault.rename, never fileManager.renameFile
  trash(path: string, mode: TrashMode, precondition: WritePrecondition): Promise<RenameOutcome>;  // no permanent delete
  removeEmptyFolder(path: VaultPath): Promise<void>;
  onEvent(listener: (event: VaultEvent) => void): Unsubscribe;
}
interface ConfigDirPort {
  list(dir: string): Promise<readonly { path: string; size: number; mtimeMs: number; isFolder: boolean }[]>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;   // atomic replace
  remove(path: string): Promise<void>;
}
interface SideFilePort {
  read(name: SideFileName): Promise<Uint8Array | null>;
  write(name: SideFileName, bytes: Uint8Array): Promise<void>;
  remove(name: SideFileName): Promise<void>;
  list(prefix: "snapshots/"): Promise<readonly SideFileName[]>;
}

// workspace.ts — main thread only. Only @codemirror/state types cross (type-only); every call is O(1) or O(change)
interface EditorBindingSpec {
  onLocal(changes: ChangeSet): void;   // one local transaction's changes, in order (typing, undo, paste)
  onReset(): void;                     // EditorView.setState replaced the state: the binding is void
  onSaveRead(): void;                  // Obsidian reads the editor for a save (getViewData, dirty cleared)
}
interface EditorBinding {
  doc(): Text;                                 // immutable CodeMirror Text, O(1)
  applyRemote(changes: ChangeSet): void;       // addToHistory=false, remote, filters off; never reported to onLocal
  detach(): void;
}
type ExternalReloadHandler = (incoming: string, from: number | null) => "handled" | "default"; // from = sibling viewId
interface EditorViewRef {
  readonly viewId: number; readonly path: VaultPath | null;
  hasEditor(): boolean;
  editorDoc(): Text | null;                    // O(1)
  isDirty(): boolean;                          // TextFileView.dirty
  lastSavedText(): string | null;              // TextFileView.lastSavedData: read, never compared, on main
  bind(spec: EditorBindingSpec): EditorBinding;                     // collab ViewPlugin listener (host/collab.ts)
  interceptExternalReload(handler: ExternalReloadHandler): Unsubscribe; // per-instance setViewData wrap
  holdSaves(hold: boolean): boolean;           // getViewData answers lastSavedData; returns "a save was skipped"
  save(): Promise<void>;
}
interface WorkspacePort {
  listMarkdownViews(): readonly EditorViewRef[];
  onViewEvent(listener: (event: ViewEvent) => void): Unsubscribe;
}

// storage.ts — IndexedDB / in-memory
interface StorageTx<S> {
  get(store, key): Promise<record | undefined>;
  getAll(store, range?, limit?): Promise<record[]>;
  getAllKeys(store, range?, limit?): Promise<key[]>;
  getAllByIndex(store, index, range?, limit?): Promise<record[]>;
  count(store, range?): Promise<number>;
  countByIndex(store, index, range?): Promise<number>;
  put(store, record): void; delete(store, key): void; deleteRange(store, range): void; abort(): void;
}
interface StorageDb<S> {
  readonly name: string;
  tx<T>(stores: readonly StoreName<S>[], mode: "readonly" | "readwrite", body: (tx: StorageTx<S>) => Promise<T>): Promise<T>;
  close(): void;
  onLost(listener: (failure: StorageFailure) => void): Unsubscribe;
}
interface StoragePort {
  open<S>(name: string, version: number, stores: Record<StoreName<S>, StoreSpec>): Promise<StorageDb<S>>;
  deleteDatabase(name: string): Promise<void>;
  listDatabases(): Promise<readonly string[]>;
  requestPersistence(): Promise<boolean>;
}

// relay.ts — contract R1–R7 in the file header
interface RelaySession {
  readonly vaultEpoch: VaultEpoch; readonly headSeq: Seq; readonly canWrite: boolean; readonly limits: RelayLimits;
  append(frame: AppendFrame): void;
  bufferedBytes(): number;
  feed(afterSeq: Seq): Promise<FeedPage>;
  read(stream: StreamName, afterSeq: Seq, preferCheckpoint: boolean): Promise<ReadPage>;
  putCheckpoint(stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): Promise<PutCheckpointResult>;
  onEvent(listener: (event: RelayEvent) => void): Unsubscribe;   // buffers until the first listener
  close(code: number, reason: string): void;
}
interface RelayPort { connect(params: { vaultId: VaultId; deviceId: DeviceId }): Promise<RelayConnectResult> }

// index.ts — bundles
interface EnginePorts { relay; storage; clock; random; crypto; hash; blob: BlobPort | null }
interface HostPorts { vault; configDir; sideFiles; workspace; platform; clock; random }   // no hash: main never hashes (§d.2)
```

- **Not a port: `HashOracle`** (host/hashOracle.ts). The host's only hashing entry point:
  `hash(items: {path, want: "fingerprint" | "contentHash", bytes}[]) → {hash, textLength}[]`, served by the engine
  through `hashRequest` (bytes transferred, §g.2). It rejects while the engine is not running, and callers fail the op
  instead of guessing. The simulation uses an in-process oracle (sim/hash.ts).
- **Production adapters:**
  - `ObsidianVaultPort`, `ObsidianWorkspacePort`, `SideFilePort`, `ConfigDirPort` and `PlatformPort` in `src/host/`
    (WP-D);
  - `IdbStoragePort`, `WsRelayPort` (+ HTTP), `HttpBlobPort` and `NoopCryptoPort` in `src/engine/adapters/` (WP-C);
  - WebCrypto `HashPort`.
- **Simulation adapters** (`src/sim/`, WP-A): `MemStoragePort` (crash = keep committed transactions), `SimRelay`
  (implements relay-wire semantics including the dedupe window, restarts, provisional/notice and group commit),
  `SimVault` (case-insensitive or case-sensitive profile), `SimWorkspace`, and virtual `ClockPort` / seeded
  `RandomPort`.

---

## i. Runtime

### i.1 Priority lanes

| Lane | `LANE` | Work |
|---|---|---|
| 0 | `openNote` | `bodyPush` apply, frame close and **send** for bound docs, receipts, body event forwarding, provisionals for bound docs, bind requests and bind merges |
| 1 | `openCatchUp` | Reads, union and merges for bound or just-opened docs; hard-limit compaction |
| 2 | `namespace` | ns/cfg/snap ingest, fold, ns/cfg/snap reads, planner runs, ns frames, settings projection |
| 3 | `background` | Body reads for stale streams, merges, projection writes, materialization, scan hashing |
| 4 | `bulk` | Blobs, compaction, remote checkpoints, retired checkpoints, snapshots, mirrors |

- **Scheduler.** Cooperative and single-threaded in the engine.
  - Each slice runs jobs from the highest non-empty lane until `sliceMs` has elapsed, then calls `yieldNow()`.
  - **Aging:** every 8th slice serves the oldest job of lanes ≥ 3, so bulk work never starves.
  - Relay events are queued immediately (O(1)). Their processing is scheduled by lane.
- **Sender** order: lane 0 frames, ns, cfg, then snap and background, then bulk (`x:` chunks, adopted frames).
- **Host** executes `diskOps` batches lane-first within `mainSliceMs` slices, and puts editor work ahead of all of
  it.

### i.2 Device classes and budgets

The host picks the class and passes it in `EngineInitConfig.deviceClass`:

| Class | Selected when |
|---|---|
| `desktop` | not mobile |
| `tablet` | `isTablet` |
| `phone` | mobile and not a tablet |
| `constrained` | mobile with (`deviceMemoryGiB` < 3, or `hardwareConcurrency` ≤ 2), or phone/tablet running inline |

Budgets (`BUDGETS` in `limits.ts`):

| | desktop | tablet | phone | constrained |
|---|---|---|---|---|
| Resident docs / bytes | 400 / 256 MiB | 120 / 96 MiB | 60 / 48 MiB | 24 / 24 MiB |
| Engine slice / main slice | 10 / 8 ms | 10 / 6 ms | 8 / 5 ms | 6 / 4 ms |
| Catch-up / blob concurrency | 8 / 4 | 4 / 2 | 3 / 2 | 2 / 1 |
| In-flight append bytes | 1 MiB | 512 KiB | 512 KiB | 256 KiB |
| Disk I/O in flight / ops per batch | 8 MiB / 32 | 4 MiB / 16 | 2 MiB / 16 | 1 MiB / 8 |
| Full reconcile interval | 5 min | 10 min | 10 min | 15 min |
| Daily frame soft budget | 20 000 | 10 000 | 6 000 | 4 000 |
| Body event credit window (`docUpdateWindowBytes`) | 512 KiB | 256 KiB | 256 KiB | 128 KiB |

Further caps:
- live queue: 4 MiB / 1000 rows;
- merge inputs: `MERGE_MAX_INPUT_CHARS`;
- doc text: `MAX_DOC_TEXT_CHARS`;
- base text: `MAX_BASE_TEXT_CHARS`.

### i.3 Residency

- Clean-only LRU, described in §d.1.
- Bound docs are pinned. Docs with an open frame builder or a running job are pinned until done.
- Catch-up of cold docs never loads a `Y.Doc`. Rows are stored after gate stages 1–2.
- A doc is loaded only for:
  - bind;
  - a merge or projection (planner `reconcileContent` / `diskMaterialize`);
  - a union or compaction job;
  - a causal-hole check.

### i.4 Lifecycle

| Event | Action |
|---|---|
| `hidden` | Close all frame builders (`T_edit`); `saveViews` for bound docs; write the outbox and synced mirrors. Desktop and tablet stop there: they keep the socket and lanes 3–4, because an occluded or minimized desktop window also reports `hidden` and must keep writing remote edits to disk (the engine cannot tell an iPad from desktop Obsidian running the engine inline, so tablets count as desktop). Phone and constrained devices pause lanes 3–4 at once (hard-cap compaction is lane 1 and still runs) and close the socket (1000) after 30 s hidden. A background close shows no offline or error phase and arms no backoff. |
| `pagehide` / `freeze` | Same flush, started synchronously (IDB transactions start in the event turn), then pause lanes 3–4 and close the socket on every device class. Expect to be killed: nothing is held in memory only, beyond the ≤ 316 ms builder window that disk covers. |
| `resume` / `visible` | Reconnect at once (reset backoff), feed, full reconcile. This tries once even after `offline`, so a missed `online` cannot strand the device; while offline a failure arms no backoff. The user's pause wins over this and over `online`. Check the IDB connection: `onLost` → §i.5. |
| `online` / `offline` | Connect at once / stop reconnect attempts (an open socket stays until it fails). The outbox keeps accumulating. |
| `memory-pressure` | Evict all clean docs, drop live-queue payloads for cold docs (stale-record), drop candidate caches except the newest. |

### i.5 IDB loss and recovery

**Detection.** Any one of:
- `open` fails;
- `StorageFailure` is `connection-lost` and the reopened DB lacks `meta.identity`;
- the identity mismatches;
- the DB is empty while the side-file mirrors have generation > 0.

**Procedure** (phase `recovering`):
1. Open a fresh DB under the same name. On a WebKit connection loss, try reopening first.
2. Import the outbox mirror: same `clientFrameId`s, `order`s and states (sent → pending), and `outboxOrder.next =
   max + 1`.
3. Import the synced mirror as `SyncedEntry` with `hasBase = false` and `bodyVersion = null`. With `bodyVersion =
   null` the planner compares content instead: `Rc := streams.textHash ≠ S.contentHash`.
4. `identity.recoveredFromMirror = true` and cursor 0.
5. Full catch-up: feed from 0, ns first, then reads with `preferCheckpoint`.
6. Full scan, with every file hashed.
7. Plan:
   - L = S → adopt;
   - only L changed → disk-only;
   - both changed → no-base conflict copy.
   - Nothing is destroyed.

**Without mirrors**, recovery is the fresh-device onboarding path (§j.5): identical files are adopted and differing
ones get conflict copies.

**`rebuildLocalCache`:** flush the outbox to the mirror, close and delete the DB, then run the same procedure.

**`StorageFailure: quota`:** §e.3.

### i.6 Relay conditions

| Condition (relay-wire) | Engine response |
|---|---|
| `refused daily-limit` (VAULT_ERROR `cf_daily_limit`, `resetAt`) / connect `daily-limit` | Phase `daily-limit`. Hold all appends and checkpoint puts until `retryAfterMs` + jitter (first probe 2 min after reset). Reads continue. Local edits keep filling the outbox. Notice (ported `dailyLimit` strings). |
| Daily soft budget (per device, local day) | At 80 %: notice. Above 100 %: frame timers ×4, background merges coalesced to ≥ 10 s per doc, onboarding creates throttled (§j.5). |
| `backpressure` (VAULT_BACKPRESSURE), then 1013 | Stop sending at once. Reconnect after ≥ 5 s. Client token bucket at 50 % for 10 min. |
| 1009 oversize / 1008 malformed APPEND | Probe mode, poison (§d.6). |
| 1008 + upgrade error `unauthorized` | Re-ticket once. Connect `unauthorized` (ticket 401) → phase `revoked`, stop, "re-pair device" notice. |
| `update_required` / connect `update-required` | Phase `upgrade-required`, no reconnect until the plugin updates. |
| `unclaimed` / `not-found` | Phase `error` with notice, retry hourly. |
| 4403 `authority_superseded` / connect `superseded` | Re-ticket and reconnect. Repeated: phase `superseded`, retry every `SUPERSEDED_RETRY_MS`. |
| 4409 | Not sent on streams sockets. If seen: reconnect and compare `VAULT_READY.vaultEpoch` (§c.12). |
| HTTP 409 `vault_generation_mismatch` | Epoch change (§c.12). |
| `refused durability` | Resend the same frame (same id) after 1 s backoff. |
| `refused frame-id-conflict` | Poison it. Body: rebuild from disk. ns/cfg: re-plan the ops under a fresh frame id. Diagnostics. |
| `refused forbidden` / `canWrite = false` | Read-only: no appends or checkpoints. Outbox kept. Notice. |
| `resendUnreceipted` (STREAM_RESEND) | §d.5. |
| 1001 / 1006 / network | Reconnect with full-jitter exponential backoff `RECONNECT_BASE_MS` → `RECONNECT_MAX_MS`. Immediate on `online` / `visible`. |
| Ticket TTL 5 min | The adapter fetches a fresh ticket for every connect. |

---

## j. Shorter specs

### j.1 Blobs

- **With a blob store** (`BlobPort`):
  - **Upload** (`blobQueue up`): hash → `crypto.blobAddress(hash)` → `has` → `put(sealBlob(bytes))`. Only **after**
    the put succeeds does the planner emit `nsCreate` / `nsSetBlob` for that hash, so readers can always fetch what
    ns references.
  - **Download:** `get` → `openBlob` → verify sha256 → write with precondition. A missing blob is retried with backoff
    (`wait(blob-unavailable)`).
  - Files larger than `BlobPort.maxBlobBytes` (the server's `maxBlobUploadBytes`; 10 MiB when it sends none or the
    capabilities probe fails) or `settings.maxAttachmentBytes` are not synced (notice) and never deleted.
    `StatusSnapshot.maxBlobBytes` reports the carrier's limit (8 MiB without a blob store); the attachment size
    setting then reads "This server accepts attachments up to N MB; the smaller limit applies."
- **Without a blob store** (`blob = null`; the relay answers 503 `attachments_unavailable`):
  - Attachments ≤ `MAX_LOG_BLOB_BYTES` (8 MiB) ride stream `x:<sha256>` as `blobChunk` frames (768 KiB, ≤ 11 rows).
    The ns op is emitted after every chunk is receipted.
  - Readers `read(x:…)`, assemble by index (duplicates ignored), and verify the hash.
  - Larger files are not synced (notice).
  - `x:` streams get `retired` checkpoints once no ns entry or cfg file references the hash.
  - The same path carries `bodyUpdateRef` payloads.
- `syncAttachments = false` excludes blobs entirely: no ns ops, and remote blobs are not fetched.

### j.2 Canvas

- **CRDT.** Stream `c:<docId>`. Roots:
  - `Y.Map "nodes"`: id → `Y.Map` of fields. Values are JSON (`ContentAny`), except a text node's `text`, which is a
    `Y.Text`. Each node also has `"rank"`, a fractional order key (ported `canvasOrdering`).
  - `Y.Map "edges"`: same shape, keyed by id.
  - `Y.Map "doc"`: other top-level keys, as JSON values.
  - The gate rejects any other root or type.
- **Projection.** Nodes and edges are sorted by `(rank, id)`. Disk bytes use Obsidian's formatting
  (`JSON.stringify(_, null, "\t")`, ported `formatCanvasBytes`). The logical hash uses `canonicalCanvasBytes`.
  - **Validation:** unique string ids; node `type ∈ {text, file, link, group}`; numeric `x / y / width / height`;
    edges reference existing nodes (dangling edges are dropped from the projection, kept in the CRDT). Invalid →
    freeze `canvas-invalid`.
- **Merge.** The ONE `MergeFn` runs over the canonical record-per-line text (`canonicalCanvasItemBytes` with rank),
  so concurrent edits to different nodes merge, and the same node conflicts.
  - The CRDT apply is record-level: changed fields are set, and the `text` field gets a minimal `Y.Text` diff. Node
    maps are never replaced wholesale.
  - Canvas views are not bound. Every user edit reaches the CRDT through a disk save and merge.

### j.3 Settings sync (`cfg`)

- **Allowlist:**
  - Root JSON (the legacy set): `app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`,
    `core-plugins-migration.json`, `graph.json`, `daily-notes.json`, `templates.json`, `backlink.json`,
    `page-preview.json`, `note-composer.json`, `switcher.json`, `bookmarks.json`, `workspaces.json`: `jsonSet` /
    `jsonDel` per top-level key, canonical JSON. A device-local key denylist per file is never emitted
    (`appearance.json` `nativeMenus` / `translucency`, `workspaces.json` `active`).
  - `community-plugins.json`: projected from `plugins` (`pluginSet` / `pluginDel`).
  - `plugins/<id>/data.json`: `filePut` with `pluginVersion`, applied only on an equal local version.
  - `snippets/*.css`, `themes/<name>/{theme.css, manifest.json}`: `filePut`. Content > 64 KiB or binary goes as a
    blob ref.
- **Never synced:** `plugins/yaos/**`, `workspace.json`, `workspace-mobile.json` (open-pane layout),
  `file-recovery.json`, `publish.json`, `types.json`, plugin code (`main.js`, `styles.css` of plugins), caches.
- **Detection.** On full reconcile and focus, `ConfigDirPort.list` / `readBytes` are compared with `cfgBase`. Changed
  keys or files become cfg ops, sent through the send window.
- **Projection.** For each register whose fold value ≠ local:
  - local = `cfgBase` → write (`ConfigDirPort.writeBytes`, atomic);
  - local changed too → emit the local op first. The fold then orders the two, and the later seq wins.
  - `T_cfg` updates `cfgBase`.
- **Ops cover only settings changes**, never whole-file rewrites. Each key holds a single value, so a register cannot
  grow.
- **Reload notice.** When applied settings need an Obsidian reload, show a notice. YAOS never reloads Obsidian itself.
- **Size caps** (`CFG_MAX_*`, legacy values). A file over 1 MB is not sent and not written. Going through files in
  path order, the first one that would take the synced set past 256 files or 4 MB is held, and so is every file after
  it. This applies on both sides, using the size after the pass. A held file gets no op and no write, and its
  `cfgBase` is left alone, so it is never deleted elsewhere. Removals never count toward the caps.
- **Skip notices.** These skips each show one warn notice per category: a `data.json` held for a plugin version
  mismatch, a plugin enabled elsewhere but not installed here, local JSON that is not valid, and files past the caps.
  The notice names the files and plugins (a count once there are many) and says what to do. A category is shown
  again only when it gains an item, so a steady hold is shown once.
- **Clash pause.** While Obsidian Sync (`core-plugins.json` `sync`) or a known community sync plugin (Remotely Save,
  Self-hosted LiveSync, Relay) is enabled, cfg sync emits and applies nothing. It shows one warn naming the clashing
  plugin and resumes on its own once that plugin is off. Note sync is not affected.
- **Desktop-only plugins.** On mobile (`PlatformInfo.isMobile`), a plugin enabled elsewhere whose installed manifest
  says `isDesktopOnly` is not enabled here. This hold is silent, and the device never disables the plugin elsewhere.
- **First-enable seed.** Turning the settings toggle on asks "Use the vault's settings" or "Use this device's
  settings" (`EngineSettings.syncSettingsSeed`, absent = vault). Closing the dialog leaves sync off.
  - The answer only applies while `cfgBase` is empty, which means the first pass on this device or the first pass after a
    cache rebuild. Later passes, including after turning sync off and on again, are normal 3-way merges.
  - With no base, vault: the vault's register wins over the local value. Device: the local value wins.
  - In both cases, what only one side has is taken and nothing is deleted.
  - While `cfgBase` is empty, a pass waits until the cfg stream has been read to the relay head in this runtime
    (`CfgSyncDeps.remoteReady`, the log reached `live`). An empty view would otherwise let local win whatever the seed.
- Port the legacy `settingsSync/{allowlist, dataJsonGate, configDirKey, clash, lwwReconcile(json canonicalization
  only)}`.

### j.4 Client snapshots and recovery

Snapshots are the recovery path. Each one is a file-level copy of the vault. It is kept on the device, and it can be
uploaded as an opaque, verifiable backup that any paired device can list and restore. The relay never parses a
snapshot: its parts are ordinary blobs (relay-wire §11.3) and its index is an ordinary commit-only stream. Zipping,
hashing and verification run in the worker (`src/core/snap/*`, `src/engine/snapshots/*`).

- **Content.** Markdown and canvas files plus blobs ≤ 1 MiB (`SNAP_MAX_BLOB_BYTES`), from the reconciler's local tree.
  Excluded paths are left out.
  - Bounds: at most 256 MiB of file bytes (`SNAP_MAX_TOTAL_BYTES`) and 65,000 files. Above that the snapshot is
    skipped with notice `snapshot-too-large`.
  - A file that would fail restore verification is left out and listed as skipped `invalid`. That covers a bad path,
    markdown that is not UTF-8, and a canvas `parseCanvasBytes` rejects. One bad file must not make the whole
    snapshot unrestorable.
- **Files, not CRDT state.** Bundles hold files, and Yjs state is not added:
  - a restore is a plain local edit through conflict copies and CAS writes, and that flow consumes bytes;
  - Yjs state only means something under the doc's stream identity, and a restore deliberately does not reuse it;
  - it is up to 3 × the text (§e.1) and would put Yjs decoding of untrusted bytes on the restore path;
  - all it would add is edit history, and a snapshot is a point in time.
- **Format zip-v1** (`src/core/snap/zip.ts`, `bundle.ts`, `export.ts`):
  - **Entries:** `files/<path>` in manifest order, then `manifest.json`: `{formatVersion: 1, id, createdAtMs,
    reason, files: [{path, kind, hash, size}], skipped: [{path, reason}]}`. `hash` is `exactFingerprint`, the sha256
    of the exact bytes.
  - **Zip:** every local header carries crc32 and both sizes (no data descriptor, no extra field, UTF-8 flag, fixed
    1980-01-01 date). Entries are deflated when that is smaller, else stored. There is no zip64. Standard unzip tools
    read it.
  - **Parts:** the zip byte stream is cut into parts of exactly `partSize` bytes; only the last may be shorter.
    `partSize = min(8 MiB, ⌊maxBlobBytes × 7/8⌋)` (headroom for sealing), or 8 MiB without a blob store. The limits
    are ≤ 512 parts of ≤ 16 MiB and a zip ≤ 320 MiB.
  - **Hashing:** each part is hashed (SHA-256) when it is cut, while the next one fills. The bundle digest binds the
    parts and the manifest:
    `bundleDigest = SHA-256("yaos/snap-bundle/1" ‖ varstring id ‖ varuint n ‖ n × (varuint size ‖ 32B sha256(part)) ‖ 32B sha256(manifest.json))`.
  - **Export** (`exporter.ts`) reads files in small batches and adds them one at a time. Each finished part goes
    straight to its side file. Peak memory is one part buffer, one read batch with its deflated copy, the central
    directory and the manifest list.
  - **Memory**, measured with `e2e/client/snapshotMemory.ts` (peak live-heap growth):

    | Vault | Before (whole zip in memory) | Streaming |
    |---|---|---|
    | 50 MiB, 1,556 files | 82 MiB | 21–23 MiB |
    | 157 MiB, 4,667 files | — | 27 MiB |

    The peak follows the part size, not the vault size.
- **Side files** (`localStore.ts`, under `state/snapshots/`):
  - `<id>-p<NNN>.part`: the parts;
  - `<id>.snap`: the descriptor, which is the encoded index record, written last. A snapshot exists iff its
    descriptor decodes, and the sweep removes parts without one;
  - `dl-p<NNN>.part`: the download cache, holding one remote snapshot.
  - Ids are `<createdAtMs, 9 base-36 chars>-<reason>`. A remote one appears to the host as `<id>@<deviceId>`. Host
    ids are parsed strictly; anything else is `bad-request`.
- **When taken:**
  - daily, keeping `keepDaily` (with snapshots enabled);
  - before a brake approval, an epoch migration and an IDB recovery (with snapshots enabled);
  - on `createSnapshot` and before every `restoreSnapshot`, even with snapshots disabled (user actions);
  - the newest 10 non-daily snapshots are kept.
- **Upload** (`remote.ts`; needs `uploadToBlobStore` and a `BlobPort`):
  - **Cadence:** a manual snapshot is uploaded at once. After a full pass, `maybeDaily` takes the daily snapshot
    when the last one is 24 h old, then uploads the newest local daily or manual snapshot that is not in the index
    yet. That is at most one background upload a day, plus the manual ones. Event snapshots stay local.
  - **Blob path:** parts go through the attachments' one blob path (`putSealed`). The address is
    `CryptoPort.blobAddress(sha256(part))` and the body is `sealBlob(part)`, so E2EE applies unchanged.
  - **Idempotent and resumable:**
    - `has` runs first, and present parts are neither read nor sent;
    - a missing part is re-checked against the descriptor before it is sent;
    - the index record is appended only after every part is stored, and only if the index lacks it, so there are no
      duplicate records.
  - **Failures and readiness:**
    - nothing uploads until the `snap` stream is caught up;
    - a failed background upload backs off 1 h and only logs a diagnostic;
    - a failed manual one raises notice `snapshot-upload-failed`.
- **Index: stream `snap`** (`src/core/snap/record.ts`, `fold.ts`; §b.2, §b.4):
  - **Records:** one small record per uploaded snapshot (≤ 48 KiB): id, createdAtMs, device label, reason, format,
    file count, total bytes, bundle digest, and per part `{address, size, sha256}`.
  - **Untrusted input:**
    - decoding enforces every bound, the reason set, the id shape and 64-hex addresses and hashes (the relay's blob
      routes take `<sha256 hex>`);
    - a violation makes the frame malformed, so it folds as empty;
    - a put with an unknown record version is ignored and reported (`snap-unknown-version` diagnostic).
  - **Fold:** a join, independent of row order and duplicates, so it needs no dedupe ring. Per device, the floor is
    the max of its floor ops. A del is kept at or above the target's floor. Per key (row deviceId/snapshotId) the put
    with the smallest canonical body wins. A device can add only its own snapshots, and any device can delete any.
    Rows whose deviceId the relay could not have issued are ignored. A seeded fuzz test (`snap.test.ts`) checks that
    permutations and duplicates give the same state.
  - **Live set:** records not deleted and not below their device's floor, at most the newest 100 per device.
  - **Retention:** each upload appends `floor = createdAtMs` of this device's `keepDaily`-th newest upload, so every
    reader drops older ones. Dels below a floor are pruned, so the state stays bounded by retention.
  - **Wiring, like `cfg`:** read after `ns` and `cfg` in catch-up, folded by a FoldRuntime, lane 2, compacted, and
    checkpointed as `snapFoldV1` (strict decode plus canonical re-encode, §b.5). The record adds no crypto of its own;
    the envelope seals it like any frame.
- **Restore and verification** (`verify.ts`, `snapshotJob.ts`). The relay is trusted for neither content nor paths,
  so every check runs on the client.
  1. **Resolve** the id: a local descriptor, else this device's uploaded record, else `<id>@<deviceId>` in the live
     set.
  2. **Pass 1, verify; nothing is written.** Parts are read in order: local parts from side files, a remote snapshot
     downloaded one part at a time through `getOpened`. Each part enters the download cache only after it passes its
     own check. Fail closed: the first failed check refuses the whole snapshot. The checks, in order:
     - part present (`part-missing`), size (`part-size`), sha256 (`part-hash`);
     - zip structure, bounded inflate, sizes and crc32 (`zip-decode` / `truncated`);
     - each entry's path under the ns path rules, §c.2 (`path-invalid`);
     - content: canvas through `parseCanvasBytes`, markdown through fatal UTF-8 decoding (`content-invalid`);
     - `manifest.json` strict schema (`manifest-invalid`), and its id, counts and file list (path, kind, size,
       sha256) equal to the record and to the entries (`manifest-mismatch`);
     - the bundle digest (`bundle-digest`).
  3. **Safety snapshot:** take a `restore` snapshot.
  4. **Pass 2, write.** Re-read the verified parts from side files (no new download) and run the same checks, with
     each entry also compared to the verified manifest (`file-hash`). Each entry goes through the restore flow:
     - a differing current file is conflict-copied first;
     - the write has precondition fingerprint(current) or absent, so a file edited meanwhile is reported failed, not
       clobbered;
     - written files sync normally, and the brake applies.

     Pass 2 can only fail if a side file changed between the passes. Files written before the failure then stay;
     each write was CAS-guarded, and the safety snapshot holds the prior state.
  - **`content_corrupt`:** every failed check is reported three ways:
    - notice `content_corrupt`: "Snapshot X is damaged (check); nothing was restored." (pass 2 says "the restore
      stopped.");
    - a diagnostic line `content_corrupt snapshot=<id> check=<check>`. Part checks add the index and sizes; vault
      paths are never added;
    - the request fails with `ProtocolError` code `content_corrupt`, not retryable.

    A store or transport error is not corruption: the request fails without that notice.
  - **Download cache:** removed after the restore, on any failure, when another remote snapshot is verified, and by
    the sweep. It never holds more than one bundle (≤ 320 MiB).
- **Blob lifetime (server ask A3, e2ee-design §10.4).** The relay has no blob GC. Until A3 exists, parts of
  superseded snapshots (below a floor, or deleted) stay in R2 until the vault is deleted. For the A3 mark-and-sweep:
  - the live set must include the part addresses of every record in the `snap` fold's live set. Records keep
    `address` for this, because under E2EE the sweep sees addresses, not hashes;
  - the 7-day grace period covers the gap between the part puts and the index record. A resumed upload skips parts
    that `has` reports present, and such a part may be older than the grace period, so it could be swept before
    its record lands. Before A3 ships, either the upload re-sends parts older than a day or `has` reports upload
    times. A part swept anyway fails a restore as `part-missing`, never silently.
- **Commands** (`src/protocol/messages.ts`):
  - `listSnapshots` → `snapshots` (id, time, reason, file count, bytes). Also `where` (`local` / `remote` / `both`)
    and the uploading device's label (`device`);
  - `snapshotFiles{id}` → the manifest's files (path, kind, size) and `skipped` entries (too large, unreadable,
    invalid). The whole snapshot is verified first (a remote one is downloaded): damaged is `content_corrupt`;
  - `restoreSnapshot{id, paths|null}` → `restored` (counts, conflict copies, failed paths);
  - `deleteSnapshot{id}` removes the local copy, plus the index record if it was uploaded; for a remote snapshot it
    appends a `del`.
  - Unknown ids are `bad-request`.
  - Without a running vault runtime these commands, `createSnapshot` and `exportDiagnostics` fail with `not-ready`.
- **Host UI** (`src/host/ui/snapshotsModal.ts`; copy and logic in the pure `snapshotsModel.ts`):
  - **Snapshots dialog** (settings "Browse snapshots" or the command palette): "Create snapshot now", then one row
    per local or uploaded snapshot, newest first (local time, reason, file count, size, plus "· uploaded" or
    "· from <device>"). Each row has "Browse files…", "Restore all…" and "Delete…":
    - restore and delete ask first;
    - the restore confirm says differing files become conflict copies and a safety snapshot is taken first;
    - opening a remote snapshot says it is being downloaded and checked.
  - **Files dialog:** a path filter, checkboxes (at most 500 rendered; "Select all matching" includes the rest),
    "Restore selected…" with a confirm, and a warning listing the manifest's skipped files.
  - **After a restore,** a notice summarises the restored, unchanged, conflict-copy and failed counts.
  - **Upload toggle:** "Upload snapshots to attachment storage" sets `uploadToBlobStore`. Its copy says you can
    restore the snapshots from any of your devices, and that the upload needs attachment storage on the server.
  - **Nothing else:** no status rows and no polling. The list reads the folded index when the dialog opens.
- **Tests:**
  - unit: codec bounds, fold fuzz, and one test per verification failure (`src/core/snap/*.test.ts`);
  - job tests: a faulting `BlobPort` (`src/engine/snapshots/*.test.ts`);
  - `e2e/client/snapshots.ts`, on a local relay with R2: device a uploads, a fresh device b lists, restores and
    matches, and a part flipped at rest in R2 is refused as `content_corrupt`.

### j.5 Onboarding and import

- **Pairing** (UI out of scope; port the legacy provisioning client) yields `vaultId`, `deviceId` and a credential
  (secret, kept in plugin data).
- **First engine start against a vault:**
  1. ns catch-up (§j.6);
  2. full scan;
  3. plan:
     - `R live, S absent, L present` → equal hash: adopt, with no frames. Different: a no-base conflict copy of the
       local file, and the remote content takes the path.
     - L-only files → `nsCreate` (+ held initial body frames).
- **Concurrent onboarding.** Two devices importing the same files into an empty vault converge through the fold:
  - identical files → `merged`: no copies, no body rows;
  - differing files → suffixed;
  - identical-loser collapse removes the rest (§c.5, §c.13).
- **Row budget.** About 1 ns row per 512 creates, plus ≥ 1 body row per note (`ceil(chars / 192 Ki)`), plus ≤ 11 per
  log-carried attachment.
  - A 10k-note vault is about 10k rows/day of the 100k free-plan rows.
  - Larger imports are paced by the daily soft budget, in order: most recently modified first, then small before
    large. Status shows progress. The daily-limit hold (§i.6) is the backstop.
- **Legacy YAOS vault data is not migrated.** A new client connects to a new vault epoch, and existing files import
  as local files.
  - Alternative: migrating legacy CRDT state. Rejected: a different log, and disk is the source of truth at import.

### j.6 Fresh-device bootstrap

1. **Connect, then feed from 0.** All streams are recorded stale with priorities. There are about streams/1000 pages.
2. **ns first.** `read("ns", 0, true)`: verify the checkpoint (V1 + V2), then fold the rows. The Remote tree is now
   complete, and status shows `bootstrap {docsTotal}`.
3. **Bodies lazily, by priority.** Bound or opened docs (lane 1) first, then live docs by `lastTouchSeq` descending,
   small first within a bucket (`priority = bucket(lastTouchSeq) × 4 + sizeClass`), then blobs (lane 4).
   - Reads use `preferCheckpoint = true`, so a body costs about one checkpoint plus few rows.
4. **Progressive disk writes.** Each doc is materialized as soon as its body is caught up (`diskMaterialize`, expect
   absent), so `docsMaterialized` rises steadily. Folders are created implicitly by writes.
5. **Afterwards.** A full reconcile runs, then `live`. Files present locally before bootstrap follow §j.5.

### j.7 Status and diagnostics

- **`StatusSnapshot`** (`src/protocol/status.ts`): phase, transport, epoch, seqs, relay connection, counts (stale
  streams, outbox, unreceipted, resident, pending disk ops and blobs, quarantined rows, frozen docs, conflict copies
  today), bootstrap progress, brake, last reconcile and sync times, daily frames, the carrier's attachment limit
  (`maxBlobBytes`, null until a vault is open), notices.
  - Posted on phase change, and otherwise at most 4/s.
  - The status bar shows phase + unsynced count.
- **`DiagnosticsBundle`** (`exportDiagnostics{includePaths}`, built in `src/engine/compose/diagnosticsBundle.ts`):
  - the whole 2000-entry ring of `DiagnosticsEvent`, oldest first (numbers, booleans, stream classes, error
    messages). The whole ring, not a tail: the window before an incident is what support needs;
  - quarantine summary (at most 200 rows), frozen doc streams, per-store counts, status;
  - never credentials, tickets or file contents. `error` fields are error messages as thrown, not scrubbed.
- **Pseudonyms.** Every stream and path is replaced by 12 hex chars of SHA-256 over a fresh random per-bundle salt and
  the file's vault path (or its stream name when the path is unknown).
  - The salt is not exported, so pseudonyms cannot be matched across bundles or tested against guessed paths.
  - Within one bundle a file has one pseudonym everywhere: doc streams read `b:`/`c:`/`x:` + pseudonym, and brake
    `samplePaths` hold the same pseudonym. `ns` and `cfg` keep their names.
- **`paths`** is null unless the user opted in. With opt-in it maps each pseudonym whose path the engine knows to
  that vault path, sorted by path. The command "Export diagnostics (include file names)" asks for confirmation
  first; the file name ends in `-with-file-names`.
- **Host additions** (`src/host/ui/diagnostics.ts`):
  - a `settings` section: plugin version, transport, host URL, vaultId, deviceId, device label, engine settings.
    Identity fields are picked one by one, never the device token. Exclude patterns appear only with opt-in (they
    name folders); otherwise only their count.
  - Secret-looking keys are redacted at any depth as a backstop.
  - The host writes the file under `<configDir>/plugins/yaos/diagnostics/` and copies it to the clipboard.

---

## k. Module layout and build plan

### k.1 Layout

```
src/
  core/                      PURE: no I/O, timers, Date, Math.random, yjs, DOM
    types.ts envelope.ts limits.ts            [architect, frozen]
    codec/   lib0 helpers, envelope, nsOps, cfgOps, nsFoldV1, cfgFoldV1, snapFoldV1, blobChunk, mirrors [WP-A]
    paths/   pathKey (+ generated casefold15_1, assigned15_1), validate, segments              [WP-A]
    ns/      fold, index, place, overlay, verify (V1/V2), candidate (V3 digest rule)          [WP-A]
    cfg/     fold, projection (pure JSON register → file bytes)                               [WP-A]
    snap/    record (snapOps), fold, zip, bundle (parts, digest, manifest), export, verify (§j.4)
    hash/    markdownLf (ported markdownCodec), canvasCanonical (ported canvasCodec/Ordering) [WP-B]
    merge/   merge (MergeFn), myers, diff3, minimalDiff                                        [WP-B]
    plan/    planner (PlanFn), brake, renames, conflictName, order                            [WP-B]
  ports/                     [architect, frozen]
  protocol/                  messages/errors/status/transport types [architect]; workerTransport, inlineTransport [WP-D]
  engine/                    worker or inline; yjs allowed; no obsidian, no DOM except adapters/
    store/   schema.ts [architect]; repo.ts (all §e.2 transactions)                           [WP-C]
    adapters/ idbStorage, wsRelay (+http feed/read/checkpoint), httpBlob, noopCrypto, webHash [WP-C]
    ingest/  gate, yjsCheck                                                                   [WP-C]
    body/    handles, frameBuilder, sender, provisional, compaction, checkpoints, canvasDoc    [WP-C]
    sync/    cursor, catchUp, nsRuntime (fold host, overlay, duties), cfgRuntime, snapRuntime [WP-C]
    runtime/ engine.ts (createEngine), lanes, budgets, lifecycle, status, diagnostics, recovery [WP-C]
    reconcile/ localTree, scan, planRunner, mergeJob, echo, intents                           [WP-B]
    blobs/   blobQueue (store + x: log carrier)                                               [WP-B]
    settings/ cfgScan, cfgProject                                                             [WP-B]
    snapshots/ snapshotJob, exporter, localStore, remote (upload, parts), restore, snapIndex  [WP-B]
    workerMain.ts            worker entry glue                                                [WP-D]
  host/                      Obsidian main thread; obsidian, @codemirror/*; no yjs / lib0 / y-protocols (§k.2)
    plugin.ts engineHost.ts (spawn, restart, inline fallback) diskExecutor.ts binding.ts bodyClient.ts collab.ts hashOracle.ts
    obsidianVault.ts obsidianWorkspace.ts configDir.ts sideFiles.ts platform.ts ui/          [WP-D]
  sim/                       tests only, never bundled
    relay.ts storage.ts clock.ts random.ts                                                    [WP-A]
    vault.ts workspace.ts actors.ts faults.ts invariants.ts run.ts                            [WP-D]
```

### k.2 Dependency rules

These are enforced by `scripts/check-deps.mjs` (WP-D), a regex import scan run in CI.

- `core/**` imports only `core/**`, `lib0`, `fflate`, and type-only `ports/**`.
- `ports/**` and `protocol/**` (types) import only `core/**` types (plus type-only `@codemirror/state` in
  ports/workspace.ts).
- `engine/**` imports `core`, `ports`, `protocol`, `yjs`, `lib0` and `fflate`.
  - Never `obsidian` or `host/**`.
  - Browser globals (`indexedDB`, `WebSocket`, `fetch`, `crypto.subtle`) only in `engine/adapters/**`.
- `host/**` imports `core`, `ports`, `protocol`, `obsidian`, `@codemirror/*` and `qrcode` (the pairing QR). From
  `engine/` it imports only `engine/adapters/webEngine.ts` (worker spawn and inline fallback), and `host/entry.ts`
  imports `engine/workerMain.ts`.
- **Main-thread rules (§d.2).** The main thread holds CodeMirror state and raw disk I/O only.
  - `MAIN_FORBIDDEN` = `yjs`, `y-codemirror.next`, `y-protocols`, `lib0`. No `host/**` file may import them: not
    tests, not type-only imports.
  - `mainReach` follows every product `host/**` module's relative imports through `core`, `ports` and `protocol`
    (stopping at the two engine entries) and fails if a forbidden package is reachable.
  - **Whole-document reads.** `FULL_READS` counts `.getValue(`, `.toString()`, `.sliceDoc(`, `.sliceString(`,
    `.getViewData(` and `Text.of(` per `host/**` file. Each occurrence must be listed in `FULL_READ_ALLOW` with the
    reason it is off the per-keystroke, per-remote-update and per-workspace-event paths, so a new one fails CI.
    Today the list is the bind upload's `sliceString` (binding.ts) plus three `toString()` calls on non-documents
    in host/ui.
- `sim/**` may import anything. Nothing imports `sim/**` except tests.
- Shared shapes change only through the architect files plus this document.

### k.3 Build plan (4 parallel work packages)

The only shared files are the frozen architect files. Each WP owns its directories. WPs integrate through ports, the
`PlanFn` / `MergeFn` / `FoldNsFrame` signatures, `YaosSchema` and the protocol.

| WP | Owns | Acceptance tests |
|---|---|---|
| **WP-A: fold, codecs, paths, sim log** | `src/core/{codec,paths,ns,cfg}/**`, `src/sim/{relay,storage,clock,random}.ts` | (1) Every codec round-trips. Canonical re-encode rejects non-minimal input. Malformed ns/cfg frames fold as empty. (2) E1–E12 (§c.14) as unit tests. (3) 10k-op fold fuzz (§l.4) passes 1000 seeds. (4) pathKey: ß/ss, Σ/σ/ς, İ, NFC/NFD, unassigned code points rejected. Table generator reproducible from UCD 15.1. (5) `SimRelay` conformance with relay-wire: contiguous seqs, receipts after broadcasts, dedupe window expiry, older-seq notice, STREAM_RESEND loss, provisional/notice/dropped, feed/read paging, checkpoint CAS + GC, 1 MiB close, rate close, daily limit. (6) `MemStoragePort` crash semantics and tx-inactive detection. |
| **WP-B: planner, merge, disk side** | `src/core/{hash,merge,plan}/**`, `src/engine/{reconcile,blobs,settings,snapshots}/**` | (1) MergeFn properties: no line of disk or crdt is lost (each appears in `text` or `conflictCopy`); identical/one-sided cases exact; bounded on 2M-char inputs. (2) `minimalDiff` applied to crdt0 equals the target, and its edit size is ≤ the line-diff size. (3) One test per planner table row. Brake thresholds and approval id stability. (4) Rename inference determinism (shuffle-invariant). (5) Conflict names always valid. (6) Reconcile job against `SimVault` + `MemStorage` + a stub log: CAS failures re-plan, echo suppression, intents resume at every crash point. (7) Settings projection gates (yaos dir, data.json version). |
| **WP-C: log-side engine** | `src/engine/{store/repo.ts,adapters,ingest,body,sync,runtime}/**` | (1) Crash at every transaction boundary (§e.2): the state reconstructs, no outbox frame is lost, and the cursor never passes an unaccounted seq. (2) Gate: malformed, disallowed types, oversize, causal hole → re-read → freeze; `releaseQuarantine`. (3) Frame builder: per-keystroke cost independent of doc size (benchmark: 5 MB doc, 1000 keystrokes, no `encodeStateAsUpdate` calls), size caps, initial chunking, `bodyUpdateRef`. (4) Provisional adopt/settle/drop, R7 settle, STREAM_RESEND resend, send window. (5) Catch-up with GC'd rows → checkpoint union. Compaction exactness: snapshot = fold of rows ≤ C. Checkpoint CAS outcomes. (6) Smoke against the local relay (`scripts/relay-dev`, e2e/relay/smoke.ts scenarios through `WsRelayPort`). |
| **WP-D: host, protocol carriers, worker, sim runner** | `src/protocol/{workerTransport,inlineTransport}.ts`, `src/engine/workerMain.ts`, `src/host/**`, `src/sim/{vault,workspace,actors,faults,invariants,run}.ts`, `scripts/check-deps.mjs`, esbuild config (worker string bundle) | (1) Worker and inline transport parity on recorded message traces; transfer ownership asserted. (2) Disk executor honours every `WritePrecondition`; rename uses `vault.rename`; trash only. (3) Binding: bind-time merge, no echo loop (update counts), external-reload interception, `docCredit` resync, worker kill mid-typing loses nothing (re-bind merge of the editor text). (4) Lifecycle flush on `pagehide`. (5) Full simulation suite (§l) green on 200 CI seeds. (6) Obsidian smoke on desktop + iOS: the worker starts and IDB opens in the worker (or inline fallback is reported). |

- **Sequencing.** All four start at once against the frozen types.
  - WP-B and WP-C use stubs of each other's functions until the integration week.
  - WP-D's simulation runner integrates last.
  - The first integration milestone is 2 simulated devices, markdown only, with no faults.
  - Spikes on day 1 (WP-D): Blob-URL worker plus IDB-in-worker on Obsidian iOS/Android (OR-1), and `setViewData`
    interception (OR-2).

---

## l. Simulation test plan

### l.1 Actors

All actors run in one Node process with a virtual `ClockPort` and a seeded `RandomPort`.

- **`SimRelay`**: relay-wire semantics. Group commit (300 ms idle / 1500 ms max / 64 KiB), per-stream dedupe window,
  provisional + notice for `b:`/`c:`, receipts after broadcasts, feed/read/checkpoint with GC, limits, daily-limit
  latch, restarts.
- **Device × N (2–5).** Each is engine (inline transport) + host + `SimVault` (case-insensitive or case-sensitive
  profile, Obsidian-like event semantics including per-child folder rename events) + `SimWorkspace` (views,
  a CodeMirror `Text` per view with a ChangeSet undo stack that maps remote changes like CodeMirror's history,
  bound as in §d.3; 2 s save debounce; `setViewData` reloads) + `MemStoragePort` + `SideFilePort`.
- **User actors**, per device: type into open notes (unique tokens), open/close/switch views, create/edit/rename/
  delete files and folders, case-only renames, paste large text, import a folder of files, attachments, settings
  edits. They act only on a running app in the foreground. While a device is down or backgrounded (`hidden`,
  `pagehide`, `freeze`), its user actions are recorded as skips.
- **External-writer actor:** another app modifying files on disk, including files open in editors. It also writes
  while the app is backgrounded. The engine then takes those writes in on resume (§i.4), as one change per file.

### l.2 Seeded faults

- Socket close at random points: before append, after commit before receipt, between provisional and notice. This
  produces drop, duplicate (resend), and cross-device reorder through independent socket delays. The relay keeps
  per-socket order.
- Relay restart → STREAM_RESEND, with unreceipted frames lost.
- Dedupe window expiry before a resend.
- **Crash** at every persistence step: before and after each `StorageTx` commit, between `T_edit` and `append`,
  between a disk write and `T_synced`, inside intents.
- **IDB wipe:** with mirrors, with stale mirrors, without mirrors.
- Offline for long periods, including past ns pruning (> 20k tombstones).
- Clock skew and jumps (wall clock ± days, monotonic intact).
- **Storms:** 2000 renames (folder moves), mass delete (must trip the brake), mass overwrite, 10k-file import.
- **Two devices onboarding** the same vault concurrently: identical, partially different, and case-different paths.
- Vault epoch change mid-session. 4403. Daily limit hit mid-onboarding. 1 MiB oversize injected (poison path).
- Malicious peer frames: malformed, disallowed Yjs types, oversize text, bad checkpoint (must quarantine or be
  rejected without spreading).

### l.3 Quiescence invariants

After healing (all faults off, all online, run until every queue is idle and no timer is pending inside the horizon):

1. **Convergence.** All devices hold the same file set, compared by `(pathKey, leaf display)` on case-insensitive
   profiles and by exact path otherwise.
   - Contents are **byte-for-byte equal**. Generated content is LF-only. A separate CRDT-vs-CRLF test asserts logical
     equality.
   - Every `NsFoldState` encodes to identical bytes, and every body CRDT has the same text.
2. **No lost acknowledged or local edit.** Every token typed into an editor, or written by a user actor to disk, and
   not deleted by a later user action, appears in the converged vault or in a conflict copy. "Acknowledged" means the
   editor buffer was saved, or `T_edit` committed.
3. **Nothing destroyed without a copy.** Every file version that existed on any disk and was not superseded by a user
   edit containing it is present in the vault, in the trash, in a conflict copy, or in a snapshot. Every trash
   happened with a passing precondition.
4. **Fold determinism.** For every device and every candidate seq, the V3 digests match. Folding from any checkpoint
   plus the rest equals the full fold.
5. **Clean state.** Outbox empty, no `held` or `adoptable` records, cursors at head, no frozen docs unless a malicious
   frame was injected, no open intents.
6. **Resource bounds held throughout:** resident docs/bytes ≤ budget (+1 doc), tail ≤ hard rows, live queue ≤ bound,
   no `encodeStateAsUpdate` on the keystroke path (instrumented counter).

### l.4 10k-op fold fuzz (WP-A)

- **Generator:** 3–8 devices emitting random op frames (1–20 ops) against their own lagged view of the fold, with
  random `authorNsSeq` lag.
  - Paths are drawn from a small adversarial alphabet: case variants, ß/SS, NFC/NFD forms, a file vs folder of the
    same name, reserved stems, over-long segments, dots and spaces.
  - It also produces duplicates/resends of past frames at new seqs (inside and outside the ring), malformed frames,
    and `upgradeRules` (rare).
- **Per seed:** 10k ops. After every frame, check every V2 invariant on the state.
  - At 50 random cut points: `decode(encode(state))` folding the rest gives byte-identical final bytes.
  - Folding the same row sequence twice gives identical bytes and identical event streams.
- **Seeds.** CI runs 1000. Nightly runs 100k. A failure reproduces from the seed and minimizes by delta-debugging
  frames.

---

## m. Ported utilities and dropped list

### m.1 Port

Port means copying the logic with tests, adapted to the new types. No runtime coupling to legacy code.
The old client was deleted once the port was done; `adfa7a7:src/...` names its files at that commit
(`git show adfa7a7:src/<path>`).

| Legacy | New location | Notes |
|---|---|---|
| `server/src/shared/markdownCodec.ts` | `src/core/hash/markdownLf.ts` | markdown-lf-v1 canonicalization, logical hash, exact fingerprint |
| `server/src/shared/vaultPath.ts`, `adfa7a7:src/paths/canonicalPath.ts` | `src/core/paths/validate.ts` | Reworked to §c.2 rules (frozen Unicode, reserved stems) |
| `adfa7a7:src/paths/pathCollision.ts` | `src/core/paths/pathKey.ts` (tests) | Collision fixtures only. The key function is new (frozen case fold) |
| `adfa7a7:src/paths/pathCategory.ts`, `adfa7a7:src/sync/exclude.ts` | `src/engine/reconcile/localState.ts` | Exclude patterns, kind classification |
| `server/src/shared/canvasCodec.ts`, `canvasOrdering.ts`, `canvasTypes.ts`, `canvasLimits.ts` | `src/core/hash/canvasCanonical.ts`, `src/engine/reconcile/canvasDoc.ts` | Canonical bytes, Obsidian formatting, ranks, validation |
| `adfa7a7:src/sync/lineMerge.ts`, `threeWayMerge.ts` | `src/core/merge/{myers,diff3}.ts` | Line diff3 core and limits. Policy wrappers dropped |
| `adfa7a7:src/sync/boundedTextDiff.ts`, `diff.ts` (`tryApplyDiffToYText` only) | `src/core/merge/minimalDiff.ts`, `src/engine/reconcile/mergeJob.ts` | Minimal diff + CAS apply. `forceReplaceYText` is **dropped** |
| `adfa7a7:src/sync/dailyLimit.ts` | `src/engine/adapters/relayHttp.ts` (`dailyResetDelayMs`), `src/engine/runtime/relayPolicy.ts` (retry), `src/engine/runtime/dailyLimit.ts` (notice gate + text) | `resetAt` parsing, probe schedule, notice gate |
| `server/src/shared/socketCloseCodes.ts` | `src/engine/adapters/wsRelay.ts` | Mapped onto `RELAY_CLOSE` / `RelayEvent.closed` |
| `adfa7a7:src/sync/settingsSync/{allowlist,dataJsonGate,configDirKey}.ts`, `lwwReconcile.ts` (canonical JSON) | `src/engine/settings/*`, `src/core/cfg/projection.ts` | Allowlist, plugin version gate, canonical JSON |
| `adfa7a7:src/utils/{randomId,sha256,semver,defaultDeviceName,format}.ts` | `src/core/codec/ids.ts`, `src/engine/adapters/webHash.ts`, `src/host/*` | Ids become 16-byte base64url |
| `adfa7a7:src/snapshots/{snapshotService,vaultExport}.ts` | `src/engine/snapshots/snapshotJob.ts` | Zip writing only |
| `adfa7a7:src/onboarding/{provisioningClient,localVaultImport}.ts` | `src/host/ui/pairing.ts`, §j.5 | Pairing HTTP calls. Import is now just "plan L-only files" |
| `adfa7a7:src/settings/{settingsTab,PairDeviceModal,DeviceCredentialsModal}.ts` | `src/host/ui/*` | UI shells only |
| `adfa7a7:src/status/statusBarController.ts` | `src/host/ui/statusBar.ts` | Render `StatusSnapshot` |

### m.2 Deliberately dropped

- **`adfa7a7:src/main.ts`, `VaultSync`, the runtime coordinators** (`runtime/*`: admission, residency, overdue-work
  kernels, connection controllers). Replaced by lanes, budgets, the pure planner and ports.
- **Server-side CRDT and WASM engine** (`@yaos/crdt-engine`, ywasm). Pure JS Yjs only, client-side.
- **Semantic epochs, fenced WebSocket, legacy receipts, bootstrap client** (`semanticEpochTransition`,
  `fencedWebSocket`, `relayReceipts`, `bootstrapClient`, `serverCapabilities`). Replaced by the streams relay
  (relay-wire.md), `vaultEpoch` and the sequence cursor.
- **Frontmatter guard/projection/quarantine family** (`frontmatter*`). Frontmatter is plain text under the one merge
  engine and the ingest gate.
- **Multiple merge/divergence policies** (`bindDivergencePolicy`, `closedFileConflict`, `externalEditPolicy`,
  `preservedUnresolved`, `runtime/reconcile/*` policies, `ThreeWayConflictModal`). One `MergeFn` + conflict copies,
  and no interactive merge UI.
  - `server/src/shared/canvasMerge.ts` is also dropped: canvas uses the same `MergeFn` (§j.2).
- **`forceReplaceYText`** and any whole-text replacement.
- **Full-doc IDB persistence** (`vaultIndexedDb`, `vaultPersistence`, `diskMirror`). Replaced by the snapshot + tail
  + outbox schema.
- **`fileManager.renameFile`** for remote moves.
- **Awareness/cursor presence** (`ownAwarenessProvider`, `deviceCursorColor`). `EditorBindingSpec.awareness = null` in
  v1.
- **Telemetry and observability runtime** (`telemetry/*`, `observability/*`). Replaced by `DiagnosticsBundle`, and
  nothing leaves the device.
- **Plugin install/update flows** (`update/*`, `obsidianPluginInstall`, `pluginIntent`). Not part of sync.
- **Public API** (`publicApi.ts`). Can be re-added on top of `StatusSnapshot` later.
