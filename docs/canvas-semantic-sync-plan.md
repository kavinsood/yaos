# Canvas semantic synchronization

Status: proposed implementation plan.

This document specifies the complete Canvas feature: durable semantic authority,
closed-file synchronization, live Obsidian Canvas projection, conflict handling,
bootstrap, recovery, resource policy, migration, observability, and validation.
It deliberately reuses YAOS's correctness substrate without introducing a
generic structured-document merge model.

## Decision

Promote supported `.canvas` files from whole-file attachment CAS to a dedicated
semantic document. Each Canvas has one stable identity independent of its path
and one Yjs document containing nodes, edges, ordering, retained deletion
evidence, and unknown JSON fields.

Canvas reuses:

- durable operation and candidate identity;
- exact receipts, vault sequence, and currentness evidence;
- server-published root structure;
- local persistent queues and common-base CAS;
- projection leases and revision-fenced effects;
- bounded residency, overdue-work scheduling, bootstrap, and recovery;
- preservation-before-convergence and whole-file attachment fallback.

Canvas does not reuse Markdown's text model, frontmatter model, or conflict
engine as its document model. Markdown diff3 is used only for the text-bearing
fields for which it is semantically valid.

The feature requires a document-schema and socket-protocol cutover. Adding a
new root map while older clients can still treat the same path as an attachment
would create two authorities. Mixed semantic and attachment writers are never
admitted.

### Proposed version pins

| Boundary | Proposed version |
| --- | ---: |
| Document schema | 8 |
| Durable SQL storage format | 3 |
| Socket protocol | 4 |
| Bootstrap format | 2 |
| Recovery snapshot format | 3 |
| Canvas semantic representation | 1 |
| JSON Canvas adapter | 1.0 |
| Canvas canonical codec | 1 |

Settings format remains unchanged. These values are planning pins; the
implementation must update every shared version declaration, compatibility
matrix, release guard, fixture, and server/client admission check in one
cutover.

## Product scope

### Goals

- Concurrent edits to different nodes, edges, and field groups survive.
- Text-node edits use character-level CRDT behavior while live and bounded
  three-way merge when reconciling an external serialized file.
- Node z-order is synchronized explicitly and deterministically.
- Renames retain Canvas identity; path reuse never inherits old content.
- Deletes cannot be undone by a stale complete-file upload.
- Concurrent edit/delete retains the edit, records the resolved conflict, and
  allows a later delete made against the edited item to win.
- Unknown top-level and item fields survive parse, synchronization, and write.
- Open Canvas views and closed disk files are both supported authorities.
- A reused Obsidian view can never move content between Canvas files.
- Unsupported, invalid, or oversized canvases remain on attachment CAS.
- Bootstrap, catch-up, recovery, Node/headless operation, mobile suspension,
  teardown, and resource pressure have explicit behavior.

### Non-goals

- Collaborative cursors, selections, laser pointers, or viewport following.
- Synchronizing the rendered contents of referenced Markdown, media, or nested
  canvases as part of the Canvas document. Those remain independent vault files.
- Recursively restoring or sharing a Canvas dependency graph.
- Byte-for-byte preservation of whitespace, object-key order, or indentation.
  Semantic JSON values and Canvas array order are preserved.
- Automatic semantic promotion of data above the semantic hard limits.
- A generic engine whose merge rules are assumed to fit Canvas, Base, and
  Excalidraw. Only lifecycle and durability infrastructure is shared.

## Normative format basis

The initial adapter targets JSON Canvas 1.0. Its semantic facts include:

- top-level `nodes` and `edges` arrays;
- node identity by `id`;
- node types `text`, `file`, `link`, and `group`;
- required node geometry `x`, `y`, `width`, and `height`;
- node array order in ascending z-index order;
- edge identity by `id` and relationships through `fromNode` and `toNode`;
- optional endpoint sides, endpoint shapes, colors, labels, subpaths, group
  backgrounds, and background styles.

The canonical specification makes node order meaningful. It is not an
implementation detail to be inferred from Y.Map iteration. Edge order is not
given rendering semantics by JSON Canvas 1.0, but YAOS preserves it for
round-trip fidelity and future extension safety.

Obsidian's actual desktop and mobile serializers must be probed before the
validator is frozen. In particular, tests must establish whether transient
geometry can be non-integral, which private methods exist on each host, and how
unknown fields are retained by Obsidian itself.

## Invariants

1. A path has at most one active authority: Markdown, semantic format, or
   attachment.
2. A Canvas identity belongs to at most one active path.
3. Path is projection metadata; Canvas identity is durable identity.
4. Root sockets cannot mutate semantic catalog maps.
5. A Canvas candidate is durable only after exact candidate identity, digest,
   semantic validation, catalog metadata, journal update, and receipt commit in
   one serialized server mutation.
6. Retry never rebases a candidate silently or changes its payload.
7. Every disk or view effect carries runtime, document, content, lifecycle,
   path, projection-owner, and host-view proofs appropriate to that effect.
8. A disk projection and a live-view projection cannot simultaneously own the
   same Canvas.
9. Absence without a trusted base is not evidence of deletion.
10. A malformed or unreadable file is uncertainty, not permission to overwrite.
11. Node and edge identifiers are scoped to one Canvas identity.
12. Node order is part of semantic equality.
13. Unknown JSON values are bounded and preserved; unknown executable behavior
    is never inferred.
14. Dangling edges remain recoverable in semantic state but are not emitted into
    the active materialized Canvas until both endpoints exist.
15. A semantic conflict is never resolved by discarding the losing value before
    preserving it or proving it reconstructible.
16. A Canvas common base advances only after server state, semantic document,
    and the owning local projection agree.
17. Unsupported clients cannot connect to a vault containing semantic Canvas
    authority.

## Root and catalog model

### Root map

Add a server-owned `pathToSemantic` map:

```ts
interface SemanticPathRef {
	documentId: string;
	kind: "canvas";
	format: "json-canvas";
	formatVersion: 1;
}
```

`pathToSemantic`, `pathToId`, and `pathToBlob` must be mutually exclusive by
path. The server validates the complete root after every publication and rejects
any overlap. Semantic content generations do not update the root; the root
changes only for create, rename, delete, revive, promote, and demote operations.

