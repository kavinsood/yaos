# Relay v2 body protocol (spike, `relay-v2-spike` branch)

Status: experimental. Everything here is gated by the Worker var
`YAOS_RELAY_BODIES === "true"`. With the flag unset or set to any other value, the server is
byte-for-byte the phase0 server: it adds no routes, frames or tables, and nothing on the socket
path changes.

Owner: server-core agent. The harness agent and reset agent build clients against this document.
Brief: `experiments/PHASE2-RELAY-SPIKE-V2.md`. Binding decisions: `experiments/results/relay2/DECISIONS.md`.

## 1. Model

In relay mode the server never holds a CRDT document for a body in the hot path:

- **Log.** Each accepted update is one row in the existing `vault_journal` (D5 option a). It takes a
  `vault_clock` sequence, advances `vault_document_heads`, and writes one catalog event and one
  attribution row. Feed, catch-up, bootstrap and pins read that table, so they see relay edits with
  no further changes.
- **Merged bytes.** The server keeps the body's merged state as bytes: checkpoint plus journal
  tail, merged with ywasm `mergeUpdatesV1`. There is a bounded per-runtime LRU cache of
  `{epoch, latestSequence, mergedBytes|null, stateVector}`.
  - Bodies whose merged bytes are at most `YAOS_RELAY_EXACT_MERGE_BYTES` (default 256 KiB) are
    merged exactly on every append (exact SV, exact no-op check).
  - Larger bodies (K3: whole-state merge/SV costs 7-14 ms at 5-10 MB) keep the head SV
    **incrementally**: `SV' = pointwise max(SV, SV(update))`. The bytes are marked stale and rebuilt
    lazily on the next step1/HTTP read. See §8 for the risk this carries.
- **Byte ops.** State vector and diff are computed from those bytes with the patch-0003 ywasm
  byte ops (`server/src/crdt/ywasmByteOps.ts`). No Y.Doc and no `yjs` import on the server.
- **Checkpoint.** An alarm-driven checkpoint merges the tail at the byte level at 50 entries or
  1 MiB. It is written into the existing checkpoint tables in one transaction. One pass merges at
  most `YAOS_RELAY_CHECKPOINT_MAX_ROWS` (default 200) tail rows (K3: merge cost is superlinear in
  frame count). A longer tail gets a **partial** checkpoint through the 200th row, and the alarm
  re-arms immediately for the rest.
- **History GC.** A client performs history GC, holding a lease: `compaction-lease` then
  `semantic-reset` (§5).

Root sockets and root documents are unchanged in relay mode. Only `kind === "body"` sockets and
body documents use the relay path.

## 2. Socket: accept

`GET /vault/:id/ws/body/:bodyId?ticket=…&schemaVersion=…&protocolVersion=…`: unchanged URL and
auth. The body epoch comes only from the HMAC socket ticket (`POST …/socket-ticket` with
`bodyEpoch`), as in base.

Relay-mode differences:

- **Skipped:** `MAX_BODY_SOCKETS` (32), `cache.admitBody`, `cache.load` and the
  semantic-compaction admission pause.
- **Sanity cap:** at most `YAOS_RELAY_MAX_BODY_SOCKETS` (default 5000) body sockets per vault
  DO. Over the cap, the upgrade is refused with HTTP 429 `{error:"body_socket_limit"}`. Relay
  sockets do not count toward base `MAX_BODY_SOCKETS`.
- **Epoch:** the body epoch is checked against the durable head (`vault_document_heads`). On a
  mismatch the server returns the same `SemanticEpochMismatchError` payload as base.
- **Body state:** the body must be active (`activeBodyHead`), as in base.
- **Handshake:** the server sends step1 = the state vector of the stored merged bytes.
  `VAULT_READY` is the same frame as base; `durableGeneration` is the head generation.
  `capabilities` is the base object plus `relayBodies: 2`
  (`{"currentnessQuery":2,"committedHead":2,"relayBodies":2}`). `GET /api/capabilities` also
  carries `"relayBodies": 2` when the flag is on, and omits the field when it is off.
- **Runtime identity:** relay body sockets survive a DO wake. The `runtimeEpoch` check in
  `message()` is bypassed for them (§4.4).

## 3. Socket: client → server frames

### 3.1 Sync frames (binary, y-protocols)

| Frame | Server action |
|---|---|
| `MESSAGE_SYNC` step1 (client SV) | Reply step2 = `diffUpdate(merged, clientSV)`. Nothing is written. |
| `MESSAGE_SYNC` step2 | Append path (§3.3). |
| `MESSAGE_SYNC` update | Append path (§3.3). |
| `MESSAGE_AWARENESS` | Phase0 semantics: own awareness only; the server rewrites `state.user`. |

Oversized frames close with 1009, as in base: a frame larger than `MAX_CANDIDATE_BYTES + 64`,
or an inner update larger than `MAX_DURABLE_UPDATE_BYTES` (1,750,000 B).

### 3.2 Envelope (D6), `__YPS:` text frame immediately before a binary update

```json
{
  "type": "BODY_UPDATE_ENVELOPE",
  "bodyId": "…",
  "bodyEpoch": 1,
  "clientFrameId": "…",
  "payloadDigest": "<sha256 hex of the INNER Yjs update bytes (the sync message payload, not the whole frame)>",
  "candidateId": "…",
  "candidateDigest": "…",
  "contentHash": "<canonicalMarkdownHash of the client's text after applying the update>",
  "size": 1234,
  "stateVector": "<base64 of Y.encodeStateVector(clientDoc) after applying the update>",
  "frameKind": "update"
}
```

Required fields: `type`, `bodyId`, `bodyEpoch`, `clientFrameId` and `payloadDigest`.
Optional fields: `candidateId`, `candidateDigest`, `contentHash`, `size`, `stateVector` and
`frameKind` (`"update"` or `"step2"`, informational only).

Pairing rules:

- The envelope applies only to the **next binary sync frame** (step2 or update) on the same socket.
  - If that frame's `sha256(innerUpdate) !== payloadDigest`, the frame is treated as having **no
    envelope**. It is still appended, but gets no `clientFrameId` echo and no hash.
  - A second envelope before a binary frame replaces the first.
- An envelope for another `bodyId` or `bodyEpoch` is ignored.
  - A binary frame on a socket whose epoch is stale is fenced with 4409 anyway (§4.3).
- Pending envelopes live in DO memory only (G13, kept by design). If the DO hibernates between
  the envelope and the binary frame (practically never, since the two are adjacent), the frame
  counts as envelope-less: it is appended with an unknown hash and gets no `clientFrameId` echo.
  The client times out and resends; the resend is a no-op (`noop: true`) or, with a `candidateId`,
  a dedupe hit. A lost envelope can never pair with a different frame, because pairing requires
  `sha256(innerUpdate) === payloadDigest`.

