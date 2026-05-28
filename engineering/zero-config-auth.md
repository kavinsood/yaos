# Zero Config Onboarding

Self-hosted software usually dies at the onboarding step. Forcing a user to open a terminal, run OpenSSL to generate a 32-byte cryptographic secret, and paste it into a .env file guarantees a 90% abandonment rate.

YAOS implements a consumer-grade, zero-terminal claim flow, while gracefully handling the realities of infrastructure paywalls.

## The Framework Migration: Killing the CLI

The first version of YAOS was built on PartyKit. PartyKit provided an incredible early abstraction - it wrapped Cloudflare's complex Durable Objects behind a simple "Room" API and made real-time multiplayer trivially easy to bootstrap.

However, the deployment worked exclusively through their proprietary CLI. The problem is that users must login through partykit-cli to deploy, meaning we couldn't utilize Cloudflare's "One-Click Deployment" button. This violated our core onboarding goal: Zero-terminal, consumer-grade self-hosting.

To unlock the deploy button, we stripped out the PartyKit framework and ported the entire transport layer to native Cloudflare Workers using y-partyserver, handle WebSocket transport and Durable Object coordination. We define the entire infrastructure (Workers, Durable Objects, and Storage) in a standard `wrangler.toml` file, eliminating the CLI entirely and allowing users to deploy straight from their browser.

# The Single-Use Claim Architecture

When deployed, the YAOS server boots into an "Unclaimed" state.
- The user visits the Worker URL in their browser and is greeted by a lightweight, dependency-free HTML setup page.
- The browser utilizes crypto.getRandomValues() to generate a high-entropy token locally.
- The user clicks "Claim". The token is sent to the server.
- The server hashes the token (SHA-256) and stores only the hash inside a singleton Config Durable Object via an ACID transaction.
- The setup route permanently locks itself.

For subsequent authentication, the plugin uses `Authorization: Bearer <token>` for HTTP endpoints.

For WebSocket sync transport, the plugin uses **short-lived connection tickets** issued by the server.  Before opening a WebSocket connection the plugin calls `POST /vault/:vaultId/auth/ticket` with the long-lived bearer token in the Authorization header.  The server returns a ticket valid for 5 minutes, scoped to the specific vault, and signed with HMAC-SHA256.  Only the ticket appears in the WebSocket URL query parameter — the long-lived token never touches a URL.

Old plugin versions that predate ticket auth continue to work during the migration window: the server accepts either a valid ticket (`?ticket=`) or a valid long-lived token (`?token=`) and emits a warning to Worker logs when the legacy path is used.

## Current transport model

- HTTP routes (`/vault/*`, setup helpers, snapshot APIs) authenticate with `Authorization: Bearer <token>`.
- WebSocket sync (`/vault/sync/:room`) authenticates with a short-lived `?ticket=` signed by the server.  Legacy `?token=` is accepted during the migration window.
- All traffic is expected over HTTPS/WSS in normal deployment.

## Ticket auth detail

The server issues tickets at `POST /vault/:vaultId/auth/ticket` (requires valid Bearer auth).  The ticket payload is:

```json
{ "v": 1, "aud": "yaos-ws", "vaultId": "...", "iat": <ms>, "exp": <ms>, "nonce": "<random>" }
```

Signed as `base64url(payload).base64url(HMAC-SHA256(signingKey, base64url(payload)))`.  The signing key is derived from the server's existing auth secret so no additional deployment secret is required.

The plugin caches the ticket and refreshes it when less than 30 seconds remain, so reconnects reuse a valid cached ticket without an extra HTTP round-trip.

## Reconnect behavior and the y-partyserver constraint

`YProvider.connect()` evaluates the async `params()` callback exactly once, mutates `provider.url` with the result, then calls the base `WebsocketProvider.connect()`.  The internal reconnect loop (`setupWS`) reads `provider.url` directly on every subsequent reconnect without re-invoking `params()`.

This means the ticket inserted on the initial connection would become stale after its 5-minute TTL, causing all reconnects after that point to present an expired ticket and receive 401 responses — permanently, until plugin reload.

The fix is a proactive refresh manager in `VaultSync`:

