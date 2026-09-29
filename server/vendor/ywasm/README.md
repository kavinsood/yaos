# YAOS ywasm artifact

This directory owns the reproducible inputs for the server CRDT artifact. The
source commit, Rust/wasm toolchain, Cargo lock and upstream MIT license checksums, memory ceiling, and
expected outputs are pinned in `SOURCE.json`. `0001-document-stats.patch` adds
the narrow census required by semantic compaction without exposing the Yrs
store. `0003-byte-level-update-ops.patch` (relay v2 spike) exports the stateless
yrs update-level functions `encodeStateVectorFromUpdateV1` and `diffUpdateV1`
(`mergeUpdatesV1` is upstream) so byte-relay paths need no transient doc.

Run `npm run build:ywasm` from `server/`. The build clones the exact source
commit into a temporary directory, verifies the lockfile and tool versions,
applies the patch, runs its Rust test, builds twice, and refuses to install
artifacts unless both builds and the recorded checksums match.

The checked-in artifact is a Cloudflare Workers module. It is not directly
Node-importable; Node adapter tests inject the npm binding, while the build
qualification runs the patched Node target to exercise `documentStats()`.
