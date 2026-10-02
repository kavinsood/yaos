# RFC: Relay Markdown body updates

Status: **final** (relay v2 spike, branch `relay-v2-spike`, base `5dd32f3`), 2026-10-01. All measured values come
from the full run, tag **f1001** (raw output: `experiments/logs/relay2/runall-f1001/raw/<id>.json`; tables in
`experiments/results/relay2/RESULTS.md`, report in `REPORT.md`). Each cell names its scenario id and n.

What this RFC describes:
- The server implementation as committed through `7feae39` (round 4) on 2026-10-01. Earlier rounds: `20e0e34`/`e1abb36`
  (round 1), `54cee51` (round 2), `4cdc37e` (round 3). Harness: `35b2882`, `276c16c`, `66fb78c`. Nothing described
  here is uncommitted. The earlier "(WIP)" marks are gone. The full run used harness SHAs `d929410` (lane B, fresh
  `yaos-relay2-f1001-*` workers), `45f3705` (reused phases) and `35e8b06`; the server code is identical in all three.
- Full-run configurations (`scripts/relay2/runall.sh`):
  - **relay** (the v2 candidate) = `YAOS_RELAY_BODIES=true` + `YAOS_RELAY_LEAN_ROWS=true` + `YAOS_RELAY_MICROBATCH_MS=10`
  - **relay-strict** = relay on, lean off, mb 0. This is the per-frame transaction variant, run for L2, L4, C1, C2,
    C4, B7, X2 and the MB sweep.
  - **base** = flag off, same vars (inert)
  - All three set `YAOS_RELAY_RESET_COOLDOWN_MS=0`.
- Cited line numbers drift. Function names are the stable reference.
- The contract document is [`relay2-protocol.md`](relay2-protocol.md). Where the two differ, the code wins, and the
  difference is called out.

**Relay v3 addendum (2026-10-01, runs r3-1002/b/c).** v3 is group commit behind `YAOS_RELAY_GROUP_COMMIT=1`
(sections 4.4a, 6, 8.8, 9.1, 12 R11–R14, 13). It was measured on deployed reused `yaos-relay2-v1001-*` workers with
harness `d067cd6`/`8730d32`/`e3a1b85` and server code through `fd52578`. Raw data:
`experiments/logs/relay2/runall-r3-1002{,b,c}/raw/`. Tables: `experiments/results/relay3/RESULTS.md`; report:
`REPORT.md`. Latency phases in r3 ran concurrently (`--lane-a-parallel`) and are labelled **[conc]**.

Evidence labels:
- **measured**: taken on a deployed Worker or in a local run, with n and the scenario ID.
- **inferred**: derived from measurements through a stated model.
- **code**: read from `server/src`.
- **smoke**: small n (v0930 = `8e194a4` default rows; w0930 = `276c16c` primary configs). Directional only.

Full-run concurrency labels (RESULTS.md run index):
- **[serial]**: L1, L2 ×3, L3 ×2, L4-strict.
- **[conc]**: run concurrently, each on its own worker/DO (user-approved): L4-base/relay, L5 ×4, L6 ×2, L7 ×2.
- **[B∥10]**: lane B, non-latency phases, 10 in parallel (C1, C2, C4, C5, X1, X3, X4, K1, MB).
- **[serial-after]**: B7 ×3 and X2 ×3, after everything else.

## 1. Summary and recommendation

**Recommendation: GO-WITH-CONDITIONS.** Ship relay bodies behind `YAOS_RELAY_BODIES`, configured as lean rows +
mb 10. Basis: full run f1001, L1–L7, C1–C6, B1–B8, CW, X1–X4, K1 deployed at full n, plus K2/K3 local (section 8).

Conditions:
1. **Lean rows are mandatory.** Strict (lean off, mb 0) is 107–119% of the Free rows/day budget on a typical day
   (inferred, costmodel runs B/D, section 9). Relay lean + mb 10 is 53–73%.
2. **Fix or explain the relay p99 tails before default-on.** L4-relay p99 was 2,305 ms (measured, n = 4,990, [conc]),
   C2-quick-relay propagation p99 9,132 ms (measured, n = 5,000, max-rate, [B∥10]), and the checkpoint alarm reached
   p99 1.04 s CPU on a 50k-edit body (measured, C2-stress-relay). Cause open; the likely suspect is the alarm.
3. Socket-ack receipts in `VaultSync` (section 11, phase 2).
4. Decide reset starvation (G9/R2) before reset ships.
5. Add receiving-side validation (R7).

Basis (all measured, full n):
- **Propagation:** 4.67× faster at p50 (L2 308 → 66.0 ms, n = 290, [serial]) with a better p99 (608 → 314 ms).
  Reversal condition 1 is not triggered.
