# Reconciliation host boundaries

## Bounded admission

The shared filesystem worker admits at most 64 queued jobs and accounts for up to
32 MiB of explicitly retained payload across queued and active jobs. Text payloads
are charged conservatively as two bytes per JavaScript code unit. This is a retained
payload limit, not a claim that total process heap usage is capped at 32 MiB.
Admission refuses immediately with `ReconciliationBackpressureError`; there is no
unlimited waiting-to-enqueue list. Idle waiters are bounded too. Producers must not
interpret refusal as accepted input or completed projection.

Projection, remote-materialization and Markdown-admission producers each retain
bounded, coalesced identifiers and rediscover overflow from durable state. Structural
rename batches are limited to 64 moves and 16 MiB of conservatively accounted source
text. Refusal fences reconciliation, including subsequent review projections, rather
than allowing old path mappings to overwrite preserved source files. Oversized cyclic
batches remain unresolved; independent batches can be retried in smaller groups.

Rediscoverable projection work is coalesced by path. Unique already-observed input
must remain in its existing durable candidate/episode, or remain unaccepted in its
source with an actionable failure. Backpressure does not authorize dropping text.

## Deadlines and late completion

Each supervised host call has a 30-second default deadline. Active jobs also have a
30-second progress watchdog while not awaiting a supervised host call, so a stuck
local persistence promise cannot retain an unlimited producer backlog. The progress
watchdog is rearmed between host calls; it is not a 30-second limit on an entire
multi-file rename batch.

A deadline failure stops admission, rejects queued work and waiting callers, and
reports a paused state. The actual callback and any outstanding host call retain
their execution fence until they settle. A reset cannot reopen admission early.
After settlement, a deliberate runtime reset/recovery is required; a late success
does not automatically resume synchronization or establish a trusted baseline.

Obsidian's host API does not expose cancellation for `Vault.read` or `Vault.process`.
Its deadline bounds the time to report failure while the event loop is responsive;
it does not claim to interrupt an OS request or an event-loop-blocking host method.
The implementation never starts another writer by merely racing an unresolved
filesystem promise against a timer.

## Node replacement contract

The headless host provides checked atomic replacement, not cross-process
compare-and-swap. Exact source bytes and physical identity are validated before
publication, and temporary-file replacement prevents partial output publication.
An unrelated process can still change the file between validation and the rename
syscall. There is no global lock against arbitrary editors. Rename destination
vacancy checks likewise are not a portable atomic no-replace primitive.

Supervised Node filesystem helpers must terminate and have their exit confirmed
before a mutation slot is released after timeout. An interrupted publication is
uncertain and must be reconciled from actual disk state. This does not upgrade the
replacement contract to cross-process CAS.

## Snapshot ownership

Candidate update bytes and frame lists are privately copied before asynchronous
hashing. Epoch, text, baseline, authority, timestamps and pending counts are captured
in the same synchronous phase. The digest and stored update describe those same
owned bytes, not mutable caller buffers or a later Yjs document. Digest-stage
semantic-epoch source changes refuse installation and retain the original document.
The separate preexisting epoch-install capacity/database-await window is unchanged
and is not certified by these digest-boundary tests.

## Artifact obstruction

Unexpected occupants are not deleted or renamed on the user's behalf. Recovery
uses a persist-before-write replacement plan inside the existing conflict episode;
it retains the same bodyId episode and remaps version references only to preserved
managed output. Path collisions are bounded, and retries after process death reuse
the durable selected target. Completed recovery metadata is retired; conflict
history artifacts are retained according to the product's history policy.

Recovery relocates one unfinished part, not every historical sibling. Historical
backlinks remain unchanged; the review lists their current managed targets and the
untouched obstruction paths. Corruption of a completed artifact without retained
unfinished bytes requires restoration of its original content, not guessed history.

Verification for this hardening is separate from the earlier native component
freeze. See
`/Users/kavin/personal/obsidiansync/experiments/results/reconciliation-hardening-20261001/REPORT.md`.