1. After the initial `params()` call succeeds with a ticket, `scheduleSocketTicketRefresh` sets a timer at `expiresAt - TICKET_REFRESH_BUFFER_MS` (i.e. 30 seconds before expiry).
2. When the timer fires, it calls the ticket callback with `force=true`, which bypasses the cache and fetches a fresh ticket from the server.
3. `patchProviderTicket` replaces `?ticket=` in `provider.url` with the new value and removes any legacy `?token=` if present.  Other query parameters (schemaVersion, `_pk`, trace context) are preserved.
4. The timer reschedules itself based on the new ticket's `expiresAt`.
5. On every `"disconnected"` status event, a best-effort refresh also fires before the internal reconnect timer retries.  This secondary path handles sleep/wake and abrupt network drops where the proactive timer may not have fired in time.  It races the first reconnect attempt (100ms backoff), but subsequent retries will use the updated URL.

The `force=true` flag causes `ticketCache.invalidate()` to run before `ticketCache.get()`, guaranteeing a network fetch rather than returning the still-cached (but about-to-expire) ticket.

If `y-partyserver` is upgraded, verify whether this behavior has changed — see also `engineering/warts-and-limits.md`.

## Threat model notes

The long-lived token is no longer placed in any URL.  A leaked ticket is bounded by the 5-minute TTL — useless by the time a log rotation or audit sees it.

For legacy clients still using `?token=`, the risk profile is unchanged from v1: acceptable when TLS is enabled end-to-end and server logs are access-controlled.

## Migration path: disabling legacy token auth

Once all plugin clients in your deployment have upgraded to the ticket-aware version (identifiable by Worker logs no longer containing `"legacy ?token= WebSocket auth"`), set the operator flag to close the legacy path permanently:

```toml
# server/wrangler.toml
[vars]
YAOS_DISABLE_LEGACY_WS_TOKEN = "true"
```

When set, connections using `?token=` are rejected with 401 before the vault Durable Object is woken.  Ticket-authenticated connections are unaffected.

The `wrangler.toml` included with the server contains this setting as a commented-out example with upgrade guidance.

## Planned hardening (post-current)

- Replace `tokenHash`-as-signing-key with a random per-server ticket signing secret generated at claim time and stored in the Config DO.  This removes the promotion of the token verifier hash to signing authority.  Existing deployments would backfill lazily on next claim.
- Ensure auth material is redacted from traces and diagnostics by default.

For the broader list of accepted compromises and tracked debt, see
`engineering/warts-and-limits.md`.

# The URI Protocol Handshake

To completely eliminate the copy-paste step, the setup page generates a custom deep-link: `obsidian://yaos?action=setup&host=...&token=....`

When clicked, the OS routes this directly to the Obsidian plugin, which intercepts the URI, configures its internal settings, and immediately boots the sync engine.

# Graceful Degradation and the Credit Card Wall

Because YAOS utilizes native `wrangler.toml` bindings, Cloudflare can automatically provision Durable Objects and R2 buckets upon deployment. 

However, we made the intentional product decision **not** to force the R2 bucket binding in the default deployment template. Cloudflare enforces a strict requirement: users must have a primary payment method (credit card) on file to provision an R2 bucket. If YAOS required this binding by default, the "Deploy to Cloudflare" button would hit a billing wall, and users without a configured payment profile would abandon the setup.

We solved this via Capability Negotiation:
- The default YAOS deployment provisions only the text-sync CRDT engine (Worker + Durable Object). It requires no credit card.
- When the Obsidian plugin connects, it performs a capability probe (`GET /api/capabilities`).
- If the server lacks the `YAOS_BUCKET` binding, it returns `{ attachments: false, snapshots: false }`.
- The plugin reads this and gracefully disables the attachment and snapshot UI. It continues to sync markdown text flawlessly.

![Deploy-button resilience without mandatory R2](./diagrams/deploy-button-resilience-without-mandatory-r2.webp)


Power users who want attachment sync can easily add the R2 binding later via the Cloudflare dashboard **one-step (Just add an R2 binding to the Worker)**. The server will dynamically detect the new binding, update its capabilities, and the plugin will unlock the UI without a single line of code changing.
