# Relay v3: group commit, tail row, receipt ring

Status: experiment, behind `YAOS_RELAY_GROUP_COMMIT` (`1` or `true`). It needs `YAOS_RELAY_BODIES=true`
and `YAOS_RELAY_LEAN_ROWS=true` and is ignored without them. With the flag off, the schema and every
code path are the same as relay v2.

## Why

Relay v2 lean costs about 5–6 Cloudflare rows written per keystroke. Each frame pays for:

- a journal insert plus its index entries
- a head update
- a `vault_candidate_receipts` insert plus its autoindex
- part of a `setAlarm`

The Free plan allows 100k rows a day. v3 aims for about 3 rows per *commit* and commits about once per
typing burst.

## Design

**B1. Share now, save in groups, confirm after saving** (`RelayBodyService.groupEnqueue` / `flushGroup`).

- Every message of a relay socket is first charged to the socket's rate budget on its raw size (R12, below).
  Then a frame is checked as in v2: authority, envelope and receipt dedupe.
- After the check, the frame is broadcast at once and buffered under its (body, epoch).
- The buffer is committed in one `transactionSync` when the first of these happens:
  - `YAOS_RELAY_GC_IDLE_MS` passes with no new frame (default 300) **and** at least
    `YAOS_RELAY_GC_MIN_INTERVAL_MS` (default 1000; 0 = off) has passed since the body's previous commit
  - `YAOS_RELAY_GC_MAX_MS` passes after the first frame (default 1500)
  - the buffer reaches `YAOS_RELAY_GC_MAX_BYTES` (default 65536; this flush is synchronous)
  - a forced flush: HTTP candidate/currentness read, authority fence, semantic reset (immediate)
- Commit-rate cap (commit 4a34f56): the idle timer is re-armed on every frame at
  max(last frame + idle, previous commit + min interval). A deferred idle commit is therefore scheduled
  for previous commit + min interval; it never waits for the next frame. Idle commits of a body are at
  least 1 s apart whatever the typing rhythm, and every frame still waits at most `GC_MAX_MS`. Without
  the cap, typing with gaps over 300 ms (1–3 keys/s, mobile, pauses) committed once per frame.
- Both timers use `setTimeout`. v3 never calls `setAlarm` per commit.
- At flush, these checks run again:
  - G2 revocation: the frame is dropped and the socket closed with 4403
  - the epoch, in memory and again inside the transaction: the frame is fenced with 4409
  - B6 receipt dedupe: a resend whose first copy was committed in the meantime gets a dedupe ack
  - in-buffer duplicate candidates
  - the growth cap: a covered update on a large body gets an exact merge check, so wake-resync step2s
    and resends write nothing
- `BODY_COMMITTED` receipts use the v2 wire format. They are sent only after the commit returns.
- After a commit there is no second fan-out.
- A socket that runs step1 while frames are buffered gets the buffered frames right after its step2.
  The frames are not durable yet, so that step2 does not contain them.

**B2. One tail row per body.**

- `relay_body_tail` is WITHOUT ROWID with a text primary key. It stores the group-commit records
  `(sequence, generation, update)` since the body's last checkpoint, plus the last accepted hash and
  the last committer.
- Reads merge journal rows and tail records by sequence (`journalUpdatesAfter`): reconstruct,
  `durableParts`, bootstrap byte reads and step1.
- When the tail reaches `YAOS_RELAY_GC_TAIL_BYTES` (64 KB) or 512 records, the server writes a
  byte-merged checkpoint at the head (`checkpointTail`). In the same transaction:
  - the tail row is deleted
  - first, any record that an active history pin still needs moves to a journal row
- The catalog event for the body is coalesced first, so the accepted hash survives.
- A tail that would grow past 1 MiB (a body whose checkpoint cannot make progress) falls back to a v2
  lean journal row.

**B3. One receipt row per device.**

- `relay_device_receipts` is WITHOUT ROWID with `client_id` as the primary key.
- It holds a newest-first JSON ring of the last 256 receipts, with the same 15-minute TTL as v2. The
  row is UPSERTed in place once per commit per device.
