# RFC 15: Excalidraw browser participation, publication, and collaboration

Status: implementation contract  
Target boundary: YAOS schema 10, storage format 6, protocol 8  
Scene protocol: `yaos-excalidraw-room-v1`  
Public projection protocol: `yaos-excalidraw-public-v1`  
Presence protocol: `yaos-presence-v2`  
Snapshot/recovery format: 4  
Date: 2026-09-09

Implementation status and remaining release gates are tracked in
`rfc-15-excalidraw-browser-publication-collaboration-implementation-report.md`.

## 1. Normative language

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and
**MAY** are normative. A component that violates a MUST is incompatible with
this RFC and MUST fail closed without changing RFC-13 canonical scene state.

This RFC defines three independently releasable profiles:

1. an enrolled full-vault member using the YAOS browser client;
2. a public read-only browser using an explicit drawing share;
3. a public read-write browser using an explicit drawing share.

Passing a later profile does not retroactively prove an earlier profile on a
different host or deployment. Public read-write MUST remain disabled unless
the read-only publication, revocation, resource, and privacy gates pass.

## 2. Decision summary

1. An enrolled browser is an ordinary YAOS device belonging to an owner or
   member. It receives complete-vault authority. RFC 15 does not introduce a
   browser-only, folder, viewer, or restricted-vault role.
2. The RFC-13 `ExcalidrawRoomDO` remains the only canonical scene authority.
   Public sharing MUST NOT create a second scene authority or forked public
   collaboration room.
3. The Drawing DO owns public grants, sanitized live projections, public
   sequences and replay, public receipts, publication manifests, sessions,
   resource mappings, and inbound resource quarantine for its drawing epoch.
4. Public users are `ShareActorContext` actors, never vault principals,
   members, devices, or tickets. Only dedicated public Excalidraw routes accept
   that actor type.
5. A public link uses a fragment-held random secret and an authenticated,
   encrypted route envelope. The fragment is exchanged for a short-lived,
   `HttpOnly` cookie. Link secrets, session cookies, and vault identifiers MUST
   NOT appear in public URLs, WebSocket queries, referrers, logs, or analytics.
6. Public scene state is a deterministic, versioned, sanitized live projection
   of canonical RFC-13 state. It is not independent authority. Every public
   sequence is share-local and reveals neither canonical room sequence nor
   canonical operation identity.
7. Resource publication is explicit and immutable. A share can read only the
   bounded artifacts selected by the owner and materialized into that share's
   publication namespace. Dependency traversal is forbidden.
8. Public edits contain only the public element representation. The Drawing DO
   maps opaque resource IDs, preserves canonical private sidecars, validates
   closure, and commits through RFC-13 native reconciliation in one transaction.
9. Public uploads enter drawing/share-scoped quarantine. They never become
   arbitrary vault files, reveal a vault path, or overwrite an existing file.
10. Grant revoke, expiry, permission downgrade, publication replacement, secret
    rotation, drawing fencing, and epoch replacement invalidate stale sessions
    and close affected sockets.
11. Presence protocol 2 serializes identity for the recipient audience. Public
    recipients receive grant-scoped pseudonyms for every participant and never
    receive principal, device, member-session, path, or drawing identities.
12. Public grants, secrets, sessions, inbound uploads, and publication objects
    are deployment-local security authority. Content backup, export, snapshot,
    and recovery MUST NOT restore or recreate them.

## 3. Scope and profiles

### 3.1 Profile A: enrolled browser

The same-vault browser client provides:

- ordinary owner/member authentication and device revocation;
- RFC-13 snapshot, replay, durable outbox, receipts, and scene convergence;
- RFC-14/RFC-15 presence;
- same-vault embedded and vault-resource resolution;
- offline editing, reconnect, and rejected-work preservation;
- the official pinned React Excalidraw component.

The browser MAY expose only one drawing in its user interface, but its device
credential still has the complete-vault authority defined by
`collaboration.md`. Product text MUST NOT imply that opening a drawing link
creates document-granular vault membership.

### 3.2 Profile B: public read-only

The public browser provides:

- a sanitized current scene and bounded public replay;
- explicitly published immutable resources;
- live public-safe updates;
- optional bounded presence, pointers, selections, and lasers;
- expiry, secret rotation, revocation, and immediate permission fencing;
- an Excalidraw view-mode interface with disabled editing controls.

Client read-only controls are presentation only. Every durable public route and
Drawing-DO mutation boundary MUST independently reject a read-only actor.

### 3.3 Profile C: public read-write

The public browser additionally provides:

- bounded native element operations against the public projection;
- durable public operation receipts and replay recovery;
- a share-scoped browser outbox;
- approved raster uploads through quarantine;
- preservation/export of work rejected after expiry, downgrade, or revocation.

Public editing grants no vault catalog, file, Markdown, Canvas, attachment,
settings, collaboration-governance, recovery, diagnostic, or operator access.

## 4. Non-goals

This RFC does not define folder-level sharing, restricted vault members, public
vault browsing, public back-of-card Markdown, recursive embedded-note sharing,
public comments or chat, voice, account identity for public users, anonymous
vault file uploads, arbitrary remote URL proxying, public SVG/PDF/HTML upload,
public plugin metadata editing, server-side Excalidraw rendering, or a second
public scene Durable Object.

This RFC does not make a bearer share private from a recipient who deliberately
copies it. Possession of an active link secret is the public admission
credential. Rotation and revocation stop future use; they cannot erase scene or
resource plaintext already received by a browser.

## 5. Version boundary

### 5.1 Required cutover

RFC 15 ships as one exact compatibility boundary:

| Boundary | Version |
| --- | ---: |
| Root/client schema | 10 |
| Durable storage format | 6 |
| Global HTTP/socket protocol | 8 |
| Public projection protocol | 1 |
| Presence protocol | 2 |
| Snapshot/recovery format | 4 |
| Collaboration policy | 2 |

Schema 10 is required even though the semantic Excalidraw root reference keeps
the RFC-13 shape. Browser caches, authority facts, presence identities, and
public-work preservation differ from schema 9 and MUST NOT be opened by a
schema-9 runtime.

Storage format 6 adds public authority and projection tables to the Drawing DO.
Protocol 8 is global because member sockets must understand public
pseudonymous presence and audience-aware protocol-2 frames. Collaboration
policy 2 adds owner-only `vault.public_shares.manage`.

A protocol-8 server MUST reject protocol-7 clients and tickets with
`update_required`. A protocol-7 server cannot admit an RFC-15 browser. Public
routes MUST return the same non-sensitive compatibility error without exposing
whether a link otherwise exists.

### 5.2 Migration and rollback

