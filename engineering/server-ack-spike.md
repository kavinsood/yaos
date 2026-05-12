# Server ack protocol spike findings

> Answers the six open technical tasks from `server-ack-design.md`.
> Spike date: 2026-05-10. Library versions: y-partyserver@2.1.2, y-protocols@2.x.
> Implementation status: baseline echo and post-apply echo are now wired through
> `server/src/server.ts`; the live Worker smoke verifies `__YPS:` delivery and a
> post-apply echo whose SV dominates the just-written client candidate.

---

## Q1: y-partyserver hook point

**Answer: override `handleMessage()` in VaultSyncServer.**

`Y.applyUpdate()` is called inside `handleSyncMessage()` in y-partyserver's server
code, which is invoked from `handleMessage()`. `handleMessage` is a public method
on `YServer` with a TypeScript declaration:

```ts
// server/node_modules/y-partyserver/dist/server/index.d.ts:35
handleMessage(connection: Connection, message: WSMessage): void;
```

`VaultSyncServer` does not currently override it. Overriding it is clean:

```ts
override handleMessage(connection: Connection, message: WSMessage): void {
    // peek at inner type before parent processes (see Q2 below)
    super.handleMessage(connection, message);
    // send echo after update applied (see Q2)
}
```

**Source**: `server/node_modules/y-partyserver/dist/server/index.cjs:269–326`

**Implemented**: `VaultSyncServer.handleMessage()` computes
`isUpdateBearingSyncMessage(message)` before calling `super.handleMessage()`, then
sends a sender-only `"postApply"` SV echo only after parent handling returns.
There is no `finally` path that emits an echo after a failed parent handler.

---

## Q2: Sender identity

**Answer: confirmed. `connection` is the first argument to `handleMessage`.**

```ts
// y-partyserver server/index.cjs:269
handleMessage(connection, message) { ... }
```

The connection object is passed as `transactionOrigin` all the way down to
`Y.applyUpdate(doc, update, connection)`. So checking `origin === connection` in a
`doc.on('update', ...)` handler correctly identifies which client sent an update.

**Detecting client updates — Phase A approach: inner-type peek in `handleMessage`.**

The outer message type is 0 (`messageSync`). Within a sync message, the inner type
determines what happens:

| Inner type | y-protocols constant | Effect |
|-----------|---------------------|--------|
| 0 | `messageYjsSyncStep1` | Client sends state vector. Server responds. **No update applied.** |
| 1 | `messageYjsSyncStep2` | Client sends its missing ops. Server applies them. **Update applied.** |
| 2 | `messageYjsUpdate` | Client sends a live update. Server applies it. **Update applied.** |

Send the SV echo when inner type is 1 or 2 (explicit check, not `!== 0` — guards
against hypothetical future inner types that do not apply updates):

```ts
shouldEcho = innerType === 1 || innerType === 2;
```

`decoding` is `lib0/decoding` — already a transitive dependency.

**`doc.on("update")` observer — NOT recommended for Phase A.** A `doc.on("update")`
handler with `origin === connection` identity check can identify the connection that
sent an update. However, it has a significant caveat for this use case: y-partyserver
may not fire the `doc.on("update")` handler for **duplicate or no-op updates** (updates
where the operations are already present in the doc). A no-op apply still means the
server's Y.Doc already has that state, which is a valid Level 3 confirmation. The
inner-type peek fires on the message regardless of whether the update was a no-op,
ensuring the echo is never suppressed for already-confirmed state.

Additionally, `Connection` from `partyserver` is a type/interface, likely not a runtime
class — `origin instanceof Connection` would not compile. Using identity `origin === connection`
requires a per-message local variable or a persistent connection-to-set tracking structure.

Use the inner-type peek for Phase A. The `doc.on("update")` approach may be revisited
if y-protocols versioning or inner-type semantics change in a future upgrade.

**Source**: `server/node_modules/y-partyserver/dist/server/index.cjs:269–326`,
`node_modules/y-protocols/dist/sync.cjs:62–64`