- `candidateReceipt` and `committedOperationOutcome` (G14) fall back to the ring.
- A resend whose receipt has aged out still reaches the growth cap. It is a CRDT no-op and gets a
  no-op ack. It never writes a row.

**B4. Schema trims.**

- Neither v3 table has a secondary index.
- The head is updated once per group commit.
- The sequence is `MAX(clock, journal head, tail head) + 1` (`leanHeadSql`). The clock is raised
  before any tail row is deleted, so a sequence is never reused.

**Feed and catalog.**

- `listChangesAfter` reports a body whose head has no journal row as one `body` entry at the head
  sequence. The feed means "document changed at S", so the intermediate tail sequences collapse into
  the head.
- The catalog head is served by the lean overlay, which reads the tail hash.
- The catalog *delta feed* is published by coalescing. That happens in three places:
  - at a tail checkpoint
  - at a semantic reset
  - in the relay alarm pass. A commit arms that alarm at most once per `YAOS_RELAY_GC_CATALOG_DELAY_MS`
    window (default 30000; 0 turns it off), and the host dedupes it in memory.

**Wake re-sync** (`ensureWakeResync`). It is called from fetch, webSocketMessage and alarm.

- A new runtime sends step1 once, with the durable state vector, to every open relay body socket that
  an earlier runtime admitted, if that socket's epoch is still current.
- Each client replies with a step2 of whatever the server lacks. This recovers frames that a crashed
  runtime broadcast but never committed.
- A step2 that is already covered writes nothing (growth cap).

## Invariant changes

1. **"Durable before broadcast" becomes "durable before receipt".** Peers can apply a frame that is
   later lost in a crash. The origin never received a receipt for it, so it resends; wake re-sync also
   pulls it back from any peer. HTTP reads (GET/HEAD, bootstrap, feed) only ever see durable state.
2. **Revocation fence (R11).** Peers and durable state must agree across a revocation, and no frame
   received after the fence is ever broadcast or appended. Every authority write in the DO
   (`/__yaos/authority-fence`, `/__yaos/revoke-device-sockets`) first calls
   `relay.flushForAuthorityFence()` in the same turn, with no await in between. Frames relayed before
   the fence (already broadcast) are committed and acked under the authority that relayed them. The
   write bumps `authorityVersion` synchronously, so the next frame of the revoked device misses the
   actor cache (the 5 s TTL never serves a stale "allowed" across a bump). It fails the fresh check at
   receipt (4403) and is never broadcast or buffered; later frames of that socket hit
   `failedSocketDrops`. There is no cross-isolate window: one DO instance per vault holds both the
   relay buffers and the authority tables, and it is single-threaded. Safety net: if a buffered
   frame's device has lost authority at flush (an authority writer that skipped the fence flush),
   v3 commits it anyway, because it was authorised at receipt and peers already applied it. It is
   counted in `revokedBroadcastCommits` and the socket is closed with 4403. v2 micro-batching
   broadcasts only after the commit, so it still drops such frames (`authorityDrops`).
   (Before d3b4db8, the deployed B4 run broadcast 10 frames of a revoked device and then dropped
   them at flush, so peers diverged from durable state.)
3. Tail attribution only covers the last commit: `attr_*` holds the last committer. No per-frame
   `vault_mutation_attribution` rows are written. G14 outcomes come from the receipt ring.
4. Receipts are bounded to 256 per device. An older resend is answered as a CRDT no-op.
5. No silent drops: `updateFrames` = the sum of the v2 outcomes + `groupDropped`. `groupFlushDedupes`
   is a subset of `dedupeHits`. On v3 no frame is dropped by authority at flush (item 2), so
   `authorityDrops` stays 0. `revokedBroadcastCommits` is a subset of the commit outcomes.
   `failedSocketDrops` is also an outcome (item 6).
6. **Acks are cumulative-safe per socket** (the client treats an ack for frame N as confirming every
   earlier frame of that socket). Frames of one socket are committed in arrival order: one body and one
   epoch per socket, one buffer per (body, epoch), synchronous byte-cap flushes, one transaction per
   group. A refused frame (rate limit, too large, authority, epoch fence, inactive body, commit failure,
   frame error, including one frame of an over-limit split) fences its socket: frames that arrived after
   it are dropped unacked (`failedSocketDrops`), and frames buffered before it still commit and ack.
   After a wake, an earlier-runtime socket's acks are held until its re-sync step2 is durable
   (`wakeHeldAcks`), because a frame it sent before the wake may have been lost with the buffer.
