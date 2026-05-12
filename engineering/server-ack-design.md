# Server acknowledgement design (FU-8)

> **Status: LEVEL 3 MVP IMPLEMENTED — baseline + post-apply server SV echoes are wired.**
> Protocol spike findings: `engineering/server-ack-spike.md`.
> Wire protocol uses `__YPS:` JSON channel (not a new binary message type).
> Implemented scope remains Level 3 only: server Y.Doc in-memory receipt.
> It is not durable persistence and does not prove another device applied the state.

## The problem

Historically, `UpdateTracker` recorded `lastLocalUpdateWhileConnectedAt` — the last time a local
Y.Doc update occurred while the WebSocket was open. This is the strongest claim the
client could make without a server-side signal. FU-8 adds a stronger Level 3
server-receipt signal, but the older timestamp still does NOT mean:

- the update was put on the wire
- the server received the update
- the server applied the update to the room Y.Doc
- the update was written to the journal or checkpoint

The UI must continue to label this as "last local update while connected"; do not
retrofit it into a delivery claim. FU-8 diagnostics now expose server receipt state
separately. Pending local update **count** remains unknown because the tracker uses
latest-state semantics, not a queue.
The gap: a user with poor connectivity can sit with stale data and no indication
that their writes haven't landed.

---

## What "acked" means — the options

There are five distinct levels. Each is cheaper and weaker than the next:

| Level | Meaning | Evidence |
|-------|---------|----------|
| 0 | Transport open at write time | Current — `lastLocalUpdateWhileConnectedAt` |
| 1 | Frame sent | WebSocket `send()` returned without error |
| 2 | Server received frame | Server echoes a receipt to the sending client |
| 3 | Server applied | Server applied the update to the room Y.Doc in memory |
| 4 | Server persisted | Update is in the journal (survives server restart) |

Level 0 and Level 3 are implemented. Levels 1, 2, and 4 are not exposed as separate
product claims.

**Recommendation: target Level 3 (server applied).**

Level 1 (frame sent) is trivially achievable client-side but gives false confidence
under a broken server. Level 2 (server received frame) is slightly stronger but still
doesn't prove the update merged cleanly. Level 3 (server applied) is the first
level where a client can reasonably say "the server's Y.Doc has my update." Level 4
(persisted) is stronger but requires the server to flush before echoing, which adds
latency and complexity (the server already journals asynchronously).

Level 3 is also what y-partyserver's awareness mechanism is close to — a state
vector echo would prove the server's Y.Doc includes the client's ops.

---

## Design options for Level 3

### Option A: state vector echo

The server, after applying a client's Y.js update, encodes its current state vector
and sends it back over the WebSocket as a control message:

```
server → client: { type: "yaos/sv-echo", schema: 1, sv: <base64 Uint8Array> }
```

The client decodes the echo and checks whether its **last unconfirmed local candidate
state vector** is `<=` the echoed vector. If yes, the client's local state is
included in the server's Y.Doc.

**Pros:** Piggybacks on existing Y.js semantics. State vector comparison is cheap.
Echoes are compressible: a single echo can confirm all pending candidate state for
the **receiving client**, regardless of how many local updates contributed to it.
Ack knowledge is recoverable after reconnect — the server emits a fresh echo from
the current room doc, and the client compares it against its persisted unconfirmed
candidate.

**Cons:** Requires a server-side custom-message echo path. The server must encode
the state vector on each baseline and update-bearing sync frame. State vector byte
size grows with the number of distinct Yjs client IDs in the document — this must
be measured before assuming it is cheap at scale.

### Option B: monotonic per-room update counter

The server increments a room-level integer counter every time it applies an update.
It echoes the counter to all connected clients:

```
server → client: { type: "ack", seq: 42 }
```

The client tracks which `seq` it last received and which `seq` was current when each
local update was sent.

**Pros:** Simple integer comparison. Easy to surface in the UI ("update #42 acked").
Easy to persist (one integer in room metadata).

**Cons:** Doesn't directly prove which Y.js operations are included — a client that
reconnects after a gap needs to re-derive "is my state included in seq N?" by
comparing state vectors anyway. The counter is more of a heartbeat signal than a
precise ack.

### Option C: per-client update receipt

After the server applies a Y.js update from client X, it sends a receipt message
back to client X (and only X):

```
server → sender: { type: "applied", clientId: "...", clock: N }
```

where `clock` is the sender's Y.js client ID clock at the time of the update.

**Pros:** Most precise — directly maps to the Y.js update that was applied.
**Cons:** Requires tracking which WebSocket connection sent which Y.js update.
y-partyserver's current message handling doesn't expose per-sender metadata easily.

---

## Recommended approach: Option A (state vector echo)

State vector echo is the most natural fit for Y.js semantics:

1. The server already has the room Y.Doc.
2. After applying any update, `Y.encodeStateVector(doc)` gives the current server
   clock.
3. The client already knows how to decode and compare state vectors (it does this
   for sync protocol step 1).
4. Comparing the echoed SV against the client's local candidate SV is O(n) where
   n is the number of distinct Y.js client IDs — typically small, but must be
   measured in real vaults (see spike tasks).
5. A single echo can confirm all pending candidate state for the **receiving client**,
   regardless of how many local updates contributed to the candidate.

---

## Wire protocol (implementation sketch)

**Spike finding**: binary unknown message types are silently dropped by the
y-partyserver client provider (`console.error("Unable to compute message")`; no
event emitted). A new binary message type is therefore not viable without patching
or wrapping the provider.

**Decision**: use y-partyserver's existing `__YPS:` string custom-message channel.

This section records the intended implementation shape. The working code is now in:

- `server/src/syncMessageClassifier.ts` — update-bearing Yjs sync frame classifier
- `server/src/svEcho.ts` — `__YPS:` SV echo payload and send helper
- `server/src/server.ts` — baseline echo in `onConnect()`, post-apply echo in `handleMessage()`
- `src/sync/svEchoMessage.ts` — client parser, detailed failure reasons, counters
- `src/sync/serverAckTracker.ts` — state-vector dominance truth gate
- `src/sync/vaultSync.ts` — client custom-message handler and receipt diagnostics

See `engineering/server-ack-spike.md` for the protocol findings and caveats
(base64 chunking, namespaced type field, `trySendSvEcho` wrapper,
`parseSvEchoMessage` parser).

### Server → client

```ts
// In VaultSyncServer — sendSvEcho helper (sketch — see spike doc for caveats):
private sendSvEcho(connection: Connection): void {
    // Level 3 only: after in-memory Y.Doc apply; intentionally before persistence.
    const sv = Y.encodeStateVector(this.document);
    // Use namespaced, schema-versioned payload. Use chunked base64 for large SVs.
    this.sendCustomMessage(connection, JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: toBase64(sv) }));
}

// On baseline connect (override onConnect):
override onConnect(conn: Connection, ctx: ConnectionContext): void {
    super.onConnect(conn, ctx);   // sends SyncStep1 + awareness
    this.sendSvEcho(conn);        // baseline echo: current server SV
}

// On client update applied (override handleMessage):
override handleMessage(connection: Connection, message: WSMessage): void {
    let shouldEcho = false;
    if (!(typeof message === "string")) {
        try {
            const array = message instanceof Uint8Array
                ? message : new Uint8Array(message as ArrayBuffer);
            const d = decoding.createDecoder(array);
            const outerType = decoding.readVarUint(d);
            if (outerType === 0 /* messageSync */) {
                const innerType = decoding.readVarUint(d);
                // inner type 0 = SyncStep1 (client sends state vector, no update applied)
                // inner type 1 = SyncStep2 (client's missing ops, update applied)
                // inner type 2 = Update (live update, applied)
                shouldEcho = innerType === 1 || innerType === 2;
            }
        } catch { /* malformed frame */ }
    }
    super.handleMessage(connection, message);
    if (shouldEcho) this.sendSvEcho(connection);
}
```

`sendCustomMessage()` is already on `YServer` (typed in `.d.ts:33`). No new imports
needed beyond `lib0/decoding` for the inner-type peek.

### Client → UpdateTracker

```ts
// In VaultSync — wire up after provider is created (sketch — see spike doc for caveats):
// Register this handler BEFORE any provider message processing can fire.
provider.on("custom-message", (msg: string) => {
    const svBytes = parseSvEchoMessage(msg); // pure parser — validates type, schema, size
    if (svBytes) this.updateTracker.recordServerSvEcho(svBytes);
});
```

`provider.on("custom-message", handler)` is a documented event on the y-partyserver
provider (fires when server sends `__YPS:` prefixed string). No provider patching.

---

## Candidate SV lifecycle

This section is the core of the design. Get it wrong and the ack is a lie.

### What a "local candidate" is

A local candidate SV represents unconfirmed local CRDT state produced by this client
— any non-provider, non-IDB-persistence update. This includes editor edits, disk
imports, snapshot restores, repair writes, and maintenance updates. It is **not**
necessarily a user edit (see FU-12 for that distinction). Use "Pending local state"
in UI copy, not "Pending local edits."

**Origin predicate**: Do not silently reuse the disk-mirror `isLocalOrigin()`
predicate for candidate tracking. The disk-mirror predicate gates writeback
suppression; the ack predicate gates candidate capture. They classify the same
origins today, but define a separate `isAckTrackedLocalOrigin(origin, provider,
persistence)` so that future changes to either predicate cannot silently break the
other.

