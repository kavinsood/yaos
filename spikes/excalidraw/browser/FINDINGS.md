# Excalidraw Browser and Native-Model Spikes

Date: 2026-09-09

## Executive conclusion

Use the broad shape of `excalidraw-cloudflare`, not its protocol literally:

- one dedicated Drawing Durable Object per stable drawing identity;
- Excalidraw-native complete element records, not Yjs;
- native `version`, `versionNonce`, `isDeleted`, and fractional `index` fields;
- the official browser component's `onChange`, `onPointerUpdate`, `onPointerUp`, `getSceneElementsIncludingDeleted()`, `getAppState()`, and `updateScene()` seams;
- ephemeral native collaborator state for pointers, lasers, selections, and follow mode;
- separate binary-resource storage and publication policy.

The reference implementation proves that this architecture is feasible. It also exposes three protocol defects YAOS must not inherit:

1. its browser chooses the highest equal-version `versionNonce`, its server rejects all equal-version updates, and upstream Excalidraw 0.18.0 actually chooses the lowest nonce;
2. the client deliberately sends related elements as separate messages, exposing temporarily torn bindings and multi-element operations;
3. presence is keyed by user identity rather than a unique device/session identity, so a user's second device replaces the first.

The appropriate YAOS design is therefore **native Excalidraw records plus a YAOS-grade ordered, atomic, acknowledged room protocol**. A CRDT wrapper is unnecessary and would retain a second history/tombstone system around a format that already supplies its conflict metadata.

## Scope and method

The spike inspected, modeled, and tested:

- local change capture and remote application in `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx`;
- WebSocket queueing and reconnect behavior in `excalidraw-cloudflare/src/client/hooks/useWebSocket.ts`;
- element persistence and broadcasting in `excalidraw-cloudflare/src/worker/drawing.ts`;
- the main and shared browser clients;
- the pinned `@excalidraw/excalidraw` package contract in `excalidraw-cloudflare/package-lock.json`;
- complete-element reconciliation, equal-version conflict resolution, deletions, tombstone compaction, ordering, bindings, presence identities, and imperative API composition.

`run.mjs` is dependency-free and includes source-anchor assertions. If the reference source changes away from the behavior being modeled, the spike fails rather than silently becoming stale.

## Commands run

Successful executable model:

```sh
cd yaos
node --test spikes/excalidraw/browser/run.mjs
```

Result:

```text
tests 13
pass 13
fail 0
```

The cases cover:

1. complete records and native tombstones pass through capture;
2. `getSceneElementsIncludingDeleted()` plus `updateScene()` is sufficient for remote application;
3. strict server versioning creates an equal-version split brain;
4. the pinned upstream lower-nonce comparator converges peers;
5. version-only local capture suppresses same-version nonce changes;
6. deleting a persisted tombstone permits stale resurrection;
7. retaining a compact deletion fence prevents stale resurrection;
8. per-element delivery tears reciprocal bindings regardless of delivery order;
9. unique fractional indices produce the expected order;
10. duplicate indices preserve divergent input order under stable sorting;
11. native collaborators and follow state fit an ephemeral adapter;
12. actor-keyed presence overwrites a second device session;
13. the model remains anchored to the inspected reference source.

## Reference implementation evidence

### Capture is a supported browser seam

The React component directly exposes the necessary public hooks:

- `onChange={handleChange}`;
- `excalidrawAPI={(api) => setExcalidrawAPI(api)}`;
- `onPointerUpdate={throttledPointerUpdate}`;
- `onPointerUp={handlePointerUp}`.

See `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx:1222`.

`handleChange` receives complete element objects, app state, and binary files. It detects element mutations by version and queues the complete record. See `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx:570`.

This is the correct browser integration direction. YAOS does not need to patch upstream Excalidraw in its browser client.

### Remote apply is a supported browser seam

The reference client reads the scene including tombstones, reconciles incoming records, sorts by fractional index, and calls `updateScene({ elements })`. See `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx:702`.

This validates the fundamental browser adapter:

```text
native change callback -> YAOS batch -> Drawing DO -> canonical batch -> updateScene
```

It does not validate the private Obsidian-plugin integration seam; that is a separate host-adapter spike.

### Native presence is composable

The reference maps remote presence into Excalidraw's `collaborators` map and applies it through `updateScene({ collaborators })`. Pointer versus laser mode, button state, name, colors, and socket identity are accepted. See `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx:860`.

