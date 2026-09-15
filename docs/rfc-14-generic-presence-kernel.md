# RFC 14: Generic presence kernel and Excalidraw presence

Status: implemented contract  
Target boundary: YAOS schema 9, storage format 5, protocol 7  
Presence protocol: `yaos-presence-v1`  
Surface protocol: `excalidraw-presence-v1`  
Date: 2026-09-09

## 1. Normative language

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and
**MAY** are normative. A component that violates a MUST is incompatible with
this RFC and MUST fail closed for presence without damaging durable RFC-13
scene synchronization.

This document specifies the implemented first version. It deliberately does
not specify a later subscription protocol, public-browser identities, presence
permissions independent of Drawing-room admission, durable awareness history,
or remote viewport control in Obsidian.

## 2. Decision summary

1. Presence uses the RFC-13 Drawing WebSocket and Drawing Durable Object. It
   does not use Yjs, a Presence DO, a second socket, SQL, room events, replay,
   durable scene snapshots, receipts, or a durable client outbox.
2. The global exact socket `PROTOCOL_VERSION` is **7**. Protocol-6 clients and
   servers are rejected at admission rather than negotiating presence.
3. The server sends the ordinary Drawing `hello` followed immediately by a
   complete `presence.snapshot`. There is no `subscribe`, `ready`, capability
   advertisement, or receive-only mode in v1.
4. One transport socket has one client-generated random `sessionId`. Duplicate
   live IDs are rejected. A reconnect obtains a newly generated transport
   session ID; v1 does not replace or resume an earlier session.
5. The server takes principal, device, display name, and color seed only from
   the authenticated socket attachment. Client-asserted identity and session
   fields are discarded when the server constructs its validated update.
6. A client update is a complete replacement state. The server retains the
   latest accepted state in the hibernatable WebSocket attachment, broadcasts
   at most once every 50 ms per session, and collapses faster updates to the
   latest sequence.
7. Presence expires after 15 seconds. A publishing client refreshes its full
   latest state every `PRESENCE_TTL_MS / 3`, currently 5 seconds. Server frames
   carry relative `expiresInMs`, never client or server wall-clock timestamps.
8. Presence is best effort. It is dropped to a socket above the 64 KiB presence
   buffer threshold. Durable scene traffic remains eligible until the 1 MiB
   scene threshold, where the socket closes and recovers through RFC-13 replay.
9. The generic kernel owns socket state, identity rewriting, rate enforcement,
   coalescing, expiry, snapshots, leave, and backpressure. The Excalidraw
   surface owns its bounded pointer, laser, selection, interaction, viewport,
   follow, and idle fields.
10. Obsidian renders the native collaborator roster, pointers, lasers, colors,
    and selections. It carries viewport and follow fields on the wire but MUST
    NOT apply a remote viewport or follow target in v1 because changing those
    AppState fields dirties the Excalidraw view.

## 3. Scope

RFC 14 adds transient same-vault presence to an active, promoted RFC-13
Excalidraw drawing:

- trusted collaborator identity;
- distinct concurrent transport sessions and devices;
- scene-coordinate pointer and laser positions;
- selected element IDs;
- active and editing element IDs;
- coarse interaction and idle state;
- viewport and follow fields for protocol continuity and future hosts;
- full initial roster snapshots;
- coalesced live state frames;
- graceful leave, socket-close leave, expiry, reset, and authority-fence leave;
- hibernation continuity from socket attachments;
- client-side relative expiry and socket-loss cleanup;
- a server kernel separated from the Excalidraw Drawing-room durable model.

All RFC-14 participants are already admitted full-vault members on an RFC-13
Drawing socket. The existing actor validation and `connect` authority
reservation remain the admission boundary. V1 does not introduce a new
read-only participant or public-share actor.

## 4. Non-goals

This RFC does not define:

- browser participation, browser rendering, or Playwright product gates;
- public viewing or editing links;
- public pseudonyms or share-grant revocation;
- Canvas host integration;
- chat, comments, voice, reactions, presence recording, or history;
- exact text caret, selection range, or IME composition presence;
- edit locks or authoritative ownership of an element;
- remote viewport application or follow mode in Obsidian;
- a user-facing hide-presence or receive-only privacy control;
- delivery acknowledgement or replay of missed presence frames;
- session replacement across reconnect.

The presence payload may describe interaction but never changes native
Excalidraw reconciliation. It cannot delay, reject, or override an RFC-13 scene
operation.

## 5. Version boundary

### 5.1 Exact protocol cutover