Currentness (D6, invariant #7): `contentHash`/`size` are recorded on the new catalog event
**only if** `stateVector` is present **and** it equals (semantic map equality) the state vector
of the body's merged bytes after the append.

- Otherwise the new catalog event has `content_hash = NULL, size = NULL`, meaning "unknown".
- Envelope-less frames (e.g. y-partyserver's internal step2) always give "unknown".
- Therefore a recorded hash always describes exactly the merged state at that catalog event.

Reconciling "unknown":

- A later frame whose envelope matches the merged SV makes the hash known again.
- HTTP body reads with an unknown hash materialise once (lazy, off the hot path, counted in
  diagnostics). They backfill the catalog event in place when it is still the head.
- `BODY_CURRENTNESS_QUERY` answers from the catalog: `contentHash: null` means unknown. The
  client reconciles by fetching the body.

### 3.3 Append path (per binary step2/update frame)

The path is synchronous in the DO; nothing awaits between the merge and the commit. Steps run in
this order (as implemented): size limit (1009), envelope pairing, 1 empty skip, 2 authority,
3 dedupe, 4 budget, then (inside commit) epoch fence, 5 growth cap, D6 check, 6 transaction,
7 fan-out. The growth cap runs after authority and budget because it needs the merged state; a
revoked or rate-limited socket never costs a merge. Authority runs before dedupe (round 3, G7), so
a revoked device cannot use `candidateId` probes to learn receipts.

`SYNC_STEP_1` from a body socket is authority-checked the same way before it is answered (round 3,
G6): a revoked actor gets close 4403 instead of a step2 carrying the body.

1. **Empty skip.** An inner update equal to `[0,0]` is not appended (`emptySkips++`).
2. **Authority re-check.** `validateActor` runs against the DO's own authority tables, with a
   per-runtime cache keyed by an in-memory authority version. The version is bumped by device
   revocation, authority fences, membership and provisioning writes, and there is a 5 s TTL safety
   net. A revoked actor gets `{type:"error", code:"authority_superseded"}` and close 4403.
3. **Candidate dedupe.** This step applies only if the envelope carries `candidateId`. The server
   looks up `vault_candidate_receipts(bodyId, deviceId, candidateId)`:
   - Same digest (`candidateDigest ?? payloadDigest`): the original receipt is re-sent as
     `BODY_COMMITTED` with `deduped: true`. Nothing is appended.
   - Different digest: the frame is rejected with
     `{type:"BODY_UPDATE_REJECTED", clientFrameId, candidateId, reason:"candidate_id_reused"}`.
     Nothing is appended.
4. **Budgets.** Each socket has a token bucket: `YAOS_RELAY_RATE_BYTES_PER_SEC` (default
   262144) refilling a burst of `max(YAOS_RELAY_BURST_BYTES, MAX_DURABLE_UPDATE_BYTES)` (default
   and floor 1,750,000 bytes). The floor guarantees one maximum-size frame always fits; before round 2,
   frames between 1 MiB and 1.75 MB were rejected forever. An empty bucket gets
   `{type:"VAULT_BACKPRESSURE", reason:"relay_rate_limit"}` and close 1013.
5. **No-op skip (growth cap).** Small bodies (exact path): if `mergeUpdates([merged, u])` is
   byte-identical to `merged`, the update adds nothing (for example, a reconnect step2 re-sending
   a covered delete set). Large bodies (incremental path): only an exact resend of the last
   appended update is detected. A skipped update is not appended (`noopSkips++`); the origin still
   gets `BODY_COMMITTED` with `noop: true` and the current head sequence.
6. **Commit**, in one `transactionSync` (per frame, or per micro-batch):
   - epoch fence against the head
   - active-body check against the latest catalog event
   - clock +1
   - journal insert (`kind='body'`)
   - attribution row(s); a candidate frame's row carries `operation_id = candidateId` and
     `request_digest = candidateDigest` (round 3, G14), so `GET /operations/:candidateId/outcome`
     finds the commit through the base `committedOperationOutcome` lookup. No
     `vault_operation_outcomes` row is written.
   - head update (`generation+1`, `latest_sequence`)
   - catalog event (copies file/path; new generation; hash or NULL)
   - candidate receipt row, only when `candidateId` is present

   There is no head CAS on merged state: appends commute, and only the epoch is compared (D5.1).
7. **After commit:**
   - `BODY_COMMITTED` goes to the origin (§4.1).
   - The raw update frame is broadcast to the other body sockets of that body and epoch.
   - The base `BODY_COMMITTED` goes to root sockets. Peer relay body sockets of the same body and
     epoch get it too, with `relay: true, peer: true` and their own admission `runtimeEpoch`, and
     are never closed by it. Every origin socket of the commit is excluded (for a micro-batch,
     all origins and duplicate senders; round 3, G16), since each already got its own receipt.
   - The checkpoint alarm is armed if the tail is over the thresholds.

**Micro-batching:** `YAOS_RELAY_MICROBATCH_MS` (default `0` = off, clamped to 0..250; the cap
was 50 before round 3). When it is greater than 0, frames arriving within the window share one
transaction and one clock sequence:

- One journal row holds the merged update.
- There is one attribution row per frame (`mutation_index` = frame index).
- There is one catalog event per batch.
- Every origin gets its own `BODY_COMMITTED`, all with the same `vaultSequence`.
- Batches are keyed by `(bodyId, bodyEpoch)` (round 3, G3). A frame for another epoch never joins
  a batch, and the epoch fence judges each batch separately. `semantic-reset` flushes the body's
  pending batches before its CAS, so a queued frame either commits first (and the reset sees
  `head_advanced`) or is fenced with 4409 after it.
- At flush time every frame's actor is re-validated (round 3, G2). A frame whose actor was revoked
  while it waited is dropped, and its socket gets 4403 once (`authorityDrops++`).
- Duplicate `(deviceId, candidateId)` inside one batch (round 3, G11): the first frame is
  appended. A later frame with the same digest is not appended and gets the first frame's receipt
  with `deduped: true`. A later frame with a different digest gets `BODY_UPDATE_REJECTED`
  `candidate_id_reused` (`batchDuplicateCandidates++`).

## 4. Socket: server → client frames

### 4.1 `BODY_COMMITTED` (origin, relay mode)

This is the base `BODY_COMMITTED` frame with extra fields:

```json
{
  "type": "BODY_COMMITTED",
  "bodyId": "…", "bodyEpoch": 1, "vaultGeneration": 1,
  "durableGeneration": 17, "vaultSequence": 4242,
  "lifecycle": "active", "contentHash": "…|null", "size": 123,
  "runtimeEpoch": "<runtime epoch that ADMITTED this socket>",
  "relay": true,
  "clientFrameId": "…",
  "candidateId": "…", "candidateDigest": "…", "payloadDigest": "…",
  "commitRuntimeEpoch": "<runtime epoch that committed>",
  "contentHashAccepted": true,
  "deduped": false,
  "noop": false
}
```

- `clientFrameId` is present only when the envelope paired.
- `candidateId` and `candidateDigest` are present only when the envelope carried them.
- `contentHash` and `size` describe the committed head. Clients must compare them with their own
  hash before treating the note as current. `contentHashAccepted` says whether this frame's
  claimed hash was recorded.
- Durability is guaranteed by ordering: the frame is sent only after `transactionSync` returns.

### 4.2 Peers

- Other body sockets of the same body and epoch get the committed update as a normal y-protocols
  update frame, after commit.
- Root sockets get the base `BODY_COMMITTED`. Peer relay body sockets get it with
  `relay: true, peer: true` and no `clientFrameId` (it is a head notice, not a receipt).
- The origin sockets of a commit never get the peer notice (§3.3 step 7).

### 4.3 Close codes

| Code | Meaning |
|---|---|
| 4409 | Semantic epoch fenced. Sent on a frame for a stale epoch and after a `semantic-reset`. Client rebases. |
| 4403 | Authority superseded (revoked device or membership, authority fence). |
| 1013 | Backpressure: token bucket empty, reason `relay rate limit`, preceded by `VAULT_BACKPRESSURE` `relay_rate_limit` (`rateLimitCloses++`). (The socket cap refuses the upgrade with 429.) See the 1013 note below. |
| 1009 | Frame too large. |
| 1008 | Body deleted or not active (`closeBody`), or socket authority mismatch (root sockets only). |
| 1011 | Durable commit failed (`commitFailures`), or `relay frame error`: any throw before the append (`frameErrors`, preceded by `VAULT_ERROR` `relay_frame_error`). The client reconnects and resends through step2. |

**1013: ours vs the platform (round 4).** The server sends 1013 only with one of these reasons:
`relay rate limit` (relay token bucket), `semantic compaction pressure`, `body cache budget exceeded`
and `pending durability budget exceeded` (base socket service). None of them is `Service overloaded`.
A 1013 with reason `Service overloaded` (or an empty reason) comes from the Cloudflare runtime:
the Durable Object was overloaded (too many queued requests or events, or CPU saturation), and
the platform shed the connection. The server never sees these closes, so no counter moves. To tell
them apart, check the reason string and whether `rateLimitCloses` grew (and whether a
`VAULT_BACKPRESSURE` frame arrived first). The K1 1013 was the platform: the sender was flooding
one DO at mb=0 with one transaction and one output-gate flush per frame.

**No silent drops (round 4).** Every non-empty `SYNC_UPDATE` frame (`updateFrames`) ends in exactly
one outcome. Each outcome has a counter, and the counters satisfy

`updateFrames = appendFrames + noopSkips + dedupeHits + dedupeConflicts + batchDuplicateCandidates
+ authorityCloses + authorityDrops + rateLimitCloses + epochFences + bodyInactiveCloses
+ tooLargeCloses + commitFailures + frameErrors`

Each outcome is one of: appended, acked or skipped as a justified no-op, or the socket is closed
with an error code. A throw anywhere before the append, including the micro-batch timer path and
`VaultSocketService.relayMessage`, closes 1011 (`failFrames`); before round 4 the socket path sent
`VAULT_ERROR` and kept the socket open, so the frame was lost with no close. A throw after the
append (`postCommitErrors`, `lastFrameError`) is counted and the remaining post-commit steps
still run, so one failing origin send can never cost a peer its fan-out frame.

### 4.4 Runtime identity

Base clients accept `BODY_COMMITTED` only when `runtimeEpoch` equals the epoch that admitted
their socket. Relay body sockets survive a DO wake, so relay mode does the following:

- `runtimeEpoch` echoes the socket's **admission** epoch (from its attachment), so existing parsing
  keeps working.
- `commitRuntimeEpoch` names the runtime that actually committed.
- The receipt's evidence is commit-before-send plus `vaultSequence`, not runtime identity.
- Relay body sockets of an older runtime receive `BODY_COMMITTED` normally; they are not closed.
- Root sockets keep base behaviour (hint or close).

## 5. HTTP

All new routes exist only when `YAOS_RELAY_BODIES === "true"` (404 otherwise), and use the
normal vault bearer auth.

### 5.1 `POST /vault/:id/body/:bodyId/compaction-lease`

Requires the `vault.content.write` capability.

Request: `{"expectedEpoch": 1, "ttlMs": 120000}`. `ttlMs` is optional, defaults to 120000 and is
clamped to [1000, 600000]. `{"release": "<leaseId>"}` releases a lease the caller holds
(`200 {"released": true}` or `404 {"released": false}`).

This is a CAS on `relay_compaction_leases(body_id PK)`. The lease is granted if there is no row,
the row has expired, or the row is held by the same device (re-grant, new `leaseId`), **and**
`expectedEpoch` equals the head epoch.

- `200 {"granted": true, "leaseId", "expiresAt", "epoch", "headSequence", "generation", "stateVector", "policy"}`
  - `headSequence` is the head `latest_sequence`.
  - `stateVector` is the base64 SV of the merged bytes at `headSequence`.
  - `policy` (round 2) is `{"lastResetAt": ms|null, "cooldownMs", "cooldownRemainingMs", "nextResetAllowedAt": ms|null}`.
- `429 {"granted": false, "reason": "cooldown", "epoch", "headSequence", "policy"}` with a
  `retry-after` header in seconds. This is the server reset cooldown (round 2): no lease is granted
  until `YAOS_RELAY_RESET_COOLDOWN_MS` (default 24 h, mirroring
  `BODY_COMPACTION_THRESHOLDS.softCooldownMs`) has passed since the body's last semantic reset.
  `lastResetAt` is `vault_semantic_compaction_state.last_compacted_at`, which
  `semanticResetFromEncodedState` already writes, so the cooldown adds no table. `semantic-reset`
  re-checks the cooldown, so a lease granted just before a concurrent reset cannot slip through.
  Test workers set the var small in `[vars]`.
- `409 {"granted": false, "reason": "held"|"epoch_mismatch", "epoch", "headSequence", "holderDeviceId"?, "expiresAt"?}`
- `403 {"granted": false, "reason": "authority_superseded", "epoch": null, "headSequence": null}`
  (round 3, G19): the actor is re-validated right before the lease CAS, not only at request
  start.

Leases are released when authority goes away (round 3, G19). Device revocation deletes every
lease that device holds. An authority fence deletes the leases of every device and principal
subject it names. This is conservative: a fence over a principal drops the leases of all that
principal's devices.
- `404 {"granted": false, "reason": "not_found", …}`: the body is unknown or not active.

**Client shape change (round 2, `scripts/relay2/reset/leaseClient.ts` + `httpTransport.ts`).** A
granted result gains `policy`. A denied result gains `reason: "cooldown"` (HTTP 429) and an
optional `policy`; the client should wait `retry-after` or `policy.cooldownRemainingMs` rather than
retry. The SV coverage check is gone (§5.2), so the builder's `coverStateVector` GC-struct prefix is
no longer needed; it is still accepted. Transports should switch to the octet-stream reset body.

### 5.2 `POST /vault/:id/body/:bodyId/semantic-reset`

Requires the `vault.content.write` capability.

Two request shapes are accepted.

**Binary (preferred, round 2).** `Content-Type: application/octet-stream`. The body is the raw
Yjs v1 full-state snapshot, up to `MAX_CATCH_UP_BYTES` (8 MiB). The metadata goes in headers:

| Header | Query fallback | Value |
|---|---|---|
| `x-yaos-lease-id` | `leaseId` | lease id |
| `x-yaos-expected-epoch` | `expectedEpoch` | integer ≥ 1 |
| `x-yaos-covered-sequence` | `coveredSequence` | integer ≥ 0 |
| `x-yaos-content-hash` | `contentHash` | 64 lowercase hex |
| `x-yaos-content-bytes` | `contentBytes` | integer ≥ 0 |

A header wins over the query parameter of the same field. The binary shape skips base64 (4/3
inflation) and JSON parsing, which is about 1.8x the snapshot in transient JS heap, on a 128 MB
isolate.

**JSON (legacy, kept).** The forwarded body limit is 8 MiB, so the snapshot tops out near 6 MB:

```json
{"leaseId": "…", "expectedEpoch": 1, "coveredSequence": 4242,
 "contentHash": "…", "contentBytes": 1234, "snapshot": "<base64 Yjs v1 full-state update>"}
```

The server checks, and then installs, in order. Before step 1 it flushes the body's pending
micro-batches (§3.3). Authority is re-validated inside the reset transaction (round 3, G19); the
snapshot upload before it can take minutes. A revoked actor gets
`403 {"ok": false, "reason": "authority_superseded"}` and its leases are deleted.

0. **Structural sanity only:** the snapshot has between 2 bytes and 8 MiB, its state vector
   decodes (`stateVectorFromUpdate`), and the SV is non-empty unless `contentBytes == 0`.
   Otherwise the server returns `400 invalid_snapshot`.
   - **Round 2 removed the SV coverage check** (`SV(snapshot) ⊇ headSV`). A correct client
     snapshot is *lineage-fresh*: a new Y.Doc holding the text, with a new client id. Its SV
     never covers the old head SV, so the check rejected every correct reset unless the client
     prepended GC structs. And it proved nothing about content anyway.
1. The lease is valid (same `leaseId`, same device, not expired).
2. `expectedEpoch` equals the head epoch.
3. `coveredSequence` equals the head `latest_sequence` **exactly**.
4. The reset cooldown has passed (`409 {"reason": "cooldown", "policy"}`; see §5.1).

**Currency proof.** Steps 1–3 together are the proof that the snapshot is current: epoch CAS,
plus a lease, plus `coveredSequence == head` exactly. Appends take a `vault_clock` sequence inside
their commit transaction, and the reset runs in one synchronous transaction that re-reads the head.
So if any edit landed after the head the client built from, the head moved and the reset fails
with `head_advanced`. The server cannot check that the snapshot *text* equals the head text
without a document. That part stays client trust, like the envelope hashes (D6).

**Hot-note CAS starvation.** On a note receiving edits continuously (for example, a live
transcript), the head can move during every build → upload window, so every reset fails
`head_advanced` until the lease expires. Mitigations:

- *Client (recommended):* re-read the head, rebuild from the local
  doc (the rebuild is O(text), about 100 ms at 5 MB), re-POST under the same lease, and add
  jittered backoff between attempts. Only reset when the note has been idle for a moment, since
  the policy thresholds make resets rare anyway.
- *Server (documented, not implemented):* an optional append-pause window. While a lease is held
  with `pauseAppends: true`, relay appends for that body are deferred (queued in memory, bounded
  by the lease TTL and by `YAOS_RELAY_MICROBATCH_MS`-style buffering) or rejected with
  `VAULT_BACKPRESSURE`. That gives the holder a quiet window of at most a few seconds. It trades
  edit latency for guaranteed progress, and the lease TTL bounds the damage if the holder dies.
4. `semanticResetFromEncodedState(bodyId, snapshot, {throughSequence: coveredSequence, generation, semanticEpoch: expectedEpoch})`
   installs the snapshot. In one transaction it writes a checkpoint at a new sequence, bumps the
   epoch, advances the head and copies the catalog event. In relay mode that catalog event
   records the client's `contentHash` and `contentBytes`.
5. The lease row is deleted.
6. `fenceSemanticEpoch` closes old-epoch sockets with 4409.
7. The merged-bytes cache is invalidated.

Responses:

- `200 {"ok": true, "epoch", "previousEpoch", "sequence", "generation", "fencedSockets", "policy"}`
- `409 {"ok": false, "reason": "lease_invalid"|"lease_expired"|"epoch_mismatch"|"head_advanced"|"cooldown", "epoch", "headSequence", "policy"?}`
- `403 {"ok": false, "reason": "authority_superseded"}` (round 3)
  - `head_advanced`: rebuild from the current head and retry while the lease is valid.
- `400 {"ok": false, "reason": "invalid_request"|"invalid_snapshot"}`
- `413 {"ok": false, "reason": "too_large"|…}`: the body is over the 8 MiB bound.

A successful reset also drops any resident base-path document (`discardResident`) and prunes the
old epoch's journal rows, checkpoints and manifests (`pruneUnpinnedDocumentHistory`; bootstrap and
restore pins are kept).

The server does **not** verify that `contentHash` matches the snapshot text, because it would need
a doc. Clients are trusted, as with envelope hashes.

### 5.3 Existing reads, relay mode

- **`GET /vault/:id/body/:bodyId`** returns the merged stored bytes (checkpoint + tail, byte
  merge). Headers:
  - `x-yaos-body-epoch`
  - `x-yaos-generation`
  - `x-yaos-head-sequence` (the head `latest_sequence`)
  - `x-yaos-content-hash`, empty when unknown
  - `x-yaos-size`, empty when unknown
  - `x-yaos-content-hash-state`: `known`, `materialised` (computed just now by the lazy hash) or
    `unknown`

  It returns `413 {"error": "relay_merge_budget_exceeded"}` for an over-budget body (§6.2).
- **`HEAD /vault/:id/body/:bodyId`** (relay mode only; base has no HEAD route) returns the same
  headers with no body. It reads only the durable head and the catalog: no byte merge and no
  document. `x-yaos-content-hash-state` is `known` or `unknown`. A client polls it cheaply for
  sequence, generation and epoch.
- **`/catch-up`** returns merged stored bytes. `contentHash`/`size` can be `null` (unknown). An
  over-budget body gets a per-item `{"status": 413, "error": "relay_merge_budget_exceeded"}`.
- **Bootstrap body reads** (`/bootstrap/:id/body/:bodyId` and the batch route) use a byte merge in
  relay mode (round 2). They merge the pinned checkpoint at or before the boundary with the
  journal tail through the boundary (`durableMergedBytes(bodyId, boundarySequence)`), with no
  document. A reset after the boundary still serves the old lineage, because the pin keeps the
  old epoch's rows (this is what the WIP and committed code do; an older revision of this doc
  said bootstrap reconstructs a document, G17). Over budget, the batch route returns
  `413 {"error": "relay_merge_budget_exceeded", "bodyId", "overBudgetBodyIds"}` before it reserves
  any budget (round 3, G20). An unmodified client bisects on 413, so it ends up failing only on
  the over-budget body; the extra merges of the other bodies in the rejected batches are bounded
  by the bisection depth.
