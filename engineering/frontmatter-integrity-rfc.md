# Frontmatter Integrity RFC

This RFC defines the plan to stop YAML frontmatter corruption, prevent repeat
amplification, and move YAOS toward a structure-aware frontmatter sync model.

It is intentionally grounded in the 2026-04-09 incident logs:

- the note involved was `Bathroom floor clean.md`
- the first visible corruption was concentrated in YAML frontmatter
- the duplicate growth involved task-related properties such as
  `complete_instances`, `taskSourceType`, and `timeEstimate`
- a later recovery loop in YAOS demonstrably amplified the malformed state

## Status

P0 and the first P1 containment pass are implemented:

- bound-file recovery now uses non-writing binding repair after disk-authority
  recovery
- the frontmatter guard blocks obvious duplicate/malformed/growth-burst states
  in both disk-to-CRDT and CRDT-to-disk directions
- blocked transitions are traced, surfaced with a throttled user notice, and can
  be opted out from Advanced settings for troubleshooting
- blocked paths persist bounded diagnostic-only quarantine metadata in plugin
  state for restart-safe debugging
- parser-backed validation now complements the cheap extractor on changed
  frontmatter slices, and schema-lite field policies are used for
  classification only

Still proposed:

- full recovery UI
- structure-aware frontmatter sidecar
- canonical YAML rendering

## Why this RFC exists

YAOS currently treats a Markdown file as a single `Y.Text`.

That is correct for prose and code-like note bodies, but YAML frontmatter has a
different semantic shape:

- keys should generally be unique
- scalar values and list values are not interchangeable without intent
- many properties are controlled by plugins or Obsidian's Properties UI
- byte-level edits can be serialization noise rather than meaningful value edits
- syntactically valid YAML can still be semantically corrupt for the user's note

The incident showed two distinct failure modes:

1. A malformed frontmatter state entered the CRDT from a remote path.
2. YAOS later amplified a small disk/editor/CRDT divergence by applying disk
   content to the CRDT and then immediately applying editor content back again.

The second failure mode is ours and should be fixed immediately.

The first failure mode may have been triggered by another plugin or another
device. YAOS cannot reliably attribute an Obsidian `modify` event to TaskNotes,
TaskForge, Obsidian Properties, mobile Obsidian, or a user keystroke. YAOS can,
however, detect frontmatter danger by structure and stop propagating obviously
bad states.

## Goals

- Stop the verified recovery amplifier.
- Prevent YAOS from writing or propagating newly detected malformed YAML
  frontmatter.
- Preserve real-time body sync and cursor behavior.
- Treat external frontmatter writers as normal, supported inputs.
- Make frontmatter changes observable in traces and diagnostics without storing
  vault content.
- Define a path from guardrails to structure-aware frontmatter sync.
- Add regression coverage for the incident class.

## Non-goals

- Do not attempt to fingerprint or special-case TaskNotes, TaskForge, or any
  single third-party plugin as the cause.
- Do not disable body sync for notes with frontmatter.
- Do not replace the vault-wide `Y.Doc` in this RFC.
- Do not require a YAML parser in the hot path for every body keystroke.
- Do not promise perfect conflict resolution for every arbitrary YAML document
  in the first implementation pass.
- Do not silently rewrite frontmatter into a surprising format without an
  explicit compatibility policy.

## Explicit product positions

### The recovery amplifier is a P0 bug

When an open note is editor-bound and disk matches the editor but not the CRDT,
the current recovery path applies disk content to the CRDT and then calls
`editorBindings.heal()`. `heal()` compares the live editor to the CRDT and can
apply the editor text back into the same `Y.Text`.

In the 2026-04-09 logs this produced repeated growth:

- disk `576`, CRDT `560`, editor `608`
- recover disk to CRDT: `560 -> 576`
- heal editor to CRDT: `576 -> 592`
- next pass repeats with a new offset

