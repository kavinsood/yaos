# RFC 09 implementation: residency admission, wake priority, and connection budgets

## Status

The pure policy kernel is implemented in
`src/runtime/residencyAdmissionCoordinator.ts`; the effect dispatcher is in
`src/runtime/residencyAdmissionRuntime.ts`. `BodyManager` supplies measured and
pre-decode estimates, while `VaultSync` owns live observations, admission,
revision-fenced eviction, and body-session closure. The plugin host propagates
mobile visibility, the CLI declares desktop foreground context, and telemetry
exports only plain scalar snapshots. Deterministic policy, dispatcher, and
VaultSync integration coverage live in the corresponding residency-admission
test suites.

## Problem

Eviction by itself does not provide resource control. Several cold bodies can
all inspect the same free capacity and begin decoding concurrently. Each load
may allocate a persisted update, a temporary `Y.Doc`, materialized text, merge
scratch, awareness, and a provider before any one load appears in the resident
body count. A count-only cache can consequently remain under its nominal body
limit while exceeding memory or socket limits.

The policy must also reconcile two latency requirements:

- opening an editor must not wait behind an unbounded catch-up queue;
- background catch-up must still progress while a user edits continuously.

One numeric priority cannot guarantee both. Unbounded aging can place a large
old background backlog ahead of a new editor. Strict editor priority can starve
background work forever.

## Invariants

1. Every known body is observed as exactly one of `active`, `warm`, `loading`,
   or `cold`.
2. `active`, dirty, durably pending, and leased bodies are never selected for
   eviction or optional socket closure.
3. A load reserves its load slot, predicted resident cost, and transient cost
   before decode or reconstruction begins.
4. Reconstruction of an already warm body reserves transient cost without
   consuming another load slot.
5. A socket admission reserves socket capacity independently of body residency.
6. Every reservation has one stable ID and late or duplicate settlement is a
   no-op.
7. At most `maxPreferredBurst` editor/foreground grants may pass an aged
   background request. The promoted background grant resets the burst.
8. A newly queued editor can be delayed by at most one promoted background
   grant once the current grants finish.
9. Mobile background state pauses optional admission and trims only clean,
   durable, unleased warm state.
10. Backpressure preserves protected work and names the exhausted resource.
11. Policy snapshots contain only scalar measurements and body IDs; they do
    not retain documents, providers, editors, or leases.

## Populations

`active` means a live consumer or projection owner currently requires the
body. It is never an eviction candidate.

`warm` means the body remains decoded for reuse but has no active owner. A warm
body is eligible only when it is clean, has no durable candidate awaiting
settlement, and holds no lease.

`loading` means decode/reconstruction has begun and the caller has not settled
its admission reservation. Loading cost and transient scratch remain visible
until completion or cancellation.

`cold` means no decoded body, provider, socket, or transient allocation is
retained. The coordinator may observe known catalog bodies as cold for truthful
population diagnostics, but it does not require every catalog ID to be loaded
into the policy map.

The coordinator validates these claims. A cold observation with resident,
transient, or socket resources is rejected. Transient cost is valid only for a
loading observation.

## Request and reservation lifecycle

An admission request declares:

- body ID;
- `editor`, `foreground`, or `background` priority;
- whether it needs a body load;
- whether it needs a socket;
- predicted resident and transient costs;
- final `active` or `warm` population;
- whether it is essential during mobile background;
- request time.

Queued requests for one body coalesce under the first request ID. Coalescing
keeps the earliest request time, upgrades to the highest priority, unions load
and socket needs, retains the larger cost reservations, upgrades the final
population to active, and preserves essential-background intent. This prevents
rapid view changes from building duplicate cold-load work while retaining one
causal identity for cancellation and diagnostics.

`decideNext(now)` either returns idle, a named backpressure result, or a grant.
A grant atomically removes the request from the queue and records a reservation
containing:

- load slot count;
- predicted resident and transient cost;
- socket slot count;
- clean warm bodies which must be evicted first;
- clean warm body providers which must be closed first.

The caller executes that plan and invokes `settle`. Successful settlement may
include the final body observation. Cancellation releases every reservation;
`requeue: true` restores the same request identity. Duplicate and late
settlement cannot release a later reservation.

The caller must not publish a loaded document or provider before all planned
evictions and closures succeed. If an observed body changed after planning,
the caller cancels the reservation, re-observes current state, and asks for a
new decision. RFC 04 revision tokens provide the effect fence for that step.