It also drives native follow state through `userToFollow`, `followedBy`, scroll offsets, and zoom. See `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx:932`.

The broad presence implementation is reusable. The transport payload should remain YAOS-owned, typed, authenticated, rate-limited, and ephemeral.

## Experiment findings

### 1. Equal-version reconciliation is a correctness blocker

The `excalidraw-cloudflare` browser's winner rule is:

```text
higher version wins
equal version: higher versionNonce wins
```

See `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx:722`.

The installed upstream `@excalidraw/excalidraw@0.18.0` publicly exports
`reconcileElements()`. Its `data/reconcile.ts` does the opposite:

```text
higher version wins
equal version: lower versionNonce wins
```

It additionally preserves the local element while that element is actively
being edited, resized, or created. That is a client interaction deferral rule,
not a server winner rule.

The reference server's SQL winner rule is only:

```sql
WHERE version < excluded.version
```

See `excalidraw-cloudflare/src/worker/drawing.ts:573`.

The executable counterexample:

1. peer A and peer B concurrently produce version 7 of the same element;
2. A has nonce 100, B has nonce 200;
3. A reaches the server first and is persisted;
4. B's equal version is rejected and is not broadcast;
5. B keeps its higher-nonce value under the reference browser rule, even though
   upstream would select A;
6. a late joiner receives A's lower-nonce value from durable storage.

The room is permanently split without a later edit.

**Decision:** use the pinned upstream reconciliation behavior rather than a
hand-written tuple rule. Server persistence must implement the durable subset of
the same lower-nonce winner rule; browser and Obsidian adapters should call the
public `reconcileElements()` utility where compatible. Active-editor deferral
remains local and must resolve after the interaction ends.

The durable revision key is at least:

```text
(version, versionNonce)
```

For adversarial or malformed clients, identical tuples with different canonical content must not be silently accepted. Reject the conflicting duplicate revision and force a canonical resync, or define a final deterministic canonical-content hash tie-break.

### 2. Multi-element changes require atomic transport batches

The reference client intentionally executes `sendElementUpdate([element])` for every pending element. See `excalidraw-cloudflare/src/client/pages/DrawingPage.tsx:526`.

The spike modeled deleting a bound rectangle while detaching its arrow. Both possible single-element delivery orders expose an invalid intermediate scene:

- deleting the rectangle first leaves the live arrow pointing at a deleted target;
- detaching the arrow first leaves the rectangle's `boundElements` claiming a non-reciprocal arrow.

Applying both complete records in one `updateScene()` preserves the invariant.

The same class includes:

- binding/unbinding arrows;
- bound text and container changes;
- grouping and ungrouping;
- frame membership changes;
- duplication of connected structures;
- multi-element deletes;
- z-order changes affecting several elements.

**Decision:** a logical Excalidraw change must be one room operation even if its wire representation is chunked for limits.

Suggested shape:

```text
operationId
documentEpoch
baseRoomSequence
chunkIndex / chunkCount, if needed
complete element records
resource intents
```

The Drawing DO assembles, validates, and commits the operation transactionally, assigns one monotonic room sequence, returns an idempotent receipt, and broadcasts one canonical batch. Receivers call `updateScene()` once for that batch.

Do not solve the 1 MiB message limit by weakening transaction boundaries. Chunk transport, not semantics.

### 3. Deletion needs tombstones, but not an unbounded second history

Excalidraw deletion is a versioned complete record with `isDeleted: true`. Removing that record outright allows an offline version 1 element to look new and resurrect after its version 2 deletion.

The spike proves two distinct requirements:

- active peers and reconnecting peers need the complete deletion record;
- durable conflict rejection eventually needs only a compact maximum deletion revision/fence.

**Decision:** initially store complete tombstones exactly as Excalidraw produces them. Add compaction only with explicit room epochs and snapshot/reconnect rules:

1. publish a canonical snapshot for room epoch N;
2. retain full tombstones through a defined compatibility/acknowledgement horizon;
3. compact old deleted element payloads to `{ elementId, version, versionNonce, deletedAtSequence }` fences;
4. reject updates at or below the fence;
5. require clients behind the retained operation horizon to replace from the canonical snapshot rather than replay arbitrary old state.

This preserves deletion safety without adopting Yjs's retained causal history or keeping every full deleted payload forever.