**Latest-state semantics**: The tracker maintains one candidate SV, not a queue.
When multiple local updates occur before any echo, the candidate is always the SV
snapshot after the most recent local update. A dominating echo confirms the
candidate, which implicitly confirms all prior local updates the candidate subsumes.
If an echo dominates an older SV but not the current candidate, status remains
unconfirmed. Do not introduce a pending count — this is latest-local-state
confirmation, not per-update delivery tracking.

### Lifecycle rules

```ts
// On any isAckTrackedLocalOrigin Y.Doc update, connected or offline:
onLocalUpdate(): void {
    this._lastUnconfirmedCandidateSv = Y.encodeStateVector(this.doc); // captured after transaction
    this._serverAppliedLocalState = false;
    this._lastLocalUpdateAt = Date.now();
    if (this._connected) {
        this._lastLocalUpdateWhileConnectedAt = Date.now();
    }
    this._persistCandidateState(); // persist immediately after capture
}

// On disconnect:
onDisconnect(): void {
    this._connectionGeneration++;
    this._connected = false;
    // Do NOT clear _lastUnconfirmedCandidateSv.
    // Do NOT reset _serverAppliedLocalState if already true.
    // Persisted state survives reconnect and plugin restart.
}

// On reconnect (provider reconnected):
onReconnect(): void {
    this._connected = true;
    // Candidate is retained from memory (or was restored from persistence on startup).
    // Ack state updates when the server echo arrives after sync exchange.
}

// On server SV echo:
recordServerSvEcho(serverSv: Uint8Array): void {
    this._lastServerReceiptEchoAt = Date.now();
    if (this._lastUnconfirmedCandidateSv !== null) {
        this._serverAppliedLocalState = isStateVectorGe(serverSv, this._lastUnconfirmedCandidateSv);
    }
    // If no candidate: update lastServerReceiptEchoAt but leave serverAppliedLocalState null.
    this._persistCandidateState();
}

// On startup, after IDB has loaded CRDT state:
onStartup(): void {
    const stored = this._loadPersistedCandidateState();
    if (!stored || !stored.candidateSv) return;

    this._lastUnconfirmedCandidateSv = stored.candidateSv;

    // Do NOT restore serverAppliedLocalState = true as active truth.
    // Level 3 is not durable: the DO may have crashed before enqueueSave().
    // A persisted `true` means "server had it at that moment" — not "server still has it."
    // Wait for a fresh echo to revalidate.
    this._serverAppliedLocalState = null;
    this._lastKnownServerReceiptEchoAt = stored.lastKnownServerReceiptEchoAt ?? null;

    // Validate candidate against the current local doc state (see below).
    this._validateCandidateAgainstDoc();
}

// Validates persisted candidate against current local doc state after IDB loads.
// Prevents stale candidate persistence from producing false status.
//
// State-vector dominance rules (four exclusive cases):
//   "candidate ahead of doc":  candidate has clocks local doc doesn't. Stale/corrupt → discard.
//   "doc ahead of candidate":  local doc has advanced past candidate → replace candidate.
//   "equal":                   identical SVs → candidate is valid, wait for fresh echo.
//   "incomparable":            each has clocks the other lacks (e.g. device used as both
//                              sender and receiver of a merge) → conservative discard.
//
// Rule: never emerge from this function with serverAppliedLocalState = true.
private _validateCandidateAgainstDoc(): void {
    if (!this._lastUnconfirmedCandidateSv) return;
    const currentSv = Y.encodeStateVector(this.doc);
    const docDominatesCandidate = isStateVectorGe(currentSv, this._lastUnconfirmedCandidateSv);
    const candidateDominatesDoc = isStateVectorGe(this._lastUnconfirmedCandidateSv, currentSv);

    if (docDominatesCandidate && candidateDominatesDoc) {
        // Equal — candidate is valid. serverAppliedLocalState stays null until fresh echo.
        return;
    }

    if (docDominatesCandidate && !candidateDominatesDoc) {
        // Local doc has advanced past the candidate (e.g. IDB crash gap, merge).
        // Replace candidate with the current local doc SV and mark unconfirmed.
        // This is conservative: the replacement SV may include remote state that
        // arrived while offline or was already confirmed. That is acceptable because
        // the server dominance check (`isStateVectorGe(serverSv, candidateSv)`) is
        // the truth gate — a candidate that includes remote state will still be
        // confirmed by the server's next echo. It will not produce false `true`.
        this._lastUnconfirmedCandidateSv = currentSv;
        this._serverAppliedLocalState = false;
        this._persistCandidateState();
        return;
    }

    // candidateAheadOfDoc (doc doesn't dominate) OR incomparable (neither dominates):
    // Candidate claims clocks the local doc doesn't have, or SVs diverge.
    // Both cases: discard candidate, fail closed.
    this._lastUnconfirmedCandidateSv = null;
    this._serverAppliedLocalState = null;
    this._persistCandidateState();
}
```