The semantic path map is generic only as a structural catalog. It does not imply
that different semantic formats share representation or merge rules.

### SQL catalog

Add semantic catalog events rather than overloading Markdown body assumptions:

```text
vault_semantic_catalog_events
  sequence
  document_id
  file_id
  kind
  format
  format_version
  path
  previous_path
  lifecycle = active | tombstoned | reaped
  generation
  content_hash
  size
  mutation_index
```

The current head is derived by greatest sequence at or before the requested
boundary. A unique active-path constraint is enforced in mutation logic because
historical event rows intentionally repeat paths.

Add separate semantic candidate receipts and creation fences so existing body
tables retain their Markdown meaning:

```text
vault_semantic_candidate_receipts
vault_semantic_creation_candidates
vault_semantic_lifecycle_receipts
```

Every receipt includes document kind and format pins in addition to candidate
identity, durable generation, vault sequence, vault generation, runtime epoch,
principal, and device attribution.

### Lifecycle operations

Semantic lifecycle supports:

- `create`;
- `rename`;
- `delete`;
- `revive`;
- `promote_attachment`;
- `demote_attachment`.

Promotion atomically verifies the expected attachment revision and hash,
installs the initial Canvas document and semantic catalog head, removes the blob
path reference, and publishes one root update. Demotion first materializes and
uploads the exact current canonical Canvas bytes, then atomically performs the
inverse root/catalog transition.

## Canvas Yjs document

### Roots

Each Canvas uses one Y.Doc with these roots:

```text
canvasMeta             Y.Map
rootFields             Y.Map<JsonValue>
nodes                  Y.Map<Y.Map>
nodeOrder              Y.Map<string>
nodeTombstones         Y.Map<CanvasItemTombstone>
edges                  Y.Map<Y.Map>
edgeOrder              Y.Map<string>
edgeTombstones         Y.Map<CanvasItemTombstone>
resolvedConflicts      Y.Map<CanvasResolvedConflict>
```

`canvasMeta` pins the representation and is not serialized into the `.canvas`
file:

```ts
interface CanvasMeta {
	format: "yaos-json-canvas";
	representationVersion: 1;
	jsonCanvasVersion: "1.0";
}
```

The document must contain an enrollment marker even for `{}` so an empty
enrolled Canvas is distinguishable from a missing or never-initialized document.

### Node representation

Each node is a nested Y.Map. Coherent values are atomic JSON values:

```text
identity/type payload  { type, type-specific known fields except text }
position               { x, y }
size                   { width, height }
color                   string | explicit-absent
text                    Y.Text, only semantically active for text nodes
extensions              Y.Map<JsonValue>, one register per unknown key
```

The type payload keeps a type change and its required fields atomic. A file
node's `file` and `subpath` are one coherent payload. A group's `label`,
`background`, and `backgroundStyle` are grouped. Unknown keys never overwrite
known fields and remain independently mergeable by key.

Position and size are separate because a concurrent move and resize are valid
to combine. Coordinates within one move and dimensions within one resize are
atomic, preventing torn `{x,y}` or `{width,height}` pairs.

### Edge representation

Each edge is a nested Y.Map:

```text
endpoints               { fromNode, fromSide?, toNode, toSide? }
decorations             { fromEnd?, toEnd? }
color                   string | explicit-absent
label                   string | explicit-absent
extensions              Y.Map<JsonValue>
```

Both endpoints are one relationship group. YAOS never constructs an edge with
the source from one concurrent mutation and destination from another.

### Optional values

Known optional values distinguish absence from JSON `null`. The codec uses an
internal explicit-absent representation where a Y.Map deletion would otherwise
make a concurrent set ambiguous. JSON `undefined`, functions, symbols,
non-finite numbers, typed arrays, and host objects are rejected.

### Ordering

`nodeOrder` and `edgeOrder` store bounded fractional rank strings by item ID.
Materialization sorts by `(rank, itemId)`. The ID tie-break makes malformed or
concurrently colliding ranks deterministic without claiming the collision is
semantically ideal.

On disk/view ingestion:

1. retain ranks for the longest order-preserving subsequence of existing IDs;
2. allocate ranks between retained neighbors for additions and moved items;
3. make no rank mutation for formatting-only or field-only changes;
4. schedule deterministic rebalance when a rank exceeds its byte bound;
5. perform rebalance only while the document is clean and under one fenced
   candidate transaction.

Rebalance changes representation but not materialized order. It is observable
and resource-bounded.

### Deletion and tombstones

Deleting an item does not immediately destroy its last payload. It writes:

```ts
interface CanvasItemTombstone {
	operationId: string;
	baseSemanticHash: string;
	deletedAt: number; // diagnostic only
	lastOrderRank: string | null;
}
```

The base hash is the exact item observed by the deleter, including its order
rank. Materialization follows:

- current item hash equals tombstone base hash: deletion wins;
- current item hash differs: an edit/delete race occurred; the edited item
  remains visible, the deletion becomes a bounded resolved-conflict record, and
  normalization removes that tombstone;
- a later deletion observes the edited hash and therefore wins normally;
- explicit revival removes the matching tombstone under a new operation ID.

This retains edits without making every deletion permanently edit-wins.
Incident edges are tombstoned in the same local transaction when Obsidian
removes them. Remote dangling edges remain internally retained and are marked
`blocked_by_endpoint` rather than discarded.

Tombstone payloads may be compacted after the retention boundary, but the
tombstone and base hash remain. An old exact payload arriving later still
matches the deletion base and remains deleted; an actual offline edit differs
and is preserved as an edit/delete race.

`resolvedConflicts` is bounded, contains no unbounded history, and is not emitted
to disk. Recovery snapshots preserve visible content, not this diagnostic log.

## Codec and validation

### Parsing

The parser has typed outcomes:

- `valid` with normalized semantic data and preserved extensions;
- `unsupported` with a stable reason;
- `invalid` with a stable reason;
- `oversized` with measured bounds.

Blank content and `{}` are valid empty canvases. Invalid JSON, non-object roots,
non-array `nodes` or `edges`, duplicate IDs, missing required fields, invalid
references, excessive nesting, and values outside bounds are not silently
normalized.

