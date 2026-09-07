# Relay RFCs 08–10 implementation report

Date: 6 September 2026. Branch: `yaos3`.

## Status and claim boundary

RFCs 08–10 now have their ordered client foundations, deterministic model
tests, and live product integrations. Remaining work is chiefly field
calibration and operational presentation rather than missing authorities.
This report deliberately distinguishes two states:

- **delivered** — implemented and covered by focused deterministic tests;
- **deferred evidence** — requires production runtime measurements or a later
  explicitly scoped producer migration, not a second competing authority.

The dependency order was:

```text
RFC 01–07 body identity, leases, epochs, and outcomes
                         │
                         ▼
RFC 08 measured observations and scratch evidence
                         │
                         ▼
RFC 09 reservation policy and admission execution
                         │
                         ▼
RFC 10 shared overdue-work mechanics and staged producer adapters
```

That order mattered. Admission can reserve only costs which have a declared
meaning, and a generic scheduler can safely migrate work only after the work's
domain owner, cancellation fence, and completion outcome are explicit.

## Delivered program

### RFC 08 — measured residency accounting

The client now has a versioned `yaos-body-residency-v1` estimator. It keeps
exact observations separate from heuristic costs instead of relabelling an
encoded Yjs update as heap usage. Per-body evidence includes encoded state,
UTF-16 and UTF-8 text size, Yjs struct/deleted-struct/client-bucket counts,
pending Yjs updates, reported transport buffers, and reported provider, socket,
and awareness counts.

`BodyManager` remeasures loaded bodies, tracks load/cache/eviction distributions,
reports explicit eviction blockers, and exposes defensive scalar snapshots.
Load, persistence, server reconstruction, server replacement, merge, and
recovery paths can publish idempotent temporary reservations. A cold-load
preflight estimates decoded residency and reconstruction scratch from stored
encoded bytes without performing a second decode.

The historical 48 MiB client limit now has an exact claim: it bounds the sum
of loaded-body resident estimates. Temporary reservations and shared root or
catalog resources are reported separately and are not silently included in
that limit. This is an honest compatibility boundary, not a claim that 48 MiB
is calibrated for every runtime.

The diagnostics schema accepts an optional residency snapshot. `VaultSync` now
supplies live body, provider, socket, awareness, root/catalog, and pending-buffer
signals to the product telemetry adapter. Hosts without that adapter still
export `null`, meaning instrumentation is unavailable rather than measured cost
is zero.

### RFC 09 — residency admission policy

`ResidencyAdmissionCoordinator` is a pure resource arbiter. It distinguishes
active, warm, loading, and cold bodies; protects active, dirty, durably pending,
and leased state; reserves load, resident, transient, and socket capacity; and
plans clean warm LRU evictions independently from clean warm socket closures.

The queue gives editor work initial preference while promoting one sufficiently
old background request after a bounded preferred burst. Mobile background
state pauses optional admission and proposes only clean, durable, unleased
trimming. Backpressure names the exhausted resource instead of evicting
protected work.

`ResidencyAdmissionRuntime` is the first effect adapter. It refreshes observed
state, asks the pure coordinator for one decision, executes planned eviction or
socket preparation before the admitted operation, and releases reservations
exactly once. Compatible same-body callers share one reservation without losing
waiters, and mobile-paused requests remain queued for a foreground poke.

`VaultSync` now constructs the coordinator/runtime, reports live observations,
routes editor, foreground, background, recovery, and catch-up body loads through
admission, fences planned eviction with body revisions, performs warm/mobile
maintenance, and exposes both RFC 08 and RFC 09 snapshots. Obsidian supplies
platform/visibility facts and the CLI declares desktop foreground operation.
An integrated 100-transition editor stress test proves bounded warm residency,
socket counts, reservations, provider lifetime, and complete teardown.

### RFC 10 — shared overdue-work kernel

`OverdueWorkKernel` and `ReconstructibleOverdueWorkStore` implement the shared
scheduling mechanics without absorbing domain policy. Durable or reconstructible
intent remains truth; timers and external events only poke a bounded,
non-reentrant drain which rereads that truth.

The kernel provides explicit-key single-flight, revision-CAS ownership,
priority aging, due and maximum-wait times, bounded drain yielding, typed
`OperationOutcome` settlement, retry-after-aware exponential backoff with
bounded jitter, quiesce fencing, and scalar queue diagnostics.

