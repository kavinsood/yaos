# RFC 13 Excalidraw same-vault scene sync implementation report

RFC 13 has a complete schema-9 core implementation for explicit same-vault
promotion and live native scene synchronization. It is not yet approved for
production rollout: the remaining gates below are preservation, lifecycle,
resource, host, and deployed-runtime work rather than open architecture
questions.

## Implemented boundary

- Schema 9, storage format 5, protocol 6, snapshot/recovery format 4, fresh
  schema-9 browser and Node caches, exact mixed-version rejection, release
  binding guards, and a dedicated `ExcalidrawRoomDO` namespace.
- Server-owned `pathToSemantic` Excalidraw authority, stable drawing identity,
  attachment/Markdown source proof, and an idempotent prepare-initialize-finalize
  promotion saga. The ordinary file planes exclude an active promoted path.
- Complete native Excalidraw records without Yjs. Reconciliation uses higher
  `version`, then lower `versionNonce`; equal revision tuples with different
  canonical content fail closed.
- One bounded logical change produces one Drawing-DO transaction, room
  sequence, replay event, receipt, broadcast, and host apply. The resulting
  state must preserve reciprocal arrow/text binding closure, container/frame
  targets, active-element limits, and total-element limits.
- Durable native tombstones, monotonic bounded replay, canonical snapshots,
  replay compaction, future-cursor rejection, operation equivocation checks,
  immutable resource-manifest merging, and application ping/pong liveness.
- Every new initialize, mutation, reset, and connection receives a Vault-DO
  reservation. Exact pre-fence reservations replay; revoked actors cannot
  reserve later work. Membership/device fences close matching Drawing sockets.
- Promoted rename and delete are durable, replay-safe root/catalog operations.
  Rename preserves drawing identity and room authority. Delete tombstones the
  catalog, denies new reservations, and closes all room sockets.
- The client persists promotion intents, lifecycle intents, scene outbox work,
  projections, receipts, and superseded-epoch alternatives. A receipt cannot
  retire outbox work before canonical replay/snapshot settlement reaches its
  sequence.
- The current Obsidian Excalidraw hook is capability-detected and chained.
  Capture snapshots include deleted records; remote apply uses
  `CaptureUpdateAction.NEVER`; exact revision evidence suppresses only the
  applied winner and preserves interleaved local edits.
- Embedded resources use immutable Blob CAS descriptors. Failed upload or
  unavailable retrieval degrades rendering without dropping the scene change.
  Vault resources remain same-vault references and are never recursively
  disclosed.
- A bounded format adapter round-trips official JSON and current Obsidian
  Markdown `json` and `compressed-json` containers while retaining unknown
  scene data, tombstones, binary metadata, and auxiliary bytes.

## Automated evidence

Focused tests cover native lower-nonce convergence, reciprocal dependency
closure, atomic batches, tombstones, replay, receipt replay, promotion response
loss, authorization fences, socket closure, host echo suppression, resource
degradation, durable outbox recovery, old-epoch preservation, format round
trips, semantic routing, and rename/delete lifecycle behavior on real SQLite.

`tests/live/excalidraw.ts` adds a two-device journey through a real local or
deployed Worker: source publication, promotion, Drawing-DO initialization,
ticketed room socket delivery, atomic edits, lower-nonce convergence, durable
receipt replay, snapshots, and replay recovery.

## Remaining release blockers

- Wire the closed-file projection coordinator to atomic Obsidian disk writes,
  correct its target scene hash, and prove open/closed/rename races. Until then,
  a drawing must be open to receive a current ordinary-file projection.
- Synchronize the auxiliary Markdown container as its own bounded authority;
  the format codec proves preservation but the live room does not yet settle
  concurrent back-of-card changes.
- Add authoritative epoch/catalog lookup instead of the current epoch-1 main
  binding, then implement revive, demotion, epoch replacement, terminal room
  snapshots, reservation draining, and orphan-room reaping.
- Add state hashes, durable snapshot history, receipt/event retention and GC,
  compact deletion fences, and crash tests across every fence boundary.
- Add durable resource upload/retry/GC jobs, the concrete same-vault resource
  resolver, rendered-dependency placeholders, and resource completion status.
- Add active interaction and IME deferral, richer apply-origin evidence and
  expiry, a forced post-apply comparison, and a save-checkpoint capture backstop.
- Integrate the dedicated Excalidraw database with global pending-work,
  reset/uninstall, export, and recovery accounting.
- Add room residency admission, bounded snapshot encoding, per-session request
  limits, rate limiting, receipt ownership checks, diagnostics, and calibrated
  backpressure under the RFC limits.
- Validate the real plugin fixture corpus and pinned native index oracle, then
  run two-profile Obsidian desktop, desktop/mobile, deployed Worker fault,
  hibernation, performance, rollback, and privacy matrices.
- Implement equivalent Drawing-room hosting or explicitly advertise the
  feature unavailable in Node/Docker deployments.

Presence, member browser participation, public read-only sharing, and public
editing remain later RFCs and do not alter the native scene authority selected
here.
