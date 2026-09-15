# Drawing room core and local runtime findings

Date: 2026-09-09

## Verdict

A dedicated native-record Drawing Durable Object fits YAOS. The pure model and
local Wrangler/Miniflare SQLite runtime passed the core contracts needed before
production integration:

- complete element records and retained native tombstones;
- upstream-compatible lower-`versionNonce` selection at equal `version`;
- one monotonic room sequence/event for a multi-element operation;
- request-digest-bound durable receipts and equivocation rejection;
- before-commit and lost-after-commit retry behavior;
- exact authority stamps and stale-session rejection;
- snapshot/replay compaction boundaries;
- session-scoped, identity-trusted, bounded, expiring presence;
- durable SQLite state across a local Worker restart;
- hibernatable WebSocket attachment and enumeration APIs.

The experiments validate the ownership and protocol shape. They are not a
production room implementation: complete Excalidraw schema validation, binding
closure, transport chunk assembly, cross-DO authority reservation, retained
snapshot policy, resource publication, and lifecycle repair remain production
work.

## Pure model

Run:

```sh
node --experimental-strip-types \
  spikes/excalidraw/server/core-experiments.ts
```

The successful rerun covered deterministic contracts, 250 randomized traces,
six permutations per trace, and 24 candidates per trace. All permutations
converged. A three-round 10,000-element load produced a 1,763,189-byte JSON
snapshot and completed in approximately 4.5 seconds on this workstation. That
number includes intentionally simple full-state cloning per operation and is a
model stress observation, not a server SLO.

The model deliberately gives equal revision tuples a canonical payload order so
permutation fuzzing has a total order. Production should be stricter: two
different canonical payloads with the same `(id, version, versionNonce)` should
be rejected as an invalid/equivocating revision and trigger canonical resync.

## Local Durable Object runtime

Run:

```sh
node spikes/excalidraw/server/runtime-experiment.mjs
```

The successful local Wrangler/Miniflare/workerd run inserted 2,000 SQLite rows
in ten batches in 41.8 ms, replayed a durable receipt, rejected operation-ID
equivocation, selected nonce 1 over nonce 10,000 at equal version, preserved
state across a Worker restart, relayed authenticated presence between two
sessions for one actor, enumerated a live hibernatable socket during authority
replacement, and compacted the replay table.

Miniflare reported one live hibernatable socket and the room invoked
`close(4003, "authority changed")`, but the Node `ws` client did not deliver a
close event. The retained test therefore asserts server enumeration and close
invocation, not end-client close delivery. Deployed revocation tests must assert
the actual close code, ticket rejection, in-flight mutation fence, and reconnect
failure before this becomes release evidence.

## Protocol conclusions

### Reconciliation

Higher element version wins. At equal version, lower nonce wins. Server
conformance vectors must be generated from the pinned bundled Excalidraw fork
rather than relying on another handwritten comparator. Index normalization and
active-editor deferral are separate adapter concerns.

### Operation atomicity

One logical gesture is one operation and room sequence even if it contains many
elements. SQLite transactionality and receiver-side single-call application
prevent transport-level tearing. Because native reconciliation may make only a
subset of candidates winners, production must validate the resulting canonical
binding/container/frame closure or reject an operation whose partial winner set
would leave an invalid scene.

### Receipts and faults

Receipts bind operation ID to a canonical request digest. A retry after response
loss returns the committed receipt. Reusing an operation ID with different
content is a conflict, not idempotence. Receipts, element rows, replay entry,
and the assigned sequence belong in one SQLite transaction.

### Authority

The local room stamp proves cheap stale-epoch rejection but does not itself
order writes against a Vault-DO revocation. The deployed authority-reservation
experiment supplies that proof. Production combines both: a room-local exact
stamp plus a Vault-DO reservation for each previously unseen durable operation.

### Presence

Presence is keyed by unique session ID, while actor and device identity come
from the authenticated socket attachment. It is schema-bounded, deduplicates
selected IDs, validates coordinates/zoom, expires independently of scene
history, and is discarded when authority changes. Production adds rate limits,
coalescing, byte/backpressure budgets, alarms/TTL cleanup, and durable-traffic
priority.

## Files

- `room-core.ts`: dependency-free model.
- `core-experiments.ts`: deterministic, fault, randomized convergence, and load
  driver.
- `worker.ts`: disposable SQLite/hibernatable-WebSocket Durable Object.
- `runtime-experiment.mjs`: local Wrangler restart and protocol driver.
- `wrangler.toml`: local-only spike configuration.
