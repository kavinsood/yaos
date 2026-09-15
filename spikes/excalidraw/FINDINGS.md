# Excalidraw collaboration spike synthesis

Date: 2026-09-09

## Verdict

Proceed with a dedicated Excalidraw subsystem. The architectural center is now
settled strongly enough to start production work:

- one Drawing Durable Object per stable drawing identity;
- complete native Excalidraw element records, not Yjs;
- one transactional room operation for each logical multi-element change;
- monotonic room sequences, replay, canonical snapshots, durable receipts, and
  native tombstones with later epoch-bound compaction;
- resources outside scene state;
- authenticated, session-scoped, ephemeral presence in the drawing room;
- explicit public resource publication, never recursive vault disclosure.

This deliberately copies the center of `excalidraw-cloudflare`. It does not copy
that project's protocol defects. Real React peers and deployed Durable Objects
have exercised the selected path end to end.

Production is not complete. In particular, the current source-level Obsidian
adapter conclusions still require a two-profile desktop trial and a mobile
trial, and public sharing still requires its actual grant gateway and resource
publication implementation.

## Most important findings

### The capture hook now exists

Current `obsidian-excalidraw-plugin` HEAD
`a601c3f470bf9dc5273cf1af074338f4ef265349` (manifest 2.27.3, bundled
`@zsviczian/excalidraw` 0.18.135) now includes `onSceneChangeHook`. It can track
element revisions, selected AppState keys, hidden views, files, and the owning
view. The original premise that YAOS must invent scene capture is out of date.

YAOS should chain that supported hook without replacing another consumer. The
root package version is stale at 2.2.5, so capability detection must decide
support instead of either version string. For the first release, versions
without the hook should require a plugin upgrade or remain attachment-only;
patching React or dirty/save internals is unnecessary.

The hook is the change signal, not the tombstone authority: on each relevant
callback the adapter snapshots
`view.excalidrawAPI.getSceneElementsIncludingDeleted()` before diffing. This
avoids assuming that every bundled fork retains deleted records in the hook's
element array.

### Remote apply is available, but origin handling remains YAOS's job

`ExcalidrawView.updateScene()` is public and forwards
`CaptureUpdateAction.NEVER`, which is the correct no-undo application seam. The
official browser component also accepts complete records through
`updateScene()` and preserves tombstones and revision metadata.

A real React runtime probe proved that programmatic `updateScene()` invokes
`onChange`: one remote apply produced one callback within 100 ms. The current
Obsidian view also independently compares scene versions and marks changed
scenes dirty. `CaptureUpdateAction.NEVER` therefore means "do not add this to
the undo store"; it does not mean "no callback" or "never materialize to disk."

YAOS needs revision-aware origin suppression. A temporal boolean is not enough:
if a user edit interleaves with a remote apply, the adapter must suppress only
the exact canonical remote revisions and still upload the extra local records.
Plugin dirty/autosave is useful for eventual local file projection. Promoted
Excalidraw paths must ignore that projection in generic file sync, while the
scene hook ignores the known remote origin. This prevents a network echo
without losing the required disk save.

### Native reconciliation uses the lower nonce

At equal element `version`, pinned upstream Excalidraw selects the **lower**
`versionNonce`. `excalidraw-cloudflare` does not match this: its browser selects
the higher nonce and its server rejects every equal-version candidate.

The counterexample produced a permanent split between an existing peer and a
late joiner. A real two-browser/deployed-room run then converged the Durable
Object and both React scenes on version 7, nonce 100 over nonce 200.

YAOS must generate conformance vectors from its pinned Excalidraw version and
apply them to the server, browser, Obsidian adapter, importer, and migration
tools. An identical `(version, versionNonce)` with different canonical content
is equivocation and should force rejection/resync rather than arrival-order
choice.

### Atomic batches are required

The reference sends related elements separately. The executable binding model
showed that both possible delivery orders for a rectangle deletion and arrow
detach expose a torn scene. Grouping, frames, bound text, duplication, and
z-order have the same problem.

One logical gesture must receive one operation ID, one durable transaction, one
room sequence, one receipt, and one receiver-side `updateScene()` call. Oversize
operations may be transport-chunked but may not become multiple semantic
commits. Per-record reconciliation can still reject stale candidates; the room
must validate the resulting canonical dependency closure or reject the
operation if a partial winner set would violate coupled invariants.

### Recursive resource sharing is catastrophically unsafe

The seven-level branching-three fixture expanded one drawing to 3,280 vault
objects. Naive traversal leaked 729 private back-of-card fixtures. An explicit
two-resource manifest leaked none and rejected hash substitution, cross-drawing
access, stale grants, private locators, and manifest overflow.

