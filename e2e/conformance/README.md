# YAOS relay conformance suite

This is a black-box suite for the streams relay. It checks the wire contract (`docs/client-remake/relay-wire.md`) and
the server-remake decisions (D2–D9, H1–H8). It runs against any deployed or local relay over HTTPS and WebSocket only.
It is standalone: plain `node` (≥ 22.18, which strips TS types natively), no npm deps, and no imports from `src/`,
`server/` or `legacy-src/`.

## Running

```sh
node e2e/conformance/run.ts --host https://<worker>.workers.dev --label <label> \
  --operator-context <path/to/client-e2e-context-<host>.json> \
  [--only T-HAPPY,T-RESET] [--skip-slow] [--log-dir <dir>]
```

- **The target must be claimed.** Each run creates fresh vaults through the operator console, named
  `conformance-<label>-<stamp>-<key>`, and enrolls devices. The operator key is read in code from the
  `operatorRecoveryKey` field of `--operator-context`. That file is never written to.
- **The suite never touches vaults it did not create.** Revoke and reset run only on the run's own vaults. The only
  vault delete is T-VAULT-DELETE-CONFIRM's, on its own throwaway vault (`…-delete`).
- **Output:** a summary table on stdout, and `<log dir>/conformance-<label>-<UTC stamp>.json`. The default log dir
  is `experiments/logs`. Every secret seen during the run (operator key, cookie, device tokens, tickets, pairing
  codes) is scrubbed from the output, and assertions check formats without echoing values.
- **Exit code:** 1 if any `baseline` test fails. `decision` failures are expected until the rewrite lands.
- **`--skip-slow`** skips the bandwidth and timing tests: `T-DEDUPE-*` (large and small), `T-RATE-*` and
  `T-MININTERVAL-TIMING`.
- **Table columns:** `exp` is `=` when the status matches what the test expects from today's server (derived from
  reading the code). It is `!X` when today's server was expected to give `X` instead.
- **A decided route that is missing** shows as `FAIL route-missing: ...`. Where a legacy equivalent exists, an
  `INFO` line shows how it behaves.

## Test IDs

### Baseline (must pass before and after the rewrite)

| ID | What |
|---|---|
| T-HAPPY | READY, PROVISIONAL/COMMITTED/NOTICE, no self-broadcast, bulk seq contiguity, ping, feed and read paging, the checkpoint status matrix (200 / 409 conflict / 400 not_advancing / 409 ahead / 404) |
| T-OVERSIZE-1009 | A frame over 1 MiB + 1 KiB → close 1009 |
| T-TWO-SOCKETS | Two sockets for the same device both receive peer broadcasts |
| T-DEDUPE-CONFLICT | The same clientFrameId with different bytes → `VAULT_ERROR dedupe_conflict` |
| T-CKPT-MULTICHUNK | A 2.5 MB checkpoint round-trips byte-identical |
| T-PARTIAL-GC | Checkpoint below lastSeq: the rows above stay readable |
| T-RATE-SOCKET | Bursting past the socket bucket → `VAULT_BACKPRESSURE relay_rate_limit` then 1013; the committed rows form a prefix; resends dedupe to the same seqs |

### Decision and hardening (most are expected to fail before the rewrite)

