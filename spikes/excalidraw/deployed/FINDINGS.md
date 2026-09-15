# Deployed Drawing Durable Object findings

Date: 2026-09-09

## Environment

The spike ran on a disposable production Cloudflare Worker with two SQLite
Durable Object classes:

- one `ExcalidrawRoomSpike` per stable drawing identity;
- one `AuthoritySpike` per vault identity.

The custom test hostname was temporarily placed behind an exact-host Access
bypass application because this machine's Zero Trust gateway rejects direct
`workers.dev` traffic. The Worker, Durable Objects, SQLite, cross-object calls,
WebSockets, and Cloudflare edge remained deployed infrastructure rather than
Miniflare simulations.

## Confirmed

- Complete native element records commit transactionally as one operation.
- Equal-version conflicts converge using the pinned upstream rule: the lowest
  `versionNonce` wins.
- Repeating an `operationId` returns its original durable receipt even when the
  retried payload differs.
- Every accepted operation receives one monotonic room sequence; reconnect uses
  sequence replay rather than timestamps.
- Complete deleted elements remain in snapshots and replay.
- Two live sessions belonging to one actor remain distinct.
- WebSocket attachment identity overwrites spoofed actor/session identity in
  presence frames.
- `ctx.acceptWebSocket()`, serialized attachments, tagged socket enumeration,
  and class-level `webSocketMessage()` work with the proposed hibernatable shape.

## Revocation experiment

The room asks the vault authority object to reserve an operation before it
commits. The driver injected response loss after reservation, fenced the actor,
and retried the same operation:

1. the pre-fence reservation replayed and committed;
2. a new post-fence operation from the stale actor revision failed;
3. the outcome therefore has a stable logical order despite cross-DO response
   loss.

This validates an authority reservation as a viable exact-ordering mechanism.
It also establishes its cost: every previously unseen durable room operation
incurs a cross-DO authority turn. Production should batch one gesture into one
room operation and measure whether short room-local authority leases can safely
reduce calls without weakening immediate revocation. A lease alone is not an
equivalent security contract.

## Deployed load observation

The retained run inserted 10,000 representative elements in 40 operations of
250 elements each:

- total apply wall time: 6,646.50 ms;
- average end-to-end operation wall time: approximately 166 ms;
- 10,000-element snapshot request: approximately 514 ms in the driver;
- independently downloaded snapshot: 1,456,702 bytes in 561 ms;
- final room sequence: 40.

These are single-run architecture measurements through the Access/custom-domain
edge, not release SLOs. They prove feasibility and show that snapshots above a
few thousand elements require compression, conditional transfer, pagination or
streaming, and explicit response limits. Incremental replay remains the normal
reconnect path.

## Required changes before production

- Call or faithfully pin upstream reconciliation and index-repair semantics;
  do not maintain an informal comparator.
- Reject an identical `(version, versionNonce)` carrying different canonical
  content rather than silently accepting whichever payload appeared first.
- Validate complete Excalidraw schemas and coupled multi-element invariants.
- Chunk oversized transport while retaining one logical transaction boundary.
- Add replay retention, snapshots, deletion fences, and old-client reset rules.
- Authenticate the room bootstrap and authority reservation with YAOS tickets;
  the spike intentionally uses visible IDs.
- Add durable room lifecycle states and multi-object orphan repair.
- Enforce presence byte/rate/coordinate bounds and idle expiry.
- Test actual hibernation/eviction duration; use of the hibernation API shape
  alone does not prove that this short run observed eviction.

## Commands

```sh
wrangler deploy --config spikes/excalidraw/deployed/wrangler.jsonc
node spikes/excalidraw/deployed/run-experiment.mjs https://<spike-host>
```

Machine-readable evidence is retained in `results.json`.

## Cleanup

After the browser integration run completed, the disposable Worker, its custom
hostname, and the exact-host Cloudflare Access application were deleted. A
follow-up DNS/HTTP probe could no longer resolve the hostname. No deployed
spike infrastructure remains active.