- **Receipts:** edit → cleared receipt 6.2× faster (L5b1 prod 480 → 77.0 ms p50, n = 90, [conc]).
- **Sockets:** no 32-socket cap (X1-relay 2,000/2,000, highest step tested; base 429 at #33).
- **Hibernation:** the relay socket survives idle and 2 restarts; base loses all 4 sockets with 1008 (B1).
- **Flood control:** our 1013 at 26.9 s with the bystander −1.3% (B7-relay).
- **CPU:** relay WS CPU p99 4.6 ms vs base 30.7 ms (C2-quick, n = 5,000). Base already exceeds the 10 ms bar.
- **Correctness:** relay convergence 9/9 (B5 20/20 races), strict 3/3, and the frame-accounting identity holds in
  16/16 relay/strict runs.

Design notes that still apply:
1. Semantic reset moves to clients under a lease. That is a prerequisite for large notes, because only clients can
   compact past the 96 MiB Wasm cap.
2. ywasm stays on the server, for the root document, Canvas semantic documents and the base fallback. It leaves the
   Markdown body hot path.
3. Reversal conditions are listed in section 13 with their full-n status. None of the latency, rows, correctness,
   CPU-per-message, memory or scale conditions is triggered. Condition 3 (DO requests) is exceeded on the letter by
   the model (typical day 1.15× base, both at 2–3% of Free) and needs explicit sign-off; condition 7's starvation
   clause was not measured.

### 1.1 Relay v3 addendum (group commit)

**Recommendation: adopt v3 as the relay write path (GO-WITH-CONDITIONS), with B5 off.** It replaces "lean rows +
mb 10" as the shipping config.

Basis (measured unless labelled):
- **Rows.** The real client (no `candidateId`) writes **0.29 rows/edit** at 5 keys/s (gql, MB-v3nc-type5, n = 551),
  against v2's 5.63 in the same run (**−95%**). That is 1.45 rows per typing-second. Spaced edits cost 2.0 rows
  each (C4 counter).
- **Free rows** (inferred, section 9.1): typical day **3%** (v2 51–53%, base 30–52%), heavy 8 h day 18%. 100k rows
  needs 19 h of non-stop typing. A 1 s plugin autosave for 8 h adds 62k rows (open note) or 80k (closed note).
- **Latency.** Propagation is unchanged or better: L2 p50 / p99 47.7 / 76.3 ms vs v2 63.0 / 396 (n = 290, [conc]).
  L4 p99 is 231 ms (f1001 v2 2,305). The receipt moves to 0.35 s p50 for a lone edit and 0.9 / 1.6 s p50 / p99
  while typing continuously (user-approved 0.3–1.5 s window plus RTT). L5 real `VaultSync` edit → cleared is 353 ms
  p50, with 0 HTTP POSTs (base prod 479).
- **Crash with a pending buffer:** 10/10 rounds, 0 frames lost, including recovery from the peer when the origin is
  offline.
- **Correctness:** convergence suite 9/9. Cumulative-ack fence: too-large 5/5, rate 6/6 rounds that drew a
  refusal. B1, B5 20/20, B6, B8, CW 121/121 and X4 pass.

Conditions (v3):
1. **Fix R11 before default-on.** B4-v3 fails convergence: a revoked device's pre-revocation frames reach peers
   and are dropped at flush. Commit admitted frames at flush, or flush in `closeDevice`.
2. **Re-run B7 serially on an idle machine (R12).** It passed 1 of 3. In one attempt Cloudflare shed the
   bystander with `1013 Service overloaded` before our rate limit closed the flooder.
3. **B5 send-coalescing was measured and removed (R13).** At idle = 300 ms it gave 1.53 rows/keystroke vs 0.29
   (v3nc) and added about 280 ms to propagation, so the client has no coalescing knob. Parameters stay at
   300 ms idle / 1.5 s max / 64 KB.
4. v2 conditions 3–5 still apply (receipts in `VaultSync`, which are now landed and measured in L5; reset
   starvation; receiving-side validation). v2 condition 1 (lean rows mandatory) is **retired** by v3. v3 requires
   lean rows by construction, and rows are no longer near the cap. v2 condition 2 (p99 tails) is **largely
   answered** for the hot path (L2 p99 76 ms, L4 p99 231 ms, [conc]). The checkpoint-alarm CPU part of R9 was not
   re-measured.

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

Baseline tables for this spike, flag off, same code and harness (measured, full run f1001, 2026-10-01, base `5dd32f3`
+ spike flag off; deploy version ids in section 14.2):

| ID | Metric | Base p50 / p90 / p99 (ms) | n | Date (UTC) | Worker |
|---|---|---|---|---|---|
| L1 | ping RTT | 50.0 / 53.9 / 247 [serial] | 90 | 2026-10-01 15:12 | `yaos-relay2-v1001-c1-relay` (reused, fresh vault) |
| L2 | propagation A→B, 4 KiB | 308 / 334 / 608 [serial] (small n was 412 p50, n = 30) | 290 | 2026-10-01 15:13 | `yaos-relay2-v1001-c1-strict` (reused) |
| L3 | propagation, 64k chars, before / after the quick trace | before 304 / 322 / 614; after 340 / 349 / 356; trace replay per frame 261 / 366 / 597 [serial] | 40 + 40 (+ 5,000) | 2026-10-01 15:22 | `yaos-relay2-v1001-c2-stress-base` (reused) |
| L4 | per-frame at 25 edits/s | 213 / 313 / 543 [conc] (small n was 293 / 458) | 4,990 | 2026-10-01 15:29 | `yaos-relay2-v1001-l1-relay` (reused) |
| L5 | edit → cleared receipt, 1-edit burst | prod 480 / 553; nodebounce 237 / 326 [conc]. 8-edit burst first / last: prod 1,356 / 475, nodebounce 1,165 / 280 | 90 per mode | 2026-10-01 15:29 | `yaos-relay2-v1001-c5-{bursts,catchups}-base` (reused) |
| C1 | propagation small / heavy; WS CPU per invocation | 303 / 385 ms p50; WS CPU p50 / p90 / p99 1.36 / 2.27 / **64.3 ms** (5,101 invocations, gql) [B∥10] | 40 each | 2026-10-01 13:48 | `yaos-relay2-f1001-c1-base` |

Reused workers: 40 phases ran on idle `yaos-relay2-v1001-*` workers with fresh vaults because of the account's
500-DO-namespace cap (test-environment note, section 12). Worker names on reused workers are historical; the
variant comes from the deployed vars, recorded per run.

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

### 4.4a Relay v3: group commit (`YAOS_RELAY_GROUP_COMMIT=1`)

Full design: [`relay3-group-commit.md`](relay3-group-commit.md) (code through `fd52578`). v3 needs
`YAOS_RELAY_BODIES=true` and `YAOS_RELAY_LEAN_ROWS=true`. With the flag off, the schema and every path are v2.

- **Share now, save in groups, confirm after saving.** Admission is unchanged: size, envelope, authority, dedupe and
  rate budget. Then the frame is **broadcast at once** and buffered per (body, epoch). The buffer commits in one
  `transactionSync` after 300 ms idle (`YAOS_RELAY_GC_IDLE_MS`), 1.5 s after the first frame (`_MAX_MS`), or at
  64 KB (`_MAX_BYTES`, synchronous). At flush the checks run again: G2 authority, epoch, B6 dedupe, in-buffer
  duplicates and the growth cap. Receipts (`BODY_COMMITTED`, v2 wire format) go out after the commit returns.
- **Rows.** One `relay_body_tail` row per body (WITHOUT ROWID, records since the last checkpoint), one
  `relay_device_receipts` row per device (a 256-entry JSON ring, 15 min TTL), and the head update. No journal row,
  no attribution rows, no per-commit `setAlarm` (the catalog alarm is armed at most once per 30 s).
  A tail checkpoint (≈ 12 rows) runs every 64 KB or 512 records.
- **Cumulative acks and fences** (invariant 3): a refused frame fences its socket, so an ack never passes a refused
  frame.
- **Wake re-sync** (invariant 1): a new runtime sends step1 with the durable SV to every surviving relay socket.
  Each client's step2 returns frames that a crashed runtime broadcast but never committed. A covered step2 writes
  nothing.
- **Client resend.** `VaultSync`'s `RelayReceiptChannel` (`relayReceipts`) resends a frame that has no receipt after
  5 s, and on reconnect. The real client sends no `candidateId` on relay-covered candidates. It confirms them with a
  synthesized receipt and falls back to HTTP at 15 s. So the realistic v3 client is the `relay-nocand` adapter (spec
  `v3nc`), which writes no receipt row.
- **B5 client send-coalescing** (250 ms, measured as `v3b5`, since removed from client and harness): the client merged
  updates for up to 250 ms before sending.

**Rows per edit and per commit** (measured, relay3 run, deployed `yaos-relay2-v1001-*` workers, harness counters =
`rowsWritten` diagnostics delta; gql values in section 8.8):

| Config | C4 rows/edit (1 edit per 1.5 s, n = 50; every edit is its own commit) | MB type5 rows/edit, counter / **gql** (5 keys/s, 110 s, n = 551) | Commits/s while typing | Rows per commit |
|---|---:|---:|---:|---:|
| base | n/a | n/a / 5.58 | n/a | n/a |
| relay v2 (lean, mb 10) | 5.0 | 5.00 / 5.63 | n/a (1 append per frame) | n/a |
| v3, harness client with `candidateId` | 3.0 | 0.38 / 0.42 | 0.64 | 3 (tail + head + receipt ring) |
| **v3, real client (no `candidateId`, `v3nc`)** | **2.0** | **0.25 / 0.29** | 0.64 | 2 (tail + head) |
| v3 + B5 250 ms | 3.0 | 1.50 / 1.53 | 2.5 | 3 |

While typing continuously, the 1.5 s max-wait sets the commit rate (0.64/s ≈ one per 1.5 s), so rows per
typing-second are ≈ 2 × 0.65 = 1.3 (counter) / 1.45 (gql), whatever the key rate. MB stream at 25 frames/s:
0.09 rows/edit. C2-stress 50k frames: 288 commits, 0.05 rows/frame.

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
  That is the source of the 0.4–2 s p90 at mb 0 against about 68 ms at mb 10 (MB smoke, v0930). Full n (measured,
  MB sweep, section 8.1): stream p90 / p99 lean mb 0 92.9 / 416 vs lean mb 10 80.6 / 316 ms.
- **Alarm CPU grows with body history** (measured, full run): relay alarm p99 59 ms (C1), 108 ms (C2-quick) and
  **1,041 ms** (C2-stress, 50k edits); strict up to 817 ms. Under the 30 s DO limit, but the output gate waits behind
  it. Open (R9).

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
- **v3 receipts** (group commit): a receipt arrives when the group commits, **0.3–1.5 s after the edit** (user-approved;
  300 ms idle, 1.5 s max). Measured (relay3): C4-v3 ack p50 / p99 351 / 625 ms at 1 edit per 1.5 s; MB type5 ack
  p50 / p99 907 / 1,642 ms at 5 keys/s (the 1.5 s max-wait bounds it, plus RTT); L2-v3 origin ack 350 / 481 ms
  (n = 290). Acks are cumulative per socket (invariant 3). The native `VaultSync` `RelayReceiptChannel`
  (`relayReceipts`, landed with v3, `1a34693`) resends after 5 s without a receipt; the harness client does the same
  (`--resend-ms`).

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
| 1 | **v2:** no edit is broadcast to peers before its append transaction commits (durable before broadcast). **v3 (`YAOS_RELAY_GROUP_COMMIT`): durable before receipt.** A frame is broadcast as soon as it passes admission; its `BODY_COMMITTED` receipt is sent only after the group commit that contains it returns. HTTP reads (GET/HEAD, bootstrap, feed) only ever see durable state. Precedent: base broadcast before its debounced flush until `e1ae3a4`. | v2: fan-out and `BODY_COMMITTED` only after `appendRelayBodyUpdate` returns. v3: `groupEnqueue` broadcasts, `flushGroup` commits in one `transactionSync` and then acks. A frame lost with the buffer (crash, eviction) was never acked, so the origin resends it (client resend after 5 s without a receipt, and on reconnect), and wake re-sync (`ensureWakeResync`) pulls it back from any peer that applied it. | `relayBodies.ts` `commitFrames` (v2), `groupEnqueue`/`flushGroup`/`ensureWakeResync` (v3) | v2: none found. v3 (measured, relay3 run r3-1002b): CRASH 10/10 rounds (5 origin-online, 5 origin-offline with recovery from the peer), 5–6 buffered frames dropped per round, 0 frames lost, fresh device C converges. Open: a revoked device's buffered frames reach peers but are dropped at flush (row 4, R11). |
| 2 | Every append has exactly one vault sequence, and the feed returns it after the cursor. | Default: `vault_clock` is bumped in the same transaction as the journal insert. Lean: the sequence is `MAX(clock, journal max) + 1` inside the transaction, and the clock is synced before any journal delete. The sequence is the journal PK. | `relayBodyStore.ts` `appendRelayBodyUpdate`; `syncLeanClock` | A reset uses one sequence too. Feed retention is 1,000 sequences (G1 fixed, round 3). In lean mode the catalog delta feed lags by ≤ 2 s. |
| 3 | A returned receipt means the bytes are durable. **v3 adds: acks are cumulative per socket.** An ack for frame N confirms every earlier frame of that socket. | The origin ack is sent after `transactionSync`. A dedupe re-ack reads a committed receipt row. A no-op ack means the bytes are already contained in durable state. v3: one body and epoch per socket, one buffer per (body, epoch), synchronous byte-cap flushes and one transaction per group keep commits in arrival order. A refused frame (rate, too large, authority, epoch, inactive body, commit failure, frame error) **fences** its socket: later frames are dropped unacked (`failedSocketDrops`), earlier buffered frames still commit. After a wake, an earlier-runtime socket's acks are held until its re-sync step2 is durable (`wakeHeldAcks`). | `commitFrames`, `ackOrigin`, `ackNoop`; v3 `markFailed`, `afterFailure`, `screenBatch` | The incremental-SV no-op for large bodies only matches identical bytes, which is safe. v3 fence (measured, r3-1002b/c): too-large 5/5 (1009; nothing after the refused frame acked or durable); rate 6/6 rounds that drew our 1013 (0 acked and 0 durable after the refused frame; `failedSocketDrops` 10–76). The ack prefix held in every v3 run (MB, C4, FENCE, CRASH). |
| 3a (round 4) | No frame is dropped silently. Every non-empty update frame ends appended, acked as a justified no-op or dedupe, or with the socket closed. | Outcome counters satisfy the frame-accounting identity (4.3). Pre-append throws close 1011. | `relayBodies.ts` `failFrames`; `vaultSocketService.ts` `relayMessage` | Covered by a random-interleaving test at mb 0 and mb > 0, and checked on full-n diagnostics deltas. |
| 4 | A revoked device's frames after the fence sequence are never appended. | Sockets are closed with 4403 on revoke. `validateActorCached` runs on every frame, on step1 (G6), and again at micro-batch flush (G2). `authorityVersion` is bumped synchronously by the writer. The 5 s TTL applies only to cross-isolate changes. | `closeDevice`; `validateActorCached`; `commitFrames` | G2, G6 and G19 fixed in round 3. Full n: B4-relay 4403 after 164 ms, 0 appends after (measured). v3 (measured, B4-v3): 4403 after 183 ms, 0 appends after the revocation started, so row 4 holds; but 10 frames sent *before* the revocation were broadcast, then dropped at flush (G2), so the live peer holds text the server does not, and the convergence check fails (fresh C and HTTP GET differ from the live clients). See R11. |
| 5 | Old-epoch frames are never appended after an epoch bump. | Ticket epoch at accept. Head epoch before commit, per (body, epoch) batch. `expectedEpoch` inside the transaction. Reset flushes pending batches and then `fenceSemanticEpoch` closes old sockets. | `commitFrames`; `appendRelayBodyUpdate`; `handleSemanticReset` | G3 fixed (round 3). |
| 6 | Flag off means baseline behaviour. | Every relay branch is gated on `this.relay !== null` / `relayBodiesEnabled`. | `server.ts`, `vaultSocketService.ts`, `bootstrap.ts` | Measured (`flag-tests.md`). Round 4 flag-off: 3,635 assertions pass, 0 new failures. Round 1: 199/199 steps. |
| 7 (D6) | A catalog content hash is recorded only if the claimant's SV equals the merged SV after the append, and that SV is exact. | `stateVectorsEqual(envelope.stateVector, nextStateVector) && stateVectorExact`. Otherwise NULL. | `commitFrames` | G8 fixed (round 3): bodies over 256 KiB never accept a claim. The hash is still unverified client data (G10). Smoke CW: 21/21 relay, 21/21 base (v0930). Full n (measured): CW-relay 119/119 (104 materialised, 15 known), CW-base 121/121. The X3-relay "VIOLATED" is a `checks.ts` artifact (empty-string header treated as a claim). |
| 8 (added) | Idempotent retries: one append per (device, candidateId), always with the same receipt. | Receipt lookup after the authority check (G7). In-batch duplicate detection (G11). `ON CONFLICT DO NOTHING` inside the transaction. | `handleSyncFrame`; `appendRelayBodyUpdate` | G7 and G11 fixed. In lean mode a candidate resend older than about 1,000 sequences and its receipt is re-appended, which is a CRDT no-op on the exact path. Full n (measured): B6-relay appendsDelta 1, dedupeHits 3, same receipt. |
| 9 (added) | The server never calls into Wasm with more than the merge budget of input. | `durableMergedBytes(…, maxMergeInputBytes)` throws `RelayMergeBudgetError` before merging. The lazy hash is capped at 3 MiB, and partial checkpoint prefixes are bounded (G20). A ywasm OOM trap poisons the instance, so the refusal happens before the call. | `durableMergedBytes`; `bodyHttpState`; `checkpointBody` | G5 fixed: `syncDocumentCache` no longer applies updates. |
| 10 (added) | A checkpoint never loses a journal row. Journal rows are deleted only in the same transaction that writes a checkpoint covering them, and never above the feed floor. | `persistCheckpoint` deletes `≤ min(through, journalFloor())` inside the checkpoint transaction. The floor advances only in `runCheckpointPass`, and stays below every pin. | `persistCheckpoint`; `runCheckpointPass` | G1 fixed. Measured locally: 5,000 appends leave 1,001 rows. Full n (measured): K1-compact-relay → 0 log rows; C2-stress relay/strict converge at 50k. Per-body journal row counts after the stress trace: not reported in the full-run tables. |
| 11 (added) | At most one semantic reset per epoch. | Lease upsert is one transaction. Reset requires the lease, an epoch CAS, the exact head sequence, and a head CAS inside `semanticResetFromEncodedState`. | `acquireLease`, `semanticReset` | Measured: B5 6/6 (e1abb36); full n B5-relay 20/20, exactly one install per race. |

## 7. Failure modes

| Case | What happens | Residual risk |
|---|---|---|
| **A client bug writes bad bytes** (malformed or structurally wrong Yjs, bad frontmatter root) | The server does not parse structure on the hot path, so it appends any update of 1.75 MB or less. Malformed bytes can make the next `mergeUpdates` or `diffUpdate` throw. That means step1, checkpoint or HTTP read failures for that body only. The error is caught per body, the alarm re-arms, and the body stays checkpoint plus tail. Semantically wrong but valid updates, such as a bad frontmatter shape, propagate to peers. Receiving-client validation (owned elsewhere) must refuse to write them to disk and surface a conflict. Recovery: a client semantic reset from good text (lease) replaces the lineage, and the history is kept per retention and pins. | Until receiving-side validation ships, relay mode loses today's server-side frontmatter/root-shape gate. The failure is per body and does not spread to the vault. There is no poison-pill quarantine yet (open question Q3). |
| **The lease holder dies** | The lease expires after its TTL (120 s default). No state changed, because reset is a single transaction at install. Another device can acquire the lease after expiry. The holder can release early. | Fixed in round 3 (G19): revocation and fencing delete the holder's lease rows, and the actor is re-validated inside lease and reset. |
| **Two resets race** | The lease upsert serialises them: the second device gets 409 `held`. If a lease expires mid-upload (B5: 5 MB upload at 115.7 s), `lease_expired` rejects the install. At install, the epoch CAS plus `coveredSequence == latest_sequence` plus the head CAS let exactly one win. The losers' sockets get 4409 and they rebase. | Measured B5: 6/6 (component), and 20/20 at full n (B5-relay), alternating winners, one install per race. Starvation risk: R2 (not measured). |
| **DO crash mid-append** | `transactionSync` is atomic: either all rows (clock, journal, attribution, head, catalog, receipt) or none. No ack or broadcast happens before commit. On crash the socket drops, the client reconnects and resends (step2), and the growth cap or receipt deduplicates. | An in-memory micro-batch (≤ 250 ms, recommended 10 ms) is lost, but it was never acked. The client resends unacked frames. **v3:** the group buffer (≤ 1.5 s) is lost, but peers may already have applied it (durable before receipt). The origin resends after 5 s or on reconnect, and wake re-sync pulls the frames back from any peer. Measured: CRASH-v3 10/10 rounds, 0 frames lost, recovery p50 ≈ 0.8 s; origin offline, recovery from the peer, 5/5. Residual: a frame that reached no peer and whose origin never returns is lost, as in v2 (it was never acked). |
| **DO crash mid-checkpoint** | `persistCheckpoint` is one transaction: chunks, manifest, journal deletes and prune together. After a crash either the old checkpoint plus the full tail remains, or the new checkpoint with the tail pruned. The alarm re-runs. A partial checkpoint (≤ 200 rows) is itself a complete, consistent checkpoint through its sequence. | none found |
| **Log growth while all devices are offline** | Without appends no alarm is armed, so nothing grows. With one writer and no readers, each append arms the checkpoint at 50 rows or 1 MiB, so the merged snapshot stays bounded by live size plus tombstones. Journal rows below the checkpoint are deleted only up to the feed floor. | G1 fixed in round 3: `runCheckpointPass` advances the floor to `current − 1000`, below every pin. Over-budget bodies (> 9 MiB merged input) are never checkpointed until a client reset. Their marker is persisted (G20). Full-n check: K1 and `C2-stress-relay` table counts. |
| **Mobile-only vault** | The routine checkpoint is server-side, so no client is needed. Reset is feasible on phones: K2 inferred 48–586 ms build, duty-cycle bound 1.7 s p50 for 5 MB. Upload speed is the constraint. Before round 2, B5's JSON 5 MB upload took 5–116 s. After round 2, a binary 5.24 MB reset takes 1.7–3.3 s from a desktop (core3, n = 4), with no growth across iterations. The lease TTL (≤ 600 s) and the octet-stream upload (which avoids the 33% base64 overhead) matter here. | The exact-head CAS combined with a slow mobile upload on a hot note is R2. |
| **Hibernation** | Relay attachments keep the admission `runtimeEpoch` and are exempt from the mismatch close. The merged cache rebuilds from SQL on the first frame. Measured full-n B1: the relay socket survives 150 s idle plus 2 restarts (afterIdle 118 ms, afterRestart2 71.9 ms); base loses all 4 sockets with 1008 "socket authority mismatch". | Lost on wake: pending envelopes (G13, memory-only by design and documented as a deviation; the next echo is unenveloped), rate buckets (they refill), and the micro-batch queue (unacked, so it is resent). |
| **Revoked device with an offline queue** | On reconnect the ticket issue fails, because the control plane rejects the revoked credential. If a socket survived, the first frame fails `validateActorCached` with 4403. Queued edits never append. Attribution rows record device and credential revision for anything appended before the revocation. | The revoked user's local edits stay local by design. G7 fixed in round 3: authority now runs before dedupe, so there is no receipt re-ack for a revoked device. |
| **Transport loss mid-stream / DO stall** (round 4 smoke data-loss finding) | Root cause in smoke mb0, worker v0930: the transport/platform plus harness behaviour. Server merge logic was not involved.<br>• l2: the DO stalled (alarm `internalError` after 27 s wall, 2 hibernation `internalError`s). Both sockets died about 49 s into a 60 s drain. All 61 edits were durable, but the raw harness client never reconnected, so B missed #37–60.<br>• burst: the sender's socket ended `clientDisconnected` about 38 s in. The raw client silently skipped sends while the socket was not OPEN, so 27 tail frames never reached the server.<br>Repros were clean, and the keystroke fuzz (n = 61 / 241 / 2,000) was clean. A real client must reconnect, re-sync with step1, and resend unacked frames. The harness now does all three (35b2882). | Server side: one latent silent drop was found and fixed (4.3, `frameErrors`). Client side: `VaultSync` integration must keep resending until it receives a receipt (phase 2). |
| **Platform overload** (`1013 Service overloaded`) | Cloudflare sheds the connection when the DO queue or CPU saturates. Seen once in K1 at mb 0 under a flood. The server never sees it, so no counter moves. | Mitigated by micro-batching (fewer transactions and output-gate flushes). Clients treat it as a reconnect and resend. Full n: recurred at X2-strict 400/s on 1 body (1 reconnect, 1,520 frames resent); B7 closes were our own `relay rate limit`. |
| **Malicious member** (valid credential, hostile client) | Rate limit (1013) and frame cap bound flooding. A malicious member can: append arbitrary valid Yjs, which propagates, just as with base once server validation is gone; claim false content hashes that equal the merged SV (the server cannot verify, G10), poisoning catalog hashes and currentness until the next honest claim; take the lease and install a reset with arbitrary text (the history is kept per retention; the reset is attributable); and hold leases to block resets. | Same trust model as today for members: members can write content. Hash poisoning (G10) is new: today the server computes hashes. Mitigation options: receiving clients verify hashes and report mismatches; the server re-hashes on the lazy path whenever a hash is disputed. |

## 8. Measurements

Dates, Workers, deploy version IDs and spike SHAs come from each run's JSON metadata (full run f1001, 2026-10-01;
lane B 13:37–13:58 UTC, reused phases from 15:07 UTC). Full-n raw output is
`experiments/logs/relay2/runall-f1001/raw/<scenario-id>.json`; the index is in section 14. "Base" means the same branch
and the same vars with the flag off. "relay" means lean + mb 10, and "strict" means lean off + mb 0. Every full-n cell
is **measured** unless labelled otherwise; latency n excludes 10 discarded warm-up samples. Concurrency labels are
defined at the top of this document.