```ts
function isStateVectorGe(a: Uint8Array, b: Uint8Array): boolean {
    const svA = Y.decodeStateVector(a);
    const svB = Y.decodeStateVector(b);
    for (const [clientId, clock] of svB) {
        if ((svA.get(clientId) ?? 0) < clock) return false;
    }
    return true;
}
```

### Why "do not clear candidate on disconnect"

The critical user workflow:

```
Device A edits note while offline.
onLocalUpdate() captures candidate SV. serverAppliedLocalState = false. Candidate persisted.
Socket is closed (or was never open). Candidate is retained in memory and persistence.
Device A reconnects.
Yjs sync sends the offline edit to the server.
Server applies the edit and emits a post-apply SV echo.
recordServerSvEcho() compares echo against retained candidate.
serverAppliedLocalState = true. Persisted.
```

If the candidate were cleared on disconnect, step 7 would find no candidate, the
echo would be ignored, and the user's offline edit would never be confirmed. That is
the exact case this system exists to solve.

### Persisted candidate state

The tracker must persist enough state to survive plugin restart. The persisted
format:

```ts
type PersistedCandidateState = {
    schema: 1;
    // Scope fields — every field must match current context on load.
    // Any mismatch → discard entirely, fail closed to null.
    vaultIdHash: string;       // SHA-256 of vaultId, hex-encoded (not raw — avoid leaking IDs in storage)
    serverHostHash: string;    // SHA-256 of the server host URL, hex-encoded
    localDeviceId: string;     // stable per-install UUID (see below — NOT deviceName)
    roomName: string;          // DO room name for this vault; changes on server reset/reclaim
    docSchemaVersion: number;  // CRDT doc schema version at time of capture
    // Metadata (not used for scope invalidation — for diagnostics and migration only)
    pluginVersion: string;     // semver at time of capture; recorded, not used for invalidation
    ackStoreVersion: number;   // increment when persisted format changes to allow future migration
    // Candidate fields
    candidateSvBase64: string | null;    // base64-encoded Uint8Array
    candidateCapturedAt: number | null;  // ms timestamp
    // Historical-only: persisted `serverAppliedLocalState=true` is NOT restored as
    // active truth after restart. Level 3 is not durable — the DO may have crashed
    // before enqueueSave(). Use `lastKnownServerReceiptEchoAt` only for "last known" UI.
    lastKnownServerReceiptEchoAt: number | null;
};
```

**`localDeviceId`**: A stable UUID generated once per local plugin install and stored
in local-only storage (never synced). This is NOT `settings.deviceName` — device name
is user-facing, mutable, and non-unique. Multiple devices can share a name; one device
can rename. Use `crypto.randomUUID()` on first run and persist it to local-only
IndexedDB or `localStorage`. `deviceName` is for display only.

**`roomName` and server reset**: `roomName` is the Durable Object room/stub name that
scopes this vault's CRDT state. If the server is reset or the vault is reclaimed, the
room name or room identity changes, making the old candidate state meaningless. If no
server generation/version field is exposed by the server in Phase A, the design must
explicitly state:

```text
Server reset and vault reclaim cannot be detected from client-side state alone in Phase A.
If a user reports stale ack status after a server migration or reset, the fix is to clear
local candidate state (either automatically on scope mismatch, or via a diagnostics action).
```

Do not claim "covers server reset" unless `roomName` or `serverGeneration` actually
changes on reset and the stored value is compared on load.

**Storage location**: a dedicated local-only IndexedDB store. Do NOT use Obsidian's
`plugin.saveData()` / `data.json` — that file is inside `.obsidian/plugins/yaos/` and
may be synced by users who sync their `.obsidian` config. Candidate state is per-device
runtime state that must not cross-contaminate across devices via `.obsidian` sync.

Store key pattern:

```text
yaos-ack-v1:${serverHostHash}:${vaultIdHash}:${localDeviceId}
```

Use hashed identifiers in the key (not raw URLs or vault IDs) to avoid storing
sensitive values in key names. The record payload already carries the raw values for
scope comparison.

**On startup after IDB ready**: Load persisted state. Compare all scope fields against
current values. If any field mismatches (different vault, server, room name, device, or
doc schema version), discard the stored state entirely and fail closed to
`serverAppliedLocalState = null`. If scope matches, load `candidateSvBase64` and
`lastKnownServerReceiptEchoAt`. Do NOT restore `serverAppliedLocalState = true` as active
truth — call `_validateCandidateAgainstDoc()` and wait for a fresh echo to revalidate.