- **Lazy hash.** If the head catalog event has a NULL hash and the merged bytes are at most
  `YAOS_RELAY_LAZY_HASH_MAX_BYTES` (default 3 MiB), the server materialises the document once,
  computes `canonicalMarkdownHash` and backfills that catalog event in place
  (`materialisations++`). Above that size the hash stays unknown (`lazyHashSkips++`), because a
  document for a large, struct-dense body can exceed the wasm memory budget (§6.2).
  A per-runtime cache (round 3, G4; at most 256 bodies) remembers the computed hash per
  `(bodyId, epoch, headSequence)`, so repeated reads of a head whose catalog event is no longer the
  newest one do not materialise again (`lazyHashCacheHits++`). A reset clears the body's entry.

### 5.4 Diagnostics

- `GET /vault/:id/diagnostics` (existing, `vault.diagnostics.read`) gains a `relay` object:

  ```json
  { "enabled": true, "config": {…},
    "counters": { "appends", "appendFrames", "emptySkips", "noopSkips", "dedupeHits", "dedupeConflicts",
                  "materialisations", "checkpoints", "lastCheckpointMs", "checkpointRowsWritten",
                  "resets", "leaseGrants", "leaseDenials", "rowsWritten", "rateLimitCloses",
                  "epochFences", "authorityCloses", "commitFailures", "mergedCacheRebuilds",
                  "step2Replies", "envelopeMismatches", "hashAccepted", "hashUnknown",
                  "incrementalAppends", "stateVectorDrift", "partialCheckpoints", "mergeBudgetRejects",
                  "unmergedStep2Replies", "lazyHashSkips", "lazyHashCacheHits", "authorityDrops",
                  "batchDuplicateCandidates", "residentStaleSkips", "floorAdvances", "floorRowsPruned",
                  "updateFrames", "frameErrors", "postCommitErrors", "bodyInactiveCloses", "tooLargeCloses",
                  "leanCatalogEvents", "leanCoalesceRowsWritten", "checkpointsFromCache",
                  "appendsPerSecond" },
    "lastFrameError": { "at", "message" } | null,
    "documentMaterialisations": { "root", "nonRoot", "recentNonRoot": [ { "documentId", "throughSequence", "at" } ] },
    "byteOps": "<ywasm byte-ops backend name>",
    "bodies": [ { "bodyId", "epoch", "latestSequence", "generation", "logRows", "logBytes",
                  "checkpointSequence", "stateVectorBytes", "mergedBytes|null", "stateVectorExact" } ],
    "mergedCacheBytes": 0, "pendingEnvelopes": 0, "pendingBatches": 0,
    "staleResidents": 0, "overBudgetBodies": 0,
    "vaultJournalRows": 123,
    "ywasmLinearMemoryBytes": 0 }
  ```

  Counters are per runtime; they reset when the DO is evicted. `vaultJournalRows` is a
  `COUNT(*)`; it runs only here and in tests (round 3, G15), never on the append or alarm path,
  and the feed floor (§6.3) keeps the table bounded. `documentMaterialisations` counts
  every `VaultDocumentStore.reconstructDocument` call, relay or base, for any reason. In relay mode
  `nonRoot` should move only for the paths listed in §6.1.