Small-n values marked "smoke" come from v0930 (`8e194a4`, default rows) or w0930 (`276c16c`, primary configs). They
are directional only.

### 8.1 Latency

| ID | Metric | Base p50 / p90 / p99 | Relay p50 / p90 / p99 | Strict p50 / p90 / p99 | n | Notes |
|---|---|---|---|---|---|---|
| L1 | ping RTT | 50.0 / 53.9 / 247 | 50.2 / 60.2 / 115 | — | 90 | [serial]. Floor; v1 45.4 / 50.1 ms (A5) |
| L2 | propagation (+ origin ack) | 308 / 334 / 608 (ack p50 309) | **66.0 / 100 / 314** (ack p50 65.8) | 56.2 / 115 / 333 (ack p50 56.2) | 290 | [serial]. **4.67× p50**, p99 0.52× base: target met. Strict 5.48× p50. Seq delta base 300, relay 373 (lean catalog coalescing), strict 300. v1: 300 / 572 → 51.8 / 279 (n = 200) |
| L3 | propagation on 64k chars, before / trace replay per frame / after | 304 / 322 / 614; 261 / 366 / 597; 340 / 349 / 356 | 66.9 / 158 / 400; 71.5 / 153 / 504; 71.2 / 102 / 618 | — | 40 / 5,000 / 40 | [serial]. Relay p99 after (618) ≈ base before (614); p50 4.8× better after. v1: 302 → 318.7 vs 52 → 52.5 ms (A5) |
| L4 | per-frame at 25 edits/s (quick trace) | 213 / 313 / 543 (max 785) | 73.7 / 532 / **2,305** (max 3,435) | 60.0 / 273 / 866 (max 2,183) | 4,990 | Base/relay **[conc]** with L5–L7; strict [serial]. Relay tails (0.3–3.4 s) recur throughout the run, including after L6/L7 ended; p50 per 250-frame window ≈ 70 ms. Same config in lane B (MB-lean-mb10-stream, n = 2,750, [B∥10]): 63.3 / 80.6 / 316. **Relay p99 tail is open** (section 12, R9). v1: 226 / 688 → 51.4 / 757 |
| L5 | edit → cleared receipt (HTTP candidate vs socket ack), 1-edit burst p50 / p90 | prod 480 / 553; nodebounce 237 / 326 | relay **77.0 / 357**; relay250 322 / 546 | — | 90 per mode | [conc]. 6.2× vs prod. DO units/burst: base prod 1.05 (1 HTTP req), relay 0.10 (0 HTTP). relay250 shows the debounce explains most of the base gap |
| L5 | 8-edit burst, first / last edit p50 (p90) | prod 1,356 / 475 (1,393 / 508); nodebounce 1,165 / 280 (1,309 / 416) | relay 959 / 67.7 (1,006 / 116); relay250 1,217 / 333 (1,305 / 425) | — | 90 per mode | [conc]. DO units/burst: base prod 1.40, nodebounce 5.40 (5 HTTP); relay 0.80, relay250 0.45 (0 HTTP) |
| L6 | open → synced, cold / warm | cold 365 / 396 / 496; warm 363 / 402 / 710 | cold 362 / 393 / 451; warm 369 / 397 / 776 | — | 100 cold / 90 warm | [conc]. ≈ equal |
| L7 | HEAD after ack; edit → HEAD shows edit | 218 / 242 / 275; **758 / 834 / 1,343** | 211 / 228 / 539; **505 / 580 / 815**; hash correct in all | — | 90 | [conc]. GET after ack: base 217 / 239 / 266, relay 214 / 233 / 307. 1.5× faster edit → visible |

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

