# The Filesystem Bridge

The trickiest part of this plugin is maintaining a bidirectional bridge between two asynchronous systems with fundamentally incompatible semantics.

1. Obsidian's Virtual File System (VFS) emits noisy, non-causal file events (create, modify, delete) that can arrive late, duplicated, or out of order.
2. Yjs applies strictly ordered document operations and expects clear causal intent, especially for cursor- and history-preserving updates.

Bridging an eventual-consistency file watcher to a strong-consistency state machine is notoriously difficult. I spoke to the founders of the two largest commercial Obsidian sync plugins (Relay and Screengarden), and they both explicitly acknowledged this bottleneck.

KAOS solves the problem natively by abandoning time-based heuristics in favor of content-addressed state acknowledgment.

![Filesystem bridge control loops and invariants (Disk <-> CRDT)](./diagrams/filesystem-bridge-control-loops-diagram-with-invariants-disk-crdt.webp)

## The "Time" Trap (Why naive watchers fail)

Early traces revealed that depending on time as a correctness primitive leads to catastrophic state tearing. Originally, the bridge used a time-to-live (path + TTL) heuristic to guess whether an incoming filesystem event was triggered by our own CRDT write.

Filesystem events do not arrive cleanly. Saving a file might trigger three separate modify events in a span of 50 milliseconds. Processing these synchronously tears the CRDT. Because event arrival is scheduler- and OS-dependent, this caused severe bugs:

- Self-echo loops: We would write a remote CRDT update to disk, Obsidian would emit a modify event, and delayed timers would allow the ingest path to mistakenly treat our own write as a new user edit.
- Timer races: Under bursty local edits, multiple timers (debounce, open-write, burst cooldown) would race to enqueue or flush the same path against stale assumptions.

In short: the filesystem is eventual and noisy, but we were treating it like a deterministic stream.

## The Solution: I/O Backpressure and State Acknowledgment

To stabilize the bridge, we stripped time out of the correctness equation and rebuilt the synchronization loop around three strict invariants:

1. Inbound (Disk -> CRDT): The Dirty-Set Drain Loop

We stopped reacting to every filesystem tick.

- Obsidian modify and create events no longer trigger immediate imports; instead, they mark paths as dirty in a coalescing map.
- A single asynchronous drainer processes these batches at the pace of actual disk I/O.
- Crucially, the batch is cleared before processing begins. Any new filesystem events that arrive during the I/O read will safely re-dirty the path for the next pass. Event storms are now bounded by path, paced by backpressure.

2. Outbound (CRDT -> Disk): Per-Path Serialization

- Outbound writes from the CRDT to the disk now pass through a strict promise chain lock.
- This ensures that the same file cannot be written concurrently by overlapping paths, making it impossible for overlapping network syncs to trigger concurrent flushes to the same file.

3. State-Acknowledged Suppression

We entirely replaced time-based suppression with observed state acknowledgment. This is how we solved the out-of-band edit problem.

- We no longer suppress self-echoes using timers. Before writing a remote update to disk, we store the expected byte length and the SHA-256 hash of the exact content we are writing.
- When Obsidian fires a vault modify event, the inbound bridge reads the file and compares the current fingerprint against the expected write. Only if the content perfectly matches do we drop the event.
- Ownership for write suppression is now causal and based on observed state, rather than elapsed time.

If a user edits a file out-of-band using a different markdown editor, the hash changes, the suppression is bypassed, and the new text is seamlessly ingested into the CRDT using fast-diff.

## Current Invariants

This architecture guarantees the following strict invariants for the filesystem bridge:
- One path, one active write chain.
- Disk event coalescing is path-based and idempotent.
- Self-event suppression must be validated by observed content state.
- CRDT ingest for markdown uses diff operations, not replace-all, to ensure cursor and history safety.

Timing still exists purely as a memory-cleanup window, but ownership for write suppression is now mathematically bound to the observed state, not just elapsed time. (Note: Delete suppression remains a heuristic, as there is no file content left to hash after a deletion).
