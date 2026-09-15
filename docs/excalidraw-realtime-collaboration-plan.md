# Excalidraw realtime collaboration plan

Status: evidence-backed architecture contract. The September 2026 spike suite
settled the scene representation and Durable Object topology and identified a
viable current-plugin host seam. The complete result, counterexamples,
measurements, and remaining release evidence are in
`../spikes/excalidraw/FINDINGS.md`.

## Objective

YAOS should make an Excalidraw drawing opened in Obsidian a realtime peer of:

- the same drawing opened in another enrolled Obsidian installation;
- an authenticated browser used by a full-vault member;
- a public browser opened through an explicit drawing share;
- eventually, a read-write public browser collaborator.

The result should provide live scene synchronization, offline convergence,
presence, durable recovery, resource handling, and immediate revocation without
making Obsidian Excalidraw or the browser client responsible for YAOS transport.

The primary product is Excalidraw. Canvas presence is deliberately deferred
until the Excalidraw feature is complete and field-proven. The transient
presence kernel should nevertheless be format-neutral so Canvas can adopt it
later without changing the protocol or authority model.

## Product sequence

1. Same-vault Obsidian-to-Obsidian scene synchronization.
2. Excalidraw presence for same-vault peers.
3. Same-vault browser participation.
4. Public browser read-only shares with explicitly published resources.
5. Public browser editing under drawing-scoped grants.
6. Canvas presence reconsideration using the proven kernel.

The first release must not claim public collaboration merely because a scene
can be serialized into a browser. Resource privacy, grant revocation, presence
identity, scene durability, and write fencing are part of that product.

## Existing leverage

YAOS already supplies:

- stable vault, principal, device, and document identities;
- full-vault owner/member content authority and transactional revocation fences;
- document-scoped, epoch-bound WebSocket tickets;
- durable operation identities, receipts, epochs, checkpoints, recovery, and
  bounded-history patterns already proven by the Yjs-backed formats; these are
  design lessons, not a reason to put Excalidraw scenes into Yjs;
- application-level socket liveness and authenticated awareness relay;
- attachment CAS and generation-scoped R2 objects;
- semantic catalog, promotion/demotion, bootstrap, feed, recovery, and headless
  patterns demonstrated by Canvas;
- host patch ownership, safe degradation, durable retry, preservation, and
  resource accounting infrastructure;
- local Wrangler, deployed Worker, browser, headless, and two-profile Obsidian
  validation harnesses.

The `excalidraw-cloudflare` project demonstrates useful browser behavior:

- official React `onChange`, `onPointerUpdate`, and `onPointerUp` integration;
- imperative scene reads and `updateScene()` remote application;
- Excalidraw-native collaborator rendering, lasers, follow mode, and viewport
  updates;
- drawing-scoped Durable Objects, R2 files, tokenized external shares, and
  read-only/read-write enforcement.

It is the architectural baseline for the Excalidraw subsystem: one drawing room
per Durable Object, native complete-element records, ephemeral native presence,
and separate binary resources. YAOS should independently implement and harden
that design rather than route Excalidraw through its Yjs semantic engine. The
reference protocol still requires stronger identity, fencing, acknowledgement,
hibernation, privacy, bounds, and recovery contracts.

## First principles

### Authority

1. One physical Excalidraw path has one active authority.
2. The scene has stable identity independent of path.
3. The scene, disk serialization, live Obsidian view, browser view, resources,
   presence, and share grants are separate authority domains.
4. Durable scene writes carry exact document epoch, actor/grant revision,
   operation identity, and expected room revision.
5. A vault member remains a complete-vault content peer. Public share users are
   not members, viewers, or restricted vault principals.
6. A public share is an orthogonal resource grant scoped to one drawing,
   permission, published-resource manifest, revision, and expiry.
7. Revocation or permission downgrade installs a durable drawing-grant fence
   before any later mutation can commit and closes affected sockets.
8. Presence is ephemeral evidence, never scene authority or durable history.

### Preservation

1. Unsupported or unreadable Excalidraw formats remain attachment-authoritative.
2. No remote state overwrites an unproven live view or changed disk projection.
3. Unknown plugin metadata and unsupported scene fields are preserved or block
   promotion; they are never silently discarded.