Unknown node types are preserved only when they satisfy bounded generic node
identity and geometry. They are never assigned invented required semantics.

### Canonical semantic bytes

The content hash is over a canonical semantic encoding:

- root object keys sorted;
- node array in synchronized z-order;
- edge array in synchronized preserved order;
- object keys recursively sorted;
- strings encoded as UTF-8 without normalization;
- finite JSON numbers encoded consistently;
- no insignificant whitespace.

Disk formatting is a separate concern. The formatter should match current
Obsidian output where practical, end with one newline if Obsidian does, and
remain deterministic. Semantic equality never depends on presentation bytes.

A formatting-only external rewrite advances the disk fingerprint and common
base observation without publishing a semantic candidate or immediately
rewriting the user's formatting.

### Proposed initial limits

The first release must stay below the existing single-candidate durable bound.
Proposed starting limits, subject to fixture and deployed calibration:

- canonical semantic JSON: 1 MiB;
- encoded Yjs candidate: existing 1,750,000-byte hard limit;
- nodes: 20,000;
- edges: 40,000;
- one text or label value: 256 KiB;
- aggregate text: 1 MiB;
- JSON nesting depth: 32;
- one identifier: 1 KiB UTF-8;
- one rank: 128 bytes;
- one unknown field value: 256 KiB;
- resolved conflict records: 1,000 per Canvas before compaction.

These are semantic-admission limits, not attachment limits. A valid Canvas above
them stays on the existing attachment plane up to the attachment limit. Raising
the semantic limit later requires measured candidate chunking and recovery
bounds, not merely increasing an HTTP constant.

### Shared validation

Canonical model, limits, and Yjs-root validation live in shared pure modules
used by client, Cloudflare server, and Node server. The server validates:

- every socket update against a reconstructed candidate document before it can
  enter the pending cache;
- every durable candidate after applying it to the current durable state;
- canonical materialization, content hash, size, and catalog kind;
- tombstone, ordering, endpoint, extension, and bound invariants.

An invalid live update closes only the offending semantic socket and cannot
poison durable state.

## Merge semantics

There are two merge layers.

### Live peer merge

Yjs merges mutations to the semantic document:

- different items merge independently;
- different field groups on one item merge independently;
- text nodes merge through Y.Text;
- the same atomic group uses Yjs's deterministic register winner;
- deletion is interpreted through the retained base-hash rule;
- rank collisions are ordered deterministically.

This guarantees convergence, not preservation of two incompatible edits to the
same atomic geometry group. YAOS must not claim otherwise.

### Disk/view three-way merge

Serialized projection reconciliation uses exact common base `B`, current shared
semantic state `S`, and local disk or view state `L`.

Item behavior:

| Base | Shared | Local | Result |
| --- | --- | --- | --- |
| absent | added | absent | shared addition |
| absent | absent | added | local addition |
| absent | different additions with same ID | both | identity conflict |
| present | deleted | unchanged | delete |
| present | unchanged | deleted | delete |
| present | deleted | edited | keep edit, record edit/delete resolution |
| present | edited | deleted | keep edit, record edit/delete resolution |
| present | deleted | deleted | delete |
| present | edited | edited | merge by field group |

Field-group behavior:

- unchanged/same: no conflict;
- changed on one side: take that side;
- different groups changed: combine;
- text changed on both: bounded text diff3;
- disjoint text edits: combine;
- overlapping text edits: semantic conflict;
- same atomic group changed differently: semantic conflict;
- the same unknown key changed differently: semantic conflict;
- different unknown keys: combine;
- concurrent reorder of different items: combine ranks;
- conflicting reorder of the same item: shared rank wins after preservation.

The shared side is the deterministic default for an unresolved value conflict
because it contains already-replicated peer state. Before applying that default,
YAOS writes the complete local alternative to a local-only Canvas conflict
artifact and records structured conflict metadata. Clean groups may still
merge. If artifact creation fails, no conflicting local value is discarded and
the path remains decision-required.

Identity collisions and overlapping text conflicts initially use whole-Canvas
artifact review. A later field-level conflict UI may submit a revision-fenced
resolution, but is not required to make the first release safe.

### Dangling edges

Edges are reconciled after node liveness. A dangling edge:

- remains in semantic state with its order and tombstone evidence;
- is omitted from the active serialized Canvas;
- appears in diagnostics as blocked by one or two endpoint IDs;
- rematerializes automatically if both endpoints become live again.

No endpoint is rewritten to another node automatically.

## Common bases

Add a `CanvasSettlement` store keyed by Canvas identity:

```text
format = 1
documentId
vaultGeneration
semanticCodec = json-canvas-canonical-v1
canonicalContent
contentHash
durableGeneration
serverContentHash
diskFingerprint { bytes, hash }
pathAtSettlement
localSettlementRevision
settledAt
```

The record is reconstructible, typed, versioned, and compare-and-swap protected.
Path remains evidence, not identity.

A settlement advances only after:

1. the current server semantic head is active and matches identity, format,
   generation, content hash, and size;
2. the resident Canvas document is clean and matches its captured document and
   content proof;
3. the owning projection is exact: disk canonical semantics match for a closed
   Canvas, or the owned live view and its completed save match for an open one;
4. the raw disk fingerprint is captured when disk is expected to exist;
5. every await is followed by proof revalidation;
6. local settlement CAS succeeds.

Missing or invalid bases use additive preservation: additions from both sides
survive, shared IDs take the shared side, and absence causes no deletion. This
is a bootstrap safety posture, not invented ancestry. Exact present agreement
may backfill the base.

## Client architecture

### CanvasManager

`CanvasManager` owns one record per semantic Canvas:

- Y.Doc load and IndexedDB persistence;
- candidate capture, coalescing, retry, and receipts;
- provider sessions and currentness;
- semantic content generation and dirty state;
- residency, hibernation, and eviction;
- common-base settlement;
- disk and view projection handoff.

Do not make `BodyManager` conditional on format. Extract only format-neutral
lifetime, admission, or provider helpers when the resulting contract is smaller
and clearer than duplication.

### CanvasCoordinator

Follow the orthogonal `BodyCoordinator` model rather than copying Relay's HSM
verbatim. Track:

- document identity and content revision;
- lifecycle/path revision;
- projection ownership revision;
- host view identity and load revision;
- residency: absent, loading, warm, active, evicting;
- synchronization: clean, locally pending, durably pending, catching up;
- divergence: none, evaluating, preserved, decision required;
- view ownership: unbound, loading, owned;
- lifetime: accepting, quiescing, disposed;
- leases and exact path bindings.

Effects require distinct proofs:

- semantic computation: runtime, document identity, content revision;
- candidate accounting: exact candidate ID and digest;
- disk write: runtime, document, content, lifecycle/path, disk owner;
- view apply: all disk-write axes plus leaf, view object, TFile object, load
  revision, and owned-view proof;
- save completion: view-apply proof plus expected semantic hash;
- common-base CAS: server, document, owning projection, and disk fingerprint.

Only the disk owner may write through the vault adapter. Only the view owner may
call Canvas private APIs. Acquiring a view invalidates pending disk effects
synchronously before any asynchronous host work begins.

### Work scheduling

Extend the overdue-work adapter with reconstructible keys:

```text
canvas-wake:<documentId>
canvas-candidate:<documentId>
canvas-reconcile:<documentId>
canvas-save:<documentId>
canvas-rank-rebalance:<documentId>
```

Candidate debounce must have both a quiet-period target and a maximum wait so a
continuous drag cannot starve durability. Suggested initial behavior:

- view mutation capture: coalesce in memory for 50 ms;
- candidate persistence: at most 150 ms after semantic capture;
- maximum durability wait during continuous interaction: 1 second;
- pointer-up, save request, view close, backgrounding, and runtime quiesce:
  immediate flush request.

The durable candidate record, not a timer, is restart authority.

### IndexedDB

Add or generalize stores for:

- semantic Canvas candidates;
- Canvas settlements;
- Canvas conflict metadata;
- semantic outstanding bootstrap work;
- document-kind-aware materialized paths.

Existing generic document state storage may store Canvas Yjs state once every
record includes and validates its kind and representation version. Candidate
stores must not rely on body IDs or Markdown canonicalization.

Database scope remains host, vault generation, local folder, principal, and
device authority. Stale-authority work is preserved as unpublished and cannot
be replayed under another authority tuple.

## Closed-file projection

`CanvasDiskMirror` owns `.canvas` files whose semantic catalog entry is active
and which have no owned live Canvas view.

For a local watcher change:

1. acquire the disk projection lease;
2. capture path/document/content proof;
3. read exact bytes and fingerprint;
4. parse and validate with typed outcome;
5. compare against current semantic state and common base;
6. preserve conflicts before mutation;
7. apply a targeted semantic diff in one Yjs transaction;
8. persist the candidate before submission;
9. return `replan` after durable receipt;
10. materialize the newly current semantic state;
11. verify disk/document/server agreement;
12. CAS-advance the common base.

For a remote update:

1. currentness/catch-up installs the semantic document state;
2. acquire disk ownership and proof;
3. read disk rather than assuming it is unchanged;
4. run the same merge protocol;
5. write only after preservation and final proof recheck;
6. attach an exact expected-write fingerprint;
7. watcher suppression requires matching bytes, never elapsed time.

Invalid JSON, read failure, write failure, oversized local data, and missing
base become explicit preservation or blocked outcomes. They never trigger an
automatic switch to attachment authority.

## Live Obsidian Canvas projection

### Host boundary

All undocumented Canvas behavior belongs in a dedicated capability-checked
`ObsidianCanvasHostAdapter`, registered in the host compatibility matrix. The
rest of YAOS cannot reach Canvas private members directly.

Probe and wrap only demonstrated capabilities:

- Canvas view detection and exact leaf identity;
- `view.file`, `view.setViewData`, and view destruction;
- `canvas.getData` and `canvas.importData`;
- `canvas.requestSave`;
- `canvas.applyHistory`;
- mutation signals such as `markDirty` and `markMoved` if stable;
- node `isEditing`, `text`, and `setText` behavior;
- embedded child-view discovery.

Every patch uses `HostPatchRegistry`: original receiver/arguments/result are
preserved, observer failure cannot alter Obsidian behavior, release is
idempotent, and foreign replacement causes YAOS to stand down.

If safe mutation observation is unavailable, YAOS captures at native save and
undo/redo boundaries. If safe view application is unavailable, remote state is
held and projected after the view closes; YAOS does not write behind an open
unknown view.

### View session identity

A Canvas view session is keyed by:

```text
vault generation
Canvas document ID
current path
WorkspaceLeaf identity
view object identity
TFile object identity
view load sequence
session generation
```

Obsidian reuses Canvas views across file switches. A path comparison alone is
insufficient. Until `setViewData` proves that rendered data belongs to the
current `view.file`, the session is `loading` and no content crosses in either
direction.

Ownership may be established by:

- successful `setViewData` for the exact current TFile;
- a native save whose rendered data was written to that TFile;
- an install-time disk/view semantic equality check that remains current after
  its asynchronous read.

A clearing load voids any prior external-ingest marker. A non-clearing load on
an already-owned exact view records one file- and load-sequence-bound external
disk ingest. Bare booleans are forbidden.

### Local view capture

Safe mutation signals schedule capture; native save and undo/redo are definitive
capture boundaries. Stable item-bearing signals collect changed node/edge IDs
and read only those items at the coalesced capture boundary. A possible delete,
z-order change, unknown signal, native save, undo/redo, or capability fallback
uses one complete `getData()` snapshot. The last captured ID/order indexes make
deletion and reorder detection explicit.

YAOS must not call complete `getData()` once per `markDirty`, `markMoved`, node,
edge, or Yjs event. A drag may produce many host signals but at most one
coalesced semantic transaction per capture window. Native save remains the
definitive backstop that repairs any missed granular signal.

Remote application carries an origin token and expected semantic hash. A later
capture is suppressed only if the exact view snapshot matches that applied
hash. If the user changed the view meanwhile, it is new local input.

### Remote view application

Before applying:

1. verify the full view-session proof;
2. read the current view snapshot;
3. reconcile it against common base and shared state;
4. preserve any local conflicts;
5. pre-adopt text for actively edited text nodes;
6. call `importData` through the host adapter;
7. mark affected nodes/edges dirty or moved only through capability-checked
   methods;
