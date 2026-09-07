# YAOS documentation

Current `main` has durable engineering documents for the schema-6 product and the Relay-derived text/lifetime program. Git history preserves replaced RFCs, audits, incident reports, and implementation notes; they are not parallel current specifications.

- [Architecture](architecture.md) — schema-6 root/body, semantic frontmatter, and revisioned attachment authority, provisioning, settings SQL authority, recovery, and deletion.
- [Sync and conflict contract](sync-contract.md) — current note, attachment, and named settings-environment contracts, including lifecycle and preservation rules.
- [Canonical Markdown](canonical-markdown.md) — the shared logical text representation, hash domains, and baseline cutover.
- [Operations](operations.md) — claim, device enrollment, settings setup, required bindings, recovery capability, and the breaking schema-6 deployment boundary.
- [QA](qa.md) — focused, regression, and local Worker coverage, with real-runtime and external evidence gaps stated separately.
- [Backlog](BACKLOG.md) — only evidenced unresolved product risks and concrete external validation gaps.
- [Runtime lifecycle and socket admission](runtime-lifecycle-and-admission.md) — publication epochs, bounded drain, and refresh-first socket ownership.
- [Application-level socket liveness](socket-liveness.md) — protocol-2 heartbeat evidence, background suspension, and force-abort recovery.
- [Body coordination and safe apply](body-coordination-and-safe-apply.md) — effect-specific proofs, catalog identity, editor/disk leases, and stale-safe text commit.
- [Common bases and three-way merge](common-base-and-three-way-merge.md) — CAS ancestry, bootstrap backfill, bounded diff3, preservation, and revision-fenced review.
- [RFC 01–07 implementation report](relay-rfcs-01-07-implementation-report.md) — delivered work, observations, pitfalls, validation, and next recommendations.
- [Body residency accounting](residency-accounting.md) — versioned resident-cost evidence, scratch reservations, blockers, diagnostics, and RFC 09 calibration handoff.
- [Residency admission policy](residency-admission-policy.md) — measured load/scratch/socket reservations, priority aging, clean warm eviction, mobile background behavior, and backpressure.
- [Overdue-work kernel](overdue-work-kernel.md) — durable-intent scheduling, single-flight keys, fairness, retry ownership, quiesce, and staged producer migration.
- [Operational resource UX](operational-resource-ux.md) — read-only heuristic budgets, queues, blockers, socket counts, and actionable pressure guidance.
- [RFC 08–10 implementation report](relay-rfcs-08-10-implementation-report.md) — integrated resource and scheduling work, server reuse, pitfalls, validation, and calibration recommendations.
- [Relay follow-up implementation and deferral report](relay-followups-implementation-report.md) — explicit rename/audit migration prerequisites, field-evidence gaps, exit criteria, and recommended execution order.
- [Obsidian host compatibility](obsidian-host-compatibility.md) — supported private-host seams, capability fallbacks, and reversible patching rules.
- [Public plugin API](public-api.md) — versioned immutable state projection, subscriptions, and reload fencing.

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
