# Body coordination and safe text application

Status: implemented for RFC 04 and RFC 05, 6 September 2026.

## Problem

Body work previously crossed IndexedDB, the server, Yjs, editor views, and disk with several unrelated notions of currentness. A path could be reused while an old completion was pending, a body could be evicted while asynchronous work still referenced it, and an ordinary stale-base diff could fall through to destructive replacement.

The implementation makes currentness effect-specific and makes every resident or projected body resource explicitly leased.

## State model

`BodyCoordinator` owns orthogonal facts rather than one combinatorial state enum:

- document identity and content revision;
- lifecycle/path revision;
- projection ownership revision;
- residency: absent, loading, warm, active, or evicting;
- synchronization: clean, locally pending, durably pending, or catching up;
- divergence: none, evaluating, preserved, or decision required;
- lifetime: accepting, quiescing, or disposed;
- body leases and the current one-to-one path/body catalog projection.

The local runtime epoch is not reinvented here. Every `BodyRevisionToken` captures the shared `RuntimeScope` epoch. Server receipt `runtimeEpoch` remains separate server evidence.

## Proof policies

One scalar revision was deliberately rejected. Different completions require different proofs:

- content computation checks runtime, document identity, and content revision;
- lifecycle completion checks runtime and lifecycle revision;
- disk projection checks runtime, document identity/content, lifecycle/path identity, and ownership revision;
- candidate receipt accounting checks the exact candidate identity and digest, not whether later content exists.

`isContentCurrent`, `isLifecycleCurrent`, and `isProjectionCurrent` encode those policies. This prevents an editor lease change from invalidating unrelated content work while still preventing a disk write from crossing an ownership change.

## Catalog transitions

The coordinator accepts a complete root catalog snapshot through `replacePathBindings`. It computes the affected bodies and advances lifecycle revisions synchronously. The reverse body-to-path index means a rename removes the old path in the same transition. Reusing a path for a new body invalidates the old body's lifecycle proof before any later asynchronous work can publish.

`VaultSync` mirrors every root transaction into this catalog projection. Durable identity remains the body ID; path is only the current projection.

## Leases and ownership

Body leases adapt the shared runtime `Lease`. Acquiring one both prevents clean eviction and appears in bounded runtime-drain diagnostics. Release is idempotent.

Each editor consumer receives a distinct projection lease. Split panes therefore share one body document while retaining independent lifetimes. Disk and recovery projections are exclusive. Closed-body materialization acquires the disk projection, captures its proof, and rechecks it after every read/hash await and immediately before filesystem mutation.

## Safe text commit

`tryApplyDiffToYText` has exactly three outcomes:

- `unchanged`: the observed base and requested result are already equal;
- `applied`: the observed base is still current and a targeted Yjs diff reached the result;
- `superseded`: the live text no longer equals the observed base, so nothing is mutated.

Ordinary disk-to-body reconciliation and three-way merge commits use this primitive. A superseded operation is requeued or replanned. `forceReplaceYText` remains available only in named recovery paths whose authority and preservation decisions have already been made.

## Failure sequences

### Path reuse during disk write

1. Work captures body A at `note.md`.
2. Root replaces the path with body B.
3. The catalog snapshot advances A and B lifecycle revisions.
4. The pending write's projection proof fails.
5. No filesystem mutation occurs; current work replans for B.

### Remote update during a disk read

1. Disk write captures body content revision N.
2. Reading the existing file yields to the event loop.
3. A remote Yjs update advances the body to N+1.
4. The pre-mutation recheck fails.
5. The path is queued again from current body content.

### Close and reopen during body load

1. Editor consumer generation N starts a body load.
2. Close invalidates N.
3. Reopen starts generation N+2.
4. The old completion cannot obtain the editor projection lease.
5. Only N+2 pins the body and owns a provider consumer.

## Test matrix

Coverage includes delayed IndexedDB load, server replacement winning a load race, delete/path reuse, rename reverse-index cleanup, split editor leases, eviction under a lease, stale runtime epoch, independent proof axes, stale-base no-mutation, current-base targeted apply, and disk proof rechecks through existing DiskMirror regressions.

## Performance

Catalog synchronization is linear in active Markdown paths per root transaction. Body proof checks and lease operations are constant time. Safe apply retains the existing Myers-style character diff and adds one exact string comparison. No body snapshots are retained by the coordinator.

## Non-goals

- residency cost calibration and admission policy belong to RFC 08–09;
- semantic frontmatter ownership belongs to RFC 11;
- recovery remains explicitly destructive after backup/preservation;
- candidate receipt accounting is not converted into common ancestry.

## Definition of done

- all product body tokens share the runtime lifetime epoch;
- path reuse and rename atomically invalidate old lifecycle work;
- split views own independent idempotent leases;
- disk materialization is fenced by path, content, and ownership;
- ordinary stale-base work never force-replaces live Yjs text;
- recovery-only replacement remains named and observable.