The schema-10/storage-6 boundary is greenfield. YAOS MUST NOT open or upgrade a
schema-9 browser cache, plugin cache, Node cache, Drawing DO, ticket, public
grant, public session, public receipt, or public resource namespace in place.

Migration imports ordinary materialized vault files into a fresh schema-10
deployment from a trusted full-vault device. Public shares MUST be recreated by
an owner. Old route envelopes, secrets, cookies, public IDs, publication
objects, and inbound quarantines remain invalid.

Rollback likewise exports ordinary files and imports them into a compatible
fresh deployment. No rollback procedure may copy share tables or public
security authority into the target deployment.

## 6. Terms and identities

| Term | Definition |
| --- | --- |
| `drawingId` | Internal RFC-13 stable drawing identity. Never returned by a public route. |
| `drawingEpoch` | Internal RFC-13 scene lineage. A change invalidates every share. |
| `shareId` | Owner-client-generated random 128-bit grant identity. Visible only on owner-authorized routes and internal service bindings. |
| `publicDrawingId` | Owner-client-generated random 128-bit, grant-scoped identifier safe for the public browser protocol. It is not a room locator or authority credential. |
| `grantRevision` | Positive safe integer naming exact public permission, secret, expiry, and admission authority. |
| `publicationRevision` | Positive safe integer naming one immutable resource manifest and public projection policy. |
| `publicSequence` | Monotonic sequence for public projection changes within one share publication lineage. |
| `publicOperationId` | Public-client random operation identity, unique within one grant for at least 30 days. |
| `routeEnvelope` | Versioned AEAD ciphertext containing internal routing scope. It grants no access without the link secret and current Drawing-DO grant. |
| link secret | Client-generated 256-bit random public bearer retained in the URL fragment until exchange. |
| public session | Short-lived cookie-authenticated admission to one current grant revision. |
| `ShareActorContext` | Server-created public actor containing only share/session authority. |
| public projection | Sanitized derivative state owned by the canonical Drawing DO. It is not canonical scene authority. |
| public resource ID | Random or keyed opaque ID mapped to one exact immutable object inside one publication. |
| inbound resource | Untrusted public upload retained in drawing/share quarantine. |

Native Excalidraw element IDs are content-level random identifiers needed for
binding and reconciliation. They MAY remain stable across canonical and public
representations. They MUST NOT be accepted as YAOS room, vault, resource, or
authorization locators.

## 7. Authority invariants

1. The Vault DO owns vault generation, drawing catalog/lifecycle, owner/member
   authority, and owner grant-management reservations.
2. The Drawing DO owns canonical scene state and every public grant and
   projection for the exact `(vaultGeneration, drawingId, drawingEpoch)`.
3. The edge owns public route-envelope decryption and constructs internal
   service requests. Decryption locates a Drawing DO; it does not authorize a
   session.
4. A public request is authorized only when the Drawing DO confirms an active
   grant, exact revisions, unexpired session, permitted action, exact
   `publicDrawingId`, and matching cookie authority.
5. `ShareActorContext` and `VaultActorContext` are disjoint tagged types. A
   public actor MUST NOT be converted to or accepted as a vault actor.
6. Only a current vault owner with `vault.public_shares.manage` may create,
   update, rotate, suspend, resume, or revoke a share.
7. The public projection cannot block or become canonical vault content. If a
   canonical member operation cannot be projected safely, the canonical commit
   remains eligible and the affected share is suspended in the same Drawing-DO
   transaction before unsafe output occurs.
8. A public write validates and commits its canonical scene effect and origin
   public projection atomically. It cannot acknowledge a public winner absent
   from canonical state.
9. Grant permission checks and public scene commit occur without an external
   await inside one Drawing-DO serialized transaction. The grant change or the
   scene operation orders first; there is no ambiguous in-flight write.
10. Public resource reads revalidate current grant and publication authority on
    every request. Knowledge of an object key, hash, old public ID, route
    envelope, or expired cookie is insufficient.
11. Rename preserves shares because it preserves drawing identity and epoch.
    Delete, demotion, reset, revive, epoch replacement, deployment replacement,
    and authority retirement invalidate them.
12. Recovery and export restore content only. They never restore public access.

## 8. Owner routes and governance

All owner routes use ordinary vault authentication and exact schema/protocol
headers. The route family is:

```text
GET    /vault/:vaultId/excalidraw/:drawingId/shares
POST   /vault/:vaultId/excalidraw/:drawingId/shares
GET    /vault/:vaultId/excalidraw/:drawingId/shares/:shareId
PATCH  /vault/:vaultId/excalidraw/:drawingId/shares/:shareId
DELETE /vault/:vaultId/excalidraw/:drawingId/shares/:shareId
POST   /vault/:vaultId/excalidraw/:drawingId/shares/:shareId/rotate-secret
POST   /vault/:vaultId/excalidraw/:drawingId/shares/:shareId/publication
GET    /vault/:vaultId/excalidraw/:drawingId/shares/:shareId/outcome/:operationId
```

Every mutation carries `operationId`, `requestDigest`, exact drawing epoch,
expected grant/publication revisions where applicable, and the owner-generated
secret digest when creating or rotating a link. A create request additionally
carries caller-generated random `shareId` and `publicDrawingId` values. Owner
clients MUST generate and durably retain those identities, the raw link secret,
and `linkSecretHash = sha256(secretBytes)` before their first network effect.
The raw secret is never included in an owner request.

The Vault DO obtains an idempotent owner authority reservation before calling
the Drawing DO. A reservation ordered before owner/device revocation MAY finish
on exact retry. A new grant-management operation after the fence MUST fail.

List and detail responses expose grant facts to the owner but never return raw
link secrets or session cookies. A create/rotate receipt returns the opaque
route envelope. The owner client combines it with its locally retained secret.
Losing that secret requires rotation; the server cannot recover it.

## 9. Public link and route envelope

The only supported public link form is:

```text
https://<deployment-host>/share#v1.<base64url(routeEnvelope)>.<base64url(secret)>
```

The server does not receive the fragment during the initial navigation. The
static application MUST set `Referrer-Policy: no-referrer`, parse the fragment
locally, exchange it, and remove it with `history.replaceState()` immediately
after a terminal exchange result.

The AEAD plaintext is a bounded canonical object containing:

```ts
interface ShareRouteEnvelopeV1 {
	v: 1;
	deploymentId: string;
	vaultGeneration: string;
	drawingId: string;
	drawingEpoch: number;
	shareId: string;
	publicDrawingId: string;
	issuedAt: number;
	keyId: string;
}
```