Full n (measured, f1001, [B∥10]; trimmed with user approval to base, strict and lean × mb {0, 10, 50}; mb100, mb250
and nocand were **not run at full n**, smoke values above only). n = 881 frames per burst run and 2,750 per stream run.
Rows/edit is gql, idle-subtracted; CPU is periodic µs per edit (idle-subtracted phase µs in brackets). Every relay run
passed the frame-accounting identity.

| Config | Burst p50 / p90 / p99 | Stream p50 / p90 / p99 | Rows/edit burst / stream | CPU µs/edit burst / stream | Source |
|---|---|---|---|---|---|
| base | 203 / 323 / 546 | 246 / 467 / 1,046 | 5.10 / 3.10 | 2,528 (2,335) / 6,550 (6,599) | `MB-base-{burst,stream}` |
| strict (full rows, mb 0) | 56.5 / 78 / 701 | 60.1 / 132 / 506 | 11.23 / 11.84 | 2,053 (2,306) / 3,866 (4,076) | `MB-strict-*` |
| lean mb 0 | 66 / 116 / 539 | 54.1 / 92.9 / 416 | 5.55 / 5.95 | 1,728 (1,212) / 2,314 (2,054) | `MB-lean-mb0-*` |
| **lean mb 10 (relay config)** | 63.4 / 132 / 517 | **63.3 / 80.6 / 316** | 5.54 / 5.92 | 1,979 (1,421) / 2,664 (2,422) | `MB-lean-mb10-*` |
| lean mb 50 | 106 / 310 / 1,711 | 114 / 145 / 463 | 5.54 / 4.88 | 2,495 (2,260) / 1,528 (1,367) | `MB-lean-mb50-*` |

Reading: mb 10 does not reduce rows at typing rates (5.54 vs 5.55). Its value is p99 (316 vs 416 stream) and
output-gate smoothing. mb 50 doubles p50 and saves only ≈ 1 row/edit when streaming.

### 8.2 Server cost

| ID | Metric | Base | Relay | Strict | n / source |
|---|---|---|---|---|---|
| C1 | propagation small / heavy p50; WS CPU per invocation p50 / p90 / p99 (gql); checkpoint alarm CPU p50 / p90 / p99 | 303 / 385 ms; 1.36 / 2.27 / **64.3 ms** (5,101 inv.; HTTP CPU p99 244 ms); n/a | 73.9 / 90.8 ms; 0.22 / 2.92 / 4.19 ms (10,188 inv.); alarm 3.4 / 6.8 / 59.3 ms (n = 105) | 70.1 / 60.2 ms; 0.46 / 3.74 / 5.70 ms; alarm 52 / 81 / 98 ms (n = 96) | n = 40 each, [B∥10]. Phase CPU base 18.9 s, relay 12.3 s, strict 23.0 s. Heavy prop 4.2× faster, WS p99 15× lower. Tail files matched 0/40 (R6), not used. v1: heavy 19 ms vs ≈ 0 ms (A5) |
| C2 | quick trace (5,000 frames): WS CPU p50 / p90 / p99; µs/edit; rows/edit; propagation p50 / p99; alarm CPU | 2,077 / 16,830 / **30,697 µs** (p90 and p99 > 10 ms); 4,786 µs/edit; 3.10 rows/edit; 243 / 704 ms | 381 / — / 4,639 µs; 3,325 µs/edit; 6.20 rows/edit; 64.0 / **9,132 ms**; alarm 5.22 / 54.8 / 108 ms | 1,506 / — / 5,722 µs; 4,271 µs/edit; 12.19 rows/edit; 68.7 / 790 ms; alarm 22 / 79 / 102 ms | n = 5,000, [B∥10], max-rate lane B. Accounting PASS relay/strict. Relay propagation p99 9.1 s is open (R9). Smoke w0930 (300 frames) WS p99 was 11.2 / 3.2 / 2.2 ms |
| C2 | stress trace (50k edits, 5 clients, max-rate replay, latency not used): WS CPU p50 / p99; µs/edit; rows/edit; alarm CPU | 1,429 / 7,342 µs; 2,181 µs/edit; 2.02 rows/edit — **provisional**: 10,226 frames only (gql window incomplete; base semantic reset at frame 10,226), not comparable | 242 / 2,829 µs; 3,375 µs/edit; 5.84 rows/edit; **alarm p90 760 / p99 1,041 ms** | 439 / 1,855 µs; 7,271 µs/edit; 13.03 rows/edit; alarm p50 445 / p99 817 ms | n = 50,000 relay/strict, [B∥10]. Accounting PASS relay/strict. Alarm CPU grows with body history (R9) |
| C3 | Wasm linear memory / resident docs at 1, 8, 32, 100 bodies; 32 × 512 KiB | 32 resident; 1.51 MB at 32 small; **37.22 MB at 32 × 512 KiB**; the 100-small step is capped at 32 sockets (6 open failures); opens p50 / p90 570 / 712 ms | 0 resident; 1.18 MB at 100 small; **4.06 MB at 32 × 512 KiB**; 0 failures; opens 553 / 720 ms | — | steps 1/8/32/100, reused worker. 9.2× less. v1: base 37.5 MB vs relay 1.11 MB (A5) |
| C4 | rows written per edit / per reconnect; sequences per edit (50 edits, 20 reconnects) | 3.10 rows/edit (MB/C2 gql); 0 / reconnect; 1 seq/edit; ack 321 / 414 ms | **5.00** (relay counter; 5.54–5.92 gql in MB); 0 / reconnect; 1.5 seq/edit (lean catalog events); ack 69.6 / 103 ms | **11.00** (relay counter; 11.23–11.84 gql in MB); 0 / reconnect; 1 seq/edit; ack 55.0 / 68.6 ms | n = 50 + 20, [B∥10]. Whole-phase gql rows are dominated by the seed, so the relay counter is the per-edit source. **Component, measured:** 9 / 11 CF rows per plain / candidate append in default mode (coresmoke-1, n = 20 each), 3 / 5 in lean (corelean-1, n = 20 each). Smoke w0930 C2-quick rows per edit: base 3.03, relay 7.26, strict 13.16. Smoke C4 sequences per edit: 1 / 1.5 / 1, and per reconnect 0 / 0 / 0. |
| C5 | DO units per edit burst / per catch-up (20:1); rows per burst / catch-up | 0.51 / 1.92 units; 43.05 / 47.95 rows (phase-level idle-subtracted 0.72 / 2.28 units, 44.08 / 50 rows) | 1.88 / 3.43 units; 45.93 / 56.45 rows (phase-level 2.13 / 3.79, 46.95 / 58.50) | — | n = 40 bursts / 20 catch-ups, [B∥10]. Propagation 299 vs 65.2 ms; catch-up open 380 vs 367 ms. In absolute terms both are small (section 9: DO requests 2–3% of Free). Smoke v0930 (default rows): base 1.45 / 2.0, relay 1.63 / 3.23 DO units; rows 44 / 48 vs 88 / 151 |
| C6 | bundle raw / gzip KiB; startup ms | 2,537.10 / 610.56 KiB at base SHA (dry run, K3) | 2,652.13 / 636.21 KiB at `276c16c` (w0930 deploy; the same bundle serves every flag) | same bundle | **measured, one deploy each.** Full run (C6-relay, deployed `45f3705`): 2,652.13 / 636.21 KiB, startup relay worker 15 ms, base worker 12 ms. Startup: base 10 ms, relay 8 ms, strict 13 ms (w0930); v0930: 11 / 15 ms. The spike adds +115 KiB raw / +25.7 KiB gzip, of which patch 0003 is +3,358 B raw / +379 B gzip. Free limit: 3 MiB compressed. v1 relay: 2,757.68 / 651.81 KiB. |

### 8.3 Behaviour

