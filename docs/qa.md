# QA status and evidence

QA claims only the surface that was executed. Unit/model tests do not prove Cloudflare deployment behavior, Obsidian filesystem behavior, or mobile lifecycle ordering.

Generated reports and device artifacts belong under ignored `qa-runs/`. Historical runs are not current schema-10 evidence unless they exercise the current principal/device authority, storage, protocol, attachment revision, semantic-epoch, and recovery formats.

## Current integration evidence

The integrated schema-10 collaboration and pathology redesign has automated evidence from:

- focused schema-10 client, control-plane, vault-authority, settings, Canvas, Excalidraw, compaction, and public-API suites;
- the complete discovered regression suite;
- the separately accountable local Wrangler Worker driver;
- the runtime-blind Wrangler/Node conformance matrix;
- the real-process headless daemon suite, isolated CLI bundle smoke, and packed-install/bin smoke;
- focused Node SQLite, object-store, alarm, migration, lock, and health suites.

The canonical `npm run test:ci` gate runs both CLI checks through `npm --prefix packages/cli run smoke` and `npm --prefix packages/cli run pack-smoke`.

Earlier Worker benchmarks and soaks established the sharding design. No repeat benchmark, soak, external Cloudflare deployment, or real mobile run is included in this integration result.

### Desktop attachment intent fencing

A disposable two-device Obsidian 1.13.7 run passed `attachment-intent-field-shapes` against a fresh local Worker and two independently enrolled profiles. It exercised equal-size rapid Canvas and Base rewrites, Base rename before first publication, delete before first publication, plugin stop during debounce followed by restart, two-device disk materialization, and required intent/transfer/publication telemetry. Both device analyzers reported zero hard failures, warnings, critical drops, redaction failures, hash mismatches, or stuck receipts. The retained local artifacts are under `qa-runs/attachment-intent-phase5/2026-09-05T23-06-33-attachment-intent-field-shapes-A` and the corresponding `-B` directory.

The first attempt exposed a real hibernation boundary: a committed attachment update was not broadcast when root sockets existed but the server root cache was unloaded. The server now broadcasts every newly committed durable root update independently of cache residency, with focused regression coverage. A post-fix desktop probe and the complete scenario both materialized the attachment on the peer. Excalidraw was intentionally omitted, as allowed for this phase.

## Focused client coverage

Current client suites exercise:

- `onboarding-import.ts`: origin versus joining provisioning, exact schema-10 provisioning proof, bounded initial inventory, and bulk import;
- `collaboration-authority.ts`: fixed owner/member roles and capabilities, authority epochs, stale-work rejection, and complete persisted principal/device authority tuples;
- `body-manager-load-race.ts`: one load winner and no stale IndexedDB overwrite;
- `bootstrap-http-boundaries.ts`: authenticated root/catalog/body SQL bootstrap routes and generation headers;
- `bootstrap-settlement.ts`: root/body verification, safe paths, hash/size/generation checks, feed catch-up, and outstanding retry state;
- `bootstrap-rename-race.ts`: 200 creates with 100 concurrent renames settle only current heads;
- `recovery-snapshot-v2.ts`: strict current-format root and manifest parsing;
- `recovery-backup.ts`: backup-before-replacement and changed-target review;
- `multivault-enrollment-contract.ts`: complete principal/device authority and schema-10 cache retirement;
- existing reconciliation, delete-preservation, editor-binding, diagnostics, attachment-conflict, and lifecycle suites through the full regression discovery.
- `public-api.ts`: immutable collaboration authority, member/presence projection, preserved-unpublished-work counts, and reload fencing without credential exposure;
- `attachment-publication-replay.ts`: lost responses, root-persistence failure, stable operation-ID replay, and durable upsert/delete/rename intent;
- `body-manager-load-race.ts`: aggregate client cost admission, safe LRU eviction, and protected-body refusal;

Settings-focused client coverage is grouped by contract rather than repeated elsewhere:

- pure policy: `settings-sync-allowlist.ts`, `settings-sync-config-dir.ts`, `settings-sync-blank.ts`, `settings-sync-clash.ts`, `settings-sync-lww-reconcile.ts`, `settings-sync-data-json-gate.ts`, `settings-sync-watch.ts`, and `plugin-intent.ts` cover the closed path set, named keys, first-choice classification, clashes, revision decisions, the plugin-data three-version gate, watcher scans, catalog pins, and platform/installer gates;
- durable queue: `settings-sync-apply-queue.ts` and `settings-sync-queue-identity.ts` cover persist-before-mutate, checkpoint/resume, JSON quarantine, partial-step continuation, background install pause, exact host/vault/generation/folder/device/configuration identity, durable environment acceptance, and exact retirement;
- engine: `settings-sync-engine.ts` covers capability/master/acceptance gating, serialized lifecycle, and installer-hook restoration;
- protocol: `settings-sync-protocol.ts` covers device-bearer vault routes, exactly one settings-format declaration, bounded strict response parsing, and duplicate rejection.

