# YAOS documentation

Current `yaos3` documentation describes the schema-8 product, its operating
boundary, and the contracts consumers and maintainers need to use safely. Git
history preserves replaced RFCs, audits, incident reports, and implementation notes; they are not
parallel current specifications.

- [Vault collaboration](collaboration.md) — owner/member product contract,
  people and devices, fixed authority, principal-scoped settings, transfer,
  revocation, presence, and compatibility.
- [Architecture](architecture.md) — schema-8 root/Markdown/Canvas authority, semantic epochs, principal/device identity, settings, recovery, and deletion.
- [Sync and conflict contract](sync-contract.md) — current note, attachment, and named settings-environment contracts, including lifecycle and preservation rules.
- [Canonical Markdown](canonical-markdown.md) — the shared logical text representation, hash domains, and baseline cutover.
- [Operations](operations.md) — claim, invitations/device links, owner recovery and transfer, settings setup, required bindings, recovery, and the greenfield schema-8 boundary.
- [Backlog](BACKLOG.md) — only evidenced unresolved product risks and concrete external validation gaps.
- [Client remake](client-remake/DESIGN.md) — the Obsidian plugin in `src/`: architecture, protocol, sync engine and host. [Legacy parity](client-remake/legacy-parity.md) maps every feature of the deleted old client to its new home or to the reason it was dropped.

The repository-root [README](../README.md) is the public product guide. Workstation notes belong under ignored `notes/`.