RFC 14 changes the global socket protocol from 6 to **7**. All schema-9 client,
server, CLI, Worker, Node, ticket, release, conformance, and deployment guards
MUST advertise and require protocol 7 exactly.

The root schema remains 9, server storage format remains 5, snapshot/recovery
format remains 4, and Excalidraw scene protocol remains
`yaos-excalidraw-room-v1`. No durable migration is required for presence.

A protocol-7 server MUST reject a protocol-6 ticket or socket with
`update_required`. A protocol-6 server cannot host an RFC-14 client. There is no
mixed protocol-6/protocol-7 Drawing room.

### 5.2 Presence and surface versions

The exact in-room discriminants are:

```ts
const PRESENCE_PROTOCOL_VERSION = 1;
const EXCALIDRAW_PRESENCE_SURFACE_VERSION = 1;

const EXCALIDRAW_PRESENCE_SURFACE = {
	kind: "excalidraw",
	version: 1,
};
```

An unknown presence or surface version is invalid on a protocol-7 Drawing
socket. V1 does not negotiate or translate versions.

## 6. Terms and identities

| Term | Definition |
| --- | --- |
| presence kernel | Format-neutral socket lifecycle, identity, rate, coalescing, expiry, snapshot, leave, and fan-out implementation. |
| surface | The validated application state carried by the kernel; v1 supports only Excalidraw. |
| `sessionId` | Random identity of one Drawing WebSocket connection, generated by the client transport and bound by the server connection reservation. |
| `clientSequence` | Positive safe integer increasing within one socket session. |
| presence state | One complete Excalidraw transient state or `null` withdrawal. |
| presence entry | Server-owned session and identity plus one non-null state and relative expiry. |
| socket attachment | Hibernatable server record holding trusted authority, current presence, sequence, timestamps, and rate metadata. |
| durable traffic | Scene events and liveness frames whose loss requires close/replay rather than best-effort dropping. |

`sessionId` is not a principal or device identity. Connecting from two devices
for one principal creates two sessions. Within one plugin manager, split views
of the same drawing deliberately share one engine, presence controller, socket,
and session through `HostGroup`; the shared remote roster renders into every
binding. An independent process or transport connection has its own session.

## 7. Authority and trust invariants

1. The Vault DO owns vault generation, actor, device, membership, drawing
   catalog, lifecycle, epoch, and the RFC-13 `connect` reservation.
2. The Drawing DO owns the live socket set and transient presence for the exact
   `(vaultGeneration, drawingId, drawingEpoch)` authority.
3. Every message first deserializes the socket attachment and compares it to
   current room metadata. A mismatch closes with application code `4403` and
   reason `drawing authority changed` before any presence effect.
4. A client cannot choose trusted `principalId`, `deviceId`, `displayName`,
   `color`, or `colorLight`. The server reconstructs those values from the
   authenticated permit and server-owned color seed.
5. Extra client fields, including asserted `identity` or top-level `sessionId`,
   are not copied into the parsed `PresenceClientUpdate` and have no effect.
6. The server-provided `sessionId` is the validated WebSocket query identity
   already used by the connection reservation, not any value inside an update.
7. Presence never changes Drawing SQL, room sequence, replay, scene snapshot,
   tombstones, receipts, metadata, resources, semantic catalog, or projection.
8. Rename preserves the room and sockets. Reset, delete, demotion, epoch
   replacement, membership removal, and device revocation remove affected
   presence and close affected sockets.

## 8. Session admission and reconnect

The client ticket transport generates a new 32-character random `sessionId`
for each socket URL. The Drawing DO validates it with the existing identity
grammar and includes it in the connect reservation digest.

Before accepting a socket, the room:

1. validates WebSocket upgrade and exact drawing epoch;
2. removes expired presence from authoritative sockets;
3. rejects an existing live authoritative socket with the same `sessionId`
   using HTTP `409` and `excalidraw_session_already_connected`;
4. rejects the connection with HTTP `429` and
   `excalidraw_room_session_limit` when 256 authoritative sockets are already
   present;
5. obtains the RFC-13 Vault-DO connect permit;
6. stores the trusted authority and identity in the server socket attachment;
7. accepts the socket;
8. sends Drawing `hello` containing the exact `sessionId`;
9. immediately sends the current sorted `presence.snapshot`.

V1 has no `connectionId` and no duplicate-session replacement protocol. A
reconnect performs the ordinary ticket path and obtains a new random session.
The old session disappears through close or expiry. Clients must not assume
that follow state, a remote map key, or a local sequence survives reconnect.

## 9. Wire encoding