4. A conflicting local alternative is preserved before a shared winner is
   projected.
5. Missing resources do not make scene content invalid. They become explicit
   unavailable-resource state.
6. No dependency is recursively disclosed to a browser merely because the
   drawing references it.

### Bounds

Every scene update, element, text value, resource, manifest, awareness frame,
pending queue, decoded scene, validation mirror, socket set, and recovery item
must have explicit limits. Near-limit parsing and hashing must reserve transient
capacity and yield rather than create unbounded Obsidian main-thread work.

## Domain decomposition

### Excalidraw document

An Excalidraw semantic document should contain only durable collaborative facts:

- active and deleted elements keyed by Excalidraw element ID;
- explicit z-order;
- bounded scene-level settings that genuinely travel with the drawing;
- binary-file metadata keyed by Excalidraw file ID;
- plugin-format metadata required for faithful disk materialization;
- conflict evidence and representation-version metadata.

Viewport, selection, active tool, pointer, laser state, collaborators, follow
state, transient editing state, device identity, and UI preferences are not
durable scene content.

### Disk container

Obsidian Excalidraw may use pure JSON and Markdown-backed formats. A dedicated
format adapter must classify, parse, and materialize each supported form. YAOS
must determine through fixtures rather than assumption:

- which formats current desktop and mobile plugin versions create;
- how compressed scene payloads, frontmatter, text blocks, back-of-card Markdown,
  embedded files, and plugin metadata are represented;
- whether the plugin rewrites formatting or metadata during load/save;
- what can be round-tripped without running plugin internals.

An Excalidraw-controlled Markdown file cannot simultaneously be synchronized by
the ordinary Markdown engine. Promotion must move the complete physical path to
one Excalidraw authority. The semantic representation may contain a separate
bounded Markdown text component when the format proves that back-of-card content
is an independent user-authored region. Browser publication excludes that text
unless the owner explicitly includes it.

### Resources

Resources divide into categories with different behavior:

1. Embedded Excalidraw binary files: immutable content objects plus metadata.
2. Vault file references: ordinary YAOS files referenced by path or identity.
3. Plugin-rendered Markdown, equations, PDFs, SVG, and nested drawings.
4. Remote URLs and unsupported plugin-specific resources.
5. Files introduced by a public browser collaborator.

Same-vault peers already possess authority to the complete vault, so scene sync
may retain vault references without recursively transferring them through the
scene room. Public shares receive only a versioned publication manifest whose
entries were explicitly approved and materialized into share-scoped immutable
objects. The public client never resolves arbitrary vault paths.

Browser-added files belong initially to a drawing-scoped inbound resource
namespace. Importing them into the vault must use a deterministic managed path
or an explicit owner decision; it must not overwrite an existing vault file.

### Presence

The generic presence envelope should be versioned and document-scoped:

```text
version
surface kind and surface version
connection/session identity
pointer and pointer tool
selected element IDs
active element/editing/interaction state
viewport
follow target
idle state
```

The server overwrites user identity, principal/share-session identity, device
identity where applicable, display name, and colors. Clients cannot assert
trusted identity. Payload fields are allowlisted, bounded, rate-limited, and
expired. Presence uses the existing awareness framing where practical, but the
application schema is YAOS-owned rather than arbitrary JSON.

Read-only collaborators may publish bounded presence without scene-write
authority. Public identities are share-scoped pseudonyms and do not expose vault
principal IDs, device IDs, email addresses, internal document IDs, or vault
paths.

## Scene representation

### Selected: native complete-element records

Persist complete Excalidraw elements keyed by element ID. Select winners with
the pinned upstream reconciliation semantics, including `version`,
`versionNonce`, deletion state, and fractional index ordering. Commit the set of
elements produced by one host change as one validated SQLite transaction and
broadcast the authoritative accepted set with a monotonic room sequence.

This is the target because it:

- matches Excalidraw's native collaboration and conflict model;
- preserves one coherent element instead of tearing coupled fields;
- avoids translating high-frequency scene edits into a second CRDT model;
- avoids retaining Yjs structural history underneath Excalidraw's own deleted
  elements and version history;