**On persistence failure**: If a write throws, increment `candidatePersistenceFailureCount`,
set `candidatePersistenceHealthy = false`, log via diagnostics trace (not `console.error`),
and continue with in-memory state only. The current session can still track ack status
in memory; restart survival becomes unavailable until the store is healthy again. Do not
surface a user-visible error for transient persistence failures. **On the next successful
candidate-state write, reset `candidatePersistenceHealthy = true` and stop logging failures.**
Expose `candidatePersistenceFailureCount` in diagnostics.

**On server reset / room reclaim (until `serverGeneration` exists)**: Server reset is
undetectable from client state alone if `roomName` does not change. Until Phase A has a
server generation discriminator, the fix for a user with stale receipt status after a
reset is a manual action. Expose a diagnostics command: **"Clear local server-receipt
state"** that discards the persisted candidate and resets `serverAppliedLocalState` to
`null`. Do not silently auto-clear on reset without a detectable signal.

**On local update**: Capture candidate, set `serverAppliedLocalState = false`, persist.

**On server echo confirming candidate**: Set `serverAppliedLocalState = true`, update
`lastKnownServerReceiptEchoAt`, persist.

**On new local update after confirmed state**: Replace candidate, reset to
`serverAppliedLocalState = false`, persist.

---

## Echo timing — when the server must emit

Two distinct echo events are required. One alone is not sufficient.

### Echo 1: Post-apply echo (the primary confirmation signal)

In Phase A, the echo is sent after the server processes a Yjs sync message with inner
type 1 (SyncStep2) or 2 (Update). This is named "post-apply" because the normal case
is that `Y.applyUpdate()` ran and the server's Y.Doc now includes the client's ops.

**Important caveat**: Phase A does not prove a new update was applied. It proves the
server processed a may-contain-update sync frame and is echoing its current state vector.
For duplicate or no-op updates (server already had those ops), the echo still fires — and
the client's `isStateVectorGe(serverSv, candidateSv)` check is the truth gate. If the
server SV dominates the candidate, the update was confirmed (either by this message or
an earlier one). This is intentional: the echo provides a fresh server-state receipt
regardless of whether any new ops were applied.

This is what confirms offline edits after reconnect are received by the server's Y.Doc.
The baseline echo is NOT sufficient for this — it fires before the sync exchange completes.

### Echo 2: Baseline echo on room load / client connect

```ts
// After the room document is loaded and the connection is admitted.
// Exact hook point within the join flow must be confirmed by the spike.
const sv = Y.encodeStateVector(this.document);
const encoder = encoding.createEncoder();
encoding.writeVarUint(encoder, messageSvEcho);
encoding.writeVarUint8Array(encoder, sv);
newClient.send(encoding.toUint8Array(encoder));  // newly connected client only
```

This is a **baseline status signal**, not a confirmation signal. It lets the client
immediately evaluate whether its persisted candidate was already known to the server
— for example, if the exact same Yjs operations already reached the server via
another connection earlier. The baseline echo will legitimately set
`serverAppliedLocalState = false` when the client carries offline edits the server
has not yet received. That is correct and expected.

The baseline echo occurs before the client's missing offline updates are delivered.
That is fine — the post-apply echo from step Echo 1 (after the server applies those
updates) is what provides confirmation.

### Ordering for a reconnecting client with offline edits

```text
Client reconnects with offline edits.
Server emits baseline echo.            ← server does not have offline edits yet
  → client sees serverAppliedLocalState = false (correct — echoed SV < candidate SV)
Client sends missing updates (Yjs sync exchange).
Server applies missing updates.
Server emits post-apply echo.          ← this echo confirms the offline edits
  → client sees serverAppliedLocalState = true (correct)
```

Both states are correct and expected. The transition false → true is the signal.

### Echo failure / connection close

WebSocket delivery is ordered and reliable while the connection is alive. If the
connection closes before the post-apply echo is delivered, the candidate remains
unconfirmed in both memory and persistence. On reconnect, the baseline echo and/or
post-apply echo re-evaluate the retained candidate. No retry protocol is needed.

---

## State-vector echo cost

State vector size grows with the number of distinct Yjs client IDs that have ever
written to the document. In YAOS:

- Each device session may generate a new Yjs client ID (depending on IDB persistence).
- Repair, migration, and snapshot operations add their own client IDs.
- Long-lived vaults may accumulate many historical client IDs.

The design proposes emitting a state vector after every incoming client update.
Under active typing, this may be one echo per small CRDT operation. **Before
finalizing "immediate echo" as the default:**

```text
Measure or bound:
- Typical SV byte size in real YAOS vaults
- Worst observed SV byte size
- Number of distinct Yjs client IDs in real vaults
- Echo frequency under normal typing
- Cloudflare egress and CPU cost per echo
```

If echo volume is high, batch per sender at 100–250 ms. A short delay is invisible
to users and much cheaper under typing bursts. The implementation must expose counters
for echo count and average/max SV size to evaluate this post-deployment.

