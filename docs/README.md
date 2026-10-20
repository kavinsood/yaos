# YAOS documentation

Documentation of the current product: the Obsidian plugin in `src/` and the Cloudflare relay in `server/`. YAOS
syncs one person's vaults across that person's devices. Git history keeps replaced designs (the schema-8 server,
the old client, RFCs and audits); they are not parallel specifications.

The repository-root [README](../README.md) is the public product guide. Workstation notes belong under ignored
`notes/`.

## Start here

- [Architecture](architecture.md): the client layers (core, engine, host, protocol, ports), the relay, storage,
  E2EE and how the tests are organized. Links to the normative documents.
- [Sync and conflict contract](sync-contract.md): the user-facing guarantees and their known limits.
- [Operations](operations.md): deploying, claiming, the operator console, R2, limits, updates and the
  fresh-deployment boundary.
- [Backlog](BACKLOG.md): the open work.
- [Collaboration](collaboration.md): why there is none, what exists instead, and what it would need.
- [Canonical Markdown](canonical-markdown.md): the `markdown-lf-v1` text representation and its hash domains.

## Client (`docs/client-remake/`)

- [DESIGN](client-remake/DESIGN.md): the plugin's normative design: protocol, fold, sync engine, reconciler,
  host and simulation.
- [e2ee-design](client-remake/e2ee-design.md): crypto suite 1 (single-user end-to-end encryption).
- [relay-wire](client-remake/relay-wire.md): the wire contract between the client and the relay.
- [integration-notes](client-remake/integration-notes.md): how the work packages were put together, the bugs found
  and fixed, deviations from DESIGN, honest gaps, simulation results and the manual test plan.
- [legacy-parity](client-remake/legacy-parity.md): every feature of the deleted old client mapped to its new home
  or to the reason it was dropped.
- [timer-audit](client-remake/timer-audit.md): every timer and time rule, traced to what it protects.
- Work-package notes, historical records of each package as delivered:
  [WP-A](client-remake/wp-a-notes.md) (fold, codecs, paths, sim log), [WP-B](client-remake/wp-b-notes.md)
  (planner, merge, disk side), [WP-C](client-remake/wp-c-notes.md) (log-side engine),
  [WP-D](client-remake/wp-d-notes.md) (host, carriers, worker, sim runner; its "Gaps and known issues" is kept
  current).
- [spike-reports](client-remake/spike-reports/): device spike results.

## Server (`docs/server-rewrite/`)

- [DECISIONS](server-rewrite/DECISIONS.md): the server rewrite's design: scope, route table, decisions, hardening,
  storage schema, acceptance matrix and open items.
