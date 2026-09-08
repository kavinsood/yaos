# Canvas semantic synchronization implementation report

The JSON Canvas 1.0 semantic plane is implemented for schema 8, storage format
4, socket protocol 5, and recovery format 3. It remains opt-in per file.
Attachment authority remains the fallback for invalid, unsupported, oversized,
excluded, or unpromoted `.canvas` files.

## Shipped contract

- `pathToSemantic` is server-owned and mutually exclusive with Markdown and attachment authority. Stable Canvas identity survives ordinary renames.
- The shared bounded codec preserves root/item extensions, canonicalizes JSON, validates JSON Canvas limits, and keeps node and edge order explicit.
- The Canvas Yjs representation separates coherent geometry, size, endpoint, payload, decoration, optional, text, extension, ordering, tombstone, and resolved-conflict state.
- Three-way projection merge uses an exact local settlement when available, preserves conflicting local bytes before choosing shared values, retains edit/delete evidence, and internally retains dangling edges.
- Semantic candidates and lifecycle operations are persisted locally before submission, replay exact identities after restart or transient failure, and clear only on matching durable receipts.
- Each active Canvas owns at most one semantic WebSocket provider across split views. Pending peer updates project immediately, providers release when the last view closes, application-level liveness covers them, and durable HTTP candidates/receipts remain the settlement authority.
- Server candidates and socket frames use a resident authoritative document plus a private validation mirror. SQLite commits the exact bounded binary update before live state advances or peers see it; failure rebuilds the mirror without contaminating live state.
- Canvas carries a body-like semantic epoch through state, candidates, receipts, tickets, sockets, bootstrap, catalogs, feed, and client persistence. Genuine compaction rebuilds a fresh Y.Doc from canonical Canvas JSON, fences stale clients, and semantically rebases offline JSON intent instead of accepting retired Yjs identities.
- Promotion consumes an exact attachment revision while retaining that exact blob as rollback material. Demotion uploads canonical semantic bytes before switching authority. Both transitions are idempotent and transaction-time fenced by exact root, catalog, and document heads.
- Bootstrap, ordered feed, recovery capture/read/restore, recovery GC, retained rollback blobs, Cloudflare storage, Node storage, and headless closed-file projection are kind-aware.
- The Obsidian host adapter is the sole private Canvas boundary. It proves file/view/load ownership, blocks unproven open views, updates every owned split view once per batch, suppresses observer echo, and preserves active text conservatively.
- Canvas residency is bounded and reports encoded, structural, text, order, tombstone, conflict, pending, invalid, oversized, and degraded estimates.
- Public API counts are immutable observations only; no Canvas contents, Y.Docs, credentials, providers, or mutation methods are exposed.

## Operator workflow

Schema 8 is a greenfield reinstall boundary; there is no schema-7 or storage-3
migration endpoint. Existing ordinary `.canvas` files are imported under fresh
authority. The active-file **Promote Canvas to semantic sync** and **Return
Canvas to attachment sync** commands perform the only authority switches in
this release.

Promotion is rejected if attachment bytes, revision, hash, size, object
existence, path authority, root generation, or semantic validation changed.
Demotion is rejected if semantic generation, hash, size, catalog, root, or
uploaded object changed. Repeating a completed operation returns its exact
receipt; reusing its identity with different input is rejected.

## Safe degradation

- Invalid or oversized local bytes are never overwritten by remote refresh.
- A conflict artifact write failure blocks convergence rather than discarding the local alternative.
- A Canvas open in an unrecognized or unproven host view blocks disk writes.
- Divergent owned split views block remote application until local capture resolves them.
- Without R2, semantic Canvas remains usable, while promotion, demotion, synchronized opaque fallback, and remote conflict artifacts that require R2 report their unavailable state.

## Automated evidence

The implementation is covered by the pure Canvas core, Canvas manager and live-provider lifecycle,
projection router, host adapter, semantic server hardening, real-SQLite
authority race, epoch reset/rebase, bootstrap, recovery, public API, Node runtime,
headless, regression, and Cloudflare/Node conformance suites. Both runtimes prove semantic socket admission, pending peer relay, and durable socket flush. Promotion and
demotion tests prove exact replay, rollback reachability, cross-authority
exclusivity, stale root rejection, and absence of partial receipts/documents.

## External release gates

Automation does not manufacture host or deployment evidence. Default semantic
creation and vault-wide promotion remain disabled until the field matrix in
`canvas-semantic-sync-plan.md` records supported Obsidian desktop/mobile host
shapes, suspension/restart, two-device offline convergence, large-canvas
interaction latency, Cloudflare hibernation/reconnect, and a rollback rehearsal.
The embedded Markdown child-editor optimization and direct CM6 binding remain
capability-gated enhancements; correctness does not depend on either private
surface being present.