- gives the browser and Obsidian adapters the same scene protocol;
- permits direct comparison with `excalidraw-cloudflare` and upstream behavior.

YAOS must add transactional batches, exact equal-version selection, durable
operation receipts, monotonic replay cursors, bounded tombstone/history policy,
schema validation, and conflict preservation. These are hardening work around
the native model, not reasons to introduce Yjs.

### Rejected: whole-scene snapshots under CAS

Publish complete serialized scenes with revision comparison.

Advantages:

- smallest implementation;
- easiest closed-file round trip;
- useful as a fallback and spike baseline.

Risks:

- concurrent edits conflict at whole-scene granularity;
- continuous drawing is bandwidth- and CPU-heavy;
- it does not deliver the intended multiplayer product.

This remains useful only as a fixture baseline and emergency read-only export.

### Rejected: fine-grained field CRDT

Model element geometry, style, bindings, points, text, and extensions as
independent Yjs structures.

Advantages:

- maximum merge granularity;
- potential character-level text merging;
- strong theoretical survival of disjoint same-element edits.

Risks:

- Excalidraw elements contain coupled invariants which can tear;
- upstream introduces new fields and element types frequently;
- text, containers, arrows, frames, points, bindings, and duplication semantics
  are substantially more complex than JSON Canvas;
- much larger correctness and compatibility surface.

This is rejected. Excalidraw already defines the collaborative unit and version
metadata. Wrapping whole elements or their fields in Yjs would duplicate
conflict and deletion machinery, retain unnecessary high-churn structural
history, complicate materialization, and make upstream compatibility harder.

## Durable Object topology candidates

### Rejected as scene owner: existing vault Durable Object

This alternative would generalize the Yjs semantic engine beyond Canvas and put
Excalidraw scene state, sockets, history, and recovery inside the vault object.

Advantages:

- one transaction boundary for vault actor revocation, lifecycle, catalog, and
  scene commits;
- minimal new server architecture;
- no cross-object creation, deletion, recovery, or authority protocol;
- appropriate for the expected personal/small-team workload.

Risks:

- every live drawing in a vault shares one object CPU and memory owner;
- a popular public drawing could contend with ordinary vault sync;
- public share grants introduce a second actor domain into a sensitive object.

### Selected: one drawing Durable Object per Excalidraw identity

The vault object owns catalog/lifecycle while a room object owns scene content,
resources, presence, and public grants.

Advantages:

- natural load isolation and horizontal placement;
- document-scoped public authority;
- room-local connection, presence, and resource accounting;
- a hot public room does not block unrelated vault work.

Risks:

- no atomic transaction spans vault catalog and room content;
- creation, promotion, deletion, recovery, purge, revocation, and epoch changes
  become idempotent multi-object protocols;
- room capabilities and orphan repair become permanent infrastructure;
- requires an explicit authority-reservation/fencing protocol with the vault
  authority rather than relying on a cross-object transaction.

### C. Canonical vault document plus public projection room

Keep the canonical scene in the drawing object and replicate a sanitized snapshot into
a separate public room.

Advantages:

- public isolation;
- explicit sanitization boundary;
- public load does not directly expose the vault object.

Risks:

- two live replicas and bridge ownership;
- bidirectional editing, revocation, response loss, and recovery become harder;
- a public room can diverge from canonical scene/resource authority.

Choice: use B from the first same-vault implementation. The Vault Durable Object
owns file identity, path, lifecycle, vault actor authority, and document epoch.
The Drawing Durable Object owns native scene state, room sequence, receipts,
presence, resource manifests, and drawing-scoped grants. Their boundary must be
an idempotent multi-object protocol with explicit incomplete-state repair.

Public access uses a dedicated public gateway and an orthogonal
`ShareActorContext`, never an owner/member token or a new restricted vault role.
The context binds share ID, grant revision, drawing identity, permission, expiry,
session identity, and publication manifest. Only dedicated Excalidraw share
routes accept it. Transactional grant mirrors fence writes exactly as vault actor
mirrors do.

## Exploratory spike program

Each spike produces fixtures, a short report, measured artifacts, rejected
approaches, and a go/no-go decision. Probe code must remain outside production
until its seam has capability checks, safe fallback, and host-matrix coverage.