Encryption MUST use AES-256-GCM with a deployment-held versioned key, unique
96-bit random nonce, canonical associated data naming
`yaos-excalidraw-share-route-v1` and the authenticated deployment host. Key
rotation MAY retain old decryption keys for a declared window, but Drawing-DO
authority remains decisive.

The route envelope is an opaque locator, not a bearer. An attacker possessing
only it receives no scene, resource, session, permission, or existence oracle.
Tampering, another deployment, another host, another epoch, malformed bytes,
unknown key ID, and expired supported-key window all fail identically.

## 10. Public exchange and cookie session

### 10.1 Exchange

The public SPA sends:

```text
POST /api/excalidraw/shares/session
Content-Type: application/json
Origin: <exact deployment origin>

{ "version": 1, "routeEnvelope": "...", "secret": "..." }
```

The gateway decrypts the route envelope, strips every client-supplied internal
authority header, and forwards the route scope over a service binding. The
Drawing DO performs a constant-time comparison against the stored SHA-256
digest of the 256-bit secret and checks grant state, revision, expiry, drawing
epoch, and exchange rate limits.

Unknown share, wrong secret, revoked share, old epoch, and malformed envelope
MUST return the same public status and body. Rate-limit responses MAY differ
only by a generic retry delay.

On success the Drawing DO creates a random public session and the gateway sets:

```text
Set-Cookie: __Host-yaos-share-<publicDrawingId>=<sealed-session>;
            Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900
```

`publicDrawingId` uses the identity grammar and is safe in a cookie name. The
sealed cookie binds exact deployment, share, public drawing, grant revision,
publication revision, public session ID, issued time, expiry, and random nonce.
It is not accepted after 15 minutes and is renewable only while the same grant
authority remains active.

The response returns only public-safe facts: `publicDrawingId`, mode, presence
availability, public projection version, public sequence, session expiry, and
grant expiry. It does not return internal vault, drawing, epoch, share, object,
principal, or device IDs.

### 10.2 Session route family

Every public effect after exchange uses only:

```text
GET  /api/excalidraw/shares/session/snapshot
GET  /api/excalidraw/shares/session/replay
POST /api/excalidraw/shares/session/batch
GET  /api/excalidraw/shares/session/outcome
GET  /api/excalidraw/shares/session/ws
GET  /api/excalidraw/shares/session/resources/:publicResourceId
POST /api/excalidraw/shares/session/resources/uploads
PUT  /api/excalidraw/shares/session/resources/uploads/:uploadId/body
POST /api/excalidraw/shares/session/resources/uploads/:uploadId/finalize
POST /api/excalidraw/shares/session/renew
DELETE /api/excalidraw/shares/session
```

HTTP requests include `X-YAOS-Public-Drawing: <publicDrawingId>` and the
matching named cookie. The ID selects one cookie when several share tabs exist;
it supplies no authority by itself. WebSocket admission carries the same
public ID in the exact `Sec-WebSocket-Protocol` offer rather than a query
parameter. The server echoes only the registered protocol token.

No session endpoint accepts a vault ID, internal drawing ID, share ID, ticket,
member bearer, resource hash, R2 key, path, or authority revision from a query
string. WebSocket URLs have no authority-bearing query parameters.

All modifying HTTP requests require exact same-origin `Origin`, JSON content
type where applicable, the public-drawing header, and a valid `SameSite=Strict`
cookie. CORS is disabled for public session routes.

## 11. Share and publication state machines

### 11.1 Grant state

```text
ABSENT
  -> PROVISIONING
  -> ACTIVE_READ
  -> ACTIVE_WRITE

ACTIVE_READ  <-> ACTIVE_WRITE
ACTIVE_*     -> SUSPENDED -> ACTIVE_*
PROVISIONING -> REVOKED
ACTIVE_*     -> REVOKED
SUSPENDED    -> REVOKED
ACTIVE_*     -> EXPIRED
SUSPENDED    -> EXPIRED
```

`ACTIVE_READ` and `ACTIVE_WRITE` are represented by active status plus exact
mode. Upgrade, downgrade, secret rotation, expiry change, presence-policy
change, suspend, resume, and revoke increment `grantRevision`. Publication-only
replacement increments `publicationRevision` and invalidates sessions bound to
the previous publication.

`EXPIRED` is logically effective when server time reaches `expiresAt`, even if
an alarm has not materialized the row transition. Every request checks time.
`REVOKED` and `EXPIRED` are terminal. Reusing a path, copying a drawing, or
reviving content requires a new grant and public identity.

### 11.2 Initial publication saga

```text
OWNER_INTENT_DURABLE
  -> VAULT_OWNER_RESERVED
  -> GRANT_PROVISIONING
  -> PUBLICATION_STAGING
  -> ARTIFACTS_MATERIALIZED
  -> GRANT_ACTIVE
```

1. The owner client persists exact requested mode, expiry, presence policy,
   selected internal resource identities, generated `shareId`, generated
   `publicDrawingId`, generated `linkSecretHash`, operation ID, and digest.
2. The Vault DO validates owner capability and active drawing identity and
   returns an idempotent management permit.
3. The Drawing DO records a provisioning grant bound to exact canonical scene
   sequence/hash and creates durable bounded publication jobs.
4. Jobs sanitize the scene projection and copy only selected resources into a
   share publication namespace. They never traverse references.
5. One Drawing-DO transaction verifies every artifact hash and bound, installs
   projection rows, manifest, public sequence 1, and activation receipt, then
   changes the grant to active.
6. Only the active receipt makes exchange possible.

Response loss resumes from durable receipts. It MUST NOT create another grant,
secret digest, public drawing identity, or publication. A failed provisioning
grant is not publicly readable and may be retried or revoked.

### 11.3 Publication replacement

An active grant keeps its current publication readable while a complete next
publication is staged. When every selected artifact is present and validated,
one transaction swaps `publicationRevision`, public projection, manifest, and
public replay lineage. Existing sessions and sockets are invalidated and must
exchange again. The old publication becomes unreadable immediately and its
objects become deferred GC candidates.

A staging failure leaves the prior active publication untouched. It MUST NOT
partially add resources or expose the candidate manifest.

### 11.4 Revoke and downgrade

The Drawing DO applies grant revision change and invalidates session/nonces in
the same serialized transaction that establishes the new mode or terminal
state. It then best-effort sends a fatal public frame and closes matching
sockets. Failure to deliver close does not preserve authority because every
later HTTP, resource, upload, presence, and scene effect checks current state.

A scene transaction ordered before the grant transaction remains committed. A
scene request ordered after it is rejected. Timeouts retry the same operation
ID and digest; clients MUST NOT infer ordering from transport loss.

## 12. Drawing-DO storage format 6

