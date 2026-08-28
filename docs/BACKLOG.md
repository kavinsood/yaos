# Main backlog

This file contains only unresolved risks that remain after the schema-4 multivault, root/body, SQL-bootstrap, and recovery-v2 integration. Completed schema-3 cutover, monolith replacement, snapshot-v1 replacement, candidate/receipt, provisioning, and purge-order work is removed rather than marked complete.

Current passing evidence is limited to focused suites, the complete regression discovery, and the local Wrangler Worker driver. See [QA](qa.md).

## Priority definitions

- **P0:** observed data loss, corruption, or availability incident.
- **P1:** a concrete correctness or release-confidence risk with an existing code, test, trace, or field evidence source.
- **External:** closure requires a deployed environment, real Obsidian runtime, mobile device, or reporter.

## P0 field risks

### ATTACH-01 — Base/Canvas rollback and Excalidraw save freeze

**State:** Unresolved field reports against the attachment plane. Schema 4 generation-scopes blob objects but does not itself prove these client-side behaviors fixed.

**Evidence:** Existing issue reports describe `.base` layout rollback, Canvas versions alternating after mobile restart, and sporadic Excalidraw save freezes while YAOS is enabled. Base, Canvas, and Excalidraw still use whole-file attachment sync.

**Required work:** Reproduce each shape independently against the current schema-4 deployment. Record root attachment metadata, object generation prefix, upload/download queue state, local hash, conflict decision, and lifecycle ordering. Profile Excalidraw save for synchronous hashing and watcher/queue churn. Do not convert structured formats to Markdown merging as a symptom fix.

**Closure:** Each reported shape has a focused reproduction and root-cause result; rollback/oscillation and freeze behavior no longer occur under that reproduction; the relevant reporter or equivalent real-device environment validates the result.

### SYNC-01 — burst-created Markdown can miss admission

**State:** An unresolved field report says one of several iOS Web Clipper-created Markdown files did not reach desktop until renamed. The schema-4 candidate path changes server durability but does not prove the client watcher/admission miss fixed.

**Evidence:** The report names burst creation and rename as the action that recovered synchronization. Current local Worker clients submit candidates directly and therefore do not exercise Obsidian watcher admission.

**Required work:** Reproduce a burst of iOS-created Markdown and trace watcher admission, dirty-set draining, body creation candidate, lifecycle receipt, root publication, and remote materialization.

**Closure:** Every admitted burst file reaches a durable candidate/root identity and a joining device without rename; the root cause has a focused regression and reporter-shaped validation.

## P1 implementation risks

### PATH-01 — one canonical path identity across root, disk, and attachment planes

**State:** Canonical path validation exists, but the repository still carries a separately tested collision detector and multiple path-normalization entry points.

**Evidence:** `src/paths/pathCollision.ts` detects NFC/NFD and separator collisions. `tests/client/path-collision.ts` exercises it, while root/body admission, Obsidian display paths, disk indexes, and attachment paths retain different call paths. Case folding remains deliberately undecided.

**Required work:** Establish one display-path versus identity-key invariant and apply it at initial import, create, rename, bootstrap settlement, disk index, reconciliation, and attachment admission. Wire collision detection at the chosen boundary or remove the unused primitive. Keep case sensitivity as a separate explicit product decision.

**Closure:** Canonically equivalent paths cannot create two root/catalog identities; collision behavior is deterministic on relevant filesystems; no unused competing normalization path remains.

### AUTH-01 — explicit credential-carrier coverage in diagnostics

**State:** Safe exports redact common identity and credential fields, but schema 4 adds provisioning, recovery capability, purge, and multi-socket error surfaces.

**Evidence:** Current diagnostics tests cover the established safe shape. Production now carries device bearers, pairing/setup links, socket tickets, operator sessions, recovery job capabilities, and purge capabilities across additional routes and error paths.

**Required work:** Add exact leak fixtures for each credential carrier in URLs, headers, fatal frames, provisioning failures, recovery errors, and server traces. Keep local-only inspection and safe export types separate.

**Closure:** Safe exports and room traces reject every named carrier without depending on incidental free-form regex discovery.

### RECOVERY-01 — real client replacement proof

**State:** Policy, backup, parsing, job, route, and local Worker restore-handshake coverage pass. The local live suite intentionally acknowledges its selected item as `skipped-changed`; it does not apply a recovery point through a real Obsidian vault.

**Evidence:** `tests/client/recovery-backup.ts` covers backup/review hooks, `tests/client/recovery-snapshot-v2.ts` covers format validation, and `tests/live/snapshots.ts` covers asynchronous capture, bounded reads, item enumeration, and terminal result acknowledgement.

**Required work:** In a QA-enabled Obsidian instance, restore changed Markdown, a missing Markdown path, a deleted identity, and an attachment. Observe backup creation, disk recheck, durable body/lifecycle receipts, materialization, and second-pass convergence. Repeat the supported subset on real mobile.

**Closure:** Desktop replacement passes end to end without bypassing the actual adapter/runtime; changed targets skip; backups are readable; restored server and disk state agree. Mobile evidence remains separately labeled until run.

### SETTINGS-01 — real desktop settings apply evidence

**State:** Focused and local Worker settings coverage passes. One disposable Obsidian 1.13.7 run also proves note sync remains online beside settings sync, exact identity/capability, explicit seed, command-driven remote CSS apply, and consented Calendar 1.5.10 installation.

**Evidence:** `tests/live/settings-sync.ts` proves two-device HTTP/SQLite revisions, auth, generation fencing, non-hydration, and post-settings root/body health. `qa/controllers/settings-sync-smoke.mjs` passed against a real desktop configuration directory; its generated artifact is retained under ignored `qa-runs/settings-sync-desktop/obsidian-1.13.7.json`. A second runtime observation also held `envRev` and the Calendar plugin-data revision exactly stable for 12 seconds after restart, closing an observed repeated plugin-data upload loop with `shouldPutMissingRemotePluginData`.

