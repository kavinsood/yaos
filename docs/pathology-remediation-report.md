# Yjs pathology remediation report

Date: 8 September 2026. Branch: `yaos3`.

## Outcome

The row-limit and pathological-history program is complete. YAOS now stores Yjs
updates as bounded binary SQLite values, keeps authoritative and validation
documents resident on active lineages, checkpoints live state, performs genuine
semantic resets, fences retired CRDT identities, rebuilds root state from SQL
authority, and bounds history retained by pins.

This is a greenfield schema boundary. No base64 Yjs representation or old-epoch
compatibility path is retained.

## Implementation audit

| Area | Result | Production behavior |
| --- | --- | --- |
| Binary-only storage | Complete | Journal updates are single bounded BLOBs. Checkpoints alone are split into ordered, digested, transactionally complete BLOB chunks. Oversized wire updates are rejected before Yjs or SQLite. |
| Candidate processing | Complete | Each active body has one resident authoritative document and one private validation mirror. Candidate durability uses exact-head CAS and receipts without reconstructing the history again. |
| WebSocket validation | Complete | Frames stage on the persistent mirror. Only validated, durably committed updates reach live state and peers; rejection rebuilds the mirror. |
| Resource accounting | Complete | Wire size governs row admission, canonical content bytes govern content limits, and input-byte estimates are never correctness proofs or admission rejections. Exact encoded-state censuses schedule observability and compaction. |
| Live checkpointing | Complete | Clean resident state is encoded directly, chunked, verified, and committed before journal pruning. Reconstruction is an exceptional recovery fallback. |
| Semantic compaction | Complete | Markdown and Canvas are materialized canonically into fresh `Y.Doc` lineages. Durable cooldown and low-water state prevent reset thrashing across restarts. |
| Epoch protocol | Complete | Body/root epochs fence tickets, sockets, queued frames, candidates, receipts, checkpoints, feeds, bootstrap, client storage, caches, pending queues, transient reservations, and serialized operation lanes. |
| Lifecycle recovery | Complete | Pending Markdown and Canvas create/rename/delete work either replays its exact durable receipt or is rebased/retired across an epoch reset. Unpublished creation receipts fence compaction until root publication is safe. |
| Root compaction | Complete | The root is rebuilt from SQL catalog and attachment authority using only the fixed root maps. Lifecycle and publication-proof debris is dropped, while outstanding proofs are transactionally rebased. |
| Pin retention | Complete | Pins are typed, owned, expiring/releasable, count- and age-bounded, attributable in diagnostics, and subject to the retained-checkpoint byte cap both at admission and during later checkpoint growth. |

Server cache identity is `(documentId, semanticEpoch)`, not merely a document
ID carrying a mutable epoch. This keeps old pending frames, reservations, and
operation tails unreachable after a reset while preserving per-document
serialization across a lineage transition.

## Pathological frozen-trace result

The stress trace starts from a 950,446-byte Markdown document and contains
50,000 exact wire frames (1,721,696 payload bytes). Its uncompressed history
ends at 97,356 structs, including 34,449 deleted structs, and a 2,128,183-byte
encoded Yjs state.

The final isolated-process measurements were:

| Intervention | Result |
| --- | ---: |
| Production candidate replay | 6.23 s |
| Five-reset production semantic-compaction soak | 6.39 s; all ceilings passed |
| Full production validation-mirror replay | 50,000/50,000 frames; 165.30 s |
| Full socket replay additional process RSS | 287.0 MiB; 320 MiB regression ceiling passed |
| Live checkpoint | 236.7 ms and +35.9 MiB peak RSS |
| Reconstruct-then-checkpoint control | 752.3 ms and +87.3 MiB peak RSS |
| Body structs after semantic reset | 1, down from 97,356 |
| Root structs after production reset | 1,009, down from 51,013; 1,017 ceiling passed |

All five body resets preserved canonical content and durable recovery, rejected
all five stale candidates, fenced all five old socket populations, and created
fresh client identities. Maximum post-reset state was one struct and about
0.9 MiB encoded. Cold durable reconstruction took 19.2 ms.

The lab also proved the rejected alternatives:

- Rematerializing the existing Yjs history removed zero encoded history.
- The periodic input-byte ledger underestimated exact state by as much as
  16,904 bytes, so it cannot be an admission proof.
- Self-contained reconstruction frames used less peak memory but were about
  three times slower in this trace.
- Checkpoint chunking remains necessary because a valid complete state can
  exceed one safe SQLite row.

These RSS figures are Node process high-water marks containing the server,
Node SQLite, the harness, and simulated clients. They are regression evidence,
not Cloudflare Worker isolate telemetry and not proof of compliance with an
isolate memory ceiling. Direct provider-side isolate RSS was unavailable.

## Correctness and packaging gates

The final tree passed:

- 161/161 regression suites;
- 92/92 headless checks;
- every Wrangler-to-Node conformance scenario;
- Node storage, object-store, alarm, and runtime suites;
- CLI smoke and packed-install smoke;
- focused cache, Canvas lifecycle, semantic-runtime, pin-retention, and
checkpoint-corruption suites;
- builds, all project TypeScript configurations, changed-file lint, and
  `git diff --check`.

The corruption matrix rejects missing, reordered, duplicate, oversized, and
digest-invalid checkpoint chunks and verifies transaction rollback. Focused
tests also cover validation poison/failure recovery, stale body/root sockets,
offline Markdown and Canvas rebasing, lifecycle publication gaps, repeated
compaction with active pins, and post-admission retained-byte growth.

The production root arm independently reconstructs the durable reset and
compares it with resident state. It preserves SQL-authoritative Markdown,
Canvas, active attachments, and attachment tombstones; removes unknown and
lifecycle marker maps; migrates two lifecycle publication proofs; and enforces
10-second elapsed and semantic-entry-derived struct ceilings. Fault injection
after proof migration verifies that root head, clock, proofs, checkpoint rows,
and socket fencing all roll back together.

## Deployed validation

The existing validation Worker was deployed with a fresh Durable Object SQL
lineage and exercised with the destructive two-device suite:

- Worker: `yaos-rfc08-10-validation-open`
- Version: `60b346a9-a7ed-4a98-bb3d-46677787cd2d`
- Host: `https://yaos-stress-storage3.kavin.me.cloudflare.dev`
- SQL lineage: `*Storage4RemediationAuditFinal2`

Enrollment, WebSockets, lifecycle operations, attachments, recovery, settings,
revocation, and generation purge all passed. Cloudflare Access used an
exact-host Service Auth policy plus a separately constrained interactive
identity policy; there were no bypass, Everyone, country, or broad-IP rules.
The one-day validation credential was removed afterward and the pre-existing
service-token policy was restored.

The first final-run purge was still retrying when the harness's old 15-second
deadline expired. The terminal assertion was retained, the platform wait was
bounded at 60 seconds, and a complete rerun on a fresh SQL lineage reached the
required `200` terminal deletion state.

## Claim boundary

The production architecture and the identified checklist defects are fixed.
The remaining external unknown is a measurement capability, not a known code
gap: Cloudflare server-only isolate RSS cannot be reported until the provider
exposes suitable telemetry or an equivalent controlled measurement surface.