Presence uses UTF-8 JSON text on the existing Drawing WebSocket. The common
inbound frame limit applies before JSON parsing. A valid incoming message is
either the existing Drawing ping or `presence.update`.

The four v1 presence frames are:

- client-to-server `presence.update`;
- server-to-client `presence.snapshot`;
- server-to-client `presence.state`;
- server-to-client `presence.leave`.

There are no timestamps, acknowledgements, error frames, subscribe frames,
ready frames, resync frames, or connection IDs. Presence JSON is not hashed,
signed separately, written to receipts, or replayed.

## 10. Typed protocol

### 10.1 Surface state

```ts
interface PresenceSurface {
	kind: "excalidraw";
	version: 1;
}

interface ExcalidrawPresencePoint {
	x: number;
	y: number;
}

interface ExcalidrawPresencePointer extends ExcalidrawPresencePoint {
	tool: string;
	button: "up" | "down";
}

interface ExcalidrawPresenceViewport {
	scrollX: number;
	scrollY: number;
	zoom: number;
	width: number;
	height: number;
}

interface ExcalidrawPresenceState {
	pointer?: ExcalidrawPresencePointer;
	laser?: ExcalidrawPresencePoint;
	selectedElementIds?: string[];
	activeElementId?: string | null;
	editingElementId?: string | null;
	interaction?:
		| "idle"
		| "pointing"
		| "drawing"
		| "dragging"
		| "resizing"
		| "rotating"
		| "editing"
		| "panning";
	viewport?: ExcalidrawPresenceViewport;
	followSessionId?: string | null;
	idle?: "active" | "idle" | "away";
}
```

Pointer and laser coordinates are Excalidraw scene coordinates. Viewport values
are captured from the local Excalidraw AppState. V1 accepts a bounded tool
identifier rather than limiting the wire to the two tools currently rendered
by the Obsidian adapter.

The state is a complete replacement. Omission removes a previously transmitted
optional field. `{}` is valid roster-only state. `state: null` is an explicit
withdrawal.

### 10.2 Client update

```ts
interface PresenceClientUpdate {
	type: "presence.update";
	presenceProtocolVersion: 1;
	surface: PresenceSurface;
	clientSequence: number;
	state: ExcalidrawPresenceState | null;
}
```

`clientSequence` begins at 1 and increases for every client publication,
including refresh and withdrawal. The server ignores a sequence less than or
equal to the last accepted sequence. An ignored sequence neither changes state
nor refreshes expiry.

The server parser constructs a fresh object from allowlisted state fields.
Unknown outer fields are discarded. Invalid values in recognized state fields
make the entire update invalid.

### 10.3 Trusted identity and entry

```ts
interface PresenceIdentity {
	principalId: string;
	deviceId: string;
	displayName: string;
	color: string;
	colorLight: string;
}

interface PresenceEntry {
	sessionId: string;
	clientSequence: number;
	expiresInMs: number;
	identity: PresenceIdentity;
	state: ExcalidrawPresenceState;
}
```

`expiresInMs` is calculated when the server frame is built. It is an integer
from 0 through 15,000. A client converts it immediately to a local monotonic
deadline. It MUST NOT interpret it as an epoch time or compensate with a wall
clock.

The identity color is the existing YAOS deterministic HSL pair derived from
the server-owned `colorSeed`:

```text
hsl(<0..359>, 72%, 52%)
hsla(<0..359>, 72%, 52%, 0.2)
```

### 10.4 Server frames

```ts
interface PresenceStateFrame {
	type: "presence.state";
	presenceProtocolVersion: 1;
	surface: PresenceSurface;
	presence: PresenceEntry;
}

interface PresenceSnapshotFrame {
	type: "presence.snapshot";
	presenceProtocolVersion: 1;
	surface: PresenceSurface;
	presences: PresenceEntry[];
}

interface PresenceLeaveFrame {
	type: "presence.leave";
	presenceProtocolVersion: 1;
	surface: PresenceSurface;
	sessionId: string;
	reason: "client" | "closed" | "expired" | "fenced" | "reset";
}
```

A snapshot is a complete replacement of the client's remote roster. Entries
are sorted lexicographically by `sessionId` and contain no expired state.

The kernel broadcasts `presence.state` to every authoritative socket,
including the origin. The client transport learns its exact local `sessionId`
from Drawing `hello`, drops a state for that ID, and removes that ID from a
snapshot before delivering the frame to the generic client. This keeps the
server fan-out simple and prevents self-rendering.

## 11. Exact validation and hard limits

The following constants from `server/src/shared/presenceProtocol.ts` are the v1
contract:

| Constant | Value |
| --- | ---: |
| `PRESENCE_TTL_MS` | 15,000 ms |
| `PRESENCE_MIN_BROADCAST_INTERVAL_MS` | 50 ms |
| `MAX_PRESENCE_FRAME_BYTES` | 16 KiB |
| `MAX_PRESENCE_INPUT_FRAMES_PER_SECOND` | 60 |
| `MAX_PRESENCE_SELECTED_ELEMENT_IDS` | 256 |
| `MAX_PRESENCE_SESSIONS` | 256 |
| `MAX_PRESENCE_SOCKET_BUFFER_BYTES` | 64 KiB |
| `MAX_SCENE_SOCKET_BUFFER_BYTES` | 1 MiB |
| scene coordinate magnitude | 10,000,000 |
| viewport dimension | 0 through 100,000 |
| zoom | 0.01 through 128 |
| tool identifier | 1 through 32 ASCII letters, digits, `_`, or `-` |
| identity-shaped string | 1 through 160 ASCII letters, digits, `_`, or `-` |
| display name | 1 through 128 JavaScript characters, no U+0000–U+001F or U+007F |

Additional validation rules:

- all numbers are finite;
- `clientSequence` is a positive safe integer;
- selected element IDs are individually valid and unique, but need not be
  sorted;
- `activeElementId`, `editingElementId`, and `followSessionId` may be absent,
  null, or a valid identity-shaped string;
- duplicate session IDs invalidate a server snapshot;
- `expiresInMs` is a safe integer within 0 through the TTL;
- identity colors must match the exact generated HSL syntax;
- recognized enums accept only the values in section 10;
- a Canvas surface or future presence version is invalid in v1.

The parser need not reject unknown keys that it does not copy. Security relies
on fresh trusted-object construction, not object spreading or attempting to
enumerate every malicious spelling.

## 12. Server socket attachment

The hibernatable attachment extends the RFC-13 room authority with:

```ts
interface PresenceSocketAttachment {
	sessionId: string;
	principalId: string;
	deviceId: string;
	displayName: string;
	colorSeed: string;
	presence?: ExcalidrawPresenceState;
	presenceClientSequence?: number;
	presenceUpdatedAt?: number;
	presenceLastBroadcastAt?: number;
	presenceLastBroadcastSequence?: number;
	presenceRateWindowStartedAt?: number;
	presenceRateWindowCount?: number;
}
```

The room serializes the attachment after accepted state, withdrawal, broadcast
metadata changes, rate-window changes needed before closure, expiry, and leave.
The bounded current state and rate metadata therefore survive Durable Object
hibernation. A later socket connection can receive a continuous snapshot by
enumerating socket attachments; no resync request or client republish is
required merely because the object hibernated.

Presence attachment state is platform-managed socket state, not Drawing SQL.
The implementation MUST NOT create a presence table, event, receipt, or alarm.
When the socket ceases to exist, its attachment ceases to be presence
authority.

## 13. Server processing state machine

For each message on an authoritative socket:

```text
FRAME
  -> reject/close if encoded bytes exceed 16 KiB
  -> parse JSON
  -> PING: sweep expiry, send durable pong
  -> PRESENCE.UPDATE: parse bounded surface
       -> ignore stale/equal sequence
       -> advance fixed rate window
       -> close if window count exceeds 60
       -> NULL: remove and broadcast client leave
       -> STATE: serialize latest state and expiry origin
            -> publish now if prior publish >= 50 ms ago
            -> otherwise retain latest in one scheduled coalescing slot
```

The kernel runs expiry and due-flush checks during message processing. A
scheduled callback re-enumerates the exact session before publishing. If the
session disappeared, withdrew, expired, reset, or was fenced, the callback does
nothing.

One accepted state replaces the prior state in the attachment. A scheduled
flush does not retain a list of intermediate frames. It publishes only when
`presenceClientSequence !== presenceLastBroadcastSequence`.

## 14. Rate and coalescing behavior

V1 uses a fixed per-socket one-second rate window, not token buckets:

- the first accepted candidate establishes `presenceRateWindowStartedAt` and
  count 1;
- after 1,000 ms, the next candidate begins a new window at count 1;
- otherwise each newer-sequence candidate increments the count;
- count 61 removes existing presence, broadcasts `closed` when applicable, and
  closes the socket with `1008`, `presence rate exceeded`.

There is no independent room byte bucket or room frame bucket in v1. The 256
socket cap, per-socket input rate, frame bound, 50 ms output coalescing, and
socket buffer thresholds are the implemented bounds.