| ID | Pass criteria | Base | Relay | Strict |
|---|---|---|---|---|
| B1 | socket survives hibernation and restart | **lost**: after 150 s idle the runtime epoch changed and all 4 sockets closed 1008 "socket authority mismatch"; warm 298 ms (n = 1 run) | **survived** idle + 2 restarts: warm 130, afterIdle 118, second 3,633, afterRestart 1,591, afterRestart2 71.9 ms (n = 1 run) | — |
| B2 | catch-up after 50 / 5,000 edits: time, bytes, rows scanned, text equal | pass, text equal; 50-edit p50 / p90 363 / 373 ms; 5,000-edit 394 ms, 108,892 B (n = 50 × 10 + 1) | pass, text equal; 366 / 388 ms; 5,000-edit 429 ms, 100,287 B (n = 50 × 10 + 1). Rows scanned: not measured (not recorded by the harness) | — |
| B3 | bootstrap of 100 notes (20 relay-edited) | pass, all match; p50 / p90 1,713 / 2,394 ms (n = 3) | pass, all match; 1,936 / 2,243 ms (n = 3) | — |
| B4 | revocation mid-stream: 4403 ≤ 1 s, no append after the fence | pass: 4403 after 182 ms, 0 appends after (n = 1) | pass: 4403 after 164 ms, 0 appends after (n = 1) | — |
| B5 | reset race: one install, zero lost edits | n/a | **measured: 6/6 pass**, winners A, B, A, B, A, B; race p50 1,813 ms, p90 2,097 ms (`B5-2026-09-29T20-16-32-720Z.json`, yaos-relay2-reset, e1abb36). Full-n (`B5-relay`, n = 20 races): **20/20 pass**; race p50 / p90 / p99 1,384 / 1,693 / 1,964 ms; winners alternate A/B; the loser gets lease-denied `held`, then 4409, and rebases onto epoch 2; all 14 checks ok (one install, zero lost edits, GET hash matches). Uploads (n = 5 each, all installed): 100k 315 ms, 1m 958 ms, 5m 4,081 ms (request 6,765,332 B) | — |
| B6 | 3× resend → one append, same receipt | **skipped by design**: base idempotence lives in the HTTP candidate path, and the relay candidate adapter does not apply | pass: appendsDelta 1, dedupeHits 3, same receipt; a reused candidate id with different bytes is rejected | — |
| B7 | 5 MiB/s flooder → 1013; victim L2 within 20% | pass: no rate limit, flood achieved 5.01 MiB/s with no close; bystander p50 306 → 321 ms (+5.0%), absorbed by the 250 ms debounce | **pass**: our 1013 "relay rate limit" at 26.9 s; achieved 0.10 MiB/s; bystander 63.2 → 62.4 ms (−1.3%) | pass: 1013 "relay rate limit" at 26.3 s; 0.26 MiB/s; bystander 57.5 → 57.4 ms (−0.3%) |
| B8 | delete with sockets open | pass: delete 666 ms; sockets 1008 "body deleted" +214 ms; reopen refused 409; GET 404 | pass: delete 673 ms; same close / 409 / 404 behaviour | — |
| CW | invariant #7 under concurrent writers | pass: 121/121 hash claims hold (2,372 edits; smoke 21/21) | pass: **119/119** hold, 104 materialised, 15 known (2,375 edits; smoke 21/21) | — |

### 8.4 Limits

| ID | Metric | Base | Relay | Strict |
|---|---|---|---|---|
| X1 | max concurrent body sockets (100 → 2,000) | **32**: 429 `body_socket_limit` at #33 (75 attempted, 43 failed); probe 307 / 315 ms | **2,000/2,000**, 0 failures (highest step tested; no limit found). Probe p50 / p90: 69.8 / 253 at 100, 89 / 108 at 250, 77 / 86.5 at 500, 101 / 201 at 1,000, 106 / 232 at 2,000 ms; linear memory 2.36 MB; open-all 94.7 s at 2,000 | — |
| X2 | max sustained append rate, 1 body / 10 bodies (10 s steps; limit = propagation p50 > 2× floor) [serial-after] | criterion n/a: the 250 ms debounce keeps p50 above 2× floor (195–312 ms vs floor 50.8), so the harness reports "max 0" (artifact). Sustained 100/s on 1 and 10 bodies, 0 lost, 0 closes (p50 230 / 225 ms) | **≥ 400/s** on 1 and 10 bodies (p50 86.6 / 87.7 ms, floor 47.5). At 800/s (highest step tested): p50 122 / 113 ms, 0 loss, 0 closes | **200/s**. At 400/s on 1 body: platform 1013 "Service overloaded", p50 3,142 ms, 1 reconnect, 1,520 frames resent; 10 bodies p50 304 ms (floor 61) |
| X3 | largest note for step2 and checkpoint (1 / 5 / 10 MB) | 1 MB ok (open ≈ 755 ms, compact 946 ms, 200); **5 MB compact HTTP 500** (164 ms). 10 MB: not measured (seed only) | 1 / 5 MB ok: open 688 / 1,124 ms; edit ack 82 / 72 ms; compact 786 / 846 ms (200). 10 MB: not measured (seed only). The convergence "fail" is a **checker artifact** (section 8.7) | — |
| X4 | catch-up of 100 bodies × 50 edits stale | ok: HTTP catch-up 437 ms, 608,662 B; socket reopen 9,313 ms, 226,992 B (A3: 676 ms) | ok: HTTP catch-up 385 ms, 536,753 B; socket reopen 9,446 ms, 157,678 B | — |

### 8.5 Compaction

| ID | Metric | Value |
|---|---|---|
| K1 | alarm merge at tails of 50 / 500 / 5,000: ms, memory, rows before and after | **Compact (measured, n = 3 per tail, [B∥10]):** base 362 / 556 / 555 ms; relay 220 / 213 / 226 ms, log rows go to 0 afterwards. **Alarm (`K1-alarm-relay`): inconclusive** — the alarm had already checkpointed during the appends (lastCheckpointMs 0 at < 1 ms resolution; log rows 14–21 before = after; 0 checkpoint rows written). Real alarm cost is taken from C1/C2 alarm CPU instead: p99 59 ms (C1), 108 ms (C2-quick), 1,041 ms (C2-stress, 50k history). Memory per alarm: not measured. Smoke (vault-wide compact, small n): relay 193–368 ms for tails of 50–2,000, base 515–559 ms. Local: `checkpointsFromCache` 3.3 → 1.8 ms per pass for a 30 KiB body. |
| K2 | reset build, desktop lease path p50 / p90 (measured, n = 10, M4 Pro, Node v26.5, fd38e71) | 100k: 12.1 / 12.8 ms. 1m: 25.9 / 26.3 ms. 5m: 97.7 / 104 ms. stress: 13.6 / 14.2 ms. Duty-cycle worker (measured): 1m at duty 25 is 166 / 205 ms and at duty 17 is 469 / 605 ms; 5m at duty 25 is 610 / 1,052 ms and at duty 17 is 1,742 / 2,667 ms. Mobile ×4–6 (**inferred**): 1m 103–155 ms, 5m 391–586 ms. Upload ≈ live size + 120 B. 5m peak heap 176 MiB. A 5m server-side reset traps (`prepareSemanticReset`, 96 MiB cap). |
| K2-upload | deployed reset upload | Pre-round-2 JSON (B5, measured): 100k p50 395 ms (n = 5, lease p50 284 ms, 134,071 B); 1m p50 1.08 s; 5m 5.0 → 20.9 s, then `lease_expired` at 115.7 s. Round-2+ binary (core3-live-reset-5mb, coresmoke-1, 5.24 MB, n = 4, all 200): 1,740 / 3,114 / 1,839 / 3,272 ms; the GET after reset takes 1.5–3.0 s with `hashState: known`; HEAD 192–269 ms; cooldown lease 429 with `retry-after: 1`. Round-2 core2 (n = 6): 3.7, 3.3, 3.6, 1.7, 3.1, 3.1 s. |
| K3 | stateless byte ops (c) vs transient doc (a) vs JS yjs (b) | **Measured, Node, not workerd** (K3.md). Merge: (c) is ≈ 2.5× faster than yjs and super-linear (50k frames: 4.4 s vs 12.8 s). SV/diff (c): 0.26 ms quick, 1.2 ms 1 MB, 6.7 ms 5 MB, 14 ms 10 MB. Wasm high-water ≈ 4–5× merged size for merge (10 MB → 48 MiB); ≈ 20 MB merged reaches the cap. Memory never shrinks, and does not grow on repeat. Lone-surrogate loss occurs only on the ywasm Doc path. Bundle: 2,537.10 → 2,541.45 KiB raw, 610.56 → 611.11 KiB gzip; Wasm is ≈ 340 KB of the gzip. |

### 8.6 v1 projections: did they hold?

| Projection (v1, A5) | v1 evidence | v2 measured | Held? |
|---|---|---|---|
| 10–50× less memory | 32 × 512 KiB: 37.5 MB base vs 1.11 MB relay | C3: 37.22 MB vs 4.06 MB = **9.2×** (32 resident vs 0) | **Nearly**: just under the 10× floor (v1 measured ≈ 34×). The cause of the higher v2 figure was not isolated |
| 30–100× more concurrent notes | 100/100 vs 429 at #33 | X1: 2,000/2,000 vs 32 = **≥ 62×** (no ceiling found) | **Yes** (lower bound) |
| 3–5× faster propagation | 300 → 52 ms | L2: 308 / 66.0 ms = **4.67×** p50 (strict 5.48×), p99 608 → 314 | **Yes** at p50 and p99 on L2. L4-relay p99 is worse than base (2,305 vs 543, open) |
| 30–100× less CPU on heavy notes | 19 ms → < 1 ms | C1 WS CPU per invocation p99 64.3 → 4.19 ms = **15×**; p50 1.36 → 0.22 ms = 6.3×. Per-keystroke heavy-only CPU: not measured separately (gql is whole-phase, R6) | **Partly**: 6–15×, not 30–100×. CPU moves into the checkpoint alarm (p99 up to 1.04 s) |
| Near-zero idle cost | hibernation survives | B1-relay survives 150 s idle + 2 restarts (base: 1008 on all sockets). Idle DO requests/day: inferred 1,056 (1%) in both modes; idle DO requests were not measured directly (C5 measures bursts and catch-ups) | **Yes**: idle cost equal to base and ≈ 1%; relay avoids the post-eviction reconnect |

### 8.7 Convergence

For each scenario, A, B and a fresh C have identical text and state vectors, the server GET equals the client text,
and the recorded hash equals the client's canonical hash. Summaries: `convergence-suite.json` (relay),
`convergence-suite-strict.json` and `convergence-suite-base.json`.