### Spike 0 — Upstream and format inventory

Questions:

- Which Excalidraw version is bundled by each supported Obsidian Excalidraw
  plugin version?
- Which public imperative APIs and React callbacks exist in those versions?
- What does upstream consider durable scene state, local AppState, collaborator
  state, binary files, and library state?
- Which element fields participate in versioning, deletion, binding repair,
  duplication, and restore?
- Which Obsidian file formats exist in field vaults?

Method:

- pin source commits for the Obsidian plugin and bundled Excalidraw package;
- create a machine-readable API/field inventory;
- capture representative files from desktop and mobile versions;
- diff scenes after every standard tool, grouping, binding, frame, text,
  image, crop, library, undo, and export operation;
- record unknown fields rather than normalizing them away.

Exit evidence: supported version matrix, format fixtures, element corpus, and a
list of required versus local-only AppState fields.

### Spike 1 — Obsidian runtime object graph

Map the live `ExcalidrawView`, plugin instance, automation API, embedded
Excalidraw API, scene callbacks, save pipeline, semaphores, file identity, and
view lifecycle on desktop and mobile.

Inspect and compare:

- direct view/controller fields;
- plugin scripting/automation surface;
- internal event emitters or hook registries;
- the imperative Excalidraw API object;
- save/load methods and dirty/autosave state;
- workspace leaf reuse, split views, embeds, and pop-out windows.

Exit evidence: capability table with exact object ownership and a safe fallback
for every missing capability. React-fiber traversal or DOM-private framework
state is presumptively rejected because it lacks a stable ownership boundary.

### Spike 2 — Local scene capture approaches

Compare at least four approaches:

1. Observe or wrap the plugin's internal committed-scene callback.
2. Observe a plugin event/hook if an internal registry exists.
3. Wrap native save/dirty boundaries and read the imperative scene API.
4. Adaptive polling of element versions while an owned view is active, with
   native save as the definitive backstop.

For each approach measure missed edits, duplicate captures, synchronous cost,
drag/freehand cadence, undo/redo, text editing, image insertion, view switching,
backgrounding, and plugin reload. A DOM mutation observer is not scene evidence
and cannot be the sole capture mechanism.

Target: low-latency incremental capture where stable, plus a definitive bounded
snapshot boundary. Correctness must not depend on every pointer event firing.

### Spike 3 — Remote apply and echo suppression

Compare:

- imperative `updateScene()` with the appropriate capture action;
- plugin view wrappers around scene update/import;
- automation API application;
- complete replacement versus changed-element application.

Prove:

- no undo-stack pollution;
- no autosave echo loop;
- exactly one bounded save intent per remote batch;
- active text editing and composition are preserved or explicitly deferred;
- bindings, selection, viewport, and current tool are not destroyed;
- stale view/file/load proofs prevent cross-file application;
- a failed apply leaves the local alternative recoverable.

Exit evidence: chosen apply seam, semaphore/origin protocol, save proof, and
fallback when application is unavailable.

### Spike 4 — Closed-file parse and round trip

Build fixture-only parsers for pure JSON, Markdown-backed, compressed, legacy,
blank, malformed, and future-field files. Round-trip without Obsidian, then let
the real plugin load/save the result and compare semantic equivalence.

Test frontmatter, back-of-card text, line endings, plugin settings, embedded
references, unknown blocks, and very large scenes. Determine whether faithful
closed-file support is possible without invoking plugin code. Unsupported forms
must remain attachments.

### Spike 5 — Scene merge model

Replay the fixture corpus through the pinned upstream/native reconciliation
algorithm and a whole-scene CAS baseline:

- different-element edits;
- same-element move/style/text/points edits;
- freehand growth;
- delete/edit and restore;
- binding and container changes;
- z-order and frame membership;
- duplicate IDs and copy/paste;
- unknown future element types;
- offline peers with long divergent histories.

Measure encoded batch size, resident state, deleted-element rows, replay-log
growth, snapshot reduction, validation time, materialization time, lost
alternatives, and visual equivalence after all update orders. Use screenshots
only as supporting evidence; canonical scene assertions remain primary.