The generic client publishes interactive state no more frequently than once
per 50 ms by default. Scene/AppState changes are ambient and coalesce at 200 ms
by default. Both paths update one latest full state; they do not enqueue
patches. Tests may inject shorter intervals under a fake clock without changing
production constants.

## 15. TTL, refresh, expiry, and leave

### 15.1 Publication refresh

While a non-null local state and publisher exist, the client republishes the
latest complete state every:

```ts
Math.floor(PRESENCE_TTL_MS / 3) // 5,000 ms
```

The refresh increments `clientSequence` and resets server expiry if accepted.
It preserves stationary cursors and roster presence without inventing a
separate heartbeat frame.

The Excalidraw controller marks its local host state idle after 30 seconds
without a new pointer or scene presence capture. It clears pointer and active
element, sets interaction to `idle`, and publishes ambient state. V1 does not
currently synthesize `away` in the Obsidian controller, though the wire enum
accepts it.

### 15.2 Server expiry

The server stores `presenceUpdatedAt` in the socket attachment. A state expires
when server time reaches `presenceUpdatedAt + 15,000`. Expiry is swept on
connection, ping, presence input, scheduled flush, and snapshot construction.
The server clears state, reserializes the attachment, and broadcasts a leave
with reason `expired`.

No SQL write or Durable Object alarm exists for expiry. The client independently
removes a remote entry at its receipt-relative monotonic deadline, with a
default sweep interval of one second. Thus a cursor disappears locally even if
no later server event discovers expiry.

### 15.3 Other leave reasons

- `client`: sender published `state: null`;
- `closed`: socket close, socket error, or rate closure removed live state;
- `fenced`: member/device/drawing authority closure;
- `reset`: room epoch reset closes the prior live state.

Leave is idempotent and keyed only by `sessionId`. Because duplicate live
sessions are forbidden and reconnect gets a new ID, v1 does not need a
connection generation.

On local controller stop, the client makes one best-effort null publication
before closing/unbinding, cancels all timers, clears its remote roster, and
clears native collaborators.

## 16. Hibernation behavior

Hibernation does not erase current presence because all current state necessary
for a roster snapshot is serialized with each accepted WebSocket attachment.
After activation the kernel enumerates authoritative sockets and reconstructs a
snapshot directly from those attachments.

The server recalculates every entry's relative `expiresInMs` at snapshot or
state creation. State whose deadline has passed is cleared first and omitted.
Snapshots are therefore continuous across runtime reconstruction without
making presence a durable SQL domain.

Pending JavaScript coalescing timers are not themselves durable. If a runtime
is evicted before a pending latest state broadcasts, the state remains in the
attachment with different accepted and last-broadcast sequences. The next
message, ping, connection, or flush-due pass can publish it; otherwise the next
5-second client refresh republishes it. Intermediate presence loss remains
permitted.

## 17. Backpressure and durable priority

Presence and scene traffic have different send policy:

```text
bufferedAmount <= 64 KiB:
  presence and durable frames may send

64 KiB < bufferedAmount <= 1 MiB:
  presence is silently dropped; durable scene frames still send

bufferedAmount > 1 MiB:
  durable send closes 1013 "scene delivery backpressure"
  client reconnects and uses RFC-13 replay/snapshot recovery
```

The client publisher likewise sends presence only while its WebSocket
`bufferedAmount <= 64 KiB`. It keeps at most one serialized pending presence
frame while the socket is not yet open. Presence send failure has no retry
receipt and does not create a scene gap.

The kernel performs no SQL transaction, Vault-DO call, scene reconciliation,
resource read, or durable queue insertion. Dropping a presence frame cannot
change room sequence or prevent the durable frame from being sent under its
larger threshold.

## 18. Generic kernel boundary

The server `PresenceKernel` is generic over an attachment and socket satisfying
the presence port. It owns:

- authoritative socket enumeration;
- exact session collision lookup;
- trusted attachment identity to wire identity;
- current snapshot construction;
- update sequence and fixed-window rate enforcement;
- latest-state coalescing;
- relative expiry and leave;
- best-effort fan-out under the presence buffer threshold.

The Drawing room owns:

- JSON message discrimination and the 16 KiB common input bound;
- room authority comparison;
- connect reservation and 256-socket admission;
- hello-before-snapshot ordering;
- reset and actor/device fence invocation;
- durable traffic delivery and scene recovery behavior.

The shared surface protocol owns parse/validation and deterministic color
construction. The client `PresenceClient` owns publication cadence, refresh,
receipt-relative expiry, snapshot replacement, leave handling, and remote
roster callbacks.