| Scenario | Smoke (v0930) | Full n relay | Full n strict | Full n base |
|---|---|---|---|---|
| L2 | pass | **pass** | pass | pass |
| L4 | pass | **pass** | pass | pass |
| quick trace | — | not in suite (accounting PASS) | not in suite (accounting PASS) | not in suite |
| stress trace | pass | **pass** (50k) | pass (50k) | **FAIL**: base semantic reset (4409), see below |
| B2 | pass | **pass** | — | pass |
| B3 | pass | **pass** | — | pass |
| B5 | pass (6/6, component) | **pass 20/20** | — | n/a |
| B6 | pass | **pass** | — | no block (skipped by design) |
| X1 sample | pass | **pass** | — | pass |
| CW (#7) | pass 21/21 | **pass 119/119** | — | pass 121/121 |

Totals (measured): relay **9/9 pass**; strict 3/3 run, all pass; base 6 pass, 1 fail, 1 n/a, 1 skipped.

- **C2-stress-base FAIL is base hitting its own semantic reset under stress, which the raw harness cannot follow. It
  is not relay data loss.** Server-side semantic compaction bumped the body to epoch 2 at frame 10,226 and sent 4409
  to all 6 sockets; 165 frames were outstanding at drain (GET 210,869 B vs client 210,844 B). Local yjs census at
  frame 10,226 (inferred): 20,478 structs, deleted ratio 0.311, which crosses the soft deleted-ratio threshold
  (≥ 0.25 with ≥ 10k structs, projected reduction ≥ 0.40). Ruled out: size limits, hard limits, the ywasm cap
  (13.1 MB of 96 MiB). The real client rebases on 4409; the raw harness client does not reconnect. Relay and strict
  have no server-side doc and no server-initiated reset, and converged at 50k.
- **C3-base** (outside the suite): a fresh C cannot open a 33rd socket. This is the real base limit.
- **X3-relay "fail" is a checker artifact** (outside the suite): text and SV are equal on A, B, fresh C and GET. A
  5 MB body gets no hash claim by design (> 256 KiB), and `checks.ts` treats the empty-string hash header as
  non-null, which produces a false inv7 "VIOLATED". Harness only; not fixed.

Frame accounting (4.3): **PASS in all 16** relay/strict runs with diagnostics (measured): C2-quick relay/strict
(5,000), C2-stress relay/strict (50,000), C4 relay/strict (50), L4 relay/strict (5,000), MB lean ×6 + strict ×2.
Base n/a. Invariant evidence at full n: 4 (B4 0 appends after the fence), 5/11 (B5 20/20, one install per race), 7
(CW-relay 119/119, CW-base 121/121, inv7 pass in every convergence leg), 8 (B6 dedupeHits 3, appendsDelta 1), 10 (K1
compact → 0 log rows; C2-stress converges at 50k).

### 8.8 Relay v3 (group commit)

All values are measured on deployed workers (runs r3-1002/b/c). Full tables are in
`experiments/results/relay3/RESULTS.md`. Latency phases are [conc].

| Area | Result |
|---|---|
| Rows/edit, MB type5 gql | base 5.58, v2 5.63, v3 0.42, **v3nc 0.29**, v3b5 1.53 |
| Rows/edit, C4 counter (spaced) | v2 5.0, v3 3.0, v3nc 2.0, v3b5 3.0. Phase-level gql: base 10.0, v2 8.5, v3 4.18, v3nc 3.18 |
| L2 propagation p50 / p99 (n = 290) | base 299 / 696, v2 63.0 / 396, **v3 47.7 / 76.3**, v3b5 301 / 333 |
| L2 receipt (origin ack) p50 / p99 | v2 62.9 / 396, **v3 350 / 482**, v3b5 604 / 926 |
| L4 per-frame p50 / p99 (n = 4,990) | v3 47.2 / 231 (f1001 v2 73.7 / 2,305) |
| L5 edit → cleared, real `VaultSync` (n = 90) | base prod 479, v2 relay 67.0, **v3 native 353** (p99 1,177), v3 native250 603. 8-edit burst first / last 1,246 / 359. 0 HTTP POSTs |
| MB type5 receipt p50 / p99 | v3 907 / 1,642, v3nc 949 / 1,603 (max-wait bound) |
| CRASH (pending buffer dropped) | online 5/5, offline-origin via peer 5/5. 51 frames dropped, **0 lost**, recovery p50 ≈ 0.8 s, fresh C converges |
| FENCE (cumulative acks) | too-large 5/5. Rate 6/6 refused rounds: 0 acked or durable after the refusal |
| Convergence suite | 9/9 (L2, L4, C2-stress, B2, B3, B5 20/20, B6, X1, CW 121/121) |
| B1 / B6 / B8 / X4 | pass / pass / pass / pass |
| B4 | invariant 4 holds; **convergence FAIL** (R11) |
| B7 | **1/3 pass** (R12) |
| Autosave 1 s, open note | v3nc 2.15 rows/save (gql), one commit per save; prop p50 45 ms |
| Autosave, closed note (HTTP candidate every 5 s) | 13.82 rows/POST (gql phase-level), POST p50 297 ms |
| Canvas identical re-save | 0 rows, no POST. 1 GET `semantic/<id>/state` (`canvasManager.ts:415/417`), code |

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
reruns with measured values (`--set name=value` or `--json`). It was re-run on 2026-10-01 with the full-run (f1001)
inputs below. Its docstring still says the micro-batch maximum is 50, which is stale; the cap is 250.

The model does not cover two things:
- the lean coalescing pass (runs A, B and E use whole-phase gql rows, which already include it)
- CPU (taken from gql directly, below)

Every output below is **inferred** from **measured** inputs. Model: 3 devices, 4 sockets each, 60 s pings, 270 s
ticket refresh, 2 h editing per day at 25% typing duty, 5 frames per typing second, Free limits (100k DO
requests/day, 100k rows/day).

**Inputs** (measured, f1001):
- `base_rows_per_flush` = 3.10 rows/edit (MB/C2 gql) × 9,000 / 7,200 flushes = **3.875**.
- Runs A, B and E use whole-phase gql rows/edit (MB-lean-mb10-stream 5.92, MB-strict-stream 11.84). These already
  include checkpoint, floor, coalescing and candidate rows, so A and B set `checkpoint_fixed_rows=0` and
  `journal_delete_rows_per_entry=0`. E keeps the modelled checkpoint rows as well (double-counted, pessimistic) and
  uses base 3.10 per flush.
- Runs C and D use the C4 relay counter (append rows only: relay 5.00, strict 11.00) plus the modelled checkpoint
  rows (8 fixed + 2 per pruned journal row).

**Output** (`costmodel.py --set …`):

| Run | Inputs | Typical base rows/day | Typical relay rows/day | Typical + 2,000-note import base / relay | DO req/day typical base / relay | Typing h/day to 100k rows base / relay |
|---|---|---|---|---|---|---|
| A relay (gql) | relay 5.92, mb 10; base 3.875/flush; ckpt rows included (0/0) | 30,024 (30%) | **53,460 (53%)** | 88% / **115%** | 2% / 3% | 1.67 / 0.94 |
| B strict (gql) | relay 11.84, mb 0 | 30,024 (30%) | **106,740 (107%)** | 88% / 180% | 2% / 3% | 1.67 / 0.47 |
| C relay (C4 counter + modelled ckpt) | relay 5.0, mb 10 | 45,576 (46%) | **64,620 (65%)** | 103% / 125% | 2% / 3% | 1.10 / 0.77 |
| D strict (C4 counter + modelled ckpt) | relay 11.0, mb 0 | 45,576 (46%) | **118,620 (119%)** | 103% / 191% | 2% / 3% | 1.10 / 0.42 |
| E relay (gql, ckpt double-counted, pessimistic) | relay 5.92, base 3.10/flush, mb 10 | 39,996 (40%) | 72,900 (73%) | 96% / 135% | 2% / 3% | 1.25 / 0.69 |

Run A output (verbatim):

```
| Day shape | Mode | DO req/day | % free | Worker req/day | % free | Rows written/day | % free | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---|
| idle | base | 1,056 | 1% | 0 | 0% | 0 | 0% | 12 sockets, 21,120 WS msgs |
| idle | relay | 1,056 | 1% | 0 | 0% | 0 | 0% | 12 sockets, 21,120 WS msgs |
| typical | base | 2,300 | 2% | 342 | 0% | 30,024 | 30% | 9,000 frames, 7,200 appends, 180 POSTs, 144 ckpts |
| typical | relay | 2,648 | 3% | 60 | 0% | 53,460 | 53% | 9,000 frames, 9,000 appends, 0 POSTs, 180 ckpts |
| typical+import | base | 5,000 | 5% | 2,742 | 3% | 87,774 | 88% | +2,000 notes |
| typical+import | relay | 5,648 | 6% | 2,460 | 2% | 115,300 | 115% | +2,000 notes |
```

**CPU** (measured, gql per-invocation; not in the model). The 10 ms limit applies to the Worker entry; a DO request
gets 30 s CPU on Free. 10 ms is still the bar for a cheap body edit. Per WS message, p99:

| | base | relay | strict |
|---|---|---|---|
| C2-quick WS p99 (n = 5,000) | **30.7 ms (over)** | 4.6 ms | 5.7 ms |
| C1 WS p99 (5,101 / 10,188 invocations) | **64.3 ms (over)** | 4.2 ms | 5.7 ms |
| C2-stress WS p99 | 7.3 ms (10,226 frames, provisional) | 2.8 ms (50k) | 1.9 ms (50k) |
| checkpoint alarm p99 | n/a | 59 ms (C1) / 108 ms (C2-quick) / **1,041 ms (C2-stress)** | 98 / 102 / 817 ms |

`exceededCpu` = 0 in every phase. K3 shows an exact SV or diff on a 5–10 MB body costs 7–14 ms, which is why bodies
over 256 KiB use the incremental SV (R4).

Reading the model:
- **Relay with lean rows fits Free on a typical day at 53–73%**, vs base at 30–46% (≈ 1.7× base rows). **Strict does
  not fit** (107–119%), so lean rows are a requirement.
- **Rows written, not requests, is the binding free-tier limit.** Typing hours/day to reach 100k rows: relay
  0.69–0.94 h vs base 1.10–1.67 h.
- **Import days.** A typical day plus a 2,000-note import exceeds 100k rows for the relay (115–135%); base sits at the
  edge (88–103%). The import is dominated by lifecycle rows (`import_rows_per_note`, assumed 25). A large import is a
  two-day operation on Free in either mode.
- **DO requests are not binding**: 2–3% on a typical day (≤ 6% with import), 1% idle in both modes. Worker
  requests/day: base 342, relay 60 (no candidate POSTs). Typical-day relay DO requests are 1.15× base (2,648 vs 2,300),
  which strictly exceeds reversal condition 3's 1.1× bar while both sit at 2–3% of Free (section 13).
- **Micro-batching.** At 5 frames/s, mb 10 does not merge appends (MB: 5.54 vs 5.55 rows/edit). Its value is the
  latency tail (stream p99 316 vs 416). Only mb ≥ 200–250 coalesces at typing cadence, and it gives back much of the
  latency win (smoke mb250 p50 ≈ 190–300 ms).
- **CPU does not bind for the relay**: WS p99 ≤ 5.7 ms and alarms ≤ 1.04 s, under the 30 s DO limit. The alarm is a
  wall-clock stall for the output gate, though (R9). Base already exceeds 10 ms per WS message.
- **Spend.** The runs used an unlimited enterprise account, profiled against Free. No quota was hit apart from the
  500-DO-namespace account cap (test-environment note, section 12).

### 9.1 Relay v3 cost model

Calculator: `scripts/relay2/costmodel3.py`. It imports `costmodel.py`, uses the same Free limits and adds the heavy
and autosave shapes. All values are **inferred** from the measured r3 gql inputs in
`experiments/logs/relay3/costmodel3-inputs.json`. A second run with the f1001 base 3.10 and relay 5.92 changes
only the base and v2 rows (base 30%, v2 53% typical); see `RESULTS.md` section 7.

| Day shape | Config | DO req/day | % Free | x base | Worker req/day | Rows written/day | % Free | x base | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| typical | base | 2,300 | 2.3% | 1.00 | 342 | 52,344 | 52% | 1.00 | 9,000 frames, 7,200 appends, 180 POSTs, 144 ckpts |
| typical | relay v2 | 2,648 | 2.6% | 1.15 | 60 | 50,850 | 51% | 0.97 | 9,000 frames, 9,000 appends, 0 POSTs, 180 ckpts |
| typical | v3 | 2,648 | 2.6% | 1.15 | 60 | 2,790 | 3% | 0.05 | 9,000 frames, 9,000 appends, 0 POSTs, 180 ckpts |
| typical | v3 (candidateId) | 2,648 | 2.6% | 1.15 | 60 | 3,960 | 4% | 0.08 | 9,000 frames, 9,000 appends, 0 POSTs, 180 ckpts |
| typical | v3+B5 | 2,198 | 2.2% | 0.96 | 60 | 13,950 | 14% | 0.27 | 9,000 frames, 9,000 appends, 0 POSTs, 180 ckpts |
| heavy | base | 8,132 | 8.1% | 1.00 | 1,314 | 335,002 | 335% | 1.00 | 57,600 frames, 46,080 appends, 1,152 POSTs, 922 ckpts |
| heavy | relay v2 | 10,910 | 10.9% | 1.34 | 60 | 325,440 | 325% | 0.97 | 57,600 frames, 57,600 appends, 0 POSTs, 1,152 ckpts |
| heavy | v3 | 10,910 | 10.9% | 1.34 | 60 | 17,856 | 18% | 0.05 | 57,600 frames, 57,600 appends, 0 POSTs, 1,152 ckpts |
| heavy | v3 (candidateId) | 10,910 | 10.9% | 1.34 | 60 | 25,344 | 25% | 0.08 | 57,600 frames, 57,600 appends, 0 POSTs, 1,152 ckpts |
| heavy | v3+B5 | 8,030 | 8.0% | 0.99 | 60 | 89,280 | 89% | 0.27 | 57,600 frames, 57,600 appends, 0 POSTs, 1,152 ckpts |
| autosave-8h (open note) | base | 32,540 | 32.5% | 1.00 | 29,142 | 480,744 | 481% | 1.00 | inferred: 1 flush + 1 candidate POST per save |
| autosave-8h (open note) | v3 | 5,528 | 5.5% | 0.17 | 60 | 64,710 | 65% | 0.13 | open note: 1 socket frame per save (MB autosave gql) |
| autosave-8h (closed note) | v3 | 8,408 | 8.4% | 0.26 | 5,820 | 82,393 | 82% | 0.17 | closed note: 1 HTTP candidate per 5 s (HTTPSAVE gql) |

| Config | Rows per typing-second | Non-stop typing hours/day to 100k rows (excl. idle) |
|---|---:|---:|
| base | 29.0 | 0.96 |
| relay v2 | 28.1 | 0.99 |
| v3 | 1.4 | 19.16 |
| v3 (candidateId) | 2.1 | 13.23 |
| v3+B5 | 7.7 | 3.63 |

Inputs: base_rows_per_edit=5.58, relay_rows_per_edit=5.63, v3_rows_per_edit=0.29, v3c_rows_per_edit=0.42, v3b5_rows_per_edit=1.53, v3b5_frames_per_edit=0.5, autosave_rows_per_save=2.15, httpsave_rows_per_post=13.82, base_autosave_rows_per_save=14.875

- **Rows are no longer the binding limit.** v3 is 3% typical and 18% heavy, against v2 51–53% and 325–342%. 100k
  rows takes 19.2 h of non-stop typing.
- **The autosave plugin day fits:** 65% (open note) and 82% (closed note, HTTP path). Base, inferred, is ≈ 460–480%.
- **DO requests are not changed by v3** (1.15× base typical, 1.34× heavy, both ≤ 11% of Free). R10 stands as in
  v2. B5 would bring DO requests to 0.96–0.99× base, but at 4.9× the rows (R13).

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

**Gaps.** G1–G23 were found while checking the RFC against the code in rounds 1–4; G24–G26 come from the full run f1001.
Status is as of `7feae39` (server) and f1001 (measurements).

| G | Gap (as found) | Status | Fix |
|---|---|---|---|
| G1 | The feed floor never advanced for relay-only workloads, so `vault_journal` grew without bound. | **fixed, round 3** | `runCheckpointPass` advances the floor to `current − 1000`, below every pin. Unit test: 5,000 appends leave 1,001 rows (floor 4002, 41 advances). Full n: K1-compact-relay → 0 log rows; C2-stress-relay converges at 50k (K1-alarm inconclusive). |
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
| G22 | mb 0 head-of-line tails (0.4–2 s p90) behind the checkpoint alarm. | **mitigated, round 4** | `checkpointsFromCache`, the lean delayed alarm, and mb 5–10 as the default. Full n: L2-strict p99 333, L4-strict p99 866 (max 2,183), MB strict stream p99 506 ms. Relay mb 10 still shows tails (G24). |
| G23 | Lean mode: the raw catalog log lags by ≤ 2 s; frame-0 attribution is pruned at the feed floor; turning lean off needs a coalescing pass first. | **accepted** (round 4) | Documented in `relay2-protocol.md` §6.4. Flag-off migration is not automated. |
| G24 | **Relay p99 tails at full n** (new, f1001): L4-relay p99 2,305 ms / max 3,435 (n = 4,990, [conc]) and C2-quick-relay propagation p99 9,132 ms (n = 5,000, max-rate, [B∥10]). The same config in lane B gave p99 316 (MB-lean-mb10-stream) and L4-strict (serial) 866. | **open** — GO condition 2 | Cause not isolated; tails recur across the run, not cleanly attributable to concurrency. Likely suspect: the checkpoint alarm (G25). Needs a per-frame trace correlated with alarm start/stop. |
| G25 | **Checkpoint-alarm CPU grows with body history** (new, f1001): relay alarm p99 59 ms (C1), 108 ms (C2-quick), **1,041 ms** (C2-stress, 50k edits); strict up to 817 ms. | **open** — GO condition 2 | Under the 30 s DO limit, but a wall-clock stall for the output gate. Candidates: bound the merge work per pass by bytes, not rows; checkpoint more often on hot bodies; move the merge off the output-gate path. |
| G26 | `checks.ts` treats an empty-string hash header as a claim, producing a false inv7 "VIOLATED" on X3-relay (5 MB body, no claim above 256 KiB by design). | **open, harness only** | Text and SV are equal everywhere; not a server bug. Fix the checker to treat "" as no claim. |

**Base findings at full n** (not relay defects, but they bear on the comparison):
- **Base semantic reset fires on a realistic 10k-edit trace** (C2-stress-base): deleted ratio 0.311 at 20,478
  structs crosses the soft threshold, epoch 2 at frame 10,226, 4409 to all 6 sockets. With base, every client gets a
  mid-session rebase on a heavily edited note. Relay has no server-initiated reset.
- **Base 5 MB compact returns HTTP 500** (X3-base, 164 ms). Relay compacts 5 MB in 846 ms.
- **Base exceeds 10 ms CPU per WS message** (C2-quick p99 30.7 ms, p90 16.8 ms; C1 p99 64.3 ms).
- **B1-base lost all sockets after 150 s idle** (1008 "socket authority mismatch").

**Test-environment note.** Cloudflare caps an account at 500 Durable Object namespaces (error 10067). The full run hit
it, so 40 phases (C3, B2–B6, B8, SEED, all L, B7, X2) ran on reused idle `yaos-relay2-v1001-*` workers, each with a
fresh vault and redeployed vars. The server code is identical. A self-hosted single-vault deployment is far below this
cap; it matters only to harnesses that deploy one Worker per scenario. Other run trims (user-approved): MB sweep cut to
mb {0, 10, 50}; C2-stress replayed at max rate (CPU/rows only); 10 MB X3, X2 above 800/s and X1 above 2,000 not run;
C2-stress-base gql provisional (10,226 frames); K1-alarm inconclusive.

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
  - Full run (inferred from measured f1001 inputs, section 9): relay lean + mb 10 is 53–73% of 100k rows/day on a
    typical day, against base 30–46% (≈ 1.7×). Measured rows/edit: relay 5.00 (C4 counter) to 5.92 (gql), base 3.10.
  - Strict (lean off, mb 0) is 107–119%. Lean is required on Free.
  - Residual risk:
    - continuous typing above ≈ 0.69–0.94 h/day for the relay (base 1.10–1.67 h), the 100k crossing point
    - import days: a typical day + 2,000 notes is 115–135% for the relay, 88–103% for base
  - **v3 retires R5 for edit traffic.** Section 9.1: typical 3%, heavy 18%, 19 h of non-stop typing to 100k. The import-day residual is set by
    lifecycle rows (`import_rows_per_note`), which v3 does not change.
- **R6 — Tail CPU measurements are lossy.**
  - `wrangler tail` dropped every WS event on a busy Worker (scratch-1 C1: 0 events). It matched 15/15 on a quiet one
    (scratch-2).
  - C1/C2 numbers must come from gql aggregates (`Invocations`, µs) or from matched-sample tails with loss reported.
    Per-event p50 from a lossy tail is biased toward quiet periods.
- **R7 — Receiving-side validation does not exist yet.** Relay mode without it drops today's server-side
  frontmatter/root-shape gate.
- **R8 — Measurements taken in Node** (K3, K2) and on an enterprise account. Workers Free DO limits are the same
  tables, but CPU and memory accounting on the edge may differ.
- **R9 — Relay p99 tails and alarm CPU growth (new at full n; G24, G25).**
  - L4-relay p99 2,305 ms and C2-quick-relay propagation p99 9,132 ms, while p50 stays ≈ 64–74 ms and lane-B mb 10
    p99 is 316 ms.
  - The checkpoint alarm's CPU scales with body history (p99 1.04 s at 50k edits) and blocks the output gate.
  - This is GO condition 2: fix or explain before default-on.
- **R10 — DO requests per edit burst are higher on the relay** (C5: 1.88 vs 0.51 units per burst; catch-up 3.43 vs
  1.92). The model puts the typical day at 1.15× base, over the 1.1× reversal bar, but at 2–3% of Free. The real
  base candidate path costs more per burst (L5b1: base prod 1.05 vs relay 0.10 units), which the C5 raw adapter does
  not exercise.
  - **v3 does not change it.** Group commit changes rows, not WS messages: the typical day is 1.15× and heavy 1.34×
    (inferred). Measured with the real client, L5b1-v3 native is 0.10 units per edit vs base prod 1.05. B5 halves
    the WS messages (L5b8 0.80 → 0.40 units per 8-edit burst), but it is not recommended (R13).
- **R11 — v3: a revoked device's buffered frames reach peers but never become durable (B4-v3, measured).**
  - In v3, frames broadcast before a revocation and dropped at flush (G2) leave the live peers ahead of the server.
    B4-v3 dropped 10 of 40 pre-revocation frames, and its convergence check failed (fresh C and GET ≠ live
    clients). This is the accepted design change "revoked frame may already have reached peers"
    (`relay3-group-commit.md`, invariant change 2). Under reversal condition 4 it is still a convergence failure.
  - The drop also buys little. The peer's next re-sync (reconnect step2 or wake re-sync) re-submits those bytes
    under the peer's own authority, and they become durable anyway.
  - Proposed fix: commit frames that passed authority at admission, even if the device is revoked before the flush.
    Invariant 4 only forbids frames after the fence. Alternatively, flush the device's buffers synchronously inside
    `closeDevice` before the 4403. Either makes B4 converge, and neither weakens the post-fence guarantee.
- **R12 — v3: flood isolation is flaky (B7-v3 1/3 pass).**
  - In a 5 MiB/s flood of 64 KiB frames, the v3 flooder could push 63 MB (a3) before our `relay rate limit` closed
    it, 43 s in. f1001 v2: 2.2 MB, closed at 26.9 s.
  - In a1 the flooder was not closed within 40 s, and Cloudflare shed the bystander's socket on the same DO with
    `1013 Service overloaded`. a2 was inconclusive (1006 right after a redeploy).
  - Suspect: every ≥ 64 KB frame triggers a synchronous byte-cap commit, and admission keeps accepting (and
    broadcasting) while the commits back up.
  - Needs a serial re-run on an idle machine, plus a check that the token bucket is debited at admission, not at
    flush.
- **R13 — v3: B5 send-coalescing defeats group commit at idle = 300 ms (measured).** With B5 at 250 ms, wire frames
  are ≥ 250 ms apart. The 300 ms idle timer then fires between most of them: MB type5 went from 70 to 275 commits,
  0.38 → 1.50 rows/edit (3.9×), and added 250 ms to propagation (L2 48 → 301 ms p50). Keep B5 off. If it is ever
  wanted, idle must be well above the coalesce window (≥ 2×).
- **R14 — v3: receipts are 0.3–1.5 s after the edit (user-approved).** Continuous typing at 5 keys/s commits on
  max-wait, so the receipt p50 is ≈ 0.9 s and p99 ≈ 1.6 s (MB type5). The UI must not treat "unconfirmed for < 2 s"
  as pending-sync noise. The client resend timer (5 s) and the HTTP fallback (15 s) sit well above the 1.5 s max.

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
   5 frames/s) is > 100% of 100k rows/day for the relay **and** > 1.25× base.
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

