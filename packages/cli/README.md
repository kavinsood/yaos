# `@yaos/cli`

Node 24+ headless YAOS client for a local Markdown vault. It synchronizes `.md` files only. Attachments, `.obsidian`, interactive recovery, and browser storage emulation are intentionally unavailable.

## Enroll

Each vault path enrolls as an independent device. Keep credentials out of argv:

```sh
YAOS_HOST=https://sync.example.com \
YAOS_PAIRING_CODE='one-time-code' \
yaos enroll /srv/notes
```

Enrollment creates a replay-safe pending request before contacting the server. A failed or lost response can be retried with the same host and pairing code. Device credentials and the server's `originImport` authority are stored under the state directory with restricted permissions.

## Run

```sh
yaos daemon /srv/notes
```

Readiness is one stdout line:

```text
YAOS_DAEMON_READY <vaultId>
```

All diagnostics go to stderr. `SIGINT` and `SIGTERM` stop input, drain filesystem ingestion and durable publication work, persist state, then exit.

## State

By default, YAOS derives a separate state directory for each real vault path:

```text
${XDG_STATE_HOME:-~/.local/state}/yaos/headless/<vault-name>-<real-path-hash>/
  daemon.lock
  enrollment.json
  client.sqlite
```

Set `YAOS_STATE_DIR` to use an explicit leaf directory instead:

```sh
YAOS_STATE_DIR=/var/lib/yaos/team-notes yaos enroll /srv/notes
YAOS_STATE_DIR=/var/lib/yaos/team-notes yaos daemon /srv/notes
```

The override is resolved to an absolute path, wins over `XDG_STATE_HOME`, and is not given another `yaos/headless/...` suffix. It must be non-empty, and the same leaf must be supplied to enrollment and the daemon. Enrollment state is bound to the vault's real path, so reusing a leaf for another vault is rejected.

For a server protected by Cloudflare Access, set `YAOS_CF_ACCESS_CLIENT_ID` and
`YAOS_CF_ACCESS_CLIENT_SECRET` for both `enroll` and `daemon`. The CLI sends the
service-token identity on HTTP and WebSocket handshakes and never writes either
credential into its state directory.

The leaf directory is mode `0700`; enrollment and database files are mode `0600`. No YAOS state is written inside the vault.

## Filesystem safety

The Node host caches file handles by vault path and physical identity (`dev`/`ino`).
Fresh lookups invalidate a handle after an external atomic replacement. Host-owned
atomic rewrites and renames retain the existing handle so reconciliation identity
checks continue to refer to the same logical file.

All Node-host vault writers share one bounded mutation queue (64 admitted operations,
including the active operation, and 32 MiB of declared retained payload). Full admission
rejects immediately; no hidden waiters retain unbounded mutation closures.
`NodeApp.create` accepts `maximumPendingMutations`, `maximumPendingMutationBytes`,
and a per-I/O `deadlineMs` (default 29 seconds, slightly earlier than the parent's
30-second I/O/watchdog deadline) for tests and embedding hosts. `mutationDiagnostics`
is a fixed-size count/byte snapshot, not a retained request history. Custom callers
of `mutate` must declare retained payload bytes; closure contents cannot be inspected.
String writers charge two bytes per JavaScript UTF-16 code unit (`2 * content.length`);
binary writers charge `byteLength`. `Vault.process(file, transform, { retainedBytes })`
lets shared callers charge their known retained captures, such as
`2 * (expected.length + next.length)` for two strings. The opaque-transform default
reserves `4 * MAX_MARKDOWN_FILE_BYTES` for maximum input/output strings, independently
of the source's possibly stale cached size. This is about 40 MiB and intentionally
exceeds the default 32 MiB admission cap: production callers must declare their known
retained bytes, or explicitly configure a larger host cap. No queued closure is
retained for a rejected admission. These declarations/reservations are an admission
contract, not introspection of arbitrary callback captures or a total JS heap limit;
callers with additional retained data must include it.
The 5 MiB canonical product limit does not lower this opaque fallback: the Node host
accepts raw input/output up to roughly 10 MiB (including CRLF allowance). Only callers
that know their captures are product-bounded may declare the smaller expected/next
reservation. Admission errors report requested bytes, available bytes, and operation
counts, making an unannotated default-cap `process` rejection explicit.
`Vault.process` uses supervised one-shot Node child processes for no-follow exact reads
and checked replacement (source identity/content recheck, temporary-file data sync,
rename, and parent-directory sync). Only the synchronous transform runs on the main
thread. Callback rejection, stale identity, changed source,
and oversized input/output fail without publishing the proposed replacement.
Permission bits are retained. Existing vault path-containment guards remain in
effect. Directory sync tolerates only unsupported-filesystem errors.

