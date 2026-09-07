# Multiplexed body transport evaluation

**Date:** 2026-09-07
**Decision:** formally reject multiplexed body transport for YAOS 3 schema 6 / socket protocol 2.

This closes the measurement gate in RFC 15. YAOS should retain one structural
root socket and separate sockets for currently admitted bodies. It should not
introduce a transport abstraction, protocol capability, or dual implementation
solely to preserve a speculative multiplexing path.

This is a rejection of the change for the measured product and protocol, not a
claim that multiplexing can never be useful. The final section defines evidence
which would justify reopening the decision.

## What Relay actually demonstrates

The earlier Relay comparison overstated Relay's use of multiplexing.
`MSG_QUERY_SUBDOCS` is a batched snapshot-index query sent over the parent
document's existing provider. It is not a live multi-document Yjs transport.
Relay's `YSweetProvider` still constructs one `WebSocket` for one provider URL,
and Relay bounds those physical providers with a connection pool whose defaults
are ten persistent and six temporary connections.

The transferable Relay lesson is therefore:

- keep active document connections bounded;
- carry compact child-head/snapshot summaries over the parent channel;
- batch cold catch-up;
- retain independent document lifetimes and failure boundaries.

YAOS already has the same shape: a seven-body client socket allowance, root
`BODY_COMMITTED` invalidations, an ordered SQL feed, paged heads, a bounded
100-body `/catch-up` route, and independent warm-body residency. There is no
missing, proven Relay live-multiplexing implementation to copy.

## Current YAOS path

The default client budget is eight physical sockets with one reserved for the
root, leaving seven body sockets. Up to 24 bodies may remain warm. The server
admits at most 32 root and 32 body sockets per vault runtime and returns a
bounded `429` at the body limit.

Editor admission is more than a WebSocket handshake. For a body which is
already present locally, `acquireEditorBody` still:

1. requests the current body head over authenticated HTTP;
2. fetches the body state if the local generation/hash is stale;
3. creates or reuses a body provider;
4. waits for provider sync before attaching the CRDT editor binding.

Consequently, multiplexing could remove only the physical body-socket setup
portion. It would not remove the current HTTP currentness gate. A connected
body session also passes through that head request on reacquisition today.

Every foreground physical socket independently uses protocol-2
`VAULT_READY/PING/PONG` liveness after 60 quiet seconds. Background runtimes
suspend the cadence. A root failure deliberately has a wider recovery domain;
a body failure is currently isolated to one body.

## Deployed measurement

The harness is `scripts/measure-multiplexing.ts`. Raw retained artifacts are:

- `qa-runs/multiplexing/deployed-run-1.json`
- `qa-runs/multiplexing/deployed-run-2.json`
- `qa-runs/multiplexing/deployed-run-3.json`

The artifacts are local QA evidence and are intentionally not product source.

Three complete runs used disposable, freshly claimable Cloudflare Workers and
fresh vault generations. Two independently enrolled devices shared 40 bodies
of 4 KiB each. All requests used public HTTPS/WSS through Cloudflare Access,
not local Wrangler. The recorded rays terminated at Cloudflare's `MAA` edge.
Known deployment versions include
`064a264e-0e1a-4f60-b1ae-d4a94e897502` and
`54fd8d1a-c070-4180-b3bb-cac09659c2d3`; the first complete run used disposable
version `491a41c1-7f48-4184-a21a-6a73e0dd99ab` before version capture was added
to the artifact.

The custom hostname was briefly subject to a negative local resolver cache.
The harness pinned that hostname to its public Cloudflare anycast address while
preserving the original HTTPS/WSS hostname and TLS validation. This did not
replace the remote edge with a local server.

Each run measured idle resume, sequential first and repeat subscriptions,
parallel widths 1/2/4/7, 40 sequential body cycles, 32-socket saturation, a
33rd admission, two-device propagation with one versus seven device-B body
sockets, protocol payloads, process-visible transport byte counters, and the
current liveness projection. The third run additionally measured deployed HEAD
and body-state HTTP reads. Every completed vault was destroyed, and all three
disposable Workers were deleted after collection.

## Results

All values are milliseconds unless noted.