---

## Q3: Protocol layer and message type — SUPERSEDED

**Finding: a new binary message type is not needed and should not be added.**

The outer message type numbers currently in use:

| Type | Name | Direction | Handled by |
|------|------|-----------|------------|
| 0 | messageSync | both | server + client provider |
| 1 | messageAwareness | both | server + client provider |
| 2 | messageAuth | client→server | client provider only |
| 3 | messageQueryAwareness | client→server | client provider only |

Type 4 is numerically free. But it is irrelevant — **the client provider silently
drops unknown binary message types** (see Q4). Do not add a binary message type.

Use the `__YPS:` string custom-message channel instead (see Q4).

**Source**: `server/node_modules/y-partyserver/dist/server/index.cjs:20–21`,
`server/node_modules/y-partyserver/dist/provider/index.cjs:29–32`

---

## Q4: Custom message forwarding — CRITICAL FINDING

**Finding: binary unknown types are dropped. Use `__YPS:` string channel.**

In the y-partyserver client provider:

```js
// provider/index.cjs:99–108
function readMessage(provider, buf, emitSynced) {
    const messageType = lib0_decoding.readVarUint(decoder);
    const messageHandler = provider.messageHandlers[messageType];
    if (messageHandler)
        messageHandler(encoder, decoder, provider, emitSynced, messageType);
    else console.error("Unable to compute message");  // ← dropped, no event emitted
    return encoder;
}
```

**String messages with `__YPS:` prefix are forwarded to the app:**

```js
// provider/index.cjs:121–127
if (typeof event.data === "string") {
    if (event.data.startsWith("__YPS:")) {
        const customMessage = event.data.slice(6);
        provider.emit("custom-message", [customMessage]);  // ← app receives this
    }
    return;
}
```

**Server API** (already on `YServer`, no subclassing needed):

```ts
// server/index.d.ts:33
sendCustomMessage(connection: Connection, message: string): void;
broadcastCustomMessage(message: string, excludeConnection?: Connection): void;
```

`sendCustomMessage()` sends `__YPS:${message}` to one connection. The client provider
fires `provider.emit("custom-message", [message])`.

**Conclusion**: The wire protocol is `__YPS:` JSON. No new binary message type.
The `messageSvEcho = 4` entry from earlier drafts of the design is retired.

**Source**: `server/node_modules/y-partyserver/dist/provider/index.cjs:99–133`,
`server/node_modules/y-partyserver/dist/server/index.cjs:234–246` and `.d.ts:33`

---

## Q5: Baseline echo timing

**Answer: override `onConnect()`, send after `super.onConnect()`.**

y-partyserver's `onConnect()` (`server/index.cjs:339–357`) sends SyncStep1 (server
state vector) and awareness states synchronously, then returns. At that point the
document is fully loaded (guaranteed by `ensureDocumentLoaded()` which runs before
any connection reaches the DO) and the room state is consistent.

```ts
override onConnect(conn: Connection, ctx: ConnectionContext): void {
    super.onConnect(conn, ctx);  // sends SyncStep1 + awareness
    this.sendSvEcho(conn);       // baseline echo: server's current SV
}
```

The baseline echo arrives at the client before the client's SyncStep1 response comes
back. The client sees the server's current state vector and can immediately evaluate
its candidate. When the client then sends its missing ops (SyncStep2), those are
applied and the post-apply echo confirms them.

**Source**: `server/node_modules/y-partyserver/dist/server/index.cjs:339–357`

**Implemented**: `VaultSyncServer.onConnect()` sends a sender-only `"baseline"`
SV echo after `super.onConnect()`. `tests/provider-manual-connect.mjs` verifies
that a real provider receives the custom message over `__YPS:`.

---

## Q6: State vector cost

**Finding: no library-level bound found. Measurement required before assuming
immediate-echo is acceptable.**

