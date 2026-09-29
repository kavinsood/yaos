# G8 — No-baseline frontmatter decision

Date: September 30, 2026. Decision memo only; this item changes no ingestion policy.

## Current contract and evidence

Measured reproduction: `fast-20260929T154917Z`, documented in `results/P0-round5-fast.md`, section c, and `results/P0-round5-frontmatter-nobaseline.json`. IndexedDB replacement discarded four disk-index baselines because their local-state identity no longer matched. A current server body is not evidence of what the disk previously agreed to.

| Case | Current behaviour | Preserved text / trade-off |
|---|---|---|
| c1: strip YAML, unchanged prose | No trusted base; disk is preserved before projecting the server body | Server properties survive, but a conflict artifact is unnecessary from the user's perspective |
| c2: strip YAML and change prose | No trusted base; preserve disk, keep server body | Prose edit survives in the artifact rather than automatically syncing into the original |
| c3: duplicate YAML keys and change prose | Guard holds properties; in-place reconciliation lacks a trusted base and preserves disk | Neither property version nor prose is lost; original may remain divergent |
| c4: autosave c3 three times | G4 now uses one durable body-keyed episode and appends distinct versions | One episode, no repeated artifact unless size rollover is needed; ingestion policy is unchanged |
| Disk exactly equals server, no baseline | Equality settles without a merge | No conflict required |
| No baseline but a valid stored whole-content common base | Use the stored base for three-way reconciliation | Clean changes merge; overlapping changes remain explicitly reviewable |
| Malformed/unclosed YAML boundary | Treat ambiguous region boundaries conservatively | Cannot safely infer which bytes are properties versus prose |

Code in `/Users/kavin/yaos-p0k-followups`: `src/runtime/reconciliationController.ts` (`syncFileFromDisk`, `inPlaceThreeWay`), `src/sync/diskMirror.ts` (`settleBody`, `preserveDiskThenProjectBody`, `readWholeCommonBase`), `src/sync/frontmatterGuard.ts` (`validateFrontmatterTransition`), and `src/sync/frontmatterBoundary.ts`. Disk-index and stored-common-base identity checks are safety barriers, not cosmetic checks. BindDivergencePolicy must continue to prevent attaching a CRDT editor over unresolved divergent input.

## Options

### (a) Retain preservation-first behaviour; improve explanation

Keep c1–c3 unchanged. Explain that YAOS lost its trusted agreement and cannot distinguish a deliberate deletion from stale disk. Link the durable episode and explicit review command. G1–G5 already make this tolerable without unsolicited modals, startup stalls or autosave spam.

Worst case: a prose edit is delayed until review, but unique input remains available. Artifact write failure must leave disk untouched and show actionable attention. Implementation size: small UI/documentation change, no merge-policy change. Tests: all c1–c4, restart, rename, open-editor bind, disk read failure, and resolution after a remote advance.

### (b) Split properties and prose; use two-way intent for prose without a base

For unambiguous boundaries, retain guarded server properties and apply existing online two-way ingestion to the disk body region. c1 avoids a conflict; c2's prose can sync; c3's prose can sync only if the region splitter accepts the malformed header's boundary, while properties remain held. Ambiguous boundaries still preserve.

Worst case: stale disk prose overwrites or deletes unseen remote prose because no agreed base distinguishes deletion intent from ignorance. A header-only comparison cannot prove that disk's body is current. Open-editor attachment must not bypass BindDivergencePolicy. Implementation size: medium, shared region-aware settlement plus explicit provenance/intent rules, not a one-line guard exemption. Tests: c1–c3, offline remote-only paragraphs, deletion on stale disk, malicious/ambiguous boundaries, valid duplicate-key header boundaries, concurrent editor/disk updates, and semantic reset. Accept only with explicit user-approved prose-winner semantics or a stronger freshness proof.

### (c) Reconstruct the exact previously agreed baseline

Recover an agreement hash and its canonical text from a durable source independent of replaced IndexedDB, or fetch retained history corresponding to a provably agreed generation. Run genuine three-way reconciliation. c1/c2 become clean if the reconstructed base demonstrates that only the disk removed properties; c3 keeps guarded properties but can merge prose. Missing, garbage-collected or unverifiable history falls back to (a).

Worst case: choosing current server text or merely a last-observed generation as the base falsely asserts prior agreement and loses remote changes. Generation/epoch knowledge alone is insufficient; the base must be body-identity scoped, text/hash verified, and represent an actual disk/server agreement. Implementation size: medium–large, agreement durability/recovery and bounded history retrieval. Tests: IndexedDB loss with retained agreement, stale generation, partial cache loss, epoch reset/history GC, renamed bodies, corrupt base/hash, agreement before versus after projection, and recovery on both fresh and returning devices.

## Recommendation

Choose (a) now, then investigate (c) as a separate task. Do not ship (b)'s no-base two-way deletion risk merely to remove a spurious artifact. Durable conflict episodes improve availability and explain the safety contract without weakening it. If the user later explicitly prefers disk prose as intent despite absent provenance, (b) should be an opt-in, documented policy with its own loss-risk acceptance tests. No such ingestion-policy change is included in this work.