Exit evidence: reconciliation RFC, conflict table, hard limits, snapshot/log
retention policy, and proof that server, browser, and Obsidian choose the same
winner. The complete element remains the indivisible merge unit.

### Spike 6 — Resources and privacy

Exercise pasted images, local vault images, remote images, SVG, PDF, equations,
Markdown embeds, nested drawings, cropped images, deleted files, duplicate
content, and unavailable resources.

Trace:

- what `getFiles()` exposes;
- what scene elements store;
- when the plugin reads from the vault;
- how `addFiles()` and scene application behave;
- which data is required for rendering versus editing;
- whether binary content is embedded, cached, linked, or regenerated.

Construct a dependency graph five to seven levels deep and prove that browser
publication selects an explicit bounded manifest rather than traversing it.
Include a privacy fixture where an apparently harmless embedded note contains
secret back-of-card content.

Exit evidence: resource taxonomy, same-vault resolution contract, browser
publication UI contract, inbound-browser-file policy, and missing-resource UX.

### Spike 7 — Presence integration

Browser trials use official Excalidraw callbacks and collaborator rendering.
Obsidian trials determine whether the embedded API exposes equivalent callbacks
or whether owned DOM pointer capture plus AppState conversion is necessary.

Exercise pointers, lasers, selected elements, active editing, idle, multiple
devices for one principal, split views, follow mode, reconnect, backgrounding,
and abrupt disconnect. Measure event rates and payload sizes.

Exit evidence: versioned presence schema, client throttle/coalescing rules,
server validation and rate policy, expiry behavior, and identity-redaction tests.

### Spike 8 — Durable Object topology and load

Drive drawing room objects with increasing peers, awareness frames, freehand
updates, large scenes, replay/snapshot work, and R2 resource publication. Drive
many rooms under one vault concurrently with ordinary Markdown traffic.

Measure CPU per message, wall time, resident bytes, socket count, pending bytes,
commit latency, alarm/snapshot interference, reconnect amplification, and
failure recovery. Include a hot public room beside normal vault editing and
exercise the Vault-DO/Drawing-DO authority boundary under faults.

Run locally for rapid iteration and on a disposable deployed Worker for actual
Cloudflare limits, hibernation, placement, WebSocket, R2, and scheduling
evidence. Miniflare results do not decide production topology alone.

Exit evidence: deployed room limits, sharding thresholds, and a validated
multi-object lifecycle, fencing, recovery, and orphan-repair protocol.

### Spike 9 — Browser client and sharing boundary

Build a minimal pinned React Excalidraw client before product UI. Prove scene
bootstrap, live update, presence, resource fetch, offline/reconnect, readonly
mode, and permission changes.

The public gateway trial must demonstrate:

- a link secret is exchanged for a short-lived drawing-scoped session;
- raw tokens are not retained in WebSocket URLs, logs, analytics, or referrers;
- internal vault, principal, device, path, and document identifiers are absent;
- read-only blocks every durable mutation but may allow presence;
- expiry, revocation, and downgrade fence in-flight writes and close sockets;
- manifests cannot be modified to request arbitrary vault objects.

### Spike 10 — Lifecycle and fault injection

Inject failure during capture, local persistence, pending-operation upload, server
commit, response, view apply, save, resource upload, share publication,
revocation, snapshotting, bootstrap, recovery, and teardown.

Exercise rename, delete, revive, copy, path reuse, promotion, demotion, plugin
disable/enable, rapid leaf reuse, process death, mobile suspension, DO eviction,
R2 unavailability, and deployment rollback. Every stage must have one named
restart authority and bounded retry behavior.

### Spike 11 — Performance and interaction quality

Use tiny, representative, 10k-element, large-freehand, image-heavy, and
near-limit drawings. Record with YAOS disabled, attachment mode, semantic mode,
and active collaboration:

- pointer-to-remote-render latency;
- local interaction long tasks;
- capture, validation, hashing, merge, and apply duration;
- updates and bytes per gesture;
- saves per remote batch;
- memory and encoded-state growth;
- reconnect/bootstrap time;
- mobile background and resume behavior.

Define release objectives only after baseline measurements. Optimization must
not weaken preservation or durability.

## Validation strategy

