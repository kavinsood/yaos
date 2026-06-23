# Checkpoint & Journal Architecture

A naive CRDT persistence layer rewrites the entire state graph on every save. To avoid catastrophic write-amplification, KAOS implements a checkpoint and journal architecture.

## Migration reality check (PartyKit -> y-partyserver)

Under the old PartyKit stack, persistence behavior came with hidden infrastructure:

- append-style update logging
- internal chunked storage writes
- periodic update-log compaction

That made large-document survival feel "automatic" even when application code was simple.

During the migration to `y-partyserver`, we initially assumed those durability mechanics were still present because both stacks expose Yjs server primitives and similar integration ergonomics. That assumption was wrong.

`y-partyserver` gives us transport, room wiring, and debounced `onSave()` / `onLoad()` hooks. It does not provide built-in chunked persistence, checkpoint manifests, journal compaction, or state-vector anchoring. Once we verified this at the implementation level, the risk became clear: we were one step away from full-state rewrites on each save and the exact write-amplification failure mode that kills CRDT deployments at scale.

We also validated framework behavior directly: `y-partyserver` gives us `onLoad()` / `onSave()` hooks, but it does not provide automatic persistence chunking like older PartyKit flows.

This was the architectural inflection point: we stopped treating persistence like plugin glue code and treated it like a storage engine problem. In practice, this was the "final boss" of CRDT scaling: write amplification plus hibernation-safe state-vector recovery.

## What we built

We implemented a two-layer persistence model in [`server/src/chunkedDocStore.ts`](../server/src/chunkedDocStore.ts):

1. Checkpoint layer
- full-state snapshot, chunked at 512 KiB
- versioned manifest + pointer indirection
- persisted checkpoint state vector bytes with length and SHA-256

2. Journal layer
- coalesced delta segments appended in sequence
- per-segment manifests + chunked payloads + SHA-256
- global journal metadata (`nextSeq`, `entryCount`, `totalBytes`)

This is chunking at the I/O boundary: the in-memory document can stay monolithic while storage writes are partitioned into bounded segments. The result is an MVCC-like write shape: append small deltas most of the time, periodically compact into a new checkpoint.

## Write path

In [`server/src/server.ts`](../server/src/server.ts), `onSave()` now:

1. Computes current state vector.
2. If state vector matches baseline, skips save (no-op guard).
3. Computes `delta = Y.encodeStateAsUpdate(doc, baselineStateVector)`.
4. Appends delta to journal.
5. Compacts to checkpoint when journal crosses either threshold:
- more than 50 entries, or
- more than 1 MiB total journal bytes.

All persistence writes are serialized through `saveChain` so journal sequence ordering is deterministic.

## Load/recovery path

On load (including post-hibernation):

1. Load and validate checkpoint pointer + manifest.
2. Reconstruct checkpoint bytes from chunks, verify SHA-256.
3. Load and validate persisted checkpoint state vector.
4. Load journal metadata and expected sequence range.
5. Load each journal segment in sequence, verify chunk layout + SHA-256.
6. Apply checkpoint then journal entries in order.

If anything is missing, malformed, out-of-sequence, or hash-mismatched, we fail closed.

## Correctness rules (non-negotiable)

- No partial replay on corruption.
- No out-of-order journal persistence.
- No implicit trust of in-memory baseline across hibernation.
- No oversized single storage operations; batched at 128 keys/op for get/put/delete.

## Why coalesced deltas (instead of per-event appends)

`y-partykit`-style per-event append can be correct, but it generates high operation counts for note-taking workloads.

KAOS chooses coalescing at `onSave()` cadence:

- lower IOPS and lower storage thrash
- much better fit for personal markdown editing bursts
- acceptable durability lag window for this product class

Write-amplification effect (order-of-magnitude example):

- old path: 50 MB vault + one character edit => near full 50 MB rewrite on save
- current path: 50 MB vault + one character edit => tiny coalesced delta append (often hundreds of bytes)

## Limits and what still hurts

Chunking removes the old single-value bottleneck, but it does not make the system infinite:

- large vaults still pay CPU cost for encode/merge/compaction
- replay size affects cold-start latency
- mobile clients still have parse/apply constraints even if transport limits are larger

Cloudflare transport limits improved over time, but network headroom is not the same as client headroom. A large payload that fits in transport can still be expensive for mobile parse/apply and UI responsiveness.

So the architectural ceiling has moved from "immediate storage crash" to "compute and memory behavior at very large scale," which is the correct class of bottleneck for this system.

## Follow-up: what this engine did not solve

Later Durable Object hardening work is worth naming explicitly so future readers
do not over-attribute responsibilities to the checkpoint/journal engine.

The checkpoint/journal design solved the **write-shape** problem for the
monolithic room document. It did not automatically solve:

- full-document decode on websocket schema admission
- observability storage shape outside the document engine
- duplicate room-load work during concurrent cold start

Those issues were addressed separately via:

- lightweight `roomMeta` for schema admission
- bounded per-entry trace storage
- single-flight room load gating

This distinction matters because the storage engine was already correct; the
remaining work lived on the admission, observability, and lifecycle paths.

## Current status

The storage engine now has:

- chunked checkpoints
- state-vector-anchored delta journaling
- deterministic threshold compaction
- strict integrity validation
- serialized persistence ordering

This is the foundation for a production-grade monolithic CRDT backend on Cloudflare Workers.
