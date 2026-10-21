# Open sim repros

Minimized failing sim runs of bugs that are **not fixed yet**, kept so they survive outside `/tmp`. Unlike
`../regressions/`, nothing replays this directory automatically (`regressions.test.ts` reads only its own directory):
every file here still fails. Replay one with

    npm run sim:replay -- src/sim/open-repros/<file>.json        (add --full for the unminimized plan, where kept)

When a bug is fixed: confirm its replay passes, write the focused test of the mechanism, then move the file to
`../regressions/` under a descriptive name (see `../regressions/README.md`) and drop its BACKLOG item. A plan can
drift with sim timing changes: if a replay here starts passing without a fix, re-find the bug before deleting it.

Status as of integrate-3 (2026-10-21): every file below still fails. "base": also fails on `client-remake-next`
6a1fb3e5, before the reclaim / generators / governance merges (only plans whose steps that build knows).

| File | Reproduces | BACKLOG |
| --- | --- | --- |
| `s1-197-clean.json` | suite 1: key roll, revoke, an outside (disk) edit on B, a second revoke, B's IndexedDB and mirrors wiped before it rekeys: the disk edit `[B.16]` is lost (tokens + destroyed). The cleanest of the three seed-197 plans; base | SIM-S1-REKEY-WIPE |
| `s1-197.json` | the same seed with the hostile device's wrongKind / deflateBomb steps in the plan (same loss) | SIM-S1-REKEY-WIPE |
| `s1-197-nohostile.json` | the same seed, another minimization (same loss) | SIM-S1-REKEY-WIPE |
| `1482901505-47-min.json` | hostile device, suite 1, attachment clean-ups and revokes, 5 devices: token `[D.54]` typed on D is lost. Likely the same as SIM-S1-REKEY-WIPE | SIM-S1-REKEY-WIPE |
| `20701862-41-min.json` | canvas: a folder rename (`cRename folder`) after a user's dangling-edge fix revives the edges A deleted (no concurrent edit, no conflict copy); base | SIM-CANVAS-FOLDER-REVIVE |
| `1370759151-13-min.json` | blob faults, 2 devices, delete / restore races: no convergence, A's disk keeps a stale `notes/r5.md` while its body replica and the relay have the newer text | SIM-BLOB-STALE-DISK |
| `relay-134.json` | targeted relay faults, seed 134: epoch reset, then a commit crash (after) and offline: token `[A.36]` typed on A is lost. Possibly the same as suite 1 "4 devices, E2EE faults" seed 1 (epoch reset + commit crash); base | SIM-EPOCH-COMMIT-CRASH |
| `532933571-114.json` | identity-per-store clone faults, 4 devices: no quiescence, D waits on the creator of a body-less doc that never sends its body; base | SIM-CLONE-BODYLESS-WAIT |
| `s1-e2ee4-seed1.json` | `npm run test:sim-suite1` "4 devices, E2EE faults" seed 1: token `[C.52]` typed on C is lost; base | SIM-EPOCH-COMMIT-CRASH |
| `prune-epoch-merged-overwrite.json` | small tombstone cap (soak): an import storm, an epoch reset, mass overwrites, no file deleted (every pruned entry is a merged alias): A's overwrite of 10 notes is lost. Passes without `smallPrune` | PRUNE-STORM |
| `prune-storm-mass-delete.json` | small tombstone cap (soak): mass deletes and import storms: imported notes on B lost. Passes without `smallPrune` | PRUNE-STORM |
| `e2ee-log-busy-89423454.json` | E2EE faults, 5 devices, suite 1 (soak): A's log never idles, devices on different epochs, wide divergence; fails the same on `generators` | SIM-E2EE-LOG-BUSY |
| `canvas-reorder-lost-1025898366.json` | E2EE faults, 2 devices, suite 1, races (soak): B's reorder of a node to the front is lost; fails the same on `generators` | SIM-CANVAS-REORDER |
| `flood-flapping-1557069770.json` | FLOOD_FAULTS, 5 devices, storms, races, clean-ups (soak): no quiescence, "flapping". Unminimized (256 steps; a replay takes ~5 min); fails the same on `generators` | SIM-FLOOD-FLAP |