| Measure | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| idle-resume body sync | 448.35 | 324.25 | 263.49 |
| steady WebSocket open p50 | 217.12 | 223.05 | 217.94 |
| first-pass body sync p50 | 268.50 | 276.79 | 274.73 |
| repeat-pass body sync p50 | 268.80 | 279.93 | 274.39 |
| one parallel body, wall p50 | 271.02 | 281.39 | 278.58 |
| seven parallel bodies, wall p50 | 306.25 | 315.79 | 310.76 |
| 32 parallel bodies, wall | 873.22 | 927.96 | 920.56 |
| 32 parallel bodies, sync p50 | 551.64 | 554.05 | 579.72 |
| 33rd body status | 429 | 429 | 429 |
| propagation with one B socket, p50 | 47.15 | 49.73 | 47.26 |
| propagation with seven B sockets, p50 | 46.37 | 62.78 | 47.60 |

Additional observations:

- A steady body subscription spends about 218-223 ms establishing WSS and
  about another 51-57 ms reaching sync. The handshake is the majority of a new
  subscription's raw network wait.
- Repeating the same bodies did not make new physical sockets meaningfully
  cheaper. TLS/edge reuse did not erase the per-provider setup cost.
- Seven bodies completed only about 32-45 ms later than one body while doing
  seven times the work. Current parallel admission does not show linear
  connection amplification.
- Median propagation across the three runs was 47.26 ms with one body socket
  and 47.60 ms with seven. One seven-socket trial was slower, but the other two
  were equal to the one-socket case. There is no repeatable steady-state
  propagation penalty at the product width.
- Deliberate saturation opened all 32 body sockets in under one second and
  rejected exactly the 33rd. The ordinary client limit of seven remains far
  below that boundary for the expected small number of full-peer devices.
- The third run measured a 194.38 ms p50 current-head request and a 193.14 ms
  p50 4 KiB body-state request. A clean warm body outside the seven-socket set
  therefore has a measured steady path of roughly 194 ms for currentness plus
  275 ms for a new socket sync: about 469 ms before CRDT editor binding. A
  perfect body mux could remove at most roughly 218 ms of that path; it would
  leave the independent currentness request in place.
- A measured body connection used about 3.0 KiB in the Node WebSocket's
  process-visible read/write counters at sync. This is useful for relative
  comparison but is not a complete IP, radio, or Cloudflare billing measure.
- A normal WebSocket close did not complete within the harness's two-second
  close window. The 40-cycle wall time of about 92 seconds is therefore mostly
  harness serialization of that timeout and is not a note-switch UX number.
  The useful churn values are its 220-226 ms open and 275-285 ms sync medians.
  Production intentionally force-abandons a fenced old transport rather than
  waiting for a close handshake, so this result confirms an existing design
  choice rather than motivating multiplexing.

## Liveness and wake projection

One exact application probe pair was 236 payload bytes. At the maximum normal
foreground shape of one root plus seven body sockets, protocol 2 therefore
produces:

- 480 probe pairs per foreground hour;
- 113,280 application payload bytes per foreground hour.

A body-only multiplexed design should retain a physically separate root socket
to preserve structural authority and failure isolation. Two physical sockets
would project to 120 pairs and 28,320 payload bytes per hour: 360 fewer pairs
and 84,960 fewer bytes, a 75% reduction in this worst-case foreground
projection.

That is a real reduction but not yet a demonstrated product problem. The bytes
are small, background cadence is suspended, simultaneous timers may share a
radio wake, and this run did not measure mobile battery impact or translate
messages into a material host bill. Implementing a new protocol from a payload
projection would violate the measurement gate which created this task.

## Benefit ceiling

For the present design, the credible multiplexing benefits are bounded:

1. Save roughly 218-223 ms when a needed body has no admitted physical socket.
2. Reduce worst-case foreground liveness pairs and payload by 75% if root
   remains physically separate.
3. Replace the aggregate physical-socket count as the first limit for vaults
   with many simultaneously active devices.

It does not improve an already admitted body's propagation, make seven-way
opening materially more parallel, remove the measured 194 ms current-head
gate, reduce Yjs state size, change warm-body memory pressure, or strengthen
durable candidate settlement.

## Implementation cost and new risk

YAOS and `y-partyserver` currently get exact-document routing from the physical
socket. A multiplexed transport would replace that simple boundary with a new
wire protocol and must ship in both Cloudflare and Node hosts. At minimum it
would require:

- a protocol-3/capability-gated endpoint and a dual-transport rollout;
- subscribe, unsubscribe, sync, awareness, error, and resubscribe frames with
  exact document identity and a logical-subscription epoch;
- stale-frame fencing across eviction, credential refresh, reconnect, and
  rapid unsubscribe/resubscribe races;
- per-body and aggregate pending-byte limits no longer supplied by one socket
  per body;
