# Shared overdue-work kernel

`OverdueWorkKernel` centralizes the scheduling mechanics shared by reconnect,
body wake/catch-up, candidate submission, transfer retry, recovery, settings,
and periodic reconciliation. It does not centralize their domain policy.

The kernel's governing rule is:

> Durable or reconstructible intent is truth. Time and events only cause that
> truth to be read again.

The implementation lives in `src/runtime/overdueWorkKernel.ts`. Its regression
suite is `tests/client/overdue-work-kernel.ts`.

## What the kernel owns

The kernel owns only generic scheduling behavior:

- explicit-key single-flight;
- one non-reentrant drain at a time;
- item-count and elapsed-time drain bounds;
- timer/yield scheduling;
- priority ordering with age-based promotion;
- retry attempt, retry-after, exponential backoff, and bounded jitter;
- lifecycle fencing after `stop()`;
- queue diagnostics.

The producer still owns the meaning and persistence of an intent. The worker
still owns protocol decisions and classifies its result as an
`OperationOutcome`. A migration must not hide domain state inside a closure or
make the kernel timer the only record that work exists.

## Durable intent

Each `DurableWorkIntent` has:

- `key`: stable single-flight and coalescing identity;
- `revision`: opaque compare-and-swap token;
- `priority`: `background`, `normal`, or `interactive`;
- `dueAt`: preferred not-before/debounce time;
- `maxWaitAt`: optional hard deadline against perpetual debounce;
- `attempt`: durable/reconstructible retry count;
- `owner`: `producer` or `kernel`;
- `blocker`: an explicit decision/permanent blocker, when present;
- `metadata`: domain-specific immutable work description or lookup identity.

The effective ready time is `min(dueAt, maxWaitAt)`. On repeated producer
upserts, the adapter keeps the earliest existing `maxWaitAt` while replacing
the preferred `dueAt`. This allows ordinary debounce without allowing a busy
input stream to defer work forever.

An upsert is keyed, not append-only. If an upsert races with kernel-owned work,
it may revise the intent but must preserve `owner: "kernel"`. That rule lets
new input supersede stale work without letting the old producer restart an
independent retry timer. The old worker's completion loses its revision CAS;
the next drain reads the newer intent.

## Store choices

### Durable adapter

Use a database-backed `OverdueWorkStore` when retry due time, attempt, blocker,
or ownership must survive process loss exactly. Every transition must be one
atomic conditional mutation against the supplied `revision`:

1. `upsert` inserts or coalesces by key;
2. `claimForKernel` changes producer ownership to kernel ownership;
3. `settle`, `scheduleRetry`, `markBlocked`, and `handoff` succeed only if the
   claimed revision is still current;
4. a lost CAS returns `false`, because newer durable intent is not an error.

`scheduleRetry` must commit `attempt` and `dueAt` before it resolves. Only then
may the kernel arm a timer. `handoff` must remove the kernel queue record or
atomically transfer it to a domain owner that `list()` will not return.

### Reconstructible adapter

`ReconstructibleOverdueWorkStore` is the production in-memory adapter for work
already represented by another durable domain model. Seed it at runtime
startup by scanning that model and constructing explicit intents:

```ts
const store = new ReconstructibleOverdueWorkStore(
	pendingBodies.map((body) => ({
		key: `body-wake:${body.id}`,
		revision: `startup:${body.intentRevision}`,
		priority: body.isOpen ? "interactive" : "background",
		dueAt: Date.now(),
		attempt: 0,
		owner: "producer",
		metadata: { bodyId: body.id },
	})),
);
```

It provides CAS revisions, keyed upsert/coalescing, ownership, retry, blocking,
settlement, and handoff. It is appropriate only when losing its in-memory
retry timestamp cannot lose the underlying work: startup reconstruction must
make that work due again. If the exact retry deadline is correctness-relevant
or server-directed throttling must survive restart, use a durable adapter.

Do not periodically replace a live store from a scan. Reconstruct once before
admission, then use keyed upserts for newly observed durable changes.

## Pokes and drains

Call `poke(reason)` for:

- visibility returning to foreground;
- browser/network online signals;
- relevant new local or remote input;
- completion that may have unblocked another key;
- periodic repair coverage;
- timer expiry.

`poke()` contains no work payload. It sets one coalesced pending bit and starts
a drain only when no drain is active. A timer callback calls `poke("timer")`;
it never invokes a captured operation. Therefore background timer suspension
cannot invalidate correctness: foreground/online/input pokes re-read the same
pending truth.

