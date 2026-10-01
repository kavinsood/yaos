# Artifact relocation fixtures and native handoff

Run from `/Users/kavin/yaos-p0k-followups`:

```sh
node tests/run-typescript.mjs --test-aliases tests/client/artifact-relocation.ts
node tests/run-typescript.mjs --test-aliases tests/client/artifact-relocation-process-recovery.ts
node tests/run-typescript.mjs --test-aliases tests/fixtures/artifact-relocation-process-child.ts /tmp/yaos-artifact-native-fixture prepare
```

Use a fresh destination directory for `prepare`. It leaves real files in
`/tmp/yaos-artifact-native-fixture/vault`, a durable `state.json`, and
`metadata.json` containing the initial episode and expected version texts.
The printed `obstructedPath` identifies the file containing the six binary
occupant bytes `ff 00 fe 0d 0a 61`. The same episode's `pendingAppend.expected`
contains the complete original artifact, and `pendingAppend.content` adds
the next version. The multipart first-part append is an explicitly assembled
recovery fixture for exercising retained sibling backlinks and lightweight
relocation references, not a native sync event.

Recover the isolated fixture with:

```sh
node tests/run-typescript.mjs --test-aliases tests/fixtures/artifact-relocation-process-child.ts /tmp/yaos-artifact-native-fixture recover
```

The process suite drives IPC checkpoints and actual parent-issued SIGKILL at
`selected`, `before-write`, `after-write`, and `committed`.
It also kills five successive processes while obstructing two selected paths,
and obstructs a replacement after its artifact write. Do not run a checkpoint
argument directly without the IPC parent: the child deliberately waits to die.

## Native Obsidian verification

Do not import the synthetic `process-body` identity into a real synced vault.
Use a genuine native conflict in an isolated QA vault with the main-port owner:

1. Stop the artifact write after `pendingAppend` is persisted but before the
   port writes. In plugin `data.json`, locate
   `_conflictEpisodes.episodes[actualBodyId]`, retain `_conflictEpisodeScope`,
   and record `id`, `parts`, `versions`, `pendingAppend.version.part`,
   `pendingAppend.expected`, and `pendingAppend.content`. Keep the original
   source note intact.
2. Replace only `pendingAppend.version.part` with unmistakable foreign bytes;
   record their exact digest. Resume or restart the real app. The episode ID
   must remain unchanged; replacement selection must already be durable before
   the create. All old versions in that logical part must keep their original
   hashes, offsets, lengths, and text. All sibling files and offsets must remain
   untouched. Their historical backlinks still reference the obstructed path;
   `episode.relocations[oldPath]` explicitly references the current managed part.
3. Kill after replacement selection. Inspect the durable selected path, occupy
   that path with a second foreign file, and restart. Repeat kills after create,
   and final metadata persist. Each restart
   must retain one logical part per original part, not an append/relocation chain.
4. Assert every occupant is unchanged, old artifact exemptions are revoked,
   `obstructions` lists foreign paths, versions are unique by hash, and
   `relocations` maps every displaced path directly to its latest managed part,
   and `pendingAppend` disappears after successful recovery. Episode settings must
   contain only version/index/hash/path metadata, not completed fulltext copies.
5. Resolve through the actual review command. Replacement artifact files and
   their artifact fingerprints must remain; the pending episode must disappear.
   Verify the artifact note is still available after another restart.

Completed artifacts corrupted outside an unfinished append cannot be
reconstructed from hashes. This implementation reports that limitation,
retains obstruction paths and the expected hash, revokes the old exemption, and
requires restoration of the exact original artifact. It never archives full
completed artifact text in settings or treats a matching version slice inside
foreign content as ownership proof.

## Main/UI owner handoff

`ConflictEpisode.obstructions` exposes obstructed paths and
`ConflictEpisode.relocations` exposes old-path-to-current-managed-part references
to main's conflict review/attention UI. Show these references even when relocation clears
`episode.error`; do not delete, auto-repair, ingest as owned artifacts, or hide
their foreign bytes. Existing `changed`/`notify` callbacks remain the normal
episode-discovery mechanism. Dedicated obstruction visibility belongs to the
main/UI owner, not this patch. Retained sibling backlinks intentionally remain
unchanged to avoid copying an entire episode into an unfinished plan; main should
explain their historical targets and link users to the current managed parts.

The 100 one-MiB sibling test asserts every persisted state stays below two MiB
with a 600 KB unfinished part and 100 MB of unchanged sibling notes. Only the
one replacement is written, and no fulltext payload survives successful replay.
