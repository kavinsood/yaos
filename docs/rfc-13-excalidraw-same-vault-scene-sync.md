# RFC 13: Excalidraw same-vault scene synchronization

Status: implementation contract  
Target boundary: YAOS schema 9, storage format 5, protocol 6  
Scene protocol: `yaos-excalidraw-room-v1`  
Representation: `excalidraw-native-0.18-v1`  
Date: 2026-09-09

Implementation status and remaining release gates are tracked in
`rfc-13-excalidraw-same-vault-scene-sync-implementation-report.md`.

## 1. Normative language

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and
**MAY** are normative. A component that violates a MUST is incompatible with
this RFC and MUST fail closed rather than silently use attachment or Canvas
semantics.

This RFC specifies the first production increment only: realtime, offline-safe
Excalidraw scene synchronization between full-vault YAOS members. Presence and
public sharing are separate RFCs. The room and host boundaries defined here are
intentionally usable by those later features.

## 2. Decision summary

1. One stable Excalidraw drawing identity has one `ExcalidrawRoomDO`.
2. The room persists complete native Excalidraw element records. It MUST NOT
   put Excalidraw records into Yjs.
3. Higher element `version` wins. At equal `version`, the **lower**
   `versionNonce` wins, matching the pinned upstream implementation.
4. One logical host change is one durable operation, SQLite transaction, room
   sequence, receipt, replay event, broadcast, and receiver-side
   `updateScene()` call.
5. Every previously unseen durable operation MUST receive an idempotent
   reservation from the Vault DO before it can commit in the Drawing DO. This
   orders the operation either before or after actor or drawing revocation.
6. Binary bodies remain outside scene records and outside the Drawing DO.
   Same-vault resource descriptors are durable; unavailable resources degrade
   rendering rather than invalidate scene content.
7. The Obsidian adapter MUST use the supported `onSceneChangeHook` when
   available and `ExcalidrawView.updateScene()` with
   `CaptureUpdateAction.NEVER`. It MUST suppress network echo by exact revision
   evidence, not a timer or boolean.
8. Promotion is explicit in the first release. Unsupported formats remain
   attachment-authoritative. A promoted drawing never silently falls back to a
   second attachment authority.

## 3. Non-goals

This RFC does not define public links, restricted vault membership, public
resource publication, inbound public uploads, presence payloads, cursors,
lasers, follow mode, character-level text merging, or Canvas behavior. It does
not provide compatibility with `excalidraw-cloudflare` wire messages. That
project is a design reference, not a protocol peer.

## 4. Version boundary

### 4.1 Required cutover

Adding an Excalidraw variant to `SemanticPathRef` changes the root schema.
Schema-8 clients validate `kind: "canvas"` and reject any other semantic path
kind. Therefore this feature MUST ship as all of the following together:

- root schema **9**;
- socket and HTTP protocol **6**;
- server storage format **5**;
- bootstrap/snapshot format **4**;
- recovery format **4**;
- a new local persistence namespace ending in `:schema-9`;
- IndexedDB logical version **8**, with the Excalidraw stores in section 16;
- equivalent fresh schema-9 tables in the Node/CLI SQLite cache.

A schema-9 Worker MUST reject schema-8 sockets and protocol-5 clients with
`update_required`. A schema-8 Worker MUST never open storage-format-5 state.

### 4.2 Migration policy

This is a greenfield boundary. YAOS MUST NOT upgrade a schema-8 root, Durable
Object namespace, IndexedDB database, Node cache, ticket, pending operation, or
receipt in place. Deployment requires a fresh server namespace and fresh
schema-9 client caches, followed by import from ordinary files on a trusted
device. Existing `.excalidraw` and Excalidraw Markdown files are the migration
source.

Before retiring schema 8, the operator MUST verify that a trusted device holds
ordinary materialized files and no required work exists only in an old cache.
Rollback from schema 9 likewise means exporting ordinary files and reinstalling
against a fresh earlier deployment. Storage format 5 is not downgrade-readable.

## 5. Terms and identities

| Term | Definition |
| --- | --- |
| `vaultId` | Stable logical vault identifier. |
| `vaultGeneration` | Immutable deployment incarnation of the vault. |
| `drawingId` | Random, unguessable 128-bit semantic document identifier. It is the existing `documentId` axis specialized to Excalidraw. |
| `drawingEpoch` | Positive safe integer naming one scene lineage. It is the semantic catalog `bodyEpoch` for this drawing. |
| `pathRevision` | Catalog revision for mutable path projection. Rename changes it but does not invalidate scene operations. |
| `authorityRevision` | Catalog revision for promotion, demotion, delete, revive, or epoch replacement. It fences tickets and room activity. |
| `roomSequence` | Monotonic safe integer assigned by the Drawing DO to each state-changing committed operation. |
| `operationId` | Client-generated UUIDv4 or 128-bit base64url identifier, unique within a vault generation for at least 31 days. |
| `requestDigest` | Lowercase SHA-256 hex of the canonical trusted operation envelope. |
| `permitId` | Random 128-bit identifier returned by an allowed Vault-DO authority reservation. |
| `sessionId` | Random 128-bit identifier for one connected runtime session. It is not an actor identity. |
| projection | Eventual ordinary file representation of canonical semantic state. It is not shared authority after promotion. |

`drawingId` MUST NOT be derived from a path. Rename preserves `drawingId` and
`drawingEpoch`. Copy creates a new `drawingId` even when bytes are identical.
Delete followed by path reuse creates a new identity. Revive of the same
tombstoned catalog identity retains `drawingId` and increments `drawingEpoch`.

## 6. Authority invariants

1. `pathToSemantic`, `pathToId`, and `pathToBlob` MUST remain mutually
   exclusive for every physical path.
2. An active Excalidraw catalog entry MUST have exactly one room named by
   `(vaultGeneration, drawingId)` and exactly one active `drawingEpoch`.
3. The Vault DO owns path, lifecycle, member/device authorization, epoch,
   promotion, demotion, delete, revive, and operation reservations.
4. The Drawing DO owns canonical scene records, auxiliary container state,
   resource descriptors, room sequences, snapshots, replay, and receipts.
5. A scene operation MUST carry exact `vaultGeneration`, `drawingId`,
   `drawingEpoch`, and `authorityRevision`. Rename MUST NOT change the latter
   two values.
6. The edge MUST derive the actor from the bearer or ticket. Client JSON MUST
   NOT be allowed to assert `principalId`, `membershipRevision`, `deviceId`,
   `deviceCredentialRevision`, role, policy version, capability digest, display
   name, or color.
7. An operation is authorized only if the trusted actor has
   `vault.content.write` at reservation time.
8. A reservation durably ordered before a revocation or drawing fence MAY
   finish after that fence. A request not already reserved before the fence
   MUST be rejected. This ordering is the definition of immediate revocation.
9. Scene state and projection state MUST never be simultaneous shared
   authorities. Generic file synchronization MUST exclude an active semantic
   Excalidraw path.

## 7. Catalog and lifecycle

### 7.1 Root reference

Schema 9 extends the root map with:

```ts
interface ExcalidrawSemanticPathRef {
	documentId: string;              // drawingId
	kind: "excalidraw";
	format: "excalidraw-native";
	formatVersion: 1;
}
```