No single harness is representative of this feature. The release claim is the
intersection of five layers.

### Pure model and property tests

Use deterministic unit, randomized, fuzz, and frozen-trace tests for:

- parser and canonical materializer;
- unknown-field round trip;
- element merge convergence, idempotence, deletion, ordering, and bindings;
- resource-manifest validation and privacy filtering;
- presence schema validation;
- operation identity, epoch, catalog, actor, and grant fences;
- snapshot/replay equivalence and bounded history;
- malformed and adversarial payloads.

These tests are fast and exhaustive, but they do not prove Excalidraw rendering,
Obsidian internals, browser behavior, or Cloudflare scheduling.

### Protocol clients and CLI drivers

Node clients should drive HTTP, WebSocket, native element batches, presence, operations, lifecycle,
resources, grants, and recovery without a UI. They are the best tools for exact
races, response loss, malformed frames, load, many peers, deterministic network
faults, and durable-state inspection.

CLI-only testing is not representative for scene capture, remote application,
undo, text composition, pointer rendering, selection, follow mode, or plugin
save behavior.

### Real React Excalidraw browser tests

Use the actual pinned `@excalidraw/excalidraw` React component in Playwright.
Run two or more isolated browser contexts and drive pointer, keyboard, paste,
file upload, offline mode, reload, permission changes, and share revocation.

Assert canonical scene/resource convergence and protocol receipts, then use
targeted screenshots for collaborator cursors, readonly UI, selection, lasers,
and missing-resource presentation. React-component tests are representative for
the YAOS browser client and upstream public APIs, not for the Obsidian plugin.

### Real Obsidian profiles

Run two independently enrolled Obsidian profiles with the exact Excalidraw
plugin build under test. The harness should drive workspace commands and DOM
interactions while also inspecting vault bytes, YAOS durable diagnostics, and
captured adapter events.

Required matrices:

| A | B | Required claim |
| --- | --- | --- |
| Obsidian desktop | Obsidian desktop | same-vault live scene and presence |
| Obsidian desktop | Obsidian mobile | lifecycle, suspension, resume, resources |
| Obsidian | authenticated browser | full-vault member browser peer |
| Obsidian | public read-only browser | sanitized rendering and revocation |
| Obsidian | public read-write browser | bidirectional scene/resources and fencing |
| Browser | browser | public API, presence, offline convergence |

Real Obsidian is mandatory for private API compatibility, native save/autosave,
disk format, undo, embedded content, plugin reload, leaf reuse, and mobile
lifecycle. Browser success cannot substitute for it.

### Local Worker

Use local Wrangler/Miniflare continuously for fast server integration, real DO
SQLite APIs, WebSocket upgrade paths, alarms, R2-shaped ports, multiple clients,
and reproducible fault injection. It is sufficiently representative to develop
transactional logic and protocol behavior.

It is not final evidence for Cloudflare placement, eviction, hibernation,
resource limits, public routing, Access/service bindings, R2 behavior during
outages, or long-duration scheduling.

### Disposable deployed Worker

Every release candidate runs the same protocol and product scenarios against a
fresh disposable deployed Worker. The run must exercise actual HTTPS and
WebSockets, Cloudflare Access for member routes, the public share gateway, DO
hibernation/reconnect, R2 objects, alarms, grant revocation, and destructive
cleanup.

Use dedicated short-lived service authentication, unique vault/generation/share
identities, retained redacted artifacts, and mandatory teardown acknowledgement.
Never aim destructive validation at a retained or production deployment.

## Core end-to-end scenarios

### Scene collaboration

- simultaneous edits to different elements;
- simultaneous edits to the same element;
- move versus style, text versus delete, binding versus delete;
- freehand drawing while a peer edits another element;
- undo/redo after remote updates;
- copy/paste and duplicate IDs;
- long offline divergence followed by reconnect;
- response loss after durable commit;
- close/reopen and full process restart.

### Projection

- local edit during remote materialization;
- remote update during active text composition;
- split views of one file;
- view object reused for another file;
- external disk edit while open and while closed;
- plugin autosave during YAOS application;
- plugin disabled or API capability missing;
- invalid or future-format disk content.

### Resources

