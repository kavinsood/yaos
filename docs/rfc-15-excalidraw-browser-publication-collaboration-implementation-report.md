# RFC 15 Excalidraw browser publication and collaboration implementation report

**Status:** read-only browser demo vertical slice implemented; production release remains gated  
**Contract:** [RFC 15](rfc-15-excalidraw-browser-publication-collaboration.md)  
**Date:** 2026-09-09

## Honest status

RFC 15 now has an integrated schema-10 core rather than only a design or mock.
The same RFC-13 Drawing Durable Object owns member and public mutations; owner
share routes, fragment exchange, cookie sessions, sanitized live reads,
read-only enforcement, public writes, audience-safe presence, explicit owner
resources, validated inbound quarantine, browser-neutral clients, and rejected
work preservation run through the real Worker journey.

That is not yet the complete browser product described by the RFC. No profile
is enabled by default. A production-built React Excalidraw viewer now provides
the minimum read-only demonstration path, but share-local projection lineage,
inbound-resource finalization, publication jobs, full lifecycle/GC, arbitrary-
guest edge policy, and external host/deployment gates remain open. Public read
and write routes return `404` unless their independent deployment flags are
explicitly enabled.

## Version boundary

| Boundary | Delivered |
| --- | ---: |
| Schema | 10 |
| Storage format | 6 |
| Global protocol | 8 |
| Public projection protocol | 1 |
| Presence protocol | 2 |
| Snapshot/recovery | 4, unchanged |
| Collaboration policy | 2 |

The plugin, Worker, Node host, CLI, tests, release builder, compatibility guard,
IndexedDB namespace, and Node SQLite filename use the same exact cutover. There
is no schema-9 cache or storage migration path.

## Profile status

| Profile | Implemented core | Remaining product gates | Release state |
| --- | --- | --- | --- |
| Enrolled full-vault browser | Shared engine, official-API adapter, member HTTP/socket/resource ports | Browser enrollment UX, production member SPA, React/IndexedDB/deployed tests | Disabled |
| Public read-only | Owner grant, sealed exchange, cookie routes, production React viewer, live sanitized snapshot/replay/socket, server RO enforcement | Share-local projection lineage, resource publication UX, privacy corpus, deployed revoke and real Obsidian/browser | Opt-in demo only |
| Public read-write | Canonical sidecar-preserving scene writes, server permission fences, outbox preservation, validated raster quarantine | Editing SPA UX, upload intent/finalize/attach, `.excalidraw` recovery UX, rate limits, deployed offline-revoke and desktop/mobile | Disabled |

## Delivered implementation

### Authority and gateway

- `server/src/excalidrawRoom.ts` owns grants, sessions, management receipts,
  public mutation receipts, exact grant-revision checks, scene commits, socket
  fencing, expiry alarms, public projection, presence projection, resources,
  and quarantine in the canonical Drawing actor.
- `server/src/routes/excalidrawShares.ts` provides owner-only management and the
  cookie-authenticated public route family. Vault, drawing, principal, device,
  bearer, secret, and session identifiers do not enter public URLs.
- `server/src/excalidrawShareEnvelope.ts` seals route and session locators with
  AES-GCM using purpose-separated deployment key material.
- `server/src/vaultExcalidrawAuthority.ts` and the vault runtime reserve member
  and share work and fence drawing shares during destructive lifecycle work.
- `YAOS_EXCALIDRAW_PUBLIC_READ` and `YAOS_EXCALIDRAW_PUBLIC_WRITE` are
  independent exact-`"true"`, default-off gates.

### Projection and presence

- `server/src/shared/excalidrawShareProtocol.ts` freezes the public element
  types and 51-field allowlist to a canonical hash. Links, `customData`, plugin
  metadata, embeddables, vault paths, and auxiliary Markdown are excluded.
- Public writes reject unknown fields and graft allowed changes onto the
  current canonical element, retaining private sidecars.
- `server/src/shared/presenceProtocol.ts` and `server/src/presenceKernel.ts`
  implement presence protocol 2 with recipient-specific projections. Public
  identities, state, follow targets, snapshots, and leave frames use
  share-scoped participant identities; trusted members do not receive raw
  share authority identifiers.
- Drawing alarms delete expired sessions and close idle public sockets without
  requiring another client request.

### Browser-neutral client

- `src/sync/excalidraw/browserHost.ts` binds official React Excalidraw seams:
  `onChange`, `onPointerUpdate`, `getSceneElementsIncludingDeleted`, `addFiles`,
  collaborator maps, and `updateScene(..., captureUpdate: "NEVER")`.
- `src/sync/excalidraw/browserClient.ts` composes the existing RFC-13
  `ExcalidrawSameVaultEngine`; it does not fork reconciliation logic.
- `src/sync/excalidraw/browserTransport.ts` provides member and public
  HTTP/WebSocket transports, clears fragment material before parsing/exchange,
  uses cookie-only public URLs, and reacts to authority changes.
- `src/sync/excalidraw/shareManagement.ts` creates, updates, and revokes exact
  digested grants while keeping the raw secret only in the returned fragment.
- `src/sync/excalidraw/browserResources.ts` verifies resource hash, size, MIME,
  and manifest binding. Public inbound upload currently stops at server-side
  validated quarantine and is not attached to canonical metadata.
- `src/sync/excalidraw/browserWork.ts` moves rejected durable operations to the
  alternatives store and exports a secret-free operation bundle.

### Read-only demo application

- `browser/excalidraw-share` is a pinned React 18 and Excalidraw 0.18.1
  application. It exchanges the fragment once, clears it from browser history,
  retains reload metadata in `sessionStorage`, and starts the shared RFC-13
  engine in Excalidraw view mode.