The root reference deliberately names only stable semantic authority. The
server is the only writer of this map. Content operations do not mutate the
root. Create, promote, rename, delete, revive, demote, and epoch replacement do.
The semantic catalog entry, lifecycle receipts, and room tickets carry the
mutable `drawingEpoch`, `authorityRevision`, path revision, and the disk
container format (`excalidraw-json` or `obsidian-excalidraw-markdown`). This
keeps the root representation aligned with the existing Canvas authority model
without weakening epoch fencing.

The SQL semantic catalog MUST additionally retain `room_state` as one of
`provisioning | active | fencing | tombstoned | demoting | reaped`, the latest
projection content hash and byte size, `path_revision`, `authority_revision`,
and the rollback attachment object retained by policy.

### 7.2 Eligibility

A file is eligible only when all of these are true:

- its path is otherwise syncable and not already authoritative in another map;
- its format adapter reports `valid` and `roundTripProven`;
- decoded scene and auxiliary container are inside every section-19 limit;
- the pinned representation supports every element type and required field;
- unknown fields survive canonical parse/materialize fixtures;
- the disk hash and attachment head remain the exact values reviewed for
  promotion;
- no unresolved attachment publication exists for the path.

Malformed, future, unsupported, or oversized files MUST remain attachments.
Eligibility MUST NOT imply automatic promotion in RFC 13.

### 7.3 Promotion state machine

Promotion is one named operation with one `operationId` and request digest:

```text
ATTACHMENT
  -> PROMOTION_RESERVED (Vault DO transaction)
  -> ROOM_INITIALIZED   (Drawing DO transaction)
  -> SEMANTIC_ACTIVE    (Vault DO CAS transaction)
```

1. The client MUST parse and canonicalize the exact disk bytes and persist a
   local promotion intent before its first network effect.
2. The Vault DO MUST atomically validate actor authority and the exact source
   root head (`pathToId` for a Markdown-controlled source or `pathToBlob` for an
   opaque source), path, semantic content hash, and disk-review proof; allocate
   `drawingId`, `drawingEpoch = 1`,
   and `authorityRevision = 1`; preserve the exact source body/blob and root
   evidence as rollback roots; and create a `provisioning` catalog record. It returns an idempotent
   initialization permit bound to the initial scene hash.
3. The Drawing DO MUST initialize only from that permit. It writes room meta,
   initial elements, resource descriptors, container record, sequence `1`, a
   snapshot, replay event, and initialization receipt in one transaction.
   Reusing the permit with a different digest is equivocation.
4. The Vault DO MUST activate only when the Drawing DO proves the exact
   initialization receipt and state hash. Activation atomically publishes
   `pathToSemantic`, removes attachment authority, and marks the room active.
5. Until step 4, the original `pathToId` or `pathToBlob` source authority
   remains the visible root winner, but mutation of the reserved path is blocked
   by the promotion intent. A changed disk or source head aborts promotion and
   preserves both versions.
6. Any lost response is repaired by querying the durable Vault and Drawing
   receipts. Recovery MUST resume the next incomplete step; it MUST NOT allocate
   another identity or initialize a second room.

This ordering deliberately prefers a harmless initialized orphan room over an
active root reference to an absent room. A room that never obtains a matching
activation receipt remains unreachable to member routes. The Vault lifecycle
repairer either finalizes it from the exact prepare/init receipts or, after the
rollback source retention window and proof that no active catalog reference
exists, tells the Drawing DO to reap it. The rollback source and both saga
receipts are GC roots until one of those terminal outcomes is durable.

The initial room event may contain more than the ordinary operation limit, but
MUST remain within the scene and snapshot limits and MUST use an internal
streaming initializer rather than a public unbounded request.

### 7.4 Rename, delete, revive, and demotion

Rename is a Vault-DO root/catalog transaction. It increments `pathRevision`
only. Scene sockets and queued operations remain valid.

Delete and demotion MUST first change the catalog to `fencing` and install a
`reservationFence` equal to the greatest authority-reservation sequence already
issued for the drawing. New reservations are then rejected. The lifecycle
runner MUST settle every allowed reservation at or below the fence by reading
its Drawing-DO receipt and retrying incomplete room commits. Only then may it
request a canonical terminal snapshot.

Delete retains that snapshot and rollback material under the normal recovery
policy, marks the catalog tombstoned, increments `authorityRevision`, and closes
all room sockets. Revive creates a new `drawingEpoch`, initializes the retained
canonical active scene into that epoch, and requires a fresh ticket and
bootstrap. Old-epoch operations and receipts can never enter the new epoch.

Demotion materializes the fenced terminal snapshot to a new immutable
attachment object, validates it with the pinned parser, atomically switches the
root from semantic to attachment authority, increments `authorityRevision`, and
then retires the room epoch. It MUST be refused while any local client reports
unsettled outbox work, while an authority reservation is unresolved, or when
faithful materialization cannot be proven. Forced recovery is a separately
audited operator action and MUST preserve the semantic snapshot as an artifact.

### 7.5 Degradation

Degradation is not demotion. A promoted drawing remains semantic when a plugin
hook disappears, a view cannot apply, a resource is missing, R2 is unavailable,
or a local projection is malformed. The affected client MUST stop unsafe
effects, retain its outbox and alternatives, exclude the path from generic file
sync, and expose a machine-readable reason. It MUST NOT upload the projection as
an opaque attachment or clear semantic authority.

## 8. Room routing and tickets

The edge routes a drawing to:

```text
roomName = hex(sha256("yaos-excalidraw-room-v1\0" + vaultGeneration + "\0" + drawingId))
roomId   = EXCALIDRAW_ROOM.idFromName(roomName)
```

Raw paths MUST NOT participate in routing. The Drawing DO MUST compare the
trusted forwarded `vaultId`, `vaultGeneration`, `drawingId`, `drawingEpoch`, and
`authorityRevision` with its own row before any effect.

Protocol 6 adds ticket purpose `excalidraw`. A ticket MUST bind deployment,
vault and generation, exact actor tuple, `drawingId`, `drawingEpoch`,
`authorityRevision`, reconciliation ID, issued-at, expiry, and random nonce.
Ticket lifetime is five minutes, with the existing 24-hour hard configuration
maximum. Socket admission MUST revalidate current control-plane and Vault-DO
mirrors; a valid signature alone is insufficient.

The bearer is exchanged over authenticated HTTPS. Long-lived bearers MUST NOT
appear in WebSocket URLs. The short-lived ticket SHOULD use the existing YAOS
subprotocol transport; if the runtime requires a query parameter, request logs
MUST redact it before the route is enabled.

The protocol-6 RFC-13 member route surface is exactly:

```text
POST /vault/:vaultId/auth/ticket
POST /vault/:vaultId/excalidraw/:drawingId/authority/prepare
POST /vault/:vaultId/excalidraw/:drawingId/initialize
POST /vault/:vaultId/excalidraw/:drawingId/authority/finalize
GET  /vault/:vaultId/excalidraw/:drawingId/replay?after=:sequence
GET  /vault/:vaultId/excalidraw/:drawingId/snapshot
POST /vault/:vaultId/excalidraw/:drawingId/batch
POST /vault/:vaultId/excalidraw/:drawingId/reset
WS   /vault/:vaultId/ws/excalidraw/:drawingId
```

