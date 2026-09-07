# Semantic frontmatter and partial settlement

RFC 11 separates a Markdown note into an exact properties region and a body. The split uses `frontmatter-boundary-v1` after `markdown-lf-v1` canonicalization. A missing opening fence means the note has no properties region; a missing closing fence is ambiguous and blocks the complete candidate.

## Partial settlement

Settlement format 2 records body and properties ancestry independently. A whole settlement proves that the server projection and exact disk observation agree in both components. A body-only settlement proves equal body content while retaining the last proven properties base, or a typed missing properties base when none exists.

Body-only settlement never produces a whole-file disk-index baseline. It records the server and disk component hashes, server generation, exact disk fingerprint, path, and local CAS revision. A later whole settlement advances both component bases.

Runtime integration must revalidate body revision, path ownership, server head, disk fingerprint, and both boundary parses before storing either settlement kind. Bootstrap may count a body-only result as materialized, but must keep properties as explicit outstanding work rather than reporting full agreement or retrying in a hot loop.

## Semantic model

Only registered fields receive semantic CRDT behavior:

- register fields use a `Y.Map` value or explicit deletion tombstone;
- set-like fields use observed add tokens and removal tombstones, so a concurrent unseen add survives removal;
- ordered fields use a `Y.Array` and retain item identity through an LCS edit;
- unknown fields remain opaque Markdown source.

The initial registry covers `title`, `timeEstimate`, `taskSourceType`, `tags`, `cssclasses`, and `aliases`. Unsupported values make the properties operation opaque instead of coercing data.

The mirror must attach before provider and editor observers. A local text observer writes its semantic delta during the same Yjs transaction. A semantic merge that requires textual repair creates a separately originated projection transaction so it enters the ordinary candidate and durable-receipt path. Projection origin is ignored in the text-to-semantic direction, preventing feedback loops.

## Lossless boundary

Projection changes only source spans for registered, simple top-level fields. Unchanged keys, comments, key order, quoting, anchors, aliases, tags, and body bytes remain untouched. A changed field using comments, anchors, aliases, tags, merge keys, flow collections, duplicate keys, malformed YAML, or an unsupported value is held opaque for review.

This is deliberately narrower than serializing the full parsed object. YAOS must preserve unfamiliar YAML rather than silently normalize it.

## Delivered runtime integration

- Reconciliation and disk projection advance an accepted body beside held properties while ambiguous boundaries continue to block the whole candidate.
- Receipt, server-head, disk-fingerprint, path-ownership, generation, and coordinator proof checks establish format-2 whole or body-only settlements.
- Common-base merge uses `bodyBase` for body-only ancestry and retains properties independently until whole agreement is proven.
- Bootstrap treats body-only content as materialized while persisting dormant `properties` outstanding work across restart; it retries only when settlement evidence changes.
- Each loaded body owns one semantic mirror before provider/editor observers and destroys it with body eviction or runtime teardown.
- HTTP candidates and body WebSocket updates validate the closed semantic-root schema, shared-type kinds, field/value/token/entry bounds, and aggregate encoded size before durability or fan-out.
- Quarantine diagnostics distinguish whole-blocked from properties-held work and persist body identity plus bounded settlement evidence without note content.
- Document schema 6, protocol 2, and generation-scoped schema-6 caches form the exact compatibility boundary for semantic bodies.