`VaultWorkScheduler` is the product-shaped adapter. It defines stable
keys and typed metadata for reconnect, body wake, candidate debounce, and
attachment-publication retry. It accepts an injected clock/random source and
startup-reconstructed intents, preserves the greatest requested body
generation, and retains kernel ownership across retryable failures.

All four staged consumers are migrated. Candidate debounce/max-wait and ticket
retry timers are removed; `ConnectionController` no longer owns a fast-reconnect
debounce timer; loaded-body durable-generation catch-up enters residency
admission through a scheduled body wake; and attachment startup/retry is
scheduler-owned while its first foreground publication attempt remains direct.
Pending schema-6 candidates and attachment operations reconstruct scheduler
intent before normal startup admission. Manual reconnect likewise remains an
immediate user action, but any continuation is scheduler-owned.

Recovery and settings continuation now use dedicated reconstructible adapters.
Recovery capture and restore are keyed by immutable server operation identity
and reconstruct from folder-scoped pending recovery state. Settings uses
separate reconcile and exact-apply keys derived from the durable apply-queue
scope; startup and foreground reconstruct from the IndexedDB queue, local
config, and server environment. The old recovery monitor and production
settings interval/watcher ownership are removed. Periodic repair audit and
rename batching remain unmigrated.

## Existing server machinery to reuse

The Worker/Node server already has mature resource and scheduling primitives.
Client RFC classes should not be copied into the server merely to make names
match.

### `VaultDocumentCache`

The server cache already enforces:

- a loaded-body count and aggregate encoded-state budget;
- clean-body LRU eviction;
- protection for dirty, open-socket, pending, and recovery-pinned bodies;
- exact pending-byte caps per document, socket, and vault;
- an aggregate transient pool with idempotent reservations;
- pre-reconstruction rejection when durable encoded history alone is too large;
- diagnostics for loaded documents, costs, limits, pending bytes, and load
  failures.

Candidate metadata reconstruction reserves durable history plus candidate
update bytes before allocation. Pending socket updates enter the same transient
total and release after durability. These are mature server-local laws and
should remain in `VaultDocumentCache`; the browser residency coordinator is
not a replacement for them.

The audit renamed the server surface from `residentBytes` to
`encodedStateBytes` and added the machine-readable claim
`encoded-yjs-state-proxy-not-heap-measurement`. It is a useful representation
bound but does not satisfy the full RFC 08 evidence model. Server coefficients
must be calibrated independently from desktop/mobile/CLI coefficients.

### `VaultSocketService`

The socket service already owns server-side root/body socket counts, hibernated
socket attachments, authority fencing by vault generation/runtime epoch/device,
body-active admission, pending-frame byte backpressure, and open-body protection
for cache eviction. Root and body sockets have independent hard counts, and
loaded documents can outlive their sockets.

That machinery is the correct server connection authority. RFC 09's client
socket planner should not be installed beside it. The useful alignment is
shared diagnostic language and explicit pressure responses, not shared mutable
state or a cross-runtime singleton.

### Drain and overdue work

The Worker uses Durable Object alarms and `waitUntil`; the Node host has a
SQLite-backed `DurableAlarmScheduler` with durable deadlines, pre-dispatch
leases, revision fencing, stale-completion protection, bounded retry, and
operator-visible quarantine after repeated abandoned dispatches. Recovery jobs
are already durable state machines with explicit next-attempt and watchdog
state.

These are stronger host-specific primitives than an in-memory browser store.
Do not replace them with `OverdueWorkKernel`. Reuse their durability and align
outcome/diagnostic vocabulary only where that reduces operational ambiguity.

## Build-order acceptance audit

### RFC 08

| Acceptance criterion | Status | Evidence or remaining work |
| --- | --- | --- |
| Every byte budget states what it measures | **Delivered** | Client snapshots name loaded heuristic scope and exclusions. Server diagnostics now name encoded Yjs state and explicitly deny a heap-measurement claim. |
| Scratch admission happens before reconstruction where feasible | **Delivered on client; partial on server** | Cold loads and warm catch-up/reconstruction reserve before allocation. Some server validation scratch documents remain outside transient admission and are listed as follow-up instrumentation. |
| Large and fragmented bodies have distinct evidence | **Delivered on client** | Text, encoding, struct, deleted-struct, and fragmentation distributions are separate. Equivalent Worker/Node evidence remains deferred. |
| Diagnostics explain failed safe eviction | **Delivered on client** | Blockers and observations are wired into product diagnostics. Server diagnostics do not yet count blocked eviction reasons. |
| Limits cite measurements and runtime scope | **Scope delivered; calibration deferred** | Runtime scope is explicit. The 48 MiB value remains historical pending desktop, mobile, CLI, Worker, and Node measurements. |

