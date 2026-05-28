# Warts and limits

This is the canonical limits and tradeoffs document for the current YAOS architecture.
It is intentionally fact-first: hard constraints, current implementation truth, and explicit engineering warts.

Maintaining one vault-level `Y.Doc` gives strong cross-file transactional behavior, but it also means persistence must handle a large binary state graph on infrastructure with strict per-entry limits. YAOS addresses this with a checkpoint + journal storage engine rather than single-value rewrites.

## Current server persistence model

YAOS keeps a monolithic vault-level `Y.Doc` in memory, but persistence is no longer a single-value rewrite:

- Checkpoint layer: full-state snapshots chunked into 512 KiB segments.
- Journal layer: coalesced state-vector deltas appended at `onSave()` cadence.
- Baseline anchor: checkpoint state vector is persisted and validated on load.
- Integrity layer: SHA-256 verification on checkpoint and journal payloads.

Compaction policy is deterministic:

- Compact when journal exceeds 50 entries, or
- Compact when journal exceeds 1 MiB total bytes.

Operationally, this solved the "final boss" of CRDT scaling for this architecture: write amplification from full-state rewrites on tiny edits.

Order-of-magnitude effect:

- old path: tiny edit could force near full-state rewrite
- current path: tiny edit typically appends a small coalesced delta segment

## Practical ceilings (what hurts first)

Very large vaults are still constrained by:

- CPU cost for `Y.encodeStateAsUpdate()` and merge/apply work.
- Durable Object memory pressure on cold start/replay.
- Client-side parse/apply latency (especially mobile), even if transport limits are higher.

In practice, compute and memory behavior usually become the first bottlenecks before raw storage capacity for CRDTs.

## Safety invariants

- Fail closed: any manifest/chunk/hash mismatch aborts load.
- Ordered writes: persistence is serialized so journal appends cannot reorder.
- State-vector anchoring: delta baselines are persisted with checkpoints and restored after hibernation wake.
- Batched storage ops: get/put/delete are capped at 128 keys per operation.

## Operational warts and intentional tradeoffs

### Observability is bounded and fail-open by design

YAOS originally kept room traces in one growing storage value. Real production
logs showed that this could trigger `SQLITE_TOOBIG` and take the room down.

The current design stores traces as bounded per-entry records and treats trace
persistence as fail-open.

Implications:

- observability can still lose entries under storage errors
- observability should never be able to make the room unavailable

This is the correct trade for telemetry in a sync engine.

### Schema admission uses a metadata sidecar

Websocket schema admission now reads a small room metadata sidecar rather than
reconstructing the full room document in the common case.

This sidecar is intentionally narrow:

- it exists for tiny admission decisions
- it is not a second source of truth for room contents

Fallback to full-document probing remains for legacy/missing metadata cases.

### CRDT tombstones are retained

In YAOS, markdown tombstones (records of deleted files) are intentionally retained in the CRDT graph.

Reason: without tombstones, stale offline clients can reintroduce deleted files during reconnect, causing resurrection bugs.

Tradeoff: tombstones increase long-term graph size and add lookup overhead, but they preserve deletion correctness under reconnect/offline churn. This is a correctness-first choice.

### Local plugin persistence is serialized on purpose

The plugin persists multiple state domains into Obsidian `data.json` (settings, disk index, blob hash cache, transfer queue).

Obsidian persistence requires a read/merge/write cycle. If independent async saves race, they can clobber each other.

YAOS routes these writes through a single serialized persistence chain to prevent cross-feature state stomps. This is less "clean" than isolated save paths, but materially safer.

### IndexedDB readiness check uses private internals

Local-first behavior depends on `y-indexeddb` startup succeeding. IndexedDB implementations are known to be flaky in some mobile/webview conditions.

YAOS currently reads a private `y-indexeddb` internal (`_db`) to detect startup failure reliably and fail safely instead of continuing in a potentially corrupt state.

This is a contained hack, explicitly documented, and should be replaced if upstream offers a stable public readiness/failure API.

## Pragmatic compromises

These are deliberate compromises to preserve correctness and operability in real environments:

- WebSocket auth uses short-lived HMAC-signed tickets (`?ticket=`) instead of the long-lived bearer token.  Old clients are still accepted via `?token=` during the migration window; set `YAOS_DISABLE_LEGACY_WS_TOKEN=true` in `wrangler.toml` once all clients have upgraded.  Ticket signing currently derives the HMAC key from the existing auth secret (token or tokenHash) rather than a dedicated per-server signing secret; the correct long-term fix is a random secret generated at claim time and stored in the Config DO.

- `y-partyserver`'s `YProvider.connect()` evaluates async `params()` once and mutates `provider.url` in place.  The internal reconnect loop (`setupWS`) reuses `provider.url` directly on every subsequent reconnect without re-calling `params()`.  This means a ticket placed in `provider.url` on initial connection will be stale after its 5-minute TTL.  The workaround is `scheduleSocketTicketRefresh` in `VaultSync`: a proactive timer fires at `expiresAt - TICKET_REFRESH_BUFFER_MS` and patches `provider.url` via `patchTicketInUrl` before the old ticket expires.  A secondary best-effort patch fires on `"disconnected"` status events.  **If `y-partyserver` is upgraded, verify whether this behavior has changed** — if the library ever re-calls `params()` on reconnect, the proactive timer becomes harmless redundancy rather than a required correctness fix.
- Filesystem-facing sync paths are intentionally mixed:
  markdown ingest uses a dirty-set drain loop for backpressure-aware coalescing,
  while some blob paths keep quiet-window checks because partial attachment reads are costlier and noisier than text edits.
- Some modules remain large where state-machine locality matters (for example, startup/reconnect orchestration). We prioritize correctness and traceability over arbitrary file-size purity.

The standard is not "perfect abstraction." The standard is explicit correctness boundaries plus controlled, testable compromises.

## Known non-goals and future work

- No fully automatic HTTP bootstrap path for giant initial sync payloads yet.
- No cryptographic prev-hash chain between journal segments yet (current model uses per-segment hash plus strict sequence validation).
- No per-file sharded CRDT model yet (current design intentionally preserves monolithic cross-file transactional semantics).
- WebSocket auth still supports query token transport; target state is explicit post-connect auth handshake plus short-lived session credentials.
- Worker RAM caching for config/auth reads remains optional micro-optimization, not core architecture.