A drain lists current intent, sorts ready unblocked items, and examines at
most `maxItemsPerDrain`. It also yields after `maxDrainMs` once it has admitted
at least one item. Remaining ready work is continued through a zero-delay
timer, not recursive drain calls. Pokes arriving during a drain coalesce into
one yielded follow-up.

`whenIdle()` waits for the active drain and any yielded follow-up already due
at the current clock time. It deliberately does not wait for future retry or
debounce timers, so shutdown and tests cannot hang behind a long deadline.

## Priority and fairness

Base ranks are background `0`, normal `1`, and interactive `2`. Every complete
`agingIntervalMs` overdue promotes work by one rank, capped at interactive.
Ordering then uses:

1. highest effective rank;
2. oldest effective ready time;
3. lexical key as a deterministic final tie-break.

This makes a cold editor open win initially while guaranteeing that sustained
interactive traffic cannot starve old background catch-up forever. Priority
is latency policy, never permission to discard lower-priority intent.

## Retry and outcome mapping

Workers return the shared `OperationOutcome` vocabulary from
`operationLifecycle.ts`:

| Outcome | Store transition | Automatic retry |
| --- | --- | --- |
| `completed` | conditional settle | no |
| `cancelled` | conditional settle | no |
| `superseded` | conditional settle | no |
| `durably_pending` | durable handoff/release | no |
| `retryable_failure` | persist next attempt and due time | yes |
| `decision_required` | persist blocker | no |
| `permanently_blocked` | persist blocker | no |

The worker, not the kernel, decides whether a failure is retryable. For a
retryable failure, the default delay is exponential in the current attempt,
capped at `retryMaxMs`, with symmetric jitter bounded by
`retryJitterRatio`. `retryAfterMs` is an authoritative minimum even when it is
greater than the local cap. Injected randomness makes the rule deterministic
in tests.

`retryPolicies` can override base, cap, and jitter by `FailureClass`. This is
how a reconnect migration can make `rate_limited` slower than `network`
without teaching the generic kernel about HTTP, sockets, or credentials.
Unauthorized, revoked, incompatible, malformed, and persistence failures must
still be classified by the worker into the correct terminal, blocked, or
retryable outcome; the kernel never guesses from a failure name.

If the worker throws, the kernel reports through `onError` and treats it as a
retryable `internal` failure. Store/list failures are also reported and cause
a delayed re-read; the durable/reconstructible intent remains the authority.

## Ownership and handoff

Producer and kernel ownership are mutually exclusive durable states:

1. the producer persists or reconstructs intent as `producer`;
2. `claimForKernel` atomically changes the current revision to `kernel`;
3. the producer stops owning correctness-critical timer/retry behavior;
4. new input may revise the record but cannot retake ownership;
5. the kernel conditionally settles, retries, blocks, or hands off;
6. `durably_pending` means another subsystem now guarantees continuation, so
   the adapter removes/transfers the kernel record and no retry is armed.

A migration is incomplete if the old producer timer remains capable of retry
after step 2. Poking the kernel from that old callback is acceptable during a
transition; directly executing the old operation is not.

## Cancellation and quiesce

`stop()` is synchronous:

- refuses later pokes;
- clears the current timer;
- rotates the internal generation fence;
- prevents late worker completion from settling or scheduling retry.

Already running I/O is not forcibly aborted because not every consumer exposes
an abort primitive. Its claimed intent remains available for startup recovery
or durable lease repair. Consumers may separately pass an `AbortSignal` in
metadata/domain context, but publication safety must still rely on the epoch
and revision fences.

## Diagnostics

`getDiagnostics()` reports:

- stopped/draining/poke-pending runtime state;
- last poke reason and next wake time;
- each key's queue age, base/effective priority, blocker, attempt, owner,
  configured due/max-wait/effective-ready times, and in-flight state.

Metadata is intentionally absent from generic diagnostics. Domain adapters
must expose only redacted identifiers and safe failure context separately.

## Vault work adapter

`VaultWorkScheduler` in `src/sync/vaultWorkScheduler.ts` is the product adapter
for the first staged consumers. It fixes their collision domains as follows:

| Domain work | Key | Default priority | Completion owner |
| --- | --- | --- | --- |
| reconnect | `reconnect` | interactive | reconnect callback |
| body wake | `body-wake:<bodyId>` | normal/caller-selected | body callback |
| candidate flush | `candidate:<bodyId>` | normal | candidate callback |
| attachment retry | `attachment-publication` | background | attachment intent subsystem |

Callbacks return `OperationOutcome` unchanged. They must not arm their own
correctness-critical retry timer after the scheduler claims an item.
`durably_pending` from attachment retry releases the scheduler record because
the attachment intent subsystem has durable continuation ownership; it does
not mean “try this scheduler item again later.”

Candidate queueing uses preferred debounce plus a hard max-wait. Body wake
queueing remembers the greatest requested minimum generation and priority so
an older producer signal cannot regress or demote a newer wake while its
callback is in flight.
All producer upserts preserve kernel ownership. Consequently, new reconnect,
body, or candidate input revises the record; a stale callback loses CAS and a
zero-delay follow-up drain observes the replacement.

The adapter accepts a complete `OverdueWorkClock`, not a separate `now`
function paired with real browser timers. Scheduling, diagnostics, retry due
times, and tests therefore share one time domain. Production defaults to
`Date.now()` and window timers. Tests inject both clock and random source.

`initialIntents` seeds work reconstructed from durable domain state and causes
an automatic startup poke. `stop()` synchronously stops kernel admission and
later queue methods reject; late callback outcomes cannot settle or retry.
`onError` is an observation boundary and must not throw.

`VaultSync` now routes reconnect/ticket refresh, candidate debounce/retry,
loaded-body durable-generation wake, and attachment publication retry through
this adapter. Their old candidate, ticket/retry, and controller debounce timers
were removed in the same slices. Manual reconnect and first attachment publish
remain direct foreground attempts; only their continuation/retry ownership is
kernel-owned. Schema-5 candidate records and attachment operations remain the
durable truth and reconstruct scheduler intent during startup.

The adapter's retry attempt/due time is reconstructible rather than durable.
A restart immediately reconstructs still-pending candidate and attachment
work, but does not retain the exact prior backoff deadline. Use a database-backed
store when exact throttling state must survive restart. Recovery, settings,
periodic reconciliation, and rename batching have not been migrated.

Focused integration coverage uses a single fake clock to prove candidate
startup reconstruction and retry, loaded-body wake through residency admission,
and proactive ticket-driven reconnect. The attachment publication replay suite
proves scheduler-owned startup reconstruction/retry while retaining exact
operation identity, causal ordering, CAS, and root-persistence settlement.

## Migration recipe

Migrate one producer at a time:

1. Choose the exact explicit key and document its collision domain.
2. Identify durable pending truth or prove startup reconstruction.
3. Implement the adapter and atomic revision/ownership transitions.
4. Express the operation result as `OperationOutcome`.
5. Upsert intent before poking; never pass intent only in the poke.
6. Route old timers, visibility, online, input, and completions to `poke()`.
7. Remove the producer's direct retry execution in the same change.
8. Add diagnostics and deterministic sleep/resume, race, stop, and retry tests.
9. Only then migrate the next producer.

Recommended order remains reconnect, body wake/catch-up, candidate submission,
attachment transfer retry, recovery jobs, settings synchronization, and
periodic reconciliation pokes. Attachment publication intent/CAS remains its
own domain protocol; the kernel may own transfer retry but must not replace it.

## Common mistakes

- Capturing work in a timer closure instead of storing an intent.
- Treating a poke as an enqueue and losing work when pokes coalesce.
- Using a path or body ID as a key without the required incarnation/epoch.
- Resetting `maxWaitAt` on every debounce upsert.
- Letting producer upsert change a kernel-owned record back to producer.
- Publishing a stale completion without a revision CAS.
- Applying jitter before the exponential cap or below `retryAfterMs`.
- Auto-retrying `decision_required` and creating a hot loop.
- Waiting for future timers in `whenIdle()` and hanging shutdown.
- Migrating several queues before any one adapter's ownership law is proven.

## Verified invariants

The deterministic suite covers empty-store pokes, simultaneous pokes,
single-flight, bounded yielding, initial priority, aging, stable ties,
due/max-wait coalescing, retry-after, capped jitter, persistence-before-timer,
timer re-read, mid-drain pokes, stop fencing, durable handoff, full diagnostics,
decision blockers, ownership retention, and reconstructible-store CAS.