The ticket, replay, snapshot, batch, reset, and promotion routes use the same
exact actor and drawing fences. Promotion is an idempotent public saga because
the initiating full-vault member must survive response loss across its three
effects. Reservation, cross-actor receipt inspection, socket fencing, repair,
and reap routes remain internal service-binding calls. Binary resource bodies
continue to use the existing authenticated generation-scoped Blob CAS routes;
RFC 13 does not expose a separate resource-completion endpoint.

## 9. Canonical encoding

All digests use SHA-256 over UTF-8 canonical JSON. The canonical codec MUST:

- sort object keys by Unicode code point;
- preserve array order;
- reject duplicate object keys at decode;
- reject `NaN`, infinities, negative zero, unsafe integers, lone surrogates,
  accessors, prototypes, functions, and cycles;
- encode numbers using the RFC 8785 JSON number form;
- preserve unknown ordinary JSON fields byte-semantically after decode and
  re-encode;
- omit no field merely because the current UI does not understand it.

Element `canonicalHash` is the digest of the complete normalized element. The
operation request digest is computed over the trusted envelope in section 11,
including the derived actor authority tuple and excluding only transport
headers, `requestDigest` itself, and retry metadata.

Every server, browser, Obsidian adapter, import tool, recovery tool, and fixture
generator MUST share the same codec and frozen vectors.

## 10. Native reconciliation

For an incoming element `candidate` and current complete element or deletion
fence `current`, the result is:

```text
candidate.version > current.version                         -> candidate wins
candidate.version < current.version                         -> stale
candidate.version == current.version and
candidate.versionNonce < current.versionNonce               -> candidate wins
candidate.version == current.version and
candidate.versionNonce > current.versionNonce               -> stale
same version, same nonce, same canonicalHash                 -> duplicate
same version, same nonce, different canonicalHash            -> equivocation
```

`isDeleted` is part of the complete record; it is not an independent tiebreaker.
A restore MUST carry a higher version than the deletion it replaces. The server
MUST reject the entire operation with `element_revision_equivocation` when any
equal revision tuple has different canonical content. Arrival order MUST NOT
choose the winner.

The representation ID pins the upstream Excalidraw revision and its fractional
index comparison. RFC 13 snapshots order active and complete tombstone records
by upstream fractional-index comparison, with element ID as deterministic tie.
The server MUST NOT silently rewrite an element index. Invalid indices are
rejected; index repair belongs to the pinned host adapter before publication.

## 11. Durable operation protocol

### 11.1 Client request

Durable mutation uses authenticated HTTP. WebSockets carry ready, commit, and
currentness frames; they are not the only receipt path.

```ts
interface SceneOperationV1 {
	v: 1;
	type: "excalidraw.operation";
	operationId: string;
	createdAt: number;                 // Unix milliseconds
	drawingId: string;
	drawingEpoch: number;
	authorityRevision: number;
	sessionId: string;
	baseSequence: number;
	reconciliationId: "excalidraw-native-0.18-v1";
	elements: NativeElement[];         // complete records, including deletes
	resources: ResourceDeclaration[];
	containerPatch?: {
		expectedRevision: number;
		expectedHash: string;
		format: "excalidraw-json" | "obsidian-excalidraw-markdown";
		codecVersion: 1;
		payload: ContainerAuxiliaryPayload;
	};
	sceneSettings?: {
		version: number;
		versionNonce: number;
		values: { viewBackgroundColor?: string };
	};
}

type ResourceDeclaration = {
	op: "declare";
	descriptor: ResourceDescriptor;
};

interface ContainerAuxiliaryPayload {
	frontmatter: Record<string, JsonValue>;
	backOfCardMarkdown: string;
	embeddedDeclarations: Array<{ key: string; value: JsonValue }>;
	unknownBlocks: Array<{ heading: string; body: string }>;
}
```

At least one of `elements`, `resources`, `containerPatch`, or `sceneSettings`
MUST change or declare state. `baseSequence` is currentness evidence, not a
whole-scene CAS: an older base may still reconcile. A base greater than the
current sequence is invalid. An operation older than 30 days or more than five
minutes in the future is rejected.

The edge converts the request into a trusted internal envelope by adding
`vaultId`, `vaultGeneration`, the complete `VaultActorContext`, and the
server-observed session binding. It computes `requestDigest`; caller-supplied
identity or digest fields are ignored and MUST NOT be forwarded.

### 11.2 Receipt

```ts
interface SceneReceiptV1 {
	v: 1;
	type: "excalidraw.receipt";
	operationId: string;
	requestDigest: string;
	status: "committed" | "rejected";
	sequence: number;
	stateHash: string;
	permitId?: string;
	replayed: boolean;
	elements: Array<{
		id: string;
		disposition: "accepted" | "stale" | "duplicate";
		canonicalHash: string;
	}>;
	containerRevision?: number;
	resourceIds: string[];
	error?: { code: ErrorCode; retry: "never" | "same-operation" | "after-bootstrap" };
}
```

A rejected receipt is durable when rejection follows a successful reservation
or is content-deterministic. Authentication failure, authority-service
unavailability, overload, and transient storage failure do not create a room
receipt. Retrying an operation ID with its exact digest returns the original
receipt with `replayed: true`. Reuse with another digest is
`operation_equivocation` even if the first result was rejected.

If every element is stale or duplicate and no other component changes, the
receipt is committed at the current sequence and no replay event is created.

### 11.3 Commit frame

One state-changing operation produces exactly one frame:

```ts
interface SceneCommitV1 {
	v: 1;
	type: "excalidraw.commit";
	drawingId: string;
	drawingEpoch: number;
	sequence: number;
	operationId: string;
	stateHash: string;
	elements: NativeElement[];         // authoritative winners only
	resources: ResourceDescriptor[];   // newly declared descriptors
	container?: { revision: number; hash: string; payload: ContainerAuxiliaryPayload };
	sceneSettings?: SceneSettingsRecord;
}
```

The frame contains no trusted actor PII. Attribution, when needed for audit, is
stored server-side against the receipt. Receivers MUST apply sequences in order.
A gap triggers replay; it MUST NOT be guessed or skipped.

## 12. Atomic multi-element operations

The client MUST expand each changed-record set to its directly coupled closure
before persistence. Closure includes:

- every element whose `boundElements` list changed;
- the corresponding bound arrow or text/container element;
- both targets of changed `startBinding` or `endBinding`;
- old and new `containerId` targets;
- old and new `frameId` targets;
- elements whose deletion detaches any of those relationships;
- every element whose native revision changed as part of group, duplicate,
  frame, bind, unbind, reorder, or library insertion behavior.

Transport MUST NOT split one logical change into independently committable
operations. RFC 13 caps an operation at 1 MiB canonical JSON and 512 element
records. A larger host callback MUST be coalesced and reduced to final complete
records when possible. If the logical closure remains larger, the adapter MUST
stop publication with `operation_too_large`; RFC 13 does not implement chunked
semantic commits.

The Drawing DO reconciles all candidates into a proposed copy, then validates
the complete resulting dependency closure before writing any row. At minimum:

- every active `containerId` and `frameId` target exists and is active;
- active arrow bindings point to active targets or are explicitly null;
- target `boundElements` and arrow/text/container relationships are mutually
  consistent according to the pinned representation;
- deleting a target in the proposed scene also deletes or detaches its active
  dependants;
- element IDs are unique within the operation;
- active element count and decoded-state limits remain valid.

Group IDs are membership labels and do not require every group member in the
operation. Equal fractional indices are permitted and tie by element ID.