Storage format 6 adds bounded tables equivalent to:

| Table | Key and purpose |
| --- | --- |
| `excalidraw_share_grants` | `share_id`; internal/public IDs, exact drawing epoch, status, mode, revisions, secret digest, presence policy, expiry, timestamps |
| `excalidraw_share_publications` | `(share_id, publication_revision)`; projection version, source sequence/hash, public head/sequence, manifest hash, state |
| `excalidraw_share_projection_elements` | `(share_id, publication_revision, element_id)`; complete sanitized records |
| `excalidraw_share_projection_events` | `(share_id, publication_revision, public_sequence)`; bounded redacted replay events |
| `excalidraw_share_resources` | `(share_id, publication_revision, public_resource_id)`; exact hash, size, MIME, immutable object locator, source class |
| `excalidraw_share_sessions` | `public_session_id`; exact revisions, cookie digest/nonce, pseudonym seed, expiry and rate state |
| `excalidraw_share_operation_receipts` | `(share_id, public_operation_id)`; request digest, disposition, canonical/public sequence evidence, expiry |
| `excalidraw_share_uploads` | `upload_id`; grant/session binding, expected bytes/hash/MIME, state, object locator, expiry |
| `excalidraw_share_jobs` | `job_id`; publication/upload GC work, exact source/target revisions, retry and terminal evidence |

Tables MUST carry exact drawing epoch even though the surrounding room names it.
Every SQL lookup and mutation includes share, epoch, and appropriate revision.
Public outcome lookup is restricted to the current session's share and public
operation; it cannot enumerate receipts from another session or grant.

Grant rows, route facts, public projections, sessions, receipts, publication
objects, and inbound uploads are intentionally absent from vault snapshots,
exports, recovery manifests, and recovery restores. GC and reset accounting
still MUST count them so deletion cannot leak deployment-local artifacts.

## 13. Live public projection

### 13.1 Projection authority

The public projection is a materialized derivative inside the canonical Drawing
DO. It has no independent merge rule. Its exact key is:

```text
(vaultGeneration, drawingId, drawingEpoch, shareId,
 grantRevision, publicationRevision, public-projection-v1)
```

Activation creates a sanitized snapshot at an exact canonical state hash and
room sequence. Each later canonical scene commit deterministically projects its
accepted records for every active grant. If public state changes, the same SQL
transaction updates public element rows, assigns one share-local
`publicSequence`, and inserts one redacted public event.

Canonical operations that change only private metadata need not advance a
public sequence. Public events do not contain canonical room sequence,
operation ID, request digest, actor, receipt, vault resource ID, or state hash.

The owner interface MUST explain that activation publishes current and future
scene geometry and text live. New binary or vault resources remain unavailable
until explicitly selected in a publication replacement.

### 13.2 Public element representation

Production code MUST export one exact
`PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1` allowlist and a frozen canonical hash of
that allowlist. `public-projection-v1` may copy only:

- pinned native identity, revision, deletion, ordering, geometry, appearance,
  grouping, locking, and binding fields required by supported Excalidraw 0.18;
- pinned type-specific standard fields needed for line, arrow, text, image,
  frame, embeddable, and freedraw rendering/editing;
- safe external links admitted by the URL policy;
- public resource IDs mapped from canonical file IDs.

It MUST remove auxiliary Markdown, plugin metadata, custom plugin fields,
vault paths, vault file IDs, R2 locators, internal resource IDs, member/device
identity, local AppState, collaborator state, and unsupported executable data.
Unknown fields are private sidecar data, not copied opportunistically.

Safe links are absolute `https:` or `mailto:` URLs inside their own length
bounds. `obsidian:`, `file:`, `data:`, `javascript:`, relative vault paths,
wiki links, block references, and unsupported schemes are removed. Rendering
an element whose link was removed remains valid.

### 13.3 Private sidecars and public writes

For an existing element, public input carries only the public representation.
Before canonical reconciliation the Drawing DO:

1. validates exact public protocol/revisions and complete record bounds;
2. maps public resource IDs to exact allowed canonical resources;
3. rejects mutation of absent, private, or another-share resource identities;
4. loads the current canonical element by native element ID;
5. rejects incompatible element-type substitution;
6. constructs a fresh canonical candidate from public allowlisted fields plus
   preserved current private/unknown sidecar fields;
7. validates native record, URL, resource, binding, container, and frame closure;
8. applies RFC-13 higher-version/lower-`versionNonce` reconciliation;
9. commits canonical records, canonical receipt/event, origin public receipt,
   and all affected active public projections in one transaction.

Public clients cannot set canonical plugin metadata, auxiliary Markdown,
resource locators, attribution, room sequence, or private sidecars. A newly
created public element begins with no private sidecar.

Equal version/nonce with different public or reconstructed canonical content is
equivocation and rejects the complete operation. Public editing never changes
the RFC-13 indivisible complete-element merge unit.

### 13.4 Projection failure

An unsafe or unprojectable member-authored record MUST NOT be disclosed and
MUST NOT roll back a valid canonical member commit. The same Drawing transaction
marks the affected grant `SUSPENDED`, advances its grant revision, invalidates
sessions, and records a non-sensitive reason. Its last projection immediately
becomes unreadable.

A public-origin operation is validated against the origin projection before
canonical commit. If its own result cannot be projected, the operation rejects
without canonical effect.

## 14. Public snapshot, replay, and receipt protocol

Public payloads use `publicDrawingId`; they never use internal `drawingId`,
`drawingEpoch`, `shareId`, or canonical sequence.

```ts
interface PublicSceneSnapshotV1 {
	publicProtocolVersion: 1;
	publicDrawingId: string;
	projectionVersion: "public-projection-v1";
	publicationRevision: number;
	publicSequence: number;
	elements: ExcalidrawElementRecord[];
	resources: PublicResourceManifestV1;
}

interface PublicSceneEventV1 {
	publicProtocolVersion: 1;
	publicDrawingId: string;
	publicationRevision: number;
	publicSequence: number;
	elements: ExcalidrawElementRecord[];
}

interface PublicReplayPageV1 {
	publicProtocolVersion: 1;
	publicDrawingId: string;
	publicationRevision: number;
	after: number;
	through: number;
	snapshotRequired: boolean;
	events: PublicSceneEventV1[];
	nextCursor: number | null;
}
```

Replay is contiguous and monotonic inside one publication revision. A future
cursor rejects. A cursor before retained history or from another publication
returns `snapshotRequired` without leaking another head. Publication replacement
always requires a new snapshot.

Public write requests are canonical JSON with an exact digest:

```ts
interface PublicBatchRequestV1 {
	publicProtocolVersion: 1;
	publicDrawingId: string;
	publicationRevision: number;
	publicOperationId: string;
	requestDigest: string;
	elements: ExcalidrawElementRecord[];
}
```

A receipt reports accepted/stale public element IDs, public sequence, current
publication revision, and whether it was replayed. It does not reveal canonical
sequence or IDs. Same operation ID and digest returns the original receipt.
Same ID with another digest is equivocation. A receipt cannot be queried by a
different public session unless it belongs to the same still-current share and
the implementation deliberately supports session recovery.

## 15. Public resources

### 15.1 Manifest

```ts
interface PublicResourceEntryV1 {
	publicResourceId: string;
	contentHash: string;
	size: number;
	mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	width?: number;
	height?: number;
	source: "published" | "rendered" | "inbound";
}

interface PublicResourceManifestV1 {
	version: 1;
	publicationRevision: number;
	entries: PublicResourceEntryV1[];
}
```

The manifest is immutable for one publication revision. Each entry binds share,
drawing epoch, grant revision, publication revision, public resource ID, exact
hash, size, MIME, and immutable object. A public ID from another drawing, share,
revision, resource, or hash is rejected.

Public clients fetch resources with authenticated `fetch()` and create browser
object URLs. HTML image tags MUST NOT receive a raw object URL, R2 locator,
bearer, or signed cross-origin URL.

### 15.2 Explicit owner publication

The owner selects each resource individually or through a UI operation whose
result is an explicit bounded list. Server code MUST NOT follow vault links,
Markdown embeds, nested drawings, back-of-card references, transclusions, or
arbitrary remote URLs to expand that list.

Embedded raster resources may be copied exactly after MIME and hash
validation. Markdown, nested drawings, equations, PDF pages, SVG, and other
active or composite content may be included only as separately approved,
sanitized immutable render artifacts. Their source content and dependency tree
remain private.

An excluded referenced resource produces an explicit missing/private
placeholder. It does not invalidate scene geometry and does not trigger a
fallback vault read.

### 15.3 Publication object lifecycle

Objects use a share/publication namespace opaque outside internal bindings.
The object key MUST NOT be derived solely from a public resource ID. A read
first validates current session/grant/publication state in the Drawing DO and
then streams the exact stored bytes with declared content length, allowlisted
MIME, `nosniff`, and private no-store caching.

Publication replacement, revoke, expiry, drawing retirement, and deployment
retirement make old objects unreachable before asynchronous deletion. R2
unavailability degrades the resource; it never causes the public client to ask
for a vault path or another object.

## 16. Public inbound-resource quarantine

Uploads are available only to `ACTIVE_WRITE` sessions. V1 accepts PNG, JPEG,
and WebP raster files. SVG, PDF, HTML, JavaScript, XML, fonts, archives, video,
audio, and unknown MIME are rejected. The server checks declared MIME, magic
bytes, exact length, digest, and bounded image dimensions where the format
permits safe header inspection.

The state machine is:

```text
ABSENT
  -> INTENT_RESERVED
  -> BODY_STORED
  -> VALIDATED
  -> ATTACHED

INTENT_RESERVED | BODY_STORED | VALIDATED -> ABANDONED -> REAPED
ATTACHED -> RETAINED | OWNER_IMPORTED | DELETED -> REAPED
```

1. The client computes content hash and persists an upload intent before its
   first request.
2. The Drawing DO creates a one-use upload ID bound to current share, grant,
   publication, session, expected hash, bytes, MIME, and expiry.
3. The body route reads at most the declared hard limit, hashes the actual
   bytes, validates media, and stores an opaque quarantine object.
4. Finalization rechecks current `ACTIVE_WRITE` authority. It allocates an
   internal drawing resource mapping and public resource ID and returns an
   idempotent receipt.
5. A later public scene operation may reference only that finalized public ID.

Revocation, downgrade, expiry, lost session, hash mismatch, or finalization
failure cannot attach the object. Pre-fence uploaded bytes may remain as
inaccessible GC orphans, but no pre-issued upload intent grants a post-fence
scene mutation.

An attached inbound resource belongs to the drawing quarantine, not to a vault
path. Vault members can render it through the Drawing resource resolver. Other
public shares cannot read it until an owner explicitly includes it in their own
publication. Owner import uses a separate reviewed managed-path operation and
MUST NOT overwrite an existing path.

## 17. Presence protocol 2 and audience safety

### 17.1 Actor domains

The RFC-14 kernel accepts one of:

```ts
type PresenceAuthority =
	| { kind: "member"; principalId: string; deviceId: string; displayName: string; colorSeed: string }
	| { kind: "share"; shareId: string; grantRevision: number; publicSessionId: string; pseudonymSeed: string };
```

Client JSON cannot assert either authority. The server reconstructs it from the
member socket attachment or validated public session.

### 17.2 Wire identities

Presence protocol 2 replaces raw server session keys with recipient-safe
`presenceId` values:

```ts
type VaultAudienceIdentity =
	| { kind: "member"; principalId: string; deviceId: string; displayName: string; color: string; colorLight: string }
	| { kind: "public"; participantId: string; pseudonym: string; color: string; colorLight: string };

interface PublicAudienceIdentity {
	kind: "public";
	participantId: string;
	pseudonym: string;
	color: string;
	colorLight: string;
}
```

Member recipients may receive normal member identity and public pseudonyms.
Public recipients receive `PublicAudienceIdentity` for every participant,
including members. `participantId`, `presenceId`, pseudonym, and colors are
derived with a grant-scoped server secret and cannot be correlated across
shares. Default pseudonyms are non-identifying labels such as `Host 1` and
`Guest 2`; vault display names are not reused unless a later explicit opt-in
RFC allows it.

The kernel MUST construct a fresh frame for each recipient audience. It MUST
NOT serialize a member frame once and forward it to public sockets. Public
frames contain no raw principal, device, member session, share, or internal
drawing IDs.

### 17.3 Behavior

RFC-14 full replacement, finite validation, 15-second TTL, 50 ms coalescing,
5-second refresh, 60-input/s abuse closure, 64 KiB presence drop threshold,
1 MiB durable close threshold, and 256-room-session limit remain in force.

A share may enable or disable public presence. Read-only sessions may publish
presence when enabled. Presence does not grant scene write, resource upload, or
session renewal. Disable, downgrade, revoke, expiry, or suspension withdraws
public presence and closes or refreshes the affected public socket as required.

Public selection and follow fields name public-safe element/presence IDs only.
They do not expose internal session identities.

## 18. Enrolled browser client