The `Vault.process` host path uses only cached logical-handle checks on the main
thread, including publication bookkeeping; physical device/inode, no-follow,
fresh containment, exact-content, and publication checks run in the helpers.
It does not call `assertCurrentFile` or synchronous lookups as preflight.
This is not a full asynchronous VFS: `getAbstractFileByPath`, walks, other writers'
preflight/bookkeeping, and rename preparation still use synchronous metadata probes
(`lstat`/`realpath`) that can OS-block the main event loop. Caller-supplied transforms
can also block or perform their own synchronous I/O. Only the helper reads and
checked-replacement/rename critical I/O are supervised; their deadlines are not a
claim that every Node filesystem stall or arbitrary transform is interruptible.

Renames recheck destination vacancy, source identity, and fresh path containment
after asynchronous preparation and again after the `beforeMutation` hook. The helper
repeats these checks before asynchronous rename publication and directory sync.
The hook precedes helper dispatch, not an uninterrupted main-thread syscall.
Rename publication and both parent-directory syncs finish
before the host mutation queue is released. A destination observed at either
check rejects the operation without replacing its bytes or removing the source.

This serializes the daemon's own writers, not arbitrary OS processes. POSIX rename
does not provide an atomic external-process compare-and-swap: an external writer
can still race between the final source check and rename, or replace a directory
after containment validation. Tests verify rejection of observed replacements,
content changes, and symlink escapes; they do not assume a global filesystem lock.
Likewise, an external process can create a rename destination between the last
vacancy check and the rename syscall. This is not a portable global no-replace
guarantee, and the host does not use a link-and-unconditional-unlink workaround.
Checked replacement is not cross-process CAS, even though the rename itself is atomic.

Each helper runs inline JavaScript under `process.execPath`; no TypeScript loader,
worker file, or extra packaged asset is needed in the bundled CLI. A child process
rather than a worker thread gives filesystem calls their own OS process and lets
the supervisor request SIGKILL independently of a blocked JavaScript thread.
On deadline or abnormal helper exit the host fences subsequent mutations and
rejects `host.failure` immediately when failure is detected, even while child exit
is still pending. Parent engine/controller code must observe that promise.
The current mutation never settles, releases the queue, or starts replacement work
until the helper's exit and stdio closure are confirmed. A kernel-blocked process
may delay exit even after SIGKILL; safety wins over pretending cancellation completed.
Even if the parent I/O/watchdog expires first, it cannot release the native active
mutation slot: this host has no queue-reset API, and queued native calls remain
behind the same pending helper exit. The deadline relation is not a cancellation
guarantee; exit-confirmed fencing is the safety mechanism.
Interrupted rename/replacement is reported as publication-uncertain, not rolled back
or automatically retried. Failure notification does not wait for exit or cleanup;
the active mutation itself still waits for confirmed exit. Interrupted helpers' temporary paths
are quarantined, not automatically removed: ownership cannot be reconstructed from
a reserved filename. `NodeFsHostFailure.retainedTemporaryPath` and its actionable
error message identify the possible ignored temp; inspect it before manual removal.
Normal failures close descriptors and remove an unpublished temporary only after
checking its created device/inode and exact planned output. Unexpected or partial
contents are retained with an actionable error message. These cleanup checks, like
publication checks, are not an atomic external-process compare-and-unlink guarantee.
Candidate data is durably stored before asynchronous network receipt waiting, and
the trusted reconciliation baseline is held back until that receipt is persisted.

Remote rename batches use SQLite structural intents scoped to the enrolled vault,
generation, principal, and real-folder fingerprint. Startup recovers these intents
before bootstrap or local import can admit files. Blocked recovery preserves every
observed input and fences its source, staging, and destination paths while unrelated
notes can continue syncing. Visible `YAOS.yaos-moving-<uuid>.md` staging names remain
reserved from local admission even when no intent is present.

## Exit codes

- `0`: enrollment completed, or daemon shut down cleanly
- `1`: usage, configuration, enrollment, or retryable runtime failure
- `2`: revoked credentials, incompatible provisioning, or vault generation mismatch
- `17`: another live process holds the vault state lock

The daemon prints exactly one readiness line only after provisioning, bootstrap/import, provider synchronization, and the first authoritative reconciliation succeed.