These tests use controlled ports and models. They prove policy and orchestration contracts, not a real Obsidian adapter or mobile filesystem.

## Focused server coverage

Current server suites exercise:

- `vault-store-sqlite-cycle.ts`: schema-10 binary journal/checkpoint persistence and reconstruction;
- `vault-server-runtime.ts` and `vault-document-cache.ts`: root/body runtime ownership, persistence, and clean-only cache behavior;
- `vault-candidate-runtime.ts`: device-scoped candidate identity, digest validation, idempotent receipts, and stale-candidate rejection;
- `bootstrap-security.ts`: fixed-boundary SQL bootstrap, pins, bounds, and failure behavior;
- `recovery.ts`, `recovery-job.ts`, and `recovery-routes-v2.ts`: capture/restore/GC job state, immutable content/manifests, bounded reads, and public route validation;
- `recovery-generation-fence.ts`: job and object authority cannot cross vault generations;
- `recovery-deletion.ts`: generation purge completes before SQL deletion;
- `multivault-registry.ts` and `identity-control-plane.ts`: provisioning state, identity-format admission, retryable deletion obligations, and purge identity;
- `collaboration-control-plane.ts`: principals versus devices, owner/member invariants, invitation/device-link separation, owner governance, accepted ownership transfer, last-owner-device rejection, and exact actor revisions;
- `vault-collaboration-authority.ts`: trusted actor parsing, forged-header stripping, fixed capability policy, and non-colliding principal settings namespaces;
- `vault-route-authority.ts` and socket admission suites: principal/device revisions, vault generation, schema 10, protocol 8, purpose/document/epoch ticket binding, and stale-authority rejection.
- `vault-document-cache.ts`: aggregate encoded-state/transient limits, mixed-size LRU, protected-body refusal, and exactly-once reservation release;
- identity suites: response-loss-safe enrollment replay and durable retryable device revocation obligations;
- `settings-sync-store.ts`: SQL seed/replace, monotonic LWW revisions, intents/tombstones, plugin-data gates, atomic failure, JSON/hash/path/count/body bounds, and bounded HTTP reads;
- `settings-sync-route-authority.ts`: current principal/device authority, wrong-vault/revoked denial before runtime allocation, trusted actor forwarding without the bearer, and principal-scoped environment isolation.

The full regression runner discovers suites under `tests/client`, `tests/server`, and `tests/contracts`, plus its harness/discovery self-tests. Discovery guards reject unaccounted inert suites.

## Local Worker coverage

`tests/live/run-live.ts` starts one fresh local Wrangler Worker with isolated persistence, claims and provisions schema 10, and enrolls multiple independently credentialed devices under the owner principal. It accounts for every TypeScript file under `tests/live`.

The current passing local Worker run covers:

- claim, owner bootstrap, same-principal device link, device roster, device revocation, and consumed-code rejection;
- exact document schema `10`, socket protocol `8`, and identity format `3` admission;
- root and body socket connections using deployment-, actor-, purpose-, and document-bound tickets;
- device A create/candidate/root publication and device B cold SQL bootstrap;
- device B durable body edit, device A catch-up, rename publication, delete tombstone, and stale candidate rejection;
- SQL persistence across local Worker restart;
- asynchronous recovery capture, format-3 root/catalog/branch/content reads, and selective restore result handshake;
- ticket refresh, missing/wrong admission values, wrong vault access, and hardening paths;
- active socket closure and stale-ticket rejection after device revocation;
- operator destroy, stable generation-scoped purge identity, and R2 purge completion before SQL deletion;
- `tests/live/settings-sync.ts`: same-principal settings seed/read/mutation, exact device authority and format rejection without mutation, no root/body cache hydration, and socket health after settings traffic;
- `tests/live/operator-destroy.ts`: seeded settings become inaccessible on destroy and a fresh vault generation begins unseeded.

This driver uses Node Yjs clients and local Wrangler. It does not launch Obsidian and does not traverse public Cloudflare routing.

These settings live cases exercise HTTP/SQLite behavior through local Wrangler. They do not run the shipped Obsidian settings engine, filesystem watcher, apply queue, package installers, or a public deployed Worker.

## Headless and Node runtime coverage

`tests/headless/run-headless.ts` launches a real local Worker, enrolls distinct CLI and peer devices, and drives the CLI only through argv, environment, filesystem, stdout, signals, HTTP, and WebSockets. Its passing cases cover replay-safe enrollment, origin import, joining bootstrap, exact two-way Markdown sync, burst admission, non-cold restart, offline changes, process locking, last-instant shutdown durability, conservative remote-delete handling, persisted unresolved state, dropped watcher hints, two-phase delete evidence, atomic saves, unreadable and symlinked subtrees, and the documented delete-plus-create rename limitation. It does not claim attachment, `.obsidian`, network-filesystem, or mobile support.