---

## Naming

Use these names consistently. **Do not use `serverAcked` or `lastServerAckAt`
anywhere in code, comments, or tests.**

```ts
// UpdateTracker fields:
lastUnconfirmedCandidateSv: Uint8Array | null  // SV snapshot at last unconfirmed local write
serverAppliedLocalState: boolean | null         // null = no candidate loaded this session
lastServerReceiptEchoAt: number | null              // timestamp of last SV echo THIS session (resets to null on restart)
lastKnownServerReceiptEchoAt: number | null         // persisted historical timestamp; survives restart; "last known"

// SyncFacts (exposed to UI):
serverAppliedLocalState: boolean | null
lastServerReceiptEchoAt: number | null              // present if a fresh echo arrived this session
lastKnownServerReceiptEchoAt: number | null         // present if historical persisted timestamp exists
```

These two timestamps have different semantics and must not be merged:

- `lastServerReceiptEchoAt`: set when a fresh SV echo arrives from the server this session.
  Resets to `null` on plugin restart. Represents current-session confirmation.
- `lastKnownServerReceiptEchoAt`: loaded from persisted state on startup. Represents the
  historical "last time we knew the server had it." Does NOT imply current server state.

The UI must use `lastServerReceiptEchoAt` when the session is active and a fresh echo
has arrived. It must fall back to `lastKnownServerReceiptEchoAt` only for the "last known"
display after restart — never as a substitute for current-session confirmation.

The internal name `serverAppliedLocalState` is precise: Level 3 means the server
Y.Doc has applied the update (not merely received a frame — that would be Level 2).
Using "received" as an internal name blurs the Level 2 / Level 3 distinction.

The UI label "Server received" is acceptable human copy for Level 3. Any expanded
status or tooltip must clarify:

```
Server received this device's latest local state (applied to server Y.Doc in memory).
This does not guarantee durability — see "Saved to server" for persistence confirmation.
```

### UI combination rule

`serverAppliedLocalState` must always be combined with connection state and timestamp.
A bare boolean is not enough:

```ts
// Do not display serverAppliedLocalState in isolation. Always combine:
{ serverAppliedLocalState, connected, lastServerReceiptEchoAt, lastKnownServerReceiptEchoAt }
```

Example copy:

| `serverAppliedLocalState` | `connected` | `lastServerReceiptEchoAt` | Display |
|--------------------------|-------------|----------------------|---------|
| `null` | any | — | "Server receipt: not tracked yet" |
| `false` | `true` | — | "Local state not yet received by server" |
| `false` | `false` | — | "Offline — local state not yet received by server" |
| `true` | `true` | present | "Server received latest local state" |
| `true` | `false` | present | "Offline — last server receipt at [time]" (use `lastServerReceiptEchoAt`) |
| `null` | any | — (only `lastKnownServerReceiptEchoAt`) | "Last known server receipt: [time]; checking…" |

The `null` row means no candidate has been captured in this session or loaded from
persistence — it does NOT necessarily mean there are pending updates.

**After plugin restart**: `serverAppliedLocalState` is always `null` until a fresh echo
arrives (persisted `true` is never restored as active truth). If `lastKnownServerReceiptEchoAt`
is present from persistence, use the bottom row: "Last known server receipt: [time]; checking…".
Never show "Server received" based on persisted state alone. Once a fresh SV echo arrives and
confirms the current candidate, `serverAppliedLocalState` becomes `true` and `lastServerReceiptEchoAt`
is set — then the normal `true` rows apply.

Do not show a naked "Server received" when the transport is currently offline. A
user seeing "Server received" while offline may assume their notes are safe. The
guarantee is only that the server's in-memory Y.Doc had the update the last time
the echo arrived.

**Do not** use `serverAcked`, `synced`, `saved`, `confirmed`, or `serverReceivedLocalState`.
Do not use "Pending local edits" — maintenance writes also create candidates.

---

## Server-side implementation scope

### Phase A: sender-only echo

**Decision: echo to the sender only after applying their update. No broadcast in Phase A.**

Additionally, the server MUST emit a baseline echo to newly connected clients after
the room document is loaded and the connection is admitted.

Broadcast is deferred to Phase B if a global "all devices caught up" indicator is
ever required.

### Exact hook point

The echo is emitted **after `Y.applyUpdate()` returns successfully**, **before**
`enqueueSave()` runs. This means:

```text
Level 3 guarantee: server Y.Doc in memory has your update.
NOT guaranteed: update is in the journal or checkpoint.
```

This is intentional for Phase A. A future Phase B would emit after persistence.

---

## Hibernation behaviour

Under Cloudflare DO hibernation, the in-memory Y.Doc is rebuilt from
`ChunkedDocStore` on cold start. State vectors are derived from document state — they
survive correctly.