If only a subset of candidates wins and that subset creates an invalid proposed
closure, the entire operation is rejected with `invalid_dependency_closure`.
Accepted candidates MUST NOT leak through. The client bootstraps, recomputes
closure against the new canonical state, and uses a new operation ID.

## 13. Vault-DO reservation and fencing

### 13.1 Reservation schema

For every first-seen operation, the Drawing DO calls a non-public Vault-DO
service-binding endpoint with:

```ts
interface ReserveDrawingOperation {
	vaultId: string;
	vaultGeneration: string;
	drawingId: string;
	drawingEpoch: number;
	authorityRevision: number;
	operationId: string;
	requestDigest: string;
	createdAt: number;
	actor: VaultActorContext;
}
```

The Vault DO transaction MUST first look up `(drawingId, drawingEpoch,
operationId)`. An existing matching digest returns its immutable prior decision.
An existing different digest returns `operation_equivocation`.

For a new row it validates exact vault generation, active catalog state,
drawing epoch and authority revision, current principal membership revision,
current device credential revision, policy version, capability digest, and
`vault.content.write`. It then allocates a monotonically increasing
`reservationSequence` scoped to the drawing epoch and stores either:

```text
allowed: permitId, actor tuple, requestDigest, reservationSequence, reservedAt
denied:  exact deny code, actor tuple, requestDigest, reservationSequence, deniedAt
```

The decision is immutable. Allowed reservations survive later actor, device,
or drawing fences. Denied reservations never become allowed.

### 13.2 Commit ordering

The Drawing DO processing order is:

1. Parse and bound the request without changing durable room state.
2. Check the local receipt by operation ID and digest.
3. For an unseen operation, obtain or replay the Vault-DO reservation.
4. Revalidate the room-local drawing stamp.
5. Reconcile and validate a proposed result.
6. In one SQLite transaction write all canonical changes, one sequence and
   replay event if changed, one receipt, resource accounting, and snapshot
   scheduling metadata.
7. Return the receipt and broadcast only after transaction success.
8. Best-effort notify the Vault DO that the reservation has a room receipt.

No network call may occur inside the SQLite transaction. If step 3 succeeds but
its response is lost, the same request replays the permit. If step 6 commits but
the response is lost, the local receipt wins on retry without another mutation.
If the process dies after reservation but before commit, the exact operation may
still commit after revocation because it was ordered before the fence.

### 13.3 Fences and repair

Actor or device revocation is ordered in the Vault DO after every reservation
transaction already processed and before every later one. It increments the
membership or device-credential revision as appropriate and causes affected
room sockets to close. It does not change an unrelated drawing's
`authorityRevision` and does not erase previously allowed permits.

A drawing lifecycle fence stores `reservationFence = current nextSequence - 1`
and changes the catalog state away from active in the same Vault transaction.
The lifecycle repairer enumerates all allowed reservations through that fence.
For each unresolved row it queries the Drawing receipt. If absent, it retries
the exact saved trusted operation from the bounded reservation payload/outcome
journal. Therefore an allowed reservation MUST retain either the canonical
request bytes or an immutable CAS pointer to them until completion.

After a receipt is found, the Vault DO marks the reservation `completed` with
receipt hash and room sequence. A terminal deterministic rejected receipt also
completes it. Demotion/delete may advance only when every allowed reservation
at or below the fence is completed. This rule prevents a response-lost mutation
from appearing after the terminal snapshot.

Vault reservation records are retained through operation expiry plus one day.
They are recovery roots and MUST NOT be truncated to satisfy a soft quota.

## 14. Drawing Durable Object storage

The production Drawing DO uses SQLite. Payload columns contain canonical UTF-8
JSON as BLOBs; hashes are lowercase SHA-256 hex. Equivalent indexes and checks
are REQUIRED even if migration syntax differs:

```sql
CREATE TABLE room_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  vault_id TEXT NOT NULL,
  vault_generation TEXT NOT NULL,
  drawing_id TEXT NOT NULL,
  drawing_epoch INTEGER NOT NULL CHECK (drawing_epoch >= 1),
  authority_revision INTEGER NOT NULL CHECK (authority_revision >= 1),
  reconciliation_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('initializing','active','fenced','retired')),
  room_sequence INTEGER NOT NULL CHECK (room_sequence >= 0),
  replay_floor_sequence INTEGER NOT NULL CHECK (replay_floor_sequence >= 0),
  state_hash TEXT NOT NULL,
  snapshot_sequence INTEGER NOT NULL CHECK (snapshot_sequence >= 0),
  snapshot_hash TEXT,
  snapshot_bytes INTEGER NOT NULL DEFAULT 0,
  container_revision INTEGER NOT NULL DEFAULT 1,
  container_hash TEXT NOT NULL,
  container_payload BLOB NOT NULL,
  scene_settings_version INTEGER NOT NULL DEFAULT 1,
  scene_settings_nonce INTEGER NOT NULL DEFAULT 0,
  scene_settings_hash TEXT NOT NULL,
  scene_settings_payload BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE elements (
  element_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  version_nonce INTEGER NOT NULL CHECK (version_nonce >= 0),
  is_deleted INTEGER NOT NULL CHECK (is_deleted IN (0,1)),
  fractional_index TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  payload BLOB NOT NULL,
  updated_sequence INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX elements_sequence ON elements(updated_sequence);
CREATE INDEX elements_deleted ON elements(is_deleted, deleted_at);

CREATE TABLE deletion_fences (
  element_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  version_nonce INTEGER NOT NULL,
  canonical_hash TEXT NOT NULL,
  deleted_sequence INTEGER NOT NULL,
  compacted_at INTEGER NOT NULL
);

CREATE TABLE resources (
  file_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content_hash TEXT,
  mime TEXT,
  byte_size INTEGER,
  descriptor_hash TEXT NOT NULL,
  descriptor_payload BLOB NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('declared','available','missing','retired')),
  declared_sequence INTEGER NOT NULL,
  last_referenced_sequence INTEGER NOT NULL
);

CREATE TABLE operation_receipts (
  operation_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  permit_id TEXT,
  actor_audit_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('committed','rejected')),
  sequence INTEGER NOT NULL,
  response_hash TEXT NOT NULL,
  response_payload BLOB NOT NULL
);
CREATE INDEX receipts_expiry ON operation_receipts(expires_at);

CREATE TABLE replay_events (
  sequence INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  event_hash TEXT NOT NULL,
  event_payload BLOB NOT NULL,
  encoded_bytes INTEGER NOT NULL,
  committed_at INTEGER NOT NULL
);

CREATE TABLE snapshots (
  sequence INTEGER PRIMARY KEY,
  snapshot_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  encoded_bytes INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
```

Initialization MUST verify that the singleton identity matches the DO route.
Mismatch is fatal corruption, not reinitialization. No request may alter
`vaultGeneration` or `drawingId` in place. Epoch replacement is a fenced
lifecycle operation, not a scene operation.

All affected `elements`, `deletion_fences`, `resources`, room metadata, replay
event, and receipt rows MUST commit in one transaction. The stored `stateHash`
MUST cover room identity, sequence-independent canonical element/fence set,
resources, container record, and scene settings; it MUST NOT cover receipts,
snapshots, timestamps, sockets, or replay retention.

## 15. Replay, snapshots, and compaction

