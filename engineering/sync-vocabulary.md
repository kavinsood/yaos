# Sync vocabulary

Status: **Draft v0** (2026-05-09). Promoted to `Accepted v1` only after the
Phase 0.5 verification pass against code is complete.

This document defines the canonical internal names YAOS uses for sync
subsystems, states, authorities, and events. Code, tests, structured
diagnostics, reason codes, and engineering docs use these names verbatim.
User-facing UI may use plain language, but every status message and
diagnostic event must map back to one canonical subsystem and one reason
code.

This document does not forbid plain English in the product. It forbids
ambiguous internal state.

The sync contract (`sync-contract.md`) and invariants
(`sync-invariants.md`) reference these names.

## Subsystems

A subsystem is one independently observable plane of behavior. Subsystems
are split into two groups: user-visible sync planes (the things sync
products actually do), and control/guard systems (cross-cutting infra that
gates the planes).

### User-visible sync planes

| Name | Current owner | Target owner | Responsibility |
| --- | --- | --- | --- |
| `connection` | `runtime/connectionController.ts` | same | Reachability, auth, WebSocket lifecycle. |
| `text` | `sync/vaultSync.ts`, vault `Y.Doc` | same | CRDT sync of `.md` file text (body and frontmatter together — see contract Q1). |
| `editor` | `sync/editorBinding.ts`, `runtime/editorWorkspaceOrchestrator.ts` | same | Binding the active Obsidian editor to per-file `Y.Text`. |
| `diskImport` | `sync/diskMirror.ts`, `sync/diskIndex.ts`, `sync/externalEditPolicy.ts` | same | Importing filesystem changes made outside the live editor. |
| `attachments` | `sync/blobSync.ts`, `runtime/attachmentOrchestrator.ts` | same | R2-backed sync of non-text and oversized files. |
| `snapshots` | `sync/snapshotClient.ts`, `snapshots/snapshotService.ts` | same | Server-side backup capture and restore. |
| `settingsSync` | not yet implemented | TBD | `.obsidian/` sync. Reserved name only. |

### Control and guard systems

These are not sync planes. They have health state and they can block,
degrade, or pause sync planes, but they do not themselves sync user
content. Status surface should not present them as peer rows to `text`.

| Name | Current owner | Target owner | Responsibility |
| --- | --- | --- | --- |
| `safety` | `sync/frontmatterGuard.ts`, `sync/frontmatterQuarantine.ts` | same | Pausing propagation of suspect frontmatter or growth. |
| `capabilities` | `runtime/capabilityUpdateService.ts`, `sync/serverCapabilities.ts` | same | Server feature negotiation and version skew. |
| `observability` | `runtime/traceRuntimeController.ts`, `diagnostics/diagnosticsService.ts` | same | Trace persistence, structured events, debug bundle export. |

## State model

Each subsystem reports one **headline state** drawn from the set below,
plus a structured set of **facts** and a list of active **reason codes**.
The headline state is what a single status row renders. The facts and
reasons are what a debug summary or expanded view exposes.

### Headline states

| State | Meaning |
| --- | --- |
| `unknown` | Not yet evaluated this session. |
| `disabled` | Intentionally off (config, missing capability, user choice). |
| `connecting` | Initialization or reconnection in progress. |
| `live` | Operating normally. |
| `catchingUp` | Live, but currently applying a backlog. |
| `degraded` | Functioning with one or more named impairments. |
| `paused` | Halted by a safety rule; user action may be required. |
| `blocked` | Cannot proceed until an external precondition is fixed. |
| `error` | Internal failure not classifiable as one of the above. |

### Facts

Facts are typed key/value pairs specific to each subsystem. Facts capture
truths the headline state cannot — for example, `connection` has three
independent boolean facts (server reachable, auth accepted, WebSocket
open) that contribute to one headline state but must remain individually
observable. This resolves the apparent tension between `INV-AUTH-01`
(decomposed) and a single headline state.

Status type sketch:

```ts
type SubsystemStatus = {
  state: HeadlineState;
  reasons: ReasonCode[];
  facts: Record<string, boolean | number | string>;
  affectedPaths?: string[];
  since: string;
  lastOkAt?: string;
  nextAction?: UserAction;
};
```

Required facts per subsystem are defined in the invariants document.

## Overall state

The plugin reports a single top-level state derived from subsystem states:

| State | Trigger |
| --- | --- |
| `setupNeeded` | No server configured. |
| `connecting` | `connection` is `connecting`; nothing is `blocked`. |
| `live` | `connection` and `text` are `live`; nothing is `blocked`. |
| `catchingUp` | A user-visible sync plane is `catchingUp`. |
| `degraded` | `text` is `live` but at least one user-visible plane is `degraded`, non-default `disabled`, or `paused`. |
| `paused` | `text` is `paused` (whole-vault). Per-file pauses surface as `degraded`. |
| `blocked` | Any user-visible plane or `capabilities` is `blocked`. |

Required for `live`: `connection` and `text`. All other planes may be
`disabled` without preventing `live` overall. Control systems
(`capabilities`, `observability`, `safety`) are not required for `live`,
but `capabilities=blocked` blocks overall.

## Authority

For any byte of vault state, exactly one source is authoritative at a time.
Authorities are named:

- `editor` — the live Obsidian editor view, when bound.
- `disk` — the on-disk file as observed via the vault filesystem boundary.
- `crdt` — the current state of the vault `Y.Doc`.
- `remote` — server-applied updates not yet observed locally.
- `snapshot` — a restored historical state.

"Authority" is per-event, not per-file. Recovery cycles must choose
exactly one authority per affected `Y.Text` per cycle (`INV-EDIT-01`).
IndexedDB is not an authority; it is a local persistence cache for `crdt`.

## User-facing copy

Internal canonical names are not user-facing copy. The product UI may use
plain English ("Offline", "Catching up", "Sync paused") provided the
mapping is explicit:

```text
Every user-facing status message must declare the canonical subsystem and
reason code it represents in its source location. Translation to plain
language happens at the rendering layer, not in the engine.
```

Example mapping:

```ts
{
  subsystem: "connection",
  state: "blocked",
  reason: "connection.auth_rejected",
  copy: "Sign-in to your YAOS server was rejected. Reconnect this device."
}
```

## Events

Event names are dotted, lowercase: `<subsystem>.<verb>_<object>`. The
subsystem prefix must be one of the names in this document. Reason codes
share the same namespace prefix. Full event taxonomy and reason-code
registry live in `sync-invariants.md`.