**Required**: on room cold-start, after the document is loaded and the connection is
admitted, the server emits a baseline SV echo to the newly connected client.

The ack knowledge is recoverable after reconnect: the server regenerates the echo
from the current room doc state; the client compares it against its persisted
unconfirmed candidate. The echo message itself does not need to persist.

---

## What this does NOT solve

**"Server applied" ≠ "durable"** — maintain this boundary in docs and UI labels.

Level 3 ack means "server Y.Doc in memory has your update." It does NOT mean:
- the update has been written to the journal
- the update has been checkpointed
- the update survives a Durable Object crash before `enqueueSave()` runs

Two-phase rollout:
- **Phase A** (this design): `serverAppliedLocalState` signal → label **"Server received"**
- **Phase B** (future): `serverPersistedLocalState` signal → label **"Saved to server"**

**Multi-device**: The ack confirms the server has the update. It does not confirm
Device B has received or applied it.

**Offline edits**: The candidate is persisted across disconnect and plugin restart.
After reconnect, the post-apply echo confirms offline edits from any session in which
the local update was captured and persisted.

---

## UI label discipline

Do NOT use these labels for Level 3 (server-applied) ack:
- "Synced" — implies durability and multi-device delivery
- "Saved" — implies persistence
- "Confirmed" — implies end-to-end delivery
- "Acked" — too technical and over-implies safety
- "Pending local edits" — implies user edits only; use "local state"

Use:
- "Server received" — accurate for Level 3

Always combine status with connection state and timestamp. See Naming section.

Reserve "Saved to server" or "Durably saved" for when persistence before echo is
implemented.

---

## Design decisions

These are settled. Do not relitigate them in implementation.

| Decision | Choice |
|----------|--------|
| Ack level | Phase A: server-applied (Level 3). Persisted ack is Phase B. |
| UI label | "Server received" — not "synced", "saved", "confirmed", or "acked" |
| Echo target | Phase A: sender-only plus baseline echo on connect. No broadcast. |
| Pending representation | `boolean \| null` — not a count. Latest-state, not per-update. |
| Candidate SV | `lastUnconfirmedCandidateSv` — captured at write time, not current doc SV. |
| Disconnect behavior | Retain unconfirmed candidate across disconnect. |
| Persistence | Phase A persists candidate SV and state. App restart is covered in Phase A. |
| Scoping / invalidation | `PersistedCandidateState` includes `vaultId`, `serverHostHash`, `localDeviceId` (UUID), `roomName`, `docSchemaVersion`. Scope mismatch → discard, fail closed to null. Server reset coverage requires `roomName` to change on reset; otherwise server reset must be treated as undetectable in Phase A. |
| Internal naming | `serverAppliedLocalState` / `lastServerReceiptEchoAt`. No `serverAcked`. |
| UI combination | Always combine `serverAppliedLocalState` + `connected` + `lastServerReceiptEchoAt`. |
| Echo cost | Immediate echo Phase A; batch at 100–250 ms if measurements show overhead. |

---

## Spike findings summary

Spike complete. Full findings in `engineering/server-ack-spike.md`.

| Task | Status | Finding |
|------|--------|---------|
| Hook point | ✅ | Override `handleMessage()` in `VaultSyncServer`; extract `isUpdateBearingSyncMessage()`; echo after `super.handleMessage()` when inner type === 1 or === 2 |
| Sender identity | ✅ | `connection` is first arg to `handleMessage`; already passed as `transactionOrigin` to `Y.applyUpdate` |
| Message type | ✅ (moot) | No binary type needed; `__YPS:` string channel is the right transport |
| Custom message forwarding | ✅ | Binary unknown types silently dropped; `__YPS:` strings fire `provider.emit("custom-message")` |
| Baseline echo timing | ✅ | Override `onConnect()`; send after `super.onConnect()` (document loaded, SyncStep1 sent) |
| SV cost | ⚠️ deferred | No library bound found; start with immediate echo, instrument, add batching if needed |

---

## Minimum test plan

Do not write protocol code without the pure-client tests passing. Server-side tests
follow after the spike.

### `isStateVectorGe` unit tests

```text
equal vectors => true
server ahead on all shared clients => true
server missing one client from candidate => false
server has extra unrelated client that candidate lacks => true
empty server SV vs non-empty candidate => false
non-empty server SV vs empty candidate => true
multi-client candidate with one missing clock => false
candidate has client A clock 5; server has client A clock 4 => false
malformed input => fail closed (throw or false, not silent true)
candidate contains old local client ID from a prior Y.Doc session; server missing that ID => false
candidate contains old local client ID; server has it at the correct clock => true
```

### `UpdateTracker` candidate lifecycle tests (pure client — implement before spike)

