# Runtime lifecycle and socket admission

## Lifetime contract

`RuntimeScope` is the shared boundary for asynchronous runtime work. Work may
capture an `OperationEpoch`, acquire an idempotent `Lease`, and register a
promise by a scalar diagnostic label. The scope deliberately contains no sync,
attachment, recovery, or UI policy.

Stopping a scope is synchronous. It rejects new epochs and leases and makes
every previously captured epoch stale before teardown awaits its first stage.
`drain(timeoutMs)` is bounded and reports unfinished work and active lease
labels without retaining the editor, provider, document, or other resource in
diagnostic output.

The plugin teardown coordinator rotates this scope on a deliberate in-process
restart. Permanent unload cannot reopen it. `VaultSync.destroy()` independently
stops its runtime scope before flushing, destroying providers, or closing the
database, so late credential responses cannot regain publication rights.

Operation completion uses `OperationOutcome`: completed, cancelled,
superseded, durably pending, retryable failure, permanently blocked, or
decision required. Expected cancellation and supersession are therefore not
reported as generic failures.

## Socket admission contract

`SocketAdmissionCoordinator` is the only path which connects production root
and body providers. Its ordering is:

1. capture the current runtime epoch;
2. obtain a current short-lived credential;
3. verify the epoch is still current;
4. disconnect providers to cancel provider-owned reconnect loops;
5. connect the root and active body providers;
6. replay durable candidates and attachment publications;
7. verify the epoch again before reporting completion.

Initial root admission and demand-loaded body admission use the same owner.
Manual commands, foreground and online events, provider disconnects, ticket
maintenance, QA network release, and retry timers only request work from that
owner. Concurrent requests share one logical reconnect attempt. A body
admission already in progress is completed before a forced all-provider
reconnect, and a body opened during an all-provider attempt joins that attempt.

The ticket cache is single-flight per host/device/vault identity. Invalidation
rotates a cache revision, so a response which began before invalidation may
finish its caller but cannot repopulate the cache. The runtime epoch separately
prevents that caller from publishing into a replaced or destroyed runtime.

Ticket failures are machine classified. Rate limits and server/network errors
remain retryable, and `Retry-After` is honored. Unauthorized, revoked,
incompatible-protocol, and malformed responses stop admission and surface as a
terminal sync state. WebSocket fatal frames remain the authority for a ticket
which was validly minted but rejected for purpose, protocol, membership, or
generation at the socket boundary.

## Server sibling

The Worker and Node hosts already implement the corresponding observable
ordering: reject admission once drain starts, close live sessions, await
accepted work, flush actor state, close actors, then release process ownership.
The Node runtime race suite covers readiness and request admission while drain
begins; the Worker vault runtime rejects fetch/socket admission once its drain
promise exists. These hosts share the lifecycle language without importing the
browser runtime class.

## Evidence and limits

Focused tests cover epoch invalidation, double and late lease release, bounded
drain reporting, credential single-flight, invalidation during a delayed
response, simultaneous reconnect signals, root/body ordering, retryable versus
terminal outcomes, and teardown during credential refresh. Production and test
typechecks plus the production plugin build exercise the integrated boundary.

Browser WebSocket APIs do not expose protocol ping/pong frames. Socket protocol
2 therefore supplies an application-level `VAULT_PING`/`VAULT_PONG` contract.
The current socket attachment, device fence, vault generation, runtime epoch,
document identity, and exact probe ID are checked before a pong renews
liveness. Background suspension cancels deadlines; foregrounding requests
fresh proof. A timeout fences late browser events, abandons the old transport,
and enters the existing refresh-first admission path. See
[application-level socket liveness](socket-liveness.md).
