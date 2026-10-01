# RFC: Relay Markdown body updates

Status: **draft** (relay v2 spike, branch `relay-v2-spike`, base `5dd32f3`). Sections 1, 2, 8, 9 and 14 still
contain `<<MEASURED: …>>` placeholders. Each one names the full-n scenario id that fills it (raw output:
`experiments/results/relay2/raw/<id>.json`). All other sections are complete.

What this RFC describes:
- The server implementation as committed through `7feae39` (round 4) on 2026-10-01. Earlier rounds: `20e0e34`/`e1abb36`
  (round 1), `54cee51` (round 2), `4cdc37e` (round 3). Harness: `35b2882`, `276c16c`, `66fb78c`. Nothing described
  here is uncommitted. The earlier "(WIP)" marks are gone.
- Full-run configurations (`scripts/relay2/runall.sh`):
  - **relay** (the v2 candidate) = `YAOS_RELAY_BODIES=true` + `YAOS_RELAY_LEAN_ROWS=true` + `YAOS_RELAY_MICROBATCH_MS=10`
  - **relay-strict** = relay on, lean off, mb 0. This is the per-frame transaction variant, run for L2, L4, C1, C2,
    C4, B7, X2 and the MB sweep.
  - **base** = flag off, same vars (inert)
  - All three set `YAOS_RELAY_RESET_COOLDOWN_MS=0`.
- Cited line numbers drift. Function names are the stable reference.
- The contract document is [`relay2-protocol.md`](relay2-protocol.md). Where the two differ, the code wins, and the
  difference is called out.

Evidence labels:
- **measured**: taken on a deployed Worker or in a local run, with n and the scenario ID.
- **inferred**: derived from measurements through a stated model.
- **code**: read from `server/src`.

## 1. Summary and recommendation

<<MEASURED: final recommendation after L1–L7, C1–C6, B1–B8, X1–X4, K1–K3 at full n (all ids in raw/)>>

Draft position, based on small-n and component evidence: **go with conditions**.

1. On the propagation path the relay is at or near the network floor.
   - Small-n L2 p50 (measured, scratch / scratch-3, n = 30): relay 90 ms, base 412 ms.
   - Small-n MB smoke (measured, v0930): at mb10, propagation p50/p90 is 65/74 ms (l2) and 62/68 ms (burst), against
     base 310/403 and 301/413.
   - The relay path also survives hibernation and scales past the base 32-socket cap.
2. Conditions:
   - Write amplification fits the Workers Free rows-written budget (section 9). Lean rows cut the per-append cost to
     3 CF rows (plain) or 5 (candidate), measured on corelean-1. The typical-day model then sits at 47–65% of
     100k/day (inferred). It is 85% if the smoke per-edit rows (7.26) hold at full n.
   - The feed-floor gap G1 is fixed (round 3) and measured in the unit suite. Full-n confirmation comes from K1 and
     `C2-stress-relay` table counts.
   - The unenveloped-client lazy-hash path (G4) has its bounds proven. It is capped at 3 MiB, with a 256-body
     lazy-hash cache.
   - Socket-ack receipts are integrated into `VaultSync` (section 11, phase 2).
   - The micro-batch default is mb 5–10 (round 4). Strict mb 0 has 0.4–2 s p90 tails behind the checkpoint alarm.
3. Semantic reset moves to clients under a lease. That is a prerequisite for large notes, because only clients can
   compact past the 96 MiB Wasm cap.
4. ywasm stays on the server, for the root document, Canvas semantic documents and the base fallback. It leaves the
   Markdown body hot path.
5. Reversal conditions are listed in section 13.

## 2. Problem

Today the authoritative body path puts the following on every body frame:
- a resident ywasm document, plus a validation mirror document
- a debounced flush
- a second write path: the HTTP candidate, which carries the same bytes

The costs below were measured before this spike.

| Cost | Evidence | Label |
|---|---|---|
| Keystroke propagation p50 ≈ 300 ms, set by the 250 ms `PERSIST_DEBOUNCE_MS` flush plus commit and broadcast | A3: 306 ms propagation, 301 ms body sync. v1 relay L2: 300 → 52 ms (A5) | measured |
| Idle storm before phase 0: ≈160k billed DO requests/day for 3 idle devices, 1.6× the DO free tier | A1: 1,430 reconnects per socket per day; `1008 socket authority mismatch` on every ping after a wake | measured + inferred |
| Body sockets capped at 32 per vault (`MAX_BODY_SOCKETS`, the 48 MiB / 96 MiB Wasm envelope) | A3: the 33rd socket gets 429. Harness X1 (base): 429 `body_socket_limit` at #33 | measured |
| Resident memory grows with open bodies: 32 × 512 KiB adds 36 MB of Wasm on base; flat on relay | A5 C3 | measured |
| CPU per keystroke on a heavy note: 19 ms base against < 1 ms v1 relay | A5 C1 | measured |
| Hibernation: base closes body sockets with 1008 on the first edit after DO eviction. Reconnect ≈ 1.33 s against 351 ms warm | A5; harness B1 (base, scratch-2) | measured |
| Time from edit to cleared settled receipt p50 is 531 ms. The debounce accounts for 250 ms of it and the candidate POST for ≈ 280 ms | L5 baseline, D8, n = 14, scratch-2 | measured (small n) |
| Every Worker → DO hop costs ≈ 44–47 ms; a HEAD is 4 hops at ≈ 215 ms | A2/A4 | measured |

Baseline tables for this spike, flag off, same code and harness:

| ID | Metric | Base p50 / p90 / p99 | n | Date | Worker |
|---|---|---|---|---|---|
| L1 | ping RTT | <<MEASURED: L1-base>> | 100 | | |
| L2 | propagation A→B, 4 KiB | <<MEASURED: L2-base>> (small n: 412 ms p50, n = 30, scratch) | 300 | | |
| L3 | propagation, 64k chars, after the quick trace | <<MEASURED: L3-base>> | 50 + 50 | | |
| L4 | per-frame at 25 edits/s | <<MEASURED: L4-base>> (small n: 293 / 458 ms, n = 300, scratch) | 5,000 | | |
| L5 | edit → cleared receipt | <<MEASURED: L5b1-base / L5b8-base, modes prod + nodebounce>> (small n: prod 531 ms, nodebounce 277 ms, n = 14, scratch-2) | 100 | | |
| C1 | CPU per keystroke, small / heavy | <<MEASURED: C1-base>> | ≥ 40 each | | |

The base suites pass on the base SHA (measured, `base-tests.md`):
- `test:regressions`: 179/179 suites, 3,135 assertions, 59 s
- node-runtime: 32/32
- conformance: 26/26, with 1 declared GAP
- headless: 92/92, with 1 of 4 runs flaky ("rename retires the old active path")
- pack-smoke fails under `npm run` because of an environment leak. This is pre-existing.

## 3. Product constraints and how they shaped the design

| Constraint (brief §1.2) | Consequence in this design |
|---|---|
| **Local-first; disk is the user-visible truth; the server is not the only copy.** | The server can be a durable ordered mailbox, not a judge. It stores and orders bytes, fences on authority and epoch, and relays. Validation of body content moves to the receiving client before its disk write (section 5), because that client owns the disk. Losing the server's semantic view is acceptable only because every device holds the full text. |
| **Few clients × many documents** (1–5 devices; hundreds to tens of thousands of notes). | Per-note server state must be cheap and bounded by bytes, not documents. Relay sockets carry no resident document. The only cache is a byte LRU (`YAOS_RELAY_MERGED_CACHE_BYTES`, 16 MiB) keyed by head sequence. The socket cap is a config value (default 5,000), not a memory envelope. Bootstrap and catch-up read stored bytes and never build a document. |
| **Idle most of the day, Obsidian left open.** | Hibernation must be invisible. Relay sockets are exempt from the `runtimeEpoch` fence (the attachment records the admission epoch), so a woken DO keeps serving the socket (B1). No debounce timers are needed. An alarm is armed only when a tail crosses the checkpoint threshold. A fully idle vault does no SQL writes. |
| **Self-hosted on the user's Cloudflare account, aiming for $0.** | The free tier is a hard constraint on request counts and rows written (section 9). It drove these choices:<br>• one transaction per append, with no extra rows (`vault_operation_outcomes` is not written)<br>• the growth cap, so resends become no-ops rather than rows<br>• micro-batching (0..250 ms; recommended 5–10)<br>• lean rows: no clock write, inline attribution and hash, coalesced catalog events. That is 3 CF rows per plain append instead of 9.<br>• checkpoints bounded to 200 rows per pass<br>It also exposed the main risk: the relay writes one append per frame (or per micro-batch), where base writes one per 250 ms window (section 12, R5). |
| **Devices may all be phones; nothing may require a desktop.** | Server-side semantic compaction is replaced by a client lease, so the work must be feasible on a phone.<br>• K2 measured desktop reset build times of 12–98 ms p50 (n = 10).<br>• Mobile-class ×4–6 is inferred at 48–586 ms, with a duty-cycle pessimistic bound of 1.7 s p50 for 5 MB.<br>• The routine checkpoint stays on the server as a byte merge that needs no client.<br>• Any device may take the lease; none is privileged. |
| **Devices are usually close to the DO; mobile networks and travel exist.** | Receipts ride the socket ack, so there is no second HTTP round trip. Catch-up and bootstrap stay HTTP-batched. Retries are idempotent through `candidateId` receipts. The lease TTL (120 s, up to 600 s) and the binary reset upload reflect slow mobile uploads: a pre-round-2 JSON upload of 5 MB took 115.7 s (B5). After round 2, a binary 5.24 MB reset takes 1.7–3.3 s from a desktop (core3, n = 4). |

## 4. Design

### 4.1 Scope and flag

- The flag is `YAOS_RELAY_BODIES === "true"` (`relayFlag.ts` `relayBodiesEnabled`). With it on, Markdown body sockets
  use the relay path. A body is a relay body when it is not `root` and has a catalog head (`server.ts` `isRelayBody`).
- Out of scope:
  - root sockets (download-only)
  - Canvas semantic sockets (`/ws/semantic`)
  - lifecycle HTTP routes, i.e. create, rename and delete, including the creation-candidate fence
- The Node host reads the same flag (`packages/server-node/src/index.ts`).
- The capability `relayBodies: 2` is advertised in `VAULT_READY.capabilities` and in `/api/capabilities`.
- The socket URL does not change: `/ws/body/:bodyId`, with a ticket bound to the body epoch.

### 4.2 Data model

The relay reuses the storage-4 tables. It adds two lazily created tables. Lean mode also adds nullable columns to
`vault_journal`.

| Table | Relay use |
|---|---|
| `vault_clock` (single row) | Default: one `sequence + 1` per append. This is the vault-wide total order. Lean: not written per append. The sequence is `MAX(vault_clock, MAX(journal.sequence)) + 1`, and `syncLeanClock` raises the clock before any journal delete, so a sequence is never reused. |
| `vault_journal` (`sequence`, `document_id`, `generation`, `semantic_epoch`, `kind`, `update_byte_length`, `data`, `created_at`; index `(document_id, sequence)`) | One row per append, kind `'body'`, raw Yjs v1 update bytes of at most 1,750,000 B (`MAX_DURABLE_UPDATE_BYTES`). A reset writes kind `'semantic-reset'` with zero bytes. Lean adds nullable `attr_*` columns (frame-0 attribution) and `relay_content_hash`/`relay_size` (the accepted hash), via a lazy `ALTER TABLE` in `enableLeanRows`. |
| `vault_mutation_attribution` | Default: one row per frame in the append, holding principal, membership revision, device, credential revision and `request_digest`. A candidate frame carries `operation_id = candidateId` and `request_digest = candidateDigest` (G14, round 3), so `/operations/:id/outcome` resolves. Lean: frame 0 is inline on the journal row, and only frames 1..n of a micro-batch get rows. |
| `vault_document_heads` | `generation + 1` and `latest_sequence` per append. Epoch changes happen only through reset. |
| `vault_catalog_events` | Default: one row per append, holding path, lifecycle `active`, generation, epoch, and `content_hash`/`size` (NULL when no claim was accepted). Lean: written by the delayed relay alarm, one event per dirty body per pass (`coalesceLeanCatalog`). Readers overlay the newest journal row (catalog-head overlay). |
| `vault_candidate_receipts` | One row per enveloped frame that carries a `candidateId`: `(body_id, client_id, candidate_id)` → digest, epoch, generation, sequence, runtime epoch. Pruned by the alarm (`pruneCandidateReceipts`). Kept in lean mode. |
| `vault_checkpoints` + `vault_checkpoint_manifests` | Byte-merged snapshot, chunked. Written by the checkpoint and by reset. The 3 newest checkpoints of the current epoch are kept, and pins are respected (`pruneUnpinnedDocumentHistory`). |
| `vault_semantic_compaction_state` | Reset cooldown source (`last_compacted_at`). |
| **`relay_compaction_leases`** (new) | `body_id` PK, `lease_id`, `device_id`, `principal_id`, `body_epoch`, `expires_at`, `created_at`. Created lazily by `RelayBodyStore.ensureLeaseTable`. Rows are deleted on revocation and fence (G19). |
| **`relay_body_budget`** (new, round 3) | Persisted over-budget marker per body (G20). It survives eviction, so the alarm does not retry a merge that is known to be too large. Keyed by epoch, so a reset (new epoch) clears it. |

