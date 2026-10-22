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
| `gated-edit-renamed-and-edited-unobserved.json` | suite-1 wipe/revoke/roll seed 112 (base): a canvas record B deleted while key-missing is back in the doc after B's file was renamed and edited again unobserved. Not data loss: B's text survives in the renamed file, a new doc | SIM-S1-HELD-EDIT-UNOBSERVED-RENAME |
