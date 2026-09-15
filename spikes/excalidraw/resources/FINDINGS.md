# Resource and privacy spike

## Result

Recursive dependency synchronization is categorically rejected for public
sharing. The executable seven-level, branching-three fixture expands one root
drawing into thousands of vault objects and proves that apparently indirect
children contain private back-of-card content.

The accepted design is an immutable, explicit public-resource manifest:

- publication materializes approved resources into a share namespace;
- entries use opaque public IDs and content hashes, never vault paths or source
  document IDs;
- resource reads bind share ID, drawing ID, grant revision, public resource ID,
  and exact hash;
- manifest count and aggregate bytes are bounded before publication;
- nested drawings and Markdown notes are published only as explicitly approved,
  sanitized render artifacts unless a future product intentionally publishes
  their source;
- browser uploads enter a drawing/share-scoped quarantine namespace and do not
  become arbitrary vault files.

## Command

```sh
node spikes/excalidraw/resources/run.mjs
```

The retained `results.json` records graph expansion, leaked private fixtures,
the two-resource explicit publication, and substitution/revocation checks.