Nothing is migrated. With the flag off the lease table is never created. With the flag on, base tables are written
with the same meanings as base, so a vault can move between modes only on a fresh install (section 11).

### 4.3 Wire protocol

**Frames on a relay body socket** (`vaultSocketService.ts` `relayMessage`):

| Direction | Frame | Handling |
|---|---|---|
| C→S text | `BODY_UPDATE_ENVELOPE` JSON: `clientFrameId`, `payloadDigest` (sha256 hex of the next binary update), optional `candidateId`, `candidateDigest`, `contentHash`, `size`, `stateVector` (base64) | Held in `pendingEnvelopes[socketId]` (memory only) and paired with the next binary SYNC_UPDATE on that socket when the digest matches (`relayBodies.ts` `handleControl`, `handleSyncFrame`). A mismatch drops the pairing (`envelopeMismatches`). The frame is still appended, unenveloped. |
| C→S binary | y-protocols `MESSAGE_SYNC` step1 / step2 / update | step1 → step2 served from bytes (4.5). step2/update → append (4.4). |
| C→S binary | awareness | Relayed through `relayAwareness`; not stored. |
| C→S text | `VAULT_PING`, `BODY_CURRENTNESS_QUERY` | Both re-validate the actor. The ping answers with the admission `runtimeEpoch`. Currentness answers from `currentBodyHead` (the hash may be null). |
| S→C text | `VAULT_READY` | Includes `capabilities.relayBodies: 2`. |
| S→C text | `BODY_COMMITTED` (origin) | `relay: true`, `clientFrameId`, `vaultSequence`, `durableGeneration`, `candidateId`/`candidateDigest`, `payloadDigest`, `runtimeEpoch` (admission), `commitRuntimeEpoch`, `contentHashAccepted`, `deduped`, `noop`. |
| S→C binary + text | peer fan-out | Raw SYNC_UPDATE with the same bytes, plus `BODY_COMMITTED` with `relay: true, peer: true`. The origin is excluded. |
| S→C text | `BODY_UPDATE_REJECTED` | Reason `candidate_id_reused`: the same `candidateId` was sent with a different digest. |
| S→C text | `VAULT_BACKPRESSURE` | Reason `relay_rate_limit`, followed by close 1013. |
| S→C text | `VAULT_ERROR` | Code `durability_failed`, followed by close 1011. Code `relay_frame_error` (round 4), followed by close 1011. |

**Close codes:**

| Code | Meaning |
|---|---|
| 4409 | Epoch fence. Carries the current epoch; the client rebases. |
| 4403 | Authority superseded (revocation, membership change). Since round 3 this also covers step1 (G6) and micro-batch flush (G2). |
| 1013 | Our rate limit: reason `relay rate limit`, always preceded by `VAULT_BACKPRESSURE` (`rateLimitCloses`). Base also sends 1013 with `semantic compaction pressure`, `body cache budget exceeded` or `pending durability budget exceeded`. **Reason `Service overloaded` or an empty reason is the Cloudflare platform** shedding an overloaded DO. The server never sees those closes and no counter moves. The transient 1013 seen in K1 (mb 0 flood) was the platform. |
| 1009 | Frame larger than 1.75 MB. |
| 1008 | Body not active or deleted. |
| 1011 | Commit failed (`commitFailures`), or **relay frame error** (round 4): any throw before the append, on the socket path or the micro-batch timer path (`frameErrors`, `lastFrameError`). Before round 4 a throw in `relayMessage` sent `VAULT_ERROR` and kept the socket open, which silently lost the frame. |
| HTTP 429 | At upgrade, when relay + semantic sockets would exceed `YAOS_RELAY_MAX_BODY_SOCKETS`. |

**No silent drops (round 4).** Every non-empty update frame has exactly one counted outcome. Diagnostics expose the
identity:

```
updateFrames = appendFrames + noopSkips + dedupeHits + dedupeConflicts + batchDuplicateCandidates
             + authorityCloses + authorityDrops + rateLimitCloses + epochFences + bodyInactiveCloses
             + tooLargeCloses + commitFailures + frameErrors
```

A random-interleaving unit test checks it at mb 0 and mb > 0. Throws after commit are counted (`postCommitErrors`) and
never skip a peer's fan-out. The harness checks the identity on every full-n run's diagnostics delta.

**HTTP routes added:**
- `POST /vault/:id/body/:bodyId/compaction-lease` and `POST …/semantic-reset`. Both need the
  `vault.content.write` capability. See 4.9.
- `HEAD /body/:id`.
- Test-only: `/__yaos/test-only/relay-table-counts`.

`GET /body/:id` (and HEAD) gain `x-yaos-head-sequence` and `x-yaos-content-hash-state` (`known` | `materialised` |
`unknown`).

### 4.4 The append

Order of operations, as implemented through round 4. Code: `relayBodies.ts` `handleSyncFrame` then `commitFrames`,
and `relayBodyStore.ts` `appendRelayBodyUpdate`.

1. **Size.** More than 1,750,000 B closes the socket with 1009 (`tooLargeCloses`).
2. **Envelope pairing.** `sha256HexSync(update) === pending.payloadDigest`. A mismatch counts in `envelopeMismatches`,
   and the frame is treated as unenveloped.
3. **Empty skip.** `[0,0]` or zero bytes: no append (`emptySkips`, outside `updateFrames`). An enveloped frame gets a
   `noop` ack.
4. **Authority** (before dedupe since round 3, G7). `validateActorCached`. The cache is keyed by the full actor tuple
   and invalidated by `authorityVersion`, which every in-process authority writer bumps (revoke, membership, authority
   fence). The TTL is 5 s. Failure closes with 4403 (`authorityCloses`).
5. **Candidate dedupe.**
   - Look up `vault_candidate_receipts(body, device, candidateId)`.
   - Same digest: re-ack with the stored receipt (`deduped: true`, `dedupeHits`).
   - Different digest: send `BODY_UPDATE_REJECTED` (`dedupeConflicts`).
6. **Budget.** A per-socket token bucket:
   - 256 KiB/s
   - burst `max(YAOS_RELAY_BURST_BYTES, 1.75 MB)`, so that any legal frame can pass (round 2)
   - empty bucket: `VAULT_BACKPRESSURE`, then 1013 (`rateLimitCloses`)
7. **Optional micro-batch** (`YAOS_RELAY_MICROBATCH_MS`, default 0, clamped to 0..250; it was 0..50 before round 3).
   - Frames are queued per **(bodyId, epoch)** (G3), and the batch is merged with `mergeUpdateBytes` at commit.
   - At flush, every frame's actor is re-validated (G2). A revoked frame is dropped and its socket gets 4403 once
     (`authorityDrops`).
   - A duplicate `(device, candidateId)` inside a batch (G11) is re-acked if the digest is the same, or rejected if it
     differs (`batchDuplicateCandidates`).
   - `semantic-reset` flushes the body's pending batches before its CAS.
   - Recommended: mb 5–10, which is the full-run relay config (mb 10).
8. **Epoch check** against the head, per batch. The merged cache revalidates against the head row. A mismatch fences
   the batch's frames with 4409 (`epochFences`).
9. **Growth cap.**
   - Merged body ≤ 256 KiB (`EXACT_MERGE_BYTES`): exact merge. The append is a no-op if and only if
     `mergeUpdates([merged, update])` is byte-equal to `merged`. The SV is exact.
   - Larger bodies: the append is a no-op only if the update is byte-identical to the last update (≤ 64 KiB kept).
     The next SV is the pointwise max of the head SV and the update's SV, flagged `stateVectorExact = false` (G8).
   - A no-op is acked `noop: true` and writes no rows (`noopSkips`).