7. An HTTP candidate or a currentness query for a body flushes that body's buffer first
   (`groupFlushReads`). Neither ever waits on a timer. An HTTP copy of relayed bytes is therefore a
   CRDT no-op: it writes no body rows, only its receipt ring entry (1 row).
8. **HTTP save through the group-commit store.** A non-creation HTTP candidate (`POST
   body/:id/candidate`, or one item of `/body/candidates`) is still validated by
   `VaultCandidateService`: ywasm apply, canonical markdown and the exact content hash. It is then
   committed by `relay.commitHttpCandidate`: tail 1 + head 1 + receipt ring 1 = 3 rows. The base path
   would write clock, journal, attribution, head upsert, catalog event, operation outcome and
   candidate receipt (14 rows). A candidate that changes nothing writes only its ring entry (1 row).
   The receipt JSON is unchanged. The ring answers replay, digest reuse
   (`candidate_id_reused_with_different_digest`) and `GET operations/:id/outcome`, matching on
   principal, membership revision and credential revision. The ring is bounded (256 per device, TTL
   as before). Because CRDT re-application is idempotent, a replay older than the ring re-validates
   as a no-op. The exact hash is claimed only if no commit landed between validation and commit;
   otherwise the hash is left unknown and materialised lazily. The catalog event is coalesced by the
   alarm, as for relay frames. Creation candidates and merged updates over the durable value limit
   keep the base path. No client change is needed.

## Rows per commit (Cloudflare billing, inferred)

| Statement | Rows | Why |
| --- | --- | --- |
| `relay_body_tail` UPSERT | 1 | WITHOUT ROWID, text primary key, no index |
| `vault_document_heads` UPDATE | 1 | sequence, generation and hash columns; no indexed column changes |
| `relay_device_receipts` UPSERT | 1 per device with candidate frames in the commit | WITHOUT ROWID, no index |
| `setAlarm` | at most 1 per 30 s window per DO | catalog coalescing |

That is 3 rows per commit for one typing device. At the defaults, a typing burst of N keystrokes
costs about 3 rows instead of about 5N. Each tail checkpoint (one per about 64 KB of updates) also
writes about 12 rows: checkpoint chunk + manifest, catalog event, clock, and the tail delete.
`tests/server/relay3-group-commit.ts` measures all of this as statement changes × (1 + index
entries).

HTTP candidate POST (closed-note save), measured locally with the same meter. These numbers are
inferred and have not been run on a deployment:

| Path | Rows per POST | By table |
| --- | --- | --- |
| Base (before) | 14 | clock 1, journal 2, attribution 2, head 2, catalog event 3, operation outcome 2, candidate receipt 2 (deployed gql: 13.82) |
| v3 relay path (after) | 3 | tail 1, head 1, receipt ring 1 |
| v3, identical re-save | 1 | receipt ring 1 |
| Deferred catalog coalesce | 5 per body per 30 s window, plus 1 alarm | clock 2, catalog event 3 |

For the HTTPSAVE shape (one POST every 5 s to one closed note), that is (6 × 3 + 5 + 1) / 6 ≈ 4.0 rows
per POST. Tail checkpoints add about 12 rows per 512 records or 64 KB.

Typing rhythm, one body, one device, 30 s per pattern. Local virtual-time accounting
(`tests/server/relay3-group-commit.ts`, "commit-rate cap"), inferred and not deployed. Rows are
3 per commit (tail, head, receipt ring) with candidate ids:

| Pattern | Rows/keystroke without cap | With cap (1000 ms) | Max commits/s (without / with) | Receipt p50 / max with cap |
| --- | --- | --- | --- | --- |
| 1 key/s | 3.00 | 3.00 | 1 / 1 | 300 / 300 ms |
| 2 keys/s | 3.00 | 1.55 | 2 / 1 | 800 / 800 ms |
| 3 keys/s | 3.00 | 1.03 | 3 / 1 | 633 / 967 ms |
| 5 keys/s | 0.38 | 0.38 | 1 / 1 | 900 / 1,500 ms |
| 8 keys/s | 0.25 | 0.25 | 1 / 1 | 875 / 1,500 ms |
| Bursty, gaps 100–2000 ms | 2.61 | 2.23 | 2 / 1 | 300 / 1,362 ms |

