# YAOS documentation

Current `main` has five durable engineering documents. Git history preserves replaced RFCs, audits, incident reports, and implementation notes; they are not parallel current specifications.

- [Architecture](architecture.md) — schema-4 root/body authority, provisioning, runtime ownership, SQL bootstrap, recovery, and deletion.
- [Sync and conflict contract](sync-contract.md) — current subjects, durable candidate/lifecycle rules, bootstrap, preservation policy, and receipts.
- [Operations](operations.md) — claim, device enrollment, required bindings and migration, recovery capability, and the breaking schema-4 deployment boundary.
- [QA](qa.md) — current focused, regression, and local Worker evidence, with deferred validation stated separately.
- [Backlog](BACKLOG.md) — only evidenced unresolved product risks and post-integration validation gaps.

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