| ID | Area | Today |
|---|---|---|
| T-ENROLL-200 | D2 | passes (every enroll is 200 with a device token) |
| T-PAIR-FORMAT | D3 | fails (codes are 32 random chars with no `<vaultId>.` prefix) |
| T-PAIR-MALFORMED | D3 | fails (`invalid enrollment request`, not `invalid_code`) |
| T-PAIR-UNKNOWN-VAULT | D3 | fails (404 `unknown_code` for an unknown vault and for an unknown secret) |
| T-PAIR-USED | D3 | passes (409 `used_code`) |
| T-ENROLL-REPLAY, T-ENROLL-CONFLICT | D3 | pass (identical retry → 200; same id, other body → 409 `enrollment_request_conflict`) |
| T-ENROLL-BODY | D3 | fails (legacy `principalId`; `originImport`, `capabilities`, `principal`, `actor` present) |
| T-UNKNOWN-VAULT-401 | §2.2 | passes (the bearer is checked before the vault lookup) |
| T-CONSOLE-ROUTES | D5 | passes |
| T-PROVISION-404 | D5 | fails (200) |
| T-VAULT-DELETE-CONFIRM | D5 | fails (409 `destroy_confirmation_required`; the vault is not deleted) |
| T-TICKET-CROSS-VAULT, T-TICKET-BAD | D4 | pass |
| T-DEVICES-LIST | D5 | fails (route missing; INFO via `/operator/state` and `/vault/:id/devices`) |
| T-LEGACY-404 | D5 | fails (the legacy routes still answer; legacy `DELETE /operator/devices/:id` gives 409 `collaboration_authority_required`) |
| T-READY-SHAPE | D6 | passes |
| T-REVOKE-GATE | D7 | passes (no victim frame sent after the revoke response commits; 3 streaming cycles plus 1 after a 20 s idle). Uses the owner's `DELETE /vault/:id/devices/:id` while the operator route is missing |
| T-REVOKE-SILENCE | D7 | passes (no data reaches the revoked sockets after the response while a peer keeps writing) |
| T-REVOKE-BUFFER | D7 / F17 | fails (frames buffered for group commit at revoke time are committed in the fence turn) |
| T-REVOKE-4403, T-REVOKE-401 | D7 | fail (route missing). The INFO line uses the legacy `DELETE /operator/devices/:id`; it refuses principal devices, so the line falls back to the owner's `DELETE /vault/:id/devices/:id` |
| T-RESET | D8a | fails (route missing; no legacy equivalent). It also probes `/restore` as INFO only |
| T-EPOCH-MISMATCH | D8c | fails (the epoch param is ignored and the checkpoint is applied) |
| T-EPOCH-MATCH, T-EPOCH-ABSENT | D8c | pass |
| T-BLOB-OPAQUE, T-BLOB-KEY-RESET | D9 | skipped while `capabilities.attachments=false` |
| T-BLOB-UNAVAILABLE | D9 | passes (503 `attachments_unavailable`) |
| T-CODEC-UTF8, -SURROGATE, -OVERLONG, -TRAILING | H1 | pass (1008) |
| T-CODEC-NONMINIMAL | H1 | fails (lib0 accepts non-minimal varuints) |
| T-CODEC-VALID | H1 | passes |
| T-DEDUPE-LARGE, T-DEDUPE-SMALL | H2 | fail (the dedupe window is the open segment plus one sealed segment while it has fewer than 64 rows) |
| T-DAILY | H3 | skipped unless the Worker sets `YAOS_TEST_ONLY_DEBUG_ROUTES=true` |
| T-RATE-DEVICE | H6 | fails (buckets are per socket, not per device) |
| T-SOCKET-CAP-DEVICE | H6 | fails (no per-device socket cap) |
| T-RETIRED-GC | H7 | fails (the open segment is never collected, so gcSeq stays 0) |
| T-MININTERVAL-READY, T-MININTERVAL-TIMING | H8 | fail (`minIntervalMs` is 0 and there is no pacing) |

## Known flakiness and limits

- **Upload bandwidth.** `T-RATE-SOCKET`, `T-RATE-DEVICE` and `T-DEDUPE-*` push megabytes. The rate tests can only
  trip the bucket if the uplink can outpace the 256 KiB/s refill. On a slow link `T-RATE-SOCKET` fails with "no
  trip" and the reason says so.
- **Timing.** `T-MININTERVAL-TIMING` measures receipt gaps with a 900 ms threshold. `T-REVOKE-4403` wants the error
  frame and the 4403 close frame each within 1 s of the request; the TCP end is recorded, not judged. Both depend on network latency.
- **Late closes.** On today's Worker, the close frame of a revoke arrives together with the error frame, but the TCP
  connection ends only about 10 s after the vault DO's last event (a peer that keeps writing delays it further). A client
  that never echoes the close keeps its TCP connection for 30 s or more. undici fires `close` only when TCP ends, so
  `closeLatencyMs` measures that end. `closeFrameLatencyMs` (readyState polling) and `lib/rawsocket.ts` measure when the close frame arrives.
  The revoke, reset and socket-cap tests wait up to 15 s for a close.
- **Revoke tests** drive the victim with `lib/rawsocket.ts`, a minimal RFC 6455 client. It can keep sending after the close
  frame (undici drops sends once it has one) and timestamps the close frame and the TCP end separately.
- **Not tested:**
  - `expired_code`: the TTL is 15 minutes.
  - Expired tickets.
  - The 1000-socket vault cap.
  - Restore: D8b is still a proposal and PITR needs a deployed vault, so restore is probed as INFO only.