Public publication must materialize owner-approved immutable artifacts into a
share namespace. Public identifiers never reveal vault paths or object IDs.
Nested drawings and Markdown embeds default to sanitized render artifacts, not
source publication. Browser uploads enter quarantine scoped to the drawing and
share; they never become arbitrary vault files automatically.

### A Drawing DO is feasible, including exact authority ordering

A disposable production Worker used one SQLite Drawing DO and one vault
authority DO. It passed native conflict resolution, retained tombstones,
durable receipt replay, monotonic replay, hibernatable socket APIs, distinct
sessions for one actor, trusted presence attribution, and 10,000 elements in 40
transactional batches.

The authority reservation experiment survived response loss: a mutation
reserved before revocation remained recoverable, while a new stale mutation
after the fence was rejected. This is the correct ordering contract. It costs a
cross-DO authority turn for each previously unseen operation and must be
measured before considering any lease optimization.

The deployed 10,000-element apply took 6,646.50 ms across 40 requests. A
1,456,702-byte snapshot took approximately 0.5 seconds at the driver. These are
single-run feasibility observations, not SLOs; they require compressed and
bounded snapshot delivery with incremental replay as the normal path.

## End-to-end browser result

Two isolated system-Chrome contexts mounted real
`@excalidraw/excalidraw@0.18.0` components against the deployed room. The run
passed:

- empty bootstrap and first native `onChange` commit;
- mutation convergence between peers;
- lower-nonce equal-version convergence;
- native tombstone retention;
- disconnect and monotonic replay recovery;
- remote `updateScene()` callback suppression with zero outbound writes;
- two sessions for one actor, with spoofed presence identity overwritten.

Measured equal-version convergence was 212.47 ms and reconnect replay was
219.19 ms. The disposable harness polled scene replay every 75 ms because its
minimal Worker only broadcast presence; production scene commits should use the
same authenticated hibernatable socket and retain replay for loss recovery.

## Spike ledger

| Spike | Evidence | Status before production |
| --- | --- | --- |
| 0. Upstream and format inventory | Current plugin/fork versions, browser APIs, native revision behavior, and reference source pinned | Add supported historical plugin matrix and representative field-vault formats |
| 1. Obsidian object graph | Capture hook, view API, dynamic `onChange`, save/dirty path, semaphores, and resource seams mapped in source | Run the adapter inside real desktop, split/pop-out, and mobile views |
| 2. Local capture | Supported hook found; real browser callbacks and complete-record diff model exercised | Measure missed/duplicate events during freehand, text, undo, images, backgrounding, and reload in Obsidian |
| 3. Remote apply | Real `updateScene()` apply, callback echo, explicit suppression, and no-write E2E exercised | Prove no undo pollution, interleaved local-edit preservation, and bounded file projection in Obsidian |
| 4. Closed-file round trip | Architecture retains attachment fallback and separates semantic projection | Build JSON, Markdown-backed, compressed, legacy, malformed, and future-field fixture corpus; compare real plugin save |
| 5. Merge model | Deterministic models, counterexamples, fuzzing, tombstones, deployed room, and two-browser convergence | Pin index repair, binding closure, unknown element, long-offline, and compaction vectors to plugin fork |
| 6. Resources/privacy | Executable deep graph and explicit-manifest attack suite passed | Exercise actual plugin `files`, `addFiles()`, vault embeds, inbound upload, and missing-resource UX |
| 7. Presence | Native collaborator map, pointer callbacks, trusted session identity, lasers/follow direction exercised | Validate visual fields, text caret availability, TTL/rate/backpressure, Obsidian pointer conversion, and peer scale |
| 8. DO topology/load | Local model plus disposable deployed SQLite DO, cross-DO fence, sockets, and 10k load exercised | Observe true eviction/hibernation, parallel hot rooms, R2 faults, snapshot limits, and lifecycle repair |
| 9. Browser boundary | Two real same-vault browser peers completed the room loop | Implement real ticket exchange, read-only enforcement, public identifier redaction, downgrade, expiry, and resources |
| 10. Lifecycle/faults | Idempotent replay, response loss at authority fence, reconnect, restart, compaction, and revocation covered in models | Complete rename/path reuse/promotion/demotion/plugin lifecycle/R2/deploy rollback matrix |
| 11. Performance | Native mount, remote callback, deployed 10k scene, convergence, snapshot, and reconnect measured | Record gesture batching, long tasks, memory, image-heavy scenes, 50/100 peers, Electron, and mobile baselines |

The ledger separates architecture-selection evidence from release evidence. The
remaining rows do not reopen the no-Yjs or drawing-per-DO decisions; they gate
adapter support, limits, and rollout.

## Production architecture

### Durable scene plane

