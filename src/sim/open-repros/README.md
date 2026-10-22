# Open sim repros

Minimized failing sim runs of bugs that are **not fixed yet**, kept so they survive outside `/tmp`. Unlike
`../regressions/`, nothing replays this directory automatically (`regressions.test.ts` reads only its own directory):
every file here still fails. Replay one with

    npm run sim:replay -- src/sim/open-repros/<file>.json        (add --full for the unminimized plan, where kept)

When a bug is fixed: confirm its replay passes, write the focused test of the mechanism, then move the file to
`../regressions/` under a descriptive name (see `../regressions/README.md`) and drop its BACKLOG item. A plan can
drift with sim timing changes: if a replay here starts passing without a fix, re-find the bug before deleting it.

Status as of integrate-3 (2026-10-22): every file below still fails. "base": also fails on `client-remake-next`
6a1fb3e5, before the reclaim / generators / governance merges (only plans whose steps that build knows).

| File | Reproduces | BACKLOG |
| --- | --- | --- |
| `bound-big-notes-past-resident-byte-budget.json` | soak 944223017 #218 (CONFLICT_FAULTS tuned big small-cap, 3 devices; also at ac7aff61, identical; 127 of 578 steps): B has two big notes (1.2 MB and 2.35 MB) open in editors with a tuned 264 KB byte budget. Bound replicas are pinned and never evicted (DESIGN §d.1), so invariant 6 (resident bytes up to the budget plus the largest doc) fails. Not data loss | SOAK-BOUND-RESIDENT-BYTES |
| `flood-retire-backlog-past-heal-horizon.json` | soak 979386157 #245 (FLOOD_FAULTS small-cap, 5 devices; also at ac7aff61, worse there; full 256-step plan, the soak's exact-detail minimization cannot shrink it): 1,400 to 2,400 dead streams per device are still to retire / drop when the 600 s heal horizon ends. Not data loss: with a 3,600 s horizon the same plan quiesces at 1,105 s with no violation | SOAK-FLOOD-RETIRE-BACKLOG |
| `gated-edit-renamed-and-edited-unobserved.json` | suite-1 wipe/revoke/roll seed 112 (base): a canvas record B deleted while key-missing is back in the doc after B's file was renamed and edited again unobserved. Not data loss: B's text survives in the renamed file, a new doc | SIM-S1-HELD-EDIT-UNOBSERVED-RENAME |
