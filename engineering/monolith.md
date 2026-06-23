# Monolithic Architecture

The current KAOS architecture uses a single, shared Y.Doc for the entire vault - file metadata, folder structures, blob references, and all markdown Y.Text values.

![Single-vault monolithic Y.Doc vs sharded two-tier CRDT model](./diagrams/single-vault-monolithic-y-doc-vs-sharded-two-tier-crdt-model.webp)

For small and medium personal vaults (upto ~40-50 MB of raw text), this gives:

- simple synchronization semantics
- strong real-time collaboration behavior
- easy snapshotting
- and perfect cross-vault ACID transactions.

If a user renames a folder containing 50 markdown files, KAOS batches that into a single ydoc.transact() block. Either all 50 files move, or none of them move. The vault structure can't tear.

The tradeoff is that this design has a scaling ceiling. Over time, retained tombstones and document history will pay more in startup cost and memory usage.

We estimate that 70-80% of Obsidian users write notes like normal humans and want a fast, local-first Apple-Notes-on-steroids alternative. But we acknowledge that the small group of users who use Obsidian to ingest 10,000 auto-generated logs, scrape Wikipedia, and dump gigabytes of academic PDFs into one folder.

Loading a 10GB vault's history into a single in-memory CRDT graph would immediately trigger an Out of Memory crash on mobile devices. This is why Obsidian Sync uses dumb, debounced file-level syncing, because it has an O(1) memory ceiling per file. It doesn't care if your vault is 1MB or 50GB; it just moves files around and relies on "File modified externally" popups when things collide.

We made the opposite trade. KAOS trades infinite scalability for perfect real-time ergonomics.

To bypass the memory ceiling while keeping real-time sync, *we could shard the CRDT per-file*, which is actually how Apple Notes works:

- Local-First Database: The source of truth is a local SQLite database (CoreData). The folder structure, metadata, and note list live here.
- Per-Note CRDTs: Apple does use a custom CRDT implementation for the rich text and tables inside the notes, but it is strictly scoped per note. They serialize the note content using Protocol Buffers and sync it via CloudKit.
- Dumb Metadata Sync: The folder hierarchy and note metadata (creation date, tags) do not use CRDTs. They use standard CloudKit conflict resolution, which is usually just Last-Writer-Wins (LWW) based on timestamps.
- Aggressive Garbage Collection: Unlike Yjs, which retains every deletion tombstone forever (unless you explicitly write a garbage collection layer), Apple Notes aggressively prunes edit history once the CloudKit server confirms the sync. This keeps the protocol buffer payloads tiny.

To achieve this in KAOS, we would have to build a Two-Tier CRDT System:

**Tier 1 (The Master Index)**: A vault-level CRDT holding only metadata (fileID -> path). It syncs immediately on startup.

**Tier 2 (Lazy-Loaded Leaf Docs)**: Each markdown file gets a dedicated Y.Doc. When a user opens foo.md, the client dynamically instantiates the doc, fetches its history, and subscribes to its updates.

We don't do this because this is a major refactor with complex consistency boundaries, and Apple's custom CRDT is actually worse at handling heavy concurrent edits than my Yjs implementation. Yjs is mathematically more robust.

Because browsers only allow a few WebSocket connections, this requires building a custom multiplexed router, and we would have to build an LRU to constantly evict idle Y.Doc instances from memory (because the nature of the Actor model is such that individual objects have small limits).

The problem is, when you split a single monolithic state graph into thousands of independent CRDT instances, you fundamentally decouple their replication streams. A multi-document operation, such as updating a structural reference in the Master Index while simultaneously modifying the target Leaf Doc—can no longer be committed as a single atomic transaction.

If a network partition interrupts the synchronization process, the system state tears. Document A may successfully replicate to the remote server while Document B remains stranded on the local client. To a remote observer, the vault's referential integrity is broken. Links between documents can break, metadata no longer lines up with the actual content, and related changes show up in the wrong order.

By sharding the state, you downgrade the system's cross-vault guarantees from *strong transactional consistency to eventual consistency*. The CRDTs will mathematically converge once the network fully stabilizes, but the intermediate states exposed to the system, and the user, will be semantically invalid.

Enterprise systems like Figma and Notion accept this tearing. They trade strong consistency for identity preservation and memory scalability. Because the content is bound to a stable fileID rather than a fragile file path, no data is permanently lost. However, they write defensive UI code to hide broken references, handle dangling pointers, and mask the eventual consistency delay from the user.

KAOS has a debug mode, which shows vault-footprint. After doing QA, I saw that my vault's `encodedDocBytes` was 25KB larger than the total live markdown text, which is roughly a **1.9% overhead.** Essentially, the CRDT state is lean, and history/tombstones are not bloating the document much at all.

When the overhead is 2%, abandoning the monolith's ACID guarantees is severe over-engineering. We will cherish the monolith until the profiler proves we have no other choice.
