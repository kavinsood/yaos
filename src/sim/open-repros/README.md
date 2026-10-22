# Open sim repros

Minimized failing sim runs of bugs that are **not fixed yet**, kept so they survive outside `/tmp`. Unlike
`../regressions/`, nothing replays this directory automatically (`regressions.test.ts` reads only its own directory):
every file here still fails. Replay one with

    npm run sim:replay -- src/sim/open-repros/<file>.json        (add --full for the unminimized plan, where kept)

When a bug is fixed: confirm its replay passes, write the focused test of the mechanism, then move the file to
`../regressions/` under a descriptive name (see `../regressions/README.md`) and drop its BACKLOG item. A plan can
drift with sim timing changes: if a replay here starts passing without a fix, re-find the bug before deleting it.

Status as of integrate-3 (2026-10-22): none open. Add a row per plan:

| File | Reproduces | BACKLOG |
| --- | --- | --- |
