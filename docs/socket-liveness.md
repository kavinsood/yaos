# Application-level socket liveness

Socket protocol 2 makes application liveness part of the root/body transport
contract. Browser `WebSocket.readyState` is only a local transport observation:
an `OPEN` socket can remain open while a suspended network path silently drops
all traffic.

Every accepted socket receives `VAULT_READY` with the exact document identity,
vault generation, runtime epoch, durable generation, and this mandatory
descriptor:

```json
{"liveness":{"version":1,"idleMs":60000,"timeoutMs":15000}}
```

An open foreground socket must receive that `VAULT_READY` frame within fifteen
seconds. Until then the connection is reported as connecting, not online; a
missing READY frame fences the transport through the same recovery path as a
missing pong.

After sixty quiet seconds the client sends one custom `VAULT_PING` carrying a
fresh opaque probe ID. The server validates the hibernated socket attachment,
current vault generation, runtime epoch, and device revocation fence before it
returns `VAULT_PONG` on that same socket. Only a pong with the exact outstanding
probe ID, document ID, vault generation, and runtime epoch is an
acknowledgement. Yjs silence, websocket `OPEN`, unrelated server traffic, and an
old pong are not substitutes.

One probe may be outstanding per socket. Failure to send or acknowledge it in
fifteen seconds is a retryable network failure. A root failure abandons root and
body transports before entering refresh-first reconnect. A body failure
abandons and re-admits only that active body first, escalating to the
coordinator-owned global recovery path only if isolated admission fails.
Pending candidates, attachment intents, body documents, leases, and durable
work remain owned by their existing lifecycles.

Obsidian backgrounding clears probe deadlines and marks live transports
suspended. A frozen JavaScript event loop therefore cannot manufacture a dead
socket. Foregrounding sends fresh probes to the root and active bodies; current
application responsiveness becomes known again only from current evidence. The
headless client remains foreground and continues the normal idle cadence.

The production provider uses a fenced websocket adapter. Force-abandonment
synchronously completes the old provider's close transition, suppresses every
later event from that native socket, and permits immediate construction of a
new transport. This is required because browser `close()` alone may wait on the
same black-holed path while the provider continues retaining its old socket.

Diagnostics expose root phase, phase counts, last acknowledgement time, and
aggregate timeout count. Probe IDs and socket IDs never enter diagnostics.
