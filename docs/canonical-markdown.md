# Canonical Markdown representation

YAOS uses one logical Markdown representation wherever it compares, merges or records note text: reconciliation,
the synced tree and its mirror, stored merge bases, the planner's remote text hash, and conflict copies. The code is
`src/core/hash/markdownLf.ts`.

## Contract

The representation identifier is `markdown-lf-v1`.

Canonicalization performs exactly two transformations:

1. remove one leading Unicode BOM (`U+FEFF`), when present;
2. replace CRLF and lone CR line endings with LF.

It preserves final-newline presence, trailing spaces and tabs, empty content,
and every other Unicode code point. It does not normalize Unicode, trim text,
rewrite YAML, or interpret Markdown.

The reconciler canonicalizes disk text before it reaches a body: the merge job (`src/engine/reconcile/mergeJob.ts`)
and intent resolution (`intents.ts`) decode the file and run `canonicalizeMarkdown` before merging. Materialization
writes the replica's text as UTF-8, so a note written by YAOS holds canonical text. One path does not canonicalize:
a bound editor's reload (`src/engine/compose/boundDisk.ts`, `reload`) merges the text Obsidian put into the view, or
the file decoded as it is when that upload was dropped. Byte-preserving archives (snapshot bundles, including the
pre-restore snapshot) deliberately remain exact disk copies rather than logical note materialization.

## Hash meanings

Every hash below is lowercase hex SHA-256, digested in the engine through `HashPort` (WebCrypto,
`src/core/hash/digest.ts`). Core's pure-JS SHA-256 (`src/core/hash/sha256.ts`) takes only inputs up to
`SYNC_HASH_MAX_BYTES`, such as the empty-content hash. [DESIGN](client-remake/DESIGN.md) §f.1 ("Hashes") is
normative.

YAOS keeps two content proofs separate (`src/core/types.ts`):

- A **`ContentHash`** is the logical hash. For markdown it is SHA-256 over canonical Markdown UTF-8 bytes
  (`markdownContentHash`). Canvas uses `json-canvas-canonical-v1` (`src/core/hash/canvasCanonical.ts`; invalid JSON
  falls back to its exact bytes), and blobs and other files use their exact bytes. It is the hash in:
  - `LocalEntry.hash` (the scan's stat cache) and `SyncedEntry.contentHash` (the merge base), whose difference is
    the planner's `Lc`;
  - the ns ops: `create.contentHash` (the fold's `createHash`; the planner compares it with the empty-content hash
    and with a local file for identical duplicates) and `setBlob.hash` (`NsBlobRef.hash`);
  - `streams.textHash`, the planner's remote hash for a caught-up markdown or canvas replica (after mirror
    recovery, `bodyVersion` is null and the planner compares it with `S.contentHash`, DESIGN §i.5);
  - the `"hash"` write precondition (`DiskExpect`), which guards destructive disk ops;
  - stored merge bases (`baseText`), re-verified against their hash on read (`src/engine/reconcile/store.ts`);
  - the synced mirror side file, which carries each entry's `contentHash` for IndexedDB recovery (DESIGN §e.4).
- A **`DiskFingerprint`** is SHA-256 over the exact bytes on disk (`exactFingerprint`), so BOM and line-ending
  differences stay visible. It is the `"fingerprint"` write precondition of a merge, canvas merge or snapshot
  restore, and the planner refreshes a synced record's stat when the fingerprint moved without a logical change.
  Self-echo suppression keys on size and mtime (`src/engine/reconcile/echo.ts`), not on a hash.

Other digests do not use the Markdown representation:

- Snapshot manifests hash each file's exact bytes, and the bundle digest binds the parts and the manifest
  (`src/core/snap/bundle.ts`). Settings sync compares exact config bytes (`src/engine/settings/`).
- A blob is checked against the plaintext SHA-256 of its bytes after upload reads and downloads
  (`src/engine/blobs/blobQueue.ts`). Its store address is that hash under suite 0 and
  `HMAC-SHA-256(kAddr, sha256)` under suite 1 ([e2ee-design](client-remake/e2ee-design.md) §10.1).

The relay computes and verifies no content hash. It checks only that a blob address is 64 lowercase hex characters
(`server/src/router.ts`, `BLOB_ADDRESS_PATTERN`). Under suite 1 every `ContentHash` travels inside sealed ns frames,
so the relay sees ciphertext and HMAC addresses; under suite 0 frames are not sealed and it can read them. Diagnostics
bundles pseudonymize with `HMAC(kDiag, ·)` under suite 1 (e2ee-design §6.4).

## No versioned hashes

Persisted hashes carry no representation identifier, and nothing converts hashes of another meaning. The remade
client keeps no state from the old client, and moving from a pre-rewrite server is a fresh deployment in which each
device re-seeds the vault from its files ([operations](operations.md), "Fresh-deployment boundary"). Changing the
representation later would need a new identifier and a migration of the synced tree, stored bases and mirrors.