- `GET /vault/:id/debug/relay-table-counts`, gated by `YAOS_TEST_ONLY_DEBUG_ROUTES === "true"` AND
  the relay flag, with the operator session: `{tables: {name: rowCount}}` for every table.

## 6. Environment variables

| Var | Default | Meaning |
|---|---|---|
| `YAOS_RELAY_BODIES` | unset | `"true"` enables everything in this doc. |
| `YAOS_RELAY_MICROBATCH_MS` | `0` | Micro-batch window (ms); 0 means one tx per frame. Clamped to 0..250 (round 3; was 50). |
| `YAOS_RELAY_MAX_BODY_SOCKETS` | `5000` | Sanity cap on body sockets per vault DO. |
| `YAOS_RELAY_RATE_BYTES_PER_SEC` | `262144` | Token-bucket refill per socket. |
| `YAOS_RELAY_BURST_BYTES` | `1048576` | Token-bucket capacity per socket. |
| `YAOS_RELAY_MERGED_CACHE_BYTES` | `16777216` | Per-runtime LRU budget for merged body bytes. |
| `YAOS_RELAY_CHECKPOINT_ENTRIES` | `50` | Tail-entry threshold that arms the checkpoint alarm. |
| `YAOS_RELAY_CHECKPOINT_BYTES` | `1048576` | Tail-byte threshold that arms the checkpoint alarm. |
| `YAOS_RELAY_EXACT_MERGE_BYTES` | `262144` | Bodies up to this merged size use the exact per-append merge; larger ones use the incremental SV. |
| `YAOS_RELAY_CHECKPOINT_MAX_ROWS` | `200` | Max tail rows merged per checkpoint pass (partial checkpoints beyond). |
| `YAOS_RELAY_RESET_COOLDOWN_MS` | `86400000` | Minimum ms between two semantic resets of one body (lease → 429 `cooldown`). `0` disables. |
| `YAOS_RELAY_MAX_MERGE_INPUT_BYTES` | `9437184` | Max summed input of one server byte merge (§6.2). |
| `YAOS_RELAY_LAZY_HASH_MAX_BYTES` | `3145728` | Bodies above this never get the lazy-hash materialisation. |
| `YAOS_RELAY_LEAN_ROWS` | unset | `"true"` enables lean rows (§6.4). |
| `YAOS_RELAY_LEAN_CATALOG_DELAY_MS` | `2000` | Lean mode: the relay alarm runs this long after the first pending append; it coalesces catalog events and checkpoints. Range 0..600000. |

