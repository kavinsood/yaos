# ywasm qualification

These probes are release gates for the CRDT engine boundary. They intentionally
remain runnable outside the server so allocator measurements use a fresh
process, and so a trap cannot contaminate another assertion.

```sh
npm run test:ywasm:quick
npm run test:ywasm:release
```

The release run first performs two clean pinned Rust/Wasm builds and their
exact 10,000-cycle linear-memory settling/maximum-page verifier. It then performs the 100 × 500 bidirectional Unicode corpus (100,000
operations per artifact invocation), 10,000 allocation/apply/encode/free
cycles, an eight-shard dual-document memory soak, lifecycle timings for both
engines, corrupt-update recovery, and Wasm artifact inspection. The ordinary
regression suite separately exercises the public `CrdtEngine` adapter.

`YAOS_YWASM_MODULE` can select a Node-importable binding for all probes. Setting
`YAOS_YWASM_CANDIDATE_MODULE` additionally runs wire and Unicode tests against
both pinned npm and a candidate, bringing the full release corpus to the RFC's
200,000 operations. By default the scripts import the pinned `ywasm` development dependency. The Worker vendor
module is tested through the Worker build/integration suite because its direct
Wasm module import is not a Node loading contract.

The following optional variables tune explicit gates without changing source:

- `YAOS_YWASM_ARTIFACT` and `YAOS_YWASM_WRAPPER` select files to inspect.
- `YAOS_YWASM_MAX_ARTIFACT_BYTES` and `YAOS_YWASM_MAX_WRAPPER_BYTES` set bundle
  ceilings (defaults: 1,100,000 and 200,000 bytes).
- `YAOS_YWASM_MAX_POST_WARMUP_RSS_GROWTH_BYTES` sets the allocator-soak RSS
  allowance. Exact linear-memory bytes are enforced through production engine
  telemetry; RSS is a complementary process-level signal.
- `YAOS_YWASM_LIFECYCLE_UPDATES` and `YAOS_YWASM_SOAK_FIXTURE_KIB` adjust the
  workload when reproducing a pathological trace.

Lifecycle output is observational rather than a timing assertion: shared CI
hosts are too noisy for a mathematically useful wall-clock threshold. Deployed
Worker medians remain the performance authority. Correct final-state hashes,
wire behavior, memory limits, artifact sizes, and disposal settling are hard
failures here.