8. request one deferred save after the complete transaction;
9. verify the view still belongs to the same session;
10. use the completed save and disk fingerprint to advance settlement.

Remote application must not create one save per node or per Yjs event.

### Text nodes

Text content is stored in Y.Text. Closed-file and view snapshots update it with
targeted diffs.

An actively edited card is special: calling `setText` may write through its
embedded editor and be observed again as local typing. The first safe release
must implement Relay's proven ordering principle:

- update the backing node text before bulk `importData`;
- never replace an active editor with an untagged transaction;
- defer Canvas save until every node observer for the semantic transaction has
  completed;
- merge the active editor's later committed value against the node Y.Text.

A direct CM6 binding for active card editors is a performance/live-visibility
enhancement only after capability probing proves stable ownership. Correctness
cannot depend on locating an undocumented inner editor. Without that capability,
remote text waits behind the active card edit and merges at its commit boundary.

### Embedded Markdown editors

Markdown file nodes can expose child editors that normal top-level leaf
orchestration does not see. Complete Canvas integration therefore includes a
bounded embedded-editor bridge:

- only actual Markdown child views are eligible;
- resolve their vault path through normal root authority;
- allocate a synthetic consumer identity scoped to Canvas view, node, and child
  view object;
- acquire the existing Markdown editor/body lease;
- capture through the child's native save path;
- release on child replacement, node deletion, Canvas file switch, leaf close,
  or runtime teardown;
- do nothing when the referenced path is excluded, absent, unauthorized, or the
  child editor capability is unavailable.

Media nodes and nested Canvas views are synchronized by their own file planes;
they are not recursively inserted into the parent Canvas document.

## Lifecycle behavior

### Create

- Parse and preflight limits before choosing semantic mode.
- Mint new Canvas/file identity.
- Seed the complete semantic document, including empty enrollment marker.
- Persist candidate and lifecycle intent before submission.
- Commit initial candidate, catalog create, and root path publication under the
  existing creation fence pattern.
- On failure, retain local file and pending intent; do not publish an empty root
  entry.

### Rename and move

- Retain Canvas identity and Y.Doc.
- Commit catalog rename before root publication.
- Replace path binding atomically in the coordinator.
- Invalidate stale disk and view effects immediately.
- Refresh `pathAtSettlement` only after the renamed projection agrees.
- A folder move is path-derived and requires no folder identity.

### Delete

For an unchanged closed projection, use normal trash/delete policy after durable
semantic lifecycle receipt. For a locally changed file or view:

- if exact base proves local modification, preserve and submit revive with the
  same Canvas identity;
- if evidence is missing or unreadable, preserve unresolved;
- if an open view has unsaved input, do not close or erase it before capture;
- later stale candidates against the tombstoned identity are rejected.

Deleting the Canvas file is distinct from deleting nodes inside it.

### Path reuse

A new file at a deleted path receives a new identity. Old settlement, view,
candidate, disk, bootstrap, and recovery completions fail their lifecycle/path
proofs. No Canvas node tombstone history crosses identities.

### Copy

Copying a Canvas creates a new Canvas identity while retaining its serialized
node and edge IDs inside the new scope. Cross-Canvas node-ID equality has no
meaning.

### Cross-format rename

Renaming `.canvas` to another extension, or another extension to `.canvas`, is
an explicit authority conversion. It cannot be represented as an ordinary
semantic rename. Conversion requires exact source head, target absence/head,
materialized bytes, and one atomic root/catalog transition. If those conditions
are not met, preserve both paths and require a decision.

## Attachment fallback and promotion

### Eligibility

A `.canvas` file is eligible for semantic mode only when:

- it parses under the supported adapter;
- its normalized model and initial Yjs state fit all bounds;
- its path is not excluded;
- no local-only conflict suppression applies;
- semantic Canvas capability is advertised by the server;
- the vault schema/protocol exactly match;
- no unresolved attachment publication exists for that path.

Otherwise it remains an attachment. Unsupported does not mean unsynchronized.

### Authority switching

Mode is durable per path identity. A transient parse failure never causes an
automatic downgrade. Promotion and demotion are named, idempotent operations
with exact expected heads.

During an initial rollout, automatic promotion is disabled. The UI reports
eligible, semantic, attachment fallback, invalid, oversized, and blocked counts.
After field evidence, new eligible canvases may default to semantic while
existing files require a controlled background promotion pass.

The blob backing a promoted Canvas remains GC-reachable for a rollback retention
window and through existing recovery roots. It is not a second live authority.

### Greenfield schema-8 installation

There is no schema-7, storage-3, cache, or Yjs-history migration. A schema-8
installation claims fresh Durable Object namespaces and fresh local caches,
then imports ordinary Markdown, Canvas, and attachment files from disk. Old
tickets, candidates, lifecycle work, receipts, and socket sessions are not
accepted. Rollback means exporting ordinary semantic files and reinstalling;
an older Worker must never open storage-format-4 state.

### Missing R2

Semantic Canvas works without R2 because its live authority is SQL/Yjs. Opaque
fallback and conflict artifacts that require synchronized attachment storage do
not. Local conflict preservation still works on disk. An invalid or oversized
Canvas without R2 remains local and explicitly blocked rather than being lost.

## Server transport and currentness

Add semantic endpoints:

```text
GET  /semantic/:documentId/head
GET  /semantic/:documentId/state
POST /semantic/:documentId/candidate
WS   /ws/semantic/:documentId
```

Tickets use purpose `semantic` and remain exact to document ID, vault
generation, principal membership revision, device credential revision, and
protocol version. Server admission verifies an active semantic catalog head and
matching format before loading a document.

Socket updates are live pending state, not durable receipts. The client still
persists and submits exact candidates. `SEMANTIC_COMMITTED` notifications include
kind, format, durable generation, content hash, size, vault sequence, vault
generation, and runtime epoch.

Generalize currentness queries from body-only naming to document heads while
retaining kind validation. Batched catch-up may include Markdown and Canvas
requests, but each response is decoded by its declared kind and hard bound.