y-partyserver has no built-in throttling or batching for echoes. Encoding the state
vector with `Y.encodeStateVector(doc)` is synchronous and O(n) in distinct client
IDs. Under active typing, one echo per keystroke is plausible.

State vector byte size is variable: each client ID (8 bytes) + clock varint +
overhead. In a long-lived vault with many historical client IDs, the SV could be
hundreds of bytes. This is still small in absolute terms, but multiplied by echo
frequency the DO egress and CPU cost deserves measurement.

**Decision for Phase A**: start with immediate echo. Instrument with cheap in-memory
counters and max byte tracking. Add batching if measurements show overhead.

**Implemented counters**:

```text
baselineSent
postApplySent
failed
bytesTotal
bytesMax
failureNotOpen
failureOversize
failureSendFailed
```

These are exposed via the server debug payload. Do not write a trace entry for
every echo; this path can be hot under active typing.
They are in-memory Durable Object debug counters and may reset on DO restart,
hibernation, or cold start.

---

## Implementation sketch

> **This is a sketch, not working code.** Known caveats are annotated inline.

```ts
// server/src/server.ts — additions to VaultSyncServer

import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";

// Inner y-protocols sync message types (y-protocols/dist/sync.cjs:62-64)
const MESSAGE_YJS_SYNC_STEP2 = 1;
const MESSAGE_YJS_UPDATE = 2;

override onConnect(conn: Connection, ctx: ConnectionContext): void {
    super.onConnect(conn, ctx);
    this.trySendSvEcho(conn);  // baseline echo
}

// Option A: inner-type peek. Option B (doc.on("update") observer) may be preferable
// — see Q2 above. Pick one approach; do not use both.
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
                // Explicit check: only echo for types that actually apply an update.
                // Do not use !== 0 — guards against hypothetical future inner types.
                shouldEcho = innerType === MESSAGE_YJS_SYNC_STEP2 || innerType === MESSAGE_YJS_UPDATE;
            }
        } catch { /* malformed frame — let parent handle */ }
    }
    super.handleMessage(connection, message);
    if (shouldEcho) this.trySendSvEcho(connection);
}

// trySendSvEcho: never throws. Catches encoding or send failures without noise.
private trySendSvEcho(connection: Connection): void {
    try {
        this.sendSvEcho(connection);
    } catch (err) {
        // Do not console.error freely — this fires on every update under active typing.
        // Increment counter and emit via rate-limited diagnostics trace only.
        this._svEchoFailedCount++;
        // maybeTrace("sv_echo_failed", { count: this._svEchoFailedCount });
    }
}

private sendSvEcho(connection: Connection): void {
    // Level 3 only: after in-memory Y.Doc apply; intentionally before persistence.
    const sv = Y.encodeStateVector(this.document);
    // CAVEAT: btoa(String.fromCharCode(...Array.from(sv))) blows the argument-list
    // limit on large arrays (>~65k entries). Use a chunked helper in production:
    //   function toBase64Chunked(bytes: Uint8Array): string {
    //       let s = "";
    //       for (let i = 0; i < bytes.length; i += 8192)
    //           s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    //       return btoa(s);
    //   }
    const svBase64 = toBase64Chunked(sv);
    // Namespaced, schema-versioned payload. Client must check both fields.
    this.sendCustomMessage(connection, JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: svBase64 }));
    // TODO: increment svEchoSentCount, svEchoBytesTotal, svEchoBytesMax counters (see Instrumentation section).
}
```