**Status at full n (f1001):**

| # | Status | Evidence |
|---|---|---|
| 1 | not triggered | L2 p50 308 → 66.0 ms (4.67×), p99 608 → 314 ms (measured, n = 290) |
| 2 | not triggered | relay 53–73% of 100k rows/day (inferred, measured inputs); > 100% only for strict (107–119%) and import days |
| 3 | **exceeded on the letter; needs sign-off** | model typical day 2,648 vs 2,300 DO req/day = 1.15× base, both 2–3% of Free; idle equal (1,056). Measured C5 per burst 1.88 vs 0.51 units (raw adapter); L5b1 with the real candidate path 0.10 vs 1.05 units (R10) |
| 4 | not triggered | relay convergence 9/9, strict 3/3; invariants 1–8, 3a, 10, 11 hold; accounting 16/16. The base C2-stress FAIL is base's own semantic reset |
| 5 | not triggered | C1 WS CPU p50 0.22 vs 1.36 ms; relay WS p99 4.2–4.6 ms ≤ 10 ms. The checkpoint alarm (p99 up to 1.04 s) is not per append and is tracked as R9 |
| 6 | not triggered | X1 2,000/2,000 ≥ 250; C3 4.06 MB < 37.22 MB |
| 7 | partly open | 1 MB mobile build 103–155 ms inferred (< 2 s); B5 20/20, no lost edit. Starvation (R2) at 1 frame/s: not measured |
| 8 | not triggered (partial evidence) | K1-compact → 0 log rows; unit test 5,000 appends → 1,001 rows. Per-body journal row counts after the stress trace: not reported in the full run |
| 9 | n/a | post-launch |