### RFC 09

| Acceptance criterion | Status | Evidence or remaining work |
| --- | --- | --- |
| Cold editor opens have bounded priority under catch-up | **Delivered** | Editor-first selection and bounded background promotion are deterministic, and editor/background loads share the live runtime. |
| Background work progresses during sustained interaction | **Delivered** | Preferred-burst fairness is covered without timers and background load callers carry background priority. |
| Dirty/pinned saturation preserves work and reports backpressure | **Delivered** | Protected state is never planned for eviction, typed reasons are logged and exported, no unsafe fallback exists, and actionable current pressure reaches the status bar while full blocker/current/last detail remains in Advanced settings. |
| Rapid switching leaks no consumers, providers, or leases | **Delivered** | Cancellation is deterministic and a live 100-transition `VaultSync` test proves bounded providers, sockets, reservations, warm bodies, and exact teardown. |
| Loaded-body and socket limits differ safely | **Delivered** | Independent arithmetic, provider observations, socket-only idle-session closure, and live pressure integration are covered. |

### RFC 10

| Acceptance criterion | Status | Evidence or remaining work |
| --- | --- | --- |
| Suspended timers cannot strand durable work | **Delivered for migrated consumers** | Timer callbacks only poke and reread intent. Pending candidates, attachment operations, recovery jobs, and exact settings apply reconstruct at startup; reconnect, body wake, and settings reconcile are reconstructible from live domain state. |
| Retry vocabulary is shared without sharing domain policy | **Delivered** | Workers return `OperationOutcome`; the kernel never infers protocol semantics from exceptions or HTTP status. |
| Diagnostics expose age, priority, blocker, attempt, and owner | **Delivered** | Scalar diagnostics omit metadata and are exported through the telemetry runtime host and diagnostics bundle. |
| Migrated producers retain no independent critical retry timer | **Delivered** | Reconnect, body wake, candidate submission, attachment publication continuation, recovery continuation, and settings reconciliation/apply continuation are scheduler-owned; the replaced debounce/retry, recovery monitor, and settings production interval/watcher paths were removed. |

## Observations

### Measurement, admission, and scheduling are three authorities

RFC 08 observes real state and estimates cost. RFC 09 prevents concurrent work
from spending the same capacity. RFC 10 decides when durable intent should ask
for resources again. Combining them would either make telemetry mutate policy,
make a queue invent resource facts, or count one scratch allocation twice.

### Server and client parity is conceptual, not numerical

Both runtimes need LRU, protected work, scratch headroom, and explicit
backpressure. They do not share a heap, event model, socket owner, or useful
coefficient set. The server's synchronous cache admission and host alarms are
already appropriate; client policy should learn their invariants without
replacing their implementation.

### A reservation is useful only before the expensive step

Post-decode measurement remains the final hard guard, but it cannot prevent a
burst of simultaneous decodes. RFC 09 reservations must be acquired before
Yjs reconstruction, provider creation, or socket admission, and must remain
owned until observations are updated atomically.

### Coalescing work also means preserving every waiter

The pure coordinator correctly merges repeated requests for one body. An
effect adapter cannot then store only one resolver per request ID: replacing
that resolver strands the earlier caller. The runtime now groups compatible
same-body waiters under the covering reservation and queues incompatible
resource requirements for a later grant.

### “Timers are pokes” requires startup truth

An in-memory retry timestamp is safe to lose only when another durable model
can reconstruct the underlying work and make it due again. Server-directed
retry-after or correctness-relevant deadlines require a database-backed
adapter. Merely moving a callback into the kernel does not make its intent
durable.

### The topological order prevented a second lifetime system

RFC 09 consumes RFC 02 epochs, RFC 04 leases/revisions, and RFC 08 costs. RFC 10
consumes `OperationOutcome` and domain intent. No new generic “task lifecycle”
was needed, and server drain/alarm ownership remains separate.

## Pitfalls encountered

- The initial RFC 08 implementation used `Array.prototype.at`, which is outside
  the production TypeScript target, and stringified `Y.Text` through a linted
  object path. Targeted tests passed, but the production build and ESLint found
  both; the implementation now uses target-compatible indexing and `toJSON()`.
