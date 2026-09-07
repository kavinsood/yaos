# Durable common bases and three-way merge

Status: implemented for RFC 06 and RFC 07, 6 September 2026.

## Authority rule

A candidate receipt proves that exact candidate bytes became durable. A disk write proves that bytes reached one local path. Neither fact alone proves common ancestry.

A common base advances only after YAOS proves all three authorities agree:

1. the current server head identifies the active body, content hash, and non-regressing durable generation;
2. the loaded body is clean, has no pending updates/candidates, and still matches its captured document/path proof;
3. an exact disk read has the same canonical content and records the raw byte length/hash used for self-echo evidence;
4. the record is committed with a local compare-and-swap revision.

Every await is followed by revalidation. Uncertainty produces missing/invalid ancestry or a superseded settlement, never invented agreement.

## Record

The generation-scoped local database stores one record per body ID:

```text
format
bodyId
vaultGeneration
canonicalVersion = markdown-lf-v1
content + contentHash
durableGeneration + serverContentHash
diskFingerprint { bytes, hash }
pathAtSettlement
localSettlementRevision
settledAt
```

Content is reconstructible, not merely named by a state vector. `pathAtSettlement` is diagnostic/projection evidence, never the durable key. The database itself is already scoped by local folder and vault generation.

Reads return `available`, `missing`, or `invalid(reason)`. Invalid reasons distinguish identity, vault generation, codec version, malformed hashes/fingerprints, noncanonical content, corrupt content, bad path, generation, revision, and timestamp.

IndexedDB performs read/compare/put in one read-write transaction. SQLite performs the same operation inside `BEGIN IMMEDIATE`. Late settlement work therefore cannot overwrite a newer local proof. Durable server generations may not regress.

## Bootstrap and backfill

The bootstrap body serialization map remains the single-flight owner. The fast path now requires a valid settlement matching the body, current server head, path, generation/hash, canonical disk content, and exact disk fingerprint. A clean cached document alone is insufficient.

Backfill is allowed only from present agreement. After body materialization YAOS reacquires the current head, exact disk evidence, and body projection proof, then CAS-writes the base. This establishes ancestry from agreement without claiming to recover unknown history.

Rename retains the body-keyed base and refreshes `pathAtSettlement` after the renamed disk projection agrees. Delete leaves the tombstoned base available for conservative delete/revive reasoning. A later same-path create has a new body ID and cannot inherit it.

## Merge protocol

Closed-body divergence runs this protocol:

```text
read typed common base
→ capture exact disk and current body text
→ bounded pure diff3
→ revalidate path/body/content proof
→ safe targeted body commit
→ durable candidate receipt
→ return replan
→ fetch the newly current server head
→ materialize exact merged body to disk
→ verify server/body/disk agreement
→ CAS-advance common base
```

Returning `replan` after the candidate receipt is essential. Treating the merge as if it still belonged to the old head would make bootstrap's head-after check discard the freshly merged state.

## Pure merge outcomes

The pure engine reports:

- identical;
- disk-only;
- body-only;
- clean merged;
- overlapping conflict;
- too large by input or edit-count bound.

Missing/invalid base, superseded proof, and blocked frontmatter are orchestration outcomes around the pure engine.

The diff3 implementation builds connected components of the cross-side overlap graph. A broad edit intersecting several opposite-side edits produces one transitive review region rather than overlapping conflict hunks. Disjoint edits remain targeted. Default bounds are 2 MiB per text and 10,000 edits per side.

## Conflict preservation and review

On overlap YAOS leaves the original disk file untouched, writes the synchronized body alternative to the existing conflict-artifact channel, marks the body decision-required, and durably records the path as preserved-unresolved. Ordinary writeback refuses preserved paths, so a later remote update cannot silently erase the disk side.

Obsidian then offers hunk review. Every hunk starts unselected; Apply stays disabled until all choices are explicit. The session captures the disk/body/path proof and returns no resolution if that proof becomes stale. A chosen resolution commits through the same safe candidate path; it does not mutate `Y.Text` from the modal. Headless CLI deliberately has no modal and keeps artifact plus preserved-unresolved state.

Frontmatter guard runs before disk mutation. Unsupported structured ambiguity remains blocked rather than being normalized by character diff3.

## Crash boundaries

Safe restart behavior is declared at each boundary:

- before candidate receipt: the durable candidate remains replayable and the old base remains;
- after receipt but before disk write: the new head rematerializes, old base remains;
- after disk write but before base CAS: exact agreement backfills on the next pass;
- after a losing CAS: the winner is reread and work replans;
- after conflict artifact but before review: original disk plus artifact and preserved registry remain;
- during review: no state changes until a revision-fenced resolution is submitted.

## Test matrix

Coverage includes typed invalid/missing states, content corruption, hash disagreement, generation regression, losing CAS, IndexedDB restart, SQLite restart and stale writer, verified bootstrap backfill, fenced fast path, rename/path identity, disjoint merge, identical edits, same-position insertion conflicts, transitive overlap coalescing, explicit resolution, and size bounds.

## Non-goals

- YAML/frontmatter semantic merge is RFC 11;
- binary and attachment merge semantics remain schema-6 attachment concerns;
- conflict-session persistence is unnecessary because the durable artifact and preserved registry are the restart contract;
- diff3 does not infer ancestry when the base is missing or invalid.

## Definition of done

- ancestry is reconstructible, versioned, typed, and CAS-protected in both clients;
- bootstrap cannot skip base backfill using only clean local cache facts;
- candidate or disk evidence alone never advances a base;
- disjoint offline edits converge through a durable candidate and new-head replan;
- overlaps preserve both alternatives and block normal writeback;
- UI resolution is explicit and becomes stale safely;
- headless behavior remains conservative and restart-safe.