No generic API in v1 accepts an arbitrary client-defined schema. The only
registered surface is compiled Excalidraw v1.

## 19. Obsidian Excalidraw host contract

### 19.1 Capture

For each promoted live `ExcalidrawView`, the adapter:

1. wraps that view's public `onPointerUpdate` only;
2. invokes the exact original first with its original receiver and arguments;
3. captures scene-coordinate pointer, laser tool, button, and optional laser
   color;
4. obtains AppState through `excalidrawAPI.getAppState()`;
5. registers the supported global scene hook for `selectedElementIds`,
   `editingElement`, `draggingElement`, `scrollX`, `scrollY`, `zoom`, and
   `userToFollow` while preserving prior hook keys and callback;
6. demultiplexes the hook by the exact view object;
7. restores only its own installed wrapper and hook registration on release.

The adapter derives width and height from live AppState when present. It emits
pointer changes as interactive presence and scene/AppState changes as ambient
presence. Current Obsidian interaction mapping is intentionally coarse:
`editing`, `dragging`, `pointing`, or `idle`.

### 19.2 Wire mapping

The controller maps a normal pointer to `pointer`. It maps a laser callback to
the separate `laser` point. It includes selected IDs, active/editing ID,
interaction, viewport, captured follow session, and active/idle state.

The wire allows richer interaction states and `away` for forward-compatible
surface producers, but the Obsidian adapter need not synthesize every value.

### 19.3 Rendering

The adapter builds a native Excalidraw collaborator map keyed by remote
`sessionId`. Each entry includes:

- trusted display name;
- trusted stroke and background colors;
- pointer or laser coordinates and supported tool;
- pointer button;
- selected element IDs;
- trusted principal ID as native collaborator `actorId` where supported.

It applies only:

```ts
excalidrawAPI.updateScene({ collaborators })
```

It MUST NOT apply remote `scrollX`, `scrollY`, `zoom`, `width`, `height`,
`followSessionId`, active element, editing element, or interaction to AppState.
The current embedded Excalidraw path marks those AppState mutations dirty and
can trigger autosave; v1 therefore transports them but does not implement
remote viewport following in Obsidian.

Collaborator-only application may invoke an upstream callback but must produce
no RFC-13 element operation. Durable capture still diffs complete native
element revisions and ignores collaborator AppState.

### 19.4 Lifecycle and degradation

Binding release restores the exact original pointer function, removes only the
YAOS hook subscriber, clears expected remote revision evidence, and allows the
presence controller to clear collaborators. Prototype, React-fiber, DOM,
autosave, dirty-state, and `ViewSaveCoordinator` patching remain forbidden.

Missing pointer or collaborator APIs degrade presence for that view without
changing promoted scene authority. The RFC-13 scene capture/apply capability
gate remains separate.

## 20. Client transport and roster behavior

The Excalidraw socket transport:

- stores the exact `sessionId` from server `hello`;
- accepts and validates the immediately following snapshot;
- removes its own session from snapshots;
- drops a `presence.state` whose session equals the local hello session;
- forwards other presence frames to the presence controller;
- treats a malformed `presence.*` server frame as protocol failure and closes
  with `1002`, `invalid_presence_frame`;
- keeps scene event parsing and gap recovery independent of valid presence;
- clears the presence client's remote roster when the publisher/socket unbinds.

The generic client applies `presence.snapshot` as a full roster replacement,
applies `presence.state` by session key, and applies leave by deleting that
session. It records `localExpiresAt = monotonicNow + expiresInMs` on receipt.
No wall-clock synchronization is required.

V1 relies on ordered WebSocket delivery for server frames. It retains
`clientSequence` in remote entries for observability and validation but does not
define cross-socket replay or reordering recovery.

## 21. Privacy and security boundary

V1 presence is scoped to already-authorized full-vault members in one exact
drawing epoch. It is not a publication mechanism. The surface contains no
element text, Markdown, file bytes, resource body, vault path, URL, access
token, or arbitrary AppState object.

Element IDs and internal member/device IDs are visible to same-vault peers.
That is acceptable only at the full-vault boundary. A future public share MUST
not reuse `PresenceIdentity`; it needs a separate redacted identity and grant
contract.

The server ignores client identity assertions, derives colors from trusted
state, isolates by authoritative room sockets, bounds every recognized
container, and drops transient output before durable traffic. Presence state
MUST NOT be written into application logs, audit bodies, SQL, replay, recovery,
or drawing files.

## 22. Errors and closure behavior