- fair scheduling so a large background body cannot head-of-line block active
  editor frames in the WebSocket's single ordered send queue;
- logical body readiness and liveness without mistaking one healthy channel
  for another;
- a policy for isolated logical-channel recovery when the shared physical
  transport is healthy, and global recovery when it is not;
- revised socket/resource accounting, diagnostics, 429 semantics, revocation,
  awareness fan-out, and teardown;
- mixed-version admission and fallback coverage while both implementations
  exist.

The durable candidate/receipt path can remain HTTP and retain its proof, but
the live provider path would no longer be the well-tested direct Yjs provider.
This is a large permanent protocol surface to optimize an off-pool subscription
which has not been shown to occur often enough in real vaults.

## Decision rationale

Multiplexing fails the RFC 15 requirement that it materially improve a declared
workload:

- product-width parallel sockets scale well;
- seven sockets do not repeatably degrade active propagation;
- current client admission remains far below the proven server boundary;
- connection and heartbeat bytes are small;
- ordinary socket-pressure frequency, mobile wake cost, and host cost have not
  been demonstrated as problems;
- the measured hot acquisition path contains a separate HTTP delay that
  multiplexing cannot fix;
- Relay itself chooses bounded per-document providers plus batched summaries,
  not the proposed live multiplexed transport.

Combining body failure domains, adding ordered-channel head-of-line risk, and
maintaining a custom protocol are not justified by the current evidence.
Schema 6 / protocol 2 should therefore keep the simpler transport.

## Better next work

The measurements point to smaller changes with higher leverage:

The detailed safety analysis and implementation order are in
[Currentness plane and editor admission investigation](currentness-plane-investigation.md).

1. **Fast-path an already current live session.** If a body provider is synced,
   application-live, generation-fenced, and has not missed a root
   `BODY_COMMITTED` invalidation, prove whether editor reacquisition can skip
   the unconditional current-head request. This targets the measured 194 ms
   path which multiplexing leaves untouched.
2. **Measure actual editor binding.** Record redacted distributions for visible
   note-to-CRDT-bound time, live-session hit/miss, HTTP currentness time,
   provider-admission time, active body sockets, and ordinary 429s. Raw paths,
   body IDs, and content must remain absent.
3. **Extend compact head batching, not live multiplexing.** Reuse root
   `BODY_COMMITTED`, paged heads, and `/catch-up` to maintain exact currentness
   evidence for warm bodies. This is the actual `MSG_QUERY_SUBDOCS` lesson from
   Relay.
4. **Tune liveness only from field evidence.** Measure mobile foreground and
   background battery/network behavior plus Worker and Node host cost before
   changing the negotiated cadence.

## Reopen conditions

Reconsider a physically separate body-mux socket only after the fast-path and
batched-currentness work above. Reopening requires at least one of these
observations from ordinary use:

- after at least 1,000 editor acquisitions across desktop and mobile, physical
  body admission contributes at least 150 ms to p95 bind latency and affects at
  least 5% of acquisitions;
- client body-socket use is at least six of seven for 10% of foreground time,
  or ordinary supported device use produces server body-socket `429`s;
- measured protocol-2 liveness causes at least 1% daily mobile battery impact
  attributable to YAOS, or a material documented host-cost boundary;
- the supported product moves to five or more simultaneously active full-peer
  devices per vault, making the current 32-body aggregate plausibly reachable.

Even then, a deployed paired prototype must demonstrate at least a 150 ms p95
or 25% cold-bind improvement, retain a physically distinct root channel, keep
active-editor propagation within 10% of the separate-socket baseline under a
noisy background body, and prove bounded per-body buffers plus leak-free
unsubscribe/reconnect/eviction races. If it cannot, the rejection remains.

## Evidence limits

- The runs used one geographic edge and a Node measurement client, not an
  Obsidian mobile radio trace.
- Bodies were 4 KiB and did not model large or fragmented Yjs histories.
- There is no paired mux prototype, so the estimated 218-223 ms benefit is an
  upper bound derived from measured physical open time, not a claimed mux
  result.
- Process-visible WebSocket counters do not include a trustworthy complete
  radio, IP, or billing model.
- The separate HTTP currentness measurement was added for the third run only.
- The 20-second quiet boundary exercises a deployed idle/resume path but is not
  proof of a particular Cloudflare isolate lifecycle transition.

These limits are reasons not to generalize the result into “multiplexing never
helps.” They do not weaken the narrower conclusion: YAOS has no measured reason
to own that complexity now.