Local tests: `YAOS_TEST_FORCE_RELAY_BODIES=true` (or `YAOS_TEST_RELAY_BODIES=true`) makes runtimes
built without an env (unit suites) default to relay mode (`relayBodiesTestDefault()` in
`server/src/relayFlag.ts`). An explicit `YAOS_RELAY_BODIES` in the env always wins. The local
wrangler launchers (`tests/conformance/launch/wrangler.ts`, `tests/headless/wrangler.ts`) forward
`YAOS_RELAY_BODIES` from the process env as `--var`, and the Node host reads it from
`process.env`.

### 6.1 Remaining document materialisations in relay mode

These code paths still build a server Y.Doc for a relay body. Each is counted in
`documentMaterialisations`:

| Path | When | Why it stays |
|---|---|---|
| Lazy hash (`bodyHttpState`) | HTTP GET/catch-up of a body whose head catalog hash is NULL, merged bytes ≤ 3 MiB | This is the only way to get text from bytes without a doc. It is at most once per unknown head, then backfilled. Clients avoid it by sending D6 claims. |
| HTTP candidate path / create (`vaultLifecycleService.createDocument`, candidate commit) | Closed-file edits and file creates go through the base HTTP candidate path, which loads the body into the document cache | The markdown → CRDT diff (and validation) needs a document. Relay covers only open-editor socket edits. Moving closed-file edits to "client builds the update, server appends" is a client change. |
| Dirty-doc `writeLiveCheckpoint` | A body resident in the cache (from the candidate path) that is dirty gets a live checkpoint from the doc | This belongs to the base cache lifecycle. The relay alarm pass skips dirty residents; the base pass handles them. |