| Condition | Result |
| --- | --- |
| Wrong global protocol | Admission rejects with `update_required`. |
| Duplicate live session | HTTP `409`, `excalidraw_session_already_connected`. |
| More than 256 authoritative sockets | HTTP `429`, `excalidraw_room_session_limit`. |
| Frame over 16 KiB | Close `1009`, `room frame too large`. |
| Invalid JSON or invalid presence shape | Close `1008`, `invalid room frame`. |
| Sequence not newer | Silently ignore; no expiry refresh. |
| More than 60 newer updates in fixed second | Remove presence; close `1008`, `presence rate exceeded`. |
| Authority mismatch | Close `4403`, `drawing authority changed`. |
| Presence destination over 64 KiB | Silently skip presence for that socket. |
| Durable destination over 1 MiB | Close `1013`, `scene delivery backpressure`; replay after reconnect. |
| Malformed server `presence.*` | Client closes `1002`, `invalid_presence_frame`. |
| Socket loss | Client clears all remote collaborators; reconnect uses new session. |

Presence has no application-level error frame or retry-after contract in v1.

## 23. Compatibility and future evolution

`(presenceProtocolVersion, surface.kind, surface.version)` is exact. Adding a
field that old parsers can safely discard may remain source-compatible, but any
change to accepted semantics or required fields requires a new surface version.
A new presence framing or lifecycle requires a new presence protocol version
and, because socket admission is exact, normally a global protocol bump.

Future work may add Canvas, browser, redacted public identity, or safe follow
application. It MUST preserve these separation rules:

- no presence in durable document models;
- server-owned identity;
- session rather than principal map keys;
- bounded full replacement state;
- relative expiry;
- best-effort delivery below durable priority.

It must not be retroactively described as v1 behavior.

## 24. Required conformance vectors

The implemented v1 requires these exact vectors:

1. **Protocol cutover:** all release surfaces advertise protocol 7 and reject
   protocol 6.
2. **Hello ordering:** a connection receives Drawing `hello` before its initial
   `presence.snapshot`.
3. **Trusted identity:** client-asserted identity/session extras are discarded;
   peers receive permit principal, device, display name, and derived colors.
4. **Two devices:** two transport sessions for one principal remain distinct.
5. **Split views:** same-manager views of one drawing share one session and the
   remote roster renders through every `HostGroup` binding.
6. **Duplicate live ID:** second connection with an existing authoritative
   session returns 409 and does not displace it.
7. **Capacity:** connection 257 returns 429 without affecting existing sockets.
8. **Room isolation:** presence cannot cross drawing, epoch, vault generation,
   or non-authoritative sockets.
9. **Bounded parser:** finite boundary coordinates, viewport, tool, IDs, enums,
   identity, and HSL forms pass; out-of-range variants fail.
10. **Selections:** 256 unique valid IDs pass under frame size; 257 or duplicate
    IDs fail.
11. **Relative expiry:** `expiresInMs` within 0–15,000 passes; absolute
    `expiresAt` in place of it fails.
12. **Complete replacement:** a later state omitting a field removes that field
    in the attachment and next broadcast.
13. **Stale sequence:** lower/equal updates have no state or TTL effect.
14. **Coalescing:** sequences 2 and 3 within 50 ms yield one later state for 3.
15. **Refresh:** stationary latest state republishes every 5 seconds with a new
    sequence.
16. **Client withdrawal:** null state removes attachment state and broadcasts
    `client` leave.
17. **Close and error:** a live state is removed with `closed` leave.
18. **Expiry:** after 15,001 ms a sweep removes state, broadcasts `expired`, and
    omits it from snapshots.
19. **Local expiry:** receipt-relative deadline removes a silent remote peer
    without wall-clock dependence.
20. **Hibernation continuity:** reconstructing the room runtime over retained
    socket attachments produces a snapshot containing the unexpired state.
21. **No SQL:** no presence table exists and state never changes room sequence,
    receipt, event, or scene snapshot.
22. **Rate closure:** update 61 inside one fixed rate window closes 1008.
23. **Frame size:** 16 KiB is admitted to parsing; 16 KiB plus one byte closes
    1009 before presence effect.
24. **Presence backpressure:** a peer above 64 KiB receives no presence state.
25. **Durable priority:** that peer still receives a scene frame until the 1 MiB
    durable threshold; above it, close/replay replaces silent durable loss.
26. **Fence:** actor/device fence broadcasts `fenced`, closes the socket, and
    prevents later publication.
27. **Reset:** epoch reset removes prior presence with `reset` and old authority
    cannot re-enter.