### 4. Fractional ordering works only while indices are valid and unique

Lexicographically sorting unique Excalidraw indices gave deterministic order in the spike. This is the correct normal case and should be preserved rather than replaced with a YAOS ordering scheme.

Equal indices are different: JavaScript's stable sort preserves each peer's prior array order, so two peers can retain different orders indefinitely. A local ID fallback converged the model, but it has not been shown to match Excalidraw's own index-repair semantics.

**Decision:** preserve native indices, validate them, detect collisions, and use the pinned Excalidraw reconciliation/index-repair behavior if it is available as a supported utility. Otherwise define a deterministic server normalization operation and test it against native rendering. Do not assume `sort(index)` alone establishes convergence.

### 5. Version-only capture is an origin-suppression shortcut

The reference capture map stores only `element.version`. Consequently a record whose `versionNonce` or content changes at the same version is not emitted locally.

This helps avoid echo after a remote `updateScene()` because the reference adapter updates its version map before applying. It also conflates two responsibilities:

- determining whether an element revision changed;
- suppressing callbacks caused by remote application.

The native React runtime probe settled the callback question: applying one element through `updateScene({ elements })` produced exactly one `onChange` event within 100 ms.

**Decision:** compare canonical revisions, and suppress remote-apply echo explicitly with an adapter apply scope/token. This is now a demonstrated requirement, not defensive speculation. Do not depend on ignoring all same-version changes.

### 6. Presence identity must be session-scoped

The reference Drawing DO stores connected users with `this.connectedUsers.set(userId, connectedUser)`. The browser also casts `userId` directly to Excalidraw `SocketId`.

A desktop and tablet belonging to the same actor therefore collapse into one presence entry. Disconnect and broadcast exclusion can target the wrong connection as well.

**Decision:** distinguish:

```text
actorId     stable authenticated person/member
deviceId    stable enrolled device
sessionId   unique live connection; Excalidraw SocketId
```

Key collaborator/presence state by `sessionId`. Attach trusted actor display data server-side. Multiple sessions may share name/color while retaining distinct cursors, selection, viewport, expiry, and disconnect handling.

### 7. Current presence coverage is useful but incomplete

Already demonstrated by the reference:

- pointer cursor;
- laser tool and button state;
- collaborator name and color;
- follower/followee signaling;
- viewport follow through scroll and zoom;
- removal on disconnect.

Not demonstrated in its browser wiring:

- remote selected element IDs;
- text caret/selection presence;
- idle/active state;
- explicit TTL expiry when a close event is lost;
- per-session identity;
- bounds and schema validation;
- server-side rate limiting/coalescing;
- backpressure behavior.

YAOS should send a versioned, surface-neutral presence envelope with an Excalidraw payload containing pointer, button/tool, selected element IDs, active text element/caret when obtainable, viewport, follow target, and interaction state. The server overwrites all identity fields and expires presence independently of durable scene history.

## What to copy and what to replace

### Copy the direction

- drawing-per-DO routing;
- native full-element records;
- native element revision metadata;
- native fractional ordering;
- `onChange` capture;
- `getSceneElementsIncludingDeleted()` reconciliation input;
- `updateScene()` application;
- native collaborators, laser, and follow UI;
- R2-style separation of binary resources from scene records;
- a separate browser surface for sharing.

### Replace the machinery

- strict-version-only SQL conflict handling;
- per-element WebSocket sends;
- wall-clock timestamps as reconnect cursors;
- pong as mutation durability acknowledgement;
- user-ID-keyed sockets;
- client-supplied mutation attribution;
- unbounded/unvalidated payloads;
- durable and ephemeral events sharing an untyped loose message union;
- implicit public access to resources referenced by a scene.

## YAOS target browser protocol

### Durable scene plane

The Drawing DO owns:

- stable drawing identity and document epoch;
- current canonical complete record for each live element;
- complete recent tombstones plus compact old deletion fences;
- monotonic committed room sequence;
- bounded operation/receipt deduplication;
- retained operation tail for resume;
- canonical snapshots for clients behind the tail;
- private resource manifest and durable publication metadata.

The server transaction for an operation should:

1. revalidate the authenticated actor and drawing grant;
2. validate epoch, operation ID, limits, element shape, and resource references;
3. compare every candidate with the canonical revision comparator;
4. preserve the operation batch as the unit of acceptance/application;
5. update element rows and tombstone fences atomically;
6. allocate one room sequence;
7. persist the idempotent receipt;
8. broadcast the canonical accepted batch;
9. acknowledge the sender with the assigned sequence and per-record disposition.

