# YAOS documentation

Current `main` has five durable engineering documents. Git history preserves replaced RFCs, audits, incident reports, and implementation notes; they are not parallel current specifications.

- [Architecture](architecture.md) — schema-4 root/body authority, provisioning, settings SQL authority, recovery, and deletion.
- [Sync and conflict contract](sync-contract.md) — current note, attachment, and named settings-environment contracts, including lifecycle and preservation rules.
- [Operations](operations.md) — claim, device enrollment, settings setup, required bindings, recovery capability, and the breaking schema-4 deployment boundary.
- [QA](qa.md) — focused, regression, and local Worker coverage, with real-runtime and external evidence gaps stated separately.
- [Backlog](BACKLOG.md) — only evidenced unresolved product risks and concrete external validation gaps.

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