**Required work:** Extend desktop evidence across two freshly enrolled Obsidian folders with the same configuration-folder key. Exercise LWW create/update/delete, invalid JSON quarantine, crash/restart queue resume, explicit auto-install consent, plugin/theme intents and tombstones, exact plugin-data version holding, and a named clash while confirming note sync continues.

**Closure:** Retained desktop artifacts show no remote apply before an explicit user decision and durable exact-identity queue, queue checkpoints survive restart, successful seed/take/replace commits acceptance, allowlisted files converge without widening scope, packages come from Obsidian/GitHub rather than YAOS storage, and held/quarantined state remains intact. Mobile coverage closes only under `MOBILE-01`.

## P1 deployment and scale evidence

### DEPLOY-01 — fresh schema-4 Cloudflare cutover rehearsal

**State:** Local Wrangler proves fresh claim/provision/enrollment. No external run currently proves the documented schema-3-to-fresh-schema-4 user boundary.

**Evidence:** The implementation deliberately admits only schema `4` and protocol `1`, provisions new SQL format `1`, and stores clients in a schema-4 IndexedDB namespace. [Operations](operations.md#deployment-boundary) explicitly rejects in-place schema-3 room/cache reuse.

**Required work:** Preserve a populated schema-3 vault on a trusted device, deploy a fresh current Worker with the `RecoveryJob` migration, claim, import through the origin path, enroll a joining device with a fresh cache, and verify the complete inventory and device isolation. Also verify advertised settings format 1, generation-fenced device-auth settings routes, and that a new vault generation starts with an unseeded settings environment.

**Closure:** A recorded external rehearsal matches the documented boundary, including failure behavior when the job binding/migration is absent and when settings capability/version is incompatible. It does not claim an in-place migration.

### DEPLOY-02 — production Cloudflare recovery and purge

**State:** Local Worker recovery-v2 and purge-first deletion pass. Production routing, alarm scheduling, R2 behavior, and Durable Object eviction remain unexecuted.

**Evidence:** `tests/live/snapshots.ts` and `tests/live/operator-destroy.ts` cover local asynchronous recovery, stable purge identity, purge-before-SQL ordering, and post-destroy rejection. Wrangler is not the production platform.

**Required work:** Against a disposable deployed Worker, exercise capture across runtime eviction, selective restore, recovery retry, GC interruption, vault destroy, and destroy retry. Retain bounded status/error evidence and exact deployment commit.

**Closure:** The deployed run reaches the same durable terminal states and never deletes SQL before the exact generation prefixes are empty.

### SCALE-01 — integrated large-vault benchmark and soak rerun

**State:** Earlier Worker benchmarks and long-run soaks established sharding, snapshot, and performance ceilings. Repeating those campaigns after identity/provisioning integration is deliberately deferred.

**Evidence:** Current focused and local Worker tests prove the integrated bounds and race behavior, including a 1,505-file import inventory and a 200-body/100-rename bootstrap race. They do not replace the earlier scale evidence or claim a fresh integrated performance measurement.

**Required work:** At the later validation milestone, repeat only the scale and duration cases affected by the integrated identity, generation, provisioning, recovery, and purge seams. Preserve the prior results as historical evidence instead of presenting them as absent.

**Closure:** Integrated results state platform, dataset shape, limits, duration, and failure criteria; benchmark samples and soak evidence remain distinct.

### MOBILE-01 — schema-4 mobile lifecycle and settings evidence

**State:** No current integration result covers real iOS or Android schema-4 bootstrap, reconnect, attachment, recovery, or settings apply behavior.

**Evidence:** Current schema-4 evidence uses unit ports, desktop/controller history from the earlier architecture, and Node clients under local Wrangler. Settings policy/queue tests do not invoke mobile Obsidian or its package installer.

**Required work:** Run fresh joining bootstrap, foreground edit, suspend/resume reconnect, attachment conflict, and supported recovery flows on real iOS and Android without copying credentials or caches. For settings, take an already-seeded named environment, verify no apply before an explicit decision and durable exact-identity queue, apply allowlisted files, exercise foreground auto-install consent and a desktop-only plugin skip, resume a checkpointed consented install after backgrounding, verify acceptance commits after successful take, verify the three-version plugin-data hold, and apply plugin/theme tombstones without interrupting note sync.

**Closure:** Device-scoped bundles show root/body convergence, no stale candidate or generation crossing, correct recovery outcomes, and exact settings queue/acceptance identity. Mobile install/apply results distinguish iOS from Android, preserve held data, and never claim a package installed from passive server agreement.

## External dependencies

| Item | External requirement |
|---|---|
| ATTACH-01 | Reporter-shaped plugin environment and preferably reporter validation |
| SETTINGS-01 | Real desktop Obsidian configuration directory and installer APIs |
| SYNC-01 | Reporter-shaped iOS Web Clipper environment |
| RECOVERY-01 | Real Obsidian desktop and mobile adapters |
| DEPLOY-01/02 | Disposable Cloudflare account and deployment |
| SCALE-01 | Declared large dataset and long-running environment |
| MOBILE-01 | Real iOS and Android devices |

External dependency does not excuse reachable work: build the focused reproduction or runbook first and record exactly which final observation remains external.

## Unscheduled features

Docker packaging is not current behavior or a backlog commitment without a separately evidenced product requirement.

Generic feature expansion, awareness relays, configurable cursor colors, and native Windows support are not backlog items unless an observed problem establishes an owner and closure contract.