Relay appends never apply an update to a resident document (round 3, G5). `syncDocumentCache`
discards a clean resident. A dirty or validating resident is left alone, counted in
`residentStaleSkips`, remembered, and evicted by the next alarm pass once it is clean. That
resident can be behind the durable head until then; the next reader reloads from durable state.
| Semantic docs / base compaction | Server semantic compaction | Disabled for relay bodies (§7.9). It can still run for bodies created before the flag. |
| Root | All root reads and writes | Out of scope: the relay covers bodies only. |

Paths that do **not** materialise in relay mode: socket accept (step1 = the SV of merged bytes),
appends, step2 replies, checkpoints, GET with a known hash, HEAD, catch-up with known hashes,
bootstrap body reads (round 2), lease and reset (structural check only). The unit test
`HTTP reads: …` asserts this with the counter.

### 6.2 Memory (ywasm byte ops)

Byte ops are stateless: every op copies its inputs into ywasm linear memory, decodes them, and
encodes the result. The linear memory grows up to a 96 MiB cap (`ywasmByteOps`) and **never
shrinks**, inside a 128 MB isolate.

Measured with `scripts/relay2-core-reset-loop.ts` on Node, the same wasm build:

| Input | Op | ywasm peak |
|---|---|---|
| 10 MB single-lineage text (checkpoint + 211 tail parts) | merge (15 ms) + SV (6 ms) | 39–48 MiB |
| 8.77 MB bloated 5 MB note (`reset-fixtures/sized-5m.update`, 246k structs) | SV only | 54 MiB |
| same | `merge([state, 50 tail edits])` | 85 MiB |
| same | `diff(state, emptySV)` | 88 MiB |
| same | SV + merge + diffs, sequentially | 95.6 MiB |
| same | `merge([state, state])` | **trap (`unreachable`, OOM)** |

The rule of thumb is about 4.5x input bytes for sparse text and up to about 10x for struct-dense
updates.

**Critical: after an OOM trap the ywasm instance is poisoned.** Every later op, even a 100-byte
merge, fails with an allocation error until the isolate restarts. In the DO that would take down
every relay body of the vault until eviction. Re-instantiating the module after a trap is owned by
the ywasm agent. The server side now **refuses before calling into wasm**:

- `YAOS_RELAY_MAX_MERGE_INPUT_BYTES` (default 9 MiB) bounds the summed input of every server
  merge: `durableMergedBytes` throws `RelayMergeBudgetError`. The 9 MiB default sits above the
  8 MiB `MAX_CATCH_UP_BYTES` response cap, so any body a GET could return is still merged. A
  dense 9 MiB input (about 90 MiB) is at the edge; lower the budget if the ywasm agent measures
  denser fixtures.
- An over-budget body keeps `bytes: null` and an exact SV (the pointwise max of the per-part SVs;
  each part is one checkpoint or one ≤1.75 MB frame). Appends keep working.
  - **Step1** is answered with the stored parts, one `SYNC_STEP_2` per part, unmerged and undiffed
    (`unmergedStep2Replies++`). y-protocols clients apply them idempotently.
  - **GET/catch-up/bootstrap** return 413 `relay_merge_budget_exceeded`.
  - **The checkpoint** is bounded (round 3, G20). When the tail is over
    `YAOS_RELAY_CHECKPOINT_MAX_ROWS` or the checkpoint plus the tail is over the merge budget, it
    merges the longest tail prefix that fits (`tailPrefixBounded`) and writes a partial
    checkpoint. When not even one row fits, the body is marked over budget in
    `relay_body_budget(body_id, body_epoch, input_bytes, marked_at)` (`mergeBudgetRejects++`). The
    marker survives DO eviction, so the alarm stops re-arming for that body. It is valid only
    while the head epoch matches, and a semantic reset clears it.
- Exact per-append merges only run for bodies ≤ `YAOS_RELAY_EXACT_MERGE_BYTES` (256 KiB), which
  is far below the budget.

### 6.3 Feed floor (round 3, G1)

Before round 3 relay bodies were never pruned from `vault_journal`: the base maintenance loop
skipped them and nothing advanced the feed floor, so the table grew by one row per append forever.
Now the alarm calls `runCheckpointPass`, which:

1. evicts stale residents (§6.1);
2. checkpoints relay bodies over the thresholds, skipping dirty residents and over-budget bodies;
3. sets `floor = min(currentSequence - 1000, pinBoundary - 1 for every active pin)` and calls
   `advanceFeedFloor(floor)` when it is above the current floor. That prunes journal rows at or
   below the floor that a complete checkpoint covers.

Bootstrap and restore pins are respected (the floor stays below every pin boundary). The base
maintenance loop now runs only for non-relay bodies. Measured in the unit suite: 5,000 relay
appends leave 1,001 journal rows (floor 4002, 41 floor advances, 2.45 s total).