### 15.1 Bootstrap response

`GET /excalidraw/:drawingId/bootstrap?after=<sequence>` returns one of:

```ts
type BootstrapResponse =
  | { mode: "replay"; epoch: number; from: number; through: number;
      stateHash: string; events: SceneCommitV1[] }
  | { mode: "snapshot"; epoch: number; sequence: number; stateHash: string;
      snapshotHash: string; elements: NativeElement[];
      deletionFences: DeletionFence[]; resources: ResourceDescriptor[];
      container: ContainerRecord; sceneSettings: SceneSettingsRecord };
```

Replay is permitted only when `after >= replayFloorSequence`, the epoch and
reconciliation ID match, and the encoded result is at most 4 MiB. Otherwise the
server returns a snapshot. A client MUST verify contiguous sequences and the
final state hash. Hash mismatch requires one fresh snapshot; a second mismatch
is fatal `state_hash_mismatch` and MUST retain diagnostics.

Snapshot application replaces the client's canonical room model. It MUST NOT
merge omitted old local records into authority. Local unreceipted operations are
then replayed against the replacement model. Deletion fences tell an adapter
which old IDs are absent and the minimum revision required for a valid restore.

### 15.2 Snapshot policy

The room MUST create a canonical snapshot after any of:

- 500 state-changing sequences since the last snapshot;
- 8 MiB of replay bytes since the last snapshot;
- 15 minutes after the first unsnapshotted commit;
- a lifecycle fence;
- an operator diagnostic request, rate-limited to one per minute.

Snapshot construction MUST use an explicit transient-residency reservation and
yield/chunk before near-limit allocation. At least the newest two verified
snapshots are retained. A snapshot is published in `room_meta` only after its
hash and state hash validate by decoding it.

The canonical `stateHash` preimage is the canonical JSON object
`{representation,drawingId,drawingEpoch,elements,deletionFences,resources,container,sceneSettings}`.
Each collection is sorted by its stable ID; `elements` additionally carries its
native fractional index but is hashed in ID order so presentation order cannot
change the set hash accidentally. `roomSequence` is intentionally outside this
preimage and is verified separately. Snapshot and replay transport compression
does not affect any digest, which always covers uncompressed canonical bytes.

### 15.3 Replay retention

After a verified snapshot, replay rows may be deleted oldest-first while always
retaining the newest 2,048 events unless doing so would exceed a hard cap.
Hard caps are 10,000 events, 32 MiB encoded replay, or seven days. Crossing a
hard cap advances `replayFloorSequence` and forces lagging clients to snapshot;
it MUST NOT reject new writes solely to preserve replay optimization.

### 15.4 Receipts

Operations may be submitted only for 30 days after `createdAt`. Their receipts
MUST remain through `createdAt + 31 days`. At 100,000 receipts or 128 MiB of
receipt payloads the room MUST reject new operations with
`room_receipt_capacity` until expiry or an epoch replacement creates a fresh
lineage. It MUST NOT evict unexpired receipts.

### 15.5 Tombstones

Complete native tombstones remain in `elements` for at least 30 days and at
least two verified snapshots after deletion. Afterwards the room MAY replace a
complete tombstone with a `deletion_fences` row in one transaction. The fence
retains ID, version, nonce, canonical hash, and deletion sequence, so an old
record cannot resurrect after compaction and an equal-tuple different payload
still detects equivocation.

Deletion fences never expire within a drawing epoch. At 50,000 fences, 128 MiB
total canonical room state, or 20,000 active-plus-complete-tombstone records,
the room MUST stop admitting growth and request a Vault-controlled epoch
replacement. Replacement fences reservations, snapshots the active canonical
scene, increments `drawingEpoch`, initializes the new epoch without old
tombstones/fences, requires every client to bootstrap, and retains the old
terminal snapshot for recovery. Old operations are rejected by epoch, making
fence removal safe.

Before resetting current-epoch tables, the Drawing DO MUST publish the old
terminal snapshot and receipt-range proof into the Vault recovery CAS and obtain
its durable receipt. It then clears element, fence, resource, replay, snapshot,
and old receipt rows in one epoch-initialization transaction before inserting
sequence 1 for the new epoch. This avoids sequence-key collision while retaining
the old lineage outside the active room schema.

## 16. Client durable state

The schema-9 IndexedDB and Node cache MUST add equivalent durable records for:

| Store | Key | Required contents |
| --- | --- | --- |
| `excalidrawDocuments` | `drawingId` | epoch, authority revision, path/path revision, format, reconciliation ID, last canonical sequence/hash, canonical scene or snapshot pointer, projection proof, degradation state |
| `excalidrawOutbox` | `operationId` | complete canonical operation, digest, authority/runtime/path proofs, attempts, next attempt, reservation/receipt evidence |
| `excalidrawSettlements` | `drawingId` | last receipted sequence/hash, disk hash, container revision/hash, local CAS revision |
| `excalidrawLifecycle` | `operationId` | promotion, rename, delete, revive, demotion, or epoch-replacement continuation and exact step receipts |
| `excalidrawResources` | `(drawingId,fileId)` | descriptor, local source proof, CAS upload/download state, retry and unavailable reason |
| `excalidrawProjection` | `drawingId` | expected path/file identity, materialized bytes hash, canonical state hash/sequence, auxiliary hash, write intent, backup/artifact reference |

An outbox operation MUST be durable before network submission. A receipt MUST be
durably applied to canonical state and settlement accounting before its outbox
row is deleted. Restart resumes exact operation IDs and bytes. Authority or epoch
change retires stale outbox rows only after preserving them as inspectable local
alternatives; it never rebases them under the old ID.

Client cache reset MUST count Excalidraw outbox, lifecycle, resource, and
projection work as pending. Ordinary reset is refused unless the user explicitly
chooses to discard it after preservation.

## 17. Obsidian host adapter

### 17.1 Capability contract

The first supported tier requires all of:

- `plugin.ea.onSceneChangeHook` with `trackElements`;
- `view.excalidrawAPI.getSceneElementsIncludingDeleted()`;
- `view.excalidrawAPI.getFiles()` and `addFiles()`;
- public `view.updateScene()`;
- `CaptureUpdateAction.NEVER` or its capability-equivalent value;
- a proven format adapter for the current disk container.

Capability detection, not package version text, decides support. YAOS MUST chain
and restore any pre-existing scene hook rather than overwrite it. One global
hook is multiplexed by exact view object, file identity, drawing identity, and
view-load generation. Every wrapper is restored on view detach or plugin unload.
React fiber traversal, prototype patching, `setDirty`, `clearDirty`, autosave
timers, and `ViewSaveCoordinator` mutation are forbidden in RFC 13.

Plugin versions without the supported scene hook remain attachment-authoritative
before promotion. If a schema-9 semantic drawing reaches such a client and no
proven closed-file adapter can safely own it, the client MUST expose it read-only
or degraded and require a plugin upgrade.

### 17.2 Capture state machine

```text
DETACHED
  -> ATTACHING (capture runtime/view/file/load proofs)
  -> BASELINING (bootstrap canonical scene and snapshot live scene)
  -> LIVE
LIVE -> CAPTURING -> OUTBOX_DURABLE -> SUBMITTING -> RECEIPTED -> LIVE
any state -> FENCED/DEGRADED -> DETACHED or fresh BASELINING
```

