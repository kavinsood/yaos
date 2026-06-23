# Snapshot Semantics and The Recovery Model

Sync is nice. Recovery is the real reason you self-host your data.

Obsidian's local File Recovery plugin is excellent for small "oops" moments (like accidentally deleting a paragraph). KAOS does not try to replace it. KAOS snapshots are designed for catastrophic recovery: *"I accidentally wiped my folder structure and need to intelligently restore the vault to yesterday's state."*

Snapshots are the operational safety-net for the CRDT graph, not a second attachment transport. KAOS serializes the full `Y.Doc` state, gzips the payload, and writes two objects to R2:
- `crdt.bin.gz` (the compressed CRDT state)
- `index.json` (snapshot metadata and blob references)

## Deduplication by design

*Snapshot creation does not duplicate blob bytes.*

If snapshots copied full binary payloads each time, a daily snapshot would explode storage costs for vaults with large static media. Instead, the index.json acts as a point-in-time manifest. It records the content hashes currently referenced by the CRDT (pathToBlob). Because R2 attachments are content-addressed, this provides inherent deduplication.

At restore time, the CRDT state is authoritative. The plugin applies the restored graph, reconstructing the exact folder structure and text, and then reconciles attachment files by pulling the missing hash pointers from R2.

## Safety Invariants

A few invariants keep this model correct under failure:
- Snapshot IDs are generated using cryptographic randomness, not predictable Math.random() calls.
- Snapshot operations share the exact same storage substrate as blob sync. If R2 is unbound, snapshots are disabled entirely (`snapshots: false`), preventing ambiguous recovery guarantees.
- Missing blob objects during restore are surfaced as localized data gaps, not silent structural failures.

The result is a system where text collaboration remains real-time and cheap, attachment sync remains content-addressed, and snapshots provide deterministic vault recovery without introducing a second complex storage engine.