- same content under multiple file IDs;
- resource upload before/after scene reference;
- missing, corrupt, oversized, and unsupported resources;
- vault resource rename/delete;
- nested drawing and Markdown dependency graph;
- browser collaborator adds and deletes an image;
- share manifest excludes a referenced secret;
- share revoked while a resource download/upload is active.

### Presence

- two devices for one principal remain distinct;
- reconnect replaces stale session state;
- abrupt disconnect expires cursors;
- read-only user can point but cannot mutate;
- spoofed user/color/device fields are overwritten;
- oversized or excessive presence is dropped/throttled;
- hidden-presence setting suppresses send and render;
- follow stops on disconnect, manual pan, or permission loss.

### Governance and security

- member removal during scene write;
- device revocation during WebSocket validation;
- ownership transfer with queued scene work;
- share expiry, revoke, read-write to read-only downgrade, and token replay;
- guessed document/resource IDs;
- forged internal headers and share context;
- stale grant ticket after revision change;
- cross-vault, cross-drawing, cross-generation, and cross-manifest substitution;
- public response and telemetry redaction.

## Higher-level build plan

### Phase 0 — Contract and evidence freeze

1. Complete spikes 0 through 6.
2. Freeze supported plugin/Excalidraw/file-format matrix.
3. Select scene representation and initial hard limits.
4. Decide the physical-file authority and back-of-card treatment.
5. Publish resource taxonomy and privacy contract.

Exit: representative fixtures round-trip, capture/apply seams are demonstrated,
and no server schema has changed yet.

### Phase 1 — Drawing identity and authority boundary

1. Add stable Excalidraw drawing identity and epoch to the vault catalog.
2. Define the Vault-DO/Drawing-DO creation, lifecycle, fencing, deletion, and
   repair protocol.
3. Define idempotent authority reservations and operation receipts so an actor
   mutation is ordered unambiguously before or after revocation.
4. Preserve Canvas and ordinary vault synchronization unchanged.

Exit: room creation and authority transitions survive response loss and every
injected boundary failure without two active epochs.

### Phase 2 — Native Excalidraw room core

1. Implement bounded parser/materializer and allowlisted element/file types.
2. Implement pinned upstream reconciliation, explicit ordering, deletion,
   conflict evidence, transactional batches, and monotonic room sequences.
3. Add operation receipts, replay log, snapshots, retention, and recovery.
4. Add frozen traces and randomized convergence tests.

Exit: pure clients and recovered room snapshots converge on the same canonical
native Excalidraw scene.

### Phase 3 — Same-vault server authority

1. Add Excalidraw catalog, promotion/demotion, room lifecycle, sockets,
   bootstrap, replay, recovery, GC, diagnostics, and attribution.
2. Reuse YAOS actor and document-epoch semantics through the explicit
   Vault-DO/Drawing-DO authority protocol, not through Yjs candidates.
3. Add content-addressed resource metadata and immutable object publication.
4. Prove local Wrangler and Node/deployed conformance where applicable.

Exit: protocol clients can create, edit, replay, rename, delete, revive,
promote, demote, snapshot, recover, and fetch resources.

### Phase 4 — Durable client and closed-file projection

1. Add local document, pending-operation, settlement, lifecycle, resource, and
   preservation stores.
2. Implement classified file discovery and exact promotion.
3. Implement closed-file three-way reconciliation and atomic writes.
4. Integrate bootstrap, feed, recovery, overdue work, shutdown, and headless
   behavior where the file format permits it.

Exit: two closed-file clients converge across offline/restart cases without
running an Excalidraw view.

### Phase 5 — Obsidian live-view adapter

1. Productionize chosen capture and apply seams behind capability checks.
2. Fence leaf/view/file/load ownership and split views.
3. Implement origin/echo/save handling and active-text policy.
4. Integrate resources without recursive dependency transfer.
5. Publish the host compatibility matrix and degradation reasons.

Exit: two real Obsidian desktop profiles collaborate without cross-file apply,
save storms, undo pollution, or lost local alternatives.

### Phase 6 — Generic presence kernel and Excalidraw presence

