# RFC 14 generic presence kernel implementation report

**Status:** implemented and validated in focused, regression, and local Worker
environments. Real Obsidian desktop/mobile and disposable Cloudflare deployment
remain external release gates.

**Contract:** [RFC 14](rfc-14-generic-presence-kernel.md)  
**Date:** 2026-09-09

## Delivered

RFC 14 adds ephemeral Excalidraw multiplayer presence without changing RFC-13
scene authority. Presence uses the existing authenticated Drawing-room socket
and Drawing Durable Object. It does not use Yjs, another Durable Object, SQL,
replay, durable scene snapshots, receipts, or the client outbox.

The global exact socket protocol is now 7. Protocol-6 clients do not understand
presence frames and are rejected rather than allowed to interpret them as scene
gaps.

### Shared protocol

`server/src/shared/presenceProtocol.ts` defines the four v1 frames, complete
replacement Excalidraw state, trusted identity, relative expiry, strict
server-frame parsing, deterministic member colors, and finite bounds for
pointers, lasers, selections, interactions, viewports, follow targets, IDs,
display names, and encoded messages.

### Server

`server/src/presenceKernel.ts` owns the transient mechanics:

- trusted identity from hibernatable socket attachments;
- one current full state and strictly newer sequence per session;
- 60 input frames per second and 50 ms latest-state coalescing;
- 15-second expiry, initial roster snapshot, and explicit leave;
- close, error, reset, and authority-fence removal;
- 256-session admission;
- presence dropping at 64 KiB while durable scene delivery remains eligible
  until the 1 MiB close/replay threshold.

Current bounded presence and rate metadata live only in WebSocket attachments.
A cold Drawing runtime can enumerate them without a presence table or alarm.

`server/src/excalidrawRoom.ts` integrates the kernel after RFC-13 connect
reservation. It sends Drawing `hello`, then `presence.snapshot`, accepts ping
and presence on the same socket, and leaves scene sequence, events, receipts,
snapshots, tombstones, resources, and reconciliation unchanged.

### Client and transport

`src/sync/presence/client.ts` implements interactive and ambient coalescing,
one latest pending full state, five-second refresh, monotonic local expiry from
`expiresInMs`, snapshot replacement, state/leave handling, socket-loss cleanup,
and best-effort withdrawal.

`src/sync/excalidraw/transport.ts` multiplexes presence through the existing
Drawing socket, drops presence first under client backpressure, parses presence
separately from scene events, and filters the local session learned from
Drawing `hello` so the sender never renders its own server echo.

`src/sync/excalidraw/engine.ts`, `src/sync/excalidraw/presence.ts`, and
`src/sync/excalidraw/manager.ts` bind presence to the scene lifecycle.
Reconnect clears stale peers and republishes current local state. Split views
inside one plugin manager share one `HostGroup`, engine, socket, and local
presence session while rendering the remote roster across every binding.

### Obsidian host

`src/host/obsidianExcalidrawHostAdapter.ts`:

- wraps each view's `onPointerUpdate` while preserving its receiver, arguments,
  result, and exact original function;
- captures selection, editing/dragging, scroll, zoom, viewport, and follow data
  through the existing scene-hook multiplexer;
- renders native Excalidraw collaborators with
  `updateScene({ collaborators })`;
- restores the exact pointer method and prior global hook on teardown;
- carries viewport/follow on the wire but never applies them remotely because
  the current host path can dirty persisted AppState.

## Validation

The implementation passed:

- 8 focused presence/Excalidraw suites;
- all 176 discovered regression suites;
- product build and product/test TypeScript checks;
- schema/storage/protocol/snapshot guard at `9/5/7/4`;
- targeted ESLint, worktree lint, and `git diff --check`;
- the complete local Wrangler/workerd suite using SQLite Durable Objects.

`tests/live/excalidraw.ts` proves two independently enrolled devices receive an
empty roster, exchange presence both directions, cannot spoof trusted identity,
do not advance Drawing sequence, continue receiving atomic scene commits,
withdraw explicitly, and disappear on abrupt socket termination. It also
reproves lower-nonce reconciliation, exact receipt replay, canonical snapshots,
and monotonic replay while presence is active.

Server runtime suites additionally prove attachment-based cold-runtime roster
continuity, TTL, coalescing, size/rate/capacity limits, authority fencing,
absence of presence SQL, and durable-priority backpressure. Client suites prove
refresh, monotonic expiry, socket-loss cleanup, snapshot replacement, self
filtering, host capture, native collaborator rendering, and exact teardown.

## Attempted deployed gate

A fresh isolated Worker name was prepared and deployment was attempted against
both Cloudflare accounts available to the configured token. Cloudflare rejected
both script uploads with API error `10000` (`Authentication error`). No Worker
was created and no retained deployment was touched. Local workerd is therefore
the strongest server-runtime evidence in this report.

## Remaining release gates

- Run `npm run test:integration:deployed` on a fresh disposable Worker once a
  token has Worker Scripts write permission, then delete the Worker.
- Run two real Obsidian desktop profiles and verify pointer, laser, selection,
  idle, reconnect, rename/delete, reload, and no autosave or undo pollution.
- Run desktop/mobile with touch and stylus, background beyond the 15-second
  TTL, resume, and abrupt application termination.
- Calibrate latency and backpressure with a larger concurrent room before
  advertising a supported participant maximum.
- Keep remote viewport/follow projection disabled until a pinned host probe
  proves it cannot dirty or persist the receiving view.

Browser sharing, public identities, privacy publication controls, Canvas host
presence, and advanced follow behavior remain separate later RFCs.