At or below 1 key/s the cap cannot help: one commit per keystroke is already one per second, so the
cost is 3 rows per keystroke (3 rows per second of typing). The cap bounds rows per second of activity
at 3 per body, not rows per keystroke.

## Rate limit (R12, commit 4a34f56)

Why B7-v3 closed the flooder late (code reading; the deployed timings are measured, the cause is
inferred):

- The bucket was checked at step 4 of `handleSyncFrame`. Before it, every frame paid: attachment
  parse; for text, `JSON.parse` of the envelope (envelopes were never charged); outer and sync
  decode; SHA-256 of the whole update when an envelope was pending; the authority check; and a
  `candidateReceipt` SQL read when the envelope had a candidate id.
- It charged `update.byteLength` only. Envelopes, step1, empty frames and dedupe hits (replays)
  were free.
- After the 1013, the close takes time to complete, and frames already queued kept arriving.
  Each one still paid the decode and the digest before the failed-socket check. On v2 there was
  no failed-socket mark at all.
- Each accepted 64 KiB frame hits the 64 KB bytes cap, so it triggers a synchronous group commit
  and often a tail checkpoint (a merge of a growing body). The DO is single-threaded, so it
  processed the flooder's queue more slowly than the queue filled. The bucket measures processing
  time, so the overdraft frame was reached only after the backlog: 43 s and 63 MB in a3. In a1,
  Cloudflare shed the DO (`1013 Service overloaded`) first.
- The bucket is per socket and starts full on every new socket.

The fix:

- `VaultSocketService.message` calls `relay.admitKnown` as its very first step: a WeakMap lookup by
  socket object, the refused flag, a size compare and the bucket arithmetic. The first message of a
  socket in a runtime parses the attachment once, then calls `admitRelay` (bucket keyed by socket id).
- Every message is charged its raw size: bytes for binary, UTF-16 units for text.
- The hard size cap is checked at the same point (binary 1,750,064 B, text 64 KiB; close 1009).
- On the first overdraft: `VAULT_BACKPRESSURE`, close 1013 `relay rate limit`, and the cumulative-ack
  fence (`markFailed`): frames buffered before it still commit and ack, nothing later is acked.
  Every later message of the socket is dropped in O(1) (`rawGateDrops`): no parse, decode, digest,
  authority check or broadcast. A dropped sync update still counts in `updateFrames` and
  `failedSocketDrops` (a 5-byte peek), so the outcome sum holds.
- The burst floor is now `MAX_DURABLE_UPDATE_BYTES + 64 + 64 KiB`, so one maximum raw frame plus its
  envelope always fits.
- There is no earlier hook. After the upgrade, Cloudflare delivers WebSocket messages straight to the
  Durable Object; they never pass through the Worker. Platform shedding (`Service overloaded`) of a deep
  inbound queue cannot be prevented in the DO, only made less likely by cheap drops.
- Local (virtual time): 5 MiB/s of 64 KiB frames at the defaults (256 KiB/s, ~1.82 MB burst) closes the
  flooder after 375 ms of input. About 29 frames (≈ the burst) are accepted with full work. Bystander
  frames on the same body all commit, ack and broadcast. Not deployed.
- Still open: per-socket (not per-device) budget; a fresh burst on reconnect. Envelopes and replays are
  now charged, so a reconnect resend backlog above the burst gets a 1013 and is resent later.

## Test-only crash route

`POST /vault/:id/debug/relay-crash` requires:

- `YAOS_TEST_ONLY_DEBUG_ROUTES=true`
- an operator session
- `YAOS_RELAY_BODIES=true` and `YAOS_RELAY_GROUP_COMMIT`

It drops every pending group buffer without committing or acking it, then swaps in a fresh runtime,
the same way `simulate-restart` does. The response is the `simulate-restart` JSON plus
`droppedRelayFrames`.