`tests/conformance/run-conformance.ts` runs the same public fixtures against local Wrangler and `packages/server-node`: capabilities, routing, identity, ticket/version admission, root/body candidate and lifecycle ordering, SQL bootstrap/feed, crash durability, settings, attachments, recovery, purge-first deletion, and root awareness. The Node target additionally proves recovery dispatch resumption across process death. Local Wrangler does not claim that process-level alarm property because stopping the emulator is not Durable Object eviction.

`tests/node-runtime/` separately proves Node-only mechanics: zero-copy BLOB bindings and exact offset ownership, lazy cursors and rollback, create-only object publication, durable alarm leases/quarantine, forward migration refusal, one-owner locking, and liveness/readiness. `tests/docker/smoke.mjs` then builds and drives the production image through its published port and persistent volume. It requires the image to run non-root with a read-only root filesystem, expose exact liveness/readiness, persist a real claim across restart, reject a second volume owner with exit 17, and stop cleanly under Docker's `SIGTERM`. This is local-container evidence, not a claim about an external registry, reverse proxy, or deployed host.

## What is not yet proven

The following remain deferred and must not be represented as passing evidence:

### Real multi-person collaboration

Focused models and local Worker tests do not prove a complete two-person
Obsidian run. Invitation acceptance on a second person's real device,
principal-aware cursors across body rooms, member removal with unpublished-work
preservation, ownership transfer/reconnect, owner recovery, and security-audit
UX still require an external desktop/mobile scenario. Revocation cannot prove
erasure of plaintext already downloaded by a former member.

### Large-vault benchmark rerun

Prior sharding/recovery benchmark evidence exists. The integrated identity, provisioning, and generation-fencing changes have not been put through another production-scale bootstrap, memory, recovery, R2-cost, or purge benchmark; that repeat is deliberately deferred.

### Soak and fault-duration rerun

Prior long-run Worker soak evidence exists. The integrated build has not repeated prolonged eviction, alarm retry, R2 outage, pin-expiry, GC interruption, or deletion-retry scenarios.

### Deployed Cloudflare boundary

A disposable two-device run against the deployed validation Worker passed
enrollment, HTTP and WebSocket synchronization, Markdown/Canvas lifecycle,
attachments, recovery, settings, revocation, and generation purge. The exact
deployment and Access policy boundary are recorded in the
[Yjs pathology remediation report](pathology-remediation-report.md).

That one destructive run proves the exercised Cloudflare routing and Durable
Object paths; it does not prove prolonged placement/eviction behavior, alarms
under every platform scheduling condition, R2 consistency during outages,
rollback across every deployment migration, or long-duration operator retries.

The same live suite can target a fresh disposable deployed Worker without starting local Wrangler. Set `YAOS_TEST_DEPLOYED_HOST` to its exact HTTPS origin and explicitly acknowledge teardown with `YAOS_TEST_DEPLOYED_DISPOSABLE=true`, then run `npm run test:integration:deployed`. The suite claims the fresh deployment, mutates it, exercises HTTP and WebSocket behavior, and destroys its test vault; it must never target a retained or production deployment.

### Obsidian and mobile restore

No current integration run proves recovery-v2 replacement through a real desktop or mobile Obsidian vault, local backup creation on those adapters, sleep/wake continuation, background suspension, or large attachment restoration.

### Obsidian settings sync

A disposable local run on Obsidian 1.13.7 passed `qa/controllers/settings-sync-smoke.mjs`: note sync remained online and provider-synced while exact capability/generation identity, explicit seed, remote allowlisted CSS mutation and command-driven disk apply, and consented Calendar 1.5.10 installation all succeeded. The emitted artifact is retained under ignored `qa-runs/settings-sync-desktop/obsidian-1.13.7.json`.

This proves one desktop seed/apply/install path against a local current Worker. It does not prove two real Obsidian folders, LWW deletion, invalid-JSON quarantine, crash/restart queue resume, plugin/theme tombstones, version-held plugin data, clash pause, mobile behavior, or deployed Cloudflare placement/eviction.

### Greenfield reinstall rehearsal

The supported boundary is a fresh current-schema deployment. No earlier-schema or storage-format migration exists. A complete user-facing rehearsal with several real people/devices, semantic file import, owner bootstrap, settings assignment, mirror verification, and old-ticket rejection remains external validation.

## Required evidence discipline

- Preserve raw failures; do not weaken a regression to obtain green output.
- A passing candidate receipt proves server durability for that candidate, not other-device disk materialization.
- A successful local bootstrap proves the SQL protocol and controlled disk port, not real filesystem watcher ordering.
- A successful recovery handshake with `skipped-changed` does not prove client replacement.
- `complete_with_gaps` must retain explicit unavailable entries and is not full recovery coverage.
- Local Wrangler is not a deployed Worker.
- Desktop simulation is not mobile lifecycle evidence.
- Benchmark samples are not soak evidence.

Open evidence gaps and field risks are tracked in [BACKLOG.md](BACKLOG.md); architecture claims remain in [architecture.md](architecture.md).
