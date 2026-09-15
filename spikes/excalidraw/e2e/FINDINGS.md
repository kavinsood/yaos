# Excalidraw React to deployed Drawing DO E2E spike

Date: 2026-09-09

## Conclusion

The proposed browser data path works end to end with the real
`@excalidraw/excalidraw@0.18.0` React component, two isolated system-Chrome
contexts, and a deployed Cloudflare Durable Object:

```text
Excalidraw onChange
  -> complete native element records
  -> Drawing DO transactional apply
  -> monotonic replay
  -> native revision reconciliation
  -> Excalidraw updateScene
```

The run passed bootstrap, live element mutation, concurrent equal-version
conflict, deletion, disconnect/replay recovery, remote-apply echo suppression,
and authenticated multi-session presence.

The architecture does not need Yjs. Native complete records plus Excalidraw's
revision rule, durable tombstones, ordered room operations, and ephemeral
presence are sufficient for the exercised collaboration loop.

## Executed environment

- Browser: system Google Chrome, headless, with two separately created browser
  contexts.
- Component: `@excalidraw/excalidraw@0.18.0` from the inspected
  `excalidraw-cloudflare` installation.
- Runtime: deployed `ExcalidrawRoomSpike` and `AuthoritySpike` Durable Objects at
  `https://yaos-excalidraw-spike-20260909.kavin.me.cloudflare.dev`.
- Scene delivery: 75 ms monotonic replay polling because this disposable worker
  intentionally does not broadcast scene commits.
- Presence delivery: direct hibernatable Durable Object WebSockets.
- HTTP bridge: Vite's same-origin proxy, used only because the disposable worker
  does not expose browser CORS headers.

Run it with:

```sh
cd yaos
node spikes/excalidraw/e2e/run.mjs \
  https://yaos-excalidraw-spike-20260909.kavin.me.cloudflare.dev
```

`run.mjs` starts and stops the local Vite harness, launches system Chrome,
creates a new authority/vault/room namespace, performs assertions, and writes
`results.json` only after every check succeeds.

## Passing evidence

The authoritative result is in `results.json`.

Measured timings from the successful run:

| Measurement | Result |
| --- | ---: |
| Mount and join two isolated contexts | 1447.71 ms |
| Equal-version conflict convergence | 212.47 ms |
| Disconnect/replay recovery | 219.19 ms |

The convergence numbers include deployed network latency, Drawing DO work,
cross-DO authority reservation, and the intentionally coarse 75 ms replay poll.
They are feasibility measurements, not product latency targets.

### Bootstrap and ordinary mutation

Both contexts joined an empty canonical room at sequence 0. Calling the real
imperative API on peer A caused a real `onChange` callback. The adapter submitted
the complete element, the Drawing DO committed sequence 1, and peer B recovered
it from replay and applied it with `updateScene()`.

This proves the official browser component supplies both sides of the required
scene seam. No Excalidraw fork or internal browser API was necessary.

### Equal-version conflicts use the lower nonce

The contexts concurrently applied version 7 of the same element:

- peer A: `versionNonce: 100`, `x: 100`;
- peer B: `versionNonce: 200`, `x: 200`.

The Durable Object and both React scenes converged on nonce 100 and `x: 100`.

This is important: pinned upstream Excalidraw reconciliation chooses the
**lower** `versionNonce` when versions are equal. A "higher nonce wins" rule is
not native behavior. Every YAOS implementation point must share the pinned
upstream rule:

- Drawing DO admission;
- browser merge;
- Obsidian host merge;
- bootstrap and replay;
- imported-file reconciliation;
- tests and migration tooling.

In this run, both equal-version candidates were durably accepted in sequence:
the transient loser arrived first, followed by the native winner. This produced
two valid room sequences before convergence. Scene broadcast must therefore
tolerate delivery of a transient candidate followed by its deterministic winner;
it must not assume every committed sequence remains the final value forever.

Prefer wrapping or vendoring a version-pinned upstream reconciliation helper
over independently remembering this counterintuitive ordering in several
handwritten comparators. Server conformance vectors should be generated from the
pinned Excalidraw implementation.

### Native deletion and retained tombstones

Peer A applied version 8 with `isDeleted: true`. The complete tombstone remained
in the Durable Object snapshot and in both peers' outputs from
`getSceneElementsIncludingDeleted()`.