The fix is not optional. A repair path must not perform two content writes from
two different observed states in one recovery cycle.

### Frontmatter needs a stronger invariant than body text

The body can remain CRDT text. Frontmatter needs structure-aware validation at a
minimum, and structure-aware synchronization as the longer-term target.

This is not because YAML is special in a theoretical sense. It is because users
and plugins treat frontmatter as a map of properties, while YAOS currently
syncs the serialized bytes.

### Plugin attribution is the wrong abstraction

The user mentioned TaskNotes and TaskForge. They may be involved, but the
correct protection boundary is not "detect TaskNotes".

The correct boundary is:

- accept that multiple writers can edit frontmatter
- validate the resulting frontmatter shape
- prevent known-bad transitions from becoming authoritative
- expose enough diagnostics to identify the source later when possible

This keeps YAOS compatible with all frontmatter-writing plugins instead of
playing whack-a-mole with individual integrations.

### A suspicious frontmatter change should fail safe

If a local or remote update would introduce duplicate YAML keys, repeated key
bursts, malformed frontmatter delimiters, or pathological growth isolated to
frontmatter, YAOS should avoid making that state authoritative automatically.

Depending on phase and confidence, the action can be:

- skip ingest into CRDT
- skip write from CRDT to disk
- keep syncing the body while quarantining the frontmatter change
- surface a notice or diagnostics entry

The default must be "do not corrupt the note further".

## Current architecture

The current markdown model is a single text object:

```text
MarkdownFile = Y.Text
```

The vault model stores file texts by stable ID:

```text
pathToId: Y.Map<string>
idToText: Y.Map<Y.Text>
meta:     Y.Map<FileMeta>
```

This preserves cursor-aware, real-time body editing. It also means a YAML
property edit is merged with the same text-level rules as a paragraph edit.

That is the core mismatch.

## Better abstraction

The longer-term model should treat a Markdown note as a product:

```text
Note = Frontmatter x Body
```

Body remains:

```text
Body = Y.Text
```

Frontmatter becomes a structured value with a parser/printer boundary:

```text
FrontmatterText <-> FrontmatterValue
```

The useful abstraction is a parser/printer boundary:

```text
MarkdownText
  -> get:  { frontmatterText, bodyText }
  -> put:  { frontmatterValue, bodyText } -> MarkdownText
```

YAOS should stop treating YAML serialization as the source of truth for
properties. Instead, it should parse YAML into a value, merge that value under
property invariants, and print it back to canonical YAML.

Practically, that means:

- duplicate keys are not representable unless explicitly modeled
- scalar/list type transitions are explicit
- list set-like fields can dedupe by value where configured
- formatting differences can be reduced by canonicalization
- raw text fallback remains available when parsing fails or comments/anchors
  cannot be preserved

This abstraction is valuable only if it reduces corruption risk. It should be
introduced incrementally.

## Scope and implementation plan

## P0: Stop the verified amplifier

### 1. Split "repair binding" from "write editor content"

Current behavior:

- `syncFileFromDisk()` detects local-only divergence.
- It applies disk content to the CRDT.
- It calls `editorBindings.heal()`.
- `heal()` may write the editor content to the CRDT again.

Approved change:

- introduce a binding repair path that reconfigures or validates the binding
  without applying editor content
- use that path after `disk-sync-recover-bound`
- reserve content-writing `heal()` for cases where editor content is the single
  chosen source of truth

Minimum accepted patch:

- after applying disk content to CRDT, do not call content-writing `heal()`
- either call non-writing `repair()` or rebind
- schedule a later health check after the editor has observed the CRDT update
- release gate: no automatic health/audit/recovery path may apply editor buffer
  content to CRDT after a disk-authority recovery decision

### 2. Add a regression test for recovery amplification

The test should model:

- CRDT text: `---\ntimeEstimate: 2\nkind: op\n---\n`
- disk text: `---\ntimeEstimate: 20\nkind: op\n---\n`
- editor text with stale or shifted content
- recovery path runs