28. **Self-filter:** origin may receive its trusted state from the server but is
    absent from the host roster after transport filtering.
29. **Snapshot replacement:** client snapshot replaces the prior remote roster;
    leave removes only its named session.
30. **Socket loss:** unbinding clears all rendered remote states immediately.
31. **Host capture:** original per-view pointer handler runs first; pointer and
    selected AppState capture produce the bounded host state.
32. **Host render:** trusted native collaborator has name, colors, pointer, and
    selected IDs keyed by session.
33. **No viewport apply:** receiving viewport/follow does not call an AppState
    viewport update in Obsidian.
34. **Exact detach:** release restores only the installed view wrapper and
    removes only the YAOS hook subscriber.
35. **No scene echo:** collaborator rendering produces no durable RFC-13
    element batch.

## 25. Validation and release gates

### 25.1 Automated layers

The codebase MUST retain:

- shared protocol parser tests for trusted reconstruction, bounds, duplicate
  sessions, relative expiry, color syntax, and unsupported surfaces;
- fake-clock generic-client tests for full-state coalescing, refresh,
  withdrawal, local expiry, snapshot replacement, leave, and socket loss;
- real SQLite Drawing-runtime tests for identity, 50 ms coalescing,
  hibernation reconstruction, expiry, absence from SQL, backpressure, durable
  priority, fences, rate closure, duplicates, oversize input, and capacity;
- transport tests for publication, presence parsing, and local-session
  filtering;
- Obsidian adapter tests for pointer/AppState capture, native collaborator
  rendering, and exact wrapper restoration;
- release-contract tests pinning global protocol 7;
- all RFC-13 scene regressions.

### 25.2 Real host gates

Before presence is advertised as production-supported on a host, two real
Obsidian profiles MUST validate roster, pointer, laser, selection, idle,
disconnect, reconnect, plugin reload, and no scene echo. Desktop/mobile support
requires a separate background/suspension trial because touch frequency and
timer suspension differ from desktop.

Remote viewport and follow are expressly excluded from this release gate. The
fields may be observed on the wire, but no product claim may say that Obsidian
follows a collaborator.

### 25.3 Deployed runtime gates

The production Worker gate must confirm hibernatable attachment continuity,
close delivery, 15-second expiry, authority fences, 60/s abuse closure, 256
socket admission, and scene delivery under the 64 KiB presence-drop band. A
local workerd/SQLite pass remains useful but does not prove actual platform
hibernation or deployed socket buffering.

## 26. Rollout and degradation

Protocol 7 is an exact deployment cutover. Server, clients, tickets, CLI,
release metadata, and compatibility guards ship together. No protocol-6 socket
remains admitted after cutover.

Presence may be disabled for a view when required host seams are unavailable.
That degradation does not demote a promoted drawing and does not switch it back
to opaque attachment sync. Useful machine-readable reasons include host pointer
unavailable, collaborator apply unavailable, invalid trusted frame, room
capacity, socket backpressure, and authority superseded.

V1 has no separate presence preference or public access rollout. Those require
their own product and privacy contract rather than silent expansion of this
RFC.

## 27. Canvas reuse boundary

The reusable work is the generic server kernel and generic client lifecycle:

- authoritative socket enumeration;
- trusted identity construction;
- session-scoped full replacement;
- rate, coalescing, snapshot, expiry, and leave;
- attachment continuity across hibernation;
- relative client deadlines;
- best-effort delivery below durable priority.

The current compiled surface remains Excalidraw-only. Canvas would need a new
surface type, coordinate and selection validator, Canvas socket integration,
host capture/render probes, and a decision about coexistence with current Yjs
awareness. RFC 14 does not implement or automatically enable any of that.

## 28. Implemented build order

1. Bump and guard global protocol 7.
2. Add the shared bounded presence and Excalidraw-surface protocol.
3. Add the generic server `PresenceKernel` over hibernatable socket
   attachments.
4. Integrate Drawing connect, hello/snapshot, update dispatch, fences, reset,
   close/error, and tiered backpressure.
5. Add the generic client with coalescing, 5-second refresh, relative expiry,
   snapshot replacement, withdrawal, and socket-loss cleanup.
6. Extend the RFC-13 transport with publication, strict server-frame parsing,
   and local-session filtering.
7. Add the Excalidraw controller and Obsidian capture/render adapter without
   applying remote viewport AppState.
8. Add protocol, runtime, client, transport, host, and release-contract tests.
9. Preserve the real-host and deployed-runtime evidence gates in section 25
   before broad product claims.
