# YAOS pathology lab

The pathology lab answers the resource questions which ordinary correctness
tests cannot: how much permanent Yjs history a single YAOS3 body accumulates,
how high an intervention's transient memory peak is, whether the real server
candidate path amplifies work, and how much root churn and history pins retain.

It deliberately uses one `Y.Doc` per body. Older memory experiments in this
repository put a vault of notes in one document and remain useful only as Yjs
controls; that is not the YAOS3 body architecture.

## Run it

The quick profile is suitable for development:

```sh
npm run lab:pathology
```

The generator's deterministic framing and corruption detection have a focused
self-test:

```sh
npm run lab:pathology:self-test
```

The stress profile generates 50,000 pathological edits. It can seed the body
from the largest admitted Markdown file found in optional corpus roots:

```sh
npm run lab:pathology -- --profile stress --corpus ~/garden,~/Downloads
```

Results are written beneath the ignored `qa-runs/pathology-lab/` directory.
Every arm runs in its own process with forced GC enabled. The report includes
the operating system's process RSS high-water mark, settled V8 measurements,
CPU usage, Yjs struct/deleted-struct counts, encoded-state size, and SQL/path
counters.

To generate a reusable trace without running measurements:

```sh
npm run lab:pathology -- --profile stress --generate-only --output /tmp/yaos-pathology-trace
```

To replay selected arms against an existing trace:

```sh
npm run lab:pathology -- --trace /tmp/yaos-pathology-trace/trace \
  --arms body-current,body-semantic-reset,server-current
```

Partial long-running result directories can be combined without rerunning
their arms. A result root may contain individual `result-*.json` files or an
aggregate `results.json`; an empty report-only import fails instead of
overwriting a report with no measurements:

```sh
npm run lab:pathology -- --trace /tmp/trace --report-only \
  --result-roots /tmp/body-results,/tmp/server-results --output /tmp/final-report
```

## Frozen evidence

Each trace contains:

- `base.update`: the initial single-body Yjs state;
- `updates.bin`: every exact length-framed wire update;
- `candidates.bin`: the same updates merged at the configured candidate
  debounce boundary;
- `semantic.jsonl`: replayable insert/delete/replace operations for future
  document-epoch tests;
- `manifest.json`: source metadata, counts, final semantic digest, Yjs census,
  and SHA-256 digests for every artifact.

Corpus contents remain only inside the ignored/local trace. Reports contain
sizes, counts, digests, and the selected local source path, never Markdown
content.

## Arms

- `body-current`, `body-rematerialize`, and `body-semantic-reset` distinguish
  warm string representation from permanent Yjs identities and tombstones.
- `server-current` calls the production `VaultCandidateService`, real
  `VaultDocumentCache`, real `VaultStore`, and Node SQLite adapter.
- `server-semantic-compaction-soak` replays the frozen semantic operations
  through those same production components, runs five real atomic semantic
  resets, and recreates every Yjs client with a fresh epoch-scoped identity
  after each reset. It fails if Markdown or durable recovery diverges, an old
  epoch candidate is accepted, socket fencing is skipped, or the declared
  struct/encoded-state regression ceilings are crossed. The byte ceilings are
  regression alarms—not input-byte admission proofs. It also enforces empirical
  elapsed-time and additional-process-RSS ceilings: 2.5 seconds/64 MiB for the
  quick trace and 20 seconds/320 MiB for the frozen 50,000-edit stress trace.
  Those thresholds leave headroom above both measured stress configurations and
  are intended to catch regressions, not certify a platform memory limit. The
  same arm separately times cold durable reconstruction and fails above 500 ms
  for quick traces or 2 seconds for the frozen stress trace.
- `server-validated-once` is the proposed lean control: candidate validation
  produces one exact post-state measurement, and the live document receives
  the update without constructing and encoding a second candidate document.
- `server-persistent-exact` retains a private validation document but performs
  exact encoded-state accounting for every candidate. `server-persistent-periodic`
  performs that exact encode every 50 candidates while carrying intervening
  input bytes as a ledger and reports every exact-size underestimation. These
  are experimental controls, not claims that the ledger is safe or that
  mutation rollback/fencing has already been implemented.
- `socket-admission-current` is the old clone-per-frame control;
  `socket-validation-mirror` is the isolated mirror algorithm control;
  `socket-production-mirror` sends every frame through the real
  `VaultSocketService` and `VaultDocumentCache` validation mirror, including
  its exact-state census every 500 frames or 256 KiB of ingress; and
  `socket-apply-floor` shows raw Yjs cost with validation removed. The stress
  profile declares and reports a 2,000-frame prefix for the expensive historical
  controls. The production mirror replays all 50,000 frames and enforces elapsed
  time and process-RSS regression ceilings.
- `checkpoint-current` measures production reconstruction/encode/chunking;
  `checkpoint-live` calls the production `writeCheckpointFromDocument` API to
  checkpoint an exact live durable state without reconstructing it again.
- `reconstruct-current` cold-loads the production fragmented checkpoint in a
  clean process; `reconstruct-self-contained` applies independently decodable
  update frames without first joining one giant checkpoint buffer.
- `root-current` and `root-semantic-reset` are isolated root-history controls.
  `root-production-semantic-reset` runs the same pathology through the real
  cache, exact-head CAS, transactional checkpoint reset, and socket fence. It
  seeds and verifies SQL-authoritative Markdown, Canvas, active attachment and
  attachment-tombstone state, removes ephemeral marker maps, rebases both
  unpublished and existing lifecycle proofs, and compares an independent
  durable reconstruction with the resident fresh root. Elapsed time and fresh
  struct count are regression-gated; incremental RSS is reported only as an
  informational OS high-water value because fixture construction can establish
  the process high-water mark before the timed reset.
- `pin-retention` measures physical checkpoint bytes retained only by live
  history pins.
- `epoch-current-risk` deliberately demonstrates the unfenced counterfactual:
  an old client can carry retired CRDT identities across a reset. Production
  fencing is proved independently by the repeated semantic-compaction soak.

Memory arms run sequentially. Running them concurrently would make CPU timing
noisy and host-wide memory pressure would distort GC and RSS results.

The soak's RSS is a Node process high-water mark. That process contains Node
SQLite, the server live document and validation mirror, the harness, and several
simulated client documents; production clients live on separate devices. V8's
`--max-old-space-size` also does not bound native, SQLite, or array-buffer RSS.
Consequently, a soak result above 128 MiB is not evidence that the Worker uses
that much isolate memory, and passing the 320 MiB stress regression ceiling is
not evidence that the Worker fits Cloudflare's 128 MiB limit. Server-only memory
must be verified separately against a deployed Worker.
