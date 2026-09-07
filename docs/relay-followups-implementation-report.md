# Relay follow-up implementation and deferral report

Date: 7 September 2026. Branch: `yaos3`.

## Status and claim boundary

The semantic-frontmatter, partial-settlement, application-liveness, recovery
continuation, settings continuation, and operational-resource UX program is
delivered. This report records the work deliberately left outside that program
so a deferral cannot be mistaken for an omitted implementation or a second
hidden authority.

The deferrals have two forms:

- **producer migration deferred** — the current feature works, but its timing
  is not yet owned by the shared overdue-work kernel;
- **field evidence deferred** — the correctness mechanism is delivered, but a
  product limit or cadence must not be retuned without representative runtime
  measurements.

None of the items below weakens durable candidate ownership, partial-settlement
proofs, socket failure fencing, or recovery/settings restart reconstruction.

## Deferral register

| Item | Class | Current safe state | Why deferred | Exit condition |
| --- | --- | --- | --- | --- |
| Rename batching scheduler migration | producer migration deferred | Rename batching remains functional under its existing debounce path. | The current path does not persist an exact pre-debounce batch intent. Moving only its timer would create scheduler-shaped work without restart-safe ownership. | A durable or provably reconstructible batch intent exists before debounce, carries exact path/body/generation fences, resumes after restart, and replaces the old timer in the same change. |
| Periodic repair audit scheduler migration | producer migration deferred | Existing event-driven reconciliation and explicit recovery paths remain authoritative. | The available periodic entry point mostly refreshes bookkeeping; it is not yet a bounded repair unit with a meaningful completion outcome. Scheduling it would add recurring work without proving that repair progresses. | A bounded audit planner identifies concrete repair units, records decision/permanent blockers, returns typed outcomes, resumes from durable or reconstructible truth, and has one retry owner. |
| Production resource calibration | field evidence deferred | The 48 MiB client budget is explicitly a versioned heuristic resident estimate, not RAM measurement; temporary work and sockets are reported separately. | Desktop, mobile, CLI, Worker, and Node evidence is not yet broad enough to justify changing coefficients or defaults. | Representative traces record estimator inputs, scratch high-water marks, fragmentation, blockers, admission latency, and safe-eviction outcomes for each supported runtime; any coefficient change ships under a new estimator version with before/after evidence. |
| Socket cadence and wake-cost tuning | field evidence deferred | Protocol 2 uses application-level READY/PING/PONG evidence, a 60-second idle interval, a 15-second response timeout, background suspension, and exact failure fencing. | Correctness is covered, but field evidence does not yet quantify mobile wake cost, battery/network impact, proxy idle behavior, or Worker/Node socket cost well enough to retune the cadence. | Representative foreground/background traces measure false failures, detection latency, wake frequency, reconnect amplification, and host cost; a cadence change preserves negotiated bounds and the existing exact-socket authority tests. |

## 1. Rename batching scheduler migration

This is a migration of retry and timing ownership, not a missing rename feature.
The unsafe shortcut would be to replace the current debounce callback with a
kernel timer while leaving the rename batch only in memory. A suspended or
terminated process could then lose the intent before the scheduler had durable
work to reconstruct.

The implementation order is:

1. Define the batch collision domain and exact key.
2. Persist or reconstruct the complete pre-debounce rename intent before any
   timer or poke is armed.
3. Bind every member to its body identity, source/target path, catalog
   generation, and supersession rules.
4. Make the worker re-read current durable truth and return a typed
   `OperationOutcome`.
5. Reconstruct pending batches at startup and after foreground/network events.
6. Remove the old rename timer and direct retry path in the same change.
7. Prove response loss, restart, source reuse, target collision, cancellation,
   and teardown leave exactly one owner and no lost rename.

Until those steps exist, the current bounded debounce is less misleading than
a partial scheduler migration.

## 2. Periodic repair audit scheduler migration

The overdue-work kernel should schedule concrete overdue work, not periodic
status refresh. Before migration, YAOS needs a planner which can enumerate a
bounded repair unit such as a specific catalog/body/disk inconsistency and can
say whether that unit completed, must retry, is superseded, requires a user
decision, or is permanently blocked.

The implementation order is:

1. Specify the audit scope, cursor, maximum work per pass, and authoritative
   read set.
2. Separate detection from repair effects and give each repair unit an exact
   identity and currentness fence.
3. Persist blockers and any work that cannot be reconstructed from authoritative
   catalog, disk-index, and pending-operation state.
4. Route the bounded worker through `OperationOutcome` and the shared queue.
5. Wake it from startup, foreground, connectivity, and relevant durable
   completions without introducing another retry timer.
6. Demonstrate actual repair progress plus bounded CPU/I/O on large vaults.

The existing event-driven reconciliation remains the product authority until a
periodic pass can meet that contract.

## 3. Production resource calibration

Operational resource UX now states exactly what it knows. The body budget is a
heuristic model, diagnostics distinguish resident estimates from scratch work,
and the status bar reports only actionable current pressure. Calibration must
improve those numbers without relabelling them as heap measurements.

Evidence collection should cover desktop Obsidian, mobile Obsidian, the CLI,
Cloudflare Workers, and the Node server. For each runtime, capture small, large,
and fragmented documents; cold and warm admission; provider/socket counts;
temporary reconstruction work; clean eviction; protected saturation; and long
sessions with repeated open/close transitions. Paths, note content, socket IDs,
and request IDs must remain absent from exported evidence.

Changing a coefficient or default requires:

- a named runtime and estimator version;
- the before/after data set and the pressure decision it changes;
- proof that dirty, leased, pending, or otherwise protected work is never made
  evictable by calibration;
- regression bounds for admission latency, false pressure, and safe eviction;
- updated product text if the meaning of a displayed estimate changes.

## 4. Socket cadence and wake-cost tuning

Application liveness is complete as a correctness mechanism. The deferred work
is choosing better operating values from field evidence. Raw WebSocket `OPEN`
must never become a substitute for READY/PONG authority, and a longer interval
must not silently remove the ability to fence a black-holed transport.

Measure at least:

- foreground quiet sockets across common proxies and network transitions;
- background/foreground cycles on desktop and mobile;
- ping wake frequency and battery/network cost;
- false READY or PONG timeouts under event-loop stalls;
- time to detect black-holed root and body sockets;
- isolated body re-admission success versus escalation to global recovery;
- Worker and Node request/socket cost under realistic vault concurrency.

Any tuning change must remain server-advertised, bounded by the protocol parser,
generation/runtime/document fenced, suspended while hidden, and covered by fake
clock tests for late READY, stale PONG, timer epoch changes, and teardown.

## Validation boundary

The delivered program currently passes all application, test, CLI, Node-server,
and Worker TypeScript targets; production build and changed-file lint; schema
and no-escape-hatch guards; and all 131 local regression suites. Those results
prove the implemented authorities and deterministic behavior. They do not
substitute for the production measurements required to close the two field
evidence deferrals.

## Recommended execution order

1. Instrument and collect resource and liveness field evidence without changing
   product defaults.
2. Specify a bounded repair planner; migrate periodic audit only after repair
   units and outcomes are real.
3. Add durable pre-debounce rename intent; migrate rename batching and delete
   its prior timer in one cutover.
4. Retune resource coefficients or socket cadence only when the evidence names
   a concrete problem and demonstrates the proposed improvement.

This order keeps measurement work observational and ensures both future
producer migrations preserve the single-owner rule established by RFC 10.
