# Operational resource UX

YAOS exposes one read-only operational resource snapshot derived from body
residency accounting, residency admission, and overdue-work diagnostics. The
snapshot contains plain scalar values only. It cannot admit work, evict a body,
close a socket, settle a queue item, or retain a body/path identity.

## What it reports

- current and high-water body residency estimates;
- the configured body-estimate budget and separately reported temporary work;
- admission and overdue-work queue counts by priority;
- the oldest queued age across both schedulers;
- active, dirty, durably pending, leased, decision, and permanent blockers;
- used, reserved, fixed, planned-release, and configured body socket counts;
- current pressure, after revalidating the exact rejected demand against the
  current resource snapshot;
- the last observed pressure after current pressure clears.

The estimate claim is always
`heuristic-resident-estimate-not-heap-measurement`. UI text says “heuristic
estimate, not RAM usage.” The configured byte limit bounds YAOS's versioned
body-cost model; it is not a percentage or measurement of device memory.

## Pressure ownership

`ResidencyAdmissionCoordinator` records the exact reason, time, priority, and
scalar demand whenever it rejects admission. It never exports the request ID or
body ID. Current pressure remains bound internally to that queued request and
clears when it is cancelled, coalesced into newer demand, or granted; last
pressure remains historical. The operational aggregate also treats overdue-work
decision and permanent blockers as current actionable pressure.
Pressure history is scoped to the current vault generation and local folder; it
does not carry across leave/re-enrollment or generation replacement.

Self-clearing concurrency and temporary-work limits remain visible in Advanced
settings and diagnostics but do not enter the status bar. Admission failures
whose request is cancelled remain historical `lastPressure`, not current
pressure. The status bar shows only actionable pressure that is still current,
such as a live estimate-budget overrun or blocked/decision-required overdue
work. Its tooltip supplies the corresponding action.

## Surfaces

- **Status bar:** connection state plus actionable current pressure only.
- **Advanced settings:** estimate/budget, queues, oldest age, blockers, sockets,
  current pressure, last pressure, and guidance.
- **Diagnostics export:** the same `operationalResources` plain-value snapshot,
  alongside the underlying residency, admission, and overdue-work snapshots.

Operational queue totals combine vault work with the recovery and settings
adapters. The raw `overdueWork` diagnostics field remains the vault scheduler's
detail view; `operationalResources` is the bounded cross-adapter aggregate.

The source of truth remains the domain diagnostics. Product UX never changes a
limit or retries work merely because it rendered this snapshot.