Expected:

- exactly one source of truth is applied
- the CRDT does not grow by applying both disk and editor content
- a second recovery pass is a no-op or remains bounded

### 3. Add trace details for recovery source selection

Record source-choice metadata without storing note content:

- path
- reason
- editor length
- disk length
- CRDT length
- chosen source: `disk`, `editor`, `crdt`, `skip`
- action: `applied`, `deferred`, `repair-only`, `quarantined`

This makes future incidents easier to diagnose without leaking user notes.

## P1: Frontmatter integrity guard

### 4. Extract frontmatter ranges cheaply

Add a small utility that classifies a Markdown document as:

- no frontmatter
- frontmatter block present
- malformed frontmatter delimiter

The extractor should return:

- `frontmatterStart`
- `frontmatterEnd`
- `frontmatterText`
- `bodyText`

This does not require parsing YAML yet. It is a cheap structural boundary for
guards and diagnostics.

### 5. Add frontmatter validation

The first containment pass uses a cheap structural classifier plus parser-backed
validation on the extracted frontmatter slice. It blocks only obvious hazards
such as duplicate top-level keys, repeated bare-key bursts, parser failures,
malformed frontmatter fences, and isolated frontmatter growth bursts.

That first pass is still an emergency brake, not a complete YAML policy. The
durable implementation should keep parser-backed validation while avoiding
premature merge or rewrite semantics.

The validator should detect:

- parser errors
- duplicate mapping keys
- scalar/list type changes where old and new frontmatter are both available
- large repeated growth inside frontmatter
- repeated key bursts such as `taskSourceType` repeated many times
- malformed frontmatter fences

The validator must report a risk class:

- `ok`
- `warn`
- `block`
- `unknown`

### 6. Gate inbound disk-to-CRDT frontmatter changes

When a local disk modify is ingested:

- compare old CRDT frontmatter to new disk frontmatter
- if body changed and frontmatter is unchanged, proceed normally
- if frontmatter changed and validates as `ok`, proceed
- if frontmatter validates as `warn`, proceed but trace
- if frontmatter validates as `block`, do not apply it to the CRDT

For `block`, YAOS should:

- leave body sync available when the body can be separated safely
- record a diagnostic
- notify the user with short copy

### 7. Gate outbound CRDT-to-disk frontmatter writes

When a remote CRDT update would be written to disk:

- compare disk frontmatter to CRDT frontmatter
- validate the target frontmatter before writing
- if validation blocks, skip the write and keep the disk file unchanged

This is the defense against another device or third-party plugin introducing a
bad frontmatter state into the room.

### 8. Add a quarantine state

Introduce a per-path quarantine record for frontmatter hazards.

Minimum fields:

- path
- detectedAt
- direction: `disk-to-crdt` or `crdt-to-disk`
- reason codes
- source lengths
- frontmatter hash only, not content
- whether body sync remains active

The quarantine should be clearable when:

- disk and CRDT match again
- the user accepts the incoming state
- the user chooses the local disk state
- the user disables the guard for the path

The first implementation is skip behavior plus trace/log diagnostics, a
throttled notice, a global opt-out, and bounded persisted quarantine metadata
for debugging. Explicit accept/keep recovery controls should follow only if they
remain consistent with YAOS snapshot and Obsidian File Recovery policy.

## P2: Structure-aware frontmatter sync

### 9. Define the frontmatter value model

Represent frontmatter as a typed value:

```text
FrontmatterValue = Map<PropertyKey, PropertyValue>

PropertyValue =
  | null
  | boolean
  | number
  | string
  | date-like string
  | list<PropertyValue>
  | object
  | rawYaml
```

Preserve a raw fallback for:

- comments
- anchors
- tags or values the parser cannot round-trip safely
- plugin-specific complex shapes

### 10. Define merge semantics by value kind

Initial policy:

- scalar: last writer wins with timestamp/source metadata
- list: ordered list by default
- configured set-like list: dedupe by normalized value
- object: recursive map merge when safe
- rawYaml: last writer wins or quarantine on concurrent edit

This should start conservative. Unknown structure should not be over-merged.

### 11. Add canonical rendering

Canonical rendering should:

- use stable key order where possible
- preserve common Obsidian property conventions
- avoid unnecessary quote churn where possible
- ensure exactly one opening and closing frontmatter fence
- render duplicate-key-invalid states as impossible

This is where formatting debates can become product decisions. The initial
renderer should be predictable and boring.

### 12. Migrate without breaking existing CRDT state

Do not remove the current `Y.Text` file model immediately.

Recommended migration:

1. Keep whole-file `Y.Text` as the source of truth.
2. Add parsed-frontmatter sidecar metadata for validation and diagnostics.
3. Add optional structured frontmatter sidecar per file.
4. For files that validate cleanly, use the structured sidecar to mediate
   frontmatter changes.
5. Render structured frontmatter back into the whole-file text.
6. Keep raw fallback for files that cannot round-trip.

This avoids a risky all-at-once CRDT schema change.

## P3: Product surface and recovery UX

### 13. Add a user-facing frontmatter conflict notice

Copy should be short and non-technical:

```text
YAOS paused a properties update in "Bathroom floor clean.md" because it looked malformed.
Your note body is still syncing.
```

Actions:

- keep local properties
- accept remote properties
- open diagnostics
- disable frontmatter guard for this note

### 14. Add diagnostics export fields

Diagnostics should include:

- frontmatter guard status
- quarantined paths
- reason codes
- hashes and lengths
- source device when known
- local/remote timestamps when known

Do not include YAML contents by default.

## P4: Tests

Add tests for:

- duplicate YAML keys are detected
- repeated-key bursts are detected
- list item deletion does not duplicate list items
- scalar/list type changes are classified
- malformed frontmatter fences are blocked
- body-only edits bypass frontmatter validation cost
- outbound remote corrupt frontmatter is not written to disk
- inbound local corrupt frontmatter is not propagated to CRDT
- recovery amplifier does not recur
- quarantine clears when disk and CRDT converge

## Acceptance criteria

P0 is complete when:

- the recovery path cannot apply disk and editor content to the same CRDT text in
  one cycle
- a regression test covers the old repeated-growth shape

P1 is complete when:

- YAOS can detect and block obvious duplicate frontmatter states in both
  disk-to-CRDT and CRDT-to-disk directions
- body sync continues when a frontmatter update is quarantined and the body can
  be separated safely
- diagnostics show reason codes without note contents

P2 is complete when:

- clean frontmatter can be parsed, merged, and rendered through a structured
  value model
- raw YAML fallback exists
- existing whole-file `Y.Text` sync still works for unstructured files

## Open questions

- Which YAML parser should be used in the plugin bundle?
- Should the first guard block duplicate keys only, or also repeated list-item
  bursts?
- Should structured frontmatter be opt-in during the first release?
- Should set-like behavior be configured per property name, for example
  `tags` and selected TaskNotes properties?
- How should mobile performance be measured for validation on large notes?
- Should quarantined frontmatter updates be persisted in plugin data for restart
  recovery in the first implementation, or start as trace-only?

## Recommended order of work

1. Implement P0 recovery amplifier fix.
2. Add recovery amplifier regression coverage.
3. Add frontmatter extractor and parser validation utilities.
4. Gate outbound CRDT-to-disk writes for duplicate/malformed frontmatter.
5. Gate inbound disk-to-CRDT ingest for duplicate/malformed frontmatter.
6. Add quarantine diagnostics.
7. Add user-facing conflict notice.
8. Design and implement structured frontmatter sidecar.

This order fixes the known YAOS bug first, then adds guardrails against other
plugins and devices, then moves toward the deeper abstraction.