On each relevant scene hook callback, the adapter MUST read
`getSceneElementsIncludingDeleted()`; the callback array alone is not tombstone
authority. It diffs complete records by `(id, version, versionNonce,
canonicalHash)` against the last canonical-plus-local baseline, filters the
exact apply-origin ledger described below, expands native dependency closure,
and persists one operation before submission.

Callbacks may coalesce rapid freehand/drag changes for at most 50 ms, but the
final complete revision of every touched element is authoritative. Save
observation is a definitive checkpoint backstop: when a save contains a scene
revision not captured by the hook, the adapter MUST produce the missing durable
operation before accepting the projection settlement.

Capture MUST recheck runtime epoch, authority tuple, drawing epoch, path/file
identity, view identity, and load generation immediately before outbox write and
again before network publication. Stale work is preserved and fenced.

### 17.3 Remote apply and exact origin suppression

For each contiguous commit batch the adapter MUST:

1. Reconcile the winners into its canonical model and verify `stateHash`.
2. Fetch/install available binary files with `addFiles()` before elements that
   reference them; missing files produce explicit placeholders.
3. Record an apply-origin entry for every authoritative winner containing
   operation ID, element ID, version, nonce, deletion bit, canonical hash,
   target sequence, and view/load proofs.
4. Build one complete reconciled native scene and call exactly once:

   ```ts
   view.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER }, false)
   ```

5. Allow the plugin to mark the view dirty and autosave the projection.
6. On the resulting scene hook, suppress only records exactly equal to origin
   entries. Remove each entry when observed. A higher revision, a different ID,
   or any interleaved local change remains publishable.

A timed `ignoreNextChange` flag is forbidden. `NEVER` prevents undo pollution;
it is not proof of no callback or no dirty state. YAOS MUST NOT call
`clearDirty()` after apply.

An origin entry expires after five seconds only by forcing a complete live-scene
comparison. Exact matches settle; missing matches trigger snapshot/reapply;
different equal tuples trigger `element_revision_equivocation`. Expiry MUST NOT
blindly discard the ledger.

### 17.4 Active interactions

A remote operation that deletes or structurally replaces the element currently
under text composition, pointer drag, resize, crop, bind, or freehand input MUST
be deferred for that view. Nonconflicting remote records MAY apply immediately
only if doing so does not split one server operation visually; the RFC 13 default
is to defer the whole commit.

The deferred queue is bounded to 100 commits, 8 MiB, or five seconds. At the
interaction boundary the adapter first captures and persists the final local
records, then applies the latest canonical scene. If no safe boundary occurs by
the limit, the view becomes `active_interaction_blocked`; YAOS preserves both
states and asks the user to finish/cancel the interaction. It MUST NOT force an
apply through an active IME composition.

### 17.5 Projection state machine

```text
CANONICAL_CURRENT
  -> PROJECTION_PLANNED (durable exact target bytes/hash and proofs)
  -> DISK_RECHECKED
  -> ATOMIC_WRITE or PLUGIN_AUTOSAVE_OBSERVED
  -> PARSED_AND_VERIFIED
  -> SETTLEMENT_CAS
  -> CANONICAL_CURRENT
```

Closed files use a bounded format adapter and atomic temporary-file replacement.
Immediately before write, the client MUST re-read path/file identity and disk
hash. A changed disk is parsed as a local alternative and captured/reconciled;
it is never overwritten by an old projection plan. Failed or malformed local
bytes are backed up and block materialization.

Open views normally materialize through plugin dirty/autosave behavior. The
watcher classifies the exact resulting bytes as a semantic projection, verifies
them against canonical state and the auxiliary container record, and settles
them. It MUST NOT feed them to generic Blob or Markdown synchronization.

Every effect carries runtime, actor, drawing epoch, path revision, file
identity, view/load generation, canonical sequence/hash, container revision,
and local projection CAS proofs appropriate to that effect. Split views may all
display and capture, but one `ProjectionCoordinator` serializes disk settlement
per drawing. A late save from another view is accepted only when its semantic
content equals or advances known local work; otherwise it is preserved and
replanned.

### 17.6 Auxiliary container record

The format adapter splits disk bytes into canonical scene/resource data and one
bounded `ContainerAuxiliaryPayload`. For Markdown-backed files the auxiliary
payload includes frontmatter fields, user-authored back-of-card Markdown,
embedded-resource declarations, and unknown non-drawing blocks required for
round trip. It MUST NOT contain a second copy of scene JSON or binary bodies.

Auxiliary edits use exact CAS through `containerPatch`. A stale expected revision
or hash rejects the entire combined operation with `container_changed`; the
client preserves the local auxiliary alternative for review. Scene-only plugin
autosaves that leave auxiliary semantic hash unchanged do not create a patch.

## 18. Same-vault resources

### 18.1 Descriptor

```ts
interface ResourceDescriptor {
	fileId: string;
	kind: "embedded-binary" | "vault-file" | "external-url" |
	      "equation-render" | "mermaid-render" |
	      "local-markdown-render" | "nested-excalidraw-render";
	contentHash?: string;
	mime?: string;
	byteSize?: number;
	width?: number;
	height?: number;
	vaultDocumentId?: string;
	unavailableReason?: "not-uploaded" | "not-found" | "unsupported" |
	                    "remote-blocked" | "render-failed";
}
```

`JsonValue` in this RFC means bounded null, boolean, finite JSON number, string,
array, or string-keyed object accepted by section 9. `frontmatter` excludes the
Drawing payload and YAOS-owned authority keys. `unknownBlocks` preserve only
non-executable blocks proven round-trippable by the format adapter.

The canonical descriptor hash covers every field. A `fileId` is immutable within
a drawing epoch: redeclaring it with an identical descriptor is duplicate;
changing its hash, kind, locator, or bytes is `resource_id_equivocation` and
requires a new `fileId`.

Scene records may reference a descriptor whose bytes are unavailable. The room
stores `declared`/`missing`, commits the scene, and receivers render a bounded
placeholder. Missing resources MUST NOT reject or delete scene elements.

### 18.2 Binary flow

Embedded immutable bytes use the existing generation-scoped YAOS CAS/R2 plane.
Clients hash and persist a resource job before upload. Upload is content-addressed
and idempotent. A descriptor declaration may precede successful upload to keep
scene editing available; a later authenticated completion verifies size/hash
and changes availability through a durable resource-only operation.

Binary bodies MUST NOT enter JSON operations, room SQLite, snapshots, replay, or
receipts. The maximum resource body is 25 MiB in RFC 13. Hashing and decode MUST
reserve scratch capacity before allocation.

### 18.3 Vault and rendered dependencies

`vault-file` uses stable vault document identity and optional display metadata,
not a permission-bearing raw path. Same-vault peers already possess full-vault
authority and resolve it locally. The room MUST NOT recursively copy Markdown,
PDF, nested drawing, or back-of-card source because one element references it.

Equations, Mermaid, local Markdown, remote URLs, and nested drawings synchronize
only their explicit descriptor and, when available, a rendered immutable
artifact. Source traversal is never automatic. The host's `BinaryFiles` map is
a rendering cache, not a dependency or permission authority.

Resource GC requires all of: no active element reference, retention through two
snapshots and 30 days, no recovery/rollback/promotion root, and no other
generation-scoped CAS reference. Deletion of a scene element alone MUST NOT
synchronously delete its bytes.