- `scripts/build-excalidraw-share.mjs` produces `server/public/share`, copies
  self-hosted Excalidraw fonts, removes the upstream external font fallback,
  and fails the build if that pinned transformation cannot be applied exactly.
- The Worker serves `/share` and its assets through the Cloudflare asset
  binding with no-store, CSP, no-referrer, MIME-sniffing, opener, permissions,
  and frame-ancestor protections.
- The Obsidian command **Create read-only browser link for active Excalidraw
  drawing** creates a 24-hour, shape-and-text-only share and presents copy/open
  controls. Embedded resources are deliberately excluded from this demo.

## Automated evidence

The focused RFC-15/RFC-13/RFC-14 integration set covers browser composition,
host echo suppression, resources, work preservation, member/public transports,
presence, the public gateway, allowlist hash, redaction, sidecar preservation,
read-only rejection, read-write commit, raster validation, quarantine, revision
fences, expiry, and resources.

`tests/live/excalidraw.ts` runs through a real local Wrangler Worker with SQLite
Durable Objects and R2 emulation. It proves:

- RFC-13 two-device promotion, scene convergence, replay, snapshots, and
  response-loss receipts;
- RFC-14 two-device presence on the same Drawing socket;
- owner creation of an explicit read-only public grant;
- fragment-to-HttpOnly-cookie exchange and sanitized snapshot/resource reads;
- server-side read-only mutation rejection;
- upgrade invalidation of the stale session;
- a fresh read-write session committing into canonical Drawing authority;
- revoke rejection of stale and offline public authority;
- generation-scoped operator destruction after public activity;
- a real headless Chrome instance loads the production React Excalidraw viewer,
  renders the initial public scene, stays live over the public WebSocket, and
  renders a subsequent member-side scene commit.

Final validation on 2026-09-09 passed:

- `npm run test:regressions`: 182 suites passed, 0 failed;
- `npm run test:integration:worker`: the complete local Wrangler/SQLite Durable
  Object journey passed, including RFC-13 scene synchronization, RFC-14
  presence, RFC-15 read-only publication, permission fencing, read-write
  collaboration, revocation, and generation-scoped destruction;
- the focused journey with `YAOS_TEST_BROWSER_EXECUTABLE` set to local Chrome
  passed initial render and live member-to-browser update without external font
  requests or CSP errors;
- focused RFC-15 suites, product/test typechecks, product and server builds,
  Node-server typecheck, schema/version guards, and release compatibility
  passed;
- `npm run build:server-release`, `npm run lint:worktree` (63 modified files),
  and `git diff --check` passed.

## Remaining RFC-15 work

### Product delivery beyond the demo

- Add browser enrollment and the full-vault member profile, durable IndexedDB
  lifecycle, offline/reload recovery matrices, collaborator rendering,
  rejected-work download, and share-management/revocation UX.
- Expand the real pinned Excalidraw browser run beyond initial/live read-only
  rendering into member/member, public/public, offline, resource, downgrade,
  revoke, export, mobile viewport, and accessibility matrices.

### Public lineage and governance

- Introduce durable `publicationRevision`, share-local `publicSequence`, public
  projection/event/receipt tables, immutable manifests, replacement staging,
  and fail-closed share suspension that cannot affect canonical member commits.
- Add owner pre-effect intent, Vault-DO grant-management reservations, detail,
  rotation, publication replacement, and committed-outcome recovery.
- Bind multi-tab cookie selection and WebSocket admission without putting
  authority in URLs; add the RFC subprotocol/nonce contract.

### Inbound resources and cleanup

- Add durable upload intents, one-use body admission, explicit finalization,
  attached Drawing-resource resolution, owner import, abandonment, and GC.
  Current PNG/JPEG/WebP bodies are magic-checked and quarantined but cannot yet
  be referenced by a public scene.
- Add publication/quarantine deletion acknowledgements for replacement,
  downgrade, revoke, expiry, reset, demotion, epoch replacement, room reaping,
  and deployment retirement.

### Abuse, recovery, and lifecycle

- Add the RFC per-route/session rate and byte budgets, receipt retention, and
  residency admission for near-limit public projection work.
- Prove delete/demote/reset ordering against in-flight public writes and close
  the inherited RFC-13 revive/demotion/epoch-replacement gaps.
- Prove snapshots, export, restore, and rollback recreate no grant, session,
  secret, publication, receipt, cookie, or quarantine authority.
- Normalize the complete public error corpus and add cross-share correlation,
  substitution, dependency-depth, and hostile-media privacy vectors.

## Inherited release gates

RFC 15 still inherits RFC-13/14 release work: closed-file projection and
open/closed/rename races; auxiliary Markdown authority; revive/demotion/epoch
replacement; state hashes and retention; durable same-vault resource jobs;
interaction/IME deferral; pending-work/reset/export/recovery accounting; real
Obsidian desktop/mobile matrices; and disposable deployed Worker evidence.

## External gates

- Disposable Cloudflare deployment with real DO hibernation, alarms, R2,
  WebSocket upgrade, Access/public-gateway separation, expiry, and revoke.
- Real React Excalidraw browser matrices for member/member, member/public,
  public/public, resources, offline/reconnect, downgrade, revoke, and export.
- Real Obsidian desktop/desktop and desktop/mobile validation for undo,
  autosave, IME, resources, background/resume, and private-sidecar retention.

## Release decision

The protocol and Worker core are suitable for continued integration. All three
profiles remain disabled. Read-only publication may be enabled only after the
SPA, public-lineage, privacy, deployed, and lifecycle gates pass. Public writes
additionally require inbound finalization, abuse controls, offline-revoke UX,
and real desktop/mobile evidence.