### Ephemeral presence plane

Presence uses the same Drawing DO/socket but is not persisted in scene history. It is keyed by session, authenticated, schema-bounded, coalesced, rate-limited, and expired. Durable scene backpressure must take priority over presence delivery.

### Browser adapter

The official React browser component should remain a thin host adapter:

1. capture native changes and files;
2. compute the changed record set plus dependency closure;
3. group it under one operation ID;
4. retain until a durable operation receipt;
5. reconcile canonical server batches with the shared comparator;
6. apply each batch once with `updateScene()`;
7. map ephemeral updates into native collaborators/app state;
8. never place presence or browser-local app state into the durable drawing.

## Native React runtime results

A real React probe under `spikes/excalidraw/browser/native/` mounted the exact pinned `@excalidraw/excalidraw@0.18.0` component in headless Chromium. It exposes browser-test controls for:

- applying remote element batches;
- reading elements including tombstones;
- applying native collaborators;
- recording `onChange`, `onPointerUpdate`, and `onPointerUp` events.

The executable browser driver is `spikes/excalidraw/browser/native/run-playwright.mjs`; the machine-readable result is `spikes/excalidraw/browser/native/results.json`.

Measured result:

```json
{
  "component": "@excalidraw/excalidraw@0.18.0",
  "mountMs": 912.46,
  "remoteApply": {
    "elementsObserved": 1,
    "onChangeEventsWithin100ms": 1
  },
  "presence": {
    "collaboratorCount": 1,
    "pointerCallbacksObserved": 4
  }
}
```

The run establishes that:

- the official component mounts successfully in a real browser;
- `updateScene({ elements })` accepts a native complete record;
- `getSceneElementsIncludingDeleted()` returns the applied record and preserves its `versionNonce`;
- remote programmatic apply invokes `onChange`, so an explicit remote-apply echo guard is mandatory;
- `updateScene({ collaborators })` accepts a session-keyed collaborator map containing pointer, laser, button, and selected-element data;
- real browser input produces both `onPointerUpdate` and `onPointerUp` callbacks.

The 912.46 ms number is a cold local dev-page readiness measurement, not a production performance budget. The collaborator assertion verifies accepted state (`getAppState().collaborators.size === 1`), not pixel-level rendering of every native presence affordance.

## Remaining native follow-up checks

Extend the now-working fixture to two mounted peers with Playwright:

1. Does the callback include deleted elements, and for how long?
2. Does `updateScene()` preserve the supplied `version`, `versionNonce`, `index`, bindings, and tombstones exactly?
3. Does Excalidraw repair duplicate/invalid indices automatically? If so, what new records appear in `onChange`?
4. Does applying a transactionally complete bound-element batch avoid all intermediate rendered tearing?
5. How does native reconciliation behave for equal `version` and different `versionNonce`?
6. Which collaborator fields visibly render selection outlines, cursor, laser, idle state, and follow UI in the pinned release?
7. Can active text/caret state be captured without private browser APIs?
8. Does `updateScene({ collaborators })` trigger durable `onChange`, and can it remain entirely ephemeral?
9. What are the real payload and render costs at 1, 10, 50, and 100 active peers?
10. What happens when a remote batch references a binary file before versus after `addFiles()`?
11. Do hidden/background browser tabs coalesce callbacks or produce reconnect bursts that change batching requirements?

These tests should be run both in Chromium and in Obsidian's Electron version. They are host-behavior validation, not reasons to reopen the already-settled DO/native-record architecture.

## Final verdict

There is no architectural reason to invent a different scene engine. The reference implementation has already found the correct center of gravity: **a dedicated drawing room holding Excalidraw-native complete records**.

YAOS should reuse that design, with four non-negotiable upgrades:

1. pinned upstream reconciliation semantics everywhere;
2. transactional multi-element operations with durable receipts and monotonic room sequences;
3. epoch-aware tombstone compaction backed by deletion fences and canonical snapshots;
4. session-scoped, authenticated, expiring presence.

That is materially simpler than Yjs, faithful to Excalidraw's own model, and strong enough for Obsidian-to-Obsidian collaboration, a first-party browser peer, and later public read/write sharing.