## 19. Hard limits

Limits are measured after UTF-8 canonical encoding unless stated otherwise.
The first implementation MUST use these values; changing them requires protocol
capability advertisement and fresh deployed evidence.

| Item | Limit |
| --- | ---: |
| identifiers | 160 ASCII URL-safe characters; generated IDs are 128-bit |
| operation JSON | 1 MiB |
| elements per operation | 512 |
| one element | 256 KiB |
| active elements | 10,000 |
| active plus complete tombstones | 20,000 |
| deletion fences per epoch | 50,000 |
| decoded canonical room state | 128 MiB |
| snapshot JSON | 16 MiB |
| replay response | 4 MiB |
| replay retained | 10,000 events / 32 MiB / 7 days hard caps |
| unexpired receipts | 100,000 / 128 MiB |
| element ID length | 128 characters |
| fractional index length | 64 characters |
| text in one element | 1 MiB, also constrained by element limit |
| points in one linear/freehand element | 20,000 |
| group IDs on one element | 128 |
| resource declarations per operation | 256 |
| resources per room epoch | 20,000 |
| one binary resource | 25 MiB |
| auxiliary container payload | 2 MiB |
| unknown JSON nesting | 64 levels |
| deferred live-view queue | 100 commits / 8 MiB / 5 seconds |
| open sockets per room | 100 |
| outstanding requests per session | 8 |
| durable operations per actor/session | 20/second burst, 5/second sustained |

The server MUST reject before expensive decode when `Content-Length` already
exceeds a limit and MUST verify actual bytes when it does not. Limits are
independent; fitting one does not waive another. Near-limit encode/decode,
snapshot, and hashing work MUST use the existing residency admission policy.

## 20. Errors and retry behavior

Every error response has `{ v: 1, error: { code, retry, detailId? } }`. Human
text is diagnostic only. Unknown error codes are treated as fatal for the
operation and trigger no destructive local action.

| Code | HTTP | Retry | Meaning |
| --- | ---: | --- | --- |
| `invalid_envelope` | 400 | never | malformed or noncanonical request |
| `invalid_element` | 422 | never | element violates pinned schema |
| `unsupported_element_type` | 422 | never | representation cannot preserve it |
| `invalid_fractional_index` | 422 | never | native ordering value invalid |
| `invalid_dependency_closure` | 409 | after-bootstrap | proposed winner set tears relationships |
| `element_revision_equivocation` | 409 | after-bootstrap | equal ID/version/nonce, different content |
| `resource_id_equivocation` | 409 | never | immutable file ID rebound |
| `container_changed` | 409 | after-bootstrap | auxiliary CAS lost |
| `operation_equivocation` | 409 | never | operation ID reused with another digest |
| `operation_expired` | 409 | never | created more than 30 days ago |
| `operation_too_large` | 413 | never | semantic operation exceeds a hard bound |
| `scene_limit_exceeded` | 413 | never | result exceeds room-state bounds |
| `snapshot_required` | 409 | after-bootstrap | client evidence is outside usable lineage/history |
| `state_hash_mismatch` | 409 | after-bootstrap once | canonical verification failed |
| `drawing_not_found` | 404 | after-bootstrap | no active catalog identity |
| `drawing_initializing` | 409 | same-operation | promotion repair incomplete |
| `drawing_fenced` | 409 | never | delete/demotion/epoch fence installed |
| `drawing_epoch_superseded` | 409 | after-bootstrap | operation names old lineage |
| `authority_revision_superseded` | 403 | after-bootstrap | lifecycle authority changed |
| `membership_superseded` | 403 | never | principal membership revision changed |
| `device_credential_superseded` | 403 | never | device credential revision changed |
| `capability_missing` | 403 | never | actor cannot write vault content |
| `update_required` | 426 | never | schema/protocol/reconciliation mismatch |
| `room_receipt_capacity` | 503 | same-operation | room cannot safely retain another receipt |
| `authority_unavailable` | 503 | same-operation | Vault-DO reservation not known |
| `storage_unavailable` | 503 | same-operation | no durable room result is known |
| `rate_limited` | 429 | same-operation | retry after advertised delay |

No client may infer rejection from a timeout. It retries the exact operation or
queries its outcome. A `never` result retires ordinary retry only after the
local alternative and diagnostic are durable.

## 21. Socket behavior

After admission the server sends `READY` containing exact room identity,
sequence, replay floor, state hash, reconciliation ID, ticket expiry, liveness
bounds, and a random connection epoch. The client acknowledges the exact frame
before the socket becomes current.

The existing protocol-6 application PING/PONG rules apply. Browser `OPEN` is not
liveness evidence. Commit frames are ordered on one socket, but the durable
bootstrap/replay endpoint remains restart and gap authority. Backpressure drops
non-durable future presence first; RFC 13 scene commit notifications are either
queued within the socket budget or the socket is closed so the client replays.

Authority, epoch, or deployment replacement sends a fatal frame where possible
and closes with:

| Close code | Meaning |
| ---: | --- |
| 4001 | schema/protocol update required |
| 4002 | authentication or ticket invalid |
| 4003 | actor/drawing authority changed |
| 4004 | drawing unavailable or retired |
| 4008 | rate/backpressure budget exceeded |
| 4010 | canonical state verification failure |

Late events from a replaced connection epoch MUST be ignored.

## 22. Security and privacy

- All public HTTP routes authenticate before resolving a Drawing DO.
- Only internal service-binding routes may call reserve, initialize, fence,
  repair, inspect receipts for another actor, or retire a room.
- Room requests MUST bind vault generation and drawing identity even though the
  object route already names them.
- SQL statements use parameters. Element JSON is inert data and MUST never be
  evaluated, imported as code, or interpolated into HTML.
- Remote URLs are not fetched by the server in RFC 13. Clients apply existing
  safe-fetch policy and may show them unavailable.
- SVG and other active media use the existing sanitized/rendered pipeline.
- Diagnostics and logs MUST hash actor, drawing, operation, file, and resource
  identifiers with a deployment-scoped salt. They MUST NOT include scene text,
  file names, paths, back-of-card text, element JSON, resource bytes, bearers,
  tickets, or canonical operation payloads.
- Same-vault membership grants full vault content access; this RFC MUST NOT be
  reused to simulate folder-level or restricted membership.
- Resource resolution never traverses dependency graphs automatically. This is
  required even for same-vault mode so the later public boundary cannot inherit
  a recursive disclosure mechanism.

## 23. Observability

The Drawing DO exposes authenticated, capability-gated aggregate diagnostics:

- active/full-tombstone/fence/resource/receipt/replay/socket counts;
- canonical, replay, receipt, snapshot, and resource-metadata bytes;
- current sequence, replay floor, snapshot sequence, epoch, lifecycle, and
  representation ID;
- operation latency split into edge validation, authority reservation, queue,
  SQLite transaction, encoding, and broadcast;
- accepted/stale/duplicate/rejected element counts by non-sensitive reason;
- snapshot duration, compaction count, forced snapshot count, and epoch-reset
  pressure;
- replay versus snapshot bootstrap count and bytes;
- outbox age, apply deferral, projection settlement, resource-unavailable, and
  degradation counts reported by clients through bounded telemetry.