**5 MB bloated note: no server doc is needed.** Server compaction is disabled for relay bodies.
The reset takes the client's snapshot and runs only the structural SV parse. GET, step2 and the
checkpoint use byte ops. The lazy hash is skipped above 3 MiB. The bloated fixture's SV-only
parse, 54 MiB, is the largest single op on the reset path.

**Repeated-reset slowdown (live: 5.0 s → 20.9 s → 116 s `lease_expired`).** A local loop with a
5 MB note, 10 iterations, real SQLite and the real route
(`node tests/run-typescript.mjs --test-aliases scripts/relay2-core-reset-loop.ts --mb 5 --n 10`)
showed nothing growing on the server:

- Each reset takes about 140 ms with the binary body and about 155 ms with JSON, flat across
  iterations.
- The post-reset read takes about 132 ms.
- Table counts stay flat (journal 2, checkpoint chunks 3, manifests 1). Old epochs are pruned.
- ywasm stays at 20.2 MiB and the heap at about 45 MiB.

So server storage and CPU do not grow per reset. The likely live cause is isolate memory
pressure: ywasm memory near the cap from the pre-round-2 `snapshotCoversHead` full-state rebuild
and SV, plus the base64 JSON body (about 3x the snapshot in transient heap), plus the 16 MiB
merged LRU, on a 128 MB isolate. That slows GC until the isolate is reset. Client or network time
could also contribute. Round 2 removes the full-state rebuild on reset and adds the binary body.

Live re-measurement after round 2 (`scripts/relay2-core-live-reset.ts --mb 5 --n 6` against
`yaos-relay2-coresmoke-1`; the 5 MB note is grown by 1 MB relay appends; binary 5.24 MB snapshot
each time; results in `results/relay2/core2-live-reset-5mb.json`):

- Six consecutive resets all returned 200: 3.7, 3.3, 3.6, 1.7, 3.1 and 3.1 s. That time is
  dominated by the 5 MB upload from the test machine. There is no growth and no `lease_expired`.
- The GET after each reset took 1.2–1.7 s for 5.24 MB, with `hashState: known`.
- HEAD took 180–260 ms.
- With the 1 s test cooldown, an immediate re-lease got `429 cooldown` (`retry-after: 1`) once. In
  the other five iterations the reset round-trip had already outlasted the cooldown.

### 6.4 Lean rows (round 4, `YAOS_RELAY_LEAN_ROWS=true`)

Rows written per append by the default relay transaction are listed below. "Node" is
`node:sqlite` `rowsWritten`, which counts table rows only. "CF" is Cloudflare `rowsWritten`,
which also counts index entries.

| Write | Node | CF | Lean |
|---|---|---|---|
| `vault_clock` UPDATE (sequence) | 1 | 1 | removed |
| `vault_journal` INSERT (PK + `(document_id, sequence)` index) | 1 | 2 | kept |
| `vault_mutation_attribution` INSERT | 1 | 1–2 | frame 0 inline on the journal row; extra micro-batch frames keep a row |
| `vault_document_heads` UPDATE | 1 | 1 | kept |
| `vault_catalog_events` INSERT (PK + `(body_id, sequence DESC)` index) | 1 | 2–3 | coalesced by the alarm |
| `vault_candidate_receipts` INSERT (candidate frames only) | +1 | +2 | kept (G13) |

The deployed numbers come from `scripts/relay2-core-smoke.ts`, which measures 20 acked edits per
frame kind using the diagnostics `rowsWritten` delta:

- `yaos-relay2-coresmoke-1` (default): 9 CF rows per plain append, 11 per candidate frame.
- `yaos-relay2-corelean-1` (lean): 3 per plain append, 5 per candidate frame.

Minimum is 2 node rows or 3 CF rows per plain append (journal + index + head), and 3 node or 5 CF
rows for candidate frames. The default is 5 node / 9 CF rows (6 / 11 with a candidate).
Amortised over a pass (`scripts/relay2-core-alarmprobe.ts 750 30`, one pass per 50 appends):
lean 2.13 node rows per append vs 5.07 by default. The coalescing pass writes 3 rows per dirty body
(clock sync, clock advance, event).

How lean mode works:

- **Sequence.** An append reads `MAX(vault_clock, MAX(vault_journal.sequence)) + 1` and does not
  write the clock. Every other allocator (`clockAdvanceSql`) and `currentSequence()` use the same
  MAX, so sequences stay unique and monotonic. Every journal `DELETE` first raises the clock to the
  journal max (`syncLeanClock`), so pruning can never free a sequence for reuse.
- **Attribution.** Frame 0's actor, `operationId` and `requestDigest` are stored in nullable
  `attr_*` columns on the journal row (added by `ALTER TABLE` in `enableLeanRows`). Frames 1..n of a
  micro-batch keep their `vault_mutation_attribution` rows. `committedOperationOutcome` falls back
  to the inline columns (G14 still holds).
- **Accepted hash.** The hash goes to `relay_content_hash` / `relay_size` on the journal row. Lazy
  backfill updates it in place.
- **Catalog.** No per-append event. `getCatalogHeadAt` / `listCatalogAt` overlay the newest body
  journal row after the latest catalog event, at or before the boundary: its sequence, generation
  and inline hash. Readers of the current head (HTTP reads, rename, bootstrap manifests,
  `currentBodyHead`) are exact. The relay alarm is armed on every lean append, delayed by
  `YAOS_RELAY_LEAN_CATALOG_DELAY_MS`. At the start of `runCheckpointPass` it writes one event per
  dirty body (`coalesceLeanCatalog`), with the head generation and the head row's inline hash, or
  NULL when that row's hash is unknown. The feed floor does not advance if coalescing failed.
  `semanticReset` coalesces the body first, because the reset event copies the latest one.

What each removed write costs:

1. **Clock write.** Nothing observable. The cost is a MAX subquery on every allocation and on
   `currentSequence()` (a PK tail lookup), plus a clock sync before journal deletes. Turning the
   flag off again requires one coalescing pass first (not automated in the spike).
2. **Attribution row.** Frame 0's attribution now lives and dies with its journal row. It is
   pruned at the feed floor, not kept forever. A candidate resend older than about 1000 sequences
   (and older than its receipt) is re-appended. On the exact path that is a CRDT no-op; the
   receipt table (kept) covers the normal window.
3. **Catalog event.** The raw catalog log (`catalogDeltaAt` delta feed, recovery-authority raw
   queries, historical catalog at boundaries between coalesced events) lags by up to the
   coalescing delay. Intermediate generations and hashes never appear as events: one event per
   body per pass. Coalesced events carry no attribution (`mutation_index` 0, no operation). Body
   hash changes reach peers through the delta feed up to about 2 s later. Socket fan-out is
   unaffected.