```text
local update while connected: candidate captured, serverAppliedLocalState=false, persisted
local update while disconnected: candidate captured, serverAppliedLocalState=false, persisted
echo dominating candidate: serverAppliedLocalState=true, persisted
echo not dominating candidate: serverAppliedLocalState=false
echo with no candidate: lastServerReceiptEchoAt updated, serverAppliedLocalState stays null
disconnect: unconfirmed candidate retained in memory, serverAppliedLocalState unchanged
reconnect: server echo compared against retained candidate
offline-edit confirmed (current session): candidate survives disconnect, post-apply echo dominates => true [NON-NEGOTIABLE]
offline-edit confirmed (after restart): candidate loaded from persistence, post-apply echo dominates => true [NON-NEGOTIABLE]
confirmed candidate + disconnect + reconnect + baseline echo still dominating => remains true
new local update after confirmed state: serverAppliedLocalState=false, candidate replaced, persisted
new offline local update after confirmed state: same as above while disconnected
remote provider update alone: no candidate created, serverAppliedLocalState unchanged
IDB load alone: no candidate created (IDB replay is not an ack-tracked local update)
corrupt persisted candidate on load: fails closed to serverAppliedLocalState=null, not true
stale persisted candidate from different vaultId: discarded, fails closed to null
stale persisted candidate from different serverHostHash: discarded, fails closed to null
stale persisted candidate from different localDeviceId: discarded, fails closed to null
stale persisted candidate from different roomName: discarded, fails closed to null
stale persisted candidate from older docSchemaVersion: discarded, fails closed to null
persisted serverAppliedLocalState=true not restored after restart: active state is null, lastKnownServerReceiptEchoAt retained
candidate ahead of local doc on startup: discarded, fails closed (candidate has clocks doc doesn't)
doc ahead of candidate on startup: candidate replaced with current SV, marked false
incomparable candidate and doc on startup: discarded, fails closed (neither dominates)
equal candidate and doc on startup: candidate retained, serverAppliedLocalState=null, waits for fresh echo
persistence write failure: in-memory tracking continues; candidatePersistenceHealthy=false; restart survival unavailable
```

### Server-side protocol tests

```text
server emits SV echo to sender after successfully applying client update
server does NOT emit post-apply echo before applyUpdate succeeds
server emits baseline SV echo to newly connected client after room load
server does NOT broadcast post-apply echo to unrelated clients in Phase A
echoed SV actually dominates the just-applied document state
```

Current coverage:

- `tests/server-sync-message-classifier.ts`
- `tests/server-sv-echo.ts`
- `tests/server-post-apply-wiring.ts`
- `tests/provider-manual-connect.mjs` through `npm run test:integration:worker`

### Integration test

```text
offline candidate survives disconnect; reconnect sync delivers missing update;
server post-apply echo marks serverAppliedLocalState=true on the client [NON-NEGOTIABLE]
```

The current live Worker smoke proves the wire-level core of this path:

```text
manual connect receives baseline sv-echo
client writes local Yjs state
server sends postApply sv-echo
postApply echo's state vector dominates the client candidate SV
fresh second provider receives a baseline echo that dominates the prior candidate
server debug counters report baseline and postApply echo sends
```

---

## Implementation order

Implementation status:

1. **Pure client logic** — implemented:
   - `isStateVectorGe()` with full test matrix
   - `ServerAckTracker` candidate lifecycle with lifecycle tests
   - `recordServerSvEcho()`
   - Persisted candidate state store

2. **Server** — implemented:
   - `isUpdateBearingSyncMessage(message: WSMessage): boolean`
   - `trySendSvEcho()` wrapper with size/readyState/failure handling
   - `onConnect()` baseline echo
   - `handleMessage()` post-apply echo after successful parent handling

3. **Client** — implemented:
   - `provider.on("custom-message", ...)` registered before `provider.connect()`
   - detailed `parseSvEchoMessageDetailed()` failure reasons and counters
   - accepted SV echoes feed `ServerAckTracker.recordServerSvEcho()`

4. **`SyncFacts` / diagnostics** — implemented:
   - `serverAppliedLocalState`
   - `lastServerReceiptEchoAt` (diagnostic copy: last server receipt echo observed)
   - `lastKnownServerReceiptEchoAt`
   - persistence health/failure fields
   - client and server SV echo counters

5. **Status label** — still pending:
   - must combine state + connection + timestamp
   - must not say "synced", "saved", "confirmed", or "durable"

6. **Tests** — implemented for pure logic, server helpers, server wire shape, and live Worker smoke.

7. **Instrument** — implemented as cheap counters, not per-echo trace writes.
   Revisit batching if `svEcho.bytesMax` or echo rate becomes noisy under real typing.
   Server-side SV echo counters are in-memory Durable Object debug counters and
   may reset on DO restart, hibernation, or cold start.