Canvas sockets share the semantic-document socket budget. One Canvas document
has at most one client provider regardless of split views. Closed canvases do
not retain sockets merely to receive updates; ordered feed and bounded catch-up
materialize them.

## Bootstrap and steady-state feed

Bootstrap descriptor and catalog pages add active semantic-document counts and
kind-aware entries. At the pinned boundary:

1. verify the root checkpoint and exclusive path authorities;
2. page Markdown and semantic catalog heads;
3. fetch Canvas state from SQL, never R2;
4. validate identity, kind, representation, generation, canonical hash, size,
   and path;
5. settle disk through the Canvas projection protocol;
6. persist outstanding failures without claiming completion;
7. catch up through the ordered feed;
8. recheck current heads before mutation;
9. release the history pin only after required state is durable locally.

Feed entries declare document kind. Coalescing cannot treat a Canvas generation
as a Markdown body generation. A feed-floor reset restarts pinned bootstrap.

Large vault bootstrap uses bounded parallelism and Canvas residency admission.
It does not open a socket for every Canvas.

## Recovery

Recovery format gains semantic Canvas manifest entries:

```text
kind = canvas
path
documentId
format = json-canvas
formatVersion = 1
generation
contentHash
size
state = materialized | gap
```

At the pinned recovery boundary, the job reconstructs the Canvas Y.Doc,
validates it, materializes canonical visible JSON, stores content-addressed
compressed bytes, and records explicit gaps. Recovery captures visible content,
not Yjs history, private view state, resolved-conflict diagnostics, or a
recursive dependency closure.

Restore:

- backs up the target first;
- rechecks reviewed disk state;
- validates manifest, identity, format, hash, size, and generation;
- parses restored JSON through the current supported adapter;
- submits normal Canvas candidate and lifecycle operations;
- settles through disk/view ownership;
- reports per-item changed, skipped, conflict, and failure outcomes.

Selective restoration of a Canvas does not automatically restore referenced
files. The UI lists missing referenced paths after restore without traversing or
authorizing them.

Recovery GC marks Canvas content objects, retained promotion blobs, manifests,
and active/deleted semantic identities under the existing generation-scoped
lease system.

## Resource ownership

### Client accounting

Add `canvas-residency-v1` estimates for:

- encoded Yjs state;
- node and edge maps;
- aggregate text code units and UTF-8 bytes;
- ordering ranks;
- retained tombstones and payloads;
- resolved conflict records;
- provider, persistence, observer, and view-session overhead;
- temporary parse, canonicalization, merge, and formatting scratch.

Canvas observations enter the existing admission authority as semantic
documents. Rename body-specific public labels to document labels only where the
reported population genuinely includes both.

Open views are active and protected. Closed clean canvases are warm and
evictable. Dirty, durably pending, leased, conflict-preserved, and save-pending
canvases are protected. Mobile backgrounding closes optional sockets, flushes
durable intent, and evicts clean warm Canvas documents.

### Server accounting

Generalize loaded-body cache accounting to loaded semantic documents while
retaining per-kind metrics. Enforce:

- loaded document count;
- encoded-state budget;
- per-document, per-socket, and per-vault pending update bytes;
- transient reconstruction/validation bytes;
- socket count;
- candidate and catch-up response bounds.

Admission returns exact Canvas-relevant backpressure reasons. Unknown
reconstruction or storage failures remain failures, not capacity guesses.

### Performance gates

- Host mutation wrappers perform no vault read, hashing, JSON serialization,
  network operation, or IndexedDB transaction synchronously.
- A coalesced local interaction generates one semantic transaction and at most
  one candidate-scheduling upsert.
- A coalesced remote transaction generates at most one view import and one
  deferred save.
- Unchanged items are not rewritten into Yjs merely because a full snapshot was
  required for deletion/order detection.
- Formatting-only disk changes generate no network candidate.
- Near-limit parsing, canonicalization, and merge reserve scratch before work and
  yield or reject rather than creating an unbounded main-thread task.
- QA records interaction long tasks, native-save duration, YAOS capture time,
  candidate bytes, imports per remote batch, saves per remote batch, and resident
  estimates with YAOS disabled, attachment mode, and semantic mode.
- Semantic mode cannot graduate from opt-in while representative Canvas save or
  interaction latency is materially worse than attachment mode without an
  understood, documented tradeoff.

## Headless and host degradation

The Node/headless client implements the closed-file Canvas codec, candidate,
bootstrap, feed, common-base, conflict artifact, lifecycle, and recovery paths.
It has no live-view adapter and therefore never acquires view ownership.

On Obsidian versions where private Canvas integration is unavailable:

- closed Canvas files still synchronize semantically;
- an open Canvas is treated as host-owned and remote disk projection waits;
- native saves are ingested when observable;
- the UI reports degraded live projection;
- YAOS never mutates an open view through guessed private APIs.

This is a capability degradation, not an attachment-authority switch.

## Security and privacy

- Canvas synchronization uses the existing complete-vault member authority.
- File-node paths are data, not authorization grants.
- The server never fetches link URLs or follows file-node dependencies.
- Canvas content, text, URLs, labels, node IDs, and file paths are excluded from
  ordinary logs and bounded diagnostics; path redaction rules apply.
- Invalid JSON cannot introduce prototypes, host objects, executable values, or
  unbounded recursion.
- Root and semantic socket mutation authority are independently checked.
- Recovery and conflict artifacts contain vault content and remain within their
  existing local or generation-scoped protection boundaries.

## Observability and UX

Add bounded product events for:

- semantic eligibility, promotion, demotion, and fallback reason;
- Canvas create, rename, delete, revive, and path reuse;
- candidate captured, persisted, submitted, committed, replayed, superseded,
  rejected, and recovered by exact outcome lookup;
- provider admission, currentness source, catch-up, and liveness;
- view session loading, ownership established/deferred/lost, apply, save, stale
  completion, and host-capability degradation;
- disk parse, formatting-only change, merge outcome, conflict preservation,
  self-write verification, and settlement CAS;
- edit/delete normalization, dangling edge count, rank collision/rebalance;
- residency, scratch, socket, and overdue-work pressure;
- bootstrap, recovery capture, restore, and gap outcomes.

Diagnostics expose counts, durations, byte buckets, reason codes, and hashed or
redacted identities only. They never serialize Canvas data.

