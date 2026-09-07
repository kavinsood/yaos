# Currentness plane implementation and deployed validation

**Date:** 2026-09-07
**Status:** implemented and validated on disposable Cloudflare Workers.
**Protocol decision:** retain independent body sockets; ship the additive
protocol-2 currentness plane and conditional reconciliation path.

## Delivered program

All six phases from the investigation are implemented.

### Phase 0 — evidence and lifetime safety

- Editor admission retains 256 redacted samples with tier, queue delay, local
  load, currentness proof, state fetch, provider admission, provider sync,
  projection, CM6 bind, socket count, body-size bucket, HTTP fallback, outcome,
  and bounded failure class. It records no path, body identity, URL, ticket,
  content, or request identity.
- Every body provider owns a coordinator lease for its complete session
  lifetime.
- Replacement marks the old body evicting before asynchronous preparation,
  blocks new projections, and rechecks identity, revision, dirty work, pins,
  and leases immediately before swap.
- Scheduled ticket refresh is no longer misclassified as pending publication;
  the headless product can become ready while future maintenance remains
  durably scheduled.

### Phase 1 — immediate active-session admission

- A second consumer of the exact current body session acquires its independent
  projection lease and pin immediately.
- The path performs no HEAD, body read, provider creation, or provider sync.
- Consumer generations and exact session/document identity still fence
  publication.

### Phase 2 — truthful commit envelopes

- One flush captures and merges queued Yjs updates with `Y.mergeUpdates()`.
- Metadata is derived from the durable reconstruction plus only that merged
  update, never from the asynchronously changing live cache.
- One atomic generation produces one catalog head, vault sequence, journal
  entry, and exact `BODY_COMMITTED` envelope.
- Updates arriving during metadata work remain queued and schedule the next
  flush.

### Phase 3 — body-socket durable watermarks

- READY establishes one immutable socket session per provider; the runtime
  epoch remains session metadata for commit-envelope validation.
- Body-socket commit envelopes are fenced by body, vault generation, the
  established socket session, initial sync, and body revision.
- Exact generation promotion requires matching canonical hash and size.
- A mutable or mismatching document retains the target and falls back to
  ordinary replay instead of overstating durable evidence.

### Phase 4 — currentness queries

- READY advertises version-2 `currentnessQuery` and `committedHead`
  capabilities plus the immutable socket-session identity. Version-1 peers
  decline the capability and retain the HTTP fallback during rolling upgrades.
- Body sockets accept only an exact self query. Root sockets accept one to 100
  unique body IDs.
- Query results contain lifecycle, generation, hash, size, one immutable
  socket-session identity, vault sequence, and explicit missing identities.
- Client waiters retain only that session, their query identity, and exact
  requested identity set. Invalid responses and session replacement fail fast.
- Simultaneous root requests microbatch to 100 bodies; absent capabilities,
  timeout, disconnect, or malformed authority use the existing HTTP path.

### Phase 5 — conditional batched reconciliation

- The shared Bootstrap client used by Obsidian and the CLI now consumes
  `/catch-up` in batches.
- Requests carry known generation and hash. Unchanged bodies return metadata
  with status 304 and no Yjs state.
- A 413 splits adaptively until a bounded request succeeds or one body remains.
- Body-only feed pages skip root settlement; structural pages retain it.
- Already-proven heads flow into body settlement instead of causing another
  HEAD, and the duplicate outer catalog HEAD was removed.
- The server yields every four reconstructed stale bodies. This preserves live
  body propagation while a maximum 100-body state response is built.

### Phase 6 — validation and profiling

- Deterministic client/server tests cover active reuse, warm socket queries,
  root query authority, exact watermark promotion, conditional batch parsing,
  body-only settlement, adaptive lifetime fences, and replacement races.
- The complete regression, Worker integration, Node runtime, conformance, CLI,
  and headless product gates were run.
- Two disposable Workers were deployed through public HTTPS/WSS at the `MAA`
  edge behind an exact-host Cloudflare Access Service Auth policy. Unmatched
  requests returned 403. Each run created two devices and 100 4-KiB bodies,
  then destroyed its vault and generation-scoped data.
- Raw ignored evidence is retained under `qa-runs/currentness/`.

## Deployed results

The final run used deployment `f1793d00-168b-495c-b31d-f9d424292f61`.
Values are milliseconds unless stated otherwise.

| Comparison | HTTP/baseline p50 | Currentness p50 | Result |
| --- | ---: | ---: | ---: |
| body HEAD vs body self query | 217.81 | 48.97 | 77.5% faster |
| one parallel HEAD vs root width 1 | 219.51 | 48.42 | 77.9% faster |
| 100 parallel HEADs vs root width 100 | 559.14 | 54.63 | 90.2% faster |