Verdict (go/no-go input). A plain append drops from 9 to 3 CF rows. It cannot go lower without
dropping the head update (the head is the fence and the merged-cache key) or the journal index.
Candidate frames cost 5 CF rows. The catalog lag is the only semantic change a client can see.

### 6.5 mb=0 tail latency (round 4)

At mb=0 every frame is its own `transactionSync`, and fan-out waits for the output gate (the SQLite
flush). Latency therefore follows commit latency, not CPU. The p90 of 0.4–2 s (vs about 68 ms at
mb10) comes from head-of-line blocking behind the checkpoint alarm. The alarm arms when the tail
reaches `YAOS_RELAY_CHECKPOINT_ENTRIES` (50) rows. mb=0 makes 1 row per frame instead of 1 per
batch, so it arms about 3x more often. Each pass is a durable byte merge plus a checkpoint write
plus a floor advance: about 60 ms CPU, with 0.5–4 s wall time deployed. The alarm runs
single-threaded with the DO, so every frame that arrives meanwhile queues behind it, and output
gates add a flush per frame.

Round 4 cheap fix: a full checkpoint uses the in-memory merged bytes when they are at the head
(`checkpointsFromCache`). That skips the SQLite read and the wasm merge; local checkpoint time
fell from 3.3 to 1.8 ms per pass for a 30 KiB body. Lean mode also delays and coalesces the alarm.
The remaining lever is micro-batching (mb 5–10). It turns N frames into one transaction and one
flush, and is the recommended default.

## 7. Design decisions

1. **Log storage in `vault_journal`** (D5 a): one source of truth, so feed, catch-up, bootstrap and
   pins keep working unchanged.
2. **No head CAS; epoch fence only** (D5.1). Concurrent appends never fail with
   `document_head_changed`.
3. **Merged bytes, not a Y.Doc.** A per-runtime LRU holds bytes and the SV. It is rebuilt from
   SQL (checkpoint + tail, byte merge) when the head sequence moved. A lazy materialisation
   happens only for an unknown hash on HTTP reads, and is counted.
4. **Growth cap by byte-equality of merge** (small bodies). `mergeUpdates([M,u]) == M` holds exactly
   when `u` adds nothing (verified by probe for covered inserts, full states, delete-only updates
   and `[0,0]`). The cost is one merge, which the exact path already needs. Large bodies only
   catch exact resends (K3 cost).
5. **Currentness requires an SV match** (D6). A hash is recorded only if the client SV equals the
   merged SV after the append (invariant #7).
6. **Synchronous frame handling** (sha256 in JS, no awaits), so envelope pairing and appends never
   interleave across frames.
7. **The receipt is commit-before-send**, not runtime identity (§4.4).
8. **Dedupe uses `vault_candidate_receipts`.** `vault_operation_outcomes` is not written per
   append (write amplification). The outcome route still works through the attribution row's
   `operation_id` (round 3, G14). Receipt pruning runs in the checkpoint alarm, not per append.
9. **Server-side semantic compaction is disabled for relay bodies.** Lease-based client reset
   replaces it; `recordCommit` is skipped for relay appends.

## 8. Deviations (from brief / base behaviour)

- **Validation.** There is no server-side frontmatter or markdown-size validation on relay
  appends, because it would need a doc. The per-frame byte limit still applies.
- **Pending envelopes are memory-only** (§3.2, G13, not fixed on purpose). Hibernation between the
  envelope and its frame means an envelope-less commit with an unknown hash and no echo. The
  client resends; the resend is a no-op or a dedupe hit. Persisting envelopes would cost one row
  write per frame for a case that practically never happens.
- **Checkpoint at `YAOS_RELAY_CHECKPOINT_*`** uses the byte merge. Checkpoints of relay bodies
  never touch the document cache.
- **`vault_operation_outcomes` is not written** for relay appends (G14). Since round 3 candidate
  frames are still retrievable through `GET /operations/:candidateId/outcome`, via the attribution
  row's `operation_id`. Envelope-only frames without `candidateId` have no operation id.
- **The reset lease is at least as strict as needed**: `coveredSequence` must equal the head
  exactly, so a busy note can starve resets. See §5.2 for the hot-note mitigations.
- **Incremental SV on large bodies (K3).** For bodies over `YAOS_RELAY_EXACT_MERGE_BYTES` the head
  SV is the pointwise max of the old SV and the update's SV. If an update arrives with a causal
  gap (its structs cannot integrate yet), that max overstates what the merged state contains,
  so a D6 hash claim can be accepted when it should not be. Well-behaved y-protocols clients send
  causally complete updates, so this should not happen in practice. Every rebuild or checkpoint
  compares the incremental SV with the exact one and counts mismatches in
  `counters.stateVectorDrift`; it was 0 in all tests.
  - Round 3 (G8): a rebuild that could not merge (over the exact size or the budget) marks the SV
    `stateVectorExact: false`, and D6 accepts a hash only while the SV is exact. So for bodies
    over 256 KiB **a client hash claim is never accepted**: the hash stays unknown and is filled
    by the lazy hash (up to 3 MiB). Above 3 MiB it stays unknown until a semantic reset records the
    client's hash. This trades hash availability for never recording an overstated claim. The growth cap on large bodies only catches
  exact resends, so a covered-but-different re-send (e.g. a reconnect step2) of a large body is
  appended (it is idempotent, and costs one journal row).
- **Bootstrap body reads use a byte merge** (round 2; §5.3). The bootstrap catalog page can carry
  `contentHash: null` for relay appends whose hash was not accepted; clients must treat that as
  unknown.
- **Over-budget bodies** (§6.2) are not served by GET, catch-up or bootstrap (413). They are
  checkpointed only as far as a bounded prefix fits, and then marked (persisted) until a client
  reset shrinks them.
- **Queued frames of a closed socket still commit** (G2). Re-validation at flush checks
  authority, not socket liveness; the frame was received before the close, and the sender resends
  anyway.
- **Reset flushes pending batches first** (G3). A reset that races queued frames can therefore fail
  with `head_advanced` where, without batching, the frames would have been fenced instead.
- **Lease release on fence is conservative** (G19): every lease of every listed device and
  principal subject is deleted.
- **Dirty residents are left stale** (G5) instead of having relay updates applied in-process.
- **Unused helper:** `RelayBodyStore.tailPrefixSequence` is superseded by `tailPrefixBounded` and
  is kept only until the spike is folded.
- **Checkpoints are bounded** to `YAOS_RELAY_CHECKPOINT_MAX_ROWS` rows per pass (partial
  checkpoint + immediate alarm re-arm) instead of one merge of the whole tail.

(Updated as implementation lands; see also `results/relay2/STATUS.md`.)