Settings/status should show:

- semantic Canvas enabled/available;
- semantic, fallback, invalid, oversized, pending, conflict, and degraded-view
  counts;
- current pressure and actionable guidance;
- an explicit per-file promote/demote/retry action during staged rollout;
- conflict artifact location and what value remained authoritative.

The public plugin API may expose immutable Canvas status and capability facts,
but not Y.Docs, scene contents, providers, credentials, or mutation methods in
the first release.

## Failure and crash matrix

| Boundary | Restart behavior |
| --- | --- |
| before local candidate persistence | disk/view remains source input and is recaptured |
| after persistence, before submission | exact candidate replays |
| after server commit, before response | exact receipt/outcome lookup clears only matching candidate |
| after receipt, before disk/view apply | current head rematerializes; old base remains |
| during parse or merge | no mutation; work replans or remains preserved |
| after conflict artifact, before apply | original plus artifact remain; registry prevents artifact promotion |
| after semantic apply, before candidate capture | Yjs persistence retains update and reconstructs candidate work |
| during remote view import | view proof/hash mismatch forces recapture and replan |
| after view import, before native save | save intent remains; view or disk is re-read before settlement |
| after disk write, before settlement CAS | exact agreement backfills settlement |
| after losing settlement CAS | reread winner and replan |
| during rename | lifecycle/root receipt and coordinator path proof determine winner |
| during promotion | one authority is visible because root transition is atomic |
| during rank rebalance | Yjs transaction is atomic; candidate retry is exact |
| during bootstrap/catch-up | outstanding kind-aware work and feed cursor resume |
| during recovery restore | backup and ordinary candidate/lifecycle receipts govern resume |
| runtime quiesce | stop admission, flush/capture intent, release patches and leases, then destroy docs |

## Implementation map

Suggested client modules:

```text
src/sync/canvas/canvasTypes.ts
src/sync/canvas/canvasCodec.ts
src/sync/canvas/canvasOrdering.ts
src/sync/canvas/canvasSemanticDocument.ts
src/sync/canvas/canvasMerge.ts
src/sync/canvas/canvasSettlement.ts
src/sync/canvas/canvasCoordinator.ts
src/sync/canvas/canvasManager.ts
src/sync/canvas/canvasDiskMirror.ts
src/sync/canvas/canvasViewSession.ts
src/sync/canvas/canvasConflict.ts
src/runtime/canvasOrchestrator.ts
src/host/obsidianCanvasHostAdapter.ts
```

Suggested shared/server modules:

```text
server/src/shared/canvasSemanticModel.ts
server/src/shared/canvasSemanticValidation.ts
server/src/shared/canvasLimits.ts
server/src/vaultSemanticCatalogStore.ts
server/src/vaultSemanticCandidateService.ts
server/src/vaultSemanticLifecycleService.ts
```

Existing modules requiring deliberate extension include schema/version pins,
root validation/publication, socket tickets and admission, document cache,
bootstrap, feed/catch-up, recovery protocol/job/read/restore, client IndexedDB,
work scheduling, resource snapshots, main/runtime lifecycle, diagnostics,
public API, host compatibility documentation, and the attachment classifier.

## Build order

### Phase 0 — Evidence and contract freeze

1. Capture JSON emitted by supported Obsidian desktop and mobile versions for
   every standard node/edge type, unknown fields, z-order changes, undo/redo,
   file rename, external disk reload, blank file, and malformed file.
2. Probe Canvas private capabilities and view reuse sequences.
3. Measure mutation/save cadence during drag, resize, text edit, bulk paste, and
   10k-item scenes.
4. Record encoded Yjs overhead for representative canvases and freeze initial
   semantic limits.
5. Decide disk presentation formatting from evidence.
6. Publish the host capability matrix and stable reason-code vocabulary.

Exit: format assumptions and bounds are evidence-backed; no production
semantic authority exists yet.

### Phase 1 — Pure semantic core

1. Implement types, parser, validator, canonical serializer, disk formatter,
   equality, and deterministic hashing.
2. Implement node/edge grouping and Yjs import/export.
3. Implement fractional ordering, minimal-rank reassignment, and rebalance.
4. Implement item tombstones and edit/delete normalization.
5. Implement pure three-way merge and conflict descriptions.
6. Fuzz JSON values, update order, merge permutations, and round trips.

Exit: shared pure suites prove deterministic materialization and convergence;
no vault integration.

### Phase 2 — Schema and durable server authority

1. Cut schema/protocol versions.
2. Add root semantic map and cross-authority validation.
3. Add semantic catalog, candidate, lifecycle, receipt, and attribution storage.
4. Add semantic candidate validation and idempotent commit.
5. Add semantic sockets, tickets, liveness, currentness, notifications, and
   backpressure.
6. Generalize cache accounting without weakening Markdown limits.
7. Implement promotion/demotion atomic transitions.

Exit: server and conformance clients can create, mutate, replay, rename, delete,
revive, promote, and demote a Canvas with exact receipts.

### Phase 3 — Client persistence and closed-file sync

1. Add CanvasManager, CanvasCoordinator, IndexedDB records, candidate queue, and
   work-scheduler integration.
2. Add common-base repository and CAS.
3. Add closed-file watcher ingestion, semantic merge, conflict artifacts,
   materialization, and self-write verification.
4. Exclude semantic paths from BlobSyncManager while retaining attachment
   fallback paths.
5. Implement Node/headless closed-file behavior.
6. Exercise restart and fault injection at every candidate/write/base boundary.

Exit: two closed Obsidian/headless vaults converge Canvas semantics through
offline edits, restarts, renames, deletes, and conflicts.

### Phase 4 — Bootstrap, feed, recovery, and resources

1. Add kind-aware bootstrap catalog/state and ordered feed catch-up.
2. Add Canvas current-head batching.
3. Add recovery capture, browse, read, restore, GC, and gaps.
4. Add client/server Canvas residency estimators and admission.
5. Add operational status, diagnostics, redaction, and public immutable facts.
6. Validate large-vault and near-limit behavior.

Exit: a fresh/reset client and recovery workflow reproduce the same bounded
Canvas content without R2 dependence for ordinary semantic sync.

