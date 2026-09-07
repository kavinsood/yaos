# YAOS documentation

Current `main` has durable engineering documents for the schema-5 product and the Relay-derived text/lifetime program. Git history preserves replaced RFCs, audits, incident reports, and implementation notes; they are not parallel current specifications.

- [Architecture](architecture.md) — schema-5 root/body and revisioned attachment authority, provisioning, settings SQL authority, recovery, and deletion.
- [Sync and conflict contract](sync-contract.md) — current note, attachment, and named settings-environment contracts, including lifecycle and preservation rules.
- [Canonical Markdown](canonical-markdown.md) — the shared logical text representation, hash domains, and baseline cutover.
- [Operations](operations.md) — claim, device enrollment, settings setup, required bindings, recovery capability, and the breaking schema-5 deployment boundary.
- [QA](qa.md) — focused, regression, and local Worker coverage, with real-runtime and external evidence gaps stated separately.
- [Backlog](BACKLOG.md) — only evidenced unresolved product risks and concrete external validation gaps.
- [Runtime lifecycle and socket admission](runtime-lifecycle-and-admission.md) — publication epochs, bounded drain, refresh-first socket ownership, and the remaining browser liveness limit.
- [Body coordination and safe apply](body-coordination-and-safe-apply.md) — effect-specific proofs, catalog identity, editor/disk leases, and stale-safe text commit.
- [Common bases and three-way merge](common-base-and-three-way-merge.md) — CAS ancestry, bootstrap backfill, bounded diff3, preservation, and revision-fenced review.
- [RFC 01–07 implementation report](relay-rfcs-01-07-implementation-report.md) — delivered work, observations, pitfalls, validation, and next recommendations.
- [Body residency accounting](residency-accounting.md) — versioned resident-cost evidence, scratch reservations, blockers, diagnostics, and RFC 09 calibration handoff.
- [Residency admission policy](residency-admission-policy.md) — measured load/scratch/socket reservations, priority aging, clean warm eviction, mobile background behavior, and backpressure.
- [Overdue-work kernel](overdue-work-kernel.md) — durable-intent scheduling, single-flight keys, fairness, retry ownership, quiesce, and staged producer migration.
- [RFC 08–10 implementation report](relay-rfcs-08-10-implementation-report.md) — integrated resource and scheduling work, server reuse, pitfalls, validation, and calibration recommendations.

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