The root query stayed nearly flat from one through 100 bodies. Width 100 used
one 15,616-byte control response instead of 100 authenticated requests. Its
p95 was 59.81 ms versus 642.10 ms for the 100-request comparison.

| Conditional `/catch-up` width | Stale p50 | Stale bytes | Unchanged p50 | Unchanged bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 244.80 | 5,761 | 211.70 | 263 |
| 7 | 223.08 | 40,159 | 209.77 | 1,673 |
| 24 | 311.42 | 137,620 | 246.67 | 5,668 |
| 100 | 554.48 | 573,320 | 255.11 | 23,528 |

At width 100, exact unchanged metadata reduced response bytes by 95.9% and
latency by 54.0%. A stale state batch remains intentionally proportional to
returned state bytes.

Rapid live bursts of 1, 10, and 100 Yjs updates each produced exactly:

- one document-generation increment;
- one vault-sequence increment;
- one inferred journal row;
- one `BODY_COMMITTED` notification.

This validates merge-per-flush compaction at the deployed Durable Object, not
only in a local test double.

## Live propagation under reconciliation

The first deployed run exposed synchronous 100-body reconstruction as a real
contention problem: seven-socket propagation rose from 48.56 ms p50 and
50.58 ms p95 to 62.04 ms p50 and 66.12 ms p95. That violated the 10% success
criterion.

After adding bounded server yields, the second deployed run measured:

| Active device-B bodies | Separate baseline p50/p95 | During stale 100-body catch-up p50/p95 |
| ---: | ---: | ---: |
| 1 | 52.20 / 58.11 | 49.27 / 51.19 |
| 7 | 49.28 / 53.07 | 49.48 / 52.61 |

Seven-socket p50 changed by 0.4% and p95 improved slightly. The maximum batch
still returned about 574 KiB in 498 ms p50, so yielding protected foreground
traffic without materially inflating batch completion.

## Cloudflare profile

For the final run, Cloudflare Workers Analytics reported no invocation errors.
Successful requests had 2.053 ms CPU p50, 2.685 ms p90, and 6.505 ms p99.
Across statuses, the run recorded 1,389 requests and 5,408 subrequests. The
`clientDisconnected` and `responseStreamDisconnected` statuses correspond to
the benchmark's deliberate WebSocket close and forced-close probes; both had
zero reported errors.

The body socket ceiling remained explicit: 32 sockets admitted and the 33rd
returned 429. Ordinary one-versus-seven socket propagation remained stable.

## Socket-session simplification follow-up

Deployment `c29d7bf5-fd59-4865-a7fb-eb71bce85a60` validated capability
version 2 through public HTTPS/WSS at the `MAA` edge. READY and every query
result carried the exact immutable socket-session identity. Body-self queries
measured 51.80 ms p50 versus 229.89 ms for HEAD; the width-100 root query
measured 56.14 ms versus 688.02 ms for 100 parallel HEADs. Removing duplicated
vault-generation and runtime-epoch fields reduced a one-body result from 370
to 330 bytes. Raw ignored evidence is retained in
`qa-runs/currentness/deployed-session-run.json`.

Deterministic client tests additionally replace the session during an active
query and inject an invalid READY, malformed result, and wrong returned
identity set. Every case settles once and reaches HTTP fallback in under the
500 ms test bound rather than waiting for the two-second missing-response
timeout.

## Outcome

The implementation meets the seven directly testable architectural criteria:

1. Active split views perform no network currentness work.
2. Warm sessions replace an approximately 218 ms HEAD with an approximately
   49 ms exact socket barrier.
3. Exact body-socket watermarks remove redundant live-body HEAD/body reads.
4. Closed-body work uses one bounded conditional state request per batch.
5. Exact generation promotion remains hash-, size-, revision-, and
   authority-fenced.
6. The ordered feed remains the restart/disconnect replay authority.
7. Maximum catch-up work keeps seven-body live propagation within 10%.
The deployed component distributions also clear the intended latency margin:
body-self query p95 was 55.11 ms versus 263.57 ms for HEAD, and width-100 root
query p95 was 59.81 ms versus 642.10 ms for parallel HEADs. One width-1 root
sample took 525.62 ms while the other 15 samples were at or below 53 ms; the
bounded timeout and HTTP fallback remain required despite the strong median.

The eighth criterion remains an explicit field gate rather than a fabricated
claim: normal desktop and mobile usage must populate the new redacted admission
distribution to establish actual visible-note-to-bound p95, tier hit rates,
and background wake patterns. This is workload calibration, not missing
protocol or product plumbing; the shipped instrumentation now measures it.
