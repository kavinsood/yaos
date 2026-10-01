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

- A frame is checked exactly as in v2: authority, envelope, receipt dedupe and rate budget.
- After the check, the frame is broadcast at once and buffered under its (body, epoch).
- The buffer is committed in one `transactionSync` when the first of these happens:
  - `YAOS_RELAY_GC_IDLE_MS` passes with no new frame (default 300)
  - `YAOS_RELAY_GC_MAX_MS` passes after the first frame (default 1500)
  - the buffer reaches `YAOS_RELAY_GC_MAX_BYTES` (default 65536; this flush is synchronous)
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
2. If a device is revoked while its frame is buffered, that frame may already have reached peers. It
   is never made durable and never acked (4403).
3. Tail attribution only covers the last commit: `attr_*` holds the last committer. No per-frame
   `vault_mutation_attribution` rows are written. G14 outcomes come from the receipt ring.
4. Receipts are bounded to 256 per device. An older resend is answered as a CRDT no-op.
5. No silent drops: `updateFrames` = the sum of the v2 outcomes + `groupDropped`. `groupFlushDedupes`
   is a subset of `dedupeHits`. A frame dropped by authority at flush is counted once, in
   `authorityDrops`.
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
   CRDT no-op: it writes no body rows, only its own idempotency receipt.

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

## Test-only crash route

`POST /vault/:id/debug/relay-crash` requires:

- `YAOS_TEST_ONLY_DEBUG_ROUTES=true`
- an operator session
- `YAOS_RELAY_BODIES=true` and `YAOS_RELAY_GROUP_COMMIT`

It drops every pending group buffer without committing or acking it, then swaps in a fresh runtime,
the same way `simulate-restart` does. The response is the `simulate-restart` JSON plus
`droppedRelayFrames`.
