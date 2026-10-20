# Sim regressions

Each `*.json` here is a minimized failing sim run, replayed by `regressions.test.ts` (part of `npm run test:client`)
with `runSim(config, minimizedPlan)`; the test asserts the replay has no violations.

## Promoting a failure

1. The soak (`npm run sim:soak`, nightly `.github/workflows/sim-soak.yml`) writes `sim-failures/<seed>-<n>.json`:
   `{ seed, config, violations, minimizedPlan, plan, gitSha, ... }`.
2. Reproduce it: `npm run sim:replay -- sim-failures/<file>.json` (add `--full` for the unminimized plan).
3. Fix the bug, confirm the replay passes, then copy the artifact here with a descriptive name
   (e.g. `relay-restart-lost-token.json`). You may drop `plan` to keep the file small.

Promote the **minimized plan**, not the seed. A seed only names a run through the plan generator, and that drifts
whenever the generator, fault weights, op weights or RNG fork order change: the same seed soon produces a different
run that no longer exercises the bug. A plan drifts much more slowly, but it drifts too: its actions resolve their
picks (which file, which view) against state at run time, and a change in timing (relay commit timing, engine
scheduling) changes that state. Then the replay passes **silently** without reaching the bug. So:

- The durable regression is a **focused test of the mechanism** (a unit or composed-engine test that fails without
  the fix and does not depend on a seed). Write one with every fix.
- The plan here is a second line: before committing it, check it fails with the fix reverted. When the sim changes
  (timing, actors, faults), re-check the plans here the same way and drop or re-minimize any that no longer fail
  without their fix (sim-pipeline's seed-23 plan stopped reaching its bug on client-remake-next's relay timing).
