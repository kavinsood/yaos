# Public plugin API

YAOS exposes a versioned, read-only state projection for other Obsidian
plugins. The consumer declaration is [`yaos-plugin-api.d.ts`](../yaos-plugin-api.d.ts).
It is intentionally an observation API, not a synchronization control surface.

## Acquire and reacquire

Read the API from Obsidian's plugin registry, then resubscribe when YAOS has
loaded or reloaded:

```ts
const acquire = () => app.plugins.plugins["yaos"]?.api;
app.workspace.on("yaos:api-ready", () => {
  const api = acquire();
  if (!api) return;
  const subscription = api.v0.subscribe(({ snapshot }) => {
    // Render this immutable snapshot.
  });
  // subscription.snapshot is atomically paired with future revisions.
});
```

YAOS assigns `plugin.api` before triggering `yaos:api-ready`. A retained
handle from an unloaded instance throws `YaosPublicApiStaleHandleError`; do
not reuse it after a reload.

## Version 0

`api.v0` supplies `getSnapshot`, `subscribe`, `getFile(path)`, and
`getFileByBodyId(bodyId)`. Snapshots carry a monotonic `revision`, readiness,
collaboration authority, file/body identity, coordinator lifecycle facts,
settlement evidence, per-file preservation/frontmatter-quarantine counts, and
aggregate counts. Subscription registration and its returned snapshot are
synchronous, so a consumer cannot miss the next published revision between
those operations.

The immutable `collaboration` projection includes:

- authority state (`active`, `refreshing`, `changing`, `revoked`, or
  `incompatible`), current principal/device identities and names, owner/member
  role, membership and device-credential revisions, fixed policy version, and
  capabilities;
- current member summaries with role, lifecycle state, device count, and
  aggregate last-seen time;
- live presence as distinct principal/device instances, even when UI groups
  several devices under one person;
- current ownership-transfer offers with source, target, creation, and expiry
  facts, but no accept/cancel method;
- the count of durable local operations preserved because their captured
  authority was superseded.

These are observations for presentation and integration. Capability strings
are useful for planning UI, but never authorize an action; the server remains
the permission source.

Every value is a frozen plain-data copy. The API never returns Markdown text,
Yjs values, providers, sockets, device bearers, invitation/device-link secrets,
raw hashes, diagnostics handles, mutable membership objects, or QA controls. It
accepts no content, membership, device, settings, or ownership mutations.
Settlement evidence is refreshed asynchronously after startup; `unknown`
remains explicit until a validated durable record is available.