- Temporary RFC 08 reservations and RFC 09 admission reservations describe
  different views of the same allocation. Adding both to one “used bytes” total
  would double-count scratch; one is telemetry, the other excludes concurrent
  admission.
- Resource signals are owner-reported. A provider/session owner which does not
  clear its signal produces a believable but permanently inflated estimate;
  missing ownership reports produce an explicit caveat rather than fake zero
  confidence.
- The first `ResidencyAdmissionRuntime` shape kept one pending resolver per
  coalesced request ID and treated mobile pause like terminal pressure. Grouped
  waiters and foreground-resumable queued work were added before product wiring.
- Runtime stop must fence active preparation/execution as well as reject queued
  work. The shared runtime epoch remains the publication authority; admission
  reservation release alone is not cancellation proof.
- A first `VaultWorkScheduler` shape assumed browser timers. Clock injection is
  required for the CLI and deterministic tests, and startup intent injection is
  required before a reconstructible adapter can claim resume safety.
- The first candidate worker treated a resolved submission call as settlement,
  but the domain helper intentionally swallowed transport failures while leaving
  durable candidates pending. The worker now rereads durable candidate truth and
  returns `retryable_failure` whenever work remains.
- Scheduler timestamps initially used the injected clock while `VaultSync.now()`
  used wall time. One logical deadline could therefore span two time domains in
  deterministic tests. `VaultSync.now()` now prefers the scheduler clock.
- `whenIdle()` initially returned before an immediately due yielded continuation.
  It now waits for active drains and zero-delay follow-ups, but deliberately not
  for future debounce/backoff timers.
- Attachment startup replay is part of local-readiness ordering, not ordinary
  background convenience. Reconstructed publication intent is installed and
  drained before `_localReady`, preserving schema-6 causal settlement.
- Carrying reconnect maximum-wait across separately triggered ticket-refresh
  cycles can make a newer cycle inherit an obsolete deadline. Reconnect keeps
  debounce/due ownership without preserving that stale maximum-wait boundary.
- The server previously exposed encoded-state proxy bytes as `residentBytes`.
  The audit renamed that contract, its limit, and its pressure reason, and added
  an explicit non-heap claim while leaving the mature cache law intact.
- Server body socket admission now maps typed count, encoded-state, and
  transient cache pressure to a minimal `429` response with the exact reason
  and a bounded retry hint. Unknown reconstruction or storage failures are
  rethrown unchanged and retain the generic internal-error path.
- Disabling Worker-specific Access was not sufficient while the account-wide
  **Block traffic to all domains in this account** setting remained enabled.
  The resulting `403`/`1050` happened before Worker invocation even though the
  Worker reported `cloudflare_app_enabled: false`. Deployed validation began
  only after the account Default-Deny setting was removed; the live runner now
  requires an explicit disposable-deployment acknowledgement before performing
  its destructive end-to-end sequence.
- Several server validation and durable-update paths allocate temporary Yjs
  documents outside `recordTransient`. Instrument those gaps before changing
  server limits; do not assume the candidate reconstruction reservation covers
  later admission probes.

## Validation performed

Delivered focused coverage includes:

- RFC 08 exact-versus-estimated components, compact versus fragmented history,
  temporary reservation lifetime, reported external/shared resources, cache
  hit/join/cold-load metrics, eviction blockers, and diagnostics serialization;
- RFC 09 population truth, editor priority, bounded background promotion,
  concurrent-load and transient exclusion, oversized preflight, protected
  saturation, clean LRU eviction, independent socket closure, mobile pause and
  trim, idempotent settlement, same-body request coalescing, cancellation, and
  warm maintenance;
- RFC 10 durable-truth rereads, poke coalescing, key single-flight, bounded
  drains, priority aging, stable ties, debounce maximum wait, retry-after,
  capped jitter, persistence-before-timer, stop fencing, ownership handoff,
  decision blockers, reconstructible CAS, and product-adapter routing;
- existing server cache coverage for count/byte LRU, protected refusal,
  pre-reconstruction rejection, transient reservations, pending-byte release,
  and explicit default limits;
- existing server/Node coverage for socket authority epochs, revocation, drain
  admission, durable alarm leases, stale completion, bounded retry, and
  quarantine.