## Resource arithmetic

Resident capacity is computed from observed non-cold bodies, active
reservations, and the resident costs of bodies already reserved for eviction.
Two grants cannot spend the same eviction candidate because reserved eviction
IDs are removed from subsequent candidate sets.

Transient capacity includes observed loading scratch and every active
transient reservation, including warm-body reconstruction that needs no load
slot. This bound is checked before resident eviction planning because
evicting a warm body cannot create decode scratch capacity if the configured
transient pool is already full.

Load concurrency counts observed loading bodies and reserved load slots. The
integration must avoid representing one operation in both places at once:
retain the admission reservation while work begins, then submit the final
observation and settle atomically. If intermediate loading observations are
needed for diagnostics, settle the admission reservation into that loading
observation before another scheduling decision.

Socket arithmetic counts body providers in `opening` or `open`, active socket
reservations, and `reservedSockets`. The reserved count represents the root
provider and any other fixed control-plane connections selected by the host.
It is part of the same total limit but cannot be reclaimed by body policy.

Snapshots show `used`, `reserved`, and `plannedRelease` separately. During a
grant it is valid for `used + reserved` to exceed the nominal limit when the
same grant has already reserved enough clean warm state for release. Displaying
the release separately prevents this transient state from looking like an
unexplained budget violation.

All byte and count inputs must be non-negative safe integers. Cost values are
RFC 08 heuristic estimates, not claims about exact JavaScript heap use.

## Eviction and socket selection

Resident eviction uses clean warm least-recently-used order. It selects enough
bodies to satisfy the hard predicted resident cost and moves toward the
configured warm-body target. The warm count is a cooling target rather than an
execution ban: a zero-warm configuration may admit finite background work and
evict its result immediately afterward. A dirty, durable, leased, or active
body is reported as a blocker and is never included in a grant.

Socket admission is planned after residency. An eviction implicitly releases
that body's socket. If more socket capacity is required, the coordinator
selects additional clean warm providers by least-recently-used order without
evicting their documents. This is the property which permits different loaded
body and socket limits.

If a warm socket is protected by dirty, durable, or leased state, socket
admission returns `socket_budget`; it does not silently close a connection
which may still be needed to converge protected work.

## Fair wake policy

Within each priority class, requests are ordered by request time and stable
sequence.

The ordinary order is editor, foreground, background. Once the oldest
background request has waited `backgroundPromotionMs` and
`maxPreferredBurst` non-background grants have run, that one background request
is promoted. Its grant resets the burst counter. The next editor is then first
again unless no editor exists.

This yields two explicit bounds:

- heavy catch-up cannot put its whole aged backlog in front of a cold editor;
- sustained interactive work grants one aged background item per configured
  preferred burst.

These are admission bounds, not wall-clock promises. Actual latency still
depends on the duration and cancellation behavior of already admitted work.
Long-running operations must keep RFC 02 epochs and RFC 04 leases so teardown
and body replacement remain safe.

## Mobile background policy

The runtime context is an explicit pair: desktop/mobile and
foreground/background. No user-agent detection exists in the policy module.

When mobile enters background:

1. optional queued requests remain queued and return `mobile_background`;
2. work marked essential may still be admitted within every ordinary limit;
3. maintenance proposes eviction of every clean, durable, unleased warm body;
4. clean warm sockets are proposed for closure even when their bodies remain;
5. active, dirty, durably pending, and leased bodies remain intact.

On foreground, the host pokes admission again. No timer grants work by itself.

Desktop/foreground maintenance evicts clean warm bodies whose measured
retention period expired and then enough additional LRU warm bodies to satisfy
the configured warm count. The retention and count are runtime tunables backed
by RFC 08 evidence, not protocol constants.

## Backpressure results

`mobile_background` means optional work is intentionally paused.

`concurrent_load_limit` means every load slot is observed or reserved.

`transient_cost_limit` means predicted scratch cannot fit before decode.

`resident_cost_limit` means this body alone exceeds the measured resident
budget, before considering any existing body.

`protected_residency_saturation` means the resident/warm target cannot be met
without evicting active or unsettled work.

`socket_budget` means no socket slot and no safely closable warm provider are
available.

RFC 10 may later map these results into its overdue-work outcomes. This module
does not retry, create timers, or own durable task intent.

## Live integration

### `BodyManager`

The read-only accounting and coordinator ports let `VaultSync` map each loaded
body into `ResidencyBodyObservation`:

- active from body coordinator residency/consumer ownership;
- warm from decoded unowned state;
- loading from the in-flight load table;
- dirty from body dirty or pending-local-update state;
- durably pending from unsettled candidates;
- lease count from the body coordinator;
- resident and transient cost from RFC 08 measurements;
- last-used time from the loaded body;
- socket state supplied by the runtime session owner.

Do not remove `BodyManager.ensureEstimatedCostCapacity`. The admission
coordinator uses a prediction to bound concurrency; the manager's post-decode
measurement remains the final hard guard when a prediction was low.

Before decoding persisted state, `estimateColdLoadForBody` reads the stored
encoded byte length and returns RFC 08's conservative prediction. The same
estimate reserves warm currentness reconstruction; the manager's actual
temporary reservation and post-decode hard guard remain authoritative when a
server response is larger than the persisted proxy.

RFC 08 temporary reservations remain telemetry for the real allocation. The
RFC 09 reservation is the admission claim which prevents concurrent work from
starting. Diagnostics must not add both values as though they were distinct
allocations when they describe the same scratch buffer.

### `VaultSync`

Each vault runtime owns one coordinator and dispatcher after measured limits
are available.
Root and catalog overhead remains in RFC 08 shared accounting; set
`reservedSockets` to the exact fixed-provider count.

Route these operations through admission:

- editor acquisition of a cold body: editor, load plus socket, final active;
- editor acquisition of a warm body: editor, socket only when absent, final
  active;
- bootstrap/catch-up cold load: background, load, usually no sustained socket,
  final warm;
- recovery or explicit user action: foreground unless an editor directly
  waits on it;
- body-provider reconnect: socket-only with the original request priority.

Execute `evictBodyIds` through `BodyManager.evict` under captured body revision
tokens. Execute `closeSocketBodyIds` by destroying only the corresponding body
session/provider and clearing RFC 08 external resource signals. A failed or
stale action cancels and replans; it never falls through to force eviction.

RFC 03 reconnect must enumerate the body providers which currently own an
admitted socket slot. Loaded warm bodies without a slot remain loaded and are
not reconnected. Root admission retains its fixed reserved slot.

On completion, update the body coordinator population, RFC 08 resource
signals, and the RFC 09 observation before settling the reservation. On view
closure or supersession, release editor ownership/leases first, then re-observe
the body as warm and request maintenance.

### Plugin and CLI hosts

The host converts visibility and platform facts into `setRuntimeContext`.
Mobile background calls `planMaintenance`, executes revision-safe clean trims,
then leaves optional requests queued. Foreground requests an admission drain.

Desktop and CLI use foreground policy unless their host explicitly enters a
background state. The CLI still benefits from load/scratch/socket bounds and
fairness; it should not pretend to be mobile based on terminal inactivity.

### RFC 10 scheduler

Until RFC 10 exists, callers may drain admission after explicit events:
request enqueue, reservation settlement, foreground, socket close, candidate
settlement, lease release, and successful eviction. Timers may poke this drain
but may not bypass `decideNext`.

RFC 10 should own durable due-work and retry timing. It should treat this
coordinator as a resource arbiter, not absorb the body observations or budget
arithmetic into a generic queue.

## Deterministic evidence

The focused model suite covers:

- truthful active/warm/loading/cold and resource snapshots;
- editor-first selection;
- background promotion after a bounded preferred burst;
- the one-promoted-item editor latency bound;
- concurrent load and transient reservation exclusion;
- pre-decode scratch rejection;
- clean warm LRU eviction under byte pressure;
- preservation and blocker diagnostics for dirty, durable, active, and leased
  saturation;
- independent provider closure under socket pressure;
- socket backpressure when the only provider is protected;
- mobile-background pause and clean trim;
- idempotent reservation settlement and stable requeue identity;
- same-body queue coalescing and priority upgrade;
- measured warm retention and count maintenance.

The suite is timer-free and uses injected request times and IDs. It therefore
tests the ordering and accounting model without browser scheduling noise.

## Deferred empirical choices

This RFC does not choose production byte limits, warm counts, retention times,
preferred bursts, or promotion times. Those values must come from RFC 08
desktop/mobile/CLI measurements and product latency targets.

Application-level dead-socket detection also remains separate. Browser
WebSockets do not expose ping/pong; RFC 03 documents the need for a server
liveness acknowledgement before an apparently open but black-holed connection
can be reclaimed confidently.
