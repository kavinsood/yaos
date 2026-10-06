# YAOS server rewrite: decisions

Status: approved 2026-10-06; implementation under way (section 9). Branch `server-remake`. Wire baseline:
`docs/client-remake/relay-wire.md` ("the contract"). IDs are stable. The review flags F1–F18 are folded into the
decisions; section 8 logs where each one landed.

Budget profile: Cloudflare Workers Free. 100k rows written/day, 5M rows read/day, 100k DO requests/day, 10 ms
CPU, 5 GB DO storage, 2 MB max row. PITR keeps 30 days and does not exist in local dev.

---

## 1. Scope and non-goals (D1)

- **In scope.** One person, many devices: one operator per server, any number of vaults.
- **E2EE.** Single-user E2EE (client-side CryptoPort suite 1) is in scope, so the server stays fully opaque. It
  never interprets payloads, checkpoints, stream names or blob contents.
- **Cloudflare only, fresh deploy.** The core keeps small injected ports (storage, sockets, clock) so tests run it
  on Node. No migration, no dual writes; clients re-seed from disk.
- **Removed (not deferred).** Members, invitations, principals, ownership, governance, device-links, the read-only
  role; shared E2EE vaults; server-side CRDT (semantic sockets, candidates, bootstrap, catch-up, compaction,
  snapshots, recovery jobs); settings sync, relay v2 bodies, bulk create, update-metadata; `packages/server-node`,
  the Docker image and `packages/cli` (already deleted on this branch, §2.3).
- **Size.** Keep about 2.2k lines, write about 3k. Delete about 42.8k in `server/src`, 4.1k in
  `packages/server-node` and 5.3k in `packages/cli`.

---

## 2. Architecture

### 2.1 Responsibilities

| Component | Owns | Never does |
|---|---|---|
| Worker (stateless) | Route table; method/path match; size caps; format checks (vaultId `^[A-Za-z0-9_-]{22}$`, pairing code, blob address, `streamsVersion=1`); body streaming to the DO; unread-body drain in `finally`; R2 I/O for blobs; `claimed=true` cached in isolate memory forever once seen | Crypto; config-DO reads on device routes; storage writes |
| Vault DO (`idFromName(vaultId)`) | `vault_meta` (vaultId, generation = epoch, ticket key); devices; pairing codes; bearer auth; ticket issue and verify; streams store and relay; dedupe index; per-device rate and socket caps; revoke; reset; restore steps; daily-limit latch | Calls to the config DO |
| Config DO (singleton `idFromName("config")`) | Operator credential hash; operator sessions; vault registry (id, name, createdAt); restore journal, steps and alarm (D8b); claim; in-memory login-failure limiter | Being on the hot path. Only `/claim`, `/operator/*` and pre-claim `/api/capabilities` reach it |

Gone: the config→vault authority mirror, the authorization fence, `202 authorization_fence_pending`, the 5 s
actor-authority TTL cache, vault lifecycle states, and the `YAOS_STREAMS` flag (streams are always on).

### 2.2 Route table

Auth: `-` none, `C` operator session cookie, `B` device bearer, `T` streams ticket. Everything not listed → `404
{"error":"not_found"}` with zero DO calls.

| Route | Auth | Worker work | DO(s) |
|---|---|---|---|
| `GET /`, `GET /mobile-setup` | - | static HTML (D5) | none |
| `OPTIONS` on `/api/*`, `/enroll`, `/vault/*` | - | static CORS preflight, 204 | none |
| `GET /api/capabilities` | - | answers from the isolate cache once `claimed` | config, only until `claimed` is seen |
| `POST /claim` | - | key ≥ 32 chars; JSON ≤ 64 KiB; mints vaultId | vault (init), config (claim), vault (owner code); order in D5 |
| `POST /operator/login`, `/operator/logout` | -, C | | config |
| `GET /operator/state` | C | | config (also lists pending restore journal rows) |
| `POST /operator/vaults` | C | mints vaultId; no `/provision` (D5) | vault (init), then config (register) |
| `POST /operator/vaults/:id/owner-code` | C | | config (session, registry), vault |
| `DELETE /operator/vaults/:id` | C | `{"confirmVaultId"}`; R2 prefix purge; order in D5 | config, vault |
| `GET /operator/vaults/:id/devices` | C | | config, vault |
| `DELETE /operator/vaults/:id/devices/:deviceId` | C | | config, vault |
| `POST /operator/vaults/:id/reset-streams` | C | | config, vault |
| `POST /operator/vaults/:id/restore` | C | | config (session, journal, steps), vault |
| `POST /enroll` | code | code regex; vaultId taken from the code | vault |
| `POST /vault/:id/auth/pairing-code` | B | | vault |
| `POST /vault/:id/auth/ticket` | B | | vault |
| `GET /vault/:id/ws/streams` | T | `streamsVersion` check (1008 `update_required`) | vault |
| `GET /vault/:id/streams/feed`, `/streams/read` | B | | vault |
| `PUT /vault/:id/streams/checkpoint` | B | Content-Length ≤ 4 MiB else 413; streams body | vault |
| `PUT`/`GET /vault/:id/blobs/:addr`, `POST /vault/:id/blobs/exists` | B | address regex; ≤ 10 MiB; R2 I/O | vault (bearer check only) |
| `POST /vault/:id/debug/simulate-daily-limit` | B | only when `YAOS_DEBUG_ROUTES=1`, else 404 | vault |

Device routes on an unknown vault answer as for a bad credential: `401 unauthorized` (at upgrade: `unauthorized`
frame + 1008). There is no existence oracle, and it matches revoke and §10's "unauthorized after a delete".
*Test:* T-UNKNOWN-VAULT-401.

### 2.3 Deleted (by subsystem, `wc -l` before deletion)