Eleven focused RFC/cache/product suites currently pass, including the kernel,
product adapter, real `VaultSync` scheduler integration, attachment replay,
fatal-auth, socket-admission, residency, candidate reconciliation, diagnostics,
and teardown suites. The full regression run passes all 125 discovered suites;
production, test, QA, CLI, Worker, and server-Node TypeScript checks and builds
pass, as do full ESLint, `git diff --check`, Node runtime, CLI smoke/pack smoke,
and the complete Worker/Node conformance matrix. Worker version
`0721a1e7-b259-4d6f-b972-d349b7b30048` was deployed to
`kavin-individual-account` and passed the complete live HTTP/WebSocket suite on
Cloudflare: claim and two-device enrollment, membership revocation, schema and
protocol fencing, root/body replication, attachment lifecycle, cold bootstrap,
recovery capture and selective restore, oversized-frame hardening, rapid ticket
refresh/reconnect, root/body admission, settings isolation, generation-scoped
destroy, and clean reprovisioning. The suite completed with exit code zero and
left a fresh vault generation after proving the old generation was purged and
fenced.

## Deferred evidence and product follow-ups

> **Lifecycle fault injection:** deterministic stop/cancellation tests and live
> rapid switching are complete. Real Obsidian fault injection during decode,
> provider admission, and revision-fenced eviction remains valuable field
> evidence, especially on mobile filesystem bridges.

> **Device pressure evidence:** editor/background priority, protected saturation,
> independent socket closure, mobile pause/trim, stale planning, and 100 rapid
> transitions are covered in deterministic and `VaultSync` tests. Repeat them
> on real iOS and Android lifecycle boundaries before retuning limits.

> **Server scratch completeness:** client cold and warm reconstructions now pass
> admission. Instrument the remaining server validation scratch documents before
> changing Worker/Node limits; do not import client coefficients.

> **Operational UX delivered:** Advanced settings and diagnostics now expose a
> read-only aggregate of residency, admission, and overdue work: configured and
> current heuristic body estimates, queue counts and oldest age, blockers,
> sockets, and current/last pressure. The status bar shows only actionable
> unresolved pressure. Every estimate explicitly denies RAM measurement; no
> fake device-memory percentage is displayed.

## Recommendations

### 1. Extend RFC 09 evidence onto real mobile hosts

Reconnect/body-wake scheduling now shares measured load and socket backpressure.
Repeat the passing deterministic pressure and 100-transition tests on iOS and
Android sleep/background/foreground boundaries before retuning defaults.

### 2. Calibrate before changing production limits

Collect the declared RFC 08 fixtures on desktop Obsidian, iOS, Android, CLI,
Worker, and Node. Record quiet/warm/evicted deltas separately and keep platform
coefficients versioned. The current 48 MiB value is a scoped historical guard,
not empirical permission to tighten or expand residency.

### 3. Improve the server meter in place

Keep `VaultDocumentCache` and `VaultSocketService`. Known admission pressure now
maps to bounded 429 responses. Add a server-specific estimator version,
struct/fragmentation and scratch observations, high-water marks, and blocker
counts. Do not import client coefficients or the browser coordinator.

### 4. Add host fault injection at the integrated boundary

The 100-transition runtime stress is now covered. Add real-host pauses during
decode, provider admission, eviction preparation, and background suspension;
assert zero orphaned waiters, leases, providers, sockets, reservations, and
timer ownership after settlement and teardown.

### 5. Preserve scheduler ownership evidence per producer

Keep each migrated producer's key collision domain, durable truth, startup scan,
removed timer, outcome mapping, and diagnostic surface documented and tested.
Recovery and settings now satisfy that ownership checklist. Apply it before
considering periodic repair audit or rename batching; neither is migrated
merely because the shared kernel exists.

### 6. Application-level socket liveness follow-up

This follow-up is delivered by socket protocol 2. Exact per-socket
`VAULT_PING`/`VAULT_PONG` acknowledgements now distinguish an application-live
connection from a browser socket which merely reports `OPEN`. Hidden Obsidian
runtimes suspend deadlines, foreground runtimes revalidate, and a fenced
transport adapter permits immediate replacement without accepting late events
from an abandoned native socket. Quiet Yjs documents remain healthy.

## Remaining Relay horizon

RFCs 08–10 establish truthful resource evidence, deterministic admission law,
and resume-aware scheduling mechanics. Their remaining work is field
calibration and selective migration of later producers—not another abstraction.
The next Relay-derived architectural work is RFC 11 semantic frontmatter and
partial settlement; transport multiplexing remains measurement-gated and comes
after admission, retry ownership, and liveness are proven in production.