**Status for relay v3 (r3-1002/b/c, measured unless noted):**

| # | Status | Evidence |
|---|---|---|
| 1 | not triggered | L2 p50 299 → 47.7 ms (6.3×), p99 696 → 76.3 ms ([conc], n = 290). The receipt is slower by design (p50 350 ms, R14) |
| 2 | not triggered, and the margin is now large | v3 is 3% typical and 18% heavy (inferred); 0.29 rows/edit vs v2 5.63. Condition 1 of section 1 (lean mandatory) is retired |
| 3 | **unchanged: exceeded on the letter; needs sign-off** | group commit does not change WS messages. Model 1.15× base typical, 1.34× heavy (inferred), ≤ 11% of Free. R10 is unchanged |
| 4 | **triggered on the letter (B4 convergence)** | invariant 4 holds (0 appends after the fence). But a revoked device's pre-fence frames were broadcast and then dropped at flush: 10 frames diverge (R11). Convergence suite 9/9, CRASH 10/10 with 0 lost, FENCE 6/6 refused rounds safe. B7 1/3 (R12). Fix R11 before ship |
| 5 | not measured for v3 | C1 not re-run. The v3 flush is one batch per 300 ms–1.5 s, so per-append CPU is no worse than v2 (inferred) |
| 6 | not re-run | X1 not run on v3. CW 121/121 pass |
| 7 | B5 20/20 | no lost edit across epoch resets under v3. R2 not measured |
| 8 | not re-run | the commit-row shape is the same as v2 |
| 9 | n/a | post-launch |

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
| Full-n run JSONs (per scenario id) | `experiments/logs/relay2/runall-f1001/raw/<id>.json` (tag f1001, 2026-10-01); `tables.md`, `progress.jsonl`, `runall.log`, `gqlfill-final.log` alongside. Manifest copy: `experiments/results/relay2/raw/runall-manifest.jsonl` |
| Small-n / smoke run JSONs | `experiments/logs/relay2/runs/`, `experiments/logs/relay2/runall-w0930-small/raw/` (not in git; contexts hold tokens) |
| Deploy records | `experiments/logs/relay2/deploy-<name>.json` |
| Results tables | `experiments/results/relay2/RESULTS.md`; report `REPORT.md` |
| K2 | `experiments/results/relay2/K2.md`, `K2-local-2026-09-29T19-58-32-456Z.json` |
| K3 | `experiments/results/relay2/K3.md`, `K3-byteops-all.json`, `K3-byteops-svdiff-all.json`, `K3-bundle-size.json` |
| B5 | `experiments/results/relay2/B5-2026-09-29T20-13-40-001Z.json`, `B5-2026-09-29T20-16-32-720Z.json` |
| Live reset (round 2/3) | `experiments/results/relay2/core2-live-reset-5mb.json`, `core3-live-reset-5mb.json` |
| Flag / base tests | `experiments/results/relay2/flag-tests.md`, `base-tests.md`, `base-tests.json`, `core{,2,3,4}-flag-*` logs |
| Prior art | `experiments/results/A1.md`, `A2-A4.md`, `A3.md`, `A5.md` |
| Convergence | `experiments/logs/relay2/runall-f1001/raw/convergence-suite.json` (relay 9/9), `convergence-suite-strict.json` (3/3), `convergence-suite-base.json` (6 pass, 1 fail, 1 n/a, 1 skipped) |
| Final deploy version IDs (base / relay / strict) | Tag f1001. Lane B: fresh `yaos-relay2-f1001-<scenario>-<variant>` workers at spike `d929410`. Reused phases: `yaos-relay2-v1001-*` workers redeployed at `45f3705` with per-phase vars (the worker name is historical; the variant is recorded in each JSON's `vars` and `protocolAdapter`). Every raw JSON records `workerName`, `deploymentVersionId`, `baseSha` and `deployedSpikeSha`. Selected below. |

Selected deploy records (from raw JSON metadata; base SHA `5dd32f3` throughout):

| Scenario | Worker | Deployment version id | Spike SHA | Started (UTC) |
|---|---|---|---|---|
| L2-base | `yaos-relay2-v1001-c1-strict` | `c3bcd97d-f79c-4aa1-8f47-be9d03d4545f` | `45f3705` | 2026-10-01 15:13 |
| L2-relay | `yaos-relay2-v1001-c2-quick-relay` | `ebb06898-a491-4cc0-9a59-15f816046962` | `45f3705` | 2026-10-01 15:15 |
| L2-strict | `yaos-relay2-v1001-c2-quick-base` | `b9e93e19-f7cf-4565-8d2b-3eb78f55ef4a` | `45f3705` | 2026-10-01 15:18 |
| L4-base | `yaos-relay2-v1001-l1-relay` | `007698a0-8b09-461e-9dde-e9813fa58a0f` | `45f3705` | 2026-10-01 15:29 |
| L4-relay | `yaos-relay2-v1001-c3-base` | `aef12799-e63a-4e38-8078-76dc16b40614` | `45f3705` | 2026-10-01 15:29 |
| L4-strict | `yaos-relay2-v1001-c2-stress-relay` | `de5bb064-881e-4f43-97c1-569575d74c33` | `45f3705` | 2026-10-01 15:24 |
| C1-base | `yaos-relay2-f1001-c1-base` | `4b67ae31-f85b-46bb-a68a-7bb87bfda1a6` | `d929410` | 2026-10-01 13:48 |
| C1-relay | `yaos-relay2-f1001-c1-relay` | `be47a71b-43c8-434a-9851-76c978347368` | `d929410` | 2026-10-01 13:48 |
| C1-strict | `yaos-relay2-f1001-c1-strict-a2` | `0ef690be-fde1-4c95-b6c4-95c4e7c22476` | `d929410` | 2026-10-01 13:53 |
| C2-quick-base | `yaos-relay2-f1001-c2-quick-base` | `52b8570b-6ef9-428b-a5da-85e38555d16e` | `d929410` | 2026-10-01 13:46 |
| C2-quick-relay | `yaos-relay2-f1001-c2-quick-relay` | `7259077d-3faa-44cd-92b5-b96110e14a4a` | `d929410` | 2026-10-01 13:46 |
| C2-quick-strict | `yaos-relay2-f1001-c2-quick-strict` | `15175c87-d554-4cf0-a412-bf30f871b0e5` | `d929410` | 2026-10-01 13:47 |
| C2-stress-relay | `yaos-relay2-f1001-c2-stress-relay` | `07dbcf83-05a3-4e2a-9b88-3f77d5d59a35` | `d929410` | 2026-10-01 13:38 |
| X1-relay | `yaos-relay2-f1001-x1-relay` | `5f82c76b-4a8a-4112-8504-f9fd086703fb` | `d929410` | 2026-10-01 13:37 |
| B5-relay | `yaos-relay2-v1001-b7-relay` | `e2fae91c-386d-4680-97f5-670c437c4108` | `45f3705` | 2026-10-01 15:08 |
| C6-relay | `yaos-relay2-v1001-c1-base` | `ee378cd6-1574-424f-a7d2-d04f6fdd1f23` | `45f3705` (harness `35e8b06`) | 2026-10-01 15:50 |