The browser loop does not need a separate deletion protocol. It does require the
server and every adapter to retain and reconcile native deleted records. Any
later tombstone compaction needs a durable deletion fence and an explicit
snapshot/epoch horizon; simply dropping the record would permit stale offline
resurrection.

### Reconnect uses the monotonic room cursor

Peer B stopped both replay polling and its presence socket at sequence 4. Peer A
then committed version 9 at sequence 5. While disconnected, peer B remained at
version 8. On reconnect it requested replay after its last cursor and recovered
version 9 in 219.19 ms.

This validates a server-issued monotonic room sequence as the recovery cursor.
Wall-clock timestamps are unnecessary and would be weaker. Production must
define a replay-retention boundary: a peer behind that boundary replaces from a
canonical snapshot rather than attempting an incomplete replay.

### `onChange` echo can be suppressed without muting real edits

Every remote `updateScene({ elements })` on peer B caused the component's real
`onChange` callback. Four remote-apply callbacks were observed. The revision
ledger was updated before `updateScene()`, so all four callbacks were recognized
as already-known revisions and emitted zero outbound operations.

During the same run, peer B's intentional concurrent version-7 edit did emit one
outbound operation. The suppression mechanism therefore distinguished remote
echo from a real local candidate rather than globally disabling capture.

For the browser component, a canonical known-revision ledger is sufficient for
element transport echo suppression. The Obsidian adapter still needs a separate
save/dirty semaphore because suppressing YAOS network echo does not prove that
the host plugin will avoid autosave or file rewrite.

### Presence identity is session-scoped and server-owned

Both contexts authenticated as the same `actorId` but used `session-a` and
`session-b`. Each real Excalidraw app state held the other session as an
independent native collaborator.

The sending browser deliberately supplied spoofed actor and session IDs in its
presence body. The Drawing DO replaced them with the values serialized into the
accepted socket attachment. Peer B observed:

- authoritative `session-a`;
- authoritative shared actor ID;
- authoritative `Alice desktop` display name.

This proves the necessary identity split:

```text
actorId   stable authorized principal
sessionId unique live connection and Excalidraw collaborator key
```

A second device for one actor must never overwrite the first device's presence.
Production should add `deviceId`, expiry/leave messages, payload schemas,
coordinate bounds, throttling, rate enforcement, and revocation-driven socket
closure.

## What this changes in the target design

1. Use one dedicated Drawing DO per stable drawing identity.
2. Store native complete Excalidraw records; do not wrap the scene in Yjs.
3. Treat pinned upstream reconciliation semantics as protocol law, including
   lower-nonce equal-version selection.
4. Commit multi-element logical edits as one transaction and assign one
   monotonic sequence.
5. Broadcast committed scene batches over the room socket in production; retain
   replay for recovery rather than using polling as the normal live path.
6. Apply remote batches once through `updateScene()` after updating the adapter's
   known-revision ledger.
7. Keep presence ephemeral and session-keyed, but derive identity exclusively
   from authenticated socket state.
8. Preserve full tombstones initially and introduce compaction only behind
   snapshot epochs and deletion fences.

## Important limits

This experiment deliberately does not prove:

- the private Obsidian Excalidraw host seams for capture, remote apply, dirty
  suppression, or save materialization;
- binary file and nested-vault-resource synchronization;
- browser publication and share-grant security;
- multi-element binding atomicity under production message chunking;
- replay truncation, snapshot replacement, or tombstone compaction;
- revocation closure of already-connected Drawing DO sockets;
- cursor throttling and presence expiry;
- user gesture fidelity for every Excalidraw tool.

Programmatic `updateScene()` was used to create deterministic local revisions,
but those revisions traversed the real component's `onChange` callback and the
same adapter/DO/replay path as UI gestures. Separate headed gesture tests should
cover freehand strokes, bound text, arrows, frames, grouping, duplication,
multi-delete, and files after the protocol is implemented.

## Disposition

The temporary deployment is no longer required for this experiment. The
executable harness and captured `results.json` remain as reproducible spike
evidence. Future runs need either the same disposable worker contract or a local
equivalent exposing `/snapshot`, `/replay`, `/apply`, and `/ws`.
