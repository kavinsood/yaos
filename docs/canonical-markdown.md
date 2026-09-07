# Canonical Markdown representation

YAOS uses one logical Markdown representation across Obsidian, the headless CLI,
body candidates, bootstrap, reconciliation, recovery materialization, conflict
artifacts, and diagnostics.

## Contract

The representation identifier is `markdown-lf-v1`.

Canonicalization performs exactly two transformations:

1. remove one leading Unicode BOM (`U+FEFF`), when present;
2. replace CRLF and lone CR line endings with LF.

It preserves final-newline presence, trailing spaces and tabs, empty content,
and every other Unicode code point. It does not normalize Unicode, trim text,
rewrite YAML, or interpret Markdown.

All new disk-to-body admission and body-to-disk materialization passes through
the shared codec. A note written by YAOS therefore uses UTF-8 canonical text.
Byte-preserving archives, including pre-restore safety backups, deliberately
remain exact disk copies rather than logical note materialization.

## Hash meanings

YAOS keeps three proofs separate:

- A logical content hash is SHA-256 over canonical Markdown UTF-8 bytes. Disk
  baselines, server catalog content metadata, and diagnostic comparisons use it.
- A disk-write fingerprint is SHA-256 plus length over the exact UTF-8 text at
  the write boundary. Self-echo suppression uses it, so BOM and line-ending
  differences remain observable evidence.
- A candidate digest is SHA-256 over the encoded Yjs update submitted to the
  candidate endpoint. It identifies the exact durable operation payload; it is
  not a logical Markdown content hash.

## Cutover

Persisted disk baselines include the representation identifier. An unversioned
or unknown-version hash is discarded on load while its stat remains available
for scan admission. The next clean settlement records a `markdown-lf-v1` hash.
This intentionally produces a conservative missing-baseline decision instead
of comparing hashes with different meanings.

Bootstrap accepts either canonical content metadata or the previously emitted
exact-text metadata after verifying the complete hash-and-size pair. In both
cases it returns canonical text for materialization. This permits a verified
legacy body to cross the representation boundary without treating corruption
as migration.

The server continues to define the candidate digest over encoded update bytes.
New catalog metadata is computed over canonical Markdown bytes.