10. **Currentness (D6 #7).** The newest paired envelope whose `stateVector` equals the next merged SV contributes
    `contentHash`/`size`, but only if the SV is exact (G8, round 3: a body over 256 KiB never accepts a claim).
    Otherwise the hash is NULL.
11. **One `transactionSync`**, `appendRelayBodyUpdate`:
    - read `vault_document_heads`: exists, epoch == expected
    - read the latest `vault_catalog_events` (lean: plus the overlay): `active`, `file_id` matches, no
      `vault_creation_candidates` row
    - default: `UPDATE vault_clock SET sequence = sequence + 1 RETURNING sequence`. Lean: `MAX(clock, journal max) + 1`,
      with no write.
    - `INSERT vault_journal (…, 'body', bytes)`. Lean also writes the inline `attr_*` and `relay_content_hash`/`relay_size`.
    - attribution: N × `INSERT vault_mutation_attribution` by default, frames 1..n only in lean
    - `UPDATE vault_document_heads SET generation = generation + 1, latest_sequence = seq`
    - catalog: `INSERT vault_catalog_events (…, content_hash|NULL, size|NULL)` by default. Lean defers it to the
      coalescing alarm.
    - 0–N × `INSERT vault_candidate_receipts … ON CONFLICT DO NOTHING`

    **Measured CF rowsWritten per append** (index writes included; `scripts/relay2-core-smoke.ts`, n = 20 acked edits
    per frame kind; diagnostics `rowsWritten` delta):

    | Mode | Plain frame | Candidate frame | Worker |
    |---|---:|---:|---|
    | default | 9 | 11 | `yaos-relay2-coresmoke-1` |
    | lean | 3 | 5 | `yaos-relay2-corelean-1` |

    Local node rows, amortised over a checkpoint pass (`relay2-core-alarmprobe.ts 750 30`): lean 2.13 against default
    5.07 per append (measured, local). The lean coalescing pass writes 3 rows per dirty body per pass.
12. **After commit only**, in this order:
    1. update the merged cache entry
    2. `syncDocumentCache`. Since round 3 (G5) it never applies the update to a resident base doc. It discards a clean
       resident; a dirty resident is left stale and counted (`residentStaleSkips`).
    3. origin `BODY_COMMITTED`
    4. peer fan-out of the same bytes, at the same epoch, excluding **every** origin of the batch (G16)
    5. `notifyBodyCommitted`
    6. arm the checkpoint alarm if the tail is ≥ 50 rows or ≥ 1 MiB. Lean arms it on every append, delayed by
       `YAOS_RELAY_LEAN_CATALOG_DELAY_MS` (2 s).

    A throw in any of these steps is counted (`postCommitErrors`) and the remaining steps still run.
13. **On a commit exception:** `VAULT_ERROR durability_failed`, close 1011 (`commitFailures`), invalidate the cache. A
    throw anywhere before the append closes 1011 too (`frameErrors`). The client resends on reconnect, and the growth
    cap or the receipt deduplicates the resend.

The default relay writes the same row set that base writes per debounced flush (flag-tests.md). What changes is how
often: once per frame or micro-batch, instead of once per 250 ms window per body. Lean mode removes the clock write,
the frame-0 attribution row and the per-append catalog event.

### 4.5 Step1/step2, catch-up, bootstrap, currentness

- **Step1.** The server sends step1 with the head SV at accept. A client step1 is authority-checked first (G6,
  round 3: a revoked actor gets 4403, not the body), then gets `step2 = diffUpdateV1(merged, clientSV)` from stored
  bytes (ywasm stateless op, patch 0003,
  `crdt/ywasmByteOps.ts`). No document is created.
  - Merged bytes are cached. They are rebuilt with `durableMergedBytes` (latest checkpoint plus journal rows after the
    checkpoint, up to the head, merged). The rebuild throws if the journal crosses an epoch without a checkpoint.
  - Above `YAOS_RELAY_MAX_MERGE_INPUT_BYTES` (9 MiB) the server does not merge. It sends the stored parts
    as one step2 per part (`replyStep2Unmerged`), and clients merge idempotently.
- **Catch-up** (`POST /catch-up`) and **GET body** use `relay.bodyHttpState`: merged bytes plus the catalog hash.
  - If the catalog hash is NULL and the body is ≤ `lazyHashMaxBytes` (3 MiB), the server materialises it
    once: `reconstructDocument` (a ywasm Doc) → `readText("body")` → canonical Markdown → sha256 →
    `backfillCatalogHash` (UPDATE only while the hash is still NULL; lean mode updates the journal row's inline
    hash). Round 3 (G4) adds a 256-body in-memory cache keyed by (epoch, head sequence), so repeated reads of an
    unchanged unenveloped body do not rebuild the Doc (`lazyHashCacheHits`).
  - Above that size the hash state is `unknown`.
  - An over-budget body returns 413 `relay_merge_budget_exceeded`.
- **Bootstrap.** With the flag on, `bootstrap.ts` serves `durableMergedBytes(bodyId, boundarySequence)` as a byte
  merge (round 2). Round 3 (G20) checks the persisted budget marker and returns 413 **before** reserving the batch, so
  one over-budget note no longer fails a reserved batch midway. The protocol doc was aligned in round 3 (G17).
- **Currentness.** `BODY_CURRENTNESS_QUERY` and `HEAD /body/:id` read the head row and the catalog, with no merge and
  no document. The hash may be `unknown`.

### 4.6 Checkpoints

- **Trigger.** Default mode: an append that pushes the tail to ≥ 50 rows or ≥ 1 MiB arms the alarm. Lean mode: every
  append arms the alarm, delayed by `YAOS_RELAY_LEAN_CATALOG_DELAY_MS` (2 s), so a burst coalesces into one pass.
- **`alarm()` → `runCheckpointPass`** (round 3, G1), in this order:
  1. Lean only: `coalesceLeanCatalog` writes one catalog event per dirty body (3 rows per dirty body per pass).
  2. Evict stale residents.
  3. For each relay body over the thresholds that is neither a dirty base resident nor marked over budget, call
     `relay.checkpointBody`.
  4. Set `floor = min(currentSequence − 1000, pinBoundary − 1 for every active pin)`. When that is above the current
     floor, call `advanceFeedFloor(floor)`. This prunes journal rows at or below the floor that a complete checkpoint
     covers. The floor does not advance if lean coalescing failed.
  5. Prune candidate receipts.

  The base `maintain()` loop now runs only for non-relay bodies. Measured in the unit suite: 5,000 relay appends leave
  1,001 journal rows (floor 4002, 41 floor advances).
- **`checkpointBody`.**
  - If the tail is more than 200 rows, it merges only the first 200 (`tailPrefixSequence`) and writes a **partial**
    checkpoint (`writeRelayCheckpointThrough`, `requireExactHead = false`). The partial prefix is itself checked
    against the merge budget (G20).
  - Otherwise it writes an exact-head checkpoint.
  - **`checkpointsFromCache`** (round 4): when the merged cache entry is at the head, a full checkpoint uses those
    in-memory bytes and skips the SQLite read and the Wasm merge. Local pass time for a 30 KiB body fell from 3.3 ms to
    1.8 ms (measured, local).
  - Merges happen only through the stateless byte ops. Past the 9 MiB merge budget the body is skipped and marked in
    `relay_body_budget` (persisted, G20) until a client reset.
- **`persistCheckpoint`** runs as one transaction:
  1. write the chunks and the manifest
  2. `assertActivePinRetainedCheckpointCapacity`
  3. delete journal rows ≤ `min(through, journalFloor())`. Lean mode calls `syncLeanClock` first.
  4. `pruneUnpinnedDocumentHistory`
- The alarm re-arms immediately while a checkpoint is partial or still needed.
- The base `writeLiveCheckpoint` path routes relay bodies to the same function.
- **Alarm cost and mb 0 tails** (round 4, deployed small n): a pass is about 60 ms CPU, with 0.5–4 s wall time
  deployed. At mb 0 each frame is its own transaction plus an output-gate flush, and frames queue behind the alarm.
  That is the source of the 0.4–2 s p90 at mb 0 against about 68 ms at mb 10 (MB smoke, v0930). Full-n:
  `MB-relay-{lean,full}-mb{0,10,50,100,250}`.

### 4.7 Receipts

- A receipt is the origin `BODY_COMMITTED` for an enveloped frame. It is sent only after the transaction commits.
- It carries `vaultSequence` and `durableGeneration`, plus `candidateId`/`candidateDigest` when the frame had them.
  The same row lands in `vault_candidate_receipts`, so an HTTP candidate replay or a socket resend of that candidate
  resolves to the same receipt. Since round 3 (G14), `GET /operations/:candidateId/outcome` also resolves. It uses the
  attribution `operation_id` by default, or the inline journal columns in lean mode.
- D7: `src/sync/vaultSync.ts` is not modified in this spike. The harness implements socket-ack receipts
  (`scripts/relay2/lib/socketReceipts.ts`).
- Integration sketch:
  - `VaultSync.create({ webSocket })` receives a WebSocket factory, and the relay wrapper's `send()` injects the
    envelope before each binary update. `sync/fencedWebSocket.ts` is the natural home.
  - The candidate observer maps each IDB candidate to `candidateId = candidate id`, `candidateDigest = candidate
    digest` and `clientFrameId`.
  - The candidate is cleared on the relay `BODY_COMMITTED` whose `candidateId` and `candidateDigest` match. The HTTP
    POST remains the fallback after a socket loss.

### 4.8 Budgets

| Budget | Default | Enforced at |
|---|---|---|
| Frame size | 1,750,000 B | `handleSyncFrame` (close 1009) |
| Per-socket rate / burst | 256 KiB/s; burst `max(1 MiB, 1.75 MB)` | `consumeTokens` (close 1013) |
| Micro-batch window | 0 ms (clamped 0..250; full-run relay config 10) | `handleSyncFrame` / batch timer |
| Relay + semantic sockets per vault | 5,000 | `acceptRelayBody` (429) |
| Merged-bytes cache | 16 MiB LRU | `remember` |
| Exact-merge threshold | 256 KiB | `commitFrames` |
| Checkpoint trigger / rows per pass | 50 rows or 1 MiB / 200 (lean: every append, delayed 2 s) | alarm, `checkpointBody` |
| Feed retention | 1,000 sequences below the current one (pins respected) | `runCheckpointPass` |
| Lazy-hash cache | 256 bodies | `bodyHttpState` |
| Merge input budget | 9 MiB | `durableMergedBytes(…, maxMergeInputBytes)` |
| Lazy-hash materialisation | ≤ 3 MiB | `bodyHttpState` |
| Lease TTL | 120 s default, 1–600 s | `acquireLease` |
| Reset cooldown | 24 h (0 in the full-run configs) | `acquireLease`, `semanticReset` |
| Reset snapshot | JSON ≤ 8 MiB (`MAX_CATCH_UP_BYTES`); octet-stream ≤ `RELAY_MAX_RESET_SNAPSHOT_BYTES` | `readResetInput` |

### 4.9 Semantic reset lease

Only clients can do history GC, because it needs a fresh `Y.Doc` built from the text.

**Acquire.** `POST …/compaction-lease` with `{expectedEpoch, ttlMs}`. `RelayBodyStore.acquireLease` runs one
transaction:
1. the head exists
2. its epoch equals `expectedEpoch`
3. the cooldown has elapsed since `last_compacted_at`
4. the actor is re-validated inside the transaction (G19, round 3)
5. no other device holds an unexpired lease
6. upsert the lease

Responses:
- 200: `leaseId`, `expiresAt`, `epoch`, `headSequence`, `generation`, `stateVector`, `policy`
- 409: `held` or `epoch_mismatch`
- 404: `not_found`
- 429: cooldown, with retry-after (measured on coresmoke-1: `retry-after: 1` with a 1 s test cooldown)

`{release: leaseId}` deletes the lease row for the same device.

**Build (client).** The client builds a lineage-fresh doc from the current text (K2). It optionally pulls
server-sourced state after taking the lease.

**Install.** `POST …/semantic-reset`, as JSON with a base64 snapshot or (round 2) as octet-stream with the
`x-yaos-lease-id`, `-expected-epoch`, `-covered-sequence`, `-content-hash` and `-content-bytes` headers. Checks:
1. `snapshotStructurallyValid`: 2 B ≤ size ≤ limit, the SV parses, and the SV is non-empty unless `contentBytes = 0`.
   This replaced the committed `snapshotCoversHead`, which rejected every lineage-fresh reset.
2. The lease `lease_id` and `device_id` match; it is unexpired; its epoch equals the head epoch, which equals
   `expectedEpoch`.
3. `coveredSequence === head.latest_sequence` exactly.
4. Cooldown, and the actor is re-validated inside the reset (G19). Pending micro-batches for the body are flushed
   before the CAS (G3).
5. `semanticResetFromEncodedState` runs as one transaction:
   - exact-head assert
   - refuses while a creation is pending or the lifecycle is unpublished
   - `vault_clock + 1`
   - journal row `'semantic-reset'` (0 B)
   - checkpoint chunks and manifest at the new sequence and the new epoch
   - pin capacity check
   - head CAS on (generation, epoch, sequence) → epoch + 1
   - catalog event with `COALESCE(client hash, previous)`
6. Delete the lease.
7. `discardResident`, then `fenceSemanticEpoch`: every old-epoch socket, relay included, is closed with 4409.
8. Invalidate the merged cache.

Errors: 409 for `lease_invalid`, `lease_expired`, `epoch_mismatch`, `head_advanced` and `cooldown`; 400 for
`invalid_snapshot`.

**Losers.**
- A client holding old-epoch edits gets 4409, fetches the new epoch and rebases its text intent. The spike rebase uses
  `mergeThreeWayText`, with a no-intent fast path.
- Server-side semantic compaction (`semanticCompactionRuntime.recordCommit` / `documentLoaded`) is skipped for relay
  bodies (`server.ts` `afterDurableCommit`, `afterDocumentLoaded`).

### 4.10 Revocation, epochs, runtime identity

- **Revocation.** `closeDevice` / `closePrincipal` close every socket of the device or principal with 4403, relay
  sockets included. Authority writers bump `authorityVersion`, so the next frame on any surviving socket fails
  `validateActorCached`. Pings and currentness queries re-validate too.
- **Delete.** `closeBody` closes relay sockets with 1008. The append transaction also refuses non-`active` catalog
  heads.
- **Epochs.** The ticket epoch is checked at accept (`SemanticEpochMismatchError`). The head epoch is checked on step1,
  at commit, and inside the transaction. A reset fences every old-epoch socket.
- **Runtime identity.**
  - `runtimeEpoch` is random per `VaultRuntime` construction.
  - Relay attachments keep their admission epoch. `message()` does not apply the runtime-epoch mismatch close to
    relay attachments with the same vault ID and generation (`vaultSocketService.ts` ~L749).
  - Receipts carry both the admission `runtimeEpoch` and `commitRuntimeEpoch`.
  - Durability does not depend on the runtime. The receipt is issued after `transactionSync`, and a runtime restart
    only loses in-memory state: pending envelopes, the rate buckets, micro-batch queues, and the cache.

## 5. What moves where

| Responsibility | Today (base) | Relay | Rationale |
|---|---|---|---|
| Body frame admission | Resident ywasm doc plus validation mirror doc per body (`vaultDocumentCache.ts`); `bodyUpdateAdmissionError` (frontmatter root shape, 5 MB Markdown cap) | Byte cap, epoch, authority, rate. No document. | The Wasm envelope was what capped sockets at 32 and cost 19 ms on heavy notes. |
| **Body content validation** | Server, before persistence | **Receiving clients, before their disk write. Owned elsewhere; out of scope for this spike.** | Disk is the truth and the client owns it. The server cannot validate once E2EE exists. |
| Persistence timing | 250 ms throttled flush (`scheduleFlush` → `flushDocument` → `commitUpdate`) | Synchronous append per frame, or per micro-batch (0..250 ms; recommended 5–10) | Removes ≈ 250 ms of latency. Costs more appends per keystroke (section 9); lean rows offset most of it. |
| Ordering | `vault_clock` per flush | `vault_clock` per append (lean: `MAX(clock, journal max) + 1`, no clock write) | Unchanged meaning. |
| Attribution | Per flush | Per frame (N rows per append; lean: frame 0 inline on the journal row) | More precise. Lean prunes frame-0 attribution at the feed floor. |
| Broadcast | After flush commit, from the resident doc | After append commit, same bytes | Invariant 1 is preserved. No re-encoding. |
| **Candidates (second write path)** | Every edit is also an IDB candidate POSTed over HTTP, cleared by `DurableReceipt` | The socket ack is the receipt (same row in `vault_candidate_receipts`). The HTTP POST becomes a fallback only after socket loss. The creation-candidate fence stays on HTTP. | Removes one Worker request plus a DO hop per burst, and a second journal write of the same bytes. |
| Step1/step2 | ywasm doc `encodeStateAsUpdate(sv)` | `diffUpdateV1` on stored bytes | No document. K3: 0.26–14 ms for 1–10 MB. |
| Catalog hash / size | Computed by the server from the doc on every flush | Client-claimed in the envelope and accepted only when the claim SV equals the merged SV. Otherwise NULL, then lazily materialised on read (≤ 3 MiB, 256-body cache). Lean: the hash sits inline on the journal row, and catalog events are coalesced by the alarm. | The server does not read plaintext on the hot path. |
| Routine checkpoint | `maintain()` via a ywasm doc | Byte merge through the stateless op (alarm, ≤ 200 rows per pass) | Plaintext structure is not interpreted. Bounded CPU. |
| **Semantic compaction (history GC)** | Server (`semanticCompaction*.ts`, fresh doc + epoch bump) | **A client under a lease** builds and uploads; the server CASes the epoch | Only clients can compact past the 96 MiB Wasm cap (the 5m fixture traps on the server). Required for E2EE. |
| Catch-up / GET body | Reconstruct doc or resident doc | Merged stored bytes (+ lazy hash) | No document except the lazy-hash fallback. |
| Bootstrap | `reconstructDocument` | Byte merge through the boundary sequence; 413 before reserving when over budget | Same. |
| Currentness / HEAD | Head + catalog | Head + catalog; the hash may be `unknown` | Unchanged, plus an explicit hash state. |
| Hibernation survival | Base closes with 1008 after eviction (runtime-epoch fence) | Relay socket survives | Idle product shape. |
| Revocation, membership, namespace, lifecycle, root doc | Authoritative server | **Unchanged**, authoritative server | Authority lives in the namespace. |
| Canvas semantic documents | Server-validated semantic docs | **Unchanged** | Out of scope. |
| Rate limiting | Cache pressure and backpressure | Per-socket token bucket, then 1013 `relay rate limit` (distinct from platform `Service overloaded`) | Explicit budget. |
| Socket cap | 32 (memory envelope) | 5,000 (config) | Bytes, not docs. |

## 6. Invariants

| # | Invariant | How it is enforced | Code | Gaps / status |
|---|---|---|---|---|
| 1 | No edit is broadcast to peers before its append transaction commits. | Fan-out (`broadcastRelayUpdate`) and `BODY_COMMITTED` are called only after `appendRelayBodyUpdate` returns. The commit path is synchronous, so nothing can interleave. | `relayBodies.ts` `commitFrames` | none found |
| 2 | Every append has exactly one vault sequence, and the feed returns it after the cursor. | Default: `vault_clock` is bumped in the same transaction as the journal insert. Lean: the sequence is `MAX(clock, journal max) + 1` inside the transaction, and the clock is synced before any journal delete. The sequence is the journal PK. | `relayBodyStore.ts` `appendRelayBodyUpdate`; `syncLeanClock` | A reset uses one sequence too. Feed retention is 1,000 sequences (G1 fixed, round 3). In lean mode the catalog delta feed lags by ≤ 2 s. |
| 3 | A returned receipt means the bytes are durable. | The origin ack is sent after `transactionSync`. A dedupe re-ack reads a committed receipt row. A no-op ack means the bytes are already contained in durable state. | `commitFrames`, `ackOrigin`, `ackNoop` | The incremental-SV no-op for large bodies only matches identical bytes, which is safe. |
| 3a (round 4) | No frame is dropped silently. Every non-empty update frame ends appended, acked as a justified no-op or dedupe, or with the socket closed. | Outcome counters satisfy the frame-accounting identity (4.3). Pre-append throws close 1011. | `relayBodies.ts` `failFrames`; `vaultSocketService.ts` `relayMessage` | Covered by a random-interleaving test at mb 0 and mb > 0, and checked on full-n diagnostics deltas. |
| 4 | A revoked device's frames after the fence sequence are never appended. | Sockets are closed with 4403 on revoke. `validateActorCached` runs on every frame, on step1 (G6), and again at micro-batch flush (G2). `authorityVersion` is bumped synchronously by the writer. The 5 s TTL applies only to cross-isolate changes. | `closeDevice`; `validateActorCached`; `commitFrames` | G2, G6 and G19 fixed in round 3. Full-n: `B4-{base,relay}`. |
| 5 | Old-epoch frames are never appended after an epoch bump. | Ticket epoch at accept. Head epoch before commit, per (body, epoch) batch. `expectedEpoch` inside the transaction. Reset flushes pending batches and then `fenceSemanticEpoch` closes old sockets. | `commitFrames`; `appendRelayBodyUpdate`; `handleSemanticReset` | G3 fixed (round 3). |
| 6 | Flag off means baseline behaviour. | Every relay branch is gated on `this.relay !== null` / `relayBodiesEnabled`. | `server.ts`, `vaultSocketService.ts`, `bootstrap.ts` | Measured (`flag-tests.md`). Round 4 flag-off: 3,635 assertions pass, 0 new failures. Round 1: 199/199 steps. |
| 7 (D6) | A catalog content hash is recorded only if the claimant's SV equals the merged SV after the append, and that SV is exact. | `stateVectorsEqual(envelope.stateVector, nextStateVector) && stateVectorExact`. Otherwise NULL. | `commitFrames` | G8 fixed (round 3): bodies over 256 KiB never accept a claim. The hash is still unverified client data (G10). Measured CW: 21/21 relay (20 materialised, 1 known), 21/21 base (small n, v0930). Full-n: `CW-{base,relay}`. |
| 8 (added) | Idempotent retries: one append per (device, candidateId), always with the same receipt. | Receipt lookup after the authority check (G7). In-batch duplicate detection (G11). `ON CONFLICT DO NOTHING` inside the transaction. | `handleSyncFrame`; `appendRelayBodyUpdate` | G7 and G11 fixed. In lean mode a candidate resend older than about 1,000 sequences and its receipt is re-appended, which is a CRDT no-op on the exact path. Full-n: `B6-{base,relay}`. |
| 9 (added) | The server never calls into Wasm with more than the merge budget of input. | `durableMergedBytes(…, maxMergeInputBytes)` throws `RelayMergeBudgetError` before merging. The lazy hash is capped at 3 MiB, and partial checkpoint prefixes are bounded (G20). A ywasm OOM trap poisons the instance, so the refusal happens before the call. | `durableMergedBytes`; `bodyHttpState`; `checkpointBody` | G5 fixed: `syncDocumentCache` no longer applies updates. |
| 10 (added) | A checkpoint never loses a journal row. Journal rows are deleted only in the same transaction that writes a checkpoint covering them, and never above the feed floor. | `persistCheckpoint` deletes `≤ min(through, journalFloor())` inside the checkpoint transaction. The floor advances only in `runCheckpointPass`, and stays below every pin. | `persistCheckpoint`; `runCheckpointPass` | G1 fixed. Measured locally: 5,000 appends leave 1,001 rows. Full-n: K1 rows before and after, plus `C2-stress-relay` table counts. |
| 11 (added) | At most one semantic reset per epoch. | Lease upsert is one transaction. Reset requires the lease, an epoch CAS, the exact head sequence, and a head CAS inside `semanticResetFromEncodedState`. | `acquireLease`, `semanticReset` | Measured: B5 6/6, exactly one install per race (e1abb36). Full-n: `B5-relay`. |

## 7. Failure modes

| Case | What happens | Residual risk |
|---|---|---|
| **A client bug writes bad bytes** (malformed or structurally wrong Yjs, bad frontmatter root) | The server does not parse structure on the hot path, so it appends any update of 1.75 MB or less. Malformed bytes can make the next `mergeUpdates` or `diffUpdate` throw. That means step1, checkpoint or HTTP read failures for that body only. The error is caught per body, the alarm re-arms, and the body stays checkpoint plus tail. Semantically wrong but valid updates, such as a bad frontmatter shape, propagate to peers. Receiving-client validation (owned elsewhere) must refuse to write them to disk and surface a conflict. Recovery: a client semantic reset from good text (lease) replaces the lineage, and the history is kept per retention and pins. | Until receiving-side validation ships, relay mode loses today's server-side frontmatter/root-shape gate. The failure is per body and does not spread to the vault. There is no poison-pill quarantine yet (open question Q3). |
| **The lease holder dies** | The lease expires after its TTL (120 s default). No state changed, because reset is a single transaction at install. Another device can acquire the lease after expiry. The holder can release early. | Fixed in round 3 (G19): revocation and fencing delete the holder's lease rows, and the actor is re-validated inside lease and reset. |
| **Two resets race** | The lease upsert serialises them: the second device gets 409 `held`. If a lease expires mid-upload (B5: 5 MB upload at 115.7 s), `lease_expired` rejects the install. At install, the epoch CAS plus `coveredSequence == latest_sequence` plus the head CAS let exactly one win. The losers' sockets get 4409 and they rebase. | Measured B5: 6/6, alternating winners. Starvation risk: R2. |
| **DO crash mid-append** | `transactionSync` is atomic: either all rows (clock, journal, attribution, head, catalog, receipt) or none. No ack or broadcast happens before commit. On crash the socket drops, the client reconnects and resends (step2), and the growth cap or receipt deduplicates. | An in-memory micro-batch (≤ 250 ms, recommended 10 ms) is lost, but it was never acked. The client resends unacked frames. |
| **DO crash mid-checkpoint** | `persistCheckpoint` is one transaction: chunks, manifest, journal deletes and prune together. After a crash either the old checkpoint plus the full tail remains, or the new checkpoint with the tail pruned. The alarm re-runs. A partial checkpoint (≤ 200 rows) is itself a complete, consistent checkpoint through its sequence. | none found |
| **Log growth while all devices are offline** | Without appends no alarm is armed, so nothing grows. With one writer and no readers, each append arms the checkpoint at 50 rows or 1 MiB, so the merged snapshot stays bounded by live size plus tombstones. Journal rows below the checkpoint are deleted only up to the feed floor. | G1 fixed in round 3: `runCheckpointPass` advances the floor to `current − 1000`, below every pin. Over-budget bodies (> 9 MiB merged input) are never checkpointed until a client reset. Their marker is persisted (G20). Full-n check: K1 and `C2-stress-relay` table counts. |
| **Mobile-only vault** | The routine checkpoint is server-side, so no client is needed. Reset is feasible on phones: K2 inferred 48–586 ms build, duty-cycle bound 1.7 s p50 for 5 MB. Upload speed is the constraint. Before round 2, B5's JSON 5 MB upload took 5–116 s. After round 2, a binary 5.24 MB reset takes 1.7–3.3 s from a desktop (core3, n = 4), with no growth across iterations. The lease TTL (≤ 600 s) and the octet-stream upload (which avoids the 33% base64 overhead) matter here. | The exact-head CAS combined with a slow mobile upload on a hot note is R2. |
| **Hibernation** | Relay attachments keep the admission `runtimeEpoch` and are exempt from the mismatch close. The merged cache rebuilds from SQL on the first frame. Measured small-n B1: the socket survives idle plus simulate-restart, with the edit propagated at 309 ms; base gets 1008 plus a ≈ 1.33 s reconnect. | Lost on wake: pending envelopes (G13, memory-only by design and documented as a deviation; the next echo is unenveloped), rate buckets (they refill), and the micro-batch queue (unacked, so it is resent). |
| **Revoked device with an offline queue** | On reconnect the ticket issue fails, because the control plane rejects the revoked credential. If a socket survived, the first frame fails `validateActorCached` with 4403. Queued edits never append. Attribution rows record device and credential revision for anything appended before the revocation. | The revoked user's local edits stay local by design. G7 fixed in round 3: authority now runs before dedupe, so there is no receipt re-ack for a revoked device. |
| **Transport loss mid-stream / DO stall** (round 4 smoke data-loss finding) | Root cause in smoke mb0, worker v0930: the transport/platform plus harness behaviour. Server merge logic was not involved.<br>• l2: the DO stalled (alarm `internalError` after 27 s wall, 2 hibernation `internalError`s). Both sockets died about 49 s into a 60 s drain. All 61 edits were durable, but the raw harness client never reconnected, so B missed #37–60.<br>• burst: the sender's socket ended `clientDisconnected` about 38 s in. The raw client silently skipped sends while the socket was not OPEN, so 27 tail frames never reached the server.<br>Repros were clean, and the keystroke fuzz (n = 61 / 241 / 2,000) was clean. A real client must reconnect, re-sync with step1, and resend unacked frames. The harness now does all three (35b2882). | Server side: one latent silent drop was found and fixed (4.3, `frameErrors`). Client side: `VaultSync` integration must keep resending until it receives a receipt (phase 2). |
| **Platform overload** (`1013 Service overloaded`) | Cloudflare sheds the connection when the DO queue or CPU saturates. Seen once in K1 at mb 0 under a flood. The server never sees it, so no counter moves. | Mitigated by micro-batching (fewer transactions and output-gate flushes). Clients treat it as a reconnect and resend. Full-n: `B7-*`, `X2-*`. |
| **Malicious member** (valid credential, hostile client) | Rate limit (1013) and frame cap bound flooding. A malicious member can: append arbitrary valid Yjs, which propagates, just as with base once server validation is gone; claim false content hashes that equal the merged SV (the server cannot verify, G10), poisoning catalog hashes and currentness until the next honest claim; take the lease and install a reset with arbitrary text (the history is kept per retention; the reset is attributable); and hold leases to block resets. | Same trust model as today for members: members can write content. Hash poisoning (G10) is new: today the server computes hashes. Mitigation options: receiving clients verify hashes and report mismatches; the server re-hashes on the lazy path whenever a hash is disputed. |

## 8. Measurements

Dates, Workers, deploy version IDs and spike SHAs come from each run's JSON metadata. Full-n raw output is
`experiments/results/relay2/raw/<scenario-id>.json`; the index is in section 14. "Base" means the same branch and the
same vars with the flag off. Each placeholder names the scenario id that fills it. "relay" means lean + mb 10, and
"strict" means lean off + mb 0.

Small-n values marked "smoke" come from v0930 (`8e194a4`, default rows) or w0930 (`276c16c`, primary configs). They
are directional only.

### 8.1 Latency

| ID | Metric | Base p50 / p90 / p99 | Relay p50 / p90 / p99 | Strict p50 / p90 / p99 | n | Notes |
|---|---|---|---|---|---|---|
| L1 | ping RTT | <<MEASURED: L1-base>> | <<MEASURED: L1-relay>> | — | 100 | floor; v1 45.4 / 50.1 ms (A5) |
| L2 | propagation (+ origin ack) | <<MEASURED: L2-base>> | <<MEASURED: L2-relay>> | <<MEASURED: L2-strict>> | 300 | small n: 412 vs 90 ms p50 (scratch / scratch-3, n = 30). MB smoke l2 mb10: 65 / 74 vs base 310 / 403 |
| L3 | propagation on 64k chars, before / after the quick trace | <<MEASURED: L3-base>> | <<MEASURED: L3-relay>> | — | 50 + 50 | v1: 302 → 318.7 vs 52 → 52.5 ms (A5) |
| L4 | per-frame at 25 edits/s | <<MEASURED: L4-base>> | <<MEASURED: L4-relay>> | <<MEASURED: L4-strict>> | 5,000 | small n: 293 vs 116 ms p50. MB smoke burst mb10: 62 / 68 vs base 301 / 413 |
| L5 | edit → cleared receipt (HTTP candidate vs socket ack), 1-edit and 8-edit bursts | <<MEASURED: L5b1-base, L5b8-base (prod, nodebounce)>> | <<MEASURED: L5b1-relay, L5b8-relay (relay, relay250)>> | — | 100 | small n base: prod 531 ms, nodebounce 277 ms (n = 14, D8) |
| L6 | open → synced, cold / warm | <<MEASURED: L6-base>> | <<MEASURED: L6-relay>> | — | 100 each | |
| L7 | HEAD/GET visible + hash matches client | <<MEASURED: L7-base>> | <<MEASURED: L7-relay>> | — | 100 | |

**Micro-batch sweep (MB).** Propagation p50 / p90 in ms, for l2, burst and stream patterns. Smoke, v0930, default rows,
small n, measured:

| Config | l2 | burst | stream |
|---|---|---|---|
| base | 310 / 403 | 301 / 413 | 200 / 307 |
| mb0 | 52 / 281 | 54 / 660 | 53 / 1996 |
| mb10 | 65 / 74 | 62 / 68 | 62 / 66 |
| mb50 | 105 / 113 | 102 / 130 | 101 / 145 |
| mb100 | 153 / 156 | 151 / 155 | 115 / 152 |
| mb250 | 303 / 2343 | 187 / 309 | 189 / 305 |

Full n: <<MEASURED: MB-base, MB-relay-{lean,full}-mb{0,10,50,100,250}, MB-relay-nocand-lean-mb10>>.

### 8.2 Server cost

| ID | Metric | Base | Relay | Strict | n / source |
|---|---|---|---|---|---|
| C1 | CPU per keystroke, small / heavy (gql per-invocation) | <<MEASURED: C1-base>> | <<MEASURED: C1-relay>> | <<MEASURED: C1-strict>> | ≥ 40 each. v1: heavy 19 ms vs ≈ 0 ms (A5) |
| C2 | CPU per update, quick trace; stress trace (50k edits, 5 clients) | <<MEASURED: C2-quick-base, C2-stress-base>> | <<MEASURED: C2-quick-relay, C2-stress-relay>> | <<MEASURED: C2-quick-strict, C2-stress-strict>> | gql aggregate. Smoke w0930 quick (300 frames): perUpdate CPU 2,607 / 2,348 / 1,965 µs; WS-invocation p99 11.2 / 3.2 / 2.2 ms |
| C3 | Wasm linear memory / resident docs at 1, 8, 32, 100 bodies; 32 × 512 KiB | <<MEASURED: C3-base>> | <<MEASURED: C3-relay>> | — | v1: base 37.5 MB vs relay 1.11 MB (A5) |
| C4 | rows written per edit / per reconnect | <<MEASURED: C4-base>> | <<MEASURED: C4-relay>> | <<MEASURED: C4-strict>> | **Component, measured:** 9 / 11 CF rows per plain / candidate append in default mode (coresmoke-1, n = 20 each), 3 / 5 in lean (corelean-1, n = 20 each). Smoke w0930 C2-quick rows per edit: base 3.03, relay 7.26, strict 13.16. Smoke C4 sequences per edit: 1 / 1.5 / 1, and per reconnect 0 / 0 / 0. |
| C5 | DO requests per edit burst / per catch-up (20:1) | <<MEASURED: C5-base>> | <<MEASURED: C5-relay>> | — | smoke v0930 (default rows): base 1.45 / 2.0, relay 1.63 / 3.23 DO units; rows 44 / 48 vs 88 / 151 |
| C6 | bundle raw / gzip KiB; startup ms | 2,537.10 / 610.56 KiB at base SHA (dry run, K3) | 2,652.13 / 636.21 KiB at `276c16c` (w0930 deploy; the same bundle serves every flag) | same bundle | **measured, one deploy each.** Startup: base 10 ms, relay 8 ms, strict 13 ms (w0930); v0930: 11 / 15 ms. The spike adds +115 KiB raw / +25.7 KiB gzip, of which patch 0003 is +3,358 B raw / +379 B gzip. Free limit: 3 MiB compressed. v1 relay: 2,757.68 / 651.81 KiB. Full-n record: `C6-relay`. |

### 8.3 Behaviour

| ID | Pass criteria | Base | Relay | Strict |
|---|---|---|---|---|
| B1 | socket survives hibernation and restart | <<MEASURED: B1-base>> (small n: 1008 + ≈ 1.33 s reconnect) | <<MEASURED: B1-relay>> (small n: survives, 309 ms) | — |
| B2 | catch-up after 50 / 5,000 edits: time, bytes, rows scanned, text equal | <<MEASURED: B2-base>> | <<MEASURED: B2-relay>> | — |
| B3 | bootstrap of 100 notes (20 relay-edited) | <<MEASURED: B3-base>> | <<MEASURED: B3-relay>> | — |
| B4 | revocation mid-stream: 4403 ≤ 1 s, no append after the fence | <<MEASURED: B4-base>> | <<MEASURED: B4-relay>> | — |
| B5 | reset race: one install, zero lost edits | n/a | **measured: 6/6 pass**, winners A, B, A, B, A, B; race p50 1,813 ms, p90 2,097 ms (`B5-2026-09-29T20-16-32-720Z.json`, yaos-relay2-reset, e1abb36). Full-n: <<MEASURED: B5-relay>> | — |
| B6 | 3× resend → one append, same receipt | <<MEASURED: B6-base>> | <<MEASURED: B6-relay>> | — |
| B7 | 5 MiB/s flooder → 1013; victim L2 within 20% | <<MEASURED: B7-base>> | <<MEASURED: B7-relay>> (small n: 1013, victim flat) | <<MEASURED: B7-strict>> |
| B8 | delete with sockets open | <<MEASURED: B8-base>> | <<MEASURED: B8-relay>> | — |
| CW | invariant #7 under concurrent writers | <<MEASURED: CW-base>> (smoke: 21/21) | <<MEASURED: CW-relay>> (smoke: 21/21; 20 materialised, 1 known) | — |

### 8.4 Limits

| ID | Metric | Base | Relay | Strict |
|---|---|---|---|---|
| X1 | max concurrent body sockets (100 → 2,000) | <<MEASURED: X1-base>> (small n: 429 at #33) | <<MEASURED: X1-relay>> (small n: 100 OK) | — |
| X2 | max sustained append rate, 1 body / 10 bodies | <<MEASURED: X2-base>> | <<MEASURED: X2-relay>> | <<MEASURED: X2-strict>> |
| X3 | largest note for step2 and checkpoint (1 / 5 / 10 MB) | <<MEASURED: X3-base>> | <<MEASURED: X3-relay>> (smoke: 5 MB opens in 0.9–1.2 s) | — |
| X4 | catch-up of 100 bodies × 50 edits stale | <<MEASURED: X4-base>> (A3: 676 ms) | <<MEASURED: X4-relay>> | — |

### 8.5 Compaction

| ID | Metric | Value |
|---|---|---|
| K1 | alarm merge at tails of 50 / 500 / 5,000: ms, memory, rows before and after | <<MEASURED: K1-compact-base, K1-compact-relay, K1-alarm-relay>>. Smoke (vault-wide compact, small n): relay 193–368 ms for tails of 50–2,000, base 515–559 ms. Local: `checkpointsFromCache` 3.3 → 1.8 ms per pass for a 30 KiB body. |
| K2 | reset build, desktop lease path p50 / p90 (measured, n = 10, M4 Pro, Node v26.5, fd38e71) | 100k: 12.1 / 12.8 ms. 1m: 25.9 / 26.3 ms. 5m: 97.7 / 104 ms. stress: 13.6 / 14.2 ms. Duty-cycle worker (measured): 1m at duty 25 is 166 / 205 ms and at duty 17 is 469 / 605 ms; 5m at duty 25 is 610 / 1,052 ms and at duty 17 is 1,742 / 2,667 ms. Mobile ×4–6 (**inferred**): 1m 103–155 ms, 5m 391–586 ms. Upload ≈ live size + 120 B. 5m peak heap 176 MiB. A 5m server-side reset traps (`prepareSemanticReset`, 96 MiB cap). |
| K2-upload | deployed reset upload | Pre-round-2 JSON (B5, measured): 100k p50 395 ms (n = 5, lease p50 284 ms, 134,071 B); 1m p50 1.08 s; 5m 5.0 → 20.9 s, then `lease_expired` at 115.7 s. Round-2+ binary (core3-live-reset-5mb, coresmoke-1, 5.24 MB, n = 4, all 200): 1,740 / 3,114 / 1,839 / 3,272 ms; the GET after reset takes 1.5–3.0 s with `hashState: known`; HEAD 192–269 ms; cooldown lease 429 with `retry-after: 1`. Round-2 core2 (n = 6): 3.7, 3.3, 3.6, 1.7, 3.1, 3.1 s. |
| K3 | stateless byte ops (c) vs transient doc (a) vs JS yjs (b) | **Measured, Node, not workerd** (K3.md). Merge: (c) is ≈ 2.5× faster than yjs and super-linear (50k frames: 4.4 s vs 12.8 s). SV/diff (c): 0.26 ms quick, 1.2 ms 1 MB, 6.7 ms 5 MB, 14 ms 10 MB. Wasm high-water ≈ 4–5× merged size for merge (10 MB → 48 MiB); ≈ 20 MB merged reaches the cap. Memory never shrinks, and does not grow on repeat. Lone-surrogate loss occurs only on the ywasm Doc path. Bundle: 2,537.10 → 2,541.45 KiB raw, 610.56 → 611.11 KiB gzip; Wasm is ≈ 340 KB of the gzip. |

### 8.6 v1 projections: did they hold?

| Projection (v1, A5) | v1 evidence | v2 measured | Held? |
|---|---|---|---|
| 10–50× less memory | 32 × 512 KiB: 37.5 MB base vs 1.11 MB relay | <<MEASURED: C3-base / C3-relay>> | <<MEASURED: C3>> |
| 30–100× more concurrent notes | 100/100 vs 429 at #33 | <<MEASURED: X1-relay ceiling / 32>> | <<MEASURED: X1>> |
| 3–5× faster propagation | 300 → 52 ms | <<MEASURED: L2-base / L2-relay>> (small n: 412 / 90 ≈ 4.6×) | <<MEASURED: L2>> |
| 30–100× less CPU on heavy notes | 19 ms → < 1 ms | <<MEASURED: C1-base heavy / C1-relay heavy>> | <<MEASURED: C1>> |
| Near-zero idle cost | hibernation survives | <<MEASURED: C5 idle DO requests/day + B1-relay>> (model: idle equal, 1,056/day, 1%) | <<MEASURED: C5, B1>> |

### 8.7 Convergence

For each scenario, A, B and a fresh C have identical text and state vectors, the server GET equals the client text,
and the recorded hash equals the client's canonical hash. Summaries: `convergence-suite.json` (relay),
`convergence-suite-strict.json` and `convergence-suite-base.json`.

| Scenario | Smoke (v0930) | Full n relay | Full n strict | Full n base |
|---|---|---|---|---|
| L2 | pass | <<MEASURED: conv L2-relay>> | <<MEASURED: conv L2-strict>> | <<MEASURED: conv L2-base>> |
| L4 | pass | <<MEASURED: conv L4-relay>> | <<MEASURED: conv L4-strict>> | <<MEASURED: conv L4-base>> |
| quick trace | — | <<MEASURED: conv C2-quick-relay>> | <<MEASURED: conv C2-quick-strict>> | <<MEASURED: conv C2-quick-base>> |
| stress trace | pass | <<MEASURED: conv C2-stress-relay>> | <<MEASURED: conv C2-stress-strict>> | <<MEASURED: conv C2-stress-base>> |
| B2 | pass | <<MEASURED: conv B2-relay>> | — | <<MEASURED: conv B2-base>> |
| B3 | pass | <<MEASURED: conv B3-relay>> | — | <<MEASURED: conv B3-base>> |
| B5 | pass (6/6, component) | <<MEASURED: conv B5-relay>> | — | n/a |
| B6 | pass | <<MEASURED: conv B6-relay>> | — | <<MEASURED: conv B6-base>> |
| X1 sample | pass | <<MEASURED: conv X1-relay>> | — | <<MEASURED: conv X1-base>> |
| CW (#7) | pass 21/21 | <<MEASURED: conv CW-relay>> | — | <<MEASURED: conv CW-base>> |

Frame accounting (4.3): the identity must hold on every relay and strict run's diagnostics delta. Full-n:
<<MEASURED: accounting identity per run (runall summary)>>.

## 9. Cost model

Workers Free limits were checked on 2026-09-30 in the Cloudflare docs
([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).

| Limit (Workers Free) | Value | Note |
|---|---|---|
| DO requests | 100,000 / day | Counts HTTP requests, RPC sessions, WebSocket messages and alarm invocations. Incoming WS messages are billed at **20:1**; outgoing messages and protocol-level pings are free. Exceeding any free limit makes further operations of that type fail until 00:00 UTC. |
| DO duration | 13,000 GB-s / day | Hibernatable idle is not billed. |
| SQLite rows written | 100,000 / day | **Index writes, deletes and `setAlarm()` each count as rows written.** |
| SQLite rows read | 5,000,000 / day | |
| SQLite storage | 5 GB total (1 GB per object on Free, per the FAQ) | |
| DO CPU per request | 30 s default (same table for both plans); resets per incoming request or WS message | The Workers Free Worker limit is 10 ms CPU per request; that applies to the Worker entry, not the DO. The enterprise account differs only in configurable DO `cpu_ms`. |
| Memory | 128 MB per isolate (JS heap + Wasm) | The 96 MiB ywasm cap sits inside this. |
| Worker requests | 100,000 / day | HTTP and WS upgrades; WS messages are not Worker requests. |
| Max SQL row / BLOB | 2 MB | This is why `MAX_DURABLE_UPDATE_BYTES` is 1.75 MB. |

The calculator is `scripts/relay2/costmodel.py`. Every input is a named parameter with a provenance tag, and it
reruns with measured values (`--set name=value` or `--json`). It was re-run on 2026-10-01 without edits. Its
docstring still says the micro-batch maximum is 50, which is stale; the cap is 250.

The model does not cover two things:
- the lean coalescing pass
- CPU

Every output below is **inferred**. Its inputs are labelled.

**Inputs** (the rest are model defaults: 3 devices, 4 sockets each, 60 s pings, 270 s ticket refresh, 2 h editing per
day at 25% typing duty, 5 frames/s, 10 s bursts, checkpoint 8 fixed rows + 2 rows per pruned journal row):

| Run | `relay_rows_per_append` | `base_rows_per_flush` | `relay_microbatch_ms` | Provenance |
|---|---:|---:|---:|---|
| (a) old defaults | 11 | 10 | 0 | pre-lean model defaults (coresmoke candidate frame; base assumed) |
| (b) **relay, lean plain** | 3 | 3 | 10 | relay: measured corelean-1, n = 20. Base: smoke w0930 C2-quick rows per edit, which already includes base batching, so this favours base. |
| (c) relay, lean candidate | 5 | 3 | 10 | relay: measured corelean-1 candidate frame, n = 20 |
| (d) strict | 9 | 3 | 0 | measured coresmoke-1 plain frame, n = 20 |
| (e) sensitivity: base per flush | 3 | 9 | 10 | base: same row set per flush as default relay (flag-tests.md), CF ≈ 9 |
| (f) relay, lean + mb 250 | 3 | 3 | 250 | micro-batch effect **inferred** |
| (g) pessimistic: smoke per-edit | 7.26 | 3.03 | 10 | smoke w0930 C2-quick rows per edit, which already include checkpoint, floor, coalescing and candidate rows. The model adds checkpoint rows again, so this over-counts. |

**Output, typical day** (rows written/day; Workers Free limit 100,000):

| Run | Base rows/day | Relay rows/day | Base + import | Relay + import | Rows per typing-s (base / relay) | Typing h/day to hit 100k (base / relay) |
|---|---:|---:|---:|---:|---|---|
| (a) | 89,676 (90%) | 118,620 (119%) | 159,676 (160%) | 190,620 (191%) | 49.8 / 65.9 | 0.56 / 0.42 |
| (b) | 39,276 (39%) | **46,620 (47%)** | 95,276 (95%) | 102,620 (103%) | 21.8 / 25.9 | 1.27 / 1.07 |
| (c) | 39,276 (39%) | 64,620 (65%) | 95,276 (95%) | 124,620 (125%) | 21.8 / 35.9 | 1.27 / 0.77 |
| (d) | 39,276 (39%) | 100,620 (101%) | 95,276 (95%) | ≈ 169% | 21.8 / 55.9 | 1.27 / 0.50 |
| (e) | 82,476 (82%) | 46,620 (47%) | ≈ 150% | 102,620 (103%) | 45.8 / 25.9 | 0.61 / 1.07 |
| (f) | 39,276 (39%) | 37,296 (37%; 7,200 appends) | 95,276 (95%) | ≈ 93% | 21.8 / 20.7 | 1.27 / 1.34 |
| (g) | 39,492 (39%) | 84,960 (85%) | 95,552 (96%) | 149,480 (149%) | 21.9 / 47.2 | 1.27 / 0.59 |

The other outputs do not depend on the row inputs:

| Day shape | Mode | DO req/day | % free | Worker req/day |
|---|---|---:|---:|---:|
| idle | base / relay | 1,056 / 1,056 | 1% / 1% | 0 / 0 |
| typical | base / relay | 2,300 / 2,648 | 2% / 3% | 342 / 60 |
| typical + import | base / relay | 5,000 / 5,648 | 5% / 6% | 2,742 / 2,460 |

**CPU against the 10 ms Worker-Free limit.** The model does not cover CPU. Small-n deployed evidence (smoke w0930,
C2-quick, 300 frames, gql; measured, small n) gives per-WS-invocation CPU p50 / p90 / p99:

| Mode | p50 | p90 | p99 |
|---|---:|---:|---:|
| base | 1,513 µs | 6,709 µs | **11,184 µs** (over 10 ms) |
| relay | 1,066 µs | 1,732 µs | 3,224 µs |
| strict | 716 µs | 1,531 µs | 2,239 µs |

The DO's own limit is 30 s per request, so 10 ms is not a hard limit for DO invocations. It applies to the Worker
entry. It is still the reference bar for keeping a body edit cheap. K3 shows an exact SV or diff on a 5–10 MB body
costs 7–14 ms, above 10 ms. That is why bodies over 256 KiB use the incremental SV (R4). Full n:
<<MEASURED: C1-*, C2-quick-*, C2-stress-* gql p99>>.

Reading the model:
- **Idle cost is equal, and small (≈ 1% of DO requests)**, now that phase 0 made pings survive. Before phase 0 it was
  ≈ 160k/day (A1). The relay's extra benefit is not reconnecting after eviction (B1). In base those reconnects appear
  on the first edit, not while idle.
- **Rows written, not requests, is the binding free-tier limit.**
  - The pre-lean relay (a) was at 119%.
  - With lean rows and plain frames (b), a typical day is 47% for relay against 39% for base (1.19×). With candidate
    frames on every append (c) it is 65% (1.65×).
  - In practice only some frames carry a `candidateId`, so the per-append range is 47–65% (inferred). The smoke
    per-edit figure gives a pessimistic 85% (g).
  - With the fairer per-flush base input (e), base is at 82% and relay is below it.
- **Micro-batching (inferred).**
  - At 5 frames/s (≈ 200 ms apart), mb 10 does not merge appends: `min(5, 1000/10)` is still 5 appends/s. Its value is
    in latency tails (8.1, MB) and under bursts.
  - **Caveat.** The smoke w0930 C2-quick rows per edit (relay 7.26, strict 13.16, base 3.03; small n) are well above
    the 3 / 5 per-append component cost. They include checkpoint passes, floor advances, coalescing and candidate
    rows at trace cadence. If full-n C2/C4 confirms ≈ 7 rows per edit, the relay typical day is ≈ 85% (g): under
    100k, but 2.2× base. Reversal condition 2 is then not triggered, but the margin is thin. The full-n `C2-quick-*`
    and `C4-*` values decide this.
  - Only mb ≥ 200–250 coalesces at typing cadence (f: 37%, below base). It gives back much of the latency win
    (MB mb250 p50 ≈ 190–300 ms).
- **Lean coalescing (inferred, not in the model)** adds 3 rows per dirty body per pass. At 5 frames/s with a 2 s delay
  that is ≈ +0.3 rows per append, i.e. ≈ +2.7k rows on a typical day: (b) becomes ≈ 49%.
- **The heavy import** is dominated by lifecycle rows (`import_rows_per_note`, assumed 25). Both modes reach or exceed
  the free budget on an import day (95% base, 103% relay in b). An import of about 3,000 notes or more is a two-day
  operation on Free in either mode.
- **Feed floor.** The model charges 2 rows per pruned journal row. With G1 fixed this pruning now happens; it is
  included.

To fill (rerun the model with full-n inputs):

| Input | Placeholder |
|---|---|
| `relay_rows_per_append`, `base_rows_per_flush`, rows per reconnect | <<MEASURED: C4-base, C4-relay, C4-strict>> |
| DO requests per burst and per catch-up | <<MEASURED: C5-base, C5-relay>> |
| `checkpoint_fixed_rows`, rows per checkpoint | <<MEASURED: K1-alarm-relay rows before/after>> |
| `base_candidate_rows` | <<MEASURED: C4-base with the real VaultSync candidate path (L5b1-base)>> |
| `frames_per_typing_s` | <<MEASURED: L4 trace frame rate / C2-quick>> |
| rows per edit at trace cadence | <<MEASURED: C2-quick-{base,relay,strict}, C2-stress-{base,relay,strict}>> |

## 10. E2EE compatibility

Goal: relay mode should need plaintext CRDT structure only in removable, optional server paths. The table lists every
relay-mode server operation that reads update bytes as more than opaque blobs.

| Operation | Where | Needs | Moves to clients how |
|---|---|---|---|
| **Checkpoint byte merge** (`mergeUpdatesV1`) | alarm → `checkpointBody` → `durableMergedBytes` | Plaintext CRDT structure (it parses structs and IDs) | A client under a lease uploads an encrypted snapshot covering sequence S. The server stores it as an opaque checkpoint and prunes the journal ≤ S (the same row shape as reset without the epoch bump). Mobile-only is fine because the lease is available to any device. |
| **Lazy hash materialisation** (`reconstructDocument` → `readText` → sha256) | `bodyHttpState` (GET, catch-up) when the catalog hash is NULL | Plaintext **text** (a full ywasm Doc) | Delete it. The hash comes only from client claims (the envelope). Unknown stays unknown, and HEAD already exposes `hashState`. Under E2EE the hash itself must be a keyed hash (HMAC with a vault key) so it leaks nothing. |
| **Head SV tracking** (`stateVectorFromUpdate`, `maxStateVector`) | every append (`commitFrames`), rebuild | Plaintext structure (IDs and clocks) | The client sends its post-update SV in the envelope (it already does for D6). Under E2EE the SV is metadata the client chooses to reveal. Either accept the SV leak (client IDs and clock counts, no content) or have the server track only sequences, with step1 answered by "all rows after the client's last seen sequence". |
| **Step2 diff** (`diffUpdateV1(merged, clientSV)`) | step1 reply | Plaintext structure | Replace SV-based diff with sequence-based catch-up: the client sends its last durable sequence and the server returns checkpoint + rows > seq as opaque blobs, which is already how `replyStep2Unmerged` works. Costs more bytes; no crypto change. |
| **Growth-cap no-op test** (exact merge equality) | `commitFrames` ≤ 256 KiB | Plaintext structure | Drop it and rely on client idempotence: receipts via candidateId, and clients skip resends whose SV is already covered by the last acked SV. The large-body identical-bytes test works on ciphertext only if encryption is deterministic, which it should not be. |
| **Micro-batch merge** (`mergeUpdates(live…)`) | `commitFrames` when batch > 1 | Plaintext structure | Store the frames as separate journal rows in one transaction (N journal rows, one sequence each) or disable micro-batching. |
| **Bootstrap / catch-up / GET byte merge** | `durableMergedBytes` | Plaintext structure | Serve checkpoint + tail parts unmerged (opaque); the client merges. |
| **Merged-bytes cache** | `MergedEntry` | Opaque storage of plaintext merged state | Disappears with the merges. |
| **`syncDocumentCache`** (since round 3 it only discards or marks a resident base doc stale; no apply) | after append | None now (no ywasm call) | Delete it together with the base body path (section 11). |
| **Reset structural check** (`snapshotStructurallyValid`: SV parse) | reset route | Plaintext structure (SV parse only) | Replace with a size check plus a client-signed header. |
| **Semantic reset** | client builds | None on the server (opaque install); the server trusts `coveredSequence` | Already on the client. |
| Frame size, rate, epochs, authority, receipts, sequence, attribution digests | throughout | **Opaque bytes** (length and sha256 of ciphertext) | No change. |

Classification summary:
- Opaque today: size, rate, digest, receipts, epochs, sequence, lease/reset CAS.
- Needs structure: merge, SV, diff, growth cap, micro-batch merge, reset SV parse.
- Needs text: the lazy hash only.

The brief's expectation was that only the optional checkpoint and the lazy hash need plaintext. That understates it:
SV tracking and step2 diff also need structure. Each has a removal path (the envelope SV and sequence-based catch-up)
that works today with `replyStep2Unmerged`.

## 11. Migration plan

**Cutover policy (confirmed).** `docs/operations.md` says: "There is no in-place migration from any earlier schema or
storage format … A release changing any pin or required class must declare another fresh or guided cutover."

The relay keeps storage format 4, schema 8 and protocol 5. It adds one lazily created table and one capability key.
- A flag flip on an existing deployment is technically possible, because the tables mean the same thing.
- Receipts and sockets differ by mode, so the recommendation is: **flag changes only on a fresh deployment**, paired
  with a protocol-capability check in the client (`relayBodies: 2`).
- Rollback (relay → base) on the same storage is possible, because base can read relay-written journal, checkpoint
  and catalog rows, which have the same shape. It is untested and is open question Q6.

**Phases:**

| Phase | Flag / gate | Contents | Exit criteria |
|---|---|---|---|
| 0 | none | Done in the spike: G1–G8, G11, G13–G17, G19, G20 (round 3); no silent drops, lean rows, `checkpointsFromCache` (round 4). Left: G9/R2 decision, G10 mitigations, G18 residual, the lean-off coalescing step | unit tests + flag-off 0 new failures (round 4: 3,635 pass) |
| 1 | `YAOS_RELAY_BODIES=true` + `YAOS_RELAY_LEAN_ROWS=true` + `YAOS_RELAY_MICROBATCH_MS=10`, opt-in deploy vars | Server relay plus the unmodified client (unenveloped; hash via lazy path ≤ 3 MiB; HTTP candidates still clear receipts) | full-n section 8 tables; section 13 not triggered |
| 2 | client capability `relayBodies ≥ 2` | Envelope + socket-ack receipts in `VaultSync` (fencedWebSocket `send()` wrapper; candidate observer → clientFrameId/candidateId); HTTP candidate POST becomes fallback | L5 relay ≤ base; candidate clears via socket in ≥ 99% |
| 3 | client | Lease-based semantic reset in the plugin (policy + builder from `scripts/relay2/reset`), receiving-side validation (owned elsewhere) | B5 at full n; mobile-class reset in budget |
| 4 | default on, fresh-install release | Delete the base body path (below) | one release of relay-default without reversal |
| 5 (E2EE prep) | separate | Client checkpoints, sequence-based catch-up, remove the lazy hash (section 10) | |

**Code that becomes dead in phase 4** (`wc -l` on the working tree, 2026-09-30; relay line counts 2026-10-01).

The root document, Canvas semantic documents and the creation-candidate fence stay on the base path, so most files
are only partly deletable.

| File | Lines | Deletable part | Estimate |
|---|---:|---|---:|
| `server/src/semanticCompaction.ts` + `…Policy.ts` + `…Runtime.ts` | 289 + 244 + 432 = 965 | Body share (Canvas keeps server compaction unless it also moves) | 350–600 |
| `server/src/vaultDocumentCache.ts` | 1,178 | Body validation mirror (`validateBodyUpdate`, `stage/discardValidatedBodyUpdate`, `rebuildValidation`), body admission and capacity (`admitBody`, `ensureBodyCapacity`, `cleanBodyCandidates`, `loadedBody*`) | ≈ 250–300 |
| `server/src/vaultSocketService.ts` | 1,372 | `bodyUpdateAdmissionError` (23) + body branch of `handleSyncFrame` validation and staging + base body step1 load | ≈ 120–180 |
| `server/src/server.ts` | 1,573 | Body share of `scheduleFlush`/`flushDocument`/`flushLoadedDocuments` (1196–1312, 1472–1476, ≈ 125); body semantic-compaction wiring; body `writeLiveCheckpoint` doc path | ≈ 100–150 (the flush path stays for Canvas) |
| `server/src/vaultCandidateService.ts` | 379 | Ordinary active-body candidate commit (the creation fence stays) | ≈ 150–200 |
| `server/src/crdt/frontmatterSemanticSnapshots.ts` + `frontmatterSemanticValidation.ts` + `shared/frontmatterSemanticValidation.ts` | 98 + 10 + 207 | Moves to receiving clients (the client already shares `shared/`) | 108 server-only |
| `vaultDocumentStore.ts` `reconstructDocument` body uses / `writeCheckpoint` via doc | (2,412) | Only after phase 5 (lazy hash) | ≈ 50 |
| **Total** | | | **≈ 1,100–1,600 server lines**, against +2,235 relay lines at `7feae39` (`relayBodies.ts` 1,249, `relayBodyStore.ts` 536, `relayFlag.ts` 133, `relayRoutes.ts` 137, `ywasmByteOps.ts` 180), plus lean-mode branches in `vaultDocumentStore.ts` |

Client side:
- `src/sync/vaultSync.ts` candidate HTTP plumbing stays as the fallback. Net client code grows by the envelope,
  receipt mapping, reset policy/builder and rebase: `scripts/relay2/reset` gives an upper bound.
- The spike diff at `66fb78c` is 87 files, +16,444 / −56 lines, mostly harness and tests.

**`packages/server-node` impact.**
- The Node host runs the same `VaultRuntime` compositions, and it already reads `YAOS_RELAY_BODIES` and
  `readRelayConfig` (`packages/server-node/src/index.ts:112–114`).
- `ywasmNodeCrdtEngine.ts` (30 lines) exposes the pinned bindings, and the byte ops come from the same patched ywasm
  artifact.
- Nothing else changes: storage (`storage.ts`, 678 lines) implements the same SQL port, and `transactionSync` keeps
  the append atomic.
- The Node host has no free-tier quota. The rows-per-keystroke concern is SQLite write amplification (fsync per
  transaction) and does not block it.

**Keep ywasm for stateless byte ops, or drop it?**

| Option | Bundle | Memory | Risk | Verdict |
|---|---|---|---|---|
| Keep ywasm (status quo + patch 0003) | 2,541.45 KiB raw / 611.11 KiB gzip at base + 0003 (K3). The full spike build is 2,652.13 / 636.21 KiB (C6, w0930). Wasm is ≈ 340 KB of the gzip, ≈ 55%. | Wasm high-water ≈ 4–5× merged size, per isolate, until eviction; 96 MiB cap ≈ 20 MB merged | Lone-surrogate loss only on the Doc paths (lazy hash, root/Canvas, reset probe), not on stateless ops | **Required anyway**: the root doc (lifecycle writes root operations, `vaultLifecycleService.ts`) and Canvas semantic docs still need a server CRDT. |
| Drop ywasm for bodies only (JS yjs byte ops) | yjs-only byte-ops ≈ 75 KB raw / 22.5 KB gzip, but it is **added** unless ywasm leaves entirely; `scripts/guard-server-crdt-imports.mjs` forbids `yjs` on the server | JS heap instead of Wasm; merge ≈ 2.5× slower (K3) | Two CRDT implementations on the server | Not worth it |
| Drop ywasm entirely | ≈ −585 KiB gzip | no Wasm cap | Requires root and Canvas to move off server-authored CRDT, beyond this RFC | Out of scope; revisit after E2EE phase 5 |

Recommendation: keep ywasm, restrict body use to the three stateless ops, and delete body Doc paths in phase 4 and
the lazy hash in phase 5.

## 12. Open questions and risks

Design gaps found while checking this RFC against the code are labelled **G#**. Risks are labelled **R#**.

**Gaps.** These were found while checking the RFC against the code in rounds 1–2. Status is as of `7feae39`.

| G | Gap (as found) | Status | Fix |
|---|---|---|---|
| G1 | The feed floor never advanced for relay-only workloads, so `vault_journal` grew without bound. | **fixed, round 3** | `runCheckpointPass` advances the floor to `current − 1000`, below every pin. Unit test: 5,000 appends leave 1,001 rows (floor 4002, 41 advances). Full-n check: K1 and `C2-stress-relay` table counts. |
| G2 | With micro-batching, authority was checked only at enqueue, so a revocation inside the window still committed. | **fixed, round 3** | Re-validated at flush; dropped frames close 4403 (`authorityDrops`). |
| G3 | Batches were keyed by body only, mixed epochs were fenced together, and reset did not flush pending batches. | **fixed, round 3** | Batches keyed by (bodyId, epoch); reset flushes pending batches before its CAS. |
| G4 | Unenveloped clients make the lazy hash the normal read path (ywasm Doc, plaintext, R1). | **bounded, round 3**; structural until phase 2 | 3 MiB cap plus a 256-body cache keyed by (epoch, head sequence). Above the cap the hash state is `unknown`. |
| G5 | `syncDocumentCache` ran ywasm on the hot path, outside the merge budget. | **fixed, round 3** | It no longer applies updates. Clean residents are discarded; dirty ones are left stale (`residentStaleSkips`). |
| G6 | step1 replies had no authority re-check. | **fixed, round 3** | step1 is authority-checked (4403). |
| G7 | Dedupe ran before the authority check (receipt probe). | **fixed, round 3** | Authority now runs before dedupe. |
| G8 | The incremental SV (> 256 KiB) can overstate state and falsely accept a hash claim. | **fixed, round 3** | `stateVectorExact` flag: bodies over 256 KiB never accept a claim. Large-body reconnect resends are still appended (growth cap only catches identical bytes). |
| G9 | Exact-head reset CAS starvation. | **open** (R2) | Needs a decision. |
| G10 | The server does not verify reset or envelope `contentHash`, so hashes can be poisoned. | **open** | Mitigation options are in section 7. |
| G11 | Duplicate `candidateId` within one micro-batch went undetected. | **fixed, round 3** | Re-ack on the same digest, reject on a different one (`batchDuplicateCandidates`). |
| G12 | The committed `snapshotCoversHead` rejected every lineage-fresh reset. | **fixed, round 2**; docs aligned in round 3 | `snapshotStructurallyValid`. |
| G13 | Pending envelopes are memory-only. | **accepted**, documented as a deviation (round 3) | Hibernation between an envelope and its frame loses the pairing, so the hash is not accepted for that frame. |
| G14 | No `vault_operation_outcomes`, so `/operations/:id/outcome` was blind to relay commits. | **fixed, round 3** | Attribution `operation_id = candidateId` (lean: inline columns). |
| G15 | `diagnostics()` ran `COUNT(*)` over `vault_journal`. | **fixed, round 3** | The count runs only in the diagnostics route. |
| G16 | Multi-origin batches sent `notifyBodyCommitted` to their own origins. | **fixed, round 3** | Every origin is excluded. |
| G17 | Bootstrap docs drifted from code (committed vs WIP). | **fixed, round 3** | Protocol doc aligned with the byte merge. |
| G18 | Write amplification: 9 / 11 CF rows per plain / candidate append, one catalog event per keystroke. | **mitigated, round 4** | Lean rows: 3 / 5 CF rows (measured, n = 20 each); catalog events coalesced. Residual: section 9. |
| G19 | Reset and lease authorized once before a long upload; revocation left lease rows behind. | **fixed, round 3** | Actor re-validated inside lease and reset; leases deleted on revoke and fence. |
| G20 | Over-budget bodies: a 413 inside a batched bootstrap, and an in-memory marker that was lost on eviction. | **fixed, round 3** | Bounded prefix checkpoint, persisted `relay_body_budget` marker, and bootstrap 413 before reserving. Only a client reset recovers the body. |
| G21 | A throw in `relayMessage` sent `VAULT_ERROR` and kept the socket open, which silently lost the frame. | **fixed, round 4** | Pre-append throws close 1011 (`frameErrors`); post-commit throws are counted and never skip fan-out. A frame-accounting identity test covers it. |
| G22 | mb 0 head-of-line tails (0.4–2 s p90) behind the checkpoint alarm. | **mitigated, round 4** | `checkpointsFromCache`, the lean delayed alarm, and mb 5–10 as the default. Full-n: MB sweep, `L2-strict`, `L4-strict`. |
| G23 | Lean mode: the raw catalog log lags by ≤ 2 s; frame-0 attribution is pruned at the feed floor; turning lean off needs a coalescing pass first. | **accepted** (round 4) | Documented in `relay2-protocol.md` §6.4. Flag-off migration is not automated. |

**Not a server bug: the smoke data-loss finding (round 4).** In smoke mb0 (v0930), B missed edits. The root cause was
transport/platform plus the raw harness client, not server merge logic (section 7). The harness was fixed in
`35b2882`. The full-n runs use the fixed client and report closes per run.

**Risks:**

- **R1 — Lone-surrogate data loss in ywasm Doc round-trips (K3).**
  - When an update splits a UTF-16 surrogate pair, a round-trip through a ywasm Doc drops the text after the lone
    surrogate (`x�Zy` → `x�Z`). Stateless ops and JS yjs preserve it.
  - This **affects today's authoritative path**, which applies every body update to a ywasm Doc and re-encodes step2
    and checkpoints from it. In relay mode it affects only the lazy hash (G4) and root/Canvas docs.
    `syncDocumentCache` no longer applies updates (G5, round 3).
  - Real editors rarely emit split pairs. An upstream y-crdt issue plus a regression fixture are needed independent
    of this RFC.
- **R2 — Starvation of the exact-head reset CAS.**
  - `coveredSequence === latest_sequence` fails whenever any append lands between the client's build and the install.
  - On a hot note with a slow mobile upload (5 MB: up to 116 s) the reset may never succeed.
  - Options:
    - a short-lived append pause for the body during install: the lease blocks appends for ≤ N s, and the server
      returns backpressure
    - a covered-sequence rebase: the server appends the tail rows > covered onto the new epoch, if they can be
      transcoded, which they cannot across lineages without a client
    - retry with a smaller snapshot
  - Needs a decision.
- **R3 — The 96 MiB Wasm cap means only clients can compact bloated notes.**
  - The 5m fixture (8.7 MB, 246k structs) traps the server (`unreachable`) in a Doc.
  - Stateless merge high-water is ≈ 4–5× merged size, so ≈ 20 MB merged is the cap even without a Doc. The 9 MiB
    merge budget keeps the server below it.
  - Past that, a body is served unmerged and never checkpointed until a client resets it. A vault whose devices never
    run the reset policy keeps that body's tail forever.
- **R4 — Estimated SV for bodies > 256 KiB.** G8 is the correctness side. The performance side: exact SVs above
  256 KiB cost 1.2 ms (1 MB) to 14 ms (10 MB) per append (K3), which exceeds a 10 ms Worker-style budget. The
  incremental SV is therefore needed, and its drift must be measured (`stateVectorDrift` in C2/stress).
- **R5 — Write amplification against the free tier (section 9).**
  - Before lean rows: one append per frame at 9–11 CF rows, ≈ 55 rows per typing-second at 5 frames/s. The model put
    a typical 2 h editing day at 119% of 100k rows/day.
  - Lean rows (round 4, measured 3 / 5 CF rows per plain / candidate append) bring the model to 47–65% for the relay,
    against 39% (base, rows per edit) or 82% (base, rows per flush). That is inferred. Using the smoke per-edit rows
    (7.26) gives 85%.
  - Strict (lean off, mb 0) stays at 101%. Lean is required on Free.
  - Residual risk:
    - continuous typing above ≈ 1.1–1.3 h/day (the 100k crossing point)
    - import days, where both modes reach the limit
  - Confirm with full-n `C4-*` and `C2-*` rows per edit.
- **R6 — Tail CPU measurements are lossy.**
  - `wrangler tail` dropped every WS event on a busy Worker (scratch-1 C1: 0 events). It matched 15/15 on a quiet one
    (scratch-2).
  - C1/C2 numbers must come from gql aggregates (`Invocations`, µs) or from matched-sample tails with loss reported.
    Per-event p50 from a lossy tail is biased toward quiet periods.
- **R7 — Receiving-side validation does not exist yet.** Relay mode without it drops today's server-side
  frontmatter/root-shape gate.
- **R8 — Measurements taken in Node** (K3, K2) and on an enterprise account. Workers Free DO limits are the same
  tables, but CPU and memory accounting on the edge may differ.

**Open questions:**

- **Q1** (Answered in round 4 by lean rows: catalog events are coalesced per body per alarm pass.) Is a catalog delta
  feed lag of ≤ 2 s acceptable to every reader, or do some need per-append events?
  Currentness then needs `latest_sequence` from the head, which it already has.
- **Q2** Should step1 always answer by sequence (unmerged parts) rather than by SV diff? That trades bytes for E2EE
  readiness and zero merges.
- **Q3** A poison-pill policy for bodies whose bytes make merges throw: quarantine, and surface to clients for a reset?
- **Q4** Lease TTL vs upload size: should the TTL scale with the declared snapshot size, or should an upload in
  progress extend the lease?
- **Q5** Keep attribution per frame or per append? Per frame is N rows per batch. Lean keeps frame 0 inline and
  prunes it at the feed floor. Is losing long-term per-edit attribution acceptable?
- **Q7** Should turning lean off be supported (it needs a forced coalescing pass first)?
- **Q6** Rollback relay → base on the same storage: allowed or forbidden?

## 13. Reversal conditions

Abandon the change or roll back to base if **any** of the following holds at full n on the Workers Free-representative
config:

1. **Latency.** Relay L2 p50 is not at least 2× better than base, or relay L2 p99 is worse than base p99.
2. **Rows written.** With measured C4 on the lean + mb 10 config, the costmodel typical day (2 h, 3 devices,
   5 frames/s) is > 100% of 100k rows/day for the relay **and** > 1.25× base. Pre-filled model (inferred): 47–65%
   relay (85% pessimistic, using smoke per-edit rows) against 39–82% base. That is under 100%, so the condition is
   not triggered. Full-n C4 and C2 confirm or refute this.
3. **DO requests.** Idle or typical-day DO requests for the relay are > 1.1× base (C5).
4. **Correctness.** Any convergence failure (section 8.7), any violation of invariants 1–5, 3a, 7, 8 or 11 in tests
   or deployed runs, or any frame-accounting identity mismatch. Examples: an append after the revocation fence
   sequence (B4), an old-epoch append (B5), more than one append per resent candidate (B6), or an unaccounted frame. A
   loss traced to the platform or transport with the resilient client in place counts too.
5. **CPU.** Relay C1 heavy-note CPU per keystroke p50 is not below base's, or relay p99 per append is > 10 ms on a
   ≤ 256 KiB body.
6. **Memory and scale.** Relay X1 is below 250 concurrent body sockets per vault, or relay C3 Wasm high-water at
   32 × 512 KiB exceeds base.
7. **Reset.** Mobile-class inferred reset build p50 for 1 MB is > 2 s, or B5 at full n shows a lost edit, or reset
   starvation (R2) persists: fewer than 90% of reset attempts on a note edited at 1 frame/s succeed within 3 tries.
8. **Stored-state growth.** After the G1 fix, `vault_journal` rows per relay body are not bounded (more than
   checkpoint entries + feed retention) after the stress trace.
9. **Post-launch regression.** A support-visible rise in conflict copies, attributable to rebase, of more than 2× base
   in the first release.

## 14. Appendix

### 14.1 Harness usage

See `scripts/relay2/README.md`. In short:

```
zsh scripts/relay2/deploy.sh yaos-relay2-<name> --relay on|off [--require-clean | --src <tree>]
node tests/run-typescript.mjs --test-aliases scripts/relay2/context.ts --host <url>
node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts <scenario> --host <url> --out <json> \
     --adapter base|relay|relay-nosv|relay-nocand [--tail]
python3 scripts/relay2/analyze.py <run.json…>          # summaries
node tests/run-typescript.mjs --test-aliases scripts/relay2/gql.ts …   # CPU from analytics (preferred, R6)
python3 scripts/relay2/costmodel.py [--set k=v] [--json measured.json]  # section 9
```

Other entry points:
- Reset and K2: `scripts/relay2/reset/`.
- Byte ops and K3: `scripts/relay2/k3/`.
- Core smoke: `scripts/relay2-core-smoke.ts <host>`.

Local tests (round 4 unless noted):

| Suite | Result |
|---|---|
| `tests/server/relay2-server-core.ts` | 31/31 in default and lean modes (round 3: 27/27) |
| `tests/server/relay2-byteops.ts` | 9/9 |
| `tests/client/relay2-reset-builder.ts` | 45/45 |
| `tests/client/relay2-reset-policy.ts` | 31/31 |
| `tests/client/relay2-reset-race.ts` | 127/127 |
| flag-off regressions | 3,635 pass, 0 new failures (round 2: 3,622/0; round 1: 199/199 steps) (`results/relay2/flag-tests.md`) |
| flag on (default and lean) | only the expected capabilities key-set failures. Lean matches after the lazy-ALTER fix. Headless 92/92 in both modes (round 3). Conformance 13/13 flag off (round 3). |
| base suites (base SHA) | 179/179 suites, 3,135 assertions; node-runtime 32/32; conformance 26/26 (1 declared GAP); headless 92/92 (1 of 4 flaky) (`results/relay2/base-tests.md`) |

### 14.2 Raw data index

| Data | Location |
|---|---|
| Full-n run JSONs (per scenario id) | `experiments/results/relay2/raw/<id>.json`, manifest `raw/runall-manifest.jsonl` |
| Small-n / smoke run JSONs | `experiments/logs/relay2/runs/`, `experiments/logs/relay2/runall-w0930-small/raw/` (not in git; contexts hold tokens) |
| Deploy records | `experiments/logs/relay2/deploy-<name>.json` |
| Results tables | `experiments/results/relay2/RESULTS.md`; report `REPORT.md` |
| K2 | `experiments/results/relay2/K2.md`, `K2-local-2026-09-29T19-58-32-456Z.json` |
| K3 | `experiments/results/relay2/K3.md`, `K3-byteops-all.json`, `K3-byteops-svdiff-all.json`, `K3-bundle-size.json` |
| B5 | `experiments/results/relay2/B5-2026-09-29T20-13-40-001Z.json`, `B5-2026-09-29T20-16-32-720Z.json` |
| Live reset (round 2/3) | `experiments/results/relay2/core2-live-reset-5mb.json`, `core3-live-reset-5mb.json` |
| Flag / base tests | `experiments/results/relay2/flag-tests.md`, `base-tests.md`, `base-tests.json`, `core{,2,3,4}-flag-*` logs |
| Prior art | `experiments/results/A1.md`, `A2-A4.md`, `A3.md`, `A5.md` |
| Convergence | <<MEASURED: raw/convergence-suite.json, convergence-suite-strict.json, convergence-suite-base.json>> |
| Final deploy version IDs (base / relay / strict) | <<MEASURED: runall full tag; workers yaos-relay2-<tag>-<group>-<variant>, version ids + spike SHA>> |