1. Define the typed format-neutral presence envelope.
2. Extend provider awareness ports with subscriptions and lifecycle ownership.
3. Validate, authenticate, rate-limit, expire, and account presence server-side.
4. Connect official browser APIs and the proven Obsidian seam.
5. Render collaborators, pointers, selections, lasers, idle, and follow state.

Exit: presence is low-latency, ephemeral, identity-safe, and cannot mutate scene
or survive its session.

### Phase 7 — Same-vault browser peer

1. Build the pinned React Excalidraw client.
2. Use ordinary full-vault actor authority through document-scoped tickets.
3. Implement resources, offline/reconnect, presence, and compatibility errors.

Exit: an enrolled member can move between Obsidian and browser without a second
scene authority.

### Phase 8 — Public read-only publication

1. Add explicit share publication and resource-selection UI.
2. Materialize a sanitized immutable scene/resource manifest.
3. Add public gateway, short-lived share sessions, privacy redaction, expiry,
   revocation, and readonly browser UX.
4. Run the deployed public-boundary security matrix.

Exit: a public user can view and point at only the published drawing package.

### Phase 9 — Public read-write collaboration

1. Add transactional share-grant mirrors or the specified multi-object fence.
2. Admit drawing-scoped scene mutations and inbound resource objects.
3. Preserve owner/member scene authority while excluding all other vault data.
4. Prove downgrade/revocation against in-flight and offline work.

Exit: public editing is durable, bounded, immediately revocable, and cannot be
used as a vault capability.

### Phase 10 — Field rollout

1. Shadow-parse representative files without authority changes.
2. Enable explicit per-file promotion for internal vaults.
3. Run desktop/desktop, desktop/mobile, Obsidian/browser, and deployed matrices.
4. Rehearse demotion, Worker rollback, missing resources, and share revocation.
5. Enable opt-in same-vault collaboration, then browser viewing, then editing.
6. Revisit Canvas presence only after Excalidraw gates remain clean.

## Release gates

The feature is not complete until:

- supported plugin formats round-trip without silent metadata loss;
- scene representation converges under frozen and randomized traces;
- one path and scene identity have one durable authority;
- actor and share-grant fencing order exactly with durable mutation;
- open and closed Obsidian projections preserve local alternatives;
- remote application does not pollute undo or create save loops;
- missing or private resources never trigger recursive disclosure;
- browser outputs contain no internal vault, principal, device, path, or object
  identifiers;
- presence is bounded, trusted, ephemeral, and independently disableable;
- bootstrap, recovery, semantic reset, GC, headless degradation, and deletion
  account for Excalidraw resources;
- local Worker, deployed Worker, real React, real Obsidian desktop, and mobile
  evidence are reported separately;
- attachment authority remains a clean fallback;
- demotion and share revocation have been rehearsed against deployed code.

## Initial decision register

| Decision | Selected answer | Evidence required to change it |
| --- | --- | --- |
| Canvas presence timing | after Excalidraw | demonstrated shared work that does not delay Excalidraw |
| Scene representation | native complete-element records; no Yjs | none without an upstream Excalidraw model change |
| Durable topology | one Drawing DO per stable drawing identity | none; load thresholds affect room limits, not ownership |
| Public first mode | read-only | complete grant/resource privacy and revocation proof |
| Public identity | share-scoped session | none; vault identity disclosure is forbidden |
| Resource publication | explicit manifest | none; recursive disclosure is forbidden |
| Text model | coherent element initially | stable native-editor bridge plus measured conflict benefit |
| Unsupported formats | attachment fallback | proven bounded parser and faithful materializer |

## Immediate next actions

1. Freeze the room protocol and version-pinned native reconciliation/index
   conformance vectors.
2. Implement the production Drawing DO and exact Vault-DO authority reservation
   boundary with request-hash receipts, replay, snapshots, and limits.
3. Implement Excalidraw semantic identity, parser/materializer, attachment
   fallback, resource accounting, and projection ownership.
4. Implement the capability-tiered Obsidian adapter and validate it with two
   real desktop profiles, then desktop/mobile host matrices.
5. Add same-vault presence and the authenticated browser peer.
6. Build public read-only publication before public editing; gate both on
   explicit resources, identifier redaction, expiry, downgrade, and deployed
   revocation tests.