The member browser uses the pinned official React Excalidraw component and the
same protocol model as the Obsidian client. Shared DOM-independent packages own
canonicalization, native reconciliation, operation digesting, replay,
settlement, durable outbox, resource resolution, and presence. Browser and
Obsidian implementations MUST NOT maintain independent winner rules.

The browser adapter uses official `onChange`, pointer, collaborator, file, and
imperative `updateScene()` APIs. Remote application MUST use exact revision
evidence because native `updateScene()` can invoke `onChange`. Timers and one
global suppression boolean are forbidden.

Member browser credentials, RFC-13 document state, outbox, receipts, resources,
and rejected alternatives use a fresh schema-10 IndexedDB namespace. Work is
durable before send. Receipt settlement, replay gap handling, snapshot replace,
offline convergence, resource degradation, and authority supersession follow
RFC 13.

The member browser MAY create drawing-scoped embedded resources but MUST NOT
invent a vault path or silently import public resources. Owner share management
uses the explicit owner routes in section 8.

## 19. Public browser client

### 19.1 Common behavior

The public SPA is a separately built, pinned React Excalidraw application. It
accepts only public protocol objects, never imports member transport modules
that expose vault routes, and has no vault credential store.

It exchanges the fragment, removes it, opens the cookie-authenticated session,
fetches a public snapshot, opens the public socket, acknowledges exact hello
authority, and replays any sequence gap. Publication change requires a full
snapshot. It fetches manifest resources through authenticated same-origin
requests and installs them with the official Excalidraw file API.

### 19.2 Read-only

Read-only sets native view mode, removes mutation and upload controls, and does
not create a durable scene outbox. It may retain bounded in-memory presence.
DOM manipulation, a forged batch, a direct resource upload, or a modified SPA
cannot bypass server mode checks.

### 19.3 Read-write

Read-write captures complete changed public records and persists the exact
request, digest, publication revision, and resource dependencies in a
share-scoped schema-10 IndexedDB namespace before submission. It retains one
exact operation across retry and settles only after receipt plus public
sequence/replay evidence.

On downgrade, revoke, expiry, suspension, publication replacement, or epoch
change, the client stops new sends, preserves unresolved local work, and offers
a normal `.excalidraw` export containing only data already available to that
public browser. It MUST NOT repeatedly retry a terminal authority failure or
rewrite the operation under a fresh public session.

Session cookies and cached resources are cleared best effort on terminal
authority. Server revocation does not depend on successful client cleanup.

## 20. Exact hard limits

RFC-13 scene and element limits remain authoritative. RFC 15 additionally
requires:

| Resource | Limit |
| --- | ---: |
| Nonterminal shares per drawing epoch | 16 |
| Public sessions per share | 64 |
| Total member and public room sockets | 256 |
| Route envelope plus secret fragment | 4 KiB |
| Route-envelope plaintext | 2 KiB |
| Public session lifetime | 15 minutes |
| Public socket/session renewal interval | at most 5 minutes |
| Public grant expiry | required; 1 hour minimum, 30 days maximum |
| Public projection snapshot | 16 MiB encoded |
| Public batch | RFC-13 512 elements and 900,000 encoded bytes |
| Public replay | 256 events and 4 MiB per publication |
| Public receipts | 30 days; 20,000 or 64 MiB per share, whichever first |
| Publication manifest | 256 entries |
| Publication aggregate resources | 250 MiB |
| Published resource | 25 MiB |
| Inbound resource | 8 MiB |
| Pending inbound resources per share | 128 entries and 64 MiB |
| Upload intent lifetime | 15 minutes |
| Secret-exchange attempts | 10/minute/IP/share-route digest |
| Public durable writes | burst 10, sustained 2/second/session |
| Public snapshot/replay requests | 30/minute/session |
| Public resource requests | 300/minute/session, plus byte budget |

Encoded limits are checked before JSON parsing where possible and verified on
the parsed/canonical representation afterward. Hitting one independent limit
does not waive another. A room at grant, receipt, projection, replay, job, or
resource capacity rejects new growth before mutation and remains readable for
owner cleanup.

Near-limit projection, snapshot, hashing, image validation, and publication
work uses residency admission and yields between bounded units. Public work has
lower priority than canonical scene durability.

## 21. Errors and retry behavior

Public errors are bounded codes without internal details:

| Code | HTTP | Retry | Meaning |
| --- | ---: | --- | --- |
| `share_unavailable` | 404 | never without a new/rotated link | unknown, wrong secret, revoked, expired, wrong deployment, or wrong epoch |
| `session_expired` | 401 | exchange if link remains valid | cookie expired or invalid |
| `permission_denied` | 403 | never for same authority | action outside current mode |
| `permission_downgraded` | 409 | preserve/export | queued write lost write authority |
| `publication_superseded` | 409 | snapshot/re-exchange | publication revision changed |
| `projection_suspended` | 409 | owner action required | safe projection unavailable |
| `public_operation_equivocation` | 409 | never | same operation ID, another digest |
| `public_operation_expired` | 409 | preserve/export | operation older than receipt window |
| `public_snapshot_required` | 409 | snapshot | replay cursor outside retained lineage |
| `resource_not_published` | 404 | never | resource absent from exact manifest |
| `upload_not_allowed` | 403 | never for same authority | mode or type forbids upload |
| `upload_invalid` | 400 | new corrected intent | bytes/hash/MIME/dimensions invalid |
| `upload_quarantined` | 409 | finalize/status | body exists but is not attached |
| `public_capacity` | 503 | owner cleanup/retry | a hard retained-state bound is full |
| `rate_limited` | 429 | advertised bounded delay | session or edge rate exceeded |
| `public_storage_unavailable` | 503 | exact request | no durable result known |

A timeout never proves rejection. Idempotent writes retry exact bytes and IDs.
Terminal grant failures preserve local work and do not auto-fork it into a vault
or another share.

Public WebSocket fatal frames carry only public-safe code, current
`publicDrawingId` when already admitted, and whether re-exchange or snapshot is
allowed. Close codes distinguish update required, session invalid, grant
changed, publication changed, rate/backpressure, and drawing unavailable
without revealing internal authority.

## 22. Security and privacy

### 22.1 Route separation

- Public handlers MUST be registered separately from vault, ticket, blob,
  collaboration, recovery, diagnostic, and operator routes.
- Public requests MUST NOT pass through the vault actor authenticator as a
  synthetic member.
- Internal route headers are removed at the public edge and recreated only by
  trusted service bindings.
- Drawing internal endpoints compare every forwarded route-envelope field with
  room metadata before session effect.
- Public cookies are accepted only on `/api/excalidraw/shares/session/*`.

### 22.2 Browser policy

The public application MUST ship without third-party runtime JavaScript and use
headers equivalent to:

```text
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  connect-src 'self' wss:;
  img-src 'self' blob: data:;
  media-src 'none'; object-src 'none'; frame-src 'none';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Session, snapshot, replay, manifest, and owner-secret responses use
`Cache-Control: no-store`. Resource responses are private and must not be
public-CDN cacheable without an independently proven encrypted cache design.

### 22.3 Redaction

No public response, frame, cookie plaintext visible to JavaScript, diagnostic,
metric label, error, or telemetry event may contain:

- vault ID/name/generation, internal drawing/share ID, room/object/R2 key;
- path, file ID, vault resource ID, attachment locator, back-of-card content;
- principal ID, device ID/name, membership revision, role, capability digest;
- member display name/color seed, ticket, owner bearer, secret digest;
- canonical room sequence, operation ID/digest, state hash, or receipt.

Logs and traces hash internal drawing/share/session/operation/resource IDs with
a deployment-scoped diagnostic salt. They never record route-envelope bytes,
fragment secrets, cookie values, request authorization, element JSON, scene
text, resource bytes, or public upload bodies.

### 22.4 Abuse resistance

Secret exchange is rate-limited before expensive DO and cryptographic work when
possible and again at the Drawing DO. Secrets have 256 bits of entropy. Failure
responses do not reveal existence or which credential component failed.

Public rate, byte, session, grant, replay, receipt, upload, and publication
limits are independent. Presence is dropped before durable traffic. Public
snapshot/publication work is admitted below canonical vault operations.

## 23. Lifecycle, recovery, and garbage collection

- Rename preserves active shares without revealing the new path.
- Delete, demotion, revive, reset, epoch replacement, and room retirement
  invalidate grants before old public authority can observe the new lineage.
- Deployment key or generation replacement invalidates all route envelopes and
  cookies.
- Semantic reset/uninstall MUST report public grants, sessions, publication
  objects, uploads, and jobs as destructive pending resources.
- Room reaping deletes or tombstones grants, closes sockets, removes public
  projections/receipts/sessions, and schedules all publication/quarantine
  objects for deletion.
- GC retains current active publication objects, attached inbound resources,
  unresolved publication jobs, exact public receipts inside retention, and
  terminal evidence required to finish deletion.
- No recovery snapshot, vault export, or content restore treats those security
  objects as roots.

If public cleanup partially fails, access remains denied and cleanup retries as
overdue work. Availability failure MUST NOT reactivate a grant or make an
unvalidated object readable.

## 24. Observability

Owner-authenticated diagnostics MAY report aggregate counts and bytes for:

- grant states/modes and oldest provisioning/suspended age;
- public sessions/sockets, exchange failures, expiry, revocation closure;
- projection elements/events/snapshots and projection duration;
- publication jobs, selected/missing resources, objects and bytes;
- inbound upload states, validation rejection, attached/orphan bytes;
- public operations, receipts, replay/snapshot recovery and rate rejection;
- public presence frame/drop/expiry counts by audience;
- cleanup candidates and oldest failed GC job.

Metrics MUST distinguish enrolled-browser, public-read, and public-write
profiles and local, deployed, React, Obsidian desktop, and mobile evidence.
Public metrics must not use raw IDs as labels.

Alerts SHOULD fire at 80% of every grant, session, receipt, projection, event,
resource, upload, job, resident-byte, or socket cap; for a suspended share; for
publication work older than five minutes; and for terminal public artifacts not
reaped within policy.

## 25. Required conformance vectors

The repository MUST freeze requests, canonical hashes, receipts, sanitized
snapshots, public events, manifests, and audience frames for at least:

1. **Exact cutover:** schema 10/storage 6/protocol 8/presence 2 reject the prior boundary.
2. **Full-vault browser:** enrolled browser actor has ordinary member authority, not a document role.
3. **Route ciphertext:** valid envelope decrypts only under exact deployment/host/AAD/key.
4. **Route tamper:** bit flip, wrong host, wrong deployment, wrong key, and wrong epoch fail identically.
5. **Secret oracle:** unknown share, wrong secret, revoked, expired, and old epoch return one public error.
6. **Fragment hygiene:** raw link material is absent from HTTP navigation, referrer, history after exchange, logs, and WS URL.
7. **Cookie scope:** missing/wrong public ID, wrong named cookie, cross-origin request, and stale cookie fail.
8. **Owner authority:** member cannot create/update/revoke; pre-owner-fence exact operation can finish; later one cannot.
9. **Create response loss:** exact retry recovers one provisioning/active grant and route envelope.
10. **Publication atomicity:** one failed resource leaves prior publication or no active grant; no partial manifest is readable.
11. **Recursive graph:** a seven-level dependency graph publishes only explicit selected artifacts.
12. **Private fixture:** excluded back-of-card, path, nested note, and plugin metadata occur zero times in public bytes.
13. **Live projection:** canonical public-safe edit advances public sequence and converges without canonical identifiers.
14. **Private-only edit:** canonical private metadata change does not leak or needlessly advance public state.
15. **Unknown unsafe record:** canonical member commit succeeds while share suspends before disclosure.
16. **Public sidecar preservation:** public edit changes allowed fields and preserves every private canonical field.
17. **Public equivocation:** equal native revision with different content rejects atomically.
18. **Lower nonce:** public, canonical server, enrolled browser, and Obsidian select the same lower-nonce winner.
19. **Binding closure:** a public atomic bound-element change cannot expose a torn canonical/public scene.
20. **Read-only bypass:** forged HTTP, altered UI, socket frame, and upload all fail without room-sequence change.
21. **Read-write receipt loss:** retry returns the original canonical/public result exactly once.
22. **Downgrade race:** write and downgrade serialize; before commits, after rejects and is exportable.
23. **Revoke race:** HTTP, WS, replay, presence, resource read, upload body, and finalize lose authority immediately after fence.
24. **Expiry without alarm:** server-time expiry denies every route before cleanup runs.
25. **Secret rotation:** old fragment/cookie/socket fail; new link enters the same current public projection.
26. **Publication replacement:** old resource IDs, cookies, cursors, and replay fail after atomic swap.
27. **Cross-substitution:** another share/drawing/epoch/public resource/hash/public operation cannot be substituted.
28. **Missing resource:** scene remains visible with placeholder and no vault fallback request.
29. **Inbound validation:** wrong hash/size/MIME, polyglot, active media, and oversized input never attach.
30. **Inbound revoke:** pre-fence body may become GC orphan but cannot finalize or enter a scene post-fence.
31. **No vault import:** public upload creates no path and overwrites no attachment.
32. **Audience identity:** public frames contain only grant-scoped aliases for members and guests; member frames may retain member identity.
33. **Audience non-correlation:** the same member/session produces unrelated public IDs in two shares.
34. **Presence independence:** read-only pointer changes no canonical/public durable sequence.
35. **Backpressure:** public presence drops before public durable events; durable gap closes and replays.
36. **Public offline rejection:** revoked offline work never enters a fresh session and remains exportable.
37. **Recovery exclusion:** snapshot/export/restore recreates scene content but zero grants, cookies, manifests, or inbound authority.
38. **Lifecycle:** rename preserves; delete/demote/revive/epoch replacement invalidate all public access.
39. **Redaction corpus:** public HTTP, WS, errors, cookies exposed to JS, telemetry, and retained test artifacts contain no forbidden fixtures.
40. **Bounds:** every section-20 boundary accepts its exact maximum and rejects maximum plus one before unsafe state.

## 26. Validation matrix

### 26.1 Pure, property, and fuzz tests

Tests cover envelope canonicalization/AEAD, token parsing, grant state machines,
owner reservations, secret comparison, cookie parsing, public sanitizer and
private-sidecar grafting, URL policy, resource ID mappings, immutable manifests,
public sequence/replay/receipt behavior, lower-nonce reconciliation, binding
closure, audience identity derivation, all limits, and redaction.

Randomized operation permutations compare canonical state with pinned upstream
Excalidraw and compare public projections after every order. Generated private
fixtures are searched byte-for-byte in every public artifact.

### 26.2 Protocol and local Worker

CLI clients exercise owner creation/update/rotation/revoke, response loss at
every saga stage, public exchange, cookie admission, snapshot/replay/batch,
read-only abuse, public receipts, expiry, downgrade races, resource publication,
upload quarantine, R2 faults, alarms, hibernation, capacity, cleanup, and
schema/protocol rejection on real local SQLite Durable Objects.

### 26.3 Real React browser

Playwright uses the pinned production React Excalidraw bundle in isolated
contexts for:

- enrolled browser to enrolled browser;
- enrolled browser to public read-only;
- enrolled browser to public read-write;
- public browser to public browser;
- read-only DOM and protocol bypass attempts;
- pointers, selections, lasers, aliases, and expiry;
- paste/upload, missing resources, offline/reconnect, reload, downgrade,
  revoke, rejected-work export, and publication replacement.

Canonical scene/projection assertions are primary. Screenshots prove read-only
controls, collaborator visuals, placeholders, and terminal UX.

### 26.4 Real Obsidian

Two desktop profiles and desktop/mobile MUST prove that member and public
browser operations render, persist, and recover through the real Obsidian
Excalidraw adapter without undo pollution, save loops, lost local alternatives,
cross-file apply, resource leakage, or private metadata loss.

Required journeys include active text/IME, freehand, bindings, images, public
revoke during edit/upload, plugin reload, mobile background beyond presence TTL,
and reconnect to a replaced publication.

### 26.5 Disposable deployed Worker

Every public release candidate repeats the protocol and React matrices against
a fresh deployment using real HTTPS, WebSockets, service bindings, Access on
member routes, unauthenticated public SPA routes, Drawing DO hibernation, R2,
alarms, expiry, revocation, key handling, and teardown.

Retained artifacts are redacted. The run uses unique vault/drawing/share IDs and
must acknowledge deletion of Worker, public objects, and temporary access
configuration. Local workerd success cannot substitute for this gate.

## 27. Rollout and feature gates

The three profiles have independent default-off flags:

1. `excalidrawBrowserMember` enables enrolled full-vault browser peers.
2. `excalidrawPublicRead` enables owner publication and read-only exchange.
3. `excalidrawPublicWrite` enables write mode and inbound resource quarantine.

The second requires the first profile's shared browser/runtime gates where
applicable. The third requires every read-only privacy, resource, expiry,
revocation, and deployed gate. A deployment may support member browser without
any public route and public read-only without public write.

RFC 15 also inherits every unresolved RFC-13 and RFC-14 production gate.
Browser success cannot waive closed-file projection, auxiliary Markdown
authority, lifecycle/epoch, state-hash/retention, durable resource jobs,
interaction deferral, real Obsidian desktop/mobile, or deployed runtime work.

## 28. Release gates

No profile is production-supported until:

- exact schema/storage/protocol/presence boundaries reject every mixed version;
- enrolled browser and Obsidian share one native winner and durable outbox model;
- public outputs pass the complete identifier/content redaction corpus;
- route envelopes, fragment exchange, cookies, origin checks, and service
  bindings expose no bearer or internal route in public URLs;
- owner-only grant management and immediate Drawing-DO fences pass response-loss races;
- public projection cannot become a second authority or lose private sidecars;
- public read-only is enforced at every server boundary;
- explicit manifests prove zero recursive dependency disclosure;
- publication replacement and resource reads reject stale revisions;
- inbound uploads remain bounded quarantine and never implicit vault files;
- audience-safe presence is non-correlatable across shares;
- expiry, revoke, downgrade, rotation, lifecycle, and deployment replacement
  invalidate sessions, sockets, replay, resources, uploads, and offline writes;
- content recovery restores zero deployment-local public authority;
- local Worker, real React, deployed Worker, real Obsidian desktop, and mobile
  results are reported separately and all required gates pass;
- reset, deletion, object GC, rollback, and teardown leave no readable public artifact.

## 29. Implementation order

1. Cut schema 10/storage 6/protocol 8/presence 2 and exact compatibility guards.
2. Add shared public protocol, projection allowlist, sanitizer, sidecar graft,
   manifest, route-envelope, cookie, and audience-identity models with frozen vectors.
3. Add Drawing-DO format-6 share tables, owner reservation boundary, idempotent
   grant/publication state machines, receipts, expiry, and cleanup.
4. Add same-vault browser transport, shared scene engine, IndexedDB outbox,
   official React adapter, resources, and member presence.
5. Add owner management routes and UI, encrypted fragment links, static public
   SPA, cookie exchange, public snapshot/replay/socket, and read-only enforcement.
6. Add live projection updates, public sequences/receipts, audience-aware
   presence, downgrade/revoke fencing, and redaction diagnostics.
7. Add immutable publication resource jobs, explicit selection UI, authenticated
   resource fetch, placeholders, replacement, and GC.
8. Add public read-write outbox, canonical sidecar-preserving transform,
   quarantine uploads, rejected-work export, and offline authority handling.
9. Run pure/protocol/local Worker/React suites, then disposable deployment and
   real Obsidian desktop/mobile matrices.
10. Enable member browser, then public read-only, then public read-write only
    after each profile's release gate remains clean.