| Subsystem | Files | Lines |
|---|---|---|
| Semantic document plane | vaultDocumentStore, vaultDocumentCache, vaultSocketService, vaultSemanticService, vaultCandidateService, semanticCompaction*, vaultBootstrapStore, vaultBulkCreateService, vaultLifecycleService, vaultCatalogStore, vaultStore, vaultObjectStore, bootstrap, contracts | 12,415 |
| Recovery | recovery*.ts, vaultRecoveryService | 9,955 |
| Relay v2 spike | relayBodies, relayBodyStore, relayRoutes, relayTail, relayFlag | 3,316 |
| Collaboration/governance | collaboration*, controlPlaneSql, vaultAuthority | 2,744 |
| Legacy config + identity | config, identity (rewritten as the config DO) | 2,449 |
| DO host | server.ts (rewritten as the vault DO) | 2,241 |
| Worker + routes | index.ts, routes/* (rewritten) | 2,636 |
| Shared CRDT/canvas codecs | shared/* except socketLiveness, socketCloseCodes | 2,086 |
| CRDT glue | crdt/* | 1,512 |
| Setup page | setupPage.ts (replaced by the console) | 1,445 |
| Settings sync | settingsSyncStore | 880 |
| Bench/debug | storageBenchmarkWorker, sqlRowCounter, testOnlyTimers | 697 |
| Node host | packages/server-node; Dockerfile, compose.yaml, .dockerignore, tests/docker/smoke.mjs, Docker CI and release jobs | 4,088 |
| Legacy CLI | packages/cli (the schema-6 daemon) | 5,282 |

The Node host and the legacy CLI are already deleted on this branch. The trimmed SQLite adapter that
`streams-relay.ts` and `cfRowModel.ts` need lives in `tests/server/helpers/`. The `server/src` rows go in P1.
*Why:* code excluded from the build rots; git log keeps it if it is ever wanted back.

Kept (about 2.2k): streams/{protocol,relay,store} 1,387; dailyLimit 263; socketLiveness 260; readBoundedBytes
138; base64url 76; setupQr 29; hex 24; version 14; socketCloseCodes 2. `vaultId.ts` is rewritten to the strict
22-char check.

New code (about 3k): Worker router 350, vault DO host 700, config DO 300, strict codec 100, relay deltas
(H2/H3/H5/H6/H7/H8) 400, blobs 120, console 450, WB tests 600. The BB conformance suite is extra.

---

## 3. Decisions D2–D9

**D2 Topology.** As in §2.1. `/api/capabilities` needs only `claimed`, and the Worker caches `true` forever.
*Why:* the config DO was a serial hop on every device request (§15: ticket 107 ms p50 deployed) and the source of
the fence. *Tests:* T-ENROLL-200 (BB), T-HOTPATH (WB: feed, read, checkpoint, ticket, socket, enroll and
pairing-code make zero config-DO calls, checked with a counting stub).

**D3 Pairing codes and enroll.**
- Format `<vaultId>.<secret>`: base64url(16 B) = 22 chars, `.`, base64url(24 B) = 32 chars; 55 in total.
- The Worker trims and checks `^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$`. Malformed → `400 invalid_code`, no DO call.
- The vault DO looks up SHA-256(secret) by PK. An unknown vault and an unknown secret both → `404 invalid_code`;
  an unknown vault costs zero writes and no DDL. Expired → `410 expired_code`; used → `409 used_code` (today's
  statuses).
- **Replay (mandatory).** The code row keeps `used_request_id` and `used_device_id`. The same
  `enrollmentRequestId` + deviceId + token hash on the same code, while that device row still exists → the same
  200 body, 0 rows. `deviceName` is not part of the key (a rename-only retry replays the stored name). The same id
  with another deviceId or token → `409 enrollment_request_conflict`. The device row is gone (revoked) → `409
  used_code`: a replay never resurrects a device. *Why:* if the 200 drops on the network, the client retries;
  without replay it gets `used_code` and the pairing is lost.
- **200 body.** Exactly `host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration`: the fields
  `readEnrollment` reads (`src/host/ui/pairing.ts`). The D6 constants belong to VAULT_READY only.
- TTL 15 min. Purposes: `owner-bootstrap`, `owner-recovery`, `device`. Limiter: in memory, 20 failures/min per
  vault DO → `429 too_many_attempts`.
- The server never sees key material. A future client-only key part must be stripped before `/enroll`.
- *Why:* routing by code removes the config lookup, and 192 bits make brute force moot. *Tests:* T-PAIR-FORMAT,
  T-PAIR-MALFORMED, T-PAIR-UNKNOWN-VAULT, T-PAIR-USED, T-ENROLL-REPLAY, T-ENROLL-CONFLICT, T-ENROLL-BODY (BB),
  T-PAIR-NOWRITE (WB).

**D4 Tickets.**
- Key: 32 random bytes per vault in `vault_meta`, made at init, never exported or rotated. The vault DO issues
  tickets and verifies them at upgrade, with the key and device map in memory.
- Payload as today (vaultId, deviceId, D6 constants, aud, purpose, documentId, iat, exp, nonce), signed with the
  vault key. Wire unchanged: aud `yaos-vault-ws`, purpose `streams`, TTL 5 min (`YAOS_TICKET_TTL_MS`).
- Issuing costs 0 rows (the lastSeen "touch device" write is dropped). Upgrade rejections keep the §3.1 shape
  (accept, `error` frame, close 1008); the DO now produces them.
- The §3.1 `unclaimed` frame is never sent: it would need a config read at upgrade. An unclaimed server has no
  vaults, so the DO answers `unauthorized`.
- *Why:* a key per vault makes cross-vault replay impossible by construction. *Tests:* T-TICKET-CROSS-VAULT,
  T-TICKET-BAD (BB).

**D5 Surviving routes.** Exactly the §2.2 table; everything else → 404.
- Static Worker responses, no DO call: the console (`GET /`), `GET /mobile-setup` (the target of `mobileSetupUrl`
  and the claim QR) and CORS preflight.
- The console is one server-rendered page with inline JS and no external assets. It covers claim, login, the
  vault list, create vault, owner code + QR (`setupQr.ts`), devices + revoke, reset streams behind a typed vaultId
  confirmation, and the D8b "Restore incomplete" banner.
- Operator JSON routes require `Content-Type: application/json` and a same-origin `Origin`. The cookie is
  HttpOnly, Secure, SameSite=Strict, 7 days.
- **Claim:** vault init → config claim (operator, vault and session in one write) → owner code. A failure after
  the claim → 503; the user re-probes, logs in and uses owner-code.
- **Create vault:** no `/provision` (→ 404). Idempotent vault init first, registry row last, so a listed vault is
  always initialized. A failed registration leaves an unreachable 1-row orphan DO (accepted).
- **Delete vault:** `{"confirmVaultId"}`, missing or mismatched → `400 confirmation_mismatch`. Sockets 1001 +
  `deleteAll()`, then the R2 prefix purge (1000 per batch), then the registry row; an incomplete purge → `503
  purge_incomplete`, retryable. Afterwards every device route → 401.
- *Why:* the rest serves only cut subsystems. *Tests:* T-LEGACY-404 (BB: members, invitations, governance,
  device-links, settings-sync, catch-up, bootstrap/start, legacy `DELETE /operator/devices/:id`), T-DEVICES-LIST (BB:
  deviceId, deviceName, no token material), T-CONSOLE-ROUTES, T-PROVISION-404, T-VAULT-DELETE-CONFIRM (BB).

**D6 VAULT_READY constants.**
- `role:"owner"`, `canWrite:true`, `membershipRevision:1`, `deviceCredentialRevision:1`, `policyVersion:1`.
- `principalId` = `owner:<vaultId>`, the same in the enroll response.
- `capabilityDigest` = today's `capabilityDigestForRole("owner")` value, frozen as a literal.
- Every §3.2 field stays; the `write_forbidden` path is removed. *Why:* the shape stays for the shipped client;
  the authority model is gone. *Test:* T-READY-SHAPE.

**D7 Device revoke.** `DELETE /operator/vaults/:id/devices/:deviceId`: operator-only, idempotent, `200 {ok,
deviceId, revoked}`. The gate shuts with the transaction, not with the close handshake.
- **Revoke turn** (one synchronous turn): DELETE the device row and its device-map entry; drop its frames from the
  pending group-commit buffer (they never commit, no receipt); remove its sockets from the fanout set; send each
  `__YPS:{"type":"error","code":"authority_superseded"}` and close 4403.
- **Inbound gate.** The socket attachment carries deviceId. Every `webSocketMessage` first checks the device map
  (rebuilt from SQLite at wake); a miss drops the frame, sends `authority_superseded` and closes 4403.
- **Wake rebuild (added, O3).** H5's rebuild skips, and closes 4403, sockets whose device is not in the map, so a
  revoked socket whose close never completed can't rejoin fanout.
- **Close.** The error and 4403 close frames leave in the revoke turn (legacy: +207 / +211 ms after the request).
  The TCP end follows about 10 s after the DO's last event; that is platform teardown, measured but not judged.
  The new deploy uses a compat date ≥ 2026-04-07 (`web_socket_auto_reply_to_close` on); whether that shortens the
  teardown is unmeasured, and the gate does not depend on it.
- The bearer then gets 401 on every device route, ticket included; the upgrade checks the device map, so an
  unexpired ticket stops working.
- *Why:* one DO, so no TTL cache and no fence. *Tests:* T-REVOKE-GATE, T-REVOKE-SILENCE, T-REVOKE-BUFFER,
  T-REVOKE-4403 (error and close frame each < 1 s; TCP end recorded), T-REVOKE-401.
- *Measured on legacy* (`conformance-scratch3-revoke-20261006T051325Z.json`): 4 cycles, ~5,300 frames sent after
  the revoke response, 0 committed, 0 echoed; the committed frames are always an unbroken prefix of those sent
  before the fence ran. Legacy flushes the 23 buffered frames in the revoke turn (BUFFER fails, as D7 intends to
  change). One cycle showed a 484 ms gap between the cutoff and the error frame, on the safe side (frames in it
  were rejected), cause not found.

**D8 Epoch.** vaultEpoch == vaultGeneration: random base64url(16), minted at vault init. Device credentials are
bound to the vaultId only. *Why:* an epoch means only "the stream space was replaced"; credentials survive it.

**D8a reset-streams.** Request `{"confirmVaultId"}` (missing or mismatched → `400 confirmation_mismatch`) → `200
{vaultEpoch}`.
- One `transactionSync` deletes every row of the 3 stream tables and writes a new generation. Then the pending
  buffer, head cache and dedupe index are discarded and streams sockets close 1001. Devices stay enrolled.
- Cost: one row per stream row (§6.2). A daily-limit hit rolls the transaction back → `503 cf_daily_limit`. P3
  measures DROP+CREATE billing on workerd and uses it if it is cheaper.
- *Test:* T-RESET.

**D8b restore (approved 2026-10-06; operator-only, cold path).** `POST /operator/vaults/:id/restore {"at": ISO8601}` → `200
{vaultEpoch}`. A restore rewinds content, never authority.
- **Why not a temp table:** PITR "appl[ies] to the entire SQLite database contents, including … key-value data"
  and returns storage "to exactly match what the storage contained at the given bookmark". A backup table written
  before the rewind is erased by it.
- **Why a journal outside the vault:** finish must always run. Until it does, the rewound vault serves the old
  device table and the old epoch, and a client still on that epoch skips the reused seqs (§11 step 5, "skipping
  seqs ≤ the stream cursor"): silent divergence. Only finish's new epoch heals it (§11 step 3 drops all cursors).
  The vault cannot detect its own rewind (the restored state is a genuine past state), so the intent lives in the
  config DO, with a config-DO alarm that resumes it.
- **Crosses the rewind:** the device rows only. Not pairing codes (all deleted), the epoch (finish mints a new
  random one, so no collision with a post-T epoch), the ticket key or the daily latch.

The config DO runs the steps (the Worker forwards the request after the session check):

0. INSERT the journal row (§6.3) and set the alarm to now + 30 s. A PK conflict means a restore is pending:
   resume it, ignore this request's `at`, respond with `resumed:true` and the journaled `at`. An `at` that is
   unparseable, in the future or over 30 days old → `400 invalid_restore_point` before any effect; no PITR (local
   dev) → `501 restore_unsupported`.
1. Vault `prepareRestore(restoreId, at)`: an in-memory `restoring` flag with a 60 s TTL (device routes and enroll
   → `503 restore_in_progress` + `Retry-After`; upgrades refused); streams sockets close 1013
   `restore_in_progress`; the buffer is dropped; `vault_meta.pending_restore_id = restoreId`; return `{bookmark:
   getBookmarkForTime(at), devices}`. The config DO stores both in the journal row.
2. Vault `rewind(restoreId, bookmark)`: `last_restore_id == restoreId` → already finished, go to 4. Otherwise
   `onNextSessionRestoreBookmark(bookmark)` and `ctx.abort()` (the RPC throws by design).
3. Vault `finishRestore(restoreId, devices)`:
   - `last_restore_id == restoreId` → no-op, current epoch.
   - `pending_restore_id` still set → the rewind did not happen (a real rewind erases the marker, written after
     T) → back to 2.
   - any write since this runtime booted (commit, checkpoint, enroll, code) → back to 2, so content is exactly T.
   - Else one `transactionSync`: replace the device table, delete all codes, mint a new epoch, set
     `last_restore_id` and `last_restore_at`. Then every streams socket closes 1001.
4. Delete the journal row; `200 {vaultEpoch}` (synchronous: the operator waits a few seconds). A failure before
   this → `503 restore_incomplete`, and the alarm finishes it.

- **Resume** (a second press, or the alarm with platform retries): if the vault still has `pending_restore_id ==
  restoreId` (not rewound), rerun 1 to refresh the snapshot; then always 2 → 3 → 4. Step 2 re-arms the same
  bookmark, which erases anything written while the vault sat rewound.
- **Authority freeze.** While a journal row exists, the config DO refuses that vault's revoke, owner-code and
  reset-streams with `409 restore_in_progress` (operator routes already pass the config DO, so it costs nothing).
  Vault delete wins: it deletes the journal row first. An enroll that lands in the rewound vault is dropped by the
  re-rewind (fail-closed: re-pair).
- **Invariants.** Cold path only: the operator route is the sole entry, and the journal, steps and alarm never touch
  a device path. The vault DO never calls the config DO; no device route gains a hop. Rows: config 3 (insert,
  update, delete); vault 1 (the marker, which the rewind erases) + finish.
- **Residual window.** No crash: one internal RPC between abort and finish; upgrades re-check the device table,
  and a write in the window sends finish back to 2. Crash: at most the alarm delay (≈ 30 s plus retries) of
  rewound content under the old epoch, healed by finish. `GET /operator/state` lists journal rows, so the console
  shows "Restore in progress".
- *Tests:* T-RESTORE-RESUME-WB (fake PITR port; crash between every pair of RPCs; final devices == pre-restore
  devices, no codes, new epoch, content == T, no journal row), T-RESTORE-MANUAL (deployed, by hand).

**D8c epoch param.** Feed, read and checkpoint take an optional `epoch=`.
- The check runs right after bearer auth, before any other validation or effect. Absent → no check.
- Mismatch (empty included) → `409 {"error":"vault_generation_mismatch","vaultEpoch":"<current>"}`.
- *Tests:* T-EPOCH-MISMATCH, T-EPOCH-MATCH, T-EPOCH-ABSENT.

**D9 Blobs (R2 only).**
- Address `^[0-9a-f]{64}$`: format check only, no SHA-256 check. PUT overwrites. Body ≤ 10 MiB
  (`maxBlobUploadBytes`), else 413. `exists` takes ≤ 50 addresses.
- No `YAOS_BUCKET` → `503 attachments_unavailable` and `capabilities.attachments=false`.
- **R2 key `v/<vaultId>/<address>` (mandatory)**, with no generation. Vault delete purges the prefix. *Why:* the
  content address is the identity, so identical bytes are the same blob across resets, restores and epoch bumps.
- *Why opaque:* E2EE addresses are HMAC(vaultKey, hash), which the server cannot check; the client verifies on
  download. *Tests:* T-BLOB-OPAQUE, T-BLOB-KEY-RESET (both SKIP when `attachments=false`), T-BLOB-UNAVAILABLE.

---

## 4. Hardening H1–H8

**H1 Strict codec.** It replaces lib0 `readVarString`/`readVarUint` on the APPEND path. lib0 turns invalid UTF-8
into U+FFFD and accepts non-minimal varuints.
- Strings: `TextDecoder("utf-8", {fatal: true, ignoreBOM: true})` (`ignoreBOM` keeps a leading U+FEFF). Varuints:
  minimal (no trailing `0x00` group) and ≤ 2^53.
- Every length must fit the remaining bytes, and the message must be fully consumed.
- Any violation → close 1008 `malformed_frame`.
- *Why:* two byte strings must never alias one stream name or frame id. *Tests:* T-CODEC-UTF8, T-CODEC-SURROGATE
  (`ED A0 80`), T-CODEC-OVERLONG (`C0 AF`), T-CODEC-NONMINIMAL (`0x82 0x00`), T-CODEC-TRAILING, T-CODEC-VALID
  (`"b:é✓😀"`).

**H2 Dedupe window.** A resend is deduped exactly when its original is among the newest W stored-row bytes of its
stream.
- W ≥ burst + maxPayload + gcMaxBytes = 2 MiB + 1 MiB + 64 KiB ≈ 3.06 MiB. **W = 4 MiB.**
- The pending buffer stays exact and vault-wide.
- *Why:* today's window collapses to the last sealed segment, so after 3×600 KiB every frame but the last is
  re-appended on resend.

Index:
- **Shape.** One lazy index per stream: `Map<hash53(deviceId 0x00 clientFrameId) → seq>`, plus a ring of
  (hash, rowBytes) to trim entries older than W.
- **Build.** On the first append to a stream in a runtime, one bounded scan: the head (usually cached), then
  `SELECT bytes FROM stream_segment WHERE stream=? ORDER BY first_seq DESC LIMIT 64`, stopping at ≥ W. It parses
  only key bytes and skips payloads by length.
- **Maintenance.** Each commit adds its rows. **Hit.** Load the row (open: 0 rows; sealed: 1) and compare bytes.
  Equal → `deduped:true` with the original seq; different → `client_frame_id_conflict` with seq. A collision on
  another key is not a hit.
- **GC'd originals.** An entry with `seq ≤ gcSeq` can't be byte-compared: answer `deduped:true` with the original
  seq; the checkpoint covers it.
- **Rows read, worst case.** Every sealed segment is ≥ 64 KiB (an end-of-commit seal needs ≥ 64 KiB, a mid-commit
  seal > 1.5 MB − 1 MiB). So one scan reads ≤ 64 segments + 1 head = **65 rows** (≤ W + 1.5 MB), once per stream
  per runtime, or once per eviction under the memory cap.
  The 5M budget allows ≈ 76.9k cold scans/day; a realistic load (200 wakes × 10 hot streams) is ≈ 130k rows/day (2.6%).
- **CPU.** 200k tiny rows can exceed 10 ms. Parse keys only; P3 measures the cold scan. If it is still over,
  chunk the scan and gate that stream's commits on it.
- **Memory bound.** The minimum row is 21 B (seq 1, deviceId 1+16, cfid 1+1, len 1), so one stream holds
  ≤ 199,728 entries, about 12 MB at about 60 B/entry (typical 250 B rows: ≤ 17k entries, about 1 MB). DO-wide cap:
  262,144 entries (about 16 MB), by LRU eviction of whole streams; an evicted stream rescans (≤ 65 rows).
- Update §5.4 (section 5). *Tests:* T-DEDUPE-LARGE (3×600 KiB), T-DEDUPE-SMALL (400×4 KiB), T-DEDUPE-CONFLICT,
  T-DEDUPE-COLD-WB.

**H3 Commit-failure typing.** The relay classifies its own commit errors; the `decorateControl` rewrite goes.
- Daily limit → `VAULT_ERROR cf_daily_limit {cause:"durability_failed", kind, resetAt, message, stream,
  clientFrameIds}`.
- Anything else → `durability_failed` plus an additive `retryAfterMs = round(min(30000, 1000·2^(n−1)) ·
  (0.5 + 0.5·rand))`, where n counts consecutive failed commits in the runtime and resets on success.
- The checkpoint, feed and read handlers map daily-limit errors to `503 cf_daily_limit` themselves.
- *Why:* errors are typed at the source, so there is no latch race. *Tests:* T-COMMIT-DAILY-WB, T-COMMIT-RETRY-WB (WB,
  new IDs), T-DAILY (BB, via `POST /vault/:id/debug/simulate-daily-limit`, only with `YAOS_DEBUG_ROUTES=1`).

**H4 Authority before write_forbidden.** Resolved by design: no roles, `canWrite` always true, and the D7 gate
shuts in the revoke turn. *Tests:* covered by T-REVOKE-GATE and T-READY-SHAPE.

**H5 Socket cache.** A `Map<WebSocket, Attachment>` with per-device lists, each attachment parsed once per socket
per runtime; maintained on accept, close and error, rebuilt from `ctx.getWebSockets()` after a wake (skipping
revoked devices, D7). *Why:* today `streamSockets()` walks every socket on every call. *Test:* T-SOCKET-CACHE-WB
(WB, new ID).

**H6 Per-device limits.**
- One in-memory token bucket per deviceId (256 KiB/s, 2 MiB burst, full after a wake), shared by its sockets. An
  overdraft closes the overdrawing socket (BACKPRESSURE, 1013).
- Cap of 4 sockets per device: a 5th connect closes that device's oldest socket with 1001 `device_socket_limit`,
  then accepts. This runs before the vault-wide check, so a device at its cap can always reconnect.
- Five live clients on one device would evict each other forever, so the client backs off ≥ 30 s on
  `device_socket_limit`.
- The vault-wide cap of 1000 (`429 stream_socket_limit`, `Retry-After: 1`) stays.
- *Why:* the limit must bind the writer, not the socket. Ghost sockets after a network switch are the usual 5th.
  *Tests:* T-RATE-DEVICE, T-RATE-SOCKET, T-SOCKET-CAP-DEVICE.

**H7 Retired-stream GC.**
- When `coversSeq == lastSeq`, the head UPDATE also sets `open=NULL, open_rows=0, tail_first=NULL, gc_seq=lastSeq`.
  Sealed segments are all ≤ N and deleted as today; the head row stays. Cost: still 1 row (no indexed column in SET).
- Client note: sealed segments of a retired stream are only collected if the client writes a final checkpoint.
- Update §8. *Tests:* T-RETIRED-GC, T-PARTIAL-GC.

**H8 minIntervalMs.**
- Default 1000 (`YAOS_STREAMS_GC_MIN_INTERVAL_MS` still overrides), echoed in `VAULT_READY.limits.groupCommit`.
- The idle flush waits `max(idleMs, lastCommitAt + 1000 − now)`; the max (1500 ms) and bytes (64 KiB) triggers stay.
- Small writes: ≤ 1 commit/s/vault, about 2–4 rows/s while typing, so 100k rows ≈ 7–14 h of continuous editing.
- Large writes are not bounded: the 64 KiB trigger still commits back to back (≤ 4/s/device at the rate gate).
  Accepted, and stated in §11.5.
- *Tests:* T-MININTERVAL-READY, T-MININTERVAL-TIMING (≥ ~900 ms between back-to-back commits).

**BASELINE** (unchanged behaviour, must stay green): T-OVERSIZE-1009, T-CKPT-MULTICHUNK (2.5 MB), T-TWO-SOCKETS,
T-HAPPY.

---

## 5. Contract delta against relay-wire.md

Classes: **additive** (new; old clients unaffected), **relaxation** (the server accepts or promises more),
**tightening** (it accepts or promises less), **removal** (gone).

| § | Old → new | Class | Client action |
|---|---|---|---|
| 2.1 | Capabilities: keep `claimed`, `streams:1`, `attachments`, `maxBlobUploadBytes`, `serverVersion`. Drop `schemaVersion`, `protocolVersion`, `snapshots`, `recoveryJobs`, `settingsSync`, `semanticCanvas`, `bulkCreate`, `relayBodies`, `storageFormatVersion`, `snapshotFormatVersion`, `settingsFormatVersion`, `update*` | removal | none (pairing.ts reads only the kept five) |
| 2.2 | Claim body/response unchanged; already claimed → `409 already_claimed` | none | none |
| 2.3 | + `GET …/devices`, `DELETE …/devices/:deviceId`, `POST …/reset-streams`, `POST …/restore`; `/provision` → 404; `DELETE /operator/vaults/:id` takes `{"confirmVaultId"}` (D5) | additive / removal | none |
| 2.4 | Pairing code: "8–512 printable" → `^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$` after trim; malformed → `400 invalid_code`; unknown → `404 invalid_code` (was `unknown_code`) | tightening | none: `enrollHttpError` maps both codes; strip any client-only key part |
| 2.4 | Same `enrollmentRequestId` + deviceId + token hash → replay 200; same id, other body → `409 enrollment_request_conflict` (D3) | additive | none (pairing.ts already re-sends the identical body) |
| 2.4 | `202 authorization_fence_pending` → never sent | removal | none (the retry loop becomes dead code) |
| 2.4 | 200 body: exactly `host, deviceToken, vaultId, deviceId, deviceName, vaultGeneration` (D3) | removal | none |
| 2.5 | Pairing-code response `{pairingCode, expiresAt, purpose, obsidianUrl, mobileSetupUrl?}`; purpose `device` only (absent = device; else `400 invalid_purpose`) | tightening | none |
| 2.6 | Ticket wire unchanged; issued by the vault DO | none | none |
| 2.7 | Removed: `403 capability_denied`, `409 vault_<state>`, `503 vault_draining`; `404 unknown_vault` → `401 unauthorized` (§2.2). `409 vault_generation_mismatch` gains `vaultEpoch`. + D8b: `503 restore_in_progress` with `Retry-After`, `409 restore_in_progress`, `503 restore_incomplete`, `400 invalid_restore_point`, `501 restore_unsupported` | removal / additive | none |
| 3.1 | `unclaimed` frame never sent (D4); DO-level `409 authority_superseded` and `403` at upgrade removed; `unauthorized` and `update_required` frames unchanged; 429 stays | removal | treat as `unauthorized` (already mapped) |
| 3.2 | `canWrite` always true; D6 constants; the `write_forbidden` note is removed; `groupCommit.minIntervalMs` 0 → 1000 | removal / tightening | read `limits`; set receipt timeouts ≥ maxMs + RTT |
| 4.3 | `STREAM_APPEND_REJECTED write_forbidden` removed. `VAULT_ERROR durability_failed` + `retryAfterMs` (ms, number) | removal / additive | when present, wait `retryAfterMs` before resending |
| 5.1 | Idle flush deferred to `lastCommitAt + minIntervalMs` | tightening | none |
| 5.4 | Dedupe scope (text below) | relaxation | none |
| 6, 7, 8 | Optional `epoch=<vaultEpoch>`; mismatch or empty → `409 {"error":"vault_generation_mismatch","vaultEpoch"}` before any effect | additive | send it; on 409 switch to the returned epoch (new local DB) |
| 8 | GC text (below) | tightening | write a final checkpoint at `lastSeq` to retire a stream |
| 10 | 1001 also means "replaced by a newer socket of the same device" (reason `device_socket_limit`); 4403 only on revoke; + 1013 `restore_in_progress` (D8b) | additive | back off ≥ 30 s on `device_socket_limit` |
| 11.1 | Rate gate per socket → per device; + "Streams sockets per device: 4, a 5th evicts the oldest (1001 `device_socket_limit`)"; group commit row gains "1000 ms min interval" | tightening | one socket per vault per device |
| 11.2 | Permissions table and the 5 s authority cache removed; revoke shuts the gate at once (D7) | removal | none |
| 11.3 | `<sha256 hex>` → `<64 lowercase hex address>`; no hash check; `400 hash mismatch` removed; PUT overwrites; capability names gone | relaxation / removal | verify downloads client-side |
| 11.4 | Unchanged; the simulate route exists only with `YAOS_DEBUG_ROUTES=1` | none | none |
| 11.5 | + three identity tables; enroll 2 rows, revoke 1, ticket 0; + "the 64 KiB trigger still commits back to back" (H8) | additive | none |
| 13 | `YAOS_STREAMS` flag gone; the Node/Docker host gone | removal | none |
| 14 | Everything listed → 404, including "Still used": `me`, `members`, `devices` (vault-level), `invitations`, `device-links`, `principals/*`, `ownership/*`, `governance` | removal | none (`src/` calls none of them) |
| 15 | HTTP routes no longer pay a config-DO hop; receipt p50 rises toward 1 s for back-to-back commits | informational | none |
| 16 | `role` type stays `"owner" \| "member"`; only `"owner"` is sent | none | none |

New §5.4 "Dedupe scope":

> Duplicates are detected in the pending buffer (vault-wide by `(deviceId, clientFrameId)`, comparing stream and
> bytes) and against every committed row among the newest 4 MiB (stored row bytes) of the stream. Outside that
> window a resend is appended again with a new seq. The window covers more than one burst plus one max payload
> plus one commit batch, so every resend this section requires is deduped.

New §8 "What survives":

> When `N < lastSeq`, the open segment (the newest rows, under 64 KiB) survives, so readers just behind the
> checkpoint can still replay rows. When `N == lastSeq`, the open segment is dropped too and `gcSeq = lastSeq`.
> The stream keeps only its head and the checkpoint, and every read below `gcSeq` returns the checkpoint. Sealed
> segments are only collected by a checkpoint, so a retired stream needs a final checkpoint at `lastSeq`.

---

## 6. Storage

### 6.1 Vault DO schema

The DDL runs once, at vault init, and never on a request path (T-PAIR-NOWRITE). The three stream tables are
unchanged from `streams/store.ts`:

- `stream_head(stream PK, last_seq, ckpt_seq, gc_seq, tail_first, open_rows, open BLOB) WITHOUT ROWID` + index
  `stream_head_last_seq(last_seq)`;
- `stream_segment(stream, first_seq, last_seq, rows, bytes, PK(stream, first_seq)) WITHOUT ROWID`;
- `stream_checkpoint(stream, chunk, covers_seq, bytes, PK(stream, chunk)) WITHOUT ROWID`.

New:

```sql
CREATE TABLE vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  vault_id TEXT NOT NULL, vault_generation TEXT NOT NULL,
  ticket_key BLOB NOT NULL,            -- 32 random bytes, never leaves the DO
  created_at INTEGER NOT NULL,
  pending_restore_id TEXT,             -- D8b: set by prepare, erased by a real rewind
  last_restore_id TEXT,                -- D8b: step 2 skip, finish idempotency
  last_restore_at INTEGER
) WITHOUT ROWID;
CREATE TABLE device (
  token_hash BLOB PRIMARY KEY,         -- SHA-256(deviceToken)
  device_id TEXT NOT NULL, device_name TEXT NOT NULL,
  enrollment_request_id TEXT NOT NULL, enrolled_at INTEGER NOT NULL
) WITHOUT ROWID;                       -- no secondary index: revoke scans (a few rows)
CREATE TABLE pairing_code (
  code_hash BLOB PRIMARY KEY,          -- SHA-256(secret)
  purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
  used_request_id TEXT, used_device_id TEXT   -- D3 replay key
) WITHOUT ROWID;
```

Probing an unknown vault reads `vault_meta`; "no such table" means unknown, cached in memory (init runs in the same
object, so the cache stays coherent). Rows read per runtime: meta 1 + devices N, then 0 per bearer auth. deviceId
uniqueness is checked in code in the same synchronous turn. Minting a code prunes rows expired over 24 h.

### 6.2 Rows written per operation (cfRowModel rules)

| Operation | Statements | CF rows |
|---|---|---|
| Vault init | INSERT meta (DDL not billed by the model; one-time) | 1 |
| Enroll | UPDATE pairing_code (used_*) + INSERT device | 2 |
| Enroll replay (D3) | none | 0 |
| Pairing / owner code | INSERT pairing_code (+1 per pruned row) | 1 |
| Ticket | none (key and devices in memory) | 0 |
| Revoke | DELETE device | 1 |
| Reset | DELETE H heads + S segments + C chunks; UPDATE meta | H+S+C+1 |
| Restore prepare (D8b) | UPDATE meta (marker; the rewind erases it) | 1 |
| Restore finish (D8b) | replace D device rows; DELETE P codes; UPDATE meta | ≈ D+P+1 |
| Commit | per touched stream: head UPDATE/INSERT (last_seq indexed) = 2; +1 per sealed segment | 2/stream + 1/seal |
| Checkpoint | DELETE old chunks (k₀) + INSERT new chunks (k₁) + DELETE collected segments (g) + UPDATE head (SET has no `last_seq`) | k₀+k₁+g+1 |
| Retired GC (H7) | same head UPDATE | +0 |
| Dedupe index (H2) | memory only | 0 |

### 6.3 Config DO schema

```sql
CREATE TABLE operator (id INTEGER PRIMARY KEY CHECK (id = 1),
  key_hash BLOB NOT NULL, claimed_at INTEGER NOT NULL) WITHOUT ROWID;   -- SHA-256(recovery key ≥ 32 chars)
CREATE TABLE session (token_hash BLOB PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE vault (vault_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE restore_journal (vault_id TEXT PRIMARY KEY, restore_id TEXT NOT NULL, at INTEGER NOT NULL,
  bookmark TEXT, devices BLOB,                                          -- set after prepare; token hashes only
  created_at INTEGER NOT NULL) WITHOUT ROWID;                           -- D8b; alarm while rows exist
```

`claimed` = the operator row exists. Rows written: claim 3 here (operator, vault, session) + 2 in the vault DO
(meta, code); login 1 (+1 per pruned session); logout 1; create vault 1 + 1 in the vault DO; delete vault 1 + the
vault DO's `deleteAll()` (not measured); restore 3 (insert, update, delete).

---

## 7. Acceptance matrix

"scratch-3" is today's `yaos-relay2-scratch-3` (legacy server, `YAOS_STREAMS=true`, no R2). BB results are
measured: `experiments/logs/conformance-scratch3-baseline-20261005T215906Z.json` and
`conformance-scratch3-flags-20261006T050159Z.json`; the revoke rows from `conformance-scratch3-revoke-20261006T051325Z.json`. `*` marks a
WB test: it never runs against scratch-3, so the entry is a guess at today's code. BB files live in
`e2e/conformance/tests/`, WB files in `tests/server/` (WB file names are suggestions).

| ID | What | Kind | scratch-3 | Where |
|---|---|---|---|---|
| T-HAPPY | enroll 2 devices, append b:/ns, receipts, provisional/committed, feed, read, checkpoint | BB | PASS | happy.ts |
| T-TWO-SOCKETS | two devices see each other's frames live | BB | PASS | socket.ts |
| T-OVERSIZE-1009 | binary > 1 MiB + 1 KiB closes 1009 | BB | PASS | socket.ts |
| T-CKPT-MULTICHUNK | 2.5 MB checkpoint round-trips (3 chunks) | BB | PASS | checkpoint.ts |
| T-ENROLL-200 | first enroll is 200 with the §2.4 fields, never 202 | BB | PASS | onboarding.ts |
| T-HOTPATH | zero config-DO calls on the 7 device paths | WB | FAIL* | hotpath.ts |
| T-PAIR-FORMAT | minted codes match the D3 regex, prefix = vaultId | BB | FAIL | onboarding.ts |
| T-PAIR-MALFORMED | malformed code → 400 invalid_code | BB | FAIL | onboarding.ts |
| T-PAIR-UNKNOWN-VAULT | unknown vault, and unknown secret on a known vault → 404 invalid_code | BB | FAIL (404 unknown_code) | onboarding.ts |
| T-PAIR-USED | second use → 409 used_code | BB | PASS | onboarding.ts |
| T-PAIR-NOWRITE | unknown vault: 0 rows written, no DDL | WB | FAIL* | pairing.ts |
| T-ENROLL-REPLAY | identical retry → 200, same deviceId, vaultId, generation; token works | BB | PASS | flags.ts |
| T-ENROLL-CONFLICT | same id, other deviceId or token → 409 enrollment_request_conflict; original token works, other 401 | BB | PASS | flags.ts |
| T-ENROLL-BODY | exactly the six client fields | BB | FAIL (legacy principalId, extra fields) | flags.ts |
| T-TICKET-CROSS-VAULT | vault A ticket on vault B → 1008 unauthorized | BB | PASS | onboarding.ts |
| T-TICKET-BAD | tampered, garbage or missing ticket → 1008 unauthorized | BB | PASS | onboarding.ts |
| T-UNKNOWN-VAULT-401 | valid bearer on an unknown vault → 401 on ticket, pairing-code, feed, read, checkpoint | BB | PASS | flags.ts |
| T-LEGACY-404 | the D5 legacy list → 404 | BB | FAIL | operator.ts |
| T-CONSOLE-ROUTES | `GET /`, `GET /mobile-setup` → 200 HTML; CORS preflight not 404 | BB | PASS | flags.ts |
| T-PROVISION-404 | `POST …/provision` → 404 | BB | FAIL (200) | flags.ts |
| T-VAULT-DELETE-CONFIRM | missing or wrong confirmVaultId → 400; match → 200, sockets 1001, bearer 401 | BB | FAIL (409 destroy_confirmation_required) | flags.ts |
| T-DEVICES-LIST | deviceId and deviceName, no token material | BB | FAIL (404) | operator.ts |
| T-READY-SHAPE | D6 constants, every §3.2 field | BB | PASS | socket.ts |
| T-REVOKE-GATE | no frame the revoked socket sends after the revoke response commits (incl. after idle) | BB | PASS | revoke.ts |
| T-REVOKE-SILENCE | the revoked socket gets no data-bearing message after the revoke response | BB | PASS | revoke.ts |
| T-REVOKE-BUFFER | frames buffered for group commit at revoke never commit, no receipt | BB | FAIL (23/23 committed) | revoke.ts |
| T-REVOKE-4403 | error frame and close frame 4403 each < 1 s; TCP end recorded | BB | FAIL (route; legacy owner route: 207 / 211 ms) | operator.ts |
| T-REVOKE-401 | revoked bearer → 401 on ticket, feed, read, pairing-code | BB | FAIL (route; legacy: all 401) | operator.ts |
| T-RESET | new epoch, empty streams, 1001 closes, devices kept | BB | FAIL | operator.ts |
| T-RESTORE-RESUME-WB | fake PITR port, crash after each step; resume ends with snapshot devices, no codes, new epoch, no journal row | WB | FAIL* | restore.ts |
| T-RESTORE-MANUAL | restore to T: content rewound, devices as of the request, codes gone, epoch rotates (deployed only) | manual | n/a | manual |
| T-EPOCH-MISMATCH | wrong or empty epoch → 409 + vaultEpoch, no effect | BB | FAIL | checkpoint.ts |
| T-EPOCH-MATCH | matching epoch → normal | BB | PASS | checkpoint.ts |
| T-EPOCH-ABSENT | no param → normal | BB | PASS | checkpoint.ts |
| T-BLOB-OPAQUE | non-SHA 64-hex address PUT/GET/exists, overwrite | BB | SKIP (no R2) | misc.ts |
| T-BLOB-KEY-RESET | a blob survives reset-streams byte-identical and in `exists` | BB | SKIP (no R2) | flags.ts |
| T-BLOB-UNAVAILABLE | 503 attachments_unavailable, attachments=false | BB | PASS | misc.ts |
| T-CODEC-UTF8 | invalid UTF-8 → 1008 | BB | PASS | socket.ts |
| T-CODEC-SURROGATE | `ED A0 80` → 1008 | BB | PASS | socket.ts |
| T-CODEC-OVERLONG | `C0 AF` → 1008 | BB | PASS | socket.ts |
| T-CODEC-NONMINIMAL | `0x82 0x00` → 1008 | BB | FAIL | socket.ts |
| T-CODEC-TRAILING | trailing byte → 1008 | BB | PASS | socket.ts |
| T-CODEC-VALID | `"b:é✓😀"` accepted | BB | PASS | socket.ts |
| T-DEDUPE-LARGE | 3×600 KiB, reconnect, resend → deduped, original seqs | BB | FAIL | commit.ts |
| T-DEDUPE-SMALL | 400×4 KiB resend → deduped | BB | FAIL | commit.ts |
| T-DEDUPE-CONFLICT | same id, other bytes → client_frame_id_conflict + seq | BB | PASS | socket.ts |
| T-DEDUPE-COLD-WB | the same after a runtime restart; ≤ 65 rows read | WB | FAIL* | dedupe.ts |
| T-DAILY | simulated limit → VAULT_ERROR cf_daily_limit; checkpoint 503 | BB | SKIP (no `YAOS_DEBUG_ROUTES`) | misc.ts |
| T-COMMIT-DAILY-WB | the relay types the daily limit itself | WB | PASS* (same wire) | relay-commit.ts |
| T-COMMIT-RETRY-WB | durability_failed + retryAfterMs, backoff, reset | WB | FAIL* | relay-commit.ts |
| T-SOCKET-CACHE-WB | attachment parsed once per socket per runtime; wake rebuild skips revoked devices | WB | FAIL* | socket-cache.ts |
| T-RATE-DEVICE | two sockets of one device share one bucket → 1013 | BB | FAIL | commit.ts |
| T-RATE-SOCKET | one socket overdraft → BACKPRESSURE + 1013 | BB | PASS | commit.ts |
| T-SOCKET-CAP-DEVICE | 5th socket evicts the oldest with 1001 | BB | FAIL | commit.ts |
| T-RETIRED-GC | ckpt at lastSeq → gcSeq=lastSeq, read = checkpoint only | BB | FAIL | checkpoint.ts |
| T-PARTIAL-GC | ckpt below lastSeq → open survives | BB | PASS | checkpoint.ts |
| T-MININTERVAL-READY | VAULT_READY minIntervalMs 1000 | BB | FAIL | socket.ts |
| T-MININTERVAL-TIMING | back-to-back commits ≥ ~900 ms apart | BB | FAIL | socket.ts |
| T-ROWS-WB | every §6.2 row count under cfRowModel | WB | n/a | rows.ts |

---

## 8. Flag log and open items

Review flags:

- F1 → accepted (mandatory), now in D3.
- F2 → accepted, now in D3.
- F3 → accepted (mandatory), now in D9.
- F4 → accepted, now in D4.
- F5 → accepted, now in §2.2 and D5.
- F6 → accepted, now in D5.
- F7 → accepted, now in D5.
- F8 → accepted, now in D5.
- F9 → replaced by the new D8b design (approved 2026-10-06).
- F10 → accepted, now in D3.
- F11 → accepted, now in §2.2.
- F12 → accepted, now in H2.
- F13 → accepted, now in H6.
- F14 → accepted, now in H8.
- F15 → decided and done on this branch, now in §2.3.
- F16 → accepted, now in D8a.
- F17 → flipped (buffered frames of a revoked device are dropped), now in D7.
- F18 → accepted, now in H2.

Raised during the fold, now resolved:

- O1 D3 replay scope → key = code + `enrollmentRequestId` + deviceId + token hash; `deviceName` ignored; a revoked
  device → `409 used_code`. Now in D3.
- O2 D3 enroll body → exactly the six fields `readEnrollment` reads; no D6 constants. Now in D3.
- O3 D7 wake rebuild → kept: H5's rebuild skips and closes 4403 sockets whose device is gone.
- O4–O8 D8b gaps (authority drift, stuck flag, writes in the window, concurrent restores, loose ends) → the D8b
  rewrite: config-DO-run steps, alarm resume, `pending_restore_id` marker, re-rewind on writes, authority freeze,
  flag TTL, PK reservation, synchronous 200, error codes.

## 9. Work plan

| Phase | Work | Exit criterion |
|---|---|---|
| P0 Conformance baseline | BB suite in `e2e/conformance/` for every BB row of section 7; run against scratch-3 and local `wrangler dev` | The suite runs end to end; scratch-3 results recorded, with every difference from the section 7 guesses explained |
| P1 Host skeleton | New Worker router, vault DO and config DO classes; streams core behind ports; legacy `server/src` deleted; README "Cloudflare only". The Node host, Docker and `packages/cli` are already gone on this branch, with the harness adapter in `tests/server/helpers/` | Ported streams WB tests green; T-LEGACY-404 and T-HOTPATH harness in place; `tsc`/lint clean |
| P2 Identity | Claim, login and sessions, vaults, owner code, D3 codes, enroll (replay, D3), D4 tickets, devices list and revoke (D7 gate) | D2–D7 BB + BASELINE green on local dev; T-PAIR-NOWRITE, T-HOTPATH, T-ROWS-WB (identity rows) green |
| P3 Hardening | H1–H8, D8a/D8c, D9 (`v/<vaultId>/<address>` keys); D8b | Every BB row except T-RESTORE-MANUAL green locally (blob rows with local R2); all WB green; H2 cold-scan CPU and D8a DROP+CREATE billing measured |
| P4 Console | `GET /` page and `GET /mobile-setup` (D5) | Manual run on local dev: claim → vault → QR → enroll → revoke → reset; no external assets |
| P5 Deploy over scratch-3 | The coordinator deploys: one migration that deletes the old DO classes and adds the two new ones (the account is at the namespace cap) | The full suite is green on scratch-3 except the documented SKIPs; T-RESTORE-MANUAL done once by hand; §15 latencies re-measured |
