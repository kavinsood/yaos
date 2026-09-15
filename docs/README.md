# YAOS documentation

Current `yaos3` has durable engineering documents for the schema-10 collaboration
product and the Relay-derived text/lifetime program. Git history preserves
replaced RFCs, audits, incident reports, and implementation notes; they are not
parallel current specifications.

- [Vault collaboration](collaboration.md) — owner/member product contract,
  people and devices, fixed authority, principal-scoped settings, transfer,
  revocation, presence, and compatibility.
- [Architecture](architecture.md) — schema-10 root/Markdown/Canvas/Excalidraw authority, semantic epochs, principal/device identity, settings, recovery, and deletion.
- [Sync and conflict contract](sync-contract.md) — current note, attachment, and named settings-environment contracts, including lifecycle and preservation rules.
- [Canonical Markdown](canonical-markdown.md) — the shared logical text representation, hash domains, and baseline cutover.
- [Operations](operations.md) — claim, invitations/device links, owner recovery and transfer, settings setup, required bindings, recovery, and the greenfield schema-10 boundary.
- [QA](qa.md) — focused, regression, and local Worker coverage, with real-runtime and external evidence gaps stated separately.
- [Backlog](BACKLOG.md) — only evidenced unresolved product risks and concrete external validation gaps.
- [Runtime lifecycle and socket admission](runtime-lifecycle-and-admission.md) — publication epochs, bounded drain, and refresh-first socket ownership.
- [Application-level socket liveness](socket-liveness.md) — heartbeat evidence, background suspension, and force-abort recovery.
- [Multiplexed body transport evaluation](multiplexed-body-transport-evaluation.md) — deployed Cloudflare measurements, formal protocol-2 rejection, and evidence thresholds for reconsideration.
- [Currentness plane and editor admission investigation](currentness-plane-investigation.md) — measured admission and catch-up amplification, exact socket watermarks, batched head queries, lifetime prerequisites, and staged implementation plan.
- [Currentness plane implementation report](currentness-plane-implementation-report.md) — six-phase delivery, public Cloudflare profiling, flush compaction, contention remediation, and final outcome.
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
- [Canvas semantic synchronization](canvas-semantic-sync-plan.md) — implemented semantic model, authority, projection, migration, recovery, validation, and field-gated rollout plan for JSON Canvas.
- [Canvas implementation report](canvas-semantic-sync-implementation-report.md) — shipped schema-8 behavior, safe degradation, automated evidence, and remaining external release gates.
- [Excalidraw realtime collaboration plan](excalidraw-realtime-collaboration-plan.md) — exploratory scene, resource, presence, sharing, spike, validation, and rollout architecture.
- [RFC 13: Excalidraw same-vault scene sync](rfc-13-excalidraw-same-vault-scene-sync.md) — native Drawing-DO authority, atomic operations, replay, fencing, host capture/apply, and resource contract.
- [RFC 13 implementation report](rfc-13-excalidraw-same-vault-scene-sync-implementation-report.md) — implemented schema-9 core, automated evidence, and remaining production release gates.
- [RFC 14: Generic presence kernel](rfc-14-generic-presence-kernel.md) — protocol-7 transient presence, bounded Drawing-room lifecycle, and Obsidian Excalidraw host contract.
- [RFC 14 implementation report](rfc-14-generic-presence-kernel-implementation-report.md) — delivered server/client/host work, local Worker evidence, and remaining deployed and real-host gates.
- [RFC 15: Excalidraw browser publication and collaboration](rfc-15-excalidraw-browser-publication-collaboration.md) — schema-10 enrolled browser, Drawing-DO public grants, sanitized live projections, explicit resources, cookie sessions, audience-safe presence, and public read/write fencing.
- [RFC 15 implementation report](rfc-15-excalidraw-browser-publication-collaboration-implementation-report.md) — profile-by-profile delivery shell, validation evidence, inherited blockers, deviations, and release decisions.
- [Yjs pathology remediation report](pathology-remediation-report.md) — binary storage, resident validation, semantic epochs and compaction, retention fixes, frozen-trace measurements, and deployed validation.

The repository-root [README](../README.md) is the public product guide. Generated evidence belongs under ignored `qa-runs/`; workstation notes belong under ignored `notes/`.
