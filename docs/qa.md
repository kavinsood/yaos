# QA status and evidence

QA claims only the surface that was executed. Unit/model tests do not prove Cloudflare deployment behavior, Obsidian filesystem behavior, or mobile lifecycle ordering.

Generated reports and device artifacts belong under ignored `qa-runs/`. Historical runs are not current schema-4 evidence unless they exercise the current storage, protocol, and recovery formats.

## Current integration evidence

The integrated schema-4 change has current passing evidence from:

- focused schema-4 client and server suites;
- the complete discovered regression suite;
- the separately accountable local Wrangler Worker driver.

Prior donor-branch Worker benchmarks and soaks established the sharding design. No repeat benchmark, soak, external Cloudflare deployment, or real mobile run is included in this integration result.

## Focused client coverage

Current client suites exercise:

- `onboarding-import.ts`: origin versus joining provisioning, exact schema-4 provisioning proof, bounded initial inventory, and bulk import;
- `body-manager-load-race.ts`: one load winner and no stale IndexedDB overwrite;
- `bootstrap-http-boundaries.ts`: authenticated root/catalog/body SQL bootstrap routes and generation headers;
- `bootstrap-settlement.ts`: root/body verification, safe paths, hash/size/generation checks, feed catch-up, and outstanding retry state;
- `bootstrap-rename-race.ts`: 200 creates with 100 concurrent renames settle only current heads;
- `recovery-snapshot-v2.ts`: strict format-2 root and manifest parsing;
- `recovery-backup.ts`: backup-before-replacement and changed-target review;
- `multivault-enrollment-contract.ts`: device-scoped memberships and schema-4 cache retirement;
- existing reconciliation, delete-preservation, editor-binding, diagnostics, attachment-conflict, and lifecycle suites through the full regression discovery.
- `attachment-publication-replay.ts`: lost responses, root-persistence failure, stable operation-ID replay, and durable upsert/delete/rename intent;
- `body-manager-load-race.ts`: aggregate client cost admission, safe LRU eviction, and protected-body refusal;

These tests use controlled ports and models. They prove policy and orchestration contracts, not a real Obsidian adapter or mobile filesystem.

## Focused server coverage

Current server suites exercise:

- `vault-store-sqlite-cycle.ts`: schema-4 root/body SQL persistence and reconstruction;
- `vault-server-runtime.ts` and `vault-document-cache.ts`: root/body runtime ownership, persistence, and clean-only cache behavior;
- `vault-candidate-runtime.ts`: device-scoped candidate identity, digest validation, idempotent receipts, and stale-candidate rejection;
- `bootstrap-security.ts`: fixed-boundary SQL bootstrap, pins, bounds, and failure behavior;
- `recovery.ts`, `recovery-job.ts`, and `recovery-routes-v2.ts`: capture/restore/GC job state, immutable content/manifests, bounded reads, and public route validation;
- `recovery-generation-fence.ts`: job and object authority cannot cross vault generations;
- `recovery-deletion.ts`: generation purge completes before SQL deletion;
- `multivault-registry.ts` and `identity-control-plane.ts`: provisioning state, memberships, retryable deletion obligations, and purge identity;
- `vault-route-authority.ts` and socket admission suites: device, vault, schema, and protocol boundaries.
- `vault-document-cache.ts`: aggregate resident/transient limits, mixed-size LRU, protected-body refusal, and exactly-once reservation release;
- identity suites: response-loss-safe enrollment replay and durable retryable device revocation obligations;

The full regression runner discovers suites under `tests/client`, `tests/server`, and `tests/contracts`, plus its harness/discovery self-tests. Discovery guards reject unaccounted inert suites.

## Local Worker coverage

`tests/live/run-live.ts` starts one fresh local Wrangler Worker with isolated persistence, claims and provisions schema 4, and enrolls two distinct device identities. It accounts for every TypeScript file under `tests/live`.

The current passing local Worker run covers:

- claim, provisioning, operator session, pairing, roster, and self-leave;
- exact document schema `4` and socket protocol `1` admission;
- root and body socket connections using short-lived device tickets;
- device A create/candidate/root publication and device B cold SQL bootstrap;
- device B durable body edit, device A catch-up, rename publication, delete tombstone, and stale candidate rejection;
- SQL persistence across local Worker restart;
- asynchronous recovery-v2 capture, format-2 root/catalog/branch/content reads, and selective restore result handshake;
- ticket refresh, missing/wrong admission values, wrong vault access, and hardening paths;
- operator destroy, stable generation-scoped purge identity, R2 purge completion before SQL deletion, membership revocation, and stale-ticket rejection.

This driver uses Node Yjs clients and local Wrangler. It does not launch Obsidian and does not traverse public Cloudflare routing.

## What is not yet proven

The following remain deferred and must not be represented as passing evidence:

### Large-vault benchmark rerun

Prior sharding/recovery benchmark evidence exists. The integrated identity, provisioning, and generation-fencing changes have not been put through another production-scale bootstrap, memory, recovery, R2-cost, or purge benchmark; that repeat is deliberately deferred.

### Soak and fault-duration rerun

Prior long-run Worker soak evidence exists. The integrated build has not repeated prolonged eviction, alarm retry, R2 outage, pin-expiry, GC interruption, or deletion-retry scenarios.

### Deployed Cloudflare boundary

Local Wrangler does not prove production WebSocket upgrade routing, Durable Object placement/eviction, alarms under platform scheduling, R2 list/delete consistency, deployment migration behavior, or operator retry behavior against an actual Cloudflare account.

### Obsidian and mobile restore

No current integration run proves recovery-v2 replacement through a real desktop or mobile Obsidian vault, local backup creation on those adapters, sleep/wake continuation, background suspension, or large attachment restoration.

### Fresh cutover rehearsal

The supported boundary is a fresh schema-4 deployment and fresh schema-4 client cache. A complete user-facing rehearsal from a populated schema-3 installation through preserved local files, new claim, origin import, and joining-device bootstrap remains external validation; no in-place schema-3 migration is claimed.

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