### Phase 5 — Obsidian live-view integration

1. Implement the capability-checked host adapter and patch lifecycle.
2. Implement exact view ownership and file-switch fencing.
3. Capture local mutation, save, and undo/redo boundaries.
4. Apply remote semantic state with one deferred save and exact echo proof.
5. Handle actively edited text nodes conservatively.
6. Connect and release embedded Markdown child editors.
7. Validate split views, rapid switching, external disk reload, plugin reload,
   workspace restore, mobile suspension, and unavailable private APIs.

Exit: open and closed Canvas projections converge without cross-file splicing,
undo pollution, save storms, or stale completion.

### Phase 6 — Migration and staged rollout

1. Ship shadow parsing and semantic-equivalence telemetry with no authority
   change.
2. Enable explicit per-file promotion for internal/canary vaults.
3. Retain promotion blob baselines and provide explicit demotion.
4. Run two-device desktop, desktop/mobile, offline, restart, and deployed
   Cloudflare scenarios.
5. Enable opt-in vault-wide promotion with progress and blockers.
6. Make new eligible Canvas files semantic by default only after field evidence.
7. Consider automatic existing-file promotion only after rollback, resource,
   and host compatibility evidence remain clean for a full release window.

Exit: the attachment plane remains a tested fallback, but eligible Canvas files
default to semantic authority with operationally proven rollback.

## Test plan

### Pure codec and model

- Empty, blank, and `{}` enrollment.
- Every JSON Canvas 1.0 node and edge field.
- Unknown root, node, and edge fields.
- Node and edge order round trips.
- Duplicate/missing IDs, malformed endpoints, invalid geometry, non-finite
  numbers, excessive depth, oversized values, and prototype-shaped keys.
- Unicode, surrogate boundaries, large text, and stable canonical hashes.
- Import/export idempotence and randomized object-key order.

### Merge and convergence

- Independent item and field-group edits in both update orders.
- Move plus resize without torn geometry.
- Same-group concurrent mutation convergence.
- Disjoint and overlapping text edits.
- Add/add identity collision.
- Unchanged/delete, edit/delete, delete/delete, later deliberate delete.
- Node deletion with incident and independently edited edges.
- Dangling edge retention and rematerialization.
- Concurrent additions/reorders, same-node reorder, rank collision, and rebalance.
- Unknown-field independent and same-key changes.
- Missing, invalid, stale, and losing-CAS common bases.
- Artifact creation failure preserving original data.

### Server

- Candidate identity/digest replay and reuse rejection.
- Invalid semantic socket updates never entering pending/durable state.
- Active-kind and format admission.
- Hibernated cache commit and broadcast.
- Candidate commit, catalog metadata, attribution, and receipt atomicity.
- Root semantic-map protection and cross-authority path rejection.
- Promotion/demotion expected-head races.
- Cache count, encoded-state, pending-byte, transient, and socket pressure.
- Revocation/transfer fence ordering and exact outcome lookup.
- Cloudflare and Node conformance parity.

### Client durability and filesystem

- Candidate and document restart at every crash boundary.
- Formatting-only disk rewrites.
- Equal-size rapid rewrites.
- Read/stat/write failure and file-provider delay.
- Rename before first publication; delete before first publication.
- Rename/path reuse during parse, merge, download, and write.
- Remote update during local read and local edit during remote materialization.
- Blob/semantic classifier exclusivity.
- Invalid/oversized fallback and missing R2.
- Conflict artifact suppression from immediate promotion.

### Host integration

- View opened before and after semantic state loads.
- View object reused for another file before `setViewData`.
- Clearing and non-clearing loads with stale pending ingest.
- Split views for one Canvas and one leaf switching canvases rapidly.
- Local drag, resize, text edit, paste, undo, redo, and native save.
- Remote changes before ownership, during import, during text editing, and during
  native save.
- One save per semantic batch, no observer echo, no save loop.
- Embedded Markdown editor create/save/replace/delete/release.
- Foreign patch replacement and missing private capability.
- Plugin unload/reload and workspace restore.

### Bootstrap and recovery

- Pinned bootstrap with mixed Markdown, Canvas, and attachment entries.
- Rename/delete/update races across the bootstrap boundary.
- Feed floor reset and outstanding Canvas resume.
- Recovery complete, complete-with-gaps, selective restore, target changed after
  review, and referenced file absent.
- Recovery GC and promoted-blob rollback retention.

### Field QA

- Two desktop devices editing separate and same nodes.
- Desktop/mobile foreground and suspension/restart.
- Offline edits on both devices followed by reconnect.
- Large Canvas near semantic limit and larger Canvas on attachment fallback.
- Rapid open/close/switch across many Canvas leaves.
- Referenced Markdown, images, renamed files, and nested canvases.
- Deployed Cloudflare hibernation, reconnect, liveness, and currentness.
- Long soak for rank growth, tombstones, candidate backlog, save cadence, and
  resident-memory estimates.

## Release gates

Semantic Canvas is complete only when:

- schema/protocol reject mixed writers;
- every active path has one authority;
- canonical model and server validation are shared and bounded;
- exact receipts and restart replay cover Canvas candidates and lifecycle;
- node z-order is preserved explicitly;
- field groups cannot tear geometry or endpoints;
- edit/delete and dangling-edge behavior retain recoverable evidence;
- common bases never advance from candidate or disk evidence alone;
- closed files work on Obsidian and headless clients;
- live views are fenced by exact file/view/load identity;
- unsupported host behavior degrades without writing behind an open view;
- bootstrap, feed, recovery, GC, and resource UX include Canvas;
- promotion/demotion are atomic and rollback-tested;
- conflict preservation failure blocks destructive convergence;
- desktop/mobile and deployed-runtime evidence is recorded separately from pure
  and simulated coverage;
- the existing whole-file attachment plane remains clean for fallback files.

## Deferred improvements

These require separate evidence and should not delay a correct first semantic
release:

- chunked semantic candidates above the initial single-update bound;
- a visual field-level Canvas conflict resolver;
- direct CM6/Y.Text binding for actively edited text cards;
- server-assisted rank compaction leases;
- live awareness, cursors, selections, and viewport following;
- selective dependency publication for external browser sharing.
