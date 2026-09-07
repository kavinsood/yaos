# Relay RFCs 01–07 implementation report

Date: 6 September 2026. Branch: `yaos3`.

## Delivered program

The seven RFCs were implemented in dependency order, with the two independent foundations developed in parallel:

```text
canonical Markdown ───────────────┐
                                 ├→ safe text commit → common base → diff3/review
runtime epoch → socket admission ┴→ body coordinator/leases ────────┘
```

### RFC 01 — canonical Markdown

YAOS now has one `markdown-lf-v1` codec across browser, CLI, bootstrap, conflict artifacts, diagnostics, and server candidate validation. It removes one BOM, maps CRLF/lone CR to LF, preserves final newline, whitespace, and Unicode, and keeps exact raw disk fingerprints separate from logical hashes. Existing unversioned baselines are conservatively invalidated.

### RFC 02 — runtime lifetime

`RuntimeScope` synchronously stops admission and rotates publication epochs before teardown awaits. It owns idempotent leases, bounded drain, operation outcomes, and machine-readable failure classes. Client teardown and a long-lived network path consume it; server shutdown uses the same stop/admit/drain language.

### RFC 03 — reconnect ownership

One `SocketAdmissionCoordinator` owns root and body connection attempts. Every attempt refreshes current credentials, simultaneous triggers single-flight, cache invalidation fences late responses, terminal credentials do not retry, transient/rate-limited failures do, and autonomous provider reconnect is routed back through the coordinator.

### RFC 04 — body coordination

`BodyCoordinator` now owns body identity, content/lifecycle/ownership revisions, catalog path projection, state facts, and leases. It consumes the shared runtime epoch rather than creating a competing lifetime. Root transactions update one-to-one bindings atomically; editor consumers have independent projection leases; load, replacement, and eviction update residency.

### RFC 05 — safe application

Ordinary stale-base text application returns `superseded` without mutation. Disk projection captures body/path/content/ownership proof and revalidates before filesystem changes. Full replacement remains only in named recovery flows.

### RFC 06 — common bases

Both IndexedDB and SQLite persist reconstructible, codec-scoped, body-keyed common bases with server generation/hash, exact disk evidence, current path metadata, and a durable local CAS revision. Reads distinguish missing from invalid ancestry. Bootstrap requires this proof on its fast path and backfills only from observed three-way agreement.

### RFC 07 — merge and review

Closed-body divergence uses bounded character diff3. Disjoint edits publish a normal durable body candidate, replan to the new head, materialize disk, and only then settle ancestry. Transitive overlap becomes one conflict hunk. The original disk is retained, the body alternative is artifacted, normal writeback is blocked, Obsidian review requires explicit revision-fenced choices, and CLI remains conservative.

## Observations

### The real unit was proof, not state

The first coordinator sketch used one revision number. That looked simple but made unrelated events invalidate one another and still could not express the proof needed by candidate receipts. Separating runtime, lifecycle/path, document/content, and ownership axes made each completion's authority reviewable.

### Candidate settlement and common-base settlement are different protocols

An exact candidate receipt must still be accounted when newer edits already exist; otherwise pending update counts never settle. A common base has the opposite requirement: it must prove the body, server head, and disk are simultaneously current. Combining them would either lose work accounting or manufacture ancestry.

### Canonical content and disk bytes are deliberately different truths

Normalizing at the filesystem adapter initially appeared attractive. It destroys the raw evidence needed to distinguish a self-write from an external CRLF/BOM rewrite. Canonicalization belongs at logical ingress; exact fingerprints remain below it.

### “Return replan” is a first-class success outcome

After a clean merge, the old server head is necessarily stale because YAOS has just published a newer candidate. Continuing the old materialization transaction looks like progress but causes the correct head-after fence to reject the operation. Successful asynchronous systems need `superseded/replan` beside `completed`.

### Durable preservation must block the ordinary path

Writing a conflict artifact is insufficient if an already-scheduled body-to-disk flush can overwrite the original file moments later. The preserved-unresolved registry is therefore part of the write admission check, not only a diagnostic list.

## Pitfalls encountered

- A first patch tried to delete and add the same file in one `apply_patch`; the patch engine correctly rejected the duplicate target. Large rewrites were split into explicit delete/add operations.
- The initial common-base prototype stored ephemeral body content/lifecycle revisions. Those counters restart at zero and cannot be durable evidence; they were replaced with `localSettlementRevision` CAS.
- The prototype used numeric canonical version `1`, conflicting with the codec's actual string identity. The store now uses the codec type directly.
- The first diff3 implementation emitted overlapping hunks when one broad edit intersected several opposite edits. Connected components now collapse each transitive region.
- Conflict review initially defaulted every hunk to the body. Defaults turn “review” into an accidental overwrite button; all choices now begin unset.
- Bootstrap's clean-cache fast path would have skipped common-base creation forever. It now requires matching persisted ancestry plus exact current disk evidence.
- Body coordination initially created a private random runtime epoch. Product bodies now capture the same `RuntimeScope` epoch used by reconnect and teardown.
- Root path binding needed a reverse index. Without it, renaming one body could leave both old and new paths apparently current.

## Validation performed

- canonical codec and baseline-cutover suites;
- runtime epoch, drain, reconnect single-flight, and terminal/retry classification suites;
- body load races, leases, split ownership, rename, path reuse, and proof-axis suites;
- stale-safe diff and recovery-only force-replace regressions;
- typed common-base validation, corruption, generation regression, and CAS tests;
- IndexedDB and SQLite restart persistence tests;
- bootstrap agreement/backfill and exact-evidence fast-path tests;
- diff3 disjoint, duplicate, insertion, transitive-overlap, explicit-resolution, and bound tests;
- production, test, CLI, server, and Node TypeScript/build surfaces;
- full regression and runtime suites at final integration.

## Recommendations

### 1. Add application-level socket liveness

Browser WebSocket state cannot reveal a silent TCP black hole. Add a protocol heartbeat/ack owned by the admission coordinator before using “connected” as a resource or UX signal.

### 2. Persist a compact conflict-session descriptor

The artifact plus preserved registry is already crash-safe. A small descriptor containing body ID, base hash, disk fingerprint, and body hash would let Obsidian reopen the exact review affordance after restart without making the modal itself authoritative.

### 3. Measure diff and temporary-document memory

The merge bounds are conservative constants, not measured device budgets. RFC 08 should separately account for base/disk/body strings, diff arrays, Yjs reconstruction, and providers on desktop and mobile, then tune admission and bounds from evidence.

### 4. Migrate legacy noncanonical Yjs bodies explicitly

Bootstrap can verify legacy raw catalog metadata and materialize canonical text, but mixed-version stored Yjs histories can remain raw until rewritten. A real rolling deployment should coordinate server rejection with a protocol capability and a one-time durable canonical candidate migration.

### 5. Give structured regions semantic adapters

Character diff3 is intentionally conservative around frontmatter. RFC 11 should define independent body/property settlement and lossless YAML behavior before enabling automatic structured merge.

### 6. Expand fault injection around real filesystem bridges

Pure and orchestration tests cover every logical crash boundary. Add desktop/mobile host tests that pause after suppression fingerprinting, after modify/create, after candidate receipt, and before settlement CAS to validate Obsidian adapter behavior under real event ordering.

## Remaining Relay horizon

RFCs 01–07 complete the text-correctness critical path, not the entire Relay-learning program. The topological next step remains RFC 08 measured residency accounting, followed by admission/wake budgets and the shared overdue-work kernel. Those should consume the leases, outcomes, and coordinator facts delivered here rather than inventing new lifetime systems.
