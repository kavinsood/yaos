# YAOS Autophagy Plan

## Behavior freeze

No new product semantics, scenario families, witness phases, or snapshot phases
during this cleanup unless required to preserve moved behavior.

## Cleanup objectives

1. Move policy out of orchestration.
2. Make path identity canonical.
3. Invert flight recorder dependency.
4. Fence QA-only surfaces.
5. Shrink main.ts and ReconciliationController.
6. Delete obsolete scaffolding.

## Not in scope

- Level 4 durable ack
- Snapshot redesign phases 2-6
- New iPad validation runs
- Frontmatter sidecar
- Empty-folder feature
- Giant-vault bootstrap
- UI polish

## Safety rule

Every behavior-moving PR must include characterization tests or reuse existing
regression coverage.

## Lint baseline

Full `npm run lint` currently fails with ~139 errors and ~12 warnings.
This is tracked as baseline debt, not as a blocker.

New and changed files must lint clean (`npm run lint:changed`).
Full baseline burn-down is separate work, not part of autophagy.

## PR sequence

1. Gates + this plan (no product code changes)
2. Deduplicate `mapWithConcurrency`
3. Extract path/rename admission policy
4. Canonical path identity (narrow wiring only)
5. TraceSink boundary (one module migrated off direct flight imports)
6. QA port fencing
7. Planner/executor split for ReconciliationController

## Completion criteria per PR

```
build must pass
regressions must pass
new/changed files must lint clean
no new product semantics introduced
```