Traces MUST carry deployment-scoped hashed correlation IDs for operation,
reservation, receipt, and room sequence. The Vault and Drawing DO logs MUST make
the pre-fence ordering inspectable without exposing payloads. Metrics MUST
distinguish local Miniflare, deployed Worker, real React, desktop Obsidian, and
mobile Obsidian evidence.

Alerts SHOULD fire before 80% of any receipt, replay, element, fence, resource,
snapshot, or resident-state hard cap and when the oldest unresolved reservation
or outbox item exceeds five minutes.

## 24. Compatibility behavior

The server advertises exact supported representation IDs. A client whose pinned
Excalidraw fork does not pass every reconciliation, element, index, and
round-trip vector MUST NOT open a write session. Read-only projection is allowed
only if it preserves unknown fields and does not save them destructively.

Unknown ordinary fields on supported element types are preserved. Unknown
element types, executable plugin extensions, and disk blocks that cannot be
round-tripped block promotion or put an already-promoted client into degraded
mode. They are never dropped to make the file appear compatible.

Representation changes require either proven byte-compatible behavior under
the same ID or a new representation ID and a Vault-controlled drawing epoch
replacement. Mixed reconciliation IDs cannot write one epoch.

## 25. Required conformance vectors

The repository MUST freeze canonical request bytes, hashes, expected receipts,
snapshots, and all operation permutations for at least these vectors:

1. **Higher version:** version 8 beats version 7 regardless of nonce.
2. **Lower nonce:** version 7 nonce 100 beats version 7 nonce 200 in every
   arrival order and after late bootstrap.
3. **Exact duplicate:** same tuple and canonical payload is idempotent.
4. **Revision equivocation:** same ID/version/nonce and different payload rejects
   the entire operation.
5. **Delete/edit:** a higher-version tombstone beats an older edit; a valid
   higher-version restore beats the tombstone.
6. **Compacted delete:** an old active record loses to a deletion fence; equal
   tuple/different hash still rejects; a higher-version restore succeeds.
7. **Atomic bind:** rectangle delete plus arrow detach yields no observable torn
   intermediate scene in either delivery order.
8. **Partial winner closure:** one stale and one winning coupled candidate that
   would tear closure rejects without leaking the winner.
9. **Ordering:** duplicate fractional indices sort by element ID; malformed
   indices reject without rewrite.
10. **Receipt loss:** response loss after room commit returns the original
    sequence and receipt on retry.
11. **Reserve response loss:** an operation reserved before revocation commits
    on exact retry; a new operation after revocation is rejected.
12. **Fence terminal snapshot:** demotion waits for every allowed reservation
    through its fence, including one whose first response was lost.
13. **Epoch replacement:** old operation, socket, replay cursor, resource
    completion, and projection effect cannot enter the new epoch.
14. **Container CAS:** concurrent auxiliary edits preserve the loser and reject
    a combined stale operation atomically.
15. **Resource missing:** image element converges while bytes are absent, then
    renders after idempotent CAS completion.
16. **Resource substitution:** same file ID with another hash and cross-drawing
    CAS locator are rejected.
17. **Host echo:** one remote `updateScene()` callback produces zero outbound
    writes, while an interleaved higher local revision produces exactly one.
18. **Projection race:** changed disk between plan and write is preserved and
    replanned, not overwritten.
19. **Split views:** stale load/save from one view cannot overwrite another
    view's newer canonical projection.
20. **Bounds:** every limit rejects before state mutation and near-limit
    snapshot/hash work owns transient admission.

The pure model MUST run randomized permutations with tombstones, fences, stale
candidates, binding closure, receipts, snapshots, and epoch resets. It MUST
compare the server model with the pinned upstream reconciliation oracle rather
than another handwritten comparator alone.

## 26. Validation matrix

### 26.1 Automated layers

1. Unit/property/fuzz tests cover codecs, schema, reconciliation, closure,
   operation identity, reservation ordering, SQL transactions, replay/snapshot
   equivalence, tombstone compaction, parsers, materializers, and all bounds.
2. Protocol CLI clients inject response loss and crashes before reservation,
   after reservation, before room transaction, after room transaction, before
   Vault completion, during snapshot, and during projection settlement.
3. Local Wrangler tests exercise actual DO SQLite, hibernatable sockets,
   restart, alarms, many rooms, and R2-shaped resource ports.
4. A disposable deployed Worker repeats authority fences, socket close/replay,
   DO eviction/hibernation, snapshot load, R2 faults, and cleanup.
5. Playwright mounts the real pinned React Excalidraw component in at least two
   isolated browser contexts and asserts canonical scene convergence, callback
   origin suppression, tombstones, resources, reconnect, and late bootstrap.

### 26.2 Real Obsidian gates

Two independently enrolled desktop profiles MUST prove freehand, shapes, text,
IME, undo/redo, grouping, frames, binding, reorder, copy/paste, images, deletion,
offline divergence, restart, rename, closed-file update, plugin reload, split
views, pop-outs, and response loss. Assertions include server canonical records,
local outbox/receipts, ordinary file bytes, undo behavior, save count, backups,
and zero opaque-file echo.

Desktop-to-mobile MUST then prove touch/stylus capture, background suspension,
resume, memory pressure, resource loading, offline merge, and projection. A
browser or source inspection result cannot substitute for these host gates.

## 27. Release gates

RFC 13 may ship opt-in only when all are true:

- schema 9/protocol 6 rejects every mixed-version path and uses fresh stores;
- supported JSON and Markdown-backed fixtures round-trip without metadata loss;
- server, browser, Obsidian, import, recovery, and migration tools pass the same
  lower-nonce and index vectors;
- Drawing-DO transactions prove one operation/sequence/receipt/event boundary;
- pre-fence response loss and post-fence rejection pass on a deployed Worker;
- replay, snapshot, receipt retention, tombstone fences, and epoch replacement
  pass crash/restart tests;
- exact origin suppression produces no echo and preserves interleaved local
  edits without undo pollution or save loops;
- open and closed projection races preserve local alternatives;
- unavailable resources degrade explicitly and no dependency is recursively
  copied;
- desktop/desktop and desktop/mobile matrices pass with measured limits;
- promotion, demotion, delete, revive, epoch replacement, Worker rollback, and
  attachment fallback are rehearsed against disposable data;
- diagnostics prove all hard bounds without recording content.

Automatic promotion is not part of the first release. It requires subsequent
field evidence that invalid, oversized, degraded, outbox, projection, resource,
and demotion rates remain within an explicitly approved budget.

## 28. Implementation order

1. Cut schema 9/protocol 6/storage 5 and freeze shared codecs and conformance
   vectors.
2. Add the Excalidraw catalog variant, lifecycle receipts, Drawing-DO binding,
   and Vault reservation/fence journal.
3. Implement the Drawing DO schema, native reconciliation, closure validator,
   receipts, replay, snapshots, tombstones, and epoch pressure signaling.
4. Add authenticated routes, protocol-6 tickets, sockets, liveness, bootstrap,
   recovery, diagnostics, and deployed fault tests.
5. Add schema-9 client stores, closed-file parser/materializer, resource jobs,
   projection coordinator, and headless behavior.
6. Add the capability-gated Obsidian adapter, exact apply-origin ledger, live
   capture, interaction deferral, and two-profile desktop tests.
7. Complete resource installation and desktop/mobile gates, then release
   explicit per-file promotion.

Presence and browser/public collaboration MUST build on this canonical room;
they MUST NOT introduce another scene authority.
