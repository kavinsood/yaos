# YAOS documentation

Current `main` has five durable engineering documents. Git history and the separate engineering library preserve replaced RFCs, audits, incident reports, and implementation notes.

- [Architecture](architecture.md) — current multivault control plane, per-vault sync rooms, device memberships, runtime, and storage boundaries.
- [Sync and conflict contract](sync-contract.md) — current vault/transport scope, preservation policy, and receipt semantics.
- [Operations](operations.md) — claim, pairing enrollment, operator console, deployment, updates, and exact schema admission.
- [QA](qa.md) — accountable gates, device-scoped fixtures, current evidence, and manual real-device procedures.
- [Backlog](BACKLOG.md) — the canonical list of open defects, validation gaps, cleanup debt, and next-block storage/recovery/sharding work.

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