The Drawing DO is addressed by stable vault generation plus drawing identity,
never by mutable path. SQLite stores canonical complete element records, recent
complete tombstones, compact old deletion fences, room epoch and sequence,
bounded operation receipts keyed by request hash, replay tail, snapshot
metadata, private resource manifest metadata, and share-publication revision.

For a new operation it must:

1. validate the ticket, exact authority stamp, epoch, operation hash, sizes,
   element shapes, and resource references;
2. reserve the operation against the vault authority before the revocation
   fence can pass it;
3. reconcile every record with version-pinned native semantics;
4. validate the resulting coupled-element closure;
5. commit records, fences, one room sequence, replay entry, and receipt in one
   SQLite transaction;
6. acknowledge with per-record dispositions and broadcast one canonical batch.

A retry with the same operation ID and hash receives its original result. The
same ID with a different hash is rejected as equivocation. Clients behind the
replay horizon replace from a canonical epoch snapshot.

### Resource plane

Scene records carry Excalidraw file IDs and bounded metadata, not binary bodies.
Immutable content uses YAOS CAS/R2. Same-vault peers resolve authorized vault
references locally and fetch missing embedded binaries by content identity.
Receivers install required binaries through `addFiles()` before applying scene
records that reference them.

Public shares use a separate, immutable publication manifest bound to share ID,
drawing ID, grant revision, public resource ID, exact hash, count, bytes, and
expiry. Revocation makes the old manifest unreadable even if its opaque IDs are
known.

### Presence plane

Presence shares the Drawing DO socket but not durable scene storage. The common
YAOS envelope is format-neutral; the Excalidraw payload contains bounded
pointer/tool/button, laser, selected IDs, active editing state where available,
viewport, and follow target.

The server derives actor identity from the socket attachment, keys entries by
unique session ID, rate-limits and coalesces, applies TTL expiry, and drops
presence before durable scene traffic under backpressure. A separate Presence
DO would add routing and lifecycle failure modes without supplying useful
authority.

### Obsidian host adapter

The adapter should use descending capability tiers:

1. chain `onSceneChangeHook` and use public `updateScene()` with
   `CaptureUpdateAction.NEVER`;
2. wrap each view's public `onPointerUpdate()` only for rate-limited presence,
   restoring the exact original on detach;
3. use save observation only as a definitive projection/checkpoint backstop;
4. require a plugin upgrade or leave the file attachment-authoritative if the
   scene hook, apply, format, or
   preservation proofs fail.

Capture diffs complete records by `(id, version, versionNonce, canonical hash)`,
adds binding/container/frame dependency closure, persists an outbox operation,
and uploads until a durable receipt. Apply reconciles against the live scene,
defers destructive interaction conflicts, records the exact expected remote
revision set, calls `updateScene()` once, suppresses only those revisions in the
following callback, and leaves interleaved local revisions pending for upload.

Capability and plugin-version checks must fail closed. Every wrapper is
restored on view unload/plugin disable. No React-fiber or DOM mutation traversal
is needed.

## Build order

1. Freeze native reconciliation/index/format conformance vectors and the room,
   authority, resource, presence, and host-adapter protocol RFC.
2. Implement the production Drawing DO, vault reservation endpoint, schema
   limits, receipts, replay/snapshot, tombstone policy, and scene WebSockets.
3. Implement semantic Excalidraw identity, promotion/demotion, closed-file
   parser/materializer, attachment fallback, and resource accounting.
4. Implement the Obsidian live adapter and same-vault outbox/recovery loop;
   validate two real desktop profiles before presence.
5. Add the generic presence kernel and Excalidraw collaborators, lasers,
   selections, viewport, and follow behavior.
6. Add the authenticated same-vault browser peer using the official React
   component.
7. Add public read-only publication with explicit manifests, redacted IDs,
   expiry, downgrade, and revocation.
8. Add public editing only after inbound resource quarantine and in-flight write
   fencing pass deployed adversarial tests.
9. Run mobile, performance, lifecycle, rollback, and demotion gates; then field
   roll out opt-in.
10. Revisit Canvas presence using the proven kernel after Excalidraw ships.

## Retained evidence

- `browser/FINDINGS.md`: reference audit, merge counterexamples, and real native
  React probe.
- `server/FINDINGS.md`: pure room model and local Wrangler/SQLite DO results.
- `deployed/FINDINGS.md`: disposable production Durable Object, authority, load,
  and cleanup results.
- `e2e/FINDINGS.md`: two real React browser contexts against the deployed room.
- `resources/FINDINGS.md`: recursive-disclosure counterexample and explicit
  manifest attack suite.
- `host/FINDINGS.md`: current Obsidian plugin object graph and adapter seams.

The disposable Worker and exact-host Access application were removed after the
run. The experimental hostname no longer resolves.