```ts
// Client side — parseSvEchoMessage: pure parser, never throws, returns null on any invalid input.
// Register the custom-message handler BEFORE provider can process messages (see Q5 / Listener timing note).

function parseSvEchoMessage(msg: string): Uint8Array | null {
    let parsed: unknown;
    try { parsed = JSON.parse(msg); } catch { return null; }
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    // Check namespaced type and schema version before trusting payload.
    if (p.type !== "yaos/sv-echo" || p.schema !== 1) return null;
    if (typeof p.sv !== "string") return null;
    // Guard against unexpectedly large payloads before decoding.
    if (p.sv.length > 65536) return null;  // ~48 KB of base64 ≈ ~36 KB binary; generous bound
    try {
        const binary = atob(p.sv);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return null;  // increment svEchoDecodeFailureCount
    }
}

// Wire-up in VaultSync:
provider.on("custom-message", (msg: string) => {
    const svBytes = parseSvEchoMessage(msg);
    if (svBytes) this.updateTracker.recordServerSvEcho(svBytes);
});
```

---

## Instrumentation counters

The implementation must expose these counters for post-deploy measurement (see Q6):

```ts
// Server-side (on VaultSyncServer):
svEchoSentCount: number        // total echos sent (baseline + post-apply)
svEchoBaselineCount: number    // echos from onConnect
svEchoPostApplyCount: number   // echos from handleMessage / doc.on("update")
svEchoBytesTotal: number       // cumulative SV bytes sent
svEchoBytesMax: number         // largest SV sent in bytes

// Client-side (on UpdateTracker or diagnostics):
svEchoDecodeFailureCount: number  // parseSvEchoMessage returned null due to decode error
```

Log `svEchoBytesMax` and `svEchoSentCount` periodically (e.g., on every 100th echo).
If `svEchoBytesMax` exceeds 4 KB or `svEchoSentCount / session_duration` exceeds ~5/s
under normal typing, revisit the 100–250 ms batching option.

---

## Implementation notes

### Listener registration timing

Register `provider.on("custom-message", ...)` immediately after the provider is
constructed, before calling any method that allows the provider to begin processing
messages (e.g., before `provider.connect()` or before the first message dispatch).
If the handler is registered late, a baseline echo arriving during the sync exchange
handshake may be lost.

### Duplicate / no-op update behavior

y-partyserver's `Y.applyUpdate()` is called even when the incoming update is a no-op
(e.g., the server already has those operations). The echo is still sent in that case.
This is correct: a no-op means the server's Y.Doc already includes that state, which
is a valid Level 3 confirmation. The echo correctly reflects the current server SV.
Do not suppress echoes for no-op updates.

**Unverified assumption**: it is asserted but not confirmed that `Y.applyUpdate()` fires
for no-op/duplicate updates inside y-partyserver. If the `doc.on("update")` approach is
revisited in a future spike, this must be verified explicitly:

```text
Spike question: Does y-partyserver emit doc.on("update") for duplicate/no-op updates?
Test: send the same SyncStep2 twice. Does the second trigger the update event?
If no: inner-type peek remains the correct Phase A approach.
If yes: doc.on("update") with origin identity check is viable as an alternative.
```

### Package version guard

This spike is verified against **y-partyserver@2.1.2** and **y-protocols@2.x**.
If either package is upgraded, re-run the spike: re-check `handleMessage`, `onConnect`,
`sendCustomMessage`, and the `__YPS:` forwarding behavior in the provider. The inner
type constants (0/1/2) are stable y-protocols values but verify if y-protocols major
version changes.

---

## Summary table

| Task | Status | Finding |
|------|--------|---------|
| Q1: hook point | ✅ resolved | Override `handleMessage()` in VaultSyncServer |
| Q2: sender identity | ✅ resolved | `connection` is first arg; Phase A uses inner-type peek (`=== 1 \|\| === 2`); `doc.on("update")` deferred — has no-op suppression risk and `instanceof Connection` is not valid at runtime |
| Q3: message type | ✅ resolved (moot) | No binary type needed; use `__YPS:` channel |
| Q4: custom message forwarding | ✅ resolved | `__YPS:` string → `provider.emit("custom-message")` |
| Q5: baseline echo timing | ✅ resolved | Override `onConnect()`, after `super.onConnect()` |
| Q6: SV cost | ⚠️ deferred | Immediate echo for Phase A; measure post-deploy via instrumentation counters |
